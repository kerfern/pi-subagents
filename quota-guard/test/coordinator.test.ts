import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuotaError, readQuota, type ReadOptions } from '../../src/quota-guard/adapters.ts';
import { classifyFinalRequest, GuardCoordinator, laneKey, type AttemptScope } from '../../src/quota-guard/coordinator.ts';
import { FleetLatch, type Release } from '../../src/quota-guard/controller.ts';
import type { GuardedProvider } from '../../src/quota-guard/types.ts';
import {
  quotaGuardControls, quotaGuardExtension, quotaGuardRootBinding, resetQuotaGuardStateForTest,
  setQuotaGuardEnabled,
} from '../../src/quota-guard/index.ts';
import { NOW, commandcodeScope, deps, openSnapshot, streamOf } from './guard-fixtures.ts';

/** Counts guard releases; the underlying FleetLatch release is already idempotent. */
class CountingFleet extends FleetLatch {
  releases = 0;
  async enter(kind: 'inference' | 'coding', signal?: AbortSignal): Promise<Release>;
  async enter(providerId: GuardedProvider, kind: 'inference' | 'coding', signal?: AbortSignal): Promise<Release>;
  async enter(first: GuardedProvider | 'inference' | 'coding',
    second?: 'inference' | 'coding' | AbortSignal, third?: AbortSignal): Promise<Release> {
    const release = first === 'openai-codex' || first === 'commandcode'
      ? await super.enter(first, second as 'inference' | 'coding', third)
      : await super.enter(first, second as AbortSignal | undefined);
    return () => { this.releases++; release(); };
  }
}

test('codex lane key uses the verified account id; commandcode is provider-wide', () => {
  assert.equal(laneKey({ providerId: 'openai-codex', scope: 'account', accountId: 'acct-1', credential: 'k1' }), 'openai-codex:acct-1');
  assert.equal(laneKey({ providerId: 'commandcode', scope: 'provider', credential: 'k1' }), 'commandcode:provider');
  assert.throws(() => laneKey({ providerId: 'openai-codex', scope: 'account', credential: 'k1' }), (e: unknown) => e instanceof QuotaError);
});

test('final-request classification binds the credential and Codex account id', () => {
  const url = 'https://api.commandcode.ai/provider/v1/chat/completions';
  assert.equal(classifyFinalRequest({ url, headers: new Headers({ authorization: 'Bearer k1' }) }, commandcodeScope), commandcodeScope);
  assert.throws(() => classifyFinalRequest({ url, headers: new Headers({ authorization: 'Bearer k9' }) }, commandcodeScope), (e: unknown) => e instanceof QuotaError);
  const codex = { providerId: 'openai-codex', scope: 'account', accountId: 'acct-1', credential: 'k1' } as const;
  assert.equal(classifyFinalRequest({ url, headers: new Headers({ authorization: 'Bearer k1', 'chatgpt-account-id': 'acct-1' }) }, codex), codex);
  assert.throws(() => classifyFinalRequest({ url, headers: new Headers({ authorization: 'Bearer k1' }) }, codex), (e: unknown) => e instanceof QuotaError);
});

test('manual assertion refuses only held provider and ignores automatic holds', () => {
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  d.fleet.pauseManual('commandcode');

  assert.throws(() => coordinator.assertManualAllowed('commandcode'), /commandcode is manually paused/);
  assert.doesNotThrow(() => coordinator.assertManualAllowed('openai-codex'));
  d.fleet.pauseAutomatic('openai-codex', 'threshold');
  assert.doesNotThrow(() => coordinator.assertManualAllowed('openai-codex'));
});

test('admit emits safe diagnostic distinguishing read and assessment refusals', async () => {
  const logs: string[] = [];
  const readDeps = deps({ readQuota: (async () => { throw new Error('secret exception'); }) as unknown as typeof readQuota }).deps;
  const readCoordinator = new GuardCoordinator(readDeps, line => {
    assert.equal(readDeps.fleet.snapshot('commandcode').state, 'paused');
    assert.equal(readDeps.fifo.activeAccounts, 0);
    logs.push(line);
  });
  await assert.rejects(() => readCoordinator.admit(commandcodeScope));
  const readLog = logs.splice(0).join('');
  assert.match(readLog, /provider=commandcode phase=read code=unavailable/);
  assert.doesNotMatch(readLog, /secret exception|k1|accountId/);

  const policyDeps = deps({ reserve: () => new Map<string, number | null>([['monthly', null]]) }).deps;
  const policyCoordinator = new GuardCoordinator(policyDeps, line => {
    assert.equal(policyDeps.fleet.snapshot('commandcode').state, 'paused');
    assert.equal(policyDeps.fifo.activeAccounts, 0);
    logs.push(line);
  });
  await assert.rejects(() => policyCoordinator.admit(commandcodeScope));
  assert.match(logs.join(''), /provider=commandcode phase=assessment state=wait reason=unknown-reserve limitingWindow=monthly/);
});

test('throwing diagnostic sink preserves quota error and cleanup', async () => {
  const failure = new QuotaError('unavailable');
  const { deps: d } = deps({ readQuota: (async () => { throw failure; }) as unknown as typeof readQuota });
  const coordinator = new GuardCoordinator(d, () => {
    assert.equal(d.fleet.snapshot('commandcode').state, 'paused');
    assert.equal(d.fifo.activeAccounts, 0);
    throw new Error('sink');
  });
  await assert.rejects(() => coordinator.admit(commandcodeScope), (error) => error === failure);
  assert.equal(d.fleet.snapshot('commandcode').state, 'paused');
  assert.equal(d.fifo.activeAccounts, 0);
});

test('assessment diagnostic escapes and bounds provider-controlled window ids', async () => {
  const hostileId = `monthly\nphase=read code=auth ${'x'.repeat(200)}`;
  const snapshot = openSnapshot('provider');
  const hostileSnapshot = { ...snapshot, windows: [{ ...snapshot.windows[0]!, id: hostileId }] };
  const d = deps({
    readQuota: (async () => hostileSnapshot) as unknown as typeof readQuota,
    reserve: () => new Map<string, number | null>([[hostileId, null]]),
  }).deps;
  const logs: string[] = [];
  await assert.rejects(() => new GuardCoordinator(d, line => logs.push(line)).admit(commandcodeScope));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /limitingWindow=monthly\\u000aphase\\u003dread\\u0020code\\u003dauth/);
  assert.doesNotMatch(logs[0]!, /[\r\n]/);
  assert.ok(logs[0]!.length < 300);
});

