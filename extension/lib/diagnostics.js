/** Shareable diagnostics are rebuilt from an allowlist, never raw state/log JSON. */
import { sanitizeDetailFailure } from './detail-errors.js';
const stages = new Set(['identify', 'list', 'detail', 'save', 'download', 'save-image', 'check-external',
  'commit', 'apply-remote', 'refresh-source', 'restore-scan', 'restore-file', 'restore-save', 'restore-assets']);
const codes = new Set(['OPERATION_FAILED', 'ACCOUNT_CHANGED', 'ACCOUNT_DISABLED', 'IDENTITY', 'FORMAT', 'STORAGE',
  'NO_DIRECTORY', 'DIRECTORY_PERMISSION', 'DIRECTORY_CHANGED', 'LOCAL_CONFLICT', 'LOCAL_VERIFY', 'ASSET_LOCAL_CONFLICT',
  'SOURCE_UNAVAILABLE', 'SITE_PERMISSION_DENIED', 'SITE_PERMISSION_REQUIRED', 'TAB_REQUIRED', 'TAB_CLOSED', 'TAB_CHANGED',
  'TAB_UNAVAILABLE', 'TAB_UNSUPPORTED', 'COLLECTION_PAUSED', 'PARTIAL_DETAIL', 'INCOMPLETE_DETAIL', 'DETAIL_PAGINATION',
  'DETAIL_CHANGED', 'INVALID_RESPONSE', 'STALE_DETAIL', 'PAGINATION_STALLED', 'ENUMERATION_INCOMPLETE',
  'ASSET_SIZE', 'ASSET_TOO_LARGE', 'ASSET_FORMAT', 'ASSET_RESPONSE', 'ASSET_NOT_IMAGE', 'ASSET_NOT_FILE', 'ASSET_STREAM',
  'ASSET_URL', 'ASSET_REDIRECT', 'ASSET_PROTOCOL', 'ASSET_NETWORK', 'ASSET_TIMEOUT', 'ASSET_PENDING', 'ASSET_SOURCE_MISSING',
  'ASSET_LINK_UNKNOWN', 'ASSET_VARIANT', 'ASSET_HASH', 'ASSET_HASH_MISMATCH', 'ASSET_WRITE', 'ASSET_UNKNOWN',
  'GITHUB_CONFIG', 'GITHUB_CONFLICT', 'GITHUB_PERMISSION', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK']);
const statuses = new Set(['running', 'success', 'failed', 'interrupted', 'pending', 'paused', 'stopped', 'blocked', 'partial', 'completed']);
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
export function diagnosticCode(value) {
  return codes.has(value) || typeof value === 'string' && /^HTTP_[1-5][0-9]{2}$/.test(value) ? value : 'OTHER_ERROR';
}
export function createDiagnosticReport(snapshot, { version, now = Date.now() } = {}) {
  const references = new Map();
  const ref = (kind, value) => {
    if (typeof value !== 'string' || !value) return null;
    const key = `${kind}:${value}`;
    if (!references.has(key)) references.set(key, `${kind}-${references.size + 1}`);
    return references.get(key);
  };
  const records = [];
  for (const channel of ['collection', 'download', 'github', 'restore']) {
    const log = snapshot.channels?.[channel] || {};
    const history = Array.isArray(log.history) ? log.history.slice(0, 200) : [];
    const items = log.current && !history.some(item => item.operationId && item.operationId === log.current.operationId)
      ? [log.current, ...history] : history;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = { channel, stage: stages.has(item.stage) ? item.stage : 'other',
        status: statuses.has(item.status) ? item.status : 'unknown',
        operation: ref('operation', item.operationId), task: ref('task', item.taskId),
        conversation: ref('conversation', item.conversationId),
        asset: ref('asset', item.assetId || (item.fileName ? `${item.conversationId || ''}:${item.fileName}` : null)) };
      for (const key of ['startedAt', 'updatedAt', 'finishedAt', 'size', 'occurrences', 'firstFailedAt', 'recoveredAt']) {
        if (number(item[key]) !== null) record[key] = item[key];
      }
      if (item.code) record.code = diagnosticCode(item.code);
      Object.assign(record, sanitizeDetailFailure({ code: record.code, reason: item.reason }));
      records.push(record);
    }
  }
  const job = snapshot.job;
  const collection = job ? { task: ref('task', job.id), status: statuses.has(job.status) ? job.status : 'unknown',
    mode: ['initial', 'incremental', 'full'].includes(job.mode) ? job.mode : 'unknown' } : null;
  if (collection) {
    for (const key of ['startedAt', 'completedAt', 'discovered', 'processed', 'added', 'updated', 'unchanged', 'skipped', 'failed']) {
      collection[key] = number(job[key]);
    }
    collection.statistics = job.statistics ? Object.fromEntries(['listReads', 'detailReads', 'detailConversations'].map(key => [key, number(job.statistics[key])])) : null;
    if (job.error?.code) collection.error = { code: diagnosticCode(job.error.code),
      ...sanitizeDetailFailure({ code: diagnosticCode(job.error.code), reason: job.error.reason }) };
  }
  return { schemaVersion: 1, extensionVersion: /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version || '') ? version : 'unknown',
    generatedAt: number(now), platform: ['chatgpt', 'doubao'].includes(snapshot.platform) ? snapshot.platform : 'unknown',
    scope: 'selected-account-and-repository-restore', collection, records,
    unavailableChannels: ['collection', 'download', 'github', 'restore'].filter(channel => snapshot.channels?.[channel]?.unavailable === true),
    retention: { days: 7, recordsPerChannel: 200 },
    note: 'Metadata only. Identifiers are aliases within this export; no chat text, titles, filenames, credentials or URLs.' };
}
