/**
 * root-binding.test.ts - pins the quota guard's ROOT WIRING.
 *
 * The wiring this file locks down (`quotaGuardExtension` -> one root coordinator -> hook install ->
 * lent latch -> `status()`) was originally verified with a throwaway script, which is exactly the
 * unpinned state that let a silent no-op install survive. Each test here fails against a root whose
 * `install()` returns before anything is constructed.
 *
 * `hookSource` lets a test publish the harness hook on a fake object, so nothing here mutates
 * `globalThis`; `stateDir` points the wake machine at an `os.tmpdir()` directory, never the repo.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { RUNTIME_HOOK_KEY } from '../../src/quota-guard/host-hook.ts';
import {
  quotaGuardControls,
  quotaGuardExtension,
  quotaGuardRootBinding,
  resetQuotaGuardStateForTest,
  setQuotaGuardEnabled,
  type QuotaGuardHost,
} from '../../src/quota-guard/index.ts';
import { assess, DEFAULT_POLICY } from '../../src/quota-guard/policy.ts';
import { openStore, type Manifest } from '../../src/quota-guard/store.ts';
import type { QuotaWindow } from '../../src/quota-guard/types.ts';
import { codexCredential } from './guard-fixtures.ts';

const ROOT_ID = 'root-binding-test';
const iso = (ms: number) => new Date(ms).toISOString();

/** Drains the microtask queue the hook-install promise chain settles on. */
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quota-root-binding-'));
  tmpDirs.push(dir);
  return dir;
}

