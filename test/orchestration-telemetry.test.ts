import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createWorkflowArtifacts } from "../src/workflow/artifacts.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

vi.setConfig({ testTimeout: 20_000 });

const TASK_ID = "telemetry-task";
const WORKFLOW_SCRIPT = `
export const meta = { name: "telemetry-test", description: "exercise usage telemetry" };
await artifacts.write("plan.md", "# approved plan");
const result = await agent("do work", { label: "worker", effort: "medium" });
await artifacts.write("review.md", result);
return result;
`;

describe("workflow telemetry", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;

  beforeEach(() => {
    vi.stubEnv("PI_SUBAGENTS_MODEL_ROUTING", "off");
    vi.mocked(runAgent).mockReset();
    hermetic = hermeticDir({ settings: { workflowsEnabled: true, schedulingEnabled: false } });
    booted = makePi();
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    await flush();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic.restore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("records each observed message delta once and keeps completion usage null", async () => {
    const session = {
      model: {
        id: "faux-1",
        name: "faux-1",
        provider: "faux",
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
      thinkingLevel: "high",
      sessionManager: { getSessionId: () => "child-session" },
      dispose: vi.fn(),
      messages: [],
    };
    const messages = [
      {
        lifetime: { input: 100, output: 40, cacheRead: 0, cacheWrite: 20, cost: 0 },
        observed: { input: 100, output: 40, cacheRead: null, cacheWrite: 20, cost: null },
      },
      {
        lifetime: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        observed: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
      },
    ];
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.(session as any);
      for (const message of messages) options.onAssistantUsage?.(message.lifetime, message.observed);
      return { responseText: "worker result", session: session as any, aborted: false, steered: false };
    });

    const tool = booted.tools.get("SubagentWorkflow");
    const result = await tool.execute(
      "tc-telemetry",
      { script: WORKFLOW_SCRIPT, args: { taskId: TASK_ID } },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    expect(textOf(result)).toContain("started");

    const store = createWorkflowArtifacts(hermetic.dir, TASK_ID);
    await vi.waitFor(async () => expect(await store.read("review.md")).not.toBeUndefined(), { timeout: 5_000 });
    const review = await store.read("review.md");
    expect(review).toBe("worker result");
    await vi.waitFor(async () => expect((await store.readUsage()).records).toHaveLength(3), { timeout: 5_000 });
    const usage = await store.readUsage();

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(usage.malformedLines).toBe(0);
    expect(usage.records).toHaveLength(3);
    expect(usage.records.slice(0, 2)).toMatchObject([
      {
        event: "usage",
        taskId: TASK_ID,
        role: "general-purpose",
        provider: "faux",
        model: "faux-1",
        requestedThinking: "medium",
        effectiveThinking: "high",
        input: 100,
        output: 40,
        cacheRead: null,
        cacheWrite: 20,
        costUsd: null,
        attempt: 1,
        status: null,
        durationMs: null,
      },
      {
        event: "usage",
        input: 30,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0.001,
      },
    ]);
    expect(usage.records[2]).toMatchObject({
      event: "complete",
      taskId: TASK_ID,
      role: "general-purpose",
      status: "completed",
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      costUsd: null,
      attempt: 1,
    });
    expect(usage.records[2].durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(usage.records)).not.toContain("do work");
  });
});

