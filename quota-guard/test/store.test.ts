import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openStore, type Manifest } from '../../src/quota-guard/store.ts';

const utc = () => new Date().toISOString();
const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type Value = Omit<Manifest, 'digest'>;

function value(generation: number, overrides: Partial<Value> = {}): Value {
  return {
    version: 1,
    rootId: 'root-a',
    generation,
    state: 'paused',
    reason: 'threshold',
    updatedAt: utc(),
    backoffIndex: 0,
    quorum: ['identity-a'],
    checkpoints: [{ id: 'cp-a', digest: 'deadbeef', generation: 1 }],
    ...overrides,
  };
}

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'quota-store-'));
}

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await sleepMs(5);
  assert.ok(predicate(), 'condition not reached in time');
}

/** Independent reimplementation of the documented canonical form. */
function canonicalOf(m: Record<string, unknown>): string {
  return JSON.stringify({
    version: m.version,
    rootId: m.rootId,
    generation: m.generation,
    state: m.state,
    reason: m.reason ?? null,
    updatedAt: m.updatedAt,
    wakeAt: m.wakeAt ?? null,
    backoffIndex: m.backoffIndex,
    quorum: m.quorum as string[],
    checkpoints: (m.checkpoints as Record<string, unknown>[]).map(c => ({ id: c.id, digest: c.digest, generation: c.generation })),
  });
}

const STORE_URL = pathToFileURL(join(import.meta.dirname, '../../src/quota-guard/store.ts')).href;

interface ChildRun { status: number | null; pid: number | undefined; stdout: string; stderr: string }

function runChild(dir: string, script: string): ChildRun {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
  return { status: run.status, pid: run.pid, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function runChildJson<T>(dir: string, script: string): { value: T; pid: number | undefined } {
  const run = runChild(dir, script);
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  return { value: JSON.parse(run.stdout) as T, pid: run.pid };
}

/** A rejected write must leave no manifest, no temp file and no lock behind. */
async function assertNoArtifacts(dir: string): Promise<void> {
  assert.deepEqual(await readdir(dir), [], 'a rejected write must not leave a manifest, temp or lock file');
  await assert.rejects(lstat(join(dir, 'manifest.json')));
}

/**
 * Child that records the exact paths fsynced. Patching the CJS `node:fs/promises`
 * exports before the store is imported lets the test observe real `fsync` calls
 * (a FileHandle's `sync`), not a computed plan.
 */
function fsyncSpyScript(dir: string, rootId: string): string {
  return `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const origOpen = fsp.open;
const synced = [];
fsp.open = async (target, ...rest) => {
  const handle = await origOpen(target, ...rest);
  const origSync = handle.sync.bind(handle);
  handle.sync = async () => { synced.push(String(target)); return origSync(); };
  return handle;
};
const { openStore } = await import(${JSON.stringify(STORE_URL)});
const store = await openStore(${JSON.stringify(dir)}, ${JSON.stringify(rootId)});
await store.write(${JSON.stringify(value(1))}, null);
process.stdout.write(JSON.stringify(synced));
`;
}

/** Child that crashes (throws) the moment an ancestor directory is opened for fsync. */
function crashBeforeAncestorSyncScript(dir: string, rootId: string, blocked: string[]): string {
  return `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const origOpen = fsp.open;
const blocked = new Set(${JSON.stringify(blocked)});
fsp.open = async (target, ...rest) => {
  if (blocked.has(String(target))) throw new Error('injected crash before ancestor fsync');
  return origOpen(target, ...rest);
};
const { openStore } = await import(${JSON.stringify(STORE_URL)});
try {
  await openStore(${JSON.stringify(dir)}, ${JSON.stringify(rootId)});
  process.stdout.write('unexpected-success');
} catch (error) {
  process.stdout.write('crashed:' + error.message);
}
`;
}

test('round-trips a manifest and reports a self-consistent digest', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  assert.equal(await store.read(), null);
  await store.write(value(1), null);
  const read = await store.read();
  assert.ok(read);
  assert.equal(read.generation, 1);
  assert.equal(read.state, 'paused');
  assert.equal(read.rootId, 'root-a');
  assert.equal(read.quorum[0], 'identity-a');
  assert.match(read.digest, /^[0-9a-f]{64}$/);
  await store.write(value(2, { state: 'checking', reason: undefined, wakeAt: utc() }), 1);
  const second = await store.read();
  assert.ok(second);
  assert.equal(second.generation, 2);
  assert.equal(second.reason, undefined);
  await store.close();
});

test('digest is independently reproducible over every other field', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const { digest, ...rest } = raw;
  const expected = createHash('sha256').update(canonicalOf(rest)).digest('hex');
  assert.equal(digest, expected);
  assert.equal((await store.read())?.digest, digest);
});

