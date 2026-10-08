import { AccountFifo, FleetLatch } from '../../src/quota-guard/controller.ts';
import type { GuardMode, QuotaScope, QuotaSnapshot } from '../../src/quota-guard/types.ts';
import type { AttemptScope, CoordinatorDeps } from '../../src/quota-guard/coordinator.ts';

export const NOW = Date.parse('2026-10-04T12:00:00.000Z');

export const commandcodeScope: AttemptScope = { providerId: 'commandcode', scope: 'provider', credential: 'k1' };

export const openSnapshot = (scope: QuotaScope): QuotaSnapshot => ({ providerId: 'commandcode', scope,
  checkedAt: new Date(NOW - 60_000).toISOString(),
  windows: [{ id: 'monthly', used: 1, cap: 70, resetAt: new Date(NOW + 3_600_000).toISOString() }] });

export const realFetch: typeof fetch = globalThis.fetch;

/** Optional fail:true errors the stream after the last chunk. */
export function streamOf(chunks: string[], opts?: { fail?: boolean }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (opts?.fail) controller.error(new Error('stream failure'));
      else controller.close();
    },
  });
}

export function deps(overrides: Partial<CoordinatorDeps> = {}) {
  const calls: string[] = [];
  return { calls, deps: {
    fifo: new AccountFifo(),
    fleet: new FleetLatch('root-1'),
    readQuota: (async () => { calls.push('read'); return openSnapshot('provider'); }) as unknown as CoordinatorDeps['readQuota'],
    policy: { warn: 20, pause: 10, resume: 20 },
    mode: () => 'running' as GuardMode,
    reserve: () => new Map<string, number | null>([['monthly', 5]]),
    now: () => NOW,
    ...overrides,
  } satisfies CoordinatorDeps };
}
