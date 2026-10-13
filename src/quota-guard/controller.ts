import type { GuardedProvider } from './types.ts';

export type Release = () => void;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Guard admission aborted', 'AbortError');
}
interface Ticket {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  detach: () => void;
}
interface Lane { active: boolean; queue: Ticket[] }

/** Account keys must come from verified provider/account/workspace scope, never a model name. */
export class AccountFifo {
  private readonly lanes = new Map<string, Lane>();
  get activeAccounts(): number { return [...this.lanes.values()].filter(lane => lane.active).length; }

  async enter(account: string, signal?: AbortSignal): Promise<Release> {
    aborted(signal);
    if (!account) throw new Error('Verified account key required');
    const lane = this.lanes.get(account) ?? { active: false, queue: [] };
    this.lanes.set(account, lane);
    return new Promise<Release>((resolve, reject) => {
      const ticket: Ticket = { resolve, reject, signal, detach: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => {
        const index = lane.queue.indexOf(ticket);
        if (index < 0) return;
        lane.queue.splice(index, 1); ticket.detach();
        if (!lane.active && !lane.queue.length) this.lanes.delete(account);
        reject(new DOMException('Guard admission aborted', 'AbortError'));
      };
      lane.queue.push(ticket); signal?.addEventListener('abort', cancel, { once: true });
      this.advance(account, lane);
    });
  }

  private advance(account: string, lane: Lane): void {
    if (lane.active) return;
    let ticket = lane.queue.shift();
    while (ticket) {
      ticket.detach();
      if (ticket.signal?.aborted) {
        ticket.reject(new DOMException('Guard admission aborted', 'AbortError'));
        ticket = lane.queue.shift();
        continue;
      }
      lane.active = true;
      break;
    }
    if (!ticket) { this.lanes.delete(account); return; }
    let released = false;
    ticket.resolve(() => {
      if (released) return;
      released = true; lane.active = false;
      // Synchronous, nonthrowing release precedes terminal/result observation in the dispatcher.
      this.advance(account, lane);
    });
  }
}

export type PauseReason = 'threshold' | 'reserve' | 'unavailable' | 'identity' | 'manual';
export type GuardTarget = 'all' | GuardedProvider;
export type FleetState = 'open' | 'draining' | 'paused';
export interface FleetSnapshot {
  rootId: string;
  generation: number;
  state: FleetState;
  active: number;
  inferences: number;
  coding: number;
  reason?: PauseReason;
}


export interface ProviderFleetSnapshot extends FleetSnapshot {
  providerId: GuardedProvider;
  automaticReason?: PauseReason;
  manual: boolean;
  manualTarget?: GuardTarget;
}
interface Waiter { provider?: GuardedProvider; resume: () => void; detach: () => void }

/** One original-root fleet. Orchestration dependencies use wait(), never a coding lease. */
export class FleetLatch {
  private readonly rootId: string;
  private legacyReason?: PauseReason;
  private rootGeneration = 0;
  private manualAll = false;
  /** Manual-intent epoch stays stable across automatic checks that advance other generations. */
  private manualAllGeneration = 0;
  private inferences = 0;
  private coding = 0;
  private readonly providerGenerations = new Map<GuardedProvider, number>();
  private readonly manualProviderGenerations = new Map<GuardedProvider, number>();
  private readonly automatic = new Map<GuardedProvider, PauseReason>();
  private readonly manualProviders = new Set<GuardedProvider>();
  private readonly providerCounts = new Map<GuardedProvider, { inferences: number; coding: number }>();
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(snapshot: Readonly<FleetSnapshot>) => void>();

  constructor(rootId: string) {
    if (!rootId) throw new Error('Original root identity required');
    this.rootId = rootId;
  }

  snapshot(): Readonly<FleetSnapshot>;
  snapshot(providerId: GuardedProvider): Readonly<ProviderFleetSnapshot>;
  snapshot(providerId?: GuardedProvider): Readonly<FleetSnapshot | ProviderFleetSnapshot> {
    if (providerId) {
      const counts = this.counts(providerId);
      const automaticReason = this.automatic.get(providerId);
      const manualTarget: GuardTarget | undefined = this.manualAll || this.legacyReason === 'manual'
        ? 'all'
        : this.manualProviders.has(providerId) ? providerId : undefined;
      const manual = manualTarget !== undefined;
      const blocked = this.isBlocked(providerId);
      const active = counts.inferences + counts.coding;
      let state: FleetState = 'open';
      if (blocked) state = active > 0 ? 'draining' : 'paused';
      let reason = automaticReason;
      if (reason === undefined && manual) reason = 'manual';
      if (reason === undefined) reason = this.legacyReason;
      return Object.freeze({
        rootId: this.rootId,
        providerId,
        generation: this.rootGeneration + (this.providerGenerations.get(providerId) ?? 0),
        state,
        active,
        inferences: counts.inferences,
        coding: counts.coding,
        ...(automaticReason !== undefined && { automaticReason }),
        manual,
        ...(manualTarget !== undefined && { manualTarget }),
        ...(reason !== undefined && { reason }),
      });
    }
    const blocked = this.legacyReason !== undefined || this.manualAll;
    return Object.freeze({
      rootId: this.rootId,
      generation: this.rootGeneration,
      state: blocked ? (this.inferences + this.coding ? 'draining' : 'paused') : 'open',
      active: this.inferences + this.coding,
      inferences: this.inferences,
      coding: this.coding,
      ...(this.legacyReason !== undefined && { reason: this.legacyReason }),
      ...(!this.legacyReason && this.manualAll && { reason: 'manual' as const }),
    });
  }

