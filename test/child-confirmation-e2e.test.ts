/**
 * child-confirmation-e2e.test.ts — OFFLINE end-to-end coverage of the guarded
 * approval bridge.
 *
 * These tests drive the REAL extension: a real child session is spawned through
 * the real `Agent` tool, a real child extension (`test/fixtures/bridge-confirm-probe.ts`)
 * calls `ctx.ui.confirm(...)`, and the production bridge routes that call to
 * the ROOT session's dialog. The only fake is the root's dialog itself — a
 * scripted `ExtensionUIContext` bound to the parent session — plus the faux
 * model that decides what each turn emits.
 *
 * What this covers is the NONVISUAL contract: routing, attribution, the
 * approval path, FIFO ordering and every denial path. It does NOT replace the
 * real-TUI operator acceptance (docs/guarded-approval-bridge-tui-acceptance.md):
 * native rendering, key input and dialog teardown at reload are not observable
 * here and stay a TUI-only check.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type FauxReply,
  type FauxResponder,
  type ManagerHandle,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

const PROBE_PATH = fileURLToPath(new URL("./fixtures/bridge-confirm-probe.ts", import.meta.url));

// --------------------------------------------------------------------------
// Scripted root dialog
// --------------------------------------------------------------------------

interface ConfirmCall {
  title: string;
  message: string;
  options?: ExtensionUIDialogOptions;
  resolve(value: boolean): void;
  reject(error: unknown): void;
  readonly signal?: AbortSignal;
}

/**
 * The root session's dialog, scripted. `confirm` never resolves on its own:
 * a test resolves or rejects the call it receives, so a request can be held
 * open for as long as a scenario needs.
 */
class ScriptedRootUI {
  readonly calls: ConfirmCall[] = [];
  private readonly arrived: ConfirmCall[] = [];
  private readonly waiters: Array<(call: ConfirmCall) => void> = [];

  async confirm(title: string, message: string, options?: ExtensionUIDialogOptions): Promise<boolean> {
    let resolveFn!: (value: boolean) => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<boolean>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const call: ConfirmCall = {
      title,
      message,
      options,
      resolve: resolveFn,
      reject: rejectFn,
      signal: options?.signal,
    };
    this.calls.push(call);
    this.arrived.push(call);
    const waiter = this.waiters.shift();
    if (waiter) waiter(this.arrived.shift()!);
    return promise;
  }

  /** The next call that arrives, or the one that already has. */
  nextCall(): Promise<ConfirmCall> {
    const arrived = this.arrived.shift();
    if (arrived) return Promise.resolve(arrived);
    return new Promise<ConfirmCall>((resolve) => this.waiters.push(resolve));
  }
}

function toUIContext(ui: ScriptedRootUI): ExtensionUIContext {
  return {
    confirm: (title: string, message: string, options?: ExtensionUIDialogOptions) =>
      ui.confirm(title, message, options),
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
  } as unknown as ExtensionUIContext;
}

// --------------------------------------------------------------------------
// Event bus (the extension's own RPC channels run on it)
// --------------------------------------------------------------------------

class TestBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
}

function stopChild(bus: TestBus, agentId: string): Promise<unknown> {
  const requestId = `e2e-stop-${agentId}`;
  return new Promise((resolve) => {
    const unsubscribe = bus.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
      unsubscribe();
      resolve(reply);
    });
    bus.emit("subagents:rpc:stop", { requestId, agentId });
  });
}

// --------------------------------------------------------------------------
// Project fixture + faux driving
// --------------------------------------------------------------------------

interface TraceRow {
  event: string;
  label: string;
  title?: string;
  message?: string;
  timeout?: number;
  answer?: boolean;
  aborted?: boolean;
  ms?: number;
  sessionId?: string;
  hasUI?: boolean;
}

function createProject(): { dir: string; tracePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "bridge-probe.md"),
    [
      "---",
      "name: bridge-probe",
      "description: Requests one confirmation through the approval bridge.",
      "tools: ext:bridge-confirm-probe/bridge_confirm_probe",
      `extensions: ["${PROBE_PATH}"]`,
      "skills: false",
      "persist_session: false",
      "output_transcript: false",
      "---",
      "",
      "Call the bridge_confirm_probe tool exactly once, with the label given in the task.",
      "",
    ].join("\n"),
  );
  return { dir, tracePath: join(dir, "trace.ndjson") };
}

