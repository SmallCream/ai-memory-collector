import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { probeChatGPT } from '../extension/lib/chatgpt.js';
import { inspectMessageGeneration } from '../extension/lib/message-generation.js';

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


function completeTree() {
  return { conversation_id: 'demo', title: 'Synthetic conversation', current_node: 'a',
    mapping: {
      root: { id: 'root', parent: null, children: ['u'], message: null },
      u: { id: 'u', parent: 'root', children: ['a'], message: { id: 'u', author: { role: 'user' }, content: { parts: ['Hello'] }, status: 'finished_successfully' } },
      a: { id: 'a', parent: 'u', children: [], message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['Hi'] }, status: 'finished_successfully' } },
    } };
}
const autoRequest = { kind: 'detail', format: 'auto', conversationId: 'demo', expectedAccountKey: expectedKey };
test('automatic detail prefers a coherent tree and checks identity before returning', async () => {
  const { run, calls } = setup([session(), completeTree(), session()]);
  const result = await run(autoRequest);
  assert.equal(result.ok, true);
  assert.equal(result.detailFormat, 'tree');
  assert.equal(result.completeness, 'complete');
  assert.equal(calls[1].path, '/backend-api/conversation/demo');
  assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(result).includes('synthetic-bearer-secret'));
  assert.match(result.coverage, /未验证/u);
});
test('automatic detail uses flat only on absent or unsupported tree endpoint', async () => {
  const flat = { conversation_id: 'demo', messages: [{ id: 'm', role: 'user', content: 'Synthetic' }],
    page_info: { has_previous_page: false, has_next_page: false } };
  for (const initial of [new Response('', { status: 404 }), { conversation_id: 'demo', renamed_mapping: {} }]) {
    const { run, calls } = setup([session(), initial, flat, session()]);
    const result = await run(autoRequest);
    assert.equal(result.ok, true);
    assert.equal(result.detailFormat, 'flat');
    assert.equal(result.completeness, 'complete');
    assert.equal(calls[2].path, '/backend-api/conversations/demo?num_turns=100');
  }
});
test('authentication, rate limits and wrong IDs never trigger a fallback detail request', async () => {
  for (const status of [401, 403, 429, 500]) {
    const { run, calls } = setup([session(), new Response('sensitive', { status })]);
    const result = await run(autoRequest);
    assert.equal(result.error.code, `HTTP_${status}`);
    assert.equal(calls.length, 2);
  }
  const { run, calls } = setup([session(), { ...completeTree(), conversation_id: 'other' }]);
  assert.equal((await run(autoRequest)).error.code, 'CONVERSATION_ID');
  assert.equal(calls.length, 2);
});
test('automatic detail rejects streaming, disconnected, cyclic and partial trees', async () => {
  const mutations = [
    value => { value.mapping.a.message.status = 'in_progress'; },
    value => { value.mapping.u.parent = 'missing'; },
    value => { value.mapping.u.parent = 'a'; },
    value => { value.current_node = 'missing'; },
    value => { value.mapping.root.children = ['missing']; },
    value => { value.mapping.side = { id: 'side', parent: 'side', message: null }; },
    value => { value.is_incomplete = true; },
    value => { value.page_info = { has_previous_page: true }; },
  ];
  for (const mutate of mutations) {
    const value = completeTree(); mutate(value);
    const { run, calls } = setup([session(), value]);
    const result = await run(autoRequest);
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.payload, undefined);
    assert.equal(calls.length, 2, 'do not fall back after an incomplete tree');
  }
});
test('automatic flat fallback refuses unknown pagination, missing stable IDs and duplicate messages', async () => {
  for (const flat of [
    { messages: [] },
    { messages: [], page_info: { has_previous_page: false } },
    { messages: [], page_info: { has_previous_page: true, has_next_page: false } },
    { messages: [{ content: 'missing id' }], page_info: { has_previous_page: false, has_next_page: false } },
    { messages: [{ id: 'same' }, { id: 'same' }], page_info: { has_previous_page: false, has_next_page: false } },
  ]) {
    const { run } = setup([session(), new Response('', { status: 404 }), { conversation_id: 'demo', ...flat }]);
    const result = await run(autoRequest);
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.payload, undefined);
  }
});
test('automatic mode discards even a complete response if account changes in flight', async () => {
  const { run } = setup([session(), completeTree(), session('changed-account')]);
  const result = await run(autoRequest);
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(result.payload, undefined);
});
test('list rejects duplicate, stalled, inconsistent and malformed pages', async () => {
  for (const raw of [
    { items: [], total: 10 },
    { items: [{ id: 'a' }, { id: 'a' }], total: 2 },
    { items: [{ id: 'a' }], total: '10' },
    { items: [{ id: 'a' }], total: 0 },
    { items: [{ id: 'a' }], total: 1, offset: 10 },
  ]) {
    const { run } = setup([session(), raw]);
    const result = await run({ kind: 'list', offset: 0, expectedAccountKey: expectedKey });
    assert.equal(result.ok, false);
    assert.equal(result.payload, undefined);
  }
});
test('empty complete list and exact full final page terminate pagination honestly', async () => {
  for (const items of [[], Array.from({ length: 20 }, (_, i) => ({ id: `item-${i}` }))]) {
    const { run } = setup([session(), { items, total: items.length }, session()]);
    const result = await run({ kind: 'list', offset: 0, expectedAccountKey: expectedKey });
    assert.equal(result.ok, true);
    assert.equal(result.payload.nextOffset, null);
  }
});