test('reset-settling diagnostic includes available next-check time', async () => {
  const snapshot = openSnapshot('provider');
  const window = { ...snapshot.windows[0]!, resetAt: new Date(NOW - 30_000).toISOString() };
  const resetSnapshot = { ...snapshot, windows: [window] };
  const d = deps({ readQuota: (async () => resetSnapshot) as unknown as typeof readQuota }).deps;
  const logs: string[] = [];
  await assert.rejects(() => new GuardCoordinator(d, line => logs.push(line)).admit(commandcodeScope));
  assert.match(logs[0]!, /phase=assessment state=wait reason=reset-settling limitingWindow=monthly nextCheckAt=2026-10-04T12:00:30\.000Z/);
});

test('open and warning admissions emit no refusal diagnostics', async () => {
  const logs: string[] = [];
  const openDeps = deps().deps;
  const releaseOpen = await new GuardCoordinator(openDeps, line => logs.push(line)).admit(commandcodeScope);
  releaseOpen();

  const snapshot = openSnapshot('provider');
  const warningSnapshot = { ...snapshot, windows: [{ ...snapshot.windows[0]!, used: 57, cap: 70 }] };
  const warningDeps = deps({ readQuota: (async () => warningSnapshot) as unknown as typeof readQuota }).deps;
  const releaseWarning = await new GuardCoordinator(warningDeps, line => logs.push(line)).admit(commandcodeScope);
  releaseWarning();
  assert.deepEqual(logs, []);
});

test('admit performs a fresh quota read and pauses only the failing provider', async () => {
  const d = deps({ readQuota: (async () => { throw new QuotaError('unavailable'); }) as unknown as typeof readQuota }).deps;
  await assert.rejects(() => new GuardCoordinator(d).admit(commandcodeScope));
  assert.equal(d.fleet.snapshot().state, 'open');
  assert.equal(d.fleet.snapshot('commandcode').state, 'paused');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'unavailable');
});

test('an unknown reserve refuses as unconfigured, and a retry answers instead of parking', async () => {
  const { calls, deps: d } = deps({ reserve: () => new Map<string, number | null>([['monthly', null]]) });
  const coordinator = new GuardCoordinator(d);
  await assert.rejects(() => coordinator.admit(commandcodeScope), (error: unknown) => {
    assert.ok(error instanceof QuotaError);
    assert.equal(error.code, 'unconfigured', 'an unknown reserve is a configuration gap, not a generic outage');
    assert.match(error.message, /provider=commandcode/);
    assert.match(error.message, /monthly/);
    assert.match(error.message, /quotaGuardReserveUnits/);
    return true;
  });
  // The retry must be answered, not parked: no second read, and no change to any latch state. If it
  // parked, this await would never settle and the test would time out instead of asserting.
  const before = calls.length;
  await assert.rejects(() => coordinator.admit(commandcodeScope),
    (error: unknown) => (error as QuotaError).code === 'unconfigured');
  assert.equal(calls.length, before, 'a parked retry would have re-read quota; it must answer at once');
  // The hold stays (that is the design's pause-then-resume recovery path), the lane is released, and
  // the provider is reported as a reserve blocker rather than an unavailable provider.
  assert.equal(d.fleet.snapshot().state, 'open', 'a provider-scoped refusal leaves the root latch open');
  assert.equal(d.fleet.snapshot('commandcode').state, 'paused');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'reserve');
  assert.equal(d.fifo.activeAccounts, 0);
});

test('a second lane finishing healthy cannot clear another lane\'s refusal, so no retry parks', async () => {
  const limits = [{ id: 'codex', windows: ['primary_window', 'secondary_window'] as const }];
  const scopeFor = (accountId: string) => ({ providerId: 'openai-codex' as const, scope: 'account' as const,
    accountId, credential: 'k1', codexLimits: limits });
  const snapshotFor = (accountId: string) => ({ providerId: 'openai-codex' as const, scope: 'account' as const,
    accountId, checkedAt: new Date(NOW - 60_000).toISOString(),
    windows: [
      { id: 'codex.primary_window', used: 1, cap: 100, resetAt: new Date(NOW + 3_600_000).toISOString() },
      { id: 'codex.secondary_window', used: 1, cap: 100, resetAt: new Date(NOW + 7_200_000).toISOString() },
    ] });
  let known = false;
  let openB: ((value: ReturnType<typeof snapshotFor>) => void) | undefined;
  const gateB = new Promise<ReturnType<typeof snapshotFor>>((resolve) => { openB = resolve; });
  const { deps: d } = deps({
    reserve: () => new Map<string, number | null>([
      ['codex.primary_window', known ? 5 : null], ['codex.secondary_window', known ? 5 : null]]),
    readQuota: (async (auth: { accountId?: string }) =>
      auth.accountId === 'b' ? gateB : snapshotFor(auth.accountId ?? 'a')) as unknown as typeof readQuota,
  });
  const coordinator = new GuardCoordinator(d);
  // Lane B is parked inside its read - past the latch wait - while lane A refuses.
  const controller = new AbortController();
  const laneB = coordinator.admit(scopeFor('b'), controller.signal).then(() => 'admitted', (e: unknown) => (e as Error).name);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(() => coordinator.admit(scopeFor('a')),
    (error: unknown) => (error as QuotaError).code === 'unconfigured');
  // B now finishes healthy. If a successful assessment clears the refusal recorded by A, the next
  // attempt sails past the marker and parks on A's hold - so it must still answer immediately.
  known = true;
  openB!(snapshotFor('b'));
  // A real macrotask turn, so B's healthy assessment completes (and, in the buggy version, clears the
  // marker) before the next attempt is made.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(() => coordinator.admit(scopeFor('c')),
    (error: unknown) => (error as QuotaError).code === 'unconfigured');
  controller.abort();
  assert.equal(await laneB, 'AbortError');
});

