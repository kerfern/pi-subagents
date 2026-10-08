/**
 * store.ts — durable file-backed store for a quota guard's pause/wake lifecycle.
 *
 * One manifest per original root, at `<directory>/manifest.json`. Every write
 * is atomic (unique temp in the same directory → fsync → rename → fsync dir),
 * mode-restricted (0700 dir, 0600 files), self-digested, and serialised through
 * a PID lock. Readers fail closed: a corrupt, truncated, foreign, symlinked or
 * digest-mismatched manifest resolves to `null`, never a guess.
 *
 * The manifest is deliberately non-sensitive: it holds pause state, the verified
 * scope quorum and opaque checkpoint digests — never credentials, key material
 * or raw quota responses. Unknown fields are stripped on write, so a stray
 * secret on the value object cannot reach disk.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PauseReason } from './controller.ts';

const VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const LOCK_NAME = '.lock';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 20;
const LOCK_MAX_RETRIES = 250;
/** A lock must be at least this old before it is judged stale and refused. */
const LOCK_STALE_MS = 10_000;

const STATES = new Set(['open', 'draining', 'paused', 'checking']);
const REASONS = new Set<PauseReason>(['threshold', 'reserve', 'unavailable', 'identity', 'manual']);

export interface Manifest {
  version: 1;
  rootId: string;
  generation: number;
  state: 'open' | 'draining' | 'paused' | 'checking';
  reason?: PauseReason;
  updatedAt: string;          // UTC ISO-8601
  wakeAt?: string;            // UTC ISO-8601
  backoffIndex: number;
  quorum: readonly string[];  // verified scope identities that must all be present
  checkpoints: readonly { id: string; digest: string; generation: number }[];
  digest: string;             // over every other field
}

/** Test-only seam: throws to simulate a crash at a durability boundary. */
export interface StoreFaults {
  beforeWrite?(): void | Promise<void>;
  beforeFileSync?(): void | Promise<void>;
  beforeRename?(): void | Promise<void>;
}

export interface QuotaStore {
  read(): Promise<Manifest | null>;
  write(value: Omit<Manifest, 'digest'>, expectedGeneration: number | null): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isUtcIso(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

/** Validate a quorum array: dense, non-empty, unique, non-empty identities. */
function checkQuorum(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('quorum must be a non-empty array');
  const out: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error('quorum must not be sparse');
    const identity = value[index];
    if (typeof identity !== 'string' || identity.length === 0) throw new Error('quorum identities must be non-empty strings');
    if (seen.has(identity)) throw new Error('quorum identities must be unique');
    seen.add(identity);
    out.push(identity);
  }
  return out;
}

/** Validate a checkpoints array: dense, non-empty, unique ids, sound entries. */
function checkCheckpoints(value: unknown): { id: string; digest: string; generation: number }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('checkpoints must be a non-empty array');
  const out: { id: string; digest: string; generation: number }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error('checkpoints must not be sparse');
    const entry = value[index];
    if (entry === null || typeof entry !== 'object') throw new Error('Malformed checkpoint');
    const { id, digest, generation } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) throw new Error('Checkpoint id must be a non-empty string');
    if (typeof digest !== 'string' || digest.length === 0) throw new Error('Checkpoint digest must be a non-empty string');
    if (!Number.isInteger(generation) || (generation as number) < 0) throw new Error('Checkpoint generation must be a non-negative integer');
    if (seen.has(id)) throw new Error('Checkpoint ids must be unique');
    seen.add(id);
    out.push({ id, digest, generation: generation as number });
  }
  return out;
}

/** Stable canonical form with fixed key order and `null` for absent optionals. */
function canonical(manifest: Omit<Manifest, 'digest'>): string {
  return JSON.stringify({
    version: manifest.version,
    rootId: manifest.rootId,
    generation: manifest.generation,
    state: manifest.state,
    reason: manifest.reason ?? null,
    updatedAt: manifest.updatedAt,
    wakeAt: manifest.wakeAt ?? null,
    backoffIndex: manifest.backoffIndex,
    quorum: [...manifest.quorum],
    checkpoints: manifest.checkpoints.map(c => ({ id: c.id, digest: c.digest, generation: c.generation })),
  });
}

function digestOf(manifest: Omit<Manifest, 'digest'>): string {
  return createHash('sha256').update(canonical(manifest)).digest('hex');
}

