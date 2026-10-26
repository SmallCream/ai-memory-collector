import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syncArchives } from '../extension/lib/github-sync.js';
import { PROBE_CONTENT, PROBE_PATH } from '../extension/lib/github.js';
import { buildArchive } from '../extension/lib/archive.js';
import { formatLfsPointer } from './helpers/legacy-lfs.js';
import { extractAssets } from '../extension/lib/assets.js';
const ACCOUNT = 'acct-' + '1'.repeat(24);
const PREFIX = 'data/web/chatgpt/demo-' + '1'.repeat(8);
const MANIFEST = PREFIX + '/archive/manifest.json';
const ACCOUNT_FILE = PREFIX + '/account.json';
const CONFIG = { repository: 'demo/private-data', token: 'synthetic-token-value' };
const digest = s => createHash('sha256').update(s).digest('hex');
const gitHash = s => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
function bundle(id = 'conversation-one', time = 100, content = 'Hello', { old = {}, title = 'Demo' } = {}) {
  const text = json({ conversation_id: id, title, create_time: 1, update_time: time,
    current_node: 'a', mapping: { a: { parent: null, message: { id: 'message-a', author: { role: 'user' }, content: { parts: [content] } } } } });
  const md = `# ${title}\n\n**你：**\n\n${content}\n`;
  const jsonPath = `${PREFIX}/conversations/2026/10/2026-10-21T00-00-00Z__${title}__${id}.json`;
  const markdownPath = jsonPath.replace(/\.json$/, '.md');
  const entry = { conversationId: id, jsonPath, markdownPath, contentHash: digest(text), markdownHash: digest(md),
    sourceCompleteness: 'complete', sourceUpdatedAt: new Date(time * 1000).toISOString(),
    namingTime: '2026-10-21T00:00:00.000Z', firstCapturedAt: '2026-10-21T00:00:00.000Z', pathTimeBasis: 'source-created' };
  const manifest = { schemaVersion: 1, accountKey: ACCOUNT, platform: 'chatgpt', conversations: { ...old, [id]: entry } };
  return { accountKey: ACCOUNT, files: [
    { path: jsonPath, content: text }, { path: markdownPath, content: md },
    { path: MANIFEST, content: json(manifest) },
    { path: ACCOUNT_FILE, content: json({ schemaVersion: 1, platform: 'chatgpt', accountKey: ACCOUNT, dataPath: PREFIX, displayName: 'Demo' }) },
  ], entry, manifest };
}
const fileMap = x => Object.fromEntries(x.files.map(f => [f.path, f.content]));
function gitServer({ initial = {}, empty = false, privateRepo = true, branch = 'main', onPatch, corruptReadback = false, losePatchResponse = false } = {}) {
  const calls = [], trees = new Map(), commits = new Map(), blobs = new Map(); let sequence = 10, head = null, patched = false;
  const nextSha = () => (++sequence).toString(16).padStart(40, '0');
  function tree(files) {
    const treeSha = nextSha(); const entries = [];
    for (const [path, content] of Object.entries(files)) { const sha = gitHash(content); blobs.set(sha, content); entries.push({ path, mode: '100644', type: 'blob', sha, size: Buffer.byteLength(content) }); }
    trees.set(treeSha, { files: { ...files }, entries }); return treeSha;
  }
  function makeCommit(files, parent = head) {
    const sha = nextSha(), treeSha = tree(files); commits.set(sha, { sha, tree: { sha: treeSha }, parents: parent ? [{ sha: parent }] : [] }); head = sha; return sha;
  }
  if (!empty) makeCommit(initial, null);
  const fetchImpl = async (url, options) => {
    const u = new URL(url), path = u.pathname.replace('/repos/demo/private-data', '') + u.search;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body, options });
    assert.equal(u.origin, 'https://api.github.com'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    if (body) assert.ok(!JSON.stringify(body).includes(CONFIG.token));
    let data = {}, status = 200;
    if (path === '') data = { private: privateRepo, default_branch: branch };
    else if (path.startsWith('/git/ref/heads/')) { if (head) data = { object: { type: 'commit', sha: head } }; else status = 409; }
    else if (path === '/branches?per_page=1') data = head ? [{ name: branch }] : [];
    else if (path.startsWith('/contents/')) {
      if (options.method === 'PUT') {
        assert.equal(path, '/contents/' + PROBE_PATH); assert.equal(Buffer.from(body.content, 'base64').toString(), PROBE_CONTENT);
        const files = head ? { ...trees.get(commits.get(head).tree.sha).files } : {};
        files[PROBE_PATH] = PROBE_CONTENT; data = { commit: { sha: makeCommit(files) } }; status = 201;
      } else {
        const filename = decodeURIComponent(path.slice('/contents/'.length).split('?')[0]);
        const text = head && trees.get(commits.get(head).tree.sha).files[filename];
        if (typeof text !== 'string') status = 404;
        else data = { type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64'), sha: gitHash(text) };
      }
    } else if (path.startsWith('/git/commits/') && options.method === 'GET') {
      data = commits.get(path.slice('/git/commits/'.length)); if (!data) status = 404;
    } else if (path.startsWith('/git/trees/') && options.method === 'GET') {
      const t = trees.get(path.slice('/git/trees/'.length).split('?')[0]);
      data = { truncated: false, tree: t?.entries || [] };
      if (corruptReadback && patched) data.tree = [];
    } else if (path.startsWith('/git/blobs/')) {
      const text = blobs.get(path.slice('/git/blobs/'.length));
      assert.equal(typeof text, 'string'); data = { encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') };
    } else if (path === '/git/trees' && options.method === 'POST') {
      assert.ok(body.base_tree); const files = { ...trees.get(body.base_tree).files };
      for (const x of body.tree) { assert.equal(x.mode, '100644'); assert.equal(x.type, 'blob'); assert.equal(typeof x.content, 'string'); files[x.path] = x.content; }
      data = { sha: tree(files) }; status = 201;
    } else if (path === '/git/commits' && options.method === 'POST') {
      const sha = nextSha(); data = { sha, tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) }; commits.set(sha, data); status = 201;
    } else if (path.startsWith('/git/refs/heads/') && options.method === 'PATCH') {
      assert.equal(body.force, false);
      if (onPatch) await onPatch({ body, calls, add: extra => makeCommit({ ...trees.get(commits.get(head).tree.sha).files, ...extra }), files: () => trees.get(commits.get(head).tree.sha).files });
      const candidate = commits.get(body.sha);
      if (candidate.parents[0]?.sha !== head) { status = 422; data = { message: 'not a fast forward' }; }
      else { head = body.sha; patched = true; data = { object: { type: 'commit', sha: head } };
        if (losePatchResponse) { losePatchResponse = false; throw new Error('network lost synthetic-token-value'); }
      }
    } else if (path.startsWith('/compare/')) {
      const [base, target] = path.slice('/compare/'.length).split('...');
      let cursor = target; while (cursor && cursor !== base) cursor = commits.get(cursor)?.parents[0]?.sha;
      data = { status: cursor === base ? base === target ? 'identical' : 'ahead' : 'diverged' };
    } else throw new Error(`Unexpected fake request ${options.method} ${path}`);
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls, files: () => trees.get(commits.get(head)?.tree.sha)?.files || {}, head: () => head };
}

