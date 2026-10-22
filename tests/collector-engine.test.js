import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorEngine } from '../extension/lib/collector-engine.js';
import { createActivityLog } from '../extension/lib/activity-log.js';

const account = { platform: 'chatgpt', accountKey: 'acct-demo', storageKey: 'demo-acct', alias: 'Demo', enabled: true, initialized: false };
const key = name => `collector${name}:${account.accountKey}`;
const issue = code => Object.assign(new Error('Untrusted error containing secrets must not appear in state'), { code });
const source = (id, updateTime = 1000) => ({ id, title: `Title ${id}`, updateTime });
const isoTime = value => value == null ? null : new Date(typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value)
  ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value)).toISOString();

function setup(options = {}) {
  const store = options.store || new Map();
  let clock = 2_000_000_000_000, sequence = 0, identity = account.accountKey, permission = 'granted';
  const calls = { identify: 0, pages: [], details: [], saves: [] };
  const local = options.local || new Map();
  const latestSources = new Map();
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
    hasConversationFiles: async (directory, target, entry) => options.filesPresent?.(entry.conversationId) ?? true,
    adapter: {
      identify: async () => { calls.identify++; return { accountKey: identity, platform: 'chatgpt' }; },
      list: async (tabId, { offset }) => {
        calls.pages.push(offset);
        const page = await list(offset);
        for (const item of page.items || []) latestSources.set(item.id, item);
        return page;
      },
      detail: async (tabId, { conversationId }) => {
        calls.details.push(conversationId);
        const error = typeof detailError === 'function' ? detailError(conversationId, calls.details.length) : detailError;
        if (error) throw issue(error);
        if (options.afterDetail) options.afterDetail({ setIdentity: value => identity = value });
        return { identity: { accountKey: account.accountKey, platform: 'chatgpt' }, payload: {
          conversation_id: conversationId, title: options.detailTitle?.(conversationId) ?? latestSources.get(conversationId)?.title ?? `Title ${conversationId}`,
          messages: [], update_time: options.detailTime ? options.detailTime(conversationId) : latestSources.get(conversationId)?.updateTime ?? 1000,
        }, capturedAt: '2033-05-18T03:33:20Z', completeness: 'complete' };
      },
    },
    saveConversation: async ({ detail }) => {
      const id = detail.payload.conversation_id;
      calls.saves.push(id);
      if (options.saveError) throw issue(options.saveError);
      const status = local.has(id) ? 'unchanged' : 'added';
      const entry = { conversationId: id, contentHash: `hash-${id}`, title: detail.payload.title,
        sourceCompleteness: detail.completeness, sourceUpdatedAt: isoTime(detail.payload.update_time) };
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
  for (let count = 0; count < 300; count++) {
    const state = await engine.tick({ account: target, tabId: 1 });
    if (state.status !== 'running' || state.nextRetryAt) return state;
  }
  throw new Error('Task did not finish');
}

test('detail reason survives a retry checkpoint and restart without saving an incomplete archive', async () => {
  const f = setup();
  f.dependencies.adapter.detail = async () => {
    throw Object.assign(new Error('private response and bearer secret'), {
      code: 'INCOMPLETE_DETAIL', reason: 'TREE_MISSING_CHILD', payload: 'private-body', nodeId: 'private-id',
    });
  };
  await f.engine.start({ account, tabId: 1 });
  await f.engine.tick({ account, tabId: 1 });
  const result = await f.engine.tick({ account, tabId: 1 });
  assert.equal(result.error.reason, 'TREE_MISSING_CHILD');
  assert.match(result.error.message, /子节点/);
  assert.equal(result.diagnostics.items[0].reason, 'TREE_MISSING_CHILD');
  assert.equal(result.diagnostics.items[0].status, 'retry');
  assert.equal(result.diagnostics.items[0].attempt, 1);
  assert.equal(f.calls.saves.length, 0);
  assert.deepEqual(await f.engine.getOutbox(account.accountKey), []);
  const restored = createCollectorEngine(f.dependencies);
  assert.equal((await restored.getState(account.accountKey)).error.reason, 'TREE_MISSING_CHILD');
  const log = await createActivityLog(f.dependencies).read(account.accountKey, 'collection');
  assert.equal(log.current.reason, 'TREE_MISSING_CHILD');
  assert.equal(log.recent[0].reason, 'TREE_MISSING_CHILD');
  assert.doesNotMatch(JSON.stringify([...f.store]), /private-response|private-body|private-id|bearer secret/);
});

test('unknown detail reasons are removed from retry state and recent activity', async () => {
  const f = setup();
  f.dependencies.adapter.detail = async () => {
    throw Object.assign(new Error('private secret'), { code: 'INCOMPLETE_DETAIL', reason: 'https://example.test/private?token=secret' });
  };
  await f.engine.start({ account, tabId: 1 });
  await f.engine.tick({ account, tabId: 1 });
  const result = await f.engine.tick({ account, tabId: 1 });
  assert.equal(result.error.reason, undefined);
  assert.equal(result.diagnostics.items[0].reason, undefined);
  assert.doesNotMatch(JSON.stringify([...f.store]), /example.test|token=|private secret/);
});

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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('collection details remain readable during actual list, detail and filesystem waits', { timeout: 5000 }, async t => {
  for (const stage of ['list', 'detail', 'save']) await t.test(stage, async () => {
    const f = setup(), entered = deferred(), release = deferred();
    await f.engine.start({ account, tabId: 1, mode: 'initial' });
    if (stage !== 'list') await f.engine.tick({ account, tabId: 1 });
    const activity = createActivityLog(f.dependencies);
    if (stage === 'save') {
      const original = f.dependencies.saveConversation;
      f.dependencies.saveConversation = async input => { entered.resolve(); await release.promise; return original(input); };
      f.engine = createCollectorEngine(f.dependencies);
    } else {
      const original = f.dependencies.adapter[stage];
      f.dependencies.adapter[stage] = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    }
    const tick = f.engine.tick({ account, tabId: 1 });
    await entered.promise;
    const state = await f.engine.getState(account.accountKey);
    const during = await activity.read(account.accountKey, 'collection');
    assert.equal(during.current.status, 'running');
    assert.equal(during.current.stage, stage);
    if (stage !== 'list') {
      assert.equal(during.current.conversationId, 'a');
      assert.equal(during.current.title, 'Title a');
      assert.equal(state.diagnostics.saved, 0);
      assert.equal(state.diagnostics.remaining, 2);
    }
    f.advance(12_000);
    const later = await activity.read(account.accountKey, 'collection');
    assert.equal(later.current.startedAt, during.current.startedAt);
    assert.equal(later.updatedAt, during.updatedAt, 'polling must not invent activity');
    release.resolve(); await tick;
    const after = await activity.read(account.accountKey, 'collection');
    assert.notEqual(after.current.status, 'running');
    assert.ok(after.recent.some(item => item.stage === stage));
  });
});

test('collection diagnostics expose bounded sanitized queue metadata and distinguish retry from terminal failure', async () => {
  const f = setup({ list: async () => ({ items: Array.from({ length: 65 }, (_, index) => ({
    ...source(`item-${index}`), title: `Title ${index} https://example.invalid/private?sig=secret github_pat_syntheticsecret`,
  })), nextOffset: null, total: 65 }), detailError: id => id === 'item-0' ? 'HTTP_429' : 'HTTP_404' });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await f.engine.tick({ account, tabId: 1 });
  await f.engine.tick({ account, tabId: 1 });
  await f.engine.tick({ account, tabId: 1 });
  const state = await f.engine.getState(account.accountKey), detail = state.diagnostics;
  assert.equal(detail.total, 65); assert.equal(detail.items.length, 50); assert.equal(detail.remaining, 65);
  assert.equal(detail.retrying, 1); assert.equal(detail.failed, 1); assert.equal(detail.saved, 0);
  assert.equal(detail.items[0].status, 'failed'); assert.equal(detail.items[0].code, 'HTTP_404');
  const retry = detail.items.find(item => item.status === 'retry');
  assert.equal(retry.conversationId, 'item-0'); assert.equal(retry.attempt, 1);
  assert.ok(retry.nextRetryAt > f.dependencies.now());
  assert.doesNotMatch(JSON.stringify(detail), /private|sig=|github_pat_|syntheticsecret|Untrusted error/);
  assert.equal(state.queue, undefined); assert.equal(state.known, undefined); assert.equal(state.manifestIds, undefined);
  const snapshots = structuredClone(f.store);
  await f.engine.getState(account.accountKey); await f.engine.getState(account.accountKey);
  assert.deepEqual(f.store, snapshots, 'read-only diagnostics never advance collection');
});

test('a failed detail logs its real error code while retry timing and completed archives remain unchanged', async () => {
  const f = setup({ detailError: id => id === 'a' ? 'INCOMPLETE_DETAIL' : null });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await f.engine.tick({ account, tabId: 1 });
  const result = await f.engine.tick({ account, tabId: 1 });
  const activity = await createActivityLog(f.dependencies).read(account.accountKey, 'collection');
  assert.equal(activity.current.stage, 'detail');
  assert.equal(activity.current.status, 'failed');
  assert.equal(activity.current.code, 'INCOMPLETE_DETAIL');
  assert.equal(result.diagnostics.retrying, 1); assert.equal(result.processed, 0);
  assert.equal(result.nextRetryAt, f.dependencies.now() + 60_000);
  assert.deepEqual(await f.engine.getOutboxSummary(account.accountKey), { total: 0, items: [] });
  await f.engine.tick({ account, tabId: 1 });
  assert.equal((await f.engine.getState(account.accountKey)).diagnostics.saved, 1);
});

test('outbox summaries show only bounded metadata without reading conversation bodies into the UI response', async () => {
  const f = setup(); await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  const stored = f.store.get(key('Outbox'));
  const first = stored.bundles[0];
  stored.bundles = Array.from({ length: 60 }, (_, index) => ({ ...first, id: `bundle-${index}`, conversationId: `item-${index}`,
    manifestEntry: { ...first.manifestEntry, title: 'Title https://example.invalid/image?sig=secret Bearer synthetic-token' },
    files: [{ path: 'private-path', content: 'conversation body must remain private to the diagnostic response' }],
  }));
  f.store.set(key('Outbox'), stored);
  const result = await f.engine.getOutboxSummary(account.accountKey);
  assert.equal(result.total, 60); assert.equal(result.items.length, 50);
  assert.equal(result.items[0].conversationId, 'item-0'); assert.ok(result.items[0].createdAt);
  assert.doesNotMatch(JSON.stringify(result), /private-path|conversation body|sig=|synthetic-token|manifestEntry|files/);
});

test('unchanged conversations from the last five minutes skip detail requests in every non-full mode', async () => {
  const time = 2_000_000_000_000 - 30_000;
  const f = setup({ list: async () => ({ items: [source('recent', time)], nextOffset: null, total: 1 }) });
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  for (const mode of ['initial', 'incremental']) {
    f.calls.details.length = 0;
    await f.engine.start({ account, tabId: 1, mode });
    const state = await complete(f.engine);
    assert.deepEqual(f.calls.details, [], mode);
    assert.equal(state.unchanged, 1);
    assert.equal(state.diagnostics.skipped, 1);
  }
});

test('a metadata scan of 102 conversations requests only the new and changed detail, including an older unknown ID', async () => {
  const original = Array.from({ length: 101 }, (_, index) => source(`id-${index}`, 1790000000 + index));
  let items = original;
  const f = setup({ list: async offset => ({ items: items.slice(offset, offset + 25),
    nextOffset: offset + 25 < items.length ? offset + 25 : null, total: items.length }) });
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  f.calls.details.length = 0; f.calls.pages.length = 0;
  items = [source('id-100', 1790000500), ...original.slice(0, 100), source('mobile-old', 1000)];
  await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
  const state = await complete(f.engine, { ...account, initialized: true });
  assert.deepEqual(f.calls.details, ['id-100', 'mobile-old']);
  assert.deepEqual(f.calls.pages, [0, 25, 50, 75, 100]);
  assert.equal(state.diagnostics.skipped, 100);
  assert.equal(state.diagnostics.saved, 2);
  assert.equal(state.processed, 102);
});

test('numeric seconds, milliseconds, numeric strings and ISO time share the same successful baseline', async () => {
  const seconds = 1792656000.1234, milliseconds = 1792656000123;
  let time = seconds;
  const f = setup({ list: async () => ({ items: [source('a', time)], nextOffset: null, total: 1 }) });
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  for (const equivalent of [milliseconds, String(seconds), String(milliseconds), new Date(milliseconds).toISOString()]) {
    time = equivalent; f.calls.details.length = 0;
    await f.engine.start({ account, tabId: 1, mode: 'incremental' });
    const state = await complete(f.engine);
    assert.deepEqual(f.calls.details, [], `timestamp ${equivalent}`);
    assert.equal(state.diagnostics.skipped, 1);
  }
});

test('restored complete archives reuse source timestamps without a browser collection index', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  const restored = setup({ local: structuredClone(f.local) });
  assert.equal(restored.store.get(key('Index')), undefined);
  await restored.engine.start({ account, tabId: 1, mode: 'incremental' });
  const state = await complete(restored.engine);
  assert.deepEqual(restored.calls.details, []);
  assert.equal(state.initializedComplete, true);
  assert.equal(state.diagnostics.skipped, 2);
  assert.deepEqual(await restored.engine.getOutbox(account.accountKey), []);
});

