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
  // Real directory handles support structured cloning; preserve our in-memory
  // handle when it is nested in a durable maintenance/backfill checkpoint.
  const clone = value => value?.kind === 'directory' ? value : value?.directory?.kind === 'directory'
    ? { ...structuredClone({ ...value, directory: null }), directory: value.directory } : structuredClone(value);
  const getSetting = async key => clone(store.get(key));
  const setSetting = async (key, value) => store.set(key, clone(value));
  const tabs = [{ id: 1, url: 'https://chatgpt.com/c/demo', active: true }];
  const identities = new Map([[1, { platform: 'chatgpt', accountKey, displayName: 'Demo' }]]);
  const permissions = new Set([site, 'https://api.github.com/*']), scripts = new Map(), alarms = new Map();
  const browser = {
    permissions: { contains: async ({ origins }) => origins.every(origin => permissions.has(origin)) },
    tabs: { get: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw issue('TAB_CLOSED'); return tab; },
      query: async query => tabs.filter(t => (!query.active || t.active) && (!query.url || t.url.startsWith(query.url.replace('*', '')))),
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
  const dependencies = { browser, getSetting, setSetting,
    getSettingsByPrefix: async prefix => [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })), adapter, createEngine: createCollectorEngine,
    readAccountManifest: async dir => ({ conversations: Object.fromEntries(dir.entries) }),
    readConversationArchive: async (dir, _account, id) => {
      if (!dir.entries.has(id)) throw issue('LOCAL_VERIFY');
      return saved(dir, id);
    },
    saveConversation: async ({ directory: dir, detail }) => {
      calls.saves.push(dir.name); await options.saveGate?.promise;
      return saved(dir, detail.payload.conversation_id);
    },
    syncArchives: async input => { const { isCurrent, ...request } = input;
      calls.uploads.push(structuredClone(request)); await options.syncGate?.promise;
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

test('Doubao permissions and binding are independent; revocation keeps ChatGPT available', async () => {
  const f = fixture(), doubaoKey = 'acct-' + 'd'.repeat(24);
  f.tabs.push({ id: 2, url: 'https://www.doubao.com/chat/123', active: false });
  f.identities.set(2, { platform: 'doubao', accountKey: doubaoKey, displayName: 'Synthetic Doubao' });
  assert.equal((await f.service.state(2)).error.code, 'SITE_PERMISSION_REQUIRED');
  f.permissions.add('https://www.doubao.com/*');
  await f.service.command({ type: 'collector:permissions-changed' }, 2);
  await f.service.command({ type: 'collector:bind', alias: '豆包测试' }, 2);
  assert.equal(f.config().accounts[doubaoKey].platform, 'doubao');
  assert.equal(f.config().accounts[accountKey].platform, 'chatgpt');
  assert.equal(f.scripts.size, 2); assert.equal((await f.service.state(2)).platform, 'doubao');
  f.calls.panels.length = 0; f.permissions.delete('https://www.doubao.com/*');
  await f.service.command({ type: 'collector:permissions-changed' }, 1);
  assert.equal(f.scripts.has('collector-doubao-entry'), false);
  assert.equal(f.scripts.has('collector-chatgpt-entry'), true);
  assert.ok(!f.calls.panels.some(p => p.tabId === 1 && p.enabled === false));
  assert.equal((await f.service.state(1)).identity.accountKey, accountKey);
});

test('pause reaches an in-flight detail between pages without waiting for the filesystem lock; resume retries it', async () => {
  const f = fixture(), started = deferred(), page = deferred();
  const original = f.dependencies.adapter.detail;
  let checkPause, nextPages = 0;
  f.dependencies.adapter.detail = async (tabId, request) => {
    checkPause = request.shouldPause; started.resolve(); await page.promise;
    if (request.shouldPause()) throw issue('COLLECTION_PAUSED');
    nextPages++; return original(tabId, request);
  };
  await f.service.pump(); await f.service.pump();
  const pumping = f.service.pump(); await started.promise;
  const pausing = f.service.command({ type: 'collector:pause' }, 1);
  for (let n = 0; n < 20 && !checkPause(); n++) await turn();
  const signalled = checkPause();
  page.resolve(); await Promise.all([pumping, pausing]);
  assert.equal(signalled, true); assert.equal(nextPages, 0);
  assert.equal(f.calls.saves.length, 0); assert.equal(f.root.entries.size, 0);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  const paused = await f.service.engine.getState(accountKey);
  assert.equal(paused.status, 'paused'); assert.equal(paused.failed, 0);
  assert.equal(paused.diagnostics.items[0].attempt, 0);
  await f.service.command({ type: 'collector:resume' }, 1);
  assert.equal((await complete(f)).status, 'completed');
  assert.equal(nextPages, 1); assert.equal(f.calls.saves.length, 1);
});

test('pause after detail resolution is checked again before any archive write', async () => {
  const f = fixture(), verified = deferred(), release = deferred();
  const originalIdentify = f.dependencies.adapter.identify;
  const originalDetail = f.dependencies.adapter.detail;
  let detailReturned = false;
  f.dependencies.adapter.detail = async (...args) => { const result = await originalDetail(...args); detailReturned = true; return result; };
  f.dependencies.adapter.identify = async (...args) => {
    if (detailReturned) { verified.resolve(); await release.promise; }
    return originalIdentify(...args);
  };
  await f.service.pump(); await f.service.pump();
  const pumping = f.service.pump(); await verified.promise;
  const pausing = f.service.engine.pause(accountKey);
  release.resolve(); await Promise.all([pumping, pausing]);
  assert.equal(f.calls.saves.length, 0);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
});

test('get-state shows actual GitHub request progress while the writer owns the command lock', async () => {
  const gate = deferred();
  const f = fixture({ syncGate: gate, github: { enabled: true, token: 'private-token', repository: 'owner/private' } });
  await f.service.pump(); await f.service.pump(); await f.service.pump();
  const pumping = f.service.pump();
  for (let n = 0; n < 20 && !f.calls.uploads.length; n++) await turn();
  assert.equal(f.calls.uploads.length, 1);
  const state = (await f.service.command({ type: 'collector:get-state' }, 1)).state;
  assert.equal(state.activity.github.current.status, 'running');
  assert.equal(state.activity.github.current.stage, 'commit');
  assert.equal(state.outboxSummary.total, 1);
  assert.ok(!JSON.stringify(state.activity).includes('private-token'));
  gate.resolve(); await pumping;
  assert.equal((await f.service.state(1)).activity.github.current.status, 'success');
});

test('explicit identity checks do not block progress reads and are labelled until the new account is confirmed', async () => {
  const f = fixture(); await f.service.state(1); f.advance(11000);
  const gate = deferred(); let checks = 0;
  const changed = { platform: 'chatgpt', accountKey: 'acct-new', displayName: 'Other account' };
  f.dependencies.adapter.identify = async () => { checks++; await gate.promise; return changed; };
  const pending = (await f.service.command({ type: 'collector:get-state', refreshIdentity: true }, 1)).state;
  assert.equal(pending.identity.accountKey, accountKey); assert.equal(pending.identityChecking, true);
  await f.service.state(1); assert.equal(checks, 1);
  gate.resolve(); await turn();
  const next = await f.service.state(1);
  assert.equal(next.identity.accountKey, changed.accountKey); assert.equal(next.identityChecking, false);
  assert.equal(next.account, null); assert.equal(next.activity.collection, null); assert.equal(next.outboxSummary, null);
});

test('manual restore runs without a source tab, account binding or automatic upload', async () => {
  const f = fixture({ config: { setupComplete: false, accounts: {} }, github: { repository: 'owner/data', token: 'secret', enabled: false } });
  f.tabs.length = 0; f.permissions.delete(site);
  const calls = [];
  let restoreState = { status: 'idle' };
  f.dependencies.restoreService = {
    state: async () => restoreState,
    start: async input => { calls.push(input); restoreState = { status: 'running', total: 1 }; },
    tick: async () => { restoreState = { status: 'completed', total: 1, processed: 1 }; return restoreState; },
  };
  f.service = createCollectorService(f.dependencies);
  const result = await f.service.command({ type: 'collector:restore' });
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].config.repository, 'owner/data'); assert.equal(calls[0].directory, f.root);
  await f.service.pump();
  assert.equal((await f.service.state()).restoreStatus.status, 'completed');
  assert.equal(f.calls.details, 0); assert.deepEqual(f.config().accounts, {});
});

