# Shared Subagent Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One session-wide, fail-closed model route applied at `AgentManager.startAgent` to every fresh subagent, with a single same-task fallback retry on provider failure — independent of Pi's main-session model.

**Architecture:** A pure routing module (`src/model-routing.ts`) owns the defaults, catalog validation, provider-failure classifier, terminal latch and session-entry restore/migration. A `SubagentRouting` object is created once by `src/index.ts`, persisted in session custom entries, and passed into `new AgentManager(...)` as a 6th argument. `startAgent` resolves the routed model before it claims any resource, refuses conflicting caller overrides, and runs **at most two attempts of the same logical task** before the existing one-time settlement tail (cleanup, notification, pool release) executes.

**Tech Stack:** TypeScript 6 (ES2022, strict), vitest 4, biome 2, Pi extension API (`@earendil-works/pi-coding-agent` 0.84.2, `@earendil-works/pi-tui`).

**Spec:** `docs/superpowers/specs/2026-09-14-shared-subagent-model-routing-design.md`

## Global Constraints

- Never commit, push, tag, or create remote branches — the user does this manually.
- Do not edit `CHANGELOG.md` (handover: reserved for maintainers).
- Full gate after code changes: `npm run check` (lint + typecheck + test), plus `npm run test:e2e` and `npm run build` for this spawn-path change.
- Default subagent model: `commandcode/deepseek/deepseek-v4.1-flash`. Single fallback: `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`.
- No per-project model control. No per-role routing. No silent parent-model inheritance while routing is active.
- Fail closed: a latched route blocks every later fresh or queued dispatch, and the error text must never ask for model re-selection.
- Exactly one pool release, one worktree cleanup, one completion notification, and one public agent id per logical task.
- Test seam: `PI_SUBAGENTS_MODEL_ROUTING=off` disables routing for the process. `vitest.config.ts` sets it off globally; the routing tests enable it per-test. Production is always on.
- Docs that must move with behavior: `README.md`, `docs/workflows.md`, `docs/rpc.md`, the Agent tool description and the workflow tool description.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/model-routing.ts` (new) | Pure routing state: constants, catalog selection, exact resolution, restore + legacy migration, block reason, provider-failure classifier, terminal latch. |
| `test/model-routing.test.ts` (new) | Unit tests for everything in `src/model-routing.ts`. |
| `src/agent-manager.ts` (modify) | `SpawnOptions.modelOverride`; optional `SubagentRouting` constructor argument; routed model resolution before resource claim; two-attempt loop in `startAgent`. |
| `test/subagent-model-routing.test.ts` (new) | Manager-level attempt-loop, latch, override-rejection, resume-bypass and single-settlement tests. |
| `src/index.ts` (modify) | Router object + persistence, `/subagent-model` + `/implementer-model` alias, status line, caller-side `modelOverride` plumbing, tool description text. |
| `test/subagent-model-command.wiring.test.ts` (new) | Command registration/alias, selection persistence, terminal-latch status. |
| `src/nested-tools.ts`, `src/workflow/host.ts`, `src/schedule.ts`, `src/cross-extension-rpc.ts` (modify) | Pass the caller-supplied model spelling through as `modelOverride`. |
| `.github/workflows/sync-upstream.yml` (new) | Mirror `upstream/master` into `master`, merge into `shared-routing`, verify, push only on success. |
| `README.md`, `docs/workflows.md`, `docs/rpc.md`, `test/agent-tool-description.md`, `examples/agent-tool-description.md` (modify) | Commands, precedence, defaults, RPC behavior, tool text. |

---

### Task 1: Pure routing module

**Files:**

- Create: `src/model-routing.ts`
- Test: `test/model-routing.test.ts`

**Interfaces:**

- Consumes: nothing from the repo (Node types only).
- Produces: `DEFAULT_SUBAGENT_MODEL`, `FALLBACK_SUBAGENT_MODEL`, `ROUTING_STATE_TYPE`, `LEGACY_ROUTING_STATE_TYPE`, `ModelRef`, `SubagentRoutingState`, `SessionEntry`, `modelKey()`, `routingCatalog()`, `resolveExactSelection()`, `restoreRoutingState()`, `selectModel()`, `clearRoutingState()`, `routingBlockReason()`, `classifyProviderFailure()`, `recordUnavailableModel()`, `recordFallbackFailure()`, `isRoutingEnabled()`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/model-routing.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_MODEL,
  FALLBACK_SUBAGENT_MODEL,
  LEGACY_ROUTING_STATE_TYPE,
  ROUTING_STATE_TYPE,
  classifyProviderFailure,
  modelKey,
  recordFallbackFailure,
  recordUnavailableModel,
  resolveExactSelection,
  restoreRoutingState,
  routingBlockReason,
  routingCatalog,
  selectModel,
} from "../src/model-routing.js";

const FAUX = { provider: "faux", id: "faux-1" };
const OTHER = { provider: "other", id: "model/x" };
const catalog = [FAUX, OTHER];

describe("routing catalog", () => {
  it("prefers session-scoped models over the full available list", () => {
    expect(routingCatalog({ scoped: [FAUX], available: [FAUX, OTHER] })).toEqual([FAUX]);
    expect(routingCatalog({ scoped: [], available: [FAUX, OTHER] })).toEqual([FAUX, OTHER]);
  });

  it("resolves only exact provider/model ids, splitting on the first slash", () => {
    expect(resolveExactSelection("other/model/x", catalog)).toBe("other/model/x");
    expect(resolveExactSelection("other/nope", catalog)).toBeUndefined();
    expect(resolveExactSelection("faux/faux-1", catalog)).toBe("faux/faux-1");
    expect(resolveExactSelection("  faux/faux-1  ", catalog)).toBe("faux/faux-1");
    expect(resolveExactSelection("faux", catalog)).toBeUndefined();
    expect(resolveExactSelection("/faux", catalog)).toBeUndefined();
  });
});

describe("restore + migration", () => {
  it("restores the newest selection on the branch", () => {
    const state = restoreRoutingState(
      [
        { type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: "other", model: "model/x" } },
        { type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: "faux", model: "faux-1" } },
      ],
      catalog,
    );
    expect(state.selected).toBe("faux/faux-1");
    expect(state.effective).toBe("faux/faux-1");
    expect(state.routingFailed).toBe(false);
  });

  it("migrates the legacy implementer-model entry once", () => {
    const state = restoreRoutingState(
      [{ type: "custom", customType: LEGACY_ROUTING_STATE_TYPE, data: { provider: "faux", model: "faux-1" } }],
      catalog,
    );
    expect(state.selected).toBe("faux/faux-1");
    expect(state.migratedFrom).toBe(LEGACY_ROUTING_STATE_TYPE);
  });

  it("keeps the default when a stored selection is gone, and reports it stale", () => {
    const state = restoreRoutingState(
      [{ type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: "gone", model: "x" } }],
      catalog,
    );
    expect(state.selected).toBe("gone/x");
    expect(state.effective).toBe(DEFAULT_SUBAGENT_MODEL);
    expect(state.stale).toBe(true);
  });

  it("ignores malformed entries and falls back to the default", () => {
    const state = restoreRoutingState(
      [{ type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: 1, model: "" } }],
      catalog,
    );
    expect(state.effective).toBe(DEFAULT_SUBAGENT_MODEL);
    expect(state.stale).toBe(false);
  });
});

describe("provider-failure classification", () => {
  it("retries recognised provider failures", () => {
    expect(classifyProviderFailure({ isError: true, text: "429 Too Many Requests" })).toBe(true);
    expect(classifyProviderFailure({ isError: true, text: "quota exceeded for this model" })).toBe(true);
    expect(classifyProviderFailure({ isError: true, text: "unauthorized: invalid api key" })).toBe(true);
    expect(classifyProviderFailure({ isError: true, text: "ECONNRESET while streaming" })).toBe(true);
  });

  it("never retries task, gate or structured-output failures", () => {
    expect(classifyProviderFailure({ isError: true, text: "gate command failed: npm test" })).toBe(false);
    expect(classifyProviderFailure({ isError: true, text: "implementation failed, tests are red" })).toBe(false);
    expect(classifyProviderFailure({ isError: true, text: "the last request is invalid for this scope" })).toBe(false);
    expect(classifyProviderFailure({ isError: true, text: "StructuredOutput call did not match the required schema" })).toBe(false);
    expect(classifyProviderFailure({ isError: true, text: "run hit the output token limit before producing any text" })).toBe(false);
    expect(classifyProviderFailure({ isError: false, text: "ok" })).toBe(false);
  });
});

describe("terminal latch", () => {
  it("latches on an unavailable configured target and reports the reason", () => {
    const state = restoreRoutingState([], catalog);
    recordUnavailableModel(state, DEFAULT_SUBAGENT_MODEL);
    expect(state.routingFailed).toBe(true);
    expect(routingBlockReason(state)).toContain(DEFAULT_SUBAGENT_MODEL);
    expect(routingBlockReason(state)).not.toMatch(/select|choose another/i);
  });

  it("latches when the fallback leg fails and names both legs", () => {
    const state = restoreRoutingState([], catalog);
    recordFallbackFailure(state, "429 from fallback");
    expect(state.routingFailed).toBe(true);
    expect(routingBlockReason(state)).toContain(FALLBACK_SUBAGENT_MODEL);
    expect(routingBlockReason(state)).toContain("429 from fallback");
  });

  it("clears the latch on a deliberate re-selection", () => {
    const state = restoreRoutingState([], catalog);
    recordFallbackFailure(state, "quota");
    selectModel(state, modelKey(FAUX));
    expect(state.routingFailed).toBe(false);
    expect(routingBlockReason(state)).toBeUndefined();
    expect(state.effective).toBe("faux/faux-1");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/model-routing.test.ts`
