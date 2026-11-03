// Acceptance for the quota guard's record-and-restore path (checkpoint -> /quota-guard restore).
//
// A pause is captured in one "process" — its own latch and its own store, over a state directory — and
// reinstated in a second process that shares nothing with the first but that directory. What this file
// claims, and nothing beyond it:
//
//   - the holds come back (root reason, provider-local automatic hold, manual intent) and so do the
//     interrupted children, as `@handle`-addressable names;
//   - the counters do NOT come back: the attempt they counted died with the first process;
//   - every checkpoint that cannot be applied is refused with the fleet still held;
//   - capture, restore and adoption reach no network and start no agent.
//
// Transports are fake by construction. The session is a plain object standing in for the transcript,
// the child transcript is a file on disk, and the agent runner is mocked. `globalThis.fetch` is a spy
// that throws, so an accidental egress fails the test that caused it instead of passing quietly.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { checkpointPath, listCheckpoints, readCheckpoint } from "../src/quota-guard/checkpoint.js";
import { FleetLatch } from "../src/quota-guard/controller.js";
import {
  captureCheckpoint,
  type NavigableSession,
  type RestoreResult,
  restoreCheckpoint,
  type SessionSource,
} from "../src/quota-guard/session-checkpoint.js";
import { openStore, type QuotaStore } from "../src/quota-guard/store.js";
import type { AgentTombstone } from "../src/types.js";

const ROOT = "root-restore-acceptance";
const SESSION_ID = "session-restore-acceptance";
const SESSION_FILE = "/sessions/restore-acceptance.jsonl";

let dir: string;

/**
 * Stands in for the network. Installed for every test so no test in this file can reach a provider,
 * and restored afterwards so nothing leaks into other suites.
 */
const fetchSpy = vi.fn<typeof globalThis.fetch>(() => {
  throw new Error("network access during quota-guard capture, restore or adoption");
});
let realFetch: typeof globalThis.fetch | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quota-restore-acceptance-"));
  fetchSpy.mockClear();
  realFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy;
});

afterEach(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  await rm(dir, { recursive: true, force: true });
});

/**
 * One "process": a latch with no holds and zero counters, and a store, both freshly constructed. The
 * state directory is the only thing the two processes in these tests have in common.
 */
async function boot(): Promise<{ fleet: FleetLatch; store: QuotaStore }> {
  return { fleet: new FleetLatch(ROOT), store: await openStore(dir, ROOT) };
}

/** A restoring process holds the guard closed before it applies anything, so a refusal can only keep it closed. */
function heldLatch(): FleetLatch {
  const fleet = new FleetLatch(ROOT);
  fleet.pause("threshold");
  return fleet;
}

interface SessionState {
  id: string;
  file: string | undefined;
  entries: string[];
  leafId: string | null;
  projection: unknown;
}

interface FakeSession {
  state: SessionState;
  view: SessionSource;
}

/** A session the guard can read; the projection is a plain object so a digest can be recomputed. */
function fakeSession(overrides: Partial<SessionState> = {}): FakeSession {
  const state: SessionState = {
    id: SESSION_ID,
    file: SESSION_FILE,
    entries: ["e1", "e2"],
    leafId: "e2",
    projection: { path: ["e1", "e2"] },
    ...overrides,
  };
  return {
    state,
    view: {
      getSessionId: () => state.id,
      getSessionFile: () => state.file,
      getLeafId: () => state.leafId,
      getEntryCount: () => state.entries.length,
      getHeader: () => ({ version: 3 }),
      getEntry: (id: string): unknown => (state.entries.includes(id) ? { id } : undefined),
      buildSessionProjection: (): unknown => state.projection,
    },
  };
}

/**
 * The command context's move. A branch at `target` leaves the projection of the path up to that entry,
 * unless a test asks for a landing that disagrees with the checkpoint.
 */
function movable(source: FakeSession, options: { cancelled?: boolean; landing?: unknown } = {}): {
  navigated: string[];
  session: NavigableSession;
} {
  const navigated: string[] = [];
  return {
    navigated,
    session: {
      sessionManager: source.view,
      async navigateTree(target: string): Promise<{ cancelled: boolean }> {
        navigated.push(target);
        if (options.cancelled) return { cancelled: true };
        const index = source.state.entries.indexOf(target);
        source.state.projection = options.landing ?? { path: source.state.entries.slice(0, index + 1) };
        source.state.leafId = target;
        return { cancelled: false };
      },
    },
  };
}

/** A child's saved conversation: adoption keeps the handle addressable, it never opens this file. */
async function childEntry(name = "child-1.jsonl"): Promise<AgentTombstone> {
  const sessionFile = join(dir, name);
  await writeFile(sessionFile, '{"type":"session"}\n');
  return {
    handle: "explore",
    id: "agent-1",
    type: "Explore",
    description: "map the reader",
    sessionFile,
    completedAt: 1_700_000_000_000,
  };
}

