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
  const isWizard = !config.setupComplete;
  show('legacy-notice', current.legacyPending === true);
  show('context-error', Boolean(current.error?.message) && (screen === 'settings' || !current.identity));
  text('context-error', current.error?.message ? safeMessage(current.error) : '');
  if (isWizard && step > 0 && !account?.enabled) step = 0;
  document.body.classList.toggle('setup-page', setupPage && isWizard);
  show('wizard', isWizard);
  show('home', !isWizard && screen === 'home');
  show('settings', !isWizard && screen === 'settings');
  show('open-settings', !isWizard && screen !== 'settings');
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
  if (!started) { started = true; window.dispatchEvent(new Event('collector:ready')); }
}
async function refresh() {
  const revision = ++stateRevision;
  const reply = await chrome.runtime.sendMessage({ type: 'collector:get-state', ...(sourceTabId === null ? {} : { tabId: sourceTabId }) });
  if (!reply?.ok) throw errorObject(reply?.error || '暂时无法读取后台状态。');
  if (revision !== stateRevision) return;
  current = reply.state;
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
async function saveGithub(wizard = false) {
  const repository = $(wizard ? 'wizard-repository' : 'repository').value.trim();
  const branch = $(wizard ? 'wizard-branch' : 'branch').value.trim();
  const tokenInput = $(wizard ? 'wizard-token' : 'github-token');
  const token = tokenInput.value.trim();
  const enabled = wizard || $('github-enabled').checked;
  if (enabled) {
    const granted = await chrome.permissions.request({ origins: ['https://api.github.com/*'] });
    if (!granted) throw new Error('未获得 GitHub 访问权限，配置尚未启用。');
  }
  await send('collector:github-config', { repository, branch, enabled, ...(token ? { token } : {}) });
  if (enabled) await send('collector:github-test');
  tokenInput.value = '';
  if (wizard) { wizardGithubVerified = true; text('wizard-github-status', '私有仓库连接验证成功。'); }
  else settingsLoaded = false;
}
function populateWizardGithub() {
  const github = current?.config?.github || {};
  $('wizard-repository').value = github.repository || '';
  $('wizard-branch').value = github.branch || '';
  $('wizard-token').value = '';
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
action('retry-github', () => send('collector:retry-github'));
action('open-settings', () => { screen = 'settings'; settingsLoaded = false; });
action('back-home', () => { screen = 'home'; });
action('save-schedule', () => send('collector:configure', { autoEnabled: $('auto-enabled').checked, intervalMinutes: Number($('interval-minutes').value) }));
action('save-github', () => saveGithub(false));
action('forget-token', async () => { await send('collector:github-config', { token: '', enabled: false }); settingsLoaded = false; });
action('collapse-panel', () => closePanel(false));
action('hide-panel', () => closePanel(true));
action('settings-hide', () => closePanel(true));
for (const id of ['wizard-repository', 'wizard-branch', 'wizard-token']) $(id).addEventListener('input', () => {
  wizardGithubVerified = false; $('wizard-next-2').disabled = true; text('wizard-github-status', '配置已改变，请重新验证。');
});
window.addEventListener('focus', () => { if (!busy) refresh().catch(error => feedback(safeMessage(error), true)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh().catch(error => feedback(safeMessage(error), true)); });
const poll = setInterval(() => { if (!document.hidden && !busy) refresh().catch(error => feedback(safeMessage(error), true)); }, 3000);
window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
try { directory = await getSetting('directory'); await refresh(); feedback(''); }
catch (error) { feedback(safeMessage(error), true); window.dispatchEvent(new Event('collector:ready')); }