/** Bounded wait for the wake machine (opened store + started) to become observable. */
async function settle(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

function fakeRuntime() {
  const originalStream = async () => 'stream';
  const originalSimple = async () => 'simple';
  const prototype: Record<string, unknown> = { stream: originalStream, streamSimple: originalSimple };
  return { prototype, originalStream, originalSimple };
}

/** The credential the retained scope carries; no durable artifact, log or status may ever show it. */
const CREDENTIAL = 'cc-credential-secret-xyz';

/** An attempt scope the guard retains; CommandCode is provider-wide, so no account id is needed. */
const commandcodeAttempt = () => ({ providerId: 'commandcode', scope: 'provider', credential: CREDENTIAL } as const);

/**
 * One CommandCode billing level: monthly credits plus the rolling windows, all in the payload shapes
 * `readQuota` accepts. Mutating the object between reads is how a test moves real usage.
 */
function commandcodeFetch(level: { monthly: number; rolling: number }): typeof fetch {
  // One reset epoch for the whole level: a real quota window's reset does not move between reads, and
  // the estimator resets its samples on any resetAt change, so a per-request timestamp would hide
  // every delta.
  const resetAt = iso(Date.now() + 3_600_000);
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

/** Enabled guard over a hook, with the given transport, so the real production wiring is exercised. */
async function enabledHost(fetchImpl: typeof fetch, extra: Partial<QuotaGuardHost> = {}): Promise<QuotaGuardHost> {
  const host: QuotaGuardHost = { rootId: ROOT_ID, fetchImpl, hookSource: hookSource(fakeRuntime().prototype), ...extra };
  setQuotaGuardEnabled(true);
  quotaGuardExtension(host);
  await flush();
  return host;
}

/** Every durable byte under a store directory, so a secret cannot hide in a manifest or sidecar. */
async function durableText(dir: string): Promise<string> {
  let text = '';
  for (const name of await readdir(dir, { recursive: true })) {
    text += await readFile(join(dir, name), 'utf8').catch(() => '');
  }
  return text;
}

/** A published harness hook handing over `prototype`, recording each install call. */
function hookSource(prototype: Record<string, unknown>, calls: string[] = []): Record<PropertyKey, unknown> {
  const source: Record<PropertyKey, unknown> = {};
  source[RUNTIME_HOOK_KEY] = {
    async install(decorate: (target: unknown) => unknown) {
      calls.push('install');
      return await decorate({ prototype, host: { name: 'fake', version: '1.0.0', packagePath: '/tmp/fake' } });
    },
  };
  return source;
}

let output: string[] = [];
let restores: Array<() => void> = [];

/** Every test starts from the module's import-inert state; fakes are per-test so nothing else leaks. */
beforeEach(async () => {
  await resetQuotaGuardStateForTest();
  setQuotaGuardEnabled(false);
  output = [];
  // console only: the node:test reporter owns process.stdout (it uses it as its IPC channel).
  const capture = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  const originalError = console.error;
  const originalLog = console.log;
  console.error = capture as typeof console.error;
  console.log = capture as typeof console.log;
  restores = [
    () => { console.error = originalError; },
    () => { console.log = originalLog; },
  ];
});

afterEach(async () => {
  for (const restore of restores) restore();
  restores = [];
  await resetQuotaGuardStateForTest();
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('enabling installs the guard on the prototype the hook hands over', async () => {
  const calls: string[] = [];
  const { prototype, originalStream, originalSimple } = fakeRuntime();
  const host: QuotaGuardHost = { rootId: ROOT_ID, hookSource: hookSource(prototype, calls) };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host);
  await flush();

  assert.deepEqual(calls, ['install'], 'the published hook must be used exactly once');
  assert.notEqual(prototype.stream, originalStream, 'the prototype stream must be decorated');
  assert.notEqual(prototype.streamSimple, originalSimple, 'the prototype streamSimple must be decorated');
  assert.equal(quotaGuardControls()?.status().installed, true, 'installed must be truthful for the hook path');
  assert.equal(host.wake, undefined, 'no stateDir must construct no wake machine');
});

test('status is truthful: state and active come from the root latch, never "unknown"', async () => {
  const { prototype } = fakeRuntime();
  const host: QuotaGuardHost = { rootId: ROOT_ID, hookSource: hookSource(prototype) };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host);
  await flush();

  const binding = quotaGuardRootBinding();
  assert.ok(binding, 'the install must build a root binding');
  const controls = quotaGuardControls();
  assert.ok(controls, 'the hook install must expose controls');
  assert.equal(controls.status().installed, true);
  assert.equal(controls.status().state, 'open', 'the lent latch must report its real state');
  assert.notEqual(controls.status().state, 'unknown');
  assert.equal(host.fleet, binding.fleet, 'the root latch must be lent to the controls');

  const release = await binding.fleet.enter('inference');
  assert.equal(controls.status().active, 1, 'active must be read from the lent root latch');
  release();
  assert.equal(controls.status().active, 0);
});

test('disabled is inert: no hook lookup, nothing decorated, no output, no coordinator', async () => {
  const calls: string[] = [];
  const registered: string[] = [];
  const { prototype, originalStream, originalSimple } = fakeRuntime();
  const host: QuotaGuardHost = {
    rootId: ROOT_ID,
    hookSource: hookSource(prototype, calls),
    registerCommand: (name) => { registered.push(name); },
  };

  setQuotaGuardEnabled(false);
  quotaGuardExtension(host);
  await flush();

  assert.deepEqual(calls, [], 'a disabled guard must never look the hook up');
  assert.deepEqual(registered, [], 'a disabled guard must register no command');
  assert.equal(prototype.stream, originalStream, 'a disabled guard must decorate nothing');
  assert.equal(prototype.streamSimple, originalSimple);
  assert.equal(quotaGuardControls(), undefined, 'no binding may exist while disabled');
  assert.equal(quotaGuardRootBinding(), undefined, 'no coordinator may be constructed while disabled');
  assert.equal(host.fleet, undefined);
  assert.equal(host.wake, undefined);
  assert.deepEqual(output, [], 'a disabled guard must be silent');
});

test('fail closed: enabled with neither a runtime handle nor a hook latches identity and throws', () => {
  const host: QuotaGuardHost = { rootId: ROOT_ID, hookSource: {} };

  setQuotaGuardEnabled(true);
  assert.throws(() => quotaGuardExtension(host), /pi-harness:runtime-hook-v1/);

  const binding = quotaGuardRootBinding();
  assert.ok(binding, 'the coordinator is built before the hook is checked');
  const snapshot = binding.fleet.snapshot();
  assert.notEqual(snapshot.state, 'open', 'a missing hook must latch the fleet closed');
  assert.equal(snapshot.reason, 'identity');
});

test('stability: a second enabled call reuses the one coordinator instead of rebuilding', async () => {
  const { prototype } = fakeRuntime();
  const host: QuotaGuardHost = { rootId: ROOT_ID, hookSource: hookSource(prototype) };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host);
  await flush();

  const first = quotaGuardRootBinding();
  assert.ok(first, 'the first call must build the root binding');
  quotaGuardControls()?.pause('manual');
  assert.equal(first.fleet.snapshot().state, 'paused');

  const other: QuotaGuardHost = { rootId: ROOT_ID, hookSource: hookSource(fakeRuntime().prototype) };
  quotaGuardExtension(other);
  await flush();

  assert.equal(quotaGuardRootBinding(), first, 'a second call must reuse the same coordinator');
  assert.equal(first.fleet.snapshot().state, 'paused', 'rebuilding would have dropped the latch state');
  assert.equal(other.fleet, first.fleet, 'the reused latch must be lent to the second host');
});

test('mode and reserve: the installed latch drives mode and an unseen lane stays null', async () => {
  const { prototype } = fakeRuntime();
  const host: QuotaGuardHost = { rootId: ROOT_ID, hookSource: hookSource(prototype) };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host);
  await flush();

  const binding = quotaGuardRootBinding();
  assert.ok(binding, 'the install must build a root binding');
  // GuardCoordinator publishes neither mode() nor reserve(); the RootBinding exposes the exact latch
  // and estimator those closures delegate to, so the one-line equivalents are asserted against the
  // objects the install actually used.
  const mode = () => (binding.fleet.snapshot().state === 'open' ? 'running' : 'paused');
  assert.equal(mode(), 'running');
  quotaGuardControls()?.pause();
  assert.equal(mode(), 'paused', 'a paused latch must report mode "paused"');
  // The coordinator closes over that very latch: pausing through it moves the root latch.
  binding.coordinator.pause('threshold');
  assert.equal(binding.fleet.snapshot().reason, 'threshold');

  const windows: QuotaWindow[] = [{ id: 'monthly', used: 0, cap: 100, resetAt: iso(Date.now() + 3_600_000) }];
  const reserved = binding.estimator.observe('commandcode:provider', windows);
  for (const window of windows) assert.equal(reserved.get(window.id), null, 'an unseen lane must stay null');
  const assessment = assess(
    { providerId: 'commandcode', scope: 'provider', checkedAt: iso(Date.now()), windows },
    DEFAULT_POLICY,
    'running',
    reserved,
    Date.now(),
  );
  assert.equal(assessment.state, 'wait', 'an unknown reserve must keep the guard closed');
  assert.equal(assessment.reason, 'unknown-reserve');
});