/** Capture the way a pausing process does, and hand back the id an operator would type. */
async function capture(
  fleet: FleetLatch,
  session: FakeSession = fakeSession(),
  children: readonly AgentTombstone[] = [],
): Promise<{ id: string; digest: string }> {
  const [written] = await captureCheckpoint({
    stateDir: dir,
    rootId: ROOT,
    fleet,
    session: session.view,
    children,
  });
  if (!written) throw new Error("capture wrote no checkpoint");
  return written;
}

/** Capture from a paused process, which is where every refusal case starts. */
async function capturedCheckpoint(): Promise<string> {
  const fleet = new FleetLatch(ROOT);
  fleet.pause("threshold");
  return (await capture(fleet, fakeSession(), [await childEntry()])).id;
}

/**
 * Attempt a restore as a held process would and expect a refusal: the fleet stays closed and no child
 * is handed to the manager.
 */
async function expectRefused(options: {
  id: string;
  session: NavigableSession;
  fleet?: FleetLatch;
  rootId?: string;
  message: RegExp;
}): Promise<RestoreResult> {
  const fleet = options.fleet ?? heldLatch();
  const adopt = vi.fn(() => ({ adopted: 0, skipped: 0 }));
  const result = await restoreCheckpoint({
    stateDir: dir,
    rootId: options.rootId ?? ROOT,
    fleet,
    session: options.session,
    id: options.id,
    adopt,
  });
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(options.message);
  expect(fleet.snapshot().state).not.toBe("open");
  expect(adopt).not.toHaveBeenCalled();
  return result;
}

