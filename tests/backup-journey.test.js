import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, stat, readdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createCollectorService } from '../extension/lib/collector-service.js';
import { createCollectorEngine } from '../extension/lib/collector-engine.js';
import { createArchiveStore, readAccountManifest, hasConversationFiles } from '../extension/lib/archive-store.js';
import { createAssetService } from '../extension/lib/asset-service.js';
import { createLocalMaintenance } from '../extension/lib/local-maintenance.js';

// Real temporary files with File System Access-compatible handles. Only the
// website, browser permissions and persistent browser store are simulated.
async function fixture(t, platform = 'chatgpt') {
  const root = await mkdtemp(join(tmpdir(), 'collector-journey-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writes = [], store = new Map(), permission = new Map();
  const copy = value => value?.kind === 'directory' ? value : Array.isArray(value) ? value.map(copy) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) : value;
  const getSetting = async key => copy(store.get(key));
  const setSetting = async (key, value) => store.set(key, copy(value));
  const translate = error => { if (error.code === 'ENOENT') throw new DOMException('Missing fixture file', 'NotFoundError'); throw error; };
  function directory(path, owner = path) {
    const permitted = () => { if (permission.get(owner) === false) throw new DOMException('Denied fixture directory', 'NotAllowedError'); };
    return { kind: 'directory', name: path.split('/').at(-1), path,
      queryPermission: async () => permission.get(owner) === false ? 'prompt' : 'granted',
      isSameEntry: async other => other?.path === path,
      async getDirectoryHandle(name, { create = false } = {}) {
        permitted(); assert.ok(name && !/[\\/]/.test(name) && name !== '..'); const next = join(path, name);
        try { if (create) await mkdir(next, { recursive: true }); else assert.ok((await stat(next)).isDirectory()); }
        catch (error) { translate(error); } return directory(next, owner);
      },
      async getFileHandle(name, { create = false } = {}) {
        permitted(); assert.ok(name && !/[\\/]/.test(name) && name !== '..'); const target = join(path, name);
        try { if (create) { try { await writeFile(target, '', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; } } else await stat(target); }
        catch (error) { translate(error); }
        return { getFile: async () => { permitted(); const bytes = await readFile(target); return { size: bytes.length,
          text: async () => bytes.toString(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }; },
          createWritable: async () => { permitted(); let bytes; return {
            write: async value => { bytes = Buffer.from(value); },
            close: async () => { permitted(); await writeFile(target + '.tmp', bytes); await rename(target + '.tmp', target); writes.push(target); },
            abort: async () => {},
          }; },
        };
      },
    };
  }
  const originalPath = join(root, 'original'); await mkdir(originalPath); const original = directory(originalPath);
  const accountKey = 'acct-' + 'a'.repeat(24), identity = { platform, accountKey, displayName: 'Journey fixture' };
  const origin = platform === 'doubao' ? 'https://www.doubao.com' : 'https://chatgpt.com';
  const tabs = [{ id: 1, url: origin + '/chat/1', active: true }], origins = new Set();
  const calls = { list: 0, detail: 0, asset: 0, cloud: 0 };
  const now = () => Date.parse('2026-10-28T01:00:00Z');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');
  const detail = () => ({ identity, completeness: 'complete', capturedAt: new Date(now()).toISOString(), payload: platform === 'chatgpt' ? {
    conversation_id: '11', title: 'Journey fixture', create_time: 1792483200, update_time: 1792569600, current_node: 'reply',
    mapping: { root: { parent: null, message: null }, reply: { parent: 'root', message: { id: 'm1', author: { role: 'assistant' }, status: 'finished_successfully',
      content: { content_type: 'multimodal_text', parts: ['Offline readable answer', { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_fixture' }] } } } },
  } : {
    platform: 'doubao', sourceFormat: 'doubao-web-chain', conversation_id: '11', title: 'Journey fixture', create_time: 1792483200, update_time: 1792569600,
    conversation: { conversation_id: '11', creator_id: '10001', conversation_type: 3, name: 'Journey fixture' },
    messages: [{ conversation_id: '11', message_id: '111', index_in_conv: '1', user_type: 2, status: 0, content_status: 0, ext: { is_finish: '1' },
      content_block: [{ block_type: 10000, is_finish: true, content: { text_block: { text: 'Offline readable answer' } } },
        { is_finish: true, content: { image_block: { image_ori: { url: 'https://p-test.byteimg.com/fixture.png' } } } }] }], regen_messages: {}, has_more: false,
  } });
  const browser = { permissions: { contains: async ({ origins: requested }) => requested.every(x => origins.has(x)) },
    tabs: { get: async id => tabs.find(t => t.id === id), query: async q => tabs.filter(t => (!q.active || t.active) && (!q.url || t.url.startsWith(q.url.replace('*', '')))), sendMessage: async () => {} },
    sidePanel: { setOptions: async () => {} }, scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    alarms: { get: async () => null, create: async () => {} },
  };
  let service, assets, maintenance;
  function restart() {
    const archive = createArchiveStore({ get: getSetting, set: setSetting });
    const enqueueArchive = input => service.engine.enqueueArchive(input);
    assets = createAssetService({ getSetting, setSetting, readAccountManifest,
      saveConversation: input => service.withFileLock(() => archive.saveConversation(input)),
      resolveAsset: async () => { calls.asset++; return { bytes: png, mimeType: 'image/png', quality: 'original' }; },
      refreshConversation: async () => detail(), enqueueArchive, browser, now });
    maintenance = createLocalMaintenance({ getSetting, setSetting, readAccountManifest,
      readConversationArchive: archive.readConversationArchive,
      repairMissingMarkdown: input => service.withFileLock(() => archive.repairMissingMarkdown(input)),
      enqueueArchive, requeueMissing: input => assets.requeueMissing(input), now });
    service = createCollectorService({ browser, getSetting, setSetting,
      getSettingsByPrefix: async prefix => [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: copy(value) })),
      adapter: { identify: async () => identity, list: async () => { calls.list++; return { items: [{ id: '11', title: 'Journey fixture', updateTime: 1792569600 }], nextOffset: null, total: 1 }; },
        detail: async () => { calls.detail++; return detail(); } },
      createEngine: createCollectorEngine, readAccountManifest, hasConversationFiles, readConversationBaseline: archive.readConversationBaseline,
      readConversationArchive: archive.readConversationArchive, saveConversation: assets.save, assetService: assets, maintenanceService: maintenance,
      syncArchives: async () => { calls.cloud++; throw Error('No cloud access expected'); }, now, later: () => 1 });
  }
  restart();
  const command = (type, fields = {}) => service.command({ type, ...fields }, 1);
  const account = () => store.get('collectorConfigV2')?.accounts[accountKey];
  async function finish() {
    for (let i = 0; i < 30; i++) {
      await service.pump();
      const state = await service.state(1);
      if (state.job?.status === 'completed' && !(state.assetDiagnostics?.pending > 0)) return state;
    }
    throw Error('Journey did not finish: ' + JSON.stringify(await service.state(1)));
  }
  async function firstBackup() {
    assert.equal((await service.state(1)).error.code, 'SITE_PERMISSION_REQUIRED');
    origins.add(origin + '/*'); await command('collector:permissions-changed');
    await command('collector:bind', { alias: 'Journey fixture' });
    await assert.rejects(command('collector:configure', { setupComplete: true }), { code: 'SETUP_INCOMPLETE' });
    store.set('directoryCandidate', original); await command('collector:directory-changed');
    await command('collector:configure', { setupComplete: true, autoEnabled: false, localAssetsEnabled: true });
    await command('collector:start', { mode: 'initial' }); return finish();
  }
  async function snapshot(path) {
    const result = {};
    async function visit(current, prefix = '') { for (const item of await readdir(current, { withFileTypes: true })) {
      const key = prefix + item.name; if (item.isDirectory()) await visit(join(current, item.name), key + '/');
      else result[key] = createHash('sha256').update(await readFile(join(current, item.name))).digest('hex');
    } } await visit(path); return result;
  }
  return { root, original, directory, store, permission, calls, writes, restart, account, firstBackup, finish, command, snapshot,
    get service() { return service; }, get maintenance() { return maintenance; },
    manifest: () => readAccountManifest(store.get('directory'), account()),
    async migrate(name = 'migrated') { const path = join(root, name); await cp(original.path, path, { recursive: true });
      const target = directory(path); store.set('directoryCandidate', target); await command('collector:directory-changed'); return target; },
  };
}

for (const platform of ['chatgpt', 'doubao']) test(`${platform}: first backup, worker reload, unchanged check and directory migration preserve real files`, async t => {
  const f = await fixture(t, platform);
  const first = await f.firstBackup(); assert.equal(first.account.initialized, true); assert.equal(f.calls.detail, 1); assert.equal(f.calls.cloud, 0);
  const manifest = await f.manifest(), entry = manifest.conversations['11'];
  assert.equal(entry.assets.length, 1);
  const original = await f.snapshot(f.original.path);
  const markdown = await readFile(join(f.original.path, entry.markdownPath), 'utf8'); assert.match(markdown, /Offline readable answer/);
  for (const asset of entry.assets || []) {
    assert.equal(asset.status, 'downloaded');
    assert.equal(original[asset.localPath], asset.oid);
    const relative = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => decodeURI(match[1]));
    assert.ok(relative.some(link => resolve(dirname(join(f.original.path, entry.markdownPath)), link) === join(f.original.path, asset.localPath)));
  }
  const config = structuredClone(f.store.get('collectorConfigV2')); f.restart();
  assert.deepEqual(f.store.get('collectorConfigV2'), config); assert.equal(f.store.get('directory').path, f.original.path);
  await f.command('collector:start', { mode: 'incremental' }); const checked = await f.finish();
  assert.equal(checked.job.skipped, 1); assert.equal(f.calls.detail, 1); assert.deepEqual(await f.snapshot(f.original.path), original);
  const target = await f.migrate(); f.restart();
  await f.command('collector:start', { mode: 'incremental' }); const moved = await f.finish();
  assert.equal(moved.job.skipped, 1); assert.equal(f.calls.detail, 1);
  assert.deepEqual(await f.snapshot(target.path), original); assert.deepEqual(await f.snapshot(f.original.path), original);
});

test('a migrated copy is checked now even while the original directory check is cooling down', async t => {
  const f = await fixture(t); await f.firstBackup();
  await f.command('collector:repair-local'); await f.service.pump();
  const prior = f.store.get(`localMaintenance:${f.account().accountKey}`); assert.ok(prior.nextRunAt > Date.parse('2026-10-28T01:00:00Z'));
  const entry = (await f.manifest()).conversations['11'];
  const target = await f.migrate(); await rm(join(target.path, entry.markdownPath));
  await f.service.pump();
  assert.match(await readFile(join(target.path, entry.markdownPath), 'utf8'), /Offline readable answer/);
  assert.equal(f.calls.detail, 1, 'repair must use copied native JSON rather than website');
});

test('failed directory switch must not be retried when restoring original directory permission', async t => {
  const f = await fixture(t); await f.firstBackup();
  const replacementPath = join(f.root, 'replacement'); await mkdir(replacementPath);
  const candidate = f.directory(replacementPath); f.permission.set(replacementPath, false); f.store.set('directoryCandidate', candidate);
  await assert.rejects(f.command('collector:directory-changed'), { code: 'DIRECTORY_PERMISSION' });
  f.permission.set(replacementPath, true);
  // The current UI uses directory-changed without a candidate when restoring permission.
  await f.command('collector:directory-changed');
  assert.equal(f.store.get('directory').path, f.original.path);
});


test('migration detects a missing binary attachment and restores its offline relative link', async t => {
  const f = await fixture(t); await f.firstBackup(); await f.command('collector:repair-local'); await f.service.pump();
  const before = await f.snapshot(f.original.path), entry = (await f.manifest()).conversations['11'];
  const target = await f.migrate(); await rm(join(target.path, entry.assets[0].localPath));
  for (let i = 0; i < 8; i++) await f.service.pump();
  const restored = await f.snapshot(target.path);
  for (const [path, hash] of Object.entries(before)) if (!path.endsWith('/archive/manifest.json')) assert.equal(restored[path], hash);
  assert.equal((await f.manifest()).conversations['11'].assets[0].status, 'downloaded');
  assert.deepEqual(await f.snapshot(f.original.path), before);
  assert.equal(f.calls.detail, 1); assert.equal(f.calls.asset, 2);
});

test('a new empty directory must not show the previous directory attachment count', async t => {
  const f = await fixture(t); await f.firstBackup();
  assert.equal((await f.service.state(1)).assetStatus.local, 1);
  const path = join(f.root, 'empty'); await mkdir(path); f.store.set('directoryCandidate', f.directory(path));
  await f.command('collector:directory-changed');
  assert.equal((await f.service.state(1)).assetStatus?.local ?? 0, 0);
});

test('upgrade migration preserves opt-outs, bindings, stopped jobs and existing files', async t => {
  const f = await fixture(t); await f.firstBackup(); await f.command('collector:stop', { accountKey: f.account().accountKey });
  const before = await f.snapshot(f.original.path), old = f.store.get('collectorConfigV2');
  const oldAccounts = structuredClone(old.accounts), oldJob = structuredClone(await f.service.engine.getState(f.account().accountKey));
  f.store.set('collectorConfigV2', { ...old, schemaVersion: 2, localAssetsEnabled: false,
    github: { enabled: false, lfsEnabled: true, repository: 'fixture/private', branch: 'main', token: 'fixture-secret' } });
  f.restart(); await f.service.initialize(); await f.service.pump();
  const state = await f.service.state(1);
  assert.deepEqual(state.account, oldAccounts[f.account().accountKey]);
  assert.equal(state.config.autoEnabled, false); assert.equal(state.config.localAssetsEnabled, false);
  assert.equal(state.config.github.enabled, false); assert.equal(state.config.github.autoRestore, false);
  assert.equal(state.config.github.hasToken, true); assert.ok(!JSON.stringify(state).includes('fixture-secret'));
  assert.equal((await f.service.engine.getState(f.account().accountKey)).id, oldJob.id);
  assert.equal((await f.service.engine.getState(f.account().accountKey)).status, 'stopped');
  assert.equal(f.calls.detail, 1); assert.equal(f.calls.cloud, 0);
  assert.deepEqual(await f.snapshot(f.original.path), before);
});

test('migration preserves user-edited Markdown and reports the conflict', async t => {
  const f = await fixture(t); await f.firstBackup(); await f.command('collector:repair-local'); await f.service.pump();
  const target = await f.migrate(), entry = (await f.manifest()).conversations['11'];
  const path = join(target.path, entry.markdownPath); await writeFile(path, 'My personal notes');
  await f.command('collector:start', { mode: 'full', expectedAccountKey: f.account().accountKey });
  for (let i = 0; i < 8; i++) await f.service.pump();
  assert.equal(await readFile(path, 'utf8'), 'My personal notes');
  const job = await f.service.engine.getState(f.account().accountKey);
  assert.ok(job.failed > 0 || job.status === 'blocked');
});