Expected: FAIL — `Failed to resolve import "../src/model-routing.js"`.

- [ ] **Step 3: Write the module**

```ts
// src/model-routing.ts
/**
 * model-routing.ts — the session-wide subagent model route.
 *
 * Pi-free on purpose: every function takes and returns plain objects so the
 * policy can be unit tested without a session, and so `AgentManager` can apply
 * it without importing the extension entry point.
 *
 * The route is fail-closed. A latched route refuses every later fresh dispatch
 * with the recorded reason; nothing here ever picks another model on its own.
 */

export const DEFAULT_SUBAGENT_MODEL = "commandcode/deepseek/deepseek-v4.1-flash";
/**
 * Where one provider failure retries to. Deliberately a DIFFERENT provider from
 * the default: retrying inside the provider that just failed re-dials the same
 * dead endpoint.
 */
export const FALLBACK_SUBAGENT_MODEL = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
export const ROUTING_STATE_TYPE = "subagent-model-state";
/** Predecessor entry written by the standalone implementer-model extension. */
export const LEGACY_ROUTING_STATE_TYPE = "implementer-model-state";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface SubagentRoutingState {
  /** Last selection recorded in the session, when one existed. */
  selected?: string;
  /** Model a fresh dispatch uses when the route is healthy. */
  effective: string;
  /** A stored selection points at a model the catalog has lost. */
  stale: boolean;
  /** Terminal: every later fresh dispatch is refused with `terminalReason`. */
  routingFailed: boolean;
  terminalReason?: string;
  /** Set when the restored state came from the legacy entry type. */
  migratedFrom?: string;
}

export interface SessionEntry {
  type?: string;
  customType?: string;
  data?: { provider?: unknown; model?: unknown };
}

export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

/** Session-scoped model restrictions replace the full catalog when present. */
export function routingCatalog(source: {
  scoped: readonly ModelRef[];
  available: readonly ModelRef[];
}): readonly ModelRef[] {
  return source.scoped.length > 0 ? source.scoped : source.available;
}

/**
 * Resolves an exact `provider/model` argument against the catalog. Splits on the
 * FIRST slash only, because model ids carry slashes of their own
 * (`commandcode/deepseek/deepseek-v4.1-flash`).
 */
export function resolveExactSelection(text: string, catalog: readonly ModelRef[]): string | undefined {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const key = `${trimmed.slice(0, slash)}/${trimmed.slice(slash + 1)}`;
  return catalog.some((model) => modelKey(model) === key) ? key : undefined;
}

function emptyState(): SubagentRoutingState {
  return { effective: DEFAULT_SUBAGENT_MODEL, stale: false, routingFailed: false };
}

/**
 * Restores the newest routing entry on the active branch, migrating a legacy
 * implementer-model entry once. A selection the catalog no longer serves keeps
 * its value for diagnosis but routes to the default and reports `stale`.
 */
export function restoreRoutingState(
  entries: readonly SessionEntry[],
  catalog: readonly ModelRef[],
): SubagentRoutingState {
  const known = catalog.map(modelKey);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom") continue;
    const legacy = entry.customType === LEGACY_ROUTING_STATE_TYPE;
    if (!legacy && entry.customType !== ROUTING_STATE_TYPE) continue;
    const { provider, model } = entry.data ?? {};
    if (typeof provider !== "string" || typeof model !== "string") continue;
    if (provider.length === 0 || model.length === 0) continue;
    const selected = `${provider}/${model}`;
    const migrated = legacy ? { migratedFrom: LEGACY_ROUTING_STATE_TYPE } : {};
    if (!known.includes(selected)) {
      return { ...emptyState(), selected, stale: true, ...migrated };
    }
    return { effective: selected, selected, stale: false, routingFailed: false, ...migrated };
  }
  return emptyState();
}

/**
 * Applies a deliberate session selection. Re-selecting is the only way out of a
 * latched route, and it is deliberate: the user typed a model.
 */
export function selectModel(state: SubagentRoutingState, key: string): void {
  state.selected = key;
  state.effective = key;
  state.stale = false;
  state.routingFailed = false;
  state.terminalReason = undefined;
  state.migratedFrom = undefined;
}

export function clearRoutingState(state: SubagentRoutingState): void {
  Object.assign(state, emptyState(), { selected: undefined, terminalReason: undefined, migratedFrom: undefined });
}

/**
 * Task-level failures (gates, tests, cancellations, scope, schema) never mean a
 * dead provider. Every alternative is a whole word or a bounded prefix: bare
 * substrings misread ordinary prose (`latest` contains "test", `authoring`
 * contains "auth"), and a misread here retries a task that actually completed.
 */
const TASK_FAILURE_PATTERN = /\b(?:gate\w*|tests?|pytest|cancel\w*|scope[ds]?|implementation\w*|schema)\b/i;
const PROVIDER_STATUS_PATTERN = /\b(?:401|402|403|404|408|429|5\d\d)\b/;
const PROVIDER_TEXT_PATTERN =
  /\b(?:auth|authenticat\w*|authoriz\w*|authoris\w*|unauthori[sz]ed|forbidden|quota|rate[ -]?limits?|connection|econn\w*|enotfound|dns|timed[ -]?out|timeouts?)\b/i;

/** True only for failures that plausibly mean "this provider cannot serve us". */
export function classifyProviderFailure(result: { isError?: boolean; text?: string }): boolean {
  if (result?.isError !== true) return false;
  const text = typeof result.text === "string" ? result.text : "";
  if (TASK_FAILURE_PATTERN.test(text)) return false;
  if (PROVIDER_STATUS_PATTERN.test(text)) return true;
  return PROVIDER_TEXT_PATTERN.test(text);
}

/** Latches an unavailable configured target before any model runs. */
export function recordUnavailableModel(state: SubagentRoutingState, model: string): void {
  state.routingFailed = true;
  state.terminalReason =
    `Subagent routing stopped: ${model} is unavailable in this session's model catalog. ` +
    `Set an available model with /subagent-model.`;
}