test('scheduled remote checks run without pending uploads or ChatGPT tabs and respect interval', async () => {
  const f = fixture({ config: { accounts: {} }, github: { repository: 'owner/data', token: 'secret', enabled: false, autoRestore: true } });
  f.tabs.length = 0; let starts = 0;
  f.dependencies.restoreService = {
    state: async () => ({ status: 'completed' }),
    start: async () => { starts++; }, tick: async () => ({ status: 'completed' }),
  };
  f.service = createCollectorService(f.dependencies);
  await f.service.pump(); await f.service.pump();
  assert.equal(starts, 1); assert.equal(f.calls.uploads.length, 0);
  f.advance(30 * 60000); await f.service.pump(); assert.equal(starts, 2);
});

test('legacy LFS settings and pending uploads cannot block text backup', async () => {
  const f = fixture({ github: { repository: 'owner/data', token: 'secret', enabled: true, lfsEnabled: true } });
  f.dependencies.assetService = { tick: async () => ({ runnable: false }),
    prepareUploads: async () => { throw new Error('LFS must never run'); },
    acknowledgeUploads: async () => { throw new Error('LFS must never run'); } };
  f.service = createCollectorService(f.dependencies);
  f.store.set(`assetUploads:${accountKey}`, { signature: 'old-upload' });
  await f.service.engine.enqueueArchive({ account, archive: f.saved(f.root, 'one') });
  await f.service.command({ type: 'collector:retry-github' }, 1);
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.calls.uploads[0].assetPointers, undefined);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).status, 'synced');
});

