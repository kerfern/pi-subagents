import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager, type SubagentRouting } from "../src/agent-manager.js";
import { agentRecordEntryData } from "../src/agent-record-entry.js";
import type { RunResult } from "../src/agent-runner.js";
import { runAgent } from "../src/agent-runner.js";
import type { SubagentRoutingState } from "../src/model-routing.js";
import { loadSettings, type TeamPolicy, TeamPolicyError } from "../src/settings.js";

const PRIMARY = { provider: "faux", id: "primary-1" };
const SEAT2 = { provider: "faux-2", id: "primary-1" };
const FALLBACK = { provider: "commandcode", id: "minimax/minimax-m3.1-flash" };
const MODELS = [PRIMARY, SEAT2, FALLBACK, { provider: "faux", id: "reviewer-1" }];

function router(st: SubagentRoutingState, models = MODELS): SubagentRouting {
  return { state: st, catalogFor: () => models };
}

function mockCtx(models = MODELS) {
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
  reviewerEffective: "faux/reviewer-1",
  stale: false,
  routingFailed: false,
  ...over,
});

const ok = (tokens = 0) => ({
  responseText: "done",
  session: { dispose: vi.fn() } as any,
  aborted: false,
  steered: false,
  lifetimeUsage: tokens > 0 ? { input: tokens, output: 0, cacheWrite: 0 } : undefined,
});
const providerFail = () => ({ ...ok(), responseText: "", failure: "429 rate limit exceeded" });
const fresh = (over: Record<string, unknown> = {}) => ({ description: "d", isBackground: false, ...over });

async function spawnAndSettle(m: AgentManager, over: Record<string, unknown> = {}, type: any = "general-purpose") {
  const id = m.spawn({} as any, mockCtx(), type, "p", fresh(over) as any);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const record = m.getRecord(id);
  await (record?.promise ?? m.awaitStartup(id)).catch(() => {});
  return record;
}

let manager: AgentManager | undefined;

beforeEach(() => {
  delete process.env.PI_SUBAGENTS_MODEL_ROUTING;
});

