/**
 * model-routing.ts — the session-scoped reviewer/shared subagent model route.
 *
 * Pi-free on purpose: every function takes and returns plain objects so the
 * policy can be unit tested without a session, and so `AgentManager` can apply
 * it without importing the extension entry point.
 *
 * The route is fail-closed. A latched route refuses every later fresh dispatch
 * with the recorded reason; nothing here ever picks another model on its own.
 */

import type { ThinkingLevel } from "./types.js";

export const DEFAULT_SUBAGENT_MODEL = "github-copilot/gpt-6-luna";
export const DEFAULT_REVIEWER_MODEL = "openai-codex/gpt-6.1-sol";
const DEFAULT_SUBAGENT_THINKING: ThinkingLevel = "low";
const DEFAULT_REVIEWER_THINKING: ThinkingLevel = "high";
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
  /** Model used by fresh non-reviewer dispatches. */
  effective: string;
  /** Model used by fresh reviewer dispatches. */
  reviewerEffective: string;
  /** Shared-model selection recorded for every non-reviewer agent. */
  selected?: string;
  /** Reviewer selection recorded separately. */
  reviewerSelected?: string;
  /** Shared thinking-level selection recorded for every non-reviewer agent. */
  selectedThinking?: ThinkingLevel;
  /** Reviewer thinking-level selection recorded separately. */
  reviewerSelectedThinking?: ThinkingLevel;
  /** Effective shared thinking level, after route restoration. */
  effectiveThinking?: ThinkingLevel;
  /** Effective reviewer thinking level, after route restoration. */
  reviewerEffectiveThinking?: ThinkingLevel;
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
  /** Pi's own `CustomEntry` carries `unknown` here, so this accepts it verbatim. */
  data?: unknown;
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
  return {
    effective: DEFAULT_SUBAGENT_MODEL,
    reviewerEffective: DEFAULT_REVIEWER_MODEL,
    selectedThinking: undefined,
    reviewerSelectedThinking: undefined,
    effectiveThinking: DEFAULT_SUBAGENT_THINKING,
    reviewerEffectiveThinking: DEFAULT_REVIEWER_THINKING,
    stale: false,
    routingFailed: false,
  };
}

function isSpecialist(type: string): boolean {
  return type === "reviewer" || type === "Plan" || type === "advisor";
}

export function modelForSubagent(state: SubagentRoutingState, type: string): string {
  return isSpecialist(type) ? state.reviewerEffective : state.effective;
}

export function thinkingForSubagent(state: SubagentRoutingState, type: string): ThinkingLevel | undefined {
  return isSpecialist(type) ? state.reviewerEffectiveThinking : state.effectiveThinking;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.has(value) ? value as ThinkingLevel : undefined;
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
    const data = (entry.data ?? {}) as {
      provider?: unknown;
      model?: unknown;
      reviewerProvider?: unknown;
      reviewerModel?: unknown;
      thinking?: unknown;
      reviewerThinking?: unknown;
    };
    if (typeof data.provider !== "string" || typeof data.model !== "string") continue;
    if (data.provider.length === 0 || data.model.length === 0) continue;

    const selected = `${data.provider}/${data.model}`;
    const reviewer = typeof data.reviewerProvider === "string" && typeof data.reviewerModel === "string"
      && data.reviewerProvider.length > 0 && data.reviewerModel.length > 0
      ? `${data.reviewerProvider}/${data.reviewerModel}`
      : selected;
    const selectedThinking = parseThinkingLevel(data.thinking);
    const reviewerThinking = parseThinkingLevel(data.reviewerThinking) ?? selectedThinking;
    const migrated = legacy ? { migratedFrom: LEGACY_ROUTING_STATE_TYPE } : {};
    const stale = !known.includes(selected) || !known.includes(reviewer);
    return {
      ...emptyState(),
      selected,
      reviewerSelected: reviewer,
      effective: known.includes(selected) ? selected : DEFAULT_SUBAGENT_MODEL,
      reviewerEffective: known.includes(reviewer) ? reviewer : DEFAULT_REVIEWER_MODEL,
      selectedThinking,
      reviewerSelectedThinking: reviewerThinking,
      effectiveThinking: selectedThinking ?? (known.includes(selected) ? undefined : DEFAULT_SUBAGENT_THINKING),
      reviewerEffectiveThinking: reviewerThinking ?? (known.includes(reviewer) ? undefined : DEFAULT_REVIEWER_THINKING),
      stale,
      ...migrated,
    };
  }
  return emptyState();
}


/**
 * Applies a deliberate session selection. Re-selecting is the only way out of a
 * latched route, and it is deliberate: the user typed a model.
 */
export function selectModels(
  state: SubagentRoutingState,
  shared: string,
  reviewer: string,
  sharedThinking?: ThinkingLevel,
  reviewerThinking?: ThinkingLevel,
): void {
  state.selected = shared;
  state.reviewerSelected = reviewer;
  state.effective = shared;
  state.reviewerEffective = reviewer;
  if (sharedThinking !== undefined || reviewerThinking !== undefined) {
    state.selectedThinking = sharedThinking;
    state.reviewerSelectedThinking = reviewerThinking;
    state.effectiveThinking = sharedThinking;
    state.reviewerEffectiveThinking = reviewerThinking;
  }
  state.stale = false;
  state.routingFailed = false;
  state.terminalReason = undefined;
  state.migratedFrom = undefined;
}

/** Backward-compatible helper: one explicit choice applies to both roles. */
export function selectModel(state: SubagentRoutingState, key: string): void {
  selectModels(state, key, key);
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
export function recordFallbackFailure(
  state: SubagentRoutingState,
  detail: string,
  primaryModel = state.effective,
): void {
  state.routingFailed = true;
  state.terminalReason =
    `Subagent routing stopped: ${primaryModel} failed, then the fallback ` +
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
