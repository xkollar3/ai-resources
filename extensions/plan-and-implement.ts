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

type PostImplementationGuardrailOutcome = "passed" | "warnings" | "scope_failed";

type PromptRuntimeContext = Pick<
  ExtensionCommandContext,
  "isIdle" | "hasPendingMessages" | "waitForIdle"
>;

type SendUserPrompt = (prompt: string) => void | Promise<void>;

const INTERNAL_POSTCHECK_COMMAND = "_plan_implement_postcheck";
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

function getCandidateResourcePaths(ctx: ExtensionCommandContext, dir: string, fileName: string): string[] {
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
  throw new Error(`missing required executable: ${fileName}\nSearched:\n${searched}`);
}

async function loadAgentPrompt(ctx: ExtensionCommandContext, fileName: string): Promise<string> {
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
  // /plan-and-implement "<feature description>" "<additional notes>"
  const quotedMatch = args.match(/^"([\s\S]*?)"\s+"([\s\S]*?)"$/);
  if (quotedMatch) {
    const feature = quotedMatch[1]?.trim() ?? "";
    const notes = quotedMatch[2]?.trim() ?? "";
    if (!feature) return null;
    return { feature, notes };
  }

  // Preferred syntax:
  // /plan-and-implement <feature description> --notes <additional notes>
  const marker = " --notes ";
  const idx = args.indexOf(marker);
  if (idx >= 0) {
    const feature = args.slice(0, idx).trim();
    const notes = args.slice(idx + marker.length).trim();
    if (!feature) return null;
    return { feature, notes };
  }

  // Fallback syntax:
  // /plan-and-implement <feature description> || <additional notes>
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

async function runGuardrail(
  command: string,
  args: string[],
  ctx: ExtensionCommandContext,
  label: string,
) {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolveResult, rejectResult) => {
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
    },
  );

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.code !== 0) {
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${label} failed (exit ${result.code})${details ? `\n${details}` : ""}`);
  }

  return { stdout, stderr };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function sendPromptAndWaitForCompletion(
  sendUserPrompt: SendUserPrompt,
  ctx: PromptRuntimeContext,
  prompt: string,
): Promise<void> {
  await sendUserPrompt(prompt);

  // sendUserMessage() on ExtensionAPI is fire-and-forget.
  // waitForIdle() can resolve immediately if called before the queued turn starts,
  // so first wait until the message is actually pending/running.
  const deadline = Date.now() + 10_000;
  while (ctx.isIdle() && !ctx.hasPendingMessages() && Date.now() < deadline) {
    await delay(25);
  }

  await ctx.waitForIdle();
}

async function runPostImplementationGuardrails(
  ctx: ExtensionCommandContext,
  sendUserPrompt: SendUserPrompt,
): Promise<PostImplementationGuardrailOutcome> {
  ctx.ui.notify("Post-check 1/2: verifying implementation scope", "info");

  // 1) Hard scope check (blocking)
  try {
    await runGuardrail(
      await resolveRequiredExecutable(ctx, "guardrails", "verify-changeset-scope.sh"),
      ["affected_files.jsonl", "HEAD"],
      ctx,
      "changeset scope verification",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify("Scope guardrail failed. Requesting infeasibility report.", "error");

    await sendPromptAndWaitForCompletion(
      sendUserPrompt,
      ctx,
      `Scope guardrail failed. Create infeasibility-report.md explaining:\n` +
        `1) Which planned items are blocked\n` +
        `2) Why they are blocked\n` +
        `3) Which additional files are required and why\n` +
        `4) Which tests are missing or cannot be implemented\n\n` +
        `Guardrail details:\n${message}`,
    );
    return "scope_failed";
  }

  ctx.ui.notify("Post-check 2/2: reporting planned tests coverage", "info");

  // 2) Missing test check (warning-only)
  const missingTestsResult = await runGuardrail(
    await resolveRequiredExecutable(ctx, "guardrails", "report-missing-tests.sh"),
    ["affected_files.jsonl", "HEAD"],
    ctx,
    "missing tests report",
  );

  const summary = [missingTestsResult.stdout, missingTestsResult.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (summary.includes("[guardrail] WARNING:")) {
    ctx.ui.notify("Implementation finished with missing-tests warnings", "warning");
    return "warnings";
  }

  ctx.ui.notify("Implementation finished and guardrails passed", "info");
  return "passed";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan-and-implement", {
    description:
      "Run plan -> validate planner output -> reset context -> implement -> run post-implementation guardrails",
    handler: async (rawArgs, ctx) => {
      const parsed = parseArgs(rawArgs);
      if (!parsed) {
        ctx.ui.notify(
          "Usage: /plan-and-implement \"<feature description>\" \"<notes>\" (or use --notes)",
          "warning",
        );
        return;
      }

      await ctx.waitForIdle();

      const planTemplate = await loadAgentPrompt(ctx, "plan.md");
      const implementPrompt = await loadAgentPrompt(ctx, "implement.md");

      ctx.ui.notify("Phase 1/3: planning", "info");
      const planPrompt = substitutePositionalArgs(planTemplate, [parsed.feature, parsed.notes]);
      await sendPromptAndWaitForCompletion((prompt) => pi.sendUserMessage(prompt), ctx, planPrompt);

      ctx.ui.notify("Phase 2/3: validating planner artifacts", "info");
      await runGuardrail(
        await resolveRequiredExecutable(ctx, "guardrails", "validate-planner-output.sh"),
        ["plan.md", "affected_files.jsonl"],
        ctx,
        "planner output validation",
      );

      ctx.ui.notify("Phase 3/3: new session + implementation", "info");
      let postcheckOutcome: PostImplementationGuardrailOutcome | null = null;

      const sessionResult = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (newCtx) => {
          let implementationError: unknown;

          try {
            await sendPromptAndWaitForCompletion(
              (prompt) => newCtx.sendUserMessage(prompt),
              newCtx,
              implementPrompt,
            );
          } catch (error) {
            implementationError = error;
          }

          // Always run post-implementation checks, even when implementation had issues.
          postcheckOutcome = await runPostImplementationGuardrails(
            newCtx,
            (prompt) => newCtx.sendUserMessage(prompt),
          );

          if (implementationError) {
            const message =
              implementationError instanceof Error
                ? implementationError.message
                : String(implementationError);
            newCtx.ui.notify(`Implementation phase failed: ${message}`, "error");
            throw implementationError;
          }
        },
      });

      if (sessionResult.cancelled) {
        ctx.ui.notify("Automatic implementation handover cancelled", "warning");
        return;
      }

      // Mirror final guardrail outcome in the caller session. Notifications emitted inside
      // the temporary implementation session can be missed when that session closes quickly.
      if (postcheckOutcome === "passed") {
        ctx.ui.notify("Implementation finished and guardrails passed", "info");
      } else if (postcheckOutcome === "warnings") {
        ctx.ui.notify("Implementation finished with missing-tests warnings", "warning");
      } else if (postcheckOutcome === "scope_failed") {
        ctx.ui.notify("Scope guardrail failed. Infeasibility report requested.", "error");
      }
    },
  });

  pi.registerCommand(INTERNAL_POSTCHECK_COMMAND, {
    description: "Internal command: run scope + missing-tests guardrails",
    handler: async (_args, ctx) => {
      await runPostImplementationGuardrails(ctx, (prompt) => pi.sendUserMessage(prompt));
    },
  });

}
