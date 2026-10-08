/**
 * Quota-guard root controls.
 *
 * Default-disabled and inert: importing this module does no I/O, resolves no
 * credentials and decorates nothing. `quotaGuardExtension` returns immediately
 * while `quotaGuardEnabled` is false, and only an operator flipping that
 * setting (or the `/quota-guard enable` subcommand) installs the guard.
 *
 * The host is a single object carrying the public surfaces this package needs:
 * a command-registration function, a runtime handle exposing `stream` /
 * `streamSimple`, the coordinator it gates through, and the fleet latch the
 * controls observe. Nothing private is read; a handle that lacks any of these
 * is refused rather than guessed at.
 */

import type { CodexLimit } from './adapters.ts';
import type { FleetSnapshot, PauseReason } from './controller.ts';
import { findRuntimeHook, installGuardedRuntimeViaHook } from './host-hook.ts';
import { DEFAULT_POLICY } from './policy.ts';
import { type GatedCoordinator, type GuardRuntime, installQuotaGuard } from './root.ts';
import { createQuotaGuardCoordinator, type RootBinding } from './root-binding.ts';
import { openStore } from './store.ts';
import { RootWake, type WakeCheck } from './wake.ts';

/** The fleet surface the controls observe; satisfied by the public `FleetLatch`. */
export interface QuotaGuardFleet {
  snapshot(): Readonly<FleetSnapshot>;
  pause(reason: PauseReason): void;
  tryResume(freshCheck: () => Promise<boolean>): Promise<boolean>;
}

/** The wake surface, when one is installed; only its public `status()` is read. */
export interface QuotaGuardWake {
  status(): Readonly<{
    state: string;
    backoffIndex?: number;
    wakeAt?: string;
  }> | null;
}

/** Public host handle. Every field is optional so a plain disabled call cannot throw. */
export interface QuotaGuardHost {
  registerCommand?(name: string, options: {
    description: string;
    handler: (args: string, ctx?: unknown) => void | Promise<void>;
  }): void;
  /** Runtime handle to decorate; must expose public `stream` and `streamSimple`. */
  runtime?: GuardRuntime;
  /** Coordinator the decorated runtime gates through. */
  coordinator?: GatedCoordinator;
  /** Fleet latch the controls pause/resume/observe. */
  fleet?: QuotaGuardFleet;
  /** Wake/backoff state, when available. */
  wake?: QuotaGuardWake;
  /** Verified Codex meter scope. Absent means a Codex attempt is refused, never misattributed. */
  codexLimits?: readonly CodexLimit[];
  /** Unwrapped transport for the quota reads themselves; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Fresh quota check a manual resume must pass; absent means resume is refused. */
  freshCheck?: () => Promise<boolean>;
  rootId?: string;
  /** Durable state directory for the wake machine; absent means no durable wake is recorded. */
  stateDir?: string;
  /** Source the harness runtime hook is published on; defaults to `globalThis`. Injectable for tests. */
  hookSource?: object;
}

export interface QuotaGuardStatus {
  enabled: boolean;
  installed: boolean;
  state: string;
  reason?: string;
  active: number;
  inferences: number;
  coding: number;
  wake: { state: string; backoffIndex?: number; wakeAt?: string } | null;
}

export interface QuotaGuardControls {
  enable(): void;
  pause(reason?: PauseReason): void;
  resume(): Promise<boolean>;
  status(): QuotaGuardStatus;
  dispose(): void;
}

let enabled = false;

/** The hook path has no runtime object to key on, so its binding uses this sentinel. */
const hookBindingKey = {};

/** Why the last hook installation failed, for an operator who sees 'not installed'. */
let lastInstallFailure: Error | undefined;

/** Exposed so an enabled-but-uninstalled guard can explain itself without console noise. */
export function quotaGuardInstallFailure(): Error | undefined {
  return lastInstallFailure;
}

/** Wired from the persisted `quotaGuardEnabled` setting via `SettingsAppliers`. */
export function setQuotaGuardEnabled(value: boolean): void { enabled = value === true; }
export function isQuotaGuardEnabled(): boolean { return enabled; }

interface Binding { dispose: () => void; controls: QuotaGuardControls; installed: boolean }

/** One binding per runtime handle: a second call reuses it instead of double-decorating. */
const bindings = new WeakMap<object, Binding>();
/** One command registration per host handle. */
const commanded = new WeakSet<object>();
let lastBinding: Binding | undefined;

function statusOf(host: QuotaGuardHost, installed: boolean): QuotaGuardStatus {
  const snap = host.fleet?.snapshot();
  const wake = host.wake?.status() ?? null;
  return {
    enabled,
    installed,
    state: snap?.state ?? 'unknown',
    ...(snap?.reason !== undefined && { reason: snap.reason }),
    active: snap?.active ?? 0,
    inferences: snap?.inferences ?? 0,
    coding: snap?.coding ?? 0,
    wake: wake && {
      state: wake.state,
      ...(wake.backoffIndex !== undefined && { backoffIndex: wake.backoffIndex }),
      ...(wake.wakeAt !== undefined && { wakeAt: wake.wakeAt }),
    },
  };
}

