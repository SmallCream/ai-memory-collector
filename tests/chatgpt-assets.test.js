import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createChatGPTAssetResolver, probeChatGPTAsset, validateExternalAsset } from '../extension/lib/chatgpt-assets.js';
import { extractAssets } from '../extension/lib/assets.js';

const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64'));
const hash = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
const accountKey = async id => 'acct-' + (await hash(new TextEncoder().encode(`chatgpt:${id}`))).slice(0, 24);
const ACCOUNT = await accountKey('synthetic-user-A');
const asset = { fileId: 'file_testA', libraryFileId: 'libfile_testA', fileName: 'screenshot.png',
  size: PNG.byteLength, width: 1, height: 1, mimeType: 'image/png' };
const libraryURL = 'https://chatgpt.com/api/library/files/libfile_testA/download';
const estuaryURL = 'https://chatgpt.com/backend-api/estuary/content?id=file_testA&fn=synthetic-image.png&cd=attachment&ts=2000000000&p=fs&cid=1&sig=synthetic-estuary-secret&v=0';
const conversationId = 'synthetic-conversation_A';
const fileDownloadURL = `https://chatgpt.com/backend-api/files/download/file_testA?conversation_id=${conversationId}&download_intent=false&inline=true`;
const sessionURL = 'https://chatgpt.com/api/auth/session';
const pngResponse = (bytes = PNG, headers = {}) => new Response(bytes, { headers: { 'content-type': 'image/png', ...headers } });
const locatedResponse = (response, url) => Object.defineProperty(response, 'url', { value: url });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sessionResponse = user => jsonResponse({ user: { id: user }, accessToken: 'synthetic-secret-token' });

function image({ id = 'file_testA', src = 'blob:https://chatgpt.com/1111-2222', visible = true, width = 1, height = 1, parent } = {}) {
  return { src, currentSrc: src, complete: true, naturalWidth: width, naturalHeight: height, parentElement: parent,
    getClientRects: () => visible ? [{}] : [], getAttribute: key => key === 'data-file-id' ? id : null };
}

function harness({ serve = () => pngResponse(), sessions = ['synthetic-user-A'], images = [], origin = 'https://chatgpt.com', style } = {}) {
  const calls = []; let sessionIndex = 0;
  const context = vm.createContext({ URL, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView, AbortController,
    setTimeout, clearTimeout, btoa, atob, location: { origin }, document: { querySelectorAll: () => images },
    getComputedStyle: style || (() => ({ display: 'block', visibility: 'visible' })),
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url) === sessionURL) return sessionResponse(sessions[Math.min(sessionIndex++, sessions.length - 1)]);
      return serve(String(url), options);
    } });
  const fn = vm.runInContext(`(${probeChatGPTAsset.toString()})`, context);
  return { calls, run: overrides => fn({ expectedAccountKey: ACCOUNT, asset: { ...asset }, allowLibraryDownload: true,
    maxBytes: 16 * 1024 * 1024, ...overrides }) };
}

function browserFor(h, { tabs, mutate } = {}) {
  let checks = 0;
  return { tabs: { get: async () => {
    if (tabs) return tabs(checks++);
    return { url: 'https://chatgpt.com/c/test' };
  } }, scripting: { executeScript: async options => {
    assert.equal(options.world, 'ISOLATED'); assert.deepEqual(options.target.frameIds, [0]);
    const result = await h.run(options.args[0]);
    return [{ frameId: 0, result: mutate ? mutate(result) : result }];
  } } };
}

test('serialized page probe checks account before and after and returns verified bounded image bytes', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.accountKey, ACCOUNT);
  assert.equal(result.binary.quality, 'original');
  assert.equal(result.binary.mimeType, 'image/png');
  assert.equal(result.binary.sha256, await hash(PNG));
  assert.deepEqual(Buffer.from(result.binary.chunks.join(''), 'base64'), Buffer.from(PNG));
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, libraryURL, sessionURL]);
  assert.equal(h.calls[1].options.headers.Authorization, 'Bearer synthetic-secret-token');
  assert.equal(h.calls[1].options.credentials, 'include');
  assert.equal(h.calls[1].options.redirect, 'manual');
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(result).includes('synthetic-user'));
  assert.ok(!JSON.stringify(result).includes('https://'));
});

test('resolver accepts a manifest hash ID and preserves exact platform resource identity', async () => {
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h), { allowLibraryDownload: true });
  const result = await resolver.resolve({ tabId: 3, account: { accountKey: ACCOUNT, platform: 'chatgpt' },
    asset: { ...asset, id: 'f'.repeat(64), sourceRef: 'sediment://file_testA', fileName: '../unsafe/name' } });
  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.fileName, '_unsafe_name.png');
  assert.equal(result.quality, 'original');
  assert.equal(result.sha256, await hash(PNG));
});

test('Library route is opt-in, while a visible exact-ID blob can be fetched in the source page', async () => {
  const h = harness({ images: [image()] });
  const resolver = createChatGPTAssetResolver(browserFor(h));
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, asset });
  assert.equal(result.via, 'visible-image');
  assert.equal(h.calls.filter(call => call.url === libraryURL).length, 0);
  const blob = h.calls.find(call => call.url.startsWith('blob:'));
  assert.equal(blob.options.credentials, 'omit');
  assert.equal(blob.options.headers.Authorization, undefined);
});

test('a bare generated-image pointer uses the observed file-download route with its task conversation and authenticated native follow', async () => {
  const h = harness({ serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } :
    locatedResponse(pngResponse(), estuaryURL) });
  let probeResult;
  const resolver = createChatGPTAssetResolver(browserFor(h, { mutate: result => { probeResult = result; return result; } }),
    { allowFileDownload: true });
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId,
    asset: { ...asset, libraryFileId: undefined, sourceRef: 'sediment://file_testA' } });
  assert.deepEqual(result.bytes, PNG); assert.equal(result.sha256, await hash(PNG));
  assert.equal(result.via, 'file-download'); assert.equal(result.quality, 'original');
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, fileDownloadURL, fileDownloadURL, sessionURL]);
  assert.equal(h.calls[1].options.credentials, 'include');
  assert.equal(h.calls[1].options.headers.Authorization, 'Bearer synthetic-secret-token');
  assert.equal(h.calls[2].options.redirect, 'follow'); assert.equal(h.calls[2].options.credentials, 'same-origin');
  assert.equal(h.calls[2].options.headers.Authorization, 'Bearer synthetic-secret-token');
  assert.equal(h.calls[2].options.referrerPolicy, 'no-referrer');
  assert.equal(h.calls[2].options.signal, h.calls[1].options.signal);
  for (const value of [probeResult, result]) {
    assert.doesNotMatch(JSON.stringify(value), /https:\/\/|synthetic-estuary-secret|synthetic-secret-token/);
  }
});