test('atomic commit stores native JSON, readable Markdown and manifest together, preserving unrelated files', async () => {
  const b = bundle(), server = gitServer({ initial: { 'unrelated.txt': 'keep' } });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.status, 'synced'); assert.equal(r.filesChanged, 4); assert.deepEqual(r.conflicts, []);
  assert.equal(server.files()['unrelated.txt'], 'keep');
  for (const f of b.files) {
    if (f.path === MANIFEST) assert.deepEqual(JSON.parse(server.files()[f.path]), JSON.parse(f.content));
    else assert.equal(server.files()[f.path], f.content);
  }
  assert.equal(server.calls.filter(c => c.method === 'PATCH').length, 1);
});

test('an identical replay performs no writes and never leaks the token', async () => {
  const b = bundle(), server = gitServer({ initial: fileMap(b) });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.status, 'unchanged'); assert.ok(server.calls.every(c => c.method === 'GET'));
  assert.ok(!JSON.stringify(r).includes(CONFIG.token));
});

test('shared manifest merges new conversation and preserves remote-only conversation entries', async () => {
  const a = bundle('one'), b = bundle('two'), server = gitServer({ initial: fileMap(a) });
  await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  const manifest = JSON.parse(server.files()[MANIFEST]);
  assert.deepEqual(Object.keys(manifest.conversations).sort(), ['one', 'two']);
  assert.equal(server.files()[a.entry.jsonPath], a.files[0].content);
});

test('concurrent writers refresh head and merge; never force push', async () => {
  const a = bundle('one'), b = bundle('two'); let raced = false;
  const server = gitServer({ initial: {}, onPatch: ({ add }) => { if (!raced) { raced = true; add(fileMap(a)); } } });
  await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.deepEqual(Object.keys(JSON.parse(server.files()[MANIFEST]).conversations).sort(), ['one', 'two']);
  assert.equal(server.calls.filter(c => c.method === 'PATCH').length, 2);
});

test('newer source timestamp updates canonical pair and keeps established filename', async () => {
  const old = bundle('one', 100, 'before'), newer = bundle('one', 200, 'after', { title: 'New title' });
  const server = gitServer({ initial: fileMap(old) });
  await syncArchives({ config: CONFIG, bundles: [newer], fetchImpl: server.fetchImpl });
  assert.equal(server.files()[old.entry.jsonPath], newer.files[0].content);
  assert.equal(server.files()[old.entry.markdownPath], newer.files[1].content);
  assert.equal(server.files()[newer.entry.jsonPath], undefined);
  assert.equal(JSON.parse(server.files()[MANIFEST]).conversations.one.jsonPath, old.entry.jsonPath);
});

test('newer remote source wins over old local copy without writes', async () => {
  const old = bundle('one', 100, 'before'), newer = bundle('one', 200, 'after');
  const server = gitServer({ initial: fileMap(newer) });
  const r = await syncArchives({ config: CONFIG, bundles: [old], fetchImpl: server.fetchImpl });
  assert.equal(r.status, 'unchanged'); assert.equal(r.remoteWinners.length, 1);
  assert.equal(r.remoteWinners[0].files[0].content, newer.files[0].content);
  assert.ok(server.calls.every(c => c.method === 'GET'));
});

test('equal-time divergence preserves both versions without changing remote canonical', async () => {
  const a = bundle('one', 100, 'remote'), b = bundle('one', 100, 'local'), server = gitServer({ initial: fileMap(a) });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.conflicts.length, 1); assert.equal(server.files()[a.entry.jsonPath], a.files[0].content);
  assert.equal(server.files()[r.conflicts[0].path], b.files[0].content);
  assert.equal(server.files()[r.conflicts[0].path.replace(/\.json$/, '.md')], b.files[1].content);
  const again = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(again.status, 'unchanged');
});

function flatBundle(time = 100, content = 'Hello') {
  const value = bundle('message-sync', time, content), native = JSON.parse(value.files[0].content);
  native.messages = [native.mapping.a.message];
  native.current_node = native.messages[0].id;
  native.page_info = { start_cursor: native.messages[0].id, end_cursor: native.messages[0].id,
    has_previous_page: false, has_next_page: false };
  delete native.mapping;
  value.files[0].content = json(native);
  value.entry.contentHash = digest(value.files[0].content);
  value.files.find(file => file.path === MANIFEST).content = json(value.manifest);
  return value;
}

function receipt(fullReadAt, checkedAt = fullReadAt) {
  const tail = checkedAt !== fullReadAt;
  return { schemaVersion: 1, format: 'flat', scope: 'selected-branch', mode: tail ? 'tail-merge' : 'full',
    fullReadAt, checkedAt, incrementalRuns: tail ? 1 : 0, pagesRead: 1,
    fetchedMessages: 1, reusedMessages: tail ? 1 : 0, addedMessages: 1, updatedMessages: 0 };
}

function setReceipt(value, sync, assets) {
  value.entry.messageSync = sync;
  if (assets !== undefined) value.entry.assets = assets;
  value.files.find(file => file.path === MANIFEST).content = json(value.manifest);
  return value;
}

test('a newer flat snapshot cannot erase tree branches in either sync direction', async t => {
  for (const treeIsRemote of [true, false]) await t.test(`tree is remote: ${treeIsRemote}`, async () => {
    const tree = bundle('message-sync', 100, 'Tree with branches'), flat = flatBundle(200, 'Newer selected branch');
    // Deliberately misleading hints must not override the actual source shape.
    setReceipt(tree, receipt(500));
    setReceipt(flat, { ...receipt(500), format: 'tree', scope: 'returned-tree' });
    const [local, remote] = treeIsRemote ? [flat, tree] : [tree, flat];
    const server = gitServer({ initial: fileMap(remote) });
    const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0].reason, /消息树/);
    assert.equal(result.remoteWinners.length, 0);
    assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
    assert.equal(server.files()[result.conflicts[0].path], local.files[0].content);
    assert.equal(server.files()[result.conflicts[0].path.replace(/\.json$/, '.md')], local.files[1].content);
  });
});

test('same native sync selects the latest full-history receipt with and without asset merging', async t => {
  for (const mergeAssets of [true, false]) for (const newerFullIsLocal of [true, false]) {
    await t.test(`assets: ${mergeAssets}; newer full is local: ${newerFullIsLocal}`, async () => {
      const newerFull = setReceipt(flatBundle(), receipt(200), mergeAssets ? [] : undefined);
      const olderFullNewerTail = setReceipt(flatBundle(), receipt(100, 300), mergeAssets ? [] : undefined);
      const [local, remote] = newerFullIsLocal ? [newerFull, olderFullNewerTail] : [olderFullNewerTail, newerFull];
      const server = gitServer({ initial: fileMap(remote) });
      const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
      assert.equal(result.conflicts.length, 0);
      assert.deepEqual(JSON.parse(server.files()[MANIFEST]).conversations['message-sync'].messageSync, receipt(200));
      assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
      if (mergeAssets) assert.deepEqual(result.remoteWinners[0].entry.messageSync, receipt(200));
      const replay = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
      assert.equal(replay.status, 'unchanged');
    });
  }
});

