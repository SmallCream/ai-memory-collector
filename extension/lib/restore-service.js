/** Durable, commit-pinned archive restoration. It never creates capture bindings. */
import { accountPrefix, readAccountManifest } from './archive-store.js';
import { readLocalBytes, hashBytes } from './asset-store.js';
import { createActivityLog } from './activity-log.js';

export const RESTORE_SETTING_KEY = 'repositoryRestore:v1';
const MAX_ITEMS = 100_000;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeSegment = (value, max = 120) => typeof value === 'string' && value.length <= max &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const MESSAGES = {
  DIRECTORY_REQUIRED: '请先选择本地保存目录。',
  DIRECTORY_PERMISSION: '本地保存目录需要重新授权。',
  DIRECTORY_CHANGED: '恢复任务属于另一个保存目录，请恢复原目录或重新开始恢复。',
  RESTORE_CONFIG_CHANGED: '恢复任务的仓库或分支已改变，请重新开始恢复。',
  RESTORE_METADATA: '远端账号或归档清单无法安全验证，此账号未恢复。',
  RESTORE_PATH: '远端归档路径无效或对应文件缺失，此对话未恢复。',
  RESTORE_LIMIT: '恢复项目或文件大小超过当前上限。',
  LOCAL_CONFLICT: '本地文件已被修改，保留本地内容并跳过此对话。',
  STALE_DETAIL: '本地原文较新，保留本地内容。',
  RESTORE_VERSION_UNCERTAIN: '原文存在差异且无法可靠判定先后，保留本地内容。',
  RESTORE_RECOVERY_PENDING: '已恢复先前的本地采集记录，等待加入同步队列；进度已保留。',
  ASSET_RESTORE_FAILED: '部分附件尚未恢复，稍后重试。',
  RESTORE_FAILED: '恢复未完成，已保留进度，稍后重试。',
  STORAGE: '恢复进度保存失败，请检查浏览器存储后重试。',
};
function fail(code) { const error = new Error(MESSAGES[code] || MESSAGES.RESTORE_FAILED); error.code = code; return error; }
function safeError(error) {
  const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code : 'RESTORE_FAILED';
  return { code, message: MESSAGES[code] || MESSAGES.RESTORE_FAILED };
}
function validPath(path) {
  return typeof path === 'string' && path.length <= 1024 && !path.split('/').some(part => !part || part === '.' || part === '..' ||
    /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function parse(text) { try { return JSON.parse(text); } catch { throw fail('RESTORE_METADATA'); } }
function stamp(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
async function sameDirectory(left, right) {
  if (left === right) return true;
  if (typeof left?.isSameEntry === 'function') { try { return await left.isSameEntry(right); } catch { return false; } }
  return false;
}
async function permission(directory) {
  if (directory?.kind !== 'directory' || typeof directory.queryPermission !== 'function') throw fail('DIRECTORY_REQUIRED');
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw fail('DIRECTORY_PERMISSION');
}
function configMatches(job, config) {
  return typeof config?.repository === 'string' && job.repository.toLowerCase() === config.repository.toLowerCase() &&
    (!config.branch || config.branch === job.branch);
}
function validateMetadata(accountText, manifestText, prefix, blobs) {
  const raw = parse(accountText), manifest = parse(manifestText);
  const storageKey = prefix.split('/').at(-1);
  if (!record(raw) || raw.schemaVersion !== 1 || raw.platform !== 'chatgpt' || !safeSegment(raw.accountKey) ||
      !safeSegment(storageKey) || raw.storageKey !== storageKey || raw.dataPath !== prefix) throw fail('RESTORE_METADATA');
  const account = { platform: 'chatgpt', accountKey: raw.accountKey, storageKey,
    alias: typeof raw.alias === 'string' ? raw.alias.slice(0, 200) : storageKey,
    displayName: typeof raw.displayName === 'string' ? raw.displayName.slice(0, 200) : storageKey };
  if (accountPrefix(account) !== prefix || !record(manifest) || manifest.schemaVersion !== 1 ||
      manifest.platform !== account.platform || manifest.accountKey !== account.accountKey || !record(manifest.conversations)) {
    throw fail('RESTORE_METADATA');
  }
  const paths = new Set(), entries = Object.entries(manifest.conversations);
  if (entries.length > MAX_ITEMS) throw fail('RESTORE_LIMIT');
  for (const [id, entry] of entries) {
    if (!safeSegment(id, 160) || !record(entry) || entry.conversationId !== id ||
        !/^[a-f0-9]{64}$/.test(entry.contentHash || '') || !/^[a-f0-9]{64}$/.test(entry.markdownHash || '') ||
        !validPath(entry.jsonPath) || !entry.jsonPath.startsWith(`${prefix}/conversations/`) ||
        !entry.jsonPath.endsWith(`__${id}.json`) || entry.markdownPath !== entry.jsonPath.replace(/\.json$/, '.md')) {
      throw fail('RESTORE_METADATA');
    }
    for (const path of [entry.jsonPath, entry.markdownPath]) {
      if (paths.has(path)) throw fail('RESTORE_METADATA');
      paths.add(path);
    }
  }
  // Only fields belonging to an archive account are passed to the writer.
  const normalizedAccount = JSON.stringify({ schemaVersion: 1, ...account, dataPath: prefix, purpose: 'conversation-archive' }, null, 2) + '\n';
  return { account, manifest, accountText: normalizedAccount, manifestText,
    entries: entries.map(([, entry]) => ({ entry, missing: !blobs.has(entry.jsonPath) || !blobs.has(entry.markdownPath) })) };
}
function summarize(job) {
  if (!job) return null;
  const done = job.items.filter(item => item.status === 'completed');
  const bad = [...job.metadata, ...job.items].filter(item => ['failed', 'retry', 'skipped'].includes(item.status));
  const retryTimes = [...job.metadata, ...job.items].filter(item => item.status === 'retry').map(item => item.nextRetryAt);
  return {
    schemaVersion: 1, status: job.status, phase: job.phase, repository: job.repository, branch: job.branch,
    commitSha: job.commitSha, treeSha: job.treeSha, startedAt: job.startedAt, updatedAt: job.updatedAt,
    completedAt: job.completedAt, accountCount: job.metadata.filter(item => item.status === 'completed').length,
    total: job.items.length, processed: done.length + job.items.filter(item => item.status === 'skipped').length,
    restored: done.filter(item => item.outcome === 'added' || item.outcome === 'updated').length,
    unchanged: done.filter(item => item.outcome === 'unchanged').length,
    cloudMissing: job.items.reduce((total, item) => total + (Number.isSafeInteger(item.cloudMissing) && item.cloudMissing > 0 ? item.cloudMissing : 0), 0),
    missingCloudConversations: job.items.filter(item => item.cloudMissing > 0).length,
    skipped: job.items.filter(item => item.status === 'skipped' || item.outcome === 'skipped').length,
    failed: [...job.metadata, ...job.items].filter(item => item.status === 'failed' || item.status === 'retry').length,
    pending: [...job.metadata, ...job.items].filter(item => ['pending', 'restoring', 'hydrating', 'retry'].includes(item.status)).length,
    nextRetryAt: retryTimes.length ? Math.min(...retryTimes) : null,
    error: job.error || bad.find(item => item.error)?.error || null,
    issues: bad.filter(item => item.error).slice(0, 50).map(item => ({ accountKey: item.account?.accountKey || null,
      conversationId: item.entry?.conversationId || null, status: item.status, ...item.error })),
  };
}

/** A tick processes one account's metadata or one conversation/asset batch.
 * Directory handles are stored only in IndexedDB; credentials are never saved in jobs.
 * reconcileRestoredAssets may return {pending:true} to bound its own work across ticks. */
export function createRestoreService({ getSetting, setSetting, fetchRepositorySnapshot, downloadRepositoryFile,
  applyRemoteFiles, reconcileRestoredAssets, enqueueRecovered, readLocalManifest = readAccountManifest, readLocalFile = readLocalBytes, now = Date.now } = {}) {
  for (const dependency of [getSetting, setSetting, fetchRepositorySnapshot, downloadRepositoryFile, applyRemoteFiles, readLocalManifest, readLocalFile]) {
    if (typeof dependency !== 'function') throw new TypeError('Missing restore service dependency');
  }
  const activity = createActivityLog({ getSetting, setSetting, now });
  let operation = Promise.resolve();
  function locked(callback) {
    const pending = operation.catch(() => {}).then(callback); operation = pending; return pending;
  }
  async function load() {
    const job = await getSetting(RESTORE_SETTING_KEY);
    if (!job) return null;
    if (job.schemaVersion !== 1 || !Array.isArray(job.metadata) || !Array.isArray(job.items) || !Array.isArray(job.entries)) throw fail('STORAGE');
    return job;
  }
  async function publish(job) {
    job.updatedAt = now();
    try { await setSetting(RESTORE_SETTING_KEY, job); } catch { throw fail('STORAGE'); }
    return summarize(job);
  }
  async function downloadText(config, entry) {
    return activity.run('repository', 'restore', { stage: 'restore-file', fileName: entry?.path?.split('/').at(-1), size: entry?.size }, async () => {
    if (!entry || entry.size > MAX_BYTES) throw fail(entry ? 'RESTORE_LIMIT' : 'RESTORE_PATH');
    const bytes = await downloadRepositoryFile({ config, entry, maxBytes: MAX_BYTES });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw fail('RESTORE_LIMIT');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('RESTORE_METADATA'); }
    });
  }
  async function reusableLocalText(directory, account, prior, remoteEntry) {
    const result = {};
    if (!prior) return result;
    const prefix = accountPrefix(account);
    for (const [pathField, hashField] of [['jsonPath', 'contentHash'], ['markdownPath', 'markdownHash']]) {
      const path = prior[pathField];
      // The manifest reader normally checks this; keep the optional injected
      // reader from turning a remote path into arbitrary local file access.
      if (!validPath(path) || !path.startsWith(`${prefix}/conversations/`)) throw fail('LOCAL_CONFLICT');
      const bytes = await readLocalFile(directory, path, MAX_BYTES);
      if (bytes === null) continue; // Missing files still use the guarded restore writer.
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw fail('RESTORE_LIMIT');
      const digest = await hashBytes(bytes);
      if (digest !== prior[hashField] && digest !== remoteEntry[hashField]) throw fail('LOCAL_CONFLICT');
      if (digest === prior[hashField] && digest === remoteEntry[hashField]) {
        try { result[pathField] = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw fail('LOCAL_CONFLICT'); }
      }
    }
    return result;
  }
  function finish(job) {
    const all = [...job.metadata, ...job.items];
    if (all.some(item => ['pending', 'restoring', 'hydrating', 'retry'].includes(item.status))) {
      job.status = 'running'; job.phase = job.metadata.some(item => item.status === 'pending' || item.status === 'retry') ? 'metadata' : 'conversations';
      job.completedAt = null;
    } else {
      job.status = all.some(item => item.status === 'failed' || item.status === 'skipped' || item.outcome === 'skipped' || item.cloudMissing > 0) ? 'partial' : 'completed';
      job.phase = 'done'; job.completedAt = now();
    }
  }
  async function start({ config, directory, force = false }) {
    return locked(async () => {
      await permission(directory);
      const previous = await load();
      // A recovered local capture is not part of the remote snapshot. Never
      // discard its durable delivery receipt, even on an explicit restart.
      if (previous?.items.some(item => item.pendingRecovered)) {
        if (!configMatches(previous, config)) throw fail('RESTORE_CONFIG_CHANGED');
        if (!await sameDirectory(previous.directory, directory)) throw fail('DIRECTORY_CHANGED');
        for (const item of previous.items) if (item.pendingRecovered && (force || item.status === 'failed')) {
          item.status = 'restoring'; item.phase = 'recovery'; item.attempts = 0; item.nextRetryAt = null;
        }
        previous.status = 'running'; previous.error = null;
        return publish(previous);
      }
      if (previous && !force) {
        // start() is serialized behind any active file write. Once that write
        // and its recovery receipt have settled, a different destination gets
        // its own snapshot instead of retrying an incompatible checkpoint.
        // The pendingRecovered guard above remains authoritative even on force.
        const sameTarget = configMatches(previous, config) && await sameDirectory(previous.directory, directory);
        if (sameTarget && ['running', 'blocked'].includes(previous.status)) {
          previous.status = 'running'; previous.error = null;
          return publish(previous);
        }
      }
      const snapshot = await activity.run('repository', 'restore', { stage: 'restore-scan' }, () => fetchRepositorySnapshot({ config }));
      if (!record(snapshot) || typeof snapshot.repository !== 'string' || typeof snapshot.branch !== 'string' ||
          !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ITEMS) throw fail('RESTORE_METADATA');
      const prefixes = new Set(), seen = new Set();
      for (const entry of snapshot.entries) {
        if (!validPath(entry?.path) || seen.has(entry.path)) throw fail('RESTORE_PATH');
        seen.add(entry.path);
        const match = /^data\/web\/chatgpt\/([^/]+)\/(?:account\.json|archive\/manifest\.json)$/.exec(entry.path);
        if (match) { if (!safeSegment(match[1])) throw fail('RESTORE_PATH'); prefixes.add(`data/web/chatgpt/${match[1]}`); }
      }
      const job = { schemaVersion: 1, repository: snapshot.repository, branch: snapshot.branch,
        commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, entries: snapshot.entries, empty: snapshot.empty,
        directory, startedAt: now(), updatedAt: now(), completedAt: null, status: 'running', phase: 'metadata', error: null,
        metadata: [...prefixes].sort().map(prefix => ({ prefix, status: 'pending', attempts: 0, nextRetryAt: null, error: null })), items: [] };
      if (!configMatches(job, config)) throw fail('RESTORE_CONFIG_CHANGED');
      finish(job);
      // Even an unchanged commit starts a fresh reconciliation: local attachments
      // may have disappeared after the previous successful restore.
      return publish(job);
    });
  }
  async function tick({ config, directory }) {
    return locked(async () => {
      const job = await load();
      if (!job) return null;
      try {
        if (!configMatches(job, config)) throw fail('RESTORE_CONFIG_CHANGED');
        if (!await sameDirectory(job.directory, directory)) throw fail('DIRECTORY_CHANGED');
        await permission(directory);
      } catch (error) { job.status = 'blocked'; job.error = safeError(error); return publish(job); }
      if (['completed', 'partial'].includes(job.status)) return summarize(job);
      job.status = 'running'; job.error = null;
      const eligible = item => ['pending', 'restoring', 'hydrating'].includes(item.status) || item.status === 'retry' && item.nextRetryAt <= now();
      const metadata = job.metadata.find(eligible);
      const item = metadata || job.items.find(eligible);
      if (!item) { finish(job); return publish(job); }
      const blobs = new Map(job.entries.map(entry => [entry.path, entry]));
      try {
        if (metadata) {
          const accountText = await downloadText(config, blobs.get(`${item.prefix}/account.json`));
          const manifestText = await downloadText(config, blobs.get(`${item.prefix}/archive/manifest.json`));
          const parsed = validateMetadata(accountText, manifestText, item.prefix, blobs);
          if (job.metadata.some(other => other !== item && other.account?.accountKey === parsed.account.accountKey)) throw fail('RESTORE_METADATA');
          if (job.items.length + parsed.entries.length > MAX_ITEMS) throw fail('RESTORE_LIMIT');
          Object.assign(item, { account: parsed.account, accountText: parsed.accountText, manifestText: parsed.manifestText, status: 'completed', error: null });
          for (const { entry, missing } of parsed.entries) job.items.push({ prefix: item.prefix, account: parsed.account, entry,
            status: missing ? 'failed' : 'pending', phase: 'archive', attempts: 0, nextRetryAt: null,
            error: missing ? safeError(fail('RESTORE_PATH')) : null });
        } else {
          if (item.phase !== 'assets' && item.phase !== 'recovery') {
            const local = await readLocalManifest(directory, item.account);
            const prior = local?.conversations?.[item.entry.conversationId];
            const remoteTime = stamp(item.entry.sourceUpdatedAt), localTime = stamp(prior?.sourceUpdatedAt);
            if (prior && prior.contentHash !== item.entry.contentHash &&
                (remoteTime === null || localTime === null || remoteTime <= localTime)) {
              item.outcome = 'skipped'; item.error = safeError(fail(remoteTime !== null && localTime !== null && remoteTime < localTime ? 'STALE_DETAIL' : 'RESTORE_VERSION_UNCERTAIN'));
              item.restoredEntry = prior;
            } else {
              const metadataForAccount = job.metadata.find(value => value.prefix === item.prefix);
              const reusable = await reusableLocalText(directory, item.account, prior, item.entry);
              const nativeText = reusable.jsonPath ?? await downloadText(config, blobs.get(item.entry.jsonPath));
              const markdownText = reusable.markdownPath ?? await downloadText(config, blobs.get(item.entry.markdownPath));
              // Even when text is unchanged, keep the writer's ownership/edit
              // guards and metadata merge: remote asset records may have improved.
              // Persist before the write; replay is safe if the worker stops after
              // the writer commits but before this job records its receipt.
              item.status = 'restoring'; await publish(job);
              const result = await activity.run('repository', 'restore', { stage: 'restore-save',
                title: item.entry.title, conversationId: item.entry.conversationId }, () => applyRemoteFiles({ directory, account: item.account, files: [
                { path: item.entry.jsonPath, content: nativeText }, { path: item.entry.markdownPath, content: markdownText },
                { path: `${item.prefix}/archive/manifest.json`, content: metadataForAccount.manifestText },
                { path: `${item.prefix}/account.json`, content: metadataForAccount.accountText },
              ] }));
              item.outcome = result.status; item.restoredEntry = result.entry || item.entry;
              if (result.recovered) item.pendingRecovered = result.recovered;
            }
            item.phase = item.pendingRecovered ? 'recovery' : 'assets';
            item.status = item.pendingRecovered ? 'restoring' : 'hydrating'; item.attempts = 0;
            await publish(job);
          }
          if (item.pendingRecovered) {
            if (typeof enqueueRecovered !== 'function') throw fail('RESTORE_RECOVERY_PENDING');
            // The outbox must be idempotent: a worker can stop after enqueue but
            // before this receipt is cleared. Never enqueue the normal restore.
            await enqueueRecovered({ account: item.account, archive: item.pendingRecovered });
            delete item.pendingRecovered;
            item.phase = 'assets'; item.status = 'hydrating'; item.attempts = 0; item.nextRetryAt = null;
            await publish(job);
          }
          if (reconcileRestoredAssets) {
            const result = await activity.run('repository', 'restore', { stage: 'restore-assets',
              title: item.entry.title, conversationId: item.entry.conversationId }, () => reconcileRestoredAssets({ directory, account: item.account, entry: item.restoredEntry,
              remoteEntry: item.entry }));
            item.cloudMissing = Number.isSafeInteger(result?.cloudMissing) && result.cloudMissing > 0 ? result.cloudMissing : 0;
            if (result?.failed) throw fail('ASSET_RESTORE_FAILED');
            if (result?.pending) { item.status = 'hydrating'; finish(job); return publish(job); }
          }
          item.status = item.outcome === 'skipped' ? 'skipped' : 'completed'; item.nextRetryAt = null;
          if (item.outcome !== 'skipped') item.error = null;
        }
      } catch (error) {
        if (error?.code === 'STORAGE') throw error;
        item.error = safeError(error);
        if (['LOCAL_CONFLICT', 'STALE_DETAIL', 'RESTORE_VERSION_UNCERTAIN'].includes(error?.code)) {
          item.status = 'skipped'; item.outcome = 'skipped'; item.nextRetryAt = null;
        } else {
          item.attempts++;
          const permanent = ['RESTORE_METADATA', 'RESTORE_PATH', 'RESTORE_LIMIT', 'REMOTE_HASH', 'ACCOUNT_MISMATCH', 'REMOTE_ARCHIVE', 'PARTIAL_DETAIL'].includes(error?.code);
          item.status = permanent || item.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
          item.nextRetryAt = item.status === 'retry' ? now() + Math.min(15 * 60_000, 60_000 * 2 ** (item.attempts - 1)) : null;
        }
      }
      finish(job); return publish(job);
    });
  }
  return { start, tick, state: async () => summarize(await load()) };
}
