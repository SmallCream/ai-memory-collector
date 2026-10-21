import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createChatGPTAssetResolver } from '../extension/lib/chatgpt-assets.js';
import { createAssetService } from '../extension/lib/asset-service.js';
import { extractAssets } from '../extension/lib/assets.js';
import { createArchiveStore, readAccountManifest } from '../extension/lib/archive-store.js';
import { assetPath } from '../extension/lib/asset-store.js';
import { hashBytes, formatLfsPointer, parseLfsPointer } from '../extension/lib/lfs.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64'));
const account = { platform: 'chatgpt', accountKey: 'acct-0123456789abcdef01234567', storageKey: 'synthetic-demo', displayName: 'Synthetic' };
const config = { repository: 'example/private-data', branch: 'main', token: 'synthetic-token', lfsEnabled: true };
function detail(parts = [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image' }]) {
  return { identity: { accountKey: account.accountKey }, capturedAt: '2026-10-21T08:00:00Z', completeness: 'complete', payload: {
    conversation_id: 'conversation-one', title: 'Synthetic image conversation', create_time: 1792483200, update_time: 1792569600,
    current_node: 'reply', mapping: {
      root: { parent: null, message: null },
      reply: { parent: 'root', message: { id: 'message-one', author: { role: 'assistant' }, status: 'finished_successfully',
        content: { content_type: 'multimodal_text', parts } } },
    },
  } };
}
function setup() {
  const fs = memoryBinaryFs(), store = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
  const captures = [], enqueued = [], uploads = [], downloads = [], objects = new Map(), requests = [];
  let enqueueFailure = false, resolveFailure = false, clock = 1_000, pointerOverride = null, corruptDownload = false;
  const dependencies = { getSetting: fs.getSetting, setSetting: fs.setSetting, readAccountManifest,
    saveConversation: store.saveConversation,
    resolveAsset: async input => { captures.push(input); if (resolveFailure) throw new Error('synthetic unavailable'); return { bytes: PNG, mimeType: 'image/png', quality: 'original' }; },
    enqueueArchive: async input => { if (enqueueFailure) throw new Error('synthetic outbox interruption'); enqueued.push(input); },
    browser: { permissions: { contains: async () => true } },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(PNG, { headers: { 'content-type': 'image/png' } }); },
    lfsFactory: () => ({
      upload: async input => { uploads.push(input); objects.set(input.oid, new Uint8Array(input.bytes)); },
      download: async input => { downloads.push(input); return corruptDownload ? new Uint8Array([1, 2]) : objects.get(input.oid); },
    }),
    downloadRepositoryFile: async ({ entry }) => new TextEncoder().encode(pointerOverride || entry.pointer),
    now: () => clock,
  };
  let service = createAssetService(dependencies);
  return { fs, store, captures, enqueued, uploads, downloads, objects, requests, dependencies,
    get service() { return service; }, restart: () => { service = createAssetService(dependencies); return service; },
    save: value => service.save({ directory: fs.directory, account, detail: value }),
    tick: () => service.tick({ directory: fs.directory, account, tabId: 7 }),
    manifest: () => readAccountManifest(fs.directory, account),
    enqueueFailure: value => { enqueueFailure = value; }, resolveFailure: value => { resolveFailure = value; },
    time: value => { clock = value; }, pointer: value => { pointerOverride = value; }, corrupt: value => { corruptDownload = value; },
  };
}
async function managed(env, count, { local = true } = {}) {
  const assets = [];
  for (let index = 0; index < count; index++) {
    const bytes = new Uint8Array(PNG.length + 1); bytes.set(PNG); bytes[PNG.length] = index;
    const oid = await hashBytes(bytes);
    const asset = { id: await hashBytes(new TextEncoder().encode(`synthetic-image-${index}`)), sourceType: 'platform', sourceRef: `file-service://file_${index}`,
      kind: 'image', status: 'downloaded', oid, size: bytes.length, mimeType: 'image/png', localPath: assetPath(account, oid, 'png') };
    assets.push(asset); env.objects.set(oid, bytes); if (local) env.fs.put(asset.localPath, bytes);
  }
  return assets;
}
function bundle(assets) {
  return [{ files: [{ path: `data/web/chatgpt/${account.storageKey}/archive/manifest.json`,
    content: JSON.stringify({ conversations: { one: { assets } } }) }] }];
}
const snapshot = assets => ({ entries: assets.map(asset => ({ path: asset.localPath, pointer: formatLfsPointer(asset) })) });

async function legacyFileCitation({ downloaded = false, ambiguous = false } = {}) {
  const env = setup(), source = detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image',
    width: 1, height: 1, size_bytes: PNG.length }]);
  const upload = source.payload.mapping.reply.message;
  upload.author.role = 'user'; upload.metadata = { attachments: [{ id: 'file_image', library_file_id: 'libfile_image', name: 'image.png' }] };
  source.payload.current_node = 'citation';
  source.payload.mapping.citation = { parent: 'reply', message: { id: 'message-citation', author: { role: 'assistant' },
    status: 'finished_successfully', content: { content_type: 'text', parts: ['The uploaded picture.'] },
    metadata: { content_references: [{ type: 'file', source: 'my_files', id: 'file_image', library_file_id: 'libfile_image', name: 'image.png' }] } } };
  if (ambiguous) upload.metadata.attachments.push({ id: 'file_other', library_file_id: 'libfile_image', name: 'different.png' });
  const extracted = await extractAssets(source.payload);
  let canonical = extracted.find(asset => asset.fileId === 'file_image');
  if (downloaded) {
    await env.save(source); await env.tick();
    canonical = (await env.manifest()).conversations['conversation-one'].assets.find(asset => asset.id === canonical.id);
  }
  canonical = { ...canonical, occurrences: canonical.occurrences.filter(item => item.messageId !== 'message-citation') };
  const alias = { id: await hashBytes(new TextEncoder().encode('platform:library:libfile_image')), sourceType: 'platform',
    sourceRef: 'library:libfile_image', libraryFileId: 'libfile_image', status: 'pending', kind: 'attachment', fileName: 'image.png',
    messageId: 'message-citation', references: ['library:libfile_image'],
    occurrences: [{ messageId: 'message-citation', path: 'messages/message-citation/metadata/content_references/0', kind: 'attachment' }] };
  const saved = await env.store.saveConversation({ directory: env.fs.directory, account, detail: source,
    assets: [canonical, ...extracted.filter(asset => asset.id !== canonical.id), alias] });
  const jobKey = `assetJobs:${account.accountKey}`;
  const failure = assetId => ({ conversationId: 'conversation-one', assetId, attempt: 4, retryAt: 999_999,
    error: { code: 'ASSET_URL', message: 'synthetic previous version' } });
  await env.fs.setSetting(jobKey, { tasks: [failure(alias.id), failure(canonical.id)] });
  env.dependencies.refreshConversation = async () => source;
  env.restart();
  return { env, source, saved, canonical, alias, jobKey };
}

test('manual retry migrates an old Library-only citation to its verified downloaded file without recapturing', async () => {
  const { env, saved, canonical, jobKey } = await legacyFileCitation({ downloaded: true });
  const original = env.fs.text(saved.entry.jsonPath), beforeCaptures = env.captures.length;
  await env.service.retryFailed({ account }); await env.tick();
  const entry = (await env.manifest()).conversations['conversation-one'];
  assert.equal(entry.assets.length, 1); assert.equal(entry.assets[0].id, canonical.id);
  assert.equal(env.captures.length, beforeCaptures);
  assert.ok(entry.assets[0].occurrences.some(item => item.messageId === 'message-citation'));
  assert.deepEqual(env.fs.files.get(entry.assets[0].localPath), PNG);
  assert.match(env.fs.text(entry.markdownPath), /assets\/[a-f0-9]{64}\.png/);
  assert.equal(env.fs.text(entry.jsonPath), original);
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 0);
});