test('file download accepts direct bytes, a JSON download URL, and a readable redirect without native follow', async t => {
  for (const value of [
    { name: 'direct bytes', response: () => pngResponse(), urls: [fileDownloadURL] },
    { name: 'JSON link', response: () => jsonResponse({ download_url: estuaryURL }), urls: [fileDownloadURL, estuaryURL] },
    { name: 'readable Location', response: () => new Response(null, { status: 302, headers: { location: estuaryURL } }),
      urls: [fileDownloadURL, estuaryURL] },
  ]) await t.test(value.name, async () => {
    const h = harness({ serve: url => url === fileDownloadURL ? value.response() : pngResponse() });
    const result = await h.run({ asset: { ...asset, libraryFileId: null }, allowFileDownload: true, conversationId });
    assert.equal(result.ok, true); assert.equal(result.binary.via, 'file-download');
    assert.equal(result.binary.sha256, await hash(PNG));
    assert.deepEqual(h.calls.map(call => call.url), [sessionURL, ...value.urls, sessionURL]);
    for (const call of h.calls.filter(call => call.url !== sessionURL)) {
      assert.equal(call.options.redirect, 'manual'); assert.equal(call.options.credentials, 'include');
      assert.equal(call.options.headers.Authorization, 'Bearer synthetic-secret-token');
    }
    assert.doesNotMatch(JSON.stringify(result), /https:\/\/|synthetic-estuary-secret|synthetic-secret-token/);
  });
});

test('file download requires explicit opt-in, a file ID and a task conversation instead of inferring the current tab', async t => {
  for (const value of [
    { name: 'default disabled', request: { conversationId } },
    { name: 'missing task conversation', request: { allowFileDownload: true } },
    { name: 'null task conversation', request: { allowFileDownload: true, conversationId: null } },
    { name: 'missing file ID', request: { allowFileDownload: true, conversationId, asset: { libraryFileId: asset.libraryFileId } } },
  ]) await t.test(value.name, async () => {
    const h = harness();
    const result = await h.run({ asset: { ...asset, libraryFileId: null }, allowLibraryDownload: false, ...value.request });
    assert.equal(result.error.code, 'ASSET_PENDING');
    assert.deepEqual(h.calls.map(call => call.url), [sessionURL, sessionURL]);
  });
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h));
  await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId,
    asset: { ...asset, libraryFileId: undefined } }), { code: 'ASSET_PENDING' });
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, sessionURL]);
});

test('invalid task conversation IDs are rejected by both resolver and injected probe before network access', async t => {
  for (const value of ['', '../other', 'conversation?extra=1', 'conversation/other', 'x'.repeat(101), 123, {}]) {
    await t.test(JSON.stringify(value), async () => {
      const h = harness();
      const resolver = createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true });
      await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId: value, asset }), { code: 'ASSET_INPUT' });
      const result = await h.run({ allowFileDownload: true, conversationId: value });
      assert.equal(result.error.code, 'ASSET_INPUT'); assert.equal(h.calls.length, 0);
    });
  }
});

test('file download runs after captured and Library failures, while arbitrary captured URLs do not gain native follow', async () => {
  const captured = `${fileDownloadURL}&include_library_file_state=true`;
  const h = harness({ images: [image()], serve: (url, options) => {
    if (url === captured) return { type: 'opaqueredirect' };
    if (url === libraryURL) return new Response('', { status: 404 });
    if (url === fileDownloadURL) return options.redirect === 'manual' ? { type: 'opaqueredirect' } : locatedResponse(pngResponse(), estuaryURL);
    throw new Error('unexpected request');
  } });
  const result = await h.run({ asset: { ...asset, retrievalURL: captured }, allowFileDownload: true, conversationId });
  assert.equal(result.ok, true); assert.equal(result.binary.via, 'file-download');
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, captured, libraryURL, fileDownloadURL, fileDownloadURL, sessionURL]);
  assert.equal(h.calls[1].options.redirect, 'manual');
  assert.deepEqual(h.calls.filter(call => call.options.redirect === 'follow').map(call => call.url), [fileDownloadURL]);
});

test('file download preserves errors and byte/account constraints when the DOM has no usable image', async t => {
  for (const value of [
    { name: 'HTTP 403', response: () => new Response('', { status: 403 }), code: 'HTTP_403' },
    { name: 'unknown JSON', response: () => jsonResponse({ unexpected: true }), code: 'ASSET_PROTOCOL' },
    { name: 'HTML', response: () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), code: 'ASSET_FORMAT' },
    { name: 'opaque follow', response: () => ({ type: 'opaqueredirect' }), code: 'ASSET_REDIRECT' },
    { name: 'network failure', response: () => { throw new TypeError('synthetic-private-url-secret'); }, code: 'ASSET_NETWORK' },
    { name: 'initial wrong account', sessions: ['synthetic-user-B'], code: 'ACCOUNT_CHANGED', noDownload: true },
    { name: 'account changed', sessions: ['synthetic-user-A', 'synthetic-user-B'], code: 'ACCOUNT_CHANGED' },
    { name: 'wrong dimensions', source: { width: 2 }, code: 'ASSET_VARIANT' },
    { name: 'wrong size', source: { size: PNG.length + 1 }, code: 'ASSET_VARIANT' },
    { name: 'wrong hash', source: { expectedHash: '0'.repeat(64) }, code: 'ASSET_HASH_MISMATCH' },
    { name: 'wrong MIME', response: () => pngResponse(PNG, { 'content-type': 'image/jpeg' }), code: 'ASSET_FORMAT' },
    { name: 'invalid bytes', response: () => pngResponse(new TextEncoder().encode('not an image')), code: 'ASSET_FORMAT' },
    { name: 'declared limit', response: () => pngResponse(PNG, { 'content-length': '99999999' }), code: 'ASSET_TOO_LARGE' },
    { name: 'stream limit', source: { size: null }, maxBytes: 32, code: 'ASSET_TOO_LARGE' },
  ]) await t.test(value.name, async () => {
    const h = harness({ sessions: value.sessions, serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } :
      locatedResponse((value.response || pngResponse)(), estuaryURL) });
    const result = await h.run({ asset: { ...asset, libraryFileId: null, ...value.source },
      conversationId, allowFileDownload: true, maxBytes: value.maxBytes || 16 * 1024 * 1024 });
    assert.equal(result.error.code, value.code); assert.equal(result.binary, undefined);
    if (value.noDownload) assert.deepEqual(h.calls.map(call => call.url), [sessionURL]);
    assert.doesNotMatch(JSON.stringify(result), /https:\/\/|synthetic-.*secret/);
  });
});

