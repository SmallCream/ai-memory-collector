import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorService, ALARM_NAME } from '../extension/lib/collector-service.js';
import { createCollectorEngine } from '../extension/lib/collector-engine.js';
import { DEFAULT_CONFIG } from '../extension/lib/config.js';

const accountKey = 'acct-' + 'a'.repeat(24);
const account = { platform: 'chatgpt', accountKey, storageKey: accountKey, alias: 'Demo', enabled: true, initialized: false, nextRunAt: 0 };
const site = 'https://chatgpt.com/*';
const issue = code => Object.assign(new Error(code), { code });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function directory(name) {
  return { kind: 'directory', name, entries: new Map(), granted: true,
    async queryPermission() { return this.granted ? 'granted' : 'prompt'; },
    async isSameEntry(other) { return this.name === other?.name; } };
}
function fixture(options = {}) {
  let clock = 2_000_000_000_000;
  const root = directory('original'), store = new Map(), calls = { lists: 0, details: 0, saves: [], uploads: [], applies: [], panels: [], messages: [], timers: [] };
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, { setupComplete: true, accounts: { [accountKey]: account } }, options.config || {});
  config.github = { ...DEFAULT_CONFIG.github, ...options.github };
  store.set('collectorConfigV2', structuredClone(config)); store.set('directory', root);
  const clone = value => value?.kind === 'directory' ? value : structuredClone(value);
  const getSetting = async key => clone(store.get(key));
  const setSetting = async (key, value) => store.set(key, clone(value));
  const tabs = [{ id: 1, url: 'https://chatgpt.com/c/demo', active: true }];
  const identities = new Map([[1, { platform: 'chatgpt', accountKey, displayName: 'Demo' }]]);
  const permissions = new Set([site, 'https://api.github.com/*']), scripts = new Map(), alarms = new Map();
  const browser = {
    permissions: { contains: async ({ origins }) => origins.every(origin => permissions.has(origin)) },
    tabs: { get: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw issue('TAB_CLOSED'); return tab; },
      query: async query => tabs.filter(t => (!query.active || t.active) && (!query.url || t.url.startsWith('https://chatgpt.com/'))),
      sendMessage: async (id, message) => calls.messages.push({ id, message }) },
    sidePanel: { setOptions: async value => calls.panels.push(value) },
    scripting: { getRegisteredContentScripts: async () => [...scripts.values()],
      registerContentScripts: async values => values.forEach(value => scripts.set(value.id, value)),
      unregisterContentScripts: async ({ ids }) => ids.forEach(id => scripts.delete(id)), executeScript: async () => {} },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value) },
  };
  const adapter = {
    identify: async id => { if (!identities.has(id)) throw issue('HTTP_401'); return identities.get(id); },
    list: async () => { calls.lists++; const ids = options.ids || ['one']; return { items: ids.map(id => ({ id, title: id, updateTime: 1000 })), nextOffset: null, total: ids.length }; },
    detail: async (tabId, { conversationId }) => { calls.details++; return { identity: identities.get(tabId), completeness: 'complete', capturedAt: new Date(clock).toISOString(), payload: { conversation_id: conversationId, update_time: 1000 } }; },
  };
  function saved(dir, id) {
    const entry = { conversationId: id, contentHash: `hash-${id}`, sourceUpdatedAt: '1970-01-01T00:16:40.000Z' };
    dir.entries.set(id, entry);
    const manifest = { schemaVersion: 1, platform: 'chatgpt', accountKey, conversations: Object.fromEntries(dir.entries) };
    const prefix = `data/web/chatgpt/${accountKey}`;
    return { entry, manifest, status: 'added', files: [
      { path: `${prefix}/conversations/${id}.json`, content: JSON.stringify({ conversation_id: id }) },
      { path: `${prefix}/conversations/${id}.md`, content: `# ${id}\n` },
      { path: `${prefix}/archive/manifest.json`, content: JSON.stringify(manifest) },
      { path: `${prefix}/account.json`, content: JSON.stringify({ accountKey }) },
    ] };
  }
  const dependencies = { browser, getSetting, setSetting, adapter, createEngine: createCollectorEngine,
    readAccountManifest: async dir => ({ conversations: Object.fromEntries(dir.entries) }),
    saveConversation: async ({ directory: dir, detail }) => {
      calls.saves.push(dir.name); await options.saveGate?.promise;
      return saved(dir, detail.payload.conversation_id);
    },
    syncArchives: async input => { calls.uploads.push(structuredClone(input)); await options.syncGate?.promise;
      if (options.syncError) throw issue(options.syncError);
      return options.syncResult || { remoteWinners: [], conflicts: [], commitSha: 'commit' }; },
    applyRemoteFiles: async ({ directory: dir }) => { calls.applies.push(dir.name); await options.applyGate?.promise; return options.applyResult || {}; },
    probeRepository: async () => ({ private: true }), now: () => clock,
    later: (fn, delay) => { calls.timers.push({ fn, delay }); return calls.timers.length; },
  };
  return { service: createCollectorService(dependencies), dependencies, store, root, saved, tabs, identities, permissions, scripts, alarms, calls,
    advance: ms => clock += ms, config: () => store.get('collectorConfigV2'), now: () => clock };
}
async function complete(f) {
  for (let i = 0; i < 20; i++) {
    await f.service.pump();
    const job = await f.service.engine.getState(accountKey);
    if (job && job.status !== 'running') return job;
  }
  throw new Error('Job did not complete');
}

