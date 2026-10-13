import type { CodexLimit, QuotaAuth, ReadOptions, readQuota } from './adapters.ts';
import { FIRST_PARTY_ORIGINS, QuotaError } from './adapters.ts';
import type { AccountFifo, FleetLatch, PauseReason, Release } from './controller.ts';
import { assess } from './policy.ts';
import type { Assessment, GuardedProvider, GuardMode, Policy, QuotaScope, QuotaSnapshot } from './types.ts';

export interface AttemptScope {
  providerId: GuardedProvider;
  scope: QuotaScope;
  accountId?: string;
  credential: string;
  codexBase?: string;
  codexLimits?: readonly CodexLimit[];
}

export interface FinalRequest { url: string; headers: Headers }

interface Outbound { destination: string | Request; init: RequestInit }

/**
 * Reads every caller-controlled scope field exactly once, before any validation or await. A caller
 * that mutates the scope afterwards, or an accessor returning different values on later reads, can
 * no longer change the credential a lane was opened for; a throwing accessor fires before any lane
 * or lease exists, so it cannot leak one.
 */
function snapshotScope(scope: AttemptScope, onProviderId?: (value: unknown) => void): AttemptScope {
  const providerId = scope.providerId;
  onProviderId?.(providerId);
  const kind = scope.scope;
  const accountId = scope.accountId;
  const credential = scope.credential;
  const codexBase = scope.codexBase;
  const supplied = scope.codexLimits;
  const codexLimits = supplied === undefined ? undefined
    : Object.freeze(supplied.map((limit) => Object.freeze({ id: limit.id, windows: Object.freeze([...limit.windows]) })));
  return Object.freeze({
    providerId, scope: kind, credential,
    ...(accountId === undefined ? {} : { accountId }),
    ...(codexBase === undefined ? {} : { codexBase }),
    ...(codexLimits === undefined ? {} : { codexLimits }),
  });
}

/** Verified lane key: Codex is account-scoped, CommandCode is provider-wide. */
export function laneKey(scope: AttemptScope): string {
  if (scope.providerId !== 'openai-codex' && scope.providerId !== 'commandcode') throw new QuotaError('auth');
  if (scope.scope === 'provider') {
    if (scope.accountId !== undefined || scope.providerId !== 'commandcode') throw new QuotaError('auth');
    return `${scope.providerId}:provider`;
  }
  if (scope.scope === 'account') {
    if (!scope.accountId || scope.providerId !== 'openai-codex') throw new QuotaError('auth');
    return `${scope.providerId}:${scope.accountId}`;
  }
  throw new QuotaError('auth');
}

/** Binds the final outgoing request to the attempt's verified credential and scope. */
export function classifyFinalRequest(req: FinalRequest, expected: AttemptScope): AttemptScope {
  laneKey(expected);
  if (req.headers.get('authorization') !== `Bearer ${expected.credential}`) throw new QuotaError('auth');
  if (expected.providerId === 'openai-codex') {
    if (req.headers.get('chatgpt-account-id') !== expected.accountId) throw new QuotaError('auth');
  } else if (req.headers.get('chatgpt-account-id') !== null) throw new QuotaError('auth');
  return expected;
}

export interface CoordinatorDeps {
  fifo: AccountFifo;
  fleet: FleetLatch;
  readQuota: typeof readQuota;
  policy: Policy;
  mode: (providerId: GuardedProvider) => GuardMode;
  reserve: (lane: string, snapshot: QuotaSnapshot) => ReadonlyMap<string, number | null>;
  now: () => number;
  fetchImpl?: typeof fetch;
}

function pauseReasonFor(reason: Assessment['reason']): Exclude<PauseReason, 'manual'> {
  // 'threshold' is a real PauseReason; falling through to 'identity' misreported an exhausted
  // window as a bad identity, which is the one reason an operator must not be told by mistake.
  if (reason === 'threshold') return 'threshold';
  if (reason === 'reserve' || reason === 'unknown-reserve') return 'reserve';
  if (reason === 'unavailable' || reason === 'reset-settling') return 'unavailable';
  return 'identity';
}

