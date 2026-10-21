import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLfsClient, parseLfsPointer, formatLfsPointer, hashBytes, GITHUB_LFS_HOSTS } from '../extension/lib/lfs.js';

const TOKEN = 'synthetic-test-secret-token';
const CONFIG = { repository: 'demo/private-data', token: TOKEN };
const BYTES = new Uint8Array([137, 80, 78, 71, 0, 255, 128, 10]);
const OBJECT = { oid: createHash('sha256').update(BYTES).digest('hex'), size: BYTES.length };
const DOWNLOAD = 'https://github-cloud.githubusercontent.com/alambic/media/object?signature=temporary';
const UPLOAD = 'https://github-cloud.s3.amazonaws.com/alambic/media/object?signature=temporary';
const VERIFY = 'https://api.github.com/lfs/demo/private-data/objects/object/verify';
const batch = actions => ({ transfer: 'basic', objects: [{ ...OBJECT, ...(actions == null ? {} : { actions }) }] });
const action = (href, extra = {}) => ({ href, ...extra });

function scripted(steps) {
  const calls = [];
  const fetchImpl = async function (url, options) {
    assert.equal(this, globalThis, 'fetch must retain the browser global receiver');
    const step = steps[calls.length];
    calls.push({ url, options });
    assert.ok(step, 'Unexpected LFS request');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (step.method) assert.equal(options.method, step.method);
    if (step.url) assert.equal(url, step.url);
    if (step.inspect) await step.inspect({ url, options });
    if (step.error) throw new Error(step.error);
    if (step.response) return step.response;
    return new Response(step.bytes ?? JSON.stringify(step.data ?? {}), { status: step.status ?? 200, headers: step.headers });
  };
  return { calls, fetchImpl, done: () => assert.equal(calls.length, steps.length) };
}

test('LFS pointers round-trip and hash binary view bytes rather than the backing buffer', async () => {
  assert.deepEqual(parseLfsPointer(formatLfsPointer(OBJECT)), OBJECT);
  assert.deepEqual(parseLfsPointer(formatLfsPointer(OBJECT).replaceAll('\n', '\r\n')), OBJECT);
  assert.equal(parseLfsPointer('# ordinary Markdown\n'), null);
  assert.equal(parseLfsPointer('not an LFS pointer'), null);
  const backing = new Uint8Array(BYTES.length + 2); backing.set(BYTES, 1);
  assert.equal(await hashBytes(backing.subarray(1, -1)), OBJECT.oid);
  assert.equal(await hashBytes(new DataView(backing.buffer, 1, BYTES.length)), OBJECT.oid);
});

test('malformed, duplicate-field, oversized and unsupported LFS pointers cannot become image data', () => {
  for (const text of [
    formatLfsPointer(OBJECT).replace('sha256:', 'sha1:'),
    formatLfsPointer(OBJECT).replace(`size ${OBJECT.size}`, 'size 9007199254740992'),
    formatLfsPointer(OBJECT).replace(`size ${OBJECT.size}`, 'size -1'),
    formatLfsPointer(OBJECT) + 'size 4\n',
    formatLfsPointer(OBJECT).replace('/spec/v1', '/spec/v2'),
  ]) assert.throws(() => parseLfsPointer(text));
});

