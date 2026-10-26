import { buildArchive, RENDERER_VERSION } from './archive.js';
import { analyzeAssets, reconcileAssetCapturePolicy } from './assets.js';
import { getSetting, setSetting } from './storage.js';
import { sanitizeMessageSync, selectMessageSync } from './message-sync-receipt.js';
import { inspectMessageGeneration } from './message-generation.js';

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_BATCH_BYTES = 48 * 1024 * 1024;
const locks = new WeakMap();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => `${JSON.stringify(value, null, 2)}\n`;

/** Upgrade known older derived formats, never downgrade a future renderer. */
export function needsMarkdownRefresh(entry) {
  if (!entry) return false;
  if (entry.rendererVersion == null) return true;
  const previous = /^rich-([1-9][0-9]*)$/.exec(entry.rendererVersion);
  const current = /^rich-([1-9][0-9]*)$/.exec(RENDERER_VERSION);
  return Boolean(previous && current && Number(previous[1]) < Number(current[1]));
}

export class ArchiveStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'ArchiveStoreError'; this.code = code; }
}
function fail(code, message) { throw new ArchiveStoreError(code, message); }
function safeSegment(value, maximum = 120) {
  return typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}
export function accountPrefix(account) {
  if (account?.platform !== 'chatgpt' || !safeSegment(account.accountKey) || !safeSegment(account.storageKey)) {
    fail('ACCOUNT_INVALID', '账号归档标识无效，未写入文件。');
  }
  return `data/web/chatgpt/${account.storageKey}`;
}
function validatePath(path, prefix) {
  if (typeof path !== 'string' || !path.startsWith(`${prefix}/`) || path.length > 1024 ||
      path.split('/').some(part => !part || part === '.' || part === '..' ||
        /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part))) {
    fail('ARCHIVE_PATH', '归档文件路径不安全或不属于当前账号。');
  }
}
async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function sourceTime(value) {
  if (typeof value === 'string') {
    value = value.trim();
    if (!value) return null;
    if (/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) value = Number(value);
  }
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const ms = typeof value === 'number' ? value * (value >= 1e12 ? 1 : 1000) : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(Math.trunc(ms));
  return date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 9999 ? date.toISOString() : null;
}

const hasTree = native => record(native?.mapping) && Object.keys(native.mapping).length > 0;

function assertNativeNotPartial(native) {
  if (!record(native)) return; // The archive builder reports malformed outer data.
  const partial = () => fail('PARTIAL_DETAIL', '原始详情仍有未读取内容或尚不能确认已结束的消息，已有归档保持不变。');
  if (['is_incomplete', 'has_more', 'has_more_messages', 'has_next_page', 'has_previous_page'].some(key => native[key] === true) ||
      ['has_more', 'has_next_page', 'has_previous_page'].some(key => native.page_info?.[key] === true)) partial();
  if (record(native.mapping) && Object.keys(native.mapping).length) {
    const mapping = native.mapping;
    for (const node of Object.values(mapping)) {
      if (!record(node) || (node.message != null && !record(node.message))) partial();
      if (node.parent != null && (typeof node.parent !== 'string' || !own(mapping, node.parent))) partial();
      if (node.children !== undefined && (!Array.isArray(node.children) ||
          node.children.some(id => typeof id !== 'string' || !own(mapping, id)))) partial();
    }
    const verified = new Set();
    for (const key of Object.keys(mapping)) {
      const chain = new Set();
      let cursor = key;
      while (cursor != null && !verified.has(cursor)) {
        if (chain.has(cursor)) partial();
        chain.add(cursor); cursor = mapping[cursor].parent;
      }
      for (const id of chain) verified.add(id);
    }
  }
  // Recompute from native nodes after validating the graph. Caller or remote
  // generation metadata cannot turn an unresolved message into a stable one.
  if (inspectMessageGeneration(native).unresolvedUnfinishedCount > 0) partial();
}
async function ensurePermission(directory) {
  if (directory?.kind !== 'directory' || typeof directory.queryPermission !== 'function') {
    fail('DIRECTORY_REQUIRED', '请先在设置中选择保存文件夹。');
  }
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    fail('DIRECTORY_PERMISSION', '保存目录需要重新授权，请在设置中恢复目录权限。');
  }
}
async function parent(directory, path, create = false) {
  const parts = path.split('/');
  const name = parts.pop();
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}
async function read(directory, path) {
  try {
    const target = await parent(directory, path);
    const file = await (await target.directory.getFileHandle(target.name)).getFile();
    if (file.size > MAX_FILE_BYTES) fail('ARCHIVE_SIZE', '归档文件超过大小限制，未覆盖已有文件。');
    return file.text();
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}
function parse(text) {
  try { return JSON.parse(text); }
  catch { fail('ARCHIVE_FORMAT', '现有归档清单或账号文件无法解析，未覆盖。'); }
}
function validateManifest(manifest, account) {
  const prefix = accountPrefix(account);
  if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.platform !== account.platform ||
      manifest.accountKey !== account.accountKey || !record(manifest.conversations)) {
    fail('ACCOUNT_MISMATCH', '现有归档清单不属于当前账号，已停止写入。');
  }
  const paths = new Set();
  for (const [id, entry] of Object.entries(manifest.conversations)) {
    if (!safeSegment(id, 160) || !record(entry) || entry.conversationId !== id ||
        !/^[a-f0-9]{64}$/.test(entry.contentHash || '') || !/^[a-f0-9]{64}$/.test(entry.markdownHash || '') ||
        typeof entry.jsonPath !== 'string' || !entry.jsonPath.startsWith(`${prefix}/conversations/`) ||
        !entry.jsonPath.endsWith(`__${id}.json`) || entry.markdownPath !== entry.jsonPath.replace(/\.json$/, '.md')) {
      fail('ARCHIVE_FORMAT', '现有归档清单的对话标识、路径或校验值无效，未覆盖。');
    }
    for (const path of [entry.jsonPath, entry.markdownPath]) {
      validatePath(path, prefix);
      if (paths.has(path)) fail('ARCHIVE_FORMAT', '现有清单包含重复文件路径，未覆盖。');
      paths.add(path);
    }
  }
  return manifest;
}

