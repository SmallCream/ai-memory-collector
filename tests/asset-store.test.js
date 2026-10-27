import test from 'node:test';
import assert from 'node:assert/strict';
import { assetPath, validateAssetPath, readLocalBytes, verifiedLocalAsset, writeLocalAsset, imageExtension, assetExtension, inspectAttachmentBytes, canCaptureAsset, MAX_ASSET_BYTES } from '../extension/lib/asset-store.js';
import { hashBytes } from '../extension/lib/asset-store.js';
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


const ZIP = new Uint8Array(Buffer.from('UEsDBBQAAAAAAIaLVl2fm+xuBwAAAAcAAAAKAAAAUkVBRE1FLnR4dGV4YW1wbGVQSwECFAMUAAAAAACGi1Zdn5vsbgcAAAAHAAAACgAAAAAAAAAAAAAAgAEAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAAAvAAAAAAA=', 'base64'));
test('PowerShell attachments preserve UTF8 bytes and reject HTML or binary responses', async () => {
  const bytes = new TextEncoder().encode('\ufeff# 示例\r\nWrite-Output "archive only"\r\n');
  const hint = { fileName: 'example.ps1', mimeType: 'text/plain' };
  assert.equal(assetExtension(bytes, hint), 'ps1');
  for (const bad of [new TextEncoder().encode('<html>Expired</html>'), new Uint8Array([255, 0, 254])]) {
    assert.equal(inspectAttachmentBytes(bad, hint), null);
  }
  assert.equal(inspectAttachmentBytes(bytes, { ...hint, mimeType: 'text/html' }), null);
  const fs = memoryBinaryFs(), value = await input(fs, bytes);
  value.asset.localPath = assetPath(account, value.asset.oid, 'ps1');
  assert.equal(validateAssetPath(account, value.asset.localPath, value.asset.oid), value.asset.localPath);
  await writeLocalAsset(value);
  assert.deepEqual(await verifiedLocalAsset(value), bytes);
});

test('32 MiB attachment boundary accepts and stores files above the previous 16 MiB limit', async () => {
  assert.equal(MAX_ASSET_BYTES, 32 * 1024 * 1024);
  const bytes = new Uint8Array(20 * 1024 * 1024).fill(97);
  assert.equal(assetExtension(bytes, { fileName: 'large.txt', mimeType: 'text/plain' }), 'txt');
  const fs = memoryBinaryFs(), value = await input(fs, bytes);
  value.asset.localPath = assetPath(account, value.asset.oid, 'txt');
  await writeLocalAsset(value);
  assert.equal((await verifiedLocalAsset(value)).byteLength, bytes.byteLength);
  const edge = new Uint8Array(MAX_ASSET_BYTES).fill(97);
  assert.equal(inspectAttachmentBytes(edge, { fileName: 'edge.txt' }).extension, 'txt');
  assert.equal(inspectAttachmentBytes(new Uint8Array(MAX_ASSET_BYTES + 1), { fileName: 'oversize.txt' }), null);
});
const OFFICE = {
  docx: 'UEsDBBQAAAAAAIaLVl3HHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAIaLVl2fm+xuBwAAAAcAAAARAAAAd29yZC9kb2N1bWVudC54bWxleGFtcGxlUEsBAhQDFAAAAAAAhotWXcccFzwIAAAACAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAAAACGi1Zdn5vsbgcAAAAHAAAAEQAAAAAAAAAAAAAAgAE5AAAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAIAAgCAAAAAbwAAAAAA',
  xlsx: 'UEsDBBQAAAAAAIaLVl3HHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAIaLVl2fm+xuBwAAAAcAAAAPAAAAeGwvd29ya2Jvb2sueG1sZXhhbXBsZVBLAQIUAxQAAAAAAIaLVl3HHBc8CAAAAAgAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAAAhotWXZ+b7G4HAAAABwAAAA8AAAAAAAAAAAAAAIABOQAAAHhsL3dvcmtib29rLnhtbFBLBQYAAAAAAgACAH4AAABtAAAAAAA=',
  pptx: 'UEsDBBQAAAAAAIaLVl3HHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAIaLVl2fm+xuBwAAAAcAAAAUAAAAcHB0L3ByZXNlbnRhdGlvbi54bWxleGFtcGxlUEsBAhQDFAAAAAAAhotWXcccFzwIAAAACAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAAAACGi1Zdn5vsbgcAAAAHAAAAFAAAAAAAAAAAAAAAgAE5AAAAcHB0L3ByZXNlbnRhdGlvbi54bWxQSwUGAAAAAAIAAgCDAAAAcgAAAAAA',
};

