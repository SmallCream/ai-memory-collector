import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createChatGPTAssetResolver, probeChatGPTAsset, validateExternalAsset } from '../extension/lib/chatgpt-assets.js';

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