function readTrace(path: string): TraceRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRow);
}

/** Wait until the probe has recorded `count` requests — the child's own barrier. */
async function waitForRequests(path: string, count: number, timeoutMs = 15_000): Promise<TraceRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readTrace(path).filter((row) => row.event === "requested");
    if (rows.length >= count) return rows;
    if (Date.now() > deadline) {
      throw new Error(`probe trace did not reach ${count} request(s) (got ${rows.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until the probe has recorded the END of one request — the denial barrier. */
async function waitForEnd(path: string, label: string, timeoutMs = 15_000): Promise<TraceRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = readTrace(path).find((entry) => entry.event === "end" && entry.label === label);
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error(`probe trace did not record the end of "${label}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until the probe has recorded `count` rows — the child's own barrier. */
async function waitForTrace(path: string, count: number, timeoutMs = 15_000): Promise<TraceRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readTrace(path);
    if (rows.length >= count) return rows;
    if (Date.now() > deadline) {
      throw new Error(`probe trace did not reach ${count} row(s) (got ${rows.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The text blocks of a single message. */
function blockText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block as { text?: string }).text ?? "").join(" ");
  }
  return "";
}

function contextText(ctx: Context): string {
  return ctx.messages
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((block) => (block as { text?: string }).text ?? "").join(" ");
      }
      return "";
    })
    .join("\n");
}

/**
 * Branch parent and child turns the way `routeBySession` does: only the parent
 * has the `Agent` tool, so the child's turn is always the probe call.
 */
function branchedResponder(
  parent: (ctx: Context) => FauxReply | Promise<FauxReply>,
  child: (ctx: Context) => FauxReply | Promise<FauxReply>,
): FauxResponder {
  return (ctx: Context) => {
    const isParent = (ctx.tools ?? []).some((tool) => tool.name === "Agent");
    return isParent ? parent(ctx) : child(ctx);
  };
}

/** The last PROBE_LABEL marker in a text — the newest request wins. */
function lastLabelIn(text: string): string {
  const matches = [...text.matchAll(/PROBE_LABEL=([A-Za-z0-9_-]+)/g)];
  return matches.at(-1)?.[1] ?? "unlabelled";
}

/** The child's turn: call the probe once per label, then report the answer. */
function childResponder(tracePath: string, extra: Record<string, unknown> = {}) {
  return (ctx: Context): FauxReply => {
    // A RESUMED child's context still holds the PREVIOUS run's prompt, so the
    // label of the CURRENT request is the LAST one in the context.
    const label = lastLabelIn(contextText(ctx));
    // A RESUMED child carries the previous run's tool result in its context, so
    // "answered" means "answered for THIS label" — not "answered at all".
    const lastResult = [...ctx.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolName?: string }).toolName === "bridge_confirm_probe",
      );
    const lastLabel = lastResult
      ? /"label":"([^"]+)"/.exec(blockText(lastResult))?.[1]
      : undefined;
    if (lastLabel === label) return "PROBE_DONE";
    return [
      fauxToolCall(
        "bridge_confirm_probe",
        {
          label,
          title: `Confirm ${label}`,
          message: "This is only a probe.",
          tracePath,
          ...extra,
        },
        { id: `probe-${label}` },
      ),
    ];
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("guarded approval bridge (offline e2e)", () => {
  const runs: PrintModeRun[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const run of runs.splice(0)) {
      await run.dispose();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes a child's confirmation to the root dialog with attribution and settles the child with the root's answer", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    let call: ConfirmCall | undefined;
    let manager: ManagerHandle | undefined;

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=one",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
      onBound: (handle) => {
        manager = handle.manager;
        void (async () => {
          call = await ui.nextCall();
          call.resolve(true);
        })();
      },
    });
    runs.push(run);

    expect(call, "the root dialog was never shown").toBeDefined();
    // Attribution prefix, then the child's own title, unchanged.
    expect(call!.title).toMatch(/^\[Child name=[^;]+; id=[^\]]+\] Confirm one$/);
    expect(call!.message).toBe("This is only a probe.");
    // The id in the prefix is the CHILD's record, not an invented one.
    const prefixId = /id=([^\]]+)\]/.exec(call!.title)?.[1];
    expect(prefixId).toBeTruthy();
    expect(manager?.getRecord(prefixId!)).toBeDefined();
    // The bridge hands the root dialog the remaining 60s budget — not more.
    expect(call!.options?.timeout).toBeGreaterThan(59_000);
    expect(call!.options?.timeout).toBeLessThanOrEqual(60_000);

    const rows = readTrace(tracePath);
    expect(rows.find((row) => row.event === "requested")?.hasUI).toBe(true);
    expect(rows.find((row) => row.event === "end")?.answer).toBe(true);
  });

  it("denies the child when the root dialog answers false", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=deny",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
      onBound: () => {
        void (async () => {
          (await ui.nextCall()).resolve(false);
        })();
      },
    });
    runs.push(run);

    // The child was denied BY the dialog, not by a path that skipped it.
    expect(ui.calls.length).toBe(1);
    expect(readTrace(tracePath).find((row) => row.event === "end")?.answer).toBe(false);
  });

  it("denies the child when the root dialog is cancelled", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=cancel",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
      onBound: () => {
        void (async () => {
          (await ui.nextCall()).reject(new Error("cancelled"));
        })();
      },
    });
    runs.push(run);

    expect(ui.calls.length).toBe(1);
    expect(readTrace(tracePath).find((row) => row.event === "end")?.answer).toBe(false);
  });

  it("denies the child when the root dialog returns a truthy non-boolean", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=truthy",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
      onBound: () => {
        void (async () => {
          (await ui.nextCall()).resolve("yes" as unknown as boolean);
        })();
      },
    });
    runs.push(run);

    expect(ui.calls.length).toBe(1);
    expect(readTrace(tracePath).find((row) => row.event === "end")?.answer).toBe(false);
  });

  it("shows one request at a time and keeps arrival order", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    let callsWhileFirstPending = -1;
    const shownTitles: string[] = [];

    // Three children, so the queue holds more than one request at a time: the
    // order they are SHOWN in is the order they ARRIVED in.
    const parent = async (ctx: Context): Promise<FauxReply> => {
      const agentResults = ctx.messages.filter(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolName?: string }).toolName === "Agent",
      );
      const label = ["A", "B", "C"][agentResults.length];
      if (label === undefined) return "done";
      if (agentResults.length > 0) {
        // Each child must have asked before the next is spawned, so the arrival
        // order is deterministic rather than a race.
        await waitForRequests(tracePath, agentResults.length);
      }
      return agentCall({
        subagent_type: "bridge-probe",
        description: `probe ${label}`,
        prompt: `PROBE_LABEL=${label}`,
        run_in_background: true,
      });
    };

    const run = await runPrintMode({
      prompt: "Ask three probes for confirmations.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: branchedResponder(parent, childResponder(tracePath)),
      onBound: () => {
        void (async () => {
          const first = await ui.nextCall();
          shownTitles.push(first.title);
          await waitForRequests(tracePath, 3);
          // The other two are queued: the root dialog was NOT shown again.
          callsWhileFirstPending = ui.calls.length;
          first.resolve(true);
          const second = await ui.nextCall();
          shownTitles.push(second.title);
          second.resolve(true);
          const third = await ui.nextCall();
          shownTitles.push(third.title);
          third.resolve(true);
        })();
      },
    });
    runs.push(run);

    expect(callsWhileFirstPending).toBe(1);
    expect(shownTitles.map((title) => title.replace(/^.*\] /, ""))).toEqual([
      "Confirm A",
      "Confirm B",
      "Confirm C",
    ]);

    const answered = readTrace(tracePath)
      .filter((row) => row.event === "end")
      .map((row) => row.label);
    expect(answered).toEqual(["A", "B", "C"]);
  });

  it("denies the child when the caller's timeout expires, and ignores a late approval", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    let call: ConfirmCall | undefined;

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=timeout",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath, { timeout: 300 }),
      }),
      onBound: () => {
        void (async () => {
          call = await ui.nextCall();
        })();
      },
    });
    runs.push(run);

    expect(call, "the root dialog was never shown").toBeDefined();
    // The caller's shorter timeout replaces the 60s budget.
    expect(call!.options?.timeout).toBeLessThanOrEqual(300);
    expect(call!.options?.timeout).toBeGreaterThan(0);

    const rows = await waitForTrace(tracePath, 2);
    const end = rows.find((row) => row.event === "end");
    expect(end?.answer).toBe(false);
    // It was denied BY the deadline, not immediately: the request stayed pending
    // for the caller's timeout.
    expect(end?.ms).toBeGreaterThan(200);
    // The bridge aborts the root dialog's own signal when it denies.
    expect(call!.signal?.aborted).toBe(true);

    // A late approval from the dialog must not revive the request.
    call!.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readTrace(tracePath).filter((row) => row.event === "end").length).toBe(1);
  });

  it("denies the child when the caller aborts its own request", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=callerabort",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath, { abortAfterCall: true }),
      }),
    });
    runs.push(run);

    // The probe aborted its own signal right after asking: the request must be
    // denied, never approved by a dialog that is still open.
    expect(ui.calls.length).toBe(1);
    expect(ui.calls[0].signal?.aborted).toBe(true);
    const rows = readTrace(tracePath);
    expect(rows.find((row) => row.event === "end")?.answer).toBe(false);
  });

  it("denies the child when the child run is aborted while the request is pending", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    const bus = new TestBus();
    let stopReply: { success?: boolean; error?: string } | undefined;

    const parent = async (ctx: Context): Promise<FauxReply> => {
      const agentResults = ctx.messages.filter(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolName?: string }).toolName === "Agent",
      );
      if (agentResults.length === 0) {
        return agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=abort",
          run_in_background: true,
        });
      }
      const id = /Agent ID: (\S+)/.exec(contextText(ctx))?.[1];
      if (id) {
        // Abort only once the child is actually holding a pending request.
        await waitForRequests(tracePath, 1);
        stopReply = (await stopChild(bus, id)) as { success?: boolean; error?: string };
      }
      return "done";
    };

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation, then abort it.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      eventBus: bus as unknown as never,
      respond: branchedResponder(parent, childResponder(tracePath)),
    });
    runs.push(run);

    // The child was stopped while its request was pending...
    expect(stopReply?.success).toBe(true);
    // ...the root dialog was shown and then torn down...
    expect(ui.calls.length).toBe(1);
    expect(ui.calls[0].signal?.aborted).toBe(true);
    // ...and the child was denied.
    const rows = readTrace(tracePath);
    expect(rows.find((row) => row.event === "end")?.answer).toBe(false);
  });

  it("does not let a closed run's request approve through the resumed run", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    const bus = new TestBus();
    let stopped = false;
    let callsWhileResumedPending = -1;

    const parent = async (ctx: Context): Promise<FauxReply> => {
      const agentResults = ctx.messages.filter(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolName?: string }).toolName === "Agent",
      );
      if (agentResults.length === 0) {
        return agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=first",
          run_in_background: true,
        });
      }
      const id = /Agent ID: (\S+)/.exec(contextText(ctx))?.[1];
      if (id && !stopped) {
        stopped = true;
        // Close the run while its request is pending: that request must deny.
        await waitForRequests(tracePath, 1);
        await stopChild(bus, id);
        // Resume the SAME record. Its old request must not approve, and only
        // the resumed run's own request may approve.
        return agentCall({
          description: "probe resumed",
          resume: id,
          prompt: "PROBE_LABEL=second",
          run_in_background: true,
        });
      }
      return "done";
    };

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation, then resume it.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      eventBus: bus as unknown as never,
      timeoutMs: 8000,
      respond: branchedResponder(parent, childResponder(tracePath)),
      onBound: () => {
        void (async () => {
          const first = await ui.nextCall();
          // The closed run's request is denied when its run ends. Releasing the
          // root dialog afterwards with a LATE approval must not revive it —
          // and the native slot only frees once that promise settles.
          await waitForEnd(tracePath, "first");
          // The resumed run must already have asked, so the slot release below
          // is what lets its request through — not the absence of a request.
          await waitForRequests(tracePath, 2);
          // And it must still be QUEUED: the root dialog is the old run's.
          callsWhileResumedPending = ui.calls.length;
          first.resolve(true);
          const second = await ui.nextCall();
          second.resolve(true);
        })();
      },
    });
    runs.push(run);

    // The resumed request was queued behind the old run's dialog, not shown.
    expect(callsWhileResumedPending).toBe(1);

    const rows = readTrace(tracePath);
    const ended = rows.filter((row) => row.event === "end");
    // The closed run's request denied...
    expect(ended.find((row) => row.label === "first")?.answer).toBe(false);
    // ...and the resumed run's own request is the one that approved.
    expect(ended.find((row) => row.label === "second")?.answer).toBe(true);
    // Both requests came from the SAME resumed child session.
    const requested = rows.filter((row) => row.event === "requested");
    expect(requested.length).toBe(2);
    expect(requested[1].sessionId).toBe(requested[0].sessionId);
  });

  it("denies the child in a headless host without showing a dialog", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=headless",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
    });
    runs.push(run);

    // No root UI was bound, so the child has no dialog to reach and no UI to
    // speak of. The denial is immediate: a request that waited for the 60s
    // deadline would have blown the runner's guard and failed this test.
    const rows = readTrace(tracePath);
    expect(rows.find((row) => row.event === "requested")?.hasUI).toBe(false);
    expect(rows.find((row) => row.event === "end")?.answer).toBe(false);
    expect(rows.find((row) => row.event === "end")?.ms).toBeLessThan(1_000);
  });

  it("denies a pending request when the root session switches away", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    let call: ConfirmCall | undefined;

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=switch",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
      onBound: (handle) => {
        void (async () => {
          call = await ui.nextCall();
          // A root switch invalidates the bridge: the pending request denies.
          await handle.session.extensionRunner?.emit({
            type: "session_before_switch",
          } as never);
        })();
      },
    });
    runs.push(run);

    expect(call, "the root dialog was never shown").toBeDefined();
    const rows = await waitForTrace(tracePath, 2);
    expect(rows.find((row) => row.event === "end")?.answer).toBe(false);
    // A late approval from the dialog must not revive the invalidated request.
    call!.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readTrace(tracePath).filter((row) => row.event === "end").length).toBe(1);
  });

  it("scopes the probe extension to the child session, not to the parent", async () => {
    const { dir, tracePath } = createProject();
    dirs.push(dir);
    const ui = new ScriptedRootUI();
    let manager: ManagerHandle | undefined;
    let childId: string | undefined;

    const run = await runPrintMode({
      prompt: "Ask the probe for a confirmation.",
      live: false,
      cwd: dir,
      uiContext: toUIContext(ui),
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "bridge-probe",
          description: "probe",
          prompt: "PROBE_LABEL=scoped",
          run_in_background: false,
        }),
        parentFinal: "done",
        subagent: childResponder(tracePath),
      }),
      onBound: (handle) => {
        manager = handle.manager;
        void (async () => {
          const call = await ui.nextCall();
          // The bridge attributes the request to the child's own record id —
          // the handle onto the child session this test inspects.
          childId = /id=([^\]]+)\]/.exec(call.title)?.[1];
          call.resolve(true);
        })();
      },
    });
    runs.push(run);

    // The child really asked, and really was answered.
    expect(ui.calls.length).toBe(1);

    // The PARENT never loaded the probe: the `extensions:` allowlist in the
    // agent frontmatter belongs to the CHILD, so the parent's tool set carries
    // no bridge_confirm_probe — neither registered nor active.
    // The guard below keeps the negative assertion from passing vacuously: the
    // parent's tool set is real (it holds the `Agent` tool this test spawned
    // the child with), so "no bridge_confirm_probe" means "not among them".
    expect(run.parentSession.getAllTools().map((tool) => tool.name)).toContain("Agent");
    expect(
      run.parentSession.getAllTools().map((tool) => tool.name),
      "the parent session registered the child-only probe tool",
    ).not.toContain("bridge_confirm_probe");
    expect(
      run.parentSession.getActiveToolNames(),
      "the parent session activated the child-only probe tool",
    ).not.toContain("bridge_confirm_probe");

    // The CHILD did load it. These asserts fail loudly — never a skip — when
    // the child session cannot be reached, so a broken handle shows up as a
    // failing test rather than as a silently weaker one.
    expect(childId, "the child's agent id was never captured").toBeTruthy();
    const record = manager?.getRecord(childId!) as { session?: AgentSession } | undefined;
    expect(record, "the child's record was not reachable through the manager").toBeDefined();
    const childSession = record?.session;
    expect(childSession, "the child's session was not reachable through its record").toBeDefined();
    expect(
      childSession!.getAllTools().map((tool) => tool.name),
      "the child session did not register the probe tool",
    ).toContain("bridge_confirm_probe");
    expect(
      childSession!.getActiveToolNames(),
      "the child session did not activate the probe tool",
    ).toContain("bridge_confirm_probe");
  });
});
