import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTAdapter, isChatGPTUrl } from '../extension/adapters/chatgpt.js';
import { adapterForUrl, getAdapter, supportedPlatforms } from '../extension/adapters/index.js';

const identity = { platform: 'chatgpt', accountKey: `acct-${'a'.repeat(24)}`, displayName: 'Synthetic', workspace: 'unverified' };
function fixture(result, tabs = [{ url: 'https://chatgpt.com/c/demo' }, { url: 'https://chatgpt.com/c/demo' }]) {
  const calls = [];
  const browser = {
    tabs: { get: async () => {
      const value = tabs.shift(); if (value instanceof Error) throw value; return value;
    } },
    scripting: { executeScript: async options => { calls.push(options); return [{ frameId: 0, result }]; } },
  };
  return { adapter: createChatGPTAdapter(browser), calls };
}
test('registry supports only packaged ChatGPT adapter and exact HTTPS origin', () => {
  assert.deepEqual(supportedPlatforms, ['chatgpt']);
  assert.equal(adapterForUrl('https://chatgpt.com/c/demo'), getAdapter('chatgpt'));
  for (const url of ['http://chatgpt.com', 'https://chatgpt.com.example.test', 'https://example.test/?url=https://chatgpt.com', 'not-a-url']) {
    assert.equal(isChatGPTUrl(url), false); assert.equal(adapterForUrl(url), null);
  }
  assert.throws(() => getAdapter('gemini'), { code: 'UNSUPPORTED_PLATFORM' });
});
test('adapter targets only main frame in isolated world and requests a complete tree detail', async () => {
  const { adapter, calls } = fixture({ ok: true, identity, payload: { conversation_id: 'demo', mapping: { root: { message: null } } }, completeness: 'complete', capturedAt: '2026-10-21T00:00:00Z' });
  const result = await adapter.detail(12, { accountKey: identity.accountKey, conversationId: 'demo' });
  assert.equal(calls[0].args[0].format, 'tree');
  assert.equal(calls[0].args[0].requireComplete, true);
  assert.equal(calls[0].world, 'ISOLATED');
  assert.deepEqual(calls[0].target, { tabId: 12, frameIds: [0] });
  assert.equal(result.completeness, 'complete');
  assert.equal(result.payload.conversation_id, 'demo');
});
test('identity and list keep normalized production contract', async () => {
  const first = fixture({ ok: true, identity });
  assert.deepEqual(await first.adapter.identify(1), identity);
  const payload = { items: [{ id: 'a' }], nextOffset: null, total: 1 };
  const second = fixture({ ok: true, identity, payload });
  assert.deepEqual(await second.adapter.list(1, { accountKey: identity.accountKey, offset: 0 }), payload);
});
test('closed, navigating and unrelated tabs cannot trigger capture', async () => {
  for (const [tab, code] of [[new Error('No tab'), 'TAB_CLOSED'], [{ url: 'https://example.test' }, 'TAB_CHANGED'],
    [{ url: 'https://chatgpt.com', pendingUrl: 'https://example.test' }, 'TAB_CHANGED']]) {
    const { adapter, calls } = fixture(null, [tab]);
    await assert.rejects(adapter.identify(1), { code });
    assert.equal(calls.length, 0);
  }
});
test('navigation after injection invalidates otherwise successful result', async () => {
  const { adapter } = fixture({ ok: true, identity }, [{ url: 'https://chatgpt.com' }, { url: 'https://example.test' }]);
  await assert.rejects(adapter.identify(1), { code: 'TAB_CHANGED' });
});
test('changed identity and unconfirmed completeness never reach storage caller', async () => {
  const other = fixture({ ok: true, identity: { ...identity, accountKey: `acct-${'b'.repeat(24)}` }, completeness: 'complete' });
  await assert.rejects(other.adapter.detail(1, { accountKey: identity.accountKey, conversationId: 'demo' }), { code: 'ACCOUNT_CHANGED' });
  const incomplete = fixture({ ok: true, identity, completeness: 'unknown' });
  await assert.rejects(incomplete.adapter.detail(1, { accountKey: identity.accountKey, conversationId: 'demo' }), { code: 'INCOMPLETE_DETAIL' });
});
test('probe failures retain safe retry codes', async () => {
  const { adapter } = fixture({ ok: false, error: { code: 'HTTP_429', message: '限流' } });
  await assert.rejects(adapter.identify(1), { code: 'HTTP_429', message: '限流' });
});

test('detail failures keep only known reason codes without exposing extra probe data', async () => {
  for (const reason of ['TREE_MISSING_CHILD', 'private-response-https://example.test/?token=secret', '__proto__']) {
    const { adapter } = fixture({ ok: false, error: { code: 'INCOMPLETE_DETAIL', message: '详情未确认', reason,
      response: 'private conversation', token: 'secret' } });
    await assert.rejects(adapter.detail(1, { accountKey: identity.accountKey, conversationId: 'demo' }), error => {
      assert.equal(error.code, 'INCOMPLETE_DETAIL');
      assert.equal(error.reason, reason === 'TREE_MISSING_CHILD' ? reason : undefined);
      assert.doesNotMatch(JSON.stringify(error), /private|token|secret|__proto__/);
      return true;
    });
  }
});
