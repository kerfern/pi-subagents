import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowArtifacts } from "../../src/workflow/artifacts.js";
import { type PrintModeRun, runPrintMode } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const TASK_ID = "faux-telemetry-task";
const SCRIPT = `
export const meta = { name: "faux-telemetry", description: "exercise real message usage" };
await artifacts.write("plan.md", "# approved plan");
const result = await agent("Run one harmless check, then report its result.", { label: "worker" });
await artifacts.write("review.md", result);
return result;
`;

function respond(context: Context) {
  const tools = context.tools ?? [];
  const hasWorkflowTool = tools.some(tool => tool.name === "SubagentWorkflow");
  const workflowStarted = context.messages.some(message =>
    message.role === "toolResult" && (message as { toolName?: string }).toolName === "SubagentWorkflow",
  );
  if (hasWorkflowTool) {
    return workflowStarted
      ? fauxText("workflow launched")
      : fauxAssistantMessage([
          fauxToolCall("SubagentWorkflow", { script: SCRIPT, args: { taskId: TASK_ID } }),
        ]);
  }

  const checkRan = context.messages.some(message =>
    message.role === "toolResult" && (message as { toolName?: string }).toolName === "bash",
  );
  return checkRan
    ? fauxText("worker result")
    : fauxAssistantMessage([fauxToolCall("bash", { command: "echo telemetry-check" })]);
}

describe("workflow telemetry (real faux sessions)", () => {
  let cwd: string;
  let run: PrintModeRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    vi.unstubAllEnvs();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("records each real child message once and keeps unpriced cost unknown", async () => {
    cwd = mkdtempSync(join(tmpdir(), "pi-subagents-telemetry-e2e-"));
    run = await runPrintMode({
      prompt: "Launch the telemetry workflow.",
      cwd,
      live: false,
      maxModelCalls: 10,
      beforeRun: () => vi.stubEnv("PI_SUBAGENTS_MODEL_ROUTING", "off"),
      respond,
    });
    await run.manager?.waitForAll();

    const store = createWorkflowArtifacts(cwd, TASK_ID);
    await vi.waitFor(async () => expect(await store.read("review.md")).toBe("worker result"), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await store.readUsage()).records.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    const usage = await store.readUsage();
    const messages = usage.records.filter(record => record.event === "usage");
    const completion = usage.records.filter(record => record.event === "complete");

    expect(usage.malformedLines).toBe(0);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.every(record => record.workflowId.length > 0
      && record.provider === "faux" && record.model === "faux-1" && record.attempt === 1)).toBe(true);
    expect(messages.every(record => record.costUsd === null)).toBe(true);
    expect(JSON.stringify(usage.records)).not.toContain("Run one harmless check");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      event: "complete",
      role: "general-purpose",
      status: "completed",
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      costUsd: null,
    });
  });
});
