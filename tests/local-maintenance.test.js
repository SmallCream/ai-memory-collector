import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveStore, accountPrefix } from '../extension/lib/archive-store.js';
import { createLocalMaintenance } from '../extension/lib/local-maintenance.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const account = { platform: 'chatgpt', accountKey: 'acct-0123456789abcdef01234567', storageKey: 'demo-01234567', alias: 'Demo' };
const capture = '2026-10-23T08:00:00.000Z';
function detail(id = 'one') {
  return { identity: { accountKey: account.accountKey, displayName: 'Demo' }, capturedAt: capture, completeness: 'complete',
    payload: { conversation_id: id, title: `Conversation ${id}`, create_time: 1792656000, update_time: 1792742400,
      current_node: 'reply', mapping: {
        root: { parent: null, message: null },
        question: { parent: 'root', message: { id: 'q', author: { role: 'user' }, status: 'finished_successfully', content: { parts: ['Question'] } } },
        reply: { parent: 'question', message: { id: 'r', author: { role: 'assistant' }, status: 'finished_successfully', content: { parts: ['A table\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'] } } },
      } } };
}
function fixture(options = {}) {
  const fs = memoryBinaryFs(), store = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
  let clock = Date.parse(capture);
  const deliveries = [], queued = [];
  const dependencies = { getSetting: fs.getSetting, setSetting: fs.setSetting,
    readAccountManifest: store.readAccountManifest, readConversationArchive: store.readConversationArchive,
    repairMissingMarkdown: store.repairMissingMarkdown,
    enqueueArchive: async input => deliveries.push(input),
    requeueMissing: async input => { queued.push(input); return { queued: true }; },
    now: () => clock, batchSize: 3, ...options };
  const maintenance = createLocalMaintenance(dependencies);
  return { fs, store, deliveries, queued, dependencies, maintenance,
    advance: ms => { clock += ms; },
    save: (source = detail(), assets) => store.saveConversation({ directory: fs.directory, account, detail: source, ...(assets ? { assets } : {}) }) };
}
async function drain(f, maintenance = f.maintenance, options = {}) {
  for (let i = 0; i < 100; i++) {
    const result = await maintenance.tick({ directory: f.fs.directory, account, ...options });
    if (!result.runnable) return result;
  }
  throw new Error('local checks did not finish');
}

test('missing Markdown is rebuilt locally and a verified archive is delivered without rewriting native JSON', async () => {
  const f = fixture(), saved = await f.save();
  const beforeJson = f.fs.text(saved.entry.jsonPath), beforeMd = f.fs.text(saved.entry.markdownPath);
  f.fs.files.delete(saved.entry.markdownPath);
  const report = await drain(f);
  assert.equal(report.status, 'completed');
  assert.equal(report.repairedMarkdown, 1);
  assert.equal(f.fs.text(saved.entry.jsonPath), beforeJson);
  assert.equal(f.fs.text(saved.entry.markdownPath), beforeMd);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].archive.entry.contentHash, saved.entry.contentHash);
  assert.equal(f.queued.length, 0);
});

test('present empty or edited files are preserved and never replaced by automatic repair', async () => {
  const f = fixture(), saved = await f.save();
  f.fs.put(saved.entry.markdownPath, '');
  const empty = await drain(f);
  assert.equal(empty.status, 'partial');
  assert.equal(empty.conflicts, 1);
  assert.equal(f.fs.text(saved.entry.markdownPath), '');
  assert.equal(f.deliveries.length, 0);
  f.fs.put(saved.entry.markdownPath, 'My manual notes');
  await assert.rejects(f.store.repairMissingMarkdown({ directory: f.fs.directory, account, conversationId: 'one' }), { code: 'LOCAL_CONFLICT' });
  assert.equal(f.fs.text(saved.entry.markdownPath), 'My manual notes');
});

test('missing Markdown cannot be rebuilt from manually changed native JSON', async () => {
  const f = fixture(), saved = await f.save();
  f.fs.files.delete(saved.entry.markdownPath);
  const changed = JSON.parse(f.fs.text(saved.entry.jsonPath)); changed.title = 'Manual change';
  f.fs.put(saved.entry.jsonPath, JSON.stringify(changed));
  const report = await drain(f);
  assert.equal(report.status, 'blocked');
  assert.equal(report.lastError.code, 'LOCAL_CONFLICT');
  assert.equal(f.fs.files.has(saved.entry.markdownPath), false);
  assert.equal(JSON.parse(f.fs.text(saved.entry.jsonPath)).title, 'Manual change');
  assert.equal(f.deliveries.length, 0);
});

