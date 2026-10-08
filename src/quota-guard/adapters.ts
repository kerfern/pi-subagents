import type { GuardedProvider, QuotaScope, QuotaSnapshot, QuotaWindow } from './types.ts';

export interface QuotaIdentity {
  providerId: GuardedProvider;
  scope: QuotaScope;
  accountId?: string;
  workspaceId?: string;
}
export interface CodexLimit {
  id: string;
  windows: readonly ('primary_window' | 'secondary_window')[];
}
export interface QuotaAuth extends QuotaIdentity {
  apiKey: string;
  codexLimits?: readonly CodexLimit[];
}
export interface ReadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  codexBase?: string;
}
export type QuotaErrorCode = 'auth' | 'schema' | 'unavailable' | 'rate-limited' | 'timeout' | 'aborted';
export class QuotaError extends Error {
  readonly code: QuotaErrorCode;
  readonly retryAt?: string;
  constructor(code: QuotaErrorCode, retryAt?: string) {
    super(`Quota check unavailable: ${code}`);
    this.name = 'QuotaError'; this.code = code; this.retryAt = retryAt;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuotaError('schema');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new QuotaError('schema');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new QuotaError('schema');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new QuotaError('schema');
  return value;
}
function instant(value: unknown): string {
  let time: number;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new QuotaError('schema');
    time = value * 1000;
  } else {
    const source = text(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source)) throw new QuotaError('schema');
    time = Date.parse(source);
    if (!Number.isFinite(time)) throw new QuotaError('schema');
    const canonical = new Date(time).toISOString();
    if (canonical !== source && canonical.replace('.000Z', 'Z') !== source) throw new QuotaError('schema');
  }
  if (!Number.isFinite(time) || time > 253402300799999) throw new QuotaError('schema');
  return new Date(time).toISOString();
}
// Verified first-party Codex origin; anything else is rejected before any request.
const CODEX_ORIGINS: ReadonlySet<string> = new Set(['https://chatgpt.com']);
const CODEX_USAGE_BASE = 'https://chatgpt.com/backend-api';
const COMMANDCODE_ORIGIN = 'https://api.commandcode.ai';
/** Pinned first-party inference destinations; the request gate rejects every other origin. */
export const FIRST_PARTY_ORIGINS: Readonly<Record<GuardedProvider, ReadonlySet<string>>> = Object.freeze({
  'openai-codex': CODEX_ORIGINS,
  commandcode: new Set([COMMANDCODE_ORIGIN]),
});
export function codexUsageUrl(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new QuotaError('schema'); }
  if (url.protocol !== 'https:' || !CODEX_ORIGINS.has(url.origin)
    || (url.pathname !== '/backend-api' && url.pathname !== '/backend-api/codex')) throw new QuotaError('schema');
  return `${url.origin}${url.pathname.replace(/\/codex$/, '')}/wham/usage`;
}
// accountId is required for account scope and must be absent for provider scope.
function accountIdOf(identity: QuotaIdentity): string | undefined {
  if (identity.scope === 'provider') {
    if (identity.accountId !== undefined) throw new QuotaError('schema');
    return undefined;
  }
  if (identity.scope === 'account') return text(identity.accountId);
  throw new QuotaError('schema');
}
function snapshot(identity: QuotaIdentity, providerId: GuardedProvider, windows: QuotaWindow[], now: number): QuotaSnapshot {
  if (identity.providerId !== providerId || !Number.isFinite(now) || now < 0 || now > 253402300799999) throw new QuotaError('schema');
  const accountId = accountIdOf(identity);
  const workspaceId = identity.workspaceId === undefined ? undefined : text(identity.workspaceId);
  return Object.freeze({ providerId, scope: identity.scope, ...(accountId === undefined ? {} : { accountId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    checkedAt: new Date(now).toISOString(), windows: Object.freeze(windows.map(window => Object.freeze(window))) });
}

export function normalizeCodex(payload: unknown, identity: QuotaIdentity, limits: readonly CodexLimit[], now: number): QuotaSnapshot {
  const body = object(payload); const windows: QuotaWindow[] = [];
  if (!limits.length || new Set(limits.map(limit => limit.id)).size !== limits.length) throw new QuotaError('schema');
  for (const limit of limits) {
    text(limit.id);
    if (!limit.windows.length || new Set(limit.windows).size !== limit.windows.length) throw new QuotaError('schema');
    let rawRate: unknown;
    if (limit.id === 'codex') rawRate = body.rate_limit;
    else {
      if (!Array.isArray(body.additional_rate_limits)) throw new QuotaError('schema');
      const matches = body.additional_rate_limits.map(object).filter(item => item.metered_feature === limit.id);
      if (matches.length !== 1) throw new QuotaError('schema');
      rawRate = matches[0].rate_limit;
    }
    const rate = object(rawRate);
    for (const name of limit.windows) {
      if (name !== 'primary_window' && name !== 'secondary_window') throw new QuotaError('schema');
      const window = object(rate[name]);
      const duration = number(window.limit_window_seconds);
      if (!Number.isSafeInteger(duration) || duration <= 0) throw new QuotaError('schema');
      windows.push({ id: `${limit.id}.${name}`, used: number(window.used_percent), cap: 100, resetAt: instant(window.reset_at) });
    }
  }
  // Applicability comes from verified actual-model scope, never balances or guessed model names.
  return snapshot(identity, 'openai-codex', windows, now);
}

export const COMMANDCODE_MONTHLY_POOLS: Readonly<Record<string, number>> = Object.freeze({
  'individual-ultra': 300, 'individual-max': 150, 'individual-provider': 15, 'individual-goat': 70,
  'individual-pro-v1': 80, 'individual-pro': 30, 'individual-go': 10, 'teams-pro': 40,
});
export function normalizeCommandCode(creditsPayload: unknown, subscriptionsPayload: unknown, identity: QuotaIdentity, now: number): QuotaSnapshot {
  const body = object(creditsPayload); const subscription = object(object(subscriptionsPayload).data);
  const plan = text(subscription.planId);
  if (!Object.hasOwn(COMMANDCODE_MONTHLY_POOLS, plan) || subscription.status !== 'active') throw new QuotaError('schema');
  const cap = COMMANDCODE_MONTHLY_POOLS[plan];
  const remaining = number(object(body.credits).monthlyCredits);
  if (remaining > cap) throw new QuotaError('schema');
  const windows: QuotaWindow[] = [{ id: 'monthly', used: cap - remaining, cap, resetAt: instant(subscription.currentPeriodEnd) }];
  const limits = object(body.windowLimits);
  for (const id of ['fiveHour', 'weekly']) {
    const window = object(limits[id]); const used = number(window.used); const rollingCap = number(window.cap);
    if (rollingCap <= 0 || typeof window.exceeded !== 'boolean') throw new QuotaError('schema');
    windows.push({ id, used: window.exceeded ? Math.max(used, rollingCap) : used, cap: rollingCap, resetAt: instant(window.resetAt) });
  }
  // Returned rolling caps apply even with limited:false; purchased/free credits never substitute.
  return snapshot(identity, 'commandcode', windows, now);
}

async function getJSON(url: string, auth: QuotaAuth, options: ReadOptions): Promise<unknown> {
  if (options.signal?.aborted) throw new QuotaError('aborted');
  if (typeof auth.apiKey !== 'string' || !auth.apiKey || auth.apiKey.length > 16384 || !/^[\u0021-\u007e]+$/.test(auth.apiKey)) throw new QuotaError('auth');
  let headers: Headers;
  try {
    headers = new Headers({ authorization: `Bearer ${auth.apiKey}`, accept: 'application/json', 'user-agent': 'pi-quota-guard/1.0.0' });
    if (auth.providerId === 'openai-codex') {
      const account = text(auth.accountId);
      if (!/^[\u0021-\u007e]+$/.test(account)) throw new QuotaError('auth');
      headers.set('chatgpt-account-id', account);
    } else { headers.set('x-command-code-version', '1.0.0'); headers.set('x-cli-environment', 'production'); }
  } catch { throw new QuotaError('auth'); }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let timedOut = false; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new QuotaError(timedOut ? 'timeout' : 'aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const request = async () => {
      const response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', headers, redirect: 'error', signal });
      if (signal.aborted) throw new QuotaError(timedOut ? 'timeout' : 'aborted');
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) throw new QuotaError('unavailable');
      if (response.status === 401 || response.status === 403) throw new QuotaError('auth');
      if (response.status === 429) {
        const retry = response.headers.get('retry-after'); const now = (options.now ?? Date.now)();
        let retryAt: string | undefined;
        if (retry) {
          const seconds = /^\d+$/.test(retry) ? Number(retry) : null;
          const time = seconds === null ? Date.parse(retry) : now + seconds * 1000;
          if (Number.isFinite(time) && time >= now && time <= 253402300799999) retryAt = new Date(time).toISOString();
        }
        throw new QuotaError('rate-limited', retryAt);
      }
      if (!response.ok) throw new QuotaError('unavailable');
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json' || !response.body) throw new QuotaError('schema');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await reader.read();
        if (signal.aborted) throw new QuotaError(timedOut ? 'timeout' : 'aborted');
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 128 * 1024) throw new QuotaError('schema');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
      catch { throw new QuotaError('schema'); }
    };
    return await Promise.race([request(), aborted]);
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    throw new QuotaError('unavailable');
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    if (reader) void reader.cancel().catch(() => {});
    controller.abort();
  }
}

export async function readQuota(auth: QuotaAuth, options: ReadOptions = {}): Promise<QuotaSnapshot> {
  if (options.signal?.aborted) throw new QuotaError('aborted');
  accountIdOf(auth);
  const now = options.now ?? Date.now;
  if (auth.providerId === 'openai-codex') {
    if (!auth.codexLimits?.length) throw new QuotaError('schema');
    const payload = await getJSON(codexUsageUrl(options.codexBase ?? CODEX_USAGE_BASE), auth, options);
    return normalizeCodex(payload, auth, auth.codexLimits, now());
  }
  if (auth.providerId !== 'commandcode') throw new QuotaError('auth');
  const credits = await getJSON(`${COMMANDCODE_ORIGIN}/alpha/billing/credits`, auth, options);
  const subscriptions = await getJSON(`${COMMANDCODE_ORIGIN}/alpha/billing/subscriptions`, auth, options);
  return normalizeCommandCode(credits, subscriptions, auth, now());
}