async function generationBundle(unfinished = true) {
  const initial = bundle('generation-state'), native = JSON.parse(initial.files[0].content);
  native.mapping.old = { parent: 'a', message: { id: 'old', author: { role: 'assistant' },
    status: unfinished ? 'in_progress' : 'finished_successfully', content: { parts: ['Historical answer'] } } };
  native.mapping.done = { parent: 'old', message: { id: 'done', author: { role: 'assistant' },
    status: 'finished_successfully', end_turn: true, content: { parts: ['Later completed answer'] } } };
  native.current_node = 'done';
  const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
    capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets: [] });
  const entry = built.manifest.conversations['generation-state'];
  entry.sourceCompleteness = 'complete';
  built.files.find(file => file.path === MANIFEST).content = json(built.manifest);
  return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry };
}

test('same native asset merge recomputes historical generation metadata and retains known complete structure', async () => {
  const local = await generationBundle(), remote = structuredClone(local);
  remote.entry = remote.manifest.conversations['generation-state'];
  remote.entry.generationState = { policy: 'old-policy', historicalUnfinishedCount: 999, unresolvedUnfinishedCount: 999 };
  remote.entry.warnings = ['Stale generation warning'];
  remote.entry.coverage.messages = 'partial';
  remote.entry.sourceCompleteness = 'partial';
  remote.files.find(file => file.path === MANIFEST).content = json(remote.manifest);
  const server = gitServer({ initial: fileMap(remote) });
  const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  assert.equal(result.conflicts.length, 0);
  const merged = JSON.parse(server.files()[MANIFEST]).conversations['generation-state'];
  assert.deepEqual(merged.generationState, local.entry.generationState);
  assert.deepEqual(merged.warnings, local.entry.warnings);
  assert.deepEqual(merged.coverage, local.entry.coverage);
  assert.equal(merged.sourceCompleteness, 'complete');
  assert.deepEqual(result.remoteWinners[0].entry, merged);
  assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
  assert.equal(JSON.parse(server.files()[remote.entry.jsonPath]).mapping.old.message.status, 'in_progress');
  assert.equal((await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl })).status, 'unchanged');
});

test('same native asset merge removes unsupported generation counts when the source has no unfinished messages', async () => {
  const local = await generationBundle(false), remote = structuredClone(local);
  remote.entry = remote.manifest.conversations['generation-state'];
  remote.entry.generationState = { policy: 'closed-descendant-v1', historicalUnfinishedCount: 8, unresolvedUnfinishedCount: 0 };
  remote.entry.warnings = ['Unsupported historical count'];
  remote.files.find(file => file.path === MANIFEST).content = json(remote.manifest);
  const server = gitServer({ initial: fileMap(remote) });
  const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  const merged = JSON.parse(server.files()[MANIFEST]).conversations['generation-state'];
  assert.equal(Object.hasOwn(merged, 'generationState'), false);
  assert.equal(Object.hasOwn(result.remoteWinners[0].entry, 'generationState'), false);
  assert.deepEqual(merged.warnings, local.entry.warnings);
  assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
});

test('same full-history time chooses the later valid receipt and discards incompatible formats', async () => {
  const local = setReceipt(flatBundle(), receipt(100, 200), []);
  const remote = setReceipt(flatBundle(), receipt(100, 300), []);
  let server = gitServer({ initial: fileMap(remote) });
  await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  assert.deepEqual(JSON.parse(server.files()[MANIFEST]).conversations['message-sync'].messageSync, receipt(100, 300));
  setReceipt(remote, { ...receipt(900), format: 'tree', scope: 'returned-tree' }, []);
  server = gitServer({ initial: fileMap(remote) });
  await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  assert.deepEqual(JSON.parse(server.files()[MANIFEST]).conversations['message-sync'].messageSync, receipt(100, 200));
});

test('message receipts do not migrate to different native bytes during derivative merges', async () => {
  const local = setReceipt(flatBundle(), receipt(300), []);
  const remote = setReceipt(flatBundle(), receipt(100), []);
  remote.files[0].content = JSON.stringify(JSON.parse(remote.files[0].content));
  remote.entry.contentHash = digest(remote.files[0].content);
  remote.files.find(file => file.path === MANIFEST).content = json(remote.manifest);
  const server = gitServer({ initial: fileMap(remote) });
  const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
  assert.deepEqual(result.remoteWinners[0].entry.messageSync, receipt(100));
  assert.deepEqual(JSON.parse(server.files()[MANIFEST]).conversations['message-sync'].messageSync, receipt(100));
});

test('a changed native version cannot inherit an unrelated remote message receipt', async () => {
  const local = flatBundle(200, 'Changed content'), remote = setReceipt(flatBundle(100), receipt(500));
  const server = gitServer({ initial: fileMap(remote) });
  await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  assert.equal(JSON.parse(server.files()[MANIFEST]).conversations['message-sync'].messageSync, undefined);
  assert.equal(server.files()[remote.entry.jsonPath], local.files[0].content);
});

test('external remote JSON edit is not overwritten even by newer source timestamp', async () => {
  const a = bundle('one', 100, 'remote'), b = bundle('one', 200, 'local');
  const custom = json({ ...JSON.parse(a.files[0].content), title: 'Manual edit' });
  const server = gitServer({ initial: { ...fileMap(a), [a.entry.jsonPath]: custom } });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.conflicts.length, 1); assert.equal(server.files()[a.entry.jsonPath], custom);
});

test('external remote Markdown edit is preserved alongside new candidate', async () => {
  const a = bundle('one'), b = bundle('one', 200, 'updated');
  const server = gitServer({ initial: { ...fileMap(a), [a.entry.markdownPath]: 'User note' } });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.conflicts.length, 1); assert.equal(server.files()[a.entry.markdownPath], 'User note');
});

test('public repository and cross-account paths are rejected before write', async () => {
  const b = bundle(), server = gitServer({ privateRepo: false });
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }), { code: 'PRIVATE_REPOSITORY_REQUIRED' });
  assert.equal(server.calls.length, 1);
  const tampered = structuredClone(b); tampered.files[0].path = 'data/web/chatgpt/other/x.json';
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [tampered], fetchImpl: server.fetchImpl }), { code: 'ACCOUNT_OWNERSHIP' });
  assert.equal(server.calls.length, 1);
});

