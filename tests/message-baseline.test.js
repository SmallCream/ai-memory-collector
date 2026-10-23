import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNativeConversation } from '../extension/lib/archive.js';
import { createArchiveStore, readAccountManifest, readConversationBaseline, accountPrefix } from '../extension/lib/archive-store.js';
import { sanitizeMessageSync, selectMessageSync } from '../extension/lib/message-sync-receipt.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const account = { platform: 'chatgpt', accountKey: 'acct-0123456789abcdef01234567',
  alias: 'demo', storageKey: 'demo-01234567' };
const identity = { platform: 'chatgpt', accountKey: account.accountKey, displayName: 'Demo' };
const checkedAt = Date.parse('2026-10-21T08:00:00Z');
const fullMeta = (extra = {}) => ({ schemaVersion: 1, format: 'flat', mode: 'full', scope: 'selected-branch',
  fullReadAt: checkedAt, checkedAt, incrementalRuns: 0, pagesRead: 2, fetchedMessages: 6,
  reusedMessages: 0, addedMessages: 6, updatedMessages: 0, ...extra });
const tailMeta = (extra = {}) => fullMeta({ mode: 'tail-merge', checkedAt: checkedAt + 60_000,
  incrementalRuns: 1, pagesRead: 1, fetchedMessages: 4, reusedMessages: 3, addedMessages: 1, ...extra });
