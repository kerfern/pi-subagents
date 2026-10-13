/**
 * Quota-guard root controls.
 *
 * Default-disabled and inert: importing this module does no I/O, resolves no
 * credentials and decorates nothing. `quotaGuardExtension` returns immediately
 * when the legacy setting is false and no provider is explicitly enabled; provider
 * toggles and the legacy setting determine which providers install.
 *
 * The host is a single object carrying the public surfaces this package needs:
 * a command-registration function, a runtime handle exposing `stream` /
 * `streamSimple`, the coordinator it gates through, and the fleet latch the
 * controls observe. Nothing private is read; a handle that lacks any of these
 * is refused rather than guessed at.
 */

import type { CodexLimit } from './adapters.ts';
import type { FleetSnapshot, FleetState, GuardTarget as FleetTarget, PauseReason, ProviderFleetSnapshot } from './controller.ts';
import { findRuntimeHook, installGuardedRuntimeViaHook } from './host-hook.ts';
import { DEFAULT_POLICY, validateReserveSeed } from './policy.ts';
import { type GatedCoordinator, type GuardRuntime, installQuotaGuard } from './root.ts';
import { createQuotaGuardCoordinator, type RootBinding } from './root-binding.ts';
import { openStore } from './store.ts';
import type { GuardedProvider } from './types.ts';
import { CheckpointUnavailableError, RootWake, type WakeCheck } from './wake.ts';

/** The fleet surface the controls observe; satisfied by the public `FleetLatch`. */
export interface QuotaGuardFleet {
  snapshot(): Readonly<FleetSnapshot>;
  snapshot(providerId: GuardedProvider): Readonly<ProviderFleetSnapshot>;
  pause(reason: PauseReason): void;
  pauseManual(target: FleetTarget): void;
  resume(
    target: FleetTarget,
    freshCheck?: (providerId: GuardedProvider) => Promise<boolean>,
    beforeClearManual?: (commitManual: () => boolean) => Promise<boolean>,
    /** Await state restoration after the manual fence is captured, before any quota checks. */
    prepare?: () => Promise<boolean>,
  ): Promise<boolean>;
  tryResume(freshCheck: () => Promise<boolean>): Promise<boolean>;
}