describe("quota-guard restore — restart", () => {
  it("reinstates root, provider and manual holds plus children, and no counters", async () => {
    // ---- Process 1: a lease is in flight when the provider refuses, so the pause lands mid-drain.
    const first = await boot();
    const release = await first.fleet.enter("inference");
    first.fleet.pause("threshold");
    first.fleet.pauseAutomatic("commandcode", "reserve");
    first.fleet.pauseManual("openai-codex");
    const interrupted = first.fleet.exportState();
    expect(first.fleet.snapshot()).toMatchObject({ state: "draining", active: 1, inferences: 1 });

    const child = await childEntry();
    const written = await capture(first.fleet, fakeSession(), [child]);
    const recorded = await readCheckpoint(dir, written.id);
    if (!recorded.ok) throw new Error(recorded.reason);
    expect(recorded.checkpoint.fleet.state).toBe("draining");
    expect(recorded.checkpoint.children).toHaveLength(1);
    release();
    await first.store.close();

    // ---- Process 2: only the directory crossed, so nothing in memory carried the pause.
    const second = await boot();
    expect(await second.store.read()).toBeNull();
    expect(second.fleet.snapshot().state).toBe("open");
    expect(second.fleet.exportState()).toEqual({ manualAll: false, manualProviders: [], automatic: [] });

    const manager = new AgentManager();
    // The session continued past the anchor before the restart; the restore branches back to it.
    const live = fakeSession({ entries: ["e1", "e2", "e3"], leafId: "e3", projection: { path: ["e1", "e2", "e3"] } });
    const command = movable(live);
    try {
      const result = await restoreCheckpoint({
        stateDir: dir,
        rootId: ROOT,
        fleet: second.fleet,
        session: command.session,
        id: written.id,
        adopt: children => manager.adoptTombstones(children),
      });

      expect(result.ok).toBe(true);
      expect(command.navigated).toEqual(["e2"]);

      // Holds are back, and they are exactly the ones the record described.
      expect(second.fleet.exportState()).toEqual(interrupted);
      expect(second.fleet.snapshot()).toMatchObject({ state: "paused", reason: "threshold", active: 0, inferences: 0, coding: 0 });
      expect(second.fleet.snapshot("commandcode")).toMatchObject({ state: "paused", automaticReason: "reserve", active: 0 });
      expect(second.fleet.snapshot("openai-codex")).toMatchObject({ manual: true, manualTarget: "openai-codex", active: 0 });

      // The interrupted child is a name again, not a running agent.
      expect(manager.resolveMention("explore")?.kind).toBe("tombstone");
      expect(manager.listAgents()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      await second.store.close();
    }
  });
});

describe("quota-guard restore — refusals", () => {
  it("refuses a corrupt checkpoint file", async () => {
    const id = await capturedCheckpoint();
    await writeFile(checkpointPath(dir, id), "this is not a checkpoint\n");
    await expectRefused({ id, session: movable(fakeSession()).session, message: /not JSON/ });
  });

  it("refuses a truncated checkpoint file", async () => {
    const id = await capturedCheckpoint();
    const text = await readFile(checkpointPath(dir, id), "utf8");
    await writeFile(checkpointPath(dir, id), text.slice(0, Math.floor(text.length / 2)));
    await expectRefused({ id, session: movable(fakeSession()).session, message: /not JSON/ });
  });

  it("refuses a digest-tampered checkpoint file", async () => {
    const id = await capturedCheckpoint();
    const path = checkpointPath(dir, id);
    const record = JSON.parse(await readFile(path, "utf8")) as { fleet: { manualAll: boolean } };
    expect(record.fleet.manualAll).toBe(false);
    record.fleet.manualAll = true;
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    await expectRefused({ id, session: movable(fakeSession()).session, message: /digest mismatch/ });
  });

  it("refuses a checkpoint recorded by another root", async () => {
    const id = await capturedCheckpoint();
    await expectRefused({
      id,
      session: movable(fakeSession()).session,
      rootId: "another-root",
      message: /root id does not match/,
    });
  });

  it("refuses a checkpoint from another session id", async () => {
    const id = await capturedCheckpoint();
    await expectRefused({
      id,
      session: movable(fakeSession({ id: "session-elsewhere" })).session,
      message: /belongs to another session/,
    });
  });

  it("refuses a checkpoint that points at another session file", async () => {
    const id = await capturedCheckpoint();
    await expectRefused({
      id,
      session: movable(fakeSession({ file: "/sessions/other.jsonl" })).session,
      message: /another session file/,
    });
  });

  it("refuses when the anchor is gone from the session", async () => {
    const id = await capturedCheckpoint();
    await expectRefused({
      id,
      session: movable(fakeSession({ entries: ["e1"], leafId: "e1" })).session,
      message: /anchor is no longer/,
    });
  });

  it("refuses a cancelled navigation", async () => {
    const id = await capturedCheckpoint();
    const command = movable(fakeSession({ entries: ["e1", "e2", "e3"], leafId: "e3" }), { cancelled: true });
    const result = await expectRefused({ id, session: command.session, message: /cancelled/ });
    expect(command.navigated).toEqual(["e2"]);
    expect(result.checkpoint).toBeUndefined();
  });

  it("refuses a session that landed at a different projection", async () => {
    const id = await capturedCheckpoint();
    const fleet = heldLatch();
    const command = movable(fakeSession({ entries: ["e1", "e2", "e3"], leafId: "e3" }), { landing: { path: ["e1"] } });
    await expectRefused({ id, session: command.session, fleet, message: /different projection/ });
    // A drifted landing is an identity failure rather than a plain refusal: the latch is re-paused for it.
    expect(fleet.snapshot().reason).toBe("identity");
  });
});

describe("quota-guard restore — idempotence", () => {
  it("a second restore of the same checkpoint is a second success with the same holds", async () => {
    const first = await boot();
    first.fleet.pause("reserve");
    first.fleet.pauseManual("all");
    const written = await capture(first.fleet, fakeSession(), [await childEntry()]);
    await first.store.close();

    const second = await boot();
    const manager = new AgentManager();
    const live = fakeSession({ entries: ["e1", "e2", "e3"], leafId: "e3", projection: { path: ["e1", "e2", "e3"] } });
    const command = movable(live);
    const outcomes: { adopted: number; skipped: number }[] = [];
    const adopt = (children: readonly AgentTombstone[]) => {
      const outcome = manager.adoptTombstones(children);
      outcomes.push(outcome);
      return outcome;
    };
    const attempt = () => restoreCheckpoint({
      stateDir: dir,
      rootId: ROOT,
      fleet: second.fleet,
      session: command.session,
      id: written.id,
      adopt,
    });

    try {
      const once = await attempt();
      expect(once.ok).toBe(true);
      const holds = second.fleet.exportState();

      // Pinned behaviour: the latch only ever closes, so reapplying an identical state is a second
      // SUCCESS, not a refusal. If that contract changes, this assertion must fail rather than the
      // suite quietly accepting either answer.
      const twice = await attempt();
      expect(twice.ok).toBe(true);
      expect(second.fleet.exportState()).toEqual(holds);
      expect(second.fleet.snapshot()).toMatchObject({ state: "paused", active: 0 });

      // The move is repeated, nothing new is written, and the second adoption only re-finds the name.
      expect(command.navigated).toEqual(["e2", "e2"]);
      expect(await listCheckpoints(dir)).toHaveLength(1);
      expect(outcomes).toEqual([
        { adopted: 1, skipped: 0 },
        { adopted: 0, skipped: 1 },
      ]);
      expect(manager.listTombstones().map(entry => entry.handle)).toEqual(["explore"]);
      expect(manager.listAgents()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      await second.store.close();
    }
  });
});

describe("quota-guard restore — zero egress", () => {
  it("makes no network call on capture, restore or adoption and creates no agent record", async () => {
    expect(globalThis.fetch).toBe(fetchSpy);

    const first = await boot();
    first.fleet.pause("unavailable");
    const written = await capture(first.fleet, fakeSession(), [await childEntry()]);
    await first.store.close();

    const second = await boot();
    const manager = new AgentManager();
    const live = fakeSession({ entries: ["e1", "e2", "e3"], leafId: "e3", projection: { path: ["e1", "e2", "e3"] } });
    const command = movable(live);
    try {
      const result = await restoreCheckpoint({
        stateDir: dir,
        rootId: ROOT,
        fleet: second.fleet,
        session: command.session,
        id: written.id,
        adopt: children => manager.adoptTombstones(children),
      });

      expect(result.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Adoption is a descriptor: nothing is spawned and no saved conversation is reopened.
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
      expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
      expect(manager.listAgents()).toEqual([]);
      expect(manager.listTombstones()).toHaveLength(1);
    } finally {
      manager.dispose();
      await second.store.close();
    }
  });
});
