/**
 * provider-pool.test.ts — the declared seat pool's settings spelling and its
 * pure selection rule.
 *
 * The pool exists to make a provider switch a declared, recorded rule instead
 * of a hidden retry inside another extension. These tests pin the file shapes
 * and the anchor rule; the dispatch/attempt behaviour lives in
 * subagent-model-routing.test.ts, next to the faux-provider harness.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyProviderFailure, poolMembersFor } from "../src/model-routing.js";
import { loadSettings, SETTING_DEFAULTS } from "../src/settings.js";

describe("poolMembersFor", () => {
  const pool = { strategy: "fill_first" as const, members: ["github-copilot", "github-copilot-2"] };

  it("applies only to the anchored (first) member", () => {
    expect(poolMembersFor({ provider: "github-copilot", id: "gpt-6-luna" }, pool)).toEqual(pool.members);
    expect(poolMembersFor({ provider: "opencode-go", id: "deepseek-v4.1-flash" }, pool)).toEqual([]);
    expect(poolMembersFor({ provider: "github-copilot-2", id: "gpt-6-luna" }, pool)).toEqual([]);
  });

  it("is off when disabled, undeclared, or under-filled", () => {
    expect(poolMembersFor({ provider: "github-copilot", id: "x" }, false)).toEqual([]);
    expect(poolMembersFor({ provider: "github-copilot", id: "x" }, undefined)).toEqual([]);
    expect(poolMembersFor({ provider: "github-copilot", id: "x" }, { strategy: "fill_first", members: ["github-copilot"] })).toEqual([]);
  });

  it("returns a copy, so an attempt cannot mutate the declaration", () => {
    const members = poolMembersFor({ provider: "github-copilot", id: "x" }, pool);
    members.pop();
    expect(pool.members).toHaveLength(2);
  });
});

describe("providerPool setting", () => {
  let agentDir: string;
  let projectDir: string;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "provider-pool-agent-"));
    projectDir = mkdtempSync(join(tmpdir(), "provider-pool-project-"));
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

  it("is off by default", () => {
    expect(SETTING_DEFAULTS.providerPool).toBe(false);
    // Unset stays absent in the parsed shape, like every other unset key; the
    // applier falls back to `SETTING_DEFAULTS`, which is `false`.
    expect(loadSettings(projectDir).providerPool).toBeUndefined();
  });

  it("keeps a declared pool in declaration order", () => {
    writeProject({ providerPool: { strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] } });
    expect(loadSettings(projectDir).providerPool).toEqual({
      strategy: "fill_first",
      members: ["github-copilot", "github-copilot-2"],
    });
  });

  it("normalizes an unsupported strategy instead of rotating by it", () => {
    writeProject({ providerPool: { strategy: "round_robin", members: ["github-copilot", "github-copilot-2"] } });
    expect(loadSettings(projectDir).providerPool).toEqual({
      strategy: "fill_first",
      members: ["github-copilot", "github-copilot-2"],
    });
  });

  it("turns a malformed declaration off instead of half-honouring it", () => {
    writeProject({ providerPool: { strategy: "fill_first", members: ["github-copilot"] } });
    expect(loadSettings(projectDir).providerPool).toBe(false);
    writeProject({ providerPool: { members: [] } });
    expect(loadSettings(projectDir).providerPool).toBe(false);
    writeProject({ providerPool: true });
    expect(loadSettings(projectDir).providerPool).toBe(false);
  });

  it("rejects the whole declaration when any member is malformed", () => {
    writeProject({
      providerPool: {
        strategy: "least_used",
        members: ["github-copilot", "github-copilot-2", "bad/member"],
      },
    });
    expect(loadSettings(projectDir).providerPool).toBe(false);
  });

  it("dedupes good members and defaults an unknown strategy", () => {
    writeProject({
      providerPool: {
        strategy: "least_used",
        members: ["github-copilot", "github-copilot", "github-copilot-2"],
      },
    });
    expect(loadSettings(projectDir).providerPool).toEqual({
      strategy: "fill_first",
      members: ["github-copilot", "github-copilot-2"],
    });
  });
});

describe("provider failure classification around the pool", () => {
  it("treats a gateway outage as a provider failure", () => {
    // Without this the most common rotation trigger (502) would be read as a
    // failed task gate and never reach the next seat.
    expect(classifyProviderFailure({ isError: true, text: "502 Bad Gateway" })).toBe(true);
    expect(classifyProviderFailure({ isError: true, text: "upstream gateway timeout" })).toBe(true);
  });

  it("still treats a failed gate as a task failure", () => {
    expect(classifyProviderFailure({ isError: true, text: "gate command failed: npm test" })).toBe(false);
    expect(classifyProviderFailure({ isError: true, text: "2 tests failed" })).toBe(false);
  });
});
