/**
 * mention-clone-tool-reachability.e2e.test.ts — reachability guard for the one
 * tool the mention clone is built around.
 *
 * `runMentionClone` hands a session ONE tool and expects the model to call it.
 * Whether that tool ever reaches the model is decided entirely inside Pi, by
 * `createAgentSession`'s allowlist plumbing — and the unit tests cannot see it:
 * their `createAgentSession` is a mock that hands `customTools[0]` straight to
 * the model turn, so a session option that silently strips the tool passes
 * every one of them.
 *
 * That is not hypothetical. The clone shipped with `noTools: "all"` on the
 * reading its doc comment invites ("start with no tools enabled" — no
 * built-ins, keep mine). Pi turns that flag into an EMPTY allowlist, and an
 * empty array is truthy, so `AgentSession` builds an empty `Set` and
 * `isAllowedTool` rejects every name — custom tools are filtered by the same
 * predicate as built-ins. Every mention was prompted with no tools, answered in
 * prose, and fell back to a direct start with a warning. The unit suite stayed
 * green throughout.
 *
 * These tests use a REAL session to establish behavior a mock cannot:
 *   1. the clone's `Agent` tool is active, and nothing else is;
 *   2. the provider receives the main prompt/history and Agent dispatch retains
 *      main-session attribution.
 *
 * No network/LLM: a faux provider drives a real turn for prompt/history and
 * attribution; a second test inspects the constructed tool set directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real pi-mono session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

// Hoisted so the (lifted) mock factory can reach it. Everything except the
// capture is the real module — the point is to construct a REAL session.
const { sessions } = vi.hoisted(() => ({ sessions: [] as any[] }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: async (opts: any) => {
      const created = await actual.createAgentSession(opts);
      sessions.push(created.session);
      return created;
    },
  };
});

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

describe("mention clone tool reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    sessions.length = 0;
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("projects the exact main-session prompt and branch to the provider", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parentSessionManager = SessionManager.inMemory(cwd);
    parentSessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main-session user marker" }],
      timestamp: 1,
    } as any);
    parentSessionManager.appendMessage(fauxAssistantMessage("main-session assistant marker", { timestamp: 2 }));

    let request: any;
    faux.setResponses([
      (context) => {
        request = context;
        return fauxAssistantMessage(
          fauxToolCall("Agent", { subagent_type: "Explore", prompt: "spawn" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("finished"),
    ]);

    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT LIVE SYSTEM PROMPT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: parentSessionManager,
    };
    const executeAgent = vi.fn(async (
      _toolCallId: string,
      _params: { subagent_type: string; prompt: string; run_in_background?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionToolContext,
    ) => ({
      content: [{ type: "text" as const, text: "Agent ID: a1" }],
      details: {},
    }));
    const agentTool = defineTool({
      name: "Agent",
      label: "Agent",
      description: "Launch a test agent",
      parameters: Type.Object({
        subagent_type: Type.String(),
        prompt: Type.String(),
        run_in_background: Type.Optional(Type.Boolean()),
      }),
      execute: executeAgent,
    });

    const result = await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(faux.state.callCount).toBe(2);
    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ spawned: true });
    expect(request).toBeDefined();
    const effectiveSystemPrompt =
      request.systemPrompt ?? request.messages.find((message: any) => message.role === "system")?.content;
    expect(effectiveSystemPrompt).toBe("PARENT LIVE SYSTEM PROMPT");
    const transcriptText = request.messages
      .flatMap((message: any) =>
        typeof message.content === "string"
          ? [message.content]
          : Array.isArray(message.content)
            ? message.content.flatMap((block: any) => (block.type === "text" ? [block.text] : []))
            : [],
      )
      .join("\n");
    expect(transcriptText).toContain("main-session user marker");
    expect(transcriptText).toContain("main-session assistant marker");
    expect(sessions[0].getActiveToolNames()).toEqual(["Agent"]);
    const agentCall = executeAgent.mock.calls.at(-1);
    if (!agentCall) throw new Error("Agent handler was not called");
    const toolContext = agentCall[4];
    expect(toolContext.cwd).toBe(cwd);
    expect(toolContext.sessionManager).toBe(parentSessionManager);
  });

  it("the clone's Agent tool is live on the real session, and it is the only one", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      // mention-clone reads the runtime off the registry facade, the same shim
      // agent-runner carries for Pi >= 0.80.8.
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getEntries: () => [], getLeafId: () => undefined, getBranch: () => [] },
    };

    // Never called: the assertion is on what the session exposes, not on the
    // faux model deciding to use it.
    const agentTool = { name: "Agent", execute: vi.fn() } as any;

    // Never rejects by contract; a faux turn that cannot complete is fine,
    // because the tool set is fixed at construction.
    await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(sessions).toHaveLength(1);
    // The bug this file exists for: with an empty allowlist this is `[]`.
    expect(sessions[0].getActiveToolNames()).toEqual(["Agent"]);
  });
});
