/**
 * checkpoint.ts — durable, self-digested snapshots of guard state plus a session position.
 *
 * A checkpoint exists so a paused guard can be reinstated after a restart **without pretending an
 * interrupted call continued**. It records where the transcript was (an entry id to branch from), which
 * providers were held and why, and which scope lanes were verified; it records the effects that were
 * lost, so nothing downstream can mistake them for completed work.
 *
 * Files are `0700` directory / `0600` file, written atomically (unique temp → fsync → rename → fsync
 * dir), self-digested, and rebuilt from an allowlist on read. A corrupt, truncated, foreign,
 * version-mismatched or digest-mismatched file resolves to a reason, never to a guess.
 *
 * `children` records the interrupted children whose saved conversations an operator could still address
 * by `@handle`. That is retention of a name and a transcript path, never hydration: no session is
 * opened, nothing is spawned, and no completion is replayed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTombstone, SubagentType } from '../types.ts';
import type { PauseReason } from './controller.ts';
import type { GuardedProvider } from './types.ts';

export const CHECKPOINT_VERSION = 1;
const DIR_NAME = 'checkpoints';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_LOST = 16;
const MAX_LANES = 32;
const MAX_CHILDREN = 16;

const REASONS: ReadonlySet<PauseReason> = new Set(['threshold', 'reserve', 'unavailable', 'identity', 'manual']);
const PROVIDERS: ReadonlySet<string> = new Set(['openai-codex', 'commandcode']);
const STATES: ReadonlySet<string> = new Set(['open', 'draining', 'paused']);

export interface CheckpointSession {
  /** Session identity the anchor belongs to; a checkpoint from another session must not be applied. */
  id: string;
  /** Absolute path of the session file the anchor lives in. */
  file: string;
  /** Entry id to branch from. Nothing is truncated; a branch is a leaf-pointer move. */
  anchorId: string;
  /** Leaf at capture time, for diagnostics. */
  leafId: string | null;
  entryCount: number;
  /** Digest of the projected context at capture time, so a restore can prove it landed where it meant to. */
  projectionDigest: string;
}

export interface CheckpointFleet {
  state: 'open' | 'draining' | 'paused';
  legacyReason?: PauseReason;
  manualAll: boolean;
  providers: readonly { id: GuardedProvider; manual: boolean; automaticReason?: PauseReason }[];
}