afterEach(() => {
  manager?.dispose();
  manager = undefined;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("teamPolicy settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "team-policy-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function loadWith(body: unknown) {
    const cwd = join(dir, `c-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ teamPolicy: body }));
    return () => loadSettings(cwd);
  }

  it("refuses load with a named error for a malformed policy (not a silent off)", () => {
    expect(() => loadWith({ retries: 9, retryBaseMs: 0 })()).toThrow(TeamPolicyError);
    expect(() => loadWith({ retries: 9, retryBaseMs: 0 })()).toThrow(/Invalid teamPolicy: retries/);
    expect(() => loadWith({ maxTeamTokens: -1, retries: 0, retryBaseMs: 0 })()).toThrow(/maxTeamTokens/);
    expect(() => loadWith({ retries: 1, retryBaseMs: 6000 })()).toThrow(/retryBaseMs/);
  });

  it("accepts a well-formed policy", () => {
    const policy: TeamPolicy = { maxTeamTokens: 1000, retries: 2, retryBaseMs: 100 };
    expect(loadWith(policy)().teamPolicy).toEqual(policy);
  });

  it("accepts autoApprove as a boolean and refuses any other type", () => {
    const base = { retries: 1, retryBaseMs: 3000 };
    expect(loadWith({ ...base, autoApprove: true })().teamPolicy).toMatchObject({ autoApprove: true });
    expect(loadWith({ ...base, autoApprove: false })().teamPolicy).toMatchObject({ autoApprove: false });
    expect(() => loadWith({ ...base, autoApprove: "yes" })()).toThrow(/autoApprove must be a boolean/);
  });

  it("defaults to off", () => {
    expect(loadSettings(join(dir, "nowhere")).teamPolicy ?? false).toBe(false);
  });

  it("accepts a review reserve inside the cap and refuses a nonsensical one", () => {
    const base = { retries: 1, retryBaseMs: 3000 };
    expect(loadWith({ ...base, maxTeamTokens: 1000, reviewReserveTokens: 400 })().teamPolicy)
      .toMatchObject({ reviewReserveTokens: 400 });
    expect(loadWith({ ...base, maxTeamMs: 1000, reviewReserveMs: 250 })().teamPolicy)
      .toMatchObject({ reviewReserveMs: 250 });
    expect(() => loadWith({ ...base, reviewReserveTokens: 10 })()).toThrow(/requires maxTeamTokens/);
    expect(() => loadWith({ ...base, maxTeamTokens: 100, reviewReserveTokens: 200 })())
      .toThrow(/must not exceed maxTeamTokens/);
    expect(() => loadWith({ ...base, maxTeamMs: 100, reviewReserveMs: 200 })())
      .toThrow(/must not exceed maxTeamMs/);
  });
});

describe("admitDispatch / team token budget", () => {
  it("refuses a queued run once accumulated team tokens exceed the cap, visibly on the record", async () => {
    vi.mocked(runAgent)
      .mockImplementationOnce(((_pi: any, _ctx: any, _t: any, opts: any) => {
        opts.onAssistantUsage?.({ input: 600, output: 0, cacheWrite: 0 }, {});
        return Promise.resolve(ok(0) as RunResult);
      }) as any)
      .mockResolvedValue(ok(0) as RunResult);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, router(state()));
    manager.setTeamPolicy({ maxTeamTokens: 500, retries: 0, retryBaseMs: 0 });

    const first = await spawnAndSettle(manager);
    expect(first?.status).toBe("completed");

    const callsBefore = vi.mocked(runAgent).mock.calls.length;
    const second = await spawnAndSettle(manager);
    expect(vi.mocked(runAgent).mock.calls.length).toBe(callsBefore);
    expect(second?.status).toBe("error");
    expect(second?.error).toMatch(/team token budget exhausted/);
  });
});

describe("reserved review slice", () => {
  it("stops writers at cap minus reserve and still admits the final reviewer", async () => {
    vi.mocked(runAgent).mockImplementation(((_pi: any, _ctx: any, _t: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 700, output: 0, cacheWrite: 0 }, {});
      return Promise.resolve(ok(0) as RunResult);
    }) as any);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, router(state()));
    manager.setTeamPolicy({ maxTeamTokens: 1000, reviewReserveTokens: 400, retries: 0, retryBaseMs: 0 });

    expect((await spawnAndSettle(manager))?.status).toBe("completed");
    const refusedWriter = await spawnAndSettle(manager);
    expect(refusedWriter?.status).toBe("error");
    expect(refusedWriter?.error).toMatch(/writer token budget exhausted \(700 ≥ 600; the cap holds 400 beyond it for review dispatches\)/);

    const review = await spawnAndSettle(manager, {}, "reviewer");
    expect(review?.status).toBe("completed");
    expect(review?.providerAttempts ?? 1).toBeGreaterThan(0);
    expect(manager.getTeamUsage().tokens).toBe(1400);

    const secondReview = await spawnAndSettle(manager, {}, "reviewer");
    expect(secondReview?.status).toBe("error");
    expect(secondReview?.error).toMatch(/team token budget exhausted \(1400 ≥ maxTeamTokens 1000\)/);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
  });

  it("reserves time on the same terms", async () => {
    vi.mocked(runAgent).mockImplementation(((_pi: any, _ctx: any, _t: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 10, output: 0, cacheWrite: 0 }, {});
      return new Promise((resolve) => setTimeout(() => resolve(ok(0) as RunResult), 150));
    }) as any);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, router(state()));
    manager.setTeamPolicy({ maxTeamMs: 200, reviewReserveMs: 120, retries: 0, retryBaseMs: 0 });

    expect((await spawnAndSettle(manager))?.status).toBe("completed");
    const refusedWriter = await spawnAndSettle(manager);
    expect(refusedWriter?.status).toBe("error");
    expect(refusedWriter?.error).toMatch(/writer time budget exhausted \(\d+ms ≥ 80ms; the cap holds 120ms beyond it for review dispatches\)/);

    const review = await spawnAndSettle(manager, {}, "reviewer");
    expect(review?.status).toBe("completed");
  }, 15_000);
});

describe("teamPolicy re-declaration", () => {
  it("resets the team's totals so a raised or re-declared budget admits again", async () => {
    vi.mocked(runAgent).mockImplementationOnce(((_pi: any, _ctx: any, _t: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 600, output: 0, cacheWrite: 0 }, {});
      return Promise.resolve(ok(0) as RunResult);
    }) as any).mockResolvedValue(ok(0) as RunResult);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, router(state()));
    const policy: TeamPolicy = { maxTeamTokens: 500, retries: 0, retryBaseMs: 0 };
    manager.setTeamPolicy(policy);

    expect((await spawnAndSettle(manager))?.status).toBe("completed");
    const refused = await spawnAndSettle(manager);
    expect(refused?.status).toBe("error");
    expect(refused?.error).toMatch(/team token budget exhausted/);

    // Re-declaring the same policy is an operator reset, not a no-op.
    manager.setTeamPolicy({ ...policy });
    const admitted = await spawnAndSettle(manager);
    expect(admitted?.status).toBe("completed");
  });
});

describe("retry allowance (shared per team root)", () => {
  it("pool rotation and the declared leg share one allowance; exhaustion stops further legs", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    manager.setProviderPool({ strategy: "fill_first", members: ["faux", "faux-2"] });
    manager.setFallbackModel("commandcode/minimax/minimax-m3.1-flash");
    manager.setTeamPolicy({ retries: 1, retryBaseMs: 0 });

    const record = await spawnAndSettle(manager);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(record?.providerAttempts).toBe(2);
  });

  it("with retries 0, no alternate leg is launched at all", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    manager.setProviderPool({ strategy: "fill_first", members: ["faux", "faux-2"] });
    manager.setTeamPolicy({ retries: 0, retryBaseMs: 0 });

    await spawnAndSettle(manager);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
  });

  it("backoff before an alternate leg is cancellable by stopping the record", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue(providerFail() as RunResult);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    manager.setProviderPool({ strategy: "fill_first", members: ["faux", "faux-2"] });
    manager.setTeamPolicy({ retries: 3, retryBaseMs: 5000 });

    const id = manager.spawn({} as any, mockCtx(), "general-purpose", "p", fresh() as any);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    manager.abort(id);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    await manager.getRecord(id)?.promise?.catch(() => {});
  });
});

describe("per-dispatch wall clock", () => {
  it("aborts a dispatch that outlives maxDispatchMs and ends stopped", async () => {
    vi.mocked(runAgent).mockImplementation(((_pi: any, _ctx: any, _type: any, opts: any) => {
      return new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve({ ...ok(), aborted: true, responseText: "" }));
      });
    }) as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, router(state()));
    manager.setTeamPolicy({ maxDispatchMs: 30, retries: 0, retryBaseMs: 0 });

    const record = await spawnAndSettle(manager);

    expect(record?.status).toBe("stopped");
  });
});

describe("durable providerRoute for owned children", () => {
  it("persists a nested child's providerRoute in the entry written for it (not just memory)", () => {
    const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
    const persist = src.indexOf("pi.appendEntry<AgentRecordEntryData>(AGENT_RECORD_ENTRY_TYPE, agentRecordEntryData(record));");
    const ownedReturn = src.indexOf("if (!isTopLevelAgent(record)) return;", persist);
    expect(persist).toBeGreaterThan(-1);
    expect(ownedReturn).toBeGreaterThan(persist);

    const entry = agentRecordEntryData({
      id: "child-1",
      type: "general-purpose",
      parentAgentId: "root-1",
      providerRoute: {
        strategy: "fill_first",
        members: ["faux", "faux-2"],
        attempts: [{ key: "faux/primary-1", outcome: "success" }],
        servedModelKey: "faux/primary-1",
      },
    } as any) as any;
    expect(entry.providerRoute?.servedModelKey).toBe("faux/primary-1");
  });
});