test('old duplicate pending tasks capture once under the file identity and retain archived byte constraints', async () => {
  const { env, source, saved, canonical, jobKey } = await legacyFileCitation();
  const original = env.fs.text(saved.entry.jsonPath), live = structuredClone(source);
  Object.assign(live.payload.mapping.reply.message.content.parts[0], { width: 2, height: 2, size_bytes: PNG.length + 1 });
  env.dependencies.refreshConversation = async () => live; env.restart();
  await env.service.retryFailed({ account }); await env.tick();
  assert.equal(env.captures.length, 1);
  assert.equal(env.captures[0].asset.id, canonical.id); assert.equal(env.captures[0].asset.fileId, 'file_image');
  assert.equal(env.captures[0].asset.expectedSize, PNG.length); assert.equal(env.captures[0].asset.width, 1);
  assert.equal((await env.manifest()).conversations['conversation-one'].assets.length, 1);
  assert.equal(env.fs.text(saved.entry.jsonPath), original);
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 0);
});

test('duplicate migration verifies a ready local file and retains its known hash if bytes need recapture', async t => {
  for (const kind of ['missing', 'modified']) await t.test(kind, async () => {
    const { env, canonical, jobKey } = await legacyFileCitation({ downloaded: true });
    const beforeCaptures = env.captures.length;
    if (kind === 'missing') env.fs.files.delete(canonical.localPath);
    else env.fs.put(canonical.localPath, new Uint8Array([1, 2, 3]));
    await env.service.retryFailed({ account }); await env.tick();
    if (kind === 'missing') {
      assert.equal(env.captures.length, beforeCaptures + 1);
      assert.equal(env.captures.at(-1).asset.sha256, canonical.oid);
      assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 0);
    } else {
      assert.equal(env.captures.length, beforeCaptures);
      assert.equal((await env.fs.getSetting(jobKey)).tasks[0].error.code, 'ASSET_LOCAL_CONFLICT');
      assert.deepEqual(env.fs.files.get(canonical.localPath), new Uint8Array([1, 2, 3]));
    }
  });
});

test('a source rescan preserves newly extracted citation anchors on an already downloaded image', async () => {
  const { env, source, canonical } = await legacyFileCitation({ downloaded: true });
  await env.save(source);
  const entry = (await env.manifest()).conversations['conversation-one'];
  assert.equal(entry.assets.length, 1); assert.equal(entry.assets[0].id, canonical.id);
  assert.equal(entry.assets[0].status, 'downloaded');
  assert.ok(entry.assets[0].occurrences.some(item => item.messageId === 'message-citation'));
});

test('Library-only migration retains failures when the archived mapping is ambiguous or citation anchors disagree', async t => {
  for (const kind of ['ambiguous', 'anchor', 'constraint', 'mime']) await t.test(kind, async () => {
    const { env, saved, alias, jobKey } = await legacyFileCitation({ ambiguous: kind === 'ambiguous' });
    if (kind !== 'ambiguous') {
      const manifest = await env.manifest(), entry = manifest.conversations['conversation-one'];
      const old = entry.assets.find(item => item.id === alias.id);
      if (kind === 'anchor') old.occurrences[0].messageId = 'unrelated-message';
      else if (kind === 'constraint') old.expectedSize = PNG.length + 1;
      else { old.mimeType = 'image/jpeg'; entry.assets.find(item => item.fileId === 'file_image').mimeType = 'image/png'; }
      env.fs.put(`${saved.entry.jsonPath.split('/conversations/')[0]}/archive/manifest.json`, JSON.stringify(manifest));
    }
    const original = env.fs.text(saved.entry.jsonPath);
    await env.service.retryFailed({ account }); await env.tick();
    assert.equal(env.captures.length, 0); assert.equal(env.fs.text(saved.entry.jsonPath), original);
    assert.ok((await env.manifest()).conversations['conversation-one'].assets.some(item => item.id === alias.id));
    assert.equal((await env.fs.getSetting(jobKey)).tasks[0].error.code, 'ASSET_SOURCE_MISSING');
  });
});

test('Library-only retry validates the live account and conversation before changing existing records', async t => {
  for (const kind of ['account', 'conversation', 'incomplete', 'missing']) await t.test(kind, async () => {
    const { env, source, saved, alias, jobKey } = await legacyFileCitation({ downloaded: true });
    const live = structuredClone(source), original = env.fs.text(saved.entry.jsonPath), beforeCaptures = env.captures.length;
    if (kind === 'account') live.identity.accountKey = 'acct-ffffffffffffffffffffffff';
    if (kind === 'conversation') live.payload.conversation_id = 'another-conversation';
    if (kind === 'incomplete') live.completeness = 'partial';
    if (kind === 'missing') live.payload.mapping = {};
    env.dependencies.refreshConversation = async () => live; env.restart();
    await env.service.retryFailed({ account }); await env.tick();
    assert.equal(env.captures.length, beforeCaptures); assert.equal(env.fs.text(saved.entry.jsonPath), original);
    assert.ok((await env.manifest()).conversations['conversation-one'].assets.some(item => item.id === alias.id));
    const task = (await env.fs.getSetting(jobKey)).tasks[0];
    assert.equal(task.assetId, alias.id);
    assert.equal(task.error.code, kind === 'account' ? 'ACCOUNT_CHANGED' : kind === 'missing' ? 'ASSET_SOURCE_MISSING' : 'INCOMPLETE_DETAIL');
  });
});

test('migration preserves older pending archives and resumes their delivery before the corrected manifest', async () => {
  const { env, saved, jobKey } = await legacyFileCitation({ downloaded: true });
  const state = await env.fs.getSetting(jobKey); state.tasks[1].pendingArchives = [saved]; await env.fs.setSetting(jobKey, state);
  const before = env.enqueued.length, beforeCaptures = env.captures.length;
  env.enqueueFailure(true); await env.service.retryFailed({ account }); await env.tick();
  const pending = await env.fs.getSetting(jobKey);
  assert.equal(pending.tasks.length, 1); assert.equal(pending.tasks[0].pendingArchives.length, 2);
  env.restart(); env.enqueueFailure(false); await env.service.retryFailed({ account }); await env.tick();
  assert.equal(env.captures.length, beforeCaptures);
  assert.deepEqual(env.enqueued.slice(before).map(item => item.archive.entry.assets.length), [2, 1]);
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 0);
});

test('a crash after migration filesystem commit can enqueue the corrected archive using the checkpointed file ID', async () => {
  const { env, canonical, jobKey } = await legacyFileCitation();
  let interrupt = true;
  env.dependencies.setSetting = async (key, value) => {
    if (interrupt && key === jobKey && value?.tasks.some(task => task.pendingArchives?.length)) throw new Error('synthetic worker stop');
    return env.fs.setSetting(key, value);
  };
  env.restart(); await env.service.retryFailed({ account });
  await assert.rejects(env.tick(), /synthetic worker stop/);
  assert.equal((await env.fs.getSetting(jobKey)).tasks[0].assetId, canonical.id);
  assert.equal((await env.manifest()).conversations['conversation-one'].assets.length, 1);
  interrupt = false; env.restart(); await env.service.retryFailed({ account }); await env.tick();
  assert.equal(env.captures.length, 1); assert.equal(env.enqueued.length, 1);
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 0);
});

