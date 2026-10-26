import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveStore, accountPrefix, needsMarkdownRefresh } from '../extension/lib/archive-store.js';
import { createLocalMaintenance } from '../extension/lib/local-maintenance.js';
import { RENDERER_VERSION } from '../extension/lib/archive.js';
import { extractAssets } from '../extension/lib/assets.js';
import { hashBytes } from '../extension/lib/asset-store.js';
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

async function olderMarkdown(f, saved, version, markdown = '# Older generated copy\n\nImage description only.\n') {
  const path = `${accountPrefix(account)}/archive/manifest.json`;
  const manifest = JSON.parse(f.fs.text(path)), entry = manifest.conversations[saved.entry.conversationId];
  if (version === undefined) delete entry.rendererVersion; else entry.rendererVersion = version;
  entry.markdownHash = await hashBytes(new TextEncoder().encode(markdown));
  f.fs.put(entry.markdownPath, markdown);
  f.fs.put(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return entry;
}

async function generatedImageFixture(version, downloaded = true) {
  const f = fixture(), source = detail();
  source.payload.mapping.image = { parent: 'question', message: { id: 'generated', author: { role: 'tool', name: 'synthetic.generated_tool' },
    recipient: 'all', channel: 'commentary', status: 'finished_successfully', content: { content_type: 'multimodal_text',
      parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_generated' }] } } };
  source.payload.mapping.reply.parent = 'image';
  const assets = await extractAssets(source.payload);
  if (downloaded) {
    Object.assign(assets[0], { status: 'downloaded', oid: 'a'.repeat(64), size: 3,
      localPath: `${accountPrefix(account)}/assets/${'a'.repeat(64)}.png` });
    f.fs.put(assets[0].localPath, new Uint8Array([1, 2, 3]));
  }
  const saved = await f.save(source, assets), nativeBefore = f.fs.text(saved.entry.jsonPath);
  await olderMarkdown(f, saved, version);
  return { ...f, saved, assets, nativeBefore };
}

test('old rich renderers rebuild existing Markdown from verified native data, including generated images', async t => {
  for (const version of ['rich-1', 'rich-2']) for (const downloaded of [false, true]) {
    await t.test(`${version} / ${downloaded ? 'local image' : 'pending image'}`, async () => {
      const f = await generatedImageFixture(version, downloaded);
      const report = await drain(f);
      assert.equal(report.status, 'completed'); assert.equal(report.repairedMarkdown, 1);
      assert.equal(f.fs.text(f.saved.entry.jsonPath), f.nativeBefore);
      assert.equal((await f.store.readAccountManifest(f.fs.directory, account)).conversations.one.rendererVersion, RENDERER_VERSION);
      const md = f.fs.text(f.saved.entry.markdownPath);
      if (downloaded) assert.ok(md.includes(`![图片](../../../assets/${'a'.repeat(64)}.png)`));
      else assert.ok(md.includes('〔图片，待补采〕'));
      assert.equal(f.deliveries.length, 1);
      const writes = f.fs.writes.length;
      f.advance(24 * 60 * 60_000 + 1);
      const again = await drain(f);
      assert.equal(again.repairedMarkdown, 0); assert.equal(f.fs.writes.length, writes);
      assert.equal(f.deliveries.length, 1);
    });
  }
});

test('plain old Markdown upgrades its renderer receipt once without changing native or matching Markdown bytes', async () => {
  const f = fixture(), saved = await f.save(), beforeMd = f.fs.text(saved.entry.markdownPath), beforeJson = f.fs.text(saved.entry.jsonPath);
  await olderMarkdown(f, saved, 'rich-2', beforeMd);
  const beforeWrites = f.fs.writes.length;
  await f.maintenance.start({ account });
  assert.equal((await drain(f)).repairedMarkdown, 1);
  assert.equal(f.fs.text(saved.entry.markdownPath), beforeMd);
  assert.equal(f.fs.text(saved.entry.jsonPath), beforeJson);
  assert.deepEqual(f.fs.writes.slice(beforeWrites), [`${accountPrefix(account)}/archive/manifest.json`]);
  const repaired = await f.store.repairMissingMarkdown({ directory: f.fs.directory, account, conversationId: 'one' });
  assert.equal(repaired.repaired, false);
  assert.equal(f.fs.writes.length, beforeWrites + 1);
});

test('renderer migration never overwrites edited Markdown, edited JSON or existing empty Markdown', async t => {
  for (const changed of ['markdown', 'json', 'empty']) await t.test(changed, async () => {
    const f = await generatedImageFixture('rich-2');
    const path = changed === 'json' ? f.saved.entry.jsonPath : f.saved.entry.markdownPath;
    const replacement = changed === 'empty' ? '' : changed === 'json' ? JSON.stringify({ conversation_id: 'other', messages: [] }) : 'My personal annotations';
    f.fs.put(path, replacement);
    const writes = f.fs.writes.length, report = await drain(f);
    assert.equal(report.repairedMarkdown, 0); assert.equal(f.deliveries.length, 0);
    assert.equal(f.fs.writes.length, writes); assert.equal(f.fs.text(path), replacement);
    assert.equal(report.status, 'partial'); assert.equal(report.conflicts, 1);
  });
});

test('renderer upgrades remain bounded across maintenance ticks and restart checkpoints', async () => {
  const f = fixture({ batchSize: 1 });
  for (const id of ['one', 'two', 'three']) await olderMarkdown(f, await f.save(detail(id)), 'rich-2');
  const first = await f.maintenance.tick({ directory: f.fs.directory, account });
  assert.equal(first.checked, 1); assert.equal(first.repairedMarkdown, 0);
  const restarted = createLocalMaintenance(f.dependencies);
  const second = await restarted.tick({ directory: f.fs.directory, account });
  assert.equal(second.checked, 2); assert.equal(second.repairedMarkdown, 1); assert.equal(f.deliveries.length, 1);
  const finished = await drain(f, restarted);
  assert.equal(finished.repairedMarkdown, 3); assert.equal(finished.checked, 6); assert.equal(f.deliveries.length, 3);
});

test('renderer upgrade replays a partially written journal without rewriting native data or counting repair twice', async () => {
  const f = await generatedImageFixture('rich-2'), manifestPath = `${accountPrefix(account)}/archive/manifest.json`;
  f.fs.fail(path => path === manifestPath);
  const blocked = await drain(f);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.lastError.code, 'LOCAL_WRITE');
  assert.equal(blocked.repairedMarkdown, 0); assert.equal(f.deliveries.length, 0);
  assert.ok(f.fs.text(f.saved.entry.markdownPath).includes('![图片]'));
  assert.equal(JSON.parse(f.fs.text(manifestPath)).conversations.one.rendererVersion, 'rich-2');
  assert.ok(f.fs.settings.get(`archiveJournal:chatgpt:${account.accountKey}`));
  const mdWrites = f.fs.writes.filter(path => path === f.saved.entry.markdownPath).length;
  f.fs.fail(null);
  const restarted = createLocalMaintenance(f.dependencies);
  await restarted.start({ account });
  const finished = await drain(f, restarted);
  assert.equal(finished.status, 'completed'); assert.equal(finished.repairedMarkdown, 1);
  assert.equal(f.fs.text(f.saved.entry.jsonPath), f.nativeBefore);
  assert.equal(f.fs.writes.filter(path => path === f.saved.entry.markdownPath).length, mdWrites);
  assert.equal(f.fs.settings.get(`archiveJournal:chatgpt:${account.accountKey}`), null);
  assert.equal(f.fs.settings.get(`localMaintenance:${account.accountKey}`).deliveryConversationId, null);
});

test('renderer migration delivery survives a queue handoff failure without another rewrite', async () => {
  const f = await generatedImageFixture('rich-1'); let reject = true;
  const maintenance = createLocalMaintenance({ ...f.dependencies, enqueueArchive: async input => {
    if (reject) throw Object.assign(new Error('queue unavailable'), { code: 'STORAGE' });
    f.deliveries.push(input);
  } });
  assert.equal((await drain(f, maintenance)).status, 'blocked');
  const writes = f.fs.writes.length;
  assert.equal((await f.store.readAccountManifest(f.fs.directory, account)).conversations.one.rendererVersion, RENDERER_VERSION);
  reject = false; await maintenance.start({ account });
  assert.equal((await drain(f, maintenance)).repairedMarkdown, 1);
  assert.equal(f.deliveries.length, 1); assert.equal(f.fs.writes.length, writes);
});

test('an edited old Markdown is reported while a following healthy conversation still migrates across ticks', async () => {
  const f = fixture({ batchSize: 1 }), edited = await f.save(detail('first')), healthy = await f.save(detail('second'));
  await olderMarkdown(f, edited, 'rich-2'); await olderMarkdown(f, healthy, 'rich-2');
  f.fs.put(edited.entry.markdownPath, 'My edited history');
  await f.maintenance.tick({ directory: f.fs.directory, account });
  const second = await f.maintenance.tick({ directory: f.fs.directory, account });
  assert.equal(second.runnable, true); assert.equal(second.conflicts, 1);
  assert.equal(f.fs.settings.get(`localMaintenance:${account.accountKey}`).deliveryConversationId, null);
  const restarted = createLocalMaintenance(f.dependencies), report = await drain(f, restarted);
  assert.equal(report.status, 'partial'); assert.equal(report.repairedMarkdown, 1); assert.equal(report.conflicts, 1);
  assert.equal(report.conversationsChecked, 2);
  assert.deepEqual(report.errors, [{ conversationId: 'first', code: 'LOCAL_CONFLICT' }]);
  assert.equal(f.fs.text(edited.entry.markdownPath), 'My edited history');
  const manifest = await f.store.readAccountManifest(f.fs.directory, account);
  assert.equal(manifest.conversations.first.rendererVersion, 'rich-2');
  assert.equal(manifest.conversations.second.rendererVersion, RENDERER_VERSION);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].archive.entry.conversationId, 'second');
});

test('an active migration journal conflict remains blocked and retains its unacknowledged delivery', async () => {
  const f = await generatedImageFixture('rich-2'), manifestPath = `${accountPrefix(account)}/archive/manifest.json`;
  f.fs.fail(path => path === manifestPath);
  assert.equal((await drain(f)).status, 'blocked');
  f.fs.fail(null);
  const journalKey = `archiveJournal:chatgpt:${account.accountKey}`, pending = f.fs.settings.get(journalKey);
  f.fs.put(f.saved.entry.markdownPath, 'Notes added during interrupted migration');
  await f.maintenance.start({ account });
  const result = await drain(f);
  assert.equal(result.status, 'blocked'); assert.equal(result.lastError.code, 'LOCAL_CONFLICT');
  assert.equal(result.repairedMarkdown, 0); assert.equal(result.conflicts, 0);
  assert.equal(f.fs.settings.get(`localMaintenance:${account.accountKey}`).deliveryConversationId, 'one');
  assert.deepEqual(f.fs.settings.get(journalKey), pending);
  assert.equal(f.fs.text(f.saved.entry.markdownPath), 'Notes added during interrupted migration');
});

test('a conflict after successful migration does not discard the pending upload handoff', async () => {
  const f = await generatedImageFixture('rich-1'); let reject = true;
  const maintenance = createLocalMaintenance({ ...f.dependencies, enqueueArchive: async input => {
    if (reject) throw Object.assign(new Error('handoff conflict'), { code: 'LOCAL_CONFLICT' });
    f.deliveries.push(input);
  } });
  const blocked = await drain(f, maintenance);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.lastError.code, 'LOCAL_CONFLICT');
  assert.equal(blocked.conflicts, 0); assert.equal(blocked.repairedMarkdown, 0);
  assert.equal(f.fs.settings.get(`localMaintenance:${account.accountKey}`).deliveryConversationId, 'one');
  assert.equal((await f.store.readAccountManifest(f.fs.directory, account)).conversations.one.rendererVersion, RENDERER_VERSION);
  assert.equal(f.fs.settings.get(`archiveJournal:chatgpt:${account.accountKey}`), null);
  reject = false; await maintenance.start({ account });
  assert.equal((await drain(f, maintenance)).repairedMarkdown, 1);
  assert.equal(f.deliveries.length, 1);
});

