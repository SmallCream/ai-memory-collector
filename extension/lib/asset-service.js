/** Persistent attachment work. Native conversations remain authoritative and unchanged. */
import { analyzeAssets, extractAssets, sanitizeAssetRecords, reconcileAssetCapturePolicy } from './assets.js';
import { reconcileFileCitation } from './asset-reconciliation.js';
import { validateExternalAsset } from './chatgpt-assets.js';
import { assetPath, readLocalBytes, verifiedLocalAsset, writeLocalAsset, assetExtension, canCaptureAsset, MAX_ASSET_BYTES } from './asset-store.js';
import { createLfsClient, hashBytes, formatLfsPointer, parseLfsPointer } from './lfs.js';
import { collectorError, safeError } from './config.js';
import { createActivityLog } from './activity-log.js';
import { assetFailureReason, externalAssetFailure, sanitizeAssetFailureDiagnostics } from './asset-failure.js';

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

function heldReason(code, streak, error) {
  if (['LOCAL_CONFLICT', 'ASSET_LOCAL_CONFLICT', 'ASSET_HASH', 'ACCOUNT_CHANGED', 'DIRECTORY_CHANGED'].includes(code)) return 'conflict';
  if (['ASSET_SIZE', 'ASSET_INPUT'].includes(code)) return 'unsupported';
  // Invalid bytes may be an expired link or login response, not proof that
  // the original file's format is unsupported.
  if (streak >= 3 && ['ASSET_FORMAT', 'ASSET_PROTOCOL', 'ASSET_URL', 'ASSET_REDIRECT'].includes(code)) return 'source';
  if (streak >= 3 && code === 'ASSET_LINK_UNKNOWN') {
    const reason = assetFailureReason(error)?.reason;
    return ['external_permission_required', 'external_authentication_required'].includes(reason) ? 'permission' : 'source';
  }
  if (streak >= 3 && ['HTTP_401', 'HTTP_403', 'DIRECTORY_PERMISSION', 'ASSET_PERMISSION'].includes(code)) return 'permission';
  if (streak >= 3 && ['HTTP_404', 'ASSET_SOURCE_MISSING'].includes(code)) return 'source';
  return null;
}

/** Counts describe recognized resources, not just the subset we can download. */
function conversationSummaries(manifest, state, captureEnabled, label) {
  const taskById = new Map(state.tasks.map(task => [`${task.conversationId}:${task.assetId}`, task]));
  return Object.entries(manifest?.conversations || {}).map(([conversationId, entry]) => {
    const result = { conversationId: label(conversationId), title: label(entry.title),
      sourceComplete: entry.sourceCompleteness === 'complete', total: 0, local: 0, external: 0,
      pending: 0, failed: 0, unsupported: 0, internalMissing: 0, paused: 0 };
    for (const asset of new Map((entry.assets || []).map(asset => [asset.id, asset])).values()) {
      result.total++;
      const task = taskById.get(`${conversationId}:${asset.id}`);
      if (ready(asset) && !task?.localMissing) result.local++;
      else if (!canCaptureAsset(asset) || task?.retryHeld === 'unsupported') result.unsupported++;
      else if (asset.sourceType === 'external' || asset.status === 'external') result.external++;
      else if (suspended(asset) || suspended(task)) result.internalMissing++;
      else if (task?.error) result.failed++;
      else if (!captureEnabled && !task?.manualRetry && !deliveryPending(task || {})) result.paused++;
      else result.pending++;
    }
    return result;
  });
}


