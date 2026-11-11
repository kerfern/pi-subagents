import { realpath } from "node:fs/promises";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { inChildSessionContext } from "./child-context.js";
import { OPENCODE_MODEL, type OpenCodeDetails, runOpenCodeTask } from "./opencode-runner.js";

const APPROVAL_TIMEOUT_MS = 120_000;

export interface OpencodePocDeps {
  runTask: (prompt: string, cwd: string, signal: AbortSignal | undefined, onUpdate: ((text: string) => void) | undefined) => Promise<{ text: string; details: OpenCodeDetails }>;
  isChild: () => boolean;
}

const parameters = Type.Object(
  { prompt: Type.String({ minLength: 1, maxLength: 16384, description: "Self-contained task for OpenCode." }) },
  { additionalProperties: false },
);

const errorResult = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: undefined, isError: true });

export function registerOpencodePoc(pi: ExtensionAPI, deps: OpencodePocDeps = { runTask: (p, c, s, u) => runOpenCodeTask(p, c, s, u), isChild: inChildSessionContext }): void {
  if (deps.isChild()) return;
  pi.registerTool(
    defineTool({
      name: "opencode_task",
      label: "OpenCode task",
      description: `Delegate one self-contained task to the OpenCode CLI pinned to ${OPENCODE_MODEL}. OpenCode runs separately with its own tools and permissions; not a Pi child session.`,
      parameters,
      executionMode: "sequential",
      async execute(_id, params, signal, onUpdate, ctx) {
        if (deps.isChild()) return errorResult("opencode_task is unavailable inside a child session");
        if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
          return errorResult("OpenCode task requires trusted interactive TUI approval");
        }
        const prompt = params.prompt;
        if (prompt.trim().length === 0 || prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > 16_384) {
          return errorResult("Prompt must contain 1–16384 UTF-8 bytes and no NUL");
        }
        if (signal?.aborted) return errorResult("OpenCode task aborted before approval");
        let cwd: string;
        try {
          cwd = await realpath(ctx.cwd);
        } catch {
          return errorResult("Cannot resolve the working directory");
        }
        if (signal?.aborted) return errorResult("OpenCode task aborted");
        const message = [
          `Working directory: ${cwd}`,
          `Model: ${OPENCODE_MODEL}`,
          `Task:\n${prompt}`,
          "Warning: OpenCode runs separately with its own permissions and may read or write files in the working directory.",
        ].join("\n\n");
        let approved = false;
        try {
          approved = await ctx.ui.confirm("Run OpenCode task?", message, { signal, timeout: APPROVAL_TIMEOUT_MS });
        } catch {
          return errorResult("OpenCode task approval failed or timed out");
        }
        if (!approved) return errorResult("OpenCode task denied by user");
        if (signal?.aborted) return errorResult("OpenCode task aborted after approval");
        if (deps.isChild()) return errorResult("opencode_task is unavailable inside a child session");
        try {
          const result = await deps.runTask(prompt, cwd, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }));
          return { content: [{ type: "text" as const, text: result.text }], details: result.details, isError: false };
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  );
}

export default function registerDefault(pi: ExtensionAPI): void {
  registerOpencodePoc(pi);
}