test('missing local files, incomplete archives and missing manifest entries stay eligible despite matching index', async t => {
  for (const condition of ['missing-files', 'incomplete', 'missing-entry']) await t.test(condition, async () => {
    let available = true;
    const f = setup({ filesPresent: id => id !== 'a' || available });
    await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
    if (condition === 'missing-files') available = false;
    if (condition === 'incomplete') f.local.get('a').entry.sourceCompleteness = 'unknown';
    if (condition === 'missing-entry') f.local.delete('a');
    f.calls.details.length = 0;
    await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
    await complete(f.engine, { ...account, initialized: true });
    assert.deepEqual(f.calls.details, ['a']);
  });
});

test('an index hash mismatch cannot hide a different archived version, but a complete matching archive is reusable', async t => {
  for (const sourceMatches of [false, true]) await t.test(`source matches: ${sourceMatches}`, async () => {
    const f = setup();
    await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
    f.local.get('a').entry.contentHash = 'remote-other-version';
    f.local.get('a').entry.sourceUpdatedAt = isoTime(sourceMatches ? 1000 : 999);
    f.calls.details.length = 0;
    await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
    await complete(f.engine, { ...account, initialized: true });
    assert.deepEqual(f.calls.details, sourceMatches ? [] : ['a']);
  });
});

