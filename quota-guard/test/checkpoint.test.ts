import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  CHECKPOINT_VERSION,
  checkpointDirectory,
  checkpointPath,
  createCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  readCheckpoint,
  validateCheckpoint,
  writeCheckpoint,
} from '../../src/quota-guard/checkpoint.ts';

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-checkpoint-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const base = (overrides: Partial<Parameters<typeof createCheckpoint>[0]> = {}) => ({
  version: CHECKPOINT_VERSION as 1,
  rootId: 'root-1',
  createdAt: '2026-11-13T10:00:00.000Z',
  sdk: { piVersion: '1.5.0', sessionFormatVersion: 3 },
  session: {
    id: 'session-1',
    file: '/tmp/session-1.jsonl',
    anchorId: 'entry-anchor',
    leafId: 'entry-leaf',
    entryCount: 12,
    projectionDigest: 'a'.repeat(64),
  },
  fleet: { state: 'paused' as const, reason: undefined, manualAll: false, providers: [{ id: 'commandcode' as const, manual: true }] },
  lanes: ['commandcode:provider'],
  lost: ['inflight-inference'],
  ...overrides,
});

test('a written checkpoint round-trips and is self-digested', async () => {
  const dir = await stateDir();
  const checkpoint = createCheckpoint(base());
  assert.equal(checkpoint.id.length, 64);
  assert.notEqual(checkpoint.digest, checkpoint.id, 'the digest covers the id as well as the content');
  assert.equal(createCheckpoint(base()).id, checkpoint.id, 'the id is derived from the content, not chosen');
  await writeCheckpoint(dir, checkpoint);

  const read = await readCheckpoint(dir, checkpoint.id, { rootId: 'root-1', sessionId: 'session-1' });
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.checkpoint, checkpoint);
});

test('files are private and the directory is owner-only', async () => {
  const dir = await stateDir();
  const checkpoint = createCheckpoint(base());
  await writeCheckpoint(dir, checkpoint);
  assert.equal((await stat(checkpointDirectory(dir))).mode & 0o777, 0o700);
  assert.equal((await stat(checkpointPath(dir, checkpoint.id))).mode & 0o777, 0o600);
});

test('only allowlisted fields reach disk, so a stray secret cannot be persisted', async () => {
  const dir = await stateDir();
  const checkpoint = createCheckpoint(base());
  const tainted = { ...checkpoint, credential: 'sk-live-secret', sdk: { ...checkpoint.sdk, apiKey: 'sk-live-secret' } };
  await writeCheckpoint(dir, tainted as typeof checkpoint);
  const text = await readFile(checkpointPath(dir, checkpoint.id), 'utf8');
  assert.equal(text.includes('sk-live-secret'), false);
});

test('a corrupt, truncated, foreign or tampered file is a reason, never a guess', async () => {
  const dir = await stateDir();
  const checkpoint = createCheckpoint(base());
  await writeCheckpoint(dir, checkpoint);

  await writeFile(checkpointPath(dir, checkpoint.id), '{"version":1');
  assert.deepEqual(await readCheckpoint(dir, checkpoint.id), { ok: false, reason: 'not JSON' });

  const tampered = { ...checkpoint, lanes: ['commandcode:other'] };
  await writeFile(checkpointPath(dir, checkpoint.id), JSON.stringify(tampered));
  const tamperedRead = await readCheckpoint(dir, checkpoint.id);
  assert.equal(tamperedRead.ok, false);
  assert.match((tamperedRead as { reason: string }).reason, /digest mismatch/);

  assert.deepEqual(await readCheckpoint(dir, 'f'.repeat(64)), { ok: false, reason: 'absent' });
});

test('validation refuses another root, another session, a foreign version and a bad position', () => {
  const checkpoint = createCheckpoint(base());
  assert.throws(() => validateCheckpoint(checkpoint, { rootId: 'root-2' }), /root id does not match/);
  assert.throws(() => validateCheckpoint(checkpoint, { sessionId: 'session-2' }), /another session/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, version: 2 }), /unsupported checkpoint version/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, session: { ...checkpoint.session, file: 'relative.jsonl' } }), /absolute path/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, session: { ...checkpoint.session, anchorId: '' } }), /anchorId/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, fleet: { ...checkpoint.fleet, providers: [{ id: 'other', manual: false }] } }), /unknown guarded provider/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, lost: Array.from({ length: 17 }, (_, i) => `lost-${i}`) }), /more than 16/);
});

test('listing is newest-first and ignores temp or foreign files', async () => {
  const dir = await stateDir();
  const older = createCheckpoint(base({ createdAt: '2026-11-13T09:00:00.000Z' }));
  const newer = createCheckpoint(base({ createdAt: '2026-11-13T11:00:00.000Z' }));
  await writeCheckpoint(dir, older);
  await writeCheckpoint(dir, newer);
  await writeFile(join(checkpointDirectory(dir), 'notes.txt'), 'ignore me');

  const listed = await listCheckpoints(dir);
  assert.deepEqual(listed.map(entry => entry.id), [newer.id, older.id]);

  assert.deepEqual(await pruneCheckpoints(dir, 1), [older.id]);
  assert.deepEqual((await readdir(checkpointDirectory(dir))).sort(), [`${newer.id}.json`, 'notes.txt']);
});