test('canonical-first migration checkpoints an old alias receipt before a crash removes the alias from the manifest', async () => {
  const { env, saved, jobKey } = await legacyFileCitation({ downloaded: true });
  const state = await env.fs.getSetting(jobKey);
  state.tasks[0].pendingArchives = [saved]; state.tasks.reverse(); await env.fs.setSetting(jobKey, state);
  const before = env.enqueued.length, beforeCaptures = env.captures.length;
  let interrupt = true;
  env.dependencies.setSetting = async (key, value) => {
    if (interrupt && key === jobKey && (await env.manifest()).conversations['conversation-one'].assets.length === 1) {
      throw new Error('synthetic stop after corrected manifest');
    }
    return env.fs.setSetting(key, value);
  };
  env.restart(); await env.service.retryFailed({ account });
  await assert.rejects(env.tick(), /synthetic stop after corrected manifest/);
  const checkpoint = await env.fs.getSetting(jobKey);
  assert.equal(checkpoint.tasks.length, 1); assert.equal(checkpoint.tasks[0].priorArchives.length, 1);
  interrupt = false; env.restart(); await env.service.retryFailed({ account }); await env.tick();
  assert.deepEqual(env.enqueued.slice(before).map(item => item.archive.entry.assets.length), [2, 1]);
  assert.equal(env.captures.length, beforeCaptures);
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 0);
});

test('capture persists exact image, regenerates Markdown and enqueues archive while native JSON remains identical', async () => {
  const env = setup(), saved = await env.save(detail());
  const original = env.fs.text(saved.entry.jsonPath), initialMarkdown = env.fs.text(saved.entry.markdownPath);
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 1);
  assert.equal((await env.tick()).pending, 0);
  const entry = (await env.manifest()).conversations['conversation-one'];
  assert.equal(entry.assets[0].status, 'downloaded'); assert.equal(entry.assets[0].quality, 'original');
  assert.deepEqual(env.fs.files.get(entry.assets[0].localPath), PNG);
  assert.equal(env.fs.text(entry.jsonPath), original); assert.equal(entry.contentHash, saved.entry.contentHash);
  assert.notEqual(env.fs.text(entry.markdownPath), initialMarkdown);
  assert.match(env.fs.text(entry.markdownPath), /assets\/[a-f0-9]{64}\.png/);
  assert.equal(env.enqueued.length, 1); assert.equal(env.captures.length, 1);
  assert.ok(!JSON.stringify(await env.fs.getSetting(`assetJobs:${account.accountKey}`)).includes('retrieval'));
});

test('bare generated pointer reaches authenticated file download, local image, Markdown and LFS preparation after restart', async t => {
  for (const mode of ['json-link', 'opaque-follow']) await t.test(mode, async () => {
    const fs = memoryBinaryFs(), store = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
    const user = 'synthetic-generated-user';
    const owner = { ...account, accountKey: `acct-${(await hashBytes(new TextEncoder().encode(`chatgpt:${user}`))).slice(0, 24)}` };
    const conversationId = 'synthetic-generated-conversation';
    const source = detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_generated',
      width: 1, height: 1, size_bytes: PNG.length, metadata: { asset_pointer_link: null } }]);
    source.identity.accountKey = owner.accountKey; source.payload.conversation_id = conversationId;
    const entryURL = `https://chatgpt.com/backend-api/files/download/file_generated?conversation_id=${conversationId}&download_intent=false&inline=true`;
    const contentURL = 'https://chatgpt.com/backend-api/estuary/content?id=file_generated&sig=synthetic-generated-signature';
    const sessionURL = 'https://chatgpt.com/api/auth/session';
    const calls = [], injected = [], enqueued = [], uploaded = [];
    const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });
    const fetch = async (url, options) => {
      calls.push({ url, options });
      if (url === sessionURL) return new Response(JSON.stringify({ user: { id: user }, accessToken: 'synthetic-session-secret' }),
        { headers: { 'content-type': 'application/json' } });
      if (url === entryURL) {
        if (mode === 'json-link') return new Response(JSON.stringify({ download_url: contentURL }),
          { headers: { 'content-type': 'application/json' } });
        return options.redirect === 'manual' ? { type: 'opaqueredirect' } : Object.defineProperty(png(), 'url', { value: contentURL });
      }
      if (url === contentURL) return png();
      throw new Error('Unexpected synthetic request');
    };
    const browser = { tabs: { get: async () => ({ url: 'https://chatgpt.com/c/different-open-conversation' }) },
      scripting: { executeScript: async options => {
        injected.push(options.args[0]);
        const context = vm.createContext({ URL, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView,
          AbortController, setTimeout, clearTimeout, btoa, atob, location: { origin: 'https://chatgpt.com' },
          document: { querySelectorAll: () => [] }, fetch });
        const probe = vm.runInContext(`(${options.func.toString()})`, context);
        return [{ frameId: 0, result: await probe(...options.args) }];
      } } };
    const resolver = createChatGPTAssetResolver(browser, { allowFileDownload: true });
    const dependencies = { getSetting: fs.getSetting, setSetting: fs.setSetting, readAccountManifest,
      saveConversation: store.saveConversation, resolveAsset: resolver.resolve, refreshConversation: async () => source,
      enqueueArchive: async input => enqueued.push(input),
      lfsFactory: () => ({ upload: async input => uploaded.push(input) }) };
    let service = createAssetService(dependencies);
    const saved = await service.save({ directory: fs.directory, account: owner, detail: source });
    const original = fs.text(saved.entry.jsonPath);
    const queueKey = `assetJobs:${owner.accountKey}`, state = await fs.getSetting(queueKey);
    state.tasks[0].error = { code: 'ASSET_PENDING', message: 'synthetic earlier version' };
    state.tasks[0].retryAt = Date.now() + 60000; await fs.setSetting(queueKey, state);
    service = createAssetService(dependencies);
    await service.retryFailed({ account: owner });
    const tick = await service.tick({ directory: fs.directory, account: owner, tabId: 7, manualOnly: true });
    assert.equal(tick.pending, 0, JSON.stringify(await service.diagnostics({ account: owner })));
    assert.equal(injected[0].conversationId, conversationId);
    assert.equal(injected[0].allowFileDownload, true);
    for (const call of calls.filter(c => c.url !== sessionURL)) {
      assert.equal(call.options.headers.Authorization, 'Bearer synthetic-session-secret');
      assert.ok(['include', 'same-origin'].includes(call.options.credentials));
    }
    const entry = (await readAccountManifest(fs.directory, owner)).conversations[conversationId];
    assert.deepEqual(fs.files.get(entry.assets[0].localPath), PNG);
    assert.equal(entry.assets[0].quality, 'original');
    assert.equal(fs.text(entry.jsonPath), original);
    assert.match(fs.text(entry.markdownPath), /assets\/[a-f0-9]{64}\.png/);
    assert.equal(enqueued.length, 1);
    const pointers = await service.prepareUploads({ directory: fs.directory, account: owner, config, bundles: [enqueued[0].archive] });
    assert.equal(uploaded.length, 1); assert.deepEqual(uploaded[0].bytes, PNG);
    assert.equal(parseLfsPointer(pointers[0].content).oid, entry.assets[0].oid);
    const persisted = [...fs.files.values()].map(bytes => new TextDecoder().decode(bytes)).join('\n') +
      JSON.stringify([...fs.settings.entries()]) + JSON.stringify(enqueued);
    assert.ok(!persisted.includes('synthetic-generated-signature'));
    assert.ok(!persisted.includes('synthetic-session-secret'));
  });
});