export function createAssetService({ getSetting, setSetting, readAccountManifest, saveConversation,
  resolveAsset, refreshConversation, enqueueArchive, browser = globalThis.chrome, fetchImpl = globalThis.fetch, downloadRepositoryFile,
  lfsFactory = createLfsClient, now = Date.now }) {
  const ephemeral = new Map();
  const activity = createActivityLog({ getSetting, setSetting, now });
  async function jobs(account) { return await getSetting(key(account)) || { tasks: [] }; }
  async function getCooldown(account) { return (await jobs(account)).cooldownUntil || 0; }
  function recordFailure(task, error, stage, state, sourceHash) {
    task.attempt = (task.attempt || 0) + 1;
    task.failureStreak = (task.failureStreak || 0) + 1;
    task.error = safeError(error); task.errorStage = stage;
    const responseDiagnostics = sanitizeAssetFailureDiagnostics(error?.diagnostics);
    if (responseDiagnostics.length) task.error.diagnostics = responseDiagnostics;
    if (sourceHash) task.retrySourceHash = sourceHash;
    const hold = heldReason(task.error.code, task.failureStreak, task.error);
    if (hold) task.retryHeld = hold; else delete task.retryHeld;
    const backoff = task.failureStreak >= 6 ? 6 * 60 * 60_000 : Math.min(60, 2 ** Math.min(task.failureStreak, 6)) * 60000;
    const supplied = Number(error?.retryAfterMs);
    const serverWait = Number.isFinite(supplied) && supplied >= 0 ? Math.min(supplied, 24 * 60 * 60_000) : 0;
    if (serverWait) task.error.retryAfterMs = serverWait;
    task.retryAt = hold ? 0 : now() + Math.max(backoff, serverWait);
    if (task.error.code === 'HTTP_429') state.cooldownUntil = Math.max(state.cooldownUntil || 0, task.retryAt);
  }
  const label = value => String(value || '').replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]').replace(/Bearer\s+[^\s,;]+/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
  async function diagnostics({ directory, account, github, captureEnabled = true }) {
    const state = await jobs(account);
    let manifest;
    if (directory) { try { manifest = await readAccountManifest(directory, account); } catch { /* queue remains readable without directory access */ } }
    const failures = state.tasks.filter(task => activeTask(task) && task.error);
    const internal = state.tasks.filter(suspended);
    const describe = task => {
      const entry = manifest?.conversations?.[task.conversationId], asset = entry?.assets?.find(a => a.id === task.assetId);
      const reason = assetFailureReason(task.error);
      return { conversationId: label(task.conversationId), assetId: label(task.assetId),
        conversationTitle: label(entry?.title), fileName: label(asset?.fileName),
        messageId: label(asset?.messageId), fileId: label(asset?.fileId), libraryFileId: label(asset?.libraryFileId),
        code: safeError(task.error).code, ...(reason ? { reason: reason.reason } : {}),
        responseDiagnostics: sanitizeAssetFailureDiagnostics(task.error?.diagnostics),
        message: reason?.message || '附件处理未完成，请根据错误代码检查后重试。',
        attempt: Number.isSafeInteger(task.attempt) && task.attempt >= 0 ? task.attempt : 0,
        retryAt: Number.isFinite(task.retryAt) ? task.retryAt : 0,
        ...(task.retryHeld ? { waitingFor: task.retryHeld } : {}) };
    };
    const captureItems = state.tasks.slice(0, 50).map(task => {
      const item = describe(task);
      return { conversationId: item.conversationId, title: item.conversationTitle,
        fileName: item.fileName || item.fileId || item.libraryFileId || (/^[a-f0-9]{64}$/.test(item.assetId) ? `附件 ${item.assetId.slice(0, 12)}` : ''),
        status: deliveryPending(task) ? 'delivering' : task.manualRetry ? 'pending' : suspended(task) ? 'internal-missing' :
          !captureEnabled ? 'paused-setting' : task.retryHeld ? `waiting-${task.retryHeld}` :
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
          status: uploaded.has(id) ? 'uploaded' : github?.lfsEnabled === false ? 'local-only' : 'pending',
        });
      }
    }
    const uploadItems = [...uploadRecords.values()].sort((a, b) => Number(a.status === 'uploaded') - Number(b.status === 'uploaded')).slice(0, 50);
    const conversations = conversationSummaries(manifest, state, captureEnabled, label);
    return { total: state.tasks.length, pending: state.tasks.filter(activeTask).length, failed: failures.length,
      captureEnabled, cooldownUntil: state.cooldownUntil || 0,
      conversations: conversations.slice(0, 200), conversationTotal: conversations.length,
      unsupported: conversations.reduce((sum, item) => sum + item.unsupported, 0),
      paused: conversations.reduce((sum, item) => sum + item.paused, 0),
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
      task.retryAt = 0; task.manualRetry = true; task.refreshSource = true; delete task.retryHeld;
    }
    await setSetting(key(account), state);
  }
  async function requestMissing({ account }) {
    const state = await jobs(account);
    let requested = 0;
    for (const task of state.tasks) if (!suspended(task)) {
      task.manualRetry = true; task.refreshSource = true; task.retryAt = 0;
      delete task.retryHeld; requested++;
    }
    // The persisted account cooldown intentionally survives an explicit retry.
    await setSetting(key(account), state);
    return { requested };
  }
  async function requeueMissing({ directory, account, conversationId, assetId, manual = false }) {
    const manifest = await readAccountManifest(directory, account), entry = manifest?.conversations?.[conversationId];
    const asset = entry?.assets?.find(item => item.id === assetId);
    if (!asset || !ready(asset)) return { queued: false };
    // A maintenance hint is not permission to replace an edited file. Verify
    // against the original digest, and only queue a genuinely absent binary.
    if (await verifiedLocalAsset({ directory, account, asset, getSetting })) return { queued: false };
    const state = await jobs(account);
    let task = state.tasks.find(item => item.conversationId === conversationId && item.assetId === assetId);
    if (!task) { task = { conversationId, assetId, attempt: 0, retryAt: 0 }; state.tasks.push(task); }
    task.localMissing = true;
    if (manual) { task.manualRetry = true; task.refreshSource = true; task.retryAt = 0; delete task.retryHeld; }
    await setSetting(key(account), state);
    await status(account, manifest);
    return { queued: true };
  }
  async function status(account, manifest) {
    const state = await jobs(account);
    const missing = new Set(state.tasks.filter(task => task.localMissing).map(task => task.assetId));
    const unique = new Map();
    for (const entry of Object.values(manifest?.conversations || {})) for (const asset of entry.assets || []) unique.set(asset.id, asset);
    const result = { external: 0, pendingCapture: 0, local: 0, uploaded: 0, pendingUpload: 0, failed: 0, internalMissing: 0, unsupported: 0 };
    const managed = new Map();
    for (const asset of unique.values()) {
      if (ready(asset) && !missing.has(asset.id)) managed.set(uploadIdentity(asset), asset);
      else if (!canCaptureAsset(asset)) result.unsupported++;
      else if (asset.sourceType === 'external' || asset.status === 'external') result.external++;
      else if (suspended(asset)) result.internalMissing++;
      else result.pendingCapture++;
    }
    result.local = managed.size;
    result.failed = state.tasks.filter(t => activeTask(t) && t.error).length;
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
    const analysis = await analyzeAssets(detail.payload);
    const extracted = [...analysis.assets];
    const ordinaryLinks = new Set(analysis.ordinaryLinkIds);
    for (const previous of old) {
      if (ordinaryLinks.has(previous.id) &&
          (previous.sourceType !== 'external' || previous.localPath || previous.oid || previous.sha256) &&
          !extracted.some(asset => asset.id === previous.id)) extracted.push(previous);
    }
    const assets = [];
    for (const asset of extracted) {
      if (asset.retrieval) ephemeral.set(`${account.accountKey}:${id}:${asset.id}`, asset.retrieval);
      const previous = oldMap.get(asset.id);
      if (previous && ready(previous)) {
        // A manifest receipt alone does not prove the binary still exists.
        // Missing bytes return to capture; differing bytes remain a conflict.
        const present = await verifiedLocalAsset({ directory, account, asset: previous, getSetting });
        const existing = { ...asset, ...previous, references: asset.references, occurrences: asset.occurrences };
        if (present) delete existing.cloudStatus;
        if (present) assets.push(reconcileAssetCapturePolicy(existing, asset));
        else {
          const missing = { ...asset, status: 'pending', sha256: previous.oid };
          delete missing.oid; delete missing.localPath; delete missing.size;
          assets.push(missing);
        }
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
      if (task?.retrySourceHash && task.retrySourceHash !== saved.entry?.contentHash) {
        delete task.retryHeld; delete task.retrySourceHash; task.failureStreak = 0; task.retryAt = 0;
      }
      if (ready(asset) || asset.status === 'external') {
        if (task) delete task.localMissing;
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
      delete task.policyCheckedHash; delete task.interfacePolicyCheckedHash; delete task.ordinaryLinkPolicyCheckedHash;
    }
    await setSetting(key(account), state);
    await status(account, saved.manifest);
    return saved;
  }
  async function external(asset) {
    const result = await validateExternalAsset({ url: asset.sourceRef, asset, browser, fetchImpl, maxBytes: MAX_ASSET_BYTES });
    if (result.status !== 'external') {
      const failure = externalAssetFailure(result);
      throw collectorError(failure.code, failure.message);
    }
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
      delete managed.errorCode; delete managed.cloudStatus;
      return { managed, bytes };
    });
    await activity.run(request.account.accountKey, 'download', { ...info, stage: 'save-image', size: bytes.length },
      () => writeLocalAsset({ ...request, asset: managed, bytes, getSetting, setSetting }));
    return managed;
  }
  async function tick({ directory, account, tabId, manualOnly = false, captureEnabled = true, networkAllowed = true }) {
    const state = await jobs(account);
    const runnable = task => (!manualOnly || task.manualRetry === true || deliveryPending(task)) &&
      (captureEnabled || task.manualRetry === true || task.pendingArchives?.length || task.interfaceRetirement) &&
      (networkAllowed || task.pendingArchives?.length || task.interfaceRetirement) &&
      (!task.retryHeld || task.manualRetry === true) &&
      (task.pendingArchives?.length || task.interfaceRetirement || (state.cooldownUntil || 0) <= now()) &&
      (activeTask(task) || task.manualRetry === true) && (task.retryAt || 0) <= now();
    const unreviewedInterfaceInput = task => !task.interfacePolicyCheckedHash &&
      task.error?.code === 'ASSET_INPUT' && (!task.errorStage || task.errorStage === 'capture');
    const unreviewedOrdinaryLink = task => !task.ordinaryLinkPolicyCheckedHash &&
      task.error?.code === 'ASSET_LINK_UNKNOWN' && (!task.errorStage || task.errorStage === 'capture');
    const needsInterfaceCheck = task => !manualOnly && (unreviewedInterfaceInput(task) || unreviewedOrdinaryLink(task));
    const needsPolicyCheck = task => !manualOnly && !suspended(task) && !task.policyCheckedHash &&
      task.error?.code === 'HTTP_404' && (!task.errorStage || task.errorStage === 'capture') && !deliveryPending(task);
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
          delete task.autoRetrySuspended;
          recordFailure(task, error, 'archive', state, entry?.contentHash);
        }
        changed = true;
      }
      if (changed) await setSetting(key(account), state);
    }
    const task = state.tasks.find(t => runnable(t) || needsPolicyCheck(t) || needsInterfaceCheck(t));
    if (!task) return { pending: state.tasks.filter(activeTask).length, runnable: false };
    let finalManifest, retainTask = false, operationStage = 'archive';
    try {
      const manifest = await readAccountManifest(directory, account), entry = manifest?.conversations?.[task.conversationId];
      finalManifest = manifest;
      let asset = entry?.assets?.find(a => a.id === task.assetId);
      if (entry && (asset || task.interfaceRetirement) &&
          (!task.pendingArchives?.length || task.interfaceRetirement === 'prepare' || unreviewedInterfaceInput(task) || unreviewedOrdinaryLink(task))) {
        const nativeBytes = await readLocalBytes(directory, entry.jsonPath, 24 * 1024 * 1024);
        if (!nativeBytes || await hashBytes(nativeBytes) !== entry.contentHash) throw collectorError('LOCAL_CONFLICT', '对话原始文件已变化，附件任务暂停以保护原文件。');
        const native = JSON.parse(text(nativeBytes));
        if (nativeId(native) !== task.conversationId) throw collectorError('INCOMPLETE_DETAIL', '附件来源对话不匹配，保留已有记录等待检查。');
        const analysis = await analyzeAssets(native);
        task.interfacePolicyCheckedHash = entry.contentHash;
        task.ordinaryLinkPolicyCheckedHash = entry.contentHash;
        const ordinaryLinks = (analysis.ordinaryLinkIds || []).filter(id => {
          const record = entry.assets?.find(item => item.id === id);
          // Existing managed bytes are never discarded by a link-policy change.
          return !record || (record.sourceType === 'external' && !record.localPath && !record.oid && !record.sha256);
        });
        const retired = new Set([...analysis.interfaceIconIds, ...ordinaryLinks]);
        if (retired.has(task.assetId)) {
          // Native context proves UI icons or ordinary file-viewer hyperlinks;
          // an error code or basename alone is never retirement evidence.
          // Keep one durable carrier until all older receipts and the corrected
          // archive have reached the outbox. The marker survives a worker stop
          // between removing the descriptor and checkpointing that archive.
          const duplicates = state.tasks.filter(other => other !== task && other.conversationId === task.conversationId && retired.has(other.assetId));
          task.priorArchives = [...(task.priorArchives || []), ...(task.pendingArchives || []),
            ...duplicates.flatMap(other => [...(other.priorArchives || []), ...(other.pendingArchives || [])])];
          delete task.pendingArchives;
          task.interfaceRetirement = 'prepare';
          // The old source/permission hold must not block replay of this local
          // correction after its manifest commits but before delivery checkpoints.
          delete task.retryHeld; task.retryAt = 0;
          state.tasks = state.tasks.filter(other => !duplicates.includes(other));
          await setSetting(key(account), state);
          const saved = await saveConversation({ directory, account,
            assets: sanitizeAssetRecords((entry.assets || []).filter(item => !retired.has(item.id))), detail: {
              payload: native, identity: { accountKey: account.accountKey, displayName: account.displayName },
              capturedAt: entry.lastChangedAt || new Date(now()).toISOString(), completeness: entry.sourceCompleteness,
            } });
          const { recovered, ...current } = saved;
          task.pendingArchives = [...task.priorArchives, ...(recovered ? [recovered, current] : [current])];
          delete task.priorArchives; delete task.captureIncomplete; delete task.autoRetrySuspended;
          delete task.error; delete task.errorStage;
          task.retryAt = 0; task.interfaceRetirement = 'deliver';
          await setSetting(key(account), state);
          finalManifest = saved.manifest;
          asset = undefined;
        } else if (!task.pendingArchives?.length && asset) {
          delete task.interfaceRetirement;
          const original = asset;
          const reconciliation = await reconcileFileCitation(asset, entry.assets, analysis.assets);
          asset = reconciliation.asset;
          let fresh = reconciliation.fresh;
          asset = reconcileAssetCapturePolicy(asset, fresh);
          const migrate404 = !task.manualRetry && !task.policyCheckedHash && !ready(asset) && asset.status !== 'external' &&
            asset.capturePolicy === 'internal-viewer' && task.error?.code === 'HTTP_404' && (!task.errorStage || task.errorStage === 'capture');
          task.policyCheckedHash = entry.contentHash;
          if (!runnable(task) && !migrate404) {
            await setSetting(key(account), state);
            return { pending: state.tasks.filter(activeTask).length, runnable: state.tasks.some(t => runnable(t) || needsPolicyCheck(t) || needsInterfaceCheck(t)) };
          }
          if (reconciliation.retired.length && nativeId(native) !== task.conversationId) {
            throw collectorError('INCOMPLETE_DETAIL', '附件来源对话不匹配，保留已有记录等待检查。');
          }
          if (ready(asset) &&
              !await verifiedLocalAsset({ directory, account, asset, getSetting })) {
            if (asset.sha256 && asset.sha256 !== asset.oid) throw collectorError('ASSET_HASH', '附件内容摘要记录冲突，已保留已有记录。');
            asset = { ...asset, status: 'pending', sha256: asset.oid };
            delete asset.oid; delete asset.localPath; delete asset.size;
            task.localMissing = true;
          }
          const wasSuspended = suspended(asset) || suspended(task);
          let sourceFailure;
          let retrieval = ephemeral.get(`${account.accountKey}:${task.conversationId}:${asset.id}`) || fresh?.retrieval;
          if (!migrate404 && !(suspended(asset) && !task.manualRetry) && (!ready(original) || task.localMissing) && original.status !== 'external' && refreshConversation && (task.refreshSource || task.error)) {
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
              if (error?.code === 'COLLECTION_PAUSED') throw error;
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
              delete task.autoRetrySuspended; delete task.localMissing; delete task.retryHeld;
            } catch (error) {
              if (error?.code === 'COLLECTION_PAUSED') throw error;
              const failure = safeError(error);
              if (!wasSuspended && (asset.capturePolicy !== 'internal-viewer' || failure.code !== 'HTTP_404')) throw error;
              completed = reconcileAssetCapturePolicy({ ...asset, status: 'unavailable', errorCode: failure.code,
                autoRetrySuspended: !sourceFailure && asset.capturePolicy === 'internal-viewer' && failure.code === 'HTTP_404' }, fresh);
              recordFailure(task, error, sourceFailure ? 'source' : 'capture', state, entry.contentHash);
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
      // A user pause or account switch can cancel a network request. Keep the
      // work pending without spending its failure budget or rewriting source.
      if (error?.code !== 'COLLECTION_PAUSED') {
        recordFailure(task, error, operationStage, state, finalManifest?.conversations?.[task.conversationId]?.contentHash);
      }
    }
    delete task.manualRetry; delete task.refreshSource;
    await setSetting(key(account), state);
    if (finalManifest) await status(account, finalManifest);
    else {
      const previous = await getSetting(`assetStatus:${account.accountKey}`) || {};
      await setSetting(`assetStatus:${account.accountKey}`, { ...previous, failed: state.tasks.filter(t => activeTask(t) && t.error).length });
    }
    return { pending: state.tasks.filter(activeTask).length, runnable: state.tasks.some(t => runnable(t) || needsPolicyCheck(t) || needsInterfaceCheck(t)) };
  }
  async function prepareUploads({ directory, account, config, bundles, isCurrent = async () => true,
    withCurrent = async operation => { await operation(); return true; } }) {
    const changedTarget = () => collectorError('GITHUB_TARGET_CHANGED', '备份设置已更新，旧上传任务已停止。');
    async function requireCurrent() { if (!await isCurrent()) throw changedTarget(); }
    async function writeCurrent(operation) {
      await requireCurrent();
      if (!await withCurrent(operation)) throw changedTarget();
    }
    // Activity is observational but must not overwrite the new target's status
    // when an old upload finishes. No network request runs under this lock.
    const uploadActivity = createActivityLog({ getSetting, now,
      setSetting: (key, value) => writeCurrent(() => setSetting(key, value)) });
    await requireCurrent();
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
      await writeCurrent(() => setSetting(uploadKey(account), checkpoint));
    }
    let receipts = await getSetting(receiptKey(account));
    if (!receipts || receipts.repository !== target.repository || receipts.branch !== target.branch ||
        !Array.isArray(receipts.uploaded) || !await sameDirectory(receipts.directory)) {
      receipts = { schemaVersion: 1, ...target, directory, uploaded: [] };
      await writeCurrent(() => setSetting(receiptKey(account), receipts));
    }
    const uploaded = new Set(checkpoint.uploaded), receiptSet = new Set(receipts.uploaded);
    // LFS performs multiple HTTP requests per file (batch, PUT, verify). A
    // changed setting must prevent the next request even inside one upload().
    const currentFetch = async (...args) => {
      await requireCurrent();
      return fetchImpl.call(globalThis, ...args);
    };
    const client = records.size ? lfsFactory({ repository: config.repository, token: config.token, branch: config.branch,
      fetchImpl: currentFetch, maxBytes: MAX_ASSET_BYTES }) : null;
    const pointers = [];
    let transferred = 0;
    async function progress() {
      await writeCurrent(async () => {
        const previous = await getSetting(`assetStatus:${account.accountKey}`) || {};
        const count = [...records.values()].filter(asset => uploaded.has(uploadIdentity(asset))).length;
        await setSetting(`assetStatus:${account.accountKey}`, { ...previous, local: records.size, uploaded: count, pendingUpload: records.size - count });
      });
    }
    for (const asset of records.values()) {
      await requireCurrent();
      const bytes = await verifiedLocalAsset({ directory, account, asset, getSetting });
      if (!bytes) throw collectorError('ASSET_MISSING', '待上传附件尚未在本地补齐。请先从 GitHub 恢复或补采附件。');
      const identity = uploadIdentity(asset);
      if (!uploaded.has(identity)) {
        if (transferred >= 2) { await progress(); throw collectorError('LFS_UPLOAD_PENDING', '附件正在分批上传，进度已保存。'); }
        await uploadActivity.run(account.accountKey, 'upload', { ...sourceLabels.get(asset.localPath), stage: 'upload-image',
          fileName: asset.fileName || asset.localPath.split('/').at(-1), size: asset.size,
          completed: [...records.values()].filter(item => uploaded.has(uploadIdentity(item))).length, total: records.size },
        async () => {
          await requireCurrent();
          try { await client.upload({ bytes, oid: asset.oid, size: asset.size, mimeType: asset.mimeType }); }
          catch (error) {
            // The transport redacts arbitrary thrown errors. Recover our own
            // cancellation classification before reporting a network failure.
            await requireCurrent(); throw error;
          }
          await requireCurrent();
        });
        await requireCurrent();
        transferred++; uploaded.add(identity); receiptSet.add(identity);
        checkpoint.uploaded = [...uploaded]; receipts.uploaded = [...receiptSet];
        await writeCurrent(async () => {
          await setSetting(receiptKey(account), receipts);
          await setSetting(uploadKey(account), checkpoint);
        });
        await progress();
      }
      pointers.push({ accountKey: account.accountKey, path: asset.localPath, oid: asset.oid, size: asset.size,
        content: formatLfsPointer({ oid: asset.oid, size: asset.size }) });
    }
    await progress();
    await requireCurrent();
    return pointers;
  }
  async function acknowledgeUploads(account) { await setSetting(uploadKey(account), null); }
  async function hydrateAssets({ directory, account, entry, remoteEntry, config, snapshot }) {
    if (remoteEntry && entry.conversationId && remoteEntry.conversationId !== entry.conversationId) {
      throw collectorError('ASSET_POINTER_MISMATCH', '恢复附件的远端对话归属不匹配。');
    }
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
    const cloudRecords = remoteEntry ? new Map((remoteEntry.assets || []).map(asset => [asset.id, asset])) : null;
    const backedUp = asset => {
      if (!cloudRecords) return asset.cloudStatus !== 'local-only';
      const remote = cloudRecords.get(asset.id);
      return Boolean(remote && ready(remote) && remote.cloudStatus !== 'local-only' && uploadIdentity(remote) === uploadIdentity(asset));
    };
    let cloudMissing = 0;
    for (const asset of (entry.assets || []).filter(asset => ready(asset) && !backedUp(asset))) {
      if (!await verifiedLocalAsset({ directory, account, asset, getSetting })) {
        cloudMissing++;
        // Text-only backup is not a promise that GitHub has these bytes. Keep
        // platform-source repair separate from this completed cloud transfer.
        if (entry.conversationId) await requeueMissing({ directory, account, conversationId: entry.conversationId, assetId: asset.id });
      }
    }
    const assets = [...new Map((entry.assets || []).filter(asset => ready(asset) && backedUp(asset)).map(asset => [uploadIdentity(asset), asset])).values()];
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
    if (remaining) return { downloaded, pending: remaining, failed: 0, ...(cloudMissing ? { cloudMissing } : {}) };
    const unresolved = Object.values(checkpoint.failures);
    if (unresolved.length) throw collectorError(unresolved[0].error.code, unresolved[0].error.message);
    return { downloaded, pending: remaining, failed: 0, ...(cloudMissing ? { cloudMissing } : {}) };
  }
  return { save, tick, diagnostics, retryFailed, requestMissing, requeueMissing, getCooldown, prepareUploads, acknowledgeUploads, hydrateAssets };
}
