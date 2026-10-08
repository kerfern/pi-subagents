import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forceSse, installQuotaGuard } from '../../src/quota-guard/root.ts';
import type { GatedCoordinator } from '../../src/quota-guard/root.ts';
import type { AttemptScope } from '../../src/quota-guard/coordinator.ts';
import type { GuardCoordinator } from '../../src/quota-guard/coordinator.ts';

// Compile-time only: the real coordinator must satisfy the public surface root.ts depends on.
type AssertTrue<T extends true> = T;
type _CoordinatorCompatible = AssertTrue<GuardCoordinator extends GatedCoordinator ? true : false>;

const callerFetch: typeof fetch = async () => new Response('caller', { status: 200 });

/** Verified meter scope the Codex path requires; without it a Codex attempt is refused. */
const codexLimits = [{ id: 'codex', windows: ['primary_window', 'secondary_window'] as const }];

/** Stub coordinator: records the scope/inner it is handed and the pauses it observes. */
function stubCoordinator() {
  const pauses: string[] = [];
  const gates: { scope: AttemptScope; inner: typeof fetch | undefined }[] = [];
  const innerCalls: string[] = [];
  // Never invokes the inner transport: the suite must make no network request.
  const gatedFetch = (scope: AttemptScope, inner?: typeof fetch): typeof fetch =>
    async (input, _init) => {
      gates.push({ scope, inner });
      innerCalls.push(String(input));
      return new Response('gated', { status: 200 });
    };
  return {
    coordinator: {
      gatedFetch,
      pause: (reason: string) => { pauses.push(reason); },
    },
    pauses, gates, innerCalls,
  };
}

function makeRuntime() {
  const seen: { method: string; args: unknown[] }[] = [];
  const runtime = {
    stream: (...args: unknown[]) => { seen.push({ method: 'stream', args }); return 'stream-result'; },
    streamSimple: (...args: unknown[]) => { seen.push({ method: 'streamSimple', args }); return 'simple-result'; },
    getAuth: async (_model: unknown): Promise<unknown> =>
      ({ auth: { apiKey: 'cred-token', headers: { 'chatgpt-account-id': 'acct-1' } } }),
  };
  return { runtime, seen };
}

const forwardedOptions = (seen: { args: unknown[] }[]): Record<string, unknown> =>
  seen[0].args[2] as Record<string, unknown>;

test('forceSse sets only transport and preserves the caller fetch', () => {
  const input = { transport: 'websocket', fetch: callerFetch, keep: 7 };
  const forced = forceSse(input);
  assert.equal(forced.transport, 'sse');
  assert.equal(forced.fetch, callerFetch);
  assert.equal(forced.keep, 7);
  assert.equal(input.transport, 'websocket');
  assert.notEqual(forced, input);
  assert.deepEqual(Object.keys(forced).sort(), ['fetch', 'keep', 'transport']);
});

test('unguarded providers pass through untouched, including their own fetch and transport', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    const options = { transport: 'websocket', fetch: callerFetch };
    assert.equal(runtime.stream({ provider: 'anthropic' }, 'ctx', options), 'stream-result');
    assert.equal(seen[0].args[2], options);            // identical reference, not a copy
    assert.equal(forwardedOptions(seen).transport, 'websocket');
    assert.equal(forwardedOptions(seen).fetch, callerFetch);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('codex is forced to SSE and the transport is replaced by a lazy gated fetch', async () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, gates, innerCalls } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    const options = { transport: 'websocket', fetch: callerFetch };
    assert.equal(runtime.stream({ provider: 'openai-codex', id: 'm', api: 'openai-codex-responses' }, 'ctx', options), 'stream-result');
    const forwarded = forwardedOptions(seen);
    assert.notEqual(forwarded, options);
    assert.equal(forwarded.transport, 'sse');
    assert.notEqual(forwarded.fetch, callerFetch);
    assert.equal(gates.length, 0);                      // scope resolution is deferred to fetch time

    const response = await (forwarded.fetch as typeof fetch)('https://chatgpt.com/backend-api/codex/responses', {});
    assert.equal(response.status, 200);
    assert.equal(gates.length, 1);
    assert.deepEqual(gates[0].scope,
      { providerId: 'openai-codex', scope: 'account', accountId: 'acct-1', credential: 'cred-token', codexLimits });
    assert.equal(gates[0].inner, callerFetch);
    assert.deepEqual(innerCalls, ['https://chatgpt.com/backend-api/codex/responses']);
  } finally { dispose(); }
});

