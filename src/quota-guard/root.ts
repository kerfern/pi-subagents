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

/**
 * JWT claim namespace the Codex transport itself trusts for the account id. Mirrors pi-ai's
 * `JWT_CLAIM_PATH` (`openai-codex-responses.js`) so the guard attributes an attempt exactly as the
 * transport does, instead of trusting a caller-supplied `chatgpt-account-id` header that the
 * transport overrides from the token anyway.
 */
const CODEX_CLAIM_PATH = 'https://api.openai.com/auth';

/** Tolerant base64url decode: `-`->`+`, `_`->`/`, padded to a multiple of four. */
function decodeBase64url(segment: string): string {
  const normalised = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (normalised.length % 4)) % 4;
  return atob(normalised.padEnd(normalised.length + padding, '='));
}

/**
 * Derives the Codex account id from the credential itself, the way the transport does
 * (`extractAccountId`): exactly three dot-separated segments, the second decoding to a JSON payload
 * carrying the claim. Returns undefined for anything undecodable or without a non-empty string
 * claim, so the caller fails closed. The credential is never echoed into an error or a log.
 */
function codexAccountId(credential: string): string | undefined {
  const parts = credential.split('.');
  if (parts.length !== 3) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(decodeBase64url(parts[1])); } catch { return undefined; }
  const claim = (payload as Record<string, unknown> | null)?.[CODEX_CLAIM_PATH];
  const accountId = (claim as { chatgpt_account_id?: unknown } | undefined)?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
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
  // Identity comes from the credential the transport will actually send. A caller-supplied
  // `chatgpt-account-id` header is deliberately ignored: the transport overrides it from the token,
  // so trusting it would let a caller aim the gate at another account's quota lane.
  const accountId = credential ? codexAccountId(credential) : undefined;
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
      // Only a live instance can answer: the prototype itself carries `getAuth`, so `receiver !== runtime`
      // must exclude it explicitly rather than falling back to resolving identity on the prototype.
      const owner: GuardRuntime | undefined = receiver && receiver !== runtime
        && typeof receiver.getAuth === 'function' ? receiver : undefined;
      const [model, contextOrHandle, maybeOptions] =
        args as [GuardModel, unknown, GuardOptions | undefined];
      const api = model?.api;
      const provider = guardedProvider(model);
      if (!provider) {
        // Passthrough forwards the model the provider will actually read, so the decision must be
        // made on that object. A getter that reads unguarded while we route and guarded later would
        // otherwise take a path the check never approved - the same flip the guarded branch pins
        // against. A plain object is pinned by spreading; anything else (a class instance, or a Proxy
        // whose descriptor reads cannot be trusted) is pinned with our own wrapper that answers the
        // pinned `provider`/`api` and delegates every other key to the original. Dispatch reads the
        // model through `get`, so the pinned values are what it sees - a lying `get` trap on the
        // target cannot influence the route. Only a non-object - which cannot be wrapped at all - is
        // still refused.
        const isObject = model !== null && typeof model === 'object';
        if (!isObject) {
          return pauseAndThrow(coordinator,
            'Quota guard: model is not a plain object; refusing to dispatch');
        }
        const prototype = Object.getPrototypeOf(model);
        const plain = prototype === Object.prototype || prototype === null;
        // Read the pinned value once, before wrapping, so a later `get` cannot re-litigate it.
        const pinnedProvider = model.provider;
        const forwarded: GuardModel = plain
          ? { ...model, api, provider: pinnedProvider }
          : new Proxy(model as object, {
              get(target, key, receiver): unknown {
                if (key === 'provider') return pinnedProvider;
                if (key === 'api') return api;
                // Reflect with the receiver so prototype members and accessors keep working.
                return Reflect.get(target, key, receiver);
              },
            }) as GuardModel;
        if (guardedProvider(forwarded)) {
          return pauseAndThrow(coordinator,
            'Quota guard: model provider changed after the guard check; refusing to dispatch');
        }
        return original.call(this, forwarded, contextOrHandle, maybeOptions);
      }
      // One own copy, made before anything is validated: a spread invokes each getter once, so a
      // `client` accessor cannot read as undefined while we validate and as a real client when the
      // provider later reads it - which is exactly how a supplied client slips past the fetch.
      const callerOptions: GuardOptions = { ...(maybeOptions ?? {}) };
      if (!transportIsGuardable(provider, { api }, callerOptions)) {
        const why = callerOptions.client !== undefined
          ? ' with a supplied client, which bypasses the injected fetch' : '';
        return pauseAndThrow(coordinator,
          `Quota guard: ${provider} on api "${String(api)}" cannot be guarded${why}; refusing to dispatch`);
      }
      if (!owner) {
        return pauseAndThrow(coordinator,
          'Quota guard: no live runtime receiver; refusing to resolve identity');
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