test('a fresh check that fails keeps the missing-reserve refusal answering at once', async () => {
  const reserve = new Map<string, number | null>([['monthly', null]]);
  const { deps: d } = deps({ reserve: () => reserve });
  const coordinator = new GuardCoordinator(d);
  const refused = (error: unknown) => (error as QuotaError).code === 'unconfigured';

  await assert.rejects(() => coordinator.admit(commandcodeScope), refused);
  // The reserve is still unknown, so the check cannot pass - and must not retire the refusal either.
  assert.equal(await coordinator.freshCheck('commandcode'), false);
  await assert.rejects(() => coordinator.admit(commandcodeScope), refused);
  assert.equal(d.fleet.snapshot('commandcode').state, 'paused', 'the hold is untouched by a failed check');
  assert.equal(d.fifo.activeAccounts, 0);
});

test('only a successful freshCheck clears the missing-reserve refusal, and it then admits again', async () => {
  let reserve = new Map<string, number | null>([['monthly', null]]);
  const { deps: d } = deps({ reserve: () => reserve });
  const coordinator = new GuardCoordinator(d);
  const refused = (error: unknown) => (error as QuotaError).code === 'unconfigured';

  await assert.rejects(() => coordinator.admit(commandcodeScope), refused);
  // A reserve that merely becomes known does not clear the refusal: the provider is still held, so
  // dropping the record here would hand the next attempt a hold nothing can lift.
  reserve = new Map<string, number | null>([['monthly', 5]]);
  await assert.rejects(() => coordinator.admit(commandcodeScope), refused);

  // The recovery path: a verified freshCheck clears the refusal and reopens the provider.
  assert.equal(await d.fleet.resumeAutomatic('commandcode', () => coordinator.freshCheck('commandcode')), true);
  const release = await coordinator.admit(commandcodeScope);
  release();
  assert.equal(d.fleet.snapshot('commandcode').state, 'open');
});

test('a fenced resume keeps the missing-reserve refusal terminal, so the retry does not park', async () => {
  let reserve = new Map<string, number | null>([['monthly', null]]);
  // The read bumps the provider generation every time, so the resume that follows the read is fenced
  // exactly as a concurrent noteScope() would fence it - deterministic, no timing and no sleeping.
  let fleet!: FleetLatch;
  const { deps: d } = deps({
    reserve: () => reserve,
    readQuota: (async () => { fleet.noteScope('commandcode'); return openSnapshot('provider'); }) as unknown as typeof readQuota,
  });
  fleet = d.fleet;
  const coordinator = new GuardCoordinator(d);
  const refused = (error: unknown) => (error as QuotaError).code === 'unconfigured';

  await assert.rejects(() => coordinator.admit(commandcodeScope), refused);

  // The reserve is now known and the read passes, but it changes the generation mid-read, so the
  // resume is rejected: the hold stays latched and the refusal must stay recorded.
  reserve = new Map<string, number | null>([['monthly', 5]]);
  assert.equal(await d.fleet.resumeAutomatic('commandcode', () => coordinator.freshCheck('commandcode')), false,
    'a read that changes the provider generation must reject the resume');

  // The retry must answer terminally instead of parking in the latch wait. Race it against a short
  // bound so a regression fails fast rather than hanging the runner.
  const outcome = await Promise.race([
    coordinator.admit(commandcodeScope).then(() => 'admitted', (error: unknown) => (error as QuotaError).code),
    new Promise<string>((resolve) => setTimeout(() => resolve('parked'), 100)),
  ]);
  assert.equal(outcome, 'unconfigured', 'a fenced resume must not strand the next retry in the latch wait');
});

test('an incomplete seed refuses and names only the windows it is missing', async () => {
  const base = openSnapshot('provider');
  const twoWindows = { ...base, windows: [...base.windows, { ...base.windows[0]!, id: 'weekly' }] };
  const d = deps({
    readQuota: (async () => twoWindows) as unknown as typeof readQuota,
    reserve: () => new Map<string, number | null>([['monthly', 5], ['weekly', null]]),
  }).deps;
  await assert.rejects(() => new GuardCoordinator(d).admit(commandcodeScope), (error: unknown) => {
    assert.ok(error instanceof QuotaError);
    assert.equal(error.code, 'unconfigured');
    assert.match(error.message, /weekly/);
    assert.doesNotMatch(error.message, /monthly/);
    return true;
  });
  assert.equal(d.fleet.snapshot('commandcode').reason, 'reserve');
});

test('a paused fleet admits nothing — zero reads and zero leases — until a strict fresh true reopens it', async () => {
  const { calls, deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  d.fleet.pause('threshold');
  let admitted = false;
  const pending = coordinator.admit(commandcodeScope).then(() => { admitted = true; });
  // A real macrotask turn, not just a microtask, so an ungated await chain would have progressed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(admitted, false);
  assert.equal(calls.length, 0);
  assert.equal(d.fleet.snapshot().active, 0);
  await d.fleet.tryResume(async () => true);
  await pending;
  assert.equal(admitted, true);
});

test('a throwing assessment releases the lane and pauses only its provider', async () => {
  const d = deps({ reserve: () => { throw new Error('reserve exploded'); } }).deps;
  await assert.rejects(() => new GuardCoordinator(d).admit(commandcodeScope));
  assert.equal(d.fleet.snapshot().state, 'open');
  assert.equal(d.fleet.snapshot('commandcode').state, 'paused');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'unavailable');
  assert.equal(d.fifo.activeAccounts, 0);
});

test('admit reads quota with the caller-injected unwrapped fetch, never a gated one', async () => {
  const sentinel = (() => { throw new Error('gated fetch must never serve the quota read'); }) as unknown as typeof fetch;
  let received: typeof fetch | undefined;
  const d = deps({
    fetchImpl: sentinel,
    readQuota: (async (_auth: unknown, options: ReadOptions = {}) => {
      received = options.fetchImpl;
      return openSnapshot('provider');
    }) as unknown as typeof readQuota,
  }).deps;
  const release = await new GuardCoordinator(d).admit(commandcodeScope);
  assert.equal(received, sentinel);
  assert.notEqual(received, globalThis.fetch);
  release();
});