test('upload uses Basic only for fixed Batch endpoint, exact action auth for PUT and verify', async () => {
  const mock = scripted([
    { method: 'POST', url: 'https://github.com/demo/private-data.git/info/lfs/objects/batch',
      inspect: ({ options }) => {
        assert.equal(atob(options.headers.Authorization.slice(6)), `x-access-token:${TOKEN}`);
        assert.deepEqual(JSON.parse(options.body), { operation: 'upload', transfers: ['basic'], hash_algo: 'sha256',
          objects: [OBJECT], ref: { name: 'refs/heads/archive/main' } });
      }, data: batch({ upload: action(UPLOAD, { header: { Authorization: 'AWS4-HMAC-SHA256 temporary-object-only', 'x-amz-date': '20261021T000000Z' } }),
        verify: action(VERIFY, { header: { Authorization: 'RemoteAuth temporary-verify-only' } }) }) },
    { method: 'PUT', url: UPLOAD, inspect: ({ options }) => {
      assert.deepEqual(options.body, BYTES);
      assert.equal(options.headers.Authorization, 'AWS4-HMAC-SHA256 temporary-object-only');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.ok(!JSON.stringify(options.headers).includes(TOKEN));
    } },
    { method: 'POST', url: VERIFY, inspect: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), OBJECT);
      assert.equal(options.headers.Authorization, 'RemoteAuth temporary-verify-only');
      assert.ok(!JSON.stringify(options.headers).includes(TOKEN));
    } },
  ]);
  const result = await createLfsClient({ ...CONFIG, branch: 'archive/main', fetchImpl: mock.fetchImpl }).upload({ bytes: BYTES, ...OBJECT, mimeType: 'image/png' });
  assert.deepEqual(result, { ...OBJECT, status: 'uploaded', verified: true });
  assert.ok(!JSON.stringify(result).includes('temporary'));
  mock.done();
});

test('existing objects skip PUT; no verify action does not invent verification', async () => {
  const existing = scripted([{ data: batch(null) }]);
  assert.deepEqual(await createLfsClient({ ...CONFIG, fetchImpl: existing.fetchImpl }).upload({ bytes: BYTES }),
    { ...OBJECT, status: 'already-present', verified: true });
  existing.done();
  const fresh = scripted([{ data: batch({ upload: action(UPLOAD) }) }, {}]);
  assert.deepEqual(await createLfsClient({ ...CONFIG, fetchImpl: fresh.fetchImpl }).upload({ bytes: BYTES }),
    { ...OBJECT, status: 'uploaded', verified: false });
  assert.equal(fresh.calls[1].options.headers.Authorization, undefined);
  fresh.done();
});

test('upload validates bytes before any request and snapshots them against caller mutation', async () => {
  const never = async () => assert.fail('Invalid object reached the network');
  const client = createLfsClient({ ...CONFIG, fetchImpl: never });
  await assert.rejects(client.upload({ bytes: BYTES, oid: 'a'.repeat(64) }), { code: 'LFS_HASH_MISMATCH' });
  await assert.rejects(client.upload({ bytes: BYTES, size: 99 }), { code: 'LFS_HASH_MISMATCH' });
  await assert.rejects(client.upload({ bytes: 'https://example.invalid/image' }), { code: 'LFS_INVALID_BYTES' });
  const callerBytes = new Uint8Array(BYTES);
  const mock = scripted([{ data: batch({ upload: action(UPLOAD) }), inspect: () => callerBytes.fill(0) },
    { inspect: ({ options }) => assert.deepEqual(options.body, BYTES) }]);
  await createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).upload({ bytes: callerBytes });
  mock.done();
});

test('download verifies actual binary SHA-256 and never adds GitHub token to storage request', async () => {
  const mock = scripted([{ data: batch({ download: action(DOWNLOAD) }) }, { bytes: BYTES, method: 'GET', url: DOWNLOAD,
    inspect: ({ options }) => assert.deepEqual(options.headers, {}) }]);
  const result = await createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT);
  assert.deepEqual(result, BYTES);
  assert.ok(result instanceof Uint8Array);
  mock.done();
});

test('download rejects same-size corruption, truncation and oversized streams', async () => {
  for (const [bytes, code] of [
    [new Uint8Array(BYTES.length), 'LFS_HASH_MISMATCH'],
    [BYTES.subarray(1), 'LFS_HASH_MISMATCH'],
    [new Uint8Array(BYTES.length + 1), 'LFS_SIZE_LIMIT'],
  ]) {
    const mock = scripted([{ data: batch({ download: action(DOWNLOAD) }) }, { bytes }]);
    await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), { code });
    mock.done();
  }
});

