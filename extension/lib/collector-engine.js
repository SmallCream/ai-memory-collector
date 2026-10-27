/**
 * Durable, account-scoped collection. A tick performs one list page or one detail
 * and commits its checkpoint before returning. No timers, DOM, or GitHub client
 * live here: the MV3 scheduler supplies those and may stop between any two ticks.
 */
import { createActivityLog, activityLabel } from './activity-log.js';
import { needsMessageFullCheck } from './message-sync.js';
import { sanitizeDetailFailure, detailFailureMessage } from './detail-errors.js';
const MODES = new Set(['initial', 'incremental', 'full']);
const LIVE = new Set(['running', 'paused', 'blocked']);
const MAX_ITEMS = 100_000;
const MAX_PAGES = 5_000;
const MAX_ATTEMPTS = 3;
const COPY = value => value == null ? value : structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const keys = accountKey => ({ job: `collectorJob:${accountKey}`, index: `collectorIndex:${accountKey}`, outbox: `collectorOutbox:${accountKey}`,
  retry: `collectorRetry:${accountKey}`, localChanges: `collectorLocalChanges:${accountKey}` });
const MAX_RETRY_AFTER = 24 * 60 * 60_000;
const manualFailure = code => ['FORMAT', 'SIZE', 'ARCHIVE_FORMAT', 'ARCHIVE_SIZE'].includes(code);
const sourceVersion = item => JSON.stringify([item.listUpdateTime ?? null, item.title || '']);
const ERROR_MESSAGES = {
  ACCOUNT_CHANGED: '采集所用会话已切换账号，原任务已暂停。',
  IDENTITY: '无法确认登录身份，请在 来源平台 完成登录后继续。',
  HTTP_401: '来源平台 登录已过期，请重新登录后继续。',
  HTTP_403: '网站需要验证或拒绝访问，请在 来源平台 页面处理后继续。',
  HTTP_429: '平台暂时限流，已保留进度，稍后重试。',
  HTTP_404: '此对话暂时无法访问，已有归档保持不变。',
  DIRECTORY_PERMISSION: '需要恢复本地目录的读写权限。',
  NO_DIRECTORY: '尚未配置本地保存目录。',
  DIRECTORY_REQUIRED: '尚未配置本地保存目录。',
  DIRECTORY_CHANGED: '保存目录与未完成任务不一致，请恢复原目录后继续。',
  SOURCE_UNAVAILABLE: '来源平台 标签页不可用，重新打开并登录后继续。',
  TAB_REQUIRED: '请打开已登录的 来源平台 标签页后继续。',
  TAB_CLOSED: '来源平台 标签页已关闭，重新打开后可继续采集。',
  TAB_CHANGED: '采集标签页已离开 来源平台，重新打开后可继续采集。',
  TAB_UNAVAILABLE: '暂时无法读取 来源平台，请检查网站权限和登录状态后继续。',
  PARTIAL_DETAIL: '详情尚未完整取得或有消息尚不能确认已结束，已有归档保持不变。',
  INCOMPLETE_DETAIL: '详情尚未完整取得，已有归档保持不变。',
  STALE_DETAIL: '线上返回的版本较旧，未覆盖已有归档。',
  DETAIL_CHANGED: '读取消息分页时对话发生变化，保留原归档，稍后重新读取。',
  DETAIL_PAGINATION: '消息分页未能可靠衔接，保留原归档，等待完整读取。',
  COLLECTION_PAUSED: '采集已暂停，原归档保持不变。',
  LOCAL_CONFLICT: '本地文件被其他程序修改，已保留原文件。',
  LOCAL_WRITE: '本地文件写入未完成，已保留恢复记录。',
  LOCAL_VERIFY: '本地文件核对未完成，已保留恢复记录。',
  FORMAT: '网站返回结构发生变化，本次未推进进度。',
  INVALID_RESPONSE: '未取得有效的采集返回结果，已有归档和进度已保留。',
  PAGINATION_STALLED: '列表分页没有继续前进，未标记全量完成。',
  PAGINATION_CHANGED: '扫描时列表发生变化，未标记全量完成，请重新检查。',
  PAGINATION_LIMIT: '列表超过当前支持的扫描范围，未标记全量完成。',
  ENUMERATION_INCOMPLETE: '列表尚未完整取得，未标记全量完成。',
  SIZE: '返回内容超过当前处理上限，已有归档保持不变。',
  NETWORK: '网络请求未完成，已保留进度，稍后重试。',
  TIMEOUT: '请求超时，已保留进度，稍后重试。',
  STORAGE: '任务状态保存失败，请检查浏览器可用空间后重试。',
};

function fail(code, message = ERROR_MESSAGES[code] || '采集未完成，进度已保留。') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeError(error) {
  const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code : 'COLLECTION_FAILED';
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0
    ? Math.min(MAX_RETRY_AFTER, Math.ceil(error.retryAfterMs)) : null;
  return { code, ...sanitizeDetailFailure({ ...error, code }),
    ...(['HTTP_429', 'HTTP_503'].includes(code) && retryAfterMs !== null ? { retryAfterMs } : {}),
    message: detailFailureMessage({ ...error, code }) || ERROR_MESSAGES[code] || (code.startsWith('HTTP_5') ? '网站暂时不可用，已保留进度。' : '采集未完成，已有归档和进度已保留。') };
}

function transient(code) {
  return ['NETWORK', 'TIMEOUT', 'HTTP_429', 'INVALID_RESPONSE', 'PARTIAL_DETAIL', 'INCOMPLETE_DETAIL', 'STALE_DETAIL', 'DETAIL_CHANGED', 'DETAIL_PAGINATION', 'STORAGE'].includes(code) || /^HTTP_5\d\d$/.test(code);
}

