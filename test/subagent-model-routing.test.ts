import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager, type SubagentRouting } from "../src/agent-manager.js";
import type { RunResult } from "../src/agent-runner.js";
import { runAgent } from "../src/agent-runner.js";
import { FALLBACK_SUBAGENT_MODEL, modelKey, type SubagentRoutingState } from "../src/model-routing.js";

const PRIMARY = { provider: "faux", id: "primary-1" };
/** The real fallback constant: the retry leg is fixed, not configurable. */
const FALLBACK = { provider: "openrouter", id: "nvidia/nemotron-3-ultra-550b-a55b:free" };

function router(state: SubagentRoutingState, models = [PRIMARY, FALLBACK]): SubagentRouting {
  return { state, catalogFor: () => models };
}

function mockCtx(models = [PRIMARY, { provider: "faux", id: "reviewer-1" }, FALLBACK]) {
  return {
    cwd: "/tmp",
    scopedModels: [],
    modelRegistry: {
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
      getAll: () => models,
      getAvailable: () => models,
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as any;
}

const state = (over: Partial<SubagentRoutingState> = {}): SubagentRoutingState => ({
  effective: "faux/primary-1",
  reviewerEffective: "faux/primary-1",
  stale: false,
  routingFailed: false,
  ...over,
});

const ok = () => ({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
const providerFail = () => ({ ...ok(), responseText: "", failure: "429 rate limit exceeded" });
const fresh = (over: Record<string, unknown> = {}) => ({ description: "d", isBackground: false, ...over });

/** Runs a fresh dispatch to completion (or startup failure). */
async function spawnAndSettle(manager: AgentManager, over: Record<string, unknown> = {}) {
  const { type = "general-purpose", ...options } = over;
  const id = manager.spawn({} as any, mockCtx(), type as string, "p", fresh(options) as any);
  const record = manager.getRecord(id);
  await (record?.promise ?? manager.awaitStartup(id)).catch(() => {});
  return record;
}

/** A refused dispatch: `spawn` returns an id, the startup rejects. */
async function spawnRefused(manager: AgentManager, over: Record<string, unknown> = {}) {
  const id = manager.spawn({} as any, mockCtx(), "general-purpose", "p", fresh(over) as any);
  await manager.awaitStartup(id);
}

let manager: AgentManager | undefined;

beforeEach(() => {
  // vitest.config disables routing process-wide for narrow faux harnesses;
  // these tests supply their own catalog and need the route live.
  delete process.env.PI_SUBAGENTS_MODEL_ROUTING;
});

afterEach(() => {
  manager?.dispose();
  manager = undefined;
  vi.mocked(runAgent).mockReset();
});

describe("shared routing at startAgent", () => {
  it("uses reviewer model only for reviewer agents", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ reviewerEffective: "faux/reviewer-1" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing, [
      PRIMARY,
      { provider: "faux", id: "reviewer-1" },
      FALLBACK,
    ]));

    await spawnAndSettle(manager, { type: "reviewer" });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual({ provider: "faux", id: "reviewer-1" });
  });

  it("uses shared model for every non-reviewer agent", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ reviewerEffective: "faux/reviewer-1" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing, [
      PRIMARY,
      { provider: "faux", id: "reviewer-1" },
      FALLBACK,
    ]));

    await spawnAndSettle(manager, { type: "worker" });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(PRIMARY);
  });

  it("runs the routed model instead of the caller's inherited model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager, { model: FALLBACK });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(PRIMARY);
  });

  it("retries the same task once on the fallback after a provider failure", async () => {
    expect(modelKey(FALLBACK)).toBe(FALLBACK_SUBAGENT_MODEL);
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as RunResult).mockResolvedValueOnce(ok() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    const record = await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(FALLBACK);
    expect(routing.routingFailed).toBe(false);
    expect(record?.status).toBe("completed");
  });

  it("does not retry a task failure", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      ...ok(),
      responseText: "",
      failure: "gate command failed: npm test",
    } as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(routing.routingFailed).toBe(false);
  });

  it("does not retry an aborted run", async () => {
    vi.mocked(runAgent).mockResolvedValue({ ...ok(), aborted: true, failure: "429 rate limit" } as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown non-provider error", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("structured output schema mismatch"));
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown provider error once", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("401 unauthorized")).mockResolvedValueOnce(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("latches when the fallback fails, then refuses the next fresh dispatch without running it", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(routing.routingFailed).toBe(true);
    expect(routing.terminalReason).toContain("429 rate limit exceeded");

    await expect(spawnRefused(manager)).rejects.toThrow(/routing stopped/i);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("fails before running when the routed model is not in the catalog", async () => {
    const routing = state({ effective: "faux/gone" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    await expect(spawnRefused(manager)).rejects.toThrow(/unavailable/i);
    expect(routing.routingFailed).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("fails before running when the fallback is not in the catalog", async () => {
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing, [PRIMARY]));
    await expect(spawnRefused(manager)).rejects.toThrow(/unavailable/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects a conflicting caller-supplied model override", async () => {
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state()));
    await expect(
      spawnRefused(manager, { model: FALLBACK, modelOverride: "faux/fallback-1" }),
    ).rejects.toThrow(/override/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("accepts a caller override that names the routed model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager, { model: PRIMARY, modelOverride: "faux/primary-1" });
    expect(runAgent).toHaveBeenCalled();
  });

  it("leaves resumes on their own model, out of the route and out of the latch", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ effective: "faux/gone", routingFailed: true, terminalReason: "latched" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager, { resumeSessionFile: "/tmp/s.jsonl", model: FALLBACK });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(FALLBACK);
  });

  it("settles once per logical task and leaks no pool slot", async () => {
    const completions: string[] = [];
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as RunResult).mockResolvedValueOnce(ok() as RunResult);
    manager = new AgentManager((r) => completions.push(r.id), 10, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager, { isBackground: true });
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(completions).toHaveLength(1);
    expect((manager as any).runningBackground).toBe(0);
  });

  it("keeps the caller's model when routing is disabled for the process", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    process.env.PI_SUBAGENTS_MODEL_ROUTING = "off";
    try {
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state()));
      await spawnAndSettle(manager, { model: FALLBACK });
      expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(FALLBACK);
    } finally {
      delete process.env.PI_SUBAGENTS_MODEL_ROUTING;
    }
  });
});