function makeControls(host: QuotaGuardHost, binding: Binding): QuotaGuardControls {
  return {
    enable: () => { enabled = true; },
    pause: (reason = 'manual') => { host.fleet?.pause(reason); },
    resume: async () => {
      if (!host.fleet || !host.freshCheck) return false;
      return host.fleet.tryResume(host.freshCheck);
    },
    status: () => statusOf(host, binding.installed === true),
    dispose: () => {
      binding.installed = false;
      binding.dispose();
      if (host.runtime) bindings.delete(host.runtime);
      if (lastBinding === binding) lastBinding = undefined;
    },
  };
}

/** The coordinator for this root. Built once and reused: rebuilding per call would drop state. */
let rootBinding: RootBinding | undefined;
/** The wake machine for this root, built once, only when a durable `stateDir` was supplied. */
let rootWake: RootWake | undefined;
/** The one in-flight wake construction, so a second enabled call does not race a second store. */
let rootWakeInit: Promise<void> | undefined;

function resolveCoordinator(host: QuotaGuardHost): GatedCoordinator | undefined {
  if (host.coordinator && typeof host.coordinator.gatedFetch === 'function') return host.coordinator;
  rootBinding ??= createQuotaGuardCoordinator({
    rootId: rootIdOf(host),
    ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
  });
  return rootBinding.coordinator;
}

function install(host: QuotaGuardHost): void {
  const coordinator = resolveCoordinator(host);
  if (!coordinator) return;
  // The hook path has no host-supplied handle, so lend it the root's own latch: state, active
  // counts and manual pause/resume all read from it. Without this the controls report 'unknown'.
  if (!host.fleet && rootBinding) host.fleet = rootBinding.fleet;
  resolveWake(host);
  const runtime = host.runtime;
  if (runtime && typeof runtime.stream === 'function' && typeof runtime.streamSimple === 'function') {
    if (bindings.has(runtime)) return;
    bind(host, runtime, installQuotaGuard({
      runtime,
      rootId: rootIdOf(host),
      coordinator,
      ...(host.codexLimits ? { codexLimits: host.codexLimits } : {}),
    }));
    return;
  }
  // No runtime handle was supplied, so the harness hook is the supported route. Checked
  // synchronously and failed closed here: enabling the guard without a way to install it must
  // stop the caller, never leave a guard that believes it is running.
  if (!findRuntimeHook(host.hookSource)) {
    coordinator.pause('identity');
    throw new Error(
      'Quota guard: enabled, but no runtime handle was supplied and the harness runtime hook '
      + '(Symbol.for("pi-harness:runtime-hook-v1")) is not published, so nothing is being gated. '
      + 'Start pi through the harness entry point (runtime/jev-host.mjs), or update it if it '
      + 'predates the hook.',
    );
  }
  if (bindings.has(hookBindingKey)) return;
  // The hook installation is async; capture a failure rather than leaving an unhandled rejection.
  // It latches the fleet, so the failure is never silent to the guard itself.
  void installGuardedRuntimeViaHook({
    coordinator,
    rootId: rootIdOf(host),
    ...(host.codexLimits ? { codexLimits: host.codexLimits } : {}),
    ...(host.hookSource !== undefined ? { source: host.hookSource } : {}),
  }).then(
    (dispose: () => void) => bind(host, hookBindingKey, dispose),
    (error: Error) => {
      lastInstallFailure = error;
      coordinator.pause('identity');
      // Silent-until-inspected is not good enough for an enabled security gate.
      console.error(`Quota guard: enabled but NOT installed for root ${rootIdOf(host)} - nothing is being gated.\n${error.message}`);
    },
  );
}

function rootIdOf(host: QuotaGuardHost): string {
  return host.rootId && host.rootId.length > 0 ? host.rootId : 'quota-guard-root';
}

/**
 * Builds the durable wake machine when the operator supplied a state directory.
 *
 * Without `stateDir` the guard gates exactly as before and `status.wake` stays `null`: that is a
 * documented limitation - there is nowhere durable to record a deadline - not a silent failure.
 */
