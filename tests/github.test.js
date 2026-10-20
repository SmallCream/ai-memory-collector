import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRepository, commitProbe, PROBE_CONTENT, PROBE_PATH } from '../extension/lib/github.js';

const SHA = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const INPUT = { owner: 'demo-owner', repo: 'private-data', token: 'test-secret-token' };
const META = { private: true, default_branch: 'main' };
const REF = { object: { type: 'commit', sha: SHA } };
const FILE = { type: 'file', encoding: 'base64', size: PROBE_CONTENT.length, content: btoa(PROBE_CONTENT), sha: SHA };

function scripted(steps) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const step = steps[calls.length];
    calls.push({ url, options });
    assert.ok(step, `Unexpected request ${options.method} ${url}`);
    if (step.method) assert.equal(options.method, step.method);
    if (step.path) assert.equal(new URL(url).pathname + new URL(url).search, step.path);
    if (step.inspect) step.inspect({ url, options });
    if (step.throw) throw new Error(step.throw);
    if (step.raw !== undefined) return new Response(step.raw, { status: step.status ?? 200 });
    return new Response(JSON.stringify(step.data ?? {}), { status: step.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls, done: () => assert.equal(calls.length, steps.length) };
}

test('read-only probe uses private fixed API origin and excludes credentials from result', async () => {
  const mock = scripted([{ data: META }, { data: REF }]);
  const result = await probeRepository({ ...INPUT, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { owner: INPUT.owner, repo: INPUT.repo, private: true, defaultBranch: 'main', branch: 'main', headSha: SHA, empty: false });
  for (const { url, options } of mock.calls) {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, `Bearer ${INPUT.token}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(result).includes(INPUT.token));
  mock.done();
});

test('public repository rejected before any content or write request', async () => {
  const mock = scripted([{ data: { ...META, private: false } }]);
  await assert.rejects(commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl }), { code: 'PRIVATE_REPOSITORY_REQUIRED' });
  mock.done();
});

test('missing branch in nonempty repository is not treated as empty', async () => {
  const mock = scripted([{ data: META }, { status: 404 }, { data: [{ name: 'main' }] }]);
  await assert.rejects(commitProbe({ ...INPUT, branch: 'missing', fetchImpl: mock.fetchImpl }), { code: 'BRANCH_NOT_FOUND' });
  mock.done();
});

test('initializes empty private repository and verifies synthetic-only payload', async () => {
  const mock = scripted([
    { data: META }, { status: 409 }, { data: [] },
    { method: 'PUT', path: `/repos/${INPUT.owner}/${INPUT.repo}/contents/${PROBE_PATH}`, data: { commit: { sha: COMMIT } }, status: 201,
      inspect: ({ options }) => {
        const body = JSON.parse(options.body);
        assert.equal(atob(body.content), PROBE_CONTENT);
        assert.equal(body.branch, undefined);
        assert.equal(body.sha, undefined);
        assert.ok(!options.body.includes(INPUT.token));
      } },
    { method: 'GET', data: FILE },
  ]);
  const result = await commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { status: 'created', path: PROBE_PATH, branch: 'main', commitSha: COMMIT, readbackVerified: true, writeVerified: true });
  mock.done();
});

test('explicit branch supports safe slashes and is used in create body and readback', async () => {
  const mock = scripted([
    { data: META }, { data: REF, path: `/repos/${INPUT.owner}/${INPUT.repo}/git/ref/heads/probe/one` }, { status: 404 },
    { status: 201, data: { commit: { sha: COMMIT } }, inspect: ({ options }) => assert.equal(JSON.parse(options.body).branch, 'probe/one') },
    { data: FILE, path: `/repos/${INPUT.owner}/${INPUT.repo}/contents/${PROBE_PATH}?ref=probe%2Fone` },
  ]);
  await commitProbe({ ...INPUT, branch: 'probe/one', fetchImpl: mock.fetchImpl });
  mock.done();
});

test('empty repository rejects explicit nondefault branch before writing', async () => {
  const mock = scripted([{ data: META }, { status: 404 }, { data: [] }]);
  await assert.rejects(commitProbe({ ...INPUT, branch: 'probe/one', fetchImpl: mock.fetchImpl }), { code: 'EMPTY_REPOSITORY_BRANCH' });
  assert.ok(mock.calls.every(x => x.options.method === 'GET'));
  mock.done();
});

test('empty repository explicit default branch is initialized without a branch body parameter', async () => {
  const mock = scripted([
    { data: { ...META, default_branch: 'archive' } }, { status: 409 }, { data: [] },
    { status: 201, data: { commit: { sha: COMMIT } }, inspect: ({ options }) => assert.equal(JSON.parse(options.body).branch, undefined) },
    { data: FILE, path: `/repos/${INPUT.owner}/${INPUT.repo}/contents/${PROBE_PATH}?ref=archive` },
  ]);
  const result = await commitProbe({ ...INPUT, branch: 'archive', fetchImpl: mock.fetchImpl });
  assert.equal(result.branch, 'archive');
  mock.done();
});

test('existing matching file is idempotent and does not claim write access was verified', async () => {
  const mock = scripted([{ data: META }, { data: REF }, { data: FILE }]);
  const result = await commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'already-present');
  assert.equal(result.writeVerified, false);
  assert.equal(result.readbackVerified, true);
  assert.ok(mock.calls.every(x => x.options.method === 'GET'));
  mock.done();
});

test('existing distinct file is never overwritten', async () => {
  const mock = scripted([{ data: META }, { data: REF }, { data: { ...FILE, content: btoa('custom user content') } }]);
  await assert.rejects(commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl }), { code: 'PROBE_PATH_CONFLICT' });
  assert.ok(mock.calls.every(x => x.options.method === 'GET'));
  mock.done();
});

test('creates absent probe in existing repository, then reads back', async () => {
  const mock = scripted([{ data: META }, { data: REF }, { status: 404 }, { status: 201, data: { commit: { sha: COMMIT } } }, { data: FILE }]);
  const result = await commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'created');
  assert.equal(mock.calls.filter(x => x.options.method === 'PUT').length, 1);
  mock.done();
});

for (const failure of [{ throw: 'network error with test-secret-token' }, { status: 409 }, { status: 500 }, { status: 201, raw: 'not valid JSON' }]) {
  test(`uncertain write (${failure.raw ? 'malformed success' : failure.status ?? 'network'}) reads back without duplicate PUT`, async () => {
    const mock = scripted([{ data: META }, { data: REF }, { status: 404 }, failure, { data: FILE }]);
    const result = await commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl });
    assert.equal(result.status, 'recovered');
    assert.equal(result.writeVerified, false);
    assert.equal(mock.calls.filter(x => x.options.method === 'PUT').length, 1);
    mock.done();
  });
}

test('uncertain write with different content fails without overwriting', async () => {
  const mock = scripted([{ data: META }, { data: REF }, { status: 404 }, { status: 409 }, { data: { ...FILE, content: btoa('different') } }]);
  await assert.rejects(commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl }), { code: 'PROBE_PATH_CONFLICT' });
  mock.done();
});

test('uncertain write remains pending when readback is absent', async () => {
  const mock = scripted([{ data: META }, { data: REF }, { status: 404 }, { throw: INPUT.token }, { status: 404 }]);
  await assert.rejects(commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl }), { code: 'WRITE_UNCONFIRMED' });
  mock.done();
});

test('successful PUT with failed readback is not reported successful', async () => {
  const mock = scripted([{ data: META }, { data: REF }, { status: 404 }, { status: 201, data: { commit: { sha: COMMIT } } }, { status: 404 }]);
  await assert.rejects(commitProbe({ ...INPUT, fetchImpl: mock.fetchImpl }), { code: 'WRITE_UNCONFIRMED' });
  mock.done();
});

test('HTTP and network errors do not leak raw response or exception secrets', async () => {
  for (const failure of [{ status: 401, data: { message: INPUT.token } }, { throw: `sensitive ${INPUT.token}` }]) {
    const mock = scripted([failure]);
    await assert.rejects(probeRepository({ ...INPUT, fetchImpl: mock.fetchImpl }), error => {
      assert.ok(!error.message.includes(INPUT.token));
      assert.ok(!JSON.stringify(error).includes(INPUT.token));
      return true;
    });
    mock.done();
  }
});

test('rejects URL injection and invalid ref syntax before sending credentials', async () => {
  for (const invalid of [{ owner: 'evil/x' }, { repo: '../elsewhere' }, { repo: 'x?query' }, { branch: '../main' }, { branch: 'x\\y' }, { branch: 'a.lock/b' }, { token: 'bad\r\nheader' }]) {
    let calls = 0;
    await assert.rejects(probeRepository({ ...INPUT, ...invalid, fetchImpl: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
});
