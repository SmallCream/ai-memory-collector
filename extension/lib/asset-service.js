/** Persistent attachment work. Native conversations remain authoritative and unchanged. */
import { extractAssets, sanitizeAssetRecords, reconcileAssetCapturePolicy } from './assets.js';
import { reconcileFileCitation } from './asset-reconciliation.js';
import { validateExternalAsset } from './chatgpt-assets.js';
import { assetPath, readLocalBytes, verifiedLocalAsset, writeLocalAsset, assetExtension, canCaptureAsset, MAX_ASSET_BYTES } from './asset-store.js';
import { createLfsClient, hashBytes, formatLfsPointer, parseLfsPointer } from './lfs.js';
import { collectorError, safeError } from './config.js';
import { createActivityLog } from './activity-log.js';

const ready = asset => asset.status === 'downloaded' && asset.oid && asset.localPath;
const key = account => `assetJobs:${account.accountKey}`;
const uploadKey = account => `assetUploads:${account.accountKey}`;
const receiptKey = account => `assetReceipts:${account.accountKey}`;
const uploadIdentity = asset => `${asset.localPath}:${asset.oid}:${asset.size}`;
const enc = new TextDecoder('utf-8', { fatal: true });
const text = bytes => enc.decode(bytes);
const nativeId = native => native.conversation_id ?? native.id;
const suspended = asset => asset?.autoRetrySuspended === true;
const deliveryPending = task => task.pendingArchives?.length || task.priorArchives?.length;
const activeTask = task => !suspended(task) || deliveryPending(task);


