import type { AgentSession, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, bindExtensions } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  bindExtensions: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
  },
  getAgentDir: () => "/tmp/pi-subagents-test-agent-dir",
  SessionManager: { inMemory: () => ({}), create: () => ({}) },
  SettingsManager: { create: () => ({ getSessionDir: () => undefined }) },
}));
vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read"],
  getConfig: () => ({ extensions: false, skills: false }),
  getAgentConfig: () => undefined,
  getToolNamesForType: () => ["read"],
  getMemoryToolNames: () => [],
  getReadOnlyMemoryToolNames: () => [],
}));
vi.mock("../src/env.js", () => ({ detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "test" }) }));
vi.mock("../src/prompts.js", () => ({ buildAgentPrompt: () => "test prompt" }));

import { getGraceTurns, resumeAgent, runAgent, setGraceTurns } from "../src/agent-runner.js";

function makeSession() {
  const subscribers: ((event: { type: string }) => void)[] = [];
  return {
    setSessionName: vi.fn(),
    bindExtensions,
    getAllTools: vi.fn(() => [{ name: "read" }]),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    agent: {},
    messages: [],
    subscribe: vi.fn((handler: unknown) => {
      subscribers.push(handler as (event: { type: string }) => void);
      return vi.fn();
    }),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(),
    abort: vi.fn(),
    emit: (type: string) => {
      for (const handler of subscribers) handler({ type });
    },
  };
}

describe("child confirmation runner binding", () => {
  beforeEach(() => {
    bindExtensions.mockReset();
    createAgentSession.mockReset();
  });

  it("uses manager UI during extension startup and renews the retained-session lease", async () => {
    const confirm = vi.fn(async (_title: string, _message: string) => true);
    const ui = { confirm } as unknown as ExtensionUIContext;
    const closes: ReturnType<typeof vi.fn>[] = [];
    const beginRun = vi.fn(() => {
      const close = vi.fn();
      closes.push(close);
      return close;
    });
    let startupAnswer: boolean | undefined;
    let leaseStartedAtBinding = false;
    bindExtensions.mockImplementation(async (bindings: { uiContext?: ExtensionUIContext }) => {
      leaseStartedAtBinding = beginRun.mock.calls.length === 1;
      startupAnswer = await bindings.uiContext?.confirm("Inspect protected path", "Read source file?");
    });
    const session = makeSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = {
      cwd: process.cwd(),
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionFile: vi.fn() },
      getSystemPrompt: () => "parent",
    } as unknown as ExtensionContext;
    const options = { pi: {} as never, childConfirmation: { uiContext: ui, beginRun } };

    await runAgent(ctx, "general-purpose", "inspect", options);

    expect(startupAnswer).toBe(true);
    expect(leaseStartedAtBinding).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith("Inspect protected path", "Read source file?");
    expect(beginRun).toHaveBeenNthCalledWith(1, undefined);
    expect(closes[0]).toHaveBeenCalledOnce();

    const resumeSignal = new AbortController().signal;
    await resumeAgent(session as unknown as AgentSession, "continue", { signal: resumeSignal });
    expect(beginRun).toHaveBeenNthCalledWith(2, resumeSignal);
    expect(closes[1]).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledTimes(2);
  });

  it("closes run lease before aborting at the hard turn limit", async () => {
    const session = makeSession();
    session.prompt.mockImplementationOnce(async () => {
      session.emit("turn_end");
      session.emit("turn_end");
    });
    session.bindExtensions.mockResolvedValue(undefined);
    createAgentSession.mockResolvedValue({ session });
    const order: string[] = [];
    session.abort.mockImplementation(() => { order.push("abort"); });
    const closeRun = vi.fn(() => { order.push("close"); });
    const beginRun = vi.fn(() => closeRun);
    const ctx = {
      cwd: process.cwd(),
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionFile: vi.fn() },
      getSystemPrompt: () => "parent",
    } as unknown as ExtensionContext;
    const previousGraceTurns = getGraceTurns();
    setGraceTurns(1);
    try {
      const result = await runAgent(ctx, "general-purpose", "inspect", {
        pi: {} as never,
        maxTurns: 1,
        childConfirmation: {
          uiContext: { confirm: vi.fn(async () => true) } as unknown as ExtensionUIContext,
          beginRun,
        },
      });
      expect(result.aborted).toBe(true);
    } finally {
      setGraceTurns(previousGraceTurns);
    }

    expect(session.abort).toHaveBeenCalledOnce();
    expect(closeRun).toHaveBeenCalled();
    expect(order.indexOf("close")).toBeLessThan(order.indexOf("abort"));
  });

  it("closes startup lease when bindExtensions rejects", async () => {
    const closeRun = vi.fn();
    const beginRun = vi.fn(() => closeRun);
    const session = makeSession();
    createAgentSession.mockResolvedValue({ session });
    bindExtensions.mockRejectedValueOnce(new Error("startup failed"));
    const ctx = {
      cwd: process.cwd(),
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionFile: vi.fn() },
      getSystemPrompt: () => "parent",
    } as unknown as ExtensionContext;

    await expect(runAgent(ctx, "general-purpose", "inspect", {
      pi: {} as never,
      childConfirmation: {
        uiContext: { confirm: vi.fn(async () => true) } as unknown as ExtensionUIContext,
        beginRun,
      },
    })).rejects.toThrow("startup failed");
    expect(closeRun).toHaveBeenCalledOnce();
  });
});