test('GitHub retry replaces stale LFS progress with its failure and preserves backoff and delivery checkpoints', async () => {
  const options = { config: { autoEnabled: false }, syncError: 'GITHUB_NETWORK',
    github: { repository: 'owner/data', token: 'secret', enabled: true, lfsEnabled: true } };
  const f = fixture(options), key = `githubStatus:${accountKey}`, running = [];
  let acknowledged = 0;
  const sync = f.dependencies.syncArchives;
  f.dependencies.syncArchives = input => { running.push(structuredClone(f.store.get(key))); return sync(input); };
  f.service = createCollectorService(f.dependencies);
  await f.service.engine.enqueueArchive({ account, archive: f.saved(f.root, 'one') });
  f.store.set(key, { status: 'pending', pending: 1, message: 'old upload progress',
    error: { code: 'GITHUB_PERMISSION', message: 'old failure' }, attempt: 4,
    nextRetryAt: f.now() + 30 * 60000, lastSyncedAt: 1000, commitSha: 'old-commit' });

  await f.service.pump();
  assert.equal(running.length, 0);
  assert.equal(f.store.get(key).error.code, 'GITHUB_PERMISSION');
  await assert.rejects(f.service.command({ type: 'collector:retry-github' }, 1), error => error.code === 'GITHUB_NETWORK');
  const failed = structuredClone(f.store.get(key));
  assert.equal(failed.status, 'pending'); assert.equal(failed.message, '');
  assert.equal(failed.error.code, 'GITHUB_NETWORK'); assert.equal(failed.attempt, 5);
  assert.equal(failed.nextRetryAt, f.now() + 32 * 60000);
  assert.equal(failed.lastSyncedAt, 1000); assert.equal(failed.commitSha, 'old-commit');
  assert.equal(acknowledged, 0); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  await f.service.pump();
  assert.deepEqual(f.store.get(key), failed); assert.equal(running.length, 1);

  options.syncError = null;
  await f.service.command({ type: 'collector:retry-github' }, 1);
  for (const state of running) {
    assert.equal(state.status, 'syncing'); assert.equal(state.error, null);
    assert.equal(state.message, ''); assert.equal(state.nextRetryAt, 0);
  }
  assert.equal(acknowledged, 0); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  assert.equal(f.store.get(key).status, 'synced'); assert.equal(f.store.get(key).error, null);
  assert.equal(f.calls.lists, 0); assert.equal(f.calls.details, 0);
});

test('image-only retry remains account scoped and works while conversation collection stays paused', async () => {
  const f = fixture({ config: { autoEnabled: false } }), retries = [], ticks = [];
  const diagnostics = { total: 1, pending: 1, failed: 1, failures: [{ code: 'HTTP_404' }] };
  f.dependencies.assetService = {
    diagnostics: async ({ account: current }) => { assert.equal(current.accountKey, accountKey); return diagnostics; },
    retryFailed: async ({ account: current }) => retries.push(current.accountKey),
    tick: async request => { ticks.push(request); return { runnable: false }; },
  };
  f.service = createCollectorService(f.dependencies);
  await f.service.command({ type: 'collector:start', mode: 'full' }, 1);
  await f.service.command({ type: 'collector:pause' }, 1);
  const result = await f.service.command({ type: 'collector:retry-images' }, 1);
  assert.deepEqual(result.state.assetDiagnostics, diagnostics);
  await f.service.pump();
  assert.deepEqual(retries, [accountKey]); assert.equal(ticks.length, 1); assert.equal(ticks[0].manualOnly, true);
  assert.equal(ticks[0].account.accountKey, accountKey); assert.equal(ticks[0].tabId, 1);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
  assert.equal(f.calls.lists, 0); assert.equal(f.calls.details, 0);
});

test('image retry rejects unavailable permissions, disabled account and newly switched unbound account', async () => {
  for (const kind of ['site', 'directory', 'disabled', 'switched']) {
    const f = fixture(); let retried = false;
    f.dependencies.assetService = { retryFailed: async () => { retried = true; } };
    f.service = createCollectorService(f.dependencies); await f.service.state(1);
    if (kind === 'site') f.permissions.delete(site);
    if (kind === 'directory') f.root.granted = false;
    if (kind === 'disabled') f.config().accounts[accountKey].enabled = false;
    if (kind === 'switched') f.identities.set(1, { platform: 'chatgpt', accountKey: 'acct-' + 'b'.repeat(24), displayName: 'Other' });
    await assert.rejects(f.service.command({ type: 'collector:retry-images' }, 1), {
      code: kind === 'site' ? 'SITE_PERMISSION_REQUIRED' : kind === 'directory' ? 'DIRECTORY_PERMISSION' : 'ACCOUNT_DISABLED',
    });
    assert.equal(retried, false);
  }
});

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
  const saveGate = deferred(), f = fixture({ saveGate, github: { enabled: true } });
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
  const uploading = f.service.command({ type: 'collector:retry-github' }, 1);
  for (let n = 0; n < 20 && !f.calls.uploads.length; n++) await turn();
  assert.equal(f.calls.uploads.length, 1);
  await f.service.command({ type: 'collector:github-config', repository: 'owner/new' }, 1);
  const revised = structuredClone(f.store.get(`githubStatus:${accountKey}`));
  syncGate.resolve(); await uploading;
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  assert.deepEqual(f.store.get(`githubStatus:${accountKey}`), revised);
  assert.equal(revised.needsBackfill, true); assert.equal(revised.manual, false);
  await f.service.pump();
  assert.equal(f.calls.uploads.at(-1).config.repository, 'owner/new');
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
});