/** Validate a caller-provided value and rebuild it from known fields only. */
function normalize(value: Omit<Manifest, 'digest'>, rootId: string, expectedGeneration: number | null): Omit<Manifest, 'digest'> {
  const raw = value as unknown as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object') throw new Error('Manifest value required');
  const generation = expectedGeneration === null ? 1 : expectedGeneration + 1;
  if (raw.version !== VERSION) throw new Error('Unsupported manifest version');
  if (raw.rootId !== rootId) throw new Error('Manifest root id does not match the store root');
  if (raw.generation !== generation) throw new Error(`Manifest generation must be ${generation}`);
  if (!STATES.has(raw.state as string)) throw new Error('Unknown manifest state');
  if (raw.reason !== undefined && !REASONS.has(raw.reason as PauseReason)) throw new Error('Unknown pause reason');
  if (!isUtcIso(raw.updatedAt)) throw new Error('updatedAt must be a UTC ISO-8601 timestamp');
  if (raw.wakeAt !== undefined && !isUtcIso(raw.wakeAt)) throw new Error('wakeAt must be a UTC ISO-8601 timestamp');
  if (!Number.isInteger(raw.backoffIndex) || (raw.backoffIndex as number) < 0) throw new Error('backoffIndex must be a non-negative integer');
  const quorum = checkQuorum(raw.quorum);
  const checkpoints = checkCheckpoints(raw.checkpoints);
  return {
    version: VERSION,
    rootId,
    generation,
    state: raw.state as Manifest['state'],
    ...(raw.reason !== undefined ? { reason: raw.reason as PauseReason } : {}),
    updatedAt: raw.updatedAt,
    ...(raw.wakeAt !== undefined ? { wakeAt: raw.wakeAt } : {}),
    backoffIndex: raw.backoffIndex as number,
    quorum,
    checkpoints,
  };
}

