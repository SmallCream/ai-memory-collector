import { getSetting, setSetting } from './lib/storage.js';
import { detailFailureMessage, sanitizeDetailFailure } from './lib/detail-errors.js';
import { assetFailureDiagnosticMessage, assetFailureAttemptSummaries } from './lib/asset-failure.js';

const $ = id => document.getElementById(id);
const setupPage = new URL(location.href).searchParams.get('setup') === '1';
const sourceParameter = new URL(location.href).searchParams.get('tab');
const sourceTabId = sourceParameter !== null && /^\d+$/.test(sourceParameter) ? Number(sourceParameter) : null;
let current = null;
let fullCaptureAccount = null;
let directory = null;
let screen = 'home';
let step = 0;
let busy = false;
let started = false;
let wizardGithubVerified = false;
let wizardLocalLoaded = false;
let settingsLoaded = false;
let stateRevision = 0;
let activeAliasKey = null;
let externalImagePermission = false;
let diagnosticSnapshot = null, diagnosticExport = null, diagnosticRevision = 0;
let refreshPending = null;
let refreshChecksIdentity = false;
const renderedLists = new Map();
const runningStatuses = new Set(['running', 'scanning', 'collecting', 'saving', 'syncing']);
const pausedStatuses = new Set(['paused', 'blocked', 'waiting', 'retrying', 'interrupted', 'waiting-source', 'waiting-permission', 'partial']);
const controls = () => document.querySelectorAll('button,input,select');
const waitReasons = { unsupported: '等待格式适配或手动重试', permission: '等待登录或授权',
  conflict: '等待处理本地改动', source: '等待来源恢复或手动重试' };
const show = (id, visible) => { $(id).hidden = !visible; };
const text = (id, value) => { const element = $(id); const next = String(value ?? ''); if (element.textContent !== next) element.textContent = next; };
const safeMessage = value => String(typeof value === 'string' ? value : value?.message || '操作未完成，请稍后重试。')
  .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]')
  .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]');
function feedback(message = '', error = false) {
  text('global-status', safeMessage(message));
  $('global-status').classList.toggle('error', error);
}
function errorObject(error) {
  const e = new Error(safeMessage(error?.message || error));
  e.code = typeof error?.code === 'string' ? error.code : 'UI_ERROR';
  return e;
}
async function send(type, fields = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...(sourceTabId === null ? {} : { tabId: sourceTabId }), ...fields });
  if (!reply?.ok) throw errorObject(reply?.error || '后台暂未响应，请重新加载扩展后重试。');
  if (reply.state) { stateRevision++; current = reply.state; }
  return reply;
}
function time(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function count(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 ? String(Number(value)) : '0'; }
function restoreMissingAssets(restore) {
  const value = restore?.cloudMissing ?? restore?.progress?.cloudMissing;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function restoreMissingMessage(restore) {
  const missing = restoreMissingAssets(restore);
  if (!missing) return '';
  const conversations = restore?.missingCloudConversations ?? restore?.progress?.missingCloudConversations;
  const scope = Number.isSafeInteger(conversations) && conversations > 0 ? `（涉及 ${count(conversations)} 条对话）` : '';
  return `本地缺少 ${count(missing)} 个附件${scope}。已恢复的文件会保留；请从原电脑复制本地附件目录，或从仍可访问的原始对话补采。GitHub 仅恢复对话文件。`;
}
function assetFailureCode(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(value) ? value : 'ASSET_UNKNOWN'; }
function assetFailureMessage(code) {
  // Error strings can originate in network/extension APIs. Only fixed messages
  // reach this diagnostic view; response bodies, signed URLs and tokens do not.
  if (/^(?:HTTP_401|HTTP_403|IDENTITY)$/.test(code)) return '请确认来源平台已登录，且当前账号可以打开原始附件。';
  if (code === 'HTTP_404') return '请求的附件入口返回 404。可能是来源已失效或下载入口不匹配，尚不能据此判断文件已删除。';
  if (code === 'HTTP_429') return '附件请求受到限流，请稍后重试。';
  if (/^HTTP_5\d\d$/.test(code)) return '附件服务暂时不可用，请稍后重试。';
  if (code === 'ACCOUNT_CHANGED') return '账号已切换，已停止处理。请回到附件所属账号后重试。';
  if (/^(?:TAB_|ORIGIN)/.test(code)) return '请打开所属账号的来源平台标签页，并确认站点访问权限。';
  if (code === 'ASSET_PENDING') return '尚未取得可确认归属的原始附件。可打开对应对话和附件后重试；部分资源仍需适配。';
  if (code === 'ASSET_SOURCE_MISSING') return '最新对话中未找到此附件，已有文件和任务已保留。请打开对应对话检查后重试。';
  if (code === 'INCOMPLETE_DETAIL') return '本次返回的对话详情不完整，未覆盖已保存数据。请稍后重试。';
  if (/^(?:ASSET_URL|ASSET_REDIRECT|ASSET_PROTOCOL)$/.test(code)) return '附件下载地址或跳转尚未支持。可打开原始附件后重试；部分资源仍需适配。';
  if (/^(?:ASSET_NETWORK|ASSET_TIMEOUT)$/.test(code)) return '附件下载未完成，请检查网络后重试。';
  if (code === 'ASSET_LINK_UNKNOWN') return '外部链接尚未验证；原链接已保留。这不等于 ChatGPT 附件下载失败，请查看具体原因。';
  if (/^(?:ASSET_SIZE|ASSET_TOO_LARGE)$/.test(code)) return '附件数据为空或超过当前处理上限。';
  if (/^(?:ASSET_FORMAT|ASSET_RESPONSE|ASSET_NOT_IMAGE|ASSET_NOT_FILE|ASSET_STREAM)$/.test(code)) return '未取得受支持的完整附件，任务已保留。';
  if (/^(?:ASSET_VARIANT|ASSET_HASH|ASSET_HASH_MISMATCH)$/.test(code)) return '下载内容与原始附件信息不一致，未保存。';
  if (/^(?:LOCAL_CONFLICT|ASSET_LOCAL_CONFLICT)$/.test(code)) return '本地文件已变化，已保留原文件。请检查对应对话或附件。';
  if (code === 'DIRECTORY_PERMISSION') return '请恢复保存目录的读写权限。';
  if (code === 'DIRECTORY_CHANGED') return '附件写入尚未完成，请恢复原保存目录后重试。';
  if (code === 'ASSET_WRITE') return '附件写入未完成，请检查保存目录后重试。';
  return '本次附件处理未完成，任务已保留。可根据错误代码继续排查。';
}
function assetLabel(value, fallback) {
  return safeMessage(typeof value === 'string' && value ? value : fallback)
    .replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
}
function attachmentName(failure, fallback = '未命名附件') {
  const id = /^file[-_][A-Za-z0-9_-]{1,160}$/.test(failure.fileId || '') ? failure.fileId :
    /^libfile_[A-Za-z0-9_-]{1,160}$/.test(failure.libraryFileId || '') ? failure.libraryFileId :
      /^[a-f0-9]{64}$/.test(failure.assetId || '') ? `附件 ${failure.assetId.slice(0, 12)}` : fallback;
  return assetLabel(failure.fileName, id);
}
function renderAssetFailures(diagnostics) {
  const failures = Array.isArray(diagnostics?.failures) ? diagnostics.failures : [];
  show('asset-failures', failures.length > 0);
  text('asset-failures-heading', `查看失败原因（${count(diagnostics?.failed)}）`);
  show('asset-failures-limit', Number(diagnostics?.failed) > failures.length);
  text('asset-failures-limit', `仅显示前 ${failures.length} 条失败记录，其余任务仍会保留。`);
  const list = $('asset-failure-list');
  list.replaceChildren();
  for (const failure of failures) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = assetLabel(failure.conversationTitle, '未命名对话');
    const filename = document.createElement('p');
    filename.textContent = attachmentName(failure);
    const code = assetFailureCode(failure.code);
    const explanation = document.createElement('p');
    explanation.textContent = assetFailureDiagnosticMessage({ code, reason: failure.reason }) || assetFailureMessage(code);
    const metadata = document.createElement('p'); metadata.classList.add('muted');
    const held = waitReasons[failure.waitingFor] || (failure.retryHeld ? '等待条件恢复或手动重试' : '');
    metadata.textContent = `${code} · 已尝试 ${count(failure.attempt)} 次${held ? ` · ${held}` : time(failure.retryAt) ? ` · 重试等待至 ${time(failure.retryAt)}` : ''}`;
    item.append(title, filename, explanation, metadata);
    for (const summary of assetFailureAttemptSummaries(failure.responseDiagnostics)) {
      const response = document.createElement('p'); response.classList.add('muted'); response.textContent = summary;
      item.append(response);
    }
    list.append(item);
  }
}
function renderInternalAttachments(diagnostics, missing) {
  const failures = Array.isArray(diagnostics?.internalFailures) ? diagnostics.internalFailures : [];
  show('asset-internal', missing > 0);
  text('asset-internal-heading', `内部附件未下载（${count(missing)}）`);
  show('asset-internal-limit', missing > failures.length);
  text('asset-internal-limit', `仅显示前 ${failures.length} 条记录，其余来源记录仍会保留。`);
  const list = $('asset-internal-list');
  list.replaceChildren();
  for (const failure of failures) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = assetLabel(failure.conversationTitle, '未命名对话');
    const filename = document.createElement('p');
    filename.textContent = attachmentName(failure, '未命名内部附件');
    const explanation = document.createElement('p');
    explanation.textContent = '工具内部看图附件（container.open_image），尚未取得原始图片。';
    const metadata = document.createElement('p'); metadata.classList.add('muted');
    metadata.textContent = `${assetFailureCode(failure.code)} · 已尝试 ${count(failure.attempt)} 次 · 已停止自动重试`;
    item.append(title, filename, explanation, metadata);
    if (failure.messageId || failure.fileId) {
      const source = document.createElement('p'); source.classList.add('muted');
      source.textContent = [failure.messageId ? `消息：${assetLabel(failure.messageId, '')}` : '',
        failure.fileId ? `文件：${assetLabel(failure.fileId, '')}` : ''].filter(Boolean).join(' · ');
      item.append(source);
    }
    list.append(item);
  }
}
const activityStages = { identify: '核验账号与保存位置', list: '读取对话列表', detail: '读取对话详情',
  save: '保存对话文件', download: '下载对话附件', 'save-image': '保存附件到本地',
  github: '同步 GitHub', sync: '提交对话到 GitHub', 'sync-archives': '提交对话到 GitHub',
  commit: '提交对话到 GitHub', 'apply-remote': '写入远端合并结果', 'refresh-source': '刷新附件下载来源',
  'restore-snapshot': '读取仓库目录', 'restore-metadata': '读取归档清单',
  'restore-conversation': '恢复对话文件', restore: '恢复仓库文件',
  'restore-scan': '读取仓库目录', 'restore-file': '下载对话归档', 'restore-save': '保存恢复的对话', 'restore-assets': '补齐归档附件' };
