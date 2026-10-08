/**
 * stop-subagent-wiring.test.ts — the model-callable cancellation tools.
 *
 * Before these, every abort lived on a UI surface or an internal path: a model
 * could launch a background agent or a workflow and then had no way to stop one
 * it had started by mistake. The two tools here are thin, but their *refusals*
 * are the load-bearing part — a stop must not become a way to reach an agent or
 * a workflow run the calling session does not own.
 *
 * Top-level: the session's own running agent stops; an unknown id, a finished
 * agent, and (covered in nested-tools.test.ts) a nested child are refused.
 * Workflow: a run this session started stops; a real run id from another
 * session is refused, because `workflowTasks` survives a session switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/** A `runAgent` that never settles — the spawned agent stays running. */
function heldRun() {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
}

describe("stop_subagent", () => {
  it("stops the session's own running agent, then refuses a second stop and an unknown id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const spawned = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "stop wiring agent", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await flush();

    const stopped = await tools.get("stop_subagent").execute("tc-stop", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(stopped)).toContain(`Stopped agent ${id}`);

    // The record is terminal now — a second stop must not claim it stopped again.
    const again = await tools.get("stop_subagent").execute("tc-stop-2", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(again)).toContain("not running");
    expect(textOf(again)).toContain("stopped");

    const missing = await tools.get("stop_subagent").execute("tc-stop-3", { agent_id: "no-such-agent" }, undefined, undefined, ctx());
    expect(textOf(missing)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.();
  });
});

describe("stop_workflow", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true } });
    booted = makePi();
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  // Never resolves, so the run is still live when the stop arrives. Aborting
  // the run's controller terminates the worker, which is what lets the test exit.
  const holdingScript =
    'export const meta = { name: "hold", description: "holds open" };\nawait new Promise(() => {});\n';

  it("stops a run this session started, and refuses a run id from another session", async () => {
    const tools = booted.tools;
    const workflowCtx = () => ctx({ cwd: hermetic.dir });

    const started = await tools.get("SubagentWorkflow").execute("tc-wf", { script: holdingScript }, undefined, undefined, workflowCtx());
    const runId = /Task ID: (\S+)/.exec(textOf(started))![1];

    // A real run id, but the calling session is not the one that started it.
    const foreign = await tools.get("stop_workflow").execute(
      "tc-stop-foreign",
      { run_id: runId },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir, sessionManager: { getSessionId: () => "another-session", getBranch: () => [] } }),
    );
    expect(textOf(foreign)).toContain("another session");

    const stopped = await tools.get("stop_workflow").execute("tc-stop", { run_id: runId }, undefined, undefined, workflowCtx());
    expect(textOf(stopped)).toContain(`Stopping workflow ${runId}`);

    const again = await tools.get("stop_workflow").execute("tc-stop-2", { run_id: runId }, undefined, undefined, workflowCtx());
    expect(textOf(again)).toContain("already stopping");

    const unknown = await tools.get("stop_workflow").execute("tc-stop-3", { run_id: "wf_zzzzzzzzzzzz" }, undefined, undefined, workflowCtx());
    expect(textOf(unknown)).toContain("Workflow not found");

    await booted.lifecycle.get("session_shutdown")?.();
  });
});