/** Latches the route after the fallback leg itself failed. */
export function recordFallbackFailure(state: SubagentRoutingState, detail: string): void {
  state.routingFailed = true;
  state.terminalReason =
    `Subagent routing stopped: ${state.effective} failed, then the fallback ` +
    `${FALLBACK_SUBAGENT_MODEL} failed (${detail}).`;
}

/** Why a fresh dispatch must be refused, or `undefined` when the route is healthy. */
export function routingBlockReason(state: SubagentRoutingState): string | undefined {
  return state.routingFailed ? state.terminalReason : undefined;
}

/**
 * The test/operator escape hatch. Routing is on by default; a process can turn
 * it off when it supplies its own model catalog (the test harnesses) or when
 * debugging. Read once per call so a test can flip it.
 */
export function isRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENTS_MODEL_ROUTING !== "off";
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/model-routing.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Mutation-check the classifier**

Invert the final line to `return !PROVIDER_TEXT_PATTERN.test(text)`; confirm the classifier tests go red; restore.

---

### Task 2: `SpawnOptions.modelOverride` and the router hook on `AgentManager`

**Files:**

- Modify: `src/agent-manager.ts`
- Test: covered by Task 3 (this task adds plumbing only)

**Interfaces:**

- Consumes: `SubagentRoutingState`, `ModelRef` (Task 1).
- Produces: the exported `SubagentRouting` interface, the `AgentManager` 6th constructor argument `routing?: SubagentRouting`, and `SpawnOptions.modelOverride?: string`.

