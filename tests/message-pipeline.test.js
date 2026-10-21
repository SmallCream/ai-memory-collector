import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createCollectorEngine } from '../extension/lib/collector-engine.js';
import { createChatGPTAdapter } from '../extension/adapters/chatgpt.js';
import { createArchiveStore, readAccountManifest, readConversationBaseline, hasConversationFiles } from '../extension/lib/archive-store.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';

const rawUser = 'message-pipeline-user';
const accountKey = 'acct-' + Buffer.from(await webcrypto.subtle.digest('SHA-256',
  new TextEncoder().encode(`chatgpt:${rawUser}`))).toString('hex').slice(0, 24);
const account = { platform: 'chatgpt', accountKey, storageKey: 'message-pipeline',
  alias: 'Pipeline', enabled: true, initialized: true };
const conversationId = 'pipeline-demo';
const initialTime = Date.parse('2026-10-21T08:00:00Z');
const sourceTime = initialTime / 1000 - 3600;
function message(number) {
  return { id: `m${number}`, author: { role: number % 2 ? 'user' : 'assistant' },
    create_time: sourceTime - 100 + number, status: 'finished_successfully',
    content: { content_type: 'text', parts: [`Message ${number}`] } };
}

function setup() {
  const fs = memoryBinaryFs(), requests = [];
  const messages = Array.from({ length: 8 }, (_, index) => message(index + 1));
  let clock = initialTime, updatedAt = sourceTime, failedBefore = false, tree = null;
  // A structured private URL changes its signature between reads. The normal
  // archive sanitizer must make it equal to its already-redacted local copy.
  messages[6].metadata = { attachments: [{ id: 'file-synthetic', name: 'sample.png',
    download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file-synthetic&sig=first-synthetic-secret' }] };
  const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  const fetch = async path => {
    const url = new URL(path, 'https://chatgpt.com');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/api/auth/session') return response({ user: { id: rawUser, name: 'Pipeline' }, accessToken: 'synthetic-session-secret' });
    if (url.pathname === '/backend-api/conversations') return response({ offset: 0, total: 1,
      items: [{ id: conversationId, title: 'Pipeline conversation', create_time: sourceTime - 1000, update_time: updatedAt }] });
    if (url.pathname === `/backend-api/conversation/${conversationId}`) return tree ? response(tree) : response({}, 404);
    assert.equal(url.pathname, `/backend-api/conversations/${conversationId}`);
    assert.equal(url.searchParams.get('num_turns'), '100');
    const before = url.searchParams.get('before');
    if (before && failedBefore) return response({}, 503);
    const end = before ? messages.findIndex(item => item.id === before) : messages.length;
    assert.ok(end >= 0, 'the collector must use a cursor returned by the server');
    const start = Math.max(0, end - 4), rows = messages.slice(start, end);
    return response({ conversation_id: conversationId, title: 'Pipeline conversation',
      create_time: sourceTime - 1000, update_time: updatedAt, current_node: messages.at(-1).id,
      messages: rows, page_info: { start_cursor: rows[0]?.id ?? null, end_cursor: rows.at(-1)?.id ?? null,
        has_previous_page: start > 0, has_next_page: end < messages.length } });
  };
  const browser = {
    tabs: { get: async () => ({ url: `https://chatgpt.com/c/${conversationId}` }) },
    scripting: { executeScript: async ({ func, args }) => {
      const context = vm.createContext({ fetch, location: { origin: 'https://chatgpt.com' },
        crypto: webcrypto, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, URL });
      const run = vm.runInContext(`(${func.toString()})`, context);
      return [{ frameId: 0, result: structuredClone(await run(...args)) }];
    } },
  };
  const archive = createArchiveStore({ get: fs.getSetting, set: fs.setSetting });
  const adapter = createChatGPTAdapter(browser, { now: () => clock });
  const engine = createCollectorEngine({ getSetting: fs.getSetting, setSetting: fs.setSetting,
    getDirectory: async () => fs.directory, readAccountManifest, hasConversationFiles,
    readConversationBaseline: (directory, target, id) => readConversationBaseline(directory, target, id, { get: fs.getSetting }),
    saveConversation: input => archive.saveConversation(input), adapter, now: () => clock });
  const flatRequests = () => requests.filter(path => path.startsWith(`/backend-api/conversations/${conversationId}?`));
  return { fs, archive, engine, requests, flatRequests, messages,
    advance: milliseconds => { clock += milliseconds; },
    append: () => { messages.push(message(messages.length + 1)); updatedAt += 60; clock += 60_000; },
    failOlder: () => { failedBefore = true; },
    setTree: value => { tree = value; },
    manifest: async () => readAccountManifest(fs.directory, account),
  };
}

async function run(fixture, mode = 'incremental') {
  await fixture.engine.start({ account, tabId: 1, mode });
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = await fixture.engine.tick({ account, tabId: 1 });
    if (state.status !== 'running' || state.nextRetryAt) return state;
  }
  throw new Error('Collection did not finish');
}

test('serialized page requests, trusted local archive and engine deliver a tail update with only one detail page', async () => {
  const f = setup();
  assert.equal((await run(f)).status, 'completed');
  const original = (await f.manifest()).conversations[conversationId];
  assert.equal(original.messageSync.mode, 'full');
  assert.equal(JSON.parse(f.fs.text(original.jsonPath)).messages.length, 8);
  assert.ok(f.flatRequests().some(path => path.includes('before=m5')));
  await f.engine.acknowledgeOutbox(accountKey, (await f.engine.getOutbox(accountKey)).map(item => item.id));
  f.requests.length = 0;
  f.append();
  f.messages[6].metadata.attachments[0].download_url = 'https://chatgpt.com/backend-api/estuary/content?id=file-synthetic&sig=changed-synthetic-secret';
  const state = await run(f);
  assert.equal(state.status, 'completed');
  const entry = (await f.manifest()).conversations[conversationId];
  assert.equal(entry.messageSync.mode, 'tail-merge');
  assert.equal(entry.messageSync.fullReadAt, original.messageSync.fullReadAt);
  assert.equal(entry.messageSync.incrementalRuns, 1);
  assert.equal(entry.messageSync.addedMessages, 1);
  assert.ok(entry.messageSync.reusedMessages > 0);
  assert.deepEqual(f.flatRequests(), [`/backend-api/conversations/${conversationId}?num_turns=100`]);
  assert.deepEqual(JSON.parse(f.fs.text(entry.jsonPath)).messages.map(item => item.id), f.messages.map(item => item.id));
  const markdown = f.fs.text(entry.markdownPath);
  assert.match(markdown, /Message 1\b/); assert.match(markdown, /Message 9\b/);
  assert.doesNotMatch(f.fs.text(entry.jsonPath), /first-synthetic-secret|changed-synthetic-secret|synthetic-session-secret/);
  assert.deepEqual((await f.engine.getOutbox(accountKey)).map(item => item.conversationId), [conversationId]);
});

test('a due historical audit crosses an unchanged list timestamp and manual full collection never reuses the prefix', async () => {
  const f = setup();
  assert.equal((await run(f)).status, 'completed');
  f.append(); assert.equal((await run(f)).status, 'completed');
  const incremental = (await f.manifest()).conversations[conversationId].messageSync;
  assert.equal(incremental.mode, 'tail-merge');
  f.requests.length = 0;
  f.advance(8 * 24 * 3600_000);
  const state = await run(f);
  assert.equal(state.status, 'completed');
  assert.equal(state.diagnostics.skipped, 0);
  const audited = (await f.manifest()).conversations[conversationId].messageSync;
  assert.equal(audited.mode, 'full');
  assert.ok(audited.fullReadAt > incremental.fullReadAt);
  assert.ok(f.flatRequests().some(path => path.includes('before=')));
  f.append(); f.requests.length = 0;
  assert.equal((await run(f, 'full')).status, 'completed');
  assert.equal((await f.manifest()).conversations[conversationId].messageSync.mode, 'full');
  assert.ok(f.flatRequests().some(path => path.includes('before=')));
});

test('an interrupted older-page request preserves the previous complete archive and does not queue a truncated replacement', async () => {
  const f = setup();
  assert.equal((await run(f)).status, 'completed');
  const entry = (await f.manifest()).conversations[conversationId];
  const original = f.fs.text(entry.jsonPath), originalManifest = JSON.stringify(await f.manifest());
  await f.engine.acknowledgeOutbox(accountKey, (await f.engine.getOutbox(accountKey)).map(item => item.id));
  f.append();
  f.messages[6].content.parts = ['An edited older message requires a complete read'];
  f.failOlder();
  const state = await run(f);
  assert.equal(state.status, 'running');
  assert.equal(state.failed, 1);
  assert.equal(state.error.code, 'HTTP_503');
  assert.equal(f.fs.text(entry.jsonPath), original);
  assert.equal(JSON.stringify(await f.manifest()), originalManifest);
  assert.deepEqual(await f.engine.getOutbox(accountKey), []);
});

test('an existing tree archive is not replaced by a selected-branch page when the tree endpoint becomes unavailable', async () => {
  const f = setup();
  const mapping = { root: { id: 'root', parent: null, children: ['m1'], message: null } };
  for (const [index, item] of f.messages.entries()) mapping[item.id] = {
    id: item.id, message: item, parent: index ? f.messages[index - 1].id : 'root',
    children: index < f.messages.length - 1 ? [f.messages[index + 1].id] : [],
  };
  // A non-selected continuation is part of the original tree and must survive.
  mapping.m6.children.push('side');
  mapping.side = { id: 'side', parent: 'm6', children: [], message: {
    ...message(99), id: 'side', content: { content_type: 'text', parts: ['Preserved alternate branch'] },
  } };
  f.setTree({ conversation_id: conversationId, title: 'Pipeline conversation',
    create_time: sourceTime - 1000, update_time: sourceTime, current_node: 'm8', mapping });
  assert.equal((await run(f)).status, 'completed');
  const entry = (await f.manifest()).conversations[conversationId];
  const original = f.fs.text(entry.jsonPath);
  assert.ok(JSON.parse(original).mapping.side);
  await f.engine.acknowledgeOutbox(accountKey, (await f.engine.getOutbox(accountKey)).map(item => item.id));
  f.requests.length = 0; f.append(); f.setTree(null);
  const state = await run(f);
  assert.notEqual(state.status, 'completed');
  assert.deepEqual(f.flatRequests(), []);
  assert.equal(f.fs.text(entry.jsonPath), original);
  assert.deepEqual(await f.engine.getOutbox(accountKey), []);
});
