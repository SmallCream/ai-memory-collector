/** Bounded local checks and repair; this module never reads the source website. */
import { accountPrefix, readAccountManifest as defaultReadManifest,
  readConversationArchive as defaultReadArchive, repairMissingMarkdown as defaultRepairMarkdown,
  needsMarkdownRefresh } from './archive-store.js';
import { validateAssetPath } from './asset-store.js';
import { getSetting as defaultGet, setSetting as defaultSet } from './storage.js';

const DAY = 24 * 60 * 60_000;
const MAX_REPORTS = 200;
const key = account => `localMaintenance:${account.accountKey}`;
const clone = value => value == null ? value : structuredClone(value);
const fail = code => Object.assign(new Error(code === 'DIRECTORY_PERMISSION' ? '请恢复保存目录权限。' : '本地检查尚未完成，已有文件已保留。'), { code });
const codeOf = error => /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code :
  error?.name === 'NotAllowedError' ? 'DIRECTORY_PERMISSION' : 'LOCAL_CHECK';

async function sameDirectory(left, right) {
  if (left === right) return true;
  try { return Boolean(left && right && await left.isSameEntry(right)); } catch { return false; }
}

async function metadata(directory, path) {
  let parent = directory;
  const parts = path.split('/'), name = parts.pop();
  try {
    for (const part of parts) parent = await parent.getDirectoryHandle(part);
    return await (await parent.getFileHandle(name)).getFile();
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

export function createLocalMaintenance({ getSetting = defaultGet, setSetting = defaultSet,
  readAccountManifest = defaultReadManifest, readConversationArchive = defaultReadArchive,
  repairMissingMarkdown = defaultRepairMarkdown, enqueueArchive = async () => {},
  requeueMissing = async () => ({ queued: false }), now = Date.now, batchSize = 12,
} = {}) {
  const locks = new Map();
  const limit = Math.max(1, Math.min(50, Number.isInteger(batchSize) ? batchSize : 12));
  function locked(account, action) {
    accountPrefix(account);
    const previous = locks.get(account.accountKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(account.accountKey, next);
    void next.finally(() => { if (locks.get(account.accountKey) === next) locks.delete(account.accountKey); }).catch(() => {});
    return next;
  }
  async function read(account) {
    const saved = await getSetting(key(account));
    if (!saved) return null;
    if (saved.schemaVersion !== 1 || saved.accountKey !== account.accountKey || saved.storageKey !== account.storageKey) throw fail('ACCOUNT_MISMATCH');
    return saved;
  }
  function publicState(value) {
    if (!value) return { status: 'idle', runnable: false, missingConversations: [] };
    const { directory, afterId, currentId, phase, assetAfterId, deliveryConversationId, deliveryBefore, ...result } = value;
    return { ...clone(result), runnable: value.status === 'running' || value.status === 'requested' };
  }
  function initial(account, directory, manual = false) {
    return { schemaVersion: 1, accountKey: account.accountKey, storageKey: account.storageKey, directory,
      status: 'running', startedAt: now(), completedAt: null, nextRunAt: 0, manual,
      afterId: '', currentId: null, phase: 'json', assetAfterId: '',
      checked: 0, conversationsChecked: 0, totalConversations: 0, repairedMarkdown: 0,
      missingAttachments: 0, missingConversationCount: 0, missingConversations: [],
      conflicts: 0, errors: [], lastError: null };
  }
  function report(state, conversationId, code, assetId = null) {
    state.conflicts++;
    if (state.errors.length < MAX_REPORTS) state.errors.push({ conversationId, ...(assetId ? { assetId } : {}), code });
  }
  async function start({ account }) {
    return locked(account, async () => {
      const previous = await read(account);
      if (previous?.status === 'running' || previous?.status === 'requested') {
        previous.manual = true; await setSetting(key(account), previous); return publicState(previous);
      }
      const next = { ...(previous || initial(account, null)), status: 'requested', nextRunAt: 0, lastError: null, manual: true };
      await setSetting(key(account), next);
      return publicState(next);
    });
  }
  async function deliverRepair(directory, account, state) {
    const conversationId = state.deliveryConversationId;
    if (!conversationId) return;
    const journalKey = `archiveJournal:${account.platform}:${account.accountKey}`;
    const pendingBefore = await getSetting(journalKey);
    // The intent is committed before writing Markdown. If the worker stops
    // after writing, the next tick still delivers the verified repaired files.
    try {
      const repaired = await repairMissingMarkdown({ directory, account, conversationId });
      if (repaired?.recovered?.files) await enqueueArchive({ account, archive: repaired.recovered });
      const archive = await readConversationArchive(directory, account, conversationId);
      await enqueueArchive({ account, archive });
      state.repairedMarkdown++;
    } catch (error) {
      const before = state.deliveryBefore;
      // A user-edited old Markdown must not block all following conversations.
      // Skip only a migration proven not to have committed anything: no journal
      // existed on entry or remains now, and the manifest is still the exact
      // old snapshot. Older delivery intents without this proof remain pending.
      if (error?.code !== 'LOCAL_CONFLICT' || !before || !needsMarkdownRefresh(before) || pendingBefore ||
          await getSetting(journalKey)) throw error;
      const manifest = await readAccountManifest(directory, account), current = manifest?.conversations?.[conversationId];
      if (!current || current.contentHash !== before.contentHash || current.markdownHash !== before.markdownHash ||
          (current.rendererVersion ?? null) !== before.rendererVersion) throw error;
      report(state, conversationId, 'LOCAL_CONFLICT');
    }
    state.deliveryConversationId = null;
    state.deliveryBefore = null;
    state.phase = 'assets';
    await setSetting(key(account), state);
  }
  async function tick({ directory, account, force = false }) {
    return locked(account, async () => {
      let state = await read(account);
      const same = state && await sameDirectory(state.directory, directory);
      if (state && same && !force && !['running', 'requested'].includes(state.status) && state.nextRunAt > now()) return publicState(state);
      if (!directory || await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        if (state) {
          state.status = 'blocked'; state.lastError = { code: 'DIRECTORY_PERMISSION' }; state.nextRunAt = now() + 60_000;
          await setSetting(key(account), state);
        }
        return { ...publicState(state), status: 'blocked', runnable: false, lastError: { code: 'DIRECTORY_PERMISSION' } };
      }
      if (state?.deliveryConversationId && !same) {
        state.status = 'blocked'; state.lastError = { code: 'DIRECTORY_CHANGED' }; state.nextRunAt = now() + DAY;
        await setSetting(key(account), state); return publicState(state);
      }
      const manual = force || state?.status === 'requested' && state?.manual === true;
      if (!state || !same || ['completed', 'partial', 'idle'].includes(state.status) ||
          (state.status === 'requested' && state.completedAt !== null && !state.deliveryConversationId)) state = initial(account, directory, manual);
      else if (force) state.manual = true;
      state.status = 'running'; state.lastError = null;
      await setSetting(key(account), state);
      try {
        await deliverRepair(directory, account, state);
        const manifest = await readAccountManifest(directory, account);
        const entries = manifest?.conversations || {}, ids = Object.keys(entries).sort();
        state.totalConversations = ids.length;
        let remaining = limit;
        while (remaining > 0) {
          if (!state.currentId || !entries[state.currentId]) {
            state.currentId = ids.find(id => id > state.afterId) || null;
            state.phase = 'json'; state.assetAfterId = '';
          }
          if (!state.currentId) {
            state.status = state.conflicts || state.missingConversationCount || state.missingAttachments ? 'partial' : 'completed';
            state.completedAt = now(); state.nextRunAt = now() + DAY; break;
          }
          const id = state.currentId, entry = entries[id];
          const finishConversation = () => {
            state.afterId = id; state.currentId = null; state.phase = 'json'; state.assetAfterId = ''; state.conversationsChecked++;
          };
          if (state.phase === 'json') {
            const file = await metadata(directory, entry.jsonPath);
            state.checked++; remaining--;
            if (file === null) {
              state.missingConversationCount++;
              if (state.missingConversations.length < MAX_REPORTS) state.missingConversations.push(id);
              finishConversation();
            } else if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 24 * 1024 * 1024) {
              report(state, id, file.size > 24 * 1024 * 1024 ? 'ARCHIVE_SIZE' : 'LOCAL_CONFLICT'); finishConversation();
            } else state.phase = 'markdown';
          } else if (state.phase === 'markdown') {
            const file = await metadata(directory, entry.markdownPath);
            state.checked++; remaining--;
            const invalid = file !== null && (!Number.isFinite(file.size) || file.size <= 0 || file.size > 24 * 1024 * 1024);
            if (invalid) {
              report(state, id, 'LOCAL_CONFLICT');
              state.phase = 'assets';
            } else if (file === null || needsMarkdownRefresh(entry)) {
              // Old generated Markdown may exist but omit supported media.
              // The writer verifies both old digests before changing it. Store
              // delivery intent first so a restart cannot lose this upgrade.
              state.deliveryConversationId = id;
              state.deliveryBefore = needsMarkdownRefresh(entry) ? { contentHash: entry.contentHash,
                markdownHash: entry.markdownHash, rendererVersion: entry.rendererVersion ?? null } : null;
              await setSetting(key(account), state);
              await deliverRepair(directory, account, state);
            } else {
              state.phase = 'assets';
            }
          } else {
            const assets = (entry.assets || []).filter(asset => asset.status === 'downloaded' && asset.localPath)
              .sort((left, right) => left.id.localeCompare(right.id));
            const asset = assets.find(item => item.id > state.assetAfterId);
            if (!asset) { finishConversation(); continue; }
            state.checked++; remaining--;
            try {
              validateAssetPath(account, asset.localPath, asset.oid);
              const file = await metadata(directory, asset.localPath);
              if (file === null) {
                await requeueMissing({ directory, account, conversationId: id, assetId: asset.id, manual: state.manual === true });
                state.missingAttachments++;
              } else if (!Number.isSafeInteger(asset.size) || file.size !== asset.size) {
                report(state, id, 'ASSET_LOCAL_CONFLICT', asset.id);
              }
            } catch (error) {
              if (error?.name === 'NotAllowedError' || error?.code === 'DIRECTORY_PERMISSION') throw error;
              report(state, id, codeOf(error), asset.id);
            }
            state.assetAfterId = asset.id;
          }
          await setSetting(key(account), state);
        }
        await setSetting(key(account), state);
        return publicState(state);
      } catch (error) {
        state.status = 'blocked'; state.lastError = { code: codeOf(error) };
        state.nextRunAt = now() + (state.lastError.code === 'LOCAL_CONFLICT' ? DAY : 60_000);
        await setSetting(key(account), state);
        return publicState(state);
      }
    });
  }
  return { start, tick, state: account => locked(account, async () => publicState(await read(account))) };
}
