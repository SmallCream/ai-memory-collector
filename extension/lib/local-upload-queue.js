/** Rebuild optional cloud work from verified local files, without source requests. */
import { accountPrefix } from './archive-store.js';

const key = account => `localUploadScan:${account.accountKey}`;
const targetOf = github => `${String(github.repository || '').toLowerCase()}\n${github.branch || ''}`;
const permanent = new Set(['ARCHIVE_MISSING', 'LOCAL_CONFLICT', 'ARCHIVE_FORMAT', 'ARCHIVE_SIZE',
  'PARTIAL_DETAIL', 'ACCOUNT_MISMATCH', 'ACCOUNT_INVALID', 'ARCHIVE_PATH', 'ACCOUNT_OWNERSHIP']);
const safeCode = error => /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code :
  error?.name === 'NotAllowedError' ? 'DIRECTORY_PERMISSION' : 'LOCAL_VERIFY';
const fail = code => Object.assign(new Error('本地备份队列无法继续，请检查保存目录和归档记录。'), { code });
async function sameDirectory(left, right) {
  if (left === right) return true;
  try { return Boolean(await left?.isSameEntry(right)); } catch { return false; }
}
export function createLocalUploadQueue({ getSetting, setSetting, readAccountManifest,
  readConversationArchive, enqueueArchive, now = Date.now }) {
  const locks = new Map();
  function locked(account, action) {
    accountPrefix(account);
    const previous = locks.get(account.accountKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(account.accountKey, next);
    void next.finally(() => { if (locks.get(account.accountKey) === next) locks.delete(account.accountKey); }).catch(() => {});
    return next;
  }
  async function load(account) {
    const job = await getSetting(key(account));
    if (!job) return null;
    if (job.schemaVersion !== 1 || job.accountKey !== account.accountKey || job.storageKey !== account.storageKey ||
        !Array.isArray(job.ids) || job.ids.length > 100_000 ||
        job.ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) ||
        new Set(job.ids).size !== job.ids.length || !Number.isSafeInteger(job.cursor) || job.cursor < 0 ||
        job.cursor > job.ids.length || job.total !== job.ids.length || !Array.isArray(job.failures) ||
        !Number.isSafeInteger(job.staged) || job.staged < 0 || job.staged > job.cursor ||
        !Number.isSafeInteger(job.failed) || job.failed < 0 || job.failed > job.cursor) throw fail('ARCHIVE_FORMAT');
    return job;
  }
  async function start({ directory, account, github }) {
    return locked(account, async () => {
      const manifest = await readAccountManifest(directory, account);
      const ids = Object.keys(manifest?.conversations || {}).sort();
      if (ids.length > 100_000 || ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id))) throw fail('ARCHIVE_FORMAT');
      const job = { schemaVersion: 1, accountKey: account.accountKey, storageKey: account.storageKey,
        target: targetOf(github), directory, ids, cursor: 0, total: ids.length,
        staged: 0, failed: 0, failures: [], status: ids.length ? 'running' : 'completed',
        nextRetryAt: 0, attempts: 0, lastError: null, startedAt: now() };
      await setSetting(key(account), job);
      return summary(job);
    });
  }
  function summary(job) {
    if (!job) return null;
    return { status: job.status, total: job.total, checked: job.cursor, staged: job.staged,
      failed: job.failed, issues: job.failures.slice(0, 50), startedAt: job.startedAt,
      nextRetryAt: job.nextRetryAt || 0, lastError: job.lastError || null };
  }
  async function state(account) { return locked(account, async () => summary(await load(account))); }
  async function tick({ directory, account, github, limit = 2 }) {
    return locked(account, async () => {
      const job = await load(account);
      if (!job || !['running', 'waiting'].includes(job.status)) return summary(job);
      const targetChanged = job.target !== targetOf(github);
      if (targetChanged || !await sameDirectory(directory, job.directory)) {
        job.status = 'blocked'; job.lastError = { code: targetChanged ? 'GITHUB_TARGET_CHANGED' : 'DIRECTORY_CHANGED' };
        await setSetting(key(account), job); return summary(job);
      }
      if (job.status === 'waiting' && job.nextRetryAt > now()) return summary(job);
      job.status = 'running'; job.lastError = null; job.nextRetryAt = 0;
      const batch = Number.isFinite(limit) ? Math.min(5, Math.max(1, Math.floor(limit))) : 2;
      for (let count = 0; count < batch && job.cursor < job.ids.length; count++) {
        const conversationId = job.ids[job.cursor];
        try {
          const archive = await readConversationArchive(directory, account, conversationId);
          if (archive?.entry?.conversationId !== conversationId || !Array.isArray(archive.files) || !archive.files.length) throw fail('ARCHIVE_FORMAT');
          if (archive.entry.sourceCompleteness === 'partial' || archive.entry.coverage?.messages === 'partial' || archive.entry.coverage?.branches === 'partial') throw fail('PARTIAL_DETAIL');
          await enqueueArchive({ account, archive, forceUpload: true });
          job.staged++;
        } catch (error) {
          const code = safeCode(error);
          if (!permanent.has(code)) {
            // Do not advance a durable cursor past a write that never committed.
            // A crash after enqueue but before cursor storage may enqueue twice;
            // the engine coalesces by conversation ID, so replay is lossless.
            job.status = 'waiting'; job.attempts++;
            job.nextRetryAt = now() + Math.min(15, 2 ** Math.min(job.attempts - 1, 4)) * 60_000;
            job.lastError = { conversationId, code };
            await setSetting(key(account), job); return summary(job);
          }
          job.failed++;
          if (job.failures.length < 200) job.failures.push({ conversationId, code });
        }
        job.cursor++; job.attempts = 0;
        if (job.cursor >= job.ids.length) job.status = job.failed ? 'partial' : 'completed';
        await setSetting(key(account), job);
      }
      return summary(job);
    });
  }
  return { start, tick, state };
}
