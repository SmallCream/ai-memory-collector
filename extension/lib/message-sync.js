/** Cursor pagination and conservative append-only reuse of a verified flat archive. */
import { sanitizeNativeConversation } from './archive.js';

const MAX_PAGES = 500;
const MAX_MESSAGES = 100_000;
const MAX_BYTES = 24 * 1024 * 1024;
const FULL_INTERVAL = 7 * 24 * 60 * 60_000;
const MAX_INCREMENTAL_RUNS = 20;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const idOf = item => (record(item?.message) ? item.message.id : item?.id) ?? item?.id;
const nativeMessage = item => own(item, 'message') ? item.message : item;
const hasTree = payload => record(payload?.mapping) && Object.keys(payload.mapping).length > 0;

function fail(code = 'DETAIL_PAGINATION', reason) {
  throw Object.assign(new Error(code === 'DETAIL_CHANGED'
    ? '读取期间对话版本发生变化，原归档保持不变，请稍后重试。'
    : code === 'SIZE' ? '对话分页超过本次处理上限，原归档保持不变。'
      : '消息分页或历史衔接无法确认，原归档保持不变。'), { code, ...(reason ? { reason } : {}) });
}

function canonical(value) {
  try { return JSON.stringify(sanitizeNativeConversation(value)); }
  catch { fail('FORMAT'); }
}

function millis(value) {
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 253402300799999 ? Math.trunc(parsed) : null;
    }
    value = Number(value);
  }
  if (!Number.isFinite(value)) return null;
  const time = value < 1e12 ? value * 1000 : value;
  return time >= 0 && time <= 253402300799999 ? Math.trunc(time) : null;
}

function version(payload) {
  return canonical({ id: payload.conversation_id ?? payload.id,
    currentNode: payload.current_node ?? null, updatedAt: millis(payload.update_time),
    title: payload.title ?? null });
}

function rowsIssue(rows) {
  if (!Array.isArray(rows)) return 'MESSAGE_SHAPE';
  if (rows.length > MAX_MESSAGES) return 'PAGE_MESSAGE_LIMIT';
  const ids = new Set();
  for (const row of rows) {
    const message = record(row) ? nativeMessage(row) : null;
    const id = idOf(row);
    if (!record(message)) return 'MESSAGE_SHAPE';
    if (!validId(id) || ids.has(id)) return 'MESSAGE_ID';
    if (['in_progress', 'streaming', 'pending'].includes(message.status)) return 'MESSAGE_IN_PROGRESS';
    ids.add(id);
  }
  return null;
}

function validRows(rows) { return rowsIssue(rows) === null; }

function validatePage(payload, conversationId, before) {
  if (!record(payload) || (payload.conversation_id ?? payload.id) !== conversationId || hasTree(payload)) fail('FORMAT');
  const issue = rowsIssue(payload.messages);
  if (issue) fail('FORMAT', issue);
  if (payload.messages.length > 2000) fail('FORMAT', 'PAGE_MESSAGE_LIMIT');
  if (['is_incomplete', 'has_more', 'has_more_messages', 'has_next_page', 'has_previous_page'].some(key => payload[key] === true)) fail('INCOMPLETE_DETAIL', 'SOURCE_PARTIAL');
  const page = payload.page_info;
  if (!record(page) || typeof page.has_previous_page !== 'boolean' || typeof page.has_next_page !== 'boolean' || page.has_more === true) fail('INCOMPLETE_DETAIL', 'PAGE_FLAGS');
  if (!before && page.has_next_page) fail('INCOMPLETE_DETAIL', 'PAGE_DIRECTION');
  if (!payload.messages.length) {
    if (before || page.has_previous_page || page.has_next_page) fail('DETAIL_PAGINATION', 'PAGE_CURSOR_STALLED');
  } else if (!validId(page.start_cursor) || !validId(page.end_cursor) ||
      page.start_cursor !== idOf(payload.messages[0]) || page.end_cursor !== idOf(payload.messages.at(-1))) fail('DETAIL_PAGINATION', 'PAGE_CURSOR_MISMATCH');
}