const pageRequest = { kind: 'detail', format: 'page', conversationId: 'demo', expectedAccountKey: expectedKey };
function messagePage(ids = ['message-a', 'message-b'], flags = {}) {
  return { conversation_id: 'demo', title: 'Synthetic page', update_time: 1792569600,
    messages: ids.map(id => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: [`Text ${id}`] },
      status: 'finished_successfully' })),
    page_info: { start_cursor: ids[0] ?? null, end_cursor: ids.at(-1) ?? null,
      has_previous_page: true, has_next_page: false, ...flags } };
}

test('serialized page probe reads latest and older cursor pages without claiming full history', async () => {
  for (const before of [undefined, 'message-after_123']) {
    const payload = messagePage(['message-a', 'message-b'], { has_next_page: before !== undefined });
    const { run, calls } = setup([session(), payload, session()]);
    const result = await run({ ...pageRequest, ...(before ? { before } : {}) });
    assert.equal(result.ok, true);
    assert.equal(result.detailFormat, 'flat');
    assert.equal(result.completeness, 'page');
    assert.equal(result.payload.page_info.has_previous_page, true);
    assert.equal(result.payload.messages.length, 2);
    assert.equal(calls[1].path, `/backend-api/conversations/demo?num_turns=100${before ? `&before=${before}` : ''}`);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.credentials, 'include');
    assert.equal(calls[1].options.redirect, 'error');
    assert.ok(!JSON.stringify(result).includes('synthetic-bearer-secret'));
  }
});

test('message cursor input is bounded and cannot become an arbitrary path or query', async () => {
  for (const before of [null, '', '../other', 'message&num_turns=999', 'message?x=1', 'message%2Fother',
    'https://example.test', 'a'.repeat(161), 1, {}, ['message']]) {
    const { run, calls } = setup([]);
    const result = await run({ ...pageRequest, before });
    assert.equal(result.error.code, 'REQUEST');
    assert.equal(calls.length, 0);
  }
  for (const format of ['auto', 'flat', 'tree']) {
    const { run, calls } = setup([]);
    assert.equal((await run({ ...pageRequest, format, before: 'message-a' })).error.code, 'REQUEST');
    assert.equal(calls.length, 0);
  }
});