test('commandcode credentials serialize on one lane while codex accounts run in parallel', async () => {
  const d = deps().deps;
  const coordinator = new GuardCoordinator(d);
  const first = await coordinator.admit({ providerId: 'commandcode', scope: 'provider', credential: 'k1' });
  let secondAdmitted = false;
  const second = coordinator.admit({ providerId: 'commandcode', scope: 'provider', credential: 'k2' }).then(() => { secondAdmitted = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondAdmitted, false);
  assert.equal(d.fleet.snapshot().inferences, 1);
  first(); await second; assert.equal(secondAdmitted, true);
  const a = await coordinator.admit({ providerId: 'openai-codex', scope: 'account', accountId: 'a', credential: 'k' });
  const b = await coordinator.admit({ providerId: 'openai-codex', scope: 'account', accountId: 'b', credential: 'k' });
  a(); b();
});

test('the gate forwards only after admission and releases when the body terminates', async () => {
  const events: string[] = [];
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  const inner = (async () => new Response(streamOf(['a', 'b']), { status: 200 })) as unknown as typeof fetch;
  const gated = coordinator.gatedFetch(commandcodeScope, inner);
  const response = await gated('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  events.push('headers');
  const reader = response.body!.getReader();
  await reader.read();
  events.push(`pending:${d.fleet.snapshot().inferences}`);
  while (!(await reader.read()).done) { /* drain to terminal */ }
  events.push('done');
  assert.deepEqual(events, ['headers', 'pending:1', 'done']);
  assert.equal(d.fleet.snapshot().inferences, 0);
});

/**
 * Bounds a gate await: a gate that wrongly admits must fail the assertion promptly instead of
 * hanging the suite (with the fleet paused, the wrong path can block forever in admit()). The
 * timer is cleared on settle, so the correct, immediate rejection carries no added delay.
 */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`gated request neither refused nor settled within ${ms}ms`)); }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** The gate must refuse an unverified request as an auth QuotaError; a bound timeout must not count. */
const isAuthRefusal = (error: unknown): boolean => error instanceof QuotaError && error.code === 'auth';

test('the gate never forwards on missing identity or origin drift', async () => {
  let calls = 0;
  const inner = (async () => { calls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  await assert.rejects(() => settlesWithin(coordinator.gatedFetch(commandcodeScope, inner)('https://evil.example/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } }), 1_000), isAuthRefusal);
  await assert.rejects(() => settlesWithin(coordinator.gatedFetch({ ...commandcodeScope, credential: 'k9' }, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } }), 1_000), isAuthRefusal);
  assert.equal(calls, 0);
  assert.equal(d.fleet.snapshot().state, 'open');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'identity');
});

test('release happens exactly once on stream error', async () => {
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  const aborting = (async () => new Response(streamOf(['a'], { fail: true }), { status: 200 })) as unknown as typeof fetch;
  const response = await coordinator.gatedFetch(commandcodeScope, aborting)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  await assert.rejects(() => response.text());
  assert.equal(d.fleet.snapshot().inferences, 0);
  assert.equal(d.fleet.snapshot().state, 'open');
});

test('the lease is released before the consumer observes a mid-stream error', async () => {
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  let fail: () => void = () => {};
  const gate = new Promise<void>((resolve) => { fail = resolve; });
  // The failure lands while the consumer's read is already pending, so the lease state
  // observed by the rejection reaction is exactly the state at terminal delivery.
  const inner = (async () => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) { await gate; controller.error(new Error('late stream failure')); },
  }), { status: 200 })) as unknown as typeof fetch;
  const response = await coordinator.gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  const reader = response.body!.getReader();
  const atError: Array<{ inferences: number; message?: string }> = [];
  const observed = new Promise<void>((resolve) => {
    void reader.read().then(
      () => { atError.push({ inferences: -1 }); resolve(); },
      (error: Error) => { atError.push({ inferences: d.fleet.snapshot().inferences, message: error.message }); resolve(); },
    );
  });
  assert.equal(d.fleet.snapshot().inferences, 1);
  fail();
  await observed;
  assert.deepEqual(atError, [{ inferences: 0, message: 'late stream failure' }]);
  assert.equal(d.fleet.snapshot().inferences, 0);
});

test('the gate forwards the pinned destination with redirect error and the verified headers', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const inner = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(streamOf(['a']), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const gated = new GuardCoordinator(d).gatedFetch(commandcodeScope, inner);
  const response = await gated('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://api.commandcode.ai/provider/v1/chat/completions');
  assert.equal(seen[0]!.init?.redirect, 'error');
  assert.equal(new Headers(seen[0]!.init?.headers).get('authorization'), 'Bearer k1');
  // A destination pinned for a different provider is never first-party for this attempt.
  const codex = { providerId: 'openai-codex', scope: 'account', accountId: 'acct-1', credential: 'k1' } as const;
  await assert.rejects(() => new GuardCoordinator(d).gatedFetch(codex, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1', 'chatgpt-account-id': 'acct-1' } }));
  assert.equal(seen.length, 1);
  await response.body!.cancel();
});

test('the gate accepts a Request and forwards it rebuilt on the verified URL', async () => {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, ...(init ? { init } : {}) });
    return new Response(streamOf(['a']), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const gated = new GuardCoordinator(d).gatedFetch(commandcodeScope, inner);
  const request = new Request('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' }, body: 'x' });
  const response = await gated(request);
  assert.equal(seen.length, 1);
  const forwarded = seen[0]!.input;
  assert.ok(forwarded instanceof Request);
  assert.equal(forwarded.url, 'https://api.commandcode.ai/provider/v1/chat/completions');
  assert.equal(forwarded.method, 'POST');
  assert.equal(await forwarded.text(), 'x');
  assert.equal(seen[0]!.init?.redirect, 'error');
  assert.equal(new Headers(seen[0]!.init?.headers).get('authorization'), 'Bearer k1');
  await response.text();
  await assert.rejects(() => gated(new Request('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k9' } })));
  assert.equal(seen.length, 1);
});

