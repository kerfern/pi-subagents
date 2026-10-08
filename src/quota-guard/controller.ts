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
interface Waiter { resume: () => void; detach: () => void }

/** One original-root fleet. Orchestration dependencies use wait(), never a coding lease. */
export class FleetLatch {
  private readonly rootId: string;
  private state: FleetState = 'open';
  private generation = 0;
  private reason?: PauseReason;
  private inferences = 0;
  private coding = 0;
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(snapshot: Readonly<FleetSnapshot>) => void>();

  constructor(rootId: string) {
    if (!rootId) throw new Error('Original root identity required');
    this.rootId = rootId;
  }
  snapshot(): Readonly<FleetSnapshot> {
    return Object.freeze({ rootId: this.rootId, generation: this.generation, state: this.state,
      active: this.inferences + this.coding, inferences: this.inferences, coding: this.coding, reason: this.reason });
  }
  pause(reason: PauseReason): void {
    this.reason = reason;
    this.generation++;
    this.state = this.inferences + this.coding ? 'draining' : 'paused';
    this.notify();
  }
  async wait(signal?: AbortSignal): Promise<void> {
    aborted(signal);
    if (this.state === 'open') return;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resume: resolve, detach: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => {
        this.waiters.delete(waiter); waiter.detach();
        reject(new DOMException('Guard admission aborted', 'AbortError'));
      };
      this.waiters.add(waiter); signal?.addEventListener('abort', cancel, { once: true });
    });
    aborted(signal);
  }
  async enter(kind: 'inference' | 'coding', signal?: AbortSignal): Promise<Release> {
    while (true) {
      await this.wait(signal); aborted(signal);
      if (this.state !== 'open') continue;
      if (kind === 'inference') this.inferences++; else this.coding++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (kind === 'inference') this.inferences--; else this.coding--;
        if (this.state === 'draining' && !this.inferences && !this.coding) {
          this.state = 'paused';
          this.notify();
        }
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
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* an observer must never break the latch */ }
    }
  }

  /**
   * Reinstates a persisted pause on a freshly constructed latch. Refuses state that would regress:
   * a latch that already has admitted work, or a generation older than the one already recorded.
   * Resuming still requires a fresh check through `tryResume` - this only restores the block.
   */
  restorePaused(generation: number, reason: PauseReason): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('Fleet restoration requires a non-negative integer generation');
    }
    if (generation < this.generation) throw new Error('Fleet restoration would regress the generation');
    if (this.inferences !== 0 || this.coding !== 0) {
      throw new Error('Fleet restoration refused while work is admitted');
    }
    this.generation = generation;
    this.reason = reason;
    this.state = 'paused';
    this.notify();
  }

  async tryResume(freshCheck: () => Promise<boolean>): Promise<boolean> {
    if (this.state !== 'paused') return false;
    const generation = this.generation;
    let ready: boolean;
    try { ready = await freshCheck(); } catch { return false; }
    if (ready !== true || this.state !== 'paused' || generation !== this.generation) return false;
    this.state = 'open'; this.reason = undefined;
    this.notify();
    for (const waiter of this.waiters) { waiter.detach(); waiter.resume(); }
    this.waiters.clear();
    return true;
  }
}
