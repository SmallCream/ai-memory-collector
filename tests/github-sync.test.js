import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syncArchives } from '../extension/lib/github-sync.js';
import { PROBE_CONTENT, PROBE_PATH } from '../extension/lib/github.js';
import { buildArchive } from '../extension/lib/archive.js';
import { formatLfsPointer } from '../extension/lib/lfs.js';
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

test('LFS pointer, scoped attributes, native JSON, Markdown and metadata commit atomically', async () => {
  const b = await pictureBundle(), server = gitServer({ initial: { [ATTRIBUTES]: '*.md text eol=lf\n', 'notes.txt': 'keep' } });
  const result = await syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  assert.equal(result.filesChanged, 6);
  assert.equal(server.calls.filter(call => call.method === 'PATCH').length, 1);
  const commitFiles = server.calls.find(call => call.path === '/git/trees' && call.method === 'POST').body.tree;
  assert.equal(commitFiles.length, 6);
  assert.equal(server.files()[IMAGE.localPath], formatLfsPointer(IMAGE));
  assert.equal(server.files()[ATTRIBUTES], '*.md text eol=lf\n' + RULE);
  assert.equal(server.files()[b.entry.jsonPath], b.files[0].content);
  assert.match(server.files()[b.entry.markdownPath], new RegExp(`\\.\\./\\.\\./\\.\\./assets/${IMAGE.oid}\\.png`));
  assert.equal(server.files()['notes.txt'], 'keep');
  assert.equal(JSON.parse(server.files()[MANIFEST]).conversations.picture.assets[0].oid, IMAGE.oid);
  const replay = await syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl });
  assert.equal(replay.status, 'unchanged');
});

test('ready image metadata cannot be committed before a corresponding uploaded pointer exists', async () => {
  const b = await pictureBundle(), server = gitServer();
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl }), { code: 'LFS_ASSET_MISSING' });
  assert.ok(server.calls.every(call => call.method === 'GET'));
  assert.deepEqual(server.files(), {});
});

test('an identical existing pointer permits new references without another descriptor', async () => {
  const b = await pictureBundle(), server = gitServer({ initial: { [IMAGE.localPath]: formatLfsPointer(IMAGE), [ATTRIBUTES]: RULE } });
  const result = await syncArchives({ config: CONFIG, bundles: [b], fetchImpl: server.fetchImpl });
  assert.equal(result.status, 'synced');
  const files = server.calls.find(call => call.path === '/git/trees' && call.method === 'POST').body.tree;
  assert.ok(!files.some(file => file.path === IMAGE.localPath));
});

test('unreferenced, cross-account and mismatched pointers are rejected before network requests', async () => {
  const b = await pictureBundle();
  for (const descriptor of [
    { ...pointer(IMAGE), accountKey: 'acct-' + '2'.repeat(24) },
    { ...pointer(IMAGE), path: IMAGE.localPath.replace('demo-', 'other-') },
    { ...pointer(IMAGE), oid: 'f'.repeat(64) },
    { ...pointer(IMAGE), content: 'not a pointer' },
    { ...pointer(IMAGE), size: 999 },
  ]) {
    const server = gitServer();
    await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], assetPointers: [descriptor], fetchImpl: server.fetchImpl }), { code: 'ACCOUNT_OWNERSHIP' });
    assert.equal(server.calls.length, 0);
  }
  const pending = await pictureBundle({ assets: [{ id: IMAGE.id, sourceRef: IMAGE.sourceRef, status: 'pending' }] });
  const server = gitServer();
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [pending], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl }), { code: 'ACCOUNT_OWNERSHIP' });
  assert.equal(server.calls.length, 0);
});

test('hash-addressed image paths cannot overwrite a different remote pointer or text', async () => {
  const b = await pictureBundle();
  for (const existing of ['manual image data', formatLfsPointer({ oid: 'f'.repeat(64), size: IMAGE.size })]) {
    const server = gitServer({ initial: { [IMAGE.localPath]: existing } });
    await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl }), { code: 'ASSET_IMMUTABLE_CONFLICT' });
    assert.equal(server.files()[IMAGE.localPath], existing);
    assert.ok(server.calls.every(call => call.method === 'GET'));
  }
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
  assert.equal(result.status, 'unchanged');
  assert.equal(server.files()[ready.entry.markdownPath], ready.files[1].content);
  assert.equal(result.remoteWinners[0].entry.assets[0].status, 'downloaded');
  assert.equal(result.remoteWinners[0].entry.assets[0].oid, IMAGE.oid);
  assert.ok(server.calls.every(call => call.method === 'GET'));
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

test('nested attributes rules that can override account LFS tracking are preserved and block writes', async () => {
  const b = await pictureBundle();
  const nested = `${PREFIX}/assets/.gitattributes`;
  const server = gitServer({ initial: { [nested]: '*.png -filter\n' } });
  await assert.rejects(syncArchives({ config: CONFIG, bundles: [b], assetPointers: [pointer(IMAGE)], fetchImpl: server.fetchImpl }), { code: 'LFS_ATTRIBUTES_CONFLICT' });
  assert.equal(server.files()[nested], '*.png -filter\n');
  assert.ok(server.calls.every(call => call.method === 'GET'));
});