test('directory is 0700 and manifest is 0600', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(join(dir, 'manifest.json')), 0o600);
});

test('writes are atomic: no temp files survive a successful write', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  await store.write(value(2), 1);
  assert.deepEqual(await readdir(dir), ['manifest.json']);
});

test('generation mismatch rejects without writing', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const before = await readFile(join(dir, 'manifest.json'), 'utf8');
  await assert.rejects(store.write(value(9), 5));
  await assert.rejects(store.write(value(3), 1));
  await assert.rejects(store.write(value(2, { generation: 1 }), 1));
  assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), before);
  assert.equal((await store.read())?.generation, 1);
});

test('expectedGeneration null refuses to clobber an existing manifest', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  await assert.rejects(store.write(value(1), null));
  assert.equal((await store.read())?.generation, 1);
});

test('null compare-and-swap refuses to overwrite a corrupt manifest', async () => {
  const dir = await sandbox();
  const seed = await openStore(dir, 'root-a');
  await seed.write(value(1), null);
  const path = join(dir, 'manifest.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  parsed.generation = 42;
  await writeFile(path, JSON.stringify(parsed));
  const before = await readFile(path, 'utf8');
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1), null));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('null compare-and-swap refuses to overwrite a foreign-root manifest', async () => {
  const dir = await sandbox();
  const seed = await openStore(dir, 'root-a');
  await seed.write(value(1), null);
  const path = join(dir, 'manifest.json');
  const before = await readFile(path, 'utf8');
  const foreign = await openStore(dir, 'root-b');
  await assert.rejects(foreign.write(value(1, { rootId: 'root-b' }), null));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('null compare-and-swap refuses a symlinked manifest', async () => {
  const dir = await sandbox();
  const decoy = join(dir, 'decoy.json');
  await writeFile(decoy, '{"sentinel":true}');
  const path = join(dir, 'manifest.json');
  await symlink(decoy, path);
  const before = await readFile(decoy, 'utf8');
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1), null));
  assert.equal(await readFile(decoy, 'utf8'), before);
  assert.ok((await lstat(path)).isSymbolicLink());
});

test('null compare-and-swap refuses a non-regular manifest path', async () => {
  const dir = await sandbox();
  await mkdir(join(dir, 'manifest.json'));
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1), null));
  assert.ok((await lstat(join(dir, 'manifest.json'))).isDirectory());
});

test('sparse quorum or checkpoints arrays are refused', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  const sparseQuorum = Array(3) as string[];
  sparseQuorum[0] = 'a'; sparseQuorum[2] = 'c';
  await assert.rejects(store.write(value(1, { quorum: sparseQuorum }), null));
  const sparseCheckpoints = Array(2) as { id: string; digest: string; generation: number }[];
  sparseCheckpoints[0] = { id: 'a', digest: 'd', generation: 1 };
  await assert.rejects(store.write(value(1, { checkpoints: sparseCheckpoints }), null));
  assert.equal(await store.read(), null);
  await assertNoArtifacts(dir);
});