test('stateDir: a persisted pause is reported and survives a fresh binding over the same directory', async () => {
  const dir = await tmpDir();
  const wakeAt = iso(Date.now() + 90_000);
  const seed = await openStore(dir, ROOT_ID);
  const seeded: Omit<Manifest, 'digest'> = {
    version: 1,
    rootId: ROOT_ID,
    generation: 1,
    state: 'paused',
    reason: 'threshold',
    updatedAt: iso(Date.now() - 1_000),
    wakeAt,
    backoffIndex: 1,
    quorum: ['commandcode:provider'],
    checkpoints: [{ id: 'cp', digest: 'deadbeef', generation: 1 }],
  };
  await seed.write(seeded, null);
  await seed.close();

  setQuotaGuardEnabled(true);
  const host: QuotaGuardHost = { rootId: ROOT_ID, stateDir: dir, hookSource: hookSource(fakeRuntime().prototype) };
  quotaGuardExtension(host);
  await flush();
  await settle(() => host.wake !== undefined && quotaGuardControls()?.status().wake !== null);

  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(controls.status().installed, true);
  assert.equal(controls.status().state, 'paused', 'the persisted pause must be reinstated on the root latch');
  assert.equal(controls.status().wake?.state, 'paused', 'real wake state must be reported, not null');
  assert.equal(controls.status().wake?.wakeAt, wakeAt, 'the recorded deadline must survive');
  assert.equal(controls.status().wake?.backoffIndex, 1);

  // A fresh binding (fresh coordinator + fresh wake machine) over the same directory reinstates it.
  await resetQuotaGuardStateForTest();
  setQuotaGuardEnabled(true);
  const second: QuotaGuardHost = { rootId: ROOT_ID, stateDir: dir, hookSource: hookSource(fakeRuntime().prototype) };
  quotaGuardExtension(second);
  await flush();
  await settle(() => second.wake !== undefined && quotaGuardControls()?.status().wake !== null);

  const status = quotaGuardControls()?.status();
  assert.ok(status);
  assert.equal(status.state, 'paused', 'the pause must still be durable after a fresh binding');
  assert.equal(status.wake?.state, 'paused');
  assert.equal(status.wake?.wakeAt, wakeAt);

  // pause/resume drive the shared latch the wake machine reinstated.
  const binding = quotaGuardRootBinding();
  assert.ok(binding);
  quotaGuardControls()?.pause('manual');
  assert.equal(binding.fleet.snapshot().reason, 'manual');
  second.freshCheck = async () => true;
  assert.equal(await quotaGuardControls()?.resume(), true);
  assert.equal(binding.fleet.snapshot().state, 'open');
});

