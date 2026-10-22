import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTAdapter, isChatGPTUrl } from '../extension/adapters/chatgpt.js';
import { adapterForUrl, getAdapter, supportedPlatforms } from '../extension/adapters/index.js';

const identity = { platform: 'chatgpt', accountKey: `acct-${'a'.repeat(24)}`, displayName: 'Synthetic', workspace: 'unverified' };
function fixture(result, tabs = [{ url: 'https://chatgpt.com/c/demo' }, { url: 'https://chatgpt.com/c/demo' }], { raw = false } = {}) {
  const calls = [];
  const browser = {
    tabs: { get: async () => {
      const value = tabs.shift(); if (value instanceof Error) throw value; return value;
    } },
    scripting: { executeScript: async options => { calls.push(options); return raw ? result : [{ frameId: 0, result }]; } },
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

test('script result transport rejects malformed containers, absent main frames and duplicate main frames', async () => {
  for (const [result, reason] of [
    [undefined, 'SCRIPT_RESULTS_INVALID'], [null, 'SCRIPT_RESULTS_INVALID'], [{}, 'SCRIPT_RESULTS_INVALID'],
    [[null], 'SCRIPT_RESULTS_INVALID'], [[[]], 'SCRIPT_RESULTS_INVALID'],
    [[{ frameId: 0, result: { ok: true, identity } }, 'invalid'], 'SCRIPT_RESULTS_INVALID'],
    [[], 'SCRIPT_MAIN_FRAME_MISSING'], [[{ frameId: 3, result: { ok: true, identity } }], 'SCRIPT_MAIN_FRAME_MISSING'],
    [[{ frameId: 0 }, { frameId: 0, result: { ok: true, identity } }], 'SCRIPT_RESULTS_INVALID'],
  ]) {
    const { adapter, calls } = fixture(result, undefined, { raw: true });
    await assert.rejects(adapter.detail(1, { accountKey: identity.accountKey, conversationId: 'demo' }), { code: 'INVALID_RESPONSE', reason });
    assert.equal(calls.length, 1, 'transport failures must not trigger a different source endpoint');
  }
});

test('missing script results and frame errors remain distinct and never expose browser error data', async () => {
  for (const [frame, reason] of [
    [{ frameId: 0 }, 'SCRIPT_RESULT_MISSING'],
    [{ frameId: 0, result: undefined }, 'SCRIPT_RESULT_MISSING'],
    [{ frameId: 0, result: null }, 'SCRIPT_RESULT_MISSING'],
    [{ frameId: 0, error: 'https://example.test/private?token=secret' }, 'SCRIPT_EXECUTION_FAILED'],
    [{ frameId: 0, error: { message: 'private response', code: 'HTTP_401', reason: 'MESSAGE_IN_PROGRESS' } }, 'SCRIPT_EXECUTION_FAILED'],
    [{ frameId: 0, error: false, result: { ok: true, identity } }, 'SCRIPT_EXECUTION_FAILED'],
    [{ frameId: 0, error: '', result: { ok: true, identity } }, 'SCRIPT_EXECUTION_FAILED'],
  ]) {
    const { adapter } = fixture([frame], undefined, { raw: true });
    await assert.rejects(adapter.identify(1), error => {
      assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(error.reason, reason);
      assert.doesNotMatch(error.message + JSON.stringify(error), /example\.test|private|token=|secret|MESSAGE_IN_PROGRESS|HTTP_401/);
      return true;
    });
  }
  for (const error of [null, undefined]) {
    const { adapter } = fixture([{ frameId: 0, error, result: { ok: true, identity } }], undefined, { raw: true });
    assert.deepEqual(await adapter.identify(1), identity);
  }
});

test('probe envelopes require a boolean ok and a valid explicit failure code', async () => {
  for (const result of [
    '', 1, [], {}, { ok: 'yes', identity }, { ok: 1, identity }, { ok: null, identity },
    { ok: false }, { ok: false, error: null }, { ok: false, error: [] },
    { ok: false, error: { code: 401, message: 'private error' } },
    { ok: false, error: { code: 'https://example.test/private', message: 'Bearer secret', reason: 'MESSAGE_IN_PROGRESS' } },
    { ok: false, error: { message: 'private error', reason: 'MESSAGE_IN_PROGRESS' } },
  ]) {
    const { adapter } = fixture(result);
    await assert.rejects(adapter.identify(1), error => {
      assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(error.reason, 'SCRIPT_ENVELOPE_INVALID');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|example\.test|Bearer|secret|MESSAGE_IN_PROGRESS/);
      return true;
    });
  }
  const tabs = [{ url: 'https://chatgpt.com/c/demo' }];
  const { adapter, calls } = fixture({ ok: false, error: { code: 'INCOMPLETE_DETAIL', message: '详情未完整', reason: 'TREE_MISSING_CHILD' } }, tabs);
  await assert.rejects(adapter.identify(1), { code: 'INCOMPLETE_DETAIL', reason: 'TREE_MISSING_CHILD' });
  assert.equal(calls.length, 1); assert.equal(tabs.length, 0, 'explicit probe failures preserve their existing path');
});

test('an invalid script result rechecks whether the source tab closed or left ChatGPT', async () => {
  for (const [after, code] of [
    [new Error('private tab exception'), 'TAB_CLOSED'],
    [{ url: 'https://example.test/private' }, 'TAB_CHANGED'],
    [{ url: 'https://chatgpt.com/c/demo', pendingUrl: 'https://example.test/private' }, 'TAB_CHANGED'],
  ]) {
    const { adapter } = fixture([{ frameId: 0, error: 'private browser error' }], [{ url: 'https://chatgpt.com/c/demo' }, after], { raw: true });
    await assert.rejects(adapter.identify(1), error => {
      assert.equal(error.code, code); assert.equal(error.reason, undefined);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|example\.test/);
      return true;
    });
  }
});