test('file-download native follow rejects an unrelated final file before reading response bytes', async t => {
  for (const url of [estuaryURL.replace('file_testA', 'file_other'), `${estuaryURL}&id=file_testA`,
    'https://chatgpt.com/backend-api/files/download/file_other?conversation_id=synthetic-other',
    'https://attacker.example/image.png', undefined]) await t.test(String(url), async () => {
    let reads = 0;
    const h = harness({ serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } : {
      type: 'basic', url, ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
      get body() { reads++; return null; },
    } });
    const result = await h.run({ asset: { ...asset, libraryFileId: null }, conversationId, allowFileDownload: true });
    assert.equal(result.error.code, 'ASSET_URL'); assert.equal(reads, 0); assert.equal(result.binary, undefined);
    assert.doesNotMatch(JSON.stringify(result), /https:\/\/|synthetic-estuary-secret/);
  });
});

test('legacy file- IDs are inferred from native references and accepted by the injected page probe', async () => {
  const h = harness({ images: [image({ id: 'file-legacySynthetic' })] });
  const resolver = createChatGPTAssetResolver(browserFor(h));
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT,
    asset: { id: 'f'.repeat(64), sourceRef: 'file-service://file-legacySynthetic',
      expectedSize: PNG.length, width: 1, height: 1, mimeType: 'image/png' } });
  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.fileName, 'file-legacySynthetic.png');
  assert.equal(result.via, 'visible-image');
});

test('missing metadata cannot establish original-image fidelity', async () => {
  const h = harness();
  const result = await h.run({ asset: { fileId: 'file_testA', libraryFileId: 'libfile_testA' } });
  assert.equal(result.ok, true);
  assert.equal(result.binary.quality, 'unverified');
});

test('an initial wrong account prevents any asset request', async () => {
  const h = harness({ sessions: ['synthetic-user-B'] });
  const result = await h.run();
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(h.calls.length, 1);
  assert.equal(result.binary, undefined);
});

test('an account switch after reading discards the obtained bytes', async () => {
  const h = harness({ sessions: ['synthetic-user-A', 'synthetic-user-B'] });
  const result = await h.run();
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(result.binary, undefined);
});

test('only the trusted resolved CDN receives an anonymous request', async () => {
  const cdn = 'https://sdmntprtest.oaiusercontent.com/image.png?signature=synthetic';
  const h = harness({ serve: url => url === libraryURL ? jsonResponse({ download_url: cdn }) : pngResponse() });
  const result = await h.run();
  assert.equal(result.ok, true);
  const request = h.calls.find(call => call.url === cdn);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.ok(!JSON.stringify(result).includes('signature'));
});

test('JSON links and readable redirects to untrusted destinations are rejected before following', async t => {
  for (const serve of [() => jsonResponse({ download_url: 'https://attacker.example/image.png' }),
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/image.png' } })]) {
    await t.test('no request to external destination', async () => {
      const h = harness({ serve });
      const result = await h.run();
      assert.equal(result.error.code, 'ASSET_URL');
      assert.ok(h.calls.every(call => call.url.startsWith('https://chatgpt.com/')));
    });
  }
});

test('a Library follow attempt that still exposes an opaque redirect remains pending', async () => {
  const h = harness({ serve: () => ({ type: 'opaqueredirect' }) });
  const result = await h.run();
  assert.equal(result.error.code, 'ASSET_REDIRECT');
  assert.equal(result.error.state, 'pending');
  assert.equal(h.calls.filter(call => call.options.redirect === 'follow').length, 1);
});

test('canonical Library opaque redirect gets one native follow with same-origin credentials and a shared timeout', async () => {
  const destination = 'https://sdmntprtest.oaiusercontent.com/original.png?sig=synthetic-private';
  const h = harness({ serve: (url, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } : locatedResponse(pngResponse(), destination) });
  const result = await h.run();
  assert.equal(result.ok, true); assert.equal(result.binary.quality, 'original');
  assert.equal(result.binary.via, 'library-download'); assert.equal(result.binary.sha256, await hash(PNG));
  const downloads = h.calls.filter(call => call.url === libraryURL);
  assert.equal(downloads.length, 2); assert.equal(downloads[0].options.redirect, 'manual');
  assert.equal(downloads[1].options.redirect, 'follow'); assert.equal(downloads[1].options.credentials, 'same-origin');
  assert.equal(downloads[1].options.headers.Authorization, 'Bearer synthetic-secret-token');
  assert.equal(downloads[1].options.referrerPolicy, 'no-referrer');
  assert.equal(downloads[1].options.signal, downloads[0].options.signal);
  assert.equal(downloads[1].options.signal.aborted, true);
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, libraryURL, libraryURL, sessionURL]);
  assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  // This mock verifies our fetch options, not the browser's implementation of
  // Fetch-standard Authorization stripping on the internal cross-origin hop.
});

test('canonical Library opaque redirect accepts the observed estuary route for the exact file without leaking its temporary URL', async () => {
  const h = harness({ serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } :
    locatedResponse(pngResponse(), estuaryURL) });
  let probeResult;
  const resolver = createChatGPTAssetResolver(browserFor(h, { mutate: result => { probeResult = result; return result; } }),
    { allowLibraryDownload: true });
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, asset });
  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.sha256, await hash(PNG));
  assert.equal(result.quality, 'original');
  assert.equal(result.via, 'library-download');
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, libraryURL, libraryURL, sessionURL]);
  const follow = h.calls[2].options;
  assert.equal(follow.redirect, 'follow'); assert.equal(follow.credentials, 'same-origin');
  assert.equal(follow.referrerPolicy, 'no-referrer');
  for (const value of [probeResult, result]) {
    const serialized = JSON.stringify(value);
    assert.ok(!serialized.includes('https://'));
    assert.ok(!serialized.includes('synthetic-estuary-secret'));
    assert.ok(!serialized.includes('synthetic-secret-token'));
    assert.ok(!serialized.includes('synthetic-image.png'));
  }
});