test('without stateDir wake stays null and gating is unaffected', async () => {
  const host: QuotaGuardHost = { rootId: ROOT_ID, hookSource: hookSource(fakeRuntime().prototype) };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host);
  await flush();

  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(host.wake, undefined, 'no stateDir must construct no wake machine');
  assert.equal(controls.status().wake, null, 'wake must be reported as null, never fabricated');
  assert.equal(controls.status().state, 'open', 'gating must be unaffected');

  controls.pause('manual');
  assert.equal(controls.status().state, 'paused', 'pause must still drive the shared latch');
  await flush();
  assert.deepEqual(output, [], 'the documented no-stateDir limitation must not log as a failure');
});

/**
 * Manual resume was dead: `freshCheck` was never assigned in production, so `resume()` returned false
 * unconditionally, and a paused guard could neither be resumed nor calibrate its own reserve (the
 * observation only ever happened inside `admit`, which blocks on the pause). These pin the real check.
 */
test('resume: unchanged usage leaves the reserve unknown, so the fleet stays paused', async () => {
  const level = { monthly: 1, rolling: 1 };
  const host = await enabledHost(commandcodeFetch(level));

  const binding = quotaGuardRootBinding();
  assert.ok(binding, 'the install must build a root binding');
  await assert.rejects(() => binding.coordinator.admit(commandcodeAttempt()));
  assert.equal(binding.fleet.snapshot().reason, 'reserve', 'an unknown reserve must pause the fleet');

  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(await controls.resume(), false, 'an unmoved usage counter must never calibrate a reserve');
  assert.equal(binding.fleet.snapshot().state, 'paused', 'the fleet must stay closed');
  assert.equal(host.freshCheck !== undefined, true, 'the binding must publish a real fresh check');
});

test('resume: genuine usage movement calibrates the reserve and reopens the fleet', async () => {
  const level = { monthly: 1, rolling: 1 };
  await enabledHost(commandcodeFetch(level));

  const binding = quotaGuardRootBinding();
  assert.ok(binding);
  await assert.rejects(() => binding.coordinator.admit(commandcodeAttempt()));
  assert.equal(binding.fleet.snapshot().state, 'paused');

  level.monthly = 5; level.rolling = 5;
  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(await controls.resume(), true, 'a moved window must yield a verified, in-policy reserve');
  assert.equal(binding.fleet.snapshot().state, 'open', 'a passing check must reopen the fleet');
});

test('resume: one unmoved window keeps the reserve unknown, so resume stays false', async () => {
  const level = { monthly: 1, rolling: 1 };
  await enabledHost(commandcodeFetch(level));

  const binding = quotaGuardRootBinding();
  assert.ok(binding);
  await assert.rejects(() => binding.coordinator.admit(commandcodeAttempt()));

  // Only one of the three tracked windows moves; the other two must still refuse the resume.
  level.monthly = 5;
  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(await controls.resume(), false, 'every window must pass, not just the moved one');
  assert.equal(binding.fleet.snapshot().state, 'paused');
});

test('resume: an unreadable retained scope fails closed', async () => {
  const level = { monthly: 1, rolling: 1 };
  const good = commandcodeFetch(level);
  let healthy = true;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => (healthy
    ? good(input, init)
    : Promise.resolve(new Response('nope', { status: 503 })))) as unknown as typeof fetch;
  await enabledHost(fetchImpl);

  const binding = quotaGuardRootBinding();
  assert.ok(binding);
  await assert.rejects(() => binding.coordinator.admit(commandcodeAttempt()));
  assert.equal(binding.fleet.snapshot().state, 'paused');

  healthy = false;
  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(await controls.resume(), false, 'an unreadable quota must never reopen the guard');
  assert.equal(binding.fleet.snapshot().state, 'paused');
});

test('secrets: the retained scope never reaches a durable manifest, the log or status()', async () => {
  const dir = await tmpDir();
  const wakeAt = iso(Date.now() + 90_000);
  const seed = await openStore(dir, ROOT_ID);
  await seed.write({
    version: 1,
    rootId: ROOT_ID,
    generation: 1,
    state: 'paused',
    reason: 'reserve',
    updatedAt: iso(Date.now() - 1_000),
    wakeAt,
    backoffIndex: 1,
    quorum: ['commandcode:provider'],
    checkpoints: [{ id: 'cp', digest: 'deadbeef', generation: 1 }],
  }, null);
  await seed.close();

  const level = { monthly: 1, rolling: 1 };
  const host = await enabledHost(commandcodeFetch(level), { stateDir: dir });
  await settle(() => host.wake !== undefined && quotaGuardControls()?.status().wake !== null);

  const binding = quotaGuardRootBinding();
  assert.ok(binding);
  // The scope is retained before the paused wait, so a check can run outside dispatch.
  const admitted = binding.coordinator.admit(commandcodeAttempt());
  const controls = quotaGuardControls();
  assert.ok(controls);
  assert.equal(await controls.resume(), false, 'the first observation cannot calibrate a reserve');
  level.monthly = 5; level.rolling = 5;
  assert.equal(await controls.resume(), true, 'the second, moved observation must calibrate and reopen');
  const release = await admitted;
  release();

  const raw = await durableText(dir);
  assert.ok(raw.includes('commandcode:provider'), 'the scanned manifest must be the real durable record');
  assert.equal(raw.includes(CREDENTIAL), false, 'no durable file may carry the credential');
  assert.equal(JSON.stringify(controls.status()).includes(CREDENTIAL), false, 'status() must stay secret-free');
  assert.equal(output.join('\n').includes(CREDENTIAL), false, 'the credential must never be logged');
});

