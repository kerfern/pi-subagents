/**
 * production-wiring.test.ts - the one integration test that drives the path PRODUCTION takes.
 *
 * Every other suite exercises a mechanism (the decorator against a hand-built coordinator, the
 * coordinator against a hand-set `freshCheck`, the hook against a stub). Three defects this session
 * survived that green suite because none of them exercised the wiring:
 *
 *   1. a fixture installed the decorator and dispatched on the SAME object, so `receiver === runtime`
 *      and the receiver-identity check could never work in production;
 *   2. identity was derived from a header rather than the credential;
 *   3. `freshCheck` was set only by hand inside tests, so `resume()` was dead in production.
 *
 * So the chain driven here is the real one, end to end:
 *
 *   configured values -> `quotaGuardExtension(host, config)` -> the harness hook (published on an
 *   injected source, as `extensions/runtime-hook.mjs` does) -> the decorated
 *   `ModelRuntime.prototype` -> a dispatch issued through an INSTANCE (never the prototype) -> the
 *   gated transport -> the caller's inner transport.
 *
 * The quota read is provisioned through `host.fetchImpl`, so no real network call happens, and the
 * assertion is always on something production observes (a resolved dispatch, the request the
 * provider issued, `status()`) - never on a hand-set seam.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { RUNTIME_HOOK_KEY } from '../../src/quota-guard/host-hook.ts';
import {
  quotaGuardControls,
  quotaGuardExtension,
  quotaGuardRootBinding,
  resetQuotaGuardStateForTest,
  setQuotaGuardEnabled,
  type QuotaGuardConfig,
  type QuotaGuardHost,
} from '../../src/quota-guard/index.ts';
import { codexCredential } from './guard-fixtures.ts';

const ROOT_ID = 'production-wiring-test';
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const COMMANDCODE_URL = 'https://api.commandcode.ai/provider/v1/chat/completions';

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
type Dispatch = (model: unknown, ctx: unknown, options: unknown) => Promise<unknown>;

/** What a live `ModelRuntime` instance carries; the prototype alone has none of it. */
interface FakeInstance { credential: string; callerHeader?: string }

/** Drains the microtask queue the hook-install promise chain settles on. */
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

/** A published harness hook handing over `prototype`, mirroring `extensions/runtime-hook.mjs`. */
function hookSource(prototype: Record<string, unknown>, calls: string[] = []): Record<PropertyKey, unknown> {
  const source: Record<PropertyKey, unknown> = {};
  source[RUNTIME_HOOK_KEY] = {
    async install(decorate: (target: unknown) => unknown) {
      calls.push('install');
      return await decorate({
        prototype,
        host: { name: 'pi-coding-agent', version: '0.0.0-test', packagePath: '/tmp/fake' },
      });
    },
  };
  return source;
}

/** The account id pi-ai's Codex transport derives from the token before it sends anything. */
function accountFromCredential(credential: string): string {
  const segment = credential.split('.')[1] ?? '';
  const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as
    Record<string, { chatgpt_account_id?: string }>;
  return payload['https://api.openai.com/auth']?.chatgpt_account_id ?? '';
}

/**
 * A genuine `ModelRuntime.prototype`: `stream`/`streamSimple`/`getAuth` are its own members, and
 * `getAuth` reads per-instance state a prototype-alone receiver does not have. The dispatch issues
 * its request through the fetch the guard injected - that is how a real provider reaches the gate.
 */
function makePrototype() {
  const seen: { model: unknown; options: Record<string, unknown> }[] = [];
  const prototype: Record<string, unknown> = {};
  prototype.getAuth = async function (this: FakeInstance) {
    return { auth: { apiKey: this.credential, headers: { 'chatgpt-account-id': this.callerHeader } } };
  };
  const dispatch = async function (this: FakeInstance, ...args: unknown[]): Promise<unknown> {
    const model = args[0] as { provider: string };
    const options = (args[2] ?? {}) as { fetch?: typeof fetch };
    seen.push({ model, options: options as unknown as Record<string, unknown> });
    const url = model.provider === 'openai-codex' ? CODEX_URL : COMMANDCODE_URL;
    const headers: Record<string, string> = { authorization: `Bearer ${this.credential}` };
    // The Codex transport overrides `chatgpt-account-id` from the token; the caller header is not
    // what goes on the wire, which is exactly why it must not decide the guard's lane either.
    if (model.provider === 'openai-codex') headers['chatgpt-account-id'] = accountFromCredential(this.credential);
    const response = await options.fetch?.(url, { method: 'POST', headers });
    return (await response?.text()) ?? 'no-fetch-issued';
  };
  prototype.stream = dispatch;
  prototype.streamSimple = dispatch;
  return { prototype, seen };
}