test('a partial initial scan retries only unfinished details and newly discovered IDs', async () => {
  const f = setup({ detailError: id => id === 'a' ? 'HTTP_404' : null });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  assert.equal((await complete(f.engine)).status, 'partial');
  f.setDetailError(null);
  f.setList(async () => ({ items: [source('a'), source('b'), source('new')], nextOffset: null, total: 3 }));
  f.calls.details.length = 0;
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  const state = await complete(f.engine);
  assert.deepEqual(f.calls.details, ['a', 'new']);
  assert.equal(state.status, 'completed');
  assert.equal(state.initializedComplete, true);
  assert.equal(state.diagnostics.skipped, 1);
});

test('a failed full recheck remains retryable in the next incremental scan even with an unchanged complete archive', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  f.setDetailError(id => id === 'a' ? 'HTTP_404' : null);
  await f.engine.start({ account, tabId: 1, mode: 'full' });
  assert.equal((await complete(f.engine)).status, 'partial');
  f.setDetailError(null); f.calls.details.length = 0;
  await f.engine.start({ account, tabId: 1, mode: 'incremental' });
  const state = await complete(f.engine);
  assert.deepEqual(f.calls.details, ['a']);
  assert.equal(state.status, 'completed');
});

test('exhausted outbox failures cannot be skipped by the next scan using the already-written manifest', async () => {
  let reject = true;
  const f = setup({ list: async () => ({ items: [source('a')], nextOffset: null, total: 1 }),
    rejectStore: name => name === key('Outbox') && reject });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  await complete(f.engine);
  f.advance(61_000); await complete(f.engine);
  f.advance(121_000);
  const partial = await complete(f.engine);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.failed, 1);
  assert.ok(f.local.has('a'));
  assert.deepEqual(await f.engine.getOutbox(account.accountKey), []);
  reject = false; f.calls.details.length = 0;
  await f.engine.start({ account, tabId: 1, mode: 'incremental' });
  const state = await complete(f.engine);
  assert.deepEqual(f.calls.details, ['a']);
  assert.equal(state.status, 'completed');
  assert.equal((await f.engine.getOutbox(account.accountKey)).length, 1);
});

