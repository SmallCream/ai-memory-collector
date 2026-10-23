import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchRepositorySnapshot, downloadRepositoryFile, validateRestorePath } from '../extension/lib/github-restore.js';

const CONFIG = { repository: 'demo/private-data', token: 'test-secret-token' };
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), SUBTREE = 'c'.repeat(40);
const META = { private: true, default_branch: 'main' };
const hash = (bytes, algorithm = 'sha1') => createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function file(path, content = 'hello', options = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { path, type: 'blob', mode: '100644', size: bytes.length, sha: hash(bytes), ...options };
}
const tree = (path, sha = SUBTREE) => ({ path, type: 'tree', mode: '040000', sha });
const prelude = [
  { path: '', data: META },
  { path: '/git/ref/heads/main', data: { object: { type: 'commit', sha: COMMIT } } },
  { path: `/git/commits/${COMMIT}`, data: { sha: COMMIT, tree: { sha: TREE } } },
];
function scripted(steps) {
  const calls = [];
  const fetchImpl = async function (url, options) {
    assert.equal(this, globalThis);
    const path = new URL(url).pathname.replace('/repos/demo/private-data', '') + new URL(url).search;
    const step = steps[calls.length];
    calls.push({ path, options, url });
    assert.ok(step, 'Unexpected request');
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${CONFIG.token}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (step.path !== undefined) assert.equal(path, step.path);
    if (step.throw) throw new Error(step.throw);
    return new Response(JSON.stringify(step.data ?? {}), { status: step.status || 200 });
  };
  return { fetchImpl, calls, done: () => assert.equal(calls.length, steps.length) };
}

test('snapshot pins one commit and returns all regular blobs without credentials or account changes', async () => {
  const entries = [tree('data'), file('data/账号.json', '{"displayName":"原账号"}'), file('.gitattributes')];
  const mock = scripted([...prelude, { path: `/git/trees/${TREE}?recursive=1`, data: { sha: TREE, truncated: false, tree: entries } }]);
  const snapshot = await fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl });
  assert.deepEqual(snapshot, { repository: CONFIG.repository, branch: 'main', commitSha: COMMIT, treeSha: TREE,
    entries: [entries[2], entries[1]], empty: false });
  assert.ok(!JSON.stringify(snapshot).includes(CONFIG.token));
  assert.equal(mock.calls.filter(call => call.path.includes('/git/ref/')).length, 1);
  mock.done();
});

test('truncated recursive tree is discarded and immutable subtrees are traversed with no pagination', async () => {
  const one = file('one.json'), two = file('two.md');
  const mock = scripted([...prelude,
    { path: `/git/trees/${TREE}?recursive=1`, data: { truncated: true, tree: [file('incomplete.txt')] } },
    { path: `/git/trees/${TREE}`, data: { truncated: false, tree: [tree('account-a'), tree('account-b')] } },
    { path: `/git/trees/${SUBTREE}`, data: { truncated: false, tree: [one, two] } },
  ]);
  const snapshot = await fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl });
  assert.deepEqual(snapshot.entries.map(entry => entry.path), ['account-a/one.json', 'account-a/two.md', 'account-b/one.json', 'account-b/two.md']);
  assert.ok(mock.calls.every(call => !call.path.includes('page=')));
  mock.done();
});

test('a truncated nonrecursive subtree is refused, not silently reported complete', async () => {
  const mock = scripted([...prelude,
    { data: { truncated: true, tree: [] } },
    { data: { truncated: true, tree: [file('one.json')] } },
  ]);
  await assert.rejects(fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }), { code: 'REMOTE_TREE_INCOMPLETE' });
  mock.done();
});

test('empty repository performs only reads and returns an empty snapshot', async () => {
  const mock = scripted([{ data: META }, { status: 409 }, { path: '/branches?per_page=1', data: [] }]);
  assert.deepEqual(await fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }), {
    repository: CONFIG.repository, branch: 'main', commitSha: null, treeSha: null, entries: [], empty: true,
  });
  mock.done();
});

test('missing branch does not restore a different existing branch', async () => {
  const mock = scripted([{ data: META }, { path: '/git/ref/heads/other', status: 404 }, { data: [{ name: 'main' }] }]);
  await assert.rejects(fetchRepositorySnapshot({ config: { ...CONFIG, branch: 'other' }, fetchImpl: mock.fetchImpl }), { code: 'BRANCH_NOT_FOUND' });
  mock.done();
});

test('archived private repositories can be restored without attempting writes', async () => {
  const mock = scripted([{ data: { ...META, archived: true } }, ...prelude.slice(1), { data: { truncated: false, tree: [] } }]);
  const snapshot = await fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl });
  assert.equal(snapshot.empty, false);
  mock.done();
});

test('public repositories and invalid server branch names are rejected before content retrieval', async () => {
  for (const data of [{ ...META, private: false }, { ...META, default_branch: '../secret' }]) {
    const mock = scripted([{ data }]);
    await assert.rejects(fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }));
    mock.done();
  }
});

