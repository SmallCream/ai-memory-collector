import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetService } from '../extension/lib/asset-service.js';
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
