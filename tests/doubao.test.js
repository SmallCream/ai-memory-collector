import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { probeDoubao, cancelDoubaoRequests } from '../extension/lib/doubao.js';
import { createDoubaoAdapter } from '../extension/adapters/doubao.js';
import { createPlatformAdapter } from '../extension/adapters/index.js';
import { buildArchive } from '../extension/lib/archive.js';
import { accountPrefix, createArchiveStore, needsMarkdownRefresh } from '../extension/lib/archive-store.js';
import { memoryBinaryFs } from './helpers/binary-fs.js';
import { createRestoreService } from '../extension/lib/restore-service.js';
import { extractAssets } from '../extension/lib/assets.js';
import { redactDoubaoMetadata, validateDoubaoConversation } from '../extension/lib/doubao-format.js';
import { createDoubaoAssetResolver } from '../extension/lib/doubao-assets.js';

// Synthetic fixtures follow the observed web protocol, never captured account data.
const owner = '10000000000000001', cid = '20000000000000001';
const identity = { platform: 'doubao', accountKey: `acct-${'d'.repeat(24)}`, displayName: 'Synthetic' };
const account = { ...identity, storageKey: 'doubao-dddddddd', alias: '豆包' };
const info = () => ({ conversation_id: cid, creator_id: owner, conversation_type: 3,
  name: '分页示例', create_time: '1792996100', update_time: '1792996200', latest_index: '5', msg_cursor: '1' });
const message = (index, text = `消息 ${index}`) => ({ conversation_id: cid, message_id: `3000000000000000${index}`,
  index_in_conv: String(index), user_type: index % 2 ? 1 : 2, status: 0, content_status: 0,
  create_time: '1792996100', update_time: '1792996200', ext: { is_finish: '1' }, content: '',
  content_block: [{ block_type: 10000, is_finish: true, content: { text_block: { text } } }] });
const native = () => ({ platform: 'doubao', sourceFormat: 'doubao-web-chain', conversation_id: cid,
  title: info().name, create_time: 1792996100, update_time: 1792996200,
  conversation: info(), messages: [message(1), message(2)], regen_messages: {}, has_more: false });
const recent = (user = owner) => ({ user_id: user, cells: [{ conversation: info() }], has_more: false, next_conv_version: '1' });

function probeFixture({ respond, origin = 'https://www.doubao.com' } = {}) {
  const calls = [], window = {}; window.top = window;
  const context = vm.createContext({ location: { origin }, window, URL, URLSearchParams, TextEncoder, TextDecoder,
    Uint8Array, AbortController, crypto: webcrypto, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url: new URL(url), options, body });
      const command = { 3200: 'pull_recent_conv_chain_downlink_body', 1110: 'get_conv_info_downlink_body', 3100: 'pull_singe_chain_downlink_body' }[body.cmd];
      const value = respond ? await respond(body, calls.length, options) : recent();
      return value instanceof Response ? value : Response.json({ cmd: body.cmd, status_code: 0, downlink_body: { [command]: value } });
    } });
  vm.runInContext(`var probe = ${probeDoubao.toString()}; var cancel = ${cancelDoubaoRequests.toString()}`, context);
  return { calls, context, run: input => context.probe({ requestId: 'synthetic-request', ...input }) };
}
function adapterFixture({ pages = [{ messages: [message(2), message(1)], has_more: false }], mutate, tab } = {}) {
  const calls = []; let infos = 0, pageIndex = 0;
  const browser = { tabs: { get: async () => tab || { url: 'https://www.doubao.com/chat/' + cid } },
    scripting: { executeScript: async options => {
      const request = options.args[0]; calls.push(request);
      if (options.func === cancelDoubaoRequests) return [];
      let payload = request.kind === 'info' ? info() : request.kind === 'messages' ? structuredClone(pages[pageIndex++]) : null;
      if (request.kind === 'info') infos++;
      const result = { ok: true, identity, payload, capturedAt: '2026-10-26T00:00:00Z' };
      mutate?.(result, request, { infos, pageIndex });
      return [{ frameId: 0, result }];
    } } };
  return { adapter: createDoubaoAdapter(browser), calls, browser,
    detail: extra => createDoubaoAdapter(browser).detail(1, { accountKey: identity.accountKey, conversationId: cid, ...extra }) };
}

