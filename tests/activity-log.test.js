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
