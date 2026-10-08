/**
 * wake.ts — the single-runner checkpoint/wake machine for one original-root quota pause.
 *
 * Exactly one runner may be in flight: a concurrent `resume()`, a timer firing and a reload all
 * funnel through the `#running` latch, and only one timer is ever armed at a time. Every armed timer
 * is fenced by the token it was created with, so a late fire from a cancelled timer is a no-op and
 * cannot clobber its replacement. Every armed timer and every reopen is preceded by a durable
 * `write()` carrying the generation it was based on, so a wake never publishes a state it has not
 * recorded, a wait deadline survives a reload, and a stale writer is rejected by the store. A wake
 * reopens only on a fresh, quorum-complete, reserve-complete, in-policy paused-mode assessment with
 * an unchanged fleet generation - elapsed time alone never reopens anything. The manifest stays
 * non-sensitive: it is only the fields already defined by `store.ts`.
 */

import { QuotaError } from './adapters.ts';
import type { FleetLatch, PauseReason } from './controller.ts';
import { assess } from './policy.ts';
import type { Manifest, QuotaStore } from './store.ts';
import type { Assessment, Policy, QuotaSnapshot } from './types.ts';

/** Successive unavailable backoff: 30s, 60s, 120s, then hold at 300s. */
const BACKOFF_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000, 300_000]);

export interface WakeCheck {
  snapshot: QuotaSnapshot;
  reserve: ReadonlyMap<string, number | null>;
}

export interface WakeDeps {
  fleet: FleetLatch;
  store: QuotaStore;
  policy: Policy;
  now: () => number;
  /** Fresh, generation-bound read of every tracked scope; null means the quorum is incomplete. */
  check: (generation: number) => Promise<WakeCheck | null>;
  /** Generation-bound checkpoint of pending effects, persisted before the wake arms. */
  checkpoint: (generation: number) => Promise<readonly { id: string; digest: string }[]>;
  /** Injectable scheduling so tests never wait on wall-clock time. */
  schedule: (delayMs: number, run: () => void) => { cancel: () => void };
  onError?: (error: unknown) => void;
}

type Checkpoint = { id: string; digest: string };

