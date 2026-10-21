import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorEngine } from '../extension/lib/collector-engine.js';

const account = { platform: 'chatgpt', accountKey: 'acct-demo', storageKey: 'demo-acct', alias: 'Demo', enabled: true, initialized: false };
const key = name => `collector${name}:${account.accountKey}`;
const issue = code => Object.assign(new Error('Untrusted error containing secrets must not appear in state'), { code });
const source = (id, updateTime = 1000) => ({ id, title: `Title ${id}`, updateTime });

function setup(options = {}) {
  const store = options.store || new Map();
  let clock = 2_000_000_000_000, sequence = 0, identity = account.accountKey, permission = 'granted';
  const calls = { identify: 0, pages: [], details: [], saves: [] };
  const local = options.local || new Map();
  let list = options.list || (async () => ({ items: [source('a'), source('b')], nextOffset: null, total: 2 }));
  let detailError = options.detailError;
  const directory = { kind: 'directory', queryPermission: async () => permission };
  const dependencies = {
    getSetting: async name => structuredClone(store.get(name)),
    setSetting: async (name, value) => {
      if (options.rejectStore?.(name, value)) throw new Error('No space');
      store.set(name, structuredClone(value));
    },
    getDirectory: async () => directory,
    readAccountManifest: async () => ({ conversations: Object.fromEntries([...local].map(([id, value]) => [id, value.entry])) }),
    adapter: {
      identify: async () => { calls.identify++; return { accountKey: identity, platform: 'chatgpt' }; },
      list: async (tabId, { offset }) => { calls.pages.push(offset); return list(offset); },
      detail: async (tabId, { conversationId }) => {
        calls.details.push(conversationId);
        const error = typeof detailError === 'function' ? detailError(conversationId, calls.details.length) : detailError;
        if (error) throw issue(error);
        if (options.afterDetail) options.afterDetail({ setIdentity: value => identity = value });
        return { identity: { accountKey: account.accountKey, platform: 'chatgpt' }, payload: { conversation_id: conversationId, messages: [], update_time: 1000 }, capturedAt: '2033-05-18T03:33:20Z', completeness: 'complete' };
      },
    },
    saveConversation: async ({ detail }) => {
      const id = detail.payload.conversation_id;
      calls.saves.push(id);
      if (options.saveError) throw issue(options.saveError);
      const status = local.has(id) ? 'unchanged' : 'added';
      const entry = { conversationId: id, contentHash: `hash-${id}` };
      local.set(id, { entry });
      const prefix = `data/web/chatgpt/${account.storageKey}`;
      const manifest = { accountKey: account.accountKey, conversations: Object.fromEntries([...local].map(([key, value]) => [key, value.entry])) };
      return { entry, manifest, status, files: [
        { path: `${prefix}/conversations/${id}.json`, content: JSON.stringify(detail.payload) },
        { path: `${prefix}/conversations/${id}.md`, content: `# ${id}\n` },
        { path: `${prefix}/archive/manifest.json`, content: JSON.stringify(manifest) },
        { path: `${prefix}/account.json`, content: JSON.stringify({ accountKey: account.accountKey }) },
      ] };
    },
    now: () => clock,
    makeId: () => `run-${++sequence}-${clock}`,
  };
  return {
    dependencies, engine: createCollectorEngine(dependencies), store, local, calls,
    advance: milliseconds => clock += milliseconds,
    setIdentity: value => identity = value,
    setPermission: value => permission = value,
    setList: value => list = value,
    setDetailError: value => detailError = value,
  };
}

async function complete(engine, target = account) {
  for (let count = 0; count < 30; count++) {
    const state = await engine.tick({ account: target, tabId: 1 });
    if (state.status !== 'running' || state.nextRetryAt) return state;
  }
  throw new Error('Task did not finish');
}