export async function readAccountManifest(directory, account) {
  const prefix = accountPrefix(account);
  await ensurePermission(directory);
  const accountText = await read(directory, `${prefix}/account.json`);
  if (accountText !== null) {
    const stored = parse(accountText);
    if (!record(stored) || stored.platform !== account.platform || stored.accountKey !== account.accountKey || stored.dataPath !== prefix) {
      fail('ACCOUNT_MISMATCH', '此目录已有其他账号的数据，已停止写入。');
    }
  }
  const text = await read(directory, `${prefix}/archive/manifest.json`);
  return text === null ? null : validateManifest(parse(text), account);
}

/** Read only a verified complete source as the starting point for a tail merge. */
export async function readConversationBaseline(directory, account, conversationId, { get = getSetting } = {}) {
  accountPrefix(account);
  if (!safeSegment(conversationId, 160)) fail('ARCHIVE_FORMAT', '对话标识无效，未读取增量基线。');
  await ensurePermission(directory);
  // A journal may have written the new JSON before the old manifest changed.
  // Let saveConversation replay it rather than treating those bytes as edits.
  if (await get(`archiveJournal:${account.platform}:${account.accountKey}`)) return null;
  const manifest = await readAccountManifest(directory, account);
  const entry = own(manifest?.conversations || {}, conversationId) ? manifest.conversations[conversationId] : null;
  if (!entry || entry.sourceCompleteness !== 'complete') return null;
  const text = await read(directory, entry.jsonPath);
  if (text === null || !text.trim()) return null;
  if (await digest(text) !== entry.contentHash) fail('LOCAL_CONFLICT', '本地对话 JSON 与归档清单不一致，未用作增量基线。');
  const payload = parse(text);
  if (!record(payload) || (!hasTree(payload) && !Array.isArray(payload.messages)) || (payload.conversation_id ?? payload.id) !== conversationId ||
      (payload.conversation_id && payload.id && payload.conversation_id !== payload.id)) {
    fail('ARCHIVE_FORMAT', '本地对话 ID 与清单不一致，未用作增量基线。');
  }
  assertNativeNotPartial(payload);
  return { payload, entry };
}

