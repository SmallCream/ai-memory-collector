import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTAdapter } from '../extension/adapters/chatgpt.js';

const now = Date.parse('2026-10-21T12:00:00Z');
const identity = { platform: 'chatgpt', accountKey: `acct-${'a'.repeat(24)}`, displayName: 'Synthetic', workspace: 'unverified' };
const options = { accountKey: identity.accountKey, conversationId: 'demo' };
const message = id => ({ id, author: { role: 'user' }, status: 'finished_successfully',
  content: { content_type: 'text', parts: [`Synthetic ${id}`] } });
function page(ids, { previous = false, next = false, current = 'm6', updated = 1792584000 } = {}) {
  return { conversation_id: 'demo', title: 'Synthetic', current_node: current, update_time: updated,
    messages: ids.map(message), page_info: { start_cursor: ids[0] ?? null, end_cursor: ids.at(-1) ?? null,
      has_previous_page: previous, has_next_page: next } };
}
function tree() {
  return { conversation_id: 'demo', title: 'Synthetic', current_node: 'm6', update_time: 1792584000,
    mapping: { root: { id: 'root', parent: null, children: ['m6'], message: null },
      m6: { id: 'm6', parent: 'root', children: [], message: message('m6') } } };
}
function baseline(payload = page(['m1', 'm2', 'm3', 'm4', 'm5'], { current: 'm5', updated: 1792583000 })) {
  const format = payload.mapping ? 'tree' : 'flat';
  return { payload, entry: { conversationId: 'demo', contentHash: 'a'.repeat(64), sourceCompleteness: 'complete',
    messageSync: { schemaVersion: 1, format, mode: 'full', scope: format === 'tree' ? 'returned-tree' : 'selected-branch',
      fullReadAt: now - 1000, checkedAt: now - 1000, incrementalRuns: 0 } } };
}
function ok(payload, completeness = payload.mapping ? 'complete' : 'page', extra = {}) {
  return { ok: true, identity, payload, completeness, detailFormat: payload.mapping ? 'tree' : 'flat',
    capturedAt: new Date(now).toISOString(), sourceFormat: 'chatgpt-web-detail', ...extra };
}
const failure = code => ({ ok: false, error: { code, message: 'Synthetic failure' } });
function fixture(respond, { tabAt } = {}) {
  const calls = [];
  let tabReads = 0;
  const browser = {
    tabs: { get: async id => {
      tabReads++;
      return tabAt?.(tabReads, id) ?? { id, url: 'https://chatgpt.com/c/demo' };
    } },
    scripting: { executeScript: async input => {
      const request = input.args[0];
      calls.push(structuredClone(request));
      const result = typeof respond === 'function' ? await respond(request, calls.length) : respond[calls.length - 1];
      assert.ok(result, `unexpected request ${JSON.stringify(request)}`);
      return [{ frameId: 0, result: structuredClone(result) }];
    } },
  };
  return { adapter: createChatGPTAdapter(browser, { now: () => now }), calls, tabReads: () => tabReads };
}

test('new archives retain complete tree snapshots when the tree endpoint is available', async () => {
  const f = fixture([ok(tree())]);
  const result = await f.adapter.detail(1, options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].format, 'tree');
  assert.equal(f.calls[0].requireComplete, true);
  assert.deepEqual(result.payload.mapping, tree().mapping);
  assert.equal(result.messageSync.format, 'tree');
  assert.equal(result.messageSync.mode, 'full');
  assert.equal(result.messageSync.scope, 'returned-tree');
  assert.equal(result.completeness, 'complete');
});

test('new archives fall back from a missing or unsupported tree endpoint to complete message pages', async t => {
  for (const code of ['HTTP_404', 'FORMAT']) await t.test(code, async () => {
    const f = fixture([failure(code), ok(page(['m1', 'm2', 'm6']))]);
    const result = await f.adapter.detail(1, options);
    assert.deepEqual(f.calls.map(item => item.format), ['tree', 'page']);
    assert.equal(result.messageSync.format, 'flat');
    assert.equal(result.messageSync.mode, 'full');
    assert.equal(result.messageSync.scope, 'selected-branch');
    assert.equal(result.messageSync.fullReadAt, now);
    assert.deepEqual(result.payload.messages.map(item => item.id), ['m1', 'm2', 'm6']);
  });
});

