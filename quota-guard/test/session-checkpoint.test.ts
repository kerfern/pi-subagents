import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { FleetLatch } from '../../src/quota-guard/controller.ts';
import { checkpointPath, listCheckpoints, readCheckpoint } from '../../src/quota-guard/checkpoint.ts';
import {
  captureCheckpoint,
  projectionDigest,
  restoreCandidates,
  restoreCheckpoint,
} from '../../src/quota-guard/session-checkpoint.ts';

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-session-checkpoint-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const FILE = '/tmp/pi-session.jsonl';

/** A session view whose projection is a plain object, so a digest can be recomputed. */
function session(overrides: Partial<{ leafId: string | null; file: string | undefined; projection: unknown; entries: string[] }> = {}) {
  const entries = overrides.entries ?? ['e1', 'e2'];
  let projection: unknown = overrides.projection ?? { path: ['e1', 'e2'] };
  return {
    getSessionId: () => 'session-1',
    getSessionFile: () => ('file' in overrides ? overrides.file : FILE),
    getLeafId: () => (overrides.leafId === undefined ? 'e2' : overrides.leafId),
    getEntryCount: () => entries.length,
    getHeader: () => ({ version: 3 }),
    getEntry: (id: string) => (entries.includes(id) ? { id } : undefined),
    buildSessionProjection: () => projection,
    setProjection: (next: unknown) => { projection = next; },
  };
}

test('capture records the live position, the holds and what stays lost', async () => {
  const dir = await stateDir();
  const fleet = new FleetLatch('root-1');
  fleet.pauseManual('commandcode');
  const s = session();

  const [written] = await captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet, session: s, lanes: ['commandcode:provider'] });
  assert.ok(written);

  const read = await readCheckpoint(dir, written.id, { rootId: 'root-1', sessionId: 'session-1' });
  assert.equal(read.ok, true);
  const checkpoint = read.ok && read.checkpoint;
  assert.ok(checkpoint);
  assert.equal(checkpoint.session.anchorId, 'e2');
  assert.equal(checkpoint.session.file, FILE);
  assert.equal(checkpoint.session.entryCount, 2);
  assert.equal(checkpoint.session.projectionDigest, projectionDigest(s.buildSessionProjection()));
  assert.equal(checkpoint.fleet.providers.find(p => p.id === 'commandcode')?.manual, true);
  assert.deepEqual(checkpoint.lanes, ['commandcode:provider']);
  assert.deepEqual([...checkpoint.lost].sort(), ['committed-tool-side-effects', 'inflight-inference']);
});

test('capture refuses a session with no anchor or no file instead of writing something unusable', async () => {
  const dir = await stateDir();
  const fleet = new FleetLatch('root-1');
  await assert.rejects(
    () => captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet, session: session({ leafId: null }) }),
    /no entry to anchor/,
  );
  await assert.rejects(
    () => captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet, session: session({ file: undefined }) }),
    /not persisted/,
  );
  assert.deepEqual(await listCheckpoints(dir), []);
});

test('restore moves the session, reapplies holds and proves the projection landed', async () => {
  const dir = await stateDir();
  const source = new FleetLatch('root-1');
  source.pause('threshold');
  source.pauseManual('openai-codex');
  const original = session();
  const [written] = await captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: source, session: original });

  const live = session({ projection: { path: ['e1', 'e2', 'later'] } });
  const navigated: string[] = [];
  const command = {
    sessionManager: live,
    async navigateTree(target: string) {
      navigated.push(target);
      live.setProjection({ path: ['e1', 'e2'] });
      return { cancelled: false };
    },
  };
  const restoredFleet = new FleetLatch('root-1');
  const result = await restoreCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: restoredFleet, session: command, id: written.id });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(navigated, ['e2']);
  assert.equal(restoredFleet.snapshot().reason, 'threshold');
  assert.equal(restoredFleet.snapshot('openai-codex').manualTarget, 'openai-codex');
  assert.match(result.message, /Lost and not resumed: /);
});

test('restore refuses a cancelled navigation, a wrong projection, another file and a missing anchor', async () => {
  const dir = await stateDir();
  const fleet = new FleetLatch('root-1');
  fleet.pause('threshold');
  const [written] = await captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet, session: session() });

  const cancelled = { sessionManager: session(), navigateTree: async () => ({ cancelled: true }) };
  const cancelledResult = await restoreCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: new FleetLatch('root-1'), session: cancelled, id: written.id });
  assert.equal(cancelledResult.ok, false);
  assert.match(cancelledResult.message, /cancelled/);

  const drifted = session({ projection: { path: ['elsewhere'] } });
  const wrongLanding = { sessionManager: drifted, navigateTree: async () => ({ cancelled: false }) };
  const landedFleet = new FleetLatch('root-1');
  const wrongResult = await restoreCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: landedFleet, session: wrongLanding, id: written.id });
  assert.equal(wrongResult.ok, false);
  assert.match(wrongResult.message, /different projection/);
  assert.equal(landedFleet.snapshot().reason, 'identity', 'a failed landing leaves the guard held, not open');

  const movedFile = { sessionManager: session({ file: '/tmp/other.jsonl' }), navigateTree: async () => ({ cancelled: false }) };
  assert.match((await restoreCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: new FleetLatch('root-1'), session: movedFile, id: written.id })).message, /another session file/);

  const missingAnchor = { sessionManager: session({ entries: ['e1'] }), navigateTree: async () => ({ cancelled: false }) };
  assert.match((await restoreCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: new FleetLatch('root-1'), session: missingAnchor, id: written.id })).message, /anchor is no longer/);

  const unknown = await restoreCheckpoint({ stateDir: dir, rootId: 'root-1', fleet: new FleetLatch('root-1'), session: cancelled, id: 'f'.repeat(64) });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /absent/);
});

test('candidates are listed newest-first for the operator', async () => {
  const dir = await stateDir();
  const fleet = new FleetLatch('root-1');
  const first = await captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet, session: session(), now: Date.parse('2026-11-13T09:00:00Z') });
  const second = await captureCheckpoint({ stateDir: dir, rootId: 'root-1', fleet, session: session(), now: Date.parse('2026-11-13T10:00:00Z') });
  const listed = await restoreCandidates(dir);
  assert.deepEqual(listed.map(entry => entry.id), [second[0].id, first[0].id]);
  assert.equal((await readCheckpoint(dir, first[0].id)).ok, true);
});
