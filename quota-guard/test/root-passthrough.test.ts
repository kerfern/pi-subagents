import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installQuotaGuard } from '../../src/quota-guard/root.ts';
import type { AttemptScope } from '../../src/quota-guard/coordinator.ts';

/** Stub coordinator: records pauses and never performs a network request. */
function stubCoordinator() {
  const pauses: string[] = [];
  const gates: { scope: AttemptScope; inner: typeof fetch | undefined }[] = [];
  const gatedFetch = (scope: AttemptScope, inner?: typeof fetch): typeof fetch =>
    async (input, _init) => {
      gates.push({ scope, inner });
      return new Response('gated', { status: 200 });
    };
  return {
    coordinator: { gatedFetch, pause: (reason: string) => { pauses.push(reason); } },
    pauses, gates,
  };
}

function makeRuntime() {
  const seen: { method: string; args: unknown[] }[] = [];
  const runtime = {
    stream: (...args: unknown[]) => { seen.push({ method: 'stream', args }); return 'stream-result'; },
    streamSimple: (...args: unknown[]) => { seen.push({ method: 'streamSimple', args }); return 'simple-result'; },
    getAuth: async (_model: unknown): Promise<unknown> => ({ auth: { apiKey: 'k' } }),
  };
  return { runtime, seen };
}

test('a provider getter that flips to a guarded value after the check is refused', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  let reads = 0;
  // The attack: reads unguarded while the guard routes, guarded on the reads that build the copy
  // the provider would receive - which would run the request outside the quota gate.
  const model = { id: 'm', api: 'openai-completions',
    get provider(): string { reads++; return reads === 1 ? 'anthropic' : 'commandcode'; } };
  try {
    assert.throws(() => runtime.stream(model, 'ctx', {}), /changed after the guard check/);
    assert.deepEqual(pauses, ['identity']);
    assert.equal(seen.length, 0, 'the provider must never be reached');
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('a plain unguarded model reaches the original with its fields intact', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  try {
    const options = { transport: 'websocket' };
    const model = { provider: 'anthropic', id: 'm', api: 'anthropic-messages', extra: 7 };
    assert.equal(runtime.stream(model, 'ctx', options), 'stream-result');
    const forwarded = seen[0].args[0] as Record<string, unknown>;
    assert.equal(forwarded.provider, 'anthropic');
    assert.equal(forwarded.api, 'anthropic-messages');
    assert.equal(forwarded.id, 'm');
    assert.equal(forwarded.extra, 7);
    assert.equal(seen[0].args[2], options, 'caller options are forwarded unchanged');
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('a plain unguarded model with a stable provider reaches the original exactly once', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  try {
    runtime.streamSimple({ provider: 'google', id: 'm', api: 'google-generative-ai' }, 'ctx', {});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'streamSimple');
    assert.equal((seen[0].args[0] as Record<string, unknown>).provider, 'google');
  } finally { dispose(); }
});

// The SDK preserves caller-supplied model objects and copies them itself, so a class-backed model
// is a legitimate caller. Rather than refuse it, the guard forwards its own wrapper that pins
// provider/api and delegates every other key, so the pinned values are what the provider reads.
test('a class-backed model with own data provider/api is pinned and dispatched', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  class RealModel { id = 'm'; api = 'anthropic-messages'; provider = 'anthropic'; }
  try {
    assert.equal(runtime.stream(new RealModel(), 'ctx', {}), 'stream-result');
    const forwarded = seen[0].args[0] as Record<string, unknown>;
    assert.equal(forwarded.provider, 'anthropic');
    assert.equal(forwarded.api, 'anthropic-messages');
    assert.equal(forwarded.id, 'm', 'other own fields are still delegated');
    assert.deepEqual(pauses, []);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('a class-backed model with a prototype provider delegates the read then pins it', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  class GetterModel { id = 'm'; api = 'anthropic-messages'; get provider(): string { return 'anthropic'; } }
  try {
    assert.equal(runtime.stream(new GetterModel(), 'ctx', {}), 'stream-result');
    const forwarded = seen[0].args[0] as Record<string, unknown>;
    assert.equal(forwarded.provider, 'anthropic', 'the pinned provider is what the wrapper answers');
    assert.equal(forwarded.id, 'm', 'prototype members still resolve through the wrapper');
    assert.deepEqual(pauses, []);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});

test('a Proxy whose live provider flips to a guarded value cannot route past the pin', () => {
  const { runtime, seen } = makeRuntime();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({ runtime, rootId: 'root-1', coordinator });
  class RealModel { id = 'm'; api = 'anthropic-messages'; provider = 'anthropic'; }
  let reads = 0;
  // The get trap answers unguarded while the guard routes and `commandcode` on later reads - the
  // exact flip the plain-object pin defends against. The pin must win, so the SDK only ever sees
  // `anthropic` and the request never reaches a guarded provider.
  const model = new Proxy(new RealModel(), {
    get(target, key, receiver): unknown {
      if (key === 'provider') { reads++; return reads <= 2 ? 'anthropic' : 'commandcode'; }
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(): PropertyDescriptor {
      return { value: 'anthropic', writable: true, enumerable: true, configurable: true };
    },
  });
  try {
    assert.equal(runtime.stream(model, 'ctx', {}), 'stream-result');
    const forwarded = seen[0].args[0] as Record<string, unknown>;
    assert.equal(forwarded.provider, 'anthropic', 'the pinned provider wins over the live proxy');
    assert.deepEqual(pauses, []);
    assert.equal(gates.length, 0, 'the request must not reach a guarded provider');
  } finally { dispose(); }
});
