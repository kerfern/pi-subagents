import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) => {
      if (fsMock.failRename) {
        fsMock.failRename = false;
        throw new Error("simulated rename failure");
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import { createWorkflowArtifacts, finishWorkflowArtifacts, registerWorkflowArtifacts } from "../src/workflow/artifacts.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-workflow-artifacts-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const validState = (taskId = "task-1") => ({
  taskId,
  mode: "complex",
  stage: "plan",
  originalRequestRef: null,
  planVersion: 1,
  approvedPlanVersion: null,
  agents: [],
  repairAttempts: 0,
  checks: [],
  blockers: [],
  reviewStatus: "pending",
});

const usage = {
  event: "usage",
  taskId: "task-1",
  workflowId: "workflow-1",
  agentId: "agent-1",
  role: "advisor",
  provider: "openai-codex",
  model: "gpt-6.1-sol",
  requestedThinking: "high",
  effectiveThinking: "high",
  input: 10,
  output: 5,
  cacheRead: 3,
  cacheWrite: 1,
  costUsd: null,
  attempt: 1,
  status: null,
  durationMs: null,
} as const;

describe("workflow artifact store", () => {
  it("reads missing files and atomically round-trips fixed text/state artifacts", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    expect(await artifacts.read("plan.md")).toBeUndefined();
    await artifacts.write("plan.md", "# Plan\n");
    expect(await artifacts.read("plan.md")).toBe("# Plan\n");

    const state = validState();
    await artifacts.write("state.json", JSON.stringify(state));
    expect(JSON.parse((await artifacts.read("state.json"))!)).toEqual(state);
  });

  it("reports an existing task directory without creating a missing one", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    const exists = (artifacts as unknown as { exists?: () => Promise<boolean> }).exists;
    expect(exists).toBeTypeOf("function");
    if (exists === undefined) return;

    expect(await exists.call(artifacts)).toBe(false);
    await artifacts.write("plan.md", "# Existing task\n");
    expect(await exists.call(artifacts)).toBe(true);
  });

  it("rejects arbitrary names and unsafe task IDs", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await expect(artifacts.read("../secret" as never)).rejects.toThrow(/artifact name/i);
    await expect(artifacts.write("usage.jsonl" as never, "x")).rejects.toThrow(/artifact name/i);
    for (const taskId of ["", "../escape", "a/b", "a..b", "_starts-wrong", "x".repeat(65)]) {
      expect(() => createWorkflowArtifacts(cwd, taskId)).toThrow(/task id/i);
    }
  });

  it("rejects symlinked .pi, workflow, and task directories", async () => {
    const outside = join(cwd, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, ".pi"), "dir");
    await expect(createWorkflowArtifacts(cwd, "task-1").read("plan.md")).rejects.toThrow(/symlink/i);

    rmSync(join(cwd, ".pi"), { force: true });
    mkdirSync(join(cwd, ".pi"));
    symlinkSync(outside, join(cwd, ".pi", "workflow"), "dir");
    await expect(createWorkflowArtifacts(cwd, "task-1").read("plan.md")).rejects.toThrow(/symlink/i);

    rmSync(join(cwd, ".pi", "workflow"), { force: true });
    mkdirSync(join(cwd, ".pi", "workflow"));
    symlinkSync(outside, join(cwd, ".pi", "workflow", "task-1"), "dir");
    await expect(createWorkflowArtifacts(cwd, "task-1").read("plan.md")).rejects.toThrow(/symlink/i);
  });

  it("appends allowlisted usage and preserves earlier rows when final JSONL line is partial", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await artifacts.appendUsage(usage);
    const usagePath = join(cwd, ".pi", "workflow", "task-1", "usage.jsonl");
    appendFileSync(usagePath, "{partial", "utf-8");

    const result = await artifacts.readUsage();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject(usage);
    expect(result.records[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(result.malformedLines).toBe(1);
  });

  it("preserves off as a distinct requested telemetry level", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await artifacts.appendUsage({ ...usage, requestedThinking: "off" });

    const result = await artifacts.readUsage();
    expect(result.records[0].requestedThinking).toBe("off");
  });

  it("persists gate outcomes without command text or output", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await artifacts.write("state.json", JSON.stringify(validState()));
    registerWorkflowArtifacts("wf_abc123", "task-1", artifacts);
    const module = await import("../src/workflow/artifacts.js");
    const appendWorkflowCheck = (module as unknown as {
      appendWorkflowCheck?: (
        workflowId: string,
        check: { outcome: "passed" | "failed" | "unavailable"; exitCode: number | null },
      ) => Promise<void>;
    }).appendWorkflowCheck;

    expect(appendWorkflowCheck).toBeTypeOf("function");
    if (appendWorkflowCheck === undefined) return;
    await appendWorkflowCheck("wf_abc123", { outcome: "failed", exitCode: null });
    await finishWorkflowArtifacts("wf_abc123");

    const state = JSON.parse((await artifacts.read("state.json"))!);
    expect(state.checks).toEqual([{ command: "workflow gate", outcome: "failed", exitCode: null }]);
  });

  it("accepts completion rows with zero provider attempts when spawn never started", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await artifacts.appendUsage({
      ...usage,
      event: "complete",
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      costUsd: null,
      attempt: 0,
      status: "error",
      durationMs: 0,
    });

    const result = await artifacts.readUsage();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ event: "complete", attempt: 0, status: "error" });
  });

  it("rejects usage records with extra sensitive fields or mismatched task IDs", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await expect(artifacts.appendUsage({ ...usage, prompt: "do not persist" } as never)).rejects.toThrow(/field|schema/i);
    await expect(artifacts.appendUsage({ ...usage, taskId: "task-2" })).rejects.toThrow(/task id/i);
    expect((await artifacts.readUsage()).records).toHaveLength(0);
  });

  it("does not overwrite valid state when replacement state is malformed or mismatched", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    const state = JSON.stringify(validState());
    await artifacts.write("state.json", state);
    await expect(artifacts.write("state.json", "{broken")).rejects.toThrow(/state/i);
    await expect(artifacts.write("state.json", JSON.stringify({ ...validState(), taskId: "task-2" }))).rejects.toThrow(/state/i);
    await expect(artifacts.write("state.json", JSON.stringify({ ...validState(), prompt: "secret" }))).rejects.toThrow(/state/i);
    expect(await artifacts.read("state.json")).toBe(state);
  });

  it("preserves prior content when atomic rename fails", async () => {
    const artifacts = createWorkflowArtifacts(cwd, "task-1");
    await artifacts.write("plan.md", "prior");
    fsMock.failRename = true;
    await expect(artifacts.write("plan.md", "replacement")).rejects.toThrow("simulated rename failure");
    expect(await artifacts.read("plan.md")).toBe("prior");
  });
});