function flat(count = 6, revision = 0) {
  const messages = Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`,
    author: { role: index % 2 ? 'assistant' : 'user' }, status: 'finished_successfully',
    content: { content_type: 'text', parts: [`Message ${index + 1}`] } }));
  return { identity, completeness: 'complete', capturedAt: new Date(checkedAt + revision * 60_000).toISOString(), payload: {
    conversation_id: 'demo', title: 'Synthetic conversation', create_time: 1792483200,
    update_time: 1792569600 + revision * 60, messages, current_node: messages.at(-1)?.id || 'root',
    page_info: { start_cursor: messages[0]?.id || null, end_cursor: messages.at(-1)?.id || null,
      has_previous_page: false, has_next_page: false },
  } };
}
function tree(revision = 0) {
  const result = flat(6, revision), mapping = { root: { parent: null, message: null } };
  let parent = 'root';
  for (const message of result.payload.messages) {
    mapping[message.id] = { parent, message };
    parent = message.id;
  }
  // An abandoned branch proves why a selected-branch replacement is lossy.
  mapping.alternative = { parent: 'm1', message: { id: 'alternative', author: { role: 'assistant' },
    content: { parts: ['Previous answer'] }, status: 'finished_successfully' } };
  delete result.payload.messages;
  delete result.payload.page_info;
  result.payload.mapping = mapping;
  return result;
}
function setup() {
  const fs = memoryBinaryFs(), store = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
  return { fs, store, save: detail => store.saveConversation({ directory: fs.directory, account, detail }),
    baseline: () => store.readConversationBaseline(fs.directory, account, 'demo') };
}
async function setEntry(f, mutate) {
  const manifest = await readAccountManifest(f.fs.directory, account);
  mutate(manifest.conversations.demo);
  f.fs.put(`${accountPrefix(account)}/archive/manifest.json`, JSON.stringify(manifest));
}
const digest = async text => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');

test('message fingerprints reuse native sanitization without mutating data or hiding quoted text', () => {
  const source = { authorization: 'secret', metadata: { download_url: 'https://example.test/image?id=file-1&sig=secret' },
    content: { parts: ['https://example.test/?token=quoted', 'Authorization: quoted text'] } };
  const sanitized = sanitizeNativeConversation(source);
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.metadata.download_url, 'https://example.test/image?id=file-1');
  assert.deepEqual(sanitized.content.parts, source.content.parts);
  assert.equal(source.authorization, 'secret');
  assert.match(source.metadata.download_url, /sig=secret/);
});

test('message baseline accepts only a complete, hash-verified archive belonging to the requested account', async () => {
  const f = setup(), saved = await f.save({ ...flat(), messageSync: fullMeta() });
  const baseline = await f.baseline();
  assert.equal(baseline.entry.contentHash, saved.entry.contentHash);
  assert.deepEqual(baseline.payload, JSON.parse(f.fs.text(saved.entry.jsonPath)));
  assert.deepEqual(baseline.entry.messageSync, fullMeta());
  await assert.rejects(readConversationBaseline(f.fs.directory, { ...account, accountKey: 'acct-other' }, 'demo', { get: f.fs.getSetting }),
    { code: 'ACCOUNT_MISMATCH' });
  f.fs.permission('prompt');
  await assert.rejects(f.baseline(), { code: 'DIRECTORY_PERMISSION' });
});

test('missing or unconfirmed native archives do not become incremental baselines', async t => {
  const empty = setup();
  assert.equal(await empty.baseline(), null);
  for (const state of ['missing-file', 'empty-file', 'unknown-completeness']) await t.test(state, async () => {
    const f = setup(), saved = await f.save(flat());
    if (state === 'missing-file') f.fs.files.delete(saved.entry.jsonPath);
    else if (state === 'empty-file') f.fs.put(saved.entry.jsonPath, '');
    else await setEntry(f, entry => { entry.sourceCompleteness = 'unknown'; });
    assert.equal(await f.baseline(), null);
  });
});

test('baseline reads reject edited JSON, mismatched IDs and source pagination that contradicts the manifest', async t => {
  for (const state of ['edited', 'wrong-id', 'partial']) await t.test(state, async () => {
    const f = setup(), saved = await f.save(flat());
    const native = JSON.parse(f.fs.text(saved.entry.jsonPath));
    if (state === 'edited') native.title = 'Manual edit';
    else if (state === 'wrong-id') native.conversation_id = 'other';
    else native.page_info.has_previous_page = true;
    const text = JSON.stringify(native);
    f.fs.put(saved.entry.jsonPath, text);
    if (state !== 'edited') {
      const hash = await digest(text);
      await setEntry(f, entry => { entry.contentHash = hash; });
    }
    await assert.rejects(f.baseline(), { code: state === 'edited' ? 'LOCAL_CONFLICT' : state === 'wrong-id' ? 'ARCHIVE_FORMAT' : 'PARTIAL_DETAIL' });
  });
});

test('message sync metadata is whitelisted and survives only unchanged-source derivative updates', async () => {
  const f = setup(), original = flat();
  const saved = await f.save({ ...original, messageSync: { ...fullMeta(), token: 'never-persist', payload: { secret: true } } });
  assert.deepEqual(saved.entry.messageSync, fullMeta());
  const repeated = await f.save(original);
  assert.deepEqual(repeated.entry.messageSync, fullMeta());
  const changed = await f.save(flat(7, 1));
  assert.equal(changed.entry.messageSync, undefined, 'unknown capture must not inherit a previous full verification');
  assert.doesNotMatch(f.fs.text(`${accountPrefix(account)}/archive/manifest.json`), /never-persist/);
});

test('a pending archive journal suppresses a half-written baseline until the writer recovers', async () => {
  const f = setup(), original = await f.save({ ...flat(), messageSync: fullMeta() });
  f.fs.fail(path => path === original.entry.markdownPath);
  const changed = { ...flat(7, 1), messageSync: tailMeta(), baselineContentHash: original.entry.contentHash };
  await assert.rejects(f.save(changed), { code: 'LOCAL_WRITE' });
  assert.notEqual(await digest(f.fs.text(original.entry.jsonPath)), original.entry.contentHash);
  assert.equal(await f.baseline(), null);
  f.fs.fail(null);
  await f.save(changed);
  assert.equal((await f.baseline()).payload.messages.length, 7);
});

test('tail metadata preserves the last full read time and cannot claim a fresh full verification', async () => {
  const f = setup();
  const original = await f.save({ ...flat(), messageSync: fullMeta() });
  const merged = await f.save({ ...flat(7, 1), messageSync: tailMeta(), baselineContentHash: original.entry.contentHash });
  assert.deepEqual(merged.entry.messageSync, tailMeta());
  const before = f.fs.text(merged.entry.jsonPath);
  await assert.rejects(f.save({ ...flat(8, 2), baselineContentHash: merged.entry.contentHash,
    messageSync: tailMeta({ checkedAt: checkedAt + 120_000, fullReadAt: checkedAt + 60_000, incrementalRuns: 2 }) }),
  { code: 'PARTIAL_DETAIL' });
  assert.equal(f.fs.text(merged.entry.jsonPath), before);
});

test('malformed or format-incompatible sync metadata never marks an archive as freshly checked', async t => {
  for (const meta of [fullMeta({ checkedAt: -1 }), fullMeta({ fullReadAt: checkedAt + 1 }),
    fullMeta({ pagesRead: -1 }), fullMeta({ incrementalRuns: 1 }), fullMeta({ reusedMessages: 1 }),
    fullMeta({ format: 'tree', scope: 'returned-tree' }), fullMeta({ scope: 'foreign' })]) {
    await t.test(JSON.stringify(meta), async () => {
      const f = setup(), saved = await f.save({ ...flat(), messageSync: meta });
      assert.equal(saved.entry.messageSync, undefined);
    });
  }
});

test('restoring a hash-verified tail archive preserves its original full read timestamp', async () => {
  const source = setup(), destination = setup();
  const original = await source.save({ ...flat(), messageSync: fullMeta() });
  const merged = await source.save({ ...flat(7, 1), messageSync: tailMeta(), baselineContentHash: original.entry.contentHash });
  const restored = await destination.store.applyRemoteFiles({ directory: destination.fs.directory, account, files: merged.files });
  assert.deepEqual(restored.entry.messageSync, tailMeta());
  assert.equal((await destination.baseline()).entry.messageSync.fullReadAt, checkedAt);
});

test('tail writes require the exact validated native baseline and reject a concurrent newer full capture', async t => {
  for (const state of ['missing-hash', 'wrong-hash', 'concurrent-full']) await t.test(state, async () => {
    const f = setup(), original = await f.save({ ...flat(), messageSync: fullMeta() });
    const incoming = { ...flat(7, 1), messageSync: tailMeta() };
    if (state === 'wrong-hash') incoming.baselineContentHash = 'f'.repeat(64);
    else if (state === 'concurrent-full') {
      incoming.baselineContentHash = original.entry.contentHash;
      const refreshed = flat(7, 1);
      refreshed.payload.messages[0].content.parts = ['History corrected during the pending request'];
      await f.save({ ...refreshed, messageSync: fullMeta({ fullReadAt: checkedAt + 30_000,
        checkedAt: checkedAt + 30_000, fetchedMessages: 7, addedMessages: 1, updatedMessages: 1 }) });
    }
    const manifest = await readAccountManifest(f.fs.directory, account);
    const path = manifest.conversations.demo.jsonPath, before = f.fs.text(path), writes = f.fs.writes.length;
    await assert.rejects(f.save(incoming), { code: 'LOCAL_CONFLICT' });
    assert.equal(f.fs.text(path), before);
    assert.equal(f.fs.writes.length, writes);
  });
});

test('same-native remote reconciliation retains the more recent full verification despite a later tail check', async () => {
  const source = setup(), destination = setup();
  const original = await source.save({ ...flat(), messageSync: fullMeta() });
  const remote = await source.save({ ...flat(7, 1), messageSync: tailMeta(), baselineContentHash: original.entry.contentHash });
  const localMeta = fullMeta({ fullReadAt: checkedAt + 30_000, checkedAt: checkedAt + 30_000,
    fetchedMessages: 7, addedMessages: 7 });
  const local = await destination.save({ ...flat(7, 1), messageSync: localMeta });
  assert.equal(local.entry.contentHash, remote.entry.contentHash);
  const restored = await destination.store.applyRemoteFiles({ directory: destination.fs.directory, account, files: remote.files });
  assert.deepEqual(restored.entry.messageSync, localMeta);
  assert.deepEqual((await destination.baseline()).entry.messageSync, localMeta);
});

test('receipt selection prefers full verification freshness and keeps a conservative run count on ties', () => {
  const native = flat(7, 1).payload;
  const fresh = fullMeta({ fullReadAt: checkedAt + 30_000, checkedAt: checkedAt + 30_000,
    fetchedMessages: 7, addedMessages: 7 });
  const staleTail = tailMeta();
  assert.deepEqual(selectMessageSync(native, staleTail, fresh), fresh);
  assert.deepEqual(selectMessageSync(native, fresh, staleTail), fresh);
  const lowRuns = tailMeta({ incrementalRuns: 3 }), highRuns = tailMeta({ incrementalRuns: 5 });
  assert.deepEqual(selectMessageSync(native, lowRuns, highRuns), highRuns);
  assert.deepEqual(sanitizeMessageSync({ ...fresh, cookie: 'never-persist' }, native), fresh);
});

test('a complete flat response cannot replace a stored tree and discard alternative branches', async () => {
  const f = setup(), saved = await f.save(tree());
  const before = f.fs.text(saved.entry.jsonPath), writes = f.fs.writes.length;
  await assert.rejects(f.save(flat(8, 1)), { code: 'PARTIAL_DETAIL' });
  assert.equal(f.fs.text(saved.entry.jsonPath), before);
  assert.equal(f.fs.writes.length, writes);
  const other = setup();
  await other.save(flat());
  const upgraded = await other.save(tree(1));
  assert.equal(JSON.parse(other.fs.text(upgraded.entry.jsonPath)).mapping.alternative.message.content.parts[0], 'Previous answer');
});