test('commandcode resolves to the provider-wide lane without an account id', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => ({ auth: { apiKey: 'cc-key' } });
  const { coordinator, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    runtime.streamSimple({ provider: 'commandcode', id: 'm', api: 'openai-completions' }, 'ctx', {});
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await gated('https://api.commandcode.ai/v1/chat/completions', {});
    assert.equal(gates.length, 1);
    assert.equal(gates[0].scope.providerId, 'commandcode');
    assert.equal(gates[0].scope.scope, 'provider');
    assert.equal(gates[0].scope.credential, 'cc-key');
    assert.equal('accountId' in gates[0].scope, false);
  } finally { dispose(); }
});

test('missing credential fails closed: pauses identity and never reaches the inner fetch', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => undefined;
  const { coordinator, pauses, gates, innerCalls } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    runtime.stream({ provider: 'commandcode', id: 'm', api: 'openai-completions' }, 'ctx', { fetch: callerFetch });
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await assert.rejects(gated('https://api.commandcode.ai/v1/chat/completions', {}),
      (error: unknown) => (error as { name?: string }).name === 'QuotaError');
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
    assert.deepEqual(innerCalls, []);
  } finally { dispose(); }
});

test('codex without a verified account id fails closed and never calls gatedFetch', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => ({ auth: { apiKey: 'cred-token', headers: {} } });
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    runtime.stream({ provider: 'openai-codex', id: 'm', api: 'openai-codex-responses' }, 'ctx', {});
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await assert.rejects(gated('https://chatgpt.com/backend-api/codex/responses', {}),
      (error: unknown) => (error as { code?: string }).code === 'auth');
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('a rejecting getAuth fails closed instead of admitting', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => { throw new Error('auth backend down'); };
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    runtime.stream({ provider: 'openai-codex', id: 'm', api: 'openai-codex-responses' }, 'ctx', {});
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await assert.rejects(gated('https://chatgpt.com/backend-api/codex/responses', {}),
      (error: unknown) => (error as { name?: string }).name === 'QuotaError');
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('the credential never reaches console output', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => ({ auth: { apiKey: 'super-secret-credential-xyz', headers: { 'chatgpt-account-id': 'acct-1' } } });
  const { coordinator } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  const logged: string[] = [];
  const real = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (...parts: unknown[]): void => { logged.push(parts.map(String).join(' ')); };
  console.log = capture; console.info = capture; console.warn = capture; console.error = capture;
  try {
    runtime.stream({ provider: 'openai-codex', id: 'm', api: 'openai-codex-responses' }, 'ctx', {});
    await (forwardedOptions(seen).fetch as typeof fetch)('https://chatgpt.com/backend-api/codex/responses', {});
  } finally {
    Object.assign(console, real);
    dispose();
  }
  assert.equal(logged.join('\n').includes('super-secret-credential-xyz'), false);
});

test('dispose restores the exact originals and is idempotent', () => {
  const { runtime } = makeRuntime();
  const { coordinator } = stubCoordinator();
  const originalStream = runtime.stream;
  const originalSimple = runtime.streamSimple;
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  assert.notEqual(runtime.stream, originalStream);
  assert.notEqual(runtime.streamSimple, originalSimple);
  dispose();
  assert.equal(runtime.stream, originalStream);
  assert.equal(runtime.streamSimple, originalSimple);
  dispose();
  assert.equal(runtime.stream, originalStream);
  assert.equal(runtime.streamSimple, originalSimple);
});

test('installing over an already-decorated runtime fails closed', () => {
  const { runtime } = makeRuntime();
  const { coordinator } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    assert.throws(() => installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits }), /already decorated/i);
  } finally { dispose(); }
  const disposeAgain = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  disposeAgain();
});

test('a runtime missing a stream method fails closed', () => {
  const { coordinator } = stubCoordinator();
  const broken = { stream: (..._args: unknown[]) => 'x' };
  assert.throws(() => installQuotaGuard({
    runtime: broken as unknown as Parameters<typeof installQuotaGuard>[0]['runtime'],
    rootId: 'root-1', coordinator,
  }), /unavailable/i);
});

test('a fetchImpl is the inner transport when the caller supplies none', async () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, fetchImpl: callerFetch, codexLimits });
  try {
    runtime.stream({ provider: 'openai-codex', id: 'm', api: 'openai-codex-responses' }, 'ctx', {});
    await (forwardedOptions(seen).fetch as typeof fetch)('https://chatgpt.com/backend-api/codex/responses', {});
    assert.equal(gates[0].inner, callerFetch);
  } finally { dispose(); }
});

test('a coordinator without a public pause fails closed instead of silently skipping the pause', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => undefined;
  const gatedFetch = (): typeof fetch => async () => new Response('x', { status: 200 });
  const partial = { gatedFetch } as unknown as GatedCoordinator;
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator: partial, codexLimits });
  try {
    runtime.stream({ provider: 'commandcode', id: 'm', api: 'openai-completions' }, 'ctx', {});
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await assert.rejects(gated('https://api.commandcode.ai/v1/chat/completions', {}), /pause/i);
  } finally { dispose(); }
});

