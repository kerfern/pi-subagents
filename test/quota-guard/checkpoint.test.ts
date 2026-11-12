import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import type { AgentTombstone } from '../../src/types.ts';

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

const child = (overrides: Partial<AgentTombstone> = {}): AgentTombstone => ({
  handle: 'explore',
  id: 'agent-1',
  type: 'Explore',
  description: 'map the reader',
  sessionFile: '/tmp/child-1.jsonl',
  completedAt: 1_700_000_000_000,
  ...overrides,
});

test('children round-trip, and the digest covers them', async () => {
  const dir = await stateDir();
  const children = [
    child({ alias: 'auth-audit' }),
    child({ handle: 'plan-2', id: 'agent-2', type: 'Plan', description: 'sketch the change', sessionFile: '/tmp/child-2.jsonl' }),
  ];
  const checkpoint = createCheckpoint({ ...base(), children });
  await writeCheckpoint(dir, checkpoint);

  const read = await readCheckpoint(dir, checkpoint.id, { rootId: 'root-1', sessionId: 'session-1' });
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.checkpoint.children, children);
  assert.notEqual(checkpoint.digest, createCheckpoint(base()).digest, 'children are part of the digest');

  const edited = { ...checkpoint, children: [{ ...children[0], description: 'something else' }, children[1]] };
  await writeFile(checkpointPath(dir, checkpoint.id), JSON.stringify(edited));
  const editedRead = await readCheckpoint(dir, checkpoint.id);
  assert.equal(editedRead.ok, false);
  assert.match((editedRead as { reason: string }).reason, /digest mismatch/);
});

test('a lost-worktree child keeps that marker through the checkpoint round-trip', async () => {
  const dir = await stateDir();
  const children = [child({ worktreeLost: true })];
  const checkpoint = createCheckpoint({ ...base(), children });
  await writeCheckpoint(dir, checkpoint);

  const read = await readCheckpoint(dir, checkpoint.id, { rootId: 'root-1', sessionId: 'session-1' });
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.checkpoint.children, children);
  assert.equal(read.ok && read.checkpoint.children[0].worktreeLost, true);
});

test('a checkpoint written before children existed still validates, as having none', async () => {
  const dir = await stateDir();
  // The pre-children canonical form, rebuilt here by hand so this pins the format rather than
  // whatever `canonical()` now emits: same keys, same order, no `children` at all.
  const session = { id: 'session-1', file: '/tmp/session-1.jsonl', anchorId: 'entry-anchor', leafId: 'entry-leaf', entryCount: 12, projectionDigest: 'a'.repeat(64) };
  const fleet = { state: 'paused', legacyReason: null, manualAll: false, providers: [{ id: 'commandcode', manual: true, automaticReason: null }] };
  const lanes = ['commandcode:provider'];
  const lost = ['inflight-inference'];
  const oldCanonical = (id: string) => JSON.stringify({
    version: 1,
    id,
    rootId: 'root-1',
    createdAt: '2026-11-13T10:00:00.000Z',
    sdk: { piVersion: '1.5.0', sessionFormatVersion: 3 },
    session,
    fleet,
    lanes,
    lost,
  });
  const id = createHash('sha256').update(oldCanonical('')).digest('hex');
  const legacy = {
    version: 1,
    id,
    rootId: 'root-1',
    createdAt: '2026-11-13T10:00:00.000Z',
    sdk: { piVersion: '1.5.0', sessionFormatVersion: 3 },
    session,
    fleet: { state: 'paused', manualAll: false, providers: [{ id: 'commandcode', manual: true }] },
    lanes,
    lost,
    digest: createHash('sha256').update(oldCanonical(id)).digest('hex'),
  };

  const validated = validateCheckpoint(legacy, { rootId: 'root-1', sessionId: 'session-1' });
  assert.deepEqual(validated.children, []);
  assert.equal(validated.id, id);
  assert.equal(validated.digest, legacy.digest, 'the record keeps the digest it was written with');
  assert.equal(createCheckpoint(base()).id, id, 'the same content still derives the same id');

  await mkdir(checkpointDirectory(dir), { recursive: true });
  await writeFile(join(checkpointDirectory(dir), `${id}.json`), `${JSON.stringify(legacy, null, 2)}\n`);
  const read = await readCheckpoint(dir, id);
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.checkpoint.children, []);
});

test('a malformed child is refused rather than half-understood', () => {
  const checkpoint = createCheckpoint(base());
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: {} }), /children must be an array/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: [child({ sessionFile: 'relative.jsonl' })] }), /absolute path/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: [child({ type: 'not a type' })] }), /agent type name/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: [child({ handle: '' })] }), /handle must be a non-empty string/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: [child({ completedAt: -1 })] }), /completedAt/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: [child({ worktreeLost: 'yes' } as never)] }), /worktreeLost/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, children: [child(), child()] }), /duplicate child handle/);
  assert.throws(
    () => validateCheckpoint({ ...checkpoint, children: Array.from({ length: 17 }, (_, index) => child({ handle: `explore-${index}` })) }),
    /more than 16/,
  );
});