/** Accepts a Request or a (url, init) pair; init headers replace the Request's, as fetch does. */
function normalizeFinalRequest(input: string | URL | Request, init?: RequestInit): FinalRequest {
  if (input instanceof Request) return { url: input.url, headers: new Headers(init?.headers ?? input.headers) };
  return { url: typeof input === 'string' ? input : input.href, headers: new Headers(init?.headers) };
}

/** The caller's effective cancellation signal: init wins, else the Request's own. */
function requestSignal(input: string | URL | Request, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

/**
 * Reads every caller-owned value exactly once, before admission, and returns our own objects only.
 * A `Request` is copied as Request-as-input so its body object is reused rather than re-extracted
 * (keepalive POSTs and already-used bodies stay valid) and its inherited options — method, integrity,
 * referrer, credentials, cache, duplex — survive. The copy's URL is re-checked against the validated
 * snapshot, because the copy's destination comes from the caller's object, not from our string.
 */
function forwardingSnapshot(input: string | URL | Request, init: RequestInit | undefined,
  request: FinalRequest, signal: AbortSignal | undefined): Outbound {
  const overrides: RequestInit = { ...init, headers: request.headers, redirect: 'error',
    ...(signal ? { signal } : {}) };
  if (!(input instanceof Request)) return { destination: request.url, init: overrides };
  // The caller's own method/referrer values are read here and now: never after admission, and a hostile
  // accessor fails closed instead of leaving a lease behind. undici's Request-as-input copy resets
  // referrer and referrerPolicy, so the Request's values are carried across — but only where the caller
  // supplied no `init` value, since init takes precedence over the Request per fetch semantics.
  if (init?.method === undefined) overrides.method = input.method;
  if (init?.referrer === undefined) overrides.referrer = input.referrer;
  if (init?.referrerPolicy === undefined) overrides.referrerPolicy = input.referrerPolicy;
  const outbound = new Request(input, overrides);
  if (outbound.url !== request.url) throw new QuotaError('auth');
  return { destination: outbound, init: overrides };
}

function isFirstPartyDestination(url: string, providerId: GuardedProvider): boolean {
  try { return FIRST_PARTY_ORIGINS[providerId].has(new URL(url).origin); } catch { return false; }
}

/** Releases the lease on the first terminal event, before the consumer can observe it. */
function terminalStream(body: ReadableStream<Uint8Array>, release: Release): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const finish = (): void => { if (!released) { released = true; release(); } };
  // A full, never-pulled queue must not hold the lease past an upstream close or failure.
  void reader.closed.then(finish, finish);
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const part = await reader.read();
        if (part.done) { finish(); controller.close(); return; }
        controller.enqueue(part.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason): Promise<void> {
      finish();
      try { await reader.cancel(reason); } catch { /* upstream already failing; the lease is released */ }
    },
  });
}

export class GuardCoordinator {
  private readonly deps: CoordinatorDeps;
  /**
   * Verified attempt scopes retained by provider/lane so resume can re-read quota OUTSIDE dispatch;
   * reserve calibration otherwise only happens inside `admit`, which waits on the hold it must lift.
   * Only scopes actually seen by the guard can be re-checked. Credentials stay in memory here and are
   * never persisted, logged or exposed through `status()`.
   */
  // A provider hold can cover multiple Codex accounts; retain one verified scope per lane so a
  // resume checks every account the guard has actually observed.
  private readonly held = new Map<GuardedProvider, Map<string, { attempt: AttemptScope; lane: string }>>();
  /**
   * Providers refused for a reason scoped to THEM rather than to the root: today, a quota surface
   * that is not served here (HTTP 404). Recorded only so `status()` can say "unsupported" instead of
   * the far more wrong "unavailable" - it never gates and never pauses anything. Session-scoped, like
   * every other in-memory record here, and never a licence to dispatch unguarded.
   */
  private readonly unsupported = new Set<GuardedProvider>();
  constructor(deps: CoordinatorDeps) { this.deps = deps; }

