import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalUploadQueue } from '../extension/lib/local-upload-queue.js';
import { createArchiveStore } from '../extension/lib/archive-store.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const account = { platform: 'chatgpt', accountKey: 'acct-0123456789abcdef01234567', storageKey: 'demo-01234567', alias: 'Demo' };
const github = { repository: 'demo/private-data', branch: 'main', enabled: true };
const settingKey = `localUploadScan:${account.accountKey}`;
const error = code => Object.assign(new Error(`synthetic ${code}`), { code });
function detail(id, content = 'Answer', update = 1792742400) {
  return { identity: { accountKey: account.accountKey, displayName: 'Demo' }, capturedAt: '2026-10-23T08:00:00Z', completeness: 'complete',
    payload: { conversation_id: id, title: id, create_time: 1792656000, update_time: update, current_node: 'reply', mapping: {
      root: { parent: null, message: null },
      question: { parent: 'root', message: { id: 'q', author: { role: 'user' }, content: { parts: ['Question'] } } },
      reply: { parent: 'question', message: { id: 'r', author: { role: 'assistant' }, content: { parts: [content] } } },
    } } };
}
function fixture(overrides = {}) {
  const fs = memoryBinaryFs(), store = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
  let clock = Date.parse('2026-10-23T08:00:00Z');
  const reads = [], calls = [], queued = new Map();
  const dependencies = { getSetting: fs.getSetting, setSetting: fs.setSetting,
    readAccountManifest: store.readAccountManifest,
    readConversationArchive: async (...args) => { reads.push(args[2]); return store.readConversationArchive(...args); },
    enqueueArchive: async input => {
      assert.equal(input.forceUpload, true);
      calls.push(input); queued.set(input.archive.entry.conversationId, input.archive);
    }, now: () => clock, ...overrides };
  const queue = createLocalUploadQueue(dependencies);
  const input = { directory: fs.directory, account, github };
  return { fs, store, dependencies, queue, input, reads, calls, queued,
    advance: ms => { clock += ms; },
    save: (id, text, updated) => store.saveConversation({ directory: fs.directory, account, detail: detail(id, text, updated) }) };
}

test('local backfill has a durable bounded cursor, survives restart, and completed ticks are idempotent', async () => {
  const f = fixture();
  for (const id of ['three', 'one', 'two']) await f.save(id);
  assert.equal((await f.queue.start(f.input)).total, 3);
  const first = await f.queue.tick({ ...f.input, limit: 1 });
  assert.equal(first.checked, 1); assert.equal(first.staged, 1); assert.equal(first.status, 'running');
  assert.deepEqual(f.reads, ['one']);
  const restarted = createLocalUploadQueue(f.dependencies);
  const second = await restarted.tick({ ...f.input, limit: 1 });
  assert.equal(second.checked, 2); assert.deepEqual(f.reads, ['one', 'three']);
  const complete = await restarted.tick(f.input);
  assert.equal(complete.status, 'completed'); assert.equal(complete.staged, 3);
  assert.equal(f.queued.size, 3);
  assert.deepEqual(await restarted.tick(f.input), complete);
  assert.deepEqual(await restarted.state(account), complete);
  assert.equal(f.calls.length, 3);
});

test('missing and edited local files produce partial results while valid conversations still stage', async () => {
  const f = fixture();
  const first = await f.save('a'), second = await f.save('b'); await f.save('c');
  await f.queue.start(f.input);
  f.fs.files.delete(first.entry.jsonPath);
  f.fs.put(second.entry.markdownPath, 'My notes');
  const result = await f.queue.tick({ ...f.input, limit: 5 });
  assert.equal(result.status, 'partial'); assert.equal(result.checked, 3); assert.equal(result.staged, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.issues, [
    { conversationId: 'a', code: 'ARCHIVE_MISSING' }, { conversationId: 'b', code: 'LOCAL_CONFLICT' },
  ]);
  assert.deepEqual([...f.queued.keys()], ['c']);
  assert.equal(f.fs.text(second.entry.markdownPath), 'My notes');
  const before = f.reads.length;
  assert.equal((await f.queue.tick(f.input)).status, 'partial');
  assert.equal(f.reads.length, before);
});

test('partial snapshots never enter the upload queue', async () => {
  const f = fixture(); await f.save('one');
  const original = f.dependencies.readConversationArchive;
  const queue = createLocalUploadQueue({ ...f.dependencies, readConversationArchive: async (...args) => {
    const result = await original(...args); result.entry.coverage.messages = 'partial'; return result;
  } });
  await queue.start(f.input);
  const result = await queue.tick(f.input);
  assert.equal(result.status, 'partial'); assert.equal(result.issues[0].code, 'PARTIAL_DETAIL');
  assert.equal(f.queued.size, 0);
});

