/**
 * retention.test.ts — archiving must be boring and reversible.
 *
 * The dangerous half of retention is deletion. These tests pin the safer
 * contract: a dry run touches nothing, apply moves complete families only,
 * every archived byte is recorded in a manifest, and the archive never
 * overwrites an older archive of the same family.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRetention, manifestFor, planRetention } from "../scripts/retention.mjs";

const DAY = 86_400_000;

describe("session retention", () => {
  let root: string;
  let sessions: string;
  let archive: string;

  const family = (name: string, ageDays: number): string => {
    const dir = join(sessions, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_one.jsonl"), `{"family":"${name}"}\\n`);
    const when = new Date(Date.now() - ageDays * DAY);
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_one.jsonl"), when, when);
    utimesSync(dir, when, when);
    return dir;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "retention-"));
    sessions = join(root, "sessions");
    archive = join(root, "archive");
    mkdirSync(sessions, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("plans old families and leaves active ones alone", () => {
    family("old-team", 40);
    family("fresh-team", 2);
    const plan = planRetention({ sessionsDir: sessions, days: 30 });
    expect(plan.candidates.map((c) => c.family)).toEqual(["old-team"]);
    expect(plan.skipped).toEqual([{ family: "fresh-team", reason: "active" }]);
  });

  it("dry run changes nothing", () => {
    family("old-team", 40);
    planRetention({ sessionsDir: sessions, days: 30 });
    expect(readdirSync(sessions)).toEqual(["old-team"]);
  });

  it("archives a whole family with a verifiable manifest", () => {
    const dir = family("old-team", 40);
    const before = manifestFor(dir);
    const plan = planRetention({ sessionsDir: sessions, days: 30 });
    const moved = applyRetention({ candidates: plan.candidates, archiveDir: archive });

    expect(moved).toEqual([{ family: "old-team", bytes: before.totalBytes, files: 1 }]);
    expect(readdirSync(sessions)).toEqual([]);
    const archived = join(archive, "old-team");
    expect(readdirSync(archived).sort()).toEqual(["2026-01-01T00-00-00-000Z_one.jsonl", "manifest.json"]);
    const manifest = JSON.parse(readFileSync(join(archived, "manifest.json"), "utf8")) as {
      files: { name: string; size: number; sha256: string }[];
      totalBytes: number;
    };
    expect(manifest.files).toEqual(before.files);
    expect(manifest.totalBytes).toBe(before.totalBytes);
    expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to overwrite an earlier archive of the same family", () => {
    family("old-team", 40);
    const first = planRetention({ sessionsDir: sessions, days: 30 });
    applyRetention({ candidates: first.candidates, archiveDir: archive });

    family("old-team", 41);
    const second = planRetention({ sessionsDir: sessions, days: 30 });
    expect(() => applyRetention({ candidates: second.candidates, archiveDir: archive }))
      .toThrow(/archive already contains old-team/);
    // The second family must still be where it was, not half-moved.
    expect(readdirSync(sessions)).toEqual(["old-team"]);
  });

  it("treats a directory with no session files as skipped, not archived", () => {
    mkdirSync(join(sessions, "empty-family"), { recursive: true });
    const plan = planRetention({ sessionsDir: sessions, days: 30 });
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([{ family: "empty-family", reason: "no session files" }]);
  });
});
