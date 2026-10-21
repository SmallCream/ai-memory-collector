/**
 * Durable, account-scoped collection. A tick performs one list page or one detail
 * and commits its checkpoint before returning. No timers, DOM, or GitHub client
 * live here: the MV3 scheduler supplies those and may stop between any two ticks.
 */
const MODES = new Set(['initial', 'incremental', 'full']);
const LIVE = new Set(['running', 'paused', 'blocked']);
const MAX_ITEMS = 100_000;
const MAX_PAGES = 5_000;
const MAX_ATTEMPTS = 3;
const OVERLAP_MS = 5 * 60_000;
const COPY = value => value == null ? value : structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const keys = accountKey => ({ job: `collectorJob:${accountKey}`, index: `collectorIndex:${accountKey}`, outbox: `collectorOutbox:${accountKey}` });
const ERROR_MESSAGES = {
  ACCOUNT_CHANGED: '采集所用会话已切换账号，原任务已暂停。',
  IDENTITY: '无法确认登录身份，请在 ChatGPT 完成登录后继续。',
  HTTP_401: 'ChatGPT 登录已过期，请重新登录后继续。',
  HTTP_403: '网站需要验证或拒绝访问，请在 ChatGPT 页面处理后继续。',
  HTTP_429: '平台暂时限流，已保留进度，稍后重试。',
  HTTP_404: '此对话暂时无法访问，已有归档保持不变。',
  DIRECTORY_PERMISSION: '需要恢复本地目录的读写权限。',
  NO_DIRECTORY: '尚未配置本地保存目录。',
  DIRECTORY_REQUIRED: '尚未配置本地保存目录。',
  DIRECTORY_CHANGED: '保存目录与未完成任务不一致，请恢复原目录后继续。',
  SOURCE_UNAVAILABLE: 'ChatGPT 标签页不可用，重新打开并登录后继续。',
  TAB_REQUIRED: '请打开已登录的 ChatGPT 标签页后继续。',
  TAB_CLOSED: 'ChatGPT 标签页已关闭，重新打开后可继续采集。',
  TAB_CHANGED: '采集标签页已离开 ChatGPT，重新打开后可继续采集。',
  TAB_UNAVAILABLE: '暂时无法读取 ChatGPT，请检查网站权限和登录状态后继续。',
  PARTIAL_DETAIL: '详情尚未完整取得或仍在生成，已有归档保持不变。',
  INCOMPLETE_DETAIL: '详情尚未完整取得，已有归档保持不变。',
  STALE_DETAIL: '线上返回的版本较旧，未覆盖已有归档。',
  LOCAL_CONFLICT: '本地文件被其他程序修改，已保留原文件。',
  LOCAL_WRITE: '本地文件写入未完成，已保留恢复记录。',
  LOCAL_VERIFY: '本地文件核对未完成，已保留恢复记录。',
  FORMAT: '网站返回结构发生变化，本次未推进进度。',
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
  return { code, message: ERROR_MESSAGES[code] || (code.startsWith('HTTP_5') ? '网站暂时不可用，已保留进度。' : '采集未完成，已有归档和进度已保留。') };
}

function transient(code) {
  return ['NETWORK', 'TIMEOUT', 'HTTP_429', 'PARTIAL_DETAIL', 'INCOMPLETE_DETAIL', 'STORAGE'].includes(code) || /^HTTP_5\d\d$/.test(code);
}

