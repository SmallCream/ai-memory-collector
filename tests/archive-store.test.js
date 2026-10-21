import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchive } from '../extension/lib/archive.js';
import { extractAssets } from '../extension/lib/assets.js';
import { createArchiveStore, readAccountManifest, accountPrefix } from '../extension/lib/archive-store.js';

const account = { platform: 'chatgpt', accountKey: 'acct-0123456789abcdef01234567', alias: 'demo', storageKey: 'demo-01234567' };
const identity = { accountKey: account.accountKey, displayName: 'Demo' };
const capture = '2026-10-21T08:00:00Z';
function detail(id = 'one', text = 'first', update = 1792569600, extra = {}) {
  return { identity, capturedAt: capture, completeness: 'complete', payload: {
    conversation_id: id, title: 'Demo title', create_time: 1792483200, update_time: update,
    current_node: 'reply', mapping: {
      root: { parent: null, message: null },
      question: { parent: 'root', message: { id: 'q', author: { role: 'user' }, content: { parts: ['Question'] }, status: 'finished_successfully' } },
      reply: { parent: 'question', message: { id: 'r', author: { role: 'assistant' }, content: { parts: [text] }, status: 'finished_successfully' } },
    }, ...extra,
  } };
}
function setup() {
  const files = new Map(), directories = new Set(['']), journals = new Map(), writes = [];
  let permission = 'granted', failPath = null, failJournalClear = false, corruptPath = null;
  const rootID = {};
  function dir(prefix = '') {
    return {
      kind: 'directory', name: 'archive',
      rootID,
      isSameEntry: async other => other?.rootID === rootID,
      queryPermission: async () => permission,
      async getDirectoryHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!directories.has(path)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          directories.add(path);
        }
        return dir(path);
      },
      async getFileHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!files.has(path)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          files.set(path, '');
        }
        return {
          getFile: async () => ({ size: Buffer.byteLength(files.get(path)), text: async () => files.get(path) }),
          createWritable: async () => {
            let staged;
            return {
              write: async content => { staged = content; },
              close: async () => {
                if (path.endsWith(failPath || '\0')) throw new DOMException('disk full', 'QuotaExceededError');
                files.set(path, path.endsWith(corruptPath || '\0') ? `${staged}!` : staged);
                writes.push(path);
              },
              abort: async () => {},
            };
          },
        };
      },
    };
  }
  const store = createArchiveStore({
    get: async key => journals.get(key),
    set: async (key, value) => {
      if (value === null && failJournalClear) throw new Error('durable journal clearing failed');
      journals.set(key, value);
    },
  });
  const directory = dir();
  return { directory, files, writes, journals, store,
    permission: value => { permission = value; },
    fail: value => { failPath = value; },
    corrupt: value => { corruptPath = value; },
    failClear: value => { failJournalClear = value; },
    save: value => store.saveConversation({ directory, account, detail: value }),
  };
}

test('restoring an older derivative cannot erase downloaded assets from the identical native conversation', async () => {
  const fs = setup(), source = detail('image', '![Screenshot](sediment://file_image)');
  const id = '1'.repeat(64), oid = '2'.repeat(64);
  const pending = { id, sourceRef: 'sediment://file_image', sourceType: 'platform', fileId: 'file_image', kind: 'image', status: 'pending' };
  const remote = await fs.store.saveConversation({ directory: fs.directory, account, detail: source, assets: [pending] });
  const local = await fs.store.saveConversation({ directory: fs.directory, account, detail: source,
    assets: [{ ...pending, status: 'downloaded', oid, size: 20, localPath: `${accountPrefix(account)}/assets/${oid}.png` }] });
  assert.equal(remote.entry.contentHash, local.entry.contentHash);
  assert.notEqual(remote.entry.markdownHash, local.entry.markdownHash);
  const restored = await fs.store.applyRemoteFiles({ directory: fs.directory, account, files: remote.files });
  assert.equal(restored.entry.assets[0].status, 'downloaded');
  assert.equal(restored.entry.assets[0].oid, oid);
  assert.equal(restored.entry.markdownHash, local.entry.markdownHash);
});

