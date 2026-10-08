// Certification of the operator-run live script, entirely offline: every transport here is a fake,
// the credential is a synthetic string, and the assertions include that nothing was sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../certify-live.mjs';

const SECRET = 'fixture-secret-key';
const now = Date.parse('2026-10-04T12:00:00.000Z');
const limits = JSON.stringify([{ id: 'codex', windows: ['primary_window', 'secondary_window'] }]);
const credentials = {
  COMMANDCODE_API_KEY: SECRET,
  CODEX_ACCESS_TOKEN: SECRET,
  CODEX_ACCOUNT_ID: 'acct',
  CODEX_LIMITS: limits,
};
const codexBody = () => ({
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 25, reset_at: now / 1000 + 3600, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 40, reset_at: now / 1000 + 7200, limit_window_seconds: 604800 },
  },
});
const creditsBody = () => ({
  credits: { monthlyCredits: 25, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: false,
    fiveHour: { used: 2, cap: 10, exceeded: false, resetAt: now / 1000 + 3600 },
    weekly: { used: 4, cap: 20, exceeded: false, resetAt: new Date(now + 7200000).toISOString() },
  },
});
const subscriptionsBody = () => ({ data: { planId: 'individual-pro', status: 'active', currentPeriodEnd: now / 1000 + 30 * 86400 } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const route = (url: string) =>
  json(url.endsWith('credits') ? creditsBody() : url.includes('chatgpt.com') ? codexBody() : subscriptionsBody());

/** Captures what the script printed, and every URL its injected transport was asked for. */
function harness(respond: (url: string) => Response) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const fetchImpl = ((input: URL | RequestInfo) => {
    urls.push(String(input));
    return Promise.resolve(respond(String(input)));
  }) as unknown as typeof fetch;
  const run = (argv: string[], env: Record<string, string | undefined>) =>
    main({
      argv,
      env,
      fetchImpl,
      log: (line: string) => { out.push(line); },
      fail: (line: string) => { err.push(line); },
    });
  return { out, err, urls, run };
}

const output = (result: { out: string[]; err: string[] }): string => [...result.out, ...result.err].join('\n');
const planned = (result: { out: string[] }): string[] => result.out.filter((line) => line.startsWith('  http')).map((line) => line.trim());

test('refuses instead of guessing which quota to certify', async () => {
  const bare = harness(route);
  assert.equal(await bare.run([], credentials), 2);
  assert.equal(bare.urls.length, 0);
  assert.match(output(bare), /no provider given/);
  assert.match(output(bare), /usage: node quota-guard\/certify-live\.mjs/);
  const unknown = harness(route);
  assert.equal(await unknown.run(['openai'], credentials), 2);
  assert.equal(unknown.urls.length, 0);
  assert.match(output(unknown), /unknown provider "openai"/);
  const unparsed = harness(route);
  assert.equal(await unparsed.run(['--dry-run'], credentials), 2);
  assert.match(output(unparsed), /no provider given/);
});

test('names the environment variable each provider needs when the credential is absent', async () => {
  const commandcode = harness(route);
  assert.equal(await commandcode.run(['commandcode'], {}), 1);
  assert.match(output(commandcode), /missing credential\(s\) for commandcode: COMMANDCODE_API_KEY/);
  assert.match(output(commandcode), /COMMANDCODE_API_KEY {2}the CommandCode API key/);
  assert.equal(commandcode.urls.length, 0);
  const codex = harness(route);
  assert.equal(await codex.run(['codex'], {}), 1);
  assert.match(output(codex), /missing credential\(s\) for codex: CODEX_ACCESS_TOKEN, CODEX_ACCOUNT_ID, CODEX_LIMITS/);
  for (const name of ['CODEX_ACCESS_TOKEN', 'CODEX_ACCOUNT_ID', 'CODEX_LIMITS']) assert.match(output(codex), new RegExp(name));
  assert.equal(codex.urls.length, 0);
});

test('dry run prints the pinned origins and paths, and transports nothing', async () => {
  const ready = harness(route);
  assert.equal(await ready.run(['--dry-run', 'commandcode'], credentials), 0);
  assert.deepEqual(planned(ready), [
    'https://api.commandcode.ai/alpha/billing/credits',
    'https://api.commandcode.ai/alpha/billing/subscriptions',
  ]);
  assert.match(output(ready), /dry run: nothing sent/);
  assert.equal(ready.urls.length, 0);
  // The dry run doubles as a readiness check: the plan prints, and a missing variable is non-zero.
  const unready = harness(route);
  assert.equal(await unready.run(['commandcode', '--dry-run'], {}), 1);
  assert.equal(unready.urls.length, 0);
  assert.match(output(unready), /api\.commandcode\.ai\/alpha\/billing\/credits/);
  assert.match(output(unready), /COMMANDCODE_API_KEY/);
  const codex = harness(route);
  assert.equal(await codex.run(['--dry-run', 'codex'], credentials), 0);
  assert.deepEqual(planned(codex), ['https://chatgpt.com/backend-api/wham/usage']);
  assert.equal(codex.urls.length, 0);
});

test('the dry-run plan is exactly what the adapters request, one GET per endpoint', async () => {
  const plan = harness(route);
  assert.equal(await plan.run(['--dry-run', 'commandcode'], credentials), 0);
  const live = harness(route);
  assert.equal(await live.run(['commandcode'], credentials), 0);
  assert.deepEqual(live.urls, planned(plan));
  assert.equal(live.urls.length, 2);
  assert.match(output(live), /requests made: 2 \(/);
  const codexPlan = harness(route);
  assert.equal(await codexPlan.run(['--dry-run', 'codex'], credentials), 0);
  const codexLive = harness(route);
  assert.equal(await codexLive.run(['codex'], credentials), 0);
  assert.deepEqual(codexLive.urls, planned(codexPlan));
  assert.equal(codexLive.urls.length, 1);
});

test('a refusal from the adapter exits non-zero and prints nothing sensitive', async () => {
  const denied = harness(() => json({ error: SECRET }, 401));
  assert.equal(await denied.run(['commandcode'], credentials), 1);
  assert.match(output(denied), /certification refused: auth/);
  assert.match(output(denied), /the guard stays closed/i);
  const unparsable = harness(() => json({}, 200));
  assert.equal(await unparsable.run(['codex'], credentials), 1);
  assert.match(output(unparsable), /certification refused: schema/);
  for (const result of [denied, unparsable]) {
    assert.ok(!output(result).includes(SECRET));
    assert.ok(!/authorization|bearer/i.test(output(result)));
  }
});

test('a certified read prints the windows, reserve state and request count', async () => {
  const commandcode = harness(route);
  assert.equal(await commandcode.run(['commandcode'], credentials), 0);
  const lines = output(commandcode);
  assert.match(lines, /monthly {2}used 5 {2}cap 30/);
  assert.match(lines, /fiveHour {2}used 2 {2}cap 10/);
  assert.match(lines, /reserve:/);
  assert.match(lines, /unknown \(one read/);
  assert.match(lines, /assessment: \w+ \/ [\w-]+/);
  assert.match(lines, /thresholds: warn 20% pause 10% resume 20%/);
  assert.match(lines, /certified: yes/);
  assert.deepEqual(commandcode.urls, [
    'https://api.commandcode.ai/alpha/billing/credits',
    'https://api.commandcode.ai/alpha/billing/subscriptions',
  ]);
  const codex = harness(route);
  assert.equal(await codex.run(['codex'], credentials), 0);
  assert.match(output(codex), /codex\.primary_window {2}used 25 {2}cap 100/);
  assert.match(output(codex), /requests made: 1 \(/);
  assert.ok(!output(codex).includes('acct'));
  assert.ok(!output(commandcode).includes(SECRET));
  assert.ok(!output(codex).includes(SECRET));
});

test('a malformed CODEX_LIMITS is refused before any request', async () => {
  const unparsable = harness(route);
  assert.equal(await unparsable.run(['codex'], { ...credentials, CODEX_LIMITS: 'not json' }), 1);
  assert.match(output(unparsable), /CODEX_LIMITS is not valid JSON/);
  assert.equal(unparsable.urls.length, 0);
  const misshapen = harness(route);
  assert.equal(await misshapen.run(['codex'], { ...credentials, CODEX_LIMITS: '[{"id":"codex"}]' }), 1);
  assert.match(output(misshapen), /CODEX_LIMITS must be a non-empty JSON array/);
  assert.equal(misshapen.urls.length, 0);
});