test('initialization walks all pages, persists every conversation and completes only afterwards', async () => {
  const f = setup({ list: async offset => offset === 0 ? { items: [source('a')], nextOffset: 1, total: 2 } : { items: [source('b')], nextOffset: null, total: 2 } });
  const start = await f.engine.start({ account, tabId: 1, mode: 'incremental' });
  assert.equal(start.mode, 'initial');
  assert.equal(start.initializedComplete, false);
  const result = await complete(f.engine);
  assert.equal(result.status, 'completed');
  assert.equal(result.initializedComplete, true);
  assert.deepEqual(f.calls.pages, [0, 1]);
  assert.deepEqual(f.calls.details, ['a', 'b']);
  assert.equal(result.added, 2);
  assert.equal(result.processed, 2);
  assert.ok(result.completedAt);
  assert.equal((await f.engine.getOutbox(account.accountKey)).length, 2);
  const stored = f.store.get(key('Outbox'));
  assert.equal(stored.sharedFiles.length, 2);
  assert.ok(stored.bundles.every(bundle => bundle.files.length === 2));
  const rebuilt = await f.engine.getOutbox(account.accountKey);
  assert.ok(rebuilt.every(bundle => bundle.files.length === 4));
  assert.deepEqual(Object.keys(JSON.parse(rebuilt[0].files.find(file => file.path.endsWith('manifest.json')).content).conversations), ['a']);
  assert.deepEqual(Object.keys(JSON.parse(rebuilt[1].files.find(file => file.path.endsWith('manifest.json')).content).conversations), ['b']);
});

test('restart resumes persisted page and detail checkpoints without duplicating successful writes', async () => {
  const f = setup({ list: async offset => offset === 0 ? { items: [source('a')], nextOffset: 1, total: 2 } : { items: [source('b')], nextOffset: null, total: 2 } });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await f.engine.tick({ account, tabId: 1 });
  let restarted = createCollectorEngine(f.dependencies);
  await restarted.tick({ account, tabId: 1 });
  await restarted.tick({ account, tabId: 1 });
  restarted = createCollectorEngine(f.dependencies);
  await complete(restarted);
  assert.deepEqual(f.calls.pages, [0, 1]);
  assert.deepEqual(f.calls.saves, ['a', 'b']);
});

test('duplicate starts serialize and do not reset a live task; manual pause survives scheduled start', async () => {
  const f = setup();
  const starts = await Promise.all(Array.from({ length: 4 }, () => f.engine.start({ account, tabId: 1, mode: 'initial' })));
  assert.equal(new Set(starts.map(state => state.id)).size, 1);
  await f.engine.pause(account.accountKey);
  assert.equal((await f.engine.start({ account, tabId: 1, mode: 'incremental' })).status, 'paused');
  assert.equal((await f.engine.tick({ account, tabId: 1 })).status, 'paused');
  assert.equal(f.calls.pages.length, 0);
  await assert.rejects(f.engine.start({ account, tabId: 1, mode: 'full' }), error => error.code === 'BUSY');
});

test('incremental skips archived unchanged older conversations, full backfill rereads every detail', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await complete(f.engine);
  const initialized = { ...account, initialized: true };
  f.calls.details.length = 0;
  await f.engine.start({ account: initialized, tabId: 1, mode: 'incremental' });
  const incremental = await complete(f.engine, initialized);
  assert.deepEqual(f.calls.details, []);
  assert.equal(incremental.unchanged, 2);
  assert.equal(incremental.processed, 2);
  await f.engine.start({ account: initialized, tabId: 1, mode: 'full' });
  const full = await complete(f.engine, initialized);
  assert.deepEqual(f.calls.details, ['a', 'b']);
  assert.equal(full.status, 'completed');
});

test('unknown and changed timestamps remain eligible for incremental detail collection', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  const initialized = { ...account, initialized: true };
  f.setList(async () => ({ items: [source('a', 1001), source('b', null), source('c')], nextOffset: null, total: 3 }));
  f.calls.details.length = 0;
  await f.engine.start({ account: initialized, tabId: 1, mode: 'incremental' });
  await complete(f.engine, initialized);
  assert.deepEqual(f.calls.details, ['a', 'b', 'c']);
});