function flatRows(payload) {
  if (hasTree(payload)) return Object.values(payload.mapping).filter(row => record(row?.message));
  return Array.isArray(payload?.messages) ? payload.messages : [];
}

function deltaCounts(payload, baseline) {
  const prior = new Map(flatRows(baseline?.payload).map(row => [idOf(row), canonical(row)]));
  let addedMessages = 0, updatedMessages = 0;
  for (const row of flatRows(payload)) {
    const id = idOf(row);
    if (!prior.has(id)) addedMessages++;
    else if (prior.get(id) !== canonical(row)) updatedMessages++;
  }
  return { addedMessages, updatedMessages };
}

/** Only reused historical prefixes need an audit even when list metadata is unchanged. */
export function needsMessageFullCheck(entry, now = Date.now()) {
  const sync = entry?.messageSync;
  if (sync?.schemaVersion !== 1 || sync.format !== 'flat' || sync.mode !== 'tail-merge') return false;
  return !Number.isFinite(sync.fullReadAt) || sync.fullReadAt < 0 || sync.fullReadAt > now ||
    now - sync.fullReadAt >= FULL_INTERVAL || !Number.isSafeInteger(sync.incrementalRuns) ||
    sync.incrementalRuns < 0 || sync.incrementalRuns >= MAX_INCREMENTAL_RUNS;
}

export function fullMessageSync(payload, baseline, now = Date.now(), counts = {}) {
  return { schemaVersion: 1, format: hasTree(payload) ? 'tree' : 'flat', mode: 'full',
    scope: hasTree(payload) ? 'returned-tree' : 'selected-branch',
    fullReadAt: now, checkedAt: now, incrementalRuns: 0, pagesRead: 1,
    fetchedMessages: flatRows(payload).length, reusedMessages: 0,
    ...counts, ...deltaCounts(payload, baseline) };
}

function usableBaseline(baseline, now, forceFull, conversationId) {
  if (forceFull || !baseline || baseline.entry?.sourceCompleteness !== 'complete' || hasTree(baseline.payload) ||
      (baseline.payload?.conversation_id ?? baseline.payload?.id) !== conversationId ||
      !validRows(baseline.payload?.messages) || baseline.payload.messages.length < 3 ||
      baseline.payload.page_info?.has_previous_page !== false || baseline.payload.page_info?.has_next_page !== false) return false;
  const sync = baseline.entry.messageSync;
  return sync?.schemaVersion === 1 && sync.format === 'flat' && ['full', 'tail-merge'].includes(sync.mode) &&
    sync.scope === 'selected-branch' && Number.isFinite(sync.fullReadAt) && sync.fullReadAt >= 0 &&
    sync.fullReadAt <= now && now - sync.fullReadAt < FULL_INTERVAL &&
    Number.isSafeInteger(sync.incrementalRuns) && sync.incrementalRuns >= 0 && sync.incrementalRuns < MAX_INCREMENTAL_RUNS;
}

function tailMerge(rows, baselineRows) {
  const indices = new Map(baselineRows.map((row, index) => [idOf(row), index]));
  const start = indices.get(idOf(rows[0]));
  if (start === undefined || start === 0) return null;
  const overlap = baselineRows.length - start;
  // An unchanged old tail without a new message may hide an edit farther back.
  if (overlap < 3 || rows.length <= overlap) return null;
  for (let index = 0; index < overlap; index++) {
    if (idOf(rows[index]) !== idOf(baselineRows[start + index]) || canonical(rows[index]) !== canonical(baselineRows[start + index])) return null;
  }
  if (rows.slice(overlap).some(row => indices.has(idOf(row)))) return null;
  return { rows: [...baselineRows.slice(0, start), ...rows], reusedMessages: start };
}