test('restore preserves local internal-viewer 404 suspension against an older same-native derivative', async () => {
  const fs = setup(), source = detail('internal-picture');
  source.payload.mapping.reply.message = { id: 'viewer', author: { role: 'tool', name: 'container.open_image' },
    content: { content_type: 'execution_output', text: '<<ImageDisplayed>>' },
    metadata: { attachments: [{ id: 'file_synthetic_viewer', name: 'synthetic.png', mime_type: 'image/png' }] } };
  const [asset] = await extractAssets(source.payload);
  const remote = await fs.store.saveConversation({ directory: fs.directory, account, detail: source, assets: [asset] });
  await fs.store.saveConversation({ directory: fs.directory, account, detail: source,
    assets: [{ ...asset, status: 'unavailable', errorCode: 'HTTP_404', autoRetrySuspended: true }] });
  const restored = await fs.store.applyRemoteFiles({ directory: fs.directory, account, files: remote.files });
  assert.equal(restored.entry.assets[0].capturePolicy, 'internal-viewer');
  assert.equal(restored.entry.assets[0].autoRetrySuspended, true);
  assert.equal(restored.entry.assets[0].errorCode, 'HTTP_404');
  assert.equal(fs.files.get(restored.entry.jsonPath), remote.files.find(file => file.path === remote.entry.jsonPath).content);
  assert.equal(restored.entry.assets[0].localPath, undefined);
  const another = setup();
  const imported = await another.store.applyRemoteFiles({ directory: another.directory, account, files: restored.files });
  assert.equal(imported.entry.assets[0].autoRetrySuspended, true);
});

test('restore rederives capture policy and rejects a forged suspension for a visible image', async () => {
  const fs = setup(), source = detail('visible-picture', '![Picture](sediment://file_synthetic_visible)');
  const [asset] = await extractAssets(source.payload);
  const remote = await fs.store.saveConversation({ directory: fs.directory, account, detail: source,
    assets: [{ ...asset, capturePolicy: 'internal-viewer', autoRetrySuspended: true, errorCode: 'HTTP_404' }] });
  const target = setup();
  const restored = await target.store.applyRemoteFiles({ directory: target.directory, account, files: remote.files });
  assert.equal(restored.entry.assets[0].capturePolicy, undefined);
  assert.equal(restored.entry.assets[0].autoRetrySuspended, undefined);
  assert.equal(restored.entry.assets[0].status, 'pending');
});

test('multiple conversations share one directory, stable filenames update, identical content does not rewrite', async () => {
  const fs = setup();
  const a = await fs.save(detail());
  assert.equal(a.status, 'added');
  assert.match(a.entry.jsonPath, /^data\/web\/chatgpt\/demo-01234567\/conversations\//);
  assert.equal(fs.writes.at(-1), `${accountPrefix(account)}/archive/manifest.json`);
  const b = await fs.save(detail('two'));
  assert.equal(b.status, 'added');
  assert.deepEqual(Object.keys(b.manifest.conversations).sort(), ['one', 'two']);
  const update = detail('one', 'Second answer', 1792656000, { title: 'Renamed title' });
  const updated = await fs.save(update);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.entry.jsonPath, a.entry.jsonPath);
  assert.equal(updated.entry.markdownPath, a.entry.markdownPath);
  assert.equal(updated.entry.sourceUpdatedAt, new Date(1792656000 * 1000).toISOString());
  assert.match(fs.files.get(updated.entry.markdownPath), /Second answer/);
  const count = fs.writes.length;
  const repeat = await fs.save({ ...update, capturedAt: '2026-10-22T08:00:00Z' });
  assert.equal(repeat.status, 'unchanged');
  assert.equal(fs.writes.length, count);
  assert.equal((await readAccountManifest(fs.directory, account)).conversations.two.contentHash, b.entry.contentHash);
});

test('full backfill repairs missing Markdown from JSON without duplicating or changing JSON', async () => {
  const fs = setup();
  const a = await fs.save(detail());
  fs.files.delete(a.entry.markdownPath);
  const count = fs.writes.length;
  const repaired = await fs.save(detail());
  assert.equal(repaired.status, 'unchanged');
  assert.deepEqual(fs.writes.slice(count), [a.entry.markdownPath]);
  assert.match(fs.files.get(a.entry.markdownPath), /first/);
});

