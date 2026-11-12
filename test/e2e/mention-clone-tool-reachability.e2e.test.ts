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
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
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
      role: "system",
      content: "",
      sections: { preamble: "STALE-PARENT-PROMPT" },
      toolsAdded: [{ name: "read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }) }],
      timestamp: 0,
    } as never);
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
    const effectiveSystemPrompt = getCurrentSystemPrompt(request.messages);
    expect(effectiveSystemPrompt).toContain("PARENT LIVE SYSTEM PROMPT");
    expect(effectiveSystemPrompt).not.toContain("STALE-PARENT-PROMPT");
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

  it("the clone's request carries the parent's conversation and system prompt, and it spawns", async () => {
    // Pi 1.x keeps the prompt and the history in the session's transcript:
    // `AgentState.systemPrompt` is a read-only getter, and SessionManager is the
    // source of every request's context. A clone seeded by mutating agent state
    // throws on the prompt assignment and never reaches its turn.
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parent = SessionManager.inMemory(cwd);
    // What a real parent transcript opens with: its prompt and its full tool set.
    parent.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "STALE-PARENT-PROMPT" },
      toolsAdded: [{ name: "read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }) }],
      timestamp: 0,
    } as never);
    parent.appendMessage({ role: "user", content: "PARENT-HISTORY question", timestamp: 1 });
    parent.appendMessage(fauxAssistantMessage("PARENT-HISTORY answer"));
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT-PROMPT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: parent,
    };

    let seen: Context | undefined;
    faux.setResponses([
      (context: Context) => {
        seen = context;
        return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "go" }));
      },
      fauxAssistantMessage("done"),
    ]);
    const agentTool = {
      name: "Agent",
      description: "Launch an agent.",
      parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "Agent ID: a1" }], details: undefined })),
    } as any;

    const result = await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(result).toEqual({ spawned: true });
    expect(seen).toBeDefined();
    const text = JSON.stringify(seen!.messages.filter((m) => m.role !== "system"));
    expect(text).toContain("PARENT-HISTORY question");
    expect(text).toContain("PARENT-HISTORY answer");
    expect(getCurrentSystemPrompt(seen!.messages)).toContain("PARENT-PROMPT");
    // Replayed, then patched over — not dropped on the way in.
    expect(JSON.stringify(seen!.messages)).toContain("STALE-PARENT-PROMPT");
    expect(getCurrentSystemPrompt(seen!.messages)).not.toContain("STALE-PARENT-PROMPT");
    // The parent's tools are withdrawn: the invisible turn can call Agent and nothing else.
    expect(getCurrentTools(seen!.messages).map((t) => t.name)).toEqual(["Agent"]);
  });
});
