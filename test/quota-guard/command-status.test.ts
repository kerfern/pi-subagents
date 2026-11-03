import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  type QuotaGuardConfig,
  type QuotaGuardHost,
  quotaGuardControls,
  quotaGuardExtension,
  quotaGuardRootBinding,
  resetQuotaGuardStateForTest,
  setQuotaGuardEnabled,
} from '../../src/quota-guard/index.ts';
import type { GuardRuntime } from '../../src/quota-guard/root.ts';

type CommandHandler = (args: string, ctx?: unknown) => void | Promise<void>;

function setup(config: QuotaGuardConfig, legacyEnabled: boolean) {
  let command: CommandHandler | undefined;
  const runtime = {
    stream: () => 'original-stream',
    streamSimple: () => 'original-simple',
  } as unknown as GuardRuntime;
  const host: QuotaGuardHost = {
    rootId: 'quota-guard-command-status-test',
    runtime,
    fetchImpl: async () => new Response('{}'),
    registerCommand: (_name, options) => { command = options.handler; },
  };
  setQuotaGuardEnabled(legacyEnabled);
  quotaGuardExtension(host, config);
  return { host, runtime, command: () => command };
}

async function invoke(command: CommandHandler, args: string): Promise<string> {
  const messages: string[] = [];
  await command(args, { ui: { notify: (message: string) => messages.push(message) } });
  return messages[0] ?? '';
}

beforeEach(async () => { await resetQuotaGuardStateForTest(); setQuotaGuardEnabled(false); });
afterEach(async () => { await resetQuotaGuardStateForTest(); setQuotaGuardEnabled(false); });

test('provider-specific enablement installs when the legacy setting is off', () => {
  const { runtime, command } = setup({ guardedProviders: ['openai-codex'] }, false);
  assert.equal(typeof command(), 'function');
  assert.equal(quotaGuardControls(runtime)?.status().enabled, true);
  assert.equal(quotaGuardControls(runtime)?.status().installed, true);
});

test('CommandCode can be enabled independently while Codex remains unguarded', () => {
  const { runtime, command } = setup({ guardedProviders: ['commandcode'] }, false);
  const status = quotaGuardControls(runtime)?.status();
  assert.equal(typeof command(), 'function');
  assert.equal(status?.providers['openai-codex'].guard, 'unguarded');
  assert.equal(status?.providers.commandcode.guard, 'guarded');
});

test('explicitly unguarded providers keep runtime inert even when legacy is on', () => {
  const { runtime, command } = setup({ guardedProviders: [] }, true);
  assert.equal(command(), undefined);
  assert.equal(quotaGuardControls(runtime), undefined);
  assert.equal(quotaGuardRootBinding(), undefined);
});

test('persistent on/off command works while both providers are OFF without installing a runtime', async () => {
  const changes: Array<[string, boolean]> = [];
  let command: CommandHandler | undefined;
  const runtime = {
    stream: () => 'original-stream',
    streamSimple: () => 'original-simple',
  } as unknown as GuardRuntime;
  const host: QuotaGuardHost = {
    rootId: 'quota-guard-command-persistence-test',
    runtime,
    registerCommand: (_name, options) => { command = options.handler; },
  };
  setQuotaGuardEnabled(false);
  quotaGuardExtension(host, {
    guardedProviders: [],
    persistProviderEnabled: (provider, enabled) => {
      changes.push([provider, enabled]);
      return { persisted: true };
    },
  });

  assert.equal(typeof command, 'function');
  assert.equal(quotaGuardControls(runtime), undefined);
  assert.equal(quotaGuardRootBinding(), undefined);
  assert.equal(runtime.stream(), 'original-stream', 'command-only mode must not decorate the runtime');
  assert.match(await invoke(command!, 'on codex'), /saved; restart pi/i);
  assert.match(await invoke(command!, 'on commandcode'), /saved; restart pi/i);
  assert.match(await invoke(command!, 'off all'), /saved; restart pi/i);
  assert.deepEqual(changes, [
    ['openai-codex', true],
    ['commandcode', true],
    ['all', false],
  ]);
  assert.match(await invoke(command!, 'on codex unexpected'), /invalid target or arguments/i);
});

test('command-only mode refuses runtime controls instead of claiming they succeeded', async () => {
  const { runtime, command } = setup({
    guardedProviders: [],
    persistProviderEnabled: () => ({ persisted: true }),
  }, false);
  const handler = command();
  assert.equal(typeof handler, 'function');
  assert.equal(quotaGuardControls(runtime), undefined);
  for (const args of ['pause codex', 'resume codex', 'enable']) {
    assert.match(await invoke(handler!, args), /^Quota guard: not installed/);
  }
});

test('failed persistent writes notify as warnings without claiming session-only activation', async () => {
  const { runtime, command } = setup({
    guardedProviders: [],
    persistProviderEnabled: () => ({
      persisted: false,
      message: 'Quota guard on codex not saved; current session unchanged.',
    }),
  }, false);
  const handler = command();
  assert.equal(typeof handler, 'function');
  const notifications: Array<[string, string?]> = [];

  await handler!('on codex', { ui: { notify: (message: string, level?: string) => notifications.push([message, level]) } });

  assert.match(notifications[0]?.[0] ?? '', /not saved; current session unchanged/i);
  assert.doesNotMatch(notifications[0]?.[0] ?? '', /session only/i);
  assert.equal(notifications[0]?.[1], 'warning');
  assert.equal(quotaGuardControls(runtime), undefined, 'a failed toggle leaves runtime unguarded as before');
});