test('turning off backup while a manual request is in flight preserves the new cancelled intent', async () => {
  for (const syncError of [undefined, 'NETWORK']) {
    const gate = deferred(), f = fixture({ syncGate: gate, syncError,
      github: { enabled: false, repository: 'owner/repo', token: 'token' } });
    await complete(f);
    const uploading = f.service.command({ type: 'collector:retry-github' }, 1);
    for (let n = 0; n < 20 && !f.calls.uploads.length; n++) await turn();
    assert.equal(f.calls.uploads.length, 1);
    await f.service.command({ type: 'collector:github-config', enabled: false }, 1);
    const revised = structuredClone(f.store.get(`githubStatus:${accountKey}`));
    gate.resolve(); await uploading;
    assert.deepEqual(f.store.get(`githubStatus:${accountKey}`), revised);
    assert.equal(revised.manual, false); assert.equal(revised.error, null);
    assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
    await f.service.pump(); assert.equal(f.calls.uploads.length, 1);
  }
});

test('a new manual backup intent survives the older attempt at the same destination', async () => {
  const gate = deferred(), f = fixture({ syncGate: gate,
    github: { enabled: true, repository: 'owner/repo', token: 'token' } });
  await f.service.pump(); await f.service.pump(); await f.service.pump();
  const running = f.service.pump();
  for (let n = 0; n < 20 && !f.calls.uploads.length; n++) await turn();
  assert.equal(f.calls.uploads.length, 1);
  await f.service.command({ type: 'collector:retry-github' }, 1);
  const revised = structuredClone(f.store.get(`githubStatus:${accountKey}`));
  assert.equal(revised.manual, true); assert.equal(revised.needsBackfill, true);
  gate.resolve(); await running;
  assert.deepEqual(f.store.get(`githubStatus:${accountKey}`), revised);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  await f.service.pump();
  assert.equal(f.calls.uploads.length, 2);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).manual, false);
});

test('internal attachment retry forwards only explicit true and keeps the active account scope', async () => {
  const f = fixture({ config: { autoEnabled: false } }), retries = [];
  f.dependencies.assetService = { retryFailed: async request => retries.push(request) };
  f.service = createCollectorService(f.dependencies);
  for (const includeInternal of [true, false, 'true']) {
    await f.service.command({ type: 'collector:retry-images', includeInternal, account: { accountKey: 'foreign' } }, 1);
  }
  assert.equal(retries.length, 3);
  assert(retries.every(request => request.account.accountKey === accountKey));
  assert.deepEqual(retries.map(request => request.includeInternal), [true, undefined, undefined]);
});

test('internal attachment retry rejects missing permissions and switched or disabled accounts', async () => {
  for (const kind of ['site', 'directory', 'disabled', 'switched']) {
    const f = fixture(); let retried = false;
    f.dependencies.assetService = { retryFailed: async () => { retried = true; } };
    f.service = createCollectorService(f.dependencies); await f.service.state(1);
    if (kind === 'site') f.permissions.delete(site);
    if (kind === 'directory') f.root.granted = false;
    if (kind === 'disabled') f.config().accounts[accountKey].enabled = false;
    if (kind === 'switched') f.identities.set(1, { platform: 'chatgpt', accountKey: 'acct-' + 'b'.repeat(24), displayName: 'Other' });
    await assert.rejects(f.service.command({ type: 'collector:retry-images', includeInternal: true }, 1), {
      code: kind === 'site' ? 'SITE_PERMISSION_REQUIRED' : kind === 'directory' ? 'DIRECTORY_PERMISSION' : 'ACCOUNT_DISABLED',
    });
    assert.equal(retried, false);
  }
});

test('local-only capture keeps no new upload bodies and toggling attachment download is independent', async () => {
  const f = fixture(), requests = [];
  f.dependencies.assetService = { tick: async input => { requests.push(input); return { runnable: false }; } };
  f.service = createCollectorService(f.dependencies);
  await f.service.command({ type: 'collector:configure', localAssetsEnabled: false }, 1);
  await complete(f);
  assert.equal(f.root.entries.size, 1);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  assert.equal(f.calls.uploads.length, 0);
  assert.ok(requests.length > 0 && requests.every(input => input.captureEnabled === false));
  await f.service.command({ type: 'collector:configure', localAssetsEnabled: true }, 1);
  await f.service.pump();
  assert.equal(requests.at(-1).captureEnabled, true);
  assert.equal(f.config().github.enabled, false);
});

test('text-only GitHub backup never prepares or acknowledges LFS uploads', async () => {
  const f = fixture({ github: { enabled: true, lfsEnabled: false, repository: 'owner/repo', token: 'token' } });
  f.dependencies.assetService = { tick: async () => ({ runnable: false }),
    prepareUploads: async () => { throw new Error('must not upload attachments'); },
    acknowledgeUploads: async () => { throw new Error('must not discard attachment checkpoint'); } };
  f.service = createCollectorService(f.dependencies);
  await complete(f);
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.calls.uploads[0].assetPointers, undefined);
  assert.equal((await f.service.state(1)).githubStatus.status, 'synced');
});

test('manual backup rebuilds a bounded local queue and finishes without enabling automatic uploads', async () => {
  const f = fixture({ ids: ['one', 'two', 'three'], github: { repository: 'owner/repo', token: 'token', enabled: false } });
  await complete(f);
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  const before = { lists: f.calls.lists, details: f.calls.details };
  f.tabs.length = 0; f.permissions.delete(site);
  await f.service.command({ type: 'collector:retry-github' });
  assert.equal(f.calls.uploads[0].bundles.length, 2);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).manual, true);
  await f.service.pump();
  assert.equal(f.calls.uploads.length, 2);
  assert.equal(f.calls.uploads[1].bundles.length, 1);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).manual, false);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).status, 'synced');
  assert.equal(f.config().github.enabled, false);
  assert.deepEqual({ lists: f.calls.lists, details: f.calls.details }, before);
  await f.service.pump(); assert.equal(f.calls.uploads.length, 2);
});

