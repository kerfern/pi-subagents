import { AccountFifo, FleetLatch } from '../../src/quota-guard/controller.ts';
import type { GuardMode, QuotaScope, QuotaSnapshot } from '../../src/quota-guard/types.ts';
import type { AttemptScope, CoordinatorDeps } from '../../src/quota-guard/coordinator.ts';

export const NOW = Date.parse('2026-10-04T12:00:00.000Z');

/**
 * A JWT-shaped credential with a real base64url payload, so the guard's decoding path is genuinely
 * exercised. Shared by every suite that needs a Codex credential: the transport derives the account
 * id from the token's claim, never from a `chatgpt-account-id` header.
 */
export const jwt = (payload: unknown): string =>
  ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

/** A Codex credential whose claim names `accountId`, as the transport's `JWT_CLAIM_PATH` expects. */
export const codexCredential = (accountId: string): string =>
  jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } });

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
