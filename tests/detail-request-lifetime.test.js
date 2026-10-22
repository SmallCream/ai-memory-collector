import test from 'node:test';
import assert from 'node:assert/strict';
import { DetailRequestTimeoutError, waitForDetailRequest } from '../extension/lib/detail-request-lifetime.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function clock() {
  let now = 0, nextId = 0;
  const jobs = new Map(), callbacks = [], cleared = [];
  function schedule(callback, delay, interval = 0) {
    const id = ++nextId;
    jobs.set(id, { callback, due: now + delay, interval }); callbacks.push(callback); return id;
  }
  const timers = {
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearTimeout: id => { cleared.push(['timeout', id]); jobs.delete(id); },
    clearInterval: id => { cleared.push(['interval', id]); jobs.delete(id); },
  };
  function advance(milliseconds) {
    const until = now + milliseconds;
    while (true) {
      const next = [...jobs].filter(([, job]) => job.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, job] = next;
      now = job.due;
      if (job.interval) job.due += job.interval;
      else jobs.delete(id);
      job.callback();
    }
    now = until;
  }
  return { timers, advance, jobs, callbacks, cleared };
}

test('a nine-minute detail stays pending beyond five minutes and releases its scoped lifetime on success', async () => {
  const c = clock(), source = deferred();
  let pings = 0, finished = false;
  const runtime = { getPlatformInfo() {
    assert.equal(this, runtime, 'the native API needs its correct receiver'); pings++;
    return Promise.resolve({ os: 'discarded platform data' });
  } };
  const waiting = waitForDetailRequest(() => source.promise, { runtime, timers: c.timers });
  waiting.then(() => { finished = true; });
  await flush(); c.advance(9 * 60_000); await flush();
  assert.equal(finished, false);
  assert.equal(pings, 27);
  source.resolve({ ok: true, payload: 'result' });
  assert.deepEqual(await waiting, { ok: true, payload: 'result' });
  assert.equal(c.jobs.size, 0);
  assert.equal(c.cleared.length, 2);
  c.advance(60_000);
  for (const callback of c.callbacks) callback(); // Already queued native timer callbacks are harmless.
  await flush();
  assert.equal(pings, 27);
});

test('the eleven-minute outer watchdog rejects a lost reply and stops every heartbeat', async () => {
  const c = clock(), source = deferred();
  let pings = 0;
  const waiting = waitForDetailRequest(() => source.promise, {
    runtime: { getPlatformInfo: () => { pings++; } }, timers: c.timers,
  });
  const rejected = assert.rejects(waiting, error => {
    assert.ok(error instanceof DetailRequestTimeoutError);
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.message, '详情读取等待超时，已保留进度，请稍后重试。');
    return true;
  });
  await flush(); c.advance(660_000); await rejected;
  assert.equal(c.jobs.size, 0);
  assert.equal(c.cleared.length, 2);
  assert.equal(pings, 32, 'the watchdog also blocks an interval callback queued at its deadline');
  c.advance(10 * 60_000);
  assert.equal(pings, 32);
});

test('synchronous throws and rejected operations retain their original error and always clear timers', async () => {
  for (const asyncFailure of [false, true]) {
    const c = clock(), original = new Error('operation failed');
    const operation = () => {
      if (asyncFailure) return Promise.reject(original);
      throw original;
    };
    await assert.rejects(waitForDetailRequest(operation, {
      runtime: { getPlatformInfo: () => {} }, timers: c.timers,
    }), error => error === original);
    assert.equal(c.jobs.size, 0);
    assert.equal(c.cleared.length, 2);
  }
});

test('late operation success or failure cannot change a timed-out result or restart its lifetime', async () => {
  for (const lateFailure of [false, true]) {
    const c = clock(), source = deferred();
    let pings = 0, successes = 0;
    const waiting = waitForDetailRequest(() => source.promise, {
      runtime: { getPlatformInfo: () => { pings++; } }, timers: c.timers,
    });
    waiting.then(() => { successes++; }, () => {});
    const rejected = assert.rejects(waiting, DetailRequestTimeoutError);
    await flush(); c.advance(660_000); await rejected;
    if (lateFailure) source.reject(new Error('private late error'));
    else source.resolve('private late result');
    await flush();
    for (const callback of c.callbacks) callback();
    await flush();
    assert.equal(successes, 0);
    assert.equal(c.jobs.size, 0);
    assert.equal(pings, 32);
  }
});

test('heartbeat API errors neither fail the detail nor expose platform data or error text', async () => {
  for (const asyncFailure of [false, true]) {
    const c = clock(), source = deferred();
    let pings = 0;
    const runtime = { getPlatformInfo() {
      pings++;
      if (asyncFailure) return Promise.reject(new Error('private platform failure'));
      throw new Error('private platform failure');
    } };
    const waiting = waitForDetailRequest(() => source.promise, { runtime, timers: c.timers });
    await flush(); c.advance(40_000); await flush();
    assert.equal(pings, 2);
    source.resolve('detail');
    assert.equal(await waiting, 'detail');
    assert.equal(c.jobs.size, 0);
  }
});

test('without a runtime API there is no heartbeat and the outer bound still applies', async () => {
  for (const runtime of [undefined, {}, { getPlatformInfo: null }]) {
    const c = clock(), source = deferred();
    const waiting = waitForDetailRequest(() => source.promise, { runtime, timers: c.timers });
    const rejected = assert.rejects(waiting, DetailRequestTimeoutError);
    await flush();
    assert.equal(c.jobs.size, 1);
    c.advance(660_000); await rejected;
    assert.equal(c.jobs.size, 0);
    assert.equal(c.cleared.length, 1);
    assert.equal(c.cleared[0][0], 'timeout');
  }
});