test('enabling GitHub stages existing local history without rereading source conversations', async () => {
  const f = fixture({ ids: ['one', 'two'], github: { repository: 'owner/repo', token: 'token', enabled: false } });
  await complete(f);
  const details = f.calls.details;
  await f.service.command({ type: 'collector:github-config', enabled: true, lfsEnabled: false }, 1);
  await f.service.pump();
  assert.equal(f.calls.uploads.length, 1); assert.equal(f.calls.uploads[0].bundles.length, 2);
  assert.equal(f.calls.details, details);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).needsBackfill, false);
});

test('manual-only backup retains its intent while local queue preparation waits for retry', async () => {
  const f = fixture({ github: { repository: 'owner/repo', token: 'token', enabled: false } });
  const read = f.dependencies.readConversationArchive; let failOnce = true;
  f.dependencies.readConversationArchive = async (...args) => {
    if (failOnce) { failOnce = false; throw issue('LOCAL_PENDING'); }
    return read(...args);
  };
  f.service = createCollectorService(f.dependencies);
  await complete(f); f.tabs.length = 0;
  await f.service.command({ type: 'collector:retry-github' });
  const waiting = f.store.get(`githubStatus:${accountKey}`);
  assert.equal(waiting.backfill.status, 'waiting'); assert.equal(waiting.manual, true);
  assert.equal(f.calls.uploads.length, 0);
  await f.service.pump(); assert.equal(f.calls.uploads.length, 0);
  f.advance(60_001); await f.service.pump();
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).manual, false);
  assert.equal(f.config().github.enabled, false);
});

test('auto upload does not implicitly start remote restoration', async () => {
  const f = fixture({ config: { accounts: {} }, github: { enabled: true, autoRestore: false, repository: 'owner/repo', token: 'token' } });
  let started = 0, restored = 0;
  f.dependencies.restoreService = { state: async () => ({ status: 'idle' }), start: async () => { started++; }, tick: async () => { restored++; } };
  f.service = createCollectorService(f.dependencies);
  await f.service.pump();
  assert.equal(started, 0); assert.equal(restored, 0);
});

test('manual local repair works without a source login and keeps automatic attachment download disabled', async () => {
  const f = fixture({ config: { localAssetsEnabled: false } }), calls = [];
  f.tabs.length = 0; f.permissions.delete(site);
  f.dependencies.maintenanceService = {
    start: async input => { calls.push(['start', input.account.accountKey]); },
    tick: async input => { calls.push(['tick', input.account.accountKey]); return { runnable: false }; },
    state: async () => ({ status: 'idle' }),
  };
  f.dependencies.assetService = { requestMissing: async input => { calls.push(['missing', input.account.accountKey]); } };
  f.service = createCollectorService(f.dependencies);
  await f.service.command({ type: 'collector:repair-local' });
  await f.service.pump();
  assert.deepEqual(calls, [['start', accountKey], ['missing', accountKey], ['tick', accountKey]]);
  assert.equal(f.config().localAssetsEnabled, false);
});

test('source rate limit gates manual attachment work with a separate network condition', async () => {
  const f = fixture(), requests = [];
  f.dependencies.adapter.detail = async () => { throw Object.assign(issue('HTTP_429'), { retryAfterMs: 600_000 }); };
  f.dependencies.assetService = { tick: async input => { requests.push(input); return { runnable: false }; } };
  f.service = createCollectorService(f.dependencies);
  await f.service.pump(); await f.service.pump(); await f.service.pump();
  assert.equal(requests.at(-1).captureEnabled, true);
  assert.equal(requests.at(-1).networkAllowed, false);
});

test('pause cancels the active source request before waiting for its account lock', async () => {
  const f = fixture(), began = deferred(), blocked = deferred(); let cancelled = 0;
  f.dependencies.adapter.detail = async () => { began.resolve(); await blocked.promise; throw issue('COLLECTION_PAUSED'); };
  f.dependencies.adapter.cancel = (tabId, request) => {
    assert.equal(tabId, 1); assert.equal(request.accountKey, accountKey); cancelled++; blocked.resolve();
  };
  await f.service.pump(); await f.service.pump();
  const running = f.service.pump(); await began.promise;
  await f.service.command({ type: 'collector:pause' }, 1); await running;
  assert.equal(cancelled, 1); assert.equal(f.calls.saves.length, 0);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
});