test('download refuses excessive Content-Length before reading and cancels its body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': '1000000000' } });
  const mock = scripted([{ data: batch({ download: action(DOWNLOAD) }) }, { response }]);
  await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), { code: 'LFS_SIZE_LIMIT' });
  assert.equal(cancelled, true);
});

test('private download preflight is read-only and never claims write or full transfer verification', async () => {
  const mock = scripted([{ data: { objects: [] } }, { data: batch({ download: action(DOWNLOAD) }) }]);
  const client = createLfsClient({ ...CONFIG, branch: '', fetchImpl: mock.fetchImpl });
  assert.deepEqual(await client.checkDownload(), { status: 'batch-reachable', downloadVerified: false, writeVerified: false });
  assert.deepEqual(await client.checkDownload(OBJECT), { ...OBJECT, status: 'available', downloadVerified: false, writeVerified: false });
  assert.ok(mock.calls.every(call => JSON.parse(call.options.body).operation === 'download'));
  mock.done();
});

test('HTTP 200 per-object errors never count as success or create image transfer', async () => {
  for (const [status, code] of [[404, 'LFS_NOT_FOUND'], [403, 'LFS_AUTH_REQUIRED'], [507, 'LFS_QUOTA']]) {
    const mock = scripted([{ data: { objects: [{ ...OBJECT, error: { code: status, message: TOKEN } }] } }]);
    await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), error => {
      assert.equal(error.code, code); assert.ok(!error.message.includes(TOKEN)); return true;
    });
    mock.done();
  }
});

test('mismatched object, missing actions and unsupported transfers fail closed', async () => {
  for (const data of [
    { objects: [{ ...OBJECT, oid: 'a'.repeat(64), actions: { download: action(DOWNLOAD) } }] },
    { objects: [{ ...OBJECT, size: 99, actions: { download: action(DOWNLOAD) } }] },
    { objects: [] }, batch(null), { ...batch({ download: action(DOWNLOAD) }), transfer: 'ssh' },
  ]) {
    const mock = scripted([{ data }]);
    await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), { code: 'LFS_INVALID_RESPONSE' });
    mock.done();
  }
});

test('untrusted or deceptive action URLs are rejected before credentials or bytes leave the client', async () => {
  for (const href of [
    'https://attacker.example/image', 'https://github-cloud.s3.amazonaws.com.attacker.example/image',
    'https://some-other-bucket.s3.amazonaws.com/image', 'http://github-cloud.s3.amazonaws.com/image',
    'https://user:password@github-cloud.s3.amazonaws.com/image', 'https://github-cloud.s3.amazonaws.com:444/image',
    `https://github-cloud.s3.amazonaws.com/image?token=${TOKEN}`,
  ]) {
    const mock = scripted([{ data: batch({ upload: action(href) }) }]);
    await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).upload({ bytes: BYTES }), error => {
      assert.ok(['LFS_HOST_NOT_ALLOWED', 'LFS_INVALID_ACTION'].includes(error.code));
      assert.ok(!error.message.includes(href)); assert.ok(!JSON.stringify(error).includes(TOKEN)); return true;
    });
    mock.done();
  }
});

test('an unsafe verify action prevents even an otherwise valid object PUT', async () => {
  const mock = scripted([{ data: batch({ upload: action(UPLOAD), verify: action('https://attacker.example/verify') }) }]);
  await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).upload({ bytes: BYTES }), { code: 'LFS_HOST_NOT_ALLOWED' });
  mock.done();
});

