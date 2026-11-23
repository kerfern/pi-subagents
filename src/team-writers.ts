/**
 * team-writers.ts — one integration owner for parallel writers.
 *
 * A manifest names 2–6 writers, each with glob file claims. Claims must not
 * overlap. Each writer runs in its own worktree (in parallel). Its diff is
 * checked against its claims, then its branch is squash-merged serially into a
 * fresh integration worktree at the shared base SHA, and the gate runs once
 * there. The operator's checkout is never written.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TeamWriter {
  name: string;
  agent: string;
  prompt: string;
  files: string[];
}

export interface TeamPlan {
  gate: string[];
  writers: TeamWriter[];
}

/** Outcome of one dispatched writer run (produced by the caller's dispatch). */
export interface WriterRun {
  status: string;
  branch?: string;
  baseSha?: string;
  worktreePath?: string;
  error?: string;
}

export type GitFn = (args: string[], cwd: string) => Promise<string>;

export interface TeamDeps {
  /** Repo root the team runs against (the operator's checkout; never written). */
  cwd: string;
  /** Run one writer in an isolated worktree; resolves when it has settled. */
  dispatch: (writer: TeamWriter) => Promise<WriterRun>;
  /** Run git in cwd; resolve trimmed stdout, reject on non-zero exit. */
  git?: GitFn;
  /** Run the gate argv in cwd. */
  exec?: (argv: string[], cwd: string) => Promise<{ code: number; output: string }>;
}

export type TeamResult =
  | { ok: true; branch: string; commit: string; merged: string[] }
  | { ok: false; reason: string; detail: string };

const MAX_WRITERS = 6;
const MIN_WRITERS = 2;

/* ---------------------------- manifest + claims --------------------------- */

/** Validate a manifest and return a TeamPlan. Throws Error with a precise message. */
export function parseTeamManifest(text: string): TeamPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`team manifest is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error("team manifest must be a JSON object");
  const gate = raw.gate;
  if (!Array.isArray(gate) || gate.length === 0 || !gate.every((g) => typeof g === "string" && g.length > 0)) {
    throw new Error("team manifest 'gate' must be a non-empty array of strings");
  }
  if (!Array.isArray(raw.writers)) throw new Error("team manifest 'writers' must be an array");
  const writers = raw.writers.map((w, i) => parseWriter(w, i));
  if (writers.length < MIN_WRITERS || writers.length > MAX_WRITERS) {
    throw new Error(`team needs ${MIN_WRITERS}–${MAX_WRITERS} writers, got ${writers.length}`);
  }
  const names = new Set<string>();
  for (const w of writers) {
    if (names.has(w.name)) throw new Error(`duplicate writer name "${w.name}"`);
    names.add(w.name);
  }
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]!;
      const b = writers[j]!;
      for (const ga of a.files) {
        for (const gb of b.files) {
          if (globsOverlap(ga, gb)) {
            throw new Error(
              `overlapping claims: writer "${a.name}" claims "${ga}" and writer "${b.name}" claims "${gb}"`,
            );
          }
        }
      }
    }
  }
  return { gate, writers };
}

function parseWriter(w: unknown, i: number): TeamWriter {
  if (!isRecord(w)) throw new Error(`writer #${i} must be an object`);
  const name = nonEmptyString(w.name, `writer #${i} 'name'`);
  const agent = nonEmptyString(w.agent, `writer "${name}" 'agent'`);
  const prompt = nonEmptyString(w.prompt, `writer "${name}" 'prompt'`);
  if (!Array.isArray(w.files) || w.files.length === 0) {
    throw new Error(`writer "${name}" 'files' must be a non-empty array`);
  }
  const files = w.files.map((f) => {
    const glob = nonEmptyString(f, `writer "${name}" file claim`);
    validateRepoGlob(glob, name);
    return glob;
  });
  return { name, agent, prompt, files };
}

function validateRepoGlob(glob: string, writer: string): void {
  if (glob.startsWith("/") || glob.startsWith("~") || /^[A-Za-z]:/.test(glob)) {
    throw new Error(`writer "${writer}" claim "${glob}" must be repo-relative`);
  }
  if (glob.includes("\\")) throw new Error(`writer "${writer}" claim "${glob}" must use POSIX '/'`);
  if (glob.split("/").some((seg) => seg === "..")) {
    throw new Error(`writer "${writer}" claim "${glob}" must not contain '..'`);
  }
}

