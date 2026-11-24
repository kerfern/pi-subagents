/**
 * team-tool.test.ts — the model-callable `Team` adapter: it must refuse before
 * confirming anything unsafe, and dispatch nothing without an explicit approval.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, isWorktreeIsolationEnabled: vi.fn(() => true) };
});
vi.mock("../src/team-writers.js", async () => {
  const actual = await vi.importActual<typeof import("../src/team-writers.js")>("../src/team-writers.js");
  return { ...actual, runTeam: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { runTeam } from "../src/team-writers.js";
import { isWorktreeIsolationEnabled } from "../src/worktree.js";

function makePi() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools };
}

const manifest = JSON.stringify({
  gate: ["node", "--version"],
  writers: [
    { name: "a", agent: "worker", prompt: "do a", files: ["lib/a.mjs"] },
    { name: "b", agent: "worker", prompt: "do b", files: ["lib/b.mjs"] },
  ],
});

let dir = "";
let tools: Map<string, any>;

function boot(confirm: boolean, policy?: Record<string, unknown>) {
  dir = mkdtempSync(join(tmpdir(), "team-tool-"));
  writeFileSync(join(dir, "team.json"), manifest);
  if (policy) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi/subagents.json"), JSON.stringify({ teamPolicy: policy }));
  }
  // The extension loads persisted settings from the launch directory at boot.
  const previous = process.cwd();
  process.chdir(dir);
  const made = makePi();
  try {
    subagentsExtension(made.pi);
  } finally {
    process.chdir(previous);
  }
  tools = made.tools;
  return {
    hasUI: true,
    cwd: dir,
    ui: { confirm: vi.fn(async () => confirm), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

async function callTeam(ctx: any, manifestPath: string) {
  const tool = tools.get("Team");
  expect(tool).toBeDefined();
  return tool.execute("call-1", { manifestPath }, undefined, undefined, ctx);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("Team tool", () => {
  it("registers and refuses a path outside the project without confirming", async () => {
    const ctx = boot(true);
    const result = await callTeam(ctx, "../escape.json");
    expect(result.content[0].text).toMatch(/team refused: /);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(runTeam).not.toHaveBeenCalled();
  });

  it("refuses an invalid manifest before any approval prompt", async () => {
    const ctx = boot(true);
    writeFileSync(join(ctx.cwd, "bad.json"), JSON.stringify({ gate: [], writers: [] }));
    const result = await callTeam(ctx, "bad.json");
    expect(result.content[0].text).toMatch(/team refused: /);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the operator declines", async () => {
    const ctx = boot(false);
    const result = await callTeam(ctx, "team.json");
    expect(result.content[0].text).toMatch(/did not approve/);
    expect(runTeam).not.toHaveBeenCalled();
  });

  it("refuses when worktree isolation is off, before confirming", async () => {
    const ctx = boot(true);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);
    const result = await callTeam(ctx, "team.json");
    expect(result.content[0].text).toMatch(/worktree isolation is disabled/);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("runs the approved plan and reports branch, commit and merged writers", async () => {
    const ctx = boot(true);
    vi.mocked(runTeam).mockResolvedValue({ ok: true, branch: "team/x", commit: "abc123", merged: ["a", "b"] });
    const result = await callTeam(ctx, "team.json");
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("node --version");
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("lib/a.mjs");
    expect(runTeam).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("team ok: 2 writers");
    expect(result.content[0].text).toContain("team/x at abc123");
    expect(result.details).toMatchObject({ ok: true, commit: "abc123" });
  });

  it("skips the prompt when teamPolicy.autoApprove is declared", async () => {
    const ctx = boot(
      false,
      { autoApprove: true, retries: 1, retryBaseMs: 3000, warnTeamTokens: 2_000_000, warnTeamMs: 1_800_000, maxDispatchMs: 900_000 },
    );
    vi.mocked(runTeam).mockResolvedValue({ ok: true, branch: "team/y", commit: "def456", merged: ["a", "b"] });
    const result = await callTeam(ctx, "team.json");
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("auto-approved by teamPolicy"), "warning");
    expect(runTeam).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("team ok: 2 writers");
  });

  it("still refuses a bad manifest before an auto-approved dispatch", async () => {
    const ctx = boot(false, { autoApprove: true, retries: 1, retryBaseMs: 3000 });
    writeFileSync(join(ctx.cwd, "bad.json"), JSON.stringify({ gate: [], writers: [] }));
    const result = await callTeam(ctx, "bad.json");
    expect(result.content[0].text).toMatch(/team refused: /);
    expect(runTeam).not.toHaveBeenCalled();
  });

  it("surfaces a refusal reason and detail unchanged", async () => {
    const ctx = boot(true);
    vi.mocked(runTeam).mockResolvedValue({ ok: false, reason: "base-mismatch", detail: "writer a at deadbeef" });
    const result = await callTeam(ctx, "team.json");
    expect(result.content[0].text).toBe("team refused (base-mismatch): writer a at deadbeef");
    expect(result.details).toMatchObject({ ok: false, reason: "base-mismatch" });
  });
});
