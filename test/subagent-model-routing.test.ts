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
import { NO_FALLBACK } from "../src/agent-types.js";
import type { SubagentRoutingState } from "../src/model-routing.js";

const PRIMARY = { provider: "faux", id: "primary-1" };
/** Independent catalog entry required by the retry behavior test. */
const FALLBACK = { provider: "commandcode", id: "minimax/minimax-m3.1-flash" };

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
async function spawnAndSettle(
  manager: AgentManager,
  over: Record<string, unknown> = {},
  models?: Array<{ provider: string; id: string }>,
) {
  const { type = "general-purpose", ...options } = over;
  const id = manager.spawn({} as any, mockCtx(models), type as string, "p", fresh(options) as any);
  // `spawn` records the promise on a later tick; without this the helper would
  // await only startup and read a half-settled record.
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  it("routes reviewer, Plan, and advisor roles to reviewer model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ reviewerEffective: "faux/reviewer-1" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [
      PRIMARY,
      { provider: "faux", id: "reviewer-1" },
      FALLBACK,
    ]));

    for (const type of ["reviewer", "Plan", "advisor"]) {
      vi.mocked(runAgent).mockClear();
      await spawnAndSettle(manager, { type });
      expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual({ provider: "faux", id: "reviewer-1" });
    }
  });

  it("uses shared model for ordinary agents and Explore", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ reviewerEffective: "faux/reviewer-1" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [
      PRIMARY,
      { provider: "faux", id: "reviewer-1" },
      FALLBACK,
    ]));

    for (const type of ["worker", "Explore"]) {
      vi.mocked(runAgent).mockClear();
      await spawnAndSettle(manager, { type });
      expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(PRIMARY);
    }
  });

  it("uses reviewer thinking route for reviewer, Plan, and advisor roles", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({
      reviewerEffectiveThinking: "high",
      effectiveThinking: "low",
    } as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));

    for (const type of ["reviewer", "Plan", "advisor"]) {
      vi.mocked(runAgent).mockClear();
      await spawnAndSettle(manager, { type });
      expect(vi.mocked(runAgent).mock.calls[0][3]!.thinkingLevel).toBe("high");
    }

    vi.mocked(runAgent).mockClear();
    await spawnAndSettle(manager, { type: "worker" });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.thinkingLevel).toBe("low");
  });

  it("runs routed thinking instead of inherited or frontmatter thinking", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ effectiveThinking: "high" } as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));

    await spawnAndSettle(manager, { thinkingLevel: "low" });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.thinkingLevel).toBe("high");
  });

  it("refuses an explicit thinking level that conflicts with the route", async () => {
    const routing = state({ effectiveThinking: "high" } as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));

    await expect(spawnRefused(manager, {
      thinkingLevel: "medium",
      thinkingOverride: "medium",
    })).rejects.toThrow(
      'Thinking override "medium" is refused: this session routes general-purpose to high. Change it with /subagent-model.',
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("allows an explicit thinking level that matches the route", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ effectiveThinking: "high" } as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));

    await spawnAndSettle(manager, { thinkingLevel: "high", thinkingOverride: "high" });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.thinkingLevel).toBe("high");
  });

  it("runs the routed model instead of the caller's inherited model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager, { model: FALLBACK });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(PRIMARY);
  });

  it("retries the same task once on the fallback after a provider failure", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as RunResult).mockResolvedValueOnce(ok() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    const record = await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(FALLBACK);
    expect(routing.routingFailed).toBe(false);
    expect(record?.status).toBe("completed");
  });

  it("does not retry a leg that throws a provider error again, and does not latch", async () => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce(providerFail() as RunResult)
      .mockRejectedValueOnce(new Error("429 fallback quota exceeded"))
      .mockResolvedValueOnce(ok() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));

    await spawnAndSettle(manager);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(routing.routingFailed).toBe(false);
  });

  it("does not retry a task failure", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      ...ok(),
      responseText: "",
      failure: "gate command failed: npm test",
    } as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(routing.routingFailed).toBe(false);
  });

  it("does not retry an aborted run", async () => {
    vi.mocked(runAgent).mockResolvedValue({ ...ok(), aborted: true, failure: "429 rate limit" } as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown non-provider error", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("structured output schema mismatch"));
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown provider error once", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("401 unauthorized")).mockResolvedValueOnce(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("reports the leg's failure for that task and leaves the route free for the next dispatch", async () => {
    // A runtime error is evidence about one task, not about routing: latching here
    // would kill every later dispatch over a transient failure on the retry provider.
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(routing.routingFailed).toBe(false);

    vi.mocked(runAgent).mockResolvedValue({ ...ok(), responseText: "recovered" } as RunResult);
    const again = await spawnAndSettle(manager);
    expect(again?.result).toBe("recovered");
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it("runs a specialist on its own route, then on the leg, without latching", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state({ reviewerEffective: "faux/reviewer-1" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [
      PRIMARY,
      { provider: "faux", id: "reviewer-1" },
      FALLBACK,
    ]));

    await spawnAndSettle(manager, { type: "advisor" });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual({ provider: "faux", id: "reviewer-1" });
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(FALLBACK);
    expect(routing.routingFailed).toBe(false);
  });

  it("fails before running when the routed model is not in the catalog", async () => {
    const routing = state({ effective: "faux/gone" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    await expect(spawnRefused(manager)).rejects.toThrow(/unavailable/i);
    expect(routing.routingFailed).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("with the retry leg off, a provider failure is reported and not retried or latched", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    manager.setFallbackModel(NO_FALLBACK);

    const record = await spawnAndSettle(manager);

    // One dispatch, on the routed model: no silent provider switch.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(PRIMARY);
    expect(record?.status).toBe("error");
    // A transient provider error must not stop every later dispatch.
    expect(routing.routingFailed).toBe(false);
  });

  it("with the retry leg off, a thrown provider error is not retried", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("429 rate limit exceeded"));
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    manager.setFallbackModel(NO_FALLBACK);

    await spawnAndSettle(manager);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(routing.routingFailed).toBe(false);
  });

  it("with the retry leg off, an unavailable default leg no longer blocks dispatch", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state();
    // Only the routed model is in the catalog; the default leg is absent.
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [PRIMARY]));
    manager.setFallbackModel(NO_FALLBACK);

    const record = await spawnAndSettle(manager);

    expect(record?.status).toBe("completed");
    expect(routing.routingFailed).toBe(false);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("uses a configured retry leg and does not latch when that leg fails", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    manager.setFallbackModel("commandcode/minimax/minimax-m3.1-flash");

    await spawnAndSettle(manager);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(FALLBACK);
    expect(routing.routingFailed).toBe(false);
  });

  it("honors a configured leg that differs from the shipped default", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    // A distinct key, so the assertion cannot pass by falling back to the constant.
    const leg = { provider: "faux", id: "retry-2" };
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [PRIMARY, leg]));
    manager.setFallbackModel("faux/retry-2");

    // The leg must be in the dispatch catalog too, not only in the routed one.
    await spawnAndSettle(manager, {}, [PRIMARY, leg]);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(leg);
    expect(routing.routingFailed).toBe(false);
  });

  it("treats a retry leg naming the routed model as off", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    manager.setFallbackModel("faux/primary-1");

    await spawnAndSettle(manager);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(routing.routingFailed).toBe(false);
  });

  it("dispatches normally when the leg is not in this session's catalog", async () => {
    // The leg is resolved only if a provider actually fails, so a scope list that
    // omits it cannot refuse work that never needed the retry.
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [PRIMARY]));
    const record = await spawnAndSettle(manager);
    expect(record?.result).toBe("done");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(routing.routingFailed).toBe(false);
  });

  it("surfaces the routed model's failure when the leg is out of catalog at failure time", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    const routing = state();
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing, [PRIMARY]));
    const record = await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(record?.error).toContain("429 rate limit exceeded");
    expect(routing.routingFailed).toBe(false);
  });

  it("rejects a conflicting caller-supplied model override", async () => {
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    await expect(
      spawnRefused(manager, { model: FALLBACK, modelOverride: "faux/fallback-1" }),
    ).rejects.toThrow(/override/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("accepts a caller override that names the routed model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager, { model: PRIMARY, modelOverride: "faux/primary-1" });
    expect(runAgent).toHaveBeenCalled();
  });

  it("leaves resumes on their own model, out of the route and out of the latch", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    const routing = state({ effective: "faux/gone", routingFailed: true, terminalReason: "latched" });
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(routing));
    await spawnAndSettle(manager, { resumeSessionFile: "/tmp/s.jsonl", model: FALLBACK });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(FALLBACK);
  });

  it("settles once per logical task and leaks no pool slot", async () => {
    const completions: string[] = [];
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as RunResult).mockResolvedValueOnce(ok() as RunResult);
    manager = new AgentManager((r) => completions.push(r.id), 10, undefined, undefined, undefined, undefined, router(state()));
    await spawnAndSettle(manager, { isBackground: true });
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(completions).toHaveLength(1);
    expect((manager as any).runningBackground).toBe(0);
  });

  it("keeps the caller's model when routing is disabled for the process", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    process.env.PI_SUBAGENTS_MODEL_ROUTING = "off";
    try {
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
      await spawnAndSettle(manager, { model: FALLBACK });
      expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(FALLBACK);
    } finally {
      delete process.env.PI_SUBAGENTS_MODEL_ROUTING;
    }
  });
});