/** Read an immutable, verified local snapshot for optional cloud backfill. */
export async function readConversationArchive(directory, account, conversationId, { get = getSetting } = {}) {
  const prefix = accountPrefix(account);
  if (!safeSegment(conversationId, 160)) fail('ARCHIVE_FORMAT', '对话标识无效，未读取本地归档。');
  await ensurePermission(directory);
  if (await get(`archiveJournal:${account.platform}:${account.accountKey}`)) {
    fail('LOCAL_PENDING', '本地还有未完成的文件写入，请恢复保存后继续。');
  }
  const manifest = await readAccountManifest(directory, account);
  const entry = own(manifest?.conversations || {}, conversationId) ? manifest.conversations[conversationId] : null;
  if (!entry) fail('ARCHIVE_MISSING', '本地未找到该对话的归档记录。');
  const nativeText = await read(directory, entry.jsonPath), markdownText = await read(directory, entry.markdownPath);
  const accountText = await read(directory, `${prefix}/account.json`);
  if (nativeText === null || markdownText === null || accountText === null) {
    fail('ARCHIVE_MISSING', '本地归档文件缺失，请先补齐后再备份。');
  }
  if (await digest(nativeText) !== entry.contentHash || await digest(markdownText) !== entry.markdownHash) {
    fail('LOCAL_CONFLICT', '本地文件与归档记录不一致，已保留原文件。');
  }
  const native = parse(nativeText), storedAccount = parse(accountText);
  if (!record(native) || (native.conversation_id ?? native.id) !== conversationId ||
      (native.conversation_id && native.id && native.conversation_id !== native.id)) {
    fail('ARCHIVE_FORMAT', '本地对话标识与清单不一致。');
  }
  if (storedAccount.accountKey !== account.accountKey || storedAccount.platform !== account.platform || storedAccount.dataPath !== prefix) {
    fail('ACCOUNT_MISMATCH', '本地账号记录与当前归档不一致。');
  }
  assertNativeNotPartial(native);
  // A source or attachment writer may have advanced the manifest while files
  // were read. Never enqueue an old body with a newer descriptor.
  const latest = await readAccountManifest(directory, account);
  if (json(latest?.conversations?.[conversationId]) !== json(entry) ||
      await get(`archiveJournal:${account.platform}:${account.accountKey}`)) {
    fail('LOCAL_PENDING', '本地归档正在更新，请稍后重新读取。');
  }
  const scopedManifest = { ...manifest, conversations: { [conversationId]: entry } };
  const files = [
    { path: entry.jsonPath, content: nativeText }, { path: entry.markdownPath, content: markdownText },
    { path: `${prefix}/archive/manifest.json`, content: json(scopedManifest) },
    { path: `${prefix}/account.json`, content: accountText },
  ];
  if (files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0) > MAX_BATCH_BYTES) {
    fail('ARCHIVE_SIZE', '本地归档超过本次读取大小限制。');
  }
  return { entry, files };
}

/** Cheap presence check for incremental scans; it does not read or hash history. */
export async function hasConversationFiles(directory, account, entry) {
  // Reuse the writer's ownership/path rules before touching either file.
  validateManifest({ schemaVersion: 1, platform: account?.platform, accountKey: account?.accountKey,
    conversations: { [entry?.conversationId]: entry } }, account);
  await ensurePermission(directory);
  for (const path of [entry.jsonPath, entry.markdownPath]) {
    try {
      const target = await parent(directory, path);
      const file = await (await target.directory.getFileHandle(target.name)).getFile();
      if (!Number.isFinite(file.size) || file.size <= 0) return false;
    } catch (error) {
      if (error?.name === 'NotFoundError') return false;
      throw error;
    }
  }
  return true;
}

function withLock(directory, key, operation) {
  let directoryLocks = locks.get(directory);
  if (!directoryLocks) { directoryLocks = new Map(); locks.set(directory, directoryLocks); }
  const previous = directoryLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  directoryLocks.set(key, next);
  return next.finally(() => { if (directoryLocks.get(key) === next) directoryLocks.delete(key); });
}

