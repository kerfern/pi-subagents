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
function snapshotScope(scope: AttemptScope): AttemptScope {
  const providerId = scope.providerId;
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
  mode: () => GuardMode;
  reserve: (lane: string, snapshot: QuotaSnapshot) => ReadonlyMap<string, number | null>;
  now: () => number;
  fetchImpl?: typeof fetch;
}

function pauseReasonFor(reason: Assessment['reason']): PauseReason {
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
  constructor(deps: CoordinatorDeps) { this.deps = deps; }

  /** Public fail-closed latch: pauses the shared fleet for a given reason without exposing it. */
  pause(reason: PauseReason): void { this.deps.fleet.pause(reason); }

  async admit(scope: AttemptScope, signal?: AbortSignal): Promise<Release> {
    const { fifo, fleet, readQuota: read, policy, mode, reserve, now, fetchImpl } = this.deps;
    let attempt: AttemptScope;
    let lane: string;
    try {
      attempt = snapshotScope(scope);
      lane = laneKey(attempt);
    } catch (error) {
      // No lane or lease is held yet, so this fail-closed rejection cannot leak either.
      fleet.pause('identity');
      throw error instanceof QuotaError ? error : new QuotaError('auth');
    }
    await fleet.wait(signal);
    const releaseLane = await fifo.enter(lane, signal);
    // Decided again whenever the fleet generation moved under the decision. Waiting before every
    // read is what keeps the approval fresh: a read taken while paused would otherwise be replayed
    // after the resume, since resuming does not itself move the generation. A stale approval is
    // re-decided rather than dispatched - and re-decided rather than rejected, because an attempt
    // that already holds a lease is admitted work that must drain, not fail.
    for (;;) {
      await fleet.wait(signal);
      // Re-checked synchronously after the wait: a pause queued before this continuation can have
      // landed as the wait resolved, and a read taken then would be replayed after the resume
      // because resuming does not move the generation.
      if (fleet.snapshot().state !== 'open') continue;
      const generation = fleet.snapshot().generation;
      const auth: QuotaAuth = { providerId: attempt.providerId, scope: attempt.scope,
        ...(attempt.accountId && { accountId: attempt.accountId }), apiKey: attempt.credential,
        ...(attempt.codexLimits && { codexLimits: attempt.codexLimits }) };
      const options: ReadOptions = { ...(fetchImpl && { fetchImpl }), signal, now,
        ...(attempt.codexBase && { codexBase: attempt.codexBase }) };
      let snapshot: QuotaSnapshot;
      try {
        snapshot = await read(auth, options);
      } catch (error) {
        fleet.pause('unavailable'); releaseLane();
        throw error instanceof QuotaError ? error : new QuotaError('unavailable');
      }
      let assessment: Assessment;
      try {
        assessment = assess(snapshot, policy, mode(), reserve(lane, snapshot), now());
      } catch (error) {
        fleet.pause('unavailable'); releaseLane();
        throw error;
      }
      if (assessment.state !== 'open' && assessment.state !== 'warn') {
        fleet.pause(pauseReasonFor(assessment.reason)); releaseLane();
        throw new QuotaError('unavailable');
      }
      let releaseFleet: Release;
      try {
        releaseFleet = await fleet.enter('inference', signal);
      } catch (error) {
        releaseLane(); throw error;
      }
      if (fleet.snapshot().generation === generation) {
        return () => { releaseFleet(); releaseLane(); };
      }
      releaseFleet();
    }
  }

  /** Request-local gate: not one byte reaches the network unless a fresh quota check admits it. */
  gatedFetch(scope: AttemptScope, inner?: typeof fetch): typeof fetch {
    const send: typeof fetch = inner ?? globalThis.fetch;
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // One snapshot for everything below: identity is read once, before the first await, and the
      // same values both key the lane and bind the outbound request.
      let attempt: AttemptScope;
      let signal: AbortSignal | undefined;
      let request: FinalRequest;
      try {
        attempt = snapshotScope(scope);
        signal = requestSignal(input, init);
        request = normalizeFinalRequest(input, init);
      } catch {
        this.deps.fleet.pause('identity');
        throw new QuotaError('auth');
      }
      if (!attempt.credential || !isFirstPartyDestination(request.url, attempt.providerId)) {
        this.deps.fleet.pause('identity');
        throw new QuotaError('auth');
      }
      try {
        classifyFinalRequest(request, attempt);
      } catch (error) {
        this.deps.fleet.pause('identity');
        throw error;
      }
      // The outbound snapshot is built before admission, so no caller getter can run while a lease is
      // held and the caller's live URL/Request is never re-read after validation.
      let outbound: Outbound;
      try {
        outbound = forwardingSnapshot(input, init, request, signal);
      } catch {
        this.deps.fleet.pause('identity');
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