/**
 * Does a claim glob match a concrete repo path? `*` matches within one segment;
 * `**` as a whole segment matches zero or more segments.
 */
export function globMatchesPath(glob: string, path: string): boolean {
  return segmentsMatch(glob.split("/"), 0, path.split("/"), 0);
}

function segmentsMatch(pat: string[], pi: number, segs: string[], si: number): boolean {
  if (pi === pat.length) return si === segs.length;
  const p = pat[pi]!;
  if (p === "**") {
    for (let k = si; k <= segs.length; k++) {
      if (segmentsMatch(pat, pi + 1, segs, k)) return true;
    }
    return false;
  }
  if (si === segs.length) return false;
  if (!segMatch(p, segs[si]!)) return false;
  return segmentsMatch(pat, pi + 1, segs, si + 1);
}

/** Match one segment pattern containing `*` wildcards (no `/`). */
function segMatch(pat: string, seg: string): boolean {
  const parts = pat.split("*");
  if (parts.length === 1) return pat === seg;
  const first = parts[0]!;
  if (!seg.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = seg.indexOf(parts[i]!, pos);
    if (idx < 0) return false;
    pos = idx + parts[i]!.length;
  }
  const last = parts[parts.length - 1]!;
  return seg.length - pos >= last.length && seg.endsWith(last);
}

/**
 * Do two claim globs possibly match a common path? Conservative: true whenever
 * a common path could exist (wildcards on either side are treated as covering).
 */
export function globsOverlap(a: string, b: string): boolean {
  return overlapSegs(a.split("/"), 0, b.split("/"), 0);
}

function overlapSegs(a: string[], ai: number, b: string[], bi: number): boolean {
  if (ai === a.length && bi === b.length) return true;
  if (ai < a.length && a[ai] === "**") {
    for (let k = bi; k <= b.length; k++) {
      if (overlapSegs(a, ai + 1, b, k)) return true;
    }
    return false;
  }
  if (bi < b.length && b[bi] === "**") {
    for (let k = ai; k <= a.length; k++) {
      if (overlapSegs(a, k, b, bi + 1)) return true;
    }
    return false;
  }
  if (ai === a.length || bi === b.length) return false;
  if (!segsCompatible(a[ai]!, b[bi]!)) return false;
  return overlapSegs(a, ai + 1, b, bi + 1);
}

/** Could one concrete segment satisfy both single-segment patterns? Conservative. */
function segsCompatible(x: string, y: string): boolean {
  if (!x.includes("*") && !y.includes("*")) return x === y;
  if (!x.includes("*")) return segMatch(y, x);
  if (!y.includes("*")) return segMatch(x, y);
  const xp = x.split("*")[0]!;
  const yp = y.split("*")[0]!;
  const xs = x.split("*").pop()!;
  const ys = y.split("*").pop()!;
  return (xp.startsWith(yp) || yp.startsWith(xp)) && (xs.endsWith(ys) || ys.endsWith(xs));
}

/* ------------------------------ run pipeline ------------------------------ */

/**
 * Dispatch every writer in parallel, verify each diff against its claims, then
 * squash-merge serially into a fresh integration worktree and gate once.
 */