test('duplicate quorum identities and checkpoint ids are refused', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1, { quorum: ['a', 'a'] }), null));
  await assert.rejects(store.write(value(1, {
    checkpoints: [{ id: 'cp', digest: 'd', generation: 1 }, { id: 'cp', digest: 'e', generation: 2 }],
  }), null));
  assert.equal(await store.read(), null);
  await assertNoArtifacts(dir);
});

test('invalid checkpoint generation or empty digest is refused', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1, { checkpoints: [{ id: 'cp', digest: 'd', generation: 1.5 }] }), null));
  await assert.rejects(store.write(value(1, { checkpoints: [{ id: 'cp', digest: 'd', generation: -1 }] }), null));
  await assert.rejects(store.write(value(1, { checkpoints: [{ id: 'cp', digest: '', generation: 1 }] }), null));
  assert.equal(await store.read(), null);
  await assertNoArtifacts(dir);
});

test('corrupt digest is rejected', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const path = join(dir, 'manifest.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  parsed.generation = 99;
  await writeFile(path, JSON.stringify(parsed));
  assert.equal(await store.read(), null);
});

test('truncated or interrupted file is rejected', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const path = join(dir, 'manifest.json');
  const raw = await readFile(path, 'utf8');
  await writeFile(path, raw.slice(0, Math.floor(raw.length / 2)));
  assert.equal(await store.read(), null);
  await truncate(path, 0);
  assert.equal(await store.read(), null);
});

test('foreign root id is rejected', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const foreign = await openStore(dir, 'root-b');
  assert.equal(await foreign.read(), null);
});

test('unknown version is refused on write and read', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1, { version: 2 as unknown as 1 }), null));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 2, rootId: 'root-a', digest: 'x' }));
  assert.equal(await store.read(), null);
});

test('empty or malformed quorum and checkpoints are refused', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1, { quorum: [] }), null));
  await assert.rejects(store.write(value(1, { checkpoints: [] }), null));
  await assert.rejects(store.write(value(1, { quorum: [''] }), null));
  await assert.rejects(store.write(value(1, { quorum: 'x' as unknown as string[] }), null));
  await assert.rejects(store.write(value(1, { checkpoints: [{ id: '', digest: 'd', generation: 1 }] }), null));
  assert.equal(await store.read(), null);
});

test('foreign root id and unknown state are refused on write', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1, { rootId: 'other' }), null));
  await assert.rejects(store.write(value(1, { state: 'bogus' as unknown as 'open' }), null));
  await assert.rejects(store.write(value(1, { reason: 'nope' as unknown as 'manual' }), null));
  await assert.rejects(store.write(value(1, { updatedAt: 'not-a-date' }), null));
  assert.equal(await store.read(), null);
});

test('symlinked store directory is refused', async () => {
  const dir = await sandbox();
  const target = join(dir, 'real');
  await openStore(target, 'root-a');
  const link = join(dir, 'link');
  await symlink(target, link);
  await assert.rejects(openStore(link, 'root-a'));
});

test('symlinked manifest file is refused on read', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const decoy = join(dir, 'decoy.json');
  const path = join(dir, 'manifest.json');
  const current = await readFile(path, 'utf8');
  await writeFile(decoy, current);
  await rm(path);
  await symlink(decoy, path);
  assert.equal(await store.read(), null);
});

test('a sentinel secret in an unknown field never reaches disk', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  const secret = 'SENTINEL-SECRET-c0ffee-1234';
  const tainted = { ...value(1), apiKey: secret, credentials: { token: secret } } as unknown as Value;
  await store.write(tainted, null);
  const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
  assert.ok(!raw.includes(secret), 'sentinel must not be serialized');
  const read = await store.read();
  assert.ok(read);
  assert.ok(!JSON.stringify(read).includes(secret));
});