function blocked(code) {
  return ['ACCOUNT_CHANGED', 'IDENTITY', 'HTTP_401', 'HTTP_403', 'DIRECTORY_PERMISSION', 'DIRECTORY_REQUIRED', 'DIRECTORY_CHANGED', 'NO_DIRECTORY', 'LOCAL_WRITE', 'LOCAL_VERIFY', 'LOCAL_CONFLICT', 'SOURCE_UNAVAILABLE', 'TAB_REQUIRED', 'TAB_CLOSED', 'TAB_CHANGED', 'TAB_UNAVAILABLE', 'SITE_PERMISSION_DENIED'].includes(code);
}

function timestamp(value) {
  if (typeof value === 'string') {
    value = value.trim();
    if (!value) return null;
    // Date.parse returns milliseconds, including dates close to the Unix epoch.
    if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return milliseconds(Date.parse(value));
    value = Number(value);
  }
  return typeof value === 'number' ? milliseconds(value < 1e12 ? value * 1000 : value) : null;
}

function milliseconds(value) {
  return Number.isFinite(value) && value >= 0 && value <= 253402300799999 ? Math.trunc(value) : null;
}

function baselines(manifest, index, unfinished = []) {
  const retry = new Set(unfinished), result = {};
  for (const [id, entry] of Object.entries(manifest?.conversations || {})) {
    if (retry.has(id) || entry.sourceCompleteness !== 'complete' || !entry.contentHash) continue;
    const indexed = own(index, id) ? index[id] : null;
    const sourceUpdatedAt = timestamp(entry.sourceUpdatedAt);
    const indexedTime = milliseconds(indexed?.listUpdateTime);
    // A remote restore/merge can change the archive independently of this
    // browser's index. Only reuse an index tied to the same native JSON bytes.
    const listUpdateTime = indexed?.contentHash === entry.contentHash &&
      (sourceUpdatedAt === null || indexedTime <= sourceUpdatedAt) ? indexedTime : null;
    Object.defineProperty(result, id, { enumerable: true, configurable: true, writable: true,
      value: { conversationId: id, title: entry.title, contentHash: entry.contentHash, markdownHash: entry.markdownHash,
        jsonPath: entry.jsonPath, markdownPath: entry.markdownPath, rendererVersion: entry.rendererVersion,
        sourceCompleteness: entry.sourceCompleteness, sourceUpdatedAt, listUpdateTime, messageSync: COPY(entry.messageSync) } });
  }
  return result;
}

function validateAccount(account) {
  if (!account || account.enabled !== true || !['chatgpt', 'doubao'].includes(account.platform) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(account.accountKey || '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(account.storageKey || '')) {
    throw fail('ACCOUNT_NOT_ENABLED', '请先为当前账号启用采集。');
  }
}

function validateTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw fail('SOURCE_UNAVAILABLE');
}

const diagnosticLabel = activityLabel;
const diagnosticId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : '';
const diagnosticTime = value => Number.isFinite(value) && value >= 0 ? value : null;
function queueDiagnostics(queue = []) {
  const rank = { failed: 0, retry: 1, pending: 2, saved: 3, skipped: 4 };
  const totals = [0, 0, 0, 0, 0], groups = [[], [], [], [], []];
  for (const item of queue) {
    const group = own(rank, item.status) ? rank[item.status] : 2;
    totals[group]++;
    if (groups[group].length < 50) groups[group].push(item);
  }
  return { total: queue.length, remaining: totals[0] + totals[1] + totals[2],
    saved: totals[3], skipped: totals[4], retrying: totals[1], failed: totals[0],
    items: groups.flat().slice(0, 50).map(item => ({
      conversationId: diagnosticId(item.id), title: diagnosticLabel(item.title) || '未命名对话',
      status: own(rank, item.status) ? item.status : 'pending',
      attempt: Number.isSafeInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0,
      nextRetryAt: diagnosticTime(item.nextRetryAt), code: item.error ? safeError(item.error).code : null,
      ...(item.retryDisposition ? { retryDisposition: item.retryDisposition } : {}),
      ...(Number.isSafeInteger(item.totalAttempts) ? { totalAttempts: item.totalAttempts } : {}),
      ...sanitizeDetailFailure(item.error),
    })) };
}

function stateOf(job) {
  if (!job) return null;
  const { queue, known, manifestIds, unfinishedIds, ...state } = job;
  return COPY({ ...state, messageProgress: messageProgress(job.messageProgress), diagnostics: queueDiagnostics(queue) });
}

function messageProgress(value) {
  if (!value || typeof value !== 'object') return null;
  const result = { mode: ['full', 'tail-merge'].includes(value.mode) ? value.mode : 'reading' };
  for (const name of ['pagesRead', 'fetchedMessages', 'reusedMessages', 'addedMessages', 'updatedMessages']) {
    if (Number.isSafeInteger(value[name]) && value[name] >= 0) result[name] = value[name];
  }
  return result;
}

function counts(job) {
  const completed = job.queue.filter(item => item.status === 'saved');
  job.processed = completed.length + (job.skipped || 0);
  job.added = completed.filter(item => item.result === 'added').length;
  job.updated = completed.filter(item => item.result === 'updated').length;
  job.unchanged = (job.skipped || 0) + completed.filter(item => item.result === 'unchanged').length;
  job.failed = job.queue.filter(item => item.status === 'failed' || item.status === 'retry').length;
  const times = job.queue.filter(item => item.status === 'retry').map(item => item.nextRetryAt);
  if (job.listRetryAt) times.push(job.listRetryAt);
  if (job.accountCooldownUntil > (job.updatedAt || 0)) times.push(job.accountCooldownUntil);
  job.nextRetryAt = job.status === 'stopped' ? null : times.length ? Math.min(...times) : null;
}

