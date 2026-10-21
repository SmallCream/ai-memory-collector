import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMessagePages, needsMessageFullCheck } from '../extension/lib/message-sync.js';
import { sanitizeNativeConversation } from '../extension/lib/archive.js';

const NOW = 1792569600000, DAY = 86400000;
const row = (id, text = id) => ({ id, status: 'finished_successfully', content: { parts: [text] } });
function page(ids, { previous = false, next = false, ...extra } = {}) {
  const messages = ids.map(value => typeof value === 'string' ? row(value) : value);
  return { conversation_id: 'demo', title: 'Example', current_node: 'e', update_time: NOW / 1000,
    messages, page_info: { has_previous_page: previous, has_next_page: next,
      start_cursor: messages[0]?.id ?? null, end_cursor: messages.at(-1)?.id ?? null }, ...extra };
}
function baseline() {
  return { payload: page(['a', 'b', 'c', 'd']), entry: { sourceCompleteness: 'complete',
    messageSync: { schemaVersion: 1, format: 'flat', mode: 'full', scope: 'selected-branch',
      fullReadAt: NOW - 1000, checkedAt: NOW - 1000, incrementalRuns: 0 } } };
}
function run(sequence, options = {}) {
  const calls = [];
  const result = collectMessagePages({ conversationId: 'demo', now: NOW, ...options,
    readPage: async cursor => {
      calls.push(cursor);
      const value = sequence.shift();
      assert.ok(value, 'unexpected page request');
      if (value instanceof Error) throw value;
      return structuredClone(value);
    } });
  return { result, calls };
}