test('automatic collection requires bound enabled account, setup and scheduling; state excludes token', async () => {
  for (const config of [{ setupComplete: false }, { autoEnabled: false }, { accounts: {} }, { accounts: { [accountKey]: { ...account, enabled: false } } }]) {
    const f = fixture({ config }); await f.service.pump();
    assert.equal(await f.service.engine.getState(accountKey), null);
    assert.equal(f.calls.lists, 0);
  }
  const f = fixture({ github: { token: 'github_pat_secret' } });
  const state = await f.service.state(1);
  assert.equal(state.config.github.hasToken, true);
  assert.equal(JSON.stringify(state).includes('github_pat_secret'), false);
  f.root.granted = false; await f.service.pump();
  assert.equal(f.calls.lists, 0);
});

test('two tabs for one account deduplicate and the next interval runs incremental', async () => {
  const f = fixture();
  f.tabs.push({ id: 2, url: 'https://chatgpt.com/c/other' }); f.identities.set(2, f.identities.get(1));
  const job = await complete(f);
  assert.equal(job.status, 'completed'); assert.equal(f.calls.lists, 1); assert.equal(f.calls.details, 1);
  assert.equal(f.config().accounts[accountKey].initialized, true);
  assert.equal(f.config().accounts[accountKey].nextRunAt, job.completedAt + 30 * 60000);
  f.advance(30 * 60000); await f.service.pump();
  assert.equal((await f.service.engine.getState(accountKey)).mode, 'incremental');
  assert.ok(f.calls.timers.every(timer => timer.delay === 1200));
});

test('same tab switching identity pauses its old account without binding the new one', async () => {
  const f = fixture(); await f.service.pump();
  f.identities.set(1, { platform: 'chatgpt', accountKey: 'acct-' + 'b'.repeat(24) }); f.advance(10001);
  await f.service.pump();
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
  assert.equal(f.calls.lists, 0); assert.equal(Object.keys(f.config().accounts).length, 1);
});

test('restart reconciles completion before choosing another initial job, without postponing the next due scan', async () => {
  const f = fixture();
  await f.service.engine.start({ account, tabId: 1, mode: 'initial' });
  for (let i = 0; i < 4; i++) await f.service.engine.tick({ account, tabId: 1 });
  const finished = await f.service.engine.getState(accountKey);
  f.service = createCollectorService(f.dependencies); await f.service.pump();
  assert.equal(f.config().accounts[accountKey].initialized, true);
  assert.equal((await f.service.engine.getState(accountKey)).id, finished.id);
  f.advance(31 * 60000); await f.service.pump();
  assert.equal((await f.service.engine.getState(accountKey)).mode, 'incremental');
});

test('directory replacement waits for the current local write, resets its index and preserves pending uploads', async () => {
  const saveGate = deferred(), f = fixture({ saveGate });
  await f.service.pump(); await f.service.pump();
  const pumping = f.service.pump(); await turn();
  assert.deepEqual(f.calls.saves, ['original']);
  const replacement = directory('replacement'); f.store.set('directoryCandidate', replacement);
  let changed = false; const changing = f.service.command({ type: 'collector:directory-changed' }, 1).then(() => changed = true);
  await turn(); assert.equal(changed, false); assert.equal(f.store.get('directory'), f.root);
  saveGate.resolve(); await pumping; await changing;
  assert.equal(f.store.get('directory'), replacement); assert.equal(await f.service.engine.getState(accountKey), null);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  assert.equal(replacement.entries.size, 0);
});

test('a pending archive journal prevents moving to another directory', async () => {
  const f = fixture(); f.store.set(`archiveJournal:chatgpt:${accountKey}`, { pending: true });
  f.store.set('directoryCandidate', directory('replacement'));
  await assert.rejects(f.service.command({ type: 'collector:directory-changed' }, 1), error => error.code === 'DIRECTORY_PENDING');
  assert.equal(f.store.get('directory'), f.root);
});