test('different remote account ownership is rejected before any write', async () => {
  const b = bundle(), initial = fileMap(b);
  initial[ACCOUNT_FILE] = json({ platform: 'chatgpt', accountKey: 'acct-' + '2'.repeat(24), dataPath: PREFIX });
  const server = gitServer({ initial });
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }), { code: 'ACCOUNT_OWNERSHIP' });
  assert.ok(server.calls.every(c => c.method === 'GET'));
});

test('empty repository uses fixed synthetic seed, then atomic real archive commit', async () => {
  const b = bundle(), server = gitServer({ empty: true });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.status, 'synced'); assert.equal(server.files()[PROBE_PATH], PROBE_CONTENT);
  assert.equal(server.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(server.calls.filter(c => c.method === 'PATCH').length, 1);
});

test('failed readback does not report sync success', async () => {
  const server = gitServer({ corruptReadback: true });
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [bundle()], fetchImpl: server.fetchImpl }), { code: 'WRITE_UNCONFIRMED' });
});

test('hash-mismatched and partial local snapshots are not uploaded', async () => {
  const b = bundle(); b.files[0].content += ' ';
  const server = gitServer();
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }), { code: 'LOCAL_HASH' });
  assert.ok(server.calls.every(c => c.method === 'GET'));
});


test('one atomic batch merges manifests from successive local saves without dropping entries', async () => {
  const a = bundle('one'), b = bundle('two', 100, 'Second', { old: a.manifest.conversations });
  const server = gitServer();
  const r = await syncArchives({ config: CONFIG, bundles: [a, b], fetchImpl: server.fetchImpl });
  assert.equal(r.filesChanged, 6);
  assert.deepEqual(Object.keys(JSON.parse(server.files()[MANIFEST]).conversations).sort(), ['one', 'two']);
  assert.equal(server.calls.filter(c => c.method === 'PATCH').length, 1);
});

test('lost successful PATCH response is verified without duplicate commit or rewrite', async () => {
  const server = gitServer({ losePatchResponse: true });
  const r = await syncArchives({ config: CONFIG, bundles: [bundle()], fetchImpl: server.fetchImpl });
  assert.equal(r.status, 'synced');
  assert.equal(server.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.ok(!JSON.stringify(r).includes(CONFIG.token));
});

test('newer remote JSON regenerates its missing Markdown and returns complete guarded import bundle', async () => {
  const old = bundle('one', 100, 'before'), newer = bundle('one', 200, 'after');
  const initial = fileMap(newer); delete initial[newer.entry.markdownPath];
  const server = gitServer({ initial });
  const r = await syncArchives({ config: CONFIG, bundles: [old], fetchImpl: server.fetchImpl });
  assert.equal(r.status, 'synced'); assert.equal(r.remoteWinners[0].files.length, 4);
  const files = Object.fromEntries(r.remoteWinners[0].files.map(f => [f.path, f.content]));
  assert.equal(files[newer.entry.jsonPath], newer.files[0].content);
  assert.match(files[newer.entry.markdownPath], /after/);
  const entry = JSON.parse(files[MANIFEST]).conversations.one;
  assert.equal(digest(files[entry.markdownPath]), entry.markdownHash);
});

test('malformed manually edited remote JSON is preserved; candidate stored separately', async () => {
  const a = bundle('one'), b = bundle('one', 200, 'updated');
  const server = gitServer({ initial: { ...fileMap(a), [a.entry.jsonPath]: 'unfinished user edit' } });
  const r = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(r.conflicts.length, 1);
  assert.equal(server.files()[a.entry.jsonPath], 'unfinished user edit');
});

test('partial local manifest is rejected even when file hashes match', async () => {
  const b = bundle(); b.manifest.conversations[b.entry.conversationId].sourceCompleteness = 'partial';
  b.files.find(f => f.path === MANIFEST).content = json(b.manifest);
  const server = gitServer();
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }), { code: 'LOCAL_HASH' });
  assert.ok(server.calls.every(c => c.method === 'GET'));
});

const IMAGE = { id: digest('file-one'), sourceRef: 'file-service://file-one', sourceType: 'platform',
  fileId: 'file-one', status: 'downloaded', oid: digest('synthetic-image'), size: 15,
  localPath: `${PREFIX}/assets/${digest('synthetic-image')}.png` };
const pointer = asset => ({ accountKey: ACCOUNT, path: asset.localPath, oid: asset.oid, size: asset.size, content: formatLfsPointer(asset) });
const ATTRIBUTES = `${PREFIX}/.gitattributes`;
const RULE = 'assets/** filter=lfs diff=lfs merge=lfs -text\n';
async function pictureBundle({ assets = [IMAGE], time = 100, text = 'Screenshot' } = {}) {
  const initial = bundle('picture', time, text);
  const native = JSON.parse(initial.files[0].content);
  native.mapping.a.message.content.parts.push({ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-one' });
  const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
    capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets });
  return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry: built.manifest.conversations.picture };
}

test('text-only cloud backup saves conversations without LFS pointers or changing the local bundle', async () => {
  const b = await pictureBundle(), before = structuredClone(b), server = gitServer();
  const result = await syncArchives({ config: { ...CONFIG, lfsEnabled: false }, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  assert.equal(server.files()[b.entry.jsonPath], b.files[0].content);
  assert.equal(server.files()[b.entry.markdownPath], b.files[1].content);
  assert.equal(server.files()[IMAGE.localPath], undefined);
  assert.equal(server.files()[ATTRIBUTES], undefined);
  const asset = JSON.parse(server.files()[MANIFEST]).conversations.picture.assets[0];
  assert.equal(asset.cloudStatus, 'local-only'); assert.equal(asset.oid, IMAGE.oid);
  assert.deepEqual(b, before);
  const replay = await syncArchives({ config: { ...CONFIG, lfsEnabled: false }, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(replay.status, 'unchanged');
  assert.equal(replay.remoteWinners[0].entry.assets[0].cloudStatus, 'local-only');
});

test('text-only upload preserves all historical asset files without inspecting or rewriting them', async () => {
  const b = await pictureBundle();
  const server = gitServer({ initial: { ...fileMap(b), [IMAGE.localPath]: formatLfsPointer(IMAGE), [ATTRIBUTES]: RULE } });
  const result = await syncArchives({ config: { ...CONFIG, lfsEnabled: false }, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  assert.equal(server.files()[IMAGE.localPath], formatLfsPointer(IMAGE));
  assert.equal(JSON.parse(server.files()[MANIFEST]).conversations.picture.assets[0].cloudStatus, 'local-only');
  const bad = gitServer({ initial: { [IMAGE.localPath]: 'unrelated user-owned file' } });
  await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: bad.fetchImpl });
  assert.equal(bad.files()[IMAGE.localPath], 'unrelated user-owned file');
});



async function downloadableBundle(extension = 'zip', downloaded = true) {
  const initial = bundle('downloadable'), native = JSON.parse(initial.files[0].content);
  const fileName = `report.${extension}`;
  native.mapping.a.message.content.parts.push({ content_type: 'file', file_id: 'file-synthetic-download', name: fileName });
  const [source] = await extractAssets(native);
  const oid = digest(`synthetic-download-${extension}`);
  const asset = downloaded ? { ...source, status: 'downloaded', oid, size: 32,
    localPath: `${PREFIX}/assets/${oid}.${extension}` } : source;
  const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
    capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets: [asset] });
  return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry: built.manifest.conversations.downloadable, asset };
}

test('downloadable attachments commit metadata and text without binary files or pointers', async () => {
  for (const extension of ['zip', 'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'py']) {
    const b = await downloadableBundle(extension), server = gitServer();
    const result = await syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(b.asset)], fetchImpl: server.fetchImpl });
    assert.equal(result.status, 'synced');
    assert.equal(server.files()[b.asset.localPath], undefined);
    assert.equal(server.files()[b.entry.jsonPath], b.files[0].content);
    assert.ok(server.files()[b.entry.markdownPath].includes(`[report\\.${extension}](../../../assets/${b.asset.oid}.${extension})`));
    assert.equal(JSON.parse(server.files()[MANIFEST]).conversations.downloadable.assets[0].status, 'downloaded');
    assert.equal(server.files()[ATTRIBUTES], undefined);
    assert.equal(server.calls.filter(call => call.method === 'PATCH').length, 1);
  }
});