for (const hook of ['beforeWrite', 'beforeFileSync', 'beforeRename'] as const) {
  test(`fault at ${hook} leaves the previous manifest readable and unchanged`, async () => {
    const dir = await sandbox();
    const first = await openStore(dir, 'root-a');
    await first.write(value(1), null);
    const before = await first.read();
    const rawBefore = await readFile(join(dir, 'manifest.json'), 'utf8');

    const failing = await openStore(dir, 'root-a', { [hook]: () => { throw new Error(`boom:${hook}`); } });
    await assert.rejects(failing.write(value(2, { state: 'checking' }), 1), /boom/);

    assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), rawBefore);
    const after = await failing.read();
    assert.deepEqual(after, before);
    assert.deepEqual(await readdir(dir), ['manifest.json']);
  });
}

test('a temp file left by a crash is never promoted to manifest', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const before = await store.read();
  await writeFile(join(dir, '.manifest.json.tmp-9999-crashed'), JSON.stringify(value(42)));
  const after = await store.read();
  assert.deepEqual(after, before);
  assert.equal(after?.generation, 1);
});

test('read-only directory fails the write and leaves the previous manifest intact', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  const before = await store.read();
  await chmod(dir, 0o500);
  try {
    await assert.rejects(store.write(value(2), 1));
  } finally {
    await chmod(dir, 0o700);
  }
  assert.deepEqual(await store.read(), before);
});

test('two concurrent holders cannot interleave; exclusion holds while one is parked mid-write', async () => {
  const dir = await sandbox();
  const base = await openStore(dir, 'root-a');
  await base.write(value(1), null);
  let reached = false;
  let gateOpen: () => void = () => {};
  const gate = new Promise<void>(resolve => { gateOpen = resolve; });
  const held = await openStore(dir, 'root-a', { beforeRename: () => { reached = true; return gate; } });
  const other = await openStore(dir, 'root-a');

  const parked = held.write(value(2, { state: 'checking' }), 1);
  await waitFor(() => reached);
  const blocked = other.write(value(2, { reason: 'manual' }), 1);
  const settled = await Promise.race([blocked.then(() => 'settled', () => 'settled'), sleepMs(80).then(() => 'pending')]);
  assert.equal(settled, 'pending', 'second writer must be excluded while the first holds the lock');
  gateOpen();
  const results = await Promise.allSettled([parked, blocked]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal((await base.read())?.generation, 2);
});

test('close refuses further use', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  await store.close();
  await assert.rejects(store.read());
  await assert.rejects(store.write(value(2), 1));
});

test('importing the module is inert', async () => {
  const dir = await sandbox();
  const url = pathToFileURL(join(import.meta.dirname, '../../src/quota-guard/store.ts')).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await readdir(dir), []);
});

test('lock file is removed after write and fs constants are numeric', async () => {
  const dir = await sandbox();
  const store = await openStore(dir, 'root-a');
  await store.write(value(1), null);
  assert.ok(!(await readdir(dir)).includes('.lock'));
  assert.equal(typeof constants.O_EXCL, 'number');
});

test('opening an existing store issues a real fsync of every ancestor parent', async () => {
  const base = await sandbox();
  const deep = join(base, 'a', 'b', 'c');
  await mkdir(deep, { recursive: true }); // crash aftermath: chain exists, parents never synced
  const { value: synced } = runChildJson<string[]>(base, fsyncSpyScript(deep, 'root-a'));
  for (const ancestor of [base, join(base, 'a'), join(base, 'a', 'b')]) {
    assert.ok(synced.includes(ancestor), `expected a real fsync of ${ancestor}; saw ${JSON.stringify(synced)}`);
  }
});

