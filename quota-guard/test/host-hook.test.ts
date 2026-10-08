import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRuntimeHook, installGuardedRuntimeViaHook, RUNTIME_HOOK_KEY } from '../../src/quota-guard/host-hook.ts';

interface FakeCoordinator { pauses: string[]; scopes: unknown[]; gatedFetch(scope: unknown, inner?: unknown): typeof fetch; pause(reason: string): void }
function fakeCoordinator(): FakeCoordinator {
  const pauses: string[] = [];
  const scopes: unknown[] = [];
  return {
    pauses, scopes,
    pause(reason: string) { pauses.push(reason); },
    gatedFetch(scope: unknown) { scopes.push(scope); return (async () => new Response('gated', { status: 200 })) as typeof fetch; },
  };
}

/** A valid hook whose decorator is whatever the test wants to observe. */
function publishFakeHook(source: Record<PropertyKey, unknown>, decorate: (target: unknown) => (() => void) | undefined) {
  const seen: unknown[] = [];
  source[RUNTIME_HOOK_KEY] = {
    async install(given: (target: unknown) => (() => void) | undefined) {
      const target = { prototype: {}, host: { name: 'fake-host', version: '1.0.0', packagePath: '/tmp/fake' } };
      seen.push(target);
      return await given(target);
    },
  };
  void decorate;
  return seen;
}

test('findRuntimeHook is pure: undefined on a plain object, and it never throws', () => {
  const source: Record<PropertyKey, unknown> = {};
  assert.equal(findRuntimeHook(source), undefined);
  assert.deepEqual(Object.keys(source), [], 'reading the hook must not write to the source');
  source[RUNTIME_HOOK_KEY] = { install: 'not a function' };
  assert.equal(findRuntimeHook(source), undefined, 'a malformed hook is treated as absent');
  source[RUNTIME_HOOK_KEY] = null;
  assert.equal(findRuntimeHook(source), undefined);
});

test('a published hook is found and its shape validated', () => {
  const source: Record<PropertyKey, unknown> = {};
  publishFakeHook(source, () => () => {});
  const hook = findRuntimeHook(source);
  assert.ok(hook, 'a well-formed hook must be found');
  assert.equal(typeof hook.install, 'function');
});

test('an absent hook fails closed: the fleet latches and the error is actionable', async () => {
  const coordinator = fakeCoordinator();
  await assert.rejects(
    () => installGuardedRuntimeViaHook({ coordinator: coordinator as never, rootId: 'root-1', source: {} }),
    (error: Error) => error.message.includes('pi-harness:runtime-hook-v1') && /not published/.test(error.message),
  );
  assert.deepEqual(coordinator.pauses, ['identity'], 'a missing hook must latch the fleet');
  assert.deepEqual(coordinator.scopes, [], 'nothing may be admitted without the hook');
});

test('a malformed hook takes the same fail-closed path', async () => {
  const coordinator = fakeCoordinator();
  const source: Record<PropertyKey, unknown> = { [RUNTIME_HOOK_KEY]: { install: 42 } };
  await assert.rejects(
    () => installGuardedRuntimeViaHook({ coordinator: coordinator as never, rootId: 'root-1', source }),
    /not published/,
  );
  assert.deepEqual(coordinator.pauses, ['identity']);
});

test('with a hook present the guard installs on the handed-over prototype and dispose restores it', async () => {
  const coordinator = fakeCoordinator();
  const originalStream = async () => 'stream-result';
  const originalSimple = async () => 'simple-result';
  const prototype: Record<string, unknown> = { stream: originalStream, streamSimple: originalSimple,
    getAuth: async () => ({ auth: { apiKey: 'k', headers: {} } }) };
  const source: Record<PropertyKey, unknown> = { [RUNTIME_HOOK_KEY]: {
    async install(decorate: (target: unknown) => unknown) {
      return await decorate({ prototype, host: { name: 'fake', version: '1.0.0', packagePath: '/tmp/fake' } });
    },
  } };
  const dispose = await installGuardedRuntimeViaHook({ coordinator: coordinator as never, rootId: 'root-1', source });
  assert.notEqual(prototype.stream, originalStream, 'the prototype method must be decorated');
  assert.notEqual(prototype.streamSimple, originalSimple);
  dispose();
  assert.equal(prototype.stream, originalStream, 'dispose must restore the exact original');
  assert.equal(prototype.streamSimple, originalSimple);
});

test('identity resolves from the dispatching instance, not from the prototype', async () => {
  const coordinator = fakeCoordinator();
  // The prototype deliberately has NO getAuth: only the instance that dispatches does. If the
  // decorator resolved identity from the prototype, this would fail closed instead of admitting.
  // The fake adapter must actually CALL the injected fetch, the way a real adapter does -
  // otherwise the gate is never consulted and the assertion proves nothing.
  const callGated = async (options?: { fetch?: typeof fetch }) => {
    const response = await options?.fetch?.('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST' });
    return (await response?.text()) ?? 'no-fetch-was-used';
  };
  const prototype: Record<string, unknown> = {
    stream: async function (this: unknown, _model: unknown, _ctx: unknown, options?: { fetch?: typeof fetch }) { return await callGated(options); },
    streamSimple: async function (this: unknown, _model: unknown, _ctx: unknown, options?: { fetch?: typeof fetch }) { return await callGated(options); },
  };
  const source: Record<PropertyKey, unknown> = { [RUNTIME_HOOK_KEY]: {
    async install(decorate: (target: unknown) => unknown) {
      return await decorate({ prototype, host: { name: 'fake', version: '1.0.0', packagePath: '/tmp/fake' } });
    },
  } };
  const dispose = await installGuardedRuntimeViaHook({ coordinator: coordinator as never, rootId: 'root-1', source });
  const instance = Object.create(prototype) as Record<string, unknown>;
  instance.getAuth = async () => ({ auth: { apiKey: 'instance-credential' } });
  const result = await (prototype.stream as (this: unknown, ...args: unknown[]) => Promise<unknown>)
    .call(instance, { provider: 'commandcode', api: 'openai-completions', id: 'm' }, 'ctx', {});
  assert.equal(result, 'gated', 'the adapter must receive what the gate returned');
  assert.deepEqual(coordinator.pauses, [], 'the instance identity must be usable');
  assert.equal(coordinator.scopes.length, 1, 'the gate must be consulted exactly once');
  assert.deepEqual(coordinator.scopes[0], { providerId: 'commandcode', scope: 'provider', credential: 'instance-credential' });
  dispose();
});