```ts
export interface SubagentRouting {
  /** Live routing state, mutated in place so every spawn sees the newest latch. */
  state: SubagentRoutingState;
  /** Catalog for a spawn's context, read at the moment the spawn actually starts. */
  catalogFor(ctx: ExtensionContext): readonly ModelRef[];
}
```

- [ ] **Step 1: Add the option**

In `SpawnOptions`, immediately after `model?: Model<any>;`:

```ts
  /**
   * The model spelling a CALLER explicitly asked for (`Agent({ model })`,
   * `agent({ model })`, a scheduled job's model, an RPC `options.model`).
   *
   * Recorded separately from the resolved `model` because a resolved model
   * cannot say who chose it: shared routing overrides a parent-inherited or
   * agent-frontmatter model silently, but refuses to silently discard a model a
   * caller named. Only callers set this.
   */
  modelOverride?: string;
```

- [ ] **Step 2: Add the constructor argument and the imports**

Imports: `import { type ModelRef, type SubagentRoutingState, classifyProviderFailure, isRoutingEnabled, modelKey, recordFallbackFailure, recordUnavailableModel, routingBlockReason } from "./model-routing.js";` and add `RunResult` to the existing `./agent-runner.js` type import.

Constructor, after `onUsage?: OnAgentUsage,`:

