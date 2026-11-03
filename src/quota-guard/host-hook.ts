import type { CodexLimit } from './adapters.ts';
import { checkHostCompatibility, compatibilityRefusal } from './compatibility.ts';
import type { Release } from './controller.ts';
import type { GatedCoordinator } from './root.ts';
import { type GuardRuntime, installQuotaGuard } from './root.ts';
import type { GuardedProvider } from './types.ts';

/** The harness publishes this on globalThis after scrubbing credentials and before pi starts. */
export const RUNTIME_HOOK_KEY = Symbol.for('pi-harness:runtime-hook-v1');

/** The host the harness handed over at install time, for records that name what was running. */
let boundHost: { name?: string; version?: string } | undefined;

/** `undefined` means no install happened, so nothing may claim a host identity. */
export function hostIdentity(): { name?: string; version?: string } | undefined {
  return boundHost;
}

export interface HarnessHookTarget {
  prototype: object;
  host: { name: string; version: string; packagePath: string };
}
/**
 * The startup decision the harness barrier blocks dispatch on: both guarded providers named
 * explicitly. The harness derives the declaring file from its own call stack and reports that
 * package's identity beside the decision - a guard-supplied path would only be a claim.
 */
export interface HarnessStartupDeclaration {
  providers: Readonly<Record<GuardedProvider, boolean>>;
}

export interface HarnessRuntimeHook {
  install(decorate: (target: HarnessHookTarget) => Release | Promise<Release> | undefined): Promise<Release>;
  /** Present only on harness builds that gate startup; absence is a refusal, never an implied ready. */
  declareStartup?(request: HarnessStartupDeclaration): Promise<string>;
}

/**
 * Read the harness hook, if the harness is running. Pure: no side effects, never throws.
 * A malformed hook is treated as absent, because a half-built hook must not look installable.
 */
export function findRuntimeHook(source: object = globalThis): HarnessRuntimeHook | undefined {
  const candidate = (source as Record<PropertyKey, unknown>)[RUNTIME_HOOK_KEY];
  if (!candidate || typeof candidate !== 'object') return undefined;
  const install = (candidate as { install?: unknown }).install;
  if (typeof install !== 'function') return undefined;
  return candidate as HarnessRuntimeHook;
}

export interface HookInstallOptions {
  coordinator: GatedCoordinator;
  rootId: string;
  codexLimits?: readonly CodexLimit[];
  guardedProviders?: readonly GuardedProvider[];
  fetchImpl?: typeof fetch;
  source?: object;
  /** Catalogue api ids when the caller can see them; omitted means that contract is unverified. */
  apiIds?: readonly string[];
}

/**
 * Name both guarded providers and the loaded guard entry before anything is installed.
 *
 * Also used for the all-off case: the harness barrier holds both dispatch methods until a startup
 * decision arrives, so silence would abort the launch. A hook that cannot accept the declaration is
 * older than the barrier contract and cannot gate dispatch, so it is refused rather than assumed.
 */
export async function declareStartupViaHook(
  providers: Readonly<Record<GuardedProvider, boolean>>,
  source: object = globalThis,
): Promise<void> {
  const hook = findRuntimeHook(source);
  if (!hook) return;
  if (typeof hook.declareStartup !== 'function') {
    throw new Error(
      'Quota guard: the published harness runtime hook does not accept a startup declaration, so the '
      + 'harness barrier can never admit a dispatch. Update pi-harness (runtime/jev-host.mjs) to a build '
      + 'that gates startup, or dispatch stays closed.',
    );
  }
  await hook.declareStartup({ providers });
}

/** Both guarded providers, named explicitly rather than implied by an omission. */
function declaredProviders(providers?: readonly GuardedProvider[]): Readonly<Record<GuardedProvider, boolean>> {
  const active = providers ?? GUARDED_PROVIDERS;
  return {
    'openai-codex': active.includes('openai-codex'),
    commandcode: active.includes('commandcode'),
  };
}

/**
 * Install the guard on the live runtime prototype, through the harness hook.
 *
 * Fails closed when the hook is absent: the guard is worthless if it can be quietly not-installed,
 * so a missing hook latches the fleet and reports exactly what to check rather than continuing
 * unguarded. Nothing here reaches into private SDK state - the hook hands over a public prototype.
 */
export async function installGuardedRuntimeViaHook(options: HookInstallOptions): Promise<Release> {
  const hook = findRuntimeHook(options.source);
  if (!hook) {
    options.coordinator.pause('identity');
    throw new Error(
      'Quota guard: the harness runtime hook (' + String(RUNTIME_HOOK_KEY) + ') is not published. '
      + 'The guard is enabled but cannot be installed, so nothing is being gated. Start pi through the '
      + 'pi-harness entry point (runtime/jev-host.mjs), or update it if it predates the hook.',
    );
  }
  // Declare before installing: enabling without a declaration leaves the barrier pending, and the
  // hook would refuse the install. A rejected declaration aborts before any decoration.
  await declareStartupViaHook(declaredProviders(options.guardedProviders), options.source ?? globalThis);
  return hook.install(async ({ prototype, host: hostInfo }) => {
    boundHost = { ...(hostInfo?.name !== undefined ? { name: hostInfo.name } : {}), ...(hostInfo?.version !== undefined ? { version: hostInfo.version } : {}) };
    // Gate activation on what can actually be seen. A missing seam must stop an enabled guard here,
    // not surface later as traffic that is quietly not being gated.
    const shape = prototype as { stream?: unknown; streamSimple?: unknown; getAuth?: unknown };
    const verdict = checkHostCompatibility({
      hasStream: typeof shape.stream === 'function',
      hasStreamSimple: typeof shape.streamSimple === 'function',
      hasGetAuth: typeof shape.getAuth === 'function',
      ...(options.apiIds ? { apiIds: options.apiIds } : {}),
      hostPackage: { name: hostInfo.name, version: hostInfo.version },
    });
    if (!verdict.ok) throw new Error(compatibilityRefusal(verdict));
    return installQuotaGuard({
      runtime: prototype as unknown as GuardRuntime,
      rootId: options.rootId,
      coordinator: options.coordinator,
      ...(options.codexLimits ? { codexLimits: options.codexLimits } : {}),
      ...(options.guardedProviders ? { guardedProviders: options.guardedProviders } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  });
}

/** Kept so the provider list stays explicit at the call site rather than implicit here. */
export const GUARDED_PROVIDERS: readonly GuardedProvider[] = Object.freeze(['openai-codex', 'commandcode']);