test('a detail older than the observed list version never advances the incremental baseline', async () => {
  let returnedTime = 1000;
  const f = setup({ list: async () => ({ items: [source('a', 1001)], nextOffset: null, total: 1 }),
    detailTime: () => returnedTime });
  await f.engine.start({ account, tabId: 1, mode: 'initial' });
  const stale = await complete(f.engine);
  assert.equal(stale.error.code, 'STALE_DETAIL');
  assert.deepEqual(f.calls.saves, []);
  assert.equal(f.store.get(key('Index')), undefined);
  returnedTime = 1001; f.advance(61_000);
  const state = await complete(f.engine);
  assert.equal(state.status, 'completed');
  assert.deepEqual(f.calls.saves, ['a']);
});

test('an unfinished discovery checkpoint keeps pending IDs eligible in a fresh scan despite complete local copies', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  f.setList(async offset => offset === 0 ? { items: [source('a')], nextOffset: 1, total: 2 }
    : { items: [], nextOffset: null, total: 2 });
  await f.engine.start({ account, tabId: 1, mode: 'full' });
  const partial = await complete(f.engine);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.error.code, 'ENUMERATION_INCOMPLETE');
  f.setList(async () => ({ items: [source('a'), source('b')], nextOffset: null, total: 2 }));
  f.calls.details.length = 0;
  await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
  const state = await complete(f.engine, { ...account, initialized: true });
  assert.deepEqual(f.calls.details, ['a']);
  assert.equal(state.status, 'completed');
  assert.equal(state.diagnostics.skipped, 1);
});

test('a renamed conversation is refreshed even when its list timestamp is unchanged', async () => {
  const f = setup();
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  f.setList(async () => ({ items: [{ ...source('a'), title: 'Renamed conversation' }, source('b')], nextOffset: null, total: 2 }));
  f.calls.details.length = 0;
  await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
  await complete(f.engine, { ...account, initialized: true });
  assert.deepEqual(f.calls.details, ['a']);
  assert.equal(f.local.get('a').entry.title, 'Renamed conversation');
  f.calls.details.length = 0;
  await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
  await complete(f.engine, { ...account, initialized: true });
  assert.deepEqual(f.calls.details, []);
});

test('unfinished local-save delivery survives an intervening scan that never observes the conversation', async t => {
  for (const missing of ['list-failure', 'temporarily-absent']) await t.test(missing, async () => {
    let reject = true;
    const f = setup({ list: async () => ({ items: [source('a')], nextOffset: null, total: 1 }),
      rejectStore: name => name === key('Outbox') && reject });
    await f.engine.start({ account, tabId: 1, mode: 'initial' });
    await complete(f.engine);
    f.advance(61_000); await complete(f.engine);
    f.advance(121_000);
    assert.equal((await complete(f.engine)).status, 'partial');
    assert.ok(f.local.has('a'));
    reject = false;
    f.setList(missing === 'list-failure' ? async () => { throw issue('FORMAT'); }
      : async () => ({ items: [source('b')], nextOffset: null, total: 1 }));
    await f.engine.start({ account, tabId: 1, mode: 'incremental' });
    assert.equal((await complete(f.engine)).status, missing === 'list-failure' ? 'partial' : 'completed');
    assert.equal((await f.engine.getOutbox(account.accountKey)).some(item => item.conversationId === 'a'), false);
    f.setList(async () => ({ items: [source('a'), source('b')], nextOffset: null, total: 2 }));
    f.calls.details.length = 0;
    await f.engine.start({ account, tabId: 1, mode: 'incremental' });
    const state = await complete(f.engine);
    assert.equal(state.status, 'completed');
    assert.deepEqual(f.calls.details, missing === 'list-failure' ? ['a', 'b'] : ['a']);
    assert.equal((await f.engine.getOutbox(account.accountKey)).some(item => item.conversationId === 'a'), true);
  });
});

test('a duplicate ID with a later timestamp on another page cancels an earlier unchanged skip', async () => {
  const f = setup({ list: async () => ({ items: [source('a')], nextOffset: null, total: 1 }) });
  await f.engine.start({ account, tabId: 1, mode: 'initial' }); await complete(f.engine);
  f.setList(async offset => offset === 0 ? { items: [source('a')], nextOffset: 1, total: null }
    : { items: [source('a', 1001), source('b')], nextOffset: null, total: null });
  f.calls.details.length = 0;
  await f.engine.start({ account: { ...account, initialized: true }, tabId: 1 });
  const state = await complete(f.engine, { ...account, initialized: true });
  assert.equal(state.status, 'completed');
  assert.deepEqual(f.calls.details, ['a', 'b']);
  assert.equal(state.diagnostics.skipped, 0);
  assert.equal(state.processed, 2);
});