  /** Providers refused as unsupported (their quota surface is not served here). Sorted, for `status()`. */
  unsupportedProviders(): readonly GuardedProvider[] { return [...this.unsupported].sort(); }

  /** Provider-attributed failures stay local; unattributed callers retain the root fail-closed latch. */
  pause(reason: PauseReason, providerId?: GuardedProvider): void {
    if (providerId && reason !== 'manual') this.deps.fleet.pauseAutomatic(providerId, reason);
    else this.deps.fleet.pause(reason);
  }

  /** Synchronous manual-only boundary for providers whose automatic guard is explicitly OFF. */
  assertManualAllowed(providerId: GuardedProvider): void {
    if (this.deps.fleet.snapshot(providerId).manual) {
      throw new Error(`Quota guard: ${providerId} is manually paused; refusing dispatch`);
    }
  }

  /**
   * The real `freshCheck` behind `resume()`: re-reads quota for the retained scope with the SAME
   * `readQuota` and the same estimator instance the coordinator gates with, so a paused guard can
   * advance calibration and reopen only on a verified, in-policy read.
   *
   * Re-checks every retained lane for the selected provider (or every provider for the legacy no-arg
   * surface). No retained scope, unreadable read, or unknown reserve keeps the guard closed.
   */
  async freshCheck(providerId?: GuardedProvider): Promise<boolean> {
    const retained = providerId
      ? [...(this.held.get(providerId)?.values() ?? [])]
      : [...this.held.values()].flatMap(scopes => [...scopes.values()]);
    if (!retained.length) return false;
    const { readQuota: read, policy, mode, reserve, now, fetchImpl } = this.deps;
    for (const { attempt, lane } of retained) {
      const auth: QuotaAuth = { providerId: attempt.providerId, scope: attempt.scope,
        ...(attempt.accountId && { accountId: attempt.accountId }), apiKey: attempt.credential,
        ...(attempt.codexLimits && { codexLimits: attempt.codexLimits }) };
      const options: ReadOptions = { ...(fetchImpl && { fetchImpl }), now,
        ...(attempt.codexBase && { codexBase: attempt.codexBase }) };
      let snapshot: QuotaSnapshot;
      try {
        snapshot = await read(auth, options);
        if (!['open', 'warn'].includes(assess(snapshot, policy, mode(attempt.providerId), reserve(lane, snapshot), now()).state)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  async admit(scope: AttemptScope, signal?: AbortSignal): Promise<Release> {
    const { fifo, fleet, readQuota: read, policy, mode, reserve, now, fetchImpl } = this.deps;
    let attempt: AttemptScope;
    let lane: string;
    let providerHint: GuardedProvider | undefined;
    try {
      attempt = snapshotScope(scope, (value) => {
        if (value === 'openai-codex' || value === 'commandcode') providerHint = value;
      });
    } catch (error) {
      if (providerHint) fleet.pauseAutomatic(providerHint, 'identity');
      throw error instanceof QuotaError ? error : new QuotaError('auth');
    }
    try {
      lane = laneKey(attempt);
    } catch (error) {
      if (providerHint) fleet.pauseAutomatic(providerHint, 'identity');
      throw error instanceof QuotaError ? error : new QuotaError('auth');
    }
    const scopes = this.held.get(attempt.providerId) ?? new Map<string, { attempt: AttemptScope; lane: string }>();
    if (!scopes.has(lane)) fleet.noteScope(attempt.providerId);
    scopes.set(lane, { attempt, lane });
    this.held.set(attempt.providerId, scopes);
    await fleet.wait(attempt.providerId, signal);
    const releaseLane = await fifo.enter(lane, signal);
    for (;;) {
      await fleet.wait(attempt.providerId, signal);
      const rootBefore = fleet.snapshot();
      const providerBefore = fleet.snapshot(attempt.providerId);
      if (rootBefore.state !== 'open' || providerBefore.state !== 'open') continue;
      const rootGeneration = rootBefore.generation;
      const providerGeneration = providerBefore.generation;
      const auth: QuotaAuth = { providerId: attempt.providerId, scope: attempt.scope,
        ...(attempt.accountId && { accountId: attempt.accountId }), apiKey: attempt.credential,
        ...(attempt.codexLimits && { codexLimits: attempt.codexLimits }) };
      const options: ReadOptions = { ...(fetchImpl && { fetchImpl }), signal, now,
        ...(attempt.codexBase && { codexBase: attempt.codexBase }) };
      let snapshot: QuotaSnapshot;
      try {
        snapshot = await read(auth, options);
      } catch (error) {
        const failure = error instanceof QuotaError ? error : new QuotaError('unavailable');
        if (failure.code === 'unsupported') this.unsupported.add(attempt.providerId);
        if (failure.code !== 'aborted') {
          fleet.pauseAutomatic(attempt.providerId,
            failure.code === 'auth' || failure.code === 'schema' ? 'identity' : 'unavailable');
        }
        releaseLane();
        throw failure;
      }
      let assessment: Assessment;
      try {
        assessment = assess(snapshot, policy, mode(attempt.providerId), reserve(lane, snapshot), now());
      } catch (error) {
        fleet.pauseAutomatic(attempt.providerId, 'unavailable');
        releaseLane();
        throw error;
      }
      if (assessment.state !== 'open' && assessment.state !== 'warn') {
        fleet.pauseAutomatic(attempt.providerId, pauseReasonFor(assessment.reason));
        releaseLane();
        throw new QuotaError('unavailable');
      }
      let release: Release;
      try {
        release = await fleet.enter(attempt.providerId, 'inference', signal);
      } catch (error) {
        releaseLane();
        throw error;
      }
      if (fleet.snapshot().generation === rootGeneration
        && fleet.snapshot(attempt.providerId).generation === providerGeneration) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          release();
          releaseLane();
        };
      }
      release();
    }
  }

  /** Request-local gate: not one byte reaches the network unless a fresh quota check admits it. */
  gatedFetch(scope: AttemptScope, inner?: typeof fetch): typeof fetch {
    const send: typeof fetch = inner ?? globalThis.fetch;
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      let attempt: AttemptScope;
      let providerHint: GuardedProvider | undefined;
      try {
        attempt = snapshotScope(scope, (value) => {
          if (value === 'openai-codex' || value === 'commandcode') providerHint = value;
        });
      } catch {
        if (providerHint) this.deps.fleet.pauseAutomatic(providerHint, 'identity');
        throw new QuotaError('auth');
      }
      try {
        laneKey(attempt);
      } catch {
        if (providerHint) this.deps.fleet.pauseAutomatic(providerHint, 'identity');
        throw new QuotaError('auth');
      }
      let signal: AbortSignal | undefined;
      let request: FinalRequest;
      try {
        signal = requestSignal(input, init);
        request = normalizeFinalRequest(input, init);
      } catch {
        this.deps.fleet.pauseAutomatic(attempt.providerId, 'identity');
        throw new QuotaError('auth');
      }
      if (!attempt.credential || !isFirstPartyDestination(request.url, attempt.providerId)) {
        this.deps.fleet.pauseAutomatic(attempt.providerId, 'identity');
        throw new QuotaError('auth');
      }
      try {
        classifyFinalRequest(request, attempt);
      } catch (error) {
        this.deps.fleet.pauseAutomatic(attempt.providerId, 'identity');
        throw error;
      }
      // The outbound snapshot is built before admission, so no caller getter can run while a lease is
      // held and the caller's live URL/Request is never re-read after validation.
      let outbound: Outbound;
      try {
        outbound = forwardingSnapshot(input, init, request, signal);
      } catch {
        this.deps.fleet.pauseAutomatic(attempt.providerId, 'identity');
        throw new QuotaError('auth');
      }
      const release = await this.admit(attempt, signal);
      let response: Response;
      try {
        response = await send(outbound.destination, outbound.init);
      } catch (error) {
        release();
        throw error;
      }
      if (!response.body) { release(); return response; }
      return new Response(terminalStream(response.body, release), {
        status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }
}