test('binary attachment inspection verifies ZIP structure and Office container names without extracting', () => {
  assert.deepEqual(inspectAttachmentBytes(ZIP, { fileName: 'download.zip', mimeType: 'application/octet-stream' }), { extension: 'zip', mimeType: 'application/zip' });
  for (const [extension, fixture] of Object.entries(OFFICE)) {
    assert.equal(assetExtension(new Uint8Array(Buffer.from(fixture, 'base64')), { fileName: `document.${extension}` }), extension);
    assert.equal(inspectAttachmentBytes(ZIP, { fileName: `document.${extension}` }), null);
  }
  assert.equal(inspectAttachmentBytes(ZIP.subarray(0, ZIP.length - 1), { fileName: 'download.zip' }), null);
  const corrupt = new Uint8Array(ZIP); corrupt[47] = 0;
  assert.equal(inspectAttachmentBytes(corrupt, { fileName: 'download.zip' }), null);
  assert.equal(inspectAttachmentBytes(ZIP, { fileName: 'download.zip', mimeType: 'text/html' }), null);
  assert.throws(() => assetExtension(PNG, { fileName: 'download.zip', mimeType: 'image/png' }), { code: 'ASSET_FORMAT' });
});

test('PDF and UTF8 attachment formats reject HTML, broken JSON, binary text, and conflicting suffixes', () => {
  const encode = value => new TextEncoder().encode(value);
  const pdf = encode('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n');
  assert.equal(assetExtension(pdf, { fileName: 'document.pdf' }), 'pdf');
  assert.equal(inspectAttachmentBytes(pdf, { fileName: 'document.zip' }), null);
  assert.equal(inspectAttachmentBytes(encode('%PDF-1.7\ntruncated'), { fileName: 'document.pdf' }), null);
  assert.equal(assetExtension(encode('# 下载文件\n'), { fileName: 'notes.md' }), 'md');
  assert.equal(assetExtension(encode('{"ok":true}'), { fileName: 'data.json' }), 'json');
  for (const [content, fileName] of [['<!doctype html><html>Sign in</html>', 'download.zip'], ['<html>Sign in</html>', 'notes.txt'], ['{broken', 'data.json'], ['bad\u0000bytes', 'notes.txt']]) {
    assert.throws(() => assetExtension(encode(content), { fileName }), { code: 'ASSET_FORMAT' });
  }
  assert.equal(inspectAttachmentBytes(new Uint8Array([255, 254, 1]), { fileName: 'notes.txt' }), null);
  assert.equal(inspectAttachmentBytes(encode('unknown'), {}), null);
});

test('generic attachments use the same account-scoped content hashes and protected writes as images', async () => {
  const fs = memoryBinaryFs(), oid = await hashBytes(ZIP), asset = { oid, size: ZIP.length, localPath: assetPath(account, oid, 'zip') };
  const value = { directory: fs.directory, account, asset, bytes: ZIP, getSetting: fs.getSetting, setSetting: fs.setSetting };
  assert.equal(await writeLocalAsset(value), true); assert.deepEqual(await verifiedLocalAsset(value), ZIP);
  assert.equal(await writeLocalAsset(value), false);
  assert.throws(() => validateAssetPath({ ...account, storageKey: 'another' }, asset.localPath, oid), { code: 'ASSET_PATH' });
  fs.put(asset.localPath, new Uint8Array([1, 2]));
  await assert.rejects(writeLocalAsset(value), { code: 'ASSET_LOCAL_CONFLICT' });
  assert.throws(() => assetPath(account, oid, '../zip'), { code: 'ASSET_PATH' });
  assert.equal(canCaptureAsset({ kind: 'attachment', sourceType: 'platform', sourceRef: 'sandbox:/mnt/data/download.zip' }), true);
  assert.equal(canCaptureAsset({ kind: 'attachment', sourceType: 'external', sourceRef: 'https://example.org/' }), false);
});
