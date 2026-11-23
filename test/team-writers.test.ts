/**
 * team-writers.test.ts — the team integration owner against real git repos
 * (no LLM). `dispatch` is a stub that commits on a real branch from the base SHA,
 * exactly what an isolated worktree run would leave behind.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globMatchesPath, globsOverlap, parseTeamManifest, runTeam, type TeamPlan, type TeamWriter, type WriterRun } from "../src/team-writers.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 20_000 }).toString().trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "team-repo-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "op@test.com");
  git(dir, "config", "user.name", "Operator");
  writeFile(dir, "README.md", "# repo\n");
  writeFile(dir, "src/api/a.txt", "a\n");
  writeFile(dir, "src/web/b.txt", "b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Stub dispatch: create a real branch off base with the given edits, return a finished run. */
function fakeWriter(repo: string, base: string, edits: Record<string, string>, status = "completed") {
  return async (w: TeamWriter): Promise<WriterRun> => {
    const branch = `pi-agent-${w.name}`;
    const wt = mkdtempSync(join(tmpdir(), `team-wt-${w.name}-`));
    rmSync(wt, { recursive: true, force: true });
    dirs.push(wt);
    git(repo, "worktree", "add", "-q", "-b", branch, wt, base);
    git(wt, "config", "user.email", `${w.name}@test.com`);
    git(wt, "config", "user.name", w.name);
    for (const [rel, content] of Object.entries(edits)) writeFile(wt, rel, content);
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", `${w.name} work`);
    git(repo, "worktree", "remove", "--force", wt);
    return { status, branch, baseSha: base };
  };
}

const gateOk = { gate: ["node", "-e", "process.exit(0)"] };

describe("parseTeamManifest overlap", () => {
  const mk = (a: string[], b: string[]) => JSON.stringify({
    gate: ["node", "--test"],
    writers: [
      { name: "a", agent: "implementer", prompt: "p", files: a },
      { name: "b", agent: "implementer", prompt: "p", files: b },
    ],
  });
  it("rejects exact-path overlap naming both claims", () => {
    expect(() => parseTeamManifest(mk(["src/api/x.ts"], ["src/api/x.ts"]))).toThrow(/overlapping claims.*"src\/api\/x.ts".*"src\/api\/x.ts"/);
  });
  it("rejects a glob overlapping a concrete path", () => {
    expect(() => parseTeamManifest(mk(["src/api/*.ts"], ["src/api/x.ts"]))).toThrow(/overlapping/);
  });
  it("rejects ** covering a nested path", () => {
    expect(() => parseTeamManifest(mk(["src/**"], ["src/api/deep/x.ts"]))).toThrow(/overlapping/);
  });
  it("accepts disjoint trees", () => {
    expect(parseTeamManifest(mk(["src/api/**"], ["src/web/**"])).writers).toHaveLength(2);
  });
  it("accepts sibling single-segment globs that cannot collide", () => {
    expect(globsOverlap("src/api/*.ts", "src/web/*.ts")).toBe(false);
    expect(globsOverlap("src/*.md", "src/*.ts")).toBe(false);
  });
  it("glob matcher: * stays in one segment, ** spans depth", () => {
    expect(globMatchesPath("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatchesPath("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(globMatchesPath("src/**", "src/a/b/c.ts")).toBe(true);
  });
  it("rejects non-repo-relative and bad team sizes", () => {
    expect(() => parseTeamManifest(mk(["/abs/x"], ["src/web/**"]))).toThrow(/repo-relative/);
    expect(() => parseTeamManifest(JSON.stringify({ gate: ["x"], writers: [{ name: "a", agent: "i", prompt: "p", files: ["a"] }] }))).toThrow(/2–6 writers/);
  });
});

describe("runTeam (real git)", () => {
  const plan = (files: [string[], string[]]): TeamPlan => ({
    gate: gateOk.gate,
    writers: [
      { name: "api", agent: "implementer", prompt: "p", files: files[0] },
      { name: "web", agent: "implementer", prompt: "p", files: files[1] },
    ],
  });

  it("(a) two disjoint writers integrate into one branch with both commits", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const opHead = git(repo, "rev-parse", "HEAD");
    const dispatch = async (w: TeamWriter) =>
      (await fakeWriter(repo, base, w.name === "api" ? { "src/api/new.txt": "x\n" } : { "src/web/new.txt": "y\n" })(w));
    const res = await runTeam({ cwd: repo, dispatch }, plan([["src/api/**"], ["src/web/**"]]));
    expect(res).toMatchObject({ ok: true, merged: ["api", "web"] });
    if (!res.ok) return;
    const log = git(repo, "log", "--format=%s", res.branch);
    expect(log).toContain("team(api)");
    expect(log).toContain("team(web)");
    expect(git(repo, "show", `${res.branch}:src/api/new.txt`)).toBe("x");
    expect(git(repo, "show", `${res.branch}:src/web/new.txt`)).toBe("y");
    expect(git(repo, "rev-parse", "HEAD")).toBe(opHead);
  });

  it("(b) unclaimed-file edit is refused and nothing is published", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const dispatch = async (w: TeamWriter) =>
      (await fakeWriter(repo, base, w.name === "api" ? { "src/api/ok.txt": "x\n", "README.md": "sneaky\n" } : { "src/web/ok.txt": "y\n" })(w));
    const res = await runTeam({ cwd: repo, dispatch }, plan([["src/api/**"], ["src/web/**"]]));
    expect(res).toMatchObject({ ok: false, reason: "unclaimed-change" });
    if (res.ok) return;
    expect(res.detail).toContain("README.md");
    expect(res.detail).toContain('"api"');
    expect(git(repo, "branch", "--list", "pi-team-*")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
  });

  it("(d) failing gate leaves operator checkout untouched and integration branch unmerged", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const dispatch = async (w: TeamWriter) =>
      (await fakeWriter(repo, base, w.name === "api" ? { "src/api/n.txt": "x\n" } : { "src/web/n.txt": "y\n" })(w));
    const res = await runTeam({ cwd: repo, dispatch }, { gate: ["node", "-e", "console.error('BOOM'); process.exit(3)"], writers: plan([["src/api/**"], ["src/web/**"]]).writers });
    expect(res).toMatchObject({ ok: false, reason: "gate-failed" });
    if (res.ok) return;
    expect(res.detail).toContain("BOOM");
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(git(repo, "status", "--porcelain")).toBe("");
    // Gate failure keeps the integration branch for inspection, but it is not
    // the operator's branch: main stays at base.
    expect(git(repo, "rev-parse", "main")).toBe(base);
  });

  it("refuses a writer whose status is not completed", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const dispatch = async (w: TeamWriter) =>
      (await fakeWriter(repo, base, { "src/api/n.txt": "x\n" }, w.name === "api" ? "error" : "completed")(w));
    const res = await runTeam({ cwd: repo, dispatch }, plan([["src/api/**"], ["src/web/**"]]));
    expect(res).toMatchObject({ ok: false, reason: "writer-not-done" });
  });
});