test('page probe requires explicit direction flags and coherent boundary IDs', async t => {
  const changes = {
    'missing page information': value => { delete value.page_info; },
    'missing older flag': value => { delete value.page_info.has_previous_page; },
    'missing newer flag': value => { delete value.page_info.has_next_page; },
    'nonboolean older flag': value => { value.page_info.has_previous_page = 'true'; },
    'nonboolean newer flag': value => { value.page_info.has_next_page = 0; },
    'latest page has newer content': value => { value.page_info.has_next_page = true; },
    'missing first cursor': value => { delete value.page_info.start_cursor; },
    'missing last cursor': value => { delete value.page_info.end_cursor; },
    'first cursor does not match': value => { value.page_info.start_cursor = 'elsewhere'; },
    'last cursor does not match': value => { value.page_info.end_cursor = 'elsewhere'; },
    'duplicate message ID': value => { value.messages[1].id = value.messages[0].id; value.page_info.end_cursor = value.messages[0].id; },
    'missing stable ID': value => { delete value.messages[0].id; },
    'unsafe stable ID': value => { value.messages[0].id = '../outside'; value.page_info.start_cursor = '../outside'; },
    'null message': value => { value.messages[0] = { id: 'message-a', message: null }; },
    'malformed message': value => { value.messages[0] = 'not a message'; },
    'page has ambiguous more flag': value => { value.page_info.has_more = true; },
    'top level incomplete': value => { value.is_incomplete = true; },
    'top level extra content': value => { value.has_more_messages = true; },
  };
  for (const [name, mutate] of Object.entries(changes)) await t.test(name, async () => {
    const payload = messagePage(); mutate(payload);
    const { run, calls } = setup([session(), payload]);
    const result = await run(pageRequest);
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.payload, undefined);
    assert.equal(calls.length, 2, 'malformed pages never trigger another endpoint');
  });
});

test('page probe accepts wrapped stable messages and rejects all known generation states', async () => {
  const payload = messagePage();
  payload.messages = payload.messages.map(message => ({ message, id: `node-${message.id}` }));
  const accepted = setup([session(), payload, session()]);
  assert.equal((await accepted.run(pageRequest)).completeness, 'page');
  for (const status of ['pending', 'streaming', 'in_progress']) {
    const unfinished = messagePage(); unfinished.messages[1].status = status;
    const { run } = setup([session(), unfinished]);
    assert.equal((await run(pageRequest)).error.code, 'INCOMPLETE_DETAIL');
  }
});

test('page probe accepts only explicitly empty history and bounds page cardinality', async () => {
  const empty = messagePage([], { has_previous_page: false, has_next_page: false });
  const accepted = setup([session(), empty, session()]);
  const result = await accepted.run(pageRequest);
  assert.equal(result.ok, true); assert.equal(result.completeness, 'page');
  for (const flags of [{ has_previous_page: true }, { has_next_page: true }, { start_cursor: 'missing' }, { end_cursor: 'missing' }]) {
    const payload = messagePage([], { has_previous_page: false, has_next_page: false, ...flags });
    const { run } = setup([session(), payload]);
    assert.equal((await run(pageRequest)).error.code, 'INCOMPLETE_DETAIL');
  }
  const huge = messagePage(Array.from({ length: 2001 }, (_, i) => `message-${i}`));
  const { run } = setup([session(), huge]);
  assert.equal((await run(pageRequest)).error.code, 'INCOMPLETE_DETAIL');
});

test('page identity changes discard source content before and after the network read', async () => {
  const before = setup([session('changed')]);
  assert.equal((await before.run(pageRequest)).error.code, 'ACCOUNT_CHANGED');
  assert.equal(before.calls.length, 1);
  const after = setup([session(), messagePage(), session('changed')]);
  const result = await after.run(pageRequest);
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(result.payload, undefined);
  assert.ok(!JSON.stringify(result).includes('Text message-a'));
});