export function createAssetService({ getSetting, setSetting, readAccountManifest, saveConversation,
  resolveAsset, refreshConversation, enqueueArchive, browser = globalThis.chrome, fetchImpl = globalThis.fetch, downloadRepositoryFile,
  lfsFactory = createLfsClient, now = Date.now }) {
  const ephemeral = new Map();
  const activity = createActivityLog({ getSetting, setSetting, now });
  async function jobs(account) { return await getSetting(key(account)) || { tasks: [] }; }
  const label = value => String(value || '').replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]').replace(/Bearer\s+[^\s,;]+/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
  async function diagnostics({ directory, account, github }) {
    const state = await jobs(account);
    let manifest;
    if (directory) { try { manifest = await readAccountManifest(directory, account); } catch { /* queue remains readable without directory access */ } }
    const failures = state.tasks.filter(task => activeTask(task) && task.error);
    const internal = state.tasks.filter(suspended);
    const describe = task => {
      const entry = manifest?.conversations?.[task.conversationId], asset = entry?.assets?.find(a => a.id === task.assetId);
      return { conversationId: label(task.conversationId), assetId: label(task.assetId),
        conversationTitle: label(entry?.title), fileName: label(asset?.fileName),
        messageId: label(asset?.messageId), fileId: label(asset?.fileId),
        code: safeError(task.error).code, message: '附件处理未完成，请根据错误代码检查后重试。',
        attempt: Number.isSafeInteger(task.attempt) && task.attempt >= 0 ? task.attempt : 0,
        retryAt: Number.isFinite(task.retryAt) ? task.retryAt : 0 };
    };
    const captureItems = state.tasks.slice(0, 50).map(task => {
      const item = describe(task);
      return { conversationId: item.conversationId, title: item.conversationTitle, fileName: item.fileName,
        status: deliveryPending(task) ? 'delivering' : task.manualRetry ? 'pending' : suspended(task) ? 'internal-missing' :
          task.error ? (task.retryAt > now() ? 'retry' : 'failed') : 'pending',
        attempt: item.attempt, nextRetryAt: item.retryAt, code: task.error ? item.code : null };
    });
    const receipts = await getSetting(receiptKey(account));
    let receiptDirectory = Boolean(directory) && directory === receipts?.directory;
    if (!receiptDirectory && directory && receipts?.directory) {
      try { receiptDirectory = Boolean(await directory.isSameEntry(receipts.directory)); } catch { /* stale directory handle */ }
    }
    const receiptTarget = !github || (typeof github.repository === 'string' &&
      receipts?.repository === github.repository.toLowerCase() && receipts?.branch === (github.branch || ''));
    const uploaded = new Set(receiptDirectory && receiptTarget && Array.isArray(receipts?.uploaded) ? receipts.uploaded : []);
    const uploadRecords = new Map();
    for (const [conversationId, entry] of Object.entries(manifest?.conversations || {})) {
      for (const asset of entry.assets || []) if (canCaptureAsset(asset) && ready(asset)) {
        const id = uploadIdentity(asset);
        if (!uploadRecords.has(id)) uploadRecords.set(id, {
          conversationId: label(conversationId), title: label(entry.title),
          fileName: label(asset.fileName || asset.localPath?.split('/').at(-1)),
          size: Number.isSafeInteger(asset.size) && asset.size >= 0 ? asset.size : 0,
          status: uploaded.has(id) ? 'uploaded' : 'pending',
        });
      }
    }
    const uploadItems = [...uploadRecords.values()].sort((a, b) => Number(a.status === 'uploaded') - Number(b.status === 'uploaded')).slice(0, 50);
    return { total: state.tasks.length, pending: state.tasks.filter(activeTask).length, failed: failures.length,
      captureTotal: state.tasks.length, captureItems, uploadTotal: uploadRecords.size, uploadItems,
      failures: failures.slice(0, 200).map(describe), internalMissing: internal.length,
      internalFailures: internal.slice(0, 200).map(task => ({ ...describe(task), code: 'HTTP_404',
        message: '内部附件未下载，自动重试已停止；原始来源和失败记录已保留。', retryAt: 0 })) };
  }
  async function retryFailed({ account, includeInternal = false }) {
    const state = await jobs(account);
    for (const task of state.tasks) if (task.error && (includeInternal ? suspended(task) : !suspended(task))) {
      // Keep the last failure visible until the retry actually succeeds. A
      // manual request permits one attempt per failed task while scans are paused.
      task.retryAt = 0; task.manualRetry = true; task.refreshSource = true;
    }
    await setSetting(key(account), state);
  }
  async function status(account, manifest) {
    const unique = new Map();
    for (const entry of Object.values(manifest?.conversations || {})) for (const asset of entry.assets || []) if (canCaptureAsset(asset)) unique.set(asset.id, asset);
    const result = { external: 0, pendingCapture: 0, local: 0, uploaded: 0, pendingUpload: 0, failed: 0, internalMissing: 0 };
    const managed = new Map();
    for (const asset of unique.values()) {
      if (asset.status === 'external') result.external++;
      else if (ready(asset)) managed.set(uploadIdentity(asset), asset);
      else if (suspended(asset)) result.internalMissing++;
      else result.pendingCapture++;
    }
    result.local = managed.size;
    result.failed = (await jobs(account)).tasks.filter(t => activeTask(t) && t.error).length;
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
        assets.push(present ? reconcileAssetCapturePolicy({ ...asset, ...previous, references: asset.references, occurrences: asset.occurrences }, asset) : asset);
      } else assets.push(previous?.status === 'external' || suspended(previous) ?
        reconcileAssetCapturePolicy({ ...asset, ...previous, references: asset.references, occurrences: asset.occurrences }, asset) : asset);
    }
    const saved = await saveConversation({ ...input, assets });
    const state = await jobs(account);
    // A ready asset may still have a pending outbox acknowledgement after a
    // crash. A new source scan must not erase that durable delivery task.
    state.tasks = state.tasks.filter(t => t.conversationId !== id || t.pendingArchives?.length || t.priorArchives?.length || assets.some(a => a.id === t.assetId));
    for (const asset of assets) if (canCaptureAsset(asset)) {
      let task = state.tasks.find(t => t.conversationId === id && t.assetId === asset.id);
      if (ready(asset) || asset.status === 'external') {
        if (task && suspended(task)) { delete task.autoRetrySuspended; delete task.error; task.retryAt = 0; }
        continue;
      }
      if (!task) { task = { conversationId: id, assetId: asset.id, attempt: 0, retryAt: 0 }; state.tasks.push(task); }
      if (suspended(asset)) {
        task.autoRetrySuspended = true;
        task.error ||= safeError(collectorError('HTTP_404', '内部附件未下载。'));
      } else if (suspended(task)) {
        // A new user/visible assistant reference makes capture required again.
        delete task.autoRetrySuspended; delete task.error; task.retryAt = 0;
      }
      delete task.policyCheckedHash;
    }
    await setSetting(key(account), state);
    await status(account, saved.manifest);
    return saved;
  }
  async function external(asset) {
    const result = await validateExternalAsset({ url: asset.sourceRef, asset, browser, fetchImpl, maxBytes: MAX_ASSET_BYTES });
    if (result.status !== 'external') throw collectorError('ASSET_LINK_UNKNOWN',
      result.reason === 'permission-required' ? '请在设置中允许检测外链附件；链接已保留。' : '外链暂时无法匿名验证，链接已保留，未自动上传。');
    return { ...asset, status: 'external', mimeType: result.mimeType };
  }
  async function capture(asset, request) {
    const info = { title: request.title, conversationId: request.conversationId, fileName: asset.fileName,
      ...(Number.isSafeInteger(asset.expectedSize) ? { size: asset.expectedSize } : {}) };
    if (asset.sourceType === 'external') return activity.run(request.account.accountKey, 'download',
      { ...info, stage: 'check-external' }, () => external(asset));
    const { managed, bytes } = await activity.run(request.account.accountKey, 'download', { ...info, stage: 'download' }, async () => {
      let bytes, mimeType = asset.mimeType, quality = 'original';
      const retrievalURL = asset.retrieval?.url || asset.retrieval?.sourceRef || asset.sourceRef;
      if (asset.sourceType === 'embedded' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(retrievalURL)) {
        const data = retrievalURL.split(',')[1];
        if (data.length > MAX_ASSET_BYTES * 1.4) throw collectorError('ASSET_SIZE', '内嵌附件超过处理上限。');
        try { bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { throw collectorError('ASSET_FORMAT', '内嵌附件格式不正确。'); }
      } else {
        const resolved = await resolveAsset({ ...request, asset }); bytes = resolved.bytes; mimeType = resolved.mimeType || mimeType; quality = resolved.quality;
      }
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_ASSET_BYTES) throw collectorError('ASSET_SIZE', '附件超过处理上限或没有数据。');
      const extension = assetExtension(bytes, { ...asset, mimeType }), oid = await hashBytes(bytes);
      const managed = reconcileAssetCapturePolicy({ ...asset, status: 'downloaded', oid, size: bytes.length, mimeType, quality,
        localPath: assetPath(request.account, oid, extension) }, asset);
      delete managed.errorCode;
      return { managed, bytes };
    });
    await activity.run(request.account.accountKey, 'download', { ...info, stage: 'save-image', size: bytes.length },
      () => writeLocalAsset({ ...request, asset: managed, bytes, getSetting, setSetting }));
    return managed;
  }
  async function tick({ directory, account, tabId, manualOnly = false }) {
    const runnable = task => (!manualOnly || task.manualRetry === true || deliveryPending(task)) &&
      (activeTask(task) || task.manualRetry === true) && (task.retryAt || 0) <= now();
    const needsPolicyCheck = task => !manualOnly && !suspended(task) && !task.policyCheckedHash &&
      task.error?.code === 'HTTP_404' && (!task.errorStage || task.errorStage === 'capture') && !deliveryPending(task);
    const state = await jobs(account);
    // Normal GitHub synchronization can apply a winning archive directly,
    // without hydrateAssets/save. Recheck only changed suspended descriptors
    // before excluding them from the scheduler. Pending receipts drain first.
    if (state.tasks.some(task => suspended(task) && !deliveryPending(task))) {
      let manifest;
      try { manifest = await readAccountManifest(directory, account); } catch { /* ordinary tasks report directory errors below */ }
      let changed = false;
      const verified = new Map();
      for (const task of state.tasks) {
        if (!suspended(task) || deliveryPending(task)) continue;
        const entry = manifest?.conversations?.[task.conversationId], asset = entry?.assets?.find(item => item.id === task.assetId);
        if (!entry || !asset || (task.policyCheckedHash === entry.contentHash && suspended(asset) && !ready(asset))) continue;
        try {
          let extracted = verified.get(task.conversationId);
          if (!extracted) {
            const nativeBytes = await readLocalBytes(directory, entry.jsonPath, 24 * 1024 * 1024);
            if (!nativeBytes || await hashBytes(nativeBytes) !== entry.contentHash) throw collectorError('LOCAL_CONFLICT', '对话原始文件已变化，附件任务暂停以保护原文件。');
            const native = JSON.parse(text(nativeBytes));
            if (nativeId(native) !== task.conversationId) throw collectorError('INCOMPLETE_DETAIL', '附件来源对话不匹配。');
            extracted = await extractAssets(native); verified.set(task.conversationId, extracted);
          }
          const current = reconcileAssetCapturePolicy(asset, extracted.find(item => item.id === asset.id));
          task.policyCheckedHash = entry.contentHash;
          if (!suspended(current)) { delete task.autoRetrySuspended; delete task.error; delete task.errorStage; task.retryAt = 0; }
        } catch (error) {
          // A source conflict is an actionable failure, not an internal 404.
          delete task.autoRetrySuspended; task.error = safeError(error); task.errorStage = 'archive'; task.attempt++;
          task.retryAt = now() + Math.min(60, 2 ** Math.min(task.attempt, 6)) * 60000;
        }
        changed = true;
      }
      if (changed) await setSetting(key(account), state);
    }
    const task = state.tasks.find(t => runnable(t) || needsPolicyCheck(t));
    if (!task) return { pending: state.tasks.filter(activeTask).length, runnable: false };
    let finalManifest, retainTask = false, operationStage = 'archive';
    try {
      const manifest = await readAccountManifest(directory, account), entry = manifest?.conversations?.[task.conversationId];
      finalManifest = manifest;
      let asset = entry?.assets?.find(a => a.id === task.assetId);
      if (!task.pendingArchives?.length && asset) {
        const nativeBytes = await readLocalBytes(directory, entry.jsonPath, 24 * 1024 * 1024);
        if (!nativeBytes || await hashBytes(nativeBytes) !== entry.contentHash) throw collectorError('LOCAL_CONFLICT', '对话原始文件已变化，附件任务暂停以保护原文件。');
        const native = JSON.parse(text(nativeBytes));
        if (nativeId(native) !== task.conversationId) throw collectorError('INCOMPLETE_DETAIL', '附件来源对话不匹配，保留已有记录等待检查。');
        const original = asset;
        const reconciliation = await reconcileFileCitation(asset, entry.assets, await extractAssets(native));
        asset = reconciliation.asset;
        let fresh = reconciliation.fresh;
        asset = reconcileAssetCapturePolicy(asset, fresh);
        const migrate404 = !task.manualRetry && !task.policyCheckedHash && !ready(asset) && asset.status !== 'external' &&
          asset.capturePolicy === 'internal-viewer' && task.error?.code === 'HTTP_404' && (!task.errorStage || task.errorStage === 'capture');
        task.policyCheckedHash = entry.contentHash;
        if (!runnable(task) && !migrate404) {
          await setSetting(key(account), state);
          return { pending: state.tasks.filter(activeTask).length, runnable: state.tasks.some(t => runnable(t) || needsPolicyCheck(t)) };
        }
        if (reconciliation.retired.length && nativeId(native) !== task.conversationId) {
          throw collectorError('INCOMPLETE_DETAIL', '附件来源对话不匹配，保留已有记录等待检查。');
        }
        if (reconciliation.retired.length && ready(asset) &&
            !await verifiedLocalAsset({ directory, account, asset, getSetting })) {
          if (asset.sha256 && asset.sha256 !== asset.oid) throw collectorError('ASSET_HASH', '附件内容摘要记录冲突，已保留已有记录。');
          asset = { ...asset, status: 'pending', sha256: asset.oid };
          delete asset.oid; delete asset.localPath; delete asset.size;
        }
        const wasSuspended = suspended(asset) || suspended(task);
        let sourceFailure;
        let retrieval = ephemeral.get(`${account.accountKey}:${task.conversationId}:${asset.id}`) || fresh?.retrieval;
        if (!migrate404 && !(suspended(asset) && !task.manualRetry) && !ready(original) && original.status !== 'external' && refreshConversation && (task.refreshSource || task.error)) {
          operationStage = 'source';
          try {
            const online = await activity.run(account.accountKey, 'download', { stage: 'refresh-source', title: entry.title,
              conversationId: task.conversationId, fileName: asset.fileName }, async () => {
              const detail = await refreshConversation({ tabId, accountKey: account.accountKey, conversationId: task.conversationId });
              if (detail?.identity?.accountKey !== account.accountKey) throw collectorError('ACCOUNT_CHANGED', '附件详情所属账号不匹配。');
              if (nativeId(detail?.payload || {}) !== task.conversationId || detail.completeness !== 'complete') {
                throw collectorError('INCOMPLETE_DETAIL', '附件来源详情未完整确认，原归档保持不变。');
              }
              const online = (await extractAssets(detail.payload)).find(a => a.id === asset.id);
              if (!online) throw collectorError('ASSET_SOURCE_MISSING', '最新详情中未找到这个附件，保留已有记录等待检查。');
              return online;
            });
            // Live references may promote an attachment to normal capture. They
            // cannot weaken the source classification from the archived JSON.
            if (online.capturePolicy !== 'internal-viewer') asset = reconcileAssetCapturePolicy(asset, online);
            fresh = online; retrieval = online.retrieval;
            if (retrieval) ephemeral.set(`${account.accountKey}:${task.conversationId}:${asset.id}`, retrieval);
          } catch (error) {
            if (!wasSuspended) throw error;
            sourceFailure = error;
          }
        }
        // Re-enqueue a saved derivative if the worker stopped after filesystem
        // commit but before its outbox checkpoint. Capturing the bytes again is unnecessary.
        // A newly resolved Library ID is a location hint. Keep original byte
        // size/dimension/hash constraints and message anchors from the archive.
        operationStage = 'capture';
        let completed;
        if (migrate404 || (suspended(asset) && !task.manualRetry)) {
          completed = reconcileAssetCapturePolicy({ ...asset, status: 'unavailable', errorCode: 'HTTP_404', autoRetrySuspended: true }, fresh);
          retainTask = true;
        } else {
          const requestAsset = { ...fresh, ...asset,
            ...(fresh?.libraryFileId ? { libraryFileId: fresh.libraryFileId } : {}), retrieval };
          delete requestAsset.autoRetrySuspended;
          try {
            if (sourceFailure) throw sourceFailure;
            completed = ready(asset) || asset.status === 'external' ? asset : await capture(requestAsset,
              { directory, account, tabId, conversationId: task.conversationId, title: entry.title });
            delete task.autoRetrySuspended;
          } catch (error) {
            const failure = safeError(error);
            if (!wasSuspended && (asset.capturePolicy !== 'internal-viewer' || failure.code !== 'HTTP_404')) throw error;
            completed = reconcileAssetCapturePolicy({ ...asset, status: 'unavailable', errorCode: failure.code,
              autoRetrySuspended: !sourceFailure && asset.capturePolicy === 'internal-viewer' && failure.code === 'HTTP_404' }, fresh);
            task.attempt++; task.error = failure; task.errorStage = sourceFailure ? 'source' : 'capture';
            task.retryAt = now() + Math.min(60, 2 ** Math.min(task.attempt, 6)) * 60000;
            delete task.autoRetrySuspended;
            retainTask = true;
          }
        }
        operationStage = 'archive';
        const duplicates = state.tasks.filter(other => other !== task && other.conversationId === task.conversationId &&
          (other.assetId === asset.id || reconciliation.retired.includes(other.assetId)));
        if (task.assetId !== asset.id || duplicates.length) {
          // Checkpoint the surviving ID before changing the manifest. If the
          // worker stops after the write, replay can still enqueue its archive.
          // Move older receipts in the same checkpoint: once the alias is gone
          // from the manifest it cannot be used to discover those tasks again.
          task.assetId = asset.id;
          task.priorArchives = [...(task.priorArchives || []), ...duplicates.flatMap(other =>
            [...(other.priorArchives || []), ...(other.pendingArchives || [])])];
          state.tasks = state.tasks.filter(other => !duplicates.includes(other));
          await setSetting(key(account), state);
        }
        const updated = entry.assets.filter(a => !reconciliation.retired.includes(a.id)).map(a => a.id === asset.id ? completed : a);
        const saved = await saveConversation({ directory, account, assets: sanitizeAssetRecords(updated), detail: {
          payload: native, identity: { accountKey: account.accountKey, displayName: account.displayName },
          capturedAt: entry.lastChangedAt || new Date(now()).toISOString(), completeness: entry.sourceCompleteness,
        } });
        const { recovered, ...current } = saved;
        // Preserve older durable receipts and deliver them first; the corrected
        // manifest must be the last archive for this image.
        if (suspended(completed)) {
          task.autoRetrySuspended = true;
          task.error = safeError(collectorError('HTTP_404', '内部附件未下载。')); task.errorStage = 'capture'; task.retryAt = 0;
        }
        if (!ready(completed) && completed.status !== 'external') task.captureIncomplete = true;
        else delete task.captureIncomplete;
        task.pendingArchives = [...(task.priorArchives || []),
          ...(recovered ? [recovered, current] : [current])];
        delete task.priorArchives;
        // Persist the delivery list before handing off either archive. A replay
        // may have recovered a different conversation whose receipt would
        // otherwise disappear after its filesystem journal is cleared.
        await setSetting(key(account), state);
        finalManifest = saved.manifest;
      }
      if (!asset && task.priorArchives?.length) {
        // A later source change removed the surviving image. Keep its older
        // receipts until a current archive can be produced, rather than send an
        // obsolete manifest by itself or silently erase the pending delivery.
        throw collectorError('ASSET_SOURCE_MISSING', '附件来源已变化，待交付归档已保留。');
      }
      while (task.pendingArchives?.length) {
        await enqueueArchive({ account, archive: task.pendingArchives[0] });
        task.pendingArchives.shift();
        await setSetting(key(account), state);
      }
      if (task.captureIncomplete && asset && !ready(asset) && asset.status !== 'external') retainTask = true;
      if (suspended(task)) {
        task.error = safeError(collectorError('HTTP_404', '内部附件未下载。')); task.errorStage = 'capture'; task.retryAt = 0;
      } else if (!retainTask) state.tasks = state.tasks.filter(t => t !== task);
      finalManifest ||= manifest;
    } catch (error) {
      task.attempt++; task.error = safeError(error); task.errorStage = operationStage;
      task.retryAt = now() + Math.min(60, 2 ** Math.min(task.attempt, 6)) * 60000;
    }
    delete task.manualRetry; delete task.refreshSource;
    await setSetting(key(account), state);
    if (finalManifest) await status(account, finalManifest);
    else {
      const previous = await getSetting(`assetStatus:${account.accountKey}`) || {};
      await setSetting(`assetStatus:${account.accountKey}`, { ...previous, failed: state.tasks.filter(t => activeTask(t) && t.error).length });
    }
    return { pending: state.tasks.filter(activeTask).length, runnable: state.tasks.some(t => runnable(t) || needsPolicyCheck(t)) };
  }
  async function prepareUploads({ directory, account, config, bundles }) {
    const records = new Map(), sourceLabels = new Map();
    for (const bundle of bundles) for (const file of bundle.files) if (file.path.endsWith('/archive/manifest.json')) {
      const manifest = JSON.parse(file.content);
      for (const [conversationId, entry] of Object.entries(manifest.conversations || {})) for (const asset of entry.assets || []) if (ready(asset)) {
        records.set(asset.localPath, asset); sourceLabels.set(asset.localPath, { conversationId, title: entry.title });
      }
    }
    if (records.size && config.lfsEnabled === false) throw collectorError('LFS_DISABLED', '附件已保存在本地；请启用 LFS 后同步带附件的对话。');
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
      if (!bytes) throw collectorError('ASSET_MISSING', '待上传附件尚未在本地补齐。请先从 GitHub 恢复或补采附件。');
      const identity = uploadIdentity(asset);
      if (!uploaded.has(identity)) {
        if (transferred >= 2) { await progress(); throw collectorError('LFS_UPLOAD_PENDING', '附件正在分批上传，进度已保存。'); }
        await activity.run(account.accountKey, 'upload', { ...sourceLabels.get(asset.localPath), stage: 'upload-image',
          fileName: asset.fileName || asset.localPath.split('/').at(-1), size: asset.size,
          completed: [...records.values()].filter(item => uploaded.has(uploadIdentity(item))).length, total: records.size },
        () => client.upload({ bytes, oid: asset.oid, size: asset.size, mimeType: asset.mimeType }));
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
    // Restoring an archive bypasses save(). Reconcile existing tasks as well as
    // seeding missing ones: a remote ready/visible winner must release an old
    // suspension. Keep any outstanding outbox receipts until delivery finishes.
    const restoredJobs = await jobs(account);
    if ((entry.assets || []).some(asset => canCaptureAsset(asset) && suspended(asset)) ||
        restoredJobs.tasks.some(task => task.conversationId === entry.conversationId && suspended(task))) {
      const manifest = await readAccountManifest(directory, account);
      const current = manifest?.conversations?.[entry.conversationId];
      if (current) {
        const nativeBytes = await readLocalBytes(directory, current.jsonPath, 24 * 1024 * 1024);
        if (!nativeBytes || await hashBytes(nativeBytes) !== current.contentHash) throw collectorError('LOCAL_CONFLICT', '对话原始文件已变化，内部附件任务未恢复。');
        const native = JSON.parse(text(nativeBytes));
        if (nativeId(native) !== entry.conversationId) throw collectorError('INCOMPLETE_DETAIL', '内部附件来源对话不匹配。');
        const extracted = await extractAssets(native);
        const assets = (current.assets || []).map(old => reconcileAssetCapturePolicy(old, extracted.find(item => item.id === old.id)));
        for (const task of restoredJobs.tasks) if (task.conversationId === entry.conversationId && suspended(task)) {
          const asset = assets.find(item => item.id === task.assetId);
          if (!suspended(asset)) {
            delete task.autoRetrySuspended; delete task.error; task.retryAt = 0;
          }
        }
        restoredJobs.tasks = restoredJobs.tasks.filter(task => task.conversationId !== entry.conversationId ||
          deliveryPending(task) || assets.some(asset => asset.id === task.assetId));
        for (const asset of assets) {
          if (!canCaptureAsset(asset) || !suspended(asset) || restoredJobs.tasks.some(task => task.conversationId === entry.conversationId && task.assetId === asset.id)) continue;
          restoredJobs.tasks.push({ conversationId: entry.conversationId, assetId: asset.id, attempt: 0, retryAt: 0,
            autoRetrySuspended: true, policyCheckedHash: current.contentHash, errorStage: 'capture',
            error: safeError(collectorError('HTTP_404', '内部附件未下载。')) });
        }
        await setSetting(key(account), restoredJobs); await status(account, manifest);
      }
    }
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
        if (!remote) throw collectorError('ASSET_POINTER_MISSING', '远端附件指针缺失，已保留待补齐任务。');
        const info = { stage: 'restore-image', title: entry.title, conversationId: entry.conversationId,
          fileName: asset.fileName || asset.localPath.split('/').at(-1), size: asset.size };
        const bytes = await activity.run(account.accountKey, 'restore-images', info, async () => {
          const pointer = parseLfsPointer(text(await downloadRepositoryFile({ config, entry: remote, fetchImpl, maxBytes: 2048 })));
          if (!pointer || pointer.oid !== asset.oid || pointer.size !== asset.size) throw collectorError('ASSET_POINTER_MISMATCH', '附件指针与对话清单不一致。');
          return client.download({ oid: asset.oid, size: asset.size });
        });
        await activity.run(account.accountKey, 'restore-images', { ...info, stage: 'save-image' },
          () => writeLocalAsset({ directory, account, asset, bytes, getSetting, setSetting })); downloaded++;
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
  return { save, tick, diagnostics, retryFailed, prepareUploads, acknowledgeUploads, hydrateAssets };
}
