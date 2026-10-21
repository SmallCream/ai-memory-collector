import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAssets, sanitizeAssetRecords, reconcileAssetCapturePolicy } from '../extension/lib/assets.js';

const attachment = () => ({ id: 'file_synthetic_viewer', name: 'user-synthetic/run/mnt/data/image.png',
  mime_type: 'image/png', size: 100 });
const viewer = () => ({ id: 'synthetic-viewer', author: { role: 'tool', name: 'container.open_image' },
  content: { content_type: 'execution_output', text: '<<ImageDisplayed>>' }, metadata: { attachments: [attachment()] } });

test('only known internal viewer attachment results receive the internal capture policy without changing native JSON', async () => {
  const source = { mapping: { viewer: { message: viewer() } } }, original = structuredClone(source);
  const [asset] = await extractAssets(source);
  assert.equal(asset.capturePolicy, 'internal-viewer');
  assert.equal(asset.status, 'pending');
  assert.equal(asset.autoRetrySuspended, undefined);
  assert.equal(asset.fileId, attachment().id);
  assert.equal(asset.occurrences[0].messageId, 'synthetic-viewer');
  assert.match(asset.occurrences[0].path, /metadata\/attachments\/0$/);
  assert.deepEqual(source, original);
});

test('ordinary images and other tools remain mandatory regardless of filename or a viewer-like name', async () => {
  for (const change of [
    message => { message.author.role = 'user'; },
    message => { message.author.role = 'assistant'; },
    message => { message.author.name = 'python'; },
    message => { message.author.name = 'imagegen'; },
    message => { message.author.name = 'container.open_image_extra'; },
    message => { message.content.content_type = 'multimodal_text'; },
    message => { delete message.author; },
    message => { message.content.parts = [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${attachment().id}` }];
      delete message.metadata; },
  ]) {
    const message = viewer(); change(message);
    const [asset] = await extractAssets({ messages: [message] });
    assert.ok(asset);
    assert.equal(asset.capturePolicy, undefined);
  }
});

test('any ordinary occurrence wins over a known viewer occurrence independent of traversal order', async () => {
  for (const role of ['user', 'assistant', 'tool']) {
    const message = { id: `synthetic-${role}`, author: { role, name: role === 'tool' ? 'imagegen' : undefined },
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer',
        asset_pointer: `sediment://${attachment().id}` }] } };
    for (const messages of [[viewer(), message], [message, viewer()]]) {
      const [asset, ...others] = await extractAssets({ messages });
      assert.equal(others.length, 0);
      assert.equal(asset.capturePolicy, undefined);
      assert.equal(asset.occurrences.length, 2);
    }
  }
});

test('a known viewer content image is not silently downgraded merely because it also has an attachment', async () => {
  const message = viewer();
  message.content.text = `![output](file-service://${attachment().id})`;
  const [asset] = await extractAssets({ messages: [message] });
  assert.equal(asset.occurrences.length, 2);
  assert.equal(asset.capturePolicy, undefined);
});

test('policy metadata sanitizes narrowly and never suspends ready assets or non-404 failures', async () => {
  const [asset] = await extractAssets({ messages: [viewer()] });
  const missing = { ...asset, status: 'unavailable', autoRetrySuspended: true, errorCode: 'HTTP_404' };
  assert.equal(sanitizeAssetRecords([missing])[0].autoRetrySuspended, true);
  for (const change of [
    { capturePolicy: 'unknown-tool' }, { capturePolicy: undefined }, { autoRetrySuspended: 'true' },
    { errorCode: 'HTTP_401' }, { errorCode: 'HTTP_403' }, { errorCode: 'HTTP_429' }, { errorCode: 'NETWORK' },
    ...['downloaded', 'ready', 'local', 'synced', 'external'].map(status => ({ status })),
  ]) assert.equal(sanitizeAssetRecords([{ ...missing, ...change }])[0].autoRetrySuspended, undefined);
  assert.equal(sanitizeAssetRecords([{ ...missing, capturePolicy: 'unknown-tool' }])[0].capturePolicy, undefined);
});

test('policy reconciliation trusts current extracted identity and preserves no unsupported suspension', async () => {
  const [fresh] = await extractAssets({ messages: [viewer()] });
  const missing = { ...fresh, status: 'unavailable', autoRetrySuspended: true, errorCode: 'HTTP_404' };
  assert.equal(reconcileAssetCapturePolicy(missing, fresh).autoRetrySuspended, true);
  for (const current of [undefined, { ...fresh, id: 'different' }, { ...fresh, capturePolicy: undefined }]) {
    const reconciled = reconcileAssetCapturePolicy(missing, current);
    assert.equal(reconciled.capturePolicy, undefined);
    assert.equal(reconciled.autoRetrySuspended, undefined);
    assert.equal(reconciled.errorCode, 'HTTP_404');
  }
  assert.equal(reconcileAssetCapturePolicy({ ...missing, status: 'downloaded' }, fresh).autoRetrySuspended, undefined);
  assert.equal(reconcileAssetCapturePolicy({ ...missing, errorCode: 'HTTP_403' }, fresh).autoRetrySuspended, undefined);
  const result = reconcileAssetCapturePolicy(fresh, fresh);
  assert.equal(result.retrieval, fresh.retrieval);
  assert.equal(Object.keys(result).includes('retrieval'), false);
});