function prependPage(older, newer) {
  const positions = new Map(newer.map((row, index) => [idOf(row), index]));
  const overlapStart = older.findIndex(row => positions.has(idOf(row)));
  if (overlapStart === -1) return [...older, ...newer];
  const overlap = older.length - overlapStart;
  if (overlapStart === 0) fail('DETAIL_PAGINATION', 'PAGE_CURSOR_STALLED');
  if (overlap > newer.length) fail('DETAIL_PAGINATION', 'PAGE_OVERLAP_CONFLICT');
  for (let index = 0; index < overlap; index++) {
    if (idOf(older[overlapStart + index]) !== idOf(newer[index]) || canonical(older[overlapStart + index]) !== canonical(newer[index])) fail('DETAIL_CHANGED', 'PAGE_OVERLAP_CONFLICT');
  }
  return [...older.slice(0, overlapStart), ...newer];
}

/** readPage receives a message cursor, never an arbitrary URL. */
export async function collectMessagePages({ readPage, conversationId, baseline = null, forceFull = false,
  now = Date.now(), onProgress = () => {} }) {
  let pagesRead = 0, fetchedMessages = 0, downloadedBytes = 0;
  const progress = async (mode = 'full', reusedMessages = 0) => {
    try { await onProgress({ pagesRead, fetchedMessages, reusedMessages, mode }); } catch { /* Observability cannot change capture results. */ }
  };
  const read = async before => {
    if (pagesRead >= MAX_PAGES) fail('SIZE');
    const payload = await readPage(before);
    pagesRead++;
    validatePage(payload, conversationId, before);
    fetchedMessages += payload.messages.length;
    downloadedBytes += new TextEncoder().encode(JSON.stringify(payload)).length;
    if (downloadedBytes > MAX_BYTES || fetchedMessages > MAX_MESSAGES * 2) fail('SIZE');
    await progress();
    return payload;
  };
  const head = await read(null), snapshotVersion = version(head), firstFingerprint = canonical(head);
  // Joining server pages or reusing a local prefix needs a comparable source
  // version and branch tip. A single complete response has no join boundary.
  if (head.page_info.has_previous_page && (millis(head.update_time) === null || !validId(head.current_node))) fail('INCOMPLETE_DETAIL', 'PAGE_VERSION_MISSING');
  let page = head, rows = head.messages, merged = null;
  const cursors = new Set();
  const allowTail = usableBaseline(baseline, now, forceFull, conversationId);
  while (page.page_info.has_previous_page) {
    if (allowTail) {
      merged = tailMerge(rows, baseline.payload.messages);
      if (merged) break;
    }
    const cursor = page.page_info.start_cursor;
    if (cursors.has(cursor)) fail('DETAIL_PAGINATION', 'PAGE_CURSOR_STALLED');
    cursors.add(cursor);
    const older = await read(cursor);
    if (version(older) !== snapshotVersion) fail('DETAIL_CHANGED', 'PAGE_VERSION_CHANGED');
    rows = prependPage(older.messages, rows);
    if (rows.length > MAX_MESSAGES) fail('SIZE');
    page = older;
  }
  // A second request after walking backward detects a moving head/version.
  if (pagesRead > 1) {
    const check = await read(null);
    if (canonical(check) !== firstFingerprint) fail('DETAIL_CHANGED', 'PAGE_VERSION_CHANGED');
  }
  if (merged) rows = merged.rows;
  const payload = { ...head, messages: rows, page_info: { ...head.page_info,
    start_cursor: rows.length ? idOf(rows[0]) : null, end_cursor: rows.length ? idOf(rows.at(-1)) : null,
    has_previous_page: false, has_next_page: false } };
  if (rows.length > MAX_MESSAGES || new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BYTES) fail('SIZE');
  const messageSync = fullMessageSync(payload, baseline, now, { pagesRead, fetchedMessages });
  if (merged) Object.assign(messageSync, { mode: 'tail-merge', fullReadAt: baseline.entry.messageSync.fullReadAt,
    incrementalRuns: baseline.entry.messageSync.incrementalRuns + 1, reusedMessages: merged.reusedMessages });
  await progress(messageSync.mode, messageSync.reusedMessages);
  return { payload, messageSync };
}
