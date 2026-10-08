import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  DEFAULT_REVIEWER_MODEL,
  DEFAULT_SUBAGENT_MODEL,
  FALLBACK_SUBAGENT_MODEL,
  LEGACY_ROUTING_STATE_TYPE,
  modelForSubagent,
  modelKey,
  ROUTING_STATE_TYPE,
  recordFallbackFailure,
  recordUnavailableModel,
  resolveExactSelection,
  restoreRoutingState,
  routingBlockReason,
  routingCatalog,
  selectModels,
  thinkingForSubagent,
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
  it("restores reviewer and shared thinking selections on the branch", () => {
    const state = restoreRoutingState(
      [{
        type: "custom",
        customType: ROUTING_STATE_TYPE,
        data: {
          provider: "faux",
          model: "faux-1",
          reviewerProvider: "other",
          reviewerModel: "model/x",
          thinking: "high",
          reviewerThinking: "low",
        },
      }],
      catalog,
    );
    expect(state.effectiveThinking).toBe("high");
    expect(state.reviewerEffectiveThinking).toBe("low");
    expect(thinkingForSubagent(state, "reviewer")).toBe("low");
    expect(thinkingForSubagent(state, "worker")).toBe("high");
  });

  it("restores the newest selection on the branch", () => {
    const state = restoreRoutingState(
      [
        { type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: "other", model: "model/x" } },
        {
          type: "custom",
          customType: ROUTING_STATE_TYPE,
          data: {
            provider: "faux",
            model: "faux-1",
            reviewerProvider: "other",
            reviewerModel: "model/x",
          },
        },
      ],
      catalog,
    );
    expect(state.selected).toBe("faux/faux-1");
    expect(state.effective).toBe("faux/faux-1");
    expect(state.reviewerEffective).toBe("other/model/x");
    expect(state.reviewerEffective).toBe("other/model/x");
    expect(state.routingFailed).toBe(false);
    expect(modelForSubagent(state, "reviewer")).toBe("other/model/x");
    expect(modelForSubagent(state, "worker")).toBe("faux/faux-1");
  });

  it("migrates the legacy implementer-model entry once", () => {
    const state = restoreRoutingState(
      [{ type: "custom", customType: LEGACY_ROUTING_STATE_TYPE, data: { provider: "faux", model: "faux-1" } }],
      catalog,
    );
    expect(state.selected).toBe("faux/faux-1");
    expect(state.reviewerSelected).toBe("faux/faux-1");
    expect(state.migratedFrom).toBe(LEGACY_ROUTING_STATE_TYPE);
  });

  it("routes reviewer, Plan, and advisor to Sol; ordinary agents use GitHub Copilot Luna", () => {
    const state = restoreRoutingState([], [
      { provider: "openai-codex", id: "gpt-6.1-sol" },
      { provider: "github-copilot", id: "gpt-6-luna" },
    ]);
    for (const role of ["reviewer", "Plan", "advisor"]) {
      expect(modelForSubagent(state, role)).toBe("openai-codex/gpt-6.1-sol");
      expect(thinkingForSubagent(state, role)).toBe("high");
    }
    for (const role of ["worker", "Explore", "custom-role"]) {
      expect(modelForSubagent(state, role)).toBe("github-copilot/gpt-6-luna");
      expect(thinkingForSubagent(state, role)).toBe("low");
    }
  });

  it("keeps the default when a stored selection is gone, and reports it stale", () => {
    const state = restoreRoutingState(
      [{ type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: "gone", model: "x" } }],
      catalog,
    );
    expect(state.selected).toBe("gone/x");
    expect(state.effective).toBe(DEFAULT_SUBAGENT_MODEL);
    expect(state.reviewerEffective).toBe(DEFAULT_REVIEWER_MODEL);
    expect(thinkingForSubagent(state, "worker")).toBe("low");
    expect(thinkingForSubagent(state, "reviewer")).toBe("high");
    expect(state.stale).toBe(true);
  });

  it("ignores malformed entries and falls back to the default", () => {
    const state = restoreRoutingState(
      [{ type: "custom", customType: ROUTING_STATE_TYPE, data: { provider: 1, model: "" } }],
      catalog,
    );
    expect(state.effective).toBe(DEFAULT_SUBAGENT_MODEL);
    expect(state.reviewerEffective).toBe(DEFAULT_REVIEWER_MODEL);
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
    expect(
      classifyProviderFailure({ isError: true, text: "StructuredOutput call did not match the required schema" }),
    ).toBe(false);
    expect(
      classifyProviderFailure({ isError: true, text: "run hit the output token limit before producing any text" }),
    ).toBe(false);
    expect(classifyProviderFailure({ isError: false, text: "ok" })).toBe(false);
  });
});

describe("terminal latch", () => {
  it("latches on an unavailable configured target and reports the reason", () => {
    const state = restoreRoutingState([], catalog);
    recordUnavailableModel(state, DEFAULT_SUBAGENT_MODEL);
    expect(state.routingFailed).toBe(true);
    expect(routingBlockReason(state)).toContain(DEFAULT_SUBAGENT_MODEL);
    expect(routingBlockReason(state)).not.toMatch(/choose another model/i);
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
    selectModels(state, modelKey(FAUX), modelKey(OTHER), "medium", "high");
    expect(state.routingFailed).toBe(false);
    expect(routingBlockReason(state)).toBeUndefined();
    expect(state.effective).toBe("faux/faux-1");
    expect(state.effectiveThinking).toBe("medium");
    expect(state.reviewerEffectiveThinking).toBe("high");
  });
});
