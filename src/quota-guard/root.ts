import type { CodexLimit } from './adapters.ts';
import { QuotaError } from './adapters.ts';
import type { PauseReason } from './controller.ts';
import type { AttemptScope } from './coordinator.ts';
import type { GuardedProvider } from './types.ts';

/** Minimal public runtime surface this package decorates; everything else stays opaque. */
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

export interface GuardRuntime {
  stream: AnyFn;
  streamSimple: AnyFn;
  getAuth?: (this: unknown, model: unknown) => unknown;
}

/** Public coordinator surface the gate depends on. */
export interface GatedCoordinator {
  gatedFetch(scope: AttemptScope, inner?: typeof fetch): typeof fetch;
  /** Mandatory fail-closed latch; the gate refuses to admit when this is unavailable. */
  pause(reason: PauseReason): void;
}

interface GuardOptions { fetch?: typeof fetch; client?: unknown; [key: string]: unknown }
interface GuardModel { provider?: string; api?: string }

/**
 * Effective APIs whose built-in implementation is verified to route the request through the
 * `fetch` this package installs. Anything else cannot be tied to a quota check at all, so it is
 * refused instead of being dispatched unguarded.
 */
const GUARDED_APIS: Readonly<Record<GuardedProvider, readonly string[]>> = Object.freeze({
  'openai-codex': Object.freeze(['openai-codex-responses']),
  commandcode: Object.freeze(['openai-completions', 'anthropic-messages']),
});

/**
 * Whether a guarded provider's request is guaranteed to pass through the injected fetch.
 * `anthropic-messages` builds its own client unless one is supplied - and a supplied client
 * issues the request itself, so the injected fetch would never be called
 * (pi-ai `anthropic-messages.js:405`).
 */
function transportIsGuardable(provider: GuardedProvider, model: GuardModel,
  options: GuardOptions): boolean {
  const api = model.api;
  if (typeof api !== 'string' || !GUARDED_APIS[provider].includes(api)) return false;
  if (api === 'anthropic-messages' && options.client !== undefined) return false;
  return true;
}

/** Our own wrapper functions, so a second runtime cannot rewrap a gate we already installed. */
const guardWrappers = new WeakSet<object>();

/** Shallow copy with SSE forced; sets nothing else and leaves any caller `fetch` untouched. */
export function forceSse(options: Record<string, unknown>): Record<string, unknown> {
  return { ...options, transport: 'sse' };
}

function guardedProvider(model: GuardModel | undefined): GuardedProvider | undefined {
  const provider = model?.provider;
  return provider === 'openai-codex' || provider === 'commandcode' ? provider : undefined;
}

/**
 * Fail closed: pause the shared latch for an unidentifiable attempt via the coordinator's public
 * contract, then reject. A coordinator that cannot pause throws a clear error rather than silently
 * skipping the mandatory pause.
 */
function failIdentity(coordinator: GatedCoordinator): never {
  if (typeof coordinator?.pause !== 'function') {
    throw new Error('Quota guard: coordinator cannot pause the fleet; refusing an unidentifiable attempt');
  }
  try {
    coordinator.pause('identity');
  } catch {
    throw new Error('Quota guard: the coordinator pause failed; refusing an unidentifiable attempt');
  }
  throw new QuotaError('auth');
}

/**
 * Fail closed for an attempt that cannot be routed through the guard: pause the shared latch,
 * then reject with an error naming the configuration to fix.
 */
function pauseAndThrow(coordinator: GatedCoordinator, message: string): never {
  if (typeof coordinator?.pause !== 'function') {
    throw new Error('Quota guard: coordinator cannot pause the fleet; refusing an unguardable attempt');
  }
  try {
    coordinator.pause('identity');
  } catch {
    throw new Error('Quota guard: the coordinator pause failed; refusing an unguardable attempt');
  }
  throw new Error(message);
}

