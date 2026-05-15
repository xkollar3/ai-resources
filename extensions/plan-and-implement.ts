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
type StatusMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
type SendStatusMessage = (message: StatusMessage) => void | Promise<void>;

const INTERNAL_POSTCHECK_COMMAND = "_plan_implement_postcheck";
const STATUS_CUSTOM_TYPE = "plan-and-implement-status";
const STATUS_SLOT = "plan-and-implement";
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

async function notifyProgress(
  ctx: Pick<ExtensionCommandContext, "ui">,
  message: string,
  type: "info" | "warning" | "error",
  sendStatusMessage?: SendStatusMessage,
): Promise<void> {
  // Footer status updates are visible during long-running work, while
  // notification toasts may be visually easy to miss during busy turns.
  ctx.ui.setStatus(STATUS_SLOT, message);
  ctx.ui.notify(message, type);

  if (sendStatusMessage) {
    await sendStatusMessage({
      customType: STATUS_CUSTOM_TYPE,
      content: message,
      display: true,
      details: { type },
    });
  }
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
  sendStatusMessage?: SendStatusMessage,
): Promise<PostImplementationGuardrailOutcome> {
  await notifyProgress(
    ctx,
    "Post-check 1/2: verifying implementation scope",
    "info",
    sendStatusMessage,
  );

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
    await notifyProgress(
      ctx,
      "Scope guardrail failed. Requesting infeasibility report.",
      "error",
      sendStatusMessage,
    );

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

  await notifyProgress(
    ctx,
    "Post-check 1/2 complete: implementation scope verified",
    "info",
    sendStatusMessage,
  );
  await notifyProgress(
    ctx,
    "Post-check 2/2: reporting planned tests coverage",
    "info",
    sendStatusMessage,
  );

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

  const extractCount = (pattern: RegExp): number | null => {
    const match = summary.match(pattern);
    if (!match?.[1]) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const detectedInDiff = extractCount(/\[guardrail\] INFO: detected in diff: (\d+)/);

  if (summary.includes("[guardrail] WARNING:")) {
    const warningMessage =
      detectedInDiff === 0
        ? "Post-check 2/2 complete: no new tests added (planned tests were not detected)"
        : "Post-check 2/2 complete: missing-tests warnings found";

    await notifyProgress(ctx, warningMessage, "warning", sendStatusMessage);
    await notifyProgress(
      ctx,
      "Implementation finished with missing-tests warnings",
      "warning",
      sendStatusMessage,
    );
    return "warnings";
  }

  const successMessage =
    detectedInDiff === 0 || summary.includes("[guardrail] INFO: no expected tests listed in affected_files.jsonl")
      ? "Post-check 2/2 complete: no new tests added"
      : "Post-check 2/2 complete: planned tests coverage clean";

  await notifyProgress(ctx, successMessage, "info", sendStatusMessage);
  await notifyProgress(
    ctx,
    "Implementation finished and guardrails passed",
    "info",
    sendStatusMessage,
  );
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

      const planPrompt = substitutePositionalArgs(planTemplate, [parsed.feature, parsed.notes]);
      await notifyProgress(ctx, "Phase 1/3: planning", "info", (message) => pi.sendMessage(message));
      await sendPromptAndWaitForCompletion((prompt) => pi.sendUserMessage(prompt), ctx, planPrompt);
      await notifyProgress(
        ctx,
        "Phase 1/3 complete: planning finished",
        "info",
        (message) => pi.sendMessage(message),
      );

      await notifyProgress(
        ctx,
        "Phase 2/3: validating planner artifacts",
        "info",
        (message) => pi.sendMessage(message),
      );
      await runGuardrail(
        await resolveRequiredExecutable(ctx, "guardrails", "validate-planner-output.sh"),
        ["plan.md", "affected_files.jsonl"],
        ctx,
        "planner output validation",
      );
      await notifyProgress(
        ctx,
        "Phase 2/3 complete: planning artifacts validated",
        "info",
        (message) => pi.sendMessage(message),
      );

      await notifyProgress(
        ctx,
        "Phase 3/3: switching to new session for implementation",
        "info",
        (message) => pi.sendMessage(message),
      );
      const sessionResult = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (newCtx) => {
          let implementationError: unknown;

          try {
            await notifyProgress(
              newCtx,
              "Phase 3/3 started: new session + implementation",
              "info",
              (message) => newCtx.sendMessage(message),
            );

            try {
              await sendPromptAndWaitForCompletion(
                (prompt) => newCtx.sendUserMessage(prompt),
                newCtx,
                implementPrompt,
              );
              await notifyProgress(
                newCtx,
                "Implementation completed; running post-implementation guardrails",
                "info",
                (message) => newCtx.sendMessage(message),
              );
            } catch (error) {
              implementationError = error;
              await notifyProgress(
                newCtx,
                "Implementation encountered an error; running post-implementation guardrails anyway",
                "warning",
                (message) => newCtx.sendMessage(message),
              );
            }

            // Always run post-implementation checks, even when implementation had issues.
            await runPostImplementationGuardrails(
              newCtx,
              (prompt) => newCtx.sendUserMessage(prompt),
              (message) => newCtx.sendMessage(message),
            );

            if (implementationError) {
              const message =
                implementationError instanceof Error
                  ? implementationError.message
                  : String(implementationError);
              newCtx.ui.notify(`Implementation phase failed: ${message}`, "error");
              throw implementationError;
            }
          } finally {
            newCtx.ui.setStatus(STATUS_SLOT, undefined);
          }
        },
      });

      if (sessionResult.cancelled) {
        ctx.ui.setStatus(STATUS_SLOT, undefined);
        ctx.ui.notify("Automatic implementation handover cancelled", "warning");
        return;
      }

      // Do not use the pre-replacement command ctx after a successful newSession().
      // All session-bound notifications are emitted from the replacement-session ctx.
    },
  });

  pi.registerCommand(INTERNAL_POSTCHECK_COMMAND, {
    description: "Internal command: run scope + missing-tests guardrails",
    handler: async (_args, ctx) => {
      try {
        await runPostImplementationGuardrails(
          ctx,
          (prompt) => pi.sendUserMessage(prompt),
          (message) => pi.sendMessage(message),
        );
      } finally {
        ctx.ui.setStatus(STATUS_SLOT, undefined);
      }
    },
  });

}