test('the mandatory identity pause reaches the coordinator public pause', async () => {
  const { runtime, seen } = makeRuntime();
  runtime.getAuth = async () => ({ auth: { apiKey: 'cred-token', headers: {} } });
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    runtime.stream({ provider: 'openai-codex', id: 'm', api: 'openai-codex-responses' }, 'ctx', {});
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await assert.rejects(gated('https://chatgpt.com/backend-api/codex/responses', {}));
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('a second runtime reusing an installed wrapper fails closed instead of nesting gates', () => {
  const first = makeRuntime();
  const second = makeRuntime();
  const { coordinator } = stubCoordinator();
  const secondOriginal = second.runtime.stream;
  const dispose = installQuotaGuard({ runtime: first.runtime, rootId: 'root-1', coordinator });
  try {
    (second.runtime as { stream: unknown }).stream = first.runtime.stream;
    assert.throws(() => installQuotaGuard({ runtime: second.runtime, rootId: 'root-2', coordinator }),
      /already decorated/i);
    (second.runtime as { stream: unknown }).stream = secondOriginal;
  } finally { dispose(); }
});

test('an unrecognised effective api is refused instead of dispatched unguarded', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    assert.throws(() => runtime.stream({ provider: 'commandcode', api: 'openai-responses', id: 'm' }, 'ctx', {}),
      /cannot be guarded/);
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
    assert.equal(seen.length, 0, 'the provider must never be reached');
  } finally { dispose(); }
});

test('a supplied anthropic client is refused because it would bypass the injected fetch', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    assert.throws(() => runtime.stream(
      { provider: 'commandcode', api: 'anthropic-messages', id: 'm' }, 'ctx', { client: {} }),
      /cannot be guarded/);
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
    assert.equal(seen.length, 0, 'the provider must never be reached');
  } finally { dispose(); }
});

test('anthropic-messages without a supplied client is guarded normally', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  try {
    runtime.stream({ provider: 'commandcode', api: 'anthropic-messages', id: 'm' }, 'ctx', {});
    assert.equal(typeof forwardedOptions(seen).fetch, 'function');
    assert.notEqual(forwardedOptions(seen).fetch, callerFetch);
    assert.equal(gates.length, 0, 'scope resolution stays deferred to fetch time');
  } finally { dispose(); }
});

test('a client accessor that flips after validation cannot slip past the guard', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  let reads = 0;
  // The attack: the accessor reads as no client while we validate, and as a real client when the
  // provider reads it - so the provider would issue the request itself and never call our fetch.
  const options: Record<string, unknown> = { get client() { reads++; return reads === 1 ? undefined : {}; } };
  try {
    runtime.stream({ provider: 'commandcode', api: 'anthropic-messages', id: 'm' }, 'ctx', options);
    const forwarded = forwardedOptions(seen);
    assert.equal(forwarded.client, undefined, 'the flipped client must never reach the provider');
    assert.equal(typeof forwarded.fetch, 'function');
    assert.notEqual(forwarded.fetch, callerFetch);
    assert.equal(reads, 1, 'the accessor is read exactly once, before validation');
  } finally { dispose(); }
});

test('the provider reads a pinned api, so a getter cannot flip the wire path after validation', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator, codexLimits });
  let reads = 0;
  // Answers allowlisted for the reads the guard makes, then a different api for the provider's read.
  const model = { provider: 'commandcode', id: 'm',
    get api(): string { reads++; return reads <= 2 ? 'openai-completions' : 'anthropic-messages'; } };
  try {
    runtime.stream(model, 'ctx', {});
    const forwarded = seen[0].args[0] as Record<string, unknown>;
    assert.notEqual(forwarded, model, 'the provider must not receive the live model object');
    assert.equal(forwarded.api, 'openai-completions', 'the validated api is pinned for the provider');
    assert.equal(forwarded.api, 'openai-completions', 'and stays pinned on every later read');
    assert.equal(forwarded.provider, 'commandcode');
    // Two reads: one to validate, one for the spread that builds the pinned copy. The provider
    // never makes a third live read - it receives the pinned value - which is the flip this closes.
    assert.equal(reads, 2, 'the api is read only while building the pinned copy');
  } finally { dispose(); }
});

test('codex without a configured meter scope is refused with an actionable error', async () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  try {
    runtime.stream({ provider: 'openai-codex', api: 'openai-codex-responses', id: 'm' }, 'ctx', {});
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await assert.rejects(gated('https://chatgpt.com/backend-api/codex/responses', {}), /codexLimits/);
    assert.deepEqual(pauses, ['identity']);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});
