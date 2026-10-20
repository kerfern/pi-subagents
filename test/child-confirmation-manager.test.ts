import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock, resumeAgentMock, steerAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  resumeAgentMock: vi.fn(),
  steerAgentMock: vi.fn(),
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: runAgentMock,
  resumeAgent: resumeAgentMock,
  steerAgent: steerAgentMock,
}));

import { AgentManager } from "../src/agent-manager.js";

const managers: AgentManager[] = [];
const session = {} as AgentSession;
const pi = {} as ExtensionAPI;
const ctx = {
  cwd: process.cwd(),
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
} as unknown as ExtensionContext;

function managerWithBridge(bridge: object): AgentManager {
  const ManagerWithBridge = AgentManager as unknown as new (...args: unknown[]) => AgentManager;
  const managerBridge = { invalidate: vi.fn(), dispose: vi.fn(), ...bridge };
  const manager = new ManagerWithBridge(undefined, 1, undefined, undefined, undefined, undefined, managerBridge);
  managers.push(manager);
  return manager;
}

async function createCompletedRecord(manager: AgentManager): Promise<string> {
  runAgentMock.mockResolvedValueOnce({
    responseText: "first run",
    session,
    aborted: false,
    steered: false,
  });
  const id = manager.spawn(pi, ctx, "general-purpose", "inspect", {
    description: "inspect",
    isBackground: true,
    bypassQueue: true,
  });
  await manager.waitForAll();
  return id;
}

beforeEach(() => {
  runAgentMock.mockReset();
  resumeAgentMock.mockReset();
  steerAgentMock.mockReset();
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
});

describe("manager confirmation ownership", () => {
  it("disposes its manager-owned confirmation bridge", async () => {
    const dispose = vi.fn();
    const manager = managerWithBridge({ forChild: vi.fn(), dispose });

    await manager.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("passes one manager-issued child binding and record-owned signal to every fresh run", async () => {
    const binding = { uiContext: undefined, beginRun: vi.fn(() => vi.fn()) };
    const forChild = vi.fn(() => binding);
    const bridge = { forChild, invalidate: vi.fn(), dispose: vi.fn() };
    const manager = managerWithBridge(bridge);

    const id = await createCompletedRecord(manager);

    expect(forChild).toHaveBeenCalledOnce();
    expect(forChild).toHaveBeenCalledWith(id, "general-purpose");
    const options = runAgentMock.mock.calls[0][3] as {
      childConfirmation?: object;
      signal?: AbortSignal;
    };
    expect(options.childConfirmation).toBe(binding);
    expect(options.signal).toBe(manager.getRecord(id)?.abortController?.signal);
  });

  it("forwards foreground resume caller abort into fresh record controller used for stopping", async () => {
    const manager = managerWithBridge({ forChild: vi.fn() });
    const id = await createCompletedRecord(manager);
    const caller = new AbortController();
    let finishResume!: (result: { text: string }) => void;
    resumeAgentMock.mockImplementationOnce(() => new Promise(resolve => { finishResume = resolve; }));

    const resuming = manager.resume(id, "continue", caller.signal);
    await Promise.resolve();
    const resumeOptions = resumeAgentMock.mock.calls[0][2] as { signal?: AbortSignal };
    const recordSignal = manager.getRecord(id)?.abortController?.signal;
    expect(resumeOptions.signal).toBe(recordSignal);
    expect(resumeOptions.signal).not.toBe(caller.signal);

    caller.abort();
    expect(resumeOptions.signal?.aborted).toBe(true);
    finishResume({ text: "continued" });
    await resuming;
    expect(manager.getRecord(id)?.status).toBe("stopped");
  });

  it("does not prompt on a foreground resume whose caller signal is already aborted", async () => {
    const manager = managerWithBridge({ forChild: vi.fn() });
    const id = await createCompletedRecord(manager);
    const caller = new AbortController();
    caller.abort();

    const result = await manager.resume(id, "continue", caller.signal);

    expect(result?.status).toBe("stopped");
    expect(resumeAgentMock).not.toHaveBeenCalled();
  });

  it("lets manager stop abort a foreground resumed run", async () => {
    const manager = managerWithBridge({ forChild: vi.fn() });
    const id = await createCompletedRecord(manager);
    let finishResume!: (result: { text: string }) => void;
    resumeAgentMock.mockImplementationOnce(() => new Promise(resolve => { finishResume = resolve; }));

    const resuming = manager.resume(id, "continue");
    await Promise.resolve();
    const resumeOptions = resumeAgentMock.mock.calls[0][2] as { signal?: AbortSignal };
    expect(manager.abort(id)).toBe(true);
    expect(resumeOptions.signal?.aborted).toBe(true);
    finishResume({ text: "stopped" });
    await resuming;
    expect(manager.getRecord(id)?.status).toBe("stopped");
  });
});
