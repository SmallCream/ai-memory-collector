/** Local, bounded observation of real operations. Never drives task scheduling. */
import { sanitizeDetailFailure } from './detail-errors.js';
const WORKER_ID = crypto.randomUUID();
const serial = new Map();
const HISTORY_LIMIT = 200, HISTORY_AGE = 7 * 86400000, HISTORY_BYTES = 1024 * 1024;
const statuses = new Set(['running', 'success', 'failed', 'interrupted']);
export function activityLabel(value) {
  return String(typeof value === 'string' ? value : '').replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]').replace(/Bearer\s+[^\s,;]+/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
}
function clean(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of ['stage', 'title', 'conversationId', 'fileName', 'assetId', 'taskId', 'operationId']) if (typeof value[key] === 'string') out[key] = activityLabel(value[key]);
  for (const key of ['size', 'completed', 'total', 'startedAt', 'updatedAt', 'finishedAt', 'occurrences', 'firstFailedAt', 'recoveredAt']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  if (statuses.has(value.status)) out.status = value.status;
  if (/^[A-Z][A-Z0-9_]{0,60}$/.test(value.code || '')) out.code = value.code;
  Object.assign(out, sanitizeDetailFailure(value));
  return out;
}
// Retention applies only to observations, never to durable work/retry records.
function retainedHistory(entries, now) {
  const valid = (Array.isArray(entries) ? entries : []).map(clean).filter(item => item &&
    (item.finishedAt ?? item.updatedAt ?? 0) >= now - HISTORY_AGE);
  // Routine successes must not immediately crowd an unresolved failure out.
  const unresolved = item => item.status === 'failed' && !item.recoveredAt;
  const selected = new Set([...valid.filter(unresolved), ...valid.filter(item => !unresolved(item))].slice(0, HISTORY_LIMIT));
  const records = valid.filter(item => selected.has(item));
  // Three bytes per UTF-16 unit is a conservative UTF-8 upper bound.
  while (records.length && JSON.stringify(records).length * 3 > HISTORY_BYTES) {
    const lastSuccess = records.findLastIndex(item => !unresolved(item));
    records.splice(lastSuccess < 0 ? records.length - 1 : lastSuccess, 1);
  }
  return records;
}
function sameOperation(a, b) {
  if (a.stage !== b.stage) return false;
  if (a.conversationId && b.conversationId) return a.conversationId === b.conversationId && (a.assetId || '') === (b.assetId || '') &&
    (a.assetId || a.fileName === b.fileName);
  if (a.stage === 'list') return Boolean(a.taskId) && a.taskId === b.taskId && a.completed === b.completed;
  return ['identify', 'commit'].includes(a.stage) && !a.conversationId && !b.conversationId;
}
export function createActivityLog({ getSetting, setSetting, now = Date.now, workerId = WORKER_ID }) {
  const keyFor = (accountKey, channel) => `activity:v1:${accountKey}:${channel}`;
  async function mutate(key, change) {
    const previous = serial.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const stored = await getSetting(key);
      await setSetting(key, change(stored && typeof stored === 'object' ? stored : {}));
    });
    serial.set(key, pending);
    try { await pending; return true; } catch { return false; /* Observation must not fail work. */ }
    finally { if (serial.get(key) === pending) serial.delete(key); }
  }
  async function read(accountKey, channel, { history = false } = {}) {
    let stored;
    try { stored = await getSetting(keyFor(accountKey, channel)); } catch { return { current: null, recent: [], updatedAt: null, unavailable: true }; }
    if (!stored) return { current: null, recent: [], updatedAt: null };
    let current = clean(stored.current);
    if (current?.status === 'running' && stored.workerId !== workerId) current.status = 'interrupted';
    if (current && current.status !== 'running' && (current.finishedAt ?? current.updatedAt ?? 0) < now() - HISTORY_AGE) current = null;
    return { current, recent: (Array.isArray(stored.recent) ? stored.recent : []).slice(0, 20).map(clean).filter(Boolean),
      updatedAt: Number.isFinite(stored.updatedAt) ? stored.updatedAt : null,
      ...(history ? { history: retainedHistory(stored.history || stored.recent, now()) } : {}) };
  }
  async function run(accountKey, channel, info, operation) {
    const operationId = crypto.randomUUID(), key = keyFor(accountKey, channel);
    const current = { ...clean(info), operationId, status: 'running', startedAt: now(), updatedAt: now() };
    await mutate(key, old => ({ ...old, workerId, operationId, current, updatedAt: current.updatedAt,
      history: retainedHistory([...(old.current?.status === 'running' && old.workerId !== workerId
        ? [{ ...old.current, status: 'interrupted', updatedAt: now() }] : []), ...retainedHistory(old.history || old.recent, now())], now()),
      recent: (Array.isArray(old.recent) ? old.recent : []).slice(0, 20).map(clean).filter(Boolean) }));
    let result, failure, failed = false;
    try { result = await operation(); }
    catch (error) { failed = true; failure = error; }
    const finished = { ...current, status: failed ? 'failed' : 'success', finishedAt: now(), updatedAt: now(),
      ...(failed ? { code: /^[A-Z][A-Z0-9_]{0,60}$/.test(failure?.code || '') ? failure.code : 'OPERATION_FAILED',
        ...sanitizeDetailFailure(failure) } : {}) };
    await mutate(key, old => {
      let history = retainedHistory(old.history || old.recent, now());
      if (failed) {
        const previous = history.find(item => item.status === 'failed' && !item.recoveredAt && sameOperation(item, finished) &&
          item.code === finished.code && item.reason === finished.reason);
        finished.occurrences = Math.min(1000000, (previous?.occurrences || (previous ? 1 : 0)) + 1);
        finished.firstFailedAt = previous?.firstFailedAt ?? previous?.startedAt ?? finished.startedAt;
        if (previous) history = history.filter(item => item !== previous);
      } else {
        const recovered = [];
        history = history.filter(item => {
          if (item.status === 'failed' && !item.recoveredAt && sameOperation(item, finished)) {
            recovered.push({ ...item, recoveredAt: finished.finishedAt }); return false;
          }
          return true;
        });
        history.unshift(...recovered);
      }
      return { ...old,
        ...(old.operationId === operationId ? { current: finished, updatedAt: finished.updatedAt } : {}),
        history: retainedHistory([finished, ...history], now()),
        recent: [finished, ...(Array.isArray(old.recent) ? old.recent : []).map(clean).filter(Boolean)].slice(0, 20) };
    });
    if (failed) throw failure;
    return result;
  }
  async function clear(accountKey, channel) {
    const saved = await mutate(keyFor(accountKey, channel), old => ({ ...old, recent: [], history: [],
      current: old.current?.status === 'running' && old.workerId === workerId ? old.current : null }));
    if (!saved) throw Object.assign(new Error('日志未能清除，请稍后重试；采集数据不受影响。'), { code: 'DIAGNOSTICS_STORAGE' });
  }
  return { run, read, clear };
}
