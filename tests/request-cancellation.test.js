import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createChatGPTAdapter } from '../extension/adapters/chatgpt.js';
import { probeChatGPT } from '../extension/lib/chatgpt.js';
import { createChatGPTAssetResolver, probeChatGPTAsset } from '../extension/lib/chatgpt-assets.js';
import { cancelChatGPTRequests, createRequestControl, safeRetryAfter } from '../extension/lib/detail-request-lifetime.js';

const accountKey = 'acct-' + Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('chatgpt:cancel-test'))).toString('hex').slice(0, 24);
const otherAccount = `acct-${'f'.repeat(24)}`;
const source = { fileId: 'file_cancelTest', libraryFileId: 'libfile_cancelTest', fileName: 'image.png', kind: 'image' };
const session = () => new Response(JSON.stringify({ user: { id: 'cancel-test', name: 'Test' }, accessToken: 'synthetic-private-token' }),
  { headers: { 'content-type': 'application/json' } });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function runningSource({ response, ignoreAbort = false } = {}) {
  const calls = [], injections = [], timers = new Map();
  let requestSignal, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const context = vm.createContext({ URL, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView,
    AbortController, atob, btoa, setTimeout, clearTimeout,
    location: { origin: 'https://chatgpt.com' }, document: { querySelectorAll: () => [] },
    fetch: async (url, options) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/auth/session')) return session();
      if (response) return response();
      requestSignal = options.signal; entered();
      return new Promise((resolve, reject) => {
        release = resolve;
        if (!ignoreAbort) options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    } });
  const browser = {
    tabs: { get: async () => ({ url: 'https://chatgpt.com/c/demo' }) },
    scripting: { executeScript: async options => {
      injections.push(options);
      const value = await vm.runInContext(`(${options.func.toString()})`, context)(options.args[0]);
      return [{ frameId: 0, result: value }];
    } },
  };
  let timerId = 0;
  const detailTimers = {
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearInterval: id => timers.delete(id),
  };
  return { browser, context, calls, injections, timers, detailTimers, started,
    signal: () => requestSignal, release: value => release(value) };
}

test('pausing a detail aborts only its owned account request and releases the outer lifetime immediately', async () => {
  const f = runningSource();
  const adapter = createChatGPTAdapter(f.browser, { timers: f.detailTimers });
  const pending = adapter.detail(3, { accountKey, conversationId: 'demo' });
  const rejected = assert.rejects(pending, { code: 'COLLECTION_PAUSED' });
  await f.started;
  assert.equal(adapter.cancel(4, { accountKey }).cancelled, 0);
  assert.equal(adapter.cancel(3, { accountKey: otherAccount }).cancelled, 0);
  assert.equal(f.signal().aborted, false);
  assert.equal(adapter.cancel(3, { accountKey }).cancelled, 1);
  await rejected; await flush();
  assert.equal(f.signal().aborted, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 2, 'cancellation must not try another source endpoint');
  assert.equal(vm.runInContext('globalThis.__aiMemoryCollectorRequestsV1.size', f.context), 0);
  const cancellation = f.injections.find(item => item.func === cancelChatGPTRequests);
  assert.equal(cancellation.world, 'ISOLATED');
  assert.deepEqual(cancellation.target, { tabId: 3, frameIds: [0] });
});

test('a transport that ignores abort cannot return a late detail as successful', async () => {
  const f = runningSource({ ignoreAbort: true });
  const adapter = createChatGPTAdapter(f.browser, { timers: f.detailTimers });
  const pending = adapter.detail(3, { accountKey, conversationId: 'demo' });
  const rejected = assert.rejects(pending, { code: 'COLLECTION_PAUSED' });
  await f.started;
  adapter.cancel(3, { accountKey }); await rejected;
  f.release(new Response(JSON.stringify({ conversation_id: 'demo', current_node: 'root', mapping: { root: { parent: null, message: null } } }),
    { headers: { 'content-type': 'application/json' } }));
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
});

test('attachment cancellation aborts the real source fetch without falling back or returning bytes', async () => {
  const f = runningSource();
  const resolver = createChatGPTAssetResolver(f.browser, { allowLibraryDownload: true, allowFileDownload: true });
  const pending = resolver.resolve({ tabId: 3, account: accountKey, conversationId: 'demo', asset: source });
  const rejected = assert.rejects(pending, { code: 'COLLECTION_PAUSED' });
  await f.started;
  assert.equal(resolver.cancel(3, { accountKey }).cancelled, 1);
  await rejected; await flush();
  assert.equal(f.signal().aborted, true);
  assert.equal(f.calls.length, 2);
  assert.equal(vm.runInContext('globalThis.__aiMemoryCollectorRequestsV1.size', f.context), 0);
});

test('cancellation before injection starts prevents network work for both serialized probes', async () => {
  for (const attachment of [false, true]) {
    let calls = 0;
    const context = vm.createContext({ location: { origin: 'https://chatgpt.com' },
      fetch: () => { calls++; throw new Error('must not run'); } });
    const requestId = attachment ? 'collector-asset-queued' : 'collector-detail-queued';
    vm.runInContext(`(${cancelChatGPTRequests.toString()})`, context)({ ids: [requestId], accountKey });
    const request = attachment ? { requestId, expectedAccountKey: accountKey, asset: source, maxBytes: 1024 }
      : { requestId, kind: 'detail', expectedAccountKey: accountKey, conversationId: 'demo', format: 'tree' };
    const probe = attachment ? probeChatGPTAsset : probeChatGPT;
    const result = await vm.runInContext(`(${probe.toString()})`, context)(request);
    assert.equal(result.error.code, 'COLLECTION_PAUSED');
    assert.equal(calls, 0);
    assert.equal(vm.runInContext('globalThis.__aiMemoryCollectorRequestsV1.size', context), 0);
  }
});

test('lost cancellation injection still rejects the local wait and leaves other requests active', async () => {
  const control = createRequestControl({ scripting: { executeScript: () => Promise.reject(new Error('closed document')) } });
  let releaseOther;
  const first = control.run(1, accountKey, scope => scope.race(() => new Promise(() => {})));
  const second = control.run(1, otherAccount, scope => scope.race(() => new Promise(resolve => { releaseOther = resolve; })));
  const rejected = assert.rejects(first, { code: 'COLLECTION_PAUSED' });
  await flush();
  assert.equal(control.cancel(1, { accountKey }).cancelled, 1);
  await rejected;
  releaseOther('valid other account result');
  assert.equal(await second, 'valid other account result');
  assert.equal(control.cancel(1, { accountKey }).cancelled, 0);
});

test('Retry-After reaches both adapters as a bounded number and rate limits do not fall back', async () => {
  for (const attachment of [false, true]) {
    for (const status of [429, 503]) {
      const f = runningSource({ response: () => new Response('private error', { status, headers: { 'Retry-After': '120' } }) });
      const pending = attachment
        ? createChatGPTAssetResolver(f.browser, { allowLibraryDownload: true, allowFileDownload: true })
          .resolve({ tabId: 3, account: accountKey, conversationId: 'demo', asset: source })
        : createChatGPTAdapter(f.browser).detail(3, { accountKey, conversationId: 'demo' });
      await assert.rejects(pending, error => {
        assert.equal(error.code, `HTTP_${status}`);
        assert.equal(error.retryAfterMs, 120_000);
        assert.doesNotMatch(JSON.stringify(error), /private|token|https/);
        return true;
      });
      assert.equal(f.calls.length, 2);
    }
  }
});

test('Retry-After accepts HTTP dates, caps long waits, ignores invalid headers and strips unsupported error metadata', async () => {
  const now = 1_800_000_000_000;
  for (const [header, expected] of [
    [new Date(now + 90_000).toUTCString(), 90_000], ['9999999999', 86_400_000], ['0', 0],
    ['-50', undefined], ['abc', undefined], ['https://private.example/?token=secret', undefined],
  ]) {
    for (const attachment of [false, true]) {
      class FixedDate extends Date { static now() { return now; } }
      const context = vm.createContext({ URL, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView,
        AbortController, setTimeout, clearTimeout, Date: FixedDate, location: { origin: 'https://chatgpt.com' },
        fetch: () => new Response('', { status: 429, headers: { 'Retry-After': header } }) });
      const probe = attachment ? probeChatGPTAsset : probeChatGPT;
      const request = attachment ? { expectedAccountKey: accountKey, asset: source, maxBytes: 1024 } : { kind: 'identity' };
      const result = await vm.runInContext(`(${probe.toString()})`, context)(request);
      assert.equal(result.error.code, 'HTTP_429');
      assert.equal(result.error.retryAfterMs, expected);
      assert.doesNotMatch(JSON.stringify(result), /private|token|https/);
    }
  }
  assert.equal(safeRetryAfter('HTTP_404', 1_000), undefined);
  assert.equal(safeRetryAfter('HTTP_429', 'secret'), undefined);
  assert.equal(safeRetryAfter('HTTP_429', Infinity), undefined);
  assert.equal(safeRetryAfter('HTTP_429', -1), undefined);
});