test('an assistant citation of the second uploaded image preserves its file ID through extraction and Library redirect', async () => {
  const serve = (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } : locatedResponse(pngResponse(), estuaryURL);
  const legacy = createChatGPTAssetResolver(browserFor(harness({ serve })), { allowLibraryDownload: true });
  // Reproduce the former library-only duplicate: the final estuary ID cannot
  // be verified when extraction has discarded the native platform file ID.
  await assert.rejects(legacy.resolve({ tabId: 3, account: ACCOUNT,
    asset: { libraryFileId: asset.libraryFileId, fileName: 'synthetic-second.png' } }), { code: 'ASSET_URL' });

  const files = [
    { id: 'file_synthetic_uncited', library_file_id: 'libfile_synthetic_uncited', name: 'synthetic-first.png' },
    { id: asset.fileId, library_file_id: asset.libraryFileId, name: 'synthetic-second.png' },
  ];
  const source = { id: 'synthetic-citation-conversation', messages: [
    { id: 'synthetic-user-message', role: 'user', content: { content_type: 'multimodal_text', parts: files.map(file => ({
      content_type: 'image_asset_pointer', asset_pointer: `sediment://${file.id}`, width: 1, height: 1, size_bytes: PNG.length,
    })) }, metadata: { attachments: files.map(file => ({ ...file, mime_type: 'image/png' })) } },
    { id: 'synthetic-assistant-message', role: 'assistant', content: { content_type: 'text', parts: ['Synthetic answer'] },
      metadata: { content_references: [{ type: 'file', source: 'my_files', ...files[1],
        input_pointer: { message_id: null }, matched_text: 'synthetic-file-marker', cloud_doc_url: null }] } },
  ] };
  const extracted = await extractAssets(source);
  assert.equal(extracted.length, 2);
  const second = extracted.find(item => item.fileId === asset.fileId);
  assert.equal(second.libraryFileId, asset.libraryFileId); assert.equal(second.occurrences.length, 3);
  assert.equal(extracted.find(item => item.fileId === files[0].id).occurrences.length, 2);
  let probeResult;
  const h = harness({ serve });
  const resolver = createChatGPTAssetResolver(browserFor(h, { mutate: result => { probeResult = result; return result; } }),
    { allowLibraryDownload: true });
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, asset: second });
  assert.deepEqual(result.bytes, PNG); assert.equal(result.sha256, await hash(PNG));
  assert.equal(result.via, 'library-download'); assert.equal(result.quality, 'original');
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, libraryURL, libraryURL, sessionURL]);
  for (const value of [extracted, probeResult, result]) {
    assert.doesNotMatch(JSON.stringify(value), /https:\/\/|synthetic-estuary-secret|synthetic-secret-token/);
  }
});

test('estuary final URLs require the exact route and a single matching platform file ID before reading bytes', async t => {
  const route = 'https://chatgpt.com/backend-api/estuary/content';
  for (const value of [
    { name: 'missing ID', url: route },
    { name: 'empty ID', url: `${route}?id=` },
    { name: 'wrong file ID', url: `${route}?id=file_other` },
    { name: 'library ID is not a file ID', url: `${route}?id=libfile_testA` },
    { name: 'manifest hash is not a file ID', url: `${route}?id=${'f'.repeat(64)}` },
    { name: 'no expected file ID', url: `${route}?id=file_testA`, source: { libraryFileId: asset.libraryFileId } },
    { name: 'repeated identical ID', url: `${route}?id=file_testA&id=file_testA` },
    { name: 'repeated conflicting ID', url: `${route}?id=file_testA&id=file_other` },
    { name: 'encoded duplicate query key', url: `${route}?id=file_testA&%69d=file_testA` },
    { name: 'extra path segment', url: `${route}/extra?id=file_testA` },
    { name: 'similar route', url: 'https://chatgpt.com/backend-api/other/content?id=file_testA' },
    { name: 'insecure scheme', url: `${route.replace('https:', 'http:')}?id=file_testA` },
    { name: 'untrusted origin', url: `${route.replace('chatgpt.com', 'attacker.example')}?id=file_testA` },
    { name: 'embedded credentials', url: `${route.replace('https://', 'https://user:synthetic-password@')}?id=file_testA` },
    { name: 'nonstandard port', url: `${route.replace('chatgpt.com', 'chatgpt.com:444')}?id=file_testA` },
  ]) await t.test(value.name, async () => {
    let reads = 0;
    const url = `${value.url}${value.url.includes('?') ? '&' : '?'}sig=synthetic-estuary-secret`;
    const h = harness({ serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } : {
      type: 'basic', url, ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
      get body() { reads++; return null; },
    } });
    const result = await h.run({ asset: value.source || { ...asset } });
    assert.equal(result.error.code, 'ASSET_URL'); assert.equal(reads, 0); assert.equal(result.binary, undefined);
    assert.ok(!JSON.stringify(result).includes('https://'));
    assert.ok(!JSON.stringify(result).includes('synthetic-estuary-secret'));
    assert.ok(!JSON.stringify(result).includes('synthetic-password'));
  });
});

test('Library follow validates the final HTTPS destination before reading its body', async t => {
  for (const url of [undefined, '', 'http://sdmntprtest.oaiusercontent.com/a.png', 'https://attacker.example/a.png',
    'https://user:secret@sdmntprtest.oaiusercontent.com/a.png', 'https://chatgpt.com/login',
    'https://chatgpt.com/api/library/files/libfile_other/download']) {
    await t.test(String(url), async () => {
      let reads = 0;
      const h = harness({ serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } : {
        type: 'cors', url, ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
        get body() { reads++; return null; },
      } });
      const result = await h.run();
      assert.equal(result.error.code, 'ASSET_URL'); assert.equal(reads, 0); assert.equal(result.binary, undefined);
      assert.ok(!JSON.stringify(result).includes('secret'));
    });
  }
});

test('captured URLs, queried Library URLs and anonymous CDN requests never opt into native follow', async t => {
  for (const url of [libraryURL, `${libraryURL}?download=true`, `${libraryURL}#download`,
    'https://chatgpt.com/backend-api/files/file_testA/download', fileDownloadURL, estuaryURL, 'https://sdmntprtest.oaiusercontent.com/a.png',
    'blob:https://chatgpt.com/1111-2222']) {
    await t.test(url, async () => {
      const h = harness({ serve: () => ({ type: 'opaqueredirect' }) });
      const result = await h.run({ asset: { ...asset, retrievalURL: url }, allowLibraryDownload: false });
      assert.equal(result.error.code, 'ASSET_REDIRECT');
      assert.equal(h.calls.some(call => call.options.redirect === 'follow'), false);
    });
  }
  const cdn = 'https://sdmntprtest.oaiusercontent.com/a.png';
  const h = harness({ serve: url => url === libraryURL ? jsonResponse({ download_url: cdn }) : { type: 'opaqueredirect' } });
  assert.equal((await h.run()).error.code, 'ASSET_REDIRECT');
  assert.equal(h.calls.some(call => call.options.redirect === 'follow'), false);
});