test('same native downloadable attachment merges preserve ready remote files and upgrade pending remote files', async () => {
  const ready = await downloadableBundle(), pending = await downloadableBundle('zip', false);
  assert.equal(ready.files[0].content, pending.files[0].content);
  for (const localReady of [true, false]) {
    const local = localReady ? ready : pending, remote = localReady ? pending : ready;
    const server = gitServer({ initial: { ...fileMap(remote), ...(!localReady ? {
      [ready.asset.localPath]: formatLfsPointer(ready.asset), [ATTRIBUTES]: RULE,
    } : {}) } });
    const result = await syncArchives({ config: CONFIG, bundles: [local],
      ...(localReady ? { assetPointers: [pointer(ready.asset)] } : {}), fetchImpl: server.fetchImpl });
    assert.equal(result.status, 'synced');
    const merged = JSON.parse(server.files()[MANIFEST]).conversations.downloadable.assets[0];
    assert.equal(merged.status, 'downloaded');
    assert.equal(merged.localPath, ready.asset.localPath);
    assert.equal(server.files()[ready.entry.markdownPath], ready.files[1].content);
    assert.equal(server.files()[ready.entry.jsonPath], ready.files[0].content);
  }
});

test('generic attachment paths still reject unsupported suffixes, wrong hashes and cross-account ownership', async () => {
  for (const invalid of ['unsupported', 'hash', 'account']) {
    const b = await downloadableBundle(), server = gitServer();
    const value = b.manifest.conversations.downloadable.assets[0];
    value.localPath = invalid === 'unsupported' ? value.localPath.replace(/zip$/, 'exe') :
      invalid === 'hash' ? value.localPath.replace(value.oid, 'f'.repeat(64)) :
        value.localPath.replace(PREFIX, 'data/web/chatgpt/other');
    b.files.find(file => file.path === MANIFEST).content = json(b.manifest);
    await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }),
      { code: invalid === 'account' ? 'ACCOUNT_OWNERSHIP' : 'ARCHIVE_ASSET' });
    assert.equal(server.calls.length, 0);
  }
});

async function citedPictureBundles({ ambiguous = false, readyAlias = false } = {}) {
  const initial = bundle('cited-picture'), native = JSON.parse(initial.files[0].content);
  const libraryFileId = 'libfile_synthetic_citation';
  native.mapping.a.message.content.parts.push({ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-one' });
  native.mapping.a.message.metadata = { attachments: [{ id: 'file-one', library_file_id: libraryFileId, name: 'synthetic.png' }] };
  if (ambiguous) native.mapping.a.message.metadata.attachments.push({ id: 'file-synthetic-other', library_file_id: libraryFileId, name: 'other.png' });
  native.current_node = 'citation';
  native.mapping.citation = { parent: 'a', message: { id: 'synthetic-citation-message', author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['Synthetic answer'] }, metadata: { content_references: [
      { type: 'file', source: 'my_files', id: 'file-one', library_file_id: libraryFileId, name: 'synthetic.png' },
    ] } } };
  const extracted = await extractAssets(native), canonical = extracted.find(asset => asset.fileId === 'file-one');
  const ready = { ...canonical, status: 'downloaded', oid: IMAGE.oid, size: IMAGE.size, localPath: IMAGE.localPath,
    occurrences: canonical.occurrences.filter(item => item.messageId !== 'synthetic-citation-message') };
  const alias = { id: digest(`platform:library:${libraryFileId}`), sourceType: 'platform', sourceRef: `library:${libraryFileId}`,
    libraryFileId, status: 'pending', fileName: 'synthetic.png', kind: 'attachment', references: [`library:${libraryFileId}`],
    occurrences: canonical.occurrences.filter(item => item.messageId === 'synthetic-citation-message') };
  if (readyAlias) Object.assign(alias, { status: 'synced', oid: ready.oid, size: ready.size, localPath: ready.localPath });
  const build = async assets => {
    const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
      capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets });
    return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry: built.manifest.conversations['cited-picture'] };
  };
  return { local: await build(extracted), remote: await build([ready, ...extracted.filter(asset => asset.id !== canonical.id), alias]),
    canonical, alias, ready };
}

async function internalViewerBundles({ visible = false } = {}) {
  const initial = bundle('internal-viewer'), native = JSON.parse(initial.files[0].content);
  native.mapping.viewer = { parent: 'a', message: { id: 'synthetic-viewer-message',
    author: { role: 'tool', name: 'container.open_image' }, content: { content_type: 'execution_output', text: '<<ImageDisplayed>>' },
    metadata: { attachments: [{ id: 'file_synthetic_viewer', name: 'mnt/data/synthetic.png', mime_type: 'image/png' }] } } };
  native.current_node = 'viewer';
  if (visible) native.mapping.a.message.content.parts.push({ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_synthetic_viewer' });
  const [asset] = await extractAssets(native);
  const build = async assets => {
    const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
      capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets });
    return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry: built.manifest.conversations['internal-viewer'] };
  };
  return { asset, build };
}

test('same-native merge does not resurrect legacy interface icons or erase actual attachments', async () => {
  const initial = bundle('interface-icons'), native = JSON.parse(initial.files[0].content);
  const sourceRef = '/images/ecosystem/apps/example/icon.png';
  native.mapping.a.message.metadata = { dil_v2_reasoning: { appData: { icon: { type: 'image', src: sourceRef } } } };
  native.mapping.a.message.content.parts.push({ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-one' });
  const [picture] = await extractAssets(native);
  const icon = { id: digest(`unknown:${sourceRef}`), sourceRef, sourceType: 'unknown', kind: 'image', status: 'pending' };
  const build = async assets => {
    const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
      capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets });
    return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry: built.manifest.conversations['interface-icons'] };
  };
  const corrected = await build([picture]), legacy = await build([picture, icon]);
  for (const [local, remote] of [[corrected, legacy], [legacy, corrected]]) {
    const server = gitServer({ initial: fileMap(remote) });
    await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    const assets = JSON.parse(server.files()[MANIFEST]).conversations['interface-icons'].assets;
    assert.equal(assets.length, 1); assert.equal(assets[0].id, picture.id);
    assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
    const again = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.equal(again.status, 'unchanged');
  }
});