describe("provider pool at startAgent", () => {
  const SEAT1 = { provider: "github-copilot", id: "gpt-6-luna" };
  const SEAT2 = { provider: "github-copilot-2", id: "gpt-6-luna" };
  const SEATS = [SEAT1, SEAT2, PRIMARY, { provider: "faux", id: "reviewer-1" }, FALLBACK];
  const pooled = () => state({ effective: "github-copilot/gpt-6-luna", reviewerEffective: "faux/reviewer-1" });

  it("rotates to the next seat on a provider failure and records both attempts", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as RunResult).mockResolvedValueOnce(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });

    const record = await spawnAndSettle(manager, {}, SEATS);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(SEAT1);
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(SEAT2);
    expect(record?.providerRoute?.attempts.map((a) => [a.key, a.outcome, a.reason])).toEqual([
      ["github-copilot/gpt-6-luna", "provider-error", "provider error"],
      ["github-copilot-2/gpt-6-luna", "success", undefined],
    ]);
    expect(record?.providerRoute?.servedModelKey).toBe("github-copilot-2/gpt-6-luna");
  });

  it("never rotates for a task failure", async () => {
    vi.mocked(runAgent).mockResolvedValue({ ...providerFail(), failure: "2 tests failed" } as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });

    const record = await spawnAndSettle(manager, {}, SEATS);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(record?.providerRoute?.attempts.map((a) => a.outcome)).toEqual(["task-error"]);
  });

  it("does not replay a seat that already ran a tool", async () => {
    vi.mocked(runAgent).mockImplementation(((_pi: any, _ctx: any, _type: any, opts: any) => {
      opts.onToolActivity?.({ type: "end" });
      return Promise.resolve(providerFail() as RunResult);
    }) as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });

    const record = await spawnAndSettle(manager, {}, SEATS);

    // Rotating here would replay the same prompt in the same worktree after
    // side effects already happened.
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(record?.providerRoute?.attempts.map((a) => [a.outcome, a.reason])).toEqual([
      ["provider-error", "tools already ran; not replayed"],
    ]);
  });

  it("does not record success when the dispatch was stopped", async () => {
    let release: (result: RunResult) => void = () => {};
    vi.mocked(runAgent).mockImplementation((() => new Promise<RunResult>((resolve) => {
      release = resolve;
    })) as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });

    const id = manager.spawn({} as any, mockCtx(SEATS), "general-purpose", "p", fresh() as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.abort(id)).toBe(true);
    release(ok() as RunResult);

    const record = manager.getRecord(id);
    await record?.promise;
    expect(record?.status).toBe("stopped");
    expect(record?.providerRoute?.servedModelKey).toBeUndefined();
    expect(record?.providerRoute?.attempts.map((a) => a.outcome)).not.toContain("success");
  });

  it("spends the pool and then the declared retry leg", async () => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce(providerFail() as RunResult)
      .mockResolvedValueOnce(providerFail() as RunResult)
      .mockResolvedValueOnce(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });
    manager.setFallbackModel("commandcode/minimax/minimax-m3.1-flash");

    const record = await spawnAndSettle(manager, {}, SEATS);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runAgent).mock.calls[2][3]!.model).toEqual(FALLBACK);
    expect(record?.providerRoute?.attempts.map((a) => a.leg)).toEqual(["pool", "pool", "fallback"]);
    expect(record?.providerRoute?.servedModelKey).toBe("commandcode/minimax/minimax-m3.1-flash");
  });

  it("does not spend a retry leg that names a pool member", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });
    manager.setFallbackModel("github-copilot-2/gpt-6-luna");

    const record = await spawnAndSettle(manager, {}, SEATS);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(record?.providerRoute?.attempts.map((a) => a.leg)).toEqual(["pool", "pool"]);
  });

  it("records a member missing from this session's catalog as skipped", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({
      strategy: "fill_first",
      members: ["github-copilot", "github-copilot-absent", "github-copilot-2"],
    });

    const record = await spawnAndSettle(manager, {}, SEATS);

    // The missing member is recorded BEFORE the seat that actually served it.
    expect(record?.providerRoute?.attempts.map((a) => [a.key, a.outcome])).toEqual([
      ["github-copilot-absent/gpt-6-luna", "skipped"],
      ["github-copilot/gpt-6-luna", "success"],
    ]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
  });

  it("does not pool a specialist route outside the anchored seat", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(pooled(), SEATS));
    manager.setProviderPool({ strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] });

    const record = await spawnAndSettle(manager, { type: "reviewer" }, SEATS);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual({ provider: "faux", id: "reviewer-1" });
    expect(record?.providerRoute).toBeUndefined();
  });

  it("leaves a dispatch exactly as before when the pool is off", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state(), SEATS));
    // Without a leg, a provider failure is reported on the routed model.
    manager.setFallbackModel(NO_FALLBACK);

    const record = await spawnAndSettle(manager, {}, SEATS);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(record?.providerRoute).toBeUndefined();
  });
});