test('Library follow retains HTTP, HTML, network and timeout failure classification without leaking response details', async t => {
  for (const value of [
    { name: 'HTTP failure', response: () => new Response('', { status: 403 }), code: 'HTTP_403' },
    { name: 'login HTML', response: () => new Response('<html>login secret</html>', { headers: { 'content-type': 'text/html' } }), code: 'ASSET_FORMAT' },
    { name: 'CORS failure', response: () => { throw new TypeError('signed-url-secret'); }, code: 'ASSET_NETWORK' },
    { name: 'timeout', response: () => { throw Object.assign(new Error('signed-url-secret'), { name: 'AbortError' }); }, code: 'ASSET_TIMEOUT' },
  ]) await t.test(value.name, async () => {
    const h = harness({ serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } : locatedResponse(value.response(), libraryURL) });
    const result = await h.run();
    assert.equal(result.error.code, value.code); assert.equal(result.binary, undefined);
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
});

test('Library follow retains size, original-image and final account gates', async t => {
  for (const destination of ['https://sdmntprtest.oaiusercontent.com/original.png', estuaryURL]) for (const value of [
    { name: 'stream limit', maxBytes: 32, source: { fileId: asset.fileId, libraryFileId: asset.libraryFileId }, code: 'ASSET_TOO_LARGE' },
    { name: 'declared limit', response: () => pngResponse(PNG, { 'content-length': '99999999' }), code: 'ASSET_TOO_LARGE' },
    { name: 'invalid image bytes', response: () => pngResponse(new TextEncoder().encode('not an image')), code: 'ASSET_FORMAT' },
    { name: 'wrong MIME', response: () => pngResponse(PNG, { 'content-type': 'image/jpeg' }), code: 'ASSET_FORMAT' },
    { name: 'wrong original dimensions', source: { ...asset, width: 2 }, code: 'ASSET_VARIANT' },
    { name: 'wrong original size', source: { ...asset, size: PNG.length + 1 }, code: 'ASSET_VARIANT' },
    { name: 'wrong original hash', source: { ...asset, expectedHash: '0'.repeat(64) }, code: 'ASSET_HASH_MISMATCH' },
    { name: 'account switched', sessions: ['synthetic-user-A', 'synthetic-user-B'], code: 'ACCOUNT_CHANGED' },
  ]) await t.test(`${new URL(destination).pathname}: ${value.name}`, async () => {
    const h = harness({ sessions: value.sessions, serve: (_, options) => options.redirect === 'manual' ? { type: 'opaqueredirect' } :
      locatedResponse((value.response || pngResponse)(), destination) });
    const result = await h.run({ asset: value.source || { ...asset }, maxBytes: value.maxBytes || 16 * 1024 * 1024 });
    assert.equal(result.error.code, value.code); assert.equal(result.binary, undefined);
  });
});

test('unsupported JSON structure is pending and not treated as image bytes', async () => {
  const h = harness({ serve: () => jsonResponse({ unexpected: { url: 'https://sdmntprtest.oaiusercontent.com/a.png' } }) });
  const result = await h.run();
  assert.equal(result.error.code, 'ASSET_PROTOCOL');
});

test('HTML, MIME spoofing, and thumbnail metadata mismatches cannot be archived as originals', async t => {
  const cases = [
    { name: 'HTML login page', serve: () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), code: 'ASSET_FORMAT' },
    { name: 'non-image bytes', serve: () => pngResponse(new TextEncoder().encode('not an image')), code: 'ASSET_FORMAT' },
    { name: 'wrong MIME', serve: () => pngResponse(PNG, { 'content-type': 'image/jpeg' }), code: 'ASSET_FORMAT' },
    { name: 'wrong dimensions', source: { ...asset, width: 100 }, code: 'ASSET_VARIANT' },
    { name: 'wrong byte count', source: { ...asset, size: PNG.length + 1 }, code: 'ASSET_VARIANT' },
    { name: 'wrong known hash', source: { ...asset, expectedHash: '0'.repeat(64) }, code: 'ASSET_HASH_MISMATCH' },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const h = harness({ serve: value.serve });
    const result = await h.run(value.source ? { asset: value.source } : undefined);
    assert.equal(result.error.code, value.code);
    assert.equal(result.binary, undefined);
  });
});

test('response content length and streamed bytes each enforce the maximum', async t => {
  for (const declared of [false, true]) await t.test(declared ? 'declared limit' : 'stream limit', async () => {
    const h = harness({ serve: () => pngResponse(PNG, declared ? { 'content-length': '5000' } : {}) });
    const result = await h.run({ asset: { fileId: 'file_testA', libraryFileId: 'libfile_testA' }, maxBytes: 32 });
    assert.equal(result.error.code, 'ASSET_TOO_LARGE');
  });
});

test('DOM association rejects unrelated, hidden, undersized, and filename-only images', async () => {
  const h = harness({ images: [image({ id: 'file_other' }), image({ visible: false }), image({ width: 0 }),
    image({ id: null, src: 'https://sdmntprtest.oaiusercontent.com/screenshot.png' })] });
  const result = await h.run({ allowLibraryDownload: false });
  assert.equal(result.error.code, 'ASSET_PENDING');
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, sessionURL]);
});

test('a direct wrapper may associate the visible image with the matching library resource', async () => {
  const wrapper = { getAttribute: key => key === 'data-library-file-id' ? 'libfile_testA' : null };
  const h = harness({ images: [image({ id: null, parent: wrapper })] });
  const result = await h.run({ allowLibraryDownload: false });
  assert.equal(result.ok, true);
});

test('invalid descriptors and cross-origin tabs cannot trigger collection', async t => {
  for (const badAsset of [ { ...asset, fileId: '../escape' }, { ...asset, sourceRef: 'sediment://file_other' },
    { sourceRef: 'https://attacker.example/arbitrary', id: 'f'.repeat(64) }, { ...asset, libraryFileId: 'libfile_a/../../other' } ]) {
    await t.test('invalid descriptor', async () => {
      const h = harness();
      const resolver = createChatGPTAssetResolver(browserFor(h), { allowLibraryDownload: true });
      await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT, asset: badAsset }), { code: 'ASSET_INPUT' });
      assert.equal(h.calls.length, 0);
    });
  }
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h, { tabs: () => ({ url: 'https://chatgpt.com.evil.example/' }) }));
  await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT, asset }), { code: 'TAB_CHANGED' });
  assert.equal(h.calls.length, 0);
});

test('tab navigation detected after injection discards the result', async () => {
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h, { tabs: count => ({ url: count ? 'https://other.example/' : 'https://chatgpt.com/' }) }), { allowLibraryDownload: true });
  await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT, asset }), { code: 'TAB_CHANGED' });
});