test('stop cancels the actual worker tab, survives restart and suppresses scheduled capture until a new start', { timeout: 5000 }, async () => {
  const f = fixture(), began = deferred(), aborted = deferred(), assets = [];
  const original = f.dependencies.adapter.detail;
  f.dependencies.adapter.detail = async () => { began.resolve(); await aborted.promise; throw issue('COLLECTION_PAUSED'); };
  const cancelled = [];
  f.dependencies.adapter.cancel = async (tabId, input) => {
    assert.equal(input.accountKey, accountKey); cancelled.push(tabId); aborted.resolve();
  };
  f.dependencies.assetService = { tick: async input => { assets.push(input); return { runnable: false }; } };
  f.service = createCollectorService(f.dependencies);
  await f.service.pump(); await f.service.pump();
  const old = await f.service.engine.getState(accountKey);
  const running = f.service.pump(); await began.promise;
  // A panel in another tab must cancel the tab actually executing this job.
  await f.service.command({ type: 'collector:stop', accountKey }, 999); await running;
  assert.ok(cancelled.includes(1)); assert.equal(f.calls.saves.length, 0);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'stopped');
  const lists = f.calls.lists; f.advance(2 * 60 * 60_000);
  f.service = createCollectorService(f.dependencies);
  await f.service.pump(); await f.service.pump();
  assert.equal(f.calls.lists, lists); assert.equal(assets.at(-1).manualOnly, true);
  assert.equal((await f.service.state(1)).nextRunAt, null);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'stopped');
  f.dependencies.adapter.detail = original;
  await f.service.command({ type: 'collector:start', mode: 'incremental' }, 1);
  const next = await f.service.engine.getState(accountKey);
  assert.notEqual(next.id, old.id); assert.equal(next.phase, 'list');
  assert.equal((await complete(f)).status, 'completed');
});

test('stop waits for an already started archive commit and retains its backup receipt', { timeout: 5000 }, async () => {
  const gate = deferred(), began = deferred();
  const f = fixture({ config: { autoEnabled: false }, github: { enabled: true } });
  const original = f.dependencies.saveConversation;
  f.dependencies.saveConversation = async input => { began.resolve(); await gate.promise; return original(input); };
  f.service = createCollectorService(f.dependencies);
  await f.service.command({ type: 'collector:start' }, 1); await f.service.pump();
  const running = f.service.pump(); await began.promise;
  let done = false;
  const stopping = f.service.command({ type: 'collector:stop', accountKey }, 1).then(() => { done = true; });
  await turn(); assert.equal(done, false);
  await assert.rejects(f.service.command({ type: 'collector:start' }, 1), { code: 'BUSY' });
  gate.resolve(); await running; await stopping;
  assert.equal(f.root.entries.size, 1); assert.equal(f.calls.saves.length, 1);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'stopped');
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
});

const sourceInterruptions = [
  { name: 'tab closure', code: 'SOURCE_UNAVAILABLE',
    interrupt: async f => { f.tabs.splice(0); await f.service.tabGone(1); },
    recover: async f => { f.tabs.push({ id: 1, url: 'https://chatgpt.com/', active: true }); } },
  { name: 'permission revocation', code: 'SITE_PERMISSION_DENIED',
    interrupt: async f => { f.permissions.delete(site); await f.service.initialize(); },
    recover: async f => { f.permissions.add(site); await f.service.initialize(); } },
  { name: 'expired login', code: 'HTTP_401',
    interrupt: async f => {
      f.identities.delete(1);
      await assert.rejects(f.service.identify(f.tabs[0], true), error => error.code === 'HTTP_401');
    },
    recover: async f => { f.identities.set(1, { platform: 'chatgpt', accountKey, displayName: 'Demo' }); } },
];

for (const interruption of sourceInterruptions) {
  test(`${interruption.name} cancels an active read and automatically resumes after source recovery`, { timeout: 5000 }, async () => {
    const f = fixture(), began = deferred(), aborted = deferred(); let cancelled = 0;
    const original = f.dependencies.adapter.detail;
    f.dependencies.adapter.detail = async () => { began.resolve(); await aborted.promise; throw issue('COLLECTION_PAUSED'); };
    f.dependencies.adapter.cancel = (tabId, request) => {
      assert.equal(tabId, 1); assert.equal(request.accountKey, accountKey); cancelled++; aborted.resolve();
    };
    await f.service.pump(); await f.service.pump();
    const running = f.service.pump(); await began.promise;
    await interruption.interrupt(f); await running;
    const job = await f.service.engine.getState(accountKey);
    assert.equal(cancelled, 1); assert.equal(job.status, 'blocked');
    assert.equal(job.error.code, interruption.code); assert.equal(job.failed, 0);
    assert.equal(job.diagnostics.items[0].attempt, 0); assert.equal(f.calls.saves.length, 0);
    f.dependencies.adapter.detail = original;
    await interruption.recover(f);
    assert.equal((await complete(f)).status, 'completed');
    assert.equal(f.calls.details, 1); assert.equal(f.calls.saves.length, 1);
  });

  test(`${interruption.name} preserves an explicit user pause after source recovery`, async () => {
    const f = fixture();
    await f.service.pump(); await f.service.pump();
    await f.service.command({ type: 'collector:pause' }, 1);
    await interruption.interrupt(f);
    assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
    await interruption.recover(f); await f.service.pump();
    assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
    assert.equal(f.calls.details, 0); assert.equal(f.calls.saves.length, 0);
  });
}

