import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountFifo, FleetLatch } from '../../src/quota-guard/controller.ts';

const flush = () => Promise.resolve();

test('account FIFO admits one lease, orders siblings, allows other accounts, releases idempotently', async () => {
  const fifo = new AccountFifo(); const order: number[] = [];
  const first = await fifo.enter('verified-account-a');
  const second = fifo.enter('verified-account-a').then(release => { order.push(2); return release; });
  const third = fifo.enter('verified-account-a').then(release => { order.push(3); return release; });
  const other = await fifo.enter('verified-account-b');
  await flush(); assert.deepEqual(order, []); other(); first(); first();
  const releaseSecond = await second; assert.deepEqual(order, [2]);
  await flush(); assert.deepEqual(order, [2]); releaseSecond(); (await third)();
  assert.deepEqual(order, [2, 3]); assert.equal(fifo.activeAccounts, 0);
});

test('queued cancellation removes only cancelled ticket; pre-abort never takes slot', async () => {
  const fifo = new AccountFifo(); const first = await fifo.enter('account');
  const abort = new AbortController(); const cancelled = fifo.enter('account', abort.signal);
  const rejection = assert.rejects(cancelled, { name: 'AbortError' }); abort.abort(); await rejection;
  const third = fifo.enter('account'); first(); (await third)();
  await assert.rejects(fifo.enter('account', abort.signal), { name: 'AbortError' });
  assert.equal(fifo.activeAccounts, 0);
});

test('handoff rejects queued ticket aborted after prior inference terminal listener', async () => {
  const fifo = new AccountFifo(); const controller = new AbortController();
  const current = await fifo.enter('account', controller.signal);
  // Model SDK/provider ordering: an earlier abort listener emits the active stream terminal event.
  controller.signal.addEventListener('abort', () => current(), { once: true });
  const queued = fifo.enter('account', controller.signal);
  const rejection = assert.rejects(queued, { name: 'AbortError' });
  controller.abort(); await rejection;
  assert.equal(fifo.activeAccounts, 0);
});

test('abort after admission does not release active inference before genuine terminal', async () => {
  const fifo = new AccountFifo(); const abort = new AbortController();
  const first = await fifo.enter('account', abort.signal); abort.abort();
  let entered = false;
  const second = fifo.enter('account').then(release => { entered = true; return release; });
  await flush(); assert.equal(entered, false); first(); (await second)();
});

test('100 account tickets cancel half queued; survivors stay FIFO and other account progresses', async () => {
  const fifo = new AccountFifo(); const first = await fifo.enter('shared');
  const order: number[] = []; let active = 0; let maxActive = 0;
  const tickets = Array.from({ length: 99 }, (_, index) => {
    const controller = new AbortController();
    const ticket = fifo.enter('shared', controller.signal).then(release => {
      order.push(index + 1); active++; maxActive = Math.max(maxActive, active);
      return () => { active--; release(); };
    });
    return { controller, ticket, index: index + 1 };
  });
  const cancelled = tickets.filter(({ index }) => index % 2 === 0);
  const rejected = cancelled.map(({ ticket }) => assert.rejects(ticket, { name: 'AbortError' }));
  for (const { controller } of cancelled) controller.abort();
  await Promise.all(rejected);
  const other = await fifo.enter('independent'); other();
  first();
  for (const { ticket, index } of tickets.filter(({ index }) => index % 2 === 1)) {
    const release = await ticket; assert.equal(order.at(-1), index); assert.equal(active, 1); release();
  }
  assert.equal(maxActive, 1); assert.equal(fifo.activeAccounts, 0);
});