test('a crash between directory creation and ancestor sync is recovered by the next open', async () => {
  const base = await sandbox();
  const deep = join(base, 'a', 'b', 'c');
  await mkdir(deep, { recursive: true });
  const crashed = runChild(base, crashBeforeAncestorSyncScript(deep, 'root-a', [join(base, 'a', 'b'), join(base, 'a'), base]));
  assert.match(crashed.stdout, /^crashed:/, crashed.stderr);
  assert.ok((await lstat(deep)).isDirectory());
  await assert.rejects(lstat(join(deep, 'manifest.json')));
  const store = await openStore(deep, 'root-a');
  await store.write(value(1), null);
  assert.equal((await store.read())?.generation, 1);
});

test('a fresh lock makes a second writer fail closed', async () => {
  const dir = await sandbox();
  const lock = join(dir, '.lock');
  // A live holder (our own pid) with a fresh lock: never stolen, never removed.
  await writeFile(lock, String(process.pid));
  const store = await openStore(dir, 'root-a');
  await assert.rejects(store.write(value(1), null), /Timed out acquiring quota store lock/);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid), 'the fresh lock must survive untouched');
  await assert.rejects(lstat(join(dir, 'manifest.json')));
});

test('a stale lock is refused with an actionable error and left in place', async () => {
  const dir = await sandbox();
  const lock = join(dir, '.lock');
  await writeFile(lock, '999999');
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  const store = await openStore(dir, 'root-a');
  const failure = await store.write(value(1), null).then(() => null, (error: Error) => error);
  assert.ok(failure, 'a stale lock must refuse the write, not reclaim it');
  assert.ok(failure.message.includes(lock), `error must name the exact lock path: ${failure.message}`);
  assert.match(failure.message, /age \d+ms/);
  assert.ok(failure.message.includes(`rm '${lock}'`), `error must name the manual step, shell-quoted: ${failure.message}`);
  assert.equal(await readFile(lock, 'utf8'), '999999', 'the stale lock must not be removed or rewritten');
  await assert.rejects(lstat(join(dir, 'manifest.json')));
  assert.deepEqual(await readdir(dir), ['.lock']);
});

test('concurrent writers all refuse a stale lock and never remove it', async () => {
  const dir = await sandbox();
  const lock = join(dir, '.lock');
  await writeFile(lock, '999999');
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  const stores = await Promise.all([0, 1, 2, 3].map(() => openStore(dir, 'root-a')));
  const results = await Promise.allSettled(stores.map(store => store.write(value(1), null)));
  assert.equal(results.filter(result => result.status === 'rejected').length, 4, 'every writer must fail closed');
  assert.equal(await readFile(lock, 'utf8'), '999999');
  await assert.rejects(lstat(join(dir, 'manifest.json')));
});

test('two writers racing for a free lock elect exactly one commit', async () => {
  const dir = await sandbox();
  const stores = await Promise.all([0, 1, 2, 3].map(() => openStore(dir, 'root-a')));
  const results = await Promise.allSettled(stores.map(store => store.write(value(1), null)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await (await openStore(dir, 'root-a')).read())?.generation, 1);
  assert.ok(!(await readdir(dir)).includes('.lock'), 'the elected holder must release the lock');
});

test('the manual step named in the stale-lock error clears it', async () => {
  const dir = await sandbox();
  const lock = join(dir, '.lock');
  await writeFile(lock, '999999');
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  const store = await openStore(dir, 'root-a');
  const failure = await store.write(value(1), null).then(() => null, (error: Error) => error);
  assert.ok(failure);
  // Run the printed recipe through a shell, so the test proves the command an operator is told to
  // paste actually works - including the quoting, which a path-only extraction could not check.
  const recipe = /clear it manually: (.*)$/m.exec(failure.message)?.[1];
  assert.ok(recipe, `error must name a manual command: ${failure.message}`);
  const cleared = spawnSync('sh', ['-c', recipe], { encoding: 'utf8' });
  assert.equal(cleared.status, 0, cleared.stderr);
  await assert.rejects(lstat(lock));
  await store.write(value(1), null);
  assert.equal((await store.read())?.generation, 1);
});