  /** Compatibility root-wide pause. New automatic failures must use pauseAutomatic(provider,...). */
  pause(reason: PauseReason): void {
    this.legacyReason = reason;
    this.rootGeneration++;
    if (reason === 'manual') this.manualAllGeneration++;
    this.notify();
  }

  pauseAutomatic(providerId: GuardedProvider, reason: Exclude<PauseReason, 'manual'>): void {
    this.automatic.set(providerId, reason);
    this.bumpProvider(providerId);
    this.notify();
  }

  /** Fences an in-flight provider resume when a new verified lane is discovered. */
  noteScope(providerId: GuardedProvider): void {
    this.bumpProvider(providerId);
  }

  pauseManual(target: GuardTarget): void {
    if (target === 'all') {
      this.manualAll = true;
      this.rootGeneration++;
      this.manualAllGeneration++;
      for (const provider of ['openai-codex', 'commandcode'] as const) {
        this.bumpProvider(provider);
        this.bumpManualProvider(provider);
      }
    } else {
      this.manualProviders.add(target);
      this.bumpProvider(target);
      this.bumpManualProvider(target);
    }
    this.notify();
  }

  clearManual(target: GuardTarget): void {
    if (target === 'all') {
      const restoredManual = this.legacyReason === 'manual';
      if (!this.manualAll && !this.manualProviders.size && !restoredManual) return;
      this.manualAll = false;
      this.manualProviders.clear();
      if (restoredManual) this.legacyReason = undefined;
      this.rootGeneration++;
      this.manualAllGeneration++;
      for (const provider of ['openai-codex', 'commandcode'] as const) {
        this.bumpProvider(provider);
        this.bumpManualProvider(provider);
      }
    } else {
      if (!this.manualProviders.delete(target)) return;
      this.bumpProvider(target);
      this.bumpManualProvider(target);
    }
    this.notify();
  }

  async resume(
    target: GuardTarget,
    freshCheck?: (providerId: GuardedProvider) => Promise<boolean>,
    beforeClearManual?: (commitManual: () => boolean) => Promise<boolean>,
    /** Await state restoration after the manual fence is captured, before any quota checks. */
    prepare?: () => Promise<boolean>,
  ): Promise<boolean> {
    const providers: readonly GuardedProvider[] = target === 'all'
      ? ['openai-codex', 'commandcode'] : [target];
    const manualAllGeneration = this.manualAllGeneration;
    const manualGenerations = providers.map(providerId => [providerId, this.manualProviderGenerations.get(providerId) ?? 0] as const);
    if (prepare && !await prepare()) return false;
    if (this.manualAllGeneration !== manualAllGeneration
      || manualGenerations.some(([providerId, generation]) => (this.manualProviderGenerations.get(providerId) ?? 0) !== generation)) {
      return false;
    }
    for (const providerId of providers) {
      if (this.automatic.has(providerId)) {
        if (!freshCheck || !await this.resumeAutomatic(providerId, () => freshCheck(providerId))) return false;
      }
    }
    const commitManual = (): boolean => {
      if (this.manualAllGeneration !== manualAllGeneration
        || manualGenerations.some(([providerId, generation]) => (this.manualProviderGenerations.get(providerId) ?? 0) !== generation)) {
        return false;
      }
      this.clearManual(target);
      return true;
    };
    return beforeClearManual ? beforeClearManual(commitManual) : commitManual();
  }

  async resumeAutomatic(providerId: GuardedProvider, freshCheck: () => Promise<boolean>): Promise<boolean> {
    const reason = this.automatic.get(providerId);
    if (reason === undefined || this.providerActive(providerId) !== 0) return false;
    const generation = this.snapshot(providerId).generation;
    let ready: boolean;
    try { ready = await freshCheck(); } catch { return false; }
    if (ready !== true || this.automatic.get(providerId) !== reason
      || this.snapshot(providerId).generation !== generation) return false;
    this.automatic.delete(providerId);
    this.bumpProvider(providerId);
    this.notify();
    return true;
  }