test('explicit complete tree mode validates the whole tree without flat fallback', async () => {
  const request = { ...autoRequest, format: 'tree', requireComplete: true };
  const accepted = setup([session(), completeTree(), session()]);
  assert.equal((await accepted.run(request)).completeness, 'complete');
  const partial = completeTree(); partial.mapping.a.message.status = 'in_progress';
  const rejected = setup([session(), partial]);
  assert.equal((await rejected.run(request)).error.code, 'INCOMPLETE_DETAIL');
  assert.equal(rejected.calls.length, 2);
  const absent = setup([session(), new Response('', { status: 404 })]);
  assert.equal((await absent.run(request)).error.code, 'HTTP_404');
  assert.equal(absent.calls.length, 2);
  const diagnostic = setup([session(), partial, session()]);
  assert.equal((await diagnostic.run({ ...request, requireComplete: false })).completeness, 'unknown');
});

test('tree rejection exposes a fixed structural reason without source details', async () => {
  const cases = [
    ['SOURCE_PARTIAL', value => { value.has_more = true; }],
    ['TREE_CURRENT_NODE', value => { value.current_node = 'private-missing-id'; }],
    ['TREE_NODE_SHAPE', value => { value.mapping.a.message = 'private malformed content'; }],
    ['MESSAGE_IN_PROGRESS', value => { value.mapping.a.message.status = 'pending'; }],
    ['TREE_MISSING_PARENT', value => { value.mapping.a.parent = 'private-missing-id'; }],
    ['TREE_MISSING_CHILD', value => { value.mapping.a.children = ['private-missing-id']; }],
    ['TREE_PARENT_CYCLE', value => { value.mapping.u.parent = 'a'; }],
  ];
  for (const [reason, mutate] of cases) {
    const payload = completeTree();
    payload.mapping.u.message.content.parts = ['private conversation text'];
    payload.reason = 'Authorization: private-reason-token';
    mutate(payload);
    const { run } = setup([session(), payload]);
    const result = await run({ ...autoRequest, format: 'tree', requireComplete: true });
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.error.reason, reason);
    assert.deepEqual(Object.keys(result.error).sort(), ['code', 'message', 'reason']);
    assert.equal(result.payload, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|synthetic-bearer-secret/);
  }
});

test('legacy flat rejection distinguishes pagination, message shape, generation and IDs', async () => {
  const cases = [
    ['SOURCE_PARTIAL', value => { value.page_info.has_previous_page = true; }],
    ['PAGE_FLAGS', value => { delete value.page_info; }],
    ['MESSAGE_SHAPE', value => { value.messages[0] = 'private malformed content'; }],
    ['MESSAGE_SHAPE', value => { value.messages[0] = { message: 'private malformed content' }; }],
    ['MESSAGE_IN_PROGRESS', value => { value.messages[0].status = 'streaming'; }],
    ['MESSAGE_ID', value => { delete value.messages[0].id; }],
  ];
  for (const [reason, mutate] of cases) {
    const payload = messagePage(['m1'], { has_previous_page: false, has_next_page: false });
    payload.messages[0].content.parts = ['private conversation text'];
    mutate(payload);
    const { run } = setup([session(), payload]);
    const result = await run({ ...autoRequest, format: 'flat', requireComplete: true });
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.error.reason, reason);
    assert.equal(result.payload, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|synthetic-bearer-secret/);
  }
});

test('page rejection distinguishes unsafe boundaries from unfinished messages without exposing source fields', async () => {
  const cases = [
    ['SOURCE_PARTIAL', value => { value.has_more_messages = true; }],
    ['PAGE_FLAGS', value => { value.page_info.has_previous_page = 'private malformed flag'; }],
    ['PAGE_DIRECTION', value => { value.page_info.has_next_page = true; }],
    ['PAGE_MESSAGE_LIMIT', value => { value.messages = Array.from({ length: 2001 }, () => value.messages[0]); }],
    ['MESSAGE_SHAPE', value => { value.messages[0] = { id: 'private-node-id', message: null }; }],
    ['MESSAGE_IN_PROGRESS', value => { value.messages[0].status = 'in_progress'; }],
    ['MESSAGE_ID', value => { value.messages[0].id = '../private-id'; }],
    ['PAGE_CURSOR_MISMATCH', value => { value.page_info.start_cursor = 'private-missing-id'; }],
    ['PAGE_DIRECTION', value => { value.messages = []; }],
    ['PAGE_CURSOR_MISMATCH', value => { value.messages = []; value.page_info.has_previous_page = false; }],
  ];
  for (const [reason, mutate] of cases) {
    const payload = messagePage();
    payload.messages[0].content.parts = ['private conversation text'];
    payload.reason = 'Authorization: private-reason-token';
    mutate(payload);
    const { run } = setup([session(), payload]);
    const result = await run(pageRequest);
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.error.reason, reason);
    assert.equal(result.payload, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|synthetic-bearer-secret/);
  }
});