test('malformed commit identifiers are refused without extra requests', async () => {
  for (const sha of ['a'.repeat(41), null, { secret: CONFIG.token }]) {
    const mock = scripted([...prelude.slice(0, 2), { data: { sha, tree: { sha: TREE } } }]);
    await assert.rejects(fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }), { code: 'INVALID_RESPONSE' });
    mock.done();
  }
});

test('unsafe paths, symlinks, submodules, and case-colliding files cannot enter a restore snapshot', async () => {
  const invalidTrees = [
    [file('../escape')], [file('/absolute')], [file('C:/escape')], [file('a\\escape')],
    [file('.git/config')], [file('NUL.png')], [file('name. ')],
    [file('link', '', { mode: '120000' })], [{ path: 'module', sha: COMMIT, mode: '160000', type: 'commit' }],
    [file('Photo.png'), file('photo.png')], [file('parent'), file('parent/child')],
    [file('a'), file('a')], [tree('Account'), file('account/one')], [file('Account/one'), file('account/two')],
  ];
  for (const entries of invalidTrees) {
    const mock = scripted([...prelude, { data: { truncated: false, tree: entries } }]);
    await assert.rejects(fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }));
    mock.done();
  }
  assert.equal(validateRestorePath('data/中文账号/.gitattributes'), 'data/中文账号/.gitattributes');
});

test('fallback detects cyclic trees without an unbounded request loop', async () => {
  const mock = scripted([...prelude, { data: { truncated: true, tree: [] } },
    { data: { truncated: false, tree: [tree('loop', TREE)] } }]);
  await assert.rejects(fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }), { code: 'REMOTE_TREE_CYCLE' });
  mock.done();
});

test('ordinary blob download preserves binary bytes and validates the immutable Git object hash', async () => {
  const bytes = Buffer.from([0, 1, 255, 128, 13, 10]);
  const entry = file('assets/photo.png', bytes);
  const mock = scripted([{ path: `/git/blobs/${entry.sha}`, data: { size: bytes.length, sha: entry.sha,
    encoding: 'base64', content: bytes.toString('base64') + '\n' } }]);
  assert.deepEqual(await downloadRepositoryFile({ config: CONFIG, entry, fetchImpl: mock.fetchImpl }), new Uint8Array(bytes));
  mock.done();
});

test('UTF-8 and empty blobs are verified using byte size, including SHA-256 Git objects', async () => {
  for (const content of ['你好', '']) {
    const bytes = Buffer.from(content), entry = file('test.json', bytes, { sha: hash(bytes, 'sha256') });
    const mock = scripted([{ data: { size: bytes.length, encoding: 'utf-8', content } }]);
    const actual = await downloadRepositoryFile({ config: CONFIG, entry, fetchImpl: mock.fetchImpl });
    assert.deepEqual(actual, new Uint8Array(bytes));
    mock.done();
  }
});

test('LFS pointers remain pointer bytes for the separate hydration step', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n';
  const entry = file('photo.png', pointer);
  const mock = scripted([{ data: { size: entry.size, encoding: 'base64', content: btoa(pointer) } }]);
  assert.equal(new TextDecoder().decode(await downloadRepositoryFile({ config: CONFIG, entry, fetchImpl: mock.fetchImpl })), pointer);
  mock.done();
});

test('bad encoding, false metadata, content corruption, and oversized files never yield successful bytes', async () => {
  const entry = file('one.md', 'hello');
  const valid = { size: 5, encoding: 'base64', content: btoa('hello') };
  for (const data of [{ ...valid, content: btoa('jello') }, { ...valid, content: '!!!!' },
    { ...valid, size: 6 }, { ...valid, content: btoa('hello!') }, { ...valid, sha: 'c'.repeat(40) },
    { ...valid, encoding: 'none' }]) {
    const mock = scripted([{ data }]);
    await assert.rejects(downloadRepositoryFile({ config: CONFIG, entry, fetchImpl: mock.fetchImpl }));
    mock.done();
  }
  const mock = scripted([]);
  await assert.rejects(downloadRepositoryFile({ config: CONFIG, entry, maxBytes: 4, fetchImpl: mock.fetchImpl }), { code: 'REMOTE_FILE_SIZE' });
  await assert.rejects(downloadRepositoryFile({ config: CONFIG, entry: { ...entry, sha: '../secret' }, fetchImpl: mock.fetchImpl }));
  mock.done();
});

test('network and API failures remain structured and do not leak tokens or response content', async () => {
  for (const failure of [{ throw: CONFIG.token }, { status: 401, data: { message: CONFIG.token } }]) {
    const mock = scripted([failure]);
    await assert.rejects(fetchRepositorySnapshot({ config: CONFIG, fetchImpl: mock.fetchImpl }), error => {
      assert.ok(error.code);
      assert.ok(!error.message.includes(CONFIG.token));
      assert.ok(!JSON.stringify(error).includes(CONFIG.token));
      return true;
    });
    mock.done();
  }
});
