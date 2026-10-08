import type { Assessment, GuardMode, Policy, QuotaSnapshot, QuotaWindow } from './types.ts';

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({ warn: 20, pause: 10, resume: 20 });

export function validatePolicy(policy: Policy): Readonly<Policy> {
  const { pause, warn, resume } = policy;
  if (![pause, warn, resume].every(Number.isFinite) || !(0 <= pause && pause < warn && warn <= resume && resume < 100)) {
    throw new Error('Invalid quota thresholds');
  }
  return Object.freeze({ pause, warn, resume });
}

function validWindow(window: QuotaWindow): boolean {
  return typeof window.id === 'string' && window.id.length > 0 && Number.isFinite(window.used) && window.used >= 0
    && Number.isFinite(window.cap) && window.cap > 0 && typeof window.resetAt === 'string'
    && Number.isFinite(Date.parse(window.resetAt));
}

export function assess(
  snapshot: QuotaSnapshot,
  policy: Policy,
  mode: GuardMode,
  reserveUnits: ReadonlyMap<string, number | null>,
  now: number,
): Assessment {
  const thresholds = validatePolicy(policy);
  const checkedAt = Date.parse(snapshot.checkedAt);
  const windows = snapshot.windows;
  const scopedIdentity = snapshot.scope === 'account' ? Boolean(snapshot.accountId)
    : snapshot.scope === 'provider' ? snapshot.accountId === undefined : false;
  if (!Number.isFinite(now) || !Number.isFinite(checkedAt) || checkedAt > now || !scopedIdentity
    || !['openai-codex', 'commandcode'].includes(snapshot.providerId) || !windows.length
    || !windows.every(validWindow) || new Set(windows.map(window => window.id)).size !== windows.length) {
    return { state: 'wait', reason: 'unavailable' };
  }
  for (const window of windows) {
    const resetAt = Date.parse(window.resetAt);
    if (resetAt <= now) {
      const deadline = resetAt + 60_000;
      if (now <= deadline || checkedAt < deadline) {
        return { state: 'wait', reason: 'reset-settling', limitingWindow: window.id, nextCheckAt: new Date(deadline).toISOString() };
      }
      // Elapsed time never establishes a fresh quota epoch or restores headroom.
      return { state: 'wait', reason: 'unavailable', limitingWindow: window.id };
    }
  }
  const threshold = mode === 'paused' ? thresholds.resume : thresholds.pause;
  for (const window of windows) {
    if (100 * (window.cap - window.used) / window.cap <= threshold) {
      return { state: mode === 'paused' ? 'wait' : 'pause', reason: 'threshold', limitingWindow: window.id };
    }
  }
  for (const window of windows) {
    const reserve = reserveUnits.get(window.id);
    if (reserve === null || reserve === undefined) return { state: 'wait', reason: 'unknown-reserve', limitingWindow: window.id };
    if (!Number.isFinite(reserve) || reserve < 0) return { state: 'wait', reason: 'unavailable' };
  }
  for (const window of windows) {
    const reserve = reserveUnits.get(window.id);
    if (reserve !== null && reserve !== undefined && window.cap - window.used <= reserve + (mode === 'paused' ? window.cap * thresholds.resume / 100 : 0)) {
      return { state: mode === 'paused' ? 'wait' : 'pause', reason: 'reserve', limitingWindow: window.id };
    }
  }
  if (mode === 'running') {
    for (const window of windows) {
      if (100 * (window.cap - window.used) / window.cap <= thresholds.warn) {
        return { state: 'warn', reason: 'threshold', limitingWindow: window.id };
      }
    }
  }
  return { state: 'open', reason: 'healthy' };
}

/**
 * Strictly validate an operator-supplied reserve seed: every key a non-empty string, every value
 * finite and >= 0. All-or-nothing on purpose - one bad entry drops the whole seed, so a malformed
 * value cannot leave the guard looking seeded while the windows it omitted stay unknown.
 *
 * This is a defence in depth behind `sanitizeReserveUnits` in settings: the guard re-validates what
 * it is handed rather than trusting its transport.
 */
export function validateReserveSeed(seed: ReadonlyMap<string, number> | undefined): ReadonlyMap<string, number> | undefined {
  if (!seed || seed.size === 0) return undefined;
  const out = new Map<string, number>();
  for (const [id, units] of seed) {
    if (typeof id !== 'string' || id.length === 0 || !Number.isFinite(units) || units < 0) return undefined;
    out.set(id, units);
  }
  return out;
}

/**
 * Fills ONLY the unknown reserves with the operator's seed: an observed value always wins, and a
 * window that has an observation is never made to look unobserved. The seed is not a default and is
 * never consulted where the estimator already produced a number, so it cannot blend with calibration.
 */
export function seedReserves(
  observed: ReadonlyMap<string, number | null>,
  seed: ReadonlyMap<string, number>,
): ReadonlyMap<string, number | null> {
  const out = new Map<string, number | null>(observed);
  for (const id of observed.keys()) {
    if (out.get(id) === null && seed.has(id)) out.set(id, seed.get(id) as number);
  }
  return out;
}

interface Sample {
  resetAt: string;
  cap: number;
  used: number;
  deltas: number[];
}

export class ReserveEstimator {
  private readonly samples = new Map<string, Map<string, Sample>>();

  observe(accountKey: string, windows: readonly QuotaWindow[]): ReadonlyMap<string, number | null> {
    const result = new Map<string, number | null>();
    if (!accountKey || !windows.length || !windows.every(validWindow)
      || new Set(windows.map(window => window.id)).size !== windows.length) {
      this.samples.delete(accountKey);
      for (const window of windows) result.set(window.id, null);
      return result;
    }
    const previous = this.samples.get(accountKey) ?? new Map<string, Sample>();
    const next = new Map<string, Sample>();
    for (const window of windows) {
      const old = previous.get(window.id);
      const sample: Sample = !old || old.resetAt !== window.resetAt || old.cap !== window.cap || window.used < old.used
        ? { resetAt: window.resetAt, cap: window.cap, used: window.used, deltas: [] }
        : { ...old, used: window.used, deltas: [...old.deltas] };
      if (old && old.resetAt === window.resetAt && old.cap === window.cap && window.used > old.used) {
        sample.deltas.push(window.used - old.used);
        sample.deltas = sample.deltas.slice(-5);
      }
      next.set(window.id, sample);
      result.set(window.id, sample.deltas.length ? 2 * Math.max(...sample.deltas) : null);
    }
    this.samples.set(accountKey, next);
    return result;
  }
}
