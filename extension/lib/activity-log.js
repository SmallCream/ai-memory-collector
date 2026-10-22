/** Local, bounded observation of real operations. Never drives task scheduling. */
import { sanitizeDetailFailure } from './detail-errors.js';
const WORKER_ID = crypto.randomUUID();
const serial = new Map();
const statuses = new Set(['running', 'success', 'failed', 'interrupted']);
export function activityLabel(value) {
  return String(typeof value === 'string' ? value : '').replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]').replace(/Bearer\s+[^\s,;]+/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
}
function clean(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of ['stage', 'title', 'conversationId', 'fileName']) if (typeof value[key] === 'string') out[key] = activityLabel(value[key]);
  for (const key of ['size', 'completed', 'total', 'startedAt', 'updatedAt', 'finishedAt']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  if (statuses.has(value.status)) out.status = value.status;
  if (/^[A-Z][A-Z0-9_]{0,60}$/.test(value.code || '')) out.code = value.code;
  Object.assign(out, sanitizeDetailFailure(value));
  return out;
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
    try { await pending; } catch { /* Observation must not fail a capture or transfer. */ }
    finally { if (serial.get(key) === pending) serial.delete(key); }
  }
  async function read(accountKey, channel) {
    let stored;
    try { stored = await getSetting(keyFor(accountKey, channel)); } catch { return { current: null, recent: [], updatedAt: null }; }
    if (!stored) return { current: null, recent: [], updatedAt: null };
    const current = clean(stored.current);
    if (current?.status === 'running' && stored.workerId !== workerId) current.status = 'interrupted';
    return { current, recent: (Array.isArray(stored.recent) ? stored.recent : []).slice(0, 20).map(clean).filter(Boolean),
      updatedAt: Number.isFinite(stored.updatedAt) ? stored.updatedAt : null };
  }
  async function run(accountKey, channel, info, operation) {
    const operationId = crypto.randomUUID(), key = keyFor(accountKey, channel);
    const current = { ...clean(info), status: 'running', startedAt: now(), updatedAt: now() };
    await mutate(key, old => ({ workerId, operationId, current, updatedAt: current.updatedAt,
      recent: (Array.isArray(old.recent) ? old.recent : []).slice(0, 20).map(clean).filter(Boolean) }));
    let result, failure, failed = false;
    try { result = await operation(); }
    catch (error) { failed = true; failure = error; }
    const finished = { ...current, status: failed ? 'failed' : 'success', finishedAt: now(), updatedAt: now(),
      ...(failed ? { code: /^[A-Z][A-Z0-9_]{0,60}$/.test(failure?.code || '') ? failure.code : 'OPERATION_FAILED',
        ...sanitizeDetailFailure(failure) } : {}) };
    await mutate(key, old => ({ ...old,
      ...(old.operationId === operationId ? { current: finished, updatedAt: finished.updatedAt } : {}),
      recent: [finished, ...(Array.isArray(old.recent) ? old.recent : []).map(clean).filter(Boolean)].slice(0, 20) }));
    if (failed) throw failure;
    return result;
  }
  return { run, read };
}