function backoffDelay(index: number): number {
  const clamped = Math.min(Math.max(Math.trunc(index) || 0, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[clamped] as number;
}

/** Verified scope identity the durable quorum is written in; mirrors the coordinator's lane key. */
function scopeIdentity(snapshot: QuotaSnapshot): string | null {
  const { providerId, scope, accountId } = snapshot;
  if (providerId !== 'openai-codex' && providerId !== 'commandcode') return null;
  if (scope === 'provider') return accountId === undefined ? `${providerId}:provider` : null;
  if (scope === 'account') return accountId ? `${providerId}:${accountId}` : null;
  return null;
}

/**
 * A single snapshot vouches for exactly one scope identity, so a complete quorum demands that every
 * configured scope is that identity. A larger quorum cannot be confirmed from one read and stays
 * closed (the callback is contractually required to resolve `null` when it cannot read them all).
 */
function quorumComplete(quorum: readonly string[], identity: string | null): boolean {
  return identity !== null && quorum.length > 0 && quorum.every((scope) => scope === identity);
}


/** The durable paused record: a wait deadline (backoff/reset/retryAt) plus the checkpoint digests. */
function pauseRecord(
  manifest: Manifest,
  checkpoints: readonly Checkpoint[],
  reason: PauseReason | undefined,
  delayMs: number,
  now: number,
): Omit<Manifest, 'digest'> {
  const pauseReason = reason ?? manifest.reason;
  const index = Math.min(Math.max(Math.trunc(manifest.backoffIndex) || 0, 0), BACKOFF_MS.length - 1);
  return {
    version: 1,
    rootId: manifest.rootId,
    generation: manifest.generation + 1,
    state: 'paused',
    ...(pauseReason === undefined ? {} : { reason: pauseReason }),
    updatedAt: new Date(now).toISOString(),
    wakeAt: new Date(now + Math.max(0, delayMs)).toISOString(),
    backoffIndex: Math.min(index + 1, BACKOFF_MS.length - 1),
    quorum: manifest.quorum,
    checkpoints: checkpoints.map((checkpoint) => ({
      id: checkpoint.id, digest: checkpoint.digest, generation: manifest.generation,
    })),
  };
}

export class RootWake {
  private readonly deps: WakeDeps;
  private manifest: Manifest | null = null;
  private running = false;
  private disposed = false;
  private timer: { cancel: () => void } | null = null;
  private timerToken = 0;
  private pendingWithdrawal: { checkpoints: readonly Checkpoint[]; reason?: PauseReason } | null = null;

  constructor(deps: WakeDeps) {
    if (!deps || typeof deps.check !== 'function' || typeof deps.checkpoint !== 'function'
      || typeof deps.schedule !== 'function' || typeof deps.now !== 'function') {
      throw new Error('RootWake requires check, checkpoint, schedule and now');
    }
    this.deps = deps;
  }

  /** Loads the manifest, reinstates a persisted pause and arms exactly one timer (or catches up). */
  async start(): Promise<void> {
    if (this.disposed) return;
    this.#cancelTimer();
    const manifest = await this.deps.store.read();
    this.manifest = manifest;
    if (!manifest || manifest.state === 'open') return;
    this.deps.fleet.restorePaused(manifest.generation, manifest.reason ?? 'unavailable');
    const now = this.deps.now();
    const wakeAt = manifest.wakeAt === undefined ? undefined : Date.parse(manifest.wakeAt);
    if (wakeAt !== undefined && wakeAt <= now) {
      await this.resume();
      return;
    }
    this.#arm(wakeAt === undefined ? backoffDelay(manifest.backoffIndex) : Math.max(0, wakeAt - now));
  }

  /** One runner: drain, checkpoint, fresh check, then reopen or re-arm. Refuses a parallel run. */
  async resume(): Promise<boolean> {
    if (this.disposed || this.running) return false;
    this.running = true;
    try {
      return await this.#run();
    } finally {
      this.running = false;
    }
  }

  status(): Readonly<Manifest> | null {
    return this.manifest;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.#cancelTimer();
  }

  async #run(): Promise<boolean> {
    this.#cancelTimer();
    // A withdrawal that could not be committed is retried before anything else: the durable record
    // still claims the root is open while the latch is paused, so bailing on an 'open' manifest here
    // (as a plain re-arm would) is exactly the stranding this avoids.
    if (this.pendingWithdrawal) return await this.#commitWithdrawal();
    const loaded = this.manifest ?? (await this.deps.store.read());
    this.manifest = loaded;
    if (!loaded || loaded.state === 'open') return false;
    const generation = loaded.generation;
    await this.#drain();
    if (this.disposed) return false;
    const checkpoints = await this.deps.checkpoint(generation);
    // Bound to the fleet generation the check is authorised against: a pause landing under the check
    // makes the approval stale, so the generation is re-read and must be unchanged before reopening.
    const fleetGeneration = this.deps.fleet.snapshot().generation;

    let check: WakeCheck | null;
    try {
      check = await this.deps.check(generation);
    } catch (error) {
      return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex), error);
    }
    if (check === null) {
      return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex));
    }
    if (!quorumComplete(loaded.quorum, scopeIdentity(check.snapshot))) {
      return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex));
    }

    let assessment: Assessment;
    try {
      assessment = assess(check.snapshot, this.deps.policy, 'paused', check.reserve, this.deps.now());
    } catch (error) {
      return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex), error);
    }
    if (assessment.state !== 'open') {
      if (assessment.reason === 'reset-settling' && assessment.nextCheckAt !== undefined) {
        const deadline = Date.parse(assessment.nextCheckAt);
        const delay = Number.isFinite(deadline)
          ? Math.max(0, deadline - this.deps.now())
          : backoffDelay(loaded.backoffIndex);
        return await this.#wait(loaded, checkpoints, delay);
      }
      if (assessment.reason === 'unavailable') {
        return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex));
      }
      return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex));
    }

    // Only a latch still paused at the generation the check was authorised against may reopen.
    const snapshot = this.deps.fleet.snapshot();
    if (snapshot.state !== 'paused' || snapshot.generation !== fleetGeneration) {
      return await this.#wait(loaded, checkpoints, backoffDelay(loaded.backoffIndex));
    }
    const now = this.deps.now();
    const record: Omit<Manifest, 'digest'> = {
      version: 1,
      rootId: loaded.rootId,
      generation: generation + 1,
      state: 'open',
      updatedAt: new Date(now).toISOString(),
      backoffIndex: 0,
      quorum: loaded.quorum,
      checkpoints: checkpoints.map((checkpoint) => ({ id: checkpoint.id, digest: checkpoint.digest, generation })),
    };
    try {
      await this.deps.store.write(record, generation);
      this.manifest = await this.deps.store.read();
    } catch (error) {
      this.deps.onError?.(error);
      return await this.#recover();
    }
    // Re-check immediately after the write: a pause landing under the check or the write makes the
    // approval stale, so the just-written 'open' record is withdrawn before any reopen is attempted.
    if (!this.#authorised(fleetGeneration)) return await this.#withdraw(checkpoints);
    // The generation is part of the decision, not just a check around it: the fresh check handed to
    // `tryResume` fails whenever the fleet is no longer paused at the authorised generation, so a
    // pause landing while this write is in flight can never be followed by a reopen.
    const reopened = await this.deps.fleet.tryResume(async () => this.#authorised(fleetGeneration));
    if (reopened) return true;
    if (this.deps.fleet.snapshot().state === 'open') return false;
    return await this.#withdraw(checkpoints);
  }

  /** True only while the fleet is still paused at the generation the check was authorised against. */
  #authorised(fleetGeneration: number): boolean {
    const snapshot = this.deps.fleet.snapshot();
    return snapshot.state === 'paused' && snapshot.generation === fleetGeneration;
  }

  /**
   * The transient 'open' record was written but the latch moved under it. Withdraw it to a durable
   * pause only while the latch is genuinely still paused: if a pause and a resume both landed under
   * the write the latch is open again and already matches the record, so withdrawing would
   * manufacture a durable pause for an open root and re-arm forever.
   */
  async #withdraw(checkpoints: readonly Checkpoint[]): Promise<boolean> {
    if (this.deps.fleet.snapshot().state === 'open') {
      this.pendingWithdrawal = null;
      return false;
    }
    if (!this.manifest || this.manifest.state !== 'open') return false;
    this.pendingWithdrawal = { checkpoints, reason: this.deps.fleet.snapshot().reason };
    return await this.#commitWithdrawal();
  }

  /**
   * Commit a withdrawal, retrying a write that failed before commit. The open/paused decision is
   * re-decided after every await that can move the latch - the `read` below and each write attempt -
   * with no await between the final check and the write itself, so a pause/resume landing under a
   * read can never make the machine withdraw a manifest the open latch no longer needs. If the latch
   * is open while the durable record still claims a pause, reality wins and the record is converged
   * back to 'open'. If the write still fails, every failure reaches `onError` and the withdrawal
   * stays pending with a wake armed, so the durable record and the latch converge on the next wake
   * instead of being stranded.
   */
  async #commitWithdrawal(): Promise<boolean> {
    const pending = this.pendingWithdrawal;
    if (!pending) return false;
    let current: Manifest | null;
    try {
      current = await this.deps.store.read();
    } catch (error) {
      this.deps.onError?.(error);
      this.#arm(backoffDelay(this.manifest?.backoffIndex ?? 0));
      return false;
    }
    this.manifest = current;
    if (current === null) {
      this.pendingWithdrawal = null;
      return false;
    }
    // Re-decide after the read: a resume landing under it leaves the latch open, and the durable
    // record must then not be left claiming a pause for a root that is already running.
    if (this.deps.fleet.snapshot().state === 'open') return await this.#convergeOpen();
    if (current.state !== 'open') {
      // The withdrawal (or another writer) already recorded a non-open state; honour its deadline.
      this.pendingWithdrawal = null;
      const wakeAt = current.wakeAt === undefined ? undefined : Date.parse(current.wakeAt);
      this.#arm(wakeAt === undefined ? backoffDelay(current.backoffIndex) : Math.max(0, wakeAt - this.deps.now()));
      return false;
    }
    const delay = backoffDelay(current.backoffIndex);
    const record = pauseRecord(current, pending.checkpoints, pending.reason, delay, this.deps.now());
    for (let attempt = 0; attempt < 2; attempt++) {
      // The decision and the act share one synchronous turn: the latch is read, then the write is
      // issued with no await between them, so the withdrawal cannot run on a decision the latch has
      // since invalidated.
      if (this.deps.fleet.snapshot().state === 'open') return await this.#convergeOpen();
      try {
        await this.deps.store.write(record, current.generation);
        this.manifest = await this.deps.store.read();
        // The write may have committed while a resume re-opened the latch; converge if so.
        if (this.deps.fleet.snapshot().state === 'open') return await this.#convergeOpen();
        this.pendingWithdrawal = null;
        this.#arm(delay);
        return false;
      } catch (error) {
        this.deps.onError?.(error);
      }
    }
    this.pendingWithdrawal = { checkpoints: pending.checkpoints, reason: pending.reason };
    this.#arm(delay);
    return false;
  }

  /**
   * The latch is open but the durable record still claims a pause: an external resume opened the
   * root while a withdrawal was committing. Reality wins - converge the record to 'open' so a
   * reload cannot reinstate a pause for a root that is already running. The record is re-read here
   * rather than trusted from the caller: a write that committed before it threw leaves the caller
   * holding a stale value, and converging from that stale value would clear the withdrawal on a
   * record the latch no longer matches. The latch is re-read after the converging write for the same
   * reason - a pause landing under it means the record no longer matches the latch, so the
   * withdrawal is retried instead of being cleared with nothing armed.
   */
  async #convergeOpen(): Promise<boolean> {
    let base: Manifest | null;
    try {
      base = await this.deps.store.read();
    } catch (error) {
      this.deps.onError?.(error);
      this.#arm(backoffDelay(this.manifest?.backoffIndex ?? 0));
      return false;
    }
    this.manifest = base;
    if (!base || base.state === 'open') {
      this.pendingWithdrawal = null;
      return false;
    }
    // The decision is made with the state it acts on: the latch is read in the same synchronous
    // turn as the write is issued, and if it is no longer open the convergence is stale and the
    // withdrawal must run instead.
    if (this.deps.fleet.snapshot().state !== 'open') return await this.#commitWithdrawal();
    try {
      await this.deps.store.write({
        version: 1,
        rootId: base.rootId,
        generation: base.generation + 1,
        state: 'open',
        updatedAt: new Date(this.deps.now()).toISOString(),
        backoffIndex: 0,
        quorum: base.quorum,
        checkpoints: base.checkpoints,
      }, base.generation);
      this.manifest = await this.deps.store.read();
    } catch (error) {
      this.deps.onError?.(error);
      this.#arm(backoffDelay(base.backoffIndex));
      return false;
    }
    if (this.deps.fleet.snapshot().state !== 'open') return await this.#commitWithdrawal();
    this.pendingWithdrawal = null;
    return false;
  }

  /** Waits, without polling, for admitted inference/coding work to finish draining. */
  #drain(): Promise<void> {
    const fleet = this.deps.fleet;
    const drained = () => fleet.snapshot().state !== 'draining';
    if (drained()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => { detach(); resolve(); };
      const detach = fleet.subscribe(() => { if (drained()) finish(); });
      if (drained()) finish();
    });
  }

  /** Persist the new wait deadline (backoff/reset/retryAt) before arming, then re-arm. */
  async #wait(
    manifest: Manifest,
    checkpoints: readonly Checkpoint[],
    delayMs: number,
    error?: unknown,
    reason?: PauseReason,
  ): Promise<boolean> {
    if (error !== undefined) this.deps.onError?.(error);
    const now = this.deps.now();
    let delay = Math.max(0, delayMs);
    if (error instanceof QuotaError && error.retryAt !== undefined) {
      const retry = Date.parse(error.retryAt);
      if (Number.isFinite(retry) && retry - now > delay) delay = retry - now;
    }
    const record = pauseRecord(manifest, checkpoints, reason, delay, now);
    try {
      await this.deps.store.write(record, manifest.generation);
      this.manifest = await this.deps.store.read();
    } catch (writeError) {
      this.deps.onError?.(writeError);
      return await this.#recover();
    }
    this.#arm(delay);
    return false;
  }

  /**
   * A rejected compare-and-swap means this runner no longer owns the state; never strand the pause.
   * Reload the latest manifest and re-arm from whatever deadline it records (immediately if overdue).
   */
  async #recover(): Promise<boolean> {
    let current: Manifest | null;
    try {
      current = await this.deps.store.read();
    } catch (error) {
      this.deps.onError?.(error);
      this.#arm(backoffDelay(0));
      return false;
    }
    this.manifest = current;
    if (!current || current.state === 'open') return false;
    const now = this.deps.now();
    const wakeAt = current.wakeAt === undefined ? undefined : Date.parse(current.wakeAt);
    this.#arm(wakeAt === undefined ? backoffDelay(current.backoffIndex) : Math.max(0, wakeAt - now));
    return false;
  }

  #arm(delayMs: number): void {
    this.#cancelTimer();
    if (this.disposed) return;
    const token = ++this.timerToken;
    this.timer = this.deps.schedule(Math.max(0, Math.trunc(delayMs)), () => {
      if (token !== this.timerToken) return; // a late fire from a cancelled timer is a no-op
      this.timer = null;
      void this.resume();
    });
  }

  #cancelTimer(): void {
    this.timerToken++;
    const timer = this.timer;
    this.timer = null;
    timer?.cancel();
  }
}