/** Dependencies deliberately accept promises so IndexedDB and real file handles
 * can be replaced by in-memory stores in deterministic restart/failure tests. */
export function createCollectorEngine({ getSetting, setSetting, getDirectory, readAccountManifest,
  hasConversationFiles = async () => false, readConversationBaseline = async () => null,
  shouldQueueUpload = async () => true,
  adapter, saveConversation, now = Date.now, onChange = () => {},
  makeId = () => crypto.randomUUID() } = {}) {
  for (const dependency of [getSetting, setSetting, getDirectory, readAccountManifest, saveConversation]) {
    if (typeof dependency !== 'function') throw new TypeError('Missing collector engine dependency');
  }
  if (!adapter || !['identify', 'list', 'detail'].every(name => typeof adapter[name] === 'function')) {
    throw new TypeError('Missing platform adapter');
  }
  const locks = new Map();
  const pauseRequests = new Set();
  const activity = createActivityLog({ getSetting, setSetting, now });

  function locked(accountKey, operation) {
    const previous = locks.get(accountKey) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    locks.set(accountKey, result);
    result.finally(() => { if (locks.get(accountKey) === result) locks.delete(accountKey); }).catch(() => {});
    return result;
  }

  async function store(key, value) {
    try { await setSetting(key, value); }
    catch { throw fail('STORAGE'); }
  }

  async function publish(job) {
    job.updatedAt = now();
    counts(job);
    await store(keys(job.accountKey).job, job);
    try { await onChange(stateOf(job)); } catch { /* UI notification is not the checkpoint. */ }
    return stateOf(job);
  }

  async function directoryFor(account) {
    const directory = await getDirectory(account);
    if (!directory || directory.kind !== 'directory' || typeof directory.queryPermission !== 'function') throw fail('NO_DIRECTORY');
    if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw fail('DIRECTORY_PERMISSION');
    return directory;
  }

  async function verify(account, tabId) {
    validateTab(tabId);
    return activity.run(account.accountKey, 'collection', { stage: 'identify', title: '核对登录账号' }, async () => {
      const identity = await adapter.identify(tabId);
      if (!identity?.accountKey) throw fail('IDENTITY');
      if (identity.accountKey !== account.accountKey || identity.platform && identity.platform !== account.platform) throw fail('ACCOUNT_CHANGED');
      return identity;
    });
  }

  async function retryLedger(account) {
    const saved = await getSetting(keys(account.accountKey).retry);
    if (saved?.schemaVersion === 1 && saved.accountKey === account.accountKey && saved.storageKey === account.storageKey &&
        saved.items && typeof saved.items === 'object' && !Array.isArray(saved.items)) return saved;
    return { schemaVersion: 1, accountKey: account.accountKey, storageKey: account.storageKey,
      items: {}, listing: null, accountCooldownUntil: 0 };
  }

  async function persistRetry(account, ledger) { await store(keys(account.accountKey).retry, ledger); }

  async function applyRetryPolicy(job, account, item) {
    const ledger = await retryLedger(account), previous = own(ledger.items, item.id) ? ledger.items[item.id] : null;
    if (!previous) return;
    if (job.mode === 'full' || previous.version !== sourceVersion(item)) {
      delete ledger.items[item.id]; await persistRetry(account, ledger); return;
    }
    item.totalAttempts = previous.totalAttempts || 0;
    if (previous.manualOnly || previous.nextRetryAt > now()) {
      // Deferred items do not keep a whole scan running: newer IDs still get
      // collected, then the account can discover updates on its next scan.
      item.status = 'failed'; item.error = safeError(previous.error);
      item.nextRetryAt = previous.manualOnly ? null : previous.nextRetryAt;
      item.retryDisposition = previous.manualOnly ? 'manual' : 'cooldown';
    }
  }

  async function rememberFailure(job, item, info, attempts) {
    const ledger = await retryLedger(job), id = item?.id;
    const previous = id ? (own(ledger.items, id) ? ledger.items[id] : null) : ledger.listing;
    const same = previous && (!item || previous.version === sourceVersion(item));
    const totalAttempts = (same ? previous.totalAttempts || 0 : 0) + 1;
    const shortDelay = Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1));
    const longDelay = info.code === 'HTTP_404' ? MAX_RETRY_AFTER :
      Math.min(MAX_RETRY_AFTER, 30 * 60_000 * 2 ** Math.min(6, Math.max(0, Math.floor((totalAttempts - 3) / 3))));
    const canRetry = transient(info.code) && attempts < MAX_ATTEMPTS;
    const nextRetryAt = now() + Math.max(canRetry ? shortDelay : longDelay, info.retryAfterMs || 0);
    const record = { ...(item ? { version: sourceVersion(item) } : {}), totalAttempts,
      manualOnly: manualFailure(info.code), nextRetryAt, error: info, lastFailedAt: now() };
    if (id) Object.defineProperty(ledger.items, id, { enumerable: true, writable: true, configurable: true, value: record });
    else ledger.listing = record;
    if (info.code === 'HTTP_429' || info.code === 'HTTP_503' && info.retryAfterMs !== undefined) {
      ledger.accountCooldownUntil = Math.max(ledger.accountCooldownUntil || 0, nextRetryAt);
    }
    job.accountCooldownUntil = ledger.accountCooldownUntil || 0;
    await persistRetry(job, ledger);
    return { nextRetryAt, totalAttempts, canRetry, manualOnly: record.manualOnly };
  }

  async function clearFailure(account, id) {
    const ledger = await retryLedger(account);
    if (id ? !own(ledger.items, id) : !ledger.listing) return;
    if (id) delete ledger.items[id]; else ledger.listing = null;
    await persistRetry(account, ledger);
  }

  async function recordLocalChange(account, item, files) {
    const key = keys(account.accountKey).localChanges;
    const before = await getSetting(key);
    const items = before?.schemaVersion === 1 && before.accountKey === account.accountKey && before.storageKey === account.storageKey
      ? before.items || {} : {};
    const file = files.find(value => value.path.endsWith('/archive/manifest.json'));
    let entry;
    try { entry = file ? JSON.parse(file.content).conversations?.[item.id] : null; } catch { throw fail('STORAGE'); }
    if (!entry) throw fail('STORAGE');
    // Only identifiers/hashes are retained. Enabling cloud backup rebuilds the
    // immutable upload bundle from the verified local files.
    Object.defineProperty(items, item.id, { enumerable: true, configurable: true, writable: true,
      value: { contentHash: entry.contentHash, markdownHash: entry.markdownHash || null, updatedAt: now() } });
    await store(key, { schemaVersion: 1, accountKey: account.accountKey, storageKey: account.storageKey, items });
  }

  async function createJob(account, tabId, mode, previousJob = null) {
    pauseRequests.delete(account.accountKey);
    const directory = await directoryFor(account);
    const ledger = await retryLedger(account);
    if (!(ledger.accountCooldownUntil > now())) await verify(account, tabId);
    const manifest = await readAccountManifest(directory, account);
    const index = await getSetting(keys(account.accountKey).index);
    const indexed = index?.schemaVersion === 1 && index.accountKey === account.accountKey && index.storageKey === account.storageKey
      ? index.items || {} : {};
    // The disk manifest remains canonical. An IndexedDB index alone must never
    // make a new/replaced directory look fully populated.
    const manifestIds = Object.keys(manifest?.conversations || {});
    // Saving the files precedes outbox/index acknowledgement. Never let a
    // manifest fallback swallow a crashed or failed delivery from the last run.
    const unfinished = [...new Set([...(previousJob?.unfinishedIds || []),
      ...(previousJob?.queue || []).filter(item => !['saved', 'skipped'].includes(item.status) &&
        // A stopped scan may reconsider untouched entries against the current
        // manifest. Preserve failed or uncertain delivery work for rechecking.
        (previousJob.status !== 'stopped' || item.status !== 'pending' || item.attempts > 0 || previousJob.error))
        .map(item => item.id)])];
    const known = baselines(manifest, indexed, unfinished);
    const actualMode = mode === 'incremental' && !account.initialized ? 'initial' : mode;
    const job = {
      schemaVersion: 1, id: makeId(), platform: account.platform, accountKey: account.accountKey,
      storageKey: account.storageKey, tabId, mode: actualMode, status: 'running', phase: 'list',
      startedAt: now(), updatedAt: now(), completedAt: null, offset: 0, pages: 0,
      discovered: 0, processed: 0, added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0,
      total: null, queue: [], known: COPY(known), manifestIds, unfinishedIds: unfinished, enumerationComplete: false,
      initializedComplete: false, listAttempts: 0, listRetryAt: null, nextRetryAt: null, error: null,
      accountCooldownUntil: ledger.accountCooldownUntil || 0,
    };
    if (mode === 'full' && ledger.listing) { ledger.listing = null; await persistRetry(account, ledger); }
    if (ledger.listing && mode !== 'full') {
      if (ledger.listing.manualOnly) {
        job.status = 'partial'; job.completedAt = now(); job.error = safeError(ledger.listing.error);
      } else if (ledger.listing.nextRetryAt > now()) job.listRetryAt = ledger.listing.nextRetryAt;
    }
    return publish(job);
  }

  async function canSkip(job, account, directory, item) {
    if (job.mode === 'full' || item.listUpdateTime === null || !own(job.known, item.id)) return false;
    const known = job.known[item.id];
    // Re-read the early Doubao build that missed serialized content resources.
    if (account.platform === 'doubao' && (!known.rendererVersion || /^rich-/.test(known.rendererVersion))) return false;
    // Old persisted jobs have no complete baseline. Continue their original
    // pending queue safely; the next newly started scan uses the new policy.
    if ((account.platform === 'chatgpt' && needsMessageFullCheck(known, now())) || known.sourceCompleteness !== 'complete' ||
        (known.listUpdateTime !== item.listUpdateTime && known.sourceUpdatedAt !== item.listUpdateTime) ||
        (typeof known.title === 'string' && known.title.slice(0, 200) !== item.title)) return false;
    return hasConversationFiles(directory, account, known);
  }

  async function load(account) {
    validateAccount(account);
    const job = await getSetting(keys(account.accountKey).job);
    if (job && (job.accountKey !== account.accountKey || job.platform !== account.platform || job.storageKey !== account.storageKey || job.schemaVersion !== 1)) {
      throw fail('ACCOUNT_CHANGED');
    }
    return job;
  }

  async function resumeJob(job) {
    if (!job || job.status === 'completed') return stateOf(job);
    const restartDiscovery = !job.enumerationComplete && ['ENUMERATION_INCOMPLETE', 'PAGINATION_STALLED', 'PAGINATION_CHANGED'].includes(job.error?.code);
    job.status = 'running'; job.error = null; job.completedAt = null;
    job.listAttempts = 0; job.listRetryAt = null;
    const ledger = await retryLedger(job);
    ledger.listing = null;
    job.phase = job.enumerationComplete ? 'details' : 'list';
    if (restartDiscovery) {
      // A moving, update-sorted list may have skipped an earlier page. A new
      // discovery pass is necessary; no detail has run before enumeration ends.
      job.offset = 0; job.pages = 0; job.discovered = 0; job.skipped = 0; job.queue = []; job.total = null;
    }
    for (const item of job.queue) {
      if (item.status === 'failed' || item.status === 'retry') {
        item.status = 'pending'; item.attempts = 0; item.nextRetryAt = null; item.error = null;
        delete item.retryDisposition; delete item.totalAttempts; delete ledger.items[item.id];
      }
    }
    // Manual retry may reactivate a source, but cannot bypass server throttling.
    job.accountCooldownUntil = ledger.accountCooldownUntil || 0;
    await persistRetry(job, ledger);
    return publish(job);
  }

  async function finish(job) {
    counts(job);
    job.status = job.enumerationComplete && !job.failed ? 'completed' : 'partial';
    job.phase = 'done'; job.completedAt = now(); job.nextRetryAt = null;
    job.initializedComplete = job.status === 'completed' && ['initial', 'full'].includes(job.mode);
    if (!job.failed && job.enumerationComplete) job.error = null;
    else if (!job.error) job.error = job.queue.find(item => item.error)?.error || null;
    return publish(job);
  }

  async function handleError(job, error, item = null) {
    const info = safeError(error);
    if (info.code === 'COLLECTION_PAUSED') {
      job.status = 'paused'; job.error = null;
      return publish(job);
    }
    job.error = info;
    if (blocked(info.code)) {
      job.status = info.code === 'ACCOUNT_CHANGED' ? 'paused' : 'blocked';
      // Do not consume an item or list page when the source/permission is invalid.
      return publish(job);
    }
    const attempts = item ? ++item.attempts : ++job.listAttempts;
    const retry = await rememberFailure(job, item, info, attempts);
    if (item) {
      item.error = info;
      item.totalAttempts = retry.totalAttempts;
      item.status = retry.canRetry ? 'retry' : 'failed';
      item.nextRetryAt = retry.manualOnly ? null : retry.nextRetryAt;
      item.retryDisposition = retry.manualOnly ? 'manual' : retry.canRetry ? 'automatic' : 'cooldown';
      return publish(job);
    }
    if (retry.canRetry) job.listRetryAt = retry.nextRetryAt;
    else { job.status = 'partial'; job.completedAt = now(); job.initializedComplete = false; }
    return publish(job);
  }

  async function listStep(job, account, tabId, directory) {
    const page = await adapter.list(tabId, { accountKey: account.accountKey, offset: job.offset });
    if (!page || !Array.isArray(page.items) || page.items.some(item => !/^[A-Za-z0-9_-]{1,160}$/.test(item?.id || ''))) throw fail('FORMAT');
    if (!(page.nextOffset === null || (account.platform === 'doubao'
      ? typeof page.nextOffset === 'string' && /^[0-9]{1,20}$/.test(page.nextOffset) && BigInt(page.nextOffset) > 0n && (job.offset === 0 || BigInt(page.nextOffset) < BigInt(job.offset))
      : Number.isSafeInteger(page.nextOffset) && page.nextOffset > job.offset))) throw fail('PAGINATION_STALLED');
    if (page.items.length === 0 && page.nextOffset !== null) throw fail('PAGINATION_STALLED');
    if (job.pages >= MAX_PAGES || job.discovered + page.items.length > MAX_ITEMS) throw fail('ENUMERATION_INCOMPLETE');
    const seen = new Map(job.queue.map(item => [item.id, item]));
    // Include skipped IDs in the durable queue so a later page cannot count them
    // again after conversations move within the website's update-sorted listing.
    let added = 0;
    for (const source of page.items) {
      const updated = timestamp(source.updateTime);
      const title = typeof source.title === 'string' ? source.title.slice(0, 200) : '未命名对话';
      const seenItem = seen.get(source.id);
      if (seenItem) {
        // Update-sorted pages can move while scanning. A changed duplicate must
        // invalidate an earlier skip rather than hide a just-observed update.
        if (seenItem.listUpdateTime !== updated || seenItem.title !== title) {
          if (seenItem.status === 'skipped') job.skipped--;
          seenItem.status = 'pending';
          seenItem.listUpdateTime = updated === null || seenItem.listUpdateTime === null
            ? null : Math.max(updated, seenItem.listUpdateTime);
          seenItem.title = title;
          seenItem.attempts = 0; seenItem.nextRetryAt = null; seenItem.error = null;
          delete seenItem.retryDisposition; delete seenItem.totalAttempts;
          await applyRetryPolicy(job, account, seenItem);
        }
        continue;
      }
      added++;
      const item = { id: source.id, title,
        listUpdateTime: updated, status: 'pending', attempts: 0, nextRetryAt: null, error: null };
      const skip = await canSkip(job, account, directory, item);
      if (skip) item.status = 'skipped';
      else await applyRetryPolicy(job, account, item);
      job.queue.push(item); seen.set(source.id, item);
      if (skip) job.skipped++;
    }
    if (!added && page.items.length && page.nextOffset !== null) throw fail('PAGINATION_STALLED');
    job.discovered = job.queue.length; job.pages++;
    if (Number.isSafeInteger(page.total) && page.total >= 0) job.total = page.total;
    job.listAttempts = 0; job.listRetryAt = null; job.error = null;
    await clearFailure(account);
    if (page.nextOffset === null) {
      if (job.total !== null && job.discovered < job.total) throw fail('ENUMERATION_INCOMPLETE');
      job.enumerationComplete = true; job.phase = 'details';
    } else job.offset = page.nextOffset;
    return publish(job);
  }

  async function appendOutbox(account, item, files, { forceUpload = false } = {}) {
    if (!forceUpload && !await shouldQueueUpload(account)) {
      await recordLocalChange(account, item, files); return;
    }
    const key = keys(account.accountKey).outbox;
    const previous = await getSetting(key);
    const state = outboxState(previous);
    const shared = new Map(state.sharedFiles.map(file => [file.path, file]));
    const privateFiles = [];
    let manifestEntry = null;
    for (const file of files) {
      if (!sharedPath(file.path)) { privateFiles.push(file); continue; }
      if (file.path.endsWith('/archive/manifest.json')) {
        let manifest;
        try { manifest = JSON.parse(file.content); } catch { throw fail('STORAGE'); }
        if (manifest.accountKey !== account.accountKey || !own(manifest.conversations || {}, item.id)) throw fail('ACCOUNT_CHANGED');
        manifestEntry = COPY(manifest.conversations[item.id]);
      }
      // Keep shared metadata once, with a union across pending captures. This
      // also keeps an older directory's undelivered bundle valid after a move.
      const old = shared.get(file.path);
      if (old && file.path.endsWith('/archive/manifest.json')) {
        let before, after;
        try { before = JSON.parse(old.content); after = JSON.parse(file.content); }
        catch { throw fail('STORAGE'); }
        if (before.accountKey !== after.accountKey || after.accountKey !== account.accountKey) throw fail('ACCOUNT_CHANGED');
        shared.set(file.path, { ...file, content: JSON.stringify({ ...after,
          conversations: { ...before.conversations, ...after.conversations } }, null, 2) + '\n' });
      } else shared.set(file.path, COPY(file));
    }
    const bundle = { id: makeId(), accountKey: account.accountKey, platform: account.platform,
      storageKey: account.storageKey, conversationId: item.id, manifestEntry,
      files: COPY(privateFiles), createdAt: now() };
    // A completion acknowledgement uses this unique ID, never just conversationId.
    // It cannot erase a later version queued while an older upload was in flight.
    await store(key, { schemaVersion: 1, accountKey: account.accountKey,
      bundles: [...state.bundles.filter(entry => entry.conversationId !== item.id), bundle], sharedFiles: [...shared.values()] });
    const changes = await getSetting(keys(account.accountKey).localChanges);
    const dirty = changes?.schemaVersion === 1 && changes.accountKey === account.accountKey &&
      changes.storageKey === account.storageKey && own(changes.items || {}, item.id) && changes.items[item.id];
    if (dirty && dirty.contentHash === manifestEntry?.contentHash && dirty.markdownHash === (manifestEntry?.markdownHash || null)) {
      delete changes.items[item.id]; await store(keys(account.accountKey).localChanges, changes);
    }
  }

  function sharedPath(path) { return path.endsWith('/archive/manifest.json') || path.endsWith('/account.json'); }

  function outboxState(stored) {
    if (stored?.schemaVersion === 1 && Array.isArray(stored.bundles) && Array.isArray(stored.sharedFiles)) return stored;
    const bundles = [], shared = new Map();
    for (const entry of Array.isArray(stored) ? stored : []) {
      const files = [];
      let manifestEntry = entry.manifestEntry || null;
      for (const file of entry.files || []) {
        if (sharedPath(file.path)) {
          shared.set(file.path, file);
          if (file.path.endsWith('/archive/manifest.json')) {
            try { manifestEntry = JSON.parse(file.content).conversations?.[entry.conversationId] || null; } catch { /* Validation happens before upload. */ }
          }
        } else files.push(file);
      }
      bundles.push({ ...entry, files, manifestEntry });
    }
    return { schemaVersion: 1, bundles, sharedFiles: [...shared.values()] };
  }

  async function deliverableOutbox(accountKey) {
    const state = outboxState(await getSetting(keys(accountKey).outbox));
    const changes = await getSetting(keys(accountKey).localChanges);
    if (changes?.schemaVersion !== 1 || changes.accountKey !== accountKey) return state;
    return { ...state, bundles: state.bundles.filter(bundle => {
      const dirty = bundle.storageKey === changes.storageKey && own(changes.items || {}, bundle.conversationId) && changes.items[bundle.conversationId];
      // An old durable upload remains stored, but it must not race the newer
      // local-only version when cloud backup is re-enabled. Backfill replaces
      // it only after verifying and staging the current on-disk archive.
      return !dirty || (dirty.contentHash === bundle.manifestEntry?.contentHash &&
        dirty.markdownHash === (bundle.manifestEntry?.markdownHash || null));
    }) };
  }

  async function detailStep(job, account, tabId, directory, item) {
    const info = { title: item.title, conversationId: item.id, completed: job.processed, total: job.discovered };
    job.messageProgress = null;
    await publish(job);
    const detail = await activity.run(account.accountKey, 'collection', { ...info, stage: 'detail' }, async () => {
      const baseline = await readConversationBaseline(directory, account, item.id);
      const result = await adapter.detail(tabId, { accountKey: account.accountKey, conversationId: item.id,
        baseline, forceFull: job.mode === 'full' || needsMessageFullCheck(baseline?.entry, now()),
        shouldPause: () => pauseRequests.has(account.accountKey),
        onProgress: async progress => {
          // Page receipt is a real progress event, not a heartbeat. Failure to
          // persist display-only progress must not discard a valid capture.
          job.messageProgress = messageProgress(progress);
          try { await publish(job); } catch { /* Final write still requires its durable checkpoint. */ }
        } });
      if (result?.identity?.accountKey !== account.accountKey) throw fail('ACCOUNT_CHANGED');
      if (result.completeness === 'partial') throw fail('PARTIAL_DETAIL');
      const conversationId = result.payload?.conversation_id ?? result.payload?.id;
      if (conversationId !== item.id) throw fail('FORMAT');
      const sourceUpdatedAt = timestamp(result.payload?.update_time);
      if (item.listUpdateTime !== null && sourceUpdatedAt !== null && sourceUpdatedAt < item.listUpdateTime) throw fail('STALE_DETAIL');
      job.messageProgress = messageProgress(result.messageSync);
      return result;
    });
    // The adapter verifies before/after its network request. Recheck just before
    // handing off to the file writer so switching while the detail resolves does
    // not silently relabel another account's response.
    await verify(account, tabId);
    if (pauseRequests.has(account.accountKey)) throw fail('COLLECTION_PAUSED');
    return activity.run(account.accountKey, 'collection', { ...info, stage: 'save' }, async () => {
      if (pauseRequests.has(account.accountKey)) throw fail('COLLECTION_PAUSED');
      const saved = await saveConversation({ directory, account, detail, tabId });
      if (!saved || !['added', 'updated', 'unchanged'].includes(saved.status) || !Array.isArray(saved.files)) throw fail('STORAGE');
      if (saved.recovered?.files && saved.recovered.entry?.conversationId) {
        await appendOutbox(account, { id: saved.recovered.entry.conversationId }, saved.recovered.files);
      }
      await appendOutbox(account, item, saved.files);
      const indexKey = keys(account.accountKey).index;
      const current = await getSetting(indexKey);
      const items = current?.schemaVersion === 1 && current.accountKey === account.accountKey && current.storageKey === account.storageKey
        ? current.items || {} : {};
      Object.defineProperty(items, item.id, { enumerable: true, configurable: true, writable: true,
        value: { listUpdateTime: item.listUpdateTime, checkedAt: now(), contentHash: saved.entry?.contentHash || null } });
      await store(indexKey, { schemaVersion: 1, accountKey: account.accountKey, storageKey: account.storageKey, items });
      item.status = 'saved'; item.result = saved.status; item.error = null; item.nextRetryAt = null;
      delete item.retryDisposition;
      await clearFailure(account, item.id);
      job.unfinishedIds = (job.unfinishedIds || []).filter(id => id !== item.id);
      job.error = null;
      return publish(job);
    });
  }

  return {
    start({ account, tabId, mode = 'incremental', automatic = false }) {
      validateAccount(account); validateTab(tabId);
      if (!MODES.has(mode)) return Promise.reject(fail('INVALID_MODE', '不支持的采集方式。'));
      return locked(account.accountKey, async () => {
        const job = await load(account);
        // A scheduled start may have been queued just before a user stop.
        if (automatic && job?.status === 'stopped') return stateOf(job);
        if (job && LIVE.has(job.status)) {
          if (mode === 'full' && job.mode !== 'full') throw fail('BUSY', '已有采集任务，请先完成或暂停当前任务后再补采。');
          return stateOf(job);
        }
        // A new scheduled/manual scan must discover newly created conversations
        // even when an earlier scan ended partially. Only explicit resume()
        // retries that old queue without rediscovering the account.
        return createJob(account, tabId, mode, job);
      });
    },
    tick({ account, tabId }) {
      validateAccount(account);
      return locked(account.accountKey, async () => {
        const job = await load(account);
        if (!job || job.status !== 'running') return stateOf(job);
        if (pauseRequests.has(account.accountKey)) return handleError(job, fail('COLLECTION_PAUSED'));
        const ledger = await retryLedger(account);
        job.accountCooldownUntil = ledger.accountCooldownUntil || 0;
        if (job.accountCooldownUntil > now()) return publish(job);
        job.accountCooldownUntil = 0;
        if (job.listRetryAt && job.listRetryAt > now()) return stateOf(job);
        if (job.phase === 'details' && !job.queue.some(entry => entry.status === 'pending' || entry.status === 'retry' && entry.nextRetryAt <= now()) &&
            job.queue.some(entry => entry.status === 'retry')) return stateOf(job);
        let directory;
        try { directory = await directoryFor(account); await verify(account, tabId); }
        catch (error) { return handleError(job, error); }
        job.tabId = tabId;
        if (job.phase === 'list') {
          try { return await activity.run(account.accountKey, 'collection', {
            stage: 'list', title: `对话列表 · 第 ${job.pages + 1} 页`, completed: job.pages,
          }, () => listStep(job, account, tabId, directory)); }
          catch (error) { return handleError(job, error); }
        }
        job.listAttempts = 0; job.listRetryAt = null;
        const item = job.queue.find(entry => entry.status === 'pending' || entry.status === 'retry' && entry.nextRetryAt <= now());
        if (!item) {
          if (job.queue.some(entry => entry.status === 'retry')) return stateOf(job);
          return finish(job);
        }
        try { return await detailStep(job, account, tabId, directory, item); }
        catch (error) { return handleError(job, error, item); }
      });
    },
    pause(accountKey) {
      // Signal an in-flight paged detail before waiting for its durable job lock.
      // Once a file write has begun, let its archive/outbox checkpoint finish.
      pauseRequests.add(accountKey);
      return locked(accountKey, async () => {
        const job = await getSetting(keys(accountKey).job);
        if (!job || !LIVE.has(job.status)) return stateOf(job);
        job.status = 'paused'; return publish(job);
      });
    },
    stop(accountKey) {
      // Cancel network reads promptly, but let an already-started archive and
      // outbox commit finish under the account lock before ending the job.
      pauseRequests.add(accountKey);
      return locked(accountKey, async () => {
        const job = await getSetting(keys(accountKey).job);
        if (!job || job.status === 'stopped') return stateOf(job);
        job.status = 'stopped'; job.stoppedAt = now(); job.listRetryAt = null;
        job.initializedComplete = false;
        return publish(job);
      });
    },
    resume({ account, tabId }) {
      validateAccount(account); validateTab(tabId);
      return locked(account.accountKey, async () => {
        pauseRequests.delete(account.accountKey);
        const job = await load(account);
        if (job?.status === 'stopped') return stateOf(job);
        if (!job) return createJob(account, tabId, account.initialized ? 'incremental' : 'initial');
        try {
          await directoryFor(account);
          if (!((await retryLedger(account)).accountCooldownUntil > now())) await verify(account, tabId);
        }
        catch (error) { return handleError(job, error); }
        job.tabId = tabId; return resumeJob(job);
      });
    },
    async getState(accountKey) { return stateOf(await getSetting(keys(accountKey).job)); },
    suspend(accountKey, code = 'SOURCE_UNAVAILABLE', { interrupted = false } = {}) {
      return locked(accountKey, async () => {
        const job = await getSetting(keys(accountKey).job);
        // Cancelling an in-flight source read reports COLLECTION_PAUSED before
        // this lock is acquired. Its original running state was observed by the
        // caller, so classify that interruption as recoverable. A concurrent
        // explicit user pause remains authoritative and must not auto-resume.
        const sourceInterrupted = interrupted && job?.status === 'paused' && !pauseRequests.has(accountKey);
        if (!job || job.status !== 'running' && !sourceInterrupted) return stateOf(job);
        job.status = 'blocked'; job.error = safeError(fail(code));
        return publish(job);
      });
    },
    reset(accountKey) {
      return locked(accountKey, async () => {
        await store(keys(accountKey).index, null);
        await store(keys(accountKey).job, null);
        await store(keys(accountKey).retry, null);
        try { await onChange(null); } catch { /* UI event only. */ }
        return null;
      });
    },
    async getOutboxSummary(accountKey) {
      const state = await deliverableOutbox(accountKey);
      return { total: state.bundles.length, items: state.bundles.slice(0, 50).map(bundle => ({
        conversationId: diagnosticId(bundle.conversationId),
        title: diagnosticLabel(bundle.manifestEntry?.title) || diagnosticLabel(bundle.conversationId) || '未命名对话',
        createdAt: diagnosticTime(bundle.createdAt),
      })) };
    },
    async getOutbox(accountKey) {
      const state = await deliverableOutbox(accountKey);
      const headers = new Map(state.sharedFiles.filter(file => file.path.endsWith('/archive/manifest.json')).map(file => {
        const { conversations, ...header } = JSON.parse(file.content);
        return [file.path, header];
      }));
      return COPY(state.bundles.map(bundle => ({ ...bundle, files: [...bundle.files, ...state.sharedFiles.map(file => {
        if (!file.path.endsWith('/archive/manifest.json') || !bundle.manifestEntry) return file;
        // Another capture or remote reconciliation can advance the shared disk
        // manifest while this bundle is still awaiting upload. Its own entry
        // must describe its own immutable JSON/MD, never that later version.
        // GitHub merges these supplied entries into its actual remote manifest;
        // unrelated entries need not be repeated in every bundle. Keeping only
        // this entry also bounds reconstruction to O(number of conversations).
        return { ...file, content: JSON.stringify({ ...headers.get(file.path),
          conversations: { [bundle.conversationId]: bundle.manifestEntry } }, null, 2) + '\n' };
      })] })));
    },
    enqueueArchive({ account, archive, forceUpload = false }) {
      validateAccount(account);
      return locked(account.accountKey, async () => {
        const id = archive?.entry?.conversationId;
        if (!id || !Array.isArray(archive?.files)) throw fail('STORAGE');
        // Recovery deliveries can outlive another successful capture/restore.
        // Do not let an old derivative replace the newer queued snapshot for
        // this conversation. The writer of the current manifest owns its receipt.
        const directory = await directoryFor(account);
        const current = (await readAccountManifest(directory, account))?.conversations?.[id];
        if (current && ((current.contentHash && archive.entry.contentHash && current.contentHash !== archive.entry.contentHash) ||
            (current.markdownHash && archive.entry.markdownHash && current.markdownHash !== archive.entry.markdownHash))) return;
        await appendOutbox(account, { id }, archive.files, { forceUpload });
      });
    },
    async getRetryState(accountKey) {
      const ledger = await getSetting(keys(accountKey).retry);
      const cooldownUntil = ledger?.schemaVersion === 1 && ledger.accountKey === accountKey
        ? Math.max(0, Number(ledger.accountCooldownUntil) || 0) : 0;
      return { accountCooldownUntil: cooldownUntil, cooldownUntil };
    },
    async getLocalChanges(accountKey) {
      const state = await getSetting(keys(accountKey).localChanges);
      return state?.schemaVersion === 1 && state.accountKey === accountKey ? COPY(state.items || {}) : {};
    },
    acknowledgeOutbox(accountKey, ids) {
      return locked(accountKey, async () => {
        const delivered = new Set(ids);
        const state = outboxState(await getSetting(keys(accountKey).outbox));
        await store(keys(accountKey).outbox, { ...state, bundles: state.bundles.filter(bundle => !delivered.has(bundle.id)) });
      });
    },
  };
}
