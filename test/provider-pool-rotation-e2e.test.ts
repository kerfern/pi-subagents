/**
 * provider-pool-rotation-e2e.test.ts — the pool rotates on a REAL 401.
 *
 * The unit suite (test/subagent-model-routing.test.ts) injects `RunResult`
 * failures, so it cannot prove that an upstream error survives the real child
 * session and is classified by the manager rather than being swallowed, retried
 * internally, or reported as a task failure. This drives the real extension, the
 * real `runAgent` path and two faux provider seats that serve the same model id:
 * seat one returns a 401, seat two answers. Both attempts must be recorded and no
 * third attempt may happen.
 *
 * Faux is deliberate — a live 401 is not reproducible without disturbing
 * credentials. `live: false` keeps the pre-publish smoke from swapping a real
 * model in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolResults,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

const AUTH_FAILURE = "401 unauthorized: seat rejected the token";

vi.setConfig({ testTimeout: 30_000 });

interface Attempt {
  key: string;
  leg: string;
  outcome: string;
}

describe("provider pool rotation on a real child 401", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("serves the task from seat two and records both attempts", async () => {
    // The routed model id is the shipped default, so the real route resolves:
    // the primary seat registers as that provider, and the pool names a second.
    cwd = mkdtempSync(join(tmpdir(), "pool-rotation-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({
        providerPool: { strategy: "fill_first", members: ["github-copilot", "github-copilot-2"] },
        fallbackModel: "none",
      }),
    );

    const bus = createEventBus();
    let completedId: string | undefined;
    bus.on("subagents:completed", (data) => {
      const id = (data as { id?: string }).id;
      if (id !== undefined) completedId = id;
    });

    let childCalls = 0;
    run = await runPrintMode({
      eventBus: bus,
      cwd,
      prompt: "Delegate.",
      primaryProvider: "github-copilot",
      primaryModelId: "claude-haiku-5.5",
      extraProviderSeats: ["github-copilot-2"],
      beforeRun: () => {
        // vitest.config disables routing process-wide; this suite needs it live.
        delete process.env.PI_SUBAGENTS_MODEL_ROUTING;
      },
      respond: routeBySession({
        parentInitial: agentCall({ run_in_background: false, description: "seats", prompt: "Work." }),
        parentFinal: "parent done",
        subagent: () => {
          childCalls++;
          if (childCalls === 1) {
            return fauxAssistantMessage([], { stopReason: "error", errorMessage: AUTH_FAILURE });
          }
          return "SEAT_TWO_SERVED";
        },
      }),
      live: false,
    });

    const toolResult = agentToolResults(run.parentSession).join("\n");
    expect(toolResult).toContain("SEAT_TWO_SERVED");
    // One failed seat, one serving seat — and nothing after the successful one.
    expect(childCalls).toBe(2);

    // The record is what survives a restart, so assert it directly.
    const record = completedId === undefined ? undefined : (run.manager?.getRecord(completedId) as {
      providerRoute?: { attempts?: Attempt[]; servedModelKey?: string };
    } | undefined);
    const attempts = record?.providerRoute?.attempts;
    expect(attempts?.map((a) => [a.key, a.leg, a.outcome])).toEqual([
      ["github-copilot/claude-haiku-5.5", "pool", "provider-error"],
      ["github-copilot-2/claude-haiku-5.5", "pool", "success"],
    ]);
    expect(record?.providerRoute?.servedModelKey).toBe("github-copilot-2/claude-haiku-5.5");
  });
});