test('transient failures retain retry item while unrelated details finish; retry does not advance index', async () => {
  let rejectA = true;
  const f = setup({ detailError: id => id === 'a' && rejectA ? 'HTTP_429' : null });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await f.engine.tick({ account, tabId: 1 });
  await f.engine.tick({ account, tabId: 1 });
  const retry = await f.engine.tick({ account, tabId: 1 });
  assert.equal(retry.processed, 1);
  assert.equal(retry.failed, 1);
  assert.equal(f.store.get(key('Index')).items.a, undefined);
  const before = f.calls.identify;
  await f.engine.tick({ account, tabId: 1 });
  assert.equal(f.calls.identify, before, 'waiting for retry should not poll identity');
  rejectA = false; f.advance(61_000);
  const result = await complete(f.engine);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.calls.saves, ['b', 'a']);
});

test('permanent individual failure cannot mark initialization completed, resume retries only failed item', async () => {
  const f = setup({ detailError: id => id === 'a' ? 'HTTP_404' : null });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  const partial = await complete(f.engine);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.failed, 1);
  assert.equal(partial.initializedComplete, false);
  assert.equal(partial.error.code, 'HTTP_404');
  assert.ok(!JSON.stringify(partial).includes('secrets'));
  f.setDetailError(null);
  await f.engine.resume({ account, tabId: 1 });
  const resumed = await complete(f.engine);
  assert.equal(resumed.initializedComplete, true);
  assert.deepEqual(f.calls.saves, ['b', 'a']);
  assert.deepEqual(f.calls.pages, [0]);
});

test('switching identity before a page or after a detail pauses the original task without writing', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  f.setIdentity('acct-other');
  const blocked = await f.engine.tick({ account, tabId: 1 });
  assert.equal(blocked.status, 'paused');
  assert.equal(blocked.error.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(f.calls.pages, []);
  const g = setup({ afterDetail: ({ setIdentity }) => setIdentity('acct-other') });
  await g.engine.start({ account, tabId: 1, mode: 'initial' });
  await g.engine.tick({ account, tabId: 1 });
  const switched = await g.engine.tick({ account, tabId: 1 });
  assert.equal(switched.status, 'paused');
  assert.equal(switched.processed, 0);
  assert.deepEqual(g.calls.saves, []);
});

test('permission loss blocks before network and local failures keep account stopped for journal recovery', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  const previousIdentityCalls = f.calls.identify;
  f.setPermission('prompt');
  const result = await f.engine.tick({ account, tabId: 1 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'DIRECTORY_PERMISSION');
  assert.equal(f.calls.identify, previousIdentityCalls);
  const g = setup({ saveError: 'LOCAL_WRITE' });
  await g.engine.start({ account, tabId: 1, mode: 'initial' });
  const blocked = await complete(g.engine);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(g.calls.saves, ['a']);
});

test('stalled pagination and a premature end never claim full coverage', async () => {
  for (const page of [
    { items: [source('a')], nextOffset: 0, total: 2 },
    { items: [source('a')], nextOffset: null, total: 2 },
    { items: [], nextOffset: 1, total: 2 },
  ]) {
    const f = setup({ list: async () => page });
    await f.engine.start({ account, tabId: 1, mode: 'initial' });
    const state = await complete(f.engine);
    assert.equal(state.status, 'partial');
    assert.equal(state.initializedComplete, false);
    assert.deepEqual(f.calls.details, []);
  }
});

test('outbox failure after local save leaves detail retryable and cannot mark it completed', async () => {
  let reject = true;
  const f = setup({ rejectStore: name => name === key('Outbox') && reject });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await f.engine.tick({ account, tabId: 1 });
  const retry = await f.engine.tick({ account, tabId: 1 });
  assert.equal(retry.processed, 0);
  assert.equal(retry.failed, 1);
  assert.ok(f.local.has('a'));
  assert.equal(f.store.get(key('Index')), undefined);
  reject = false; f.advance(61_000);
  const completed = await complete(f.engine);
  assert.equal(completed.status, 'completed');
  assert.equal((await f.engine.getOutbox(account.accountKey)).length, 2);
});