/** Coerce parsed JSON into a manifest shape, or `null` if anything is off. */
function coerce(data: unknown, rootId: string): Omit<Manifest, 'digest'> | null {
  if (data === null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (raw.version !== VERSION || raw.rootId !== rootId) return null;
  if (!Number.isInteger(raw.generation) || (raw.generation as number) < 0) return null;
  if (!STATES.has(raw.state as string)) return null;
  if (raw.reason !== undefined && !REASONS.has(raw.reason as PauseReason)) return null;
  if (!isUtcIso(raw.updatedAt)) return null;
  if (raw.wakeAt !== undefined && !isUtcIso(raw.wakeAt)) return null;
  if (!Number.isInteger(raw.backoffIndex) || (raw.backoffIndex as number) < 0) return null;
  let quorum: string[];
  let checkpoints: { id: string; digest: string; generation: number }[];
  try {
    quorum = checkQuorum(raw.quorum);
    checkpoints = checkCheckpoints(raw.checkpoints);
  } catch {
    return null;
  }
  return {
    version: VERSION,
    rootId,
    generation: raw.generation as number,
    state: raw.state as Manifest['state'],
    ...(raw.reason !== undefined ? { reason: raw.reason as PauseReason } : {}),
    updatedAt: raw.updatedAt,
    ...(raw.wakeAt !== undefined ? { wakeAt: raw.wakeAt as string } : {}),
    backoffIndex: raw.backoffIndex as number,
    quorum,
    checkpoints,
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Re-fsync the parent of every ancestor on the path, from the store directory
 * up to the filesystem root. Idempotent and cheap (fsync of an already-synced
 * directory is harmless), and it recovers a crash that landed between creating
 * a directory and syncing its parent: without it, a later process would treat
 * the existing-but-unsynced ancestor as durable and could lose a committed
 * subtree. This is derived from durable state (the path), never from memory.
 */
async function syncAncestorEntries(directory: string): Promise<void> {
  let ancestor = dirname(resolve(directory));
  while (true) {
    await fsyncDirectory(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

/** Create or verify the store directory: 0700, never a symlink, ancestors synced. */
async function ensureDirectory(directory: string, enforceMode: boolean): Promise<void> {
  let info: Stats | null = null;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (info === null) {
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
    await chmod(directory, DIR_MODE);
  } else {
    if (info.isSymbolicLink()) throw new Error('Store directory must not be a symlink');
    if (!info.isDirectory()) throw new Error('Store path is not a directory');
    // Only openStore tightens an existing directory; a write must not fight a
    // deliberate read-only state back open.
    if (enforceMode) await chmod(directory, DIR_MODE);
  }
  await syncAncestorEntries(directory);
}

/** Read the manifest bytes, refusing symlinks and non-files; `null` on any error. */
async function readManifestFile(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Refuse a lock that is provably stale rather than reclaiming it. Stale means
 * both older than `staleMs` and no longer held; an old lock whose holder is
 * still alive is contention, not staleness, so the caller keeps waiting. The
 * returned error names the exact path, its age and the manual step that clears
 * it, so a human acts instead of the store mutating a file a peer may hold.
 */
async function staleLockRefusal(path: string, staleMs: number): Promise<Error | null> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    return null; // vanished under us; the caller re-contests the create
  }
  if (!info.isFile()) return null;
  const ageMs = Math.round(Date.now() - info.mtimeMs);
  if (ageMs < staleMs) return null;
  const pid = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
  if (Number.isInteger(pid) && processRunning(pid)) return null; // live holder: keep waiting
  const holder = Number.isInteger(pid) ? `holder pid ${pid}` : 'no readable holder pid';
  return new Error(
    `Stale quota store lock at ${path} (age ${ageMs}ms, ${holder}); refusing automatic reclaim. `
    + `If no writer is running, clear it manually: rm ${shellQuote(path)}`,
  );
}

/** POSIX single-quoting, so the printed recipe works for any path an operator might have. */
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

class FileQuotaStore implements QuotaStore {
  private readonly directory: string;
  private readonly rootId: string;
  private readonly manifestPath: string;
  private readonly lockPath: string;
  private readonly faults: StoreFaults;
  private closed = false;

  constructor(directory: string, rootId: string, faults: StoreFaults) {
    this.directory = resolve(directory);
    this.rootId = rootId;
    this.manifestPath = join(this.directory, MANIFEST_NAME);
    this.lockPath = join(this.directory, LOCK_NAME);
    this.faults = faults;
  }

  async init(): Promise<void> {
    await ensureDirectory(this.directory, true);
  }

  async read(): Promise<Manifest | null> {
    if (this.closed) throw new Error('Store is closed');
    const text = await readManifestFile(this.manifestPath);
    if (text === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    const coerced = coerce(parsed, this.rootId);
    if (coerced === null) return null;
    const digest = (parsed as Record<string, unknown>).digest;
    if (typeof digest !== 'string' || digestOf(coerced) !== digest) return null;
    return { ...coerced, digest };
  }

  /**
   * Distinguish "no manifest yet" (which authorises a null CAS) from "something
   * is present but unverifiable" (which must not be overwritten). Only a genuine
   * ENOENT counts as absent.
   */
  private async probe(): Promise<{ present: boolean; manifest: Manifest | null }> {
    let info: Stats;
    try {
      info = await lstat(this.manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, manifest: null };
      throw error;
    }
    if (!info.isFile()) return { present: true, manifest: null };
    return { present: true, manifest: await this.read() };
  }

  async write(value: Omit<Manifest, 'digest'>, expectedGeneration: number | null): Promise<void> {
    if (this.closed) throw new Error('Store is closed');
    const release = await this.acquireLock();
    let temp: string | undefined;
    try {
      const { present, manifest: current } = await this.probe();
      const actual = current === null ? null : current.generation;
      if (expectedGeneration === null) {
        if (present) throw new Error('Manifest already present; refusing to overwrite an unverifiable manifest');
      } else if (actual !== expectedGeneration) {
        throw new Error(`Generation mismatch: expected ${expectedGeneration}, found ${actual}`);
      }
      const next = normalize(value, this.rootId, expectedGeneration);
      const record: Manifest = { ...next, digest: digestOf(next) };
      temp = join(this.directory, `.${MANIFEST_NAME}.tmp-${process.pid}-${randomUUID()}`);
      await this.faults.beforeWrite?.();
      const handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      try {
        await handle.chmod(FILE_MODE);
        await handle.writeFile(JSON.stringify(record, null, 2));
        await this.faults.beforeFileSync?.();
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.faults.beforeRename?.();
      await rename(temp, this.manifestPath);
      temp = undefined;
      await fsyncDirectory(this.directory);
    } finally {
      if (temp !== undefined) await unlink(temp).catch(() => {});
      await release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Cross-process PID lock; serialises writers so generation checks stay atomic. */
  private async acquireLock(): Promise<() => Promise<void>> {
    await ensureDirectory(this.directory, false);
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        const handle = await open(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          FILE_MODE,
        );
        try {
          await handle.chmod(FILE_MODE);
          await handle.writeFile(String(process.pid));
        } finally {
          await handle.close();
        }
        return async () => { await unlink(this.lockPath).catch(() => {}); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A stale lock is never reclaimed: refuse and name the manual step.
        const refusal = await staleLockRefusal(this.lockPath, LOCK_STALE_MS);
        if (refusal !== null) throw refusal;
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error('Timed out acquiring quota store lock');
  }
}

export async function openStore(directory: string, rootId: string, faults: StoreFaults = {}): Promise<QuotaStore> {
  if (!directory) throw new Error('Store directory required');
  if (!rootId) throw new Error('Original root identity required');
  const store = new FileQuotaStore(directory, rootId, faults);
  await store.init();
  return store;
}