/** Wake status and explicit legacy-manual convergence, when a durable wake is installed. */
export interface QuotaGuardWake {
  resumeManual?(commitManual?: () => boolean): Promise<boolean>;
  status(): Readonly<{
    state: string;
    backoffIndex?: number;
    wakeAt?: string;
    /** False when the reported pause was never written; absent means the surface does not say. */
    durable?: boolean;
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
  /**
   * Operator-asserted per-window reserve units, filling only a reserve the estimator cannot compute.
   * A host field wins over the settings-supplied `config`, the same way `stateDir` and `codexLimits` do.
   */
  reserveUnits?: ReadonlyMap<string, number>;
  /** Unwrapped transport for the quota reads themselves; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Fresh quota check used only for enabled providers with automatic holds; absent means refusal. */
  freshCheck?: (providerId?: GuardedProvider) => Promise<boolean>;
  rootId?: string;
  /** Durable state directory for the wake machine; absent means no durable wake is recorded. */
  stateDir?: string;
  /** Source the harness runtime hook is published on; defaults to `globalThis`. Injectable for tests. */
  hookSource?: object;
}

export interface QuotaGuardReserveSeedStatus {
  id: string;
  units: number;
  source: 'operator';
}

export interface QuotaGuardProviderStatus {
  guard: 'guarded' | 'unguarded';
  state: FleetState | 'unknown';
  manualTarget?: GuardTarget;
  automaticReason?: PauseReason;
  unsupported: boolean;
  /** Configured operator seeds are fallback-only; observed reserves take precedence. */
  reserveSeeds: readonly QuotaGuardReserveSeedStatus[];
}

export interface QuotaGuardStatus {
  enabled: boolean;
  installed: boolean;
  state: string;
  reason?: string;
  active: number;
  inferences: number;
  coding: number;
  providers: Readonly<Record<GuardedProvider, QuotaGuardProviderStatus>>;
  /**
   * Providers the guard refuses because it cannot read their quota surface here (HTTP 404 on a quota
   * route). A diagnostic, not a latch: the fleet stays open for every other provider. Present only
   * when at least one provider is in that state, so it can never be confused with `state: paused`.
   */
  unsupported?: readonly string[];
  wake: { state: string; backoffIndex?: number; wakeAt?: string; durable?: boolean } | null;
}

export type GuardTarget = 'all' | 'codex' | 'commandcode';

export interface QuotaGuardControls {
  enable(): void;
  pause(target?: GuardTarget): void;
  resume(target?: GuardTarget): Promise<boolean>;
  status(): QuotaGuardStatus;
  dispose(): void;
}

const DEFAULT_GUARDED_PROVIDERS: readonly GuardedProvider[] = Object.freeze(['openai-codex', 'commandcode']);

function fleetTarget(target: GuardTarget): FleetTarget {
  if (target === 'codex') return 'openai-codex';
  return target;
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

/**
 * Providers the coordinator has refused as unsupported, read through its public accessor.
 *
 * A host-supplied coordinator and the root's own are both possible owners; the root's is consulted
 * when the host carries none, which is the normal case. Read structurally and defensively: this is a
 * diagnostic on top of a working guard, so an object without the accessor simply reports nothing -
 * it must never throw out of `status()` and leave an operator with no status at all.
 */
function unsupportedOf(host: QuotaGuardHost): readonly string[] {
  const coordinator: unknown = host.coordinator ?? rootBinding?.coordinator;
  const read = (coordinator as { unsupportedProviders?: () => readonly string[] } | undefined)?.unsupportedProviders;
  if (typeof read !== 'function') return [];
  try { return read.call(coordinator); } catch { return []; }
}

function statusOf(
  host: QuotaGuardHost,
  installed: boolean,
  guardedProviders: readonly GuardedProvider[],
  reserveUnits?: ReadonlyMap<string, number>,
): QuotaGuardStatus {
  const snap = host.fleet?.snapshot();
  const wake = host.wake?.status() ?? null;
  const unsupported = unsupportedOf(host);
  // Match the estimator's all-or-nothing rule; never advertise a subset of a rejected seed map.
  const validReserveUnits = validateReserveSeed(reserveUnits);
  const guarded = new Set(guardedProviders);
  const providerStatus = (providerId: GuardedProvider): QuotaGuardProviderStatus => {
    const provider = host.fleet?.snapshot(providerId);
    const reserveSeeds: QuotaGuardReserveSeedStatus[] = [];
    for (const [id, units] of validReserveUnits ?? []) {
      const belongsToProvider = providerId === 'openai-codex'
        ? id.endsWith('.primary_window') || id.endsWith('.secondary_window')
        : id === 'monthly' || id === 'fiveHour' || id === 'weekly';
      if (belongsToProvider && Number.isFinite(units) && units > 0) {
        reserveSeeds.push({ id, units, source: 'operator' });
      }
    }
    return {
      guard: guarded.has(providerId) ? 'guarded' : 'unguarded',
      state: provider?.state ?? 'unknown',
      ...(provider?.manualTarget !== undefined && { manualTarget: publicTarget(provider.manualTarget) }),
      ...(provider?.automaticReason !== undefined && { automaticReason: provider.automaticReason }),
      unsupported: unsupported.includes(providerId),
      reserveSeeds,
    };
  };
  return {
    enabled: guarded.size > 0,
    installed,
    state: snap?.state ?? 'unknown',
    ...(snap?.reason !== undefined && { reason: snap.reason }),
    active: snap?.active ?? 0,
    inferences: snap?.inferences ?? 0,
    coding: snap?.coding ?? 0,
    providers: {
      'openai-codex': providerStatus('openai-codex'),
      commandcode: providerStatus('commandcode'),
    },
    ...(unsupported.length ? { unsupported } : {}),
    wake: wake && {
      state: wake.state,
      ...(wake.backoffIndex !== undefined && { backoffIndex: wake.backoffIndex }),
      ...(wake.wakeAt !== undefined && { wakeAt: wake.wakeAt }),
      // Carried through so a pause the wake machine refused to record can never read as a durable one.
      ...(wake.durable !== undefined && { durable: wake.durable }),
    },
  };
}

function publicTarget(target: FleetTarget): GuardTarget {
  return target === 'openai-codex' ? 'codex' : target;
}

function makeControls(host: QuotaGuardHost, binding: Binding,
  guardedProviders: readonly GuardedProvider[], reserveUnits?: ReadonlyMap<string, number>): QuotaGuardControls {
  const guarded = new Set(guardedProviders);
  return {
    enable: () => { enabled = true; },
    pause: (target = 'all') => { host.fleet?.pauseManual(fleetTarget(target)); },
    resume: async (target = 'all') => {
      const fleet = host.fleet;
      if (!fleet) return false;
      const selected = fleetTarget(target);
      const freshCheck = host.freshCheck;
      return fleet.resume(selected, async (providerId) => {
        if (!guarded.has(providerId)) return true;
        return freshCheck ? freshCheck(providerId) : false;
      }, async (commitManual) => {
        const root = fleet.snapshot();
        const rootAutomatic = selected === 'all' && root.state !== 'open' && root.reason !== 'manual';
        if (rootAutomatic && (!freshCheck || !await fleet.tryResume(() => freshCheck()))) return false;
        const wake = selected === 'all' ? host.wake : undefined;
        return wake?.resumeManual
          ? wake.resumeManual(commitManual)
          : commitManual();
      }, async () => {
        if (selected === 'all' && rootWakeInit) await rootWakeInit;
        return true;
      });
    },
    status: () => statusOf(host, binding.installed === true, guardedProviders, reserveUnits),
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

function resolveCoordinator(host: QuotaGuardHost, config?: QuotaGuardConfig): GatedCoordinator | undefined {
  if (host.coordinator && typeof host.coordinator.gatedFetch === 'function') return host.coordinator;
  const reserveUnits = host.reserveUnits ?? config?.reserveUnits;
  rootBinding ??= createQuotaGuardCoordinator({
    rootId: rootIdOf(host),
    ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    ...(reserveUnits ? { reserveUnits } : {}),
  });
  return rootBinding.coordinator;
}

function install(host: QuotaGuardHost, config?: QuotaGuardConfig): void {
  const coordinator = resolveCoordinator(host, config);
  if (!coordinator) return;
  // The hook path has no host-supplied handle, so lend it the root's own latch: state, active
  // counts and manual pause/resume all read from it. Without this the controls report 'unknown'.
  if (!host.fleet && rootBinding) host.fleet = rootBinding.fleet;
  // The real check a manual resume needs. Only lent when this root is the one that built the
  // coordinator: a host-supplied coordinator keeps its own check, and reading quota through a
  // different coordinator's estimator would calibrate the wrong lane.
  if (rootBinding && coordinator === rootBinding.coordinator) host.freshCheck ??= rootBinding.freshCheck;
  const codexLimits = host.codexLimits ?? config?.codexLimits;
  const reserveUnits = host.reserveUnits ?? config?.reserveUnits;
  const guardedProviders = config?.guardedProviders ?? DEFAULT_GUARDED_PROVIDERS;
  resolveWake(host, config);
  const runtime = host.runtime;
  if (runtime && typeof runtime.stream === 'function' && typeof runtime.streamSimple === 'function') {
    if (bindings.has(runtime)) return;
    bind(host, runtime, installQuotaGuard({
      runtime,
      rootId: rootIdOf(host),
      coordinator,
      ...(codexLimits ? { codexLimits } : {}),
      guardedProviders,
    }), guardedProviders, reserveUnits);
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
    ...(codexLimits ? { codexLimits } : {}),
    guardedProviders,
    ...(host.hookSource !== undefined ? { source: host.hookSource } : {}),
  }).then(
    (dispose: () => void) => bind(host, hookBindingKey, dispose, guardedProviders, reserveUnits),
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
function resolveWake(host: QuotaGuardHost, config?: QuotaGuardConfig): void {
  const stateDir = host.stateDir ?? config?.stateDir;
  if (rootWake || rootWakeInit || !stateDir) return;
  const fleet = rootBinding?.fleet;
  // A host-supplied coordinator is not paired with a root latch, so there is nothing to wake.
  if (!fleet) return;
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
        // Durability ceiling, stated rather than implied: the guard cannot enumerate pending effects
        // yet, so it has no checkpoint to name, and the store refuses a checkpoint-less pause by design
        // (a pause whose interrupted work cannot be named cannot be restored). Returning an empty list
        // would leave that refusal for the store's validation to discover; this raises the reason
        // itself, and the wake machine records it as an unrecorded pause (`status.wake.durable: false`)
        // instead of writing anything. A fresh pause is therefore not durable: after a restart its
        // reason, generation and resume deadline are gone and no pending continuation is restored.
        // See docs/quota-guard-compatibility.md.
        checkpoint: async (): Promise<readonly { id: string; digest: string }[]> => {
          throw new CheckpointUnavailableError(
            `Quota guard: no durable checkpoints for root ${rootId} - the owning component cannot yet `
            + 'enumerate pending effects, so a pause is not recorded and does not survive a restart',
          );
        },
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

function bind(host: QuotaGuardHost, key: object, dispose: () => void,
  guardedProviders: readonly GuardedProvider[], reserveUnits?: ReadonlyMap<string, number>): void {
  const binding = {} as Binding;
  binding.installed = true;
  binding.dispose = dispose;
  binding.controls = makeControls(host, binding, guardedProviders, reserveUnits);
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
  // Provider lines make independent guarding, manual intent, automatic holds and reserve provenance explicit.
  for (const [providerId, label] of [['openai-codex', 'codex'], ['commandcode', 'commandcode']] as const) {
    const provider = status.providers[providerId];
    const details = [`${label}: ${provider.guard}`, `state ${provider.state}`];
    if (provider.manualTarget) details.push(`manual ${provider.manualTarget}`);
    if (provider.automaticReason) details.push(`automatic ${provider.automaticReason}`);
    if (provider.unsupported) details.push('unsupported');
    details.push(provider.reserveSeeds.length
      ? `configured operator reserve seed ${provider.reserveSeeds.map(seed => `${seed.id}=${seed.units}`).join(', ')} (fallback only; observed values take precedence)`
      : 'reserve observed/unknown (no operator seed)');
    parts.push(details.join(', '));
  }
  // Retained for compatibility: a provider the guard cannot read is not the same as a paused fleet.
  if (status.unsupported?.length) parts.push(`unsupported ${status.unsupported.join(', ')}`);
  if (status.wake) {
    parts.push(`wake ${status.wake.state}${status.wake.backoffIndex !== undefined ? ` backoff#${status.wake.backoffIndex}` : ''}${status.wake.wakeAt ? ` @${status.wake.wakeAt}` : ''}${status.wake.durable === false ? ' (not durable)' : ''}`);
  }
  return `Quota guard: ${parts.join(' · ')}`;
}

function registerCommand(host: QuotaGuardHost, config?: QuotaGuardConfig): void {
  if (typeof host.registerCommand !== 'function') return;
  host.registerCommand('quota-guard', {
    description: 'Quota guard: on|off|pause|resume [all|codex|commandcode], or show status',
    handler: async (args: string, ctx?: unknown) => {
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? 'status';
      const targetToken = tokens[1];
      const validTargets: readonly string[] = ['all', 'codex', 'commandcode'];
      const invalidTarget = (sub === 'pause' || sub === 'resume' || sub === 'on' || sub === 'off')
        && (tokens.length > 2 || (targetToken !== undefined && !validTargets.includes(targetToken)));
      const controls = quotaGuardControls();
      const runtimeUnavailable = 'Quota guard: not installed; run /quota-guard on [all|codex|commandcode] and restart pi.';
      let message: string;
      if (invalidTarget || (sub === 'enable' && tokens.length > 1)
        || (sub === 'status' && tokens.length > 1)) {
        message = 'Quota guard: invalid target or arguments; use on|off|pause|resume [all|codex|commandcode].';
      } else {
        const publicTarget = (targetToken ?? 'all') as GuardTarget;
        const target = fleetTarget(publicTarget);
        const targetLabel = publicTarget;
        switch (sub) {
          case 'on':
          case 'off': {
            const persist = config?.persistProviderEnabled;
            if (!persist) {
              message = 'Quota guard: persistent settings changes are unavailable in this session.';
              break;
            }
            const result = persist(target, sub === 'on');
            message = result.persisted
              ? `Quota guard ${sub} ${targetLabel} saved; restart pi for it to take effect.`
              : result.message ?? `Quota guard ${sub} ${targetLabel} could not be saved.`;
            break;
          }
          case 'enable':
            if (!controls) {
              message = runtimeUnavailable;
              break;
            }
            controls.enable();
            message = 'Quota guard enabled (applies on the next pi session).';
            break;
          case 'pause':
            if (!controls) {
              message = runtimeUnavailable;
              break;
            }
            controls.pause(publicTarget);
            message = `Quota guard paused (${targetLabel}).`;
            break;
          case 'resume':
            if (!controls) {
              message = runtimeUnavailable;
              break;
            }
            message = (await controls.resume(publicTarget))
              ? `Quota guard resumed (${targetLabel}).`
              : `Quota guard resume refused (${targetLabel}): the applicable holds could not be safely cleared.`;
            break;
          case 'status':
            message = controls ? describe(controls.status()) : 'Quota guard: not installed.';
            break;
          default:
            message = controls ? describe(controls.status()) : 'Quota guard: not installed.';
        }
      }
      const ui = (ctx as { ui?: { notify?: (m: string, t?: string) => void } } | undefined)?.ui;
      if (typeof ui?.notify === 'function') ui.notify(message, 'info');
      else process.stdout.write(`${message}\n`);
    },
  });
}

/**
 * Configuration the guard reads off the host, transported from the persisted settings.
 *
 * Settings-only values the pi API object does not carry arrive as an explicit second argument,
 * rather than by mutating the API object: the host identity
 * is what `commanded`/`bindings` key on, and rewriting it would lose that identity.
 */
export interface QuotaGuardConfig {
  /** Persist provider ON/OFF choices to the current project's settings file. */
  persistProviderEnabled?: (target: FleetTarget, enabled: boolean) => { persisted: boolean; message?: string };
  /** Durable state directory for the wake machine; must be absolute. */
  stateDir?: string;
  /** Verified Codex meter scope. Absent means a Codex attempt is refused, never misattributed. */
  codexLimits?: readonly CodexLimit[];
  /**
   * Operator-asserted per-window reserve units (`quotaGuardReserveUnits`). Consulted ONLY where the
   * estimator has no observation for a window; an observed reserve always wins. Absent keeps an
   * unknown reserve unknown, which keeps the guard closed.
   */
  reserveUnits?: ReadonlyMap<string, number>;
  /** Providers with automatic quota guarding enabled; omitted preserves legacy both-on behavior. */
  guardedProviders?: readonly GuardedProvider[];
}

/**
 * Entry point. An explicit empty provider list overrides legacy enablement. When both providers are
 * off, a persistence callback permits command-only settings control without installing a runtime.
 * Otherwise, the guard is inert unless legacy enablement or a provider is enabled.
 *
 * `config` supplies what the host object cannot (see `QuotaGuardConfig`). A value the host already
 * carries wins, so an explicit host field is never overwritten by the settings.
 */
export function quotaGuardExtension(host: unknown, config?: QuotaGuardConfig): void {
  const guardedProviders = config?.guardedProviders;
  const commandOnly = guardedProviders !== undefined && guardedProviders.length === 0
    && typeof config?.persistProviderEnabled === 'function';
  if (!commandOnly && (guardedProviders !== undefined ? guardedProviders.length === 0 : !enabled)) return;
  if (!host || typeof host !== 'object') return;
  const h = host as QuotaGuardHost;
  if (typeof h.registerCommand === 'function' && !commanded.has(h)) {
    commanded.add(h);
    registerCommand(h, config);
  }
  // Keep the persistent settings command available while both providers are OFF, without creating
  // a coordinator, resolving credentials, looking up the runtime hook, or decorating dispatch.
  if (commandOnly) return;
  install(h, config);
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