test('failure diagnostics immediately reflect durable queue and never expose raw error URLs or tokens', async () => {
  const env = setup(); await env.save(detail()); env.resolveFailure(true);
  await env.tick();
  assert.equal((await env.fs.getSetting(`assetStatus:${account.accountKey}`)).failed, 1);
  const state = await env.fs.getSetting(`assetJobs:${account.accountKey}`);
  state.tasks[0].error = { code: 'HTTP_403', message: 'https://example.invalid/?sig=private Bearer private github_pat_private' };
  await env.fs.setSetting(`assetJobs:${account.accountKey}`, state);
  const diagnostics = await env.service.diagnostics({ directory: env.fs.directory, account });
  assert.equal(diagnostics.total, 1); assert.equal(diagnostics.pending, 1); assert.equal(diagnostics.failed, 1);
  assert.equal(diagnostics.failures[0].code, 'HTTP_403'); assert.equal(diagnostics.failures[0].attempt, 1);
  assert.equal(diagnostics.failures[0].conversationTitle, 'Synthetic image conversation');
  assert.ok(!JSON.stringify(diagnostics).includes('private'));
  assert.equal((await env.service.diagnostics({ account })).failed, 1);
});

test('manual retry bypasses backoff once per failed task while paused and leaves fresh tasks alone', async () => {
  const env = setup(); await env.save(detail()); env.resolveFailure(true); await env.tick();
  const other = detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_other' }]);
  other.payload.conversation_id = 'conversation-two'; await env.save(other);
  await env.service.retryFailed({ account });
  const retry = () => env.service.tick({ directory: env.fs.directory, account, tabId: 7, manualOnly: true });
  assert.equal((await retry()).runnable, false);
  assert.equal(env.captures.length, 2); assert.equal((await retry()).runnable, false);
  env.time(1_000_000); await retry(); assert.equal(env.captures.length, 2);
  assert.equal((await env.service.diagnostics({ account })).failed, 1);
  env.resolveFailure(false); await env.service.retryFailed({ account }); await retry();
  assert.equal(env.captures.length, 3); assert.equal((await env.service.diagnostics({ account })).failed, 0);
  assert.equal((await env.service.diagnostics({ account })).pending, 1);
});

test('retry refreshes live attachment link after worker restart without replacing archived native conversation', async () => {
  const env = setup(), saved = await env.save(detail()), original = env.fs.text(saved.entry.jsonPath);
  env.resolveFailure(true); await env.tick(); env.resolveFailure(false);
  const refreshes = [], live = detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image',
    asset_pointer_link: 'https://files.oaiusercontent.com/image.png?sig=synthetic-fresh-secret' }]);
  live.payload.title = 'New online title';
  env.dependencies.refreshConversation = async request => { refreshes.push(request); return live; };
  env.restart(); await env.service.retryFailed({ account });
  await env.service.tick({ directory: env.fs.directory, account, tabId: 7, manualOnly: true });
  assert.deepEqual(refreshes, [{ tabId: 7, accountKey: account.accountKey, conversationId: 'conversation-one' }]);
  assert.equal(env.captures[1].asset.retrieval.url, live.payload.mapping.reply.message.content.parts[0].asset_pointer_link);
  assert.equal(env.fs.text(saved.entry.jsonPath), original);
  assert.ok(!JSON.stringify(await env.manifest()).includes('synthetic-fresh-secret'));
  assert.equal((await env.service.diagnostics({ account })).pending, 0);
});

test('refreshed image details reject wrong account, wrong conversation, incomplete source and missing asset', async () => {
  for (const kind of ['account', 'conversation', 'incomplete', 'missing']) {
    const env = setup(), saved = await env.save(detail()), original = env.fs.text(saved.entry.jsonPath);
    env.resolveFailure(true); await env.tick(); env.resolveFailure(false);
    const live = detail(kind === 'missing' ? ['image no longer in source'] : undefined);
    if (kind === 'account') live.identity.accountKey = 'acct-ffffffffffffffffffffffff';
    if (kind === 'conversation') live.payload.conversation_id = 'other';
    if (kind === 'incomplete') live.completeness = 'partial';
    env.dependencies.refreshConversation = async () => live;
    env.restart(); await env.service.retryFailed({ account }); await env.tick();
    assert.equal(env.captures.length, 1); assert.equal(env.fs.text(saved.entry.jsonPath), original);
    const diagnostic = await env.service.diagnostics({ account });
    assert.equal(diagnostic.failed, 1);
    assert.equal(diagnostic.failures[0].code, kind === 'account' ? 'ACCOUNT_CHANGED' : kind === 'missing' ? 'ASSET_SOURCE_MISSING' : 'INCOMPLETE_DETAIL');
  }
});

test('source refresh updates Library location while retaining original byte identity constraints', async () => {
  const env = setup(), initial = detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image',
    library_file_id: 'libfile_old', width: 1, height: 1, size_bytes: PNG.length }]);
  await env.save(initial); env.resolveFailure(true); await env.tick(); env.resolveFailure(false);
  const live = detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image',
    library_file_id: 'libfile_new', width: 2, height: 2, size_bytes: PNG.length + 1 }]);
  env.dependencies.refreshConversation = async () => live;
  env.restart(); await env.service.retryFailed({ account }); await env.tick();
  const captured = env.captures[1].asset;
  assert.equal(captured.libraryFileId, 'libfile_new'); assert.equal(captured.retrieval.libraryFileId, 'libfile_new');
  assert.equal(captured.width, 1); assert.equal(captured.height, 1); assert.equal(captured.expectedSize, PNG.length);
});

test('manual retry keeps pending outbox receipt without fetching or downloading original again', async () => {
  const env = setup(); await env.save(detail()); env.enqueueFailure(true); await env.tick();
  let refreshed = 0; env.dependencies.refreshConversation = async () => { refreshed++; throw new Error('must not fetch'); };
  env.restart(); env.enqueueFailure(false); await env.service.retryFailed({ account }); await env.tick();
  assert.equal(refreshed, 0); assert.equal(env.captures.length, 1); assert.equal(env.enqueued.length, 1);
});

test('restart after enqueue failure delivers saved image without recapture even if another source scan occurs', async () => {
  const env = setup(); await env.save(detail()); env.enqueueFailure(true);
  assert.equal((await env.tick()).pending, 1); assert.equal(env.captures.length, 1);
  env.restart(); await env.save(detail());
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 1);
  env.enqueueFailure(false); env.time(121_001);
  assert.equal((await env.tick()).pending, 0); assert.equal(env.captures.length, 1); assert.equal(env.enqueued.length, 1);
  assert.equal((await env.fs.getSetting(`assetStatus:${account.accountKey}`)).failed, 0);
});

test('deleted managed binary returns to capture while manual binary modifications remain protected', async () => {
  const env = setup(); await env.save(detail()); await env.tick();
  let entry = (await env.manifest()).conversations['conversation-one'];
  env.fs.files.delete(entry.assets[0].localPath);
  await env.save(detail());
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 1);
  assert.equal((await env.tick()).pending, 0); assert.equal(env.captures.length, 2);
  entry = (await env.manifest()).conversations['conversation-one'];
  env.fs.put(entry.assets[0].localPath, new Uint8Array([7]));
  await assert.rejects(env.save(detail()), { code: 'ASSET_LOCAL_CONFLICT' });
  assert.deepEqual(env.fs.files.get(entry.assets[0].localPath), new Uint8Array([7]));
});