test('a missing native file is reported for source recapture without guessing the conversation', async () => {
  const f = fixture(), saved = await f.save();
  f.fs.files.delete(saved.entry.jsonPath);
  const report = await drain(f);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.missingConversations, ['one']);
  assert.equal(report.missingConversationCount, 1);
  assert.equal(report.repairedMarkdown, 0);
  assert.equal(f.queued.length, 0);
  assert.equal(f.deliveries.length, 0);
});

test('missing binary is requeued, while changed existing binary remains an explicit conflict', async () => {
  const f = fixture();
  const assets = ['1', '2'].map(n => ({ id: n.repeat(64), kind: 'image', status: 'downloaded',
    sourceRef: `sediment://file_${n}`, sourceType: 'platform', fileId: `file_${n}`,
    oid: n.repeat(64), size: 5, localPath: `${accountPrefix(account)}/assets/${n.repeat(64)}.png` }));
  await f.save(detail(), assets);
  f.fs.put(assets[1].localPath, 'different size');
  const report = await drain(f);
  assert.equal(report.missingAttachments, 1);
  assert.equal(report.conflicts, 1);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].assetId, assets[0].id);
  assert.equal(f.queued[0].manual, false);
  assert.equal(f.fs.text(assets[1].localPath), 'different size');
});

test('an explicit repair sweep grants a manual retry while later daily sweeps remain automatic', async () => {
  const f = fixture();
  const asset = { id: '1'.repeat(64), kind: 'image', status: 'downloaded', sourceType: 'platform',
    sourceRef: 'sediment://file_one', fileId: 'file_one', oid: '2'.repeat(64), size: 5,
    localPath: `${accountPrefix(account)}/assets/${'2'.repeat(64)}.png` };
  await f.save(detail(), [asset]);
  await f.maintenance.start({ account });
  await drain(f);
  assert.equal(f.queued[0].manual, true);
  f.advance(24 * 60 * 60_000 + 1);
  await drain(f);
  assert.equal(f.queued[1].manual, false);
});

test('file checking is bounded, resumes across instances, and respects daily cadence', async () => {
  const f = fixture({ batchSize: 2 });
  for (const id of ['one', 'two', 'three']) await f.save(detail(id));
  const first = await f.maintenance.tick({ directory: f.fs.directory, account });
  assert.equal(first.checked, 2);
  assert.equal(first.runnable, true);
  const restarted = createLocalMaintenance(f.dependencies);
  const second = await restarted.tick({ directory: f.fs.directory, account });
  assert.equal(second.checked, 4);
  const result = await drain(f, restarted);
  assert.equal(result.checked, 6);
  assert.equal(result.conversationsChecked, 3);
  assert.equal(result.status, 'completed');
  assert.equal((await restarted.tick({ directory: f.fs.directory, account })).startedAt, result.startedAt);
  f.advance(24 * 60 * 60_000 + 1);
  const next = await restarted.tick({ directory: f.fs.directory, account });
  assert.equal(next.checked, 2);
  assert.ok(next.startedAt > result.startedAt);
});

test('ordinary checks only inspect archive sizes and do not read or hash every body', async () => {
  const f = fixture(), saved = await f.save();
  const wrap = (directory, prefix = '') => ({ ...directory,
    getDirectoryHandle: async (name, options) => wrap(await directory.getDirectoryHandle(name, options), prefix ? `${prefix}/${name}` : name),
    getFileHandle: async (name, options) => {
      const handle = await directory.getFileHandle(name, options), path = prefix ? `${prefix}/${name}` : name;
      return { ...handle, getFile: async () => {
        const file = await handle.getFile();
        return path === saved.entry.jsonPath || path === saved.entry.markdownPath ? { ...file,
          text: async () => { throw new Error('ordinary check read a conversation body'); },
          arrayBuffer: async () => { throw new Error('ordinary check read body bytes'); },
        } : file;
      } };
    } });
  let result;
  do { result = await f.maintenance.tick({ directory: wrap(f.fs.directory), account }); } while (result.runnable);
  assert.equal(result.status, 'completed');
});