test('a user pause racing with tab interruption remains paused after reopening', { timeout: 5000 }, async () => {
  const f = fixture(), began = deferred(), aborted = deferred(); let userPause;
  const original = f.dependencies.adapter.detail;
  f.dependencies.adapter.detail = async () => { began.resolve(); await aborted.promise; throw issue('COLLECTION_PAUSED'); };
  f.dependencies.adapter.cancel = () => {
    // The source event already observed running, but a user pause arrives before
    // the canceled reader releases the account lock.
    userPause = f.service.engine.pause(accountKey); aborted.resolve();
  };
  await f.service.pump(); await f.service.pump();
  const running = f.service.pump(); await began.promise;
  f.tabs.splice(0); await f.service.tabGone(1); await running; await userPause;
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
  f.dependencies.adapter.detail = original;
  f.tabs.push({ id: 1, url: 'https://chatgpt.com/', active: true }); await f.service.pump();
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
  assert.equal(f.calls.saves.length, 0);
});

test('a slow account does not block another account from advancing its collection', async () => {
  const otherKey = 'acct-' + 'b'.repeat(24), f = fixture(), began = deferred(), release = deferred();
  f.config().accounts[otherKey] = { ...account, accountKey: otherKey, storageKey: otherKey };
  f.tabs.push({ id: 2, url: 'https://chatgpt.com/c/other', active: false });
  f.identities.set(2, { platform: 'chatgpt', accountKey: otherKey });
  const original = f.dependencies.adapter.detail;
  let otherDetails = 0;
  f.dependencies.adapter.detail = async (id, request) => {
    if (id === 1) { began.resolve(); await release.promise; }
    else { otherDetails++; throw issue('HTTP_404'); }
    return original(id, request);
  };
  await f.service.pump(); await f.service.pump();
  const running = f.service.pump(); await began.promise;
  for (let n = 0; n < 20 && !otherDetails; n++) await turn();
  assert.equal(otherDetails, 1);
  release.resolve(); await running;
});

test('unfinished asset writes block directory replacement even without an archive journal or bound owner', async () => {
  const f = fixture(), candidate = directory('replacement');
  const journal = { schemaVersion: 1, accountKey: 'unbound-restored-account', directory: f.root, phase: 'writing', path: 'pending-image' };
  f.store.set('assetWrite:synthetic-hash', journal);
  f.store.set('directoryCandidate', candidate);
  const config = structuredClone(f.store.get('collectorConfigV2'));
  await assert.rejects(f.service.command({ type: 'collector:directory-changed' }, 1), { code: 'DIRECTORY_PENDING' });
  assert.equal(f.store.get('directory'), f.root);
  assert.equal(f.store.get('directoryCandidate'), null);
  assert.deepEqual(f.store.get('collectorConfigV2'), config);
  assert.equal(f.store.get('assetWrite:synthetic-hash'), journal);
  // Completing the original write permits a newly selected switch.
  f.store.set('assetWrite:synthetic-hash', null);
  f.store.set('directoryCandidate', candidate);
  await f.service.command({ type: 'collector:directory-changed' }, 1);
  assert.equal(f.store.get('directory'), candidate);
});

test('directory replacement checks verified-but-not-cleared journals and fails closed on storage errors', async () => {
  const f = fixture();
  f.store.set('directoryCandidate', directory('replacement'));
  f.store.set('assetWrite:verified', { directory: directory('original'), phase: 'verified' });
  await assert.rejects(f.service.command({ type: 'collector:directory-changed' }, 1), { code: 'DIRECTORY_PENDING' });
  f.store.delete('assetWrite:verified');
  f.store.set('directoryCandidate', directory('replacement')); // Explicitly select again after refusal.
  f.dependencies.getSettingsByPrefix = async () => { throw issue('STORAGE'); };
  f.service = createCollectorService(f.dependencies);
  await assert.rejects(f.service.command({ type: 'collector:directory-changed' }, 1), { code: 'STORAGE' });
  assert.equal(f.store.get('directory'), f.root);
});

test('journals belonging to another directory do not block a clean directory switch', async () => {
  const f = fixture(), candidate = directory('replacement');
  f.store.set('assetWrite:other', { directory: directory('unrelated'), phase: 'writing' });
  f.store.set('directoryCandidate', candidate);
  await f.service.command({ type: 'collector:directory-changed' }, 1);
  assert.equal(f.store.get('directory'), candidate);
});


test('idle panel, floating entry and alarms reuse identity across thirty minutes', async () => {
  const f = fixture({ config: { autoEnabled: false } });
  let checks = 0; const identify = f.dependencies.adapter.identify;
  f.dependencies.adapter.identify = async (...args) => { checks++; return identify(...args); };
  await f.service.state(1);
  for (let minute = 0; minute < 30; minute++) {
    f.advance(60000);
    const state = await f.service.state(1);
    assert.equal(state.identityChecking, false); assert.equal(state.identity.accountKey, accountKey);
    await f.service.contentState(1); await f.service.pump();
  }
  assert.equal(checks, 1); assert.equal(f.calls.lists, 0); assert.equal(f.calls.details, 0);
});

test('scheduled collection verifies identity when due, not on intervening idle alarms', async () => {
  const f = fixture({ config: { accounts: { [accountKey]: { ...account, nextRunAt: 2_000_000_120_000 } } } });
  let checks = 0; const identify = f.dependencies.adapter.identify;
  f.dependencies.adapter.identify = async (...args) => { checks++; return identify(...args); };
  await f.service.state(1); f.advance(60000); await f.service.pump();
  assert.equal(checks, 1); assert.equal(await f.service.engine.getState(accountKey), null);
  f.advance(60000); await f.service.pump();
  assert.ok(checks > 1); assert.equal((await f.service.engine.getState(accountKey)).status, 'running');
});