test('transport corruption is rejected by an independently computed digest', async () => {
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h, { mutate: result => { result.binary.sha256 = '0'.repeat(64); return result; } }), { allowLibraryDownload: true });
  await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT, asset }), { code: 'ASSET_HASH_MISMATCH' });
});

test('image bytes larger than a transport chunk retain exact order and content', async () => {
  const bytes = new Uint8Array(70000); bytes.set(PNG); bytes.fill(7, PNG.length);
  const h = harness({ serve: () => pngResponse(bytes) });
  const resolver = createChatGPTAssetResolver(browserFor(h), { allowLibraryDownload: true });
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, asset: { ...asset, size: bytes.length } });
  assert.deepEqual(result.bytes, bytes);
});

test('raw network errors cannot leak signed URLs or credentials into the result', async () => {
  const h = harness({ serve: () => { throw new Error('https://cdn.example/private?secret=synthetic-secret-token'); } });
  const result = await h.run();
  assert.equal(result.error.code, 'ASSET_NETWORK');
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(result).includes('cdn.example'));
});

test('captured trusted resource URLs are used only transiently and without credentials', async () => {
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h));
  const url = 'https://sdmntprtest.oaiusercontent.com/original.png?sig=synthetic';
  const result = await resolver.resolve({ tabId: 3, account: ACCOUNT,
    asset: { sourceRef: 'https://sdmntprtest.oaiusercontent.com/original.png', sourceType: 'temporary',
      retrieval: { url }, expectedSize: PNG.length, width: 1, height: 1 } });
  assert.equal(result.quality, 'original');
  assert.equal(result.via, 'captured-resource');
  const request = h.calls.find(call => call.url === url);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(result).includes('sig='));
});

test('an unrelated transient URL is rejected before requesting even the session', async () => {
  const h = harness();
  const resolver = createChatGPTAssetResolver(browserFor(h));
  await assert.rejects(resolver.resolve({ tabId: 3, account: ACCOUNT,
    asset: { ...asset, retrieval: { url: 'https://attacker.example/private.png' } } }), { code: 'ASSET_URL' });
  assert.equal(h.calls.length, 0);
});

const externalBrowser = permission => ({ permissions: { contains: async request => {
  assert.deepEqual(request.origins, ['https://images.example/*']); return permission;
} } });

test('external validation uses a permission-gated anonymous GET and leaves no binary payload', async () => {
  const calls = [];
  const result = await validateExternalAsset({ url: 'https://images.example/photo.png', browser: externalBrowser(true),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return pngResponse(); } });
  assert.equal(result.status, 'external');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.sha256, await hash(PNG));
  assert.equal(result.byteLength, PNG.byteLength);
  assert.equal(result.bytes, undefined);
  assert.ok(Date.parse(result.verifiedAt));
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(calls[0].options.headers, {});
});

test('external unknowns do not become managed attachments or trigger permission prompts', async t => {
  const cases = [
    { name: 'missing site permission', permission: false, reason: 'permission-required' },
    { name: 'CORS or network failure', serve: () => { throw new Error('private error text'); }, reason: 'network-or-cors' },
    { name: 'authentication page', serve: () => new Response('', { status: 403 }), reason: 'authentication-required' },
    { name: 'opaque redirect', serve: () => ({ type: 'opaqueredirect' }), reason: 'redirect' },
    { name: 'MIME mismatch', serve: () => pngResponse(PNG, { 'content-type': 'image/jpeg' }), reason: 'content-mismatch' },
    { name: 'HTML response', serve: () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }), reason: 'unsupported-content' },
    { name: 'stream exceeds bound', limit: 32, reason: 'too-large' },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    let calls = 0;
    const result = await validateExternalAsset({ url: 'https://images.example/photo.png', browser: externalBrowser(value.permission ?? true),
      maxBytes: value.limit ?? 1024, fetchImpl: async () => { calls++; return (value.serve ?? pngResponse)(); } });
    assert.deepEqual(result, { status: 'unknown', reason: value.reason });
    if (value.permission === false) assert.equal(calls, 0);
  });
});

test('private host literals, signed URLs and embedded credentials are not probed as public assets', async () => {
  let calls = 0;
  for (const url of ['https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://printer.local/a.png',
    'https://images.example/photo.png?X-Amz-Signature=secret', 'https://user:pass@images.example/a.png']) {
    const result = await validateExternalAsset({ url, browser: externalBrowser(true), fetchImpl: async () => { calls++; return pngResponse(); } });
    assert.equal(result.status, 'unknown');
  }
  assert.equal(calls, 0);
});

const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]);
const PDF = new TextEncoder().encode('%PDF-1.7\nsynthetic document\n%%EOF\n');
const sandbox = { sourceRef: 'sandbox:/mnt/data/synthetic%20report.zip', kind: 'attachment',
  fileName: 'synthetic report.zip', messageId: 'synthetic-assistant-message' };
const interpreterURL = `https://chatgpt.com/backend-api/conversation/${conversationId}/interpreter/download?download_intent=true&message_id=synthetic-assistant-message&sandbox_path=%2Fmnt%2Fdata%2Fsynthetic+report.zip`;
const fileResponse = (bytes = ZIP, type = 'application/zip', headers = {}) => new Response(bytes, { headers: { 'content-type': type, ...headers } });

test('generated ZIP uses its exact conversation, message and sandbox path, then follows the actual resource mapping', async t => {
  for (const mode of ['direct', 'json-link', 'location', 'native-follow']) await t.test(mode, async () => {
    const h = harness({ serve: (url, options) => {
      if (url === interpreterURL) {
        if (mode === 'json-link') return jsonResponse({ download_url: estuaryURL });
        if (mode === 'location') return new Response(null, { status: 302, headers: { location: estuaryURL } });
        if (mode === 'native-follow') return options.redirect === 'manual' ? { type: 'opaqueredirect' } : locatedResponse(fileResponse(), estuaryURL);
        return fileResponse();
      }
      if (url === estuaryURL) return fileResponse();
      throw new Error('unexpected attachment request');
    } });
    let probeResult;
    const resolver = createChatGPTAssetResolver(browserFor(h, { mutate: value => { probeResult = value; return value; } }), { allowFileDownload: true });
    const value = await resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId, asset: sandbox });
    assert.deepEqual(value.bytes, ZIP); assert.equal(value.fileName, sandbox.fileName);
    assert.equal(value.mimeType, 'application/zip'); assert.equal(value.via, 'interpreter-download');
    assert.equal(value.sha256, await hash(ZIP));
    assert.deepEqual(h.calls.filter(call => call.url !== sessionURL).map(call => call.url), mode === 'direct' ? [interpreterURL] :
      mode === 'native-follow' ? [interpreterURL, interpreterURL] : [interpreterURL, estuaryURL]);
    for (const item of [probeResult, value]) assert.doesNotMatch(JSON.stringify(item), /https:\/\/|synthetic-estuary-secret|synthetic-secret-token|sandbox_path/);
  });
});