/** The caller-side transport; recording it proves whether the gate was replaced. */
function innerTransport(label: string) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(label, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * The fake quota read for CommandCode: the two billing endpoints `readQuota` consumes. One reset
 * epoch per level, because the estimator resets its samples whenever `resetAt` moves.
 */
function commandcodeBilling(level: { monthly: number; rolling: number }): typeof fetch {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  return (async (input: string | URL | Request) => {
    const json = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (String(input).endsWith('/alpha/billing/credits')) {
      return json({
        credits: { monthlyCredits: 70 - level.monthly },
        windowLimits: {
          fiveHour: { used: level.rolling, cap: 100, exceeded: false, resetAt },
          weekly: { used: level.rolling, cap: 100, exceeded: false, resetAt },
        },
      });
    }
    return json({ data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: resetAt } });
  }) as unknown as typeof fetch;
}

/** Enables the guard over the hook path with a fake quota read, the way settings enable it. */
async function enabledHost(quotaFetch: typeof fetch, config?: QuotaGuardConfig) {
  const { prototype, seen } = makePrototype();
  const hookCalls: string[] = [];
  const host: QuotaGuardHost = {
    rootId: ROOT_ID,
    fetchImpl: quotaFetch,
    hookSource: hookSource(prototype, hookCalls),
  };
  setQuotaGuardEnabled(true);
  quotaGuardExtension(host, config);
  await flush();
  return { prototype, seen, hookCalls, host };
}

/** The live instance a provider dispatches from - never the prototype the hook handed over. */
function instanceOf(prototype: Record<string, unknown>, credential: string, callerHeader?: string) {
  const instance = Object.create(prototype) as FakeInstance & { stream: Dispatch };
  instance.credential = credential;
  if (callerHeader !== undefined) instance.callerHeader = callerHeader;
  return instance;
}

beforeEach(async () => { await resetQuotaGuardStateForTest(); setQuotaGuardEnabled(false); });
afterEach(async () => { await resetQuotaGuardStateForTest(); setQuotaGuardEnabled(false); });