test('idle failed identity does not retry on every UI poll and explicit refresh recovers', async () => {
  const f = fixture({ config: { autoEnabled: false } });
  let checks = 0; const identify = f.dependencies.adapter.identify;
  f.dependencies.adapter.identify = async (...args) => { checks++; return identify(...args); };
  const identity = f.identities.get(1); f.identities.delete(1);
  assert.equal((await f.service.state(1)).error.code, 'HTTP_401');
  for (let n = 0; n < 10; n++) { f.advance(3000); await f.service.state(1); await f.service.contentState(1); }
  assert.equal(checks, 1);
  f.identities.set(1, identity);
  const recovered = await f.service.state(1, { refreshIdentity: true });
  assert.equal(recovered.identity.accountKey, accountKey); assert.equal(checks, 2);
});

test('manual collection rejects an unbound account even while the idle UI has the old identity', async () => {
  const f = fixture({ config: { autoEnabled: false } }); await f.service.state(1);
  f.identities.set(1, { platform: 'chatgpt', accountKey: 'acct-new', displayName: 'Other' });
  assert.equal((await f.service.state(1)).identity.accountKey, accountKey);
  await assert.rejects(f.service.command({ type: 'collector:start', mode: 'incremental' }, 1), { code: 'SETUP_INCOMPLETE' });
  assert.equal(f.calls.lists, 0); assert.equal(f.calls.saves.length, 0);
});

test('identity switching after detail still prevents writes with a warm service cache', async () => {
  const f = fixture(); const detail = f.dependencies.adapter.detail;
  f.dependencies.adapter.detail = async (...args) => {
    const result = await detail(...args);
    f.identities.set(1, { platform: 'chatgpt', accountKey: 'acct-new' });
    return result;
  };
  await f.service.pump(); await f.service.pump(); await f.service.pump();
  assert.equal(f.calls.details, 1); assert.equal(f.calls.saves.length, 0);
  assert.equal((await f.service.engine.getState(accountKey)).status, 'paused');
  assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
});


test('paused and stopped jobs do not trigger identity polling from idle alarms', async () => {
  for (const status of ['paused', 'stopped']) {
    const f = fixture(); await f.service.pump();
    if (status === 'paused') await f.service.engine.pause(accountKey);
    else await f.service.engine.stop(accountKey);
    let checks = 0; const identify = f.dependencies.adapter.identify;
    f.dependencies.adapter.identify = async (...args) => { checks++; return identify(...args); };
    for (let n = 0; n < 3; n++) { f.advance(60000); await f.service.pump(); await f.service.state(1); }
    assert.equal(checks, 0); assert.equal((await f.service.engine.getState(accountKey)).status, status);
  }
});

test('diagnostic read export and clear work offline without account probing and isolate selected accounts', async () => {
  const f = fixture();
  f.store.set(`activity:v1:${accountKey}:collection`, { current: null, recent: [{ stage: 'detail', status: 'failed', code: 'HTTP_403', title: 'PRIVATE', finishedAt: 2_000_000_000_000 }] });
  f.store.set('activity:v1:other:collection', { recent: [{ title: 'unrelated' }] });
  f.dependencies.adapter.identify = async () => { throw new Error('diagnostics must not identify'); };
  f.tabs.length = 0; f.permissions.clear();
  const result = await f.service.command({ type: 'collector:diagnostics', accountKey });
  assert.equal(result.diagnostics.channels.collection.history.length, 1);
  const exported = await f.service.command({ type: 'collector:export-diagnostics', accountKey });
  assert.doesNotMatch(JSON.stringify(exported.report), /PRIVATE|unrelated/);
  await assert.rejects(f.service.command({ type: 'collector:diagnostics', accountKey: 'other' }), { code: 'ACCOUNT_DISABLED' });
  await f.service.command({ type: 'collector:clear-diagnostics', accountKey });
  assert.equal((await f.service.command({ type: 'collector:diagnostics', accountKey })).diagnostics.channels.collection.history.length, 0);
  assert.equal(f.store.get('activity:v1:other:collection').recent.length, 1);
  assert.equal(f.calls.lists, 0); assert.equal(f.calls.saves.length, 0);
});


test('full capture confirmation is checked against freshly identified account before starting a job', async () => {
  const f = fixture(), otherKey = 'acct-' + 'b'.repeat(24);
  await f.service.state(1);
  f.store.set('collectorConfigV2', { ...f.config(), accounts: { ...f.config().accounts,
    [otherKey]: { ...account, accountKey: otherKey, storageKey: otherKey } } });
  f.identities.set(1, { platform: 'chatgpt', accountKey: otherKey, displayName: 'Other' });
  await assert.rejects(f.service.command({ type: 'collector:start', mode: 'full', expectedAccountKey: accountKey }, 1), { code: 'ACCOUNT_CHANGED' });
  assert.equal(await f.service.engine.getState(otherKey), null);
  assert.equal(f.calls.lists, 0); assert.equal(f.calls.saves.length, 0);
  await f.service.command({ type: 'collector:start', mode: 'full', expectedAccountKey: otherKey }, 1);
  assert.equal((await f.service.engine.getState(otherKey)).mode, 'full');
});
