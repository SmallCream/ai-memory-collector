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

test('Doubao incremental scans reuse real archives while changed, missing and legacy entries still refresh', async t => {
  for (const scenario of ['unchanged', 'renamed', 'updated', 'missing-markdown', 'legacy-renderer', 'missing-renderer', 'full']) {
    await t.test(scenario, async () => {
      const f = setup();
      const target = { ...account, platform: 'doubao', initialized: true };
      const owner = { ...identity, platform: 'doubao' };
      const items = ['11', '12'].map(id => ({ id, title: `Title ${id}`, updateTime: sourceTime }));
      f.dependencies.adapter = {
        identify: async () => owner,
        list: async () => ({ items, nextOffset: null, total: 2 }),
        detail: async (tabId, { conversationId }) => {
          f.requests.push(conversationId);
          const item = items.find(value => value.id === conversationId);
          return { identity: owner, completeness: 'complete', capturedAt: '2026-10-21T08:00:00Z', payload: {
            platform: 'doubao', sourceFormat: 'doubao-web-chain', conversation_id: conversationId,
            title: item.title, create_time: sourceTime - 100, update_time: item.updateTime,
            conversation: { conversation_id: conversationId, creator_id: '10001', conversation_type: 3,
              name: item.title, create_time: String(sourceTime - 100), update_time: String(item.updateTime) },
            messages: [1, 2].map(index => ({ conversation_id: conversationId,
              message_id: `${conversationId}${index}`, index_in_conv: String(index), user_type: index,
              status: 0, content_status: 0, ext: { is_finish: '1' }, content: '',
              content_block: [{ block_type: 10000, is_finish: true, content: { text_block: { text: `Message ${index}` } } }] })),
            regen_messages: {}, has_more: false,
          } };
        },
      };
      assert.equal((await run(createCollectorEngine(f.dependencies), target)).status, 'completed');
      const manifest = await readAccountManifest(f.fs.directory, target);
      assert.equal(manifest.conversations['11'].rendererVersion, 'doubao-1');
      if (scenario === 'renamed') items[0].title = 'Renamed';
      if (scenario === 'updated') items[0].updateTime++;
      if (scenario === 'missing-markdown') f.fs.files.delete(manifest.conversations['11'].markdownPath);
      if (scenario === 'legacy-renderer' || scenario === 'missing-renderer') {
        if (scenario === 'legacy-renderer') manifest.conversations['11'].rendererVersion = 'rich-3';
        else delete manifest.conversations['11'].rendererVersion;
        const path = [...f.fs.files.keys()].find(value => value.endsWith('/archive/manifest.json'));
        f.fs.put(path, JSON.stringify(manifest));
      }
      const writes = f.fs.writes.length;
      f.requests.length = 0; f.checks.length = 0;
      // Losing the browser index must not lose the on-disk renderer receipt.
      f.fs.settings.delete(`collectorIndex:${target.accountKey}`);
      const restarted = createCollectorEngine(f.dependencies);
      if (scenario === 'full') await restarted.start({ account: target, tabId: 1, mode: 'full' });
      const state = await run(restarted, target);
      assert.equal(state.status, 'completed');
      assert.deepEqual(f.requests, scenario === 'unchanged' ? [] : scenario === 'full' ? ['11', '12'] : ['11']);
      assert.equal(state.diagnostics.skipped, scenario === 'unchanged' ? 2 : scenario === 'full' ? 0 : 1);
      if (scenario === 'unchanged') {
        assert.deepEqual(f.checks, ['11', '12']);
        assert.equal(f.fs.writes.length, writes, 'unchanged Doubao archives must not be rewritten');
      }
    });
  }
});