test('a verified three-message suffix reuses only the earlier prefix and preserves its audit time', async () => {
  const local = baseline(), before = JSON.stringify(local);
  const f = run([page(['b', 'c', 'd', 'e'], { previous: true })], { baseline: local });
  const result = await f.result;
  assert.deepEqual(f.calls, [null]);
  assert.deepEqual(result.payload.messages.map(item => item.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(result.messageSync.mode, 'tail-merge');
  assert.equal(result.messageSync.reusedMessages, 1);
  assert.equal(result.messageSync.addedMessages, 1);
  assert.equal(result.messageSync.updatedMessages, 0);
  assert.equal(result.messageSync.fullReadAt, NOW - 1000);
  assert.equal(result.messageSync.incrementalRuns, 1);
  assert.equal(result.payload.page_info.start_cursor, 'a');
  assert.equal(result.payload.page_info.has_previous_page, false);
  assert.equal(JSON.stringify(local), before);
});

test('same timestamp or a single known ID is never a sufficient overlap anchor', async () => {
  const head = page(['d', 'e'], { previous: true });
  const f = run([head, page(['a', 'b', 'c'], { next: true }), head], { baseline: baseline() });
  const result = await f.result;
  assert.deepEqual(f.calls, [null, 'd', null]);
  assert.equal(result.messageSync.mode, 'full');
  assert.equal(result.messageSync.pagesRead, 3);
  assert.equal(result.messageSync.fetchedMessages, 7);
  assert.equal(result.messageSync.fullReadAt, NOW);
});

test('an unchanged tail with no added IDs scans older history and detects edits there', async () => {
  const head = page(['b', 'c', 'd'], { previous: true });
  const f = run([head, page([row('a', 'Edited earlier message')], { next: true }), head], { baseline: baseline() });
  const result = await f.result;
  assert.equal(result.messageSync.mode, 'full');
  assert.equal(result.messageSync.updatedMessages, 1);
  assert.equal(result.messageSync.addedMessages, 0);
});

test('an edited overlap message falls back to reading the whole current branch', async () => {
  const head = page(['b', row('c', 'changed'), 'd', 'e'], { previous: true });
  const f = run([head, page(['a'], { next: true }), head], { baseline: baseline() });
  const result = await f.result;
  assert.equal(result.messageSync.mode, 'full');
  assert.equal(result.messageSync.updatedMessages, 1);
  assert.equal(result.payload.messages.find(item => item.id === 'c').content.parts[0], 'changed');
});

test('a newly selected branch is read to its beginning instead of retaining the old tail', async () => {
  const head = page(['b', 'c', 'new-d', 'e'], { previous: true });
  const f = run([head, page(['a'], { next: true }), head], { baseline: baseline() });
  const result = await f.result;
  assert.equal(result.messageSync.mode, 'full');
  assert.deepEqual(result.payload.messages.map(item => item.id), ['a', 'b', 'c', 'new-d', 'e']);
});

test('matching local beginning cannot hide the server claim that still older messages exist', async () => {
  const head = page(['a', 'b', 'c', 'd', 'e'], { previous: true });
  const f = run([head, page(['older'], { next: true }), head], { baseline: baseline() });
  assert.equal((await f.result).messageSync.mode, 'full');
  assert.deepEqual(f.calls, [null, 'a', null]);
});

test('full capture de-duplicates a contiguous identical page boundary without sorting timestamps', async () => {
  const head = page([row('c'), row('d')], { previous: true });
  head.messages[0].create_time = 900;
  head.messages[1].create_time = 100;
  const old = page(['a', 'b', head.messages[0]], { next: true });
  const result = await run([head, old, head], { forceFull: true }).result;
  assert.deepEqual(result.payload.messages.map(item => item.id), ['a', 'b', 'c', 'd']);
});

test('pagination rejects conflicting, noncontiguous and nonprogressing overlaps', async t => {
  const head = page(['c', 'd'], { previous: true });
  for (const older of [page(['a', row('c', 'conflict')], { next: true }),
    page(['a', 'd'], { next: true }), page(['c', 'd'], { previous: true, next: true })]) {
    await t.test(older.messages.map(item => item.id).join(','), async () => {
      await assert.rejects(run([head, older]).result, error => ['DETAIL_CHANGED', 'DETAIL_PAGINATION'].includes(error.code));
    });
  }
});

test('a changed version, branch tip or latest page aborts the assembled snapshot', async t => {
  const head = page(['c', 'd'], { previous: true });
  for (const older of [page(['a', 'b'], { next: true, update_time: NOW / 1000 + 1 }),
    page(['a', 'b'], { next: true, current_node: 'other' })]) {
    await t.test(JSON.stringify(older.current_node) + older.update_time, async () => {
      await assert.rejects(run([head, older]).result, { code: 'DETAIL_CHANGED' });
    });
  }
  const changedHead = page(['c', row('d', 'changed while reading')], { previous: true });
  await assert.rejects(run([head, page(['a', 'b'], { next: true }), changedHead]).result, { code: 'DETAIL_CHANGED' });
});

test('unknown pagination, cursor mismatch, duplicate IDs and unfinished messages cannot become complete', async t => {
  const invalid = [page(['a', 'a']), page(['a']), page(['a']), page([row('a')]), page(['a'])];
  invalid[1].page_info.start_cursor = 'wrong';
  delete invalid[2].page_info.has_next_page;
  invalid[3].messages[0].status = 'in_progress';
  invalid[4].page_info.has_next_page = true;
  for (let index = 0; index < invalid.length; index++) await t.test(String(index), async () => {
    await assert.rejects(run([invalid[index]]).result, error => ['FORMAT', 'DETAIL_PAGINATION', 'INCOMPLETE_DETAIL'].includes(error.code));
  });
});

test('old or unverified baselines and forced audits perform a complete page walk', async t => {
  const head = page(['b', 'c', 'd', 'e'], { previous: true });
  for (const change of [local => { delete local.entry.messageSync; },
    local => { local.entry.sourceCompleteness = 'unknown'; },
    local => { local.entry.messageSync.fullReadAt = NOW - 7 * DAY; },
    local => { local.entry.messageSync.fullReadAt = NOW + 1; },
    local => { local.entry.messageSync.incrementalRuns = 20; },
    local => { local.payload.page_info.has_previous_page = true; }]) {
    const local = baseline(); change(local);
    await t.test(JSON.stringify(local.entry), async () => {
      assert.equal((await run([head, page(['a'], { next: true }), head], { baseline: local }).result).messageSync.mode, 'full');
    });
  }
});

test('fingerprints reuse the archive sanitizer but preserve actual message and attachment changes', async () => {
  const local = baseline();
  local.payload.messages[1].metadata = { attachment: { file_id: 'file-1', url: 'https://example.test/image?id=file-1&sig=old' } };
  local.payload = sanitizeNativeConversation(local.payload);
  const fresh = structuredClone(local.payload.messages.slice(1));
  fresh[0].metadata.attachment.url = 'https://example.test/image?id=file-1&sig=fresh';
  const head = page([...fresh, row('e')], { previous: true });
  assert.equal((await run([head], { baseline: local }).result).messageSync.mode, 'tail-merge');
  fresh[0].metadata.attachment.file_id = 'file-2';
  const changed = page([...fresh, row('e')], { previous: true });
  assert.equal((await run([changed, page(['a'], { next: true }), changed], { baseline: local }).result).messageSync.mode, 'full');
});

test('audit scheduling applies only to reused flat history and never refreshes through checkedAt', () => {
  const entry = baseline().entry;
  assert.equal(needsMessageFullCheck(entry, NOW), false);
  entry.messageSync.mode = 'tail-merge';
  entry.messageSync.fullReadAt = NOW - 7 * DAY;
  entry.messageSync.checkedAt = NOW;
  assert.equal(needsMessageFullCheck(entry, NOW), true);
  entry.messageSync.fullReadAt = NOW;
  entry.messageSync.incrementalRuns = 20;
  assert.equal(needsMessageFullCheck(entry, NOW), true);
  entry.messageSync.format = 'tree';
  assert.equal(needsMessageFullCheck(entry, NOW), false);
});

test('a paginated or tail-merge head needs a usable version and branch tip before any history join', async t => {
  for (const change of [head => { delete head.update_time; }, head => { head.update_time = 'unknown'; },
    head => { delete head.current_node; }, head => { head.current_node = ''; },
    head => { head.current_node = '../unsafe'; }]) {
    const head = page(['b', 'c', 'd', 'e'], { previous: true }); change(head);
    await t.test(JSON.stringify({ updated: head.update_time, current: head.current_node }), async () => {
      for (const local of [null, baseline()]) {
        const f = run([head], { baseline: local });
        await assert.rejects(f.result, { code: 'INCOMPLETE_DETAIL' });
        assert.deepEqual(f.calls, [null]);
      }
    });
  }
});

test('a single explicitly complete page can retain unknown source version without joining history', async () => {
  const head = page(['a', 'b', 'c']);
  delete head.update_time; delete head.current_node;
  const f = run([head], { baseline: baseline() });
  const result = await f.result;
  assert.deepEqual(f.calls, [null]);
  assert.equal(result.messageSync.mode, 'full');
  assert.equal(result.messageSync.reusedMessages, 0);
  assert.deepEqual(result.payload.messages, head.messages);
});

test('page count limit terminates an otherwise endless sequence without publishing a snapshot', async () => {
  let reads = 0;
  await assert.rejects(collectMessagePages({ conversationId: 'demo', now: NOW,
    readPage: async before => page([`m${++reads}`], { previous: true, next: Boolean(before) }) }), { code: 'SIZE' });
  assert.equal(reads, 500);
});