const taskStatuses = { pending: '排队中', retry: '等待重试', failed: '失败待处理', saved: '已保存',
  skipped: '无变化，已跳过', downloaded: '已下载', 'internal-missing': '内部附件未下载',
  suspended: '内部附件未下载', delivering: '正在交付归档', queued: '排队中', waiting: '等待处理',
  running: '正在处理', external: '保留外链', unavailable: '尚未取得',
  'paused-by-setting': '按设置暂停下载', 'paused-setting': '按设置暂停下载', paused: '已暂停',
  held: '等待条件恢复', 'retry-held': '等待条件恢复', unsupported: '暂不支持', 'local-only': '仅保存在本地',
  'waiting-unsupported': '等待格式适配或手动重试', 'waiting-permission': '等待登录或授权',
  'waiting-conflict': '等待处理本地改动', 'waiting-source': '等待来源恢复或手动重试' };
const activityStatuses = { running: '正在处理', success: '本步骤完成', failed: '本步骤未完成', interrupted: '上次处理已中断' };
function clock(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
function duration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
function fileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '';
  return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(size / 1024))} KiB`;
}
function activityName(item) { return activityStages[item?.stage] || '处理任务'; }
function activityTitle(item) {
  return [item?.title, item?.fileName].filter(value => typeof value === 'string' && value)
    .map(value => assetLabel(value, '')).join(' · ') || assetLabel(item?.conversationId, '未命名任务');
}
function appendText(parent, tag, value, className) {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.classList.add(className);
  parent.append(element); return element;
}
function cloudVisibility() {
  const github = current?.config?.github || {}, status = current?.githubStatus || {};
  const upload = github.enabled === true || status.manual === true ||
    current?.activity?.github?.current?.status === 'running';
  const restore = github.autoRestore === true || Boolean(current?.restoreStatus && current.restoreStatus.status !== 'idle') ||
    current?.activity?.restore?.current?.status === 'running';
  return { upload, restore };
}
function renderCompleteness(diagnostics) {
  const rows = Array.isArray(diagnostics?.conversations) ? diagnostics.conversations.slice(0, 50) : [];
  const total = Math.max(rows.length, Number(diagnostics?.conversationTotal) || 0);
  show('archive-completeness', rows.length > 0);
  text('archive-completeness-badge', total ? `${count(total)} 条归档` : '');
  text('archive-completeness-note', `${total > rows.length ? `显示前 ${rows.length} 条。` : ''}按当前已识别的正文与附件统计；仅外链、失败和暂不支持的附件尚未完整保存在本地。`);
  const list = $('archive-completeness-list'), previousScroll = list.scrollTop;
  const key = JSON.stringify(rows);
  if (renderedLists.get('archive-completeness-list') !== key) {
    renderedLists.set('archive-completeness-list', key); list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('li');
      appendText(item, 'strong', assetLabel(row.title, '未命名对话'));
      appendText(item, 'p', `${row.sourceComplete ? '正文已保存' : '正文完整性待确认'} · 已识别附件 ${count(row.total)} 个，已保存 ${count(row.local)} 个`);
      const parts = [];
      for (const [field, label] of [['pending', '待下载'], ['failed', '失败'], ['external', '仅外链'],
        ['unsupported', '暂不支持'], ['internalMissing', '内部附件未下载'], ['paused', '按设置暂停']]) {
        if (Number(row[field]) > 0) parts.push(`${label} ${count(row[field])}`);
      }
      if (parts.length) appendText(item, 'p', parts.join(' · '), 'muted');
      appendText(item, 'p', `对话 ID：${assetLabel(row.conversationId, '')}`, 'muted');
      list.append(item);
    }
    if (Number.isFinite(previousScroll)) list.scrollTop = previousScroll;
  }
  const maintenance = current.maintenanceStatus;
  show('maintenance-status', Boolean(maintenance && maintenance.status !== 'idle'));
  if (maintenance) {
    const labels = { requested: '本地检查已排队', running: '正在检查本地文件', completed: '本地检查完成', complete: '本地检查完成',
      partial: '本地检查有待处理项', blocked: '本地检查需要处理', failed: '本地检查未完成', paused: '本地检查已暂停' };
    const missing = maintenance.missingConversationCount ?? (Array.isArray(maintenance.missingConversations) ? maintenance.missingConversations.length : maintenance.missingConversations);
    const missingAssets = maintenance.missingAttachments ?? maintenance.missingAssets;
    const parts = [labels[maintenance.status] || '本地检查进度已保留',
      `已检查 ${count(maintenance.conversationsChecked ?? maintenance.checked)} / ${count(maintenance.totalConversations ?? maintenance.total)} 条`,
      `已修复 ${count(maintenance.repairedMarkdown ?? maintenance.repaired)}`];
    if (Number(missingAssets) > 0) parts.push(`附件缺失 ${count(missingAssets)}`);
    if (Number(missing) > 0) parts.push(`正文待补采 ${count(missing)}`);
    if (Number(maintenance.conflicts) > 0) parts.push(`保留人工修改 ${count(maintenance.conflicts)}`);
    if (maintenance.error) parts.push(assetLabel(maintenance.error.message, '请检查目录权限后重试。'));
    else if (maintenance.lastError?.code) parts.push(assetFailureCode(maintenance.lastError.code));
    text('maintenance-status', parts.join(' · '));
  }
}
function appendDetailFailure(parent, item, collection = false) {
  if (item.code && item.title && item.conversationId) {
    appendText(parent, 'p', `对话 ID：${assetLabel(item.conversationId, '')}`, 'muted');
  }
  const { reason } = sanitizeDetailFailure(item);
  const message = reason ? detailFailureMessage({ code: item.code, reason }) : '';
  if (message) appendText(parent, 'p', `原因：${message}（${reason}）`, 'warning-text');
  else if (item.code === 'INCOMPLETE_DETAIL') {
    appendText(parent, 'p', '详情完整性未确认；此记录没有具体原因，请继续采集后查看新记录。', 'warning-text');
  } else if (collection && item.code === 'INVALID_RESPONSE') {
    appendText(parent, 'p', '采集脚本未返回可识别的结果；此记录没有具体原因，请继续采集后查看新记录。', 'warning-text');
  }
}
function renderActivityCards(id, channels) {
  const parent = $(id); parent.replaceChildren();
  for (const [label, log] of channels) {
    const item = log?.current;
    if (!item) continue;
    const card = document.createElement('div'); card.classList.add('activity-card');
    if (['running', 'interrupted'].includes(item.status)) card.classList.add(`is-${item.status}`);
    appendText(card, 'strong', `${label} · ${activityStatuses[item.status] || '进度已记录'}`);
    appendText(card, 'p', `${activityName(item)} · ${activityTitle(item)}`);
    const parts = [];
    if (Number.isFinite(item.startedAt)) {
      if (item.status === 'running') parts.push(`已等待 ${duration(Date.now() - item.startedAt)}`);
      else if (Number.isFinite(item.finishedAt)) parts.push(`耗时 ${duration(item.finishedAt - item.startedAt)}`);
      else if (clock(item.startedAt)) parts.push(`开始于 ${clock(item.startedAt)}`);
    }
    if (clock(item.updatedAt)) parts.push(`最近进展 ${clock(item.updatedAt)}`);
    if (Number.isFinite(item.completed) && Number.isFinite(item.total) && item.total > 0) parts.push(`步骤开始时已完成 ${count(item.completed)} / ${count(item.total)}`);
    if (fileSize(item.size)) parts.push(`文件大小 ${fileSize(item.size)}`);
    if (item.code) parts.push(assetFailureCode(item.code));
    appendText(card, 'p', parts.join(' · '), 'muted');
    appendDetailFailure(card, item, id.startsWith('collection-'));
    if (item.status === 'running' && Number.isFinite(item.updatedAt || item.startedAt) &&
        Date.now() - (item.updatedAt || item.startedAt) >= 90_000) {
      appendText(card, 'p', '暂未收到新进展，可能仍在等待响应；这不代表程序已停止。', 'warning-text');
    }
    if (item.status === 'interrupted') appendText(card, 'p', '上次执行未记录结束；进度已保留，等待后台继续处理。', 'warning-text');
    parent.append(card);
  }
  if (!parent.children.length) appendText(parent, 'p', '暂无执行记录，新任务开始后会显示当前步骤。', 'hint');
}
function renderTaskList(id, noteId, items, total, emptyText, mode = 'queue') {
  const rows = Array.isArray(items) ? items.slice(0, mode === 'recent' ? 20 : 50) : [];
  const knownTotal = Math.max(rows.length, Number(total) || 0);
  text(noteId, !rows.length ? emptyText : mode === 'recent' ? `显示最近 ${rows.length} 条步骤记录。` :
    knownTotal > rows.length ? `共 ${count(knownTotal)} 项，显示前 ${rows.length} 项。` : `共 ${rows.length} 项。`);
  const key = JSON.stringify(rows);
  if (renderedLists.get(id) === key) return;
  renderedLists.set(id, key);
  const list = $(id), previousScroll = list.scrollTop;
  list.replaceChildren();
  for (const item of rows) {
    const row = document.createElement('li');
    const status = mode === 'recent' ? activityStatuses[item.status] || '进度已记录' :
      item.status === 'failed' && item.retryDisposition === 'manual' ? '等待手动处理' :
      item.status === 'failed' && item.retryDisposition === 'cooldown' ? '冷却后重试' :
      taskStatuses[item.status] || (mode === 'outbox' ? '等待提交' : '等待处理');
    appendText(row, 'strong', mode === 'recent' ? `${assetLabel(item.channelLabel, '')}${item.channelLabel ? ' · ' : ''}${activityName(item)} · ${status}` : `${activityTitle(item)} · ${status}`);
    if (mode === 'recent') appendText(row, 'p', activityTitle(item));
    const parts = [];
    if (item.conversationId && !item.title) parts.push(`对话 ${assetLabel(item.conversationId, '')}`);
    if (Number(item.attempt) > 0) parts.push(`已尝试 ${count(item.attempt)} 次`);
    if (Number(item.totalAttempts) > Number(item.attempt || 0)) parts.push(`累计尝试 ${count(item.totalAttempts)} 次`);
    if (clock(item.nextRetryAt)) parts.push(`重试时间 ${clock(item.nextRetryAt)}`);
    if (item.code) parts.push(assetFailureCode(item.code));
    if (fileSize(item.size)) parts.push(`文件大小 ${fileSize(item.size)}`);
    if (mode === 'recent' && clock(item.finishedAt || item.updatedAt)) parts.push(clock(item.finishedAt || item.updatedAt));
    if (mode === 'outbox' && clock(item.createdAt)) parts.push(`入队 ${clock(item.createdAt)}`);
    if (parts.length) appendText(row, 'p', parts.join(' · '), 'muted');
    appendDetailFailure(row, item, id.startsWith('collection-'));
    list.append(row);
  }
  if (Number.isFinite(previousScroll)) list.scrollTop = previousScroll;
}
function renderDetailedProgress() {
  const job = current.job, diagnostics = job?.diagnostics || {}, activity = current.activity || {};
  const collection = activity.collection, liveCollection = collection?.current?.status === 'running';
  show('collection-details', Boolean(job || collection?.current));
  const jobLabels = { running: liveCollection ? '正在处理' : '等待调度', paused: '已暂停', stopped: '已停止', blocked: '需要处理', partial: '部分完成', completed: '已完成' };
  text('collection-details-status', jobLabels[job?.status] || '暂无任务');
  let collectionWait = '';
  if (job?.status === 'paused') collectionWait = '采集已暂停，点击“继续采集”后处理未完成项。';
  else if (job?.status === 'stopped') collectionWait = '本轮已停止，已保存数据保留。点击开始按钮将重新扫描列表，不再继续旧队列。';
  else if (job?.status === 'blocked') collectionWait = assetLabel(job.error?.message, '采集等待登录或保存权限恢复。');
  else if (!liveCollection && Number(job?.nextRetryAt) > Date.now()) collectionWait = `等待重试至 ${clock(job.nextRetryAt)}，剩余 ${duration(job.nextRetryAt - Date.now())}。`;
  else if (job?.status === 'running' && !liveCollection) collectionWait = '当前没有进行中的请求，等待后台调度下一项。';
  else if (job?.status === 'completed') collectionWait = '本轮对话采集完成；附件是否已保存请查看本地备份完整性和下载详情。';
  else if (job?.status === 'partial') collectionWait = '本轮仍有未完成项，可查看失败原因并继续采集。';
  else if (liveCollection) collectionWait = '正在执行下方步骤，面板收起后任务仍可继续。';
  if (job?.status === 'running' && Number(job.accountCooldownUntil) > Date.now()) {
    collectionWait = `当前账号请求已降速，等待至 ${clock(job.accountCooldownUntil)} 再继续；进度已保留。`;
  }
  if (job?.status === 'running' && !liveCollection && Number(job?.nextRetryAt) > Date.now()) text('collection-details-status', '等待重试');
  text('collection-wait', collectionWait);
  show('run-summary', Boolean(job));
  text('run-summary', job ? `本轮发现 ${count(job.discovered)} 条对话；未变化跳过 ${count(job.skipped)} 条，已新增 ${count(job.added)} 条、更新 ${count(job.updated)} 条，待处理 ${count(diagnostics.remaining ?? Math.max(0, (job.discovered || 0) - (job.processed || 0)))} 条。` : '');
  text('collection-read-counts', job?.statistics ? `列表读取 ${count(job.statistics.listReads)} 次；正文读取 ${count(job.statistics.detailConversations)} 条／${count(job.statistics.detailReads)} 次（含重复尝试）。一次正文读取可能包含多页网络请求。` : job ? '此任务创建于旧版本，未记录完整读取次数；下一轮新建任务开始统计。' : '');
  text('collection-detail-counts', job ? `已发现 ${count(job.discovered)} 条 · 已处理 ${count(job.processed)} 条 · 未变化已跳过 ${count(diagnostics.skipped ?? job.skipped)} 条 · 待处理 ${count(diagnostics.remaining ?? Math.max(0, (job.discovered || 0) - (job.processed || 0)))} 条 · 失败／重试 ${count(diagnostics.failed !== undefined ? Number(diagnostics.failed) + Number(diagnostics.retrying || 0) : job.failed)} 条${job.pages ? ` · 已读 ${count(job.pages)} 页列表` : ''}` : '');
  const messages = job?.messageProgress;
  show('collection-message-progress', Boolean(messages));
  text('collection-message-progress', messages ? `本条详情：${messages.mode === 'tail-merge' ? '尾部增量（较早历史未重新核对）' : messages.mode === 'full' ? '完整详情读取' : '正在分页读取'} · 已读 ${count(messages.pagesRead)} 页 · 接收 ${count(messages.fetchedMessages)} 条消息 · 复用 ${count(messages.reusedMessages)} 条历史消息${Number.isSafeInteger(messages.addedMessages) ? ` · 新发现 ${count(messages.addedMessages)} 条 · 修改 ${count(messages.updatedMessages)} 条` : ''}` : '');
  renderActivityCards('collection-current', [['采集', collection]]);
  renderTaskList('collection-queue', 'collection-queue-note', diagnostics.items, diagnostics.total,
    job?.phase === 'list' ? '正在获取列表，发现对话后显示队列。' : '暂无对话队列记录。');
  renderTaskList('collection-recent', 'collection-recent-note', collection?.recent, 0, '暂无步骤完成记录。', 'recent');
  const cloud = cloudVisibility();
  const transferChannels = [['对话附件下载', activity.download],
    ...(cloud.upload ? [['GitHub 对话提交', activity.github]] : []),
    ...(cloud.restore ? [['仓库恢复（全部账号）', activity.restore]] : [])];
  text('transfer-heading', cloud.upload || cloud.restore ? '下载与上传详情' : '附件下载详情');
  show('outbox-queue-section', cloud.upload);
  show('restore-queue-section', cloud.restore);
  const running = transferChannels.filter(([, log]) => log?.current?.status === 'running');
  const interrupted = transferChannels.some(([, log]) => log?.current?.status === 'interrupted');
  const asset = current.assetDiagnostics || {}, github = current.githubStatus || {}, outbox = current.outboxSummary || {};
  const retryAt = cloud.upload ? github.nextRetryAt || github.retryAt : 0;
  let wait = '', badge = '暂无传输';
  if (running.length) { badge = '正在处理'; wait = '当前正在执行下方步骤；完成当前文件后会更新数量。'; }
  else if (Number(retryAt) > Date.now()) { badge = '等待重试'; wait = `GitHub 同步等待至 ${clock(retryAt)}，剩余 ${duration(retryAt - Date.now())}。`; }
  else if (interrupted) { badge = '等待继续'; wait = '上次传输未记录结束，进度已保留，等待后台继续处理。'; }
  else if (current.config?.localAssetsEnabled === false && !cloud.upload && !cloud.restore) { badge = '下载已暂停'; wait = '附件自动下载已关闭；已有本地文件保留，可手动补齐缺失。'; }
  else if (!cloud.upload && !cloud.restore) { badge = '本地备份'; wait = '对话和附件保存在本地，下载失败项会保留进度。'; }
  else if (cloud.upload && job?.status === 'running' && Number(outbox.total ?? github.pending) > 0) { badge = '等待提交'; wait = '对话采集中，完成本轮后提交 GitHub；附件下载仍可继续处理。'; }
  else if (Number(asset.pending) > 0 || cloud.upload && Number(outbox.total ?? github.pending) > 0) { badge = '等待处理'; wait = '等待后台处理队列，对话和附件各自保留进度。'; }
  else if (cloud.upload && github.status === 'synced') { badge = '已同步'; wait = '当前已知的对话提交已完成；未下载附件仍保留各自状态。'; }
  text('transfer-details-status', badge); text('transfer-wait', wait);
  text('transfer-detail-counts', `附件待处理 ${count(asset.pending)} · 失败 ${count(asset.failed)} · 内部附件未下载 ${count(asset.internalMissing)}${cloud.upload ? ` · 待提交对话 ${count(outbox.total ?? github.pending)}` : ''}`);
  renderActivityCards('transfer-current', transferChannels);
  renderTaskList('download-queue', 'download-queue-note', asset.captureItems, asset.captureTotal, '暂无附件下载任务。');
  renderTaskList('outbox-queue', 'outbox-queue-note', cloud.upload ? outbox.items : [], cloud.upload ? outbox.total : 0, '暂无待提交的对话。', 'outbox');
  const restore = current.restoreStatus;
  text('transfer-restore-detail', restore ? `已处理 ${count(restore.processed)} / ${count(restore.total)} 条 · 待处理 ${count(restore.pending)} · 失败 ${count(restore.failed)}${Number(restore.nextRetryAt) > Date.now() ? ` · 重试时间 ${clock(restore.nextRetryAt)}` : ''}${restore.error?.code ? ` · ${assetFailureCode(restore.error.code)}` : ''}${restoreMissingAssets(restore) ? ` · ${restoreMissingMessage(restore)}` : ''}` : '尚未执行仓库恢复。');
  const recent = transferChannels.flatMap(([label, log]) => (Array.isArray(log?.recent) ? log.recent : []).map(item => ({ ...item, channelLabel: label })))
    .sort((a, b) => (b.finishedAt || b.updatedAt || 0) - (a.finishedAt || a.updatedAt || 0)).slice(0, 20);
  renderTaskList('transfer-recent', 'transfer-recent-note', recent, 0, '暂无传输完成记录。', 'recent');
}
function jobError(job) { return job?.error?.message || (typeof job?.error === 'string' ? job.error : ''); }
function describeGithub(value, enabled) {
  if (!enabled) return '未启用';
  const status = typeof value === 'string' ? value : value?.status;
  if (['synced', 'success', 'completed'].includes(status)) return '已同步';
  if (status === 'idle') return '等待首次同步';
  if (status === 'conflicts') return '已保留冲突副本';
  if (['syncing', 'running'].includes(status)) return '同步中';
  if (['error', 'failed', 'pending', 'waiting', 'conflict', 'blocked'].includes(status)) return '本地已保存，待同步';
  return '已启用';
}
function renderSummary() {
  const target = $('wizard-summary');
  target.replaceChildren();
  const values = [
    `${current.siteLabel || 'ChatGPT'} · ${current.account?.alias || current.identity?.displayName || '尚未绑定'}`,
    `保存到 ${current.directory?.name || directory?.name || '尚未选择'}`,
    '默认保存 JSON 与 Markdown',
    $('wizard-local-assets-enabled').checked ? '自动下载图片和附件到本地' : '附件保留来源，需要时手动下载',
    current.config?.github?.enabled ? `GitHub：${current.config.github.repository || '已配置'}` : 'GitHub：暂不启用',
  ];
  for (const value of values) { const p = document.createElement('p'); p.textContent = value; target.append(p); }
}
function fillSettings() {
  const config = current?.config || {};
  $('auto-enabled').checked = config.autoEnabled !== false;
  $('local-assets-enabled').checked = config.localAssetsEnabled !== false;
  $('interval-minutes').value = String([15, 30, 60].includes(config.intervalMinutes) ? config.intervalMinutes : 30);
  $('github-enabled').checked = config.github?.enabled === true;
  $('github-auto-restore').checked = config.github?.autoRestore === true;
  $('repository').value = config.github?.repository || '';
  $('branch').value = config.github?.branch || '';
  $('github-token').value = '';
  text('token-status', config.github?.hasToken ? '此浏览器已保存 Token，留空沿用。' : '尚未保存 Token。');
  settingsLoaded = true;
}
function unsavedGithubSettings() {
  if (screen !== 'settings' || !settingsLoaded) return false;
  const github = current?.config?.github || {};
  return $('repository').value.trim() !== (github.repository || '') || $('branch').value.trim() !== (github.branch || '') ||
    Boolean($('github-token').value.trim()) || $('github-enabled').checked !== (github.enabled === true) ||
    $('github-auto-restore').checked !== (github.autoRestore === true);
}
function render() {
  if (!current) return;
  const config = current.config || {};
  const identity = current.identity;
  const account = current.account;
  const job = current.job;
  const isRunning = runningStatuses.has(job?.status);
  const isPaused = pausedStatuses.has(job?.status);
  const isPartial = job?.status === 'partial';
  const isStopped = job?.status === 'stopped';
  const isWizard = !config.setupComplete && screen === 'home';
  const cloud = cloudVisibility();
  show('legacy-notice', current.legacyPending === true);
  show('context-error', Boolean(current.error?.message) && (screen === 'settings' || !current.identity));
  text('context-error', current.error?.message ? safeMessage(current.error) +
    (screen === 'settings' && !identity && /^(?:SITE_|SOURCE_|ACCOUNT_|CHATGPT_|HTTP_401$|HTTP_403$)/.test(current.error?.code || '') ?
      ' 此登录状态不影响从 GitHub 恢复备份。' : '') : '');
  if (isWizard && step > 0 && !account?.enabled) step = 0;
  document.body.classList.toggle('setup-page', setupPage && isWizard);
  show('wizard', isWizard);
  show('home', !isWizard && screen === 'home');
  show('settings', screen === 'settings');
  show('diagnostics', screen === 'diagnostics');
  show('open-settings', screen !== 'settings');
  text('back-home', config.setupComplete ? '‹ 返回采集' : '‹ 返回首次设置');
  const selectedName = account?.alias || identity?.displayName || '尚未识别账号';
  text('account-name', selectedName);
  text('account-avatar', identity ? Array.from(selectedName).slice(0, 2).join('').toUpperCase() : 'AI');
  text('account-context', identity ? `${current.siteLabel || 'ChatGPT'} · 普通对话` : '打开并登录 ChatGPT 或豆包后自动识别');
  text('account-badge', current.identityChecking ? '核验中' : !identity ? '等待登录' : account?.enabled ? '已启用' : '未启用');
  show('identity-checking-note', current.identityChecking === true);
  const hasIdentity = Boolean(identity?.accountKey);
  show('account-alert', !hasIdentity || !account?.enabled);
  show('bind-account', hasIdentity && !account?.enabled);
  show('new-account-alias', hasIdentity && !account?.enabled);
  $('new-account-alias').parentElement.hidden = !hasIdentity || Boolean(account?.enabled);
  const requiresPermission = !current.error || ['SITE_PERMISSION_DENIED', 'SITE_PERMISSION', 'SITE_PERMISSION_REQUIRED', 'PERMISSION_REQUIRED'].includes(current.error?.code);
  show('home-grant', !hasIdentity && requiresPermission);
  show('home-open-chatgpt', !hasIdentity && !requiresPermission);
  show('home-open-doubao', !hasIdentity);
  text('home-grant', `授权 ${current.siteLabel || 'ChatGPT'}`);
  show('grant-doubao-images', current.platform === 'doubao');
  text('account-alert-text', hasIdentity ? '当前账号尚未启用。确认后会保存到它自己的目录。' :
    safeMessage(current.error?.message || '请打开并登录 ChatGPT 或豆包。页面会自动更新，无需手动选择标签页。'));
  if (activeAliasKey !== identity?.accountKey) {
    activeAliasKey = identity?.accountKey || null;
    $('account-alias').value = account?.alias || identity?.displayName || '';
    $('new-account-alias').value = account?.alias || identity?.displayName || '';
  }
  const interval = config.intervalMinutes || 30;
  text('home-heading', isRunning ?
    job.mode === 'full' ? '正在全量补采' : job.mode === 'initial' ? '正在初始化采集' : '正在检查新增与更新' :
    isStopped ? '本轮采集已停止' : isPartial ? '部分采集已完成' : isPaused ? '采集已暂停' : !account?.initialized ? '准备好首次备份' : job?.status === 'completed' ? '本轮对话检查完成' : '对话归档已就绪');
  text('schedule-status', isStopped ? '当前账号自动采集和自动附件下载已停止；重新开始后按设置恢复，手动补齐仍可使用。' : config.autoEnabled === false ? '自动采集已暂停，可以手动采集。' :
    isRunning ? `每 ${interval} 分钟自动检查 · 当前任务完成后继续调度` :
    current.nextRunAt ? `自动采集已开启 · 下次检查 ${time(current.nextRunAt)}` : `自动采集已开启 · 每 ${interval} 分钟检查`);
  show('job-progress', isRunning || isPaused);
  const phases = { list: '扫描对话列表', listing: '扫描对话列表', scan: '扫描对话列表', scanning: '扫描对话列表', detail: '读取对话详情', details: '读取对话详情', capture: '读取对话详情', save: '保存 JSON 与 Markdown', saving: '保存 JSON 与 Markdown', sync: '同步 GitHub', syncing: '同步 GitHub', complete: '采集完成' };
  text('job-phase', phases[job?.phase] || (isPaused ? '进度已保留' : '正在处理'));
  const discovered = Number(job?.discovered) || 0;
  const processed = Number(job?.processed) || 0;
  text('job-count', discovered ? `${processed} / ${discovered}` : '');
  if (discovered > 0 && !['list', 'listing', 'scan', 'scanning'].includes(job?.phase)) {
    $('progress-meter').max = Math.max(discovered, processed, 1);
    $('progress-meter').value = processed;
  } else $('progress-meter').removeAttribute('value');
  text('job-detail', isPartial ? `已保存的对话会保留，继续处理未完成项${Number(job?.failed) > 0 ? `（${count(job.failed)} 条待处理）` : ''}。` : isPaused ? '恢复后继续处理未完成项。' : '收起面板不会主动暂停任务。');
  const error = (!isStopped && jobError(job)) || (hasIdentity ? current.error?.message : '');
  show('job-error', Boolean(error)); text('job-error', safeMessage(error || ''));
  show('start-capture', !isRunning && !isPaused);
  text('start-capture', account?.initialized ? '检查更新' : '开始首次备份');
  show('full-capture', Boolean(account?.initialized) && !isRunning && (!isPaused || isPartial));
  show('pause-capture', isRunning);
  show('stop-capture', isRunning || isPaused);
  show('resume-capture', isPaused);
  text('resume-capture', isPartial ? '重试未完成项' : '继续采集');
  const directoryName = current.directory?.name || directory?.name || '尚未选择';
  const granted = current.directory?.granted === true;
  show('reading-help', Boolean(account?.initialized && granted));
  text('directory-name', directoryName);
  text('directory-status', granted ? '自动保存' : current.directory?.name ? '需要授权' : '未设置');
  show('restore-directory', !granted && Boolean(current.directory?.name || directory));
  text('settings-directory', `${directoryName} · JSON + Markdown`);
  show('settings-restore-directory', !granted && Boolean(current.directory?.name || directory));
  const githubDescription = describeGithub(current.githubStatus, cloud.upload);
  text('github-state', githubDescription);
  show('github-destination', cloud.upload);
  show('retry-github', cloud.upload);
  const githubError = current.githubStatus?.error;
  const githubErrorCode = typeof githubError?.code === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(githubError.code) ? githubError.code : 'GITHUB_ERROR';
  // Older persisted states can contain both a failed request and the preceding
  // upload progress message. Always expose the failure without expanding a card.
  const githubDetail = cloud.upload ? githubError ?
    `同步未完成（${githubErrorCode}）：${safeMessage(githubError.message || '请检查权限或网络后重试。')
      .replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')}` : current.githubStatus?.message ||
      'GitHub 只备份对话文件；图片和附件保存在本地。' : '';
  text('github-detail', safeMessage(githubDetail));
  show('github-detail', Boolean(githubDetail));
  $('github-detail').classList.toggle('warning-text', Boolean(githubError) || current.githubStatus?.status === 'conflicts');
  const assets = current.assetStatus || {};
  const diagnostics = current.assetDiagnostics;
  const pendingImages = Number(diagnostics?.pending ?? assets.pendingCapture) || 0;
  const failedImages = Number(diagnostics?.failed ?? assets.failed) || 0;
  const internalMissing = Number(diagnostics?.internalMissing ?? assets.internalMissing) || 0;
  const assetParts = [];
  if (Number(assets.local) > 0) assetParts.push(`本地附件 ${count(assets.local)}`);
  if (Number(assets.external) > 0) assetParts.push(`外链 ${count(assets.external)}`);
  if (pendingImages > 0) assetParts.push(`${diagnostics ? '待处理' : '待采集'} ${count(pendingImages)}${failedImages > 0 ? `（其中失败 ${count(failedImages)}）` : ''}`);
  else if (failedImages > 0) assetParts.push(`待处理失败 ${count(failedImages)}`);
  if (internalMissing > 0) assetParts.push(`内部附件未下载 ${count(internalMissing)}`);
  if (Number(diagnostics?.unsupported ?? assets.unsupported) > 0) assetParts.push(`暂不支持 ${count(diagnostics?.unsupported ?? assets.unsupported)}`);
  text('asset-summary-text', assetParts.join(' · ')); show('asset-summary', assetParts.length > 0);
  text('overview-attachments', assetParts.length ? `附件累计：${assetParts.join(' · ')}。` : '附件：尚无可显示的统计，不能据此确认全部附件已保存。');
  show('overview-cloud', cloud.upload || cloud.restore);
  text('overview-cloud', cloud.upload ? `GitHub 对话备份：${githubDescription}。附件仅保存在本地。` : 'GitHub 恢复状态请在传输详情中查看；附件需单独补齐。');
  const attention = [];
  if (Number(job?.failed) > 0) attention.push(`对话失败／重试 ${count(job.failed)} 条`);
  else if (job?.status === 'blocked' || job?.status === 'partial') attention.push('对话检查尚未完成');
  if (failedImages > 0) attention.push(`附件失败 ${count(failedImages)} 个`);
  if (internalMissing > 0) attention.push(`内部附件未下载 ${count(internalMissing)} 个`);
  if (!granted) attention.push('保存目录需要选择或授权');
  if (cloud.upload && (githubError || current.githubStatus?.status === 'conflicts')) attention.push('GitHub 备份需要处理');
  text('overview-problems', attention.join(' · ')); show('overview-problems', attention.length > 0);
  const collectionProblem = Number(job?.failed) > 0 || ['blocked', 'partial'].includes(job?.status);
  const assetProblem = failedImages > 0 || internalMissing > 0;
  const githubProblem = cloud.upload && Boolean(githubError || current.githubStatus?.status === 'conflicts');
  show('problem-collection', collectionProblem); show('problem-assets', assetProblem); show('problem-github', githubProblem);
  show('problem-actions', collectionProblem || assetProblem || githubProblem);
  const maintenance = current.maintenanceStatus;
  const localMissing = Number(maintenance?.missingConversationCount ?? (Array.isArray(maintenance?.missingConversations) ? maintenance.missingConversations.length : maintenance?.missingConversations)) > 0 ||
    Number(maintenance?.missingAttachments ?? maintenance?.missingAssets) > 0;
  show('repair-recommended', localMissing);
  show('task-action-help', isRunning || isPaused || isStopped);
  text('task-action-help', '暂停可继续原队列；停止本轮后，下次检查重新扫描。已保存文件保留，GitHub 备份和手动附件任务独立运行。');
  if (!account?.enabled || fullCaptureAccount !== account.accountKey || isRunning || current.identityChecking) fullCaptureAccount = null;
  show('full-capture-confirmation', Boolean(fullCaptureAccount));
  text('full-capture-explanation', `将为“${selectedName}”重新读取全部可枚举对话，可能耗时较长。已有归档和文件保护规则继续生效。日常检查只需“检查更新”。`);
  const manifest = chrome.runtime.getManifest?.();
  text('extension-version', manifest ? `AI Memory Collector ${manifest.version_name || manifest.version}` : 'AI Memory Collector');

  show('local-assets-policy', config.localAssetsEnabled === false);
  text('local-assets-policy', '附件自动下载已关闭，未执行的下载按设置暂停。已保存的文件保留，点击“补齐缺失”可手动处理。');
  renderCompleteness(diagnostics);
  renderAssetFailures(diagnostics);
  renderInternalAttachments(diagnostics, internalMissing);
  renderDetailedProgress();
  show('retry-images', failedImages > 0);
  show('image-retry-note', failedImages > 0);
  const restore = current.restoreStatus;
  const restoreRunning = ['running', 'restoring', 'scanning', 'downloading', 'saving'].includes(restore?.status);
  const restoreProgress = restore?.progress || restore || {};
  const restoreTotal = Number(restoreProgress.total) || 0;
  const restoreCompleted = Number(restoreProgress.completed ?? restoreProgress.processed) || 0;
  const restoreFailed = Number(restoreProgress.failed) || 0;
  const restoreCloudMissing = restoreMissingAssets(restore);
  const restoreNeedsRetry = restoreFailed > 0 || restoreCloudMissing > 0 || ['failed', 'error', 'partial', 'paused', 'blocked', 'interrupted', 'waiting-permission', 'needsPermission'].includes(restore?.status);
  const restoreReady = Boolean(config.github?.repository && config.github?.hasToken && granted);
  show('open-restore', cloud.restore);
  const requirements = [];
  if (!config.github?.repository || !config.github?.hasToken) requirements.push('请先填写并保存 GitHub 仓库与 Token。');
  if (!granted) requirements.push('请选择保存目录或恢复目录权限。');
  text('restore-requirements', requirements.join(' '));
  show('restore-progress', Boolean(restore && restore.status !== 'idle'));
  const restoreLabels = { completed: '恢复完成', complete: '恢复完成', success: '恢复完成',
    partial: '部分恢复完成', failed: '恢复未完成', error: '恢复未完成', paused: '恢复已暂停',
    blocked: '恢复需要处理', interrupted: '恢复已中断', 'waiting-permission': '等待权限', needsPermission: '等待权限', empty: '仓库暂无可恢复内容' };
  const restoreComplete = ['completed', 'complete', 'success'].includes(restore?.status);
  text('restore-phase', restoreRunning ? '正在恢复对话' : restoreComplete && restoreCloudMissing ? '部分恢复完成' : restoreLabels[restore?.status] || '恢复进度已保留');
  text('restore-count', restoreTotal ? `${restoreCompleted} / ${restoreTotal}` : '');
  if (restoreTotal > 0) { $('restore-meter').max = Math.max(restoreTotal, restoreCompleted, 1); $('restore-meter').value = restoreCompleted; }
  else $('restore-meter').removeAttribute('value');
  show('restore-meter', restoreRunning || restoreTotal > 0);
  const restoreDetail = safeMessage(restore?.message || restore?.error?.message ||
    (restoreFailed ? `${restoreFailed} 项未完成，已恢复的文件会保留。` : restoreRunning ? '收起面板不会主动暂停恢复。' : ''));
  text('restore-detail', [restoreDetail, restoreMissingMessage(restore)].filter(Boolean).join(' '));
  show('restore-retry', restoreNeedsRetry && !restoreRunning);
  text('external-images-status', externalImagePermission ? '已允许匿名检测。可在浏览器扩展设置中撤销网站访问权限。' : '尚未授权，外链附件保留为链接。');
  text('grant-external-images', externalImagePermission ? '已允许检测外链附件' : '允许检测外链附件');
  const result = current.lastResult || (['completed', 'complete', 'done', 'partial', 'failed'].includes(job?.status) ? job : null);
  show('last-result', Boolean(result));
  if (result) {
    text('count-added', count(result.added)); text('count-updated', count(result.updated));
    text('count-unchanged', count(result.unchanged)); text('count-failed', count(result.failed));
    text('last-result-time', time(result.completedAt || result.finishedAt || result.updatedAt));
  }
  text('settings-account', hasIdentity ? `${current.siteLabel || 'ChatGPT'} · ${selectedName}` : '尚未识别当前账号');
  if (screen === 'settings' && !settingsLoaded) fillSettings();
  if (isWizard) {
    if (!wizardLocalLoaded) {
      $('wizard-auto-enabled').checked = config.autoEnabled !== false;
      $('wizard-local-assets-enabled').checked = config.localAssetsEnabled !== false;
      wizardLocalLoaded = true;
    }
    for (let index = 0; index < 4; index++) {
      show(`wizard-step-${index}`, index === step);
      const item = document.querySelector(`[data-step="${index}"]`);
      item.classList.toggle('current', index === step); item.classList.toggle('done', index < step);
      if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    }
    text('wizard-identity', identity ? `已识别：${selectedName}` : safeMessage(current.error?.message || '打开 ChatGPT 或豆包并完成授权后自动识别。'));
    show('grant-chatgpt', !identity); show('open-chatgpt', !identity);
    show('grant-doubao', !identity); show('open-doubao', !identity);
    text('wizard-directory', directoryName); text('wizard-directory-permission', granted ? '读写权限已确认' : '需要选择或恢复写入权限');
    show('wizard-restore-directory', !granted && Boolean(current.directory?.name || directory));
    if (step === 3) renderSummary();
  }
  for (const control of controls()) control.disabled = busy;
  $('wizard-bind').disabled = busy || !hasIdentity;
  $('wizard-next-1').disabled = busy || !granted;
  $('wizard-next-2').disabled = busy || !wizardGithubVerified;
  $('start-capture').disabled = busy || !account?.enabled || !granted;
  $('full-capture').disabled = busy || !account?.enabled || !granted;
  $('repair-local').disabled = busy || !account?.enabled || !granted || ['requested', 'running'].includes(current.maintenanceStatus?.status);
  $('repair-recommended').disabled = $('repair-local').disabled;
  $('confirm-full-capture').disabled = busy || !fullCaptureAccount || !granted || isRunning || !account?.enabled;
  $('resume-capture').disabled = busy || !account?.enabled || !granted;
  $('stop-capture').disabled = busy || !account?.accountKey;
  $('retry-images').disabled = busy || failedImages <= 0 || !account?.enabled || !granted || !hasIdentity ||
    account.accountKey !== identity.accountKey || !Number.isSafeInteger(current.tabId) || current.tabId < 0;
  $('retry-internal-images').disabled = busy || internalMissing <= 0 || !account?.enabled || !granted || !hasIdentity ||
    account.accountKey !== identity.accountKey || !Number.isSafeInteger(current.tabId) || current.tabId < 0;
  $('restore-github').disabled = busy || !restoreReady || restoreRunning;
  $('restore-retry').disabled = busy || !restoreReady || restoreRunning;
  $('backup-github-now').disabled = busy || !restoreReady || !account?.enabled || unsavedGithubSettings();
  $('grant-external-images').disabled = busy || externalImagePermission;
  if (current.identityChecking === true) {
    for (const id of ['wizard-bind', 'bind-account', 'wizard-finish', 'start-capture', 'full-capture', 'pause-capture',
      'resume-capture', 'repair-local', 'repair-recommended', 'confirm-full-capture', 'retry-images', 'retry-internal-images', 'retry-github', 'backup-github-now']) $(id).disabled = true;
  }
  if (!started) { started = true; window.dispatchEvent(new Event('collector:ready')); }
}
async function readState(refreshIdentity = false) {
  if (screen === 'diagnostics') { await loadDiagnostics(); return; }
  const revision = ++stateRevision;
  const reply = await chrome.runtime.sendMessage({ type: 'collector:get-state', refreshIdentity, ...(sourceTabId === null ? {} : { tabId: sourceTabId }) });
  if (!reply?.ok) throw errorObject(reply?.error || '暂时无法读取后台状态。');
  if (revision !== stateRevision) return;
  if (chrome.permissions.contains) {
    try { externalImagePermission = await chrome.permissions.contains({ origins: ['https://*/*'] }); }
    catch { externalImagePermission = false; }
    if (revision !== stateRevision) return;
  }
  current = reply.state;
  render();
}
function refresh(refreshIdentity = false) {
  if (refreshPending) return refreshIdentity && !refreshChecksIdentity ? refreshPending.then(() => refresh(true)) : refreshPending;
  refreshChecksIdentity = refreshIdentity;
  let timer;
  const request = readState(refreshIdentity);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stateRevision++; // A late response must not overwrite a newer read or command.
      reject(new Error('读取后台状态超时；进度记录保留，请稍后查看。'));
    }, 15_000);
  });
  refreshPending = Promise.race([request, timeout]).finally(() => { clearTimeout(timer); refreshPending = null; });
  return refreshPending;
}
function refreshProgress(refreshIdentity = false) {
  return refresh(refreshIdentity).then(() => {
    for (const id of ['collection-connection', 'transfer-connection']) { text(id, ''); show(id, false); }
  }).catch(error => {
    for (const id of ['collection-connection', 'transfer-connection']) {
      text(id, '暂时无法读取后台状态；以下保留上次记录，不能据此确认任务仍在运行。'); show(id, true);
    }
    feedback(safeMessage(error), true);
  });
}
function action(id, handler) {
  $(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true; stateRevision++; render(); feedback('正在处理…');
    try {
      // Calling before the first await preserves the activation for native pickers/permissions.
      await handler();
      await refresh();
      feedback('');
    } catch (error) { feedback(safeMessage(error), true); }
    finally { busy = false; render(); }
  });
}
async function grantChatGPT() {
  const granted = await chrome.permissions.request({ origins: ['https://chatgpt.com/*'] });
  if (!granted) throw new Error('未获得 ChatGPT 访问权限。需要时可再次授权。');
  await send('collector:permissions-changed');
}
async function grantDoubao() {
  if (!await chrome.permissions.request({ origins: ['https://www.doubao.com/*'] })) throw new Error('未获得豆包访问权限。');
  await send('collector:permissions-changed');
}
async function chooseDirectory() {
  if (!window.showDirectoryPicker) throw new Error('当前环境不支持选择真实目录，请使用桌面 Chrome 或 Edge。');
  const selected = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ai-memory-collector-p0' });
  await setSetting('directoryCandidate', selected);
  await send('collector:directory-changed');
  directory = selected;
}
async function restoreDirectory() {
  if (!directory) throw new Error('保存目录尚未加载，请稍后重试或重新选择目录。');
  if (await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('目录权限未恢复；已有采集进度会保留。');
  // The action refreshes state next. Restoring access is not a directory selection.
}
async function grantGithub() {
  const granted = await chrome.permissions.request({ origins: ['https://api.github.com/*'] });
  if (!granted) throw new Error('未获得 GitHub 访问权限。已有数据会保留，可再次点击授权后保存配置。');
}
async function restoreGithub(retry = false) {
  // Start the permission request directly from this click, before any network await.
  await grantGithub();
  await send(retry ? 'collector:restore-retry' : 'collector:restore');
}
async function saveGithub(wizard = false) {
  const repository = $(wizard ? 'wizard-repository' : 'repository').value.trim();
  const branch = $(wizard ? 'wizard-branch' : 'branch').value.trim();
  const tokenInput = $(wizard ? 'wizard-token' : 'github-token');
  const token = tokenInput.value.trim();
  const enabled = $(wizard ? 'wizard-github-enabled' : 'github-enabled').checked;
  const autoRestore = $(wizard ? 'wizard-github-auto-restore' : 'github-auto-restore').checked;
  const previous = current?.config?.github || {};
  if ((wizard || enabled || autoRestore) && (!repository || !(token || previous.hasToken))) {
    throw new Error('请填写 GitHub 仓库与 Token，再保存或验证连接。');
  }
  const changedCredentials = repository !== (previous.repository || '') || branch !== (previous.branch || '') || Boolean(token);
  // Turning automatic tasks off must work even when site access has been revoked.
  const verify = Boolean(repository && (token || previous.hasToken)) && (wizard || enabled || autoRestore || changedCredentials);
  if (verify) await grantGithub();
  await send('collector:github-config', { repository, branch, enabled, autoRestore, ...(token ? { token } : {}) });
  if (verify) await send('collector:github-test');
  tokenInput.value = '';
  if (wizard) { wizardGithubVerified = true; text('wizard-github-status', '私有仓库连接验证成功。'); }
  else settingsLoaded = false;
}
function populateWizardGithub() {
  const github = current?.config?.github || {};
  $('wizard-repository').value = github.repository || '';
  $('wizard-branch').value = github.branch || '';
  $('wizard-token').value = '';
  $('wizard-github-enabled').checked = github.enabled === true;
  $('wizard-github-auto-restore').checked = github.autoRestore === true;
  $('wizard-token').placeholder = github.hasToken ? '已保存 Token，留空沿用' : '粘贴仅授权此仓库的 Token';
  wizardGithubVerified = false;
  text('wizard-github-status', '');
}
async function closePanel(hide = false) {
  await send('collector:close-panel', { hide });
  if (!setupPage) window.close();
}
async function loadDiagnostics(type = 'collector:diagnostics', entryAccountKey = null) {
  const revision = ++diagnosticRevision;
  const accountKey = entryAccountKey || $('diagnostics-account').value || diagnosticSnapshot?.accountKey || current?.account?.accountKey;
  const reply = await send(type, accountKey ? { accountKey } : {});
  if (revision !== diagnosticRevision) return;
  diagnosticSnapshot = reply.diagnostics;
  const accounts = diagnosticSnapshot?.accounts || [];
  const key = JSON.stringify(accounts);
  if (renderedLists.get('diagnostics-account') !== key) {
    $('diagnostics-account').replaceChildren();
    for (const account of accounts) {
      const option = document.createElement('option'); option.value = account.accountKey;
      option.textContent = `${account.platform === 'doubao' ? '豆包' : 'ChatGPT'} · ${assetLabel(account.label, '已配置账号')}`;
      $('diagnostics-account').append(option);
    }
    renderedLists.set('diagnostics-account', key);
  }
  $('diagnostics-account').value = diagnosticSnapshot?.accountKey || '';
  renderDiagnostics();
}
function renderDiagnostics() {
  const channelNames = { collection: '对话采集／写入', download: '附件下载／写入', github: 'GitHub 备份', restore: '仓库恢复' };
  const selectedChannel = $('diagnostics-channel').value || 'all', selectedStatus = $('diagnostics-status').value || 'all';
  const guidance = {
    collection: '先查看失败步骤与原因。恢复登录或目录权限后，回首页重试未完成项；遇到本地冲突，先保留并核对自己的修改，不必直接全量补采。',
    download: '正文完成不代表附件已保存。先在来源平台确认附件可打开，再回首页“重试失败附件”；来源已删除或返回 404 时，反复重试不保证恢复。',
    github: '这里只表示对话文件备份，附件仍在本地。先按错误原因检查网络、仓库权限或冲突，再到设置中的 GitHub 备份处理；无需重新采集对话。',
    restore: '仓库恢复记录覆盖该仓库全部恢复账号。先检查保存目录和仓库权限，再到设置重新尝试恢复；二进制附件需要从原电脑复制或从来源平台补齐。',
  };
  text('diagnostics-help', guidance[selectedChannel] || '这里展示本机保留的步骤记录，不代表当前所有问题。先选账号和阶段查看原因，回首页处理；需要反馈时先预览脱敏导出，再保存诊断文件。');
  const after = Date.now() - ($('diagnostics-period').value === 'day' ? 1 : 7) * 86400000;
  const code = $('diagnostics-code').value.trim().toUpperCase();
  const records = [];
  for (const [channel, log] of Object.entries(diagnosticSnapshot?.channels || {})) {
    if (selectedChannel !== 'all' && selectedChannel !== channel) continue;
    const rows = [...(log.history || [])];
    if (log.current && !rows.some(item => item.operationId && item.operationId === log.current.operationId)) rows.unshift(log.current);
    for (const item of rows) {
      if ((item.finishedAt || item.updatedAt || 0) < after) continue;
      if (selectedStatus === 'failed' && (item.status !== 'failed' || item.recoveredAt)) continue;
      if (selectedStatus === 'recovered' && !item.recoveredAt) continue;
      if (selectedStatus === 'interrupted' && item.status !== 'interrupted') continue;
      if (code && !assetFailureCode(item.code).includes(code)) continue;
      records.push({ ...item, channel });
    }
  }
  records.sort((a, b) => (b.finishedAt || b.updatedAt || 0) - (a.finishedAt || a.updatedAt || 0));
  text('diagnostics-count', records.length ? `符合筛选 ${records.length} 条，显示前 ${Math.min(100, records.length)} 条。完整保留记录可导出；历史失败不等于当前任务仍失败。` : '当前筛选没有日志。旧版本仅能沿用尚未被覆盖的最近记录；没有日志不代表没有待处理任务。');
  const unavailable = Object.entries(diagnosticSnapshot?.channels || {}).filter(([, log]) => log.unavailable).map(([channel]) => channelNames[channel]);
  if (unavailable.length) text('diagnostics-count', `暂时无法读取 ${unavailable.join('、')} 的日志；以下记录可能不完整，请稍后刷新。`);
  const list = $('diagnostics-list'), scroll = list.scrollTop;
  const renderKey = JSON.stringify(records.slice(0, 100));
  if (renderedLists.get('diagnostics-list') === renderKey) return;
  renderedLists.set('diagnostics-list', renderKey); list.replaceChildren();
  for (const item of records.slice(0, 100)) {
    const row = document.createElement('li'), details = document.createElement('details');
    appendText(details, 'summary', `${channelNames[item.channel] || '任务'} · ${activityName(item)} · ${item.recoveredAt ? '本步骤已恢复' : activityStatuses[item.status] || '已记录'}${item.code ? ' · ' + assetFailureCode(item.code) : ''}`);
    appendText(details, 'p', activityTitle(item));
    appendText(details, 'p', `${new Date(item.finishedAt || item.updatedAt).toLocaleString()} · 耗时 ${duration((item.finishedAt || item.updatedAt) - item.startedAt)}${item.occurrences ? ` · 同类失败 ${count(item.occurrences)} 次` : ''}`, 'muted');
    if (item.taskId) appendText(details, 'p', `本机任务编号：${assetLabel(item.taskId, '')}`, 'muted');
    if (item.status === 'failed') {
      const reason = detailFailureMessage(item);
      const advice = item.channel === 'download' ? assetFailureMessage(item.code) :
        item.code === 'HTTP_401' || item.code === 'HTTP_403' ? '来源拒绝了请求，请检查登录状态、权限及原网页是否可访问。' :
        item.code === 'DIRECTORY_PERMISSION' ? '请回到首页或设置恢复保存目录权限。' :
        item.code === 'HTTP_429' ? '服务限制请求频率，请等待冷却后重试。' :
        item.code === 'ACCOUNT_CHANGED' ? '账号发生变化，请回到任务所属账号后处理。' :
        '此步骤未完成。请回到首页查看当前任务状态和可用操作；已有归档保留。';
      appendText(details, 'p', reason || advice);
      if (item.recoveredAt) appendText(details, 'p', `该步骤于 ${new Date(item.recoveredAt).toLocaleString()} 成功；其他阶段请以首页结果为准。`);
    }
    row.append(details); list.append(row);
  }
  if (Number.isFinite(scroll)) list.scrollTop = scroll;
}
for (const [id, channel] of [['open-diagnostics', 'all'], ['settings-diagnostics', 'all'],
  ['problem-collection', 'collection'], ['problem-assets', 'download'], ['problem-github', 'github']]) action(id, async () => {
  diagnosticExport = null; show('diagnostics-export', false);
  $('diagnostics-channel').value = channel;
  $('diagnostics-status').value = channel === 'download' ? 'failed' : 'all';
  $('diagnostics-period').value = 'week'; $('diagnostics-code').value = '';
  await loadDiagnostics('collector:diagnostics', current?.account?.accountKey); screen = 'diagnostics';
});
$('reset-diagnostics-filters').addEventListener('click', () => {
  $('diagnostics-channel').value = 'all'; $('diagnostics-status').value = 'all';
  $('diagnostics-period').value = 'week'; $('diagnostics-code').value = '';
  renderDiagnostics();
});
action('diagnostics-back', () => { screen = 'home'; });
action('refresh-diagnostics', () => loadDiagnostics());
action('clear-diagnostics', async () => { await loadDiagnostics('collector:clear-diagnostics'); diagnosticExport = null; show('diagnostics-export', false); });
$('diagnostics-account').addEventListener('change', () => { diagnosticExport = null; show('diagnostics-export', false); void loadDiagnostics().catch(error => feedback(safeMessage(error), true)); });
for (const id of ['diagnostics-channel', 'diagnostics-status', 'diagnostics-period', 'diagnostics-code']) $(id).addEventListener('input', renderDiagnostics);
action('preview-diagnostics', async () => {
  const reply = await send('collector:export-diagnostics', { accountKey: $('diagnostics-account').value || undefined });
  diagnosticExport = reply.report; text('diagnostics-preview', JSON.stringify(diagnosticExport, null, 2)); show('diagnostics-export', true);
});
action('save-diagnostics', () => {
  if (!diagnosticExport) throw new Error('请先生成脱敏导出预览。');
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnosticExport, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'ai-memory-collector-diagnostics.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action('cancel-diagnostics-export', () => { diagnosticExport = null; show('diagnostics-export', false); });
action('grant-chatgpt', grantChatGPT);
action('home-grant', () => current.platform === 'doubao' ? grantDoubao() : grantChatGPT());
action('grant-doubao', grantDoubao);
action('settings-grant-doubao', grantDoubao);
action('settings-grant-chatgpt', grantChatGPT);
action('grant-doubao-images', async () => {
  if (!await chrome.permissions.request({ origins: ['https://*.byteimg.com/*'] })) throw new Error('未获得豆包图片域名权限。');
  await send('collector:permissions-changed');
});
for (const id of ['open-doubao', 'home-open-doubao']) action(id, () => chrome.tabs.create({ url: 'https://www.doubao.com/chat/' }));
for (const id of ['open-chatgpt', 'home-open-chatgpt']) action(id, () => chrome.tabs.create({ url: 'https://chatgpt.com/' }));
action('wizard-bind', async () => { await send('collector:bind', { alias: $('account-alias').value.trim() }); step = 1; });
action('bind-account', () => send('collector:bind', { alias: $('new-account-alias').value.trim() }));
for (const id of ['wizard-choose-directory', 'choose-directory']) action(id, chooseDirectory);
for (const id of ['wizard-restore-directory', 'restore-directory', 'settings-restore-directory']) action(id, restoreDirectory);
action('wizard-next-1', () => { step = 2; populateWizardGithub(); });
action('wizard-connect-github', () => saveGithub(true));
action('wizard-next-2', () => { step = 3; });
action('wizard-skip-github', () => { step = 3; });
for (let index = 1; index <= 3; index++) action(`wizard-back-${index}`, () => { step = index - 1; });
action('wizard-finish', async () => {
  await send('collector:configure', { setupComplete: true, autoEnabled: $('wizard-auto-enabled').checked,
    localAssetsEnabled: $('wizard-local-assets-enabled').checked, intervalMinutes: 30 });
  await send('collector:start', { mode: 'initial' });
  screen = 'home';
});
action('start-capture', () => send('collector:start', { mode: current?.account?.initialized ? 'incremental' : 'initial' }));
action('full-capture', () => { fullCaptureAccount = current?.account?.accountKey || null; });
action('cancel-full-capture', () => { fullCaptureAccount = null; });
action('confirm-full-capture', async () => {
  if (!fullCaptureAccount || fullCaptureAccount !== current?.account?.accountKey || current?.identityChecking) throw new Error('账号或任务状态已变化，请重新选择全量补采。');
  await send('collector:start', { mode: 'full', expectedAccountKey: fullCaptureAccount }); fullCaptureAccount = null;
});
action('repair-recommended', () => send('collector:repair-local'));
action('repair-local', () => send('collector:repair-local'));
action('pause-capture', () => send('collector:pause'));
action('stop-capture', () => send('collector:stop', { accountKey: current?.account?.accountKey }));
action('resume-capture', () => send('collector:resume'));
action('retry-images', () => send('collector:retry-images'));
action('retry-internal-images', () => send('collector:retry-images', { includeInternal: true }));
action('retry-github', async () => { await grantGithub(); await send('collector:retry-github'); });
action('backup-github-now', async () => {
  if (unsavedGithubSettings()) throw new Error('请先保存 GitHub 设置，再备份对话。');
  await grantGithub(); await send('collector:retry-github');
});
for (const id of ['open-restore', 'wizard-open-restore']) action(id, () => { screen = 'settings'; settingsLoaded = false; });
action('restore-github', () => restoreGithub(false));
action('restore-retry', () => restoreGithub(true));
action('grant-external-images', async () => {
  const granted = await chrome.permissions.request({ origins: ['https://*/*'] });
  if (!granted) throw new Error('未获得外链附件检测权限。对话与链接仍可正常归档。');
  externalImagePermission = true;
  await send('collector:permissions-changed');
});
action('open-settings', () => { screen = 'settings'; settingsLoaded = false; });
action('back-home', () => { screen = 'home'; });
action('save-schedule', () => send('collector:configure', { autoEnabled: $('auto-enabled').checked,
  localAssetsEnabled: $('local-assets-enabled').checked, intervalMinutes: Number($('interval-minutes').value) }));
action('save-github', () => saveGithub(false));
action('forget-token', async () => { await send('collector:github-config', { token: '', enabled: false, autoRestore: false }); settingsLoaded = false; });
action('collapse-panel', () => closePanel(false));
action('hide-panel', () => closePanel(true));
action('settings-hide', () => closePanel(true));
for (const id of ['wizard-repository', 'wizard-branch', 'wizard-token', 'wizard-github-enabled', 'wizard-github-auto-restore']) $(id).addEventListener('input', () => {
  wizardGithubVerified = false; $('wizard-next-2').disabled = true; text('wizard-github-status', '配置已改变，请重新验证。');
});
for (const id of ['repository', 'branch', 'github-token', 'github-enabled', 'github-auto-restore']) {
  $(id).addEventListener('input', () => { render(); });
}
window.addEventListener('focus', () => { refreshProgress(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshProgress(true); });
const poll = setInterval(() => { if (!document.hidden) return refreshProgress(); }, 3000);
window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
try { directory = await getSetting('directory'); await refresh(true); feedback(''); }
catch (error) { feedback(safeMessage(error), true); window.dispatchEvent(new Event('collector:ready')); }
