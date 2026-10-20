import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { probeChatGPT } from '../extension/lib/chatgpt.js';

const session = (id = 'synthetic-user') => ({ user: { id, name: 'Demo User' }, accessToken: 'synthetic-bearer-secret' });
const expectedKey = 'acct-' + Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('chatgpt:synthetic-user'))).toString('hex').slice(0, 24);
function setup(responses, origin = 'https://chatgpt.com') {
  const calls = [];
  const fetch = async (path, options) => {
    calls.push({ path, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    assert.notEqual(next, undefined, 'unexpected request');
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const context = vm.createContext({ fetch, location: { origin }, crypto: webcrypto, TextEncoder, TextDecoder,
    AbortController, setTimeout, clearTimeout, URL });
  // Execute the serialized function, as Chrome does. Any accidental outer dependency fails.
  const run = vm.runInContext(`(${probeChatGPT.toString()})`, context);
  return { run, calls };
}
test('serialized identity probe exposes only hashed identity, never bearer or raw ID', async () => {
  const { run, calls } = setup([session()]);
  const result = await run({ kind: 'identity' });
  assert.equal(result.ok, true);
  assert.equal(result.identity.accountKey, expectedKey);
  assert.equal(result.identity.workspace, 'unverified');
  assert.ok(!JSON.stringify(result).includes('synthetic-bearer-secret'));
  assert.ok(!JSON.stringify(result).includes('synthetic-user'));
  assert.equal(calls[0].options.credentials, 'include');
});
test('rejects an untrusted origin and arbitrary requests before fetching', async () => {
  const { run, calls } = setup([], 'https://example.test');
  assert.equal((await run({ kind: 'identity' })).error.code, 'ORIGIN');
  assert.equal(calls.length, 0);
  const second = setup([]);
  assert.equal((await second.run({ kind: 'fetch', url: 'https://example.test' })).ok, false);
  assert.equal(second.calls.length, 0);
});
test('list permits bounded paging, uses bearer in request and checks identity afterwards', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `demo-${i}`, title: 'Demo' }));
  const { run, calls } = setup([session(), { items, total: 21 }, session()]);
  const r = await run({ kind: 'list', offset: 0, expectedAccountKey: expectedKey });
  assert.equal(r.ok, true); assert.equal(r.payload.nextOffset, 20);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-bearer-secret');
  assert.equal(calls[1].options.redirect, 'error');
  assert.ok(!JSON.stringify(r).includes('synthetic-bearer-secret'));
});
test('changed identity before fetch blocks source request', async () => {
  const { run, calls } = setup([session('another-demo-user')]);
  const r = await run({ kind: 'list', offset: 0, expectedAccountKey: expectedKey });
  assert.equal(r.error.code, 'ACCOUNT_CHANGED'); assert.equal(calls.length, 1);
});
test('changed identity after detail causes result to be dropped', async () => {
  const { run } = setup([session(), { conversation_id: 'demo', messages: [{ id: 'x', content: 'private text' }] }, session('other')]);
  const r = await run({ kind: 'detail', format: 'flat', conversationId: 'demo', expectedAccountKey: expectedKey });
  assert.equal(r.error.code, 'ACCOUNT_CHANGED'); assert.equal(r.payload, undefined);
  assert.ok(!JSON.stringify(r).includes('private text'));
});
test('modern partial response retains page flags, never claims complete', async () => {
  const raw = { conversation_id: 'demo', messages: [], page_info: { has_previous_page: true } };
  const { run, calls } = setup([session(), raw, session()]);
  const r = await run({ kind: 'detail', format: 'flat', conversationId: 'demo', expectedAccountKey: expectedKey });
  assert.equal(r.ok, true); assert.equal(r.payload.page_info.has_previous_page, true);
  assert.equal(calls[1].path, '/backend-api/conversations/demo?num_turns=100');
  assert.match(r.coverage, /未验证/);
});
test('legacy tree endpoint is explicit and ID mismatch is rejected', async () => {
  const { run, calls } = setup([session(), { conversation_id: 'wrong', mapping: {} }]);
  const r = await run({ kind: 'detail', format: 'tree', conversationId: 'demo', expectedAccountKey: expectedKey });
  assert.equal(calls[1].path, '/backend-api/conversation/demo');
  assert.equal(r.error.code, 'CONVERSATION_ID');
});
test('unrecognized list format fails instead of treating response as empty', async () => {
  const { run } = setup([session(), { unexpected: [] }]);
  const r = await run({ kind: 'list', offset: 0, expectedAccountKey: expectedKey });
  assert.equal(r.error.code, 'FORMAT'); assert.equal(r.payload, undefined);
});
test('HTML login/challenge and HTTP status do not expose response body', async () => {
  const { run } = setup([new Response('secret body', { headers: { 'content-type': 'text/html' } })]);
  assert.equal((await run({ kind: 'identity' })).error.code, 'FORMAT');
  for (const status of [401, 403, 404, 429]) {
    const second = setup([new Response('sensitive body', { status })]);
    const r = await second.run({ kind: 'identity' });
    assert.equal(r.error.code, `HTTP_${status}`);
    assert.ok(!JSON.stringify(r).includes('sensitive body'));
  }
});
test('malformed IDs and offsets never reach the network', async () => {
  for (const request of [
    { kind: 'detail', format: 'flat', conversationId: '../../token' },
    { kind: 'list', offset: -1 }, { kind: 'list', offset: 0.1 }
  ]) {
    const { run, calls } = setup([]);
    const r = await run({ ...request, expectedAccountKey: expectedKey });
    assert.equal(r.ok, false); assert.equal(calls.length, 0);
  }
});
test('network exception messages are not forwarded', async () => {
  const { run } = setup([new Error('Authorization: secret-value')]);
  const result = await run({ kind: 'identity' });
  assert.equal(result.error.code, 'NETWORK');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});