test('acknowledging an older upload cannot remove a newer queued version', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  const old = await f.engine.getOutbox(account.accountKey);
  await f.engine.start({ account: { ...account, initialized: true }, tabId: 1, mode: 'full' });
  await complete(f.engine, { ...account, initialized: true });
  await f.engine.acknowledgeOutbox(account.accountKey, old.map(bundle => bundle.id));
  const current = await f.engine.getOutbox(account.accountKey);
  assert.equal(current.length, 2);
  assert.ok(current.every(bundle => !old.some(previous => previous.id === bundle.id)));
  await f.engine.acknowledgeOutbox(account.accountKey, current.map(bundle => bundle.id));
  assert.deepEqual(await f.engine.getOutbox(account.accountKey), []);
});

test('reset clears task and incremental index but preserves unsent archives', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  await f.engine.reset(account.accountKey);
  assert.equal(await f.engine.getState(account.accountKey), null);
  assert.equal(f.store.get(key('Index')), null);
  assert.equal((await f.engine.getOutbox(account.accountKey)).length, 2);
});

test('unbound accounts cannot start and an existing job cannot be reassigned to another directory key', async () => {
  const f = setup();
  assert.throws(() => f.engine.start({ account: { ...account, enabled: false }, tabId: 1 }), error => error.code === 'ACCOUNT_NOT_ENABLED');
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await assert.rejects(f.engine.tick({ account: { ...account, storageKey: 'another-path' }, tabId: 1 }), error => error.code === 'ACCOUNT_CHANGED');
});

test('a new scan after partial completion discovers newer conversations instead of starving on the old failed queue', async () => {
  const f = setup({ detailError: id => id === 'a' ? 'HTTP_404' : null });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  const previous = await complete(f.engine);
  assert.equal(previous.status, 'partial');
  f.setList(async () => ({ items: [source('a'), source('b'), source('mobile-new')], nextOffset: null, total: 3 }));
  const fresh = await f.engine.start({ account, tabId: 1, mode: 'initial' });
  assert.notEqual(fresh.id, previous.id);
  const next = await complete(f.engine);
  assert.equal(next.status, 'partial');
  assert.ok(f.calls.details.includes('mobile-new'));
  assert.deepEqual(f.calls.pages, [0, 0]);
});

test('pending bundle keeps its own manifest hash after another local capture advances the shared manifest', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  const pending = await f.engine.getOutbox(account.accountKey);
  const archivedB = pending.find(bundle => bundle.conversationId === 'b');
  const newerA = structuredClone(pending.find(bundle => bundle.conversationId === 'a'));
  const manifestFile = newerA.files.find(file => file.path.endsWith('/manifest.json'));
  const manifest = JSON.parse(manifestFile.content);
  manifest.conversations.b = { conversationId: 'b', contentHash: 'remote-new-hash' };
  manifestFile.content = JSON.stringify(manifest);
  await f.engine.enqueueArchive({ account, archive: { entry: manifest.conversations.a, files: newerA.files } });
  const after = (await f.engine.getOutbox(account.accountKey)).find(bundle => bundle.conversationId === 'b');
  assert.equal(after.id, archivedB.id);
  const bManifest = JSON.parse(after.files.find(file => file.path.endsWith('/manifest.json')).content);
  assert.equal(bManifest.conversations.b.contentHash, 'hash-b');
  assert.deepEqual(Object.keys(bManifest.conversations), ['b']);
});

test('delayed recovery delivery cannot replace a newer queued conversation or image derivative', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  const before = (await f.engine.getOutbox(account.accountKey)).find(bundle => bundle.conversationId === 'a');
  f.local.get('a').entry.markdownHash = 'new-images';
  await f.engine.enqueueArchive({ account, archive: {
    entry: { conversationId: 'a', contentHash: 'old-native', markdownHash: 'old-images' }, files: before.files,
  } });
  await f.engine.enqueueArchive({ account, archive: {
    entry: { conversationId: 'a', contentHash: 'hash-a', markdownHash: 'old-images' }, files: before.files,
  } });
  const after = (await f.engine.getOutbox(account.accountKey)).find(bundle => bundle.conversationId === 'a');
  assert.equal(after.id, before.id);
});