function blocked(code) {
  return ['ACCOUNT_CHANGED', 'IDENTITY', 'HTTP_401', 'HTTP_403', 'DIRECTORY_PERMISSION', 'DIRECTORY_REQUIRED', 'DIRECTORY_CHANGED', 'NO_DIRECTORY', 'LOCAL_WRITE', 'LOCAL_VERIFY', 'LOCAL_CONFLICT', 'SOURCE_UNAVAILABLE', 'TAB_REQUIRED', 'TAB_CLOSED', 'TAB_CHANGED', 'TAB_UNAVAILABLE', 'SITE_PERMISSION_DENIED'].includes(code);
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function validateAccount(account) {
  if (!account || account.enabled !== true || account.platform !== 'chatgpt' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(account.accountKey || '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(account.storageKey || '')) {
    throw fail('ACCOUNT_NOT_ENABLED', '请先为当前账号启用采集。');
  }
}

function validateTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw fail('SOURCE_UNAVAILABLE');
}

function stateOf(job) {
  if (!job) return null;
  const { queue, known, manifestIds, ...state } = job;
  return COPY(state);
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
  job.nextRetryAt = times.length ? Math.min(...times) : null;
}

/** Dependencies deliberately accept promises so IndexedDB and real file handles
 * can be replaced by in-memory stores in deterministic restart/failure tests. */
export function createCollectorEngine({ getSetting, setSetting, getDirectory, readAccountManifest,
  adapter, saveConversation, now = Date.now, onChange = () => {},
  makeId = () => crypto.randomUUID() } = {}) {
  for (const dependency of [getSetting, setSetting, getDirectory, readAccountManifest, saveConversation]) {
    if (typeof dependency !== 'function') throw new TypeError('Missing collector engine dependency');
  }
  if (!adapter || !['identify', 'list', 'detail'].every(name => typeof adapter[name] === 'function')) {
    throw new TypeError('Missing platform adapter');
  }
  const locks = new Map();

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
    counts(job);
    job.updatedAt = now();
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
    const identity = await adapter.identify(tabId);
    if (!identity?.accountKey) throw fail('IDENTITY');
    if (identity.accountKey !== account.accountKey || identity.platform && identity.platform !== account.platform) throw fail('ACCOUNT_CHANGED');
    return identity;
  }

  async function createJob(account, tabId, mode) {
    const directory = await directoryFor(account);
    await verify(account, tabId);
    const manifest = await readAccountManifest(directory, account);
    const index = await getSetting(keys(account.accountKey).index);
    const known = index?.schemaVersion === 1 && index.accountKey === account.accountKey && index.storageKey === account.storageKey
      ? index.items || {} : {};
    // The disk manifest remains canonical. An IndexedDB index alone must never
    // make a new/replaced directory look fully populated.
    const manifestIds = Object.keys(manifest?.conversations || {});
    const actualMode = mode === 'incremental' && !account.initialized ? 'initial' : mode;
    const job = {
      schemaVersion: 1, id: makeId(), platform: account.platform, accountKey: account.accountKey,
      storageKey: account.storageKey, tabId, mode: actualMode, status: 'running', phase: 'list',
      startedAt: now(), updatedAt: now(), completedAt: null, offset: 0, pages: 0,
      discovered: 0, processed: 0, added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0,
      total: null, queue: [], known: COPY(known), manifestIds, enumerationComplete: false,
      initializedComplete: false, listAttempts: 0, listRetryAt: null, nextRetryAt: null, error: null,
    };
    return publish(job);
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
    job.phase = job.enumerationComplete ? 'details' : 'list';
    if (restartDiscovery) {
      // A moving, update-sorted list may have skipped an earlier page. A new
      // discovery pass is necessary; no detail has run before enumeration ends.
      job.offset = 0; job.pages = 0; job.discovered = 0; job.skipped = 0; job.queue = []; job.total = null;
    }
    for (const item of job.queue) {
      if (item.status === 'failed' || item.status === 'retry') {
        item.status = 'pending'; item.attempts = 0; item.nextRetryAt = null; item.error = null;
      }
    }
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
    job.error = info;
    if (blocked(info.code)) {
      job.status = info.code === 'ACCOUNT_CHANGED' ? 'paused' : 'blocked';
      // Do not consume an item or list page when the source/permission is invalid.
      return publish(job);
    }
    const attempts = item ? ++item.attempts : ++job.listAttempts;
    const retryAt = now() + Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1));
    if (item) {
      item.error = info;
      item.status = transient(info.code) && attempts < MAX_ATTEMPTS ? 'retry' : 'failed';
      item.nextRetryAt = item.status === 'retry' ? retryAt : null;
      return publish(job);
    }
    if (transient(info.code) && attempts < MAX_ATTEMPTS) job.listRetryAt = retryAt;
    else { job.status = 'partial'; job.completedAt = now(); job.initializedComplete = false; }
    return publish(job);
  }

  async function listStep(job, account, tabId) {
    const page = await adapter.list(tabId, { accountKey: account.accountKey, offset: job.offset });
    if (!page || !Array.isArray(page.items) || page.items.some(item => !/^[A-Za-z0-9_-]{1,160}$/.test(item?.id || ''))) throw fail('FORMAT');
    if (!(page.nextOffset === null || Number.isSafeInteger(page.nextOffset) && page.nextOffset > job.offset)) throw fail('PAGINATION_STALLED');
    if (page.items.length === 0 && page.nextOffset !== null) throw fail('PAGINATION_STALLED');
    if (job.pages >= MAX_PAGES || job.discovered + page.items.length > MAX_ITEMS) throw fail('ENUMERATION_INCOMPLETE');
    const seen = new Map(job.queue.map(item => [item.id, item]));
    // Include skipped IDs in the durable queue so a later page cannot count them
    // again after conversations move within the website's update-sorted listing.
    let added = 0;
    for (const source of page.items) {
      if (seen.has(source.id)) continue;
      added++;
      const updated = timestamp(source.updateTime);
      const known = own(job.known, source.id) ? job.known[source.id] : null;
      const skip = job.mode === 'incremental' && job.manifestIds.includes(source.id) && known &&
        updated !== null && known.listUpdateTime === updated && updated < job.startedAt - OVERLAP_MS;
      const item = { id: source.id, title: typeof source.title === 'string' ? source.title.slice(0, 200) : '未命名对话',
        listUpdateTime: updated, status: skip ? 'skipped' : 'pending', attempts: 0, nextRetryAt: null, error: null };
      job.queue.push(item); seen.set(source.id, item);
      if (skip) job.skipped++;
    }
    if (!added && page.items.length && page.nextOffset !== null) throw fail('PAGINATION_STALLED');
    job.discovered = job.queue.length; job.pages++;
    if (Number.isSafeInteger(page.total) && page.total >= 0) job.total = page.total;
    job.listAttempts = 0; job.listRetryAt = null; job.error = null;
    if (page.nextOffset === null) {
      if (job.total !== null && job.discovered < job.total) throw fail('ENUMERATION_INCOMPLETE');
      job.enumerationComplete = true; job.phase = 'details';
    } else job.offset = page.nextOffset;
    return publish(job);
  }

  async function appendOutbox(account, item, files) {
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

  async function detailStep(job, account, tabId, directory, item) {
    const detail = await adapter.detail(tabId, { accountKey: account.accountKey, conversationId: item.id });
    if (detail?.identity?.accountKey !== account.accountKey) throw fail('ACCOUNT_CHANGED');
    if (detail.completeness === 'partial') throw fail('PARTIAL_DETAIL');
    const conversationId = detail.payload?.conversation_id ?? detail.payload?.id;
    if (conversationId !== item.id) throw fail('FORMAT');
    // The adapter verifies before/after its network request. Recheck just before
    // handing off to the file writer so switching while the detail resolves does
    // not silently relabel another account's response.
    await verify(account, tabId);
    const saved = await saveConversation({ directory, account, detail });
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
    job.error = null;
    return publish(job);
  }

  return {
    start({ account, tabId, mode = 'incremental' }) {
      validateAccount(account); validateTab(tabId);
      if (!MODES.has(mode)) return Promise.reject(fail('INVALID_MODE', '不支持的采集方式。'));
      return locked(account.accountKey, async () => {
        const job = await load(account);
        if (job && LIVE.has(job.status)) {
          if (mode === 'full' && job.mode !== 'full') throw fail('BUSY', '已有采集任务，请先完成或暂停当前任务后再补采。');
          return stateOf(job);
        }
        // A new scheduled/manual scan must discover newly created conversations
        // even when an earlier scan ended partially. Only explicit resume()
        // retries that old queue without rediscovering the account.
        return createJob(account, tabId, mode);
      });
    },
    tick({ account, tabId }) {
      validateAccount(account);
      return locked(account.accountKey, async () => {
        const job = await load(account);
        if (!job || job.status !== 'running') return stateOf(job);
        if (job.listRetryAt && job.listRetryAt > now()) return stateOf(job);
        if (job.phase === 'details' && !job.queue.some(entry => entry.status === 'pending' || entry.status === 'retry' && entry.nextRetryAt <= now()) &&
            job.queue.some(entry => entry.status === 'retry')) return stateOf(job);
        let directory;
        try { directory = await directoryFor(account); await verify(account, tabId); }
        catch (error) { return handleError(job, error); }
        job.tabId = tabId;
        if (job.phase === 'list') {
          try { return await listStep(job, account, tabId); }
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
      return locked(accountKey, async () => {
        const job = await getSetting(keys(accountKey).job);
        if (!job || !LIVE.has(job.status)) return stateOf(job);
        job.status = 'paused'; return publish(job);
      });
    },
    resume({ account, tabId }) {
      validateAccount(account); validateTab(tabId);
      return locked(account.accountKey, async () => {
        const job = await load(account);
        if (!job) return createJob(account, tabId, account.initialized ? 'incremental' : 'initial');
        try { await directoryFor(account); await verify(account, tabId); }
        catch (error) { return handleError(job, error); }
        job.tabId = tabId; return resumeJob(job);
      });
    },
    async getState(accountKey) { return stateOf(await getSetting(keys(accountKey).job)); },
    suspend(accountKey, code = 'SOURCE_UNAVAILABLE') {
      return locked(accountKey, async () => {
        const job = await getSetting(keys(accountKey).job);
        if (!job || job.status !== 'running') return stateOf(job);
        job.status = 'blocked'; job.error = safeError(fail(code));
        return publish(job);
      });
    },
    reset(accountKey) {
      return locked(accountKey, async () => {
        await store(keys(accountKey).index, null);
        await store(keys(accountKey).job, null);
        try { await onChange(null); } catch { /* UI event only. */ }
        return null;
      });
    },
    async getOutbox(accountKey) {
      const state = outboxState(await getSetting(keys(accountKey).outbox));
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
    enqueueArchive({ account, archive }) {
      validateAccount(account);
      return locked(account.accountKey, async () => {
        const id = archive?.entry?.conversationId;
        if (!id || !Array.isArray(archive?.files)) throw fail('STORAGE');
        await appendOutbox(account, { id }, archive.files);
      });
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
