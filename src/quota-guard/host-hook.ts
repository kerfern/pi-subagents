import type { CodexLimit } from './adapters.ts';
import type { Release } from './controller.ts';
import type { GatedCoordinator } from './root.ts';
import { type GuardRuntime, installQuotaGuard } from './root.ts';
import type { GuardedProvider } from './types.ts';

/** The harness publishes this on globalThis after scrubbing credentials and before pi starts. */
export const RUNTIME_HOOK_KEY = Symbol.for('pi-harness:runtime-hook-v1');

export interface HarnessHookTarget {
  prototype: object;
  host: { name: string; version: string; packagePath: string };
}
export interface HarnessRuntimeHook {
  install(decorate: (target: HarnessHookTarget) => Release | Promise<Release> | undefined): Promise<Release>;
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
  fetchImpl?: typeof fetch;
  source?: object;
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
  return hook.install(async ({ prototype }) => installQuotaGuard({
    runtime: prototype as unknown as GuardRuntime,
    rootId: options.rootId,
    coordinator: options.coordinator,
    ...(options.codexLimits ? { codexLimits: options.codexLimits } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }));
}

/** Kept so the provider list stays explicit at the call site rather than implicit here. */
export const GUARDED_PROVIDERS: readonly GuardedProvider[] = Object.freeze(['openai-codex', 'commandcode']);