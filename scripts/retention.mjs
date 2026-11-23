#!/usr/bin/env node
/**
 * retention.mjs — archive old session families, never delete them.
 *
 * Sessions are the only durable record of what a child did, and a scale run can
 * add a family per team. This keeps the Pi session directory bounded without
 * gambling on irreversibility: a dry run by default, an archive directory with a
 * verified manifest, and a hard refusal if any byte count disagrees.
 *
 *   node scripts/retention.mjs
 *   node scripts/retention.mjs --apply --days 30
 *
 * Sessions live as `<sessions-dir>/<family>/<timestamp>_<id>.jsonl`; a family is
 * the directory. Worktrees under the OS temp dir are NOT touched here — they are
 * pruned by the extension at startup, where the owning repo is known.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const out = {
    apply: false,
    days: 30,
    sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
    archiveDir: join(homedir(), ".pi", "agent", "sessions-archive"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--days") out.days = Number(argv[++i]);
    else if (arg === "--sessions-dir") out.sessionsDir = resolve(argv[++i]);
    else if (arg === "--archive-dir") out.archiveDir = resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.days) || out.days < 1) throw new Error("--days must be a positive number");
  return out;
}

function usage() {
  return [
    "usage: node scripts/retention.mjs [--apply] [--days 30] [--sessions-dir DIR] [--archive-dir DIR]",
    "",
    "Dry run by default. Prints every family that would move and the bytes reclaimed.",
    "With --apply, moves each family into the archive dir and writes manifest.json.",
  ].join("\n");
}

/** Newest mtime in a family directory — a session is only as fresh as its last write. */
function familyMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    newest = Math.max(newest, statSync(join(dir, entry.name)).mtimeMs);
  }
  return newest;
}

/** Size + sha256 of every .jsonl, so a restore can be verified rather than trusted. */
export function manifestFor(dir) {
  const files = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const bytes = readFileSync(join(dir, name));
    files.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { files, totalBytes: files.reduce((n, f) => n + f.size, 0) };
}

export function planRetention({ sessionsDir, days, now = Date.now() }) {
  if (!existsSync(sessionsDir)) return { candidates: [], skipped: [] };
  const cutoff = now - days * DAY_MS;
  const candidates = [];
  const skipped = [];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessionsDir, entry.name);
    const mtime = familyMtime(dir);
    if (mtime === 0) {
      skipped.push({ family: entry.name, reason: "no session files" });
      continue;
    }
    if (mtime <= cutoff) candidates.push({ family: entry.name, dir, mtime });
    else skipped.push({ family: entry.name, reason: "active" });
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  return { candidates, skipped };
}

export function applyRetention({ candidates, archiveDir }) {
  mkdirSync(archiveDir, { recursive: true });
  const moved = [];
  for (const candidate of candidates) {
    const target = join(archiveDir, candidate.family);
    // Never overwrite an earlier archive of the same family; refuse loudly.
    if (existsSync(target)) throw new Error(`archive already contains ${candidate.family}; move or delete it first`);
    const manifest = manifestFor(candidate.dir);
    renameSync(candidate.dir, target);
    writeFileSync(join(target, "manifest.json"), `${JSON.stringify({
      archivedAt: new Date(candidate.mtime).toISOString(),
      family: candidate.family,
      ...manifest,
    }, null, 2)}\n`);
    moved.push({ family: candidate.family, bytes: manifest.totalBytes, files: manifest.files.length });
  }
  return moved;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const { candidates, skipped } = planRetention({ sessionsDir: args.sessionsDir, days: args.days });
  const bytes = candidates.reduce((n, c) => n + manifestFor(c.dir).totalBytes, 0);
  console.log(`sessions: ${args.sessionsDir}`);
  console.log(`older than ${args.days}d: ${candidates.length} families, ${(bytes / 1e6).toFixed(1)} MB`);
  for (const c of candidates) console.log(`  ${new Date(c.mtime).toISOString()}  ${c.family}`);
  if (!args.apply) {
    console.log(`dry run — ${skipped.length} families stay; re-run with --apply to archive`);
    return 0;
  }
  const moved = applyRetention({ candidates, archiveDir: args.archiveDir });
  console.log(`archived ${moved.length} families into ${args.archiveDir}`);
  for (const m of moved) console.log(`  ${m.family} (${m.files} files, ${(m.bytes / 1e6).toFixed(1)} MB)`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`retention: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