test('GitHub retries the durable outbox without recollecting source data', async () => {
  const options = { syncError: 'GITHUB_NETWORK', github: { enabled: true, repository: 'owner/repo', token: 'token' } }, f = fixture(options);
  await complete(f); assert.equal(f.calls.uploads.length, 1);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  options.syncError = null;
  await f.service.command({ type: 'collector:retry-github' }, 1);
  assert.equal(f.calls.uploads.length, 2); assert.equal(f.calls.lists, 1); assert.equal(f.calls.details, 1);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  assert.equal((await f.service.state(1)).githubStatus.status, 'synced');
});

test('directory replacement and resume serialize behind remote reconciliation; recovered files remain queued', async () => {
  const applyGate = deferred(), options = { applyGate, syncResult: { remoteWinners: [{ files: [] }], conflicts: [] },
    github: { enabled: false, repository: 'owner/repo', token: 'token' } }, f = fixture(options);
  await complete(f); options.applyResult = { recovered: f.saved(f.root, 'recovered') };
  await f.service.command({ type: 'collector:github-config', enabled: true }, 1);
  const uploading = f.service.command({ type: 'collector:retry-github' }, 1); await turn();
  assert.deepEqual(f.calls.applies, ['original']);
  f.store.set('directoryCandidate', directory('replacement'));
  let swapped = false; const changing = f.service.command({ type: 'collector:directory-changed' }, 1).then(() => swapped = true);
  const resuming = f.service.command({ type: 'collector:resume' }, 1);
  await turn(); assert.equal(swapped, false);
  applyGate.resolve(); await uploading; await changing; await resuming;
  assert.equal(f.store.get('directory').name, 'replacement');
  assert.deepEqual((await f.service.engine.getOutbox(accountKey)).map(bundle => bundle.conversationId), ['recovered']);
});

test('duplicate start is coalesced and a live initial job rejects overlapping full backfill', async () => {
  const f = fixture();
  const results = await Promise.all([1, 2].map(() => f.service.command({ type: 'collector:start', mode: 'initial' }, 1)));
  assert.equal(results[0].state.job.id, results[1].state.job.id);
  await assert.rejects(f.service.command({ type: 'collector:start', mode: 'full' }, 1), error => error.code === 'BUSY');
  assert.equal(f.calls.details, 0);
});

test('closing the last source tab suspends collection but uploads saved files and reopening resumes', async () => {
  const f = fixture({ ids: ['one', 'two'], github: { enabled: true, repository: 'owner/repo', token: 'token' } });
  await f.service.pump(); await f.service.pump(); await f.service.pump();
  f.tabs.splice(0); await f.service.tabGone(1); await f.service.pump();
  assert.equal((await f.service.engine.getState(accountKey)).error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(f.calls.uploads.length, 1);
  f.tabs.push({ id: 2, url: 'https://chatgpt.com/', active: true }); f.identities.set(2, f.identities.get(1));
  await complete(f); assert.equal(f.calls.details, 2);
});

test('permission revocation removes the content entry and exposes recovery; heartbeat is one minute', async () => {
  const f = fixture(); await f.service.initialize(); await f.service.initialize();
  assert.equal(f.scripts.size, 1); assert.deepEqual(f.alarms.get(ALARM_NAME), { periodInMinutes: 1 });
  f.permissions.delete(site); await f.service.initialize();
  assert.equal(f.scripts.size, 0);
  assert.ok(f.calls.panels.some(value => value.tabId === 1 && value.enabled === false));
  assert.ok(f.calls.messages.some(value => value.message.type === 'collector:hide-entry'));
  assert.equal((await f.service.state(1)).error.code, 'SITE_PERMISSION_REQUIRED');
});

test('GitHub omitted token preserves it, explicit empty clears it and a changed destination requires backfill', async () => {
  const f = fixture({ github: { enabled: false, repository: 'owner/old', token: 'token' } });
  await f.service.command({ type: 'collector:github-config', branch: 'main' }, 1);
  assert.equal(f.config().github.token, 'token');
  f.store.set(`githubStatus:${accountKey}`, { status: 'synced' });
  await f.service.command({ type: 'collector:github-config', repository: 'owner/new' }, 1);
  const status = (await f.service.state(1)).githubStatus;
  assert.equal(status.status, 'pending'); assert.equal(status.needsBackfill, true);
  await f.service.command({ type: 'collector:github-config', token: '', enabled: false }, 1);
  assert.equal(f.config().github.token, '');
});

test('destination changes during an upload cannot acknowledge data for the new repository', async () => {
  const syncGate = deferred(), f = fixture({ syncGate, github: { enabled: false, repository: 'owner/old', token: 'token' } });
  await complete(f); await f.service.command({ type: 'collector:github-config', enabled: true }, 1);
  const uploading = f.service.command({ type: 'collector:retry-github' }, 1); await turn();
  f.config().github.repository = 'owner/new'; syncGate.resolve();
  await assert.rejects(uploading, error => error.code === 'GITHUB_TARGET_CHANGED');
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  assert.equal((await f.service.state(1)).githubStatus.error.code, 'GITHUB_TARGET_CHANGED');
});
