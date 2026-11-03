/**
 * session-checkpoint.ts — bind the guard's durable state to a session position.
 *
 * Capture reads the position the SDK exposes (leaf id, entry count, projection) and writes a
 * checkpoint; it never appends to the transcript, because an extension context holds a read-only
 * manager. Restore moves the session to the recorded entry through the command context's
 * `navigateTree` and only then reapplies the fleet holds, so a restore that Pi cancels leaves the guard
 * exactly as held as it was.
 *
 * What this cannot do is unchanged and stated by the checkpoint itself: an interrupted inference, a
 * tool side effect already committed, or a subagent process is not resumed. Those appear in `lost`.
 */

import { createHash } from 'node:crypto';
import type { AgentTombstone } from '../types.ts';
import {
  type Checkpoint,
  type CheckpointFleet,
  createCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  readCheckpoint,
  writeCheckpoint,
} from './checkpoint.ts';
import type { FleetLatch, FleetStateExport, PauseReason } from './controller.ts';
import { hostIdentity } from './host-hook.ts';
import type { GuardedProvider } from './types.ts';

/** The read surface both an extension context and a command context provide. */
export interface SessionSource {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getEntryCount(): number;
  getHeader(): { version?: number } | null;
  getEntry(id: string): unknown;
  buildSessionProjection(): unknown;
}

/** A command-capable context: it reads the session and can move it. */
export interface NavigableSession {
  sessionManager: SessionSource;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}

/** Stable digest of the projected context: what a restore is supposed to land on. */
export function projectionDigest(projection: unknown): string {
  return createHash('sha256').update(JSON.stringify(projection ?? null)).digest('hex');
}

/** The host the harness bound at install time; `unknown` is stated rather than guessed. */
function piVersion(): string {
  return hostIdentity()?.version ?? 'unknown';
}

function fleetStateOf(fleet: FleetLatch): CheckpointFleet {
  const exported: FleetStateExport = fleet.exportState();
  const providers: CheckpointFleet['providers'] = (['openai-codex', 'commandcode'] as const).map((id) => {
    const automatic = exported.automatic.find(entry => entry.providerId === id)?.reason;
    return {
      id,
      manual: exported.manualAll || exported.manualProviders.includes(id),
      ...(automatic !== undefined ? { automaticReason: automatic } : {}),
    };
  });
  return {
    state: fleet.snapshot().state,
    ...(exported.legacyReason !== undefined ? { legacyReason: exported.legacyReason } : {}),
    manualAll: exported.manualAll,
    providers,
  };
}

/**
 * Capture and persist a checkpoint for the current position. Refuses when the session has no entry to
 * branch from (an empty session) or no file on disk - a checkpoint nothing could apply is not written.
 */
export async function captureCheckpoint(options: {
  stateDir: string;
  rootId: string;
  fleet: FleetLatch;
  session: SessionSource;
  lanes?: readonly string[];
  lost?: readonly string[];
  /** Children whose saved conversation should stay addressable after a restore. Handles only. */
  children?: readonly AgentTombstone[];
  now?: number;
}): Promise<{ id: string; digest: string }[]> {
  const { stateDir, rootId, fleet, session } = options;
  const leafId = session.getLeafId();
  const file = session.getSessionFile();
  if (leafId === null || leafId === undefined) throw new Error('Quota guard: the session has no entry to anchor a checkpoint');
  if (!file) throw new Error('Quota guard: the session is not persisted, so a checkpoint could not be applied');
  const header = session.getHeader();
  const checkpoint: Checkpoint = createCheckpoint({
    version: 1,
    rootId,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    sdk: { piVersion: piVersion(), sessionFormatVersion: header?.version ?? 0 },
    session: {
      id: session.getSessionId(),
      file,
      anchorId: leafId,
      leafId,
      entryCount: session.getEntryCount(),
      projectionDigest: projectionDigest(session.buildSessionProjection()),
    },
    fleet: fleetStateOf(fleet),
    lanes: options.lanes ?? [],
    lost: options.lost ?? ['inflight-inference', 'committed-tool-side-effects'],
    // Pass-through: capture stats nothing. A transcript that has since gone is the restoring manager's
    // decision to make, so capture stays free of a filesystem check it cannot own the meaning of.
    children: (options.children ?? []).filter(child => child.handle.length > 0 && child.sessionFile.length > 0),
  });
  const written = await writeCheckpoint(stateDir, checkpoint);
  return [{ id: written.id, digest: written.digest }];
}