test('repair delivery intent survives an interrupted upload-queue handoff', async () => {
  let reject = true, deliveries = 0;
  const f = fixture({ enqueueArchive: async () => { if (reject) throw Object.assign(new Error('full'), { code: 'STORAGE' }); deliveries++; } });
  const saved = await f.save();
  f.fs.files.delete(saved.entry.markdownPath);
  const result = await drain(f);
  assert.equal(result.status, 'blocked');
  assert.equal(f.fs.files.has(saved.entry.markdownPath), true);
  const writes = f.fs.writes.length;
  reject = false;
  const restarted = createLocalMaintenance(f.dependencies);
  await restarted.start({ account });
  const repaired = await drain(f, restarted);
  assert.equal(repaired.status, 'completed');
  assert.equal(repaired.repairedMarkdown, 1);
  assert.equal(deliveries, 1);
  assert.equal(f.fs.writes.length, writes);
});

test('interrupted Markdown creation replays its journal and recovers an empty placeholder', async () => {
  const f = fixture(), saved = await f.save();
  f.fs.files.delete(saved.entry.markdownPath);
  f.fs.fail(path => path === saved.entry.markdownPath);
  const first = await drain(f);
  assert.equal(first.status, 'blocked');
  assert.equal(first.lastError.code, 'LOCAL_WRITE');
  assert.equal(f.fs.files.get(saved.entry.markdownPath).length, 0);
  f.fs.fail(null);
  await f.maintenance.start({ account });
  const resumed = await drain(f);
  assert.equal(resumed.status, 'completed');
  assert.ok(f.fs.files.get(saved.entry.markdownPath).length > 0);
  assert.equal(f.fs.settings.get(`archiveJournal:chatgpt:${account.accountKey}`), null);
});

test('a Markdown repair does not consume another conversation unfinished write receipt', async () => {
  const f = fixture(), first = await f.save();
  f.fs.files.delete(first.entry.markdownPath);
  f.fs.fail(path => path.endsWith('__other.md'));
  await assert.rejects(f.save(detail('other')), { code: 'LOCAL_WRITE' });
  const journalKey = `archiveJournal:chatgpt:${account.accountKey}`;
  const pending = f.fs.settings.get(journalKey);
  f.fs.fail(null);
  await assert.rejects(f.store.repairMissingMarkdown({ directory: f.fs.directory, account, conversationId: 'one' }), { code: 'LOCAL_PENDING' });
  assert.deepEqual(f.fs.settings.get(journalKey), pending);
  assert.equal(f.fs.files.has(first.entry.markdownPath), false);
});

test('local archive backfill returns a scoped verified snapshot and rejects modified text or pending writes', async () => {
  const f = fixture(), saved = await f.save();
  await f.save(detail('other'));
  const archive = await f.store.readConversationArchive(f.fs.directory, account, 'one');
  assert.equal(archive.files.length, 4);
  assert.deepEqual(Object.keys(JSON.parse(archive.files.find(file => file.path.endsWith('/archive/manifest.json')).content).conversations), ['one']);
  f.fs.put(saved.entry.markdownPath, 'edited');
  await assert.rejects(f.store.readConversationArchive(f.fs.directory, account, 'one'), { code: 'LOCAL_CONFLICT' });
  f.fs.settings.set(`archiveJournal:chatgpt:${account.accountKey}`, { pending: true });
  await assert.rejects(f.store.readConversationArchive(f.fs.directory, account, 'other'), { code: 'LOCAL_PENDING' });
});

test('directory permission loss preserves progress and resumes after permission returns', async () => {
  const f = fixture({ batchSize: 1 }); await f.save();
  const first = await f.maintenance.tick({ directory: f.fs.directory, account });
  assert.equal(first.checked, 1);
  f.fs.permission('denied');
  const blocked = await f.maintenance.tick({ directory: f.fs.directory, account });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.checked, 1);
  f.fs.permission('granted'); f.advance(60_001);
  const resumed = await drain(f);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.checked, 2);
});
