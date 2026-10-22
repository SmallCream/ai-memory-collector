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

test('stale identity checks do not block progress reads and are labelled until the new account is confirmed', async () => {
  const f = fixture(); await f.service.state(1); f.advance(11000);
  const gate = deferred(); let checks = 0;
  const changed = { platform: 'chatgpt', accountKey: 'acct-new', displayName: 'Other account' };
  f.dependencies.adapter.identify = async () => { checks++; await gate.promise; return changed; };
  const pending = await f.service.state(1);
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
  const f = fixture({ config: { accounts: {} }, github: { repository: 'owner/data', token: 'secret', enabled: true } });
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

test('pending LFS work retains text outbox and only commits after upload preparation', async () => {
  const f = fixture({ github: { repository: 'owner/data', token: 'secret', enabled: true } });
  let prepared = false, acknowledged = 0;
  f.dependencies.assetService = {
    tick: async () => ({ pending: 0 }),
    prepareUploads: async () => { if (!prepared) throw issue('LFS_UPLOAD_PENDING'); return [{ path: 'verified-pointer' }]; },
    acknowledgeUploads: async () => { acknowledged++; },
  };
  f.service = createCollectorService(f.dependencies);
  await complete(f);
  assert.equal(f.calls.uploads.length, 0); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  assert.equal(f.store.get(`githubStatus:${accountKey}`).nextRetryAt, 0);
  prepared = true; await f.service.pump();
  assert.equal(f.calls.uploads.length, 1); assert.equal(f.calls.uploads[0].assetPointers[0].path, 'verified-pointer');
  assert.equal(acknowledged, 1); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
});

test('GitHub retry replaces stale LFS progress with its failure and preserves backoff and delivery checkpoints', async () => {
  const options = { config: { autoEnabled: false }, syncError: 'GITHUB_NETWORK',
    github: { repository: 'owner/data', token: 'secret', enabled: true } };
  const f = fixture(options), key = `githubStatus:${accountKey}`, running = [];
  let prepared = false, acknowledged = 0;
  f.dependencies.assetService = {
    tick: async () => ({ runnable: false }),
    prepareUploads: async () => {
      running.push(structuredClone(f.store.get(key)));
      if (!prepared) throw issue('LFS_UPLOAD_PENDING');
      return [];
    },
    acknowledgeUploads: async () => { acknowledged++; },
  };
  f.service = createCollectorService(f.dependencies);
  await f.service.engine.enqueueArchive({ account, archive: f.saved(f.root, 'one') });
  f.store.set(key, { status: 'pending', pending: 1, message: 'old upload progress',
    error: { code: 'GITHUB_PERMISSION', message: 'old failure' }, attempt: 4,
    nextRetryAt: f.now() + 30 * 60000, lastSyncedAt: 1000, commitSha: 'old-commit' });

  await f.service.pump();
  assert.equal(running.length, 0);
  assert.equal(f.store.get(key).error.code, 'GITHUB_PERMISSION');
  await f.service.command({ type: 'collector:retry-github' }, 1);
  const uploading = f.store.get(key);
  assert.equal(uploading.status, 'pending'); assert.equal(uploading.error, null);
  assert.match(uploading.message, /分批上传/); assert.equal(uploading.nextRetryAt, 0);
  assert.equal(uploading.attempt, 4); assert.equal(uploading.commitSha, 'old-commit');
  assert.equal(acknowledged, 0); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);

  prepared = true;
  await assert.rejects(f.service.command({ type: 'collector:retry-github' }, 1), error => error.code === 'GITHUB_NETWORK');
  const failed = structuredClone(f.store.get(key));
  assert.equal(failed.status, 'pending'); assert.equal(failed.message, '');
  assert.equal(failed.error.code, 'GITHUB_NETWORK'); assert.equal(failed.attempt, 5);
  assert.equal(failed.nextRetryAt, f.now() + 32 * 60000);
  assert.equal(failed.lastSyncedAt, 1000); assert.equal(failed.commitSha, 'old-commit');
  assert.equal(acknowledged, 0); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 1);
  await f.service.pump();
  assert.deepEqual(f.store.get(key), failed); assert.equal(running.length, 2);

  options.syncError = null;
  await f.service.command({ type: 'collector:retry-github' }, 1);
  for (const state of running) {
    assert.equal(state.status, 'syncing'); assert.equal(state.error, null);
    assert.equal(state.message, ''); assert.equal(state.nextRetryAt, 0);
  }
  assert.equal(acknowledged, 1); assert.equal((await f.service.engine.getOutbox(accountKey)).length, 0);
  assert.equal(f.store.get(key).status, 'synced'); assert.equal(f.store.get(key).error, undefined);
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