/** The injected journal store is for deterministic crash-recovery tests. Production uses IndexedDB. */
export function createArchiveStore({ get = getSetting, set = setSetting } = {}) {
  async function sameDirectory(left, right) {
    if (typeof left?.isSameEntry === 'function') return left.isSameEntry(right);
    return left === right;
  }
  function validatePlan(plan, account) {
    const prefix = accountPrefix(account);
    if (!record(plan) || plan.schemaVersion !== 1 || plan.accountKey !== account.accountKey || plan.prefix !== prefix ||
        !Array.isArray(plan.files) || plan.files.length !== 4 || !record(plan.expected) || !record(plan.result)) {
      fail('JOURNAL_INVALID', '未完成的本地保存记录无效，请保留目录并检查扩展存储。');
    }
    let bytes = 0;
    const paths = new Set();
    for (const file of plan.files) {
      validatePath(file.path, prefix);
      if (typeof file.content !== 'string' || paths.has(file.path) || !own(plan.expected, file.path)) {
        fail('JOURNAL_INVALID', '本地保存记录中的文件无效。');
      }
      paths.add(file.path);
      bytes += new TextEncoder().encode(file.content).length;
    }
    if (bytes > MAX_BATCH_BYTES) fail('ARCHIVE_SIZE', '本次归档超过保存大小限制，未覆盖已有文件。');
    validateManifest(plan.result.manifest, account);
  }
  async function execute(directory, account, plan, journalKey) {
    validatePlan(plan, account);
    if (!await sameDirectory(directory, plan.directory)) {
      fail('DIRECTORY_CHANGED', '还有未完成的本地保存，请恢复原保存目录后继续。');
    }
    await ensurePermission(directory);
    const expectedHashes = new Map();
    for (const file of plan.files) expectedHashes.set(file.path, await digest(file.content));
    async function allowed(file) {
      const content = await read(directory, file.path);
      if (content === null || (content === '' && plan.expected[file.path] === null)) return content;
      const hash = await digest(content);
      if (hash !== expectedHashes.get(file.path) && hash !== plan.expected[file.path]) {
        fail('LOCAL_CONFLICT', '检测到归档被其他程序修改，原文件已保留；请检查该对话后重试。');
      }
      return content;
    }
    // Check the complete group before touching any file. Recheck at each write as well.
    for (const file of plan.files) await allowed(file);
    const ordered = [...plan.files].sort((a, b) => Number(a.path.endsWith('/archive/manifest.json')) - Number(b.path.endsWith('/archive/manifest.json')));
    for (const file of ordered) {
      if (await allowed(file) === file.content) continue;
      const target = await parent(directory, file.path, true);
      const handle = await target.directory.getFileHandle(target.name, { create: true });
      const appeared = await handle.getFile();
      if (appeared.size > 0) {
        const content = await appeared.text();
        const hash = await digest(content);
        if (content === file.content) continue;
        if (hash !== plan.expected[file.path]) fail('LOCAL_CONFLICT', '目标文件在写入前发生变化，已保留原内容。');
      }
      let writer;
      try {
        writer = await handle.createWritable({ keepExistingData: false });
        await writer.write(file.content);
        await writer.close();
      } catch {
        try { await writer?.abort(); } catch { /* Already closed. */ }
        fail('LOCAL_WRITE', '本地写入中断，进度已保留，恢复目录权限或空间后可继续。');
      }
      if (await (await handle.getFile()).text() !== file.content) fail('LOCAL_VERIFY', '本地文件核对未通过，尚未标记保存成功。');
    }
    for (const file of plan.files) {
      if (await read(directory, file.path) !== file.content) fail('LOCAL_VERIFY', '本地文件在保存期间发生变化，尚未标记保存成功。');
    }
    // If clearing fails, the exact same plan remains safe to replay without duplicate writes.
    await set(journalKey, null);
    return { ...plan.result, files: plan.files };
  }
  async function saveUnlocked({ directory, account, detail, preferredEntry, assets, remoteMessageSync, preserveNativeHash }) {
    const prefix = accountPrefix(account);
    if (!detail?.identity || detail.identity.accountKey !== account.accountKey) {
      fail('ACCOUNT_MISMATCH', '采集结果与任务账号不一致，未写入文件。');
    }
    await ensurePermission(directory);
    const journalKey = `archiveJournal:${account.platform}:${account.accountKey}`;
    const pending = await get(journalKey);
    let recovered = null;
    if (pending) recovered = await execute(directory, account, pending, journalKey);
    const manifest = await readAccountManifest(directory, account);
    const native = detail.payload;
    // Remote imports do not pass through the website adapter. Never trust a
    // manifest's "complete" label over contradictory flags in the source JSON.
    assertNativeNotPartial(native);
    const id = native?.conversation_id ?? native?.id;
    const prior = manifest && own(manifest.conversations, id) ? manifest.conversations[id] : null;
    // A selected-branch array cannot replace a previously archived message tree:
    // it would silently erase the other branches, even with a newer timestamp.
    if (prior && !hasTree(native) && Array.isArray(native?.messages)) {
      const text = await read(directory, prior.jsonPath);
      if (text !== null && text !== '') {
        if (await digest(text) !== prior.contentHash) fail('LOCAL_CONFLICT', '已有对话 JSON 与清单不一致，未覆盖原文件。');
        if (hasTree(parse(text))) fail('PARTIAL_DETAIL', '分页结果仅包含当前分支，不能覆盖已有消息树及历史分支。');
      } else if (prior.messageSync?.format === 'tree' || prior.renderMode === 'current-branch') {
        fail('PARTIAL_DETAIL', '已有归档包含消息树，需要完整消息树恢复缺失文件。');
      }
    }
    // A remote import with no local copy keeps the canonical original filename.
    // Existing local names stay stable, even if another machine chose a different title.
    let builderManifest = manifest;
    if (!prior && preferredEntry) {
      builderManifest = structuredClone(manifest || { schemaVersion: 1, platform: account.platform, accountKey: account.accountKey, conversations: {} });
      Object.defineProperty(builderManifest.conversations, id, { value: preferredEntry, enumerable: true, writable: true, configurable: true });
      validateManifest(builderManifest, account);
    }
    const built = await buildArchive({ conversation: native, identity: detail.identity, capturedAt: detail.capturedAt,
      existingManifest: builderManifest, productionPrefix: prefix, assets: assets ?? prior?.assets ?? preferredEntry?.assets });
    const entry = built.manifest.conversations[id];
    if (preserveNativeHash && entry.contentHash !== preserveNativeHash) {
      fail('LOCAL_CONFLICT', '阅读文件重建需要修改原始 JSON，已停止并保留原文件。');
    }
    if (detail.completeness === 'partial' || built.summary.coverage.messages === 'partial') {
      fail('PARTIAL_DETAIL', '这条对话尚未完整读取或有消息尚不能确认已结束，已保留原归档，稍后重试。');
    }
    const updatedAt = sourceTime(native.update_time);
    const oldTime = sourceTime(prior?.sourceUpdatedAt);
    const contentChanged = prior && prior.contentHash !== entry.contentHash;
    if (contentChanged && updatedAt && oldTime && updatedAt < oldTime) {
      fail('STALE_DETAIL', '线上返回的版本早于已有归档，已保留较新数据，稍后重新核对。');
    }
    if (contentChanged && prior?.sourceCompleteness === 'complete' && detail.completeness !== 'complete') {
      fail('PARTIAL_DETAIL', '本次详情完整度尚未确认，已保留此前完整归档。');
    }
    if (contentChanged && Number.isInteger(prior?.messageCount) && built.summary.messageCount < prior.messageCount &&
        (!updatedAt || !oldTime || updatedAt <= oldTime)) {
      fail('PARTIAL_DETAIL', '返回的消息比已有归档少且无法确认是更新版本，已保留原文件。');
    }
    entry.sourceUpdatedAt = updatedAt;
    entry.sourceCompleteness = detail.completeness === 'complete' || (!contentChanged && prior?.sourceCompleteness === 'complete') ? 'complete' : 'unknown';
    entry.messageCount = built.summary.messageCount;
    const priorReceipt = !contentChanged ? sanitizeMessageSync(prior?.messageSync, native) : null;
    let receipt = sanitizeMessageSync(remoteMessageSync ?? detail.messageSync, native);
    if (entry.sourceCompleteness !== 'complete') receipt = null;
    if (detail.messageSync?.mode === 'tail-merge' && !remoteMessageSync) {
      // An earlier verified prefix cannot overwrite an archive advanced by a
      // different writer while the network request was in flight.
      const replayingSameTail = recovered?.entry?.conversationId === id &&
        pending?.expected?.[pending?.result?.entry?.jsonPath] === detail.baselineContentHash &&
        recovered.entry.contentHash === entry.contentHash && prior?.contentHash === entry.contentHash &&
        receipt !== null && json(sanitizeMessageSync(recovered.entry.messageSync, native)) === json(receipt);
      if (!/^[a-f0-9]{64}$/.test(detail.baselineContentHash || '') ||
          (prior?.contentHash !== detail.baselineContentHash && !replayingSameTail)) {
        fail('LOCAL_CONFLICT', '增量读取期间已有归档发生变化，未用旧历史覆盖新版本。');
      }
      const previous = sanitizeMessageSync(prior?.messageSync, native);
      if (!receipt || (!replayingSameTail && (!previous || receipt.fullReadAt !== previous.fullReadAt ||
          receipt.checkedAt < previous.checkedAt || receipt.incrementalRuns !== previous.incrementalRuns + 1))) {
        fail('PARTIAL_DETAIL', '增量核对记录无效或未继承全量基线，未保存本次合成结果。');
      }
    }
    // Image-only rewrites preserve a valid receipt. A changed source without a
    // new receipt cannot inherit an unrelated previous full-history check.
    if (priorReceipt) receipt = remoteMessageSync ? selectMessageSync(native, priorReceipt, receipt) : receipt || priorReceipt;
    if (receipt) entry.messageSync = receipt;
    else delete entry.messageSync;
    const manifestFile = built.files.find(file => file.path.endsWith('/archive/manifest.json'));
    manifestFile.content = json(built.manifest);
    const accountFile = built.files.find(file => file.path.endsWith('/account.json'));
    accountFile.content = json({ schemaVersion: 1, platform: account.platform, accountKey: account.accountKey,
      displayName: account.displayName || detail.identity.displayName || account.alias || account.accountKey,
      alias: account.alias || detail.identity.displayName || account.accountKey, storageKey: account.storageKey,
      dataPath: prefix, purpose: 'conversation-archive' });
    const expected = {};
    for (const file of built.files) {
      validatePath(file.path, prefix);
      const current = await read(directory, file.path);
      const currentHash = current === null ? null : await digest(current);
      if (file.path === entry.jsonPath || file.path === entry.markdownPath) {
        const priorHash = file.path === entry.jsonPath ? prior?.contentHash : prior?.markdownHash;
        const desiredHash = file.path === entry.jsonPath ? entry.contentHash : entry.markdownHash;
        if (currentHash !== null && currentHash !== priorHash && currentHash !== desiredHash) {
          fail('LOCAL_CONFLICT', '检测到对话文件被手动修改，原文件已保留；请检查该对话后重试。');
        }
      }
      expected[file.path] = currentHash;
    }
    // A changed manifest between initial load and journal preparation is an external writer.
    const existingManifestText = await read(directory, manifestFile.path);
    if ((manifest === null) !== (existingManifestText === null) ||
        (manifest !== null && json(parse(existingManifestText)) !== json(manifest))) {
      fail('LOCAL_CONFLICT', '归档清单被其他任务更新，请稍后重试。');
    }
    const result = { manifest: built.manifest, entry,
      status: !prior ? 'added' : contentChanged ? 'updated' : 'unchanged', warnings: built.summary.warnings };
    const plan = { schemaVersion: 1, accountKey: account.accountKey, prefix, directory,
      files: built.files, expected, result };
    validatePlan(plan, account);
    await set(journalKey, plan);
    const written = await execute(directory, account, plan, journalKey);
    if (recovered && recovered.entry.conversationId !== entry.conversationId) written.recovered = recovered;
    else if (recovered?.entry.contentHash === entry.contentHash) written.status = recovered.status;
    return written;
  }
  function saveConversation(input) {
    accountPrefix(input.account);
    if (!input.directory || typeof input.directory !== 'object') return Promise.reject(new ArchiveStoreError('DIRECTORY_REQUIRED', '请选择保存目录。'));
    return withLock(input.directory, input.account.accountKey, () => saveUnlocked(input));
  }
  function repairMissingMarkdown({ directory, account, conversationId }) {
    accountPrefix(account);
    if (!safeSegment(conversationId, 160)) return Promise.reject(new ArchiveStoreError('ARCHIVE_FORMAT', '对话标识无效。'));
    if (!directory || typeof directory !== 'object') return Promise.reject(new ArchiveStoreError('DIRECTORY_REQUIRED', '请选择保存目录。'));
    return withLock(directory, account.accountKey, async () => {
      await ensurePermission(directory);
      const journalKey = `archiveJournal:${account.platform}:${account.accountKey}`;
      const pending = await get(journalKey);
      if (pending && pending.result?.entry?.conversationId !== conversationId) {
        // The original owner must finish delivery of another conversation's
        // checkpoint. A Markdown repair must not clear that unrelated receipt.
        fail('LOCAL_PENDING', '另一个对话还有未完成的保存，请恢复后继续本地检查。');
      }
      const recovered = pending ? await execute(directory, account, pending, journalKey) : null;
      const manifest = await readAccountManifest(directory, account);
      const entry = manifest?.conversations?.[conversationId];
      if (!entry) fail('ARCHIVE_MISSING', '本地未找到该对话的归档记录。');
      const markdown = await read(directory, entry.markdownPath);
      if (markdown !== null) {
        // Existing empty or user-edited files are not disposable. A journal
        // created by this writer is the only authority to recover its output.
        if (!markdown || await digest(markdown) !== entry.markdownHash) {
          fail('LOCAL_CONFLICT', '本地阅读文件与记录不一致，已保留原文件。');
        }
        if (!needsMarkdownRefresh(entry)) {
          return { repaired: Boolean(recovered?.entry?.conversationId === conversationId), recovered };
        }
        // A derived-format upgrade follows the same guarded journal path as a
        // missing file. Matching the old Markdown digest is required before
        // regenerating it; source JSON and account ownership are checked below.
      }
      const nativeText = await read(directory, entry.jsonPath);
      if (nativeText === null) fail('ARCHIVE_MISSING', '原始 JSON 缺失，需要重新采集该对话。');
      if (!nativeText || await digest(nativeText) !== entry.contentHash) {
        fail('LOCAL_CONFLICT', '原始 JSON 与归档记录不一致，未重建阅读文件。');
      }
      const native = parse(nativeText);
      if (!record(native) || (native.conversation_id ?? native.id) !== conversationId) {
        fail('ARCHIVE_FORMAT', '原始 JSON 的对话标识不一致。');
      }
      const saved = await saveUnlocked({ directory, account, assets: entry.assets,
        preserveNativeHash: entry.contentHash, detail: {
          identity: { accountKey: account.accountKey, displayName: account.displayName || account.alias || account.accountKey },
          payload: native, capturedAt: sourceTime(entry.firstCapturedAt) || sourceTime(entry.lastChangedAt) || new Date().toISOString(),
          completeness: entry.sourceCompleteness === 'complete' ? 'complete' : 'unknown',
        } });
      if (recovered) saved.recovered = recovered;
      return { ...saved, repaired: true };
    });
  }
  async function applyRemoteFiles({ directory, account, files }) {
    const prefix = accountPrefix(account);
    if (!Array.isArray(files) || files.length !== 4) fail('REMOTE_ARCHIVE', '远端归档缺少同版本的数据、阅读文件或账号清单。');
    const contents = new Map();
    let bytes = 0;
    for (const file of files) {
      validatePath(file?.path, prefix);
      if (typeof file.content !== 'string' || contents.has(file.path)) fail('REMOTE_ARCHIVE', '远端归档文件内容或路径无效。');
      bytes += new TextEncoder().encode(file.content).length;
      if (bytes > MAX_BATCH_BYTES) fail('ARCHIVE_SIZE', '远端归档超过本次保存大小限制。');
      contents.set(file.path, file.content);
    }
    const remoteAccount = parse(contents.get(`${prefix}/account.json`));
    if (!record(remoteAccount) || remoteAccount.accountKey !== account.accountKey || remoteAccount.platform !== account.platform || remoteAccount.dataPath !== prefix) {
      fail('ACCOUNT_MISMATCH', '远端归档不属于当前账号，未写入本地。');
    }
    const manifest = validateManifest(parse(contents.get(`${prefix}/archive/manifest.json`)), account);
    const entries = Object.values(manifest.conversations).filter(entry => contents.has(entry.jsonPath));
    if (entries.length !== 1) fail('REMOTE_ARCHIVE', '远端归档无法确定唯一待恢复对话。');
    const entry = entries[0];
    const nativeText = contents.get(entry.jsonPath), markdownText = contents.get(entry.markdownPath);
    if (typeof markdownText !== 'string' || await digest(nativeText) !== entry.contentHash || await digest(markdownText) !== entry.markdownHash) {
      fail('REMOTE_HASH', '远端归档的文件摘要不匹配，已有本地文件未覆盖。');
    }
    if (entry.sourceCompleteness === 'partial' || entry.coverage?.messages === 'partial' || entry.coverage?.branches === 'partial') {
      fail('PARTIAL_DETAIL', '远端归档标记为部分内容，未替换本地档案。');
    }
    const native = parse(nativeText);
    if (!record(native) || (native.conversation_id ?? native.id) !== entry.conversationId) {
      fail('REMOTE_ARCHIVE', '远端对话 ID 与清单不一致，未写入本地。');
    }
    const capturedAt = sourceTime(entry.lastChangedAt) || sourceTime(entry.firstCapturedAt) || new Date().toISOString();
    const localManifest = await readAccountManifest(directory, account);
    const localEntry = localManifest?.conversations?.[entry.conversationId];
    // Only the hash-verified native conversation decides whether a descriptor
    // is a real attachment, an ordinary file-viewer link or an internal image.
    const analysis = await analyzeAssets(native);
    const extracted = new Map(analysis.assets.map(asset => [asset.id, asset]));
    const ordinaryLinkIds = new Set(analysis.ordinaryLinkIds);
    const protectedLinkRecord = asset => asset && (asset.sourceType !== 'external' || asset.localPath || asset.oid || asset.sha256);
    let assets = entry.assets;
    if (localEntry?.contentHash === entry.contentHash && Array.isArray(localEntry.assets)) {
      const merged = new Map((entry.assets || []).map(asset => [asset.id, asset]));
      for (const asset of localEntry.assets) {
        const remote = merged.get(asset.id);
        // The inverse also matters: an older verified external link is not
        // richer than a remote pending record that still owns recovery evidence.
        if (ordinaryLinkIds.has(asset.id) && protectedLinkRecord(remote) && !protectedLinkRecord(asset)) continue;
        // Do not let a stale pending remote record erase local saved/recovery
        // evidence before the ordinary-link filter below sees it.
        if (!remote || (ordinaryLinkIds.has(asset.id) && protectedLinkRecord(asset) && !protectedLinkRecord(remote)) ||
            (asset.status === 'downloaded' && remote.status !== 'downloaded') ||
            (asset.status === 'external' && remote.status === 'pending')) merged.set(asset.id, asset);
        else if (reconcileAssetCapturePolicy(asset, extracted.get(asset.id)).autoRetrySuspended &&
            !['downloaded', 'ready', 'local', 'synced', 'external'].includes(remote.status)) {
          merged.set(asset.id, { ...remote, errorCode: 'HTTP_404', autoRetrySuspended: true });
        }
      }
      assets = [...merged.values()];
    }
    if (Array.isArray(assets)) assets = assets.filter(asset => !ordinaryLinkIds.has(asset.id) || protectedLinkRecord(asset))
      .map(asset => reconcileAssetCapturePolicy(asset, extracted.get(asset.id)));
    const result = await saveConversation({ directory, account, preferredEntry: entry, assets,
      remoteMessageSync: sanitizeMessageSync(entry.messageSync, native), detail: {
      identity: { accountKey: account.accountKey, displayName: account.displayName || remoteAccount.displayName || account.alias },
      payload: native, capturedAt, completeness: entry.sourceCompleteness === 'complete' ? 'complete' : 'unknown',
    } });
    return { ...result, remotePaths: { jsonPath: entry.jsonPath, markdownPath: entry.markdownPath } };
  }
  return {
    readAccountManifest,
    readConversationBaseline: (directory, account, conversationId) => readConversationBaseline(directory, account, conversationId, { get }),
    readConversationArchive: (directory, account, conversationId) => readConversationArchive(directory, account, conversationId, { get }),
    repairMissingMarkdown,
    saveConversation,
    applyRemoteFiles,
  };
}

const production = createArchiveStore();
export const saveConversation = input => production.saveConversation(input);
export const applyRemoteFiles = input => production.applyRemoteFiles(input);
export const repairMissingMarkdown = input => production.repairMissingMarkdown(input);