test('commands target all, Codex, and CommandCode; omitted target aliases all and invalid targets refuse', async () => {
  const { runtime, command } = setup({ guardedProviders: ['openai-codex'] }, true);
  const handler = command();
  const binding = quotaGuardRootBinding();
  assert.equal(typeof handler, 'function');
  assert.ok(binding);

  await invoke(handler!, 'pause codex');
  assert.equal(binding.fleet.snapshot('openai-codex').manual, true);
  assert.equal(binding.fleet.snapshot('commandcode').manual, false);
  await invoke(handler!, 'resume codex');
  assert.equal(binding.fleet.snapshot('openai-codex').manual, false);

  await invoke(handler!, 'pause commandcode');
  assert.equal(binding.fleet.snapshot('commandcode').manual, true);
  await invoke(handler!, 'resume commandcode');
  assert.equal(binding.fleet.snapshot('commandcode').manual, false);

  await invoke(handler!, 'pause all');
  assert.equal(binding.fleet.snapshot('openai-codex').manual, true);
  assert.equal(binding.fleet.snapshot('commandcode').manual, true);
  await invoke(handler!, 'resume all');
  assert.equal(binding.fleet.snapshot('openai-codex').manual, false);
  assert.equal(binding.fleet.snapshot('commandcode').manual, false);

  await invoke(handler!, 'pause');
  assert.equal(binding.fleet.snapshot('openai-codex').manual, true);
  assert.equal(binding.fleet.snapshot('commandcode').manual, true);
  await invoke(handler!, 'resume');
  assert.equal(binding.fleet.snapshot('openai-codex').manual, false);
  assert.equal(binding.fleet.snapshot('commandcode').manual, false);

  const invalid = await invoke(handler!, 'pause codexx');
  assert.match(invalid, /invalid target/i);
  assert.equal(binding.fleet.snapshot().state, 'open');
  assert.ok(quotaGuardControls(runtime));
});

test('status distinguishes provider modes, local holds, and operator reserve provenance', async () => {
  const reserveUnits = new Map([
    ['codex.primary_window', 3],
    ['codex.secondary_window', 3],
  ]);
  const { runtime, command } = setup({ guardedProviders: ['openai-codex'], reserveUnits }, true);
  const binding = quotaGuardRootBinding();
  const controls = quotaGuardControls(runtime);
  assert.ok(binding);
  assert.ok(controls);
  binding.fleet.pauseAutomatic('openai-codex', 'reserve');
  binding.fleet.pauseManual('commandcode');

  const status = controls.status();
  assert.equal(status.enabled, true);
  assert.equal(status.installed, true);
  assert.equal(status.state, 'open', 'provider-local automatic holds must not become a global pause');
  assert.equal(status.providers['openai-codex'].guard, 'guarded');
  assert.equal(status.providers['openai-codex'].automaticReason, 'reserve');
  assert.equal(status.providers.commandcode.guard, 'unguarded');
  assert.equal(status.providers.commandcode.manualTarget, 'commandcode');
  assert.deepEqual(status.providers['openai-codex'].reserveSeeds, [
    { id: 'codex.primary_window', units: 3, source: 'operator' },
    { id: 'codex.secondary_window', units: 3, source: 'operator' },
  ]);

  const handler = command();
  assert.equal(typeof handler, 'function');
  const message = await invoke(handler!, 'status');
  assert.match(message, /codex: guarded/i);
  assert.match(message, /commandcode: unguarded/i);
  assert.match(message, /operator.*codex\.primary_window=3/i);
  assert.match(message, /manual.*commandcode/i);
});

test('status does not advertise valid-looking entries from an all-or-nothing rejected reserve seed', async () => {
  const reserveUnits = new Map([
    ['monthly', 60],
    ['fiveHour', -1],
    ['weekly', 60],
  ]);
  const { runtime, command } = setup({ guardedProviders: ['commandcode'], reserveUnits }, true);
  const controls = quotaGuardControls(runtime);
  assert.ok(controls);

  const status = controls.status();
  assert.deepEqual(status.providers.commandcode.reserveSeeds, []);
  const handler = command();
  assert.equal(typeof handler, 'function');
  const message = await invoke(handler!, 'status');
  assert.doesNotMatch(message, /monthly=60|weekly=60/);
  assert.match(message, /no operator seed/i);
});

// --- restore/checkpoints command surface (#15) -------------------------------------------------
test('restore and checkpoints are wired through the command, and refuse missing arguments', async () => {
  const registered: { name: string; handler: (args: string, ctx?: unknown) => Promise<void> }[] = [];
  const host = {
    registerCommand: (name: string, options: { handler: (args: string, ctx?: unknown) => Promise<void> }) => {
      registered.push({ name, handler: options.handler });
    },
  };
  const restored: string[] = [];
  quotaGuardExtension(host as never, {
    guardedProviders: [],
    persistProviderEnabled: () => ({ persisted: true }),
    restore: async (id) => { restored.push(id); return { ok: true, message: `restored ${id.slice(0, 4)}` }; },
    checkpoints: async () => [{ id: 'a'.repeat(64), createdAt: '2026-11-13T10:00:00.000Z' }],
  });
  const command = registered.find(entry => entry.name === 'quota-guard');
  assert.ok(command);

  const notify: { message: string; level?: string }[] = [];
  const ctx = { ui: { notify: (message: string, level?: string) => { notify.push({ message, level }); } } };

  await command.handler('restore', ctx as never);
  assert.match(notify.at(-1)?.message ?? '', /restore needs exactly one checkpoint id/);

  await command.handler(`restore ${'b'.repeat(64)}`, ctx as never);
  assert.deepEqual(restored, ['b'.repeat(64)]);
  assert.match(notify.at(-1)?.message ?? '', /restored bbbb/);

  await command.handler('checkpoints', ctx as never);
  assert.match(notify.at(-1)?.message ?? '', /aaaaaaaaaaaa…/);
});