  async wait(signal?: AbortSignal): Promise<void>;
  async wait(providerId: GuardedProvider, signal?: AbortSignal): Promise<void>;
  async wait(providerOrSignal?: GuardedProvider | AbortSignal, maybeSignal?: AbortSignal): Promise<void> {
    const providerId = typeof providerOrSignal === 'string' ? providerOrSignal : undefined;
    const signal = providerId ? maybeSignal : providerOrSignal as AbortSignal | undefined;
    aborted(signal);
    if (!this.isBlocked(providerId)) return;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        ...(providerId && { provider: providerId }),
        resume: resolve,
        detach: () => signal?.removeEventListener('abort', cancel),
      };
      const cancel = () => {
        this.waiters.delete(waiter);
        waiter.detach();
        reject(new DOMException('Guard admission aborted', 'AbortError'));
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    aborted(signal);
  }

  async enter(kind: 'inference' | 'coding', signal?: AbortSignal): Promise<Release>;
  async enter(providerId: GuardedProvider, kind: 'inference' | 'coding', signal?: AbortSignal): Promise<Release>;
  async enter(first: GuardedProvider | 'inference' | 'coding', second?: 'inference' | 'coding' | AbortSignal,
    third?: AbortSignal): Promise<Release> {
    const providerId = first === 'openai-codex' || first === 'commandcode' ? first : undefined;
    const kind = providerId ? second as 'inference' | 'coding' : first as 'inference' | 'coding';
    const signal = providerId ? third : second as AbortSignal | undefined;
    while (true) {
      if (providerId) await this.wait(providerId, signal); else await this.wait(signal);
      aborted(signal);
      if (this.isBlocked(providerId)) continue;
      if (kind === 'inference') this.inferences++; else this.coding++;
      if (providerId) {
        const counts = this.counts(providerId);
        if (kind === 'inference') counts.inferences++; else counts.coding++;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (kind === 'inference') this.inferences--; else this.coding--;
        if (providerId) {
          const counts = this.counts(providerId);
          if (kind === 'inference') counts.inferences--; else counts.coding--;
        }
        this.notify();
      };
    }
  }

  /**
   * Observes every fleet transition. A throwing observer can never break a release or a pause,
   * because the latch's own bookkeeping has already happened by the time listeners run.
   */
  subscribe(listener: (snapshot: Readonly<FleetSnapshot>) => void): Release {
    if (typeof listener !== 'function') throw new TypeError('Fleet listener must be a function');
    this.listeners.add(listener);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const waiter of this.waiters) {
      if (this.isBlocked(waiter.provider)) continue;
      this.waiters.delete(waiter);
      waiter.detach();
      waiter.resume();
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* an observer must never break the latch */ }
    }
  }

  /**
   * Reinstates a persisted root-wide pause on a freshly constructed latch. Provider-local pauses
   * are intentionally never restored from an unattributed root record.
   */
  restorePaused(generation: number, reason: PauseReason): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('Fleet restoration requires a non-negative integer generation');
    }
    if (generation < this.rootGeneration) throw new Error('Fleet restoration would regress the generation');
    if (this.inferences !== 0 || this.coding !== 0) {
      throw new Error('Fleet restoration refused while work is admitted');
    }
    this.rootGeneration = generation;
    this.legacyReason = reason;
    if (reason === 'manual') this.manualAllGeneration++;
    this.notify();
  }

  async tryResume(freshCheck: () => Promise<boolean>): Promise<boolean> {
    if (this.legacyReason === undefined) return false;
    const generation = this.rootGeneration;
    if (this.inferences + this.coding !== 0) return false;
    let ready: boolean;
    try { ready = await freshCheck(); } catch { return false; }
    if (ready !== true || this.legacyReason === undefined || generation !== this.rootGeneration) return false;
    this.legacyReason = undefined;
    this.rootGeneration++;
    this.notify();
    return true;
  }

  private counts(providerId: GuardedProvider): { inferences: number; coding: number } {
    let counts = this.providerCounts.get(providerId);
    if (!counts) { counts = { inferences: 0, coding: 0 }; this.providerCounts.set(providerId, counts); }
    return counts;
  }

  private providerActive(providerId: GuardedProvider): number {
    const counts = this.counts(providerId);
    return counts.inferences + counts.coding;
  }

  private bumpProvider(providerId: GuardedProvider): void {
    this.providerGenerations.set(providerId, (this.providerGenerations.get(providerId) ?? 0) + 1);
  }

  private bumpManualProvider(providerId: GuardedProvider): void {
    this.manualProviderGenerations.set(providerId, (this.manualProviderGenerations.get(providerId) ?? 0) + 1);
  }

  private isBlocked(providerId?: GuardedProvider): boolean {
    if (this.legacyReason !== undefined || this.manualAll) return true;
    return providerId !== undefined
      && (this.manualProviders.has(providerId) || this.automatic.has(providerId));
  }
}