test('an existing tree archive never falls back to a flat response that could discard its branches', async t => {
  for (const code of ['HTTP_404', 'FORMAT', 'INCOMPLETE_DETAIL']) await t.test(code, async () => {
    const saved = baseline(tree()), before = structuredClone(saved);
    const f = fixture([failure(code), ok(page(['m6']))]);
    await assert.rejects(f.adapter.detail(1, { ...options, baseline: saved }), { code });
    assert.deepEqual(f.calls.map(item => item.format), ['tree']);
    assert.deepEqual(saved, before);
  });
});

test('flat archives merge a verified consecutive tail and expose honest reuse metadata', async () => {
  const saved = baseline(), before = structuredClone(saved), progress = [];
  const latest = page(['m3', 'm4', 'm5', 'm6'], { previous: true });
  const f = fixture([ok(latest)]);
  const result = await f.adapter.detail(1, { ...options, baseline: saved, onProgress: value => progress.push(value) });
  assert.equal(result.baselineContentHash, saved.entry.contentHash);
  assert.deepEqual(f.calls.map(item => item.format), ['page']);
  assert.equal(f.calls[0].before ?? null, null);
  assert.deepEqual(result.payload.messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(result.payload.page_info.has_previous_page, false);
  assert.equal(result.payload.page_info.has_next_page, false);
  assert.equal(result.messageSync.mode, 'tail-merge');
  assert.equal(result.messageSync.fullReadAt, saved.entry.messageSync.fullReadAt);
  assert.equal(result.messageSync.checkedAt, now);
  assert.equal(result.messageSync.pagesRead, 1);
  assert.equal(result.messageSync.fetchedMessages, 4);
  assert.equal(result.messageSync.reusedMessages, 2);
  assert.equal(result.messageSync.addedMessages, 1);
  assert.equal(result.messageSync.updatedMessages, 0);
  assert.equal(result.messageSync.incrementalRuns, 1);
  assert.equal(result.completeness, 'complete');
  assert.ok(progress.length > 0);
  assert.deepEqual(saved, before, 'the adapter must not mutate the on-disk baseline object');
});

test('forceFull follows older-page cursors and rechecks the latest page instead of reusing a matching tail', async () => {
  const latest = page(['m3', 'm4', 'm5', 'm6'], { previous: true });
  const oldest = page(['m1', 'm2'], { next: true });
  const f = fixture([ok(latest), ok(oldest), ok(latest)]);
  const result = await f.adapter.detail(1, { ...options, baseline: baseline(), forceFull: true });
  assert.deepEqual(f.calls.map(item => [item.format, item.before ?? null]), [['page', null], ['page', 'm3'], ['page', null]]);
  assert.equal(f.tabReads(), f.calls.length * 2, 'every page must keep the before/after navigation checks');
  assert.equal(result.messageSync.mode, 'full');
  assert.equal(result.messageSync.fullReadAt, now);
  assert.equal(result.messageSync.reusedMessages, 0);
  assert.equal(result.messageSync.incrementalRuns, 0);
  assert.deepEqual(result.payload.messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
});

test('a short newest page continues until enough old-tail overlap is found, then stops before older history', async () => {
  const latest = page(['m5', 'm6'], { previous: true });
  const overlap = page(['m2', 'm3', 'm4'], { previous: true, next: true });
  const f = fixture([ok(latest), ok(overlap), ok(latest)]);
  const result = await f.adapter.detail(1, { ...options, baseline: baseline() });
  assert.deepEqual(f.calls.map(item => item.before ?? null), [null, 'm5', null]);
  assert.equal(result.messageSync.mode, 'tail-merge');
  assert.equal(result.messageSync.reusedMessages, 1);
  assert.equal(result.messageSync.addedMessages, 1);
  assert.deepEqual(result.payload.messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
});

test('an unsupported page response can fall back to a complete tree without returning a partial array', async t => {
  for (const code of ['HTTP_404', 'FORMAT', 'INCOMPLETE_DETAIL']) await t.test(code, async () => {
    const f = fixture([failure(code), ok(tree())]);
    const result = await f.adapter.detail(1, { ...options, baseline: baseline() });
    assert.deepEqual(f.calls.map(item => item.format), ['page', 'tree']);
    assert.ok(result.payload.mapping);
    assert.equal(result.messageSync.format, 'tree');
    assert.equal(result.completeness, 'complete');
  });
});

test('authorization, rate limits, network failures and account switches never trigger another endpoint', async t => {
  for (const code of ['HTTP_401', 'HTTP_403', 'HTTP_429', 'NETWORK', 'ACCOUNT_CHANGED']) await t.test(code, async () => {
    const f = fixture([failure(code), ok(tree())]);
    await assert.rejects(f.adapter.detail(1, { ...options, baseline: baseline() }), { code });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].format, 'page');
  });
});

test('changed account on an older page invalidates all collected pages and leaves the baseline untouched', async () => {
  const saved = baseline(), before = structuredClone(saved);
  const latest = page(['m5', 'm6'], { previous: true });
  const f = fixture([ok(latest), ok(page(['m1', 'm2', 'm3', 'm4'], { next: true }), 'page',
    { identity: { ...identity, accountKey: `acct-${'b'.repeat(24)}` } }), ok(tree())]);
  await assert.rejects(f.adapter.detail(1, { ...options, baseline: saved, forceFull: true }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(saved, before);
});

test('navigation away after an older page does not fall back or save a mixed conversation', async () => {
  const latest = page(['m5', 'm6'], { previous: true });
  const f = fixture([ok(latest), ok(page(['m1', 'm2', 'm3', 'm4'], { next: true })), ok(tree())],
    { tabAt: count => count === 4 ? { id: 1, url: 'https://example.invalid' } : null });
  await assert.rejects(f.adapter.detail(1, { ...options, baseline: baseline(), forceFull: true }), { code: 'TAB_CHANGED' });
  assert.equal(f.calls.length, 2);
});

test('progress callback failure cannot turn a successfully collected snapshot into a capture failure', async () => {
  const f = fixture([ok(page(['m3', 'm4', 'm5', 'm6'], { previous: true }))]);
  const result = await f.adapter.detail(1, { ...options, baseline: baseline(),
    onProgress: async () => { throw new Error('Synthetic UI failure'); } });
  assert.equal(result.completeness, 'complete');
  assert.equal(result.messageSync.mode, 'tail-merge');
});

test('pausing after the first message page stops before older history or fallback requests', async () => {
  let paused = false;
  const f = fixture(() => {
    paused = true;
    return ok(page(['m4', 'm5', 'm6'], { previous: true }));
  });
  await assert.rejects(f.adapter.detail(1, { ...options, baseline: baseline(), shouldPause: () => paused }), { code: 'COLLECTION_PAUSED' });
  assert.deepEqual(f.calls.map(item => item.format), ['page']);
});

test('complete tree reads honor pause boundaries before and after the browser request', async t => {
  await t.test('already paused', async () => {
    const f = fixture([ok(tree())]);
    await assert.rejects(f.adapter.detail(1, { ...options, shouldPause: () => true }), { code: 'COLLECTION_PAUSED' });
    assert.deepEqual(f.calls, []);
  });
  await t.test('paused while reading', async () => {
    let paused = false;
    const f = fixture(() => { paused = true; return ok(tree()); });
    await assert.rejects(f.adapter.detail(1, { ...options, shouldPause: () => paused }), { code: 'COLLECTION_PAUSED' });
    assert.deepEqual(f.calls.map(item => item.format), ['tree']);
  });
});