test('partial, streaming, and older snapshots preserve previous archive bytes', async () => {
  const fs = setup();
  const a = await fs.save(detail());
  const original = new Map(fs.files);
  await assert.rejects(fs.save({ ...detail('one', 'truncated', 1792656000), completeness: 'partial' }), { code: 'PARTIAL_DETAIL' });
  const stream = detail('one', 'stream', 1792656000);
  stream.payload.mapping.reply.message.status = 'in_progress';
  await assert.rejects(fs.save(stream), { code: 'PARTIAL_DETAIL' });
  await assert.rejects(fs.save(detail('one', 'old', 1792483200)), { code: 'STALE_DETAIL' });
  await assert.rejects(fs.save({ ...detail('one', 'unknown', 1792656000), completeness: 'unknown' }), { code: 'PARTIAL_DETAIL' });
  assert.deepEqual(fs.files, original);
  assert.equal((await readAccountManifest(fs.directory, account)).conversations.one.contentHash, a.entry.contentHash);
});

test('identical unknown snapshot never downgrades known completeness', async () => {
  const fs = setup();
  await fs.save(detail());
  const repeat = await fs.save({ ...detail(), completeness: 'unknown' });
  assert.equal(repeat.entry.sourceCompleteness, 'complete');
});

test('manual JSON or Markdown edits are preserved and reported before other writes', async () => {
  for (const key of ['jsonPath', 'markdownPath']) {
    const fs = setup();
    const original = await fs.save(detail());
    fs.files.set(original.entry[key], 'manually edited content');
    const count = fs.writes.length;
    await assert.rejects(fs.save(detail('one', 'new', 1792656000)), { code: 'LOCAL_CONFLICT' });
    assert.equal(fs.files.get(original.entry[key]), 'manually edited content');
    assert.equal(fs.writes.length, count);
  }
});

test('failure between JSON and Markdown resumes durable journal including empty new files', async () => {
  const fs = setup();
  fs.fail('.md');
  await assert.rejects(fs.save(detail()), { code: 'LOCAL_WRITE' });
  assert.equal([...fs.journals.values()].filter(Boolean).length, 1);
  assert.equal(await readAccountManifest(fs.directory, account), null);
  assert.equal(fs.writes.length, 1);
  fs.fail(null);
  const resumed = await fs.save(detail());
  assert.equal(resumed.status, 'added');
  assert.equal(fs.writes.filter(path => path === resumed.entry.jsonPath).length, 1);
  assert.equal([...fs.journals.values()].filter(Boolean).length, 0);
  assert.ok((await readAccountManifest(fs.directory, account)).conversations.one);
});

test('existing JSON update followed by failed Markdown resumes safely with old manifest still intact', async () => {
  const fs = setup();
  const first = await fs.save(detail());
  fs.fail('.md');
  await assert.rejects(fs.save(detail('one', 'new', 1792656000)), { code: 'LOCAL_WRITE' });
  assert.equal((await readAccountManifest(fs.directory, account)).conversations.one.contentHash, first.entry.contentHash);
  fs.fail(null);
  const result = await fs.save(detail('one', 'new', 1792656000));
  assert.equal(result.status, 'updated');
  assert.match(fs.files.get(result.entry.markdownPath), /new/);
});

test('journal-clear failure recovers without duplicate file writes and preserves original success status', async () => {
  const fs = setup(); fs.failClear(true);
  await assert.rejects(fs.save(detail()), /journal clearing/);
  assert.equal(fs.writes.length, 4);
  fs.failClear(false);
  const result = await fs.save(detail());
  assert.equal(result.status, 'added');
  assert.equal(fs.writes.length, 4);
});

test('journal is pinned to original directory and cannot silently write into a newly selected folder', async () => {
  const first = setup(), second = setup(); first.fail('.md');
  await assert.rejects(first.save(detail()), { code: 'LOCAL_WRITE' });
  await assert.rejects(first.store.saveConversation({ directory: second.directory, account, detail: detail() }), { code: 'DIRECTORY_CHANGED' });
  assert.equal(second.files.size, 0);
});