test('temporary archive-write or queue failure does not advance the cursor and retries after cooldown', async () => {
  const f = fixture(); await f.save('one');
  let held = true;
  const queue = createLocalUploadQueue({ ...f.dependencies, enqueueArchive: async input => {
    if (held) throw error('STORAGE');
    await f.dependencies.enqueueArchive(input);
  } });
  await queue.start(f.input);
  const waiting = await queue.tick(f.input);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.checked, 0); assert.equal(waiting.failed, 0);
  assert.equal(waiting.lastError.code, 'STORAGE');
  held = false;
  await queue.tick(f.input); assert.equal(f.reads.length, 1);
  f.advance(60_001);
  const result = await queue.tick(f.input);
  assert.equal(result.status, 'completed'); assert.equal(result.checked, 1); assert.equal(result.staged, 1);
  assert.equal(f.queued.size, 1);
});

test('a pending local journal is waiting work rather than a discarded permanent failure', async () => {
  const f = fixture(); await f.save('one');
  await f.queue.start(f.input);
  f.fs.settings.set(`archiveJournal:chatgpt:${account.accountKey}`, { pending: true });
  const result = await f.queue.tick(f.input);
  assert.equal(result.status, 'waiting'); assert.equal(result.checked, 0);
  assert.equal(result.lastError.code, 'LOCAL_PENDING');
  f.fs.settings.set(`archiveJournal:chatgpt:${account.accountKey}`, null); f.advance(60_001);
  assert.equal((await f.queue.tick(f.input)).status, 'completed');
});

test('a crash after enqueue before cursor commit safely replays through conversation deduplication', async () => {
  const f = fixture(); await f.save('one');
  let rejectCheckpoint = true;
  const dependencies = { ...f.dependencies, setSetting: async (key, value) => {
    if (rejectCheckpoint && key === settingKey && value.cursor === 1) throw error('STORAGE');
    await f.fs.setSetting(key, value);
  } };
  const first = createLocalUploadQueue(dependencies);
  await first.start(f.input);
  await assert.rejects(first.tick(f.input), { code: 'STORAGE' });
  assert.equal((await first.state(account)).checked, 0);
  assert.equal(f.queued.size, 1);
  rejectCheckpoint = false;
  const restarted = createLocalUploadQueue(dependencies);
  const result = await restarted.tick(f.input);
  assert.equal(result.status, 'completed'); assert.equal(result.staged, 1);
  assert.equal(f.calls.length, 2); assert.equal(f.queued.size, 1);
});

test('changed repository, branch or directory blocks old work before files are read', async () => {
  for (const change of [
    input => ({ ...input, github: { ...github, repository: 'demo/other-data' } }),
    input => ({ ...input, github: { ...github, branch: 'other' } }),
    input => ({ ...input, directory: memoryBinaryFs().directory }),
  ]) {
    const f = fixture(); await f.save('one'); await f.queue.start(f.input);
    const changed = change(f.input), result = await f.queue.tick(changed);
    assert.equal(result.status, 'blocked'); assert.equal(result.checked, 0);
    assert.equal(result.lastError.code, changed.directory === f.input.directory ? 'GITHUB_TARGET_CHANGED' : 'DIRECTORY_CHANGED');
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('same logical directory handle and repository case changes keep the scan valid', async () => {
  const f = fixture(); await f.save('one'); await f.queue.start(f.input);
  const result = await f.queue.tick({ ...f.input, directory: { ...f.fs.directory }, github: { ...github, repository: 'DEMO/Private-Data' } });
  assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 1);
});

test('concurrent ticks serialize and cannot overwrite each other cursor progress', async () => {
  const f = fixture(); await f.save('one'); await f.save('two');
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const queue = createLocalUploadQueue({ ...f.dependencies, readConversationArchive: async (...args) => {
    if (args[2] === 'one') { entered(); await hold; }
    return f.dependencies.readConversationArchive(...args);
  } });
  await queue.start(f.input);
  const first = queue.tick({ ...f.input, limit: 1 }); await enteredPromise;
  const second = queue.tick({ ...f.input, limit: 1 }); release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.checked), [1, 2]);
  assert.equal(results[1].status, 'completed'); assert.deepEqual(f.reads, ['one', 'two']);
});

test('reads the current verified local version after scan start, without caching old bodies', async () => {
  const f = fixture(); const old = await f.save('one', 'Old answer');
  await f.queue.start(f.input);
  const latest = await f.save('one', 'New answer', 1792742500);
  await f.queue.tick(f.input);
  assert.notEqual(old.entry.contentHash, latest.entry.contentHash);
  assert.equal(f.queued.get('one').entry.contentHash, latest.entry.contentHash);
});

test('an empty local archive completes without invoking reader or uploader', async () => {
  const f = fixture(); const result = await f.queue.start(f.input);
  assert.equal(result.status, 'completed'); assert.equal(result.total, 0);
  assert.deepEqual(await f.queue.tick(f.input), result);
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
});

test('invalid limits remain bounded and corrupted persisted ownership cannot stage files', async () => {
  const f = fixture(); for (const id of ['a', 'b', 'c']) await f.save(id);
  await f.queue.start(f.input);
  const result = await f.queue.tick({ ...f.input, limit: NaN });
  assert.equal(result.checked, 2);
  const stored = f.fs.settings.get(settingKey); stored.storageKey = 'different';
  f.fs.settings.set(settingKey, stored);
  await assert.rejects(f.queue.tick(f.input), { code: 'ARCHIVE_FORMAT' });
  assert.equal(f.calls.length, 2);
});