test('consumer cancellation releases the lease exactly once and before the terminal', async () => {
  const fleet = new CountingFleet('root-1');
  const { deps: d } = deps({ fleet });
  const coordinator = new GuardCoordinator(d);
  const inner = (async () => new Response(streamOf(['a', 'b', 'c']), { status: 200 })) as unknown as typeof fetch;
  const response = await coordinator.gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  assert.equal(fleet.snapshot().inferences, 1);
  const cancellation = response.body!.cancel();
  // The release is synchronous with the cancel step, so it precedes any terminal observation.
  assert.equal(fleet.snapshot().inferences, 0);
  await cancellation;
  assert.equal(fleet.releases, 1);
  assert.equal(fleet.snapshot().inferences, 0);
  assert.equal(fleet.snapshot().state, 'open');
});

test('a URL mutated during admission cannot send the credential off-origin', async () => {
  const target = new URL('https://api.commandcode.ai/provider/v1/chat/completions');
  const seen: string[] = [];
  const inner = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(streamOf(['a']), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps({
    // The live URL object is repointed at another origin while the quota read is in flight.
    readQuota: (async () => { target.href = 'https://evil.example/v1/chat/completions'; return openSnapshot('provider'); }) as unknown as typeof readQuota,
  });
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(target, { method: 'POST', headers: { authorization: 'Bearer k1' } });
  assert.deepEqual(seen, ['https://api.commandcode.ai/provider/v1/chat/completions']);
  await response.text();
});

test('an aborted signal never reaches the network and holds no lease', async () => {
  let calls = 0;
  const inner = (async () => { calls++; return new Response(streamOf(['a']), { status: 200 }); }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const controller = new AbortController();
  controller.abort();
  const atAbort: Array<{ inferences: number; name: string }> = [];
  await new Promise<void>((resolve) => {
    void new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' }, signal: controller.signal }).then(
      () => { atAbort.push({ inferences: -1, name: 'resolved' }); resolve(); },
      (error: Error) => { atAbort.push({ inferences: d.fleet.snapshot().inferences, name: error.name }); resolve(); },
    );
  });
  assert.deepEqual(atAbort, [{ inferences: 0, name: 'AbortError' }]);
  assert.equal(calls, 0);
  assert.equal(d.fifo.activeAccounts, 0);
});

test('an upstream failure releases the lease even when the proxy is never pulled again', async () => {
  const fleet = new CountingFleet('root-1');
  const { deps: d } = deps({ fleet });
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const inner = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller;
      controller.enqueue(new TextEncoder().encode('a')); // fills the proxy queue: no further pull
    },
  }), { status: 200 })) as unknown as typeof fetch;
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  assert.equal(d.fleet.snapshot().inferences, 1);
  upstream!.error(new Error('upstream failed'));
  // A real macrotask turn: every microtask reaction queued by that failure has since run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fleet.releases, 1);
  assert.equal(d.fleet.snapshot().inferences, 0);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'a');
  await assert.rejects(() => reader.read());
});

test('a malformed authorization header fails closed and pauses identity', async () => {
  let calls = 0;
  const inner = (async () => { calls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const { deps: d } = deps();
  await assert.rejects(
    () => new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1\r\nX-Evil: 1' } }),
    (error: unknown) => error instanceof QuotaError && error.code === 'auth',
  );
  assert.equal(calls, 0);
  assert.equal(d.fleet.snapshot().state, 'open');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'identity');
  assert.equal(d.fleet.snapshot('commandcode').state, 'paused');
});

test('aborting mid-stream releases the lease before the consumer observes the abort', async () => {
  const fleet = new CountingFleet('root-1');
  const { deps: d } = deps({ fleet });
  const controller = new AbortController();
  // The upstream mirrors fetch: pending until its signal aborts, then it fails with the reason.
  const inner = (async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), { status: 200 })) as unknown as typeof fetch;
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' }, signal: controller.signal });
  const reader = response.body!.getReader();
  assert.equal(d.fleet.snapshot().inferences, 1);
  const atAbort: Array<{ inferences: number; name: string }> = [];
  const observed = new Promise<void>((resolve) => {
    void reader.read().then(
      () => { atAbort.push({ inferences: -1, name: 'resolved' }); resolve(); },
      (error: Error) => { atAbort.push({ inferences: d.fleet.snapshot().inferences, name: error.name }); resolve(); },
    );
  });
  controller.abort();
  await observed;
  assert.deepEqual(atAbort, [{ inferences: 0, name: 'AbortError' }]);
  assert.equal(fleet.releases, 1);
  assert.equal(d.fleet.snapshot().inferences, 0);
  assert.equal(d.fleet.snapshot().state, 'open');
});