test('network errors cannot inject diagnostic reasons, including names used by internal validation', async () => {
  for (const reason of ['MESSAGE_IN_PROGRESS', 'Authorization: private-reason-token']) {
    const error = Object.assign(new Error('Synthetic transport failure'), { reason });
    const { run } = setup([error]);
    const result = await run({ kind: 'identity' });
    assert.equal(result.error.code, 'NETWORK');
    assert.equal(Object.hasOwn(result.error, 'reason'), false);
    assert.doesNotMatch(JSON.stringify(result), /private|MESSAGE_IN_PROGRESS/);
  }
});

function historicalTree(status = 'in_progress') {
  const value = completeTree();
  value.mapping.a.message.status = status;
  value.mapping.a.message.end_turn = false;
  value.mapping.a.children = ['u2'];
  value.mapping.u2 = { id: 'u2', parent: 'a', children: ['a2'], message: {
    id: 'u2', author: { role: 'user' }, content: { parts: ['Continue this conversation'] }, status: 'finished_successfully',
  } };
  value.mapping.a2 = { id: 'a2', parent: 'u2', children: [], message: {
    id: 'a2', author: { role: 'assistant' }, content: { parts: ['A later completed answer'] },
    status: 'finished_successfully', end_turn: true,
  } };
  value.current_node = 'a2';
  return value;
}

test('serialized tree probe preserves historical unfinished messages with later closure on the selected branch', async () => {
  for (const status of ['pending', 'streaming', 'in_progress']) {
    const payload = historicalTree(status);
    const before = structuredClone(payload);
    const { run, calls } = setup([session(), payload, session()]);
    const result = await run({ ...autoRequest, format: 'tree', requireComplete: true });
    assert.equal(result.ok, true);
    assert.equal(result.completeness, 'complete');
    assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), before, 'no node, status or content is rewritten');
    assert.equal(calls.length, 3, 'identity must still be checked after the detail read');
    assert.deepEqual(inspectMessageGeneration(payload), {
      unfinishedCount: 1, historicalUnfinishedCount: 1, unresolvedUnfinishedCount: 0,
    });
  }
});