async function ordinaryLinkBundles({ resource = null } = {}) {
  const sourceRef = 'https://github.com/example/project/blob/main/README.md';
  const initial = bundle('ordinary-link'), native = JSON.parse(initial.files[0].content);
  native.mapping.a.message.content.parts = [`[说明](${sourceRef})`];
  if (resource === 'image') native.mapping.a.message.content.parts.push(`![image](${sourceRef})`);
  if (resource === 'download') native.mapping.a.message.content.parts.push(`<a href="${sourceRef}" download>下载</a>`);
  if (resource === 'metadata') native.mapping.a.message.metadata = {
    attachments: [{ id: 'file_synthetic_document', url: sourceRef, name: 'README.md', mime_type: 'text/markdown' }],
  };
  const legacy = { id: digest(`external:${sourceRef}`), sourceRef, sourceType: 'external',
    kind: 'attachment', fileName: 'README.md', messageId: 'message-a', status: 'pending' };
  const build = async assets => {
    const built = await buildArchive({ conversation: native, identity: { accountKey: ACCOUNT, displayName: 'Demo' },
      capturedAt: '2026-10-21T00:00:00Z', existingManifest: initial.manifest, productionPrefix: PREFIX, assets });
    return { accountKey: ACCOUNT, files: built.files, manifest: built.manifest, entry: built.manifest.conversations['ordinary-link'] };
  };
  return { native, sourceRef, legacy, build };
}

test('same-native merge prevents ordinary GitHub links from returning from either older device', async () => {
  const { sourceRef, legacy, build } = await ordinaryLinkBundles();
  const corrected = await build([]), old = await build([legacy]);
  for (const [local, remote] of [[corrected, old], [old, corrected]]) {
    const server = gitServer({ initial: fileMap(remote) });
    const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.deepEqual(JSON.parse(server.files()[MANIFEST]).conversations['ordinary-link'].assets, []);
    assert.deepEqual(result.remoteWinners[0].entry.assets, []);
    assert.ok(server.files()[remote.entry.markdownPath].includes(`[说明](${sourceRef})`));
    assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
    const replay = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.equal(replay.status, 'unchanged');
  }
});

test('same-native link-policy cleanup preserves existing bytes and pending recovery evidence from either device', async t => {
  const { legacy, build } = await ordinaryLinkBundles();
  const oid = digest('synthetic-markdown'), localPath = `${PREFIX}/assets/${oid}.md`;
  const changes = [
    { status: 'downloaded', oid, localPath, size: 10 },
    { sha256: oid }, { oid }, { localPath },
  ];
  for (const change of changes) await t.test(Object.keys(change).join(','), async () => {
    const protectedRecord = { ...legacy, ...change }, protectedBundle = await build([protectedRecord]), old = await build([legacy]);
    for (const [local, remote] of [[protectedBundle, old], [old, protectedBundle]]) {
      const server = gitServer({ initial: fileMap(remote) });
      const result = await syncArchives({ config: { ...CONFIG, lfsEnabled: false }, bundles: [local], fetchImpl: server.fetchImpl });
      const [retained] = result.remoteWinners[0].entry.assets;
      assert.equal(retained.id, legacy.id);
      for (const [field, value] of Object.entries(change)) assert.equal(retained[field], value, field);
      const again = await syncArchives({ config: { ...CONFIG, lfsEnabled: false }, bundles: [local], fetchImpl: server.fetchImpl });
      assert.equal(again.status, 'unchanged');
    }
  });
});

test('same-native link-policy cleanup keeps actual media, explicit downloads and native attachment metadata', async t => {
  for (const resource of ['image', 'download', 'metadata']) await t.test(resource, async () => {
    const { native, legacy, build } = await ordinaryLinkBundles({ resource });
    const extracted = await extractAssets(native);
    const combined = [...new Map([...extracted, legacy].map(asset => [asset.id, asset])).values()];
    const current = await build(extracted), old = await build(combined);
    const server = gitServer({ initial: fileMap(old) });
    const result = await syncArchives({ config: CONFIG, bundles: [current], fetchImpl: server.fetchImpl });
    const retained = result.remoteWinners[0].entry.assets;
    assert.ok(retained.some(asset => asset.id === legacy.id));
    for (const asset of extracted) assert.ok(retained.some(item => item.id === asset.id));
  });
});

test('same-native link-policy cleanup does not discard a descriptor with a different source classification', async () => {
  const { legacy, build } = await ordinaryLinkBundles();
  const current = await build([{ ...legacy, sourceType: 'unknown' }]), old = await build([legacy]);
  for (const [local, remote] of [[current, old], [old, current]]) {
    const server = gitServer({ initial: fileMap(remote) });
    const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.equal(result.remoteWinners[0].entry.assets.length, 1);
    assert.equal(result.remoteWinners[0].entry.assets[0].sourceType, 'unknown');
    const replay = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.equal(replay.status, 'unchanged');
  }
});

test('same native merge preserves a suspended internal 404 from either device and stays stable on replay', async () => {
  const { asset, build } = await internalViewerBundles();
  const stale = await build([asset]), suspended = await build([{ ...asset, status: 'unavailable',
    autoRetrySuspended: true, errorCode: 'HTTP_404' }]);
  for (const [local, remote] of [[stale, suspended], [suspended, stale]]) {
    const server = gitServer({ initial: fileMap(remote) });
    const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    const [merged] = JSON.parse(server.files()[MANIFEST]).conversations['internal-viewer'].assets;
    assert.equal(merged.capturePolicy, 'internal-viewer');
    assert.equal(merged.autoRetrySuspended, true);
    assert.equal(merged.errorCode, 'HTTP_404');
    assert.equal(result.remoteWinners[0].entry.assets[0].autoRetrySuspended, true);
    assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
    const replay = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
    assert.equal(replay.status, 'unchanged');
  }
});

test('same native merge clears an unsupported internal label when the image also occurs in the conversation', async () => {
  const { asset, build } = await internalViewerBundles({ visible: true });
  const normal = await build([asset]), mislabeled = await build([{ ...asset, capturePolicy: 'internal-viewer',
    status: 'unavailable', autoRetrySuspended: true, errorCode: 'HTTP_404' }]);
  const server = gitServer({ initial: fileMap(mislabeled) });
  const result = await syncArchives({ config: CONFIG, bundles: [normal], fetchImpl: server.fetchImpl });
  const [merged] = result.remoteWinners[0].entry.assets;
  assert.equal(merged.capturePolicy, undefined);
  assert.equal(merged.autoRetrySuspended, undefined);
});

