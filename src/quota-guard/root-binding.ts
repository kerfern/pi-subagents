import { readQuota } from './adapters.ts';
import { AccountFifo, FleetLatch } from './controller.ts';
import { GuardCoordinator } from './coordinator.ts';
import { DEFAULT_POLICY, ReserveEstimator } from './policy.ts';
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
}

export interface RootBinding {
  coordinator: GuardCoordinator;
  fleet: FleetLatch;
  estimator: ReserveEstimator;
}

export function createQuotaGuardCoordinator(options: RootBindingOptions): RootBinding {
  const rootId = options.rootId && options.rootId.length > 0 ? options.rootId : 'quota-guard-root';
  const fleet = new FleetLatch(rootId);
  const fifo = new AccountFifo();
  const estimator = new ReserveEstimator();
  const coordinator = new GuardCoordinator({
    fifo,
    fleet,
    readQuota,
    policy: options.policy ?? DEFAULT_POLICY,
    // The paused mode is what applies the RESUME threshold instead of the pause one, so this must
    // report the latch's real state: getting it wrong silently reopens at the wrong headroom.
    mode: () => (fleet.snapshot().state === 'open' ? 'running' : 'paused'),
    // Per-window reserve units for that lane. An unseen lane yields null, and null keeps the guard
    // closed - unknown is never treated as zero.
    reserve: (lane, snapshot) => estimator.observe(lane, snapshot.windows),
    now: options.now ?? Date.now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { coordinator, fleet, estimator };
}