import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRestoreService, RESTORE_SETTING_KEY } from '../extension/lib/restore-service.js';
import { createActivityLog } from '../extension/lib/activity-log.js';

const config = { repository: 'example/private-data', branch: 'main', token: 'never-persist-this-token' };
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(storageKey = 'demo-a', accountKey = 'acct-a', ids = ['one']) {
  const prefix = `data/web/chatgpt/${storageKey}`;
  const account = { schemaVersion: 1, platform: 'chatgpt', accountKey, storageKey, alias: storageKey,
    displayName: storageKey, dataPath: prefix, purpose: 'conversation-archive' };
  const files = new Map();
  const manifest = { schemaVersion: 1, platform: 'chatgpt', accountKey, conversations: {} };
  for (const id of ids) {
    const jsonPath = `${prefix}/conversations/2026/10/2026-10-21T00-00-00Z__Demo__${id}.json`;
    const text = JSON.stringify({ conversation_id: id, title: 'Demo', mapping: {} });
    const md = `# Demo\n\n${id}\n`;
    manifest.conversations[id] = { conversationId: id, jsonPath, markdownPath: jsonPath.replace(/\.json$/, '.md'),
      contentHash: hash(text), markdownHash: hash(md), sourceUpdatedAt: '2026-10-21T00:00:00Z', sourceCompleteness: 'complete',
      assets: [{ localPath: `${prefix}/attachments/${id}.png`, oid: 'a'.repeat(64), size: 3 }] };
    files.set(jsonPath, text); files.set(jsonPath.replace(/\.json$/, '.md'), md);
  }
  files.set(`${prefix}/account.json`, JSON.stringify(account));
  files.set(`${prefix}/archive/manifest.json`, JSON.stringify(manifest));
  return { prefix, account, manifest, files };
}
function setup(fixtures = [fixture()]) {
  const files = new Map(fixtures.flatMap(value => [...value.files]));
  const entry = ([path, text]) => ({ path, size: Buffer.byteLength(text), type: 'blob', mode: '100644',
    sha: createHash('sha1').update(text).digest('hex') });
  let snapshot = { repository: config.repository, branch: config.branch, commitSha: '1'.repeat(40), treeSha: '2'.repeat(40),
    entries: [...files].map(entry), empty: false };
  const contentBySha = new Map([...files].map(value => [entry(value).sha, value[1]]));
  const settings = new Map(), calls = [], downloads = [], hydration = [], localFiles = new Map(), localReads = [];
  const rootId = {}, directory = { kind: 'directory', queryPermission: async () => 'granted', rootId,
    isSameEntry: async other => other?.rootId === rootId };
  const clone = value => value == null ? value : { ...structuredClone({ ...value, directory: null }), directory: value.directory };
  let clock = 1000, failure = null, hydrate = async () => ({ pending: false }), local = null, fetchCount = 0;
  const dependencies = {
    getSetting: async key => clone(settings.get(key)),
    setSetting: async (key, value) => settings.set(key, clone(value)),
    fetchRepositorySnapshot: async () => { fetchCount++; return structuredClone(snapshot); },
    downloadRepositoryFile: async ({ entry: item }) => {
      downloads.push(item.path);
      if (failure?.(item)) throw Object.assign(new Error('network with private detail'), { code: 'NETWORK' });
      return new TextEncoder().encode(contentBySha.get(item.sha));
    },
    applyRemoteFiles: async input => {
      calls.push(input);
      const native = JSON.parse(input.files[0].content);
      const manifest = JSON.parse(input.files.find(file => file.path.endsWith('/archive/manifest.json')).content);
      return { status: 'added', entry: manifest.conversations[native.conversation_id] };
    },
    readLocalManifest: async () => local,
    readLocalFile: async (directory, path) => {
      localReads.push(path);
      const content = localFiles.get(path);
      return content == null ? null : typeof content === 'string' ? new TextEncoder().encode(content) : content;
    },
    hydrateAssets: async input => { hydration.push(input); return hydrate(input); },
    now: () => clock,
  };
  const service = createRestoreService(dependencies);
  return { service, dependencies, settings, directory, calls, hydration, downloads, fixtures, localReads,
    start: options => service.start({ config, directory, ...options }),
    tick: options => service.tick({ config, directory, ...options }),
    restart: () => createRestoreService(dependencies),
    time: value => { clock = value; }, fail: value => { failure = value; },
    hydrate: value => { hydrate = value; }, local: value => { local = value; },
    localFile: (path, content) => { if (content == null) localFiles.delete(path); else localFiles.set(path, content); },
    snapshot: value => { snapshot = value; }, fetchCount: () => fetchCount,
    replaceFile: (path, text) => {
      const next = entry([path, text]); contentBySha.set(next.sha, text);
      snapshot.entries = snapshot.entries.map(item => item.path === path ? next : item);
    },
  };
}

test('restores multiple accounts without website login or enabling capture; one conversation per tick', async () => {
  const env = setup([fixture('demo-a', 'acct-a', ['one', 'two']), fixture('demo-b', 'acct-b', ['three'])]);
  assert.equal((await env.start()).phase, 'metadata');
  await env.tick(); await env.tick();
  assert.equal(env.calls.length, 0);
  assert.equal((await env.service.state()).total, 3);
  await env.tick(); assert.equal(env.calls.length, 1);
  await env.tick(); assert.equal(env.calls.length, 2);
  const state = await env.tick();
  assert.equal(state.status, 'completed'); assert.equal(state.restored, 3);
  assert.deepEqual(env.calls.map(value => value.account.accountKey), ['acct-a', 'acct-a', 'acct-b']);
  assert.ok(env.calls.every(value => value.account.enabled === undefined));
  assert.ok(env.calls.every(value => value.files.length === 4));
  assert.deepEqual([...env.settings.keys()].sort(), ['activity:v1:repository:restore', RESTORE_SETTING_KEY].sort());
  assert.ok(!JSON.stringify(env.settings.get(RESTORE_SETTING_KEY), (key, value) => key === 'directory' ? null : value).includes(config.token));
});

test('restore file downloads and local writes expose real running activity without blocking status reads', async () => {
  const env = setup(); await env.start(); await env.tick();
  const original = env.dependencies.downloadRepositoryFile;
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { began = resolve; });
  env.dependencies.downloadRepositoryFile = async input => { began(); await gate; return original(input); };
  const service = env.restart(), running = service.tick({ config, directory: env.directory });
  await entered;
  const log = createActivityLog(env.dependencies);
  const snapshot = await log.read('repository', 'restore');
  assert.equal(snapshot.current.stage, 'restore-file'); assert.equal(snapshot.current.status, 'running');
  assert.match(snapshot.current.fileName, /\.json$/);
  assert.equal((await service.state()).processed, 0);
  assert.ok(!JSON.stringify(snapshot).includes(config.token));
  release(); await running;
  const finished = await log.read('repository', 'restore');
  assert.ok(finished.recent.some(item => item.stage === 'restore-save' && item.status === 'success'));
});

test('worker restart resumes the fixed snapshot and does not refetch moving branch', async () => {
  const env = setup(); await env.start(); await env.tick();
  const restored = env.restart();
  env.replaceFile(env.fixtures[0].manifest.conversations.one.jsonPath, JSON.stringify({ conversation_id: 'wrong-new-branch' }));
  const state = await restored.tick({ config, directory: env.directory });
  assert.equal(state.status, 'completed'); assert.equal(env.fetchCount(), 1);
  assert.equal(JSON.parse(env.calls[0].files[0].content).conversation_id, 'one');
  assert.equal(env.hydration[0].snapshot.commitSha, '1'.repeat(40));
});

test('restarting completed same-commit restore reconciles missing managed assets again', async () => {
  const env = setup(); await env.start(); await env.tick(); await env.tick();
  env.dependencies.applyRemoteFiles = async () => { throw new Error('unused dependency replacement'); };
  await env.start(); await env.tick(); await env.tick();
  assert.equal(env.hydration.length, 2); assert.equal(env.fetchCount(), 2);
});

test('asset work remains checkpointed and bounded across restarts', async () => {
  const env = setup(); let count = 0;
  env.hydrate(async () => ({ pending: ++count < 3, downloaded: 2 }));
  await env.start(); await env.tick();
  const first = await env.tick();
  assert.equal(first.status, 'running'); assert.equal(env.calls.length, 1);
  const resumed = env.restart();
  await resumed.tick({ config, directory: env.directory });
  const done = await resumed.tick({ config, directory: env.directory });
  assert.equal(done.status, 'completed'); assert.equal(env.calls.length, 1); assert.equal(count, 3);
});

test('one failed conversation retries independently while other conversations progress', async () => {
  const env = setup([fixture('demo-a', 'acct-a', ['one', 'two'])]);
  env.fail(item => item.path.endsWith('__one.json'));
  await env.start(); await env.tick();
  let state = await env.tick(); assert.equal(state.failed, 1);
  state = await env.tick(); assert.equal(state.restored, 1); assert.equal(env.calls.length, 1);
  env.fail(null); env.time(61_001);
  state = await env.tick(); assert.equal(state.status, 'completed'); assert.equal(state.restored, 2);
});

test('asset failure retries only hydration rather than reapplying conversation files', async () => {
  const env = setup(); let attempt = 0;
  env.hydrate(async () => ({ failed: ++attempt === 1 ? 1 : 0, pending: false }));
  await env.start(); await env.tick();
  assert.equal((await env.tick()).failed, 1);
  env.time(61_001);
  assert.equal((await env.tick()).status, 'completed'); assert.equal(env.calls.length, 1);
});

test('local newer source is preserved but its snapshot-compatible assets can be hydrated', async () => {
  const env = setup(); const local = structuredClone(env.fixtures[0].manifest);
  local.conversations.one.contentHash = 'b'.repeat(64);
  local.conversations.one.sourceUpdatedAt = '2026-10-22T00:00:00Z';
  env.local(local);
  await env.start(); await env.tick(); const state = await env.tick();
  assert.equal(state.status, 'partial'); assert.equal(state.skipped, 1); assert.equal(env.calls.length, 0);
  assert.equal(state.issues[0].code, 'STALE_DETAIL');
  assert.equal(env.hydration[0].entry.contentHash, 'b'.repeat(64));
  assert.equal(env.hydration[0].remoteEntry.contentHash, env.fixtures[0].manifest.conversations.one.contentHash);
});

test('unknown or equal source times never silently overwrite differing local source', async () => {
  for (const time of [null, '2026-10-21T00:00:00Z']) {
    const env = setup(); const local = structuredClone(env.fixtures[0].manifest);
    local.conversations.one.contentHash = 'b'.repeat(64); local.conversations.one.sourceUpdatedAt = time;
    env.local(local); await env.start(); await env.tick();
    assert.equal((await env.tick()).issues[0].code, 'RESTORE_VERSION_UNCERTAIN'); assert.equal(env.calls.length, 0);
  }
});

test('manual file conflicts are skipped without asset or second file writes', async () => {
  const env = setup();
  const service = createRestoreService({ ...env.dependencies,
    applyRemoteFiles: async () => { throw Object.assign(new Error('private content'), { code: 'LOCAL_CONFLICT' }); } });
  await service.start({ config, directory: env.directory }); await service.tick({ config, directory: env.directory });
  const state = await service.tick({ config, directory: env.directory });
  assert.equal(state.status, 'partial'); assert.equal(state.skipped, 1); assert.equal(env.hydration.length, 0);
  assert.ok(!JSON.stringify(state).includes('private content'));
});

test('changed directory blocks old checkpoints; explicit force starts independent restore', async () => {
  const env = setup(); await env.start(); await env.tick();
  const other = { kind: 'directory', queryPermission: async () => 'granted', rootId: {} };
  assert.equal((await env.tick({ directory: other })).error.code, 'DIRECTORY_CHANGED');
  assert.equal(env.calls.length, 0);
  await assert.rejects(env.start({ directory: other }), { code: 'DIRECTORY_CHANGED' });
  assert.equal((await env.start({ directory: other, force: true })).status, 'running');
  await env.tick({ directory: other });
  assert.equal((await env.tick({ directory: other })).status, 'completed');
});

test('changed repository blocks before download or write', async () => {
  const env = setup(); await env.start();
  const state = await env.tick({ config: { ...config, repository: 'example/other' } });
  assert.equal(state.status, 'blocked'); assert.equal(state.error.code, 'RESTORE_CONFIG_CHANGED');
  assert.equal(env.downloads.length, 0);
});

test('invalid account ownership is isolated and valid account can still restore', async () => {
  const a = fixture('demo-a', 'acct-a'), b = fixture('demo-b', 'acct-b');
  a.files.set(`${a.prefix}/account.json`, JSON.stringify({ ...a.account, dataPath: b.prefix }));
  const env = setup([a, b]); await env.start(); await env.tick(); await env.tick();
  const state = await env.tick();
  assert.equal(state.status, 'partial'); assert.equal(state.failed, 1); assert.equal(state.restored, 1);
  assert.equal(env.calls[0].account.accountKey, 'acct-b');
});

test('missing conversation files are reported without writing; unrelated repository files are ignored', async () => {
  const f = fixture(); f.files.delete(f.manifest.conversations.one.markdownPath);
  f.files.set('README.md', 'not an archive');
  const env = setup([f]); await env.start(); const state = await env.tick();
  assert.equal(state.status, 'partial'); assert.equal(state.failed, 1); assert.equal(env.calls.length, 0);
  assert.ok(!env.downloads.includes('README.md'));
});

test('malicious manifest paths and duplicate identity under another directory are rejected', async () => {
  const f = fixture(); f.manifest.conversations.one.jsonPath = 'data/web/chatgpt/demo-a/conversations/../outside__one.json';
  f.manifest.conversations.one.markdownPath = f.manifest.conversations.one.jsonPath.replace(/\.json$/, '.md');
  f.files.set(`${f.prefix}/archive/manifest.json`, JSON.stringify(f.manifest));
  const env = setup([f]); await env.start();
  assert.equal((await env.tick()).issues[0].code, 'RESTORE_METADATA');
  const duplicate = setup([fixture('demo-a', 'acct-same'), fixture('demo-b', 'acct-same')]);
  await duplicate.start(); await duplicate.tick();
  assert.equal((await duplicate.tick()).failed, 1); assert.equal(duplicate.calls.length, 0);
});

test('permission loss blocks without consuming the conversation, resumes after grant', async () => {
  const env = setup(); await env.start(); await env.tick();
  env.directory.queryPermission = async () => 'prompt';
  assert.equal((await env.tick()).error.code, 'DIRECTORY_PERMISSION'); assert.equal(env.calls.length, 0);
  env.directory.queryPermission = async () => 'granted';
  assert.equal((await env.tick()).status, 'completed');
});

test('concurrent ticks serialize and cannot restore the same conversation twice', async () => {
  const env = setup([fixture('demo-a', 'acct-a', ['one', 'two'])]); await env.start(); await env.tick();
  await Promise.all([env.tick(), env.tick()]);
  assert.equal(env.calls.length, 2); assert.equal((await env.service.state()).status, 'completed');
});

test('repeated same-snapshot restore reuses hash-verified local text but still reconciles assets', async () => {
  const env = setup(), f = env.fixtures[0], entry = f.manifest.conversations.one;
  env.local(structuredClone(f.manifest));
  for (const path of [entry.jsonPath, entry.markdownPath]) env.localFile(path, f.files.get(path));
  const service = createRestoreService({ ...env.dependencies, applyRemoteFiles: async input => {
    env.calls.push(input); return { status: 'unchanged', entry };
  } });
  for (let round = 0; round < 2; round++) {
    await service.start({ config, directory: env.directory });
    await service.tick({ config, directory: env.directory });
    const state = await service.tick({ config, directory: env.directory });
    assert.equal(state.status, 'completed'); assert.equal(state.unchanged, 1);
  }
  assert.equal(env.downloads.length, 4); // Two metadata files per run, zero conversation blobs.
  assert.ok(env.downloads.every(path => path.endsWith('/account.json') || path.endsWith('/archive/manifest.json')));
  assert.equal(env.localReads.length, 4);
  assert.equal(env.hydration.length, 2);
  assert.equal(env.calls.length, 2); // Existing write/conflict guards still run with local text.
  assert.equal(env.calls[1].files[0].content, f.files.get(entry.jsonPath));
});

test('missing managed text downloads only the absent file and retains guarded restoration', async () => {
  const env = setup(), f = env.fixtures[0], entry = f.manifest.conversations.one;
  env.local(structuredClone(f.manifest));
  env.localFile(entry.jsonPath, f.files.get(entry.jsonPath));
  await env.start(); await env.tick(); const state = await env.tick();
  assert.equal(state.status, 'completed');
  assert.ok(!env.downloads.includes(entry.jsonPath));
  assert.ok(env.downloads.includes(entry.markdownPath));
  assert.equal(env.calls.length, 1); assert.equal(env.hydration.length, 1);
});

test('manual local edit is preserved and skipped before downloading conversation data', async () => {
  const env = setup(), f = env.fixtures[0], entry = f.manifest.conversations.one;
  env.local(structuredClone(f.manifest));
  env.localFile(entry.jsonPath, f.files.get(entry.jsonPath));
  env.localFile(entry.markdownPath, '# My handwritten note\n');
  await env.start(); await env.tick(); const state = await env.tick();
  assert.equal(state.status, 'partial'); assert.equal(state.skipped, 1);
  assert.equal(state.issues[0].code, 'LOCAL_CONFLICT');
  assert.equal(env.downloads.length, 2); assert.equal(env.calls.length, 0); assert.equal(env.hydration.length, 0);
});

test('unchanged text does not hide improved remote attachment metadata', async () => {
  const env = setup(), f = env.fixtures[0], entry = f.manifest.conversations.one;
  const local = structuredClone(f.manifest);
  local.conversations.one.assets = [];
  env.local(local);
  env.localFile(entry.jsonPath, f.files.get(entry.jsonPath));
  env.localFile(entry.markdownPath, f.files.get(entry.markdownPath));
  await env.start(); await env.tick(); await env.tick();
  assert.equal(env.downloads.length, 2);
  const receivedManifest = JSON.parse(env.calls[0].files.find(file => file.path.endsWith('/archive/manifest.json')).content);
  assert.deepEqual(receivedManifest.conversations.one.assets, entry.assets);
  assert.deepEqual(env.hydration[0].entry.assets, entry.assets);
});

test('changed remote Markdown fetches new bytes while reusing identical JSON', async () => {
  const env = setup(), f = env.fixtures[0], entry = f.manifest.conversations.one;
  const local = structuredClone(f.manifest), oldMD = '# Previous renderer\n';
  local.conversations.one.markdownHash = hash(oldMD);
  env.local(local);
  env.localFile(entry.jsonPath, f.files.get(entry.jsonPath));
  env.localFile(entry.markdownPath, oldMD);
  await env.start(); await env.tick(); const state = await env.tick();
  assert.equal(state.status, 'completed');
  assert.ok(!env.downloads.includes(entry.jsonPath)); assert.ok(env.downloads.includes(entry.markdownPath));
  assert.equal(env.calls[0].files[1].content, f.files.get(entry.markdownPath));
});

test('recovered local capture survives failed outbox delivery and restart without replaying remote writes', async () => {
  const env = setup(), entry = env.fixtures[0].manifest.conversations.one;
  const recovered = { status: 'added', entry: { conversationId: 'earlier-local-capture', contentHash: 'c'.repeat(64) },
    files: [{ path: `${env.fixtures[0].prefix}/conversations/local.json`, content: 'earlier local capture' }] };
  let deliveries = 0;
  const dependencies = { ...env.dependencies,
    applyRemoteFiles: async input => { env.calls.push(input); return { status: 'added', entry, recovered }; },
    enqueueRecovered: async input => {
      deliveries++;
      const saved = env.settings.get(RESTORE_SETTING_KEY).items[0];
      assert.deepEqual(saved.pendingRecovered, recovered); // Durable before first delivery attempt.
      assert.equal(saved.phase, 'recovery');
      assert.equal(input.account.enabled, undefined); // Reading never enables a capture account.
      assert.equal(input.archive.entry.conversationId, 'earlier-local-capture');
      if (deliveries === 1) throw Object.assign(new Error('outbox unavailable'), { code: 'OUTBOX_WRITE' });
    },
  };
  const first = createRestoreService(dependencies);
  await first.start({ config, directory: env.directory }); await first.tick({ config, directory: env.directory });
  assert.equal((await first.tick({ config, directory: env.directory })).failed, 1);
  assert.equal(env.calls.length, 1); assert.equal(env.hydration.length, 0);
  const downloads = env.downloads.length;
  env.time(61_001);
  const resumed = createRestoreService(dependencies);
  const state = await resumed.tick({ config, directory: env.directory });
  assert.equal(state.status, 'completed'); assert.equal(deliveries, 2);
  assert.equal(env.calls.length, 1); assert.equal(env.downloads.length, downloads);
  assert.equal(env.hydration.length, 1);
  assert.equal(env.settings.get(RESTORE_SETTING_KEY).items[0].pendingRecovered, undefined);
});

test('missing recovery hook keeps a durable receipt across force restart until delivery becomes available', async () => {
  const env = setup(), entry = env.fixtures[0].manifest.conversations.one;
  const recovered = { status: 'added', entry: { conversationId: 'pending-local' }, files: [] };
  const dependencies = { ...env.dependencies,
    applyRemoteFiles: async input => { env.calls.push(input); return { status: 'unchanged', entry, recovered }; } };
  const service = createRestoreService(dependencies);
  await service.start({ config, directory: env.directory }); await service.tick({ config, directory: env.directory });
  const pending = await service.tick({ config, directory: env.directory });
  assert.equal(pending.issues[0].code, 'RESTORE_RECOVERY_PENDING');
  await service.start({ config, directory: env.directory, force: true });
  assert.equal(env.fetchCount(), 1); assert.deepEqual(env.settings.get(RESTORE_SETTING_KEY).items[0].pendingRecovered, recovered);
  const received = [];
  const resumed = createRestoreService({ ...dependencies, enqueueRecovered: async value => received.push(value) });
  assert.equal((await resumed.tick({ config, directory: env.directory })).status, 'completed');
  assert.equal(received.length, 1); assert.deepEqual(received[0].archive, recovered);
  assert.equal(env.calls.length, 1);
});