test('same native merge keeps saved internal bytes over a suspended snapshot from either device', async () => {
  const { asset, build } = await internalViewerBundles();
  const savedAsset = { ...asset, status: 'downloaded', oid: IMAGE.oid, size: IMAGE.size, localPath: IMAGE.localPath };
  const saved = await build([savedAsset]), suspended = await build([{ ...asset, status: 'unavailable',
    autoRetrySuspended: true, errorCode: 'HTTP_404' }]);
  for (const [local, remote] of [[saved, suspended], [suspended, saved]]) {
    const server = gitServer({ initial: { ...fileMap(remote), [savedAsset.localPath]: formatLfsPointer(savedAsset), [ATTRIBUTES]: RULE } });
    const result = await syncArchives({ config: CONFIG, bundles: [local],
      assetPointers: local === saved ? [pointer(savedAsset)] : [], fetchImpl: server.fetchImpl });
    const [merged] = result.remoteWinners[0].entry.assets;
    assert.equal(merged.status, 'downloaded');
    assert.equal(merged.oid, savedAsset.oid);
    assert.equal(merged.autoRetrySuspended, undefined);
  }
});

test('same native sync retires a proven remote file-citation duplicate, keeps ready bytes and stabilizes on replay', async () => {
  const { local, remote, canonical, alias, ready } = await citedPictureBundles();
  const server = gitServer({ initial: { ...fileMap(remote), [ready.localPath]: formatLfsPointer(ready), [ATTRIBUTES]: RULE } });
  const result = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  const assets = JSON.parse(server.files()[MANIFEST]).conversations['cited-picture'].assets;
  assert.equal(assets.length, 1); assert.equal(assets[0].id, canonical.id);
  assert.equal(assets[0].status, 'downloaded'); assert.equal(assets[0].oid, ready.oid);
  assert.equal(assets[0].occurrences.length, 3);
  assert.ok(!assets.some(asset => asset.id === alias.id));
  assert.equal(result.remoteWinners[0].entry.assets.length, 1);
  assert.equal(server.files()[remote.entry.jsonPath], remote.files[0].content);
  const before = server.calls.length;
  const again = await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  assert.equal(again.status, 'unchanged'); assert.ok(server.calls.slice(before).every(call => call.method === 'GET'));
  assert.equal(again.remoteWinners[0].entry.assets.length, 1);
});

test('same native sync preserves ambiguous library identities instead of retiring their records', async () => {
  const { local, remote, alias, ready } = await citedPictureBundles({ ambiguous: true });
  const server = gitServer({ initial: { ...fileMap(remote), [ready.localPath]: formatLfsPointer(ready), [ATTRIBUTES]: RULE } });
  await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  const assets = JSON.parse(server.files()[MANIFEST]).conversations['cited-picture'].assets;
  assert.equal(assets.length, 3); assert.ok(assets.some(asset => asset.id === alias.id));
  assert.equal(assets.find(asset => asset.id === ready.id).status, 'downloaded');
});

test('same native sync does not retire a legacy citation that already owns saved image bytes', async () => {
  const { local, remote, alias, ready } = await citedPictureBundles({ readyAlias: true });
  const server = gitServer({ initial: { ...fileMap(remote), [ready.localPath]: formatLfsPointer(ready), [ATTRIBUTES]: RULE } });
  await syncArchives({ config: CONFIG, bundles: [local], fetchImpl: server.fetchImpl });
  const assets = JSON.parse(server.files()[MANIFEST]).conversations['cited-picture'].assets;
  assert.equal(assets.length, 2);
  assert.equal(assets.find(asset => asset.id === alias.id).status, 'synced');
  assert.equal(assets.find(asset => asset.id === alias.id).oid, alias.oid);
});

test('text commits remain atomic without creating pointers or editing existing attributes', async () => {
  const b = await pictureBundle(), server = gitServer({ initial: { [ATTRIBUTES]: '*.md text eol=lf\n', 'notes.txt': 'keep' } });
  const result = await syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  assert.equal(result.filesChanged, 4);
  assert.equal(server.calls.filter(call => call.method === 'PATCH').length, 1);
  const commitFiles = server.calls.find(call => call.path === '/git/trees' && call.method === 'POST').body.tree;
  assert.equal(commitFiles.length, 4);
  assert.equal(server.files()[IMAGE.localPath], undefined);
  assert.equal(server.files()[ATTRIBUTES], '*.md text eol=lf\n');
  assert.equal(server.files()[b.entry.jsonPath], b.files[0].content);
  assert.match(server.files()[b.entry.markdownPath], new RegExp(`\\.\\./\\.\\./\\.\\./assets/${IMAGE.oid}\\.png`));
  assert.equal(server.files()['notes.txt'], 'keep');
  assert.equal(JSON.parse(server.files()[MANIFEST]).conversations.picture.assets[0].oid, IMAGE.oid);
  const replay = await syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl });
  assert.equal(replay.status, 'unchanged');
});


test('an identical existing pointer permits new references without another descriptor', async () => {
  const b = await pictureBundle(), server = gitServer({ initial: { [IMAGE.localPath]: formatLfsPointer(IMAGE), [ATTRIBUTES]: RULE } });
  const result = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  const files = server.calls.find(call => call.path === '/git/trees' && call.method === 'POST').body.tree;
  assert.ok(!files.some(file => file.path === IMAGE.localPath));
});



test('cross-account and non-hash image paths inside a manifest fail before any request', async () => {
  for (const localPath of [`data/web/chatgpt/other/assets/${IMAGE.oid}.png`, `${PREFIX}/assets/not-the-hash.png`, `${PREFIX}/assets/../image.png`]) {
    const b = await pictureBundle();
    b.manifest.conversations.picture.assets[0].localPath = localPath;
    b.files.find(file => file.path === MANIFEST).content = json(b.manifest);
    const server = gitServer();
    await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }));
    assert.equal(server.calls.length, 0);
  }
});