test('Doubao probe hashes stable platform-scoped ownership and restricts transport to same origin', async () => {
  const f = probeFixture(); const first = await f.run({ kind: 'identity' }), second = await f.run({ kind: 'identity' });
  assert.equal(first.ok, true); assert.deepEqual(first.identity, second.identity);
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`doubao:${owner}`))).toString('hex').slice(0, 24);
  assert.equal(first.identity.accountKey, 'acct-' + expected);
  assert.equal(first.identity.platform, 'doubao');
  for (const { url, options, body } of f.calls) {
    assert.equal(url.origin, 'https://www.doubao.com'); assert.equal(url.pathname, '/im/chain/recent_conv');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['agw-js-conv'], 'str'); assert.equal(body.channel, 2);
    assert.ok(!/device_id|web_id|token|signature/i.test(url.search));
  }
});
test('Doubao probe refuses wrong origins, anonymous IDs and ownership changes', async () => {
  assert.equal((await probeFixture({ origin: 'https://www.doubao.com.evil.test' }).run({ kind: 'identity' })).error.code, 'ORIGIN');
  assert.equal((await probeFixture({ respond: () => recent('0') }).run({ kind: 'identity' })).ok, false);
  const f = probeFixture({ respond: (_, call) => recent(call === 1 ? owner : '10000000000000002') });
  assert.equal((await f.run({ kind: 'identity' })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await probeFixture().run({ kind: 'identity', expectedAccountKey: identity.accountKey })).error.code, 'ACCOUNT_CHANGED');
});
test('Doubao lists preserve descending version cursors without treating them as offsets', async () => {
  const f = probeFixture({ respond: () => ({ ...recent(), has_more: true, next_conv_version: '1792227233738638' }) });
  const result = await f.run({ kind: 'list', offset: '1792679968234664' });
  assert.equal(result.ok, true); assert.equal(result.payload.nextOffset, '1792227233738638');
  assert.equal(result.payload.items[0].id, cid);
  const body = f.calls[0].body.uplink_body.pull_recent_conv_chain_uplink_body;
  assert.equal(body.conv_version, 1792679968234664); assert.equal(body.direction, 1);
  const stalled = await f.run({ kind: 'list', offset: '1792227233738638' });
  assert.equal(stalled.error.code, 'PAGINATION_STALLED');
  assert.equal((await f.run({ kind: 'list', offset: '9007199254740993' })).error.code, 'FORMAT');
});
test('Doubao info verifies creator and messages verify their conversation', async () => {
  const f = probeFixture({ respond: body => body.cmd === 3200 ? recent() : body.cmd === 1110
    ? { user_id: owner, conversation_info: { ...info(), creator_id: '999' } }
    : { messages: [{ ...message(1), conversation_id: '999' }], has_more: false } });
  assert.equal((await f.run({ kind: 'info', conversationId: cid })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.run({ kind: 'messages', conversationId: cid })).error.code, 'FORMAT');
});
test('Doubao cancellation tombstone blocks queued requests before network access', async () => {
  const f = probeFixture();
  vm.runInContext(`cancel({ ids: ['synthetic-request'] })`, f.context);
  assert.equal((await f.run({ kind: 'identity' })).error.code, 'COLLECTION_PAUSED');
  assert.equal(f.calls.length, 0);
});
test('Doubao HTTP and format failures never expose response bodies', async () => {
  for (const response of [new Response('private token', { status: 403 }), new Response('private token', { headers: { 'content-type': 'text/html' } }),
    Response.json({ status_code: 1, secret: 'private token' })]) {
    const result = await probeFixture({ respond: () => response }).run({ kind: 'identity' });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /private token/);
  }
});
test('Doubao adapter assembles all pages, removes identical boundary overlap and sorts messages', async () => {
  const f = adapterFixture({ pages: [
    { messages: [message(4), message(3)], has_more: true, msg_cursor: '1' },
    { messages: [message(3), message(2), message(1)], has_more: false, msg_cursor: '1' },
  ] });
  const result = await f.detail({ onProgress: () => { throw new Error('diagnostic storage unavailable'); } });
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.payload.messages.map(m => m.index_in_conv), ['1', '2', '3', '4']);
  assert.equal(f.calls.filter(r => r.kind === 'messages')[1].anchor, '2');
  assert.equal(f.calls.filter(r => r.kind === 'info').length, 2);
});
test('Doubao rejects conflicting overlap, stalled pages, changing versions and live generation', async () => {
  const cases = [
    [{ pages: [{ messages: [message(2)], has_more: true, msg_cursor: '2' }, { messages: [message(2, 'changed')], has_more: false }] }, 'DETAIL_CHANGED'],
    [{ pages: [{ messages: [message(2)], has_more: true, msg_cursor: '2' }, { messages: [message(2)], has_more: true, msg_cursor: '1' }] }, 'DETAIL_PAGINATION'],
    [{ mutate: (r, req, { infos }) => { if (req.kind === 'info' && infos === 2) r.payload.latest_index = '6'; } }, 'DETAIL_CHANGED'],
    [{ mutate: (r, req) => { if (req.kind === 'messages') r.payload.messages[0].ext.is_finish = '0'; } }, 'PARTIAL_DETAIL'],
    [{ mutate: r => { r.identity = { ...identity, accountKey: `acct-${'e'.repeat(24)}` }; } }, 'ACCOUNT_CHANGED'],
    [{ tab: { url: 'https://chatgpt.com/' } }, 'TAB_CHANGED'],
  ];
  for (const [options, code] of cases) await assert.rejects(adapterFixture(options).detail(), { code });
});
test('Doubao adapter cancellation rejects a pending injection and calls its own cancellation probe', async () => {
  const f = adapterFixture(); let start;
  const started = new Promise(resolve => { start = resolve; }); const calls = [];
  f.browser.scripting.executeScript = options => { calls.push(options); if (options.func === cancelDoubaoRequests) return Promise.resolve([]); start(); return new Promise(() => {}); };
  const pending = f.adapter.detail(1, { accountKey: identity.accountKey, conversationId: cid }); await started;
  assert.equal(f.adapter.cancel(1, { accountKey: identity.accountKey }).cancelled, 1);
  await assert.rejects(pending, { code: 'COLLECTION_PAUSED' });
  assert.equal(calls.at(-1).func, cancelDoubaoRequests);
});
test('platform routing follows the current tab and never falls back to a different platform', async () => {
  let url = 'https://www.doubao.com/chat/'; const calls = [];
  const registered = new Map(['chatgpt', 'doubao'].map(platform => [platform, { identify: async () => { calls.push(platform); return platform; } }]));
  const router = createPlatformAdapter({ tabs: { get: async () => ({ url }) } }, registered);
  assert.equal(await router.identify(1), 'doubao'); url = 'https://chatgpt.com/';
  assert.equal(await router.identify(1), 'chatgpt'); url = 'https://www.doubao.com.evil.test/';
  await assert.rejects(router.identify(1), { code: 'TAB_CHANGED' }); assert.deepEqual(calls, ['doubao', 'chatgpt']);
});
test('Doubao archive keeps raw content and history, redacts embedded credentials, and rebuilds byte-stably', async () => {
  const conversation = native();
  conversation.messages[0].content_block[0].content.text_block.text = '用户写的 access_token 示例和 https://example.test/?token=prose';
  conversation.messages[0].fetch_token = 'private-fetch';
  conversation.messages[0].ext.inner_user_ip = 'private-ip';
  conversation.conversation.extra = JSON.stringify({ device_id: 'private-device', mode: 'keep' });
  conversation.regen_messages = { '7': { text: '历史版本', sec_sender: 'private-sender' } };
  const result = await buildArchive({ conversation, identity, capturedAt: '2026-10-26T00:00:00Z', productionPrefix: accountPrefix(account) });
  const raw = JSON.parse(result.files[0].content);
  assert.equal(raw.regen_messages['7'].text, '历史版本');
  assert.equal(JSON.parse(raw.conversation.extra).mode, 'keep');
  assert.doesNotMatch(result.files.map(f => f.content).join(''), /private-fetch|private-ip|private-device|private-sender/);
  assert.match(result.files[1].content, /用户写的 access_token/);
  assert.match(result.files[0].path, /^data\/web\/doubao\//);
  assert.equal(result.manifest.platform, 'doubao'); assert.equal(result.summary.messageCount, 2);
  const rebuilt = await buildArchive({ conversation: raw, identity, capturedAt: '2026-10-27T00:00:00Z', productionPrefix: accountPrefix(account), existingManifest: result.manifest });
  assert.equal(rebuilt.files[0].content, result.files[0].content); assert.equal(rebuilt.files[1].content, result.files[1].content);
  assert.deepEqual(redactDoubaoMetadata(raw, []), raw);
});
test('Doubao archive rejects foreign platform paths and incomplete messages before producing files', async () => {
  await assert.rejects(buildArchive({ conversation: native(), capturedAt: '2026-10-26T00:00:00Z', identity: { ...identity, platform: 'chatgpt' } }));
  await assert.rejects(buildArchive({ conversation: native(), capturedAt: '2026-10-26T00:00:00Z', identity, productionPrefix: 'data/web/chatgpt/doubao-dddddddd' }));
  for (const mutate of [n => { n.has_more = true; }, n => { n.messages.push(message(2)); },
    n => { n.messages[0].content_block[0].is_finish = false; }]) {
    const n = native(); mutate(n); assert.throws(() => validateDoubaoConversation(n), { code: 'PARTIAL_DETAIL' });
  }
});

test('Doubao preserves explicitly finished interrupted responses without accepting unfinished generation', async () => {
  const n = native(), m = n.messages[1];
  m.content_status = 120; m.ext.is_interrupted = 'true';
  validateDoubaoConversation(n);
  const archive = await buildArchive({ conversation: n, identity, capturedAt: '2026-10-26T00:00:00Z' });
  assert.equal(JSON.parse(archive.files[0].content).messages[1].content_status, 120);
  assert.match(archive.files[1].content, /来源已标记此条回复中断/); assert.match(archive.files[1].content, /消息 2/);
  for (const mutate of [m => { m.ext.is_interrupted = 'false'; }, m => { m.ext.is_finish = '0'; },
    m => { m.content_status = 121; }, m => { m.content_block[0].is_finish = false; }]) {
    const invalid = structuredClone(n); mutate(invalid.messages[1]);
    assert.throws(() => validateDoubaoConversation(invalid), { code: 'PARTIAL_DETAIL' });
  }
});
test('Doubao completed user image uploads do not require the streamed-block finish flag', async () => {
  const n = native(), m = n.messages[0]; m.content_type = 9999;
  m.content_block = [{ block_type: 10052, is_finish: false, content: { pc_event_block: '', attachment_block: { attachments: [
    { type: 1, upload_status: 1, progress: 100, parse_state: 1, review_state: 1,
      image: { image_ori: { url: 'https://p-test.byteimg.com/upload.png', width: 800, height: 600 } } },
  ] } } }];
  const f = adapterFixture({ pages: [{ messages: [...n.messages].reverse(), has_more: false }] });
  const detail = await f.detail({});
  const archive = await buildArchive({ conversation: detail.payload, identity, capturedAt: detail.capturedAt });
  assert.equal((await extractAssets(detail.payload)).length, 1);
  assert.equal(JSON.parse(archive.files[0].content).messages[0].content_block[0].is_finish, false);
  assert.match(archive.files[1].content, /附件尚未保存/);
  for (const mutate of [x => { x.user_type = 2; }, x => { x.ext.is_finish = '0'; },
    x => { x.content_block[0].block_type = 10000; }, x => { delete x.content_block[0].content; },
    x => { x.content_block[0].content.text_block = { text: 'not finished' }; },
    x => { x.content_block[0].content.attachment_block.attachments = []; },
    ...['type', 'upload_status', 'progress', 'parse_state', 'review_state'].map(key => x => {
      x.content_block[0].content.attachment_block.attachments[0][key] = 0;
    }), x => { x.content_block[0].content.attachment_block.attachments[0].image.image_ori.url = ''; },
    x => { x.content_block[0].content.attachment_block.attachments.push({ type: 1, progress: 50 }); }]) {
    const invalid = structuredClone(n); mutate(invalid.messages[0]);
    assert.throws(() => validateDoubaoConversation(invalid), { code: 'PARTIAL_DETAIL' });
  }
});

test('Doubao preserves ended empty interruption records but rejects unknown status combinations', async () => {
  const n = native(), m = n.messages[1];
  Object.assign(m, { status: 1, content_status: 120, content_type: 9999, content: '[]', content_block: [] });
  m.ext.is_interrupted = 'true';
  const f = adapterFixture({ pages: [{ messages: [...n.messages].reverse(), has_more: false }] });
  const detail = await f.detail({});
  const archive = await buildArchive({ conversation: detail.payload, identity, capturedAt: detail.capturedAt });
  assert.equal(JSON.parse(archive.files[0].content).messages[1].status, 1);
  assert.match(archive.files[1].content, /已结束空中断记录/);
  for (const mutate of [x => { x.status = 2; }, x => { x.content_status = 0; }, x => { x.user_type = 1; },
    x => { x.ext.is_finish = '0'; }, x => { delete x.ext.is_interrupted; },
    x => { x.content = 'nonempty'; }, x => { x.content = 1; },
    x => { x.content_block = message(2).content_block; }]) {
    const invalid = structuredClone(n); mutate(invalid.messages[1]);
    assert.throws(() => validateDoubaoConversation(invalid), { code: 'PARTIAL_DETAIL' });
  }
});

test('Doubao legacy interrupted replies without a flag require a later validated message', async () => {
  const n = native(); n.messages[1].content_status = 120; n.messages.push(message(3));
  const archive = await buildArchive({ conversation: n, identity, capturedAt: '2026-10-26T00:00:00Z' });
  assert.match(archive.files[1].content, /来源已标记此条回复中断/);
  assert.equal(JSON.parse(archive.files[0].content).messages[1].ext.is_interrupted, undefined);
  for (const mutate of [x => { x.messages.pop(); }, x => { x.messages[2].ext.is_finish = '0'; },
    x => { x.messages[1].ext.is_interrupted = 'false'; }, x => { x.messages[1].ext.is_finish = '0'; },
    x => { x.messages[1].content_block[0].is_finish = false; }]) {
    const invalid = structuredClone(n); mutate(invalid);
    assert.throws(() => validateDoubaoConversation(invalid), { code: 'PARTIAL_DETAIL' });
  }
});

test('Doubao resources use stable IDs across signed URL refreshes and ignore interface images', async () => {
  const n = native();
  n.messages[1].content_block.push({ is_finish: true, content: { image_block: { image_ori: { url: 'https://p-test.byteimg.com/picture.png?signature=private-one', icon_url: 'https://p-test.byteimg.com/icon.png' } } } });
  const a = await extractAssets(n); assert.equal(a.length, 1);
  assert.equal(a[0].sourceRef, 'https://p-test.byteimg.com/picture.png');
  assert.equal(a[0].retrieval.url, 'https://p-test.byteimg.com/picture.png?signature=private-one');
  assert.doesNotMatch(JSON.stringify(a), /private-one/);
  n.messages[1].content_block.at(-1).content.image_block.image_ori.url = 'https://p-test.byteimg.com/picture.png?signature=private-two';
  assert.equal((await extractAssets(n))[0].id, a[0].id);
  const archive = await buildArchive({ conversation: n, identity, capturedAt: '2026-10-26T00:00:00Z' });
  assert.doesNotMatch(archive.files[0].content, /private-two/);
});

test('Doubao legacy serialized entities retain images and redact signatures without rendering raw JSON', async () => {
  const n = native(), m = n.messages[0];
  m.content_block = []; m.content_type = 20;
  m.content = JSON.stringify({ entities: [{ entity_type: 2, entity_content: { image: { key: 'synthetic-image',
    image_thumb: { url: 'https://p-test.byteimg.com/thumb.jpg' },
    image_ori: { url: 'https://p-test.byteimg.com/original.jpg?x-signature=private-secret', format: 'jpeg' } } } }] });
  m.tts_content = m.content;
  n.messages[1].content_block[0].meta_info = [{ type: 100,
    info: JSON.stringify({ insert_text: '<img src="https://p-test.byteimg.com/a.jpg?x-signature=private-secret" data-images="[{&#34;url&#34;:&#34;https://p-test.byteimg.com/b.jpg?width=2&amp;x-signature=private-secret&#34;}]" />' }) }];
  const assets = await extractAssets(n); assert.equal(assets.length, 1); assert.equal(assets[0].kind, 'image');
  assert.equal(assets[0].sourceRef, 'https://p-test.byteimg.com/original.jpg');
  const a = await buildArchive({ conversation: n, identity, capturedAt: '2026-10-26T00:00:00Z' });
  assert.doesNotMatch(a.files[0].content, /private-secret|x-signature/);
  assert.doesNotMatch(a.files[1].content, /entity_content|image_ori/);
  assert.match(a.files[1].content, /附件尚未保存/);
  const cleaned = JSON.parse(a.files[0].content);
  assert.equal((await extractAssets(cleaned))[0].id, assets[0].id);
  assert.deepEqual(redactDoubaoMetadata(cleaned, []), cleaned);
  assert.equal(a.manifest.conversations[cid].rendererVersion, 'doubao-1');
  assert.equal(needsMarkdownRefresh({ sourceFormat: 'doubao-web-chain', rendererVersion: 'rich-3' }), true);
  assert.equal(needsMarkdownRefresh(a.manifest.conversations[cid]), false);
  assert.equal(needsMarkdownRefresh({ sourceFormat: 'doubao-web-chain', rendererVersion: 'doubao-2' }), false);
});

test('Doubao serialized block arrays render prose and reject unfinished blocks', async () => {
  const n = native(), m = n.messages[1];
  m.content_type = 9999; m.content = JSON.stringify(m.content_block); m.content_block = [];
  const a = await buildArchive({ conversation: n, identity, capturedAt: '2026-10-26T00:00:00Z' });
  assert.match(a.files[1].content, /消息 2/); assert.doesNotMatch(a.files[1].content, /text_block/);
  m.content = JSON.stringify([{ is_finish: false, content: { text_block: { text: 'still generating' } } }]);
  assert.throws(() => validateDoubaoConversation(n), { code: 'PARTIAL_DETAIL' });
});
test('Doubao asset downloads reconfirm source and account, request exact CDN permission and omit credentials', async () => {
  const n = native(); n.messages[0].content_block.push({ is_finish: true, content: { image_block: { url: 'https://p-test.byteimg.com/a.png?signature=fresh' } } });
  const [asset] = await extractAssets(n), calls = [];
  const browser = { permissions: { contains: async input => { calls.push(input); return true; } } };
  let current = identity;
  const adapter = { detail: async () => ({ payload: n }), identify: async () => current };
  const resolver = createDoubaoAssetResolver(browser, adapter, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), { headers: { 'content-type': 'image/png' } });
  } });
  const result = await resolver.resolve({ tabId: 1, account, conversationId: cid, asset });
  assert.equal(result.mimeType, 'image/png'); assert.deepEqual(calls[0], { origins: ['https://p-test.byteimg.com/*'] });
  assert.equal(calls[1].options.credentials, 'omit'); assert.equal(calls[1].options.redirect, 'error');
  current = { ...identity, accountKey: `acct-${'e'.repeat(24)}` };
  await assert.rejects(resolver.resolve({ tabId: 1, account, conversationId: cid, asset }), { code: 'ACCOUNT_CHANGED' });
});

