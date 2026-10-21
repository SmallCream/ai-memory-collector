import test from 'node:test';
import assert from 'node:assert/strict';
import { assetPath, validateAssetPath, readLocalBytes, verifiedLocalAsset, writeLocalAsset, imageExtension, MAX_ASSET_BYTES } from '../extension/lib/asset-store.js';
import { hashBytes } from '../extension/lib/lfs.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const account = { platform: 'chatgpt', accountKey: 'acct-test', storageKey: 'demo' };
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64'));
async function input(fs, bytes = PNG) {
  const oid = await hashBytes(bytes);
  return { directory: fs.directory, account, asset: { oid, size: bytes.length, localPath: assetPath(account, oid, 'png') }, bytes,
    getSetting: fs.getSetting, setSetting: fs.setSetting };
}

test('content-addressed binary write verifies exact bytes and repeated writes are idempotent', async () => {
  const fs = memoryBinaryFs(), value = await input(fs);
  assert.equal(await writeLocalAsset(value), true);
  assert.deepEqual(await verifiedLocalAsset(value), PNG);
  assert.equal(await writeLocalAsset(value), false); assert.equal(fs.writes.length, 1);
  assert.ok([...fs.settings.values()].every(item => item === null));
});

test('manually edited nonempty and zero-byte files are preserved without a recovery journal', async () => {
  for (const manual of [new Uint8Array([1, 2, 3]), new Uint8Array()]) {
    const fs = memoryBinaryFs(), value = await input(fs); fs.put(value.asset.localPath, manual);
    await assert.rejects(writeLocalAsset(value), { code: 'ASSET_LOCAL_CONFLICT' });
    assert.deepEqual(fs.files.get(value.asset.localPath), manual); assert.equal(fs.writes.length, 0);
  }
});

test('first-create interruption leaves a durable ownership record and repairs only its own empty file', async () => {
  const fs = memoryBinaryFs(), value = await input(fs); fs.fail(() => true);
  await assert.rejects(writeLocalAsset(value), { code: 'ASSET_WRITE' });
  assert.equal(fs.files.get(value.asset.localPath).length, 0);
  assert.equal([...fs.settings.values()].filter(Boolean).length, 1);
  assert.equal(await verifiedLocalAsset(value), null);
  fs.fail(null);
  assert.equal(await writeLocalAsset({ ...value, directory: fs.directory }), true);
  assert.deepEqual(fs.files.get(value.asset.localPath), PNG);
});

test('manual bytes in a previously failed write are never overwritten on retry', async () => {
  const fs = memoryBinaryFs(), value = await input(fs); fs.fail(() => true);
  await assert.rejects(writeLocalAsset(value), { code: 'ASSET_WRITE' });
  fs.fail(null); fs.put(value.asset.localPath, new Uint8Array([9, 8]));
  await assert.rejects(writeLocalAsset(value), { code: 'ASSET_LOCAL_CONFLICT' });
  assert.deepEqual(fs.files.get(value.asset.localPath), new Uint8Array([9, 8]));
});

test('journal belongs to the original directory and cannot repair another directory', async () => {
  const fs = memoryBinaryFs(), other = memoryBinaryFs(), value = await input(fs); fs.fail(() => true);
  await assert.rejects(writeLocalAsset(value), { code: 'ASSET_WRITE' });
  await assert.rejects(writeLocalAsset({ ...value, directory: other.directory }), { code: 'DIRECTORY_CHANGED' });
  assert.equal(other.files.size, 0);
});

test('verified journal survives failed clearing without permitting subsequent manual truncation', async () => {
  const fs = memoryBinaryFs(), value = await input(fs); fs.failClear(true);
  await assert.rejects(writeLocalAsset(value), /checkpoint clear/);
  assert.equal([...fs.settings.values()].find(Boolean).phase, 'verified');
  fs.put(value.asset.localPath, new Uint8Array()); fs.failClear(false);
  await assert.rejects(writeLocalAsset(value), { code: 'ASSET_LOCAL_CONFLICT' });
  assert.equal(fs.files.get(value.asset.localPath).length, 0);
});

test('invalid hash, account path and oversized bytes fail before file writes', async () => {
  const fs = memoryBinaryFs(), value = await input(fs);
  assert.throws(() => validateAssetPath(account, value.asset.localPath, '['), { code: 'ASSET_PATH' });
  assert.throws(() => validateAssetPath({ ...account, storageKey: 'other' }, value.asset.localPath, value.asset.oid), { code: 'ASSET_PATH' });
  await assert.rejects(writeLocalAsset({ ...value, bytes: new Uint8Array([1]) }), { code: 'ASSET_HASH' });
  await assert.rejects(writeLocalAsset({ ...value, bytes: new Uint8Array(MAX_ASSET_BYTES + 1) }), { code: 'ASSET_HASH' });
  assert.equal(fs.files.size, 0);
});

test('filesystem permission and native file read bounds are enforced', async () => {
  const fs = memoryBinaryFs(), value = await input(fs); fs.permission('prompt');
  await assert.rejects(writeLocalAsset(value), { code: 'DIRECTORY_PERMISSION' });
  fs.permission('granted'); fs.put('data/file.json', '12345');
  await assert.rejects(readLocalBytes(fs.directory, 'data/file.json', 4), { code: 'ASSET_SIZE' });
  assert.equal(imageExtension(PNG), 'png');
  assert.throws(() => imageExtension(new Uint8Array([1, 2, 3])), { code: 'ASSET_NOT_IMAGE' });
});

test('concurrent writes serialize before sharing a pending journal', async () => {
  const fs = memoryBinaryFs(), value = await input(fs);
  assert.deepEqual(await Promise.all([writeLocalAsset(value), writeLocalAsset(value)]), [true, false]);
  assert.equal(fs.writes.length, 1);
});
