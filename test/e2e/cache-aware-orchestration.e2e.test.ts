import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../src/agent-types.js";
import { DEFAULT_AGENTS } from "../../src/default-agents.js";
import { createWorkflowArtifacts } from "../../src/workflow/artifacts.js";
import { type PrintModeRun, runPrintMode, toolCallsNamed, toolResultsNamed } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 90_000 });

const SCRIPT = readFileSync(new URL("../../examples/workflows/cache-aware-orchestration.js", import.meta.url), "utf-8");
const PLAN = {
  objective: "Implement one bounded change",
  invariants: ["Keep tests passing"],
  files: ["src/example.ts"],
  steps: [{ id: "step-1", task: "Make the change", dependsOn: [], verify: "true" }],
  acceptance: ["Focused test passes"],
  assumptions: [],
};
const REVIEW = {
  requirements: [{ item: "Focused test passes", status: "pass", evidence: ["check:1"] }],
  blockers: [],
  residualRisks: [],
};

function configureFauxProfiles() {
  vi.stubEnv("PI_SUBAGENTS_MODEL_ROUTING", "off");
  const agents = new Map(DEFAULT_AGENTS);
  for (const name of ["Plan", "advisor", "reviewer"]) {
    const profile = agents.get(name);
    if (profile !== undefined) agents.set(name, { ...profile, model: "faux/faux-1" });
  }
  registerAgents(agents);
}

function respond(stage: string, args: Record<string, unknown>) {
  return (context: Context) => {
    const tools = context.tools ?? [];
    if (tools.some(tool => tool.name === "SubagentWorkflow")) {
      const started = context.messages.some(message =>
        message.role === "toolResult" && (message as { toolName?: string }).toolName === "SubagentWorkflow",
      );
      return started
        ? fauxText("workflow launched")
        : fauxToolCall("SubagentWorkflow", { script: SCRIPT, args }, { id: `workflow-${stage}` });
    }

    if (tools.some(tool => tool.name === "StructuredOutput")) {
      const recorded = context.messages.some(message =>
        message.role === "toolResult" && (message as { toolName?: string }).toolName === "StructuredOutput",
      );
      if (recorded) return fauxText("structured answer recorded");
      return fauxToolCall("StructuredOutput", stage === "plan" ? PLAN : REVIEW, { id: `structured-${stage}` });
    }
    return fauxText("bounded worker result");
  };
}

async function runStage(
  cwd: string,
  stage: string,
  args: Record<string, unknown>,
  waitFor: () => Promise<void>,
): Promise<{
  responseText: string;
  workflowCalls: Array<Record<string, unknown>>;
  workflowResults: string[];
  subagents: Array<Record<string, unknown>>;
}> {
  let run: PrintModeRun | undefined;
  try {
    run = await runPrintMode({
      prompt: `Launch ${stage} stage.`,
      cwd,
      live: false,
      maxModelCalls: 12,
      beforeRun: configureFauxProfiles,
      respond: respond(stage, args),
    });
    await run.manager?.waitForAll();
    await waitFor();
    return {
      responseText: run.responseText,
      workflowCalls: toolCallsNamed(run.parentSession, "SubagentWorkflow"),
      workflowResults: toolResultsNamed(run.parentSession, "SubagentWorkflow"),
      subagents: run.subagents,
    };
  } finally {
    await run?.dispose();
    registerAgents(new Map(DEFAULT_AGENTS));
    vi.unstubAllEnvs();
  }
}

describe("cache-aware orchestration (real faux sessions)", () => {
  let cwd: string | undefined;

  afterEach(() => {
    if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
    registerAgents(new Map(DEFAULT_AGENTS));
    vi.unstubAllEnvs();
  });

  it("carries one task through Plan, gated worker, and reviewer without storing gate output", async () => {
    cwd = mkdtempSync(join(tmpdir(), "pi-subagents-cache-aware-e2e-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: true }));
    const taskId = "faux-pilot-task";
    const store = createWorkflowArtifacts(cwd, taskId);

    const taskDir = join(cwd, ".pi", "workflow", taskId);
    const planRun = await runStage(cwd, "plan", {
      taskId,
      mode: "routine",
      stage: "plan",
      task: "Implement one bounded test-only change.",
      originalRequestRef: "TEST-42",
    }, async () => {
      await vi.waitFor(() => expect(existsSync(join(taskDir, "state.json"))).toBe(true), { timeout: 15_000 });
    });
    expect(planRun.workflowCalls).toHaveLength(1);
    expect(planRun.responseText).toContain("workflow launched");
    const planText = await store.read("plan.md");
    expect(JSON.parse(planText!)).toMatchObject({ objective: PLAN.objective, acceptance: PLAN.acceptance });
    expect(JSON.parse(readFileSync(join(taskDir, "state.json"), "utf-8")).approvedPlanVersion).toBeNull();
    const planTelemetry = (await store.readUsage()).records;
    expect(planTelemetry.some(record => record.event === "usage" && record.role === "Plan")).toBe(true);
    expect(planTelemetry.some(record => record.event === "complete" && record.role === "Plan")).toBe(true);

    await runStage(cwd, "worker", {
      taskId,
      mode: "routine",
      stage: "worker",
      approvedPlanVersion: 1,
      test: "printf secret-gate-output",
    }, async () => {
      await vi.waitFor(() => {
        const stateText = readFileSync(join(taskDir, "state.json"), "utf-8");
        const state = JSON.parse(stateText);
        expect(state.approvedPlanVersion).toBe(1);
        expect(state.checks).toHaveLength(1);
        expect(state.checks[0]).toMatchObject({ command: "workflow gate", outcome: "passed", exitCode: 0 });
        expect(stateText).not.toContain("printf secret-gate-output");
        expect(stateText).not.toContain("secret-gate-output");
      }, { timeout: 15_000 });
    });

    await runStage(cwd, "review", {
      taskId,
      mode: "routine",
      stage: "review",
      reviewContext: {
        revisionId: "e2e-revision-1",
        originalRequest: "redacted original request",
        approvedPlan: planText,
        actualDiff: "diff summary only",
        validationResults: "gate 1 passed",
        unresolvedIssues: "none",
      },
    }, async () => {
      await vi.waitFor(() => {
        const state = JSON.parse(readFileSync(join(taskDir, "state.json"), "utf-8"));
        expect(state.reviewStatus).toBe("pass");
        expect(existsSync(join(taskDir, "review.md"))).toBe(true);
      }, { timeout: 15_000 });
    });

    const review = await store.read("review.md");
    expect(review).toContain('"status": "pass"');
    expect(review).toContain('"item": "Focused test passes"');
    expect(review).not.toContain("redacted original request");
    expect(review).not.toContain("diff summary only");
  });
});