function resolveWake(host: QuotaGuardHost): void {
  if (rootWake || rootWakeInit || !host.stateDir) return;
  const fleet = rootBinding?.fleet;
  // A host-supplied coordinator is not paired with a root latch, so there is nothing to wake.
  if (!fleet) return;
  const stateDir = host.stateDir;
  const rootId = rootIdOf(host);
  rootWakeInit = (async () => {
    try {
      const store = await openStore(stateDir, rootId);
      const wake = new RootWake({
        fleet,
        store,
        policy: DEFAULT_POLICY,
        now: Date.now,
        // Tracked scopes cannot genuinely be enumerated yet, so a complete quorum cannot be
        // confirmed from a single read. `null` is the honest answer and keeps the root closed;
        // fabricating a quorum could reopen it on evidence nobody verified.
        check: async (): Promise<WakeCheck | null> => null,
        // Nothing is pending checkpointing yet, so the honest checkpoint list is empty. The durable
        // store refuses a checkpoint-less pause by design, so a fresh pause is not persisted yet.
        checkpoint: async () => [],
        // The real timer in production. `unref` keeps a pending deadline from pinning a process that
        // has nothing else to do; RootWake owns cancellation through the returned handle.
        schedule: (delayMs: number, run: () => void) => {
          const timer = setTimeout(run, delayMs);
          timer.unref?.();
          return { cancel: () => clearTimeout(timer) };
        },
        onError: (error: unknown) => {
          lastInstallFailure = error instanceof Error ? error : new Error(String(error));
          console.error(`Quota guard: wake machine error for root ${rootId} - ${String(error)}`);
        },
      });
      rootWake = wake;
      host.wake ??= wake;
      await wake.start();
    } catch (error) {
      // Fail closed: an enabled guard whose durability layer cannot initialise must not look healthy.
      lastInstallFailure = error instanceof Error ? error : new Error(String(error));
      host.fleet?.pause('unavailable');
      console.error(`Quota guard: enabled but the wake machine could not start for root ${rootId} - nothing durable is recorded.\n${String(error)}`);
    }
  })();
}

function bind(host: QuotaGuardHost, key: object, dispose: () => void): void {
  const binding = {} as Binding;
  binding.installed = true;
  binding.dispose = dispose;
  binding.controls = makeControls(host, binding);
  bindings.set(key, binding);
  lastBinding = binding;
}

function describe(status: QuotaGuardStatus): string {
  const parts = [
    status.enabled ? 'enabled' : 'disabled',
    status.installed ? 'installed' : 'not installed',
    `state ${status.state}${status.reason ? ` (${status.reason})` : ''}`,
    `active ${status.active} (inference ${status.inferences}, coding ${status.coding})`,
  ];
  if (status.wake) {
    parts.push(`wake ${status.wake.state}${status.wake.backoffIndex !== undefined ? ` backoff#${status.wake.backoffIndex}` : ''}${status.wake.wakeAt ? ` @${status.wake.wakeAt}` : ''}`);
  }
  return `Quota guard: ${parts.join(' · ')}`;
}

function registerCommand(host: QuotaGuardHost): void {
  if (typeof host.registerCommand !== 'function') return;
  host.registerCommand('quota-guard', {
    description: 'Quota guard: enable, pause, resume or show status',
    handler: async (args: string, ctx?: unknown) => {
      const sub = (args ?? '').trim().split(/\s+/)[0] ?? '';
      const controls = quotaGuardControls();
      let message: string;
      switch (sub) {
        case 'enable':
          controls?.enable();
          message = 'Quota guard enabled (applies on the next pi session).';
          break;
        case 'pause':
          controls?.pause('manual');
          message = 'Quota guard paused.';
          break;
        case 'resume':
          message = (await controls?.resume())
            ? 'Quota guard resumed.'
            : 'Quota guard resume refused: no fresh check available.';
          break;
        default:
          message = controls ? describe(controls.status()) : 'Quota guard: not installed.';
      }
      const ui = (ctx as { ui?: { notify?: (m: string, t?: string) => void } } | undefined)?.ui;
      if (typeof ui?.notify === 'function') ui.notify(message, 'info');
      else process.stdout.write(`${message}\n`);
    },
  });
}

/**
 * Entry point. Inert unless `quotaGuardEnabled` is true: the enabled check is
 * the very first statement, so a disabled call cannot touch the host at all.
 */
export function quotaGuardExtension(host: unknown): void {
  if (!enabled) return;
  if (!host || typeof host !== 'object') return;
  const h = host as QuotaGuardHost;
  if (typeof h.registerCommand === 'function' && !commanded.has(h)) {
    commanded.add(h);
    registerCommand(h);
  }
  install(h);
}

/** Controls for a bound runtime, or the most recent binding when omitted. */
export function quotaGuardControls(runtime?: object): QuotaGuardControls | undefined {
  if (runtime) return bindings.get(runtime)?.controls;
  return lastBinding?.controls;
}

/**
 * Test seam: the live root binding (undefined while import-inert or disabled), so a test asserts
 * against the coordinator and latch the guard actually installed rather than a look-alike.
 */
export function quotaGuardRootBinding(): RootBinding | undefined {
  return rootBinding;
}

/** Test seam: return the module to its import-inert state, dropping the coordinator and wake machine. */
export async function resetQuotaGuardStateForTest(): Promise<void> {
  const pending = rootWakeInit;
  const wake = rootWake;
  rootWakeInit = undefined;
  rootWake = undefined;
  rootBinding = undefined;
  lastBinding = undefined;
  lastInstallFailure = undefined;
  bindings.delete(hookBindingKey);
  enabled = false;
  await pending;
  await wake?.dispose();
}