test('flag off: the entry is inert on the real wiring path', async () => {
  const quotaCalls: string[] = [];
  const quotaFetch = (async (input: string | URL | Request) => {
    quotaCalls.push(String(input));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const { prototype } = makePrototype();
  const originalStream = prototype.stream;
  const originalSimple = prototype.streamSimple;
  const hookCalls: string[] = [];
  const registered: string[] = [];
  const host: QuotaGuardHost = {
    rootId: ROOT_ID,
    fetchImpl: quotaFetch,
    hookSource: hookSource(prototype, hookCalls),
    registerCommand: (name) => { registered.push(name); },
  };

  setQuotaGuardEnabled(false);
  quotaGuardExtension(host, { codexLimits: [{ id: 'codex', windows: ['primary_window'] as const }] });
  await flush();

  assert.deepEqual(hookCalls, [], 'a disabled guard must never reach the harness hook');
  assert.deepEqual(registered, [], 'a disabled guard must register no command');
  assert.equal(prototype.stream, originalStream, 'nothing may be decorated while disabled');
  assert.equal(prototype.streamSimple, originalSimple);
  assert.equal(quotaGuardRootBinding(), undefined, 'no coordinator may be built while disabled');
  assert.equal(quotaGuardControls(), undefined);
  assert.deepEqual(quotaCalls, [], 'a disabled guard must make no quota read');
});

test('identity resolves from the dispatching instance and the credential, not the prototype or a header', async () => {
  const quotaHeaders: Headers[] = [];
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const quotaFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    quotaHeaders.push(new Headers(init?.headers));
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: { limit_window_seconds: 18_000, used_percent: 10, reset_at: resetAt },
        secondary_window: { limit_window_seconds: 604_800, used_percent: 10, reset_at: resetAt },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  // Both the meter scope and the reserve arrive as the entry's SECOND argument, as settings send them.
  const { prototype, seen } = await enabledHost(quotaFetch, {
    codexLimits: [{ id: 'codex', windows: ['primary_window', 'secondary_window'] as const }],
    reserveUnits: new Map([['codex.primary_window', 10], ['codex.secondary_window', 10]]),
  });
  const controls = quotaGuardControls();
  assert.ok(controls, 'the hook install must expose the real controls');
  assert.equal(controls.status().installed, true);

  const inner = innerTransport('inner-ok');
  const instance = instanceOf(prototype, codexCredential('acct-token'), 'acct-header');
  const model = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-5' };

  assert.equal(await instance.stream(model, 'ctx', { fetch: inner.fetchImpl }), 'inner-ok',
    'a healthy Codex dispatch through a live instance must reach the inner transport');

  assert.equal(seen.length, 1, 'the provider must have been dispatched');
  assert.notEqual(seen[0].options.fetch, inner.fetchImpl, 'the provider must receive the guard fetch');
  assert.equal(typeof seen[0].options.fetch, 'function');
  assert.deepEqual(inner.calls, [CODEX_URL], 'the gated transport must end at the inner transport');
  assert.equal(quotaHeaders.length, 1, 'exactly one gated quota read');
  // Identity came from the credential's claim. If it came from the header it would read 'acct-header'
  // here - and `classifyFinalRequest` would then refuse the request the transport actually sends.
  assert.equal(quotaHeaders[0].get('chatgpt-account-id'), 'acct-token',
    'the credential must decide the account, never the caller header');

  // ...and the prototype itself cannot answer, because the identity lives on the instance.
  assert.throws(() => (prototype.stream as AnyFn).call(prototype, model, 'ctx', {}),
    /no live runtime receiver/);
  assert.equal(controls.status().reason, 'identity', 'the prototype receiver must latch identity');
});

test('a window over threshold refuses the dispatch and never reaches the inner transport', async () => {
  // monthly headroom is 1/70 = 1.4%, under the 10% pause threshold; no reserve is needed to decide it.
  const { prototype } = await enabledHost(commandcodeBilling({ monthly: 69, rolling: 1 }));
  const inner = innerTransport('inner-ok');
  const instance = instanceOf(prototype, 'cc-credential');
  const model = { provider: 'commandcode', api: 'openai-completions', id: 'cc' };

  await assert.rejects(
    () => instance.stream(model, 'ctx', { fetch: inner.fetchImpl }),
    (error: unknown) => (error as { code?: string }).code === 'unavailable');
  assert.deepEqual(inner.calls, [], 'a refused dispatch must never reach the inner transport');
  const status = quotaGuardControls()?.status();
  assert.equal(status?.state, 'paused');
  assert.equal(status?.reason, 'threshold', 'an exhausted window must not be reported as identity');
});

test('a paused fleet reopens through the real freshCheck and is then admitted for real', async () => {
  const level = { monthly: 1, rolling: 1 };
  const { prototype, seen } = await enabledHost(commandcodeBilling(level));
  const inner = innerTransport('inner-ok');
  const instance = instanceOf(prototype, 'cc-credential');
  const model = { provider: 'commandcode', api: 'openai-completions', id: 'cc' };
  const controls = quotaGuardControls();
  assert.ok(controls, 'the hook install must expose the real controls');

  // Healthy window, but no observation yet: the reserve is unknown, so the guard stays closed.
  await assert.rejects(
    () => instance.stream(model, 'ctx', { fetch: inner.fetchImpl }),
    (error: unknown) => (error as { code?: string }).code === 'unavailable');
  assert.deepEqual(inner.calls, [], 'an unknown reserve must not reach the inner transport');
  assert.equal(controls.status().state, 'paused');
  assert.equal(controls.status().reason, 'reserve');

  // Genuine usage movement calibrates the reserve through resume's OWN freshCheck. Nothing here
  // assigns `host.freshCheck` or `binding.freshCheck`: a dead production check leaves this red.
  level.monthly = 6;
  level.rolling = 6;
  assert.equal(await controls.resume(), true, 'the real freshCheck must reopen the fleet');
  assert.equal(controls.status().state, 'open');

  assert.equal(await instance.stream(model, 'ctx', { fetch: inner.fetchImpl }), 'inner-ok',
    'a reopened fleet must admit the next dispatch');
  assert.equal(seen.length, 2, 'both dispatches must reach the provider');
  assert.notEqual(seen[1].options.fetch, inner.fetchImpl, 'the provider must receive the guard fetch');
  assert.deepEqual(inner.calls, [COMMANDCODE_URL], 'the admitted dispatch ends at the inner transport');
});
