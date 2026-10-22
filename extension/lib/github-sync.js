/** Atomic, private-repository archive sync. No page/session credentials enter this module. */
import { buildArchive } from './archive.js';
import { createGitHubClient, inspectGitHubRepository, commitProbe, GitHubProbeError } from './github.js';
import { formatLfsPointer } from './lfs.js';
import { ASSET_EXTENSIONS } from './asset-store.js';
import { analyzeAssets, reconcileAssetCapturePolicy } from './assets.js';
import { reconcileFileCitation } from './asset-reconciliation.js';
import { selectMessageSync } from './message-sync-receipt.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 512;
const encoder = new TextEncoder();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
const accountKeyPattern = /^acct-[a-f0-9]{24}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const READY_ASSETS = new Set(['downloaded', 'ready', 'local', 'synced']);
const LFS_RULE = 'assets/** filter=lfs diff=lfs merge=lfs -text';
function fail(code, message) { throw new GitHubProbeError(code, message); }
function json(value) { return JSON.stringify(value, null, 2) + '\n'; }
function parse(text, code = 'ARCHIVE_FORMAT') {
  try { const value = JSON.parse(text); if (record(value)) return value; } catch { /* Redact source. */ }
  fail(code, '归档结构无法解析，已有文件未覆盖。');
}
async function hash(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function blobHash(text) {
  const content = encoder.encode(text);
  const header = encoder.encode(`blob ${content.byteLength}\0`);
  const bytes = new Uint8Array(header.length + content.length);
  bytes.set(header); bytes.set(content, header.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function safePath(path) {
  if (typeof path !== 'string' || path.length > 1200 || !/^data\/web\/[a-z][a-z0-9-]*\/[^/]+\//.test(path) ||
      path.split('/').some(p => !p || p === '.' || p === '..' || /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(p) || /[. ]$/u.test(p))) {
    fail('ARCHIVE_PATH', '待同步文件路径无效或超出归档目录。');
  }
  return path.split('/').slice(0, 4).join('/');
}
function assetsOf(entry, prefix) {
  if (entry.assets === undefined) return [];
  if (!Array.isArray(entry.assets) || entry.assets.length > 4096) fail('ARCHIVE_ASSET', '对话资源清单无效。');
  const ids = new Set();
  for (const asset of entry.assets) {
    if (!record(asset) || !/^[a-f0-9]{64}$/.test(asset.id || '') || ids.has(asset.id)) fail('ARCHIVE_ASSET', '对话资源标识无效或重复。');
    ids.add(asset.id);
    if (asset.localPath !== undefined && (safePath(asset.localPath) !== prefix || !asset.localPath.startsWith(`${prefix}/assets/`))) {
      fail('ACCOUNT_OWNERSHIP', '资源路径超出当前账号目录。');
    }
    if (READY_ASSETS.has(asset.status)) {
      if (!/^[a-f0-9]{64}$/.test(asset.oid || '') || !Number.isSafeInteger(asset.size) || asset.size < 0 ||
          typeof asset.localPath !== 'string' ||
          !new RegExp(`^${asset.oid}\\.(${ASSET_EXTENSIONS})$`).test(asset.localPath.slice(prefix.length + '/assets/'.length))) {
        fail('ARCHIVE_ASSET', '已保存附件缺少有效的路径、内容摘要或大小。');
      }
    }
  }
  return entry.assets;
}
function validatePointers(bundles, supplied) {
  if (!Array.isArray(supplied) || supplied.length > MAX_FILES) fail('ARCHIVE_ASSET', 'LFS 指针列表无效或过多。');
  const references = new Map(), pointers = new Map();
  for (const bundle of bundles) for (const entry of bundle.entries) for (const asset of assetsOf(entry, bundle.prefix)) {
    if (!READY_ASSETS.has(asset.status)) continue;
    const expected = { accountKey: bundle.accountKey, path: asset.localPath, oid: asset.oid, size: asset.size,
      content: formatLfsPointer(asset) };
    const previous = references.get(asset.localPath);
    if (previous && !sameJSON(previous, expected)) fail('ARCHIVE_ASSET', '同一资源路径对应了不同内容。');
    references.set(asset.localPath, expected);
  }
  for (const pointer of supplied) {
    const reference = references.get(pointer?.path);
    if (!reference || pointer.accountKey !== reference.accountKey || pointer.oid !== reference.oid ||
        pointer.size !== reference.size || pointer.content !== reference.content) {
      fail('ACCOUNT_OWNERSHIP', 'LFS 指针不属于本批账号和对话资源，未提交。');
    }
    if (pointers.has(pointer.path) && pointers.get(pointer.path).content !== pointer.content) fail('ARCHIVE_ASSET', 'LFS 指针路径重复且内容不同。');
    pointers.set(pointer.path, { ...reference });
  }
  return { references, pointers };
}
async function mergeSameNativeAssets(localEntry, remoteEntry, prefix, native) {
  if (localEntry.assets === undefined && remoteEntry?.assets === undefined) return undefined;
  const result = new Map(assetsOf(localEntry, prefix).map(asset => [asset.id, asset]));
  for (const remoteAsset of assetsOf(remoteEntry || {}, prefix)) {
    const localAsset = result.get(remoteAsset.id);
    // A stable source resource already saved remotely must not become pending again.
    const preferred = !localAsset || READY_ASSETS.has(remoteAsset.status) || !READY_ASSETS.has(localAsset.status) ? remoteAsset : localAsset;
    const merged = { ...preferred };
    // A stale pending snapshot must not erase the other device's explicit
    // missing-internal-attachment result. Native evidence is checked below.
    if ([localAsset, remoteAsset].some(asset => asset?.capturePolicy === 'internal-viewer' &&
        asset.autoRetrySuspended === true && asset.errorCode === 'HTTP_404')) {
      merged.autoRetrySuspended = true;
      if (!READY_ASSETS.has(merged.status) && merged.status !== 'external') merged.errorCode = 'HTTP_404';
    }
    for (const field of ['references', 'occurrences']) if (Array.isArray(localAsset?.[field]) || Array.isArray(remoteAsset[field])) {
      merged[field] = [...new Map([localAsset, remoteAsset].flatMap(item => Array.isArray(item?.[field]) ? item[field] : []).map(value =>
        [typeof value === 'string' ? value : JSON.stringify(value), value])).values()];
    }
    result.set(remoteAsset.id, merged);
  }
  // The caller has verified account ownership, the local hash and identical
  // native content. Retire only aliases proven by that same conversation.
  const { assets: extracted, interfaceIconIds } = await analyzeAssets(native);
  for (const id of interfaceIconIds) result.delete(id);
  for (const asset of [...result.values()]) {
    if (!result.has(asset.id)) continue;
    const reconciled = await reconcileFileCitation(asset, [...result.values()], extracted);
    if (!reconciled.retired.length) continue;
    result.set(reconciled.asset.id, reconciled.asset);
    for (const id of reconciled.retired) result.delete(id);
  }
  const freshById = new Map(extracted.map(asset => [asset.id, asset]));
  return [...result.values()].map(asset => reconcileAssetCapturePolicy(asset, freshById.get(asset.id)));
}
function validateManifest(value, prefix, accountKey, platform) {
  if (!record(value) || value.schemaVersion !== 1 || value.accountKey !== accountKey || value.platform !== platform || !record(value.conversations)) {
    fail('ACCOUNT_OWNERSHIP', '远端或本地清单的账号归属不匹配，未覆盖。');
  }
  const seen = new Set();
  for (const [id, entry] of Object.entries(value.conversations)) {
    if (!idPattern.test(id) || !record(entry) || entry.conversationId !== id ||
        typeof entry.jsonPath !== 'string' || typeof entry.markdownPath !== 'string' ||
        !entry.jsonPath.startsWith(prefix + '/conversations/') || !entry.jsonPath.endsWith(`__${id}.json`) ||
        entry.markdownPath !== entry.jsonPath.replace(/\.json$/, '.md') ||
        !/^[a-f0-9]{64}$/.test(entry.contentHash || '') || !/^[a-f0-9]{64}$/.test(entry.markdownHash || '')) {
      fail('ARCHIVE_FORMAT', '归档清单的路径或摘要不合法，未覆盖。');
    }
    for (const path of [entry.jsonPath, entry.markdownPath]) {
      if (safePath(path) !== prefix || seen.has(path)) fail('ARCHIVE_PATH', '归档清单存在重复或越界路径。');
      seen.add(path);
    }
    assetsOf(entry, prefix);
  }
  return value;
}
function validateBundles(bundles) {
  if (!Array.isArray(bundles) || !bundles.length || bundles.length > 128) fail('ARCHIVE_INPUT', '没有有效的待同步归档。');
  let bytes = 0, count = 0;
  return bundles.map(bundle => {
    if (!accountKeyPattern.test(bundle?.accountKey || '') || !Array.isArray(bundle.files) || !bundle.files.length) fail('ARCHIVE_INPUT', '待同步归档缺少账号归属。');
    const files = new Map(); let prefix = null;
    for (const file of bundle.files) {
      const root = safePath(file?.path);
      if (prefix !== null && prefix !== root) fail('ACCOUNT_OWNERSHIP', '单次归档不能跨账号写入。');
      prefix = root;
      if (typeof file.content !== 'string' || files.has(file.path)) fail('ARCHIVE_INPUT', '待同步文件内容或路径不合法。');
      bytes += encoder.encode(file.content).byteLength; count++;
      if (bytes > MAX_BYTES || count > MAX_FILES) fail('ARCHIVE_SIZE', '本批同步内容过多，请分批重试。');
      files.set(file.path, file.content);
    }
    const platform = prefix.split('/')[2];
    const manifestPath = `${prefix}/archive/manifest.json`, accountPath = `${prefix}/account.json`;
    const manifest = validateManifest(parse(files.get(manifestPath)), prefix, bundle.accountKey, platform);
    const account = parse(files.get(accountPath));
    if (account.accountKey !== bundle.accountKey || account.platform !== platform || account.dataPath !== prefix) fail('ACCOUNT_OWNERSHIP', '账号文件与保存路径不匹配。');
    const entries = Object.values(manifest.conversations).filter(e => files.has(e.jsonPath));
    if (!entries.length) fail('ARCHIVE_INPUT', '待同步归档中没有对话 JSON。');
    const allowed = new Set([manifestPath, accountPath]);
    for (const entry of entries) {
      if (!files.has(entry.markdownPath)) fail('ARCHIVE_INPUT', '对话缺少同版本的 Markdown。');
      allowed.add(entry.jsonPath); allowed.add(entry.markdownPath);
    }
    if ([...files.keys()].some(path => !allowed.has(path))) fail('ARCHIVE_PATH', '待同步文件不属于本批对话。');
    return { accountKey: bundle.accountKey, prefix, platform, files, account, entries, manifest, manifestPath, accountPath };
  });
}
function sourceTime(value) {
  const candidate = value?.update_time ?? value?.updated_at;
  if (candidate == null || candidate === '') return null;
  const time = typeof candidate === 'number' ? candidate * 1000 : Date.parse(candidate);
  return Number.isFinite(time) && time >= 0 ? time : null;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function sameJSON(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function hasTree(native) { return record(native?.mapping) && Object.keys(native.mapping).length > 0; }
function isFlat(native) { return !hasTree(native) && Array.isArray(native?.messages); }
function applyMessageSync(entry, native, ...receipts) {
  const receipt = selectMessageSync(native, ...receipts);
  if (receipt) entry.messageSync = receipt;
  else delete entry.messageSync;
  return entry;
}
function completeEntry(entry) {
  return entry.sourceCompleteness !== 'partial' && entry.coverage?.messages !== 'partial' && entry.coverage?.branches !== 'partial';
}
function decodeBlob(data) {
  if (data?.encoding !== 'base64' || typeof data.content !== 'string' || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_BYTES || data.content.length > MAX_BYTES * 1.5) {
    fail('REMOTE_FILE_SIZE', '远端文件过大或无法安全读取，未覆盖。');
  }
  try {
    const raw = atob(data.content.replace(/\s/g, ''));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, x => x.charCodeAt(0)));
  } catch { fail('REMOTE_FILE_FORMAT', '远端文件不是有效的 UTF-8 文本，未覆盖。'); }
}
async function snapshot(api, head) {
  const commit = (await api.request(`/git/commits/${head}`)).data;
  if (!sha(commit?.tree?.sha)) fail('INVALID_RESPONSE', '无法确认远端提交的文件树。');
  const tree = (await api.request(`/git/trees/${commit.tree.sha}?recursive=1`)).data;
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) fail('REMOTE_TREE_INCOMPLETE', '远端文件清单不完整，本次未同步。');
  const entries = new Map();
  for (const entry of tree.tree) {
    if (typeof entry.path !== 'string' || !sha(entry.sha) || entries.has(entry.path)) fail('INVALID_RESPONSE', '远端文件树无法验证。');
    entries.set(entry.path, entry);
  }
  const contents = new Map(), blobs = new Map();
  async function read(path) {
    if (contents.has(path)) return contents.get(path);
    const entry = entries.get(path);
    if (!entry) { contents.set(path, null); return null; }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('REMOTE_PATH_TYPE', '归档路径被目录或链接占用，未覆盖。');
    if (!blobs.has(entry.sha)) {
      const data = (await api.request(`/git/blobs/${entry.sha}`)).data;
      const text = decodeBlob(data);
      if (await blobHash(text) !== entry.sha) fail('REMOTE_HASH', '远端文件摘要核对失败，未覆盖。');
      blobs.set(entry.sha, text);
    }
    const content = blobs.get(entry.sha); contents.set(path, content); return content;
  }
  function assertAncestors(path) {
    const pieces = path.split('/');
    for (let i = 1; i < pieces.length; i++) {
      const ancestor = entries.get(pieces.slice(0, i).join('/'));
      if (ancestor && ancestor.type !== 'tree') fail('REMOTE_PATH_TYPE', '归档父路径被文件占用，未覆盖。');
    }
  }
  return { head, treeSha: commit.tree.sha, entries, read, assertAncestors };
}
async function plan(api, remote, bundles, assetPlan) {
  const changes = new Map(), conflicts = [], remoteWinners = [];
  async function read(path) { return changes.has(path) ? changes.get(path) : remote.read(path); }
  async function put(path, content) {
    safePath(path); remote.assertAncestors(path);
    if (await remote.read(path) === content) changes.delete(path); else changes.set(path, content);
  }
  const assetPrefixes = new Set();
  async function ensureAsset(asset, prefix) {
    if (!READY_ASSETS.has(asset.status)) return;
    const expected = formatLfsPointer(asset);
    const current = await read(asset.localPath);
    if (current !== null && current !== expected) fail('ASSET_IMMUTABLE_CONFLICT', '远端附件路径已有不同内容，已保留原文件。');
    if (current === null) {
      const pointer = assetPlan.pointers.get(asset.localPath);
      if (!pointer || pointer.content !== expected) fail('LFS_ASSET_MISSING', '附件尚未上传 LFS，暂不提交引用该附件的归档。');
      await put(asset.localPath, pointer.content);
    }
    assetPrefixes.add(prefix);
  }
  // Validate every local ready reference, even if a newer remote conversation wins.
  for (const bundle of bundles) for (const entry of bundle.entries) for (const asset of assetsOf(entry, bundle.prefix)) {
    await ensureAsset(asset, bundle.prefix);
  }
  for (const bundle of bundles) {
    const { prefix, platform, accountKey, files, manifestPath, accountPath } = bundle;
    const accountText = await read(accountPath);
    if (accountText !== null) {
      const account = parse(accountText, 'REMOTE_ACCOUNT');
      if (account.accountKey !== accountKey || account.platform !== platform || account.dataPath !== prefix) fail('ACCOUNT_OWNERSHIP', '远端目录属于其他账号，已停止同步。');
    }
    const manifestText = await read(manifestPath);
    const manifest = manifestText === null ? { schemaVersion: 1, platform, accountKey, conversations: {} } :
      validateManifest(parse(manifestText, 'REMOTE_MANIFEST'), prefix, accountKey, platform);
    for (const localEntry of bundle.entries) {
      const id = localEntry.conversationId;
      const localJSON = files.get(localEntry.jsonPath), localMD = files.get(localEntry.markdownPath);
      if (await hash(localJSON) !== localEntry.contentHash || await hash(localMD) !== localEntry.markdownHash || !completeEntry(localEntry)) {
        fail('LOCAL_HASH', '本地归档摘要或完整性核对失败，未上传。');
      }
      const native = parse(localJSON);
      if ((native.conversation_id ?? native.id) !== id) fail('CONVERSATION_ID', '对话 ID 与归档清单不一致。');
      const previous = manifest.conversations[id];
      const jsonPath = previous?.jsonPath || localEntry.jsonPath;
      const markdownPath = previous?.markdownPath || localEntry.markdownPath;
      const remoteJSON = await read(jsonPath); let remoteMD = await read(markdownPath);
      let reason = null, remoteWins = false, sameNative = false, remoteContentHash = null;
      if (remoteJSON !== null) {
        remoteContentHash = await hash(remoteJSON);
        const managedJSON = previous && remoteContentHash === previous.contentHash;
        const managedMD = remoteMD === null || (previous && await hash(remoteMD) === previous.markdownHash);
        let remoteNative;
        try { remoteNative = JSON.parse(remoteJSON); } catch { /* Preserve malformed external edits. */ }
        if (!record(remoteNative)) reason = '远端 JSON 有人工修改或格式损坏';
        else if (remoteJSON === localJSON || sameJSON(remoteNative, native)) {
          sameNative = true;
          if (!managedMD && remoteMD !== localMD) reason = '远端 Markdown 有人工修改';
          // Preserve byte-stable native JSON if only whitespace/key ordering differs.
          else if (remoteJSON !== localJSON && previous) remoteWins = true;
        } else if (!managedJSON || !managedMD) {
          reason = '远端文件已被其他程序修改';
        } else if (!completeEntry(previous)) {
          reason = '远端快照不完整，未自动选为最新版';
        } else {
          const lt = sourceTime(native), rt = sourceTime(remoteNative);
          if (lt !== null && rt !== null && lt > rt) {
            if (hasTree(remoteNative) && isFlat(native)) reason = '较新的当前分支快照不能覆盖远端消息树及历史分支';
          } else if (lt !== null && rt !== null && lt < rt) {
            if (hasTree(native) && isFlat(remoteNative)) reason = '较新的远端当前分支快照不能覆盖本地消息树及历史分支';
            else remoteWins = true;
          }
          else reason = '同一来源时间存在不同内容或缺少可靠来源时间';
        }
      } else if (remoteMD !== null && (!previous || await hash(remoteMD) !== previous.markdownHash)) {
        reason = '远端阅读文件来源不明';
      }
      if (reason) {
        const conflictPath = `${prefix}/conflicts/${id}/${localEntry.contentHash}.json`;
        const conflictMD = conflictPath.replace(/\.json$/, '.md');
        for (const [path, content] of [[conflictPath, localJSON], [conflictMD, localMD]]) {
          const current = await read(path);
          if (current !== null && current !== content) fail('CONFLICT_COPY_CHANGED', '已有冲突副本被修改，已保留本地待同步任务。');
          await put(path, content);
        }
        conflicts.push({ conversationId: id, reason, path: conflictPath });
        continue;
      }
      if (sameNative && (localEntry.assets !== undefined || previous?.assets !== undefined)) {
        const mergedAssets = await mergeSameNativeAssets(localEntry, previous, prefix, native);
        for (const asset of mergedAssets) await ensureAsset(asset, prefix);
        const rebuilt = await buildArchive({ conversation: parse(remoteJSON),
          identity: { accountKey, displayName: bundle.account.displayName },
          capturedAt: previous?.lastChangedAt || previous?.firstCapturedAt || localEntry.firstCapturedAt || new Date().toISOString(),
          existingManifest: { ...manifest, conversations: { ...manifest.conversations, [id]: previous || localEntry } },
          productionPrefix: prefix, assets: mergedAssets });
        const rebuiltMD = rebuilt.files.find(file => file.path === markdownPath)?.content;
        if (typeof rebuiltMD !== 'string') fail('REMOTE_DERIVATIVE_MISSING', '附件阅读文件无法重新生成，待同步任务已保留。');
        const rebuiltEntry = rebuilt.manifest.conversations[id];
        // Receipts belong to exact native bytes. A derivative-only merge must
        // retain the strongest full-history check rather than favoring a device.
        const mergedEntry = applyMessageSync({ ...localEntry, ...previous, assets: mergedAssets, jsonPath, markdownPath,
          contentHash: remoteContentHash, markdownHash: await hash(rebuiltMD),
          rendererVersion: rebuiltEntry.rendererVersion, coverage: rebuiltEntry.coverage, warnings: rebuiltEntry.warnings }, native,
        remoteContentHash === localEntry.contentHash ? localEntry.messageSync : null,
        remoteContentHash === previous?.contentHash ? previous.messageSync : null);
        // These are derived from the chosen native tree, not evidence supplied
        // by another device's older manifest. Clear stale generation metadata
        // when no unfinished messages exist in the actual source.
        if (rebuiltEntry.generationState) mergedEntry.generationState = rebuiltEntry.generationState;
        else delete mergedEntry.generationState;
        if (localEntry.sourceCompleteness === 'complete' || previous?.sourceCompleteness === 'complete') {
          mergedEntry.sourceCompleteness = 'complete';
        }
        Object.defineProperty(manifest.conversations, id, { value: mergedEntry, enumerable: true, writable: true, configurable: true });
        await put(markdownPath, rebuiltMD);
        // Preserve the native JSON bytes and return the richer version for guarded local import.
        remoteWinners.push({ conversationId: id, accountKey, entry: mergedEntry,
          files: [{ path: jsonPath, content: remoteJSON }, { path: markdownPath, content: rebuiltMD }] });
        continue;
      }
      if (remoteWins) {
        for (const asset of assetsOf(previous, prefix)) await ensureAsset(asset, prefix);
        if (remoteMD === null) {
          // Rebuild from the selected remote native version, never from the stale local copy.
          const regenerated = await buildArchive({ conversation: parse(remoteJSON),
            identity: { accountKey, displayName: bundle.account.displayName },
            capturedAt: previous.lastChangedAt || previous.firstCapturedAt || new Date().toISOString(),
            existingManifest: manifest, productionPrefix: prefix, assets: previous.assets });
          remoteMD = regenerated.files.find(file => file.path === markdownPath)?.content;
          if (typeof remoteMD !== 'string') fail('REMOTE_DERIVATIVE_MISSING', '远端阅读文件暂时无法恢复，待同步任务已保留。');
          await put(markdownPath, remoteMD);
          previous.markdownHash = await hash(remoteMD);
          previous.rendererVersion = regenerated.manifest.conversations[id].rendererVersion;
        }
        remoteWinners.push({ conversationId: id, accountKey, entry: previous,
          files: [{ path: jsonPath, content: remoteJSON }, { path: markdownPath, content: remoteMD }] });
        continue;
      }
      await put(jsonPath, localJSON); await put(markdownPath, localMD);
      const entry = applyMessageSync({ ...localEntry, jsonPath, markdownPath,
        ...(previous ? { namingTime: previous.namingTime, pathTimeBasis: previous.pathTimeBasis, firstCapturedAt: previous.firstCapturedAt } : {}) },
      native, localEntry.messageSync,
      sameNative && remoteContentHash === localEntry.contentHash && remoteContentHash === previous?.contentHash ? previous.messageSync : null);
      Object.defineProperty(manifest.conversations, id, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    if (manifestText === null || !sameJSON(parse(manifestText), manifest)) await put(manifestPath, json(manifest));
    if (accountText === null) await put(accountPath, files.get(accountPath));
  }
  for (const prefix of assetPrefixes) {
    const attributesPath = `${prefix}/.gitattributes`;
    // A more specific attributes file can override the account rule. Do not guess
    // Git's full pattern/macro semantics or silently rewrite user-owned rules.
    for (const path of remote.entries.keys()) if (path.startsWith(`${prefix}/assets/`) && path.endsWith('/.gitattributes')) {
      const text = await read(path);
      if (text?.split(/\r?\n/).some(line => line.trim() && !line.trimStart().startsWith('#'))) {
        fail('LFS_ATTRIBUTES_CONFLICT', '附件目录包含自定义 Git 属性规则，请先处理后再启用 LFS。');
      }
    }
    const previous = await read(attributesPath);
    const lines = (previous || '').split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
    // At this directory level the final rule takes precedence, preserving every existing line.
    if (lines.at(-1)?.trim() !== LFS_RULE) {
      await put(attributesPath, (previous ? previous + (previous.endsWith('\n') ? '' : '\n') : '') + LFS_RULE + '\n');
    }
  }
  for (const winner of remoteWinners) {
    const prefix = safePath(winner.files[0].path);
    winner.files.push({ path: `${prefix}/archive/manifest.json`, content: await read(`${prefix}/archive/manifest.json`) },
      { path: `${prefix}/account.json`, content: await read(`${prefix}/account.json`) });
  }
  if (changes.size > MAX_FILES || [...changes.values()].reduce((total, text) => total + encoder.encode(text).byteLength, 0) > MAX_BYTES) {
    fail('ARCHIVE_SIZE', '包含附件指针的本批同步内容过多，请分批重试。');
  }
  return { changes, conflicts, remoteWinners };
}
async function headOf(api, branch) {
  const ref = (await api.request(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)).data;
  if (ref?.object?.type !== 'commit' || !sha(ref.object.sha)) fail('INVALID_RESPONSE', '无法确认远端分支。');
  return ref.object.sha;
}
async function verifyCommit(api, branch, commitSha, treeSha, changes) {
  const commit = (await api.request(`/git/commits/${commitSha}`)).data;
  if (commit?.tree?.sha !== treeSha) fail('WRITE_UNCONFIRMED', '提交文件树核对失败，待同步任务仍保留。');
  const tree = (await api.request(`/git/trees/${treeSha}?recursive=1`)).data;
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) fail('WRITE_UNCONFIRMED', '无法读回完整提交文件树，待同步任务仍保留。');
  const paths = new Map(tree.tree.map(x => [x.path, x]));
  for (const [path, content] of changes) {
    if (paths.get(path)?.type !== 'blob' || paths.get(path)?.sha !== await blobHash(content)) fail('WRITE_UNCONFIRMED', '提交后的文件摘要核对失败，待同步任务仍保留。');
  }
  const head = await headOf(api, branch);
  if (head !== commitSha) {
    const compare = (await api.request(`/compare/${commitSha}...${head}`)).data;
    if (!['ahead', 'identical'].includes(compare?.status)) fail('WRITE_UNCONFIRMED', '远端分支已变化，待同步任务仍保留。');
  }
}

/**
 * Caller owns a persistent outbox and clears a bundle only after this resolves.
 * Conflicting snapshots are preserved under conflicts/, never forcibly merged.
 * Remote winners are returned for optional guarded local reconciliation.
 */
export async function syncArchives({ config, bundles, assetPointers = [], fetchImpl = globalThis.fetch } = {}) {
  const checked = validateBundles(bundles);
  const assetPlan = validatePointers(checked, assetPointers);
  const parts = typeof config?.repository === 'string' ? config.repository.split('/') : [];
  if (parts.length !== 2) fail('INVALID_REPOSITORY', '仓库格式应为 owner/repository。');
  const input = { owner: parts[0], repo: parts[1], branch: config.branch, token: config.token, fetchImpl };
  const api = createGitHubClient(input);
  let info = await inspectGitHubRepository(api);
  if (info.empty) {
    // GitHub's refs API cannot initialize an empty repository. Seed only the fixed
    // synthetic probe; the complete conversation group is still one later commit.
    await commitProbe(input);
    info = await inspectGitHubRepository(api);
    if (info.empty) fail('WRITE_UNCONFIRMED', '空仓库初始化尚未确认，请稍后重试。');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = attempt === 0 ? info.headSha : await headOf(api, info.branch);
    const remote = await snapshot(api, head);
    const { changes, conflicts, remoteWinners } = await plan(api, remote, checked, assetPlan);
    if (!changes.size) return { status: 'unchanged', commitSha: head, branch: info.branch, filesChanged: 0, conflicts, remoteWinners };
    const tree = (await api.request('/git/trees', { method: 'POST', body: { base_tree: remote.treeSha,
      tree: [...changes].map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) } })).data;
    if (!sha(tree?.sha)) fail('INVALID_RESPONSE', 'GitHub 未返回有效文件树。');
    const commit = (await api.request('/git/commits', { method: 'POST', body: {
      message: 'archive: sync AI conversation changes', tree: tree.sha, parents: [head] } })).data;
    if (!sha(commit?.sha)) fail('INVALID_RESPONSE', 'GitHub 未返回有效提交。');
    try {
      await api.request(`/git/refs/heads/${info.branch.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PATCH', body: { sha: commit.sha, force: false } });
    } catch (error) {
      if (['CONFLICT', 'NETWORK', 'TIMEOUT', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500) {
        // A timed-out PATCH may already have committed. Verify before retrying.
        try {
          await verifyCommit(api, info.branch, commit.sha, tree.sha, changes);
          return { status: 'synced', commitSha: commit.sha, branch: info.branch, filesChanged: changes.size, conflicts, remoteWinners };
        } catch { /* Re-read and merge a new immutable head; no force update. */ }
        if (attempt < 2) continue;
        fail('SYNC_RETRY', '远端正在更新或提交结果未确认；本地数据已保留，稍后重试同步。');
      }
      throw error;
    }
    await verifyCommit(api, info.branch, commit.sha, tree.sha, changes);
    return { status: 'synced', commitSha: commit.sha, branch: info.branch, filesChanged: changes.size, conflicts, remoteWinners };
  }
}
