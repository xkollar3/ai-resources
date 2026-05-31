import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type ParsedArgs = {
  feature: string;
  notes: string;
};

type PromptRuntimeContext = Pick<
  ExtensionCommandContext,
  "isIdle" | "hasPendingMessages" | "waitForIdle"
>;

type SendUserPrompt = (prompt: string) => void | Promise<void>;

const STATUS_SLOT = "plan";
const AGENTS_DIR = "agents";

function substitutePositionalArgs(template: string, values: string[]): string {
  let result = template;
  values.forEach((value, idx) => {
    const key = `$${idx + 1}`;
    result = result.split(key).join(value);
  });
  return result;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;

  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return content;
  return content.slice(end + "\n---\n".length);
}

function getCandidateResourcePaths(
  ctx: ExtensionCommandContext,
  dir: string,
  fileName: string,
): string[] {
  return [
    // 1) project-local override
    resolve(ctx.cwd, dir, fileName),
    // 2) this resources repo default location
    resolve(process.env.HOME ?? "", ".config", "ai-resources", dir, fileName),
  ];
}

async function resolveRequiredExecutable(
  ctx: ExtensionCommandContext,
  dir: string,
  fileName: string,
): Promise<string> {
  const candidatePaths = getCandidateResourcePaths(ctx, dir, fileName);

  for (const candidatePath of candidatePaths) {
    try {
      await access(candidatePath, constants.X_OK);
      return candidatePath;
    } catch {
      // try next candidate
    }
  }

  const searched = candidatePaths.map((p) => ` - ${p}`).join("\n");
  throw new Error(
    `missing required executable: ${fileName}\nSearched:\n${searched}`,
  );
}

async function loadAgentPrompt(
  ctx: ExtensionCommandContext,
  fileName: string,
): Promise<string> {
  const candidatePaths = getCandidateResourcePaths(ctx, AGENTS_DIR, fileName);

  let lastReadError: unknown;

  for (const promptPath of candidatePaths) {
    try {
      const content = await readFile(promptPath, "utf8");
      const prompt = stripFrontmatter(content).trim();
      if (!prompt) {
        throw new Error(`prompt template is empty: ${promptPath}`);
      }
      return prompt;
    } catch (error) {
      lastReadError = error;
    }
  }

  const searched = candidatePaths.map((p) => ` - ${p}`).join("\n");
  throw new Error(
    `missing required prompt template: ${fileName}\nSearched:\n${searched}` +
      (lastReadError ? `\nLast error: ${String(lastReadError)}` : ""),
  );
}