```ts
    /**
     * Session-wide model route (see `src/model-routing.ts`). Optional so every
     * existing `new AgentManager()` — tests, and any host that wants raw
     * pass-through — keeps today's behavior exactly.
     */
    private routing?: SubagentRouting,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (no behavior change yet).

---

### Task 3: Two-attempt loop in `startAgent`

**Files:**

- Modify: `src/agent-manager.ts` (`startAgent`, and two new private methods)
- Test: `test/subagent-model-routing.test.ts`

**Interfaces:**

- Consumes: `SubagentRouting` (Task 2), the whole of Task 1.
- Produces: `startAgent` routed behavior; private `resolveRoute(ctx, options): RoutedModels | string` and `runRouted(startRun, route): Promise<RunResult>`, where `interface RoutedModels { model: Model<any>; fallback: Model<any> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/subagent-model-routing.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { runAgent } from "../src/agent-runner.js";
import { AgentManager, type SubagentRouting } from "../src/agent-manager.js";
import type { SubagentRoutingState } from "../src/model-routing.js";

const PRIMARY = { provider: "faux", id: "primary-1" };
const FALLBACK = { provider: "faux", id: "fallback-1" };

function router(state: SubagentRoutingState, models = [PRIMARY, FALLBACK]): SubagentRouting {
  return { state, catalogFor: () => models };
}

function mockCtx(models = [PRIMARY, FALLBACK]) {
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

const ok = () => ({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
const providerFail = () => ({ ...ok(), responseText: "", failure: "429 rate limit exceeded" });
const fresh = (over: Record<string, unknown> = {}) => ({ description: "d", isBackground: false, ...over });

/** A spawn() that rejects is the contract for a refused fresh dispatch. */
async function spawnAndSettle(manager: AgentManager, over: Record<string, unknown> = {}) {
  const id = manager.spawn({} as any, mockCtx(), "general-purpose", "p", fresh(over) as any);
  const record = manager.getRecord(id);
  await record?.promise?.catch(() => {});
  return record;
}

let manager: AgentManager | undefined;
afterEach(() => {
  manager?.dispose();
  manager = undefined;
  vi.mocked(runAgent).mockReset();
});

describe("shared routing at startAgent", () => {
  it("runs the routed model instead of the caller's inherited model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as any);
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined,
      router({ effective: "faux/primary-1", stale: false, routingFailed: false }));
    await spawnAndSettle(manager, { model: FALLBACK });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(PRIMARY);
  });

  it("retries the same task once on the fallback after a provider failure", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as any).mockResolvedValueOnce(ok() as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    const record = await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1][3]!.model).toEqual(FALLBACK);
    expect(state.routingFailed).toBe(false);
    expect(record?.status).toBe("completed");
  });

  it("does not retry a task failure", async () => {
    vi.mocked(runAgent).mockResolvedValue({ ...ok(), responseText: "", failure: "gate command failed: npm test" } as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(state.routingFailed).toBe(false);
  });

  it("does not retry an aborted run", async () => {
    vi.mocked(runAgent).mockResolvedValue({ ...ok(), aborted: true, failure: "429 rate limit" } as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown non-provider error", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("structured output schema mismatch"));
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown provider error once", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("401 unauthorized")).mockResolvedValueOnce(ok() as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("latches when the fallback fails, and refuses the next fresh dispatch without running it", async () => {
    vi.mocked(runAgent).mockResolvedValue(providerFail() as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(state.routingFailed).toBe(true);

    await expect(async () => {
      const id = manager!.spawn({} as any, mockCtx(), "general-purpose", "p", fresh() as any);
      await manager!.awaitStartup(id);
    }).rejects.toThrow(/routing stopped/i);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("fails before running when the routed model is not in the catalog", async () => {
    const state: SubagentRoutingState = { effective: "faux/gone", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await expect(async () => {
      const id = manager!.spawn({} as any, mockCtx(), "general-purpose", "p", fresh() as any);
      await manager!.awaitStartup(id);
    }).rejects.toThrow(/unavailable/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects a conflicting caller-supplied model override", async () => {
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await expect(async () => {
      const id = manager!.spawn({} as any, mockCtx(), "general-purpose", "p",
        fresh({ model: FALLBACK, modelOverride: "faux/fallback-1" }) as any);
      await manager!.awaitStartup(id);
    }).rejects.toThrow(/override/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("accepts a caller override that names the routed model", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager, { model: PRIMARY, modelOverride: "faux/primary-1" });
    expect(runAgent).toHaveBeenCalled();
  });

  it("leaves resumes on their own model, out of the route and out of the latch", async () => {
    vi.mocked(runAgent).mockResolvedValue(ok() as any);
    const state: SubagentRoutingState = { effective: "faux/gone", stale: false, routingFailed: true, terminalReason: "latched" };
    manager = new AgentManager(undefined, 10, undefined, undefined, undefined, router(state));
    await spawnAndSettle(manager, { resumeSessionFile: "/tmp/s.jsonl", model: FALLBACK });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.model).toEqual(FALLBACK);
  });

  it("settles once: one completion callback and one pool release per logical task", async () => {
    const completions: string[] = [];
    vi.mocked(runAgent).mockResolvedValueOnce(providerFail() as any).mockResolvedValueOnce(ok() as any);
    const state: SubagentRoutingState = { effective: "faux/primary-1", stale: false, routingFailed: false };
    manager = new AgentManager((r) => completions.push(r.id), 1, undefined, undefined, undefined, router(state));
    manager.setMaxConcurrentForeground(1);
    await spawnAndSettle(manager);
    expect(completions).toHaveLength(1);
    // One slot released: a second spawn is not queued behind a leaked slot.
    vi.mocked(runAgent).mockResolvedValue(ok() as any);
    await spawnAndSettle(manager);
    expect(manager.getRecord(manager["queue"][0]?.id ?? "")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/subagent-model-routing.test.ts`
Expected: FAIL — routed model ignored, no retry.

- [ ] **Step 3: Resolve the route before any resource is claimed**

In `startAgent`, immediately after `assertValidSpawnCwd(options.cwd);` at the top and BEFORE `const pool = this.poolFor(record)`:

```ts
    // The route is resolved BEFORE the pool slot and the worktree: a config that
    // cannot run must fail without claiming either. `resumeSessionFile` is
    // deliberately exempt — a resumed conversation keeps the model its stored
    // session already has, and must still open while the route is latched.
    const routed = this.routing !== undefined && isRoutingEnabled() && options.resumeSessionFile === undefined
      ? this.resolveRoute(ctx, options)
      : undefined;
    if (typeof routed === "string") throw new Error(routed);
```

- [ ] **Step 4: Replace the single run with the two-attempt runner**

Turn the existing `runAgent(ctx, type, prompt, { ... })` expression into an arrow function that takes the model, changing only `model: options.model,` to `model,`:

```ts
    const startRun = (model: Model<any> | undefined) => runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model,
      maxTurns: options.maxTurns,
      /* ...every remaining field of the current literal, unchanged... */
    });

    const promise = this.runRouted(startRun, routed as RoutedModels | undefined)
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        /* the existing success tail, unchanged */
      })
      .catch(async (err) => {
        /* the existing error tail, unchanged */
      });
```

- [ ] **Step 5: Implement the two new private methods**

```ts
  /**
   * Both models a fresh dispatch may use, or the reason it cannot run.
   *
   * Resolved here and not by the callers because every fresh dispatch surface —
   * the Agent tool, workflows, nested delegation, the scheduler and cross-
   * extension RPC — converges on `startAgent`, and only here is the catalog read
   * at the moment the work actually starts (a queued spawn can be minutes old).
   */
  private resolveRoute(ctx: ExtensionContext, options: SpawnOptions): RoutedModels | string {
    const routing = this.routing;
    if (routing === undefined) return "";
    const blocked = routingBlockReason(routing.state);
    if (blocked !== undefined) return blocked;

    const catalog = routing.catalogFor(ctx);
    const wanted = routing.state.effective;
    // Both legs are validated up front: a fallback that cannot be resolved is a
    // latched route, and discovering that mid-task would waste the primary run.
    const model = this.exactCatalogModel(ctx, catalog, wanted);
    if (typeof model === "string") {
      recordUnavailableModel(routing.state, wanted);
      return routingBlockReason(routing.state) as string;
    }

    // A caller that named a model is answered, not ignored — but only after the
    // route is known to be runnable, so "switch with /subagent-model" is honest.
    if (options.modelOverride !== undefined && options.model !== undefined) {
      const same = options.model.provider === model.provider && options.model.id === model.id;
      if (!same) {
        return `Model override "${options.modelOverride}" is refused: this session routes every subagent to ` +
          `${wanted}. Change it with /subagent-model.`;
      }
    }

    const fallback = this.exactCatalogModel(ctx, catalog, FALLBACK_SUBAGENT_MODEL);
    if (typeof fallback === "string") {
      recordUnavailableModel(routing.state, FALLBACK_SUBAGENT_MODEL);
      return routingBlockReason(routing.state) as string;
    }
    return { model, fallback };
  }

  /**
   * Resolves an exact `provider/model` key against the live catalog and returns
   * the Model instance, or the key itself when it cannot be served. Exact on
   * purpose: the route is a configured identity, and `resolveModel`'s fuzzy
   * matching would happily serve a different date-stamped sibling.
   */
  private exactCatalogModel(ctx: ExtensionContext, catalog: readonly ModelRef[], key: string): Model<any> | string {
    if (!catalog.some((candidate) => modelKey(candidate) === key)) return key;
    const slash = key.indexOf("/");
    const found = ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1)) as Model<any> | undefined;
    return found ?? key;
  }

  /**
   * One logical task, at most two model attempts.
   *
   * Only the model differs between attempts: same prompt, type, tools, options
   * and worktree, because a provider failure says nothing about the work. Any
   * non-provider failure — including an abort — returns immediately, so a task
   * failure can never consume the fallback.
   */
  private async runRouted(
    startRun: (model?: Model<any>) => Promise<RunResult>,
    route?: RoutedModels,
  ): Promise<RunResult> {
    const routing = this.routing;
    if (routing === undefined || route === undefined) return startRun(route?.model);
    try {
      const first = await startRun(route.model);
      if (first.aborted || first.failure === undefined) return first;
      if (!classifyProviderFailure({ isError: true, text: first.failure })) return first;
      return await this.retryOnFallback(startRun, route);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!classifyProviderFailure({ isError: true, text: detail })) throw error;
      return await this.retryOnFallback(startRun, route);
    }
  }

  /**
   * The single fallback leg. A fallback that cannot be resolved latches and
   * fails the task here; a fallback that runs but fails again latches, then
   * rethrows-or-returns its own failure so the record reports what actually
   * happened instead of the primary's message.
   */
  private async retryOnFallback(
    startRun: (model?: Model<any>) => Promise<RunResult>,
    route: RoutedModels,
  ): Promise<RunResult> {
    const routing = this.routing as SubagentRouting;
    try {
      const second = await startRun(route.fallback);
      if (!second.aborted && second.failure !== undefined
        && classifyProviderFailure({ isError: true, text: second.failure })) {
        recordFallbackFailure(routing.state, second.failure);
      }
      return second;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (classifyProviderFailure({ isError: true, text: detail })) recordFallbackFailure(routing.state, detail);
      throw error;
    }
  }
```

Declare `interface RoutedModels { model: Model<any>; fallback: Model<any> }` beside `SubagentRouting`, and import `FALLBACK_SUBAGENT_MODEL` alongside the other routing imports.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx vitest run test/subagent-model-routing.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the existing manager suites**

Run: `npx vitest run test/agent-manager.test.ts test/agent-manager-gc.test.ts test/foreground-concurrency.test.ts test/background-by-default.test.ts test/abortable.test.ts`
Expected: PASS — a manager constructed without a router is unchanged.

---

### Task 4: Wire the router, commands and caller overrides into the extension

**Files:**

- Modify: `src/index.ts`, `src/nested-tools.ts`, `src/workflow/host.ts`, `src/schedule.ts`, `src/cross-extension-rpc.ts`, `vitest.config.ts`
- Test: `test/subagent-model-command.wiring.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3; `makePi`/`ctx` from `test/helpers/boot-extension.ts`.
- Produces: registered commands `subagent-model` and `implementer-model`; status key `subagent`; `modelOverride` set by every caller that has one.

- [ ] **Step 1: Construct the router**

In `src/index.ts`, immediately before `const manager = new AgentManager((record) => {`:

```ts
/**
 * One route per session, mutated in place: `startAgent` reads the live latch,
 * so a fallback failure stops the NEXT dispatch too. `catalogFor` re-reads the
 * catalog on every spawn because auth and the model scope can change mid-session.
 */
const routingState: SubagentRoutingState = { effective: DEFAULT_SUBAGENT_MODEL, stale: false, routingFailed: false };
const routing: SubagentRouting = {
  state: routingState,
  catalogFor: (spawnCtx) => routingCatalog({
    scoped: (spawnCtx.scopedModels ?? []).map((entry) => entry.model),
    available: (spawnCtx.modelRegistry.getAvailable?.() ?? spawnCtx.modelRegistry.getAll()) as ModelRef[],
  }),
};
```

and append `routing` as the 6th argument to the `new AgentManager(...)` call.

- [ ] **Step 2: Restore on session start**

In the extension's existing `session_start` handler, restore and report:

```ts
    Object.assign(routingState, restoreRoutingState(ctx.sessionManager.getBranch(), routing.catalogFor(ctx)));
    if (routingState.migratedFrom !== undefined && routingState.selected !== undefined) {
      const slash = routingState.selected.indexOf("/");
      pi.appendEntry(ROUTING_STATE_TYPE, {
        provider: routingState.selected.slice(0, slash),
        model: routingState.selected.slice(slash + 1),
      });
    }
    updateRoutingStatus(ctx);
    if (routingState.stale) {
      ctx.ui.notify(`Subagent model ${routingState.selected} is unavailable; using ${routingState.effective}.`, "warning");
    }
```

with

```ts
  function updateRoutingStatus(sessionCtx: ExtensionContext): void {
    sessionCtx.ui.setStatus("subagent", routingState.routingFailed ? "routing:blocked" : `routing:${routingState.effective}`);
  }
```

- [ ] **Step 3: Register `/subagent-model` and its alias**

One handler, two registrations. The handler:

1. `const catalog = routing.catalogFor(ctx);`
2. argument branch: `resolveExactSelection(text, catalog)`; `undefined` → notify `Unknown or unavailable model "<text>". Pass an exact provider/model, or run /subagent-model with no argument to pick one.` and return;
3. no-argument branch: without `ctx.hasUI` notify the exact-argument requirement and return; otherwise open the picker — lift the `fuzzyFilter` + `SelectList` + `Input` picker from `~/.pi/agent/extensions/implementer-model/index.ts`, retitled "Subagent model", with the same `minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46` column budget;
4. on a chosen key: `pi.appendEntry(ROUTING_STATE_TYPE, {...})` inside try/catch (a failed write must change neither state nor status, and must say so and keep `routingState.effective`), then `selectModel(routingState, key)`, `updateRoutingStatus(ctx)`, and `ctx.ui.notify(\`Subagent model set to ${key}.\`, "info")`.

Register the alias explicitly: `pi.registerCommand("implementer-model", { description: "Alias for /subagent-model (session-wide subagent model)", handler: subagentModelHandler })`.

- [ ] **Step 4: Pass `modelOverride` from every caller**

| Call site | Value |
| --- | --- |
| `src/index.ts` background + foreground Agent branches | `...(resolvedConfig.modelFromParams ? { modelOverride: params.model as string } : {})` |
| `src/index.ts` mention spawns (`spawnTopLevel` callers) | same, from the mention's params |
| `src/nested-tools.ts` (both branches) | `...(invocation.modelFromParams ? { modelOverride: invocation.modelInput } : {})` |
| `src/workflow/host.ts` | `...(request.model !== undefined ? { modelOverride: request.model } : {})` |
| `src/schedule.ts` | `...(job.model !== undefined ? { modelOverride: job.model } : {})` |
| `src/cross-extension-rpc.ts` | `modelOverride: label` alongside the resolved `model` in `normalizedOptions` |

- [ ] **Step 5: Write the wiring test**

```ts
// test/subagent-model-command.wiring.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePi, ctx as makeCtx } from "./helpers/boot-extension.js";

// Boots the real extension (src/index.ts) through makePi() + a mock ctx, then
// asserts:
//  - `subagent-model` and `implementer-model` are both registered, and share one handler
//  - `/subagent-model <provider>/<model>` with a model the catalog serves,
//    appends a `subagent-model-state` entry through pi.appendEntry
//  - a model the catalog does not serve is refused with the exact-argument message
//  - a latched routing state reports status "routing:blocked"
//  - the status line reports `routing:<provider>/<model>` otherwise
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run test/subagent-model-command.wiring.test.ts`
Expected: PASS.

- [ ] **Step 7: Neutralize routing for the pre-existing suites**

Add `env: { PI_SUBAGENTS_MODEL_ROUTING: "off" }` under `test` in `vitest.config.ts`, with a comment explaining that the harness catalogs are single-model faux providers and the routing suites enable it per-test. Then:

Run: `npx vitest run test/agent-model-display.test.ts test/agent-widget.test.ts test/e2e/workflow.e2e.test.ts`
Expected: PASS.

---

### Task 5: Documentation and tool descriptions

**Files:**

- Modify: `README.md`, `docs/workflows.md`, `docs/rpc.md`, `test/agent-tool-description.md`, `examples/agent-tool-description.md`, and the Agent tool description string in `src/index.ts` if it documents `model`

- [ ] **Step 1: Update each file** to state: the session-wide route and its default, `/subagent-model` as canonical with `/implementer-model` as an alias, that model choice is session-wide while routing is active, that a conflicting per-call override is refused (not silently ignored), that main-session model selection is unaffected, and that a latched route refuses later dispatches with the recorded reason and never offers re-selection.
- [ ] **Step 2: Verify docs match code**

Run: `npm run check`
Expected: PASS, including `test/documented-defaults.test.ts` and any doc-parity test.

---

### Task 6: Upstream synchronization workflow

**Files:**

- Create: `.github/workflows/sync-upstream.yml`

- [ ] **Step 1: Add the workflow.** Triggers: `schedule` (daily) + `workflow_dispatch`. `permissions: contents: write`, a `concurrency` group, no third-party actions. Steps: checkout `shared-routing` (full history) → `git remote add upstream https://github.com/tintinweb/pi-subagents.git` → `git fetch upstream` → `git push --ff-only origin upstream/master:master` → if `shared-routing` already contains `upstream/master`, stop successfully → `git merge --no-edit upstream/master` → `npm ci` → `npm run check` → `npm run test:e2e` → `npm run build` → `git push origin shared-routing`. Any failure exits non-zero before the push, leaving the branch unchanged. Never force-push either branch.
- [ ] **Step 2: Validate the YAML locally**

Run: `python3 -c "import yaml;yaml.safe_load(open('.github/workflows/sync-upstream.yml'))" && echo OK`
Expected: `OK`.

- [ ] **Step 3: Flag the manual remainder to the user** — the workflow can only be exercised with `workflow_dispatch` after the branch is pushed, and `shared-routing` must be set as the fork's default branch on GitHub.

---

### Task 7: Full verification

- [ ] **Step 1:** `npm run check` — lint clean, `tsc --noEmit` exit 0, full vitest suite green.
- [ ] **Step 2:** `npm run test:e2e` — green.
- [ ] **Step 3:** `npm run build` — `dist/` written.
- [ ] **Step 4:** Mutation-check the new assertions: (a) invert the classifier's task-failure guard, (b) skip the latch check in `resolveRoutedModel`, (c) allow a third attempt, (d) drop the override rejection — each must turn its specific test red; restore each after confirming.
- [ ] **Step 5:** Report to the user: files changed, verification output, and what remains manual (commit, push, GitHub default branch, package-source switch, disabling the standalone `implementer-model` extension, removing the three agent model pins).
