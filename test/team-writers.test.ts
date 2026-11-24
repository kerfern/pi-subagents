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
    return { status, branch, baseSha: base, worktreePath: wt };
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
  it("refuses a writer that names the reviewer role", () => {
    const body = JSON.stringify({
      gate: ["node", "--test"],
      writers: [
        { name: "a", agent: "reviewer", prompt: "p", files: ["src/api/**"] },
        { name: "b", agent: "implementer", prompt: "p", files: ["src/web/**"] },
      ],
    });
    expect(() => parseTeamManifest(body)).toThrow(/may not use the reviewer role/);
  });
  it("rejects non-repo-relative and bad team sizes", () => {
    expect(() => parseTeamManifest(mk(["/abs/x"], ["src/web/**"]))).toThrow(/repo-relative/);
    expect(() => parseTeamManifest(JSON.stringify({ gate: ["x"], writers: [{ name: "a", agent: "i", prompt: "p", files: ["a"] }] }))).toThrow(/2–6 writers/);
  });
});

describe("runTeam cancellation", () => {
  it("passes the signal into the gate and reports an abort that lands mid-gate", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const plan = parseTeamManifest(JSON.stringify({
      gate: ["node", "--test"],
      writers: [
        { name: "a", agent: "implementer", prompt: "p", files: ["src/api/a.txt"] },
        { name: "b", agent: "implementer", prompt: "p", files: ["src/web/b.txt"] },
      ],
    }));
    const dispatch = (w: TeamWriter) => fakeWriter(repo, base, { [w.files[0]!]: `${w.name}-change\n` })(w);

    const controller = new AbortController();
    let gateSignal: AbortSignal | undefined;
    let sawAbort = false;
    let gateStarted!: () => void;
    const started = new Promise<void>((resolve) => { gateStarted = resolve; });
    const exec = async (_argv: string[], _cwd: string, opts?: { signal?: AbortSignal }) => {
      gateSignal = opts?.signal;
      gateStarted();
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) { sawAbort = true; resolve(); return; }
        const timer = setTimeout(resolve, 500);
        opts?.signal?.addEventListener("abort", () => { sawAbort = true; clearTimeout(timer); resolve(); }, { once: true });
      });
      return sawAbort ? { code: 143, output: "gate killed by abort" } : { code: 0, output: "gate passed without an abort" };
    };

    const running = runTeam({ cwd: repo, dispatch, exec, signal: controller.signal }, plan);
    await started;
    controller.abort();
    const result = await running;

    expect(gateSignal).toBe(controller.signal);
    expect(sawAbort, "the gate must receive the abort while it is running").toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("gate-failed");
    expect(result.detail).toContain("143");
    expect(git(repo, "branch", "--list", "pi-team-*").length).toBeGreaterThan(0);
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
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