/**
 * The documented activation path is a settings file, but the guard reads its configuration off the
 * host object it is handed. These pin the transport: `quotaGuardExtension(host, config)` must make
 * the configured `stateDir` and `codexLimits` reach the code that consumes them, without changing
 * the host identity (`registerCommand` must stay bound to it).
 */
test('transport: a configured stateDir reaches the wake machine', async () => {
  const dir = await tmpDir();
  const wakeAt = iso(Date.now() + 120_000);
  const seed = await openStore(dir, ROOT_ID);
  await seed.write({
    version: 1,
    rootId: ROOT_ID,
    generation: 1,
    state: 'paused',
    reason: 'threshold',
    updatedAt: iso(Date.now() - 1_000),
    wakeAt,
    backoffIndex: 1,
    quorum: ['commandcode:provider'],
    checkpoints: [{ id: 'cp', digest: 'deadbeef', generation: 1 }],
  }, null);
  await seed.close();

  const { prototype } = fakeRuntime();
  const registered: string[] = [];
  const host: QuotaGuardHost = {
    rootId: ROOT_ID,
    hookSource: hookSource(prototype),
    registerCommand: (name) => { registered.push(name); },
  };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host, { stateDir: dir });
  await flush();
  await settle(() => host.wake !== undefined && quotaGuardControls()?.status().wake !== null);

  const wake = quotaGuardControls()?.status().wake;
  assert.equal(wake?.state, 'paused', 'the configured stateDir must be the one the wake machine reads');
  assert.equal(wake?.wakeAt, wakeAt, 'the persisted deadline must be reinstated from that directory');
  assert.deepEqual(registered, ['quota-guard'], 'the command must stay bound to the original host');
});

test('transport: configured codexLimits reach the codex attempt scope', async () => {
  const gates: { providerId: string; codexLimits?: unknown }[] = [];
  const coordinator = {
    gatedFetch: (scope: { providerId: string; codexLimits?: unknown }) => async () => {
      gates.push(scope);
      return new Response('gated', { status: 200 });
    },
    pause: () => {},
  };
  // The original dispatches through the fetch the guard injected; that is the only moment identity
  // is resolved and the meter scope is consumed.
  const dispatch = function (this: unknown, _model: unknown, _ctx: unknown, options: { fetch: typeof fetch }) {
    return options.fetch('https://chatgpt.com/backend-api/wham/usage', {});
  };
  const runtime = { stream: dispatch, streamSimple: dispatch };
  const host: QuotaGuardHost = { rootId: ROOT_ID, runtime, coordinator };
  const limits = [{ id: 'codex', windows: ['primary_window'] as const }];
  const model = { provider: 'openai-codex', api: 'openai-codex-responses' };
  const receiver = { getAuth: async () => ({ auth: { apiKey: codexCredential('acct'), headers: { 'chatgpt-account-id': 'acct' } } }) };

  setQuotaGuardEnabled(true);
  quotaGuardExtension(host, { codexLimits: limits });
  await runtime.stream.call(receiver, model, undefined, {});

  assert.equal(gates.length, 1, 'the codex attempt must reach the gate, not be refused for a missing scope');
  assert.equal(gates[0].providerId, 'openai-codex');
  assert.deepEqual(gates[0].codexLimits, limits, 'the configured scope must be what the guard reads');

  // The contrast: the same host without the configured scope still refuses.
  await resetQuotaGuardStateForTest();
  setQuotaGuardEnabled(true);
  const bare: QuotaGuardHost = { rootId: ROOT_ID, runtime: { stream: dispatch, streamSimple: dispatch }, coordinator };
  quotaGuardExtension(bare);
  await assert.rejects(
    () => (bare.runtime?.stream as (this: unknown, ...args: unknown[]) => unknown).call(receiver, model, undefined, {}),
    /no verified Codex meter scope configured/,
  );
});
