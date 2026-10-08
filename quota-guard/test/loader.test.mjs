import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { FleetLatch } from '../../src/quota-guard/controller.ts';
import {
  isQuotaGuardEnabled,
  quotaGuardControls,
  quotaGuardExtension,
  setQuotaGuardEnabled,
} from '../../src/quota-guard/index.ts';

/** A host whose every surface throws if read - proves the disabled path touches nothing. */
function trappedHost() {
  const boom = () => { throw new Error('host was touched while disabled'); };
  return {
    get registerCommand() { return boom; },
    get runtime() { return boom; },
    get coordinator() { return boom; },
    get fleet() { return boom; },
    get wake() { return boom; },
    get freshCheck() { return boom; },
    get rootId() { return boom; },
  };
}

function fakeHost() {
  const calls = { commands: [] };
  const stream = function () { return 'original'; };
  const streamSimple = function () { return 'original'; };
  const runtime = { stream, streamSimple };
  const fleet = new FleetLatch('root-1');
  const coordinator = {
    gatedFetch: () => globalThis.fetch,
    pause: (reason) => { fleet.pause(reason); },
  };
  const host = {
    registerCommand: (name, options) => { calls.commands.push({ name, options }); },
    runtime,
    coordinator,
    fleet,
    wake: { status: () => null },
    rootId: 'root-1',
    freshCheck: async () => true,
  };
  return { host, runtime, fleet, calls, originalStream: stream, originalStreamSimple: streamSimple };
}

beforeEach(() => {
  quotaGuardControls()?.dispose();
  setQuotaGuardEnabled(false);
});

test('default-disabled and inert', () => {
  assert.equal(isQuotaGuardEnabled(), false);
  assert.equal(quotaGuardControls(), undefined);
});

test('disabled: no host access, no command, no decoration', () => {
  setQuotaGuardEnabled(false);
  const host = trappedHost();
  assert.doesNotThrow(() => quotaGuardExtension(host));
  assert.equal(quotaGuardControls(), undefined);
});

test('enabled: installs once, registers one command', () => {
  setQuotaGuardEnabled(true);
  const { host, runtime, calls, originalStream, originalStreamSimple } = fakeHost();

  quotaGuardExtension(host);

  assert.notEqual(runtime.stream, originalStream, 'runtime.stream must be decorated');
  assert.notEqual(runtime.streamSimple, originalStreamSimple, 'runtime.streamSimple must be decorated');
  assert.equal(calls.commands.length, 1);
  assert.equal(calls.commands[0].name, 'quota-guard');

  // A second call must not double-install or double-register.
  const decorated = runtime.stream;
  quotaGuardExtension(host);
  assert.equal(runtime.stream, decorated);
  assert.equal(calls.commands.length, 1);
});

test('status after pause reports the pause and active counts', () => {
  setQuotaGuardEnabled(true);
  const { host, runtime, fleet } = fakeHost();
  quotaGuardExtension(host);

  const controls = quotaGuardControls(runtime);
  assert.ok(controls);
  controls.pause('threshold');

  const status = controls.status();
  assert.equal(status.enabled, true);
  assert.equal(status.installed, true);
  assert.equal(status.state, 'paused');
  assert.equal(status.reason, 'threshold');
  assert.equal(status.active, 0);
  assert.equal(status.inferences, 0);
  assert.equal(status.coding, 0);
  assert.equal(fleet.snapshot().reason, 'threshold');
});

test('disposal restores a runtime whose methods were replaced', () => {
  setQuotaGuardEnabled(true);
  const { host, runtime, originalStream, originalStreamSimple } = fakeHost();
  quotaGuardExtension(host);
  const controls = quotaGuardControls(runtime);
  assert.ok(controls);
  assert.notEqual(runtime.stream, originalStream);

  controls.dispose();

  assert.equal(runtime.stream, originalStream);
  assert.equal(runtime.streamSimple, originalStreamSimple);
  assert.equal(quotaGuardControls(runtime), undefined);
});

test('command handler renders the fleet status without secrets', async () => {
  setQuotaGuardEnabled(true);
  const { host, calls } = fakeHost();
  quotaGuardExtension(host);
  const { options } = calls.commands[0];

  const notifications = [];
  await options.handler('status', {
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /^Quota guard: enabled · installed · state open /);
  assert.equal(notifications[0].type, 'info');
});