function credentialOf(auth: unknown): string | undefined {
  const value = (auth as { auth?: { apiKey?: unknown } } | undefined)?.auth?.apiKey;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Case-insensitive header read; accepts a `ProviderHeaders` record only. */
function headerValue(auth: unknown, name: string): string | undefined {
  const headers = (auth as { auth?: { headers?: unknown } } | undefined)?.auth?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  for (const key of Object.keys(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue;
    const value = (headers as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Resolves the attempt scope from public host APIs; missing identity pauses and throws. */
async function resolveScope(runtime: GuardRuntime, coordinator: GatedCoordinator,
  provider: GuardedProvider, model: GuardModel,
  codexLimits?: readonly CodexLimit[]): Promise<AttemptScope> {
  let auth: unknown;
  try { auth = await runtime.getAuth?.(model); } catch { return failIdentity(coordinator); }
  const credential = credentialOf(auth);
  if (provider === 'commandcode') {
    if (!credential) return failIdentity(coordinator);
    return { providerId: 'commandcode', scope: 'provider', credential };
  }
  const accountId = headerValue(auth, 'chatgpt-account-id');
  if (!credential || !accountId) return failIdentity(coordinator);
  if (!codexLimits?.length) {
    // Without the verified meter scope the read cannot be attributed to a quota window, so refuse
    // with an actionable error instead of failing later as a generic schema error.
    return pauseAndThrow(coordinator,
      'Quota guard: no verified Codex meter scope configured; pass codexLimits to installQuotaGuard');
  }
  return { providerId: 'openai-codex', scope: 'account', accountId, credential, codexLimits };
}

/** Lazy transport: resolves identity only when the provider actually performs a request. */
function gatedTransport(runtime: GuardRuntime, coordinator: GatedCoordinator, provider: GuardedProvider,
  model: GuardModel, inner: typeof fetch, codexLimits?: readonly CodexLimit[]): typeof fetch {
  return async (input, init) => {
    const scope = await resolveScope(runtime, coordinator, provider, model, codexLimits);
    return coordinator.gatedFetch(scope, inner)(input, init);
  };
}

function restore(runtime: GuardRuntime, method: 'stream' | 'streamSimple', original: AnyFn, hadOwn: boolean): void {
  if (hadOwn) runtime[method] = original;
  else delete (runtime as unknown as Record<string, unknown>)[method];
}

/**
 * Decorates the runtime's public `stream`/`streamSimple`. Guarded providers get a lazy gated
 * fetch (Codex also gets SSE forced); unguarded providers pass through untouched. Returns a
 * idempotent dispose that restores the originals.
 */
export function installQuotaGuard(options: {
  runtime: GuardRuntime;
  rootId: string;
  coordinator: GatedCoordinator;
  fetchImpl?: typeof fetch;
  /** Verified Codex meter scope; without it a Codex attempt is refused rather than misattributed. */
  codexLimits?: readonly CodexLimit[];
}): () => void {
  const { runtime, rootId, coordinator, fetchImpl, codexLimits } = options;
  if (!rootId) throw new Error('Quota guard: root identity required');
  const originalStream = runtime?.stream;
  const originalSimple = runtime?.streamSimple;
  if (typeof originalStream !== 'function' || typeof originalSimple !== 'function') {
    throw new Error(`Quota guard (${rootId}): runtime stream methods unavailable`);
  }
  if (guardWrappers.has(originalStream) || guardWrappers.has(originalSimple)) {
    throw new Error(`Quota guard (${rootId}): runtime method already decorated`);
  }
  const hadOwnStream = Object.hasOwn(runtime, 'stream');
  const hadOwnSimple = Object.hasOwn(runtime, 'streamSimple');

  const decorate = (original: AnyFn): AnyFn => {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      // Resolve identity from the invocation's own receiver. The harness hook installs this
      // decorator on ModelRuntime.prototype, where `runtime` IS the prototype - calling the
      // prototype's getAuth would bind `this` to the prototype, which has none of the runtime's
      // private state. The instance that dispatches is the only object that can answer.
      const receiver = this as GuardRuntime | undefined;
      const owner: GuardRuntime = receiver && typeof receiver.getAuth === 'function' ? receiver : runtime;
      const [model, contextOrHandle, maybeOptions] =
        args as [GuardModel, unknown, GuardOptions | undefined];
      const provider = guardedProvider(model);
      if (!provider) return original.call(this, model, contextOrHandle, maybeOptions);
      // One own copy, made before anything is validated: a spread invokes each getter once, so a
      // `client` accessor cannot read as undefined while we validate and as a real client when the
      // provider later reads it - which is exactly how a supplied client slips past the fetch.
      const callerOptions: GuardOptions = { ...(maybeOptions ?? {}) };
      const api = model.api;
      if (!transportIsGuardable(provider, { api }, callerOptions)) {
        const why = callerOptions.client !== undefined
          ? ' with a supplied client, which bypasses the injected fetch' : '';
        return pauseAndThrow(coordinator,
          `Quota guard: ${provider} on api "${String(api)}" cannot be guarded${why}; refusing to dispatch`);
      }
      const inner = callerOptions.fetch ?? fetchImpl ?? globalThis.fetch;
      const next: Record<string, unknown> = {
        ...callerOptions, fetch: gatedTransport(owner, coordinator, provider, model, inner, codexLimits),
      };
      // The provider reads `model.api` again when it dispatches, so re-checking the live value is not
      // enough - a getter could answer differently on that third read and take a path this check never
      // approved. Forward a pinned copy instead: the spread reads each field once and the explicit
      // `api`/`provider` after it win, so the decision cannot be re-litigated downstream.
      const prototype = Object.getPrototypeOf(model);
      if (prototype !== Object.prototype && prototype !== null) {
        return pauseAndThrow(coordinator,
          `Quota guard: ${provider} model is not a plain object; refusing to dispatch`);
      }
      const pinned: GuardModel = { ...model, api, provider };
      const forwarded = provider === 'openai-codex' ? forceSse(next) : next;
      return original.call(this, pinned, contextOrHandle, forwarded);
    };
    guardWrappers.add(wrapper);
    return wrapper;
  };

  runtime.stream = decorate(originalStream);
  runtime.streamSimple = decorate(originalSimple);

  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    restore(runtime, 'stream', originalStream, hadOwnStream);
    restore(runtime, 'streamSimple', originalSimple, hadOwnSimple);
  };
}