test('same native JSON preserves richer remote asset status and image Markdown over pending local copy', async () => {
  const ready = await pictureBundle();
  const pending = await pictureBundle({ assets: [{ id: IMAGE.id, sourceRef: IMAGE.sourceRef, status: 'pending' }] });
  assert.equal(ready.files[0].content, pending.files[0].content);
  const server = gitServer({ initial: { ...fileMap(ready), [IMAGE.localPath]: formatLfsPointer(IMAGE), [ATTRIBUTES]: RULE } });
  const result = await syncArchives({ config: CONFIG, bundles: [pending], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  assert.equal(server.files()[ready.entry.markdownPath], ready.files[1].content);
  assert.equal(result.remoteWinners[0].entry.assets[0].status, 'downloaded');
  assert.equal(result.remoteWinners[0].entry.assets[0].oid, IMAGE.oid);
  assert.equal(JSON.parse(server.files()[MANIFEST]).conversations.picture.assets[0].cloudStatus, 'local-only');
  assert.equal(server.files()[IMAGE.localPath], formatLfsPointer(IMAGE));
});

test('same native JSON can upgrade pending remote image with newly uploaded local asset', async () => {
  const ready = await pictureBundle();
  const pending = await pictureBundle({ assets: [{ id: IMAGE.id, sourceRef: IMAGE.sourceRef, status: 'pending' }] });
  const server = gitServer({ initial: fileMap(pending) });
  const result = await syncArchives({ config: CONFIG, bundles: [ready], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  const manifest = JSON.parse(server.files()[MANIFEST]);
  assert.equal(manifest.conversations.picture.assets[0].status, 'downloaded');
  assert.equal(server.files()[ready.entry.markdownPath], ready.files[1].content);
  assert.equal(server.files()[ready.entry.jsonPath], pending.files[0].content);
});

test('regenerating a missing newer remote Markdown retains its saved image references', async () => {
  const newer = await pictureBundle({ time: 200 }), older = await pictureBundle({ time: 100, assets: [] });
  const initial = { ...fileMap(newer), [IMAGE.localPath]: formatLfsPointer(IMAGE), [ATTRIBUTES]: RULE };
  delete initial[newer.entry.markdownPath];
  const server = gitServer({ initial });
  const result = await syncArchives({ config: CONFIG, bundles: [older], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  assert.match(server.files()[newer.entry.markdownPath], new RegExp(IMAGE.oid));
  assert.equal(result.remoteWinners[0].entry.assets[0].oid, IMAGE.oid);
});


test('turning off or changing the sync target during remote reads stops every later write', async () => {
  const b = bundle(), server = gitServer(); let current = true;
  const fetchImpl = async (url, options) => {
    const response = await server.fetchImpl(url, options);
    if (options.method === 'GET' && new URL(url).pathname.includes('/git/trees/')) current = false;
    return response;
  };
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl, isCurrent: async () => current }),
    { code: 'GITHUB_TARGET_CHANGED' });
  assert.ok(server.calls.every(call => call.method === 'GET'));
  assert.deepEqual(server.files(), {});
});

test('settings changes while tree or commit responses are pending stop the next write boundary', async () => {
  for (const afterPath of ['/git/trees', '/git/commits']) {
    const b = bundle(), server = gitServer(); let current = true;
    const fetchImpl = async (url, options) => {
      const response = await server.fetchImpl(url, options);
      if (options.method === 'POST' && new URL(url).pathname.endsWith(afterPath)) {
        const read = response.json.bind(response);
        response.json = async () => { const data = await read(); current = false; return data; };
      }
      return response;
    };
    await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl, isCurrent: async () => current }),
      { code: 'GITHUB_TARGET_CHANGED' });
    const writes = server.calls.filter(call => call.method !== 'GET');
    assert.deepEqual(writes.map(call => call.path), afterPath === '/git/trees' ? ['/git/trees'] : ['/git/trees', '/git/commits']);
    assert.deepEqual(server.files(), {}, 'unreferenced objects must not advance the branch');
  }
});

test('nested empty-repository initialization rechecks settings after its internal GET before PUT', async () => {
  const b = bundle(), server = gitServer({ empty: true }); let current = true, branchReads = 0;
  const fetchImpl = async (url, options) => {
    const response = await server.fetchImpl(url, options);
    if (options.method === 'GET' && new URL(url).pathname.endsWith('/branches') && ++branchReads === 2) current = false;
    return response;
  };
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl, isCurrent: async () => current }),
    { code: 'GITHUB_TARGET_CHANGED' });
  assert.equal(branchReads, 2, 'the change occurs inside commitProbe, after the outer empty-repository check');
  assert.ok(server.calls.every(call => call.method === 'GET'));
  assert.equal(server.head(), null);
});

test('a target change after a conflicting PATCH prevents a retry from writing to the old target', async () => {
  let current = true;
  const server = gitServer({ onPatch: ({ add }) => { add({ 'concurrent.txt': 'keep' }); current = false; } });
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [bundle()], fetchImpl: server.fetchImpl, isCurrent: async () => current }),
    { code: 'GITHUB_TARGET_CHANGED' });
  assert.equal(server.calls.filter(call => call.path === '/git/trees' && call.method === 'POST').length, 1);
  assert.equal(server.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.deepEqual(server.files(), { 'concurrent.txt': 'keep' });
});

test('already-issued PATCH requests retain readback and lost-response verification after settings change', async () => {
  for (const losePatchResponse of [false, true]) {
    let current = true;
    const b = bundle(), server = gitServer({ losePatchResponse, onPatch: () => { current = false; } });
    const result = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl, isCurrent: async () => current });
    assert.equal(result.status, 'synced');
    assert.equal(server.files()[b.entry.jsonPath], b.files[0].content);
    const patchIndex = server.calls.findIndex(call => call.method === 'PATCH');
    assert.ok(patchIndex > 0);
    assert.ok(server.calls.slice(patchIndex + 1).length > 0);
    assert.ok(server.calls.slice(patchIndex + 1).every(call => call.method === 'GET'));
    assert.equal(server.calls.filter(call => call.method === 'PATCH').length, 1);
  }
});

test('missing current authorization and config-read errors fail closed without requests or private error text', async () => {
  for (const isCurrent of [async () => false, async () => undefined, async () => { throw new Error('private-token-secret'); }]) {
    const server = gitServer();
    await assert.rejects(syncArchives({ config: CONFIG, bundles: [bundle()], fetchImpl: server.fetchImpl, isCurrent }), error => {
      assert.equal(error.code, 'GITHUB_TARGET_CHANGED');
      assert.doesNotMatch(error.message, /private|token|secret/);
      return true;
    });
    assert.equal(server.calls.length, 0);
  }
});

test('a conversation with 600 local attachments commits only four text files and never exceeds the pointer limit', async () => {
  const b = bundle(), server = gitServer();
  b.entry.assets = Array.from({ length: 600 }, (_, i) => {
    const oid = digest(`attachment-${i}`);
    return { id: oid, oid, size: 1, status: 'downloaded', kind: 'attachment', sourceType: 'platform', localPath: `${PREFIX}/assets/${oid}.txt` };
  });
  const built = await buildArchive({ conversation: JSON.parse(b.files[0].content), identity: { accountKey: ACCOUNT, displayName: 'Demo' },
    capturedAt: '2026-10-21T00:00:00Z', existingManifest: b.manifest, productionPrefix: PREFIX, assets: b.entry.assets });
  b.files = built.files;
  const before = structuredClone(b);
  const result = await syncArchives({ config: { ...CONFIG, lfsEnabled: true }, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced'); assert.equal(result.filesChanged, 4);
  assert.deepEqual(b, before);
  assert.ok(!Object.keys(server.files()).some(path => path.includes('/assets/') || path.endsWith('/.gitattributes')));
  assert.ok(JSON.parse(server.files()[MANIFEST]).conversations['conversation-one'].assets.every(a => a.cloudStatus === 'local-only'));
  assert.equal((await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl })).status, 'unchanged');
});