test('a recovered different-conversation archive is durably delivered before the current archive', async () => {
  const env = setup(); await env.save(detail());
  const other = detail(['Another synthetic conversation']); other.payload.conversation_id = 'conversation-two';
  env.fs.fail(path => path.endsWith('__conversation-two.md'));
  await assert.rejects(env.store.saveConversation({ directory: env.fs.directory, account, detail: other }), { code: 'LOCAL_WRITE' });
  env.fs.fail(null); env.enqueueFailure(true);
  assert.equal((await env.tick()).pending, 1);
  const task = (await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks[0];
  assert.deepEqual(task.pendingArchives.map(value => value.entry.conversationId), ['conversation-two', 'conversation-one']);
  env.restart(); env.enqueueFailure(false); env.time(121_001);
  assert.equal((await env.tick()).pending, 0);
  assert.deepEqual(env.enqueued.map(value => value.archive.entry.conversationId), ['conversation-two', 'conversation-one']);
  assert.equal(env.captures.length, 1);
});

test('embedded retrieval is reconstructed from native JSON after restart', async () => {
  const env = setup();
  await env.save(detail([`![tiny](data:image/png;base64,${Buffer.from(PNG).toString('base64')})`]));
  env.restart(); assert.equal((await env.tick()).pending, 0);
  assert.equal(env.captures.length, 0);
  const entry = (await env.manifest()).conversations['conversation-one'];
  assert.deepEqual(env.fs.files.get(entry.assets[0].localPath), PNG);
  assert.match(env.fs.text(entry.markdownPath), /assets\/[a-f0-9]{64}\.png/);
});

test('verified public external image retains link and never uploads its bytes', async () => {
  const env = setup(); await env.save(detail(['![public](https://images.example.org/tiny.png)']));
  assert.equal((await env.tick()).pending, 0);
  const entry = (await env.manifest()).conversations['conversation-one'];
  assert.equal(entry.assets[0].status, 'external'); assert.equal(env.captures.length, 0);
  assert.equal(env.requests[0].options.credentials, 'omit');
  const pointers = await env.service.prepareUploads({ directory: env.fs.directory, account, config, bundles: bundle(entry.assets) });
  assert.deepEqual(pointers, []); assert.equal(env.uploads.length, 0);
  assert.ok(![...env.fs.files.keys()].some(path => path.includes('/assets/')));
});

test('non-image attachments stay references and do not create retry tasks', async () => {
  const env = setup(); await env.save(detail([{ content_type: 'file', file_id: 'file_document', mime_type: 'application/pdf', name: 'manual.pdf' }]));
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 0);
  assert.equal((await env.tick()).runnable, false); assert.equal(env.captures.length, 0);
});

test('manual native JSON changes stop image processing before resolver or outbox changes', async () => {
  const env = setup(), saved = await env.save(detail());
  env.fs.put(saved.entry.jsonPath, '{"manual":true}');
  assert.equal((await env.tick()).pending, 1);
  assert.equal(env.fs.text(saved.entry.jsonPath), '{"manual":true}');
  assert.equal(env.captures.length, 0); assert.equal(env.enqueued.length, 0);
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks[0].error.code, 'LOCAL_CONFLICT');
});