test('tree probe and shared classification agree on same-branch closure and ambiguous states', async t => {
  const cases = {
    'selected branch ended': { accepted: true, mutate: () => {} },
    'current node remains pending': { mutate: value => { value.mapping.a2.message.status = 'pending'; } },
    'current pending ancestor has only sibling closure': { mutate: value => {
      value.mapping.a2.message.end_turn = false;
      value.mapping.a.children.push('side');
      value.mapping.side = { id: 'side', parent: 'a', children: [], message: {
        ...structuredClone(value.mapping.a2.message), id: 'side', end_turn: true,
      } };
    } },
    'unfinished alternate branch has its own closure': { accepted: true, mutate: value => {
      value.mapping.u.children.push('side');
      value.mapping.side = { id: 'side', parent: 'u', children: ['sideFinal'], message: {
        ...structuredClone(value.mapping.a.message), id: 'side',
      } };
      value.mapping.sideFinal = { id: 'sideFinal', parent: 'side', children: [], message: {
        ...structuredClone(value.mapping.a2.message), id: 'sideFinal',
      } };
    } },
    'unfinished alternate leaf has no closure': { mutate: value => {
      value.mapping.u.children.push('side');
      value.mapping.side = { id: 'side', parent: 'u', children: [], message: {
        ...structuredClone(value.mapping.a.message), id: 'side',
      } };
    } },
    'end_turn missing': { mutate: value => { delete value.mapping.a2.message.end_turn; } },
    'end_turn false': { mutate: value => { value.mapping.a2.message.end_turn = false; } },
    'user message ended': { mutate: value => { value.mapping.a2.message.author.role = 'user'; } },
    'tool message ended': { mutate: value => { value.mapping.a2.message.author.role = 'tool'; } },
    'tool recipient': { mutate: value => { value.mapping.a2.message.recipient = 'python'; } },
    'analysis channel': { mutate: value => { value.mapping.a2.message.channel = 'analysis'; } },
    'commentary channel': { mutate: value => { value.mapping.a2.message.channel = 'commentary'; } },
    'failed end status': { mutate: value => { value.mapping.a2.message.status = 'failed'; } },
    'explicit final channel and all recipient': { accepted: true, mutate: value => {
      value.mapping.a2.message.channel = 'final'; value.mapping.a2.message.recipient = 'all';
    } },
  };
  for (const [name, { accepted = false, mutate }] of Object.entries(cases)) await t.test(name, async () => {
    const payload = historicalTree(); mutate(payload);
    const classification = inspectMessageGeneration(payload);
    assert.equal(classification.unresolvedUnfinishedCount === 0, accepted);
    const { run, calls } = setup([session(), payload, session()]);
    const result = await run({ ...autoRequest, format: 'tree', requireComplete: true });
    assert.equal(result.ok, accepted);
    if (accepted) assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), payload);
    else {
      assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
      assert.equal(result.error.reason, 'MESSAGE_IN_PROGRESS');
      assert.equal(result.payload, undefined);
      assert.equal(calls.length, 2, 'an uncertain tree must not fall back to a narrower endpoint');
    }
  });
});

test('historical closure does not override incomplete flags, malformed links or cycles', async () => {
  for (const [reason, mutate] of [
    ['SOURCE_PARTIAL', value => { value.has_more = true; }],
    ['TREE_CURRENT_NODE', value => { value.current_node = 'missing'; }],
    ['TREE_MISSING_PARENT', value => { value.mapping.u.parent = 'missing'; }],
    ['TREE_MISSING_CHILD', value => { value.mapping.u.children.push('missing'); }],
    ['TREE_PARENT_CYCLE', value => { value.mapping.root.parent = 'a2'; }],
  ]) {
    const payload = historicalTree(); mutate(payload);
    const { run, calls } = setup([session(), payload]);
    const result = await run({ ...autoRequest, format: 'tree', requireComplete: true });
    assert.equal(result.error.code, 'INCOMPLETE_DETAIL');
    assert.equal(result.error.reason, reason);
    assert.equal(result.payload, undefined);
    assert.equal(calls.length, 2);
  }
});

test('flat and page reads still reject unfinished history even with a later ended message', async () => {
  for (const format of ['flat', 'page']) {
    const payload = messagePage(['m1', 'm2'], { has_previous_page: false, has_next_page: false });
    payload.messages[0].status = 'pending';
    payload.messages[1].author.role = 'assistant';
    payload.messages[1].end_turn = true;
    assert.equal(inspectMessageGeneration(payload).unresolvedUnfinishedCount, 1);
    const { run } = setup([session(), payload]);
    const result = await run({ ...autoRequest, format, requireComplete: true });
    assert.equal(result.error.reason, 'MESSAGE_IN_PROGRESS');
    assert.equal(result.payload, undefined);
  }
});

test('serialized generation classifier stays identical to the archive classifier', () => {
  // Chrome serializes only probeChatGPT, so the small classifier must be nested.
  // Assert source parity as well as the behavior above to prevent future drift.
  const nested = inspectMessageGeneration.toString().split('\n').map(line => line ? `  ${line}` : '').join('\n');
  assert.ok(probeChatGPT.toString().includes(nested));
});

