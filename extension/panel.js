import { getSetting, setSetting } from './lib/storage.js';

const $ = id => document.getElementById(id);
const setupPage = new URL(location.href).searchParams.get('setup') === '1';
const sourceParameter = new URL(location.href).searchParams.get('tab');
const sourceTabId = sourceParameter !== null && /^\d+$/.test(sourceParameter) ? Number(sourceParameter) : null;
let current = null;
let directory = null;
let screen = 'home';
let step = 0;
let busy = false;
let started = false;
let wizardGithubVerified = false;
let settingsLoaded = false;
let stateRevision = 0;
let activeAliasKey = null;
let externalImagePermission = false;
const githubOrigins = ['https://api.github.com/*', 'https://github.com/*', 'https://lfs.github.com/*',
  'https://github-cloud.githubusercontent.com/*', 'https://objects.githubusercontent.com/*',
  'https://media.githubusercontent.com/*', 'https://github-cloud.s3.amazonaws.com/*'];
const runningStatuses = new Set(['running', 'scanning', 'collecting', 'saving', 'syncing']);
const pausedStatuses = new Set(['paused', 'blocked', 'waiting', 'retrying', 'interrupted', 'waiting-source', 'waiting-permission', 'partial']);
const controls = () => document.querySelectorAll('button,input,select');
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
  if (reply.state) current = reply.state;
  return reply;
}
function time(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function count(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 ? String(Number(value)) : '0'; }
function assetFailureCode(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(value) ? value : 'ASSET_UNKNOWN'; }
function assetFailureMessage(code) {
  // Error strings can originate in network/extension APIs. Only fixed messages
  // reach this diagnostic view; response bodies, signed URLs and tokens do not.
  if (/^(?:HTTP_401|HTTP_403|IDENTITY)$/.test(code)) return '请确认 ChatGPT 已登录，且当前账号可以打开原图。';
  if (code === 'HTTP_404') return '图片下载入口未找到；原图可能需要打开后补采，或等待接口适配。';
  if (code === 'HTTP_429') return '图片请求受到限流，请稍后重试。';
  if (/^HTTP_5\d\d$/.test(code)) return '图片服务暂时不可用，请稍后重试。';
  if (code === 'ACCOUNT_CHANGED') return '账号已切换，已停止处理。请回到图片所属账号后重试。';
  if (/^(?:TAB_|ORIGIN)/.test(code)) return '请打开所属账号的 ChatGPT 标签页，并确认站点访问权限。';
  if (code === 'ASSET_PENDING') return '尚未取得可确认归属的原图。可打开对应对话和图片后重试；部分资源仍需适配。';
  if (code === 'ASSET_SOURCE_MISSING') return '最新对话中未找到这张图片，已有文件和任务已保留。请打开对应对话检查后重试。';
  if (code === 'INCOMPLETE_DETAIL') return '本次返回的对话详情不完整，未覆盖已保存数据。请稍后重试。';
  if (/^(?:ASSET_URL|ASSET_REDIRECT|ASSET_PROTOCOL)$/.test(code)) return '图片下载地址或跳转尚未支持。可打开原图后重试；部分资源仍需适配。';
  if (/^(?:ASSET_NETWORK|ASSET_TIMEOUT)$/.test(code)) return '图片下载未完成，请检查网络后重试。';
  if (code === 'ASSET_LINK_UNKNOWN') return '外链暂时无法验证。请检查设置中的外链图片权限；原链接已保留。';
  if (/^(?:ASSET_SIZE|ASSET_TOO_LARGE)$/.test(code)) return '图片数据为空或超过当前处理上限。';
  if (/^(?:ASSET_FORMAT|ASSET_RESPONSE|ASSET_NOT_IMAGE|ASSET_STREAM)$/.test(code)) return '未取得受支持的完整图片，任务已保留。';
  if (/^(?:ASSET_VARIANT|ASSET_HASH|ASSET_HASH_MISMATCH)$/.test(code)) return '图片与原始附件信息不一致，未作为原图保存。';
  if (/^(?:LOCAL_CONFLICT|ASSET_LOCAL_CONFLICT)$/.test(code)) return '本地文件已变化，已保留原文件。请检查对应对话或图片。';
  if (code === 'DIRECTORY_PERMISSION') return '请恢复保存目录的读写权限。';
  if (code === 'DIRECTORY_CHANGED') return '图片写入尚未完成，请恢复原保存目录后重试。';
  if (code === 'ASSET_WRITE') return '图片写入未完成，请检查保存目录后重试。';
  return '本次图片处理未完成，任务已保留。可根据错误代码继续排查。';
}
function assetLabel(value, fallback) {
  return safeMessage(typeof value === 'string' && value ? value : fallback)
    .replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
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
    filename.textContent = assetLabel(failure.fileName, '未命名图片');
    const code = assetFailureCode(failure.code);
    const explanation = document.createElement('p'); explanation.textContent = assetFailureMessage(code);
    const metadata = document.createElement('p'); metadata.classList.add('muted');
    metadata.textContent = `${code} · 已尝试 ${count(failure.attempt)} 次${time(failure.retryAt) ? ` · 重试等待至 ${time(failure.retryAt)}` : ''}`;
    item.append(title, filename, explanation, metadata); list.append(item);
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
    filename.textContent = assetLabel(failure.fileName, '未命名内部附件');
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
    `ChatGPT · ${current.account?.alias || current.identity?.displayName || '尚未绑定'}`,
    `保存到 ${current.directory?.name || directory?.name || '尚未选择'}`,
    '默认保存 JSON 与 Markdown',
    current.config?.github?.enabled ? `GitHub：${current.config.github.repository || '已配置'}` : 'GitHub：暂不启用',
  ];
  for (const value of values) { const p = document.createElement('p'); p.textContent = value; target.append(p); }
}
function fillSettings() {
  const config = current?.config || {};
  $('auto-enabled').checked = config.autoEnabled !== false;
  $('interval-minutes').value = String([15, 30, 60].includes(config.intervalMinutes) ? config.intervalMinutes : 30);
  $('github-enabled').checked = config.github?.enabled === true;
  $('lfs-enabled').checked = config.github?.lfsEnabled !== false;
  $('repository').value = config.github?.repository || '';
  $('branch').value = config.github?.branch || '';
  $('github-token').value = '';
  text('token-status', config.github?.hasToken ? '此浏览器已保存 Token，留空沿用。' : '尚未保存 Token。');
  settingsLoaded = true;
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
  const isWizard = !config.setupComplete && screen !== 'settings';
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
  show('open-settings', screen !== 'settings');
  text('back-home', config.setupComplete ? '‹ 返回采集' : '‹ 返回首次设置');
  const selectedName = account?.alias || identity?.displayName || '尚未识别账号';
  text('account-name', selectedName);
  text('account-avatar', identity ? Array.from(selectedName).slice(0, 2).join('').toUpperCase() : 'AI');
  text('account-context', identity ? 'ChatGPT · 普通对话' : '打开并登录 ChatGPT 后自动识别');
  text('account-badge', !identity ? '等待登录' : account?.enabled ? '已启用' : '未启用');
  const hasIdentity = Boolean(identity?.accountKey);
  show('account-alert', !hasIdentity || !account?.enabled);
  show('bind-account', hasIdentity && !account?.enabled);
  show('new-account-alias', hasIdentity && !account?.enabled);
  $('new-account-alias').parentElement.hidden = !hasIdentity || Boolean(account?.enabled);
  const requiresPermission = !current.error || ['SITE_PERMISSION_DENIED', 'SITE_PERMISSION', 'SITE_PERMISSION_REQUIRED', 'PERMISSION_REQUIRED'].includes(current.error?.code);
  show('home-grant', !hasIdentity && requiresPermission);
  show('home-open-chatgpt', !hasIdentity && !requiresPermission);
  text('account-alert-text', hasIdentity ? '当前账号尚未启用。确认后会保存到它自己的目录。' :
    safeMessage(current.error?.message || '请打开并登录 ChatGPT。页面会自动更新，无需手动选择标签页。'));
  if (activeAliasKey !== identity?.accountKey) {
    activeAliasKey = identity?.accountKey || null;
    $('account-alias').value = account?.alias || identity?.displayName || '';
    $('new-account-alias').value = account?.alias || identity?.displayName || '';
  }
  const interval = config.intervalMinutes || 30;
  text('home-heading', isRunning ?
    job.mode === 'full' ? '正在全量补采' : job.mode === 'initial' ? '正在初始化采集' : '正在检查新增与更新' :
    isPartial ? '部分采集已完成' : isPaused ? '采集已暂停' : !account?.initialized ? '准备好首次采集' : config.autoEnabled === false ? '对话归档已就绪' : '对话正在自动归档');
  text('schedule-status', config.autoEnabled === false ? '自动采集已暂停，可以手动采集。' :
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
  const error = jobError(job) || (hasIdentity ? current.error?.message : '');
  show('job-error', Boolean(error)); text('job-error', safeMessage(error || ''));
  show('start-capture', !isRunning && !isPaused);
  text('start-capture', account?.initialized ? '立即检查更新' : '开始初始化采集');
  show('full-capture', Boolean(account?.initialized) && !isRunning && (!isPaused || isPartial));
  show('pause-capture', isRunning);
  show('resume-capture', isPaused);
  text('resume-capture', isPartial ? '重试未完成项' : '继续采集');
  const directoryName = current.directory?.name || directory?.name || '尚未选择';
  const granted = current.directory?.granted === true;
  text('directory-name', directoryName);
  text('directory-status', granted ? '自动保存' : current.directory?.name ? '需要授权' : '未设置');
  show('restore-directory', !granted && Boolean(current.directory?.name || directory));
  text('settings-directory', `${directoryName} · JSON + Markdown`);
  show('settings-restore-directory', !granted && Boolean(current.directory?.name || directory));
  const githubDescription = describeGithub(current.githubStatus, config.github?.enabled);
  text('github-state', githubDescription);
  show('retry-github', Boolean(config.github?.enabled) && (githubDescription.includes('待同步') || Number(current.githubStatus?.pending) > 0));
  const githubDetail = config.github?.enabled ? current.githubStatus?.message || current.githubStatus?.error?.message || '' : '';
  text('github-detail', safeMessage(githubDetail));
  show('github-detail', Boolean(githubDetail));
  $('github-detail').classList.toggle('warning-text', current.githubStatus?.status === 'conflicts');
  const assets = current.assetStatus || {};
  const diagnostics = current.assetDiagnostics;
  const pendingImages = Number(diagnostics?.pending ?? assets.pendingCapture) || 0;
  const failedImages = Number(diagnostics?.failed ?? assets.failed) || 0;
  const internalMissing = Number(diagnostics?.internalMissing ?? assets.internalMissing) || 0;
  const assetParts = [];
  if (Number(assets.local) > 0) assetParts.push(`本地图片 ${count(assets.local)}`);
  if (Number(assets.uploaded) > 0) assetParts.push(`已上传 ${count(assets.uploaded)}`);
  if (Number(assets.downloaded) > 0) assetParts.push(`已恢复 ${count(assets.downloaded)}`);
  if (Number(assets.external) > 0) assetParts.push(`外链 ${count(assets.external)}`);
  if (pendingImages > 0) assetParts.push(`${diagnostics ? '待处理' : '待采集'} ${count(pendingImages)}${failedImages > 0 ? `（其中失败 ${count(failedImages)}）` : ''}`);
  else if (failedImages > 0) assetParts.push(`待处理失败 ${count(failedImages)}`);
  if (Number(assets.pendingUpload) > 0) assetParts.push(`待上传 ${count(assets.pendingUpload)}`);
  if (internalMissing > 0) assetParts.push(`内部附件未下载 ${count(internalMissing)}`);
  text('asset-summary-text', assetParts.join(' · ')); show('asset-summary', assetParts.length > 0);
  renderAssetFailures(diagnostics);
  renderInternalAttachments(diagnostics, internalMissing);
  show('retry-images', failedImages > 0);
  show('image-retry-note', failedImages > 0);
  const imagePermissionNeeded = assets.needsPermission || current.githubStatus?.needsPermission ||
    /PERMISSION/.test(assets.error?.code || current.githubStatus?.error?.code || '');
  show('grant-github-images', Boolean(config.github?.enabled && config.github?.lfsEnabled !== false && imagePermissionNeeded));
  const restore = current.restoreStatus;
  const restoreRunning = ['running', 'restoring', 'scanning', 'downloading', 'saving'].includes(restore?.status);
  const restoreProgress = restore?.progress || restore || {};
  const restoreTotal = Number(restoreProgress.total) || 0;
  const restoreCompleted = Number(restoreProgress.completed ?? restoreProgress.processed) || 0;
  const restoreFailed = Number(restoreProgress.failed) || 0;
  const restoreNeedsRetry = restoreFailed > 0 || ['failed', 'error', 'partial', 'paused', 'blocked', 'interrupted', 'waiting-permission', 'needsPermission'].includes(restore?.status);
  const restoreReady = Boolean(config.github?.repository && config.github?.hasToken && granted);
  const requirements = [];
  if (!config.github?.repository || !config.github?.hasToken) requirements.push('请先填写并保存 GitHub 仓库与 Token。');
  if (!granted) requirements.push('请选择保存目录或恢复目录权限。');
  text('restore-requirements', requirements.join(' '));
  show('restore-progress', Boolean(restore && restore.status !== 'idle'));
  const restoreLabels = { completed: '恢复完成', complete: '恢复完成', success: '恢复完成',
    partial: '部分恢复完成', failed: '恢复未完成', error: '恢复未完成', paused: '恢复已暂停',
    blocked: '恢复需要处理', interrupted: '恢复已中断', 'waiting-permission': '等待权限', needsPermission: '等待权限', empty: '仓库暂无可恢复内容' };
  text('restore-phase', restoreRunning ? '正在恢复对话与图片' : restoreLabels[restore?.status] || '恢复进度已保留');
  text('restore-count', restoreTotal ? `${restoreCompleted} / ${restoreTotal}` : '');
  if (restoreTotal > 0) { $('restore-meter').max = Math.max(restoreTotal, restoreCompleted, 1); $('restore-meter').value = restoreCompleted; }
  else $('restore-meter').removeAttribute('value');
  show('restore-meter', restoreRunning || restoreTotal > 0);
  text('restore-detail', safeMessage(restore?.message || restore?.error?.message ||
    (restoreFailed ? `${restoreFailed} 项未完成，已恢复的文件会保留。` : restoreRunning ? '收起面板不会主动暂停恢复。' : '')));
  show('restore-retry', restoreNeedsRetry && !restoreRunning);
  text('external-images-status', externalImagePermission ? '已允许匿名检测。可在浏览器扩展设置中撤销网站访问权限。' : '尚未授权，外链图片保留为链接。');
  text('grant-external-images', externalImagePermission ? '已允许检测外链图片' : '允许检测外链图片');
  const result = current.lastResult || (['completed', 'complete', 'done', 'partial', 'failed'].includes(job?.status) ? job : null);
  show('last-result', Boolean(result));
  if (result) {
    text('count-added', count(result.added)); text('count-updated', count(result.updated));
    text('count-unchanged', count(result.unchanged)); text('count-failed', count(result.failed));
    text('last-result-time', time(result.completedAt || result.finishedAt || result.updatedAt));
  }
  text('settings-account', hasIdentity ? `ChatGPT · ${selectedName}` : '尚未识别当前账号');
  if (screen === 'settings' && !settingsLoaded) fillSettings();
  if (isWizard) {
    for (let index = 0; index < 4; index++) {
      show(`wizard-step-${index}`, index === step);
      const item = document.querySelector(`[data-step="${index}"]`);
      item.classList.toggle('current', index === step); item.classList.toggle('done', index < step);
      if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    }
    text('wizard-identity', identity ? `已识别：${selectedName}` : safeMessage(current.error?.message || '打开 ChatGPT 并完成授权后自动识别。'));
    show('grant-chatgpt', !identity); show('open-chatgpt', !identity);
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
  $('resume-capture').disabled = busy || !account?.enabled || !granted;
  $('retry-images').disabled = busy || failedImages <= 0 || !account?.enabled || !granted || !hasIdentity ||
    account.accountKey !== identity.accountKey || !Number.isSafeInteger(current.tabId) || current.tabId < 0;
  $('retry-internal-images').disabled = busy || internalMissing <= 0 || !account?.enabled || !granted || !hasIdentity ||
    account.accountKey !== identity.accountKey || !Number.isSafeInteger(current.tabId) || current.tabId < 0;
  $('restore-github').disabled = busy || !restoreReady || restoreRunning;
  $('restore-retry').disabled = busy || !restoreReady || restoreRunning;
  $('grant-external-images').disabled = busy || externalImagePermission;
  if (!started) { started = true; window.dispatchEvent(new Event('collector:ready')); }
}
async function refresh() {
  const revision = ++stateRevision;
  const reply = await chrome.runtime.sendMessage({ type: 'collector:get-state', ...(sourceTabId === null ? {} : { tabId: sourceTabId }) });
  if (!reply?.ok) throw errorObject(reply?.error || '暂时无法读取后台状态。');
  if (revision !== stateRevision) return;
  current = reply.state;
  if (chrome.permissions.contains) {
    try { externalImagePermission = await chrome.permissions.contains({ origins: ['https://*/*'] }); }
    catch { externalImagePermission = false; }
    if (revision !== stateRevision) return;
  }
  render();
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
  await send('collector:directory-changed');
}
async function grantGithub(lfs = false) {
  const granted = await chrome.permissions.request({ origins: lfs ? githubOrigins : ['https://api.github.com/*'] });
  if (!granted) throw new Error('未获得 GitHub 访问权限。已有数据会保留，可再次点击授权或关闭图片同步后保存配置。');
}
async function restoreGithub(retry = false) {
  // Start the permission request directly from this click, before any network await.
  await grantGithub(true);
  await send(retry ? 'collector:restore-retry' : 'collector:restore');
}
async function saveGithub(wizard = false) {
  const repository = $(wizard ? 'wizard-repository' : 'repository').value.trim();
  const branch = $(wizard ? 'wizard-branch' : 'branch').value.trim();
  const tokenInput = $(wizard ? 'wizard-token' : 'github-token');
  const token = tokenInput.value.trim();
  const enabled = wizard || $('github-enabled').checked;
  const lfsEnabled = $(wizard ? 'wizard-lfs-enabled' : 'lfs-enabled').checked;
  const verify = enabled || Boolean(repository && (token || current?.config?.github?.hasToken));
  if (verify) await grantGithub(lfsEnabled);
  await send('collector:github-config', { repository, branch, enabled, lfsEnabled, ...(token ? { token } : {}) });
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
  $('wizard-lfs-enabled').checked = github.lfsEnabled !== false;
  $('wizard-token').placeholder = github.hasToken ? '已保存 Token，留空沿用' : '粘贴仅授权此仓库的 Token';
  wizardGithubVerified = false;
  text('wizard-github-status', '');
}
async function closePanel(hide = false) {
  await send('collector:close-panel', { hide });
  if (!setupPage) window.close();
}
action('grant-chatgpt', grantChatGPT);
action('home-grant', grantChatGPT);
for (const id of ['open-chatgpt', 'home-open-chatgpt']) action(id, () => chrome.tabs.create({ url: 'https://chatgpt.com/' }));
action('wizard-bind', async () => { await send('collector:bind', { alias: $('account-alias').value.trim() }); step = 1; });
action('bind-account', () => send('collector:bind', { alias: $('new-account-alias').value.trim() }));
for (const id of ['wizard-choose-directory', 'choose-directory']) action(id, chooseDirectory);
for (const id of ['wizard-restore-directory', 'restore-directory', 'settings-restore-directory']) action(id, restoreDirectory);
action('wizard-next-1', () => { step = 2; populateWizardGithub(); });
action('wizard-connect-github', () => saveGithub(true));
action('wizard-next-2', () => { step = 3; });
action('wizard-skip-github', async () => { await send('collector:github-config', { enabled: false }); step = 3; });
for (let index = 1; index <= 3; index++) action(`wizard-back-${index}`, () => { step = index - 1; });
action('wizard-finish', async () => {
  await send('collector:configure', { setupComplete: true, autoEnabled: $('wizard-auto-enabled').checked, intervalMinutes: 30 });
  await send('collector:start', { mode: 'initial' });
  screen = 'home';
});
action('start-capture', () => send('collector:start', { mode: current?.account?.initialized ? 'incremental' : 'initial' }));
action('full-capture', () => send('collector:start', { mode: 'full' }));
action('pause-capture', () => send('collector:pause'));
action('resume-capture', () => send('collector:resume'));
action('retry-images', () => send('collector:retry-images'));
action('retry-internal-images', () => send('collector:retry-images', { includeInternal: true }));
action('retry-github', async () => { await grantGithub(current?.config?.github?.lfsEnabled !== false); await send('collector:retry-github'); });
action('grant-github-images', async () => { await grantGithub(true); await send('collector:retry-github'); });
for (const id of ['open-restore', 'wizard-open-restore']) action(id, () => { screen = 'settings'; settingsLoaded = false; });
action('restore-github', () => restoreGithub(false));
action('restore-retry', () => restoreGithub(true));
action('grant-external-images', async () => {
  const granted = await chrome.permissions.request({ origins: ['https://*/*'] });
  if (!granted) throw new Error('未获得外链图片检测权限。对话与链接仍可正常归档。');
  externalImagePermission = true;
  await send('collector:permissions-changed');
});
action('open-settings', () => { screen = 'settings'; settingsLoaded = false; });
action('back-home', () => { screen = 'home'; });
action('save-schedule', () => send('collector:configure', { autoEnabled: $('auto-enabled').checked, intervalMinutes: Number($('interval-minutes').value) }));
action('save-github', () => saveGithub(false));
action('forget-token', async () => { await send('collector:github-config', { token: '', enabled: false }); settingsLoaded = false; });
action('collapse-panel', () => closePanel(false));
action('hide-panel', () => closePanel(true));
action('settings-hide', () => closePanel(true));
for (const id of ['wizard-repository', 'wizard-branch', 'wizard-token', 'wizard-lfs-enabled']) $(id).addEventListener('input', () => {
  wizardGithubVerified = false; $('wizard-next-2').disabled = true; text('wizard-github-status', '配置已改变，请重新验证。');
});
window.addEventListener('focus', () => { if (!busy) refresh().catch(error => feedback(safeMessage(error), true)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh().catch(error => feedback(safeMessage(error), true)); });
const poll = setInterval(() => { if (!document.hidden && !busy) refresh().catch(error => feedback(safeMessage(error), true)); }, 3000);
window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
try { directory = await getSetting('directory'); await refresh(); feedback(''); }
catch (error) { feedback(safeMessage(error), true); window.dispatchEvent(new Event('collector:ready')); }
