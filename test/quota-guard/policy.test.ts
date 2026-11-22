import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assess, DEFAULT_POLICY, ReserveEstimator, validatePolicy } from '../../src/quota-guard/policy.ts';
import type { Policy, QuotaSnapshot, QuotaWindow } from '../../src/quota-guard/types.ts';

const now = Date.parse('2026-10-04T12:00:00.000Z');
const policy: Policy = { warn: 20, pause: 10, resume: 20 };
const windowOf = (id: string, used: number, cap = 100, resetAt: string | null = '2026-10-04T13:00:00.000Z'): QuotaWindow => ({ id, used, cap, resetAt });
const snapshotOf = (windows: readonly QuotaWindow[], checkedAt = '2026-10-04T11:59:00.000Z'): QuotaSnapshot => ({
  providerId: 'openai-codex', scope: 'account', accountId: 'acct', checkedAt, windows,
});
const reserve = (...values: [string, number | null][]): ReadonlyMap<string, number | null> => new Map(values);

function assessAt(
  windows: readonly QuotaWindow[],
  mode: 'running' | 'paused' = 'running',
  reserves: ReadonlyMap<string, number | null> = new Map(windows.map(({ id }) => [id, 0])),
  checkedAt?: string,
) {
  return assess(snapshotOf(windows, checkedAt), policy, mode, reserves, now);
}

describe('shipped thresholds', () => {
  it('refuses only once 3% of the headroom is left', () => {
    const at = (used: number) => assess(snapshotOf([windowOf('monthly', used, 100)]), DEFAULT_POLICY, 'running',
      reserve(['monthly', 0]), now);
    assert.equal(at(96).state, 'warn', '4% left still admits, in the warn band');
    assert.equal(at(97).state, 'pause', 'the boundary is inclusive: exactly 3% left already refuses');
    assert.equal(at(98).state, 'pause', '2% left refuses');
  });
});

describe('policy validation', () => {
  it('returns frozen copy of valid policy and rejects out-of-order or non-finite values', () => {
    const input = { ...policy };
    assert.deepEqual(DEFAULT_POLICY, { warn: 20, pause: 3, resume: 20 });
    const result = validatePolicy(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
    assert.ok(Object.isFrozen(result));
    for (const invalid of [
      { warn: 20, pause: 20, resume: 20 },
      { warn: 10, pause: 11, resume: 20 },
      { warn: 20, pause: 10, resume: 100 },
      { warn: Number.NaN, pause: 10, resume: 20 },
      { warn: 20, pause: Number.POSITIVE_INFINITY, resume: 30 },
    ]) assert.throws(() => validatePolicy(invalid));
  });
});

describe('quota assessment', () => {
  it('uses exact pause/warn boundaries while paused resume is strict', () => {
    assert.deepEqual(assessAt([windowOf('w', 90)]), { state: 'pause', reason: 'threshold', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 80)]), { state: 'warn', reason: 'threshold', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 79)]), { state: 'open', reason: 'healthy' });
    assert.deepEqual(assessAt([windowOf('w', 80)], 'paused'), { state: 'wait', reason: 'threshold', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 79)], 'paused'), { state: 'open', reason: 'healthy' });
  });

  it('requires additive resume percentage plus reserve, strictly above combined boundary', () => {
    for (const used of [70, 65]) assert.deepEqual(assessAt([windowOf('w', used)], 'paused', reserve(['w', 15])), {
      state: 'wait', reason: 'reserve', limitingWindow: 'w',
    });
    assert.deepEqual(assessAt([windowOf('w', 64.99)], 'paused', reserve(['w', 15])), { state: 'open', reason: 'healthy' });
    assert.deepEqual(assessAt([windowOf('w', 140, 200)], 'paused', reserve(['w', 30])), { state: 'wait', reason: 'reserve', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 70)], 'running', reserve(['w', 15])), { state: 'open', reason: 'healthy' });
  });

  it('prioritizes threshold over reserve; reserve pauses/waits before warn', () => {
    assert.deepEqual(assessAt([windowOf('w', 90)], 'running', reserve(['w', 50])), { state: 'pause', reason: 'threshold', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 70)], 'running', reserve(['w', 31])), { state: 'pause', reason: 'reserve', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 70)], 'paused', reserve(['w', 31])), { state: 'wait', reason: 'reserve', limitingWindow: 'w' });
  });

  it('fails closed on unknown reserve and invalid or missing data', () => {
    assert.deepEqual(assessAt([windowOf('w', 0)], 'running', reserve(['w', null])), { state: 'wait', reason: 'unknown-reserve', limitingWindow: 'w' });
    for (const windows of [[], [windowOf('w', -1)], [windowOf('w', 1, 0)], [windowOf('w', 1, 100, 'bad')]]) {
      assert.deepEqual(assessAt(windows), { state: 'wait', reason: 'unavailable' });
    }
    assert.deepEqual(assessAt([windowOf('w', 1)], 'running', reserve()), { state: 'wait', reason: 'unknown-reserve', limitingWindow: 'w' });
    assert.deepEqual(assessAt([windowOf('w', 1)], 'running', reserve(['w', 0]), '2026-10-04T12:00:01.000Z'), { state: 'wait', reason: 'unavailable' });
  });

  it('selects most restrictive mixed window and settles immediately after reset epoch', () => {
    assert.deepEqual(assessAt([windowOf('month', 50, 100), windowOf('day', 90, 100)]), { state: 'pause', reason: 'threshold', limitingWindow: 'day' });
    assert.deepEqual(assessAt([windowOf('w', 95, 100, '2026-10-04T11:59:00.000Z')]), {
      state: 'wait', reason: 'reset-settling', limitingWindow: 'w', nextCheckAt: '2026-10-04T12:00:00.000Z',
    });
    assert.deepEqual(assessAt([windowOf('w', 95, 100, '2026-10-04T12:01:00.000Z')]), { state: 'pause', reason: 'threshold', limitingWindow: 'w' });
  });

  it('never opens expired counters merely because reset time elapsed', () => {
    assert.deepEqual(assess(snapshotOf([windowOf('w', 0, 100, '2026-10-04T11:58:00.000Z')], '2026-10-04T12:00:00.000Z'), policy, 'paused', reserve(['w', 0]), now), {
      state: 'wait', reason: 'unavailable', limitingWindow: 'w',
    });
  });

  it('assesses provider-scope snapshots without accountId and rejects a stray one', () => {
    const providerSnapshot: QuotaSnapshot = {
      providerId: 'commandcode', scope: 'provider', checkedAt: '2026-10-04T11:59:00.000Z', windows: [windowOf('w', 0)],
    };
    assert.deepEqual(assess(providerSnapshot, policy, 'running', reserve(['w', 0]), now), { state: 'open', reason: 'healthy' });
    assert.deepEqual(assess({ ...providerSnapshot, accountId: 'acct' }, policy, 'running', reserve(['w', 0]), now), { state: 'wait', reason: 'unavailable' });
  });

  it('rejects duplicate windows and invalid reserves', () => {
    assert.deepEqual(assessAt([windowOf('w', 0), windowOf('w', 1)]), { state: 'wait', reason: 'unavailable' });
    assert.deepEqual(assessAt([windowOf('w', 0)], 'running', reserve(['w', -1])), { state: 'wait', reason: 'unavailable' });
    assert.deepEqual(assessAt([windowOf('w', 0)], 'running', reserve(['w', Number.NaN])), { state: 'wait', reason: 'unavailable' });
  });

  it('does not mutate caller snapshot, windows, policy, or reserve map', () => {
    const windows = [windowOf('w', 90)];
    const inputPolicy = { ...policy };
    const reserves = reserve(['w', 0]);
    const before = JSON.stringify({ windows, inputPolicy, entries: [...reserves] });
    assess(snapshotOf(windows), inputPolicy, 'running', reserves, now);
    assert.equal(JSON.stringify({ windows, inputPolicy, entries: [...reserves] }), before);
  });
});

describe('reserve estimator', () => {
  it('starts unknown, estimates twice largest positive delta over last five, and evicts older peaks', () => {
    const estimator = new ReserveEstimator();
    const sample = (used: number) => estimator.observe('acct', [windowOf('w', used)]).get('w');
    assert.equal(sample(0), null);
    assert.equal(sample(3), 6);
    assert.equal(sample(4), 6);
    assert.equal(sample(5), 6);
    assert.equal(sample(6), 6);
    assert.equal(sample(7), 6);
    assert.equal(sample(8), 2);
  });

  it('ignores zero deltas, resets on refill/scope/reset changes, and isolates accounts', () => {
    const estimator = new ReserveEstimator();
    const win = (used: number, id = 'w', resetAt = '2026-10-04T13:00:00.000Z') => [windowOf(id, used, 100, resetAt)];
    assert.equal(estimator.observe('a', win(10)).get('w'), null);
    assert.equal(estimator.observe('a', win(10)).get('w'), null);
    assert.equal(estimator.observe('a', win(12)).get('w'), 4);
    assert.equal(estimator.observe('a', win(1)).get('w'), null);
    assert.equal(estimator.observe('b', win(20)).get('w'), null);
    assert.equal(estimator.observe('a', win(2, 'other')).get('other'), null);
    assert.equal(estimator.observe('a', win(3, 'other', '2026-10-04T14:00:00.000Z')).get('other'), null);
    assert.equal(estimator.observe('b', win(21)).get('w'), 2);
    assert.equal(estimator.observe('b', win(22, 'w', '2026-10-04T14:00:00.000Z')).get('w'), null);
  });

  it('clears changed capacity and never exposes mutable internal history', () => {
    const estimator = new ReserveEstimator();
    estimator.observe('scope', [windowOf('w', 10)]);
    const result = estimator.observe('scope', [windowOf('w', 12)]);
    assert.equal(result.get('w'), 4);
    (result as Map<string, number | null>).set('w', 999);
    assert.equal(estimator.observe('scope', [windowOf('w', 12)]).get('w'), 4);
    assert.equal(estimator.observe('scope', [windowOf('w', 13, 200)]).get('w'), null);
    assert.equal(estimator.observe('different-workspace', [windowOf('w', 14, 200)]).get('w'), null);
  });
});

describe('windows with no reset pending', () => {
  const rolling = (id: string, used: number, cap: number): QuotaWindow => ({ id, used, cap, resetAt: null });
  const commandSnapshot = (windows: readonly QuotaWindow[]): QuotaSnapshot => ({
    providerId: 'commandcode', scope: 'provider', checkedAt: '2026-10-04T11:59:00.000Z', windows,
  });

  it('admits a CommandCode rolling window that reports no reset, and still gates it', () => {
    assert.deepEqual(assess(commandSnapshot([rolling('fiveHour', 0, 14)]), policy, 'running', reserve(['fiveHour', 0]), now),
      { state: 'open', reason: 'healthy' });
    assert.deepEqual(assess(commandSnapshot([rolling('weekly', 34, 35)]), policy, 'running', reserve(['weekly', 0]), now),
      { state: 'pause', reason: 'threshold', limitingWindow: 'weekly' }, 'no reset instant does not lift the threshold');
    assert.deepEqual(assess(commandSnapshot([rolling('fiveHour', 0, 14)]), policy, 'running', reserve(), now),
      { state: 'wait', reason: 'unknown-reserve', limitingWindow: 'fiveHour' },
      'a null reset never supplies a reserve');
    assert.deepEqual(assess(commandSnapshot([rolling('fiveHour', 0, 14)]), policy, 'running', reserve(['fiveHour', 3]), now),
      { state: 'open', reason: 'healthy' }, 'an operator seed still fills the unknown');
    assert.deepEqual(assess(commandSnapshot([rolling('fiveHour', 0, 14)]), policy, 'running', reserve(['fiveHour', 14]), now),
      { state: 'pause', reason: 'reserve', limitingWindow: 'fiveHour' }, 'a seeded reserve that exceeds the headroom still refuses');
  });

  it('rejects a missing reset on the monthly pool and on every Codex window', () => {
    assert.deepEqual(assess(commandSnapshot([rolling('monthly', 1, 30)]), policy, 'running', reserve(['monthly', 0]), now),
      { state: 'wait', reason: 'unavailable' });
    assert.deepEqual(assess(snapshotOf([rolling('codex.primary_window', 1, 100)]), policy, 'running',
      reserve(['codex.primary_window', 0]), now), { state: 'wait', reason: 'unavailable' });
    // The id alone is not enough: only CommandCode may report it, so a Codex snapshot cannot borrow it.
    assert.deepEqual(assess(snapshotOf([rolling('weekly', 1, 100)]), policy, 'running', reserve(['weekly', 0]), now),
      { state: 'wait', reason: 'unavailable' });
  });

  it('drops the estimate instead of learning across a window with no reset instant', () => {
    const estimator = new ReserveEstimator();
    const at = '2026-10-04T13:00:00.000Z';
    const seen = (used: number, resetAt: string | null) => estimator.observe('acct', [windowOf('weekly', used, 35, resetAt)]).get('weekly');
    assert.equal(seen(1, at), null);
    assert.equal(seen(2, at), 2, 'two observations with movement estimate a reserve');
    assert.equal(seen(3, null), null, 'the sentinel reports unknown, never the carried estimate');
    assert.equal(seen(4, at), null, 'the history was dropped, not carried across the gap');

    // A null window drops only itself: the sibling's history and estimate must survive the same read.
    const both = new ReserveEstimator();
    const pair = (weekly: number, resetAt: string | null, fiveHour: number) =>
      both.observe('acct', [windowOf('fiveHour', fiveHour, 14), windowOf('weekly', weekly, 35, resetAt)]);
    pair(1, at, 1);
    const before = pair(3, at, 2);
    assert.equal(before.get('weekly'), 4, 'weekly estimate is known before the gap');
    assert.equal(before.get('fiveHour'), 2, 'fiveHour estimate is known before the gap');
    const witnessed = pair(5, null, 3);
    assert.equal(witnessed.get('weekly'), null, 'the sentinel reports unknown for its own window');
    assert.equal(witnessed.get('fiveHour'), 2, 'the sibling keeps calibrating through the same read');
  });
});
