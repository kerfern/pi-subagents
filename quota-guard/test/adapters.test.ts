import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexUsageUrl, normalizeCodex, normalizeCommandCode, readQuota, QuotaError } from '../../src/quota-guard/adapters.ts';

const now = Date.parse('2026-10-04T12:00:00.000Z');
const codexId = { providerId: 'openai-codex' as const, scope: 'account' as const, accountId: 'acct', workspaceId: 'work' };
const commandId = { providerId: 'commandcode' as const, scope: 'account' as const, accountId: 'acct' };
const limits = [{ id: 'codex', windows: ['primary_window', 'secondary_window'] as const }];
const codex = () => ({
  plan_type: 'pro', credits: { balance: '90000', unlimited: true },
  rate_limit: {
    primary_window: { used_percent: 25, reset_at: now / 1000 + 3600, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 120, reset_at: now / 1000 + 7200, limit_window_seconds: 604800 },
  },
  additional_rate_limits: [{ metered_feature: 'codex_spark', limit_name: 'spark', rate_limit: {
    primary_window: { used_percent: 50, reset_at: now / 1000 + 1800, limit_window_seconds: 18000 },
  } }],
});
const credits = (monthlyCredits = 25) => ({
  credits: { monthlyCredits, purchasedCredits: 90000, freeCredits: 90000 },
  windowLimits: { limited: false,
    fiveHour: { used: 2, cap: 10, exceeded: false, resetAt: now / 1000 + 3600 },
    weekly: { used: 4, cap: 20, exceeded: false, resetAt: new Date(now + 7200000).toISOString() },
  },
});
const subscription = (planId = 'individual-pro', status = 'active') => ({ data: {
  planId, status, currentPeriodEnd: now / 1000 + 30 * 86400,
} });
const schema = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof QuotaError && error.code === 'schema');
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...extra },
});
const fake = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((input: URL | RequestInfo, init?: RequestInit) => Promise.resolve(fn(String(input), init))) as typeof fetch;
const auth = (providerId: 'openai-codex' | 'commandcode') => ({ providerId, scope: 'account' as const, accountId: 'acct', apiKey: 'fixture-secret-key', codexLimits: limits });
const fail = (code: string) => (error: unknown) => error instanceof QuotaError && error.code === code
  && !error.message.includes('fixture-secret-key') && !JSON.stringify(error).includes('fixture-secret-key');

test('Codex uses only explicitly applicable meters, ignores bonus credits, preserves overuse and inputs', () => {
  const body = codex(); const before = JSON.stringify(body);
  const standard = normalizeCodex(body, codexId, limits, now);
  assert.deepEqual(standard.windows.map(w => [w.id, w.used, w.cap]), [
    ['codex.primary_window', 25, 100], ['codex.secondary_window', 120, 100],
  ]);
  const spark = normalizeCodex(body, codexId, [{ id: 'codex_spark', windows: ['primary_window'] }], now);
  assert.deepEqual(spark.windows.map(w => w.used), [50]);
  assert.equal(standard.windows[0]?.resetAt, new Date(now + 3600000).toISOString());
  assert.equal(JSON.stringify(body), before);
  assert.ok(Object.isFrozen(standard)); assert.ok(Object.isFrozen(standard.windows[0]));
});

test('Codex rejects empty/duplicate selection, missing or malformed required data and ambiguous meters', () => {
  for (const selection of [[], [{ id: 'codex', windows: [] }], [{ id: 'codex', windows: ['primary_window', 'primary_window'] as const }], [...limits, ...limits]]) {
    schema(() => normalizeCodex(codex(), codexId, selection, now));
  }
  schema(() => normalizeCodex({}, codexId, limits, now));
  schema(() => normalizeCodex(codex(), codexId, [{ id: 'missing', windows: ['primary_window'] }], now));
  const bad = codex(); bad.rate_limit.primary_window.used_percent = Number.NaN;
  schema(() => normalizeCodex(bad, codexId, limits, now));
  const duplicate = codex(); duplicate.additional_rate_limits.push(duplicate.additional_rate_limits[0]);
  schema(() => normalizeCodex(duplicate, codexId, [{ id: 'codex_spark', windows: ['primary_window'] }], now));
});

test('CommandCode included allowance and returned caps survive limited:false; purchases never count', () => {
  const body = credits(); const before = JSON.stringify(body);
  const result = normalizeCommandCode(body, subscription(), commandId, now);
  assert.deepEqual(result.windows.map(w => [w.id, w.used, w.cap]), [['monthly', 5, 30], ['fiveHour', 2, 10], ['weekly', 4, 20]]);
  assert.equal(result.windows[0]?.resetAt, new Date(now + 30 * 86400000).toISOString());
  assert.equal(JSON.stringify(body), before); assert.ok(Object.isFrozen(result.windows));
  body.windowLimits.fiveHour.exceeded = true;
  assert.equal(normalizeCommandCode(body, subscription(), commandId, now).windows[1]?.used, 10);
});

test('CommandCode exact supported pools; unknown variants/inactive/missing/over-pool allowance reject', () => {
  const pools = { 'individual-ultra': 300, 'individual-max': 150, 'individual-provider': 15, 'individual-goat': 70,
    'individual-pro-v1': 80, 'individual-pro': 30, 'individual-go': 10, 'teams-pro': 40 };
  for (const [plan, cap] of Object.entries(pools)) assert.equal(normalizeCommandCode(credits(1), subscription(plan), commandId, now).windows[0]?.cap, cap);
  for (const plan of ['individual-pro-v9', 'constructor', '__proto__']) schema(() => normalizeCommandCode(credits(), subscription(plan), commandId, now));
  schema(() => normalizeCommandCode(credits(31), subscription(), commandId, now));
  schema(() => normalizeCommandCode(credits(), subscription('individual-pro', 'canceled'), commandId, now));
  schema(() => normalizeCommandCode({}, subscription(), commandId, now));
  schema(() => normalizeCommandCode(credits(), { data: { planId: 'individual-pro', status: 'active' } }, commandId, now));
});

test('normalizers reject identity/provider mismatch, nonfinite clock and invalid UTC timestamps', () => {
  schema(() => normalizeCodex(codex(), commandId, limits, now));
  schema(() => normalizeCommandCode(credits(), subscription(), codexId, now));
  schema(() => normalizeCodex(codex(), codexId, limits, Number.NaN));
  const bad = credits(); bad.windowLimits.weekly.resetAt = '2026-02-30T12:00:00.000Z';
  schema(() => normalizeCommandCode(bad, subscription(), commandId, now));
});

test('GET origins, paths, redirect policy and per-provider headers pinned', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = fake((url, init) => { calls.push({ url, init }); return json(url.includes('chatgpt.com') ? codex() : url.endsWith('credits') ? credits() : subscription()); });
  await readQuota(auth('openai-codex'), { now: () => now, fetchImpl });
  assert.equal(calls[0]?.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(new Headers(calls[0]?.init?.headers).get('chatgpt-account-id'), 'acct');
  calls.length = 0;
  assert.equal((await readQuota(auth('commandcode'), { now: () => now, fetchImpl })).windows.length, 3);
  assert.deepEqual(calls.map(c => c.url), ['https://api.commandcode.ai/alpha/billing/credits', 'https://api.commandcode.ai/alpha/billing/subscriptions']);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(call.init?.method, 'GET'); assert.equal(call.init?.redirect, 'error');
    assert.equal(headers.get('authorization'), 'Bearer fixture-secret-key'); assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('x-command-code-version'), '1.0.0'); assert.equal(headers.get('x-cli-environment'), 'production');
  }
});

test('invalid header bytes reject before transport with sanitized auth errors', async () => {
  let calls = 0;
  const fetchImpl = fake(() => { calls++; return json(codex()); });
  for (const invalid of [
    { ...auth('openai-codex'), apiKey: 'fixture-secret-\u0100' },
    { ...auth('commandcode'), apiKey: 'fixture-secret-\u0100' },
    { ...auth('openai-codex'), accountId: 'acct-\u0100' },
  ]) await assert.rejects(readQuota(invalid, { fetchImpl }), fail('auth'));
  assert.equal(calls, 0);
});

test('pre-abort sends nothing; pending external abort is sanitized', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(readQuota(auth('openai-codex'), { signal: controller.signal, fetchImpl: fake(() => { calls++; return json(codex()); }) }), fail('aborted'));
  assert.equal(calls, 0);
  const pending = new AbortController();
  const operation = readQuota(auth('openai-codex'), { signal: pending.signal, fetchImpl: fake(() => new Promise(() => {})) });
  pending.abort(); await assert.rejects(operation, fail('aborted'));
});

test('15s deadline covers uncooperative fetch without exposing secrets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const operation = readQuota(auth('openai-codex'), { fetchImpl: fake(() => new Promise(() => {})), now: () => Date.now() });
  t.mock.timers.tick(15000); await assert.rejects(operation, fail('timeout'));
});

test('429 Retry-After preserved as UTC ISO, auth/network failures discard raw responses/errors', async () => {
  await assert.rejects(readQuota(auth('openai-codex'), { now: () => now, fetchImpl: fake(() => json({}, 429, { 'retry-after': '120' })) }),
    (error: unknown) => error instanceof QuotaError && error.code === 'rate-limited' && error.retryAt === new Date(now + 120000).toISOString());
  await assert.rejects(readQuota(auth('openai-codex'), { fetchImpl: fake(() => json({ error: 'fixture-secret-key' }, 401)) }), fail('auth'));
  await assert.rejects(readQuota(auth('openai-codex'), { fetchImpl: fake(() => { throw new Error('fixture-secret-key'); }) }), fail('unavailable'));
});

test('codex usage URL derives from the verified base and rejects foreign origins', () => {
  assert.equal(codexUsageUrl('https://chatgpt.com/backend-api/codex'), 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(codexUsageUrl('https://chatgpt.com/backend-api'), 'https://chatgpt.com/backend-api/wham/usage');
  assert.throws(() => codexUsageUrl('https://evil.example/backend-api/codex'), (e: unknown) => e instanceof QuotaError && e.code === 'schema');
  assert.throws(() => codexUsageUrl('http://chatgpt.com/backend-api'), (e: unknown) => e instanceof QuotaError && e.code === 'schema');
});

test('provider-scope snapshot omits accountId; account-scope requires it', () => {
  const providerScope = normalizeCommandCode(credits(), subscription(), { providerId: 'commandcode', scope: 'provider' }, now);
  assert.equal(providerScope.scope, 'provider');
  assert.equal('accountId' in providerScope, false);
  assert.throws(() => normalizeCodex(codex(), { providerId: 'openai-codex', scope: 'account' }, limits, now),
    (e: unknown) => e instanceof QuotaError && e.code === 'schema');
});

test('readQuota derives the Codex usage URL from a caller-supplied verified base and rejects foreign bases', async () => {
  const calls: string[] = [];
  await readQuota(auth('openai-codex'), { now: () => now, codexBase: 'https://chatgpt.com/backend-api/codex',
    fetchImpl: fake(url => { calls.push(url); return json(codex()); }) });
  assert.deepEqual(calls, ['https://chatgpt.com/backend-api/wham/usage']);
  let transport = 0;
  await assert.rejects(readQuota(auth('openai-codex'), { now: () => now, codexBase: 'https://evil.example/backend-api',
    fetchImpl: fake(() => { transport++; return json(codex()); }) }),
    (e: unknown) => e instanceof QuotaError && e.code === 'schema');
  assert.equal(transport, 0);
});

test('redirects, foreign response URLs, content type, malformed or oversized JSON reject', async () => {
  const responses = [Response.redirect('https://evil.example/'), new Response('x', { headers: { 'content-type': 'text/plain' } }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    json({ ...codex(), padding: 'x'.repeat(128 * 1024 + 1) })];
  const foreign = json(codex()); Object.defineProperty(foreign, 'url', { value: 'https://evil.example/' }); responses.push(foreign);
  for (const response of responses) await assert.rejects(readQuota(auth('openai-codex'), { now: () => now, fetchImpl: fake(() => response) }),
    (error: unknown) => error instanceof QuotaError && !error.message.includes('evil.example'));
});