test('image tasks make bounded progress and retry failures without losing other tasks', async () => {
  const env = setup();
  await env.save(detail([{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_one' },
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_two' }]));
  env.resolveFailure(true); assert.equal((await env.tick()).pending, 2);
  env.resolveFailure(false); assert.equal((await env.tick()).pending, 1); assert.equal(env.enqueued.length, 1);
  env.time(121_001); assert.equal((await env.tick()).pending, 0); assert.equal(env.enqueued.length, 2);
});

test('LFS preparation is capped at two new objects, persists per-object progress, and resumes after restart', async () => {
  const env = setup(), assets = await managed(env, 5), input = { directory: env.fs.directory, account, config, bundles: bundle(assets) };
  await assert.rejects(env.service.prepareUploads(input), { code: 'LFS_UPLOAD_PENDING' });
  assert.equal(env.uploads.length, 2);
  assert.equal((await env.fs.getSetting(`assetStatus:${account.accountKey}`)).pendingUpload, 3);
  env.restart(); await assert.rejects(env.service.prepareUploads(input), { code: 'LFS_UPLOAD_PENDING' });
  assert.equal(env.uploads.length, 4);
  const pointers = await env.service.prepareUploads(input);
  assert.equal(env.uploads.length, 5); assert.equal(pointers.length, 5);
  assert.ok(pointers.every(pointer => parseLfsPointer(pointer.content).oid === pointer.oid));
  await env.service.acknowledgeUploads(account);
  assert.equal(await env.fs.getSetting(`assetUploads:${account.accountKey}`), null);
  assert.equal((await env.fs.getSetting(`assetReceipts:${account.accountKey}`)).uploaded.length, 5);
});

test('upload checkpoint cannot skip transfers into another repository, branch or directory', async () => {
  const env = setup(), assets = await managed(env, 3);
  const input = { directory: env.fs.directory, account, config, bundles: bundle(assets) };
  await assert.rejects(env.service.prepareUploads(input), { code: 'LFS_UPLOAD_PENDING' });
  await assert.rejects(env.service.prepareUploads({ ...input, config: { ...config, repository: 'example/other-data' } }), { code: 'LFS_UPLOAD_PENDING' });
  assert.equal(env.uploads.length, 4);
  await assert.rejects(env.service.prepareUploads({ ...input, config: { ...config, branch: 'backup' } }), { code: 'LFS_UPLOAD_PENDING' });
  assert.equal(env.uploads.length, 6);
  const other = memoryBinaryFs(); for (const asset of assets) other.put(asset.localPath, env.objects.get(asset.oid));
  await assert.rejects(env.service.prepareUploads({ ...input, directory: other.directory }), { code: 'LFS_UPLOAD_PENDING' });
  assert.equal(env.uploads.length, 8);
});

test('capture status preserves uploaded receipts after a later identical source scan', async () => {
  const env = setup(); await env.save(detail()); await env.tick();
  const entry = (await env.manifest()).conversations['conversation-one'];
  await env.service.prepareUploads({ directory: env.fs.directory, account, config, bundles: bundle(entry.assets) });
  await env.service.acknowledgeUploads(account); await env.save(detail());
  const state = await env.fs.getSetting(`assetStatus:${account.accountKey}`);
  assert.equal(state.local, 1); assert.equal(state.uploaded, 1); assert.equal(state.pendingUpload, 0);
});

test('LFS restore verifies pointer identity and file content before writing binary', async () => {
  const env = setup(), assets = await managed(env, 1, { local: false });
  const result = await env.service.hydrateAssets({ directory: env.fs.directory, account, entry: { assets }, config, snapshot: snapshot(assets) });
  assert.equal(result.downloaded, 1); assert.equal(result.pending, 0);
  assert.deepEqual(env.fs.files.get(assets[0].localPath), env.objects.get(assets[0].oid));
  const again = await env.service.hydrateAssets({ directory: env.fs.directory, account, entry: { assets }, config, snapshot: snapshot(assets) });
  assert.equal(again.downloaded, 0); assert.equal(env.downloads.length, 1);
});

test('wrong or missing pointers and corrupt LFS objects do not create local image files', async () => {
  const env = setup(), assets = await managed(env, 1, { local: false });
  const input = { directory: env.fs.directory, account, entry: { assets }, config, snapshot: snapshot(assets) };
  await assert.rejects(env.service.hydrateAssets({ ...input, snapshot: { entries: [] } }), { code: 'ASSET_POINTER_MISSING' });
  env.time(61_001);
  env.pointer(formatLfsPointer({ oid: 'a'.repeat(64), size: assets[0].size }));
  await assert.rejects(env.service.hydrateAssets(input), { code: 'ASSET_POINTER_MISMATCH' });
  assert.equal(env.downloads.length, 0);
  env.pointer(null); env.corrupt(true); env.time(181_001);
  await assert.rejects(env.service.hydrateAssets(input), { code: 'ASSET_HASH' });
  assert.equal(env.fs.files.size, 0);
});

test('restore hydrates at most two images per call and preserves manual edits', async () => {
  const env = setup(), assets = await managed(env, 3, { local: false });
  const input = { directory: env.fs.directory, account, entry: { assets }, config, snapshot: snapshot(assets) };
  assert.deepEqual(await env.service.hydrateAssets(input), { downloaded: 2, pending: 1, failed: 0 });
  env.restart(); assert.deepEqual(await env.service.hydrateAssets(input), { downloaded: 1, pending: 0, failed: 0 });
  env.fs.put(assets[0].localPath, new Uint8Array());
  await assert.rejects(env.service.hydrateAssets(input), { code: 'ASSET_LOCAL_CONFLICT' });
  assert.equal(env.fs.files.get(assets[0].localPath).length, 0); assert.equal(env.downloads.length, 3);
});

test('one missing pointer cannot starve later good images and failures retain per-file backoff after restart', async () => {
  const env = setup(), assets = await managed(env, 5, { local: false });
  const input = { directory: env.fs.directory, account, entry: { conversationId: 'synthetic-many', assets }, config,
    snapshot: { ...snapshot(assets.slice(1)), commitSha: 'a'.repeat(40) } };
  assert.deepEqual(await env.service.hydrateAssets(input), { downloaded: 1, pending: 3, failed: 0 });
  assert.equal(env.downloads.length, 1); // failed first pointer also consumed the attempt budget
  env.restart();
  assert.deepEqual(await env.service.hydrateAssets(input), { downloaded: 2, pending: 1, failed: 0 });
  await assert.rejects(env.service.hydrateAssets(input), { code: 'ASSET_POINTER_MISSING' });
  assert.equal(env.downloads.length, 4);
  assert.ok(assets.slice(1).every(asset => env.fs.files.has(asset.localPath)));
  assert.equal(env.fs.files.has(assets[0].localPath), false);
  const saved = [...env.fs.settings.entries()].find(([key]) => key.startsWith('assetHydration:'))[1];
  assert.equal(Object.values(saved.failures)[0].attempt, 1);
  env.time(61_001);
  await assert.rejects(env.service.hydrateAssets(input), { code: 'ASSET_POINTER_MISSING' });
  const retried = [...env.fs.settings.entries()].find(([key]) => key.startsWith('assetHydration:'))[1];
  assert.equal(Object.values(retried.failures)[0].attempt, 2);
  // A new immutable snapshot may supply the missing pointer without inheriting its backoff.
  assert.deepEqual(await env.service.hydrateAssets({ ...input, snapshot: { ...snapshot(assets), commitSha: 'b'.repeat(40) } }),
    { downloaded: 1, pending: 0, failed: 0 });
});

function internalDetail() {
  const value = detail(['Text is archived normally.']);
  value.payload.current_node = 'viewer';
  value.payload.mapping.viewer = { parent: 'reply', message: { id: 'message-viewer',
    author: { role: 'tool', name: 'container.open_image' }, status: 'finished_successfully',
    content: { content_type: 'execution_output', text: '<<ImageDisplayed>>' },
    metadata: { attachments: [{ id: 'file_internal', name: '/mnt/data/internal.png', mime_type: 'image/png', size: PNG.length }] } } };
  return value;
}
function failCapture(env, code) {
  env.dependencies.resolveAsset = async input => {
    env.captures.push(input);
    throw Object.assign(new Error('https://example.invalid/?sig=private Bearer private'), { code });
  };
  env.restart();
}

test('internal viewer capture 404 preserves source, records missing bytes, and stops automatic retries across restarts', async () => {
  const env = setup(), source = internalDetail(), saved = await env.save(source), original = env.fs.text(saved.entry.jsonPath);
  failCapture(env, 'HTTP_404');
  assert.deepEqual(await env.tick(), { pending: 0, runnable: false });
  let entry = (await env.manifest()).conversations['conversation-one'], asset = entry.assets[0];
  assert.equal(asset.status, 'unavailable'); assert.equal(asset.capturePolicy, 'internal-viewer');
  assert.equal(asset.autoRetrySuspended, true); assert.equal(asset.errorCode, 'HTTP_404');
  assert.equal(asset.fileId, 'file_internal'); assert.equal(asset.messageId, 'message-viewer');
  assert.equal(asset.fileName, '/mnt/data/internal.png'); assert.equal(asset.oid, undefined); assert.equal(asset.localPath, undefined);
  assert.equal(env.fs.text(entry.jsonPath), original); assert.equal(env.enqueued.length, 1);
  assert.equal(env.enqueued[0].archive.entry.assets[0].autoRetrySuspended, true);
  const diagnostic = await env.service.diagnostics({ directory: env.fs.directory, account });
  assert.equal(diagnostic.pending, 0); assert.equal(diagnostic.failed, 0); assert.equal(diagnostic.internalMissing, 1);
  assert.equal(diagnostic.internalFailures[0].fileId, 'file_internal'); assert.equal(diagnostic.internalFailures[0].messageId, 'message-viewer');
  assert(!JSON.stringify(diagnostic).includes('private'));
  const state = await env.fs.getSetting(`assetStatus:${account.accountKey}`);
  assert.equal(state.pendingCapture, 0); assert.equal(state.internalMissing, 1); assert.equal(state.local, 0);
  env.time(99_000_000); env.restart(); await env.tick(); await env.save(source); await env.tick();
  assert.equal(env.captures.length, 1); assert.equal((await env.service.diagnostics({ account })).internalMissing, 1);
});

test('ordinary retries leave suspended internal attachments alone and explicit internal retry can download and upload real bytes', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); await env.tick();
  await env.service.retryFailed({ account }); await env.tick(); assert.equal(env.captures.length, 1);
  await env.service.retryFailed({ account, includeInternal: true });
  const manual = () => env.service.tick({ directory: env.fs.directory, account, tabId: 7, manualOnly: true });
  await manual(); assert.equal(env.captures.length, 2); await manual(); assert.equal(env.captures.length, 2);
  env.dependencies.resolveAsset = async input => { env.captures.push(input); return { bytes: PNG, mimeType: 'image/png', quality: 'original' }; };
  env.restart(); await env.service.retryFailed({ account, includeInternal: true }); await manual();
  const entry = (await env.manifest()).conversations['conversation-one'], asset = entry.assets[0];
  assert.equal(asset.status, 'downloaded'); assert.equal(asset.autoRetrySuspended, undefined); assert.equal(asset.errorCode, undefined);
  assert.deepEqual(env.fs.files.get(asset.localPath), PNG);
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 0);
  const pointers = await env.service.prepareUploads({ directory: env.fs.directory, account, config, bundles: [env.enqueued.at(-1).archive] });
  assert.equal(pointers.length, 1); assert.equal(env.uploads.length, 1); assert.deepEqual(env.uploads[0].bytes, PNG);
});

test('visible user or assistant images and unknown tool attachments never suspend capture after HTTP 404', async t => {
  for (const kind of ['user', 'assistant', 'other-tool', 'shared-user']) await t.test(kind, async () => {
    const env = setup(), source = internalDetail(), viewer = source.payload.mapping.viewer.message;
    if (kind === 'user' || kind === 'assistant') viewer.author = { role: kind };
    if (kind === 'other-tool') viewer.author.name = 'image_generator';
    if (kind === 'shared-user') source.payload.mapping.reply.message.content = { content_type: 'multimodal_text', parts: [
      { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_internal' }] };
    await env.save(source); failCapture(env, 'HTTP_404'); await env.tick();
    const diagnostic = await env.service.diagnostics({ account });
    assert.equal(diagnostic.internalMissing, 0); assert.equal(diagnostic.failed, 1);
    assert.equal((await env.manifest()).conversations['conversation-one'].assets[0].autoRetrySuspended, undefined);
    env.time(1_000_000); await env.tick(); assert.equal(env.captures.length, 2);
  });
});

test('internal authentication, rate limit and network failures keep ordinary retry semantics', async t => {
  for (const code of ['HTTP_401', 'HTTP_403', 'HTTP_429', 'NETWORK']) await t.test(code, async () => {
    const env = setup(); await env.save(internalDetail()); failCapture(env, code); await env.tick();
    const diagnostic = await env.service.diagnostics({ account });
    assert.equal(diagnostic.internalMissing, 0); assert.equal(diagnostic.failed, 1);
    env.time(1_000_000); await env.tick(); assert.equal(env.captures.length, 2);
  });
});

test('a hash-verified legacy internal 404 migrates before backoff expires without a new network request', async () => {
  const env = setup(), saved = await env.save(internalDetail()), original = env.fs.text(saved.entry.jsonPath);
  const state = await env.fs.getSetting(`assetJobs:${account.accountKey}`);
  Object.assign(state.tasks[0], { attempt: 6, retryAt: 99_000_000, error: { code: 'HTTP_404', message: 'old failure' } });
  await env.fs.setSetting(`assetJobs:${account.accountKey}`, state);
  let refreshes = 0; env.dependencies.refreshConversation = async () => { refreshes++; throw new Error('must not refresh'); }; env.restart();
  await env.tick(); assert.equal(env.captures.length, 0); assert.equal(refreshes, 0);
  assert.equal(env.fs.text(saved.entry.jsonPath), original);
  const diagnostic = await env.service.diagnostics({ account });
  assert.equal(diagnostic.internalMissing, 1); assert.equal(diagnostic.internalFailures[0].attempt, 6);
});

test('legacy 404 migration verifies native bytes and never trusts a forged manifest capture policy', async t => {
  for (const kind of ['modified-native', 'normal-source']) await t.test(kind, async () => {
    const env = setup(), saved = await env.save(kind === 'normal-source' ? detail() : internalDetail());
    if (kind === 'modified-native') env.fs.put(saved.entry.jsonPath, '{"modified":true}');
    else {
      const manifest = await env.manifest(); manifest.conversations['conversation-one'].assets[0].capturePolicy = 'internal-viewer';
      env.fs.put(`${saved.entry.jsonPath.split('/conversations/')[0]}/archive/manifest.json`, JSON.stringify(manifest));
    }
    const state = await env.fs.getSetting(`assetJobs:${account.accountKey}`);
    Object.assign(state.tasks[0], { attempt: 3, retryAt: 99_000_000, error: { code: 'HTTP_404', message: 'old failure' } });
    await env.fs.setSetting(`assetJobs:${account.accountKey}`, state); await env.tick();
    assert.equal((await env.service.diagnostics({ account })).internalMissing, 0); assert.equal(env.captures.length, 0);
    if (kind === 'modified-native') assert.equal((await env.service.diagnostics({ account })).failures[0].code, 'LOCAL_CONFLICT');
  });
});

test('a rescan with a visible reference promotes a suspended internal attachment to ordinary capture', async () => {
  const env = setup(), source = internalDetail(); await env.save(source); failCapture(env, 'HTTP_404'); await env.tick();
  source.payload.mapping.reply.message.author.role = 'user';
  source.payload.mapping.reply.message.content = { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_internal' }] };
  await env.save(source);
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
  await env.tick(); assert.equal(env.captures.length, 2);
  const asset = (await env.manifest()).conversations['conversation-one'].assets[0];
  assert.equal(asset.capturePolicy, undefined); assert.equal(asset.autoRetrySuspended, undefined);
  assert.equal((await env.service.diagnostics({ account })).failed, 1);
});

test('a suspended metadata archive resumes delivery while paused after an outbox failure and worker restart', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); env.enqueueFailure(true);
  await env.tick(); const jobKey = `assetJobs:${account.accountKey}`;
  assert.equal((await env.fs.getSetting(jobKey)).tasks[0].pendingArchives.length, 1);
  env.enqueueFailure(false); env.time(1_000_000); env.restart();
  await env.service.tick({ directory: env.fs.directory, account, tabId: 7, manualOnly: true });
  assert.equal(env.enqueued.length, 1); assert.equal(env.captures.length, 1);
  const task = (await env.fs.getSetting(jobKey)).tasks[0]; assert.equal(task.autoRetrySuspended, true); assert.equal(task.pendingArchives.length, 0);
  assert.equal((await env.service.diagnostics({ account })).pending, 0);
});

test('HTTP 404 from source refresh or archive delivery does not suspend an ordinary internal capture task', async t => {
  for (const stage of ['refresh', 'delivery']) await t.test(stage, async () => {
    const env = setup(); await env.save(internalDetail());
    if (stage === 'refresh') {
      env.resolveFailure(true); await env.tick(); env.resolveFailure(false);
      env.dependencies.refreshConversation = async () => { throw Object.assign(new Error('missing conversation'), { code: 'HTTP_404' }); };
      env.restart(); await env.service.retryFailed({ account });
    } else {
      env.dependencies.enqueueArchive = async () => { throw Object.assign(new Error('outbox unavailable'), { code: 'HTTP_404' }); }; env.restart();
    }
    await env.tick(); env.time(1_000_000); await env.tick();
    assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
    assert.equal((await env.service.diagnostics({ account })).failed, 1);
  });
});

test('restore hydration recreates suspended manual retry jobs from verified native data and stays idempotent', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); await env.tick();
  const entry = (await env.manifest()).conversations['conversation-one'];
  await env.fs.setSetting(`assetJobs:${account.accountKey}`, null); env.restart();
  const input = { directory: env.fs.directory, account, entry, config, snapshot: { entries: [] } };
  await env.service.hydrateAssets(input); await env.service.hydrateAssets(input);
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 1);
  assert.equal((await env.service.diagnostics({ directory: env.fs.directory, account })).internalMissing, 1);
  await env.tick(); assert.equal(env.captures.length, 1);
  await env.service.retryFailed({ account, includeInternal: true }); await env.tick(); assert.equal(env.captures.length, 2);
});