export interface RestoreResult {
  ok: boolean;
  message: string;
  checkpoint?: Checkpoint;
}

/**
 * Reinstate the transcript position and the holds a checkpoint names. Order matters: navigate first,
 * then apply holds, then prove the projection landed. A cancelled navigation restores nothing.
 */
export async function restoreCheckpoint(options: {
  stateDir: string;
  rootId: string;
  fleet: FleetLatch;
  session: NavigableSession;
  id: string;
  /**
   * Hand the checkpoint's interrupted children to whoever can make them addressable again. Called once,
   * only after the position and the holds are back — a refused restore adopts nothing.
   */
  adopt?: (children: readonly AgentTombstone[]) => { adopted: number; skipped: number };
}): Promise<RestoreResult> {
  const { stateDir, rootId, fleet, session, id } = options;
  const view = session.sessionManager;
  const sessionId = view.getSessionId();
  const read = await readCheckpoint(stateDir, id, { rootId, sessionId });
  if (!read.ok) {
    return { ok: false, message: `Quota guard: checkpoint ${id.slice(0, 12)}… cannot be applied (${read.reason}).` };
  }
  const checkpoint = read.checkpoint;
  const file = view.getSessionFile();
  if (!file || checkpoint.session.file !== file) {
    return { ok: false, message: 'Quota guard: this checkpoint belongs to another session file; refusing to restore.' };
  }
  if (!view.getEntry(checkpoint.session.anchorId)) {
    return { ok: false, message: 'Quota guard: the checkpoint anchor is no longer in this session; refusing to guess a position.' };
  }
  if (fleet.snapshot().active !== 0) {
    return { ok: false, message: 'Quota guard: refusing to restore while work is admitted; pause first and retry when idle.' };
  }
  const navigation = await session.navigateTree(checkpoint.session.anchorId, { summarize: false });
  if (navigation.cancelled) {
    return { ok: false, message: 'Quota guard: navigation was cancelled; nothing was restored and the guard stays held.' };
  }
  const landed = projectionDigest(view.buildSessionProjection());
  if (landed !== checkpoint.session.projectionDigest) {
    fleet.pause('identity');
    return {
      ok: false,
      message: 'Quota guard: the session landed at a different projection than the checkpoint recorded; the guard stays held.',
    };
  }
  fleet.restoreState({
    ...(checkpoint.fleet.legacyReason !== undefined ? { legacyReason: checkpoint.fleet.legacyReason } : {}),
    manualAll: checkpoint.fleet.manualAll,
    manualProviders: checkpoint.fleet.providers
      .filter(provider => provider.manual && !checkpoint.fleet.manualAll)
      .map(provider => provider.id as GuardedProvider),
    automatic: checkpoint.fleet.providers
      .filter(provider => provider.automaticReason !== undefined)
      .map(provider => ({ providerId: provider.id as GuardedProvider, reason: provider.automaticReason as PauseReason })),
  });
  const adoption = options.adopt?.(checkpoint.children);
  const children = adoption && (adoption.adopted > 0 || adoption.skipped > 0)
    ? ` Children: ${adoption.adopted} addressable by @handle, ${adoption.skipped} skipped.`
    : '';
  const lost = checkpoint.lost.length ? ` Lost and not resumed: ${checkpoint.lost.join(', ')}.` : '';
  return {
    ok: true,
    message: `Quota guard: restored checkpoint ${id.slice(0, 12)}… (${checkpoint.session.entryCount} entries).${children}${lost}`,
    checkpoint,
  };
}

/** Checkpoints this root and session can apply, newest first. */
export async function restoreCandidates(stateDir: string): Promise<{ id: string; createdAt: string }[]> {
  return listCheckpoints(stateDir);
}

/** Bounded retention: a checkpoint per pause would otherwise accumulate without limit. */
export async function pruneRestorePoints(stateDir: string, keep = 20): Promise<string[]> {
  return pruneCheckpoints(stateDir, keep);
}