test('renderer migration cannot consume another conversation journal and never downgrades future versions', async () => {
  const f = await generatedImageFixture('rich-2'), journalKey = `archiveJournal:chatgpt:${account.accountKey}`;
  f.fs.fail(path => path.endsWith('__other.md'));
  await assert.rejects(f.save(detail('other')), { code: 'LOCAL_WRITE' });
  const pending = f.fs.settings.get(journalKey);
  f.fs.fail(null);
  await assert.rejects(f.store.repairMissingMarkdown({ directory: f.fs.directory, account, conversationId: 'one' }), { code: 'LOCAL_PENDING' });
  assert.deepEqual(f.fs.settings.get(journalKey), pending);
  assert.equal(needsMarkdownRefresh({ rendererVersion: RENDERER_VERSION }), false);
  assert.equal(needsMarkdownRefresh({ rendererVersion: 'rich-99' }), false);
  assert.equal(needsMarkdownRefresh({ rendererVersion: 'unknown-format' }), false);
  assert.equal(needsMarkdownRefresh({}), true);
  const future = fixture(), saved = await future.save();
  await olderMarkdown(future, saved, 'rich-99');
  const writes = future.fs.writes.length;
  assert.equal((await drain(future)).repairedMarkdown, 0);
  assert.equal(future.fs.writes.length, writes);
});

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