test('one blocker latches whole fleet; admitted inference and coding finish without forced abort', async () => {
  const fleet = new FleetLatch('root');
  const inference = await fleet.enter('inference'); const coding = await fleet.enter('coding');
  fleet.pause('threshold'); assert.equal(fleet.snapshot().state, 'draining');
  let entered = false; const unaffected = fleet.enter('inference').then(release => { entered = true; return release; });
  await flush(); assert.equal(entered, false);
  inference(); assert.equal(fleet.snapshot().state, 'draining'); coding(); coding();
  assert.equal(fleet.snapshot().state, 'paused');
  assert.equal(await fleet.tryResume(async () => false), false); assert.equal(entered, false);
  assert.equal(await fleet.tryResume(async () => true), true); (await unaffected)();
  assert.equal(fleet.snapshot().state, 'open'); assert.equal(fleet.snapshot().active, 0);
});

test('resume cannot race drain, check failures or newer root generation', async () => {
  const fleet = new FleetLatch('root'); const release = await fleet.enter('coding'); fleet.pause('manual');
  let checks = 0; assert.equal(await fleet.tryResume(async () => { checks++; return true; }), false); assert.equal(checks, 0);
  release(); assert.equal(await fleet.tryResume(async () => { throw new Error('unavailable'); }), false);
  let finish: (result: boolean) => void = () => {};
  const resumed = fleet.tryResume(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const old = fleet.snapshot().generation; fleet.pause('identity'); finish(true);
  assert.equal(await resumed, false); assert.ok(fleet.snapshot().generation > old); assert.equal(fleet.snapshot().state, 'paused');
});

test('queued coding and inference stay blocked through failed and stale resume checks', async () => {
  const fleet = new FleetLatch('root'); fleet.pause('manual');
  let codingEntered = false; let inferenceEntered = false;
  const coding = fleet.enter('coding').then(release => { codingEntered = true; return release; });
  const inference = fleet.enter('inference').then(release => { inferenceEntered = true; return release; });
  assert.equal(await fleet.tryResume(async () => false), false);
  assert.equal(await fleet.tryResume(async () => { throw new Error('unavailable'); }), false);
  let finish: (ready: boolean) => void = () => {};
  const stale = fleet.tryResume(() => new Promise<boolean>(resolve => { finish = resolve; }));
  fleet.pause('identity'); finish(true); assert.equal(await stale, false);
  await flush(); assert.equal(codingEntered, false); assert.equal(inferenceEntered, false);
  assert.deepEqual(fleet.snapshot().active, 0); assert.equal(fleet.snapshot().state, 'paused');
  assert.equal(await fleet.tryResume(async () => true), true);
  const [releaseCoding, releaseInference] = await Promise.all([coding, inference]);
  assert.equal(fleet.snapshot().coding, 1); assert.equal(fleet.snapshot().inferences, 1);
  releaseCoding(); releaseInference(); assert.equal(fleet.snapshot().active, 0);
});

test('pre-aborted and queued-aborted fleet admissions never take leases', async () => {
  const fleet = new FleetLatch('root'); fleet.pause('manual');
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(fleet.enter('coding', preAborted.signal), { name: 'AbortError' });
  const abort = new AbortController(); const queued = fleet.enter('inference', abort.signal);
  const rejection = assert.rejects(queued, { name: 'AbortError' }); abort.abort(); await rejection;
  assert.deepEqual(fleet.snapshot().active, 0);
  assert.equal(fleet.snapshot().coding, 0); assert.equal(fleet.snapshot().inferences, 0);
});

test('pause between open check and admission continuation rechecks fleet state', async () => {
  const fleet = new FleetLatch('root'); let entered = false;
  const pending = fleet.enter('inference').then(release => { entered = true; return release; });
  fleet.pause('manual'); await flush();
  assert.equal(entered, false); assert.equal(fleet.snapshot().state, 'paused'); assert.equal(fleet.snapshot().active, 0);
  assert.equal(await fleet.tryResume(async () => true), true);
  (await pending)(); assert.equal(fleet.snapshot().active, 0);
});

test('paused queue aborts cleanly; orchestration waits do not count as coding work', async () => {
  const fleet = new FleetLatch('root'); fleet.pause('manual');
  const controller = new AbortController(); const waiting = fleet.wait(controller.signal);
  const rejection = assert.rejects(waiting, { name: 'AbortError' }); controller.abort(); await rejection;
  assert.equal(fleet.snapshot().active, 0); assert.equal(fleet.snapshot().state, 'paused');
  assert.equal(await fleet.tryResume(async () => true), true);
  const before = fleet.snapshot(); assert.ok(Object.isFrozen(before)); assert.equal(before.rootId, 'root');
});

test('resume requires a strict boolean fresh check', async () => {
  const fleet = new FleetLatch('root'); fleet.pause('manual');
  assert.equal(await fleet.tryResume(async () => 'yes' as unknown as boolean), false);
  assert.equal(fleet.snapshot().state, 'paused');
});

test('simultaneous resume checks publish only one reopen', async () => {
  const fleet = new FleetLatch('root'); fleet.pause('manual');
  assert.deepEqual(await Promise.all([fleet.tryResume(async () => true), fleet.tryResume(async () => true)]), [true, false]);
});

test('subscribers observe every transition once, and unsubscribing stops delivery', async () => {
  const fleet = new FleetLatch('root');
  const seen: string[] = [];
  const detach = fleet.subscribe((s) => seen.push(`${s.state}:${s.reason ?? '-'}:${s.active}`));
  const release = await fleet.enter('inference');   // admitted before the pause, so it drains
  await flush();
  assert.equal(seen.length, 0, 'acquiring a lease is not a latch transition');
  fleet.pause('threshold');
  assert.deepEqual(seen, ['draining:threshold:1']);
  release();
  assert.deepEqual(seen[1], 'paused:threshold:0', 'the drain completing is reported once');
  assert.equal(seen.length, 2);
  detach();
  await fleet.tryResume(async () => true);
  assert.equal(seen.length, 2, 'a detached subscriber hears nothing more');
});

test('a throwing subscriber cannot break a pause or a release', async () => {
  const fleet = new FleetLatch('root');
  fleet.subscribe(() => { throw new Error('hostile observer'); });
  fleet.pause('reserve');
  assert.equal(fleet.snapshot().state, 'paused');
  assert.doesNotThrow(() => fleet.restorePaused(1, 'reserve')); // notify runs through the observer
  await fleet.tryResume(async () => true);
  const release = await fleet.enter('inference');
  assert.doesNotThrow(() => release());
  assert.equal(fleet.snapshot().inferences, 0);
});

test('restoration reinstates a persisted pause and refuses regressive or active state', async () => {
  const fleet = new FleetLatch('root');
  fleet.restorePaused(7, 'threshold');
  const restored = fleet.snapshot();
  assert.equal(restored.state, 'paused');
  assert.equal(restored.reason, 'threshold');
  assert.equal(restored.generation, 7);
  assert.throws(() => fleet.restorePaused(6, 'threshold'), /regress/);
  assert.throws(() => fleet.restorePaused(7.5, 'threshold'), /non-negative integer/);

  const busy = new FleetLatch('root');
  const release = await busy.enter('coding');
  assert.throws(() => busy.restorePaused(1, 'manual'), /work is admitted/);
  release();
  busy.restorePaused(1, 'manual');
  assert.equal(busy.snapshot().state, 'paused');
});

test('a restored pause still requires a fresh check before it reopens', async () => {
  const fleet = new FleetLatch('root');
  fleet.restorePaused(3, 'reserve');
  let checked = 0;
  assert.equal(await fleet.tryResume(async () => { checked++; return false; }), false);
  assert.equal(fleet.snapshot().state, 'paused', 'a refused check leaves the block in place');
  assert.equal(await fleet.tryResume(async () => { checked++; return true; }), true);
  assert.equal(fleet.snapshot().state, 'open');
  assert.equal(checked, 2);
});