function timedProbe(handler) {
  let time = 0, nextTimer = 0;
  const timers = new Map(), scheduled = [], cleared = [], calls = [];
  const clock = {
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due <= time && timers.delete(id)) timer.callback();
      }
    },
  };
  const context = vm.createContext({
    location: { origin: 'https://chatgpt.com' }, crypto: webcrypto, TextEncoder, TextDecoder, AbortController, URL,
    fetch: async (path, options) => { calls.push({ path, options }); return handler(path, options, clock); },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      scheduled.push(delay); timers.set(id, { callback, due: time + delay }); return id;
    },
    clearTimeout: id => { cleared.push(id); timers.delete(id); },
  });
  return { run: vm.runInContext(`(${probeChatGPT.toString()})`, context), calls, scheduled, cleared, timers };
}
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const timeoutReply = result => {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(typeof result.error.code, 'string');
  assert.equal(result.error.message, '请求超时，请稍后重试。');
  assert.equal(result.payload, undefined);
  assert.equal(result.error.reason, undefined);
};

test('real AbortController numeric code 20 becomes a safe TIMEOUT for identity and detail requests', async () => {
  for (const kind of ['identity', 'detail']) {
    const f = timedProbe((path, options, clock) => {
      if (kind === 'detail' && path === '/api/auth/session') return jsonResponse(session());
      clock.advance(kind === 'detail' ? 60_000 : 20_000);
      assert.equal(options.signal.aborted, true);
      assert.equal(options.signal.reason.name, 'AbortError');
      assert.equal(options.signal.reason.code, 20, 'use the native exception, not a plain Error mock');
      throw options.signal.reason;
    });
    timeoutReply(await f.run(kind === 'identity' ? { kind } : autoRequest));
    assert.equal(f.calls.length, kind === 'identity' ? 1 : 2, 'timeout must not trigger another endpoint');
    assert.deepEqual(f.scheduled, kind === 'identity' ? [20_000] : [20_000, 60_000]);
    assert.equal(f.cleared.length, f.scheduled.length);
    assert.equal(f.timers.size, 0);
  }
});

test('a stream reader abort cannot expose a numeric code or partial conversation', async () => {
  const f = timedProbe((path, options, clock) => {
    if (path === '/api/auth/session') return jsonResponse(session());
    let reads = 0;
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({
      read: async () => {
        if (++reads === 1) return { done: false, value: new TextEncoder().encode('{"conversation_id":"private-partial') };
        clock.advance(60_000);
        throw options.signal.reason;
      },
    }) } };
  });
  const result = await f.run(autoRequest);
  timeoutReply(result);
  assert.doesNotMatch(JSON.stringify(result), /private-partial|operation was aborted/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
  assert.equal(f.cleared.length, 2);
});

test('external error codes and primitive exceptions cannot spoof a safe error or trigger fallback', async () => {
  const secret = 'private https://example.test/?token=secret';
  for (const error of [
    null, undefined, 20, secret,
    { code: 20, message: secret },
    { code: 'HTTP_404', message: secret, reason: 'TREE_MISSING_CHILD' },
    { code: 'FORMAT', message: secret },
    Object.assign(new Error(secret), { code: 'INCOMPLETE_DETAIL', reason: 'MESSAGE_IN_PROGRESS' }),
  ]) {
    const f = timedProbe(path => {
      if (path === '/api/auth/session') return jsonResponse(session());
      throw error;
    });
    const result = await f.run(autoRequest);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NETWORK');
    assert.equal(result.error.message, '请求未完成，请检查网站登录状态和网络。');
    assert.equal(result.error.reason, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|example\.test|secret|TREE_MISSING_CHILD|MESSAGE_IN_PROGRESS/);
    assert.equal(f.calls.length, 2, 'only trusted probe HTTP_404/FORMAT may select another endpoint');
    assert.equal(f.timers.size, 0);
    assert.equal(f.cleared.length, 2);
  }
});

test('foreign AbortError and TimeoutError exceptions retain only fixed timeout diagnostics', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const nativeError = new DOMException('private https://example.test/?token=secret', name);
    const f = timedProbe(() => { throw nativeError; });
    const result = await f.run({ kind: 'identity' });
    timeoutReply(result);
    assert.doesNotMatch(JSON.stringify(result), /private|example\.test|secret/);
    assert.equal(f.timers.size, 0);
    assert.equal(f.cleared.length, 1);
  }
});