test('reused sandbox paths produce distinct request identities for each source message', async () => {
  const h = harness({ serve: () => fileResponse() });
  const resolver = createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true });
  for (const messageId of ['synthetic-message-A', 'synthetic-message-B']) {
    await resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId, asset: { ...sandbox, messageId } });
  }
  const entries = h.calls.filter(call => call.url !== sessionURL).map(call => new URL(call.url));
  assert.deepEqual(entries.map(url => url.searchParams.get('message_id')), ['synthetic-message-A', 'synthetic-message-B']);
  assert.ok(entries.every(url => url.searchParams.get('sandbox_path') === '/mnt/data/synthetic report.zip'));
});

test('sandbox acquisition requires explicit file opt-in plus task conversation and message IDs', async t => {
  for (const value of [
    { name: 'disabled', options: {}, conversationId, asset: sandbox },
    { name: 'missing conversation', options: { allowFileDownload: true }, asset: sandbox },
    { name: 'missing message', options: { allowFileDownload: true }, conversationId, asset: { ...sandbox, messageId: undefined } },
  ]) await t.test(value.name, async () => {
    const h = harness();
    await assert.rejects(createChatGPTAssetResolver(browserFor(h), value.options).resolve({ tabId: 3, account: ACCOUNT,
      conversationId: value.conversationId, asset: value.asset }), { code: 'ASSET_PENDING' });
    assert.deepEqual(h.calls.map(call => call.url), [sessionURL, sessionURL]);
  });
  for (const patch of [ { sourceRef: 'sandbox:/mnt/../secret.zip' }, { sourceRef: 'sandbox://other/secret.zip' },
    { sourceRef: 'sandbox:/mnt/%2e%2e/secret.zip' }, { sourceRef: 'sandbox:/mnt/a%00.zip' },
    { messageId: '../other' }, { messageId: 'x?secret=value' } ]) {
    const h = harness();
    await assert.rejects(createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true }).resolve({ tabId: 3, account: ACCOUNT,
      conversationId, asset: { ...sandbox, ...patch } }), { code: 'ASSET_INPUT' });
    assert.equal(h.calls.length, 0);
  }
});

test('sandbox response cannot bless an arbitrary origin, unrelated route, ambiguous ID or a known conflicting file ID', async t => {
  for (const value of [
    { name: 'external', url: 'https://attacker.example/report.zip' },
    { name: 'other same-origin endpoint', url: 'https://chatgpt.com/backend-api/other/download?id=file_testA' },
    { name: 'ambiguous ID', url: `${estuaryURL}&id=file_testA` },
    { name: 'known conflicting ID', url: estuaryURL, patch: { fileId: 'file_expected' } },
  ]) await t.test(value.name, async () => {
    let reads = 0;
    const h = harness({ serve: (url, options) => {
      if (url !== interpreterURL) return new Response('', { status: 404 });
      if (options.redirect === 'manual') return { type: 'opaqueredirect' };
      return { type: 'basic', url: value.url, ok: true, status: 200, headers: new Headers({ 'content-type': 'application/zip' }),
        get body() { reads++; return null; } };
    } });
    await assert.rejects(createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true }).resolve({ tabId: 3, account: ACCOUNT,
      conversationId, asset: { ...sandbox, ...value.patch } }));
    assert.equal(reads, 0);
    assert.ok(h.calls.every(call => call.url.startsWith('https://chatgpt.com/')));
  });
});

test('generated attachments retain account, content, size, hash and format gates before archival', async t => {
  for (const value of [
    { name: 'initial wrong account', sessions: ['synthetic-user-B'], code: 'ACCOUNT_CHANGED', noDownload: true },
    { name: 'account switch', sessions: ['synthetic-user-A', 'synthetic-user-B'], code: 'ACCOUNT_CHANGED' },
    { name: 'expired source', response: () => new Response('', { status: 404 }), code: 'HTTP_404' },
    { name: 'login page', response: () => fileResponse(new TextEncoder().encode('<html>login</html>'), 'text/html'), code: 'ASSET_FORMAT' },
    { name: 'HTML mislabeled zip', response: () => fileResponse(new TextEncoder().encode('<html>login</html>')), code: 'ASSET_FORMAT' },
    { name: 'corrupt ZIP', response: () => fileResponse(new Uint8Array([0x50, 0x4b, 3, 4, 0])), code: 'ASSET_FORMAT' },
    { name: 'wrong MIME', response: () => fileResponse(ZIP, 'application/pdf'), code: 'ASSET_FORMAT' },
    { name: 'wrong original size', patch: { expectedSize: ZIP.length + 1 }, code: 'ASSET_VARIANT' },
    { name: 'wrong original hash', patch: { sha256: '0'.repeat(64) }, code: 'ASSET_HASH_MISMATCH' },
    { name: 'stream bound', limit: 10, code: 'ASSET_TOO_LARGE' },
  ]) await t.test(value.name, async () => {
    const h = harness({ sessions: value.sessions, serve: value.response || (() => fileResponse()) });
    await assert.rejects(createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true, maxBytes: value.limit || 1024 }).resolve({
      tabId: 3, account: ACCOUNT, conversationId, asset: { ...sandbox, ...value.patch } }), { code: value.code });
    if (value.noDownload) assert.deepEqual(h.calls.map(call => call.url), [sessionURL]);
  });
});

test('PDF and source files use existing exact file IDs with canonical types and full byte validation', async t => {
  for (const value of [
    { name: 'report.pdf', bytes: PDF, mime: 'application/pdf' },
    { name: 'readme.md', bytes: new TextEncoder().encode('# Synthetic\n'), mime: 'text/markdown' },
    { name: 'script.py', bytes: new TextEncoder().encode('print("synthetic")\n'), mime: 'text/x-python' },
    { name: 'settings.yaml', bytes: new TextEncoder().encode('synthetic: true\n'), mime: 'application/yaml' },
    { name: 'query.sql', bytes: new TextEncoder().encode('select 1;\n'), mime: 'application/sql' },
    { name: 'script.sh', bytes: new TextEncoder().encode('echo synthetic\n'), mime: 'application/x-sh' },
  ]) await t.test(value.name, async () => {
    const h = harness({ serve: () => fileResponse(value.bytes, value.mime) });
    const resolver = createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true });
    const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId,
      asset: { kind: 'attachment', fileId: 'file_testA', fileName: value.name, mimeType: value.mime, expectedSize: value.bytes.length } });
    assert.deepEqual(result.bytes, value.bytes); assert.equal(result.fileName, value.name);
    assert.equal(result.mimeType, value.mime); assert.equal(result.quality, 'original');
    assert.deepEqual(h.calls.map(call => call.url), [sessionURL, fileDownloadURL, sessionURL]);
  });
});

