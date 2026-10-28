import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLog } from '../extension/lib/activity-log.js';
function setup(workerId = 'first') {
  const store = new Map(); let clock = 100;
  const dependencies = { getSetting: async key => structuredClone(store.get(key)),
    setSetting: async (key, value) => store.set(key, structuredClone(value)), now: () => clock, workerId };
  return { store, dependencies, log: createActivityLog(dependencies), advance: n => { clock += n; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
test('real pending operations are readable without waiting and polling does not advance activity timestamps', async () => {
  const env = setup(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = env.log.run('account-one', 'download', { stage: 'download', fileName: 'image.png' }, () => gate);
  await turn(); const before = await env.log.read('account-one', 'download');
  assert.equal(before.current.status, 'running'); assert.equal(before.current.startedAt, 100);
  env.advance(120000); assert.deepEqual(await env.log.read('account-one', 'download'), before);
  release('bytes'); assert.equal(await running, 'bytes');
  const after = await env.log.read('account-one', 'download');
  assert.equal(after.current.status, 'success'); assert.equal(after.current.finishedAt, 120100);
  assert.equal(after.recent.length, 1);
});
test('worker restarts report interrupted last operations without inventing progress or changing storage', async () => {
  const env = setup(); let release;
  const running = env.log.run('one', 'upload', { stage: 'upload-image' }, () => new Promise(resolve => { release = resolve; }));
  await turn(); const snapshot = structuredClone([...env.store]);
  const restored = createActivityLog({ ...env.dependencies, workerId: 'second' });
  assert.equal((await restored.read('one', 'upload')).current.status, 'interrupted');
  assert.deepEqual([...env.store], snapshot); release(); await running;
});
test('activity persistence failures never alter the operation result or original error', async () => {
  const original = Object.assign(new Error('sensitive details'), { code: 'HTTP_403' });
  const log = createActivityLog({ getSetting: async () => { throw new Error('storage'); }, setSetting: async () => {}, now: () => 1 });
  assert.equal(await log.run('one', 'upload', {}, async () => 17), 17);
  await assert.rejects(log.run('one', 'upload', {}, async () => { throw original; }), error => error === original);
  let caught = false;
  try { await log.run('one', 'upload', {}, async () => { throw null; }); } catch (error) { caught = true; assert.equal(error, null); }
  assert.equal(caught, true);
});
test('logs are bounded, account isolated, metadata only and sanitized again on read', async () => {
  const env = setup();
  for (let n = 0; n < 25; n++) await env.log.run('one', 'collection', {
    title: 'unsafe https://example.test/private?sig=secret github_pat_hiddenvalue Bearer token', stage: 'detail',
    payload: { conversation: 'private' }, token: 'secret', total: 25, completed: n,
  }, async () => {});
  const state = await env.log.read('one', 'collection');
  assert.equal(state.recent.length, 20); assert.equal(state.current.completed, 24);
  assert.doesNotMatch(JSON.stringify(state), /sig=|github_pat_|Bearer|private|payload|token/);
  assert.deepEqual((await env.log.read('two', 'collection')).recent, []);
  env.store.set('activity:v1:one:collection', { current: { status: 'success', title: 'https://example.test/?secret', token: 'private' },
    recent: [{ status: 'failed', code: 'https://bad.test/', response: 'private' }] });
  assert.doesNotMatch(JSON.stringify(await env.log.read('one', 'collection')), /https:|private/);
});

test('persistent history groups repeated failures and marks only the same object and step recovered', async () => {
  const env = setup(), info = { stage: 'download', conversationId: 'chat', assetId: 'asset-a', fileName: 'same.png' };
  const failure = () => { throw Object.assign(new Error('private response'), { code: 'HTTP_403' }); };
  for (let i = 0; i < 3; i++) { await assert.rejects(env.log.run('one', 'download', info, failure)); env.advance(1); }
  let history = (await env.log.read('one', 'download', { history: true })).history;
  assert.equal(history.length, 1); assert.equal(history[0].occurrences, 3); assert.equal(history[0].firstFailedAt, 100);
  await env.log.run('one', 'download', { ...info, assetId: 'asset-b' }, async () => {});
  assert.equal((await env.log.read('one', 'download', { history: true })).history.find(row => row.code).recoveredAt, undefined);
  await env.log.run('one', 'download', info, async () => {});
  history = (await createActivityLog({ ...env.dependencies, workerId: 'new' }).read('one', 'download', { history: true })).history;
  assert.equal(history.find(row => row.code).recoveredAt, 103);
});

test('history is bounded and expires, while clearing preserves a running operation and unrelated work', async () => {
  const env = setup(); env.store.set('collectorJob:one', { status: 'paused' });
  for (let i = 0; i < 210; i++) await env.log.run('one', 'collection', { stage: 'detail', conversationId: String(i) }, async () => {});
  assert.equal((await env.log.read('one', 'collection', { history: true })).history.length, 200);
  env.advance(8 * 86400000);
  assert.equal((await env.log.read('one', 'collection', { history: true })).history.length, 0);
  let release; const pending = env.log.run('one', 'collection', { stage: 'detail' }, () => new Promise(resolve => { release = resolve; }));
  await turn(); await env.log.clear('one', 'collection');
  const cleared = await env.log.read('one', 'collection', { history: true });
  assert.equal(cleared.current.status, 'running'); assert.equal(cleared.history.length, 0);
  assert.deepEqual(env.store.get('collectorJob:one'), { status: 'paused' }); release(); await pending;
  assert.equal((await env.log.read('one', 'collection', { history: true })).history.length, 1);
});

test('starting a new step preserves a previous worker interruption in history', async () => {
  const env = setup();
  env.store.set('activity:v1:one:collection', { workerId: 'old', current: { status: 'running', stage: 'detail', operationId: 'old-op', startedAt: 90, updatedAt: 90 }, recent: [] });
  await env.log.run('one', 'collection', { stage: 'identify' }, async () => {});
  const log = await env.log.read('one', 'collection', { history: true });
  assert.equal(log.history.find(row => row.operationId === 'old-op').status, 'interrupted');
});

test('diagnostic read and clear expose storage failures instead of claiming empty logs or success', async () => {
  const log = createActivityLog({ getSetting: async () => { throw new Error('storage'); }, setSetting: async () => {} });
  assert.equal((await log.read('one', 'collection', { history: true })).unavailable, true);
  await assert.rejects(log.clear('one', 'collection'), { code: 'DIAGNOSTICS_STORAGE' });
});

test('routine successes do not crowd out unresolved failures and list recovery matches the same task page', async () => {
  const env = setup(), info = { stage: 'list', taskId: 'run-a', completed: 1 };
  await assert.rejects(env.log.run('one', 'collection', info, () => { throw Object.assign(new Error('retry'), { code: 'HTTP_503' }); }));
  for (let n = 0; n < 210; n++) await env.log.run('one', 'collection', { stage: 'identify' }, async () => {});
  let history = (await env.log.read('one', 'collection', { history: true })).history;
  assert.equal(history.length, 200); assert.ok(history.some(item => item.code === 'HTTP_503'));
  await env.log.run('one', 'collection', { ...info, completed: 2 }, async () => {});
  assert.equal((await env.log.read('one', 'collection', { history: true })).history.find(item => item.code).recoveredAt, undefined);
  await env.log.run('one', 'collection', info, async () => {});
  // Keep the recovery evidence near the new success, even after a busy run.
  history = (await env.log.read('one', 'collection', { history: true })).history;
  assert.equal(history.find(item => item.code === 'HTTP_503').recoveredAt, 100);
});