export interface Checkpoint {
  version: 1;
  id: string;
  rootId: string;
  createdAt: string;
  sdk: { piVersion: string; sessionFormatVersion: number };
  session: CheckpointSession;
  fleet: CheckpointFleet;
  /** Verified scope lane identities that were live; a quorum is rebuilt from these, never invented. */
  lanes: readonly string[];
  /** Effects this checkpoint cannot reinstate, stated explicitly so recovery cannot overclaim. */
  lost: readonly string[];
  /**
   * Children whose conversation a restore makes enterable again by `@handle`. A handle and a transcript
   * path only: a restored child is not running, has no queue, and continues from a new prompt or not at
   * all. Absent in checkpoints written before children were recorded, which read as none.
   */
  children: readonly AgentTombstone[];
  digest: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isUtcIso(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

/**
 * A child's agent type. `SubagentType` is `string` — a user-defined agent is named at runtime, so there
 * is no union to enumerate — but a name no registry could have produced (spaces, separators, unbounded
 * length) is refused, so a hand-edited checkpoint cannot smuggle a path or a sentence into a handle.
 */
function agentType(value: unknown, field: string): SubagentType {
  const type = nonEmpty(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(type)) throw new Error(`${field} must be an agent type name`);
  return type;
}

/**
 * Rebuild the children list from known fields only. A missing list is legacy (nothing was recorded);
 * one that is present but malformed is an error, because a partially understood child cannot be
 * addressed safely.
 */
function childList(value: unknown): AgentTombstone[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('children must be an array');
  if (value.length > MAX_CHILDREN) throw new Error(`children has more than ${MAX_CHILDREN} entries`);
  const seen = new Set<string>();
  const out: AgentTombstone[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error('children must not be sparse');
    const child = value[index] as Record<string, unknown> | null;
    if (child === null || typeof child !== 'object') throw new Error(`children[${index}] must be an object`);
    const handle = nonEmpty(child.handle, `children[${index}].handle`);
    if (seen.has(handle)) throw new Error(`duplicate child handle ${handle}`);
    seen.add(handle);
    const sessionFile = nonEmpty(child.sessionFile, `children[${index}].sessionFile`);
    if (!sessionFile.startsWith('/')) throw new Error(`children[${index}].sessionFile must be an absolute path`);
    if (child.alias !== undefined) nonEmpty(child.alias, `children[${index}].alias`);
    if (!Number.isSafeInteger(child.completedAt) || (child.completedAt as number) < 0) {
      throw new Error(`children[${index}].completedAt must be a non-negative integer`);
    }
    out.push({
      handle,
      ...(child.alias !== undefined ? { alias: child.alias as string } : {}),
      id: nonEmpty(child.id, `children[${index}].id`),
      type: agentType(child.type, `children[${index}].type`),
      description: nonEmpty(child.description, `children[${index}].description`),
      sessionFile,
      completedAt: child.completedAt as number,
    });
  }
  return out;
}

function boundedList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > max) throw new Error(`${field} has more than ${max} entries`);
  const out: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error(`${field} must not be sparse`);
    out.push(nonEmpty(value[index], `${field}[${index}]`));
  }
  return out;
}

/** Canonical form: fixed key order, absent optionals as `null`, so a digest can be reproduced. */
function canonical(value: Omit<Checkpoint, 'digest'>): string {
  return JSON.stringify({
    version: value.version,
    id: value.id,
    rootId: value.rootId,
    createdAt: value.createdAt,
    sdk: { piVersion: value.sdk.piVersion, sessionFormatVersion: value.sdk.sessionFormatVersion },
    session: {
      id: value.session.id,
      file: value.session.file,
      anchorId: value.session.anchorId,
      leafId: value.session.leafId ?? null,
      entryCount: value.session.entryCount,
      projectionDigest: value.session.projectionDigest,
    },
    fleet: {
      state: value.fleet.state,
      legacyReason: value.fleet.legacyReason ?? null,
      manualAll: value.fleet.manualAll,
      providers: value.fleet.providers.map(provider => ({
        id: provider.id,
        manual: provider.manual,
        automaticReason: provider.automaticReason ?? null,
      })),
    },
    lanes: [...value.lanes],
    lost: [...value.lost],
    // Omitted when empty rather than written as `[]`, so a digest computed before children existed is
    // still the digest of the same record: an already stored checkpoint stays restorable across this change.
    ...(value.children.length === 0 ? {} : {
      children: value.children.map(child => ({
        handle: child.handle,
        alias: child.alias ?? null,
        id: child.id,
        type: child.type,
        description: child.description,
        sessionFile: child.sessionFile,
        completedAt: child.completedAt,
      })),
    }),
  });
}

/** Digest of everything except the digest itself. */
export function checkpointDigest(value: Omit<Checkpoint, 'digest'>): string {
  return sha256(canonical(value));
}

/**
 * Validate a value and rebuild it from known fields only. Throws with a specific reason; nothing here
 * repairs, defaults or tolerates a partial record.
 */
export function validateCheckpoint(value: unknown, expected?: { rootId?: string; sessionId?: string }): Checkpoint {
  if (value === null || typeof value !== 'object') throw new Error('checkpoint must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== CHECKPOINT_VERSION) throw new Error(`unsupported checkpoint version ${String(raw.version)}`);
  const rootId = nonEmpty(raw.rootId, 'rootId');
  if (expected?.rootId !== undefined && rootId !== expected.rootId) throw new Error('checkpoint root id does not match this root');
  if (!isUtcIso(raw.createdAt)) throw new Error('createdAt must be a UTC ISO-8601 timestamp');

  const sdk = raw.sdk as Record<string, unknown> | undefined;
  if (!sdk || typeof sdk !== 'object') throw new Error('sdk identity is required');
  const piVersion = nonEmpty(sdk.piVersion, 'sdk.piVersion');
  if (!Number.isInteger(sdk.sessionFormatVersion) || (sdk.sessionFormatVersion as number) < 0) {
    throw new Error('sdk.sessionFormatVersion must be a non-negative integer');
  }

  const session = raw.session as Record<string, unknown> | undefined;
  if (!session || typeof session !== 'object') throw new Error('session position is required');
  const sessionId = nonEmpty(session.id, 'session.id');
  if (expected?.sessionId !== undefined && sessionId !== expected.sessionId) throw new Error('checkpoint belongs to another session');
  const file = nonEmpty(session.file, 'session.file');
  if (!file.startsWith('/')) throw new Error('session.file must be an absolute path');
  const anchorId = nonEmpty(session.anchorId, 'session.anchorId');
  if (session.leafId !== null && (typeof session.leafId !== 'string' || session.leafId.length === 0)) {
    throw new Error('session.leafId must be null or a non-empty string');
  }
  if (!Number.isInteger(session.entryCount) || (session.entryCount as number) < 0) throw new Error('session.entryCount must be a non-negative integer');
  if (!isHex64(session.projectionDigest)) throw new Error('session.projectionDigest must be a sha256 hex digest');

  const fleet = raw.fleet as Record<string, unknown> | undefined;
  if (!fleet || typeof fleet !== 'object') throw new Error('fleet state is required');
  if (!STATES.has(fleet.state as string)) throw new Error(`unknown fleet state ${String(fleet.state)}`);
  if (fleet.legacyReason !== undefined && !REASONS.has(fleet.legacyReason as PauseReason)) throw new Error('unknown fleet reason');
  if (typeof fleet.manualAll !== 'boolean') throw new Error('fleet.manualAll must be a boolean');
  const providers = fleet.providers;
  if (!Array.isArray(providers)) throw new Error('fleet.providers must be an array');
  const seen = new Set<string>();
  const rebuiltProviders: { id: GuardedProvider; manual: boolean; automaticReason?: PauseReason }[] = [];
  for (let index = 0; index < providers.length; index++) {
    if (!Object.hasOwn(providers, index)) throw new Error('fleet.providers must not be sparse');
    const provider = providers[index] as Record<string, unknown> | null;
    if (provider === null || typeof provider !== 'object') throw new Error('fleet provider must be an object');
    const id = nonEmpty(provider.id, 'fleet.providers[].id');
    if (!PROVIDERS.has(id)) throw new Error(`unknown guarded provider ${id}`);
    if (seen.has(id)) throw new Error(`duplicate guarded provider ${id}`);
    seen.add(id);
    if (typeof provider.manual !== 'boolean') throw new Error('fleet.providers[].manual must be a boolean');
    if (provider.automaticReason !== undefined && !REASONS.has(provider.automaticReason as PauseReason)) {
      throw new Error('unknown automatic reason');
    }
    rebuiltProviders.push({
      id: id as GuardedProvider,
      manual: provider.manual,
      ...(provider.automaticReason !== undefined ? { automaticReason: provider.automaticReason as PauseReason } : {}),
    });
  }

  const base: Omit<Checkpoint, 'digest'> = {
    version: CHECKPOINT_VERSION,
    id: nonEmpty(raw.id, 'id'),
    rootId,
    createdAt: raw.createdAt,
    sdk: { piVersion, sessionFormatVersion: sdk.sessionFormatVersion as number },
    session: {
      id: sessionId,
      file,
      anchorId,
      leafId: session.leafId as string | null,
      entryCount: session.entryCount as number,
      projectionDigest: session.projectionDigest,
    },
    fleet: {
      state: fleet.state as CheckpointFleet['state'],
      ...(fleet.legacyReason !== undefined ? { legacyReason: fleet.legacyReason as PauseReason } : {}),
      manualAll: fleet.manualAll,
      providers: rebuiltProviders,
    },
    lanes: boundedList(raw.lanes, 'lanes', MAX_LANES),
    lost: boundedList(raw.lost, 'lost', MAX_LOST),
    children: childList(raw.children),
  };
  if (!isHex64(base.id)) throw new Error('id must be a sha256 hex digest');
  const digest = checkpointDigest(base);
  if (raw.digest !== digest) throw new Error('checkpoint digest mismatch');
  return { ...base, digest };
}

/**
 * Build a validated checkpoint. The id is derived from the content, so a caller cannot choose one that
 * collides with a different record; the digest then covers the id as well.
 */
export function createCheckpoint(
  value: Omit<Checkpoint, 'digest' | 'id' | 'children'> & { children?: readonly AgentTombstone[] },
): Checkpoint {
  const complete = { ...value, children: value.children ?? [] };
  const id = checkpointDigest({ ...complete, id: '' });
  const digest = checkpointDigest({ ...complete, id });
  return validateCheckpoint({ ...complete, id, digest });
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export function checkpointDirectory(stateDir: string): string {
  return join(stateDir, DIR_NAME);
}

export function checkpointPath(stateDir: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('checkpoint id must be a sha256 digest');
  return join(checkpointDirectory(stateDir), `${id}.json`);
}

/** Write atomically: the file a reader can see is always complete and digest-valid. */
export async function writeCheckpoint(stateDir: string, checkpoint: Checkpoint): Promise<{ id: string; digest: string }> {
  const validated = validateCheckpoint(checkpoint);
  const directory = checkpointDirectory(stateDir);
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  await chmod(directory, DIR_MODE);
  const target = checkpointPath(stateDir, validated.id);
  const temp = join(directory, `.${validated.id}.${randomUUID()}.tmp`);
  const text = `${JSON.stringify(validated, null, 2)}\n`;
  const handle = await open(temp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  await fsyncDirectory(directory);
  return { id: validated.id, digest: validated.digest };
}

export type CheckpointRead =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; reason: string };

/**
 * Read one checkpoint. A missing file and an invalid file are different answers: recovery must be able
 * to say "nothing was ever written" rather than "what was written cannot be trusted".
 */
export async function readCheckpoint(stateDir: string, id: string, expected?: { rootId?: string; sessionId?: string }): Promise<CheckpointRead> {
  let text: string;
  try {
    text = await readFile(checkpointPath(stateDir, id), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'absent' : `unreadable: ${code ?? 'unknown'}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  try {
    return { ok: true, checkpoint: validateCheckpoint(parsed, expected) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Newest first. Only digest-named files are considered; a temp or foreign file is not a checkpoint. */
export async function listCheckpoints(stateDir: string): Promise<{ id: string; createdAt: string }[]> {
  let names: string[];
  try {
    names = await readdir(checkpointDirectory(stateDir));
  } catch {
    return [];
  }
  const found: { id: string; createdAt: string }[] = [];
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    if (!match) continue;
    const read = await readCheckpoint(stateDir, match[1]);
    if (read.ok) found.push({ id: read.checkpoint.id, createdAt: read.checkpoint.createdAt });
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest `keep` checkpoints; returns what was removed. */
export async function pruneCheckpoints(stateDir: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer');
  const all = await listCheckpoints(stateDir);
  const removed: string[] = [];
  for (const stale of all.slice(keep)) {
    await unlink(checkpointPath(stateDir, stale.id)).catch(() => {});
    removed.push(stale.id);
  }
  return removed;
}