test('permission expiry and identity mismatch fail before file creation or journal storage', async () => {
  const fs = setup();
  fs.permission('prompt');
  await assert.rejects(fs.save(detail()), { code: 'DIRECTORY_PERMISSION' });
  fs.permission('granted');
  await assert.rejects(fs.save({ ...detail(), identity: { accountKey: 'another' } }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(fs.files.size, 0); assert.equal(fs.journals.size, 0);
});

test('different account cannot write through another account storageKey', async () => {
  const fs = setup(); await fs.save(detail());
  const other = { ...account, accountKey: 'acct-ffffffffffffffffffffffff' };
  await assert.rejects(readAccountManifest(fs.directory, other), { code: 'ACCOUNT_MISMATCH' });
});

test('production prefix and stored manifest traversal are rejected', async () => {
  for (const storageKey of ['../x', 'a/b', 'nul', 'x\\y', 'a.']) {
    assert.throws(() => accountPrefix({ ...account, storageKey }), { code: 'ACCOUNT_INVALID' });
  }
  await assert.rejects(buildArchive({ conversation: detail().payload, identity, capturedAt: capture, productionPrefix: 'data/web/chatgpt/../outside' }), /目录/);
  const fs = setup(); const result = await fs.save(detail());
  const manifest = structuredClone(result.manifest);
  manifest.conversations.one.jsonPath = `${accountPrefix(account)}/conversations/../../__one.json`;
  manifest.conversations.one.markdownPath = manifest.conversations.one.jsonPath.replace(/\.json$/, '.md');
  fs.files.set(`${accountPrefix(account)}/archive/manifest.json`, JSON.stringify(manifest));
  await assert.rejects(readAccountManifest(fs.directory, account), { code: 'ARCHIVE_PATH' });
});

test('same-account simultaneous local saves serialize and retain both manifest entries', async () => {
  const fs = setup();
  await Promise.all([fs.save(detail('one')), fs.save(detail('two'))]);
  assert.deepEqual(Object.keys((await readAccountManifest(fs.directory, account)).conversations).sort(), ['one', 'two']);
});

test('failed readback is never reported as saved and retains recovery journal', async () => {
  const fs = setup(); fs.corrupt('.md');
  await assert.rejects(fs.save(detail()), { code: 'LOCAL_VERIFY' });
  assert.equal([...fs.journals.values()].filter(Boolean).length, 1);
  assert.equal(await readAccountManifest(fs.directory, account), null);
});

test('newer remote winner safely updates local JSON and regenerates matching Markdown', async () => {
  const local = setup(), remote = setup();
  const before = await local.save(detail());
  const winner = await remote.save(detail('one', 'remote answer', 1792656000));
  const applied = await local.store.applyRemoteFiles({ directory: local.directory, account, files: winner.files });
  assert.equal(applied.status, 'updated');
  assert.equal(applied.entry.jsonPath, before.entry.jsonPath);
  assert.equal(applied.entry.contentHash, winner.entry.contentHash);
  assert.match(local.files.get(applied.entry.markdownPath), /remote answer/);
});

test('remote import into new machine keeps remote canonical filename and source naming time', async () => {
  const local = setup(), remote = setup();
  const first = await remote.save(detail());
  const winner = await remote.save(detail('one', 'remote answer', 1792656000, { title: 'Renamed later' }));
  const applied = await local.store.applyRemoteFiles({ directory: local.directory, account, files: winner.files });
  assert.equal(applied.status, 'added');
  assert.equal(applied.entry.jsonPath, first.entry.jsonPath);
  assert.equal(applied.entry.namingTime, first.entry.namingTime);
});

test('different local filename remains stable while importing newer remote content', async () => {
  const local = setup(), remote = setup();
  const first = await local.save(detail('one', 'local', 1792569600, { title: 'Local first title' }));
  const winner = await remote.save(detail('one', 'remote', 1792656000, { title: 'Remote first title' }));
  assert.notEqual(first.entry.jsonPath, winner.entry.jsonPath);
  const applied = await local.store.applyRemoteFiles({ directory: local.directory, account, files: winner.files });
  assert.equal(applied.entry.jsonPath, first.entry.jsonPath);
  assert.equal(applied.remotePaths.jsonPath, winner.entry.jsonPath);
  assert.ok(!local.files.has(winner.entry.jsonPath));
});

test('remote import rejects tampering, foreign account, incomplete entry, and stale source', async () => {
  const local = setup(), remote = setup();
  await local.save(detail('one', 'newest', 1792742400));
  const winner = await remote.save(detail('one', 'older', 1792656000));
  const before = new Map(local.files);
  await assert.rejects(local.store.applyRemoteFiles({ directory: local.directory, account, files: winner.files }), { code: 'STALE_DETAIL' });
  const tampered = structuredClone(winner.files);
  tampered[0].content += ' ';
  await assert.rejects(local.store.applyRemoteFiles({ directory: local.directory, account, files: tampered }), { code: 'REMOTE_HASH' });
  const incomplete = structuredClone(winner.files);
  const mf = incomplete.find(file => file.path.endsWith('/archive/manifest.json'));
  const manifest = JSON.parse(mf.content);
  manifest.conversations.one.sourceCompleteness = 'partial'; mf.content = JSON.stringify(manifest);
  await assert.rejects(local.store.applyRemoteFiles({ directory: local.directory, account, files: incomplete }), { code: 'PARTIAL_DETAIL' });
  const foreign = structuredClone(winner.files);
  const af = foreign.find(file => file.path.endsWith('/account.json'));
  af.content = JSON.stringify({ ...JSON.parse(af.content), accountKey: 'other' });
  await assert.rejects(local.store.applyRemoteFiles({ directory: local.directory, account, files: foreign }), { code: 'ACCOUNT_MISMATCH' });
  assert.deepEqual(local.files, before);
});

test('remote reconciliation preserves local manual edits', async () => {
  const local = setup(), remote = setup();
  const original = await local.save(detail());
  local.files.set(original.entry.markdownPath, 'my notes');
  const winner = await remote.save(detail('one', 'remote', 1792656000));
  await assert.rejects(local.store.applyRemoteFiles({ directory: local.directory, account, files: winner.files }), { code: 'LOCAL_CONFLICT' });
  assert.equal(local.files.get(original.entry.markdownPath), 'my notes');
});

test('remote complete labels cannot override pagination, pending messages, or broken hidden branches in native JSON', async () => {
  const local = setup(), remote = setup();
  await local.save(detail());
  const winner = await remote.save(detail('one', 'newer but incomplete', 1792656000));
  const before = new Map(local.files);
  for (const mutate of [
    native => { native.has_more = true; },
    native => { native.page_info = { has_more: true }; },
    native => { native.mapping.reply.message.status = 'pending'; },
    native => { native.mapping.other = { parent: 'missing', message: null }; },
    native => { native.mapping.other = { parent: 'other', message: null }; },
  ]) {
    const files = structuredClone(winner.files);
    const nativeFile = files.find(file => file.path === winner.entry.jsonPath);
    const native = JSON.parse(nativeFile.content); mutate(native); nativeFile.content = JSON.stringify(native);
    const manifestFile = files.find(file => file.path.endsWith('/archive/manifest.json'));
    const manifest = JSON.parse(manifestFile.content);
    manifest.conversations.one.contentHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nativeFile.content))).toString('hex');
    manifestFile.content = JSON.stringify(manifest);
    await assert.rejects(local.store.applyRemoteFiles({ directory: local.directory, account, files }), { code: 'PARTIAL_DETAIL' });
    assert.deepEqual(local.files, before);
  }
});

test('a large account manifest retains 1000 other conversations without copying their bodies into each save', async () => {
  const fs = setup();
  const seed = await fs.save(detail('seed'));
  const manifest = structuredClone(seed.manifest);
  for (let i = 0; i < 1000; i++) {
    const id = `existing-${i}`;
    const jsonPath = seed.entry.jsonPath.replace('__seed.json', `__${id}.json`);
    manifest.conversations[id] = { ...seed.entry, conversationId: id, jsonPath, markdownPath: jsonPath.replace(/\.json$/, '.md') };
  }
  fs.files.set(`${accountPrefix(account)}/archive/manifest.json`, JSON.stringify(manifest));
  const saved = await fs.save(detail('new'));
  assert.equal(Object.keys(saved.manifest.conversations).length, 1002);
  assert.equal(saved.files.length, 4);
  assert.ok(saved.files.every(file => !file.path.includes('__existing-')));
  assert.ok(Buffer.byteLength(JSON.stringify(saved.files)) < 3 * 1024 * 1024);
});