test('a worker stop after writing suspended metadata recovers its outbox without downloading again', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404');
  const jobKey = `assetJobs:${account.accountKey}`; let interrupt = true;
  env.dependencies.setSetting = async (key, value) => {
    if (interrupt && key === jobKey && value?.tasks.some(task => task.pendingArchives?.length)) throw new Error('synthetic stop');
    return env.fs.setSetting(key, value);
  };
  env.restart(); await assert.rejects(env.tick(), /synthetic stop/);
  assert.equal((await env.manifest()).conversations['conversation-one'].assets[0].autoRetrySuspended, true);
  interrupt = false; env.restart(); await env.tick();
  assert.equal(env.captures.length, 1); assert.equal(env.enqueued.length, 1);
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 1);
});

test('manual retry source failures release stale suspension and persist the actual error for ordinary backoff', async t => {
  for (const code of ['HTTP_401', 'HTTP_403', 'HTTP_404']) await t.test(code, async () => {
    const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); await env.tick();
    let refreshes = 0;
    env.dependencies.refreshConversation = async () => { refreshes++; throw Object.assign(new Error('source unavailable'), { code }); };
    env.restart(); await env.service.retryFailed({ account, includeInternal: true }); await env.tick();
    const diagnostic = await env.service.diagnostics({ account });
    assert.equal(diagnostic.internalMissing, 0); assert.equal(diagnostic.failed, 1); assert.equal(diagnostic.failures[0].code, code);
    const asset = (await env.manifest()).conversations['conversation-one'].assets[0];
    assert.equal(asset.autoRetrySuspended, undefined); assert.equal(asset.errorCode, code);
    env.time(9_000_000); await env.tick(); assert.equal(refreshes, 2);
    assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
  });
});

