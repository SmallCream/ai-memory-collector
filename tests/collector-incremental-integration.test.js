import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorEngine } from '../extension/lib/collector-engine.js';
import { createArchiveStore, readAccountManifest, hasConversationFiles } from '../extension/lib/archive-store.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const account = { platform: 'chatgpt', accountKey: 'acct-0123456789abcdef01234567',
  alias: 'demo', storageKey: 'demo-01234567', enabled: true, initialized: false };
const identity = { platform: 'chatgpt', accountKey: account.accountKey, displayName: 'Demo' };
const sourceTime = 1792569600;
function detail(id) {
  return { identity, completeness: 'complete', capturedAt: '2026-10-21T08:00:00Z', payload: {
    conversation_id: id, title: `Title ${id}`, create_time: 1792483200, update_time: sourceTime,
    current_node: 'reply', mapping: {
      root: { parent: null, message: null },
      question: { parent: 'root', message: { id: 'q', author: { role: 'user' },
        content: { content_type: 'text', parts: ['Question'] }, status: 'finished_successfully' } },
      reply: { parent: 'question', message: { id: 'r', author: { role: 'assistant' },
        content: { content_type: 'text', parts: [`Answer for ${id}`] }, status: 'finished_successfully' } },
    },
  } };
}
function setup() {
  const fs = memoryBinaryFs(), requests = [], checks = [];
  const archive = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
  const dependencies = { getSetting: fs.getSetting, setSetting: fs.setSetting,
    getDirectory: async () => fs.directory, readAccountManifest,
    hasConversationFiles: async (...args) => { checks.push(args[2].conversationId); return hasConversationFiles(...args); },
    saveConversation: input => archive.saveConversation(input),
    adapter: {
      identify: async () => identity,
      list: async () => ({ items: ['a', 'b'].map(id => ({ id, title: `Title ${id}`, updateTime: sourceTime })),
        nextOffset: null, total: 2 }),
      detail: async (tabId, { conversationId }) => { requests.push(conversationId); return detail(conversationId); },
    },
    now: () => Date.parse('2026-10-21T08:00:00Z'),
  };
  return { fs, requests, checks, dependencies, engine: createCollectorEngine(dependencies) };
}
async function run(engine, target = account) {
  await engine.start({ account: target, tabId: 1, mode: 'incremental' });
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = await engine.tick({ account: target, tabId: 1 });
    if (state.status !== 'running' || state.nextRetryAt) return state;
  }
  throw new Error('Collection did not finish');
}

test('real archive entries without a browser index pass presence validation and skip unchanged details', async () => {
  const f = setup();
  assert.equal((await run(f.engine)).status, 'completed');
  const manifest = await readAccountManifest(f.fs.directory, account);
  assert.equal(manifest.conversations.a.sourceCompleteness, 'complete');
  assert.equal(manifest.conversations.a.sourceUpdatedAt, new Date(sourceTime * 1000).toISOString());
  const writes = f.fs.writes.length;
  f.fs.settings.delete(`collectorIndex:${account.accountKey}`);
  f.fs.settings.delete(`collectorJob:${account.accountKey}`);
  f.requests.length = 0;
  const state = await run(createCollectorEngine(f.dependencies));
  assert.equal(state.status, 'completed');
  assert.equal(state.diagnostics.skipped, 2);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.checks, ['a', 'b']);
  assert.equal(f.fs.writes.length, writes, 'skipping must not rewrite JSON or Markdown');
});

test('real missing JSON or Markdown files are repaired without fetching unchanged intact conversations', async t => {
  for (const field of ['jsonPath', 'markdownPath']) await t.test(field, async () => {
    const f = setup();
    assert.equal((await run(f.engine)).status, 'completed');
    const manifest = await readAccountManifest(f.fs.directory, account);
    const path = manifest.conversations.a[field], original = f.fs.text(path);
    await f.engine.acknowledgeOutbox(account.accountKey, (await f.engine.getOutbox(account.accountKey)).map(item => item.id));
    f.fs.files.delete(path); f.requests.length = 0;
    const state = await run(f.engine, { ...account, initialized: true });
    assert.equal(state.status, 'completed');
    assert.equal(state.diagnostics.skipped, 1);
    assert.deepEqual(f.requests, ['a']);
    assert.equal(f.fs.text(path), original);
    assert.equal(await hasConversationFiles(f.fs.directory, account, (await readAccountManifest(f.fs.directory, account)).conversations.a), true);
    assert.deepEqual((await f.engine.getOutbox(account.accountKey)).map(item => item.conversationId), ['a']);
  });
});