function parseArgs(rawArgs: string): ParsedArgs | null {
  const args = (rawArgs ?? "").trim();
  if (!args) return null;

  // Quoted two-arg syntax:
  // /plan "<feature description>" "<additional notes>"
  const quotedMatch = args.match(/^"([\s\S]*?)"\s+"([\s\S]*?)"$/);
  if (quotedMatch) {
    const feature = quotedMatch[1]?.trim() ?? "";
    const notes = quotedMatch[2]?.trim() ?? "";
    if (!feature) return null;
    return { feature, notes };
  }

  // Preferred syntax:
  // /plan <feature description> --notes <additional notes>
  const marker = " --notes ";
  const idx = args.indexOf(marker);
  if (idx >= 0) {
    const feature = args.slice(0, idx).trim();
    const notes = args.slice(idx + marker.length).trim();
    if (!feature) return null;
    return { feature, notes };
  }

  // Fallback syntax:
  // /plan <feature description> || <additional notes>
  const fallbackMarker = " || ";
  const fallbackIdx = args.indexOf(fallbackMarker);
  if (fallbackIdx >= 0) {
    const feature = args.slice(0, fallbackIdx).trim();
    const notes = args.slice(fallbackIdx + fallbackMarker.length).trim();
    if (!feature) return null;
    return { feature, notes };
  }

  // If no explicit separator, treat everything as feature description.
  return { feature: args, notes: "" };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function notifyProgress(
  ctx: Pick<ExtensionCommandContext, "ui">,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  ctx.ui.setStatus(STATUS_SLOT, message);
  ctx.ui.notify(message, type);
}

async function sendPromptAndWaitForSubmission(
  sendUserPrompt: SendUserPrompt,
  ctx: Pick<ExtensionCommandContext, "isIdle" | "hasPendingMessages">,
  prompt: string,
): Promise<void> {
  await sendUserPrompt(prompt);

  const deadline = Date.now() + 10_000;
  while (ctx.isIdle() && !ctx.hasPendingMessages() && Date.now() < deadline) {
    await delay(25);
  }
}

async function submitPromptAndNotifySubmitted(
  sendUserPrompt: SendUserPrompt,
  ctx: Pick<ExtensionCommandContext, "isIdle" | "hasPendingMessages" | "ui">,
  prompt: string,
  submittedMessage: string,
  type: "info" | "warning" | "error" = "info",
): Promise<void> {
  await sendPromptAndWaitForSubmission(sendUserPrompt, ctx, prompt);
  await notifyProgress(ctx, submittedMessage, type);
}

async function submitPromptWaitForCompletionAndNotify(
  sendUserPrompt: SendUserPrompt,
  ctx: PromptRuntimeContext & Pick<ExtensionCommandContext, "ui">,
  prompt: string,
  submittedMessage: string,
  completedMessage: string,
  submittedType: "info" | "warning" | "error" = "info",
  completedType: "info" | "warning" | "error" = "info",
): Promise<void> {
  await submitPromptAndNotifySubmitted(
    sendUserPrompt,
    ctx,
    prompt,
    submittedMessage,
    submittedType,
  );
  await ctx.waitForIdle();
  await notifyProgress(ctx, completedMessage, completedType);
}

async function runGuardrail(
  command: string,
  args: string[],
  ctx: ExtensionCommandContext,
  label: string,
) {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolveResult, rejectResult) => {
    const child = spawn(command, args, { cwd: ctx.cwd, env: process.env });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      rejectResult(error);
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, 120000);

    const onAbort = () => {
      child.kill("SIGTERM");
    };

    if (ctx.signal) {
      if (ctx.signal.aborted) {
        onAbort();
      } else {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (ctx.signal) {
        ctx.signal.removeEventListener("abort", onAbort);
      }

      const exitCode = code ?? (timedOut ? 124 : 1);
      resolveResult({ code: exitCode, stdout, stderr });
    });
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.code !== 0) {
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      `${label} failed (exit ${result.code})${details ? `\n${details}` : ""}`,
    );
  }

  return { stdout, stderr };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description:
      "Generate a plan for a feature: plan.md + affected_files.jsonl",
    handler: async (rawArgs, ctx) => {
      const parsed = parseArgs(rawArgs);
      if (!parsed) {
        ctx.ui.notify(
          'Usage: /plan "<feature description>" "<notes>" (or use --notes)',
          "warning",
        );
        return;
      }

      await ctx.waitForIdle();

      const planTemplate = await loadAgentPrompt(ctx, "plan.md");

      await notifyProgress(ctx, "Planning...", "info");
      const planPrompt = substitutePositionalArgs(planTemplate, [
        parsed.feature,
        parsed.notes,
      ]);

      await submitPromptWaitForCompletionAndNotify(
        (prompt) => pi.sendUserMessage(prompt),
        ctx,
        planPrompt,
        "Planning prompt submitted",
        "Planning complete",
      );

      await notifyProgress(ctx, "Validating planner artifacts", "info");
      await runGuardrail(
        await resolveRequiredExecutable(
          ctx,
          "guardrails",
          "validate-planner-output.sh",
        ),
        ["plan.md", "affected_files.jsonl"],
        ctx,
        "planner output validation",
      );

      await notifyProgress(ctx, "Plan ready", "info");
    },
  });
}