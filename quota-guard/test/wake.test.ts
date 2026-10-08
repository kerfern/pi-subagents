import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { QuotaError } from '../../src/quota-guard/adapters.ts';
import { FleetLatch } from '../../src/quota-guard/controller.ts';
import { DEFAULT_POLICY } from '../../src/quota-guard/policy.ts';
import { openStore, type Manifest, type QuotaStore } from '../../src/quota-guard/store.ts';
import { RootWake, type WakeCheck, type WakeDeps } from '../../src/quota-guard/wake.ts';

type Value = Omit<Manifest, 'digest'>;
const T = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function paused(overrides: Partial<Value> = {}): Value {
  return {
    version: 1,
    rootId: 'root-a',
    generation: 1,
    state: 'paused',
    reason: 'threshold',
    updatedAt: iso(0),
    backoffIndex: 0,
    quorum: ['commandcode:provider'],
    checkpoints: [{ id: 'cp', digest: 'deadbeef', generation: 1 }],
    ...overrides,
  };
}

/** A complete, in-policy check: provider-scoped monthly window with headroom and a known reserve. */
function healthy(): WakeCheck {
  return {
    snapshot: {
      providerId: 'commandcode',
      scope: 'provider',
      checkedAt: iso(T),
      windows: [{ id: 'monthly', used: 0, cap: 100, resetAt: iso(T + 3_600_000) }],
    },
    reserve: new Map([['monthly', 5]]),
  };
}

/** A fresh, in-quorum scope whose paused-mode assessment is `wait` (no resume headroom). */
function exhausted(): WakeCheck {
  return {
    snapshot: {
      providerId: 'commandcode',
      scope: 'provider',
      checkedAt: iso(T),
      windows: [{ id: 'monthly', used: 95, cap: 100, resetAt: iso(T + 3_600_000) }],
    },
    reserve: new Map([['monthly', 5]]),
  };
}

interface FakeTimer { delay: number; run: () => void; cancelled: boolean }
function scheduler() {
  const timers: FakeTimer[] = [];
  const schedule = (delay: number, run: () => void) => {
    const timer: FakeTimer = { delay, run, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  };
  return { timers, schedule, armed: () => timers.filter((timer) => !timer.cancelled) };
}

function deps(overrides: Partial<WakeDeps> & Pick<WakeDeps, 'fleet' | 'store'>): WakeDeps {
  return {
    policy: DEFAULT_POLICY,
    now: () => T,
    schedule: () => ({ cancel: () => {} }),
    check: async () => healthy(),
    checkpoint: async () => [{ id: 'cp', digest: 'deadbeef' }],
    ...overrides,
  };
}

/** Records accepted writes on top of a real store, so a rejected write leaves no trace. */
function recording(base: QuotaStore) {
  const written: Value[] = [];
  const store: QuotaStore = {
    read: () => base.read(),
    write: async (value, expectedGeneration) => {
      await base.write(value, expectedGeneration);
      written.push(value);
    },
    close: () => base.close(),
  };
  return { store, written };
}

/** Deterministic in-memory store for the drain/single-runner tests (no filesystem latency). */
function memoryStore(seed: Value | null) {
  let current: Manifest | null = seed === null ? null : { ...seed, digest: 'digest' };
  const store: QuotaStore = {
    read: async () => current,
    write: async (value, expectedGeneration) => {
      const actual = current === null ? null : current.generation;
      if (actual !== expectedGeneration) {
        throw new Error(`Generation mismatch: expected ${expectedGeneration}, found ${actual}`);
      }
      current = { ...value, digest: 'digest' };
    },
    close: async () => {},
  };
  return { store };
}

test('start reinstates a persisted pause and arms the recorded wake without an early check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T + 90_000) }), null);
    const fleet = new FleetLatch('root-a');
    const s = scheduler();
    let checks = 0;
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => { checks++; return healthy(); },
    }));
    await wake.start();
    assert.equal(fleet.snapshot().state, 'paused');
    assert.equal(fleet.snapshot().reason, 'threshold');
    assert.equal(checks, 0, 'a future wake must not check early');
    assert.deepEqual(s.timers.map((timer) => timer.delay), [90_000]);
    assert.equal(wake.status()?.generation, 1);
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an overdue wake catches up on start and reopens with a durable write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1_000) }), null);
    const fleet = new FleetLatch('root-a');
    const s = scheduler();
    let checks = 0;
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => { checks++; return healthy(); },
    }));
    await wake.start();
    assert.equal(checks, 1, 'an overdue wake runs immediately');
    assert.equal(fleet.snapshot().state, 'open');
    assert.equal((await base.read())?.state, 'open');
    assert.equal((await base.read())?.generation, 2);
    assert.equal((await base.read())?.wakeAt, undefined);
    assert.deepEqual(s.timers, []);
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only one runner: a concurrent resume is refused and the check runs exactly once', async () => {
  const fleet = new FleetLatch('root-a');
  fleet.restorePaused(1, 'threshold');
  const { store } = memoryStore(paused());
  let checks = 0;
  let checkpointCalls = 0;
  let finish: (value: WakeCheck) => void = () => {};
  const pending = new Promise<WakeCheck>((resolve) => { finish = resolve; });
  const wake = new RootWake(deps({
    fleet, store,
    checkpoint: async () => { checkpointCalls++; return [{ id: 'cp', digest: 'deadbeef' }]; },
    check: async () => { checks++; return pending; },
  }));

  const first = wake.resume();
  const second = await wake.resume();
  assert.equal(second, false, 'a second runner is refused, not run in parallel');
  assert.equal(await wake.resume(), false);
  await flush();
  assert.equal(checkpointCalls, 1);
  assert.equal(checks, 1);
  finish(healthy());
  assert.equal(await first, true);
  assert.equal(checks, 1, 'the check is never re-run for a refused runner');
  await wake.dispose();
});

test('the wake drains every admitted lease before it checkpoints', async () => {
  const fleet = new FleetLatch('root-a');
  const release = await fleet.enter('coding');
  fleet.pause('threshold'); // draining: one admitted coding lease, generation 1
  const { store } = memoryStore(paused());
  let checkpointRan = false;
  let activeAtCheckpoint = -1;
  const wake = new RootWake(deps({
    fleet, store,
    checkpoint: async () => {
      checkpointRan = true;
      activeAtCheckpoint = fleet.snapshot().active;
      return [{ id: 'cp', digest: 'deadbeef' }];
    },
  }));

  const resumed = wake.resume();
  await flush();
  assert.equal(checkpointRan, false, 'checkpoint must wait for the drain');
  release();
  assert.equal(await resumed, true);
  assert.equal(checkpointRan, true);
  assert.equal(activeAtCheckpoint, 0, 'checkpoint runs only once no work is admitted');
  assert.equal(fleet.snapshot().state, 'open');
  await wake.dispose();
});

test('an unavailable check re-arms on the 30 s ladder and persists the new wait', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    const generations: number[] = [];
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async (generation) => { generations.push(generation); throw new QuotaError('unavailable'); },
    }));

    assert.equal(await wake.resume(), false);
    assert.deepEqual(generations, [1], 'the check is bound to the manifest generation');
    assert.deepEqual(s.timers.map((timer) => timer.delay), [30_000]);
    const read = await base.read();
    assert.equal(read?.state, 'paused');
    assert.equal(read?.generation, 2);
    assert.equal(read?.backoffIndex, 1);
    assert.equal(read?.wakeAt, iso(T + 30_000));
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a later QuotaError retryAt overrides the backoff delay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => { throw new QuotaError('rate-limited', iso(T + 90_000)); },
    }));

    assert.equal(await wake.resume(), false);
    assert.deepEqual(s.timers.map((timer) => timer.delay), [90_000]);
    assert.equal((await base.read())?.wakeAt, iso(T + 90_000));
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reset-settling assessment re-arms at its own deadline instead of reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => ({
        snapshot: {
          providerId: 'commandcode', scope: 'provider', checkedAt: iso(T),
          windows: [{ id: 'monthly', used: 0, cap: 100, resetAt: iso(T - 1_000) }],
        },
        reserve: new Map([['monthly', 5]]),
      }),
    }));

    assert.equal(await wake.resume(), false);
    assert.deepEqual(s.timers.map((timer) => timer.delay), [59_000]);
    assert.equal((await base.read())?.wakeAt, iso(T + 59_000));
    assert.equal(fleet.snapshot().state, 'paused');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 1a: a partial quorum never reopens even when the returned scope is healthy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ quorum: ['commandcode:provider', 'openai-codex:acct-b'] }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const wake = new RootWake(deps({ fleet, store: base }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused', 'one of two quorum scopes is not a complete quorum');
    assert.equal((await base.read())?.state, 'paused');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 1b: a re-pause during the fresh check keeps the guard closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const wake = new RootWake(deps({
      fleet, store: base,
      check: async () => { fleet.pause('reserve'); return healthy(); },
    }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused', 'a moved fleet generation invalidates the approval');
    assert.equal(fleet.snapshot().reason, 'reserve');
    assert.equal((await base.read())?.state, 'paused');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 2a: an incomplete quorum stays closed and persists its next wake deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const rec = recording(base);
    const wake = new RootWake(deps({ fleet, store: rec.store, check: async () => null }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused');
    const read = await base.read();
    assert.equal(read?.state, 'paused', 'a wait must never publish an open state');
    assert.equal(read?.generation, 2);
    assert.equal(read?.wakeAt, iso(T + 30_000), 'the wait deadline must be durable');
    assert.equal(rec.written.every((value) => value.state !== 'open'), true);
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 2b: a persisted wake deadline survives a reload, including one already overdue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null); // generation 1, paused, no wakeAt
    let now = T;

    const firstFleet = new FleetLatch('root-a');
    const first = new RootWake(deps({
      fleet: firstFleet, store: base, now: () => now, check: async () => null,
    }));
    assert.equal(await first.resume(), false);
    await first.dispose();
    const persisted = await base.read();
    assert.equal(persisted?.wakeAt, iso(T + 30_000), 'the first machine must persist its deadline');

    // Reload: a brand new machine over the same store, now past the persisted deadline.
    now = T + 30_001;
    const secondFleet = new FleetLatch('root-a');
    let checks = 0;
    const second = new RootWake(deps({
      fleet: secondFleet, store: base, now: () => now,
      check: async () => { checks++; return healthy(); },
    }));
    await second.start();
    assert.equal(checks, 1, 'a persisted overdue deadline is due immediately after a reload');
    assert.equal(secondFleet.snapshot().state, 'open');
    assert.equal((await base.read())?.state, 'open');
    assert.equal((await base.read())?.generation, 3);
    await second.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown reserve (null) keeps the guard closed and persists its next wake', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const wake = new RootWake(deps({
      fleet, store: base,
      check: async () => ({ ...healthy(), reserve: new Map([['monthly', null]]) }),
    }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused');
    const read = await base.read();
    assert.equal(read?.state, 'paused');
    assert.equal(read?.wakeAt, iso(T + 30_000));
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('identity drift keeps the guard closed and persists its next wake', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused(), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const wake = new RootWake(deps({
      fleet, store: base,
      check: async () => ({
        snapshot: {
          providerId: 'openai-codex', scope: 'account', accountId: 'acct-b', checkedAt: iso(T),
          windows: [{ id: 'codex.primary_window', used: 0, cap: 100, resetAt: iso(T + 3_600_000) }],
        },
        reserve: new Map([['codex.primary_window', 5]]),
      }),
    }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused');
    assert.equal((await base.read())?.state, 'paused');
    assert.equal((await base.read())?.wakeAt, iso(T + 30_000));
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 3: a rejected compare-and-swap reloads the latest manifest and re-arms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T + 90_000) }), null); // generation 1
    const fleet = new FleetLatch('root-a');
    const rec = recording(base);
    const s = scheduler();
    const wake = new RootWake(deps({
      fleet, store: rec.store, schedule: s.schedule,
      check: async () => { throw new QuotaError('unavailable'); },
    }));
    await wake.start(); // holds generation 1, arms for T + 90_000
    assert.equal(fleet.snapshot().state, 'paused');

    // A competing writer advances the manifest while this runner still expects generation 1.
    await base.write(paused({ generation: 2, wakeAt: iso(T + 120_000) }), 1);
    assert.equal(await wake.resume(), false);
    assert.equal(rec.written.length, 0, 'the stale compare-and-swap is rejected, not accepted');
    assert.deepEqual(s.armed().map((timer) => timer.delay), [120_000],
      'a rejected runner must reload and re-arm rather than strand the pause');
    assert.equal(fleet.snapshot().state, 'paused');
    assert.equal((await base.read())?.generation, 2);
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reopen is written durably before the latch is reopened', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1_000) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const order: string[] = [];
    const observable: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        order.push(`write:${value.state}`);
      },
      close: () => base.close(),
    };
    const real = fleet.tryResume.bind(fleet);
    fleet.tryResume = async (freshCheck) => { order.push('reopen'); return await real(freshCheck); };

    const wake = new RootWake(deps({ fleet, store: observable }));
    assert.equal(await wake.resume(), true);
    assert.deepEqual(order, ['write:open', 'reopen'], 'persist before publishing the reopen');
    assert.equal((await base.read())?.state, 'open');
    assert.equal(fleet.snapshot().state, 'open');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 4: a stale timer callback is fenced and cannot clobber the replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T + 90_000) }), null);
    const fleet = new FleetLatch('root-a');
    const s = scheduler();
    let checks = 0;
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => { checks++; return null; },
    }));

    await wake.start();       // arms timer A
    await wake.resume();      // cancels A, persists a wait, arms timer B
    await wake.start();       // cancels B, re-arms timer C
    assert.equal(checks, 1);
    assert.equal(s.armed().length, 1);

    const staleA = s.timers[0];
    const staleB = s.timers[1];
    assert.ok(staleA);
    assert.ok(staleB);
    staleA.run();             // a late fire from the cancelled timer
    staleB.run();
    await flush();
    assert.equal(checks, 1, 'a stale fire must not start another check');
    assert.equal(s.armed().length, 1, 'start -> resume -> start leaves exactly one armed timer');
    assert.equal(fleet.snapshot().state, 'paused');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding 5: a due timer whose fresh check says wait re-arms and stays paused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null); // due now
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let checks = 0;
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => { checks++; return exhausted(); },
    }));

    await wake.resume(); // the due timer firing
    assert.equal(checks, 1);
    assert.equal(fleet.snapshot().state, 'paused', 'time passing alone must not reopen');
    const read = await base.read();
    assert.equal(read?.state, 'paused');
    assert.equal(read?.wakeAt, iso(T + 30_000));
    assert.deepEqual(s.armed().map((timer) => timer.delay), [30_000]);
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispose cancels the timer so a later fire does nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T + 90_000) }), null);
    const fleet = new FleetLatch('root-a');
    const s = scheduler();
    let checks = 0;
    const wake = new RootWake(deps({
      fleet, store: base, schedule: s.schedule,
      check: async () => { checks++; return healthy(); },
    }));
    await wake.start();
    const armed = s.timers[0];
    assert.ok(armed);
    await wake.dispose();
    assert.equal(armed.cancelled, true);
    armed.run(); // a fire that raced the cancel
    await flush();
    assert.equal(checks, 0);
    assert.equal((await base.read())?.state, 'paused');
    assert.equal(fleet.snapshot().state, 'paused');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 2: a re-pause landing during the manifest write never reopens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    const store: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        if (value.state === 'open') fleet.pause('manual'); // re-pause lands while the write is in flight
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused', 'a pause landing under the write must prevent the reopen');
    assert.equal(fleet.snapshot().reason, 'manual');
    const read = await base.read();
    assert.equal(read?.state, 'paused', 'the written open record is withdrawn to a durable pause');
    assert.equal(read?.reason, 'manual');
    assert.equal(read?.wakeAt, iso(T + 30_000));
    assert.deepEqual(s.armed().map((timer) => timer.delay), [30_000]);
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 2: a re-pause landing on the post-write read-back never reopens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    let wroteOpen = false;
    let landed = false;
    const store: QuotaStore = {
      read: async () => {
        const manifest = await base.read();
        if (wroteOpen && !landed) { landed = true; fleet.pause('identity'); }
        return manifest;
      },
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        if (value.state === 'open') wroteOpen = true;
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused', 'a pause landing on the read-back must prevent the reopen');
    assert.equal(fleet.snapshot().reason, 'identity');
    const read = await base.read();
    assert.equal(read?.state, 'paused');
    assert.equal(read?.reason, 'identity');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 3 finding 1a: a failed withdrawal write is retried until it commits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let pausedAttempts = 0;
    const store: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        if (value.state === 'paused' && pausedAttempts++ === 0) {
          throw new Error('injected withdrawal failure');
        }
        await base.write(value, expectedGeneration);
        if (value.state === 'open') fleet.pause('reserve'); // re-pause lands under the open write
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'paused');
    assert.equal(pausedAttempts, 2, 'the withdrawal write is retried after the injected failure');
    const read = await base.read();
    assert.equal(read?.state, 'paused', 'the durable record converges back to the paused state');
    assert.equal(read?.reason, 'reserve');
    assert.equal(read?.generation, 3);
    assert.deepEqual(s.armed().map((timer) => timer.delay), [30_000],
      'the withdrawn pause must be armed rather than stranded');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 3 finding 1b: a persistently failing withdrawal reports and converges on the next wake', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let failing = true;
    let errors = 0;
    let committed: () => void = () => {};
    const committedWrite = new Promise<void>((resolve) => { committed = resolve; });
    const store: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        if (value.state === 'paused' && failing) throw new Error('injected persistent failure');
        await base.write(value, expectedGeneration);
        if (value.state === 'paused') committed();
        if (value.state === 'open') fleet.pause('reserve'); // re-pause lands under the open write
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({
      fleet, store, schedule: s.schedule, onError: () => { errors++; },
    }));

    assert.equal(await wake.resume(), false);
    assert.ok(errors >= 1, 'a withdrawal that cannot be committed is reported, not swallowed');
    assert.equal(fleet.snapshot().state, 'paused', 'the latch is never silently reopened by a write failure');
    assert.equal((await base.read())?.state, 'open');
    const armed = s.armed().at(-1);
    assert.ok(armed, 'the pending withdrawal must leave a wake armed so it is retried');

    failing = false;
    armed.run();
    await committedWrite;
    const read = await base.read();
    assert.equal(read?.state, 'paused', 'the durable record converges once the write recovers');
    assert.equal(read?.generation, 3);
    assert.equal(fleet.snapshot().state, 'paused');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 3 finding 2: a pause+resume landing under the write is not withdrawn to paused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    const written: string[] = [];
    const store: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        written.push(value.state);
        if (value.state === 'open') {
          fleet.pause('manual');                              // a pause lands under the write ...
          await fleet.tryResume(async () => true);            // ... and resumes again before it returns
        }
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'open', 'the latch reopened under the write');
    assert.deepEqual(written, ['open'], 'an already-open latch must not be withdrawn to a durable pause');
    assert.equal((await base.read())?.state, 'open');
    assert.equal((await base.read())?.generation, 2);
    assert.equal(s.armed().length, 0, 'an open latch must not be re-armed into a loop');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 4 finding 1: a resume landing under the withdrawal read is never overwritten with a pause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    const written: string[] = [];
    let openReads = 0;
    const store: QuotaStore = {
      read: async () => {
        const manifest = await base.read();
        // The 'open' write is read back once by #run; the withdrawal's own read is the second one.
        // Land a pause+resume there: the open/paused decision is stale by the time the write happens.
        if (manifest?.state === 'open' && openReads++ === 1) {
          fleet.pause('manual');
          await fleet.tryResume(async () => true);
        }
        return manifest;
      },
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        written.push(value.state);
        if (value.state === 'open') fleet.pause('reserve'); // forces the withdrawal
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule }));

    assert.equal(await wake.resume(), false);
    assert.equal(fleet.snapshot().state, 'open', 'the latch reopened under the withdrawal read');
    assert.deepEqual(written, ['open'], 'an open latch must not be withdrawn to a durable pause');
    assert.equal((await base.read())?.state, 'open');
    assert.equal((await base.read())?.generation, 2);
    assert.equal(s.armed().length, 0, 'an open latch must not be re-armed');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 4 finding 2: a committed-but-threw withdrawal converges after an external resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let throwNextRead = false;
    let errors = 0;
    let opens = 0;
    const store: QuotaStore = {
      read: async () => {
        if (throwNextRead) { throwNextRead = false; throw new Error('injected read-back failure'); }
        return base.read();
      },
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        if (value.state === 'open' && opens++ === 0) fleet.pause('reserve'); // forces the withdrawal
        if (value.state === 'paused') throwNextRead = true;                  // commit, then fail the read-back
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule, onError: () => { errors++; } }));

    assert.equal(await wake.resume(), false);
    assert.ok(errors >= 1, 'the failed withdrawal reaches onError');
    assert.equal((await base.read())?.state, 'paused', 'commit-then-throw leaves a durable pause');
    assert.equal(fleet.snapshot().state, 'paused');

    // An external resume opens the latch while the durable record still claims a pause.
    assert.equal(await fleet.tryResume(async () => true), true);
    assert.equal(fleet.snapshot().state, 'open');

    await wake.resume();
    const read = await base.read();
    assert.equal(read?.state, 'open', 'reality wins: the record converges to the open latch, never paused');
    assert.equal(read?.generation, 4);
    assert.equal(fleet.snapshot().state, 'open');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 4 finding 3: a recovered withdrawal write still reports its failure through onError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let pausedAttempts = 0;
    let errors = 0;
    const store: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        if (value.state === 'paused' && pausedAttempts++ === 0) throw new Error('injected withdrawal failure');
        await base.write(value, expectedGeneration);
        if (value.state === 'open') fleet.pause('reserve');
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule, onError: () => { errors++; } }));

    assert.equal(await wake.resume(), false);
    assert.equal(pausedAttempts, 2, 'the withdrawal write was retried and recovered');
    assert.equal(errors, 1, 'the failed withdrawal attempt reaches onError, not swallowed by the retry');
    assert.equal((await base.read())?.state, 'paused');
    assert.equal(fleet.snapshot().state, 'paused');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 5 finding 1: a pause landing under the converging open write is withdrawn, not left unarmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let flipped = false;
    let openReads = 0;
    let openWrites = 0;
    const store: QuotaStore = {
      read: async () => {
        const manifest = await base.read();
        // The 'open' record is read back once by #run; the withdrawal's own read is the second one.
        // Land it there: another writer records a pause while an external resume opens the latch, so
        // the withdrawal must converge the paused record to the open latch.
        if (!flipped && manifest?.state === 'open' && openReads++ === 1) {
          flipped = true;
          await base.write(paused({ generation: manifest.generation + 1, wakeAt: iso(T + 30_000) }), manifest.generation);
          fleet.pause('manual');
          await fleet.tryResume(async () => true);
          return base.read();
        }
        return manifest;
      },
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);
        if (value.state === 'open' && openWrites++ === 0) {
          fleet.pause('reserve');            // the transient reopen record forces the withdrawal
          return;
        }
        if (value.state === 'open' && openWrites > 1) {
          fleet.pause('identity');           // a pause lands under the converging open write
        }
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule }));

    assert.equal(await wake.resume(), false);
    const read = await base.read();
    assert.equal(fleet.snapshot().state, 'paused', 'the pause landed under the converging write');
    assert.equal(read?.state, 'paused', 'the converging open write must be withdrawn to a pause');
    assert.equal(s.armed().length, 1, 'a paused root must have exactly one armed wake');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round 5 finding 2: a commit-then-throw withdrawal re-reads rather than trusting a stale open record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  try {
    const base = await openStore(dir, 'root-a');
    await base.write(paused({ wakeAt: iso(T - 1) }), null);
    const fleet = new FleetLatch('root-a');
    fleet.restorePaused(1, 'threshold');
    const s = scheduler();
    let opens = 0;
    let errors = 0;
    const store: QuotaStore = {
      read: () => base.read(),
      write: async (value, expectedGeneration) => {
        await base.write(value, expectedGeneration);              // COMMIT first
        if (value.state === 'open' && opens++ === 0) fleet.pause('reserve');
        if (value.state === 'paused') {
          await fleet.tryResume(async () => true);                // an external resume opens the latch ...
          throw new Error('injected post-commit withdrawal failure'); // ... then the call fails
        }
      },
      close: () => base.close(),
    };
    const wake = new RootWake(deps({ fleet, store, schedule: s.schedule, onError: () => { errors++; } }));

    assert.equal(await wake.resume(), false);
    assert.ok(errors >= 1, 'the post-commit failure is reported');
    assert.equal(fleet.snapshot().state, 'open', 'the external resume reopened the latch');
    const read = await base.read();
    assert.equal(read?.state, 'open', 'the committed pause must be converged to the open latch, not trusted stale');
    assert.equal((read?.state === 'open'), (fleet.snapshot().state === 'open'), 'the latch and the record agree');
    await wake.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});