test('manual retry with a live visible reference persists promotion even when image download still returns 404', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); await env.tick();
  const online = internalDetail(); online.payload.mapping.viewer.message.author = { role: 'user' };
  env.dependencies.refreshConversation = async () => online; env.restart();
  await env.service.retryFailed({ account, includeInternal: true }); await env.tick();
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
  assert.equal((await env.manifest()).conversations['conversation-one'].assets[0].autoRetrySuspended, undefined);
  env.time(9_000_000); await env.tick(); assert.equal(env.captures.length, 3);
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
});

test('restore releases old suspended jobs when remote native makes the attachment visible', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); await env.tick();
  const source = internalDetail(); source.payload.mapping.viewer.message.author = { role: 'user' };
  const saved = await env.store.saveConversation({ directory: env.fs.directory, account, detail: source, assets: await extractAssets(source.payload) });
  await env.service.hydrateAssets({ directory: env.fs.directory, account, entry: saved.entry, config, snapshot: { entries: [] } });
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
  await env.tick(); assert.equal(env.captures.length, 2);
  assert.equal((await env.service.diagnostics({ account })).failed, 1);
});

test('ready winners clear stale internal jobs during restore and rescan without another download', async t => {
  for (const method of ['restore', 'rescan']) await t.test(method, async () => {
    const env = setup(), source = internalDetail(); await env.save(source); failCapture(env, 'HTTP_404'); await env.tick();
    const old = (await env.manifest()).conversations['conversation-one'].assets[0], oid = await hashBytes(PNG);
    const asset = { ...old, status: 'downloaded', oid, size: PNG.length, localPath: assetPath(account, oid, 'png') };
    delete asset.autoRetrySuspended; delete asset.errorCode; env.fs.put(asset.localPath, PNG);
    const saved = await env.store.saveConversation({ directory: env.fs.directory, account, detail: source, assets: [asset] });
    if (method === 'restore') await env.service.hydrateAssets({ directory: env.fs.directory, account, entry: saved.entry, config, snapshot: { entries: [] } });
    else await env.save(source);
    assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
    await env.tick(); assert.equal(env.captures.length, 1);
    assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 0);
    assert.equal((await env.manifest()).conversations['conversation-one'].assets[0].status, 'downloaded');
  });
});

test('a rescan cannot turn a known source-refresh 404 into legacy internal attachment migration', async () => {
  const env = setup(), source = internalDetail(); await env.save(source); env.resolveFailure(true); await env.tick();
  let refreshes = 0;
  env.dependencies.refreshConversation = async () => { refreshes++; throw Object.assign(new Error('conversation missing'), { code: 'HTTP_404' }); };
  env.restart(); await env.service.retryFailed({ account }); await env.tick();
  assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks[0].errorStage, 'source');
  await env.save(source); env.time(9_000_000); env.restart(); await env.tick();
  assert.equal(refreshes, 2); assert.equal(env.captures.length, 1);
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
  assert.equal((await env.service.diagnostics({ account })).failed, 1);
  assert.equal((await env.manifest()).conversations['conversation-one'].assets[0].autoRetrySuspended, undefined);
});

test('tick reconciles suspended jobs after direct GitHub winner application without restore hydration or rescan', async t => {
  for (const winner of ['visible', 'ready']) await t.test(winner, async () => {
    const env = setup(), source = internalDetail(); await env.save(source); failCapture(env, 'HTTP_404'); await env.tick();
    let assets;
    if (winner === 'visible') {
      source.payload.mapping.viewer.message.author = { role: 'user' }; assets = await extractAssets(source.payload);
    } else {
      const old = (await env.manifest()).conversations['conversation-one'].assets[0], oid = await hashBytes(PNG);
      const asset = { ...old, status: 'downloaded', oid, size: PNG.length, localPath: assetPath(account, oid, 'png') };
      delete asset.autoRetrySuspended; delete asset.errorCode; env.fs.put(asset.localPath, PNG); assets = [asset];
    }
    await env.store.saveConversation({ directory: env.fs.directory, account, detail: source, assets });
    env.restart(); await env.tick();
    assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
    if (winner === 'visible') { assert.equal(env.captures.length, 2); assert.equal((await env.service.diagnostics({ account })).failed, 1); }
    else { assert.equal(env.captures.length, 1); assert.equal((await env.fs.getSetting(`assetJobs:${account.accountKey}`)).tasks.length, 0); }
  });
});

test('direct remote promotion drains older suspended receipts before starting required capture', async () => {
  const env = setup(), source = internalDetail(); await env.save(source); failCapture(env, 'HTTP_404'); env.enqueueFailure(true); await env.tick();
  source.payload.mapping.viewer.message.author = { role: 'user' };
  await env.store.saveConversation({ directory: env.fs.directory, account, detail: source, assets: await extractAssets(source.payload) });
  env.enqueueFailure(false); env.time(9_000_000); env.restart(); await env.tick();
  assert.equal(env.enqueued.length, 1); assert.equal(env.captures.length, 1);
  await env.tick(); assert.equal(env.captures.length, 2);
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
});

test('unavailable metadata delivery after restart retains the ordinary capture task until bytes are fetched', async () => {
  const env = setup(); await env.save(internalDetail()); failCapture(env, 'HTTP_404'); await env.tick();
  let refreshes = 0;
  env.dependencies.refreshConversation = async () => { refreshes++; throw Object.assign(new Error('session expired'), { code: 'HTTP_401' }); };
  env.restart(); env.enqueueFailure(true); await env.service.retryFailed({ account, includeInternal: true }); await env.tick();
  const jobKey = `assetJobs:${account.accountKey}`;
  assert.equal((await env.fs.getSetting(jobKey)).tasks[0].captureIncomplete, true);
  env.restart(); env.enqueueFailure(false); env.time(9_000_000); await env.tick();
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 1);
  assert.equal((await env.service.diagnostics({ account })).internalMissing, 0);
  assert.equal(refreshes, 1); await env.tick(); assert.equal(refreshes, 2);
  assert.equal((await env.fs.getSetting(jobKey)).tasks.length, 1);
});