test('server headers cannot forward PAT, cookies, forbidden browser headers or CRLF', async () => {
  for (const header of [
    { Authorization: `Bearer ${TOKEN}` }, { Authorization: `Basic ${btoa(`x-access-token:${TOKEN}`)}` },
    { Cookie: 'private-session' }, { Host: 'attacker.example' }, { 'Content-Length': '99' },
    { 'x-amz-date': 'today\r\nCookie: bad' }, { Authorization: 'one', authorization: 'two' },
  ]) {
    const mock = scripted([{ data: batch({ download: action(DOWNLOAD, { header }) }) }]);
    await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), error => {
      assert.ok(['LFS_INVALID_ACTION', 'LFS_UNSUPPORTED_HEADER'].includes(error.code));
      assert.ok(!JSON.stringify(error).includes(TOKEN)); return true;
    });
    mock.done();
  }
});

test('expired action and authorization failure refresh Batch once, without stale URL reuse', async () => {
  const mock = scripted([
    { data: batch({ download: action(DOWNLOAD, { expires_at: '2001-01-01T00:00:00Z' }) }) },
    { data: batch({ download: action(DOWNLOAD + '-fresh', { expires_in: 300 }) }) },
    { url: DOWNLOAD + '-fresh', bytes: BYTES },
  ]);
  assert.deepEqual(await createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), BYTES);
  mock.done();
  const denied = scripted([
    { data: batch({ download: action(DOWNLOAD) }) }, { status: 403 },
    { data: batch({ download: action(DOWNLOAD + '-fresh') }) }, { bytes: BYTES },
  ]);
  assert.deepEqual(await createLfsClient({ ...CONFIG, fetchImpl: denied.fetchImpl }).download(OBJECT), BYTES);
  denied.done();
});

test('persistent expired actions stop after one refresh and never transfer bytes', async () => {
  const expired = batch({ download: action(DOWNLOAD, { expires_in: 0 }) });
  const mock = scripted([{ data: expired }, { data: expired }]);
  await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), { code: 'LFS_ACTION_EXPIRED' });
  mock.done();
});

test('failed verify is not a successful upload; rate limits expose bounded retry hints only', async () => {
  const mock = scripted([{ data: batch({ upload: action(UPLOAD), verify: action(VERIFY) }) }, {},
    { status: 429, headers: { 'Retry-After': '60' }, data: { message: TOKEN } }]);
  await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).upload({ bytes: BYTES }), error => {
    assert.equal(error.code, 'LFS_RATE_LIMIT'); assert.equal(error.retryAfterMs, 60_000);
    assert.equal(error.retryable, true); assert.ok(!JSON.stringify(error).includes(TOKEN)); return true;
  });
  mock.done();
});

test('network errors are sanitized and callers retain retry responsibility', async () => {
  const mock = scripted([{ error: `sensitive ${TOKEN} ${DOWNLOAD}` }]);
  await assert.rejects(createLfsClient({ ...CONFIG, fetchImpl: mock.fetchImpl }).download(OBJECT), error => {
    assert.equal(error.code, 'LFS_NETWORK_OR_PERMISSION'); assert.equal(error.retryable, true);
    assert.ok(!error.message.includes(TOKEN)); assert.ok(!error.message.includes(DOWNLOAD)); return true;
  });
  mock.done();
});

test('unsafe configuration and oversized files fail without requests', async () => {
  for (const bad of [{ repository: '../private-data' }, { repository: 'demo/repo?x=y' }, { token: 'secret\r\nheader' },
    { allowedHosts: ['*.amazonaws.com'] }, { allowedHosts: ['attacker.example'] }, { branch: '../main' }]) {
    assert.throws(() => createLfsClient({ ...CONFIG, ...bad }));
  }
  assert.ok(GITHUB_LFS_HOSTS.every(host => !host.includes('*')));
  const client = createLfsClient({ ...CONFIG, maxBytes: BYTES.length - 1, fetchImpl: async () => assert.fail('No network allowed') });
  await assert.rejects(client.download(OBJECT), { code: 'LFS_SIZE_LIMIT' });
  await assert.rejects(client.upload({ bytes: BYTES }), { code: 'LFS_SIZE_LIMIT' });
});
