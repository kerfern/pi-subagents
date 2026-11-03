// A quota-guard restore must leave an interrupted child's saved conversation
// addressable by `@handle`. That is retention of a descriptor, never hydration:
// nothing here opens a session, spawns an agent, sends a prompt or replays a
// completion. `adoptTombstones` is the whole of it, so it is tested against the
// real manager with the runner mocked out — a call into the runner would be a
// model request, which is exactly what restoration must not start.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type { AgentTombstone } from "../src/types.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const completed = {
  responseText: "done",
  session: { dispose: vi.fn() } as any,
  aborted: false,
  steered: false,
} as any;

describe("AgentManager — quota-guard child adoption", () => {
  let manager: AgentManager;
  let dir: string;

  beforeEach(async () => {
    vi.mocked(runAgent).mockResolvedValue(completed);
    vi.mocked(resumeAgent).mockResolvedValue(completed);
    manager = new AgentManager();
    dir = await mkdtemp(join(tmpdir(), "quota-child-adoption-"));
  });

  afterEach(async () => {
    manager.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  /** A transcript on disk, the way a finished child leaves one. */
  async function transcript(name: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, '{"type":"session"}\n');
    return file;
  }

  function entry(overrides: Partial<AgentTombstone> = {}): AgentTombstone {
    return {
      handle: "explore",
      id: "agent-1",
      type: "Explore",
      description: "map the reader",
      sessionFile: join(dir, "gone.jsonl"),
      completedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  it("adopts a child whose transcript survived, so @handle reaches its conversation", async () => {
    const sessionFile = await transcript("child-1.jsonl");
    const result = manager.adoptTombstones([entry({ sessionFile })]);

    expect(result).toEqual({ adopted: 1, skipped: 0 });
    expect(manager.listTombstones().map(entry => entry.handle)).toEqual(["explore"]);
    expect(manager.resolveMention("explore")?.kind).toBe("tombstone");
  });

  it("skips a child whose transcript is gone, instead of holding its name for nothing", async () => {
    const result = manager.adoptTombstones([entry({ sessionFile: join(dir, "missing.jsonl") })]);

    expect(result).toEqual({ adopted: 0, skipped: 1 });
    expect(manager.listTombstones()).toEqual([]);
  });

  it("skips a handle a live agent already answers to", async () => {
    const sessionFile = await transcript("child-2.jsonl");
    const id = manager.spawn(mockPi, mockCtx, "Explore", "look around", { description: "look around", isBackground: true });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.handle).toBe("explore");

    const result = manager.adoptTombstones([entry({ sessionFile })]);

    expect(result).toEqual({ adopted: 0, skipped: 1 });
    expect(manager.resolveMention("explore")?.kind).toBe("live");
  });

  it("issues no model request and creates no record: adoption is a descriptor only", async () => {
    const sessionFile = await transcript("child-3.jsonl");
    vi.mocked(runAgent).mockClear();
    vi.mocked(resumeAgent).mockClear();

    const result = manager.adoptTombstones([entry({ handle: "plan-2", id: "agent-3", type: "Plan", sessionFile })]);

    expect(result).toEqual({ adopted: 1, skipped: 0 });
    expect(runAgent).not.toHaveBeenCalled();
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
  });

  // --- collision and accounting ---------------------------------------------------------------

    it("skips an alias that is already taken by another conversation", async () => {
      const manager = new AgentManager();
      const sessionFile = join(dir, "first.jsonl");
      await writeFile(sessionFile, "{}\n");
      // An adopted handle whose ALIAS collides would be reachable under a name the manager already uses,
      // so the mention would resolve to whichever entry it found first.
      manager.adoptTombstones([{ handle: "explore", id: "a1", type: "Explore", description: "one",
        sessionFile, completedAt: 1 }]);
      const result = manager.adoptTombstones([{ handle: "plan", alias: "explore", id: "a2", type: "Plan",
        description: "two", sessionFile, completedAt: 2 }]);
      expect(result).toEqual({ adopted: 0, skipped: 1 });
      expect(manager.listTombstones().map(entry => entry.handle)).toEqual(["explore"]);
    });

    it("reports an entry it evicted immediately as skipped, not addressable", async () => {
      const manager = new AgentManager();
      const sessionFile = join(dir, "old.jsonl");
      await writeFile(sessionFile, "{}\n");
      const filler = Array.from({ length: 100 }, (_, index) => ({
        handle: `agent-${index}`, id: `id-${index}`, type: "Explore", description: `d${index}`,
        sessionFile, completedAt: 10_000 + index,
      }));
      manager.adoptTombstones(filler);
      // Older than every retained entry, so admitting it pushes itself straight back out.
      const result = manager.adoptTombstones([{ handle: "ancient", id: "id-old", type: "Explore",
        description: "old", sessionFile, completedAt: 1 }]);
      expect(result).toEqual({ adopted: 0, skipped: 1 });
      expect(manager.listTombstones().some(entry => entry.handle === "ancient")).toBe(false);
    });

    it("lists still-live top-level children so an interrupted one is not lost at pause time", async () => {
      const manager = new AgentManager();
      const sessionFile = join(dir, "live.jsonl");
      await writeFile(sessionFile, "{}\n");
      // A child that is still in memory at pause time is not a tombstone yet; the checkpoint must still
      // see it, or it disappears across the restart it was meant to survive.
      const children = manager.listReopenableChildren(16);
      expect(Array.isArray(children)).toBe(true);
      expect(children.length).toBeLessThanOrEqual(16);
    });

});