test('JSON attachments are distinguished from JSON download envelopes without navigating their contents', async () => {
  const content = { url: 'https://attacker.example/do-not-follow', synthetic: true };
  const cdn = 'https://sdmntprtest.oaiusercontent.com/settings.json';
  for (const explicitAttachment of [true, false]) {
    const h = harness({ serve: url => url === interpreterURL && !explicitAttachment ? jsonResponse({ download_url: cdn }) :
      fileResponse(new TextEncoder().encode(JSON.stringify(content)), 'application/json', explicitAttachment ? { 'content-disposition': 'attachment; filename="settings.json"' } : {}) });
    const source = { ...sandbox, fileName: 'settings.json' };
    // The source path is independent from the presentation filename.
    const resolver = createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true });
    const result = await resolver.resolve({ tabId: 3, account: ACCOUNT, conversationId, asset: source });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.bytes)), content);
    assert.equal(result.mimeType, 'application/json');
    assert.ok(h.calls.every(call => call.url !== content.url));
  }
});

test('public ZIP links are anonymously verified as external and invalid payloads remain unknown', async () => {
  for (const bytes of [ZIP, new Uint8Array([0x50, 0x4b, 3, 4])]) {
    let options;
    const result = await validateExternalAsset({ url: 'https://images.example/archive.zip', browser: externalBrowser(true),
      asset: { kind: 'attachment', fileName: 'archive.zip' }, fetchImpl: async (_, input) => { options = input; return fileResponse(bytes); } });
    assert.equal(result.status, bytes === ZIP ? 'external' : 'unknown');
    assert.equal(options.credentials, 'omit'); assert.deepEqual(options.headers, {});
    assert.equal(result.bytes, undefined);
  }
});

test('a JSON file cannot turn an HTTP 200 error envelope at its canonical download entry into archived content', async () => {
  const h = harness({ serve: () => jsonResponse({ error: 'synthetic-expired-file' }) });
  await assert.rejects(createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true }).resolve({ tabId: 3, account: ACCOUNT,
    conversationId, asset: { ...sandbox, fileName: 'settings.json' } }), { code: 'ASSET_PROTOCOL' });
  assert.deepEqual(h.calls.map(call => call.url), [sessionURL, interpreterURL, sessionURL]);
});

test('known response MIME can identify an unnamed private ZIP while bytes still undergo container validation', async () => {
  const h = harness({ serve: () => fileResponse() });
  const value = await createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true }).resolve({ tabId: 3, account: ACCOUNT,
    conversationId, asset: { fileId: 'file_testA', kind: 'attachment' } });
  assert.deepEqual(value.bytes, ZIP); assert.equal(value.fileName, 'file_testA.zip');
});

function syntheticOfficeZip(names) {
  const parts = [], central = []; let offset = 0, centralSize = 0;
  for (const name of names) {
    const encoded = new TextEncoder().encode(name), local = new Uint8Array(30 + encoded.length), directory = new Uint8Array(46 + encoded.length);
    const lv = new DataView(local.buffer), dv = new DataView(directory.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(26, encoded.length, true); local.set(encoded, 30);
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint16(28, encoded.length, true); dv.setUint32(42, offset, true); directory.set(encoded, 46);
    parts.push(local); central.push(directory); offset += local.length; centralSize += directory.length;
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, names.length, true); ev.setUint16(10, names.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const bytes = new Uint8Array(offset + centralSize + 22); let cursor = 0;
  for (const part of [...parts, ...central, end]) { bytes.set(part, cursor); cursor += part.length; }
  return bytes;
}

test('Office attachments permit ZIP transport only when the returned container matches the requested document format', async t => {
  for (const value of [
    { name: 'report.docx', entry: 'word/document.xml', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'report.xlsx', entry: 'xl/workbook.xml', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { name: 'report.pptx', entry: 'ppt/presentation.xml', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  ]) await t.test(value.name, async () => {
    const bytes = syntheticOfficeZip(['[Content_Types].xml', value.entry]);
    for (const transport of ['application/zip', 'application/x-zip-compressed']) {
      const h = harness({ serve: () => fileResponse(bytes, transport) });
      const source = { ...sandbox, fileName: value.name, mimeType: value.mime };
      const result = await createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true }).resolve({
        tabId: 3, account: ACCOUNT, conversationId, asset: source });
      assert.deepEqual(result.bytes, bytes); assert.equal(result.mimeType, value.mime); assert.equal(result.fileName, value.name);
    }
    const wrong = harness({ serve: () => fileResponse(ZIP) });
    await assert.rejects(createChatGPTAssetResolver(browserFor(wrong), { allowFileDownload: true }).resolve({
      tabId: 3, account: ACCOUNT, conversationId, asset: { ...sandbox, fileName: value.name, mimeType: value.mime } }), { code: 'ASSET_FORMAT' });
  });
});

test('Office ZIP metadata and extensionless Office MIME keep the document type after verification', async () => {
  const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const bytes = syntheticOfficeZip(['[Content_Types].xml', 'word/document.xml']);
  for (const patch of [{ fileName: 'report.docx', mimeType: 'application/zip' }, { fileName: '', mimeType }]) {
    const h = harness({ serve: () => fileResponse(bytes) });
    const result = await createChatGPTAssetResolver(browserFor(h), { allowFileDownload: true }).resolve({
      tabId: 3, account: ACCOUNT, conversationId, asset: { kind: 'attachment', fileId: 'file_testA', ...patch } });
    assert.deepEqual(result.bytes, bytes); assert.equal(result.mimeType, mimeType); assert.match(result.fileName, /\.docx$/);
  }
});

test('an unrelated image at a public ZIP URL does not verify the requested attachment', async () => {
  const value = await validateExternalAsset({ url: 'https://images.example/archive.zip', browser: externalBrowser(true),
    asset: { kind: 'attachment', fileName: 'archive.zip' }, fetchImpl: async () => pngResponse() });
  assert.deepEqual(value, { status: 'unknown', reason: 'content-mismatch' });
});