test('identity and list retain 20-second budgets while a 30-second detail succeeds inside its 60-second budget', async () => {
  const identityProbe = timedProbe(() => jsonResponse(session()));
  assert.equal((await identityProbe.run({ kind: 'identity' })).ok, true);
  assert.deepEqual(identityProbe.scheduled, [20_000]);
  assert.equal(identityProbe.timers.size, 0);
  const listProbe = timedProbe(path => jsonResponse(path === '/api/auth/session' ? session() : { items: [], total: 0 }));
  assert.equal((await listProbe.run({ kind: 'list', expectedAccountKey: expectedKey, offset: 0 })).ok, true);
  assert.deepEqual(listProbe.scheduled, [20_000, 20_000, 20_000]);
  assert.equal(listProbe.timers.size, 0);
  for (const format of ['auto', 'tree', 'flat', 'page']) {
    const f = timedProbe((path, options, clock) => {
      if (path === '/api/auth/session') return jsonResponse(session());
      clock.advance(30_000);
      assert.equal(options.signal.aborted, false);
      return jsonResponse(['auto', 'tree'].includes(format) ? completeTree() : messagePage(['m1', 'm2'], {
        has_previous_page: false, has_next_page: false,
      }));
    });
    const result = await f.run({ ...autoRequest, format, requireComplete: true });
    assert.equal(result.ok, true);
    assert.equal(result.completeness, format === 'page' ? 'page' : 'complete');
    assert.deepEqual(f.scheduled, [20_000, 60_000, 20_000], 'identity checks must retain their shorter budgets');
    assert.equal(f.timers.size, 0);
    assert.equal(f.cleared.length, 3);
  }
});

test('responses arriving after the deadline are discarded even when a transport ignores abort', async () => {
  for (const phase of ['headers', 'text', 'reader-done']) {
    const f = timedProbe((path, options, clock) => {
      if (path === '/api/auth/session') return jsonResponse(session());
      const response = jsonResponse(completeTree());
      if (phase === 'headers') { clock.advance(60_000); return response; }
      if (phase === 'text') return { ok: true, headers: response.headers, body: null,
        text: async () => { clock.advance(60_000); return JSON.stringify(completeTree()); } };
      let reads = 0;
      return { ok: true, headers: response.headers, body: { getReader: () => ({ read: async () => {
        if (++reads === 1) return { done: false, value: new TextEncoder().encode(JSON.stringify(completeTree())) };
        clock.advance(60_000); return { done: true };
      } }) } };
    });
    timeoutReply(await f.run(autoRequest));
    assert.equal(f.calls.length, 2, 'late details never reach the final identity check');
    assert.equal(f.timers.size, 0);
    assert.equal(f.cleared.length, 2);
  }
});

test('stream progress does not reset the total detail deadline and generic post-abort errors remain timeouts', async () => {
  for (const behavior of ['progress', 'generic-error']) {
    const f = timedProbe((path, options, clock) => {
      if (path === '/api/auth/session') return jsonResponse(session());
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({ read: async () => {
        clock.advance(25_000);
        if (behavior === 'generic-error' && options.signal.aborted) throw new TypeError('private post-abort error');
        return { done: false, value: new TextEncoder().encode(' ') };
      } }) } };
    });
    const result = await f.run(autoRequest);
    timeoutReply(result);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.deepEqual(f.scheduled, [20_000, 60_000]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.cleared.length, 2);
  }
});

test('trusted HTTP errors keep their code and fixed copy while always clearing the request timer', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const f = timedProbe(() => new Response('private response body', { status }));
    const result = await f.run({ kind: 'identity' });
    assert.equal(result.error.code, `HTTP_${status}`);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.deepEqual(f.scheduled, [20_000]);
    assert.equal(f.cleared.length, 1);
    assert.equal(f.timers.size, 0);
  }
});