describe("runTeam hardening (injected git)", () => {
  const twoWriters = (): TeamPlan => ({
    gate: ["gate"],
    writers: [
      { name: "api", agent: "implementer", prompt: "p", files: ["src/api/**"] },
      { name: "web", agent: "implementer", prompt: "p", files: ["src/web/**"] },
    ],
  });
  const okRun = (name: string, extra: Partial<WriterRun> = {}): WriterRun => ({
    status: "completed",
    branch: `pi-agent-${name}`,
    baseSha: "BASE",
    worktreePath: `/wt/${name}`,
    ...extra,
  });
  /** Fake git: records argv; diff returns per-branch NUL-joined paths; rev-parse resolves a branch. */
  function fakeGit(opts: { diff?: Record<string, string>; resolved?: Record<string, string> } = {}) {
    const calls: { args: string[]; cwd: string }[] = [];
    const git = async (args: string[], cwd: string): Promise<string> => {
      calls.push({ args, cwd });
      if (args[0] === "diff" && args.includes("--name-only") && !args.includes("--diff-filter=U")) {
        const range = args[args.length - 1]!;
        const branch = range.split("..")[1]!;
        return opts.diff?.[branch] ?? (branch === "pi-agent-web" ? "src/web/ok.ts" : "src/api/ok.ts");
      }
      if (args[0] === "rev-parse" && args[1]?.endsWith("^{commit}")) {
        const branch = args[1].replace("^{commit}", "");
        return opts.resolved?.[branch] ?? `SHA-${branch}`;
      }
      if (args[0] === "merge" && args[1] === "--squash") return "";
      if (args[0] === "rev-parse") return "HEAD-SHA";
      if (args[0] === "status") return "";
      if (args[0] === "log") return "Dev <d@x>";
      return "";
    };
    return { git, calls };
  }

  it("diff uses --no-renames -z and treats NUL-separated paths individually", async () => {
    const { git, calls } = fakeGit({ diff: { "pi-agent-api": "src/api/a.ts\0README.md" } });
    const res = await runTeam({ cwd: "/repo", dispatch: async (w) => okRun(w.name), git, exec: async () => ({ code: 0, output: "" }) }, twoWriters());
    const diffCall = calls.find((c) => c.args[0] === "diff" && c.args.includes("-z"))!;
    expect(diffCall.args).toEqual(["diff", "--name-only", "--no-renames", "-z", "BASE..pi-agent-api"]);
    expect(res).toMatchObject({ ok: false, reason: "unclaimed-change" });
    if (res.ok) return;
    expect(res.detail).toContain("README.md");
    expect(res.detail).not.toContain("src/api/a.ts\0");
  });

  it("merges the resolved commit sha, not the movable branch name", async () => {
    const { git, calls } = fakeGit({ resolved: { "pi-agent-api": "SHA-API", "pi-agent-web": "SHA-WEB" } });
    const res = await runTeam({
      cwd: "/repo",
      dispatch: async (w) => okRun(w.name, { ...(w.name === "web" ? { branch: "pi-agent-web" } : {}) }),
      git,
      exec: async () => ({ code: 0, output: "" }),
    }, { ...twoWriters(), writers: [
      { name: "api", agent: "implementer", prompt: "p", files: ["src/api/**"] },
      { name: "web", agent: "implementer", prompt: "p", files: ["src/web/**"] },
    ] });
    expect(res).toMatchObject({ ok: true, merged: ["api", "web"] });
    const merges = calls.filter((c) => c.args[0] === "merge" && c.args[1] === "--squash").map((c) => c.args[2]);
    expect(merges).toEqual(["SHA-API", "SHA-WEB"]);
    expect(calls.some((c) => c.args[0] === "merge" && c.args.includes("pi-agent-api"))).toBe(false);
    expect(calls.some((c) => c.args[0] === "rev-parse" && c.args[1] === "pi-agent-api^{commit}")).toBe(true);
  });

  it("ignores tool metadata in claims and keeps it out of the merge commit", async () => {
    const { git, calls } = fakeGit({ diff: { "pi-agent-api": ".serena/project.yml\0src/api/ok.ts" } });
    const res = await runTeam({
      cwd: "/repo",
      dispatch: async (w) => okRun(w.name),
      git,
      exec: async () => ({ code: 0, output: "" }),
    }, twoWriters());
    expect(res).toMatchObject({ ok: true });
    const reset = calls.find((c) => c.args[0] === "reset" && c.args.includes(".serena"));
    const clean = calls.find((c) => c.args[0] === "clean" && c.args.includes(".serena"));
    expect(reset?.args).toEqual(["reset", "--quiet", "HEAD", "--", ".serena"]);
    expect(clean?.args).toEqual(["clean", "-fdq", ".serena"]);
  });

  it("refuses a writer whose only change is tool metadata", async () => {
    const { git } = fakeGit({ diff: { "pi-agent-api": ".serena/project.yml", "pi-agent-web": "src/web/ok.ts" } });
    const res = await runTeam({
      cwd: "/repo",
      dispatch: async (w) => okRun(w.name),
      git,
      exec: async () => ({ code: 0, output: "" }),
    }, twoWriters());
    expect(res).toMatchObject({ ok: false, reason: "writer-no-changes" });
  });

  it("refuses a writer without a worktree before any merge", async () => {
    const { git, calls } = fakeGit();
    const res = await runTeam({
      cwd: "/repo",
      dispatch: async (w) => (w.name === "web" ? okRun(w.name, { worktreePath: undefined }) : okRun(w.name)),
      git,
      exec: async () => ({ code: 0, output: "" }),
    }, twoWriters());
    expect(res).toMatchObject({ ok: false, reason: "no-worktree" });
    if (res.ok) return;
    expect(res.detail).toContain('"web"');
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  it("aborted before dispatch: no dispatch, no git", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let dispatched = 0;
    const { git, calls } = fakeGit();
    const res = await runTeam({ cwd: "/repo", signal: ctrl.signal, dispatch: async (w) => { dispatched++; return okRun(w.name); }, git, exec: async () => ({ code: 0, output: "" }) }, twoWriters());
    expect(res).toEqual({ ok: false, reason: "aborted", detail: "team run aborted before dispatch" });
    expect(dispatched).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("aborted after writers settle: nothing merged and gate not run", async () => {
    const ctrl = new AbortController();
    const { git, calls } = fakeGit();
    let gateCalled = false;
    const res = await runTeam({
      cwd: "/repo",
      signal: ctrl.signal,
      dispatch: async (w) => { ctrl.abort(); return okRun(w.name); },
      git,
      exec: async () => { gateCalled = true; return { code: 0, output: "" }; },
    }, twoWriters());
    expect(res).toMatchObject({ ok: false, reason: "aborted" });
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
    expect(gateCalled).toBe(false);
  });

  it("aborted before the gate: gate not called, integration worktree removed", async () => {
    const ctrl = new AbortController();
    const { git, calls } = fakeGit();
    let gateCalled = false;
    const res = await runTeam({
      cwd: "/repo",
      signal: ctrl.signal,
      dispatch: async (w) => okRun(w.name),
      git: async (args, cwd) => {
        const out = await git(args, cwd);
        // Abort on the last writer's merge-commit so only the pre-gate check can fire.
        if (args[0] === "commit" && args.some((a) => a.startsWith("team(web)"))) ctrl.abort();
        return out;
      },
      exec: async () => { gateCalled = true; return { code: 0, output: "" }; },
    }, twoWriters());
    expect(res).toMatchObject({ ok: false, reason: "aborted", detail: "team run aborted before gate" });
    expect(gateCalled).toBe(false);
    expect(calls.some((c) => c.args[0] === "merge")).toBe(true);
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
  });

  it("passes the signal to the gate executor", async () => {
    const ctrl = new AbortController();
    const { git } = fakeGit();
    let seen: AbortSignal | undefined;
    await runTeam({
      cwd: "/repo",
      signal: ctrl.signal,
      dispatch: async (w) => okRun(w.name),
      git,
      exec: async (_argv, _cwd, opts) => { seen = opts?.signal; return { code: 0, output: "" }; },
    }, twoWriters());
    expect(seen).toBe(ctrl.signal);
  });
});