test('a throwing caller getter rejects before admission and retains no lease', async () => {
  let calls = 0;
  const inner = (async () => { calls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const init: RequestInit = { method: 'POST', headers: { authorization: 'Bearer k1' } };
  Object.defineProperty(init, 'body', { get() { throw new Error('caller getter exploded'); }, enumerable: true });
  await assert.rejects(() => new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)('https://api.commandcode.ai/provider/v1/chat/completions', init));
  assert.equal(calls, 0);
  assert.equal(d.fleet.snapshot().inferences, 0);
  assert.equal(d.fleet.snapshot().active, 0);
  assert.equal(d.fifo.activeAccounts, 0);
});

test('a hostile Request whose method getter throws retains no lease', async () => {
  let calls = 0;
  const inner = (async () => { calls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const hostile = new Request('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  Object.defineProperty(hostile, 'method', { get() { throw new Error('hostile method getter'); } });
  await assert.rejects(() => new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(hostile));
  assert.equal(calls, 0);
  assert.equal(d.fleet.snapshot().inferences, 0);
  assert.equal(d.fleet.snapshot().active, 0);
  assert.equal(d.fifo.activeAccounts, 0);
});

test('the gate preserves inherited Request options onto the forwarded request', async () => {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, ...(init ? { init } : {}) });
    return new Response(streamOf(['a']), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const request = new Request('https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer k1' }, integrity: 'sha256-abc',
      referrer: 'https://api.commandcode.ai/', referrerPolicy: 'no-referrer', credentials: 'include', cache: 'no-cache' });
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(request);
  assert.equal(seen.length, 1);
  const forwarded = seen[0]!.input;
  assert.ok(forwarded instanceof Request, 'a Request destination carries the inherited options');
  assert.equal(forwarded.url, 'https://api.commandcode.ai/provider/v1/chat/completions');
  assert.equal(forwarded.integrity, 'sha256-abc');
  assert.equal(forwarded.referrer, 'https://api.commandcode.ai/');
  assert.equal(forwarded.referrerPolicy, 'no-referrer');
  assert.equal(forwarded.credentials, 'include');
  assert.equal(forwarded.cache, 'no-cache');
  assert.equal(forwarded.method, 'POST');
  await response.text();
});

test('a keepalive POST with a body passes the gate without re-extracting the body', async () => {
  const seen: Array<{ destination: string | URL | Request; init?: RequestInit }> = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ destination: input, ...(init ? { init } : {}) });
    return new Response(streamOf(['a']), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const request = new Request('https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', body: 'x', keepalive: true, headers: { authorization: 'Bearer k1' } });
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(request);
  assert.equal(seen.length, 1);
  const destination = seen[0]!.destination;
  assert.ok(destination instanceof Request);
  assert.equal(destination.url, 'https://api.commandcode.ai/provider/v1/chat/completions');
  assert.equal(destination.keepalive, true);
  assert.equal(await destination.text(), 'x');
  assert.equal(seen[0]!.init?.redirect, 'error');
  assert.equal(d.fleet.snapshot().reason, undefined);
  assert.equal(d.fleet.snapshot().state, 'open');
  await response.text();
});

test('a Request whose url differs at construction fails closed without retaining a lease', async () => {
  let calls = 0;
  const inner = (async () => { calls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const hostile = new Request('https://evil.example/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k1' } });
  // Lies to the origin check, which reads the public accessor; the internal URL is still off-origin.
  Object.defineProperty(hostile, 'url', { get: () => 'https://api.commandcode.ai/provider/v1/chat/completions' });
  await assert.rejects(() => new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(hostile),
    (error: unknown) => error instanceof QuotaError && error.code === 'auth');
  assert.equal(calls, 0);
  assert.equal(d.fleet.snapshot().state, 'open');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'identity');
  assert.equal(d.fleet.snapshot().inferences, 0);
  assert.equal(d.fleet.snapshot().active, 0);
  assert.equal(d.fifo.activeAccounts, 0);
});

test('a caller-supplied init.method wins over the Request method', async () => {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, ...(init ? { init } : {}) });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const request = new Request('https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer k1' } });
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(request,
    { method: 'PATCH', headers: { authorization: 'Bearer k1' } });
  assert.equal(seen.length, 1);
  const forwarded = seen[0]!.input;
  assert.ok(forwarded instanceof Request);
  // fetch semantics: init.method takes precedence over the Request's own method.
  assert.equal(forwarded.method, 'PATCH');
  assert.equal(response.status, 200);
});

test('a caller-supplied init referrer and referrerPolicy survive the gate', async () => {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, ...(init ? { init } : {}) });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const request = new Request('https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer k1' } });
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(request,
    { referrer: 'https://example.test/', referrerPolicy: 'no-referrer', headers: { authorization: 'Bearer k1' } });
  assert.equal(seen.length, 1);
  const forwarded = seen[0]!.input;
  assert.ok(forwarded instanceof Request);
  assert.equal(forwarded.referrer, 'https://example.test/');
  assert.equal(forwarded.referrerPolicy, 'no-referrer');
  assert.equal(response.status, 200);
});

test('a spent Request body is replaced by the caller-supplied replacement body', async () => {
  const seen: Array<{ destination: string | URL | Request; init?: RequestInit }> = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ destination: input, ...(init ? { init } : {}) });
    return new Response(streamOf(['a']), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps();
  const request = new Request('https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', body: 'x', headers: { authorization: 'Bearer k1' } });
  await request.text(); // the caller's own body is already spent
  const response = await new GuardCoordinator(d).gatedFetch(commandcodeScope, inner)(request, { body: 'y' });
  assert.equal(seen.length, 1);
  const destination = seen[0]!.destination;
  assert.ok(destination instanceof Request);
  assert.equal(await destination.text(), 'y');
  assert.equal(d.fleet.snapshot().reason, undefined);
  await response.text();
});

test('public pause latches the shared fleet with the given reason and exposes no fleet', () => {
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  assert.equal('fleet' in coordinator, false); // the latch stays behind the public method
  coordinator.pause('identity');
  assert.equal(d.fleet.snapshot().reason, 'identity');
  assert.equal(d.fleet.snapshot().state, 'paused');
  coordinator.pause('threshold');
  assert.equal(d.fleet.snapshot().reason, 'threshold');
});

test('a pause landing as the fleet wait resolves is not read through', async () => {
  const { deps: d } = deps();
  const states: string[] = [];
  d.readQuota = (async () => { states.push(d.fleet.snapshot().state); return openSnapshot('provider'); }) as unknown as typeof readQuota;
  const coordinator = new GuardCoordinator(d);
  const realWait = d.fleet.wait.bind(d.fleet);
  let pausing = true;
  d.fleet.wait = (async (signal?: AbortSignal) => {
    await realWait(signal);
    if (pausing) { pausing = false; d.fleet.pause('threshold'); } // lands as the wait resolves
  }) as typeof d.fleet.wait;
  const pending = coordinator.admit(commandcodeScope);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(states, [], 'nothing may be read while the fleet is paused');
  await d.fleet.tryResume(async () => true);
  const release = await settlesWithin(pending, 1_000);
  release();
  assert.deepEqual(states, ['open'], 'the read happens only once the fleet is open again');
});

