/** Persistent image work. Native conversations remain authoritative and unchanged. */
import { extractAssets, sanitizeAssetRecords } from './assets.js';
import { validateExternalAsset } from './chatgpt-assets.js';
import { assetPath, readLocalBytes, verifiedLocalAsset, writeLocalAsset, imageExtension, MAX_ASSET_BYTES } from './asset-store.js';
import { createLfsClient, hashBytes, formatLfsPointer, parseLfsPointer } from './lfs.js';
import { collectorError, safeError } from './config.js';

const ready = asset => asset.status === 'downloaded' && asset.oid && asset.localPath;
const key = account => `assetJobs:${account.accountKey}`;
const uploadKey = account => `assetUploads:${account.accountKey}`;
const receiptKey = account => `assetReceipts:${account.accountKey}`;
const uploadIdentity = asset => `${asset.localPath}:${asset.oid}:${asset.size}`;
const enc = new TextDecoder('utf-8', { fatal: true });
const text = bytes => enc.decode(bytes);
const nativeId = native => native.conversation_id ?? native.id;
const isImage = asset => asset.kind === 'image' || /^image\//i.test(asset.mimeType || '') || /\.(png|jpe?g|gif|webp|avif)$/i.test(asset.fileName || '');

export function createAssetService({ getSetting, setSetting, readAccountManifest, saveConversation,
  resolveAsset, enqueueArchive, browser = globalThis.chrome, fetchImpl = globalThis.fetch, downloadRepositoryFile,
  lfsFactory = createLfsClient, now = Date.now }) {
  const ephemeral = new Map();
  async function jobs(account) { return await getSetting(key(account)) || { tasks: [] }; }
  async function status(account, manifest) {
    const unique = new Map();
    for (const entry of Object.values(manifest?.conversations || {})) for (const asset of entry.assets || []) if (isImage(asset)) unique.set(asset.id, asset);
    const result = { external: 0, pendingCapture: 0, local: 0, uploaded: 0, pendingUpload: 0, failed: 0 };
    const managed = new Map();
    for (const asset of unique.values()) {
      if (asset.status === 'external') result.external++;
      else if (ready(asset)) managed.set(uploadIdentity(asset), asset);
      else result.pendingCapture++;
    }
    result.local = managed.size;
    result.failed = (await jobs(account)).tasks.filter(t => t.error).length;
    const receipts = await getSetting(receiptKey(account));
    const uploaded = new Set(receipts?.uploaded || []);
    result.uploaded = [...managed.keys()].filter(identity => uploaded.has(identity)).length;
    result.pendingUpload = result.local - result.uploaded;
    const previous = await getSetting(`assetStatus:${account.accountKey}`);
    await setSetting(`assetStatus:${account.accountKey}`, { ...previous, ...result });
  }
  async function save(input) {
    const { directory, account, detail } = input;
    const manifest = await readAccountManifest(directory, account);
    const id = nativeId(detail.payload), old = manifest?.conversations?.[id]?.assets || [];
    const oldMap = new Map(old.map(a => [a.id, a]));
    const extracted = await extractAssets(detail.payload);
    const assets = [];
    for (const asset of extracted) {
      if (asset.retrieval) ephemeral.set(`${account.accountKey}:${id}:${asset.id}`, asset.retrieval);
      const previous = oldMap.get(asset.id);
      if (previous && ready(previous)) {
        // A manifest receipt alone does not prove the binary still exists.
        // Missing bytes return to capture; differing bytes remain a conflict.
        const present = await verifiedLocalAsset({ directory, account, asset: previous, getSetting });
        assets.push(present ? { ...asset, ...previous } : asset);
      } else assets.push(previous?.status === 'external' ? { ...asset, ...previous } : asset);
    }
    const saved = await saveConversation({ ...input, assets });
    const state = await jobs(account);
    // A ready asset may still have a pending outbox acknowledgement after a
    // crash. A new source scan must not erase that durable delivery task.
    state.tasks = state.tasks.filter(t => t.conversationId !== id || t.pendingArchives?.length || assets.some(a => a.id === t.assetId));
    for (const asset of assets) if (isImage(asset) && !ready(asset) && asset.status !== 'external' && !state.tasks.some(t => t.conversationId === id && t.assetId === asset.id)) {
      state.tasks.push({ conversationId: id, assetId: asset.id, attempt: 0, retryAt: 0 });
    }
    await setSetting(key(account), state);
    await status(account, saved.manifest);
    return saved;
  }
  async function external(asset) {
    const result = await validateExternalAsset({ url: asset.sourceRef, browser, fetchImpl, maxBytes: MAX_ASSET_BYTES });
    if (result.status !== 'external') throw collectorError('ASSET_LINK_UNKNOWN',
      result.reason === 'permission-required' ? '请在设置中允许检测外链图片；链接已保留。' : '外链暂时无法匿名验证，链接已保留，未自动上传。');
    return { ...asset, status: 'external', mimeType: result.mimeType };
  }
  async function capture(asset, request) {
    if (asset.sourceType === 'external') return external(asset);
    let bytes, mimeType = asset.mimeType, quality = 'original';
    const retrievalURL = asset.retrieval?.url || asset.retrieval?.sourceRef || asset.sourceRef;
    if (asset.sourceType === 'embedded' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(retrievalURL)) {
      const data = retrievalURL.split(',')[1];
      if (data.length > MAX_ASSET_BYTES * 1.4) throw collectorError('ASSET_SIZE', '内嵌图片超过处理上限。');
      try { bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { throw collectorError('ASSET_FORMAT', '内嵌图片格式不正确。'); }
    } else {
      const resolved = await resolveAsset({ ...request, asset }); bytes = resolved.bytes; mimeType = resolved.mimeType || mimeType; quality = resolved.quality;
    }
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_ASSET_BYTES) throw collectorError('ASSET_SIZE', '图片超过处理上限或没有数据。');
    const extension = imageExtension(bytes), oid = await hashBytes(bytes);
    const managed = { ...asset, status: 'downloaded', oid, size: bytes.length, mimeType, quality,
      localPath: assetPath(request.account, oid, extension) };
    await writeLocalAsset({ ...request, asset: managed, bytes, getSetting, setSetting });
    return managed;
  }
  async function tick({ directory, account, tabId }) {
    const state = await jobs(account), task = state.tasks.find(t => (t.retryAt || 0) <= now());
    if (!task) return { pending: state.tasks.length, runnable: false };
    let finalManifest;
    try {
      const manifest = await readAccountManifest(directory, account), entry = manifest?.conversations?.[task.conversationId];
      const asset = entry?.assets?.find(a => a.id === task.assetId);
      if (!task.pendingArchives?.length && asset) {
        const nativeBytes = await readLocalBytes(directory, entry.jsonPath, 24 * 1024 * 1024);
        if (!nativeBytes || await hashBytes(nativeBytes) !== entry.contentHash) throw collectorError('LOCAL_CONFLICT', '对话原始文件已变化，图片任务暂停以保护原文件。');
        const native = JSON.parse(text(nativeBytes));
        const fresh = (await extractAssets(native)).find(a => a.id === asset.id);
        const retrieval = ephemeral.get(`${account.accountKey}:${task.conversationId}:${asset.id}`) || fresh?.retrieval;
        // Re-enqueue a saved derivative if the worker stopped after filesystem
        // commit but before its outbox checkpoint. Capturing the bytes again is unnecessary.
        const completed = ready(asset) || asset.status === 'external' ? asset : await capture({ ...asset, retrieval }, { directory, account, tabId });
        const updated = entry.assets.map(a => a.id === asset.id ? completed : a);
        const saved = await saveConversation({ directory, account, assets: sanitizeAssetRecords(updated), detail: {
          payload: native, identity: { accountKey: account.accountKey, displayName: account.displayName },
          capturedAt: entry.lastChangedAt || new Date(now()).toISOString(), completeness: entry.sourceCompleteness,
        } });
        const { recovered, ...current } = saved;
        task.pendingArchives = recovered ? [recovered, current] : [current];
        // Persist the delivery list before handing off either archive. A replay
        // may have recovered a different conversation whose receipt would
        // otherwise disappear after its filesystem journal is cleared.
        await setSetting(key(account), state);
        finalManifest = saved.manifest;
      }
      while (task.pendingArchives?.length) {
        await enqueueArchive({ account, archive: task.pendingArchives[0] });
        task.pendingArchives.shift();
        await setSetting(key(account), state);
      }
      state.tasks = state.tasks.filter(t => t !== task);
      finalManifest ||= manifest;
    } catch (error) {
      task.attempt++; task.error = safeError(error);
      task.retryAt = now() + Math.min(60, 2 ** Math.min(task.attempt, 6)) * 60000;
    }
    await setSetting(key(account), state);
    if (finalManifest) await status(account, finalManifest);
    return { pending: state.tasks.length, runnable: state.tasks.some(t => (t.retryAt || 0) <= now()) };
  }
  async function prepareUploads({ directory, account, config, bundles }) {
    const records = new Map();
    for (const bundle of bundles) for (const file of bundle.files) if (file.path.endsWith('/archive/manifest.json')) {
      const manifest = JSON.parse(file.content);
      for (const entry of Object.values(manifest.conversations || {})) for (const asset of entry.assets || []) if (ready(asset)) records.set(asset.localPath, asset);
    }
    if (records.size && config.lfsEnabled === false) throw collectorError('LFS_DISABLED', '图片已保存在本地；请启用 LFS 后同步带图片的对话。');
    const target = { repository: config.repository.toLowerCase(), branch: config.branch || '' };
    const signature = await hashBytes(new TextEncoder().encode(JSON.stringify({ ...target,
      records: [...records.values()].map(uploadIdentity).sort() })));
    const sameDirectory = async other => {
      if (directory === other) return true;
      try { return typeof directory?.isSameEntry === 'function' && await directory.isSameEntry(other); } catch { return false; }
    };
    let checkpoint = await getSetting(uploadKey(account));
    if (!checkpoint || checkpoint.signature !== signature || checkpoint.repository !== target.repository ||
        checkpoint.branch !== target.branch || !Array.isArray(checkpoint.uploaded) ||
        !await sameDirectory(checkpoint.directory) || now() - checkpoint.startedAt > 60 * 60_000) {
      checkpoint = { schemaVersion: 1, ...target, signature, directory, startedAt: now(), uploaded: [] };
      await setSetting(uploadKey(account), checkpoint);
    }
    let receipts = await getSetting(receiptKey(account));
    if (!receipts || receipts.repository !== target.repository || receipts.branch !== target.branch ||
        !Array.isArray(receipts.uploaded) || !await sameDirectory(receipts.directory)) {
      receipts = { schemaVersion: 1, ...target, directory, uploaded: [] };
      await setSetting(receiptKey(account), receipts);
    }
    const uploaded = new Set(checkpoint.uploaded), receiptSet = new Set(receipts.uploaded);
    const client = records.size ? lfsFactory({ repository: config.repository, token: config.token, branch: config.branch, fetchImpl, maxBytes: MAX_ASSET_BYTES }) : null;
    const pointers = [];
    let transferred = 0;
    async function progress() {
      const previous = await getSetting(`assetStatus:${account.accountKey}`) || {};
      const count = [...records.values()].filter(asset => uploaded.has(uploadIdentity(asset))).length;
      await setSetting(`assetStatus:${account.accountKey}`, { ...previous, local: records.size, uploaded: count, pendingUpload: records.size - count });
    }
    for (const asset of records.values()) {
      const bytes = await verifiedLocalAsset({ directory, account, asset, getSetting });
      if (!bytes) throw collectorError('ASSET_MISSING', '待上传图片尚未在本地补齐。请先从 GitHub 恢复或补采图片。');
      const identity = uploadIdentity(asset);
      if (!uploaded.has(identity)) {
        if (transferred >= 2) { await progress(); throw collectorError('LFS_UPLOAD_PENDING', '图片正在分批上传，进度已保存。'); }
        await client.upload({ bytes, oid: asset.oid, size: asset.size, mimeType: asset.mimeType });
        transferred++; uploaded.add(identity); receiptSet.add(identity);
        checkpoint.uploaded = [...uploaded]; receipts.uploaded = [...receiptSet];
        await setSetting(receiptKey(account), receipts);
        await setSetting(uploadKey(account), checkpoint);
        await progress();
      }
      pointers.push({ accountKey: account.accountKey, path: asset.localPath, oid: asset.oid, size: asset.size,
        content: formatLfsPointer({ oid: asset.oid, size: asset.size }) });
    }
    await progress();
    return pointers;
  }
  async function acknowledgeUploads(account) { await setSetting(uploadKey(account), null); }
  async function hydrateAssets({ directory, account, entry, config, snapshot }) {
    const assets = [...new Map((entry.assets || []).filter(ready).map(asset => [uploadIdentity(asset), asset])).values()];
    const checkpointKey = `assetHydration:${await hashBytes(new TextEncoder().encode(`${account.accountKey}:${entry.conversationId || assets.map(uploadIdentity).join('|')}`))}`;
    const signature = await hashBytes(new TextEncoder().encode(JSON.stringify({ repository: config.repository.toLowerCase(),
      branch: config.branch || snapshot.branch || '', commit: snapshot.commitSha || snapshot.treeSha || null,
      assets: assets.map(uploadIdentity).sort() })));
    let checkpoint = await getSetting(checkpointKey);
    let sameDirectory = checkpoint?.directory === directory;
    if (checkpoint && !sameDirectory) { try { sameDirectory = await directory.isSameEntry(checkpoint.directory); } catch { sameDirectory = false; } }
    if (!checkpoint || checkpoint.signature !== signature || !sameDirectory || !checkpoint.failures || typeof checkpoint.failures !== 'object') {
      checkpoint = { schemaVersion: 1, signature, directory, failures: {} };
    }
    const currentIds = new Set(assets.map(uploadIdentity));
    for (const id of Object.keys(checkpoint.failures)) if (!currentIds.has(id)) delete checkpoint.failures[id];
    let downloaded = 0, remaining = 0, attempted = 0;
    const client = lfsFactory({ repository: config.repository, token: config.token, fetchImpl, maxBytes: MAX_ASSET_BYTES });
    async function failed(id, error) {
      const attempt = (checkpoint.failures[id]?.attempt || 0) + 1;
      checkpoint.failures[id] = { attempt, retryAt: now() + Math.min(15, 2 ** Math.min(attempt - 1, 4)) * 60_000, error: safeError(error) };
      await setSetting(checkpointKey, checkpoint);
    }
    for (const asset of assets) {
      const id = uploadIdentity(asset), previous = checkpoint.failures[id];
      if (previous && previous.retryAt > now()) continue;
      let present;
      try { present = await verifiedLocalAsset({ directory, account, asset, getSetting }); }
      catch (error) {
        if (attempted >= 2) { remaining++; continue; }
        attempted++; await failed(id, error); continue;
      }
      if (present) { delete checkpoint.failures[id]; continue; }
      if (attempted >= 2) { remaining++; continue; }
      attempted++;
      try {
        const remote = snapshot.entries.find(e => e.path === asset.localPath);
        if (!remote) throw collectorError('ASSET_POINTER_MISSING', '远端图片指针缺失，已保留待补齐任务。');
        const pointer = parseLfsPointer(text(await downloadRepositoryFile({ config, entry: remote, fetchImpl, maxBytes: 2048 })));
        if (!pointer || pointer.oid !== asset.oid || pointer.size !== asset.size) throw collectorError('ASSET_POINTER_MISMATCH', '图片指针与对话清单不一致。');
        const bytes = await client.download({ oid: asset.oid, size: asset.size });
        await writeLocalAsset({ directory, account, asset, bytes, getSetting, setSetting }); downloaded++;
        delete checkpoint.failures[id];
        await setSetting(checkpointKey, checkpoint);
      } catch (error) { await failed(id, error); }
    }
    await setSetting(checkpointKey, checkpoint);
    // Do not spend the conversation's retry budget while other images can
    // still make progress. Failed files keep their own persisted backoff.
    if (remaining) return { downloaded, pending: remaining, failed: 0 };
    const unresolved = Object.values(checkpoint.failures);
    if (unresolved.length) throw collectorError(unresolved[0].error.code, unresolved[0].error.message);
    return { downloaded, pending: remaining, failed: 0 };
  }
  return { save, tick, prepareUploads, acknowledgeUploads, hydrateAssets };
}