export async function runTeam(deps: TeamDeps, plan: TeamPlan): Promise<TeamResult> {
  const git = deps.git ?? defaultGit;
  const exec = deps.exec ?? defaultExec;

  const runs = await Promise.all(plan.writers.map((w) => deps.dispatch(w).catch((err: unknown): WriterRun => ({
    status: "error",
    error: err instanceof Error ? err.message : String(err),
  }))));

  // Verify every settled writer before any merge.
  for (let i = 0; i < plan.writers.length; i++) {
    const writer = plan.writers[i]!;
    const run = runs[i]!;
    if (run.status !== "completed") {
      return fail("writer-not-done", `writer "${writer.name}" finished with status "${run.status}"${run.error ? `: ${run.error}` : ""}`);
    }
    if (!run.branch || !run.baseSha) {
      return fail("writer-no-changes", `writer "${writer.name}" changed nothing (no branch produced)`);
    }
    let changed: string[];
    try {
      changed = (await git(["diff", "--name-only", `${run.baseSha}..${run.branch}`], deps.cwd))
        .split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      return fail("diff-failed", `writer "${writer.name}": ${(err as Error).message}`);
    }
    if (changed.length === 0) {
      return fail("writer-no-changes", `writer "${writer.name}" changed nothing`);
    }
    const outside = changed.filter((p) => !writer.files.some((g) => globMatchesPath(g, p)));
    if (outside.length > 0) {
      return fail("unclaimed-change",
        `writer "${writer.name}" changed path(s) outside its claims: ${outside.join(", ")}`);
    }
  }

  const settled = plan.writers.map((writer, i) => ({ writer, run: runs[i]! }));
  const baseSha = settled[0]!.run.baseSha!;
  if (settled.some((s) => s.run.baseSha !== baseSha)) {
    return fail("base-mismatch", "writers were created from different base SHAs");
  }

  // Serial integration into a fresh worktree at the shared base SHA.
  const integBranch = `pi-team-${Date.now().toString(36)}`;
  const integDir = mkdtempSync(join(tmpdir(), "pi-team-"));
  rmSync(integDir, { recursive: true, force: true });
  try {
    await git(["worktree", "add", "-b", integBranch, integDir, baseSha], deps.cwd);
  } catch (err) {
    return fail("integration-setup", (err as Error).message);
  }

  const merged: string[] = [];
  try {
    for (const { writer, run } of settled) {
      try {
        await git(["merge", "--squash", run.branch!], integDir);
      } catch (err) {
        const conflicts = await listConflicts(git, integDir);
        await git(["merge", "--abort"], integDir).catch(() => undefined);
        await git(["reset", "--hard", "HEAD"], integDir).catch(() => undefined);
        await git(["clean", "-fd"], integDir).catch(() => undefined);
        return await abandon(git, deps.cwd, integDir, integBranch,
          fail("merge-conflict",
            `writer "${writer.name}" conflicts in ${conflicts.length ? conflicts.join(", ") : "(unknown paths)"}: ${(err as Error).message}`));
      }
      const author = await authorOf(git, deps.cwd, run.branch!);
      try {
        await git(["commit", "--no-verify", "-m", `team(${writer.name}): merge ${run.branch}`, "--author", author], integDir);
        merged.push(writer.name);
      } catch (err) {
        const status = await git(["status", "--porcelain"], integDir).catch(() => "x");
        if (status.trim() !== "") {
          return await abandon(git, deps.cwd, integDir, integBranch,
            fail("commit-failed", `writer "${writer.name}": ${(err as Error).message}`));
        }
        // Nothing staged (identical content): skip this writer, not a failure.
      }
    }

    const gateRes = await exec(plan.gate, integDir);
    if (gateRes.code !== 0) {
      const tail = gateRes.output.split("\n").slice(-30).join("\n");
      // Keep the integration branch for inspection; remove only a clean worktree.
      await removeCleanWorktree(git, deps.cwd, integDir);
      return fail("gate-failed", `gate exited ${gateRes.code}; tail:\n${tail}`);
    }

    const commit = await git(["rev-parse", "HEAD"], integDir);
    await removeCleanWorktree(git, deps.cwd, integDir);
    return { ok: true, branch: integBranch, commit, merged };
  } catch (err) {
    return await abandon(git, deps.cwd, integDir, integBranch,
      fail("integration-error", (err as Error).message));
  }
}

function fail(reason: string, detail: string): TeamResult {
  return { ok: false, reason, detail };
}

async function listConflicts(git: GitFn, dir: string): Promise<string[]> {
  try {
    return (await git(["diff", "--name-only", "--diff-filter=U"], dir)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function authorOf(git: GitFn, cwd: string, branch: string): Promise<string> {
  const out = await git(["log", "-1", "--format=%an <%ae>", branch], cwd).catch(() => "");
  return out.trim() || "pi-team <pi-team@localhost>";
}

/** Remove the integration worktree only if clean; never force-remove a dirty one. */
async function removeCleanWorktree(git: GitFn, cwd: string, dir: string): Promise<void> {
  const status = await git(["status", "--porcelain"], dir).catch(() => "unknown");
  if (status.trim() !== "") return;
  await git(["worktree", "remove", dir], cwd).catch(() => undefined);
}

/** Failure before publish: drop the integration branch this run created. */
async function abandon(git: GitFn, cwd: string, dir: string, branch: string, failure: TeamResult): Promise<TeamResult> {
  await removeCleanWorktree(git, cwd, dir);
  await git(["branch", "-D", branch], cwd).catch(() => undefined);
  return failure;
}

function defaultGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

function defaultExec(argv: string[], cwd: string): Promise<{ code: number; output: string }> {
  const [cmd, ...rest] = argv;
  return new Promise((resolve) => {
    execFile(cmd!, rest, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return v;
}