test('Doubao local save and commit-pinned repository restore preserve native and Markdown hashes', async () => {
  const local = memoryBinaryFs(), restored = memoryBinaryFs();
  const store = createArchiveStore({ get: local.getSetting, set: local.setSetting });
  const saved = await store.saveConversation({ directory: local.directory, account,
    detail: { identity, payload: native(), capturedAt: '2026-10-26T00:00:00Z', completeness: 'complete' } });
  const destination = createArchiveStore({ get: restored.getSetting, set: restored.setSetting });
  const snapshot = { repository: 'synthetic/archive', branch: 'main', commitSha: '1'.repeat(40), treeSha: '2'.repeat(40),
    empty: false, entries: saved.files.map((file, i) => ({ path: file.path, type: 'blob', mode: '100644', sha: String(i).repeat(40), size: Buffer.byteLength(file.content) })) };
  const config = { repository: snapshot.repository, branch: snapshot.branch, token: 'synthetic' };
  const restore = createRestoreService({ getSetting: restored.getSetting, setSetting: restored.setSetting,
    fetchRepositorySnapshot: async () => snapshot,
    downloadRepositoryFile: async ({ entry }) => new TextEncoder().encode(saved.files.find(f => f.path === entry.path).content),
    applyRemoteFiles: destination.applyRemoteFiles, readLocalManifest: destination.readAccountManifest,
    reconcileRestoredAssets: async () => ({ pending: false }),
  });
  await restore.start({ config, directory: restored.directory });
  let state;
  for (let i = 0; i < 5; i++) { state = await restore.tick({ config, directory: restored.directory }); if (state.status === 'completed') break; }
  assert.equal(state.status, 'completed'); assert.equal(state.restored, 1);
  assert.equal(restored.text(saved.entry.jsonPath), local.text(saved.entry.jsonPath));
  assert.equal(restored.text(saved.entry.markdownPath), local.text(saved.entry.markdownPath));
  assert.equal((await destination.readAccountManifest(restored.directory, account)).platform, 'doubao');
  assert.ok(!restored.settings.has('collectorConfigV2'), 'restore must not enable collection');
  const before = local.writes.length;
  await assert.rejects(store.saveConversation({ directory: local.directory, account: { ...account, platform: 'chatgpt' },
    detail: { identity, payload: native(), completeness: 'complete' } }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(local.writes.length, before);
});
