import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installQuotaGuard } from '../../src/quota-guard/root.ts';
import { codexCredential } from './guard-fixtures.ts';
import type { AttemptScope } from '../../src/quota-guard/coordinator.ts';

/** Verified meter scope the Codex path requires; without it a Codex attempt is refused. */
const codexLimits = [{ id: 'codex', windows: ['primary_window', 'secondary_window'] as const }];

/** Stub coordinator: records pauses and the scope/inner it is handed; never performs a request. */
function stubCoordinator() {
  const pauses: string[] = [];
  const gates: { scope: AttemptScope; inner: typeof fetch | undefined }[] = [];
  const gatedFetch = (scope: AttemptScope, inner?: typeof fetch): typeof fetch =>
    async (_input, _init) => {
      gates.push({ scope, inner });
      return new Response('gated', { status: 200 });
    };
  return {
    coordinator: { gatedFetch, pause: (reason: string) => { pauses.push(reason); } },
    pauses, gates,
  };
}

interface Receiver {
  credential?: string;
  accountId?: string;
}
type Prototype = Record<string, unknown> & Receiver;

/**
 * A genuine prototype: `stream`/`streamSimple`/`getAuth` are its own members, and `getAuth` reads
 * per-instance state (`credential`/`accountId`) that exists only on a live instance - so calling it
 * bound to the prototype answers from none of that state.
 */
function makePrototype() {
  const seen: { method: string; args: unknown[] }[] = [];
  const prototype: Prototype = {};
  prototype.getAuth = async function (this: Receiver): Promise<unknown> {
    return { auth: { apiKey: this.credential, headers: { 'chatgpt-account-id': this.accountId } } };
  };
  prototype.stream = function (this: unknown, ...args: unknown[]): unknown {
    seen.push({ method: 'stream', args }); return 'stream-result';
  };
  prototype.streamSimple = function (this: unknown, ...args: unknown[]): unknown {
    seen.push({ method: 'streamSimple', args }); return 'simple-result';
  };
  return { prototype, seen };
}

const forwardedOptions = (seen: { args: unknown[] }[]): Record<string, unknown> =>
  seen[0].args[2] as Record<string, unknown>;

test('a guarded dispatch whose this is the captured prototype is refused', () => {
  const { prototype, seen } = makePrototype();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({
    runtime: prototype as unknown as Parameters<typeof installQuotaGuard>[0]['runtime'],
    rootId: 'root-1', coordinator, codexLimits,
  });
  try {
    // `this` IS the captured prototype: it has a callable getAuth, but none of a live instance's
    // private state, so identity must never be resolved from it.
    const call = prototype.stream as (...args: unknown[]) => unknown;
    assert.throws(
      () => call.call(prototype, { provider: 'openai-codex', api: 'openai-codex-responses', id: 'm' }, 'ctx', {}),
      /no live runtime receiver/);
    assert.deepEqual(pauses, ['identity']);
    assert.equal(seen.length, 0, 'the provider must never be reached');
    assert.equal(gates.length, 0, 'identity is never resolved from the prototype');
  } finally { dispose(); }
});

test('a live instance receiver still resolves identity as before', async () => {
  const { prototype, seen } = makePrototype();
  const { coordinator, gates } = stubCoordinator();
  const dispose = installQuotaGuard({
    runtime: prototype as unknown as Parameters<typeof installQuotaGuard>[0]['runtime'],
    rootId: 'root-1', coordinator, codexLimits,
  });
  try {
    const instance = Object.create(prototype) as Receiver;
    // The account id lives in the credential's claim, exactly as the transport derives it; the
    // header names the same account but is not what identity resolves from.
    const credential = codexCredential('acct-1');
    instance.credential = credential;
    instance.accountId = 'acct-1';
    assert.equal((instance as unknown as { stream: (...a: unknown[]) => unknown })
      .stream({ provider: 'openai-codex', api: 'openai-codex-responses', id: 'm' }, 'ctx', {}), 'stream-result');
    assert.equal(seen.length, 1);
    const gated = forwardedOptions(seen).fetch as typeof fetch;
    await gated('https://chatgpt.com/backend-api/codex/responses', {});
    assert.equal(gates.length, 1);
    assert.equal(gates[0].scope.accountId, 'acct-1');
    assert.equal(gates[0].scope.credential, credential);
  } finally { dispose(); }
});

test('an unguarded provider still passes through when this is the prototype', () => {
  const { prototype, seen } = makePrototype();
  const { coordinator, pauses, gates } = stubCoordinator();
  const dispose = installQuotaGuard({
    runtime: prototype as unknown as Parameters<typeof installQuotaGuard>[0]['runtime'],
    rootId: 'root-1', coordinator, codexLimits,
  });
  try {
    const options = { transport: 'websocket' };
    const call = prototype.stream as (...args: unknown[]) => unknown;
    assert.equal(
      call.call(prototype, { provider: 'anthropic', id: 'm', api: 'anthropic-messages' }, 'ctx', options),
      'stream-result');
    assert.equal(seen.length, 1, 'the passthrough reaches the original');
    assert.equal(seen[0].args[2], options, 'caller options are forwarded unchanged');
    assert.deepEqual(pauses, []);
    assert.equal(gates.length, 0);
  } finally { dispose(); }
});