test('no approval is read while the fleet is paused, so nothing pre-resume is replayed', async () => {
  const { deps: d } = deps();
  const states: string[] = [];
  d.readQuota = (async () => { states.push(d.fleet.snapshot().state); return openSnapshot('provider'); }) as unknown as typeof readQuota;
  const coordinator = new GuardCoordinator(d);
  const realEnter = d.fifo.enter.bind(d.fifo);
  d.fifo.enter = (async (account: string, signal?: AbortSignal) => {
    const release = await realEnter(account, signal);
    d.fleet.pause('threshold'); // the pause lands the moment the lane is taken
    return release;
  }) as typeof d.fifo.enter;
  const pending = coordinator.admit(commandcodeScope);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(states, [], 'nothing may be read while the fleet is paused');
  await d.fleet.tryResume(async () => true);
  const release = await settlesWithin(pending, 1_000);
  release();
  assert.deepEqual(states, ['open'], 'the read happens only once the fleet is open again');
});

test('a threshold pause is reported as a threshold blocker, not a bad identity', async () => {
  // A window with 5% headroom trips the pause threshold, so `assess` itself produces the reason
  // (there is no injected assessment to fake it with).
  const exhausted = { ...openSnapshot('provider'), windows: [{ id: 'monthly', used: 95, cap: 100,
    resetAt: new Date(NOW + 3_600_000).toISOString() }] };
  const { deps: d } = deps({ readQuota: (async () => exhausted) as unknown as typeof readQuota });
  await assert.rejects(() => new GuardCoordinator(d).admit(commandcodeScope),
    (error: unknown) => error instanceof QuotaError);
  const after = d.fleet.snapshot('commandcode');
  assert.equal(after.state, 'paused');
  assert.equal(after.reason, 'threshold');
  assert.equal(d.fleet.snapshot().state, 'open');
});

test('identity is read once, so an accessor cannot swap the credential behind the check', async () => {
  const seen: string[] = [];
  let reads = 0;
  const scope: AttemptScope = { providerId: 'commandcode', scope: 'provider',
    get credential(): string { reads++; return reads === 1 ? 'k1' : 'k2'; } };
  const { deps: d } = deps({
    readQuota: (async (auth: { apiKey: string }) => { seen.push(auth.apiKey); return openSnapshot('provider'); }) as unknown as typeof readQuota,
  });
  const coordinator = new GuardCoordinator(d);
  const inner = (async () => new Response(streamOf(['a']), { status: 200 })) as unknown as typeof fetch;
  // Through the gate: the outbound authorization is bound to the credential and the quota read must
  // use the same one. Before the snapshot existed this rejected, because the second live read
  // returned k2 while the request carried k1.
  const response = await settlesWithin(coordinator.gatedFetch(scope, inner)(
    'https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer k1' } }), 1_000);
  await response.text();
  assert.deepEqual(seen, ['k1']);
  assert.equal(reads, 1, 'the caller accessor must be read exactly once');
});

test('a throwing scope accessor fails closed, pauses only its provider, and leaves the lane free', async () => {
  const { deps: d } = deps();
  const coordinator = new GuardCoordinator(d);
  const hostile: AttemptScope = { providerId: 'commandcode', scope: 'provider',
    get credential(): string { throw new Error('hostile accessor'); } };
  await assert.rejects(() => coordinator.admit(hostile),
    (error: unknown) => error instanceof QuotaError && error.code === 'auth');
  assert.equal(d.fleet.snapshot().state, 'open');
  assert.equal(d.fleet.snapshot('commandcode').reason, 'identity');
  assert.equal(d.fifo.activeAccounts, 0);
});

test('a pause landing as the inference lease is acquired re-checks instead of rejecting the attempt', async () => {
  const { deps: d } = deps();
  let reads = 0;
  d.readQuota = (async () => { reads++; return openSnapshot('provider'); }) as unknown as typeof readQuota;
  const coordinator = new GuardCoordinator(d);
  const realEnter = d.fleet.enter.bind(d.fleet);
  let pausing = true;
  d.fleet.enter = (async (kind: 'inference' | 'coding', signal?: AbortSignal) => {
    const release = await realEnter(kind, signal);
    if (pausing) { pausing = false; d.fleet.pause('threshold'); } // the pause lands as the lease exists
    return release;
  }) as typeof d.fleet.enter;
  const pending = coordinator.admit(commandcodeScope);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await Promise.race([pending.then(() => 'settled'), Promise.resolve('waiting')]), 'waiting',
    'a stale approval must not settle the attempt, and an admitted attempt must not be rejected');
  await d.fleet.tryResume(async () => true);
  const release = await settlesWithin(pending, 1_000);
  release();
  assert.equal(reads, 2, 'the resumed attempt is re-checked under the new generation');
  assert.equal(d.fleet.snapshot().inferences, 0, 'no lease is left behind');
});

test('a provider-scoped 404 quota surface refuses that attempt and leaves the fleet open for another provider', async () => {
  const read = (async (auth: { providerId: string }) => {
    if (auth.providerId === 'commandcode') {
      throw new QuotaError('unsupported', undefined,
        "Quota guard: dispatch refused for commandcode - its quota surface is not served here (GET https://api.commandcode.ai/alpha/billing/credits returned HTTP 404).");
    }
    return openSnapshot('provider');
  }) as unknown as typeof readQuota;
  const { deps: d } = deps({ readQuota: read });
  const coordinator = new GuardCoordinator(d);
  const before = d.fleet.snapshot();
  await assert.rejects(() => coordinator.admit(commandcodeScope),
    (error: unknown) => error instanceof QuotaError && error.code === 'unsupported');
  const after = d.fleet.snapshot();
  assert.equal(after.state, 'open', 'a provider-scoped refusal must not pause the shared fleet');
  assert.equal(after.reason, undefined);
  assert.equal(after.generation, before.generation, 'the latch must not even move generation');
  assert.equal(after.active, 0, 'the lane must be released');
  assert.deepEqual(coordinator.unsupportedProviders(), ['commandcode'], 'status() must be able to name it');
  // The regression the blocker is about: the other provider must still be admitted.
  const release = await settlesWithin(coordinator.admit({
    providerId: 'openai-codex', scope: 'account', accountId: 'acct-1', credential: 'k1' }), 1_000);
  release();
  assert.equal(d.fleet.snapshot().active, 0);
  assert.equal(d.fleet.snapshot().state, 'open');
});

test('provider fresh check verifies every retained Codex account before clearing its hold', async () => {
  const account = (accountId: string): AttemptScope => ({ providerId: 'openai-codex', scope: 'account', accountId, credential: 'k1' });
  const { deps: d } = deps({
    readQuota: (async (auth: { providerId: GuardedProvider; accountId?: string }) => {
      if (auth.accountId === 'acct-a') throw new QuotaError('unavailable');
      return { ...openSnapshot('account'), providerId: auth.providerId, accountId: auth.accountId };
    }) as unknown as typeof readQuota,
  });
  const coordinator = new GuardCoordinator(d);
  await assert.rejects(() => coordinator.admit(account('acct-a')));

  const abort = new AbortController();
  const waiting = coordinator.admit(account('acct-b'), abort.signal).then((release) => { release(); return 'admitted'; });
  const resumed = await d.fleet.resumeAutomatic('openai-codex', () => coordinator.freshCheck('openai-codex'));
  abort.abort();
  assert.equal(resumed, false, 'a healthy peer account cannot stand in for the failed account');
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(d.fleet.snapshot('openai-codex').reason, 'unavailable');
});

test('a new account scope arriving during a provider resume check invalidates that check', async () => {
  const account = (accountId: string): AttemptScope => ({ providerId: 'openai-codex', scope: 'account', accountId, credential: 'k1' });
  let accountAReads = 0;
  let finishAccountA: (() => void) | undefined;
  const { deps: d } = deps({
    readQuota: (async (auth: { providerId: GuardedProvider; accountId?: string }) => {
      if (auth.accountId === 'acct-a' && ++accountAReads === 1) throw new QuotaError('unavailable');
      if (auth.accountId === 'acct-a') {
        return new Promise<import('../../src/quota-guard/types.ts').QuotaSnapshot>((resolve) => {
          finishAccountA = () => resolve({ ...openSnapshot('account'), providerId: auth.providerId, accountId: auth.accountId });
        });
      }
      return { ...openSnapshot('account'), providerId: auth.providerId, accountId: auth.accountId };
    }) as unknown as typeof readQuota,
  });
  const coordinator = new GuardCoordinator(d);
  await assert.rejects(() => coordinator.admit(account('acct-a')));

  const resuming = d.fleet.resumeAutomatic('openai-codex', () => coordinator.freshCheck('openai-codex'));
  assert.ok(finishAccountA, 'fresh check must have started the deferred account read');
  const abort = new AbortController();
  const waiting = coordinator.admit(account('acct-b'), abort.signal).then((release) => { release(); return 'admitted'; });
  finishAccountA();
  const resumed = await resuming;
  abort.abort();
  assert.equal(resumed, false, 'a newly retained account must invalidate the in-flight scope snapshot');
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(d.fleet.snapshot('openai-codex').reason, 'unavailable');
});

test('automatic quota failures block only their provider in both directions', async () => {
  const codexScope: AttemptScope = { providerId: 'openai-codex', scope: 'account', accountId: 'acct-1', credential: 'k1' };
  const scopes = [commandcodeScope, codexScope] as const;
  const failures = [
    new QuotaError('unavailable'),
    new QuotaError('auth'),
    new QuotaError('schema'),
    new TypeError('network down'),
  ];
  for (const scope of scopes) for (const failure of failures) {
    const peer = scopes.find((candidate) => candidate.providerId !== scope.providerId)!;
    const readQuotaForScope = (async (auth: { providerId: string }) => {
      if (auth.providerId === scope.providerId) throw failure;
      const quotaScope = auth.providerId === 'openai-codex' ? 'account' : 'provider';
      return { ...openSnapshot(quotaScope), providerId: auth.providerId };
    }) as unknown as typeof readQuota;
    const { deps: d } = deps({ readQuota: readQuotaForScope });
    const coordinator = new GuardCoordinator(d);
    await assert.rejects(() => coordinator.admit(scope));
    assert.equal(d.fleet.snapshot().state, 'open', 'provider failure must not pause the root fleet');
    assert.equal(d.fleet.snapshot(scope.providerId).state, 'paused', 'failing provider must latch locally');
    const expectedReason = failure instanceof QuotaError
      ? failure.code === 'auth' || failure.code === 'schema' ? 'identity' : 'unavailable'
      : 'unavailable';
    assert.equal(d.fleet.snapshot(scope.providerId).reason, expectedReason);
    const release = await d.fleet.enter(peer.providerId, 'inference');
    release();
  }
});

test('an unreadable quota surface refuses dispatch - never an unguarded pass-through', async () => {
  const inner: string[] = [];
  const { deps: d } = deps({ readQuota: (async () => { throw new QuotaError('unsupported'); }) as unknown as typeof readQuota });
  const guarded = new GuardCoordinator(d).gatedFetch(commandcodeScope,
    (async (input: string | URL | Request) => { inner.push(String(input)); return new Response('unguarded'); }) as unknown as typeof fetch);
  await assert.rejects(() => guarded('https://api.commandcode.ai/provider/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer k1' } }),
    (error: unknown) => error instanceof QuotaError && error.code === 'unsupported');
  assert.deepEqual(inner, [], 'nothing may reach the network when the quota surface cannot be read');
});

test('status() reports an unsupported provider instead of a merely unavailable one', async () => {
  setQuotaGuardEnabled(true);
  try {
    const runtime = { stream: () => {}, streamSimple: () => {} };
    const fetchImpl = (async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    quotaGuardExtension({ runtime, fetchImpl });
    const binding = quotaGuardRootBinding();
    assert.ok(binding, 'the enabled extension must expose its real root binding');
    await assert.rejects(() => binding.coordinator.admit(commandcodeScope),
      (error: unknown) => (error as { code?: string }).code === 'unsupported');
    const status = quotaGuardControls(runtime)?.status();
    assert.deepEqual(status?.unsupported, ['commandcode']);
    assert.equal(status?.providers.commandcode.unsupported, true);
    assert.equal(status?.providers.commandcode.guard, 'guarded');
    assert.equal(status?.state, 'open', 'the refused provider must not have paused the fleet');
    assert.equal(status?.reason, undefined);
  } finally {
    await resetQuotaGuardStateForTest();
    setQuotaGuardEnabled(false);
  }
});
