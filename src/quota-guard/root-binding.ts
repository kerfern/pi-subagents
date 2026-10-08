import { readQuota } from './adapters.ts';
import { AccountFifo, FleetLatch } from './controller.ts';
import { GuardCoordinator } from './coordinator.ts';
import { DEFAULT_POLICY, ReserveEstimator, seedReserves, validateReserveSeed } from './policy.ts';
import type { Policy } from './types.ts';

/**
 * Builds the one coordinator a guarded root runs on. Nothing constructs this at import time: it
 * exists only when an operator enables the guard, which is what keeps the package inert.
 *
 * Identity is not resolved here. `root.ts` resolves each attempt's provider/account/credential from
 * the runtime it decorates and hands the resulting scope to the coordinator, so the coordinator
 * only ever sees a verified scope - never a credential it looked up itself.
 */
export interface RootBindingOptions {
  rootId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  policy?: Policy;
  /**
   * Operator-asserted per-window reserve units, from `quotaGuardReserveUnits`. Re-validated here and
   * used only to fill a reserve the estimator could not compute (an idle account never moves a
   * counter, so it can never calibrate): it is never a default and never overrides an observation.
   */
  reserveUnits?: ReadonlyMap<string, number>;
}

export interface RootBinding {
  coordinator: GuardCoordinator;
  fleet: FleetLatch;
  estimator: ReserveEstimator;
  /**
   * The check a manual resume must pass. It reads quota through the coordinator's own `readQuota` and
   * estimator, so calibration progresses while the fleet is paused instead of deadlocking in `admit`.
   * Only the scopes the guard has actually seen can be re-checked - the estimator is keyed by lane and
   * `AccountFifo.lanes` is private, so an arbitrary known scope cannot be enumerated from here.
   */
  freshCheck: () => Promise<boolean>;
}

export function createQuotaGuardCoordinator(options: RootBindingOptions): RootBinding {
  const rootId = options.rootId && options.rootId.length > 0 ? options.rootId : 'quota-guard-root';
  const fleet = new FleetLatch(rootId);
  const fifo = new AccountFifo();
  const estimator = new ReserveEstimator();
  // Validated once, at construction: an invalid seed is dropped whole rather than applied in part.
  const seed = validateReserveSeed(options.reserveUnits);
  const coordinator = new GuardCoordinator({
    fifo,
    fleet,
    readQuota,
    policy: options.policy ?? DEFAULT_POLICY,
    // The paused mode is what applies the RESUME threshold instead of the pause one, so this must
    // report the latch's real state: getting it wrong silently reopens at the wrong headroom.
    mode: () => (fleet.snapshot().state === 'open' ? 'running' : 'paused'),
    // Per-window reserve units for that lane. An unseen lane yields null, and null keeps the guard
    // closed - unknown is never treated as zero. The operator's seed fills only those nulls; where
    // the estimator has an observation, that observation is what gates.
    reserve: (lane, snapshot) => {
      const observed = estimator.observe(lane, snapshot.windows);
      return seed ? seedReserves(observed, seed) : observed;
    },
    now: options.now ?? Date.now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { coordinator, fleet, estimator, freshCheck: () => coordinator.freshCheck() };
}