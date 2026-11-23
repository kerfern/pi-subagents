/**
 * fallback-model.test.ts — the `fallbackModel` switch and the retry-leg key.
 *
 * A provider failure may move a subagent to ONE approved retry leg; when none is
 * approved, the failure has to stay on the routed model. These tests pin the
 * key resolution and the settings spellings, so a silent provider switch cannot
 * come back through a dropped or mistyped field.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_FALLBACK } from "../src/agent-types.js";
import {
  FALLBACK_SUBAGENT_MODEL,
  fallbackKeyFor,
  recordFallbackFailure,
  routingBlockReason,
  type SubagentRoutingState,
} from "../src/model-routing.js";
import { loadSettings, SETTING_DEFAULTS } from "../src/settings.js";

describe("fallbackKeyFor", () => {
  it("keeps the shipped leg when the setting is unset", () => {
    expect(fallbackKeyFor(undefined, "opencode-go/deepseek-v4.1-flash")).toBe(FALLBACK_SUBAGENT_MODEL);
  });

  it("is off for the sentinel, whatever its case", () => {
    expect(fallbackKeyFor(NO_FALLBACK, "a/b")).toBeUndefined();
    expect(fallbackKeyFor("NONE", "a/b")).toBeUndefined();
  });

  it("is off when the configured leg is the routed model itself", () => {
    expect(fallbackKeyFor("a/b", "a/b")).toBeUndefined();
    expect(fallbackKeyFor("a/c", "a/b")).toBe("a/c");
  });
});

describe("recordFallbackFailure", () => {
  const state = (): SubagentRoutingState => ({ effective: "a/primary" } as SubagentRoutingState);

  it("names the leg that actually failed", () => {
    const s = state();
    recordFallbackFailure(s, "429 rate limited", "a/primary", "b/leg");
    expect(routingBlockReason(s)).toContain("b/leg");
    expect(routingBlockReason(s)).not.toContain(FALLBACK_SUBAGENT_MODEL);
  });

  it("still defaults to the shipped leg for older callers", () => {
    const s = state();
    recordFallbackFailure(s, "boom");
    expect(routingBlockReason(s)).toContain(FALLBACK_SUBAGENT_MODEL);
  });
});

describe("fallbackModel setting", () => {
  let agentDir: string;
  let projectDir: string;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "fallback-model-agent-"));
    projectDir = mkdtempSync(join(tmpdir(), "fallback-model-project-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify(obj));
  }

  it("is unset by default, so the shipped leg keeps applying", () => {
    expect(SETTING_DEFAULTS.fallbackModel).toBeUndefined();
    expect(loadSettings(projectDir).fallbackModel).toBeUndefined();
  });

  it("accepts a typed key, trimmed", () => {
    writeProject({ fallbackModel: "  opencode-go/deepseek-v4.1-flash  " });
    expect(loadSettings(projectDir).fallbackModel).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it('treats "none" and the boolean false as the disabled sentinel', () => {
    writeProject({ fallbackModel: "none" });
    expect(loadSettings(projectDir).fallbackModel).toBe(NO_FALLBACK);
    writeProject({ fallbackModel: false });
    expect(loadSettings(projectDir).fallbackModel).toBe(NO_FALLBACK);
    expect(fallbackKeyFor(loadSettings(projectDir).fallbackModel, "a/b")).toBeUndefined();
  });

  it("drops values that are neither a string nor false", () => {
    writeProject({ fallbackModel: 42 });
    expect(loadSettings(projectDir).fallbackModel).toBeUndefined();
    writeProject({ fallbackModel: "   " });
    expect(loadSettings(projectDir).fallbackModel).toBeUndefined();
  });
});
