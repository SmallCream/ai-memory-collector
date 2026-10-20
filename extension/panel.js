import { probeChatGPT } from './lib/chatgpt.js';
import { buildArchive } from './lib/archive.js';
import { getSetting, setSetting, writeArchive } from './lib/storage.js';
import { probeRepository, commitProbe } from './lib/github.js';

const $ = (id) => document.getElementById(id);
let identity = null, nextOffset = null, directory = null, pending = null, busy = false, locked = true;
let activeFeedback = null;
const buttons = [...document.querySelectorAll('button')];
function showFeedback(element, text, error = false) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('error', error);
}
function status(text, error = false) {
  showFeedback($('global-status'), text, error);
  showFeedback(activeFeedback, text, error);
}
function startupStatus(text, error = false) {
  status(text, error);
  for (const element of document.querySelectorAll('[data-action-status]')) showFeedback(element, error ? text : '', error);
  window.dispatchEvent(new Event('collector:ready'));
}
function errorText(error) {
  let message = error?.message || '操作未完成，请重试。';
  const token = $('github-token').value.trim();
  if (token.length >= 8) message = message.split(token).join('[已隐藏]');
  message = message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]');
  const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? `（${error.code}）` : '';
  return `${message}${code}`;
}
function refreshControls() {
  for (const button of buttons) button.disabled = busy || locked;
  for (const input of document.querySelectorAll('input,select')) input.disabled = busy || locked;
  $('next').disabled ||= nextOffset === null || !identity;
  $('list').disabled ||= !identity;
  $('use-current').disabled ||= !identity;
  $('capture').disabled ||= !identity || !$('conversation').value;
  $('save-local').disabled ||= !pending || !directory;
  $('discard').disabled ||= !pending;
  $('reauthorize').disabled ||= !directory;
}
function action(id, fn) {
  const button = $(id);
  button.addEventListener('click', async () => {
    if (busy || locked) return;
    const label = button.textContent;
    activeFeedback = button.closest('section')?.querySelector('[data-action-status]');
    busy = true; refreshControls();
    button.textContent = '处理中…';
    button.setAttribute('aria-busy', 'true');
    status(`正在${label}…`);
    try { await fn(); }
    catch (error) {
      // Chrome errors and GitHub wrapper errors must not include API bodies or tokens.
      status(errorText(error), true);
      if (error?.code === 'ACCOUNT_CHANGED' || error?.code === 'IDENTITY') clearIdentity();
    } finally {
      button.textContent = label;
      button.removeAttribute('aria-busy');
      activeFeedback = null;
      busy = false; refreshControls();
    }
  });
}
function clearIdentity() {
  identity = null; nextOffset = null;
  $('identity').textContent = '需要重新识别账号';
  $('conversation').replaceChildren(new Option('先读取列表', ''));
  $('list-status').textContent = '尚未读取列表';
}
async function permissions(origin) {
  // Must run directly in a user click chain.
  if (!await chrome.permissions.request({ origins: [origin] })) {
    const error = new Error('未获得站点访问权限，请再次点击并允许浏览器授权。');
    error.code = 'SITE_PERMISSION_DENIED';
    throw error;
  }
}
async function runProbe(request) {
  const tabId = Number($('source-tab').value);
  if (!$('source-tab').value || !Number.isInteger(tabId)) throw new Error('请先连接并选择 ChatGPT 标签页。');
  if (!$('personal-space').checked) throw new Error('请先切换到个人空间并勾选确认。');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== 'https://chatgpt.com') throw new Error('标签页已离开 ChatGPT，请重新连接。');
  const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: probeChatGPT, args: [request] });
  const result = results.find(x => x.frameId === 0)?.result;
  if (!result?.ok) { const e = new Error(result?.error?.message || '没有取得有效结果，请检查网站状态。'); e.code = result?.error?.code; throw e; }
  return result;
}
action('connect', async () => {
  await permissions('https://chatgpt.com/*');
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  $('source-tab').replaceChildren(new Option('请选择标签页', ''));
  for (const tab of tabs) $('source-tab').append(new Option(tab.title || `ChatGPT ${tab.id}`, String(tab.id)));
  const preferred = new URL(location.href).searchParams.get('tab');
  if (tabs.some(t => String(t.id) === preferred)) $('source-tab').value = preferred;
  else if (tabs.length === 1) $('source-tab').value = String(tabs[0].id);
  clearIdentity(); status(tabs.length ? `找到 ${tabs.length} 个标签页，请识别账号。` : '请先打开并登录 chatgpt.com，然后重新连接。');
});
$('source-tab').addEventListener('change', () => { clearIdentity(); refreshControls(); });
$('personal-space').addEventListener('change', () => { clearIdentity(); refreshControls(); });
$('conversation').addEventListener('change', refreshControls);
action('identify', async () => {
  clearIdentity();
  const result = await runProbe({ kind: 'identity' });
  identity = result.identity;
  $('identity').textContent = `${identity.displayName} · ${identity.accountKey}`;
  status('已观察到当前登录身份。工作区和切换边界仍需实测。');
});
async function listPage(offset) {
  const result = await runProbe({ kind: 'list', offset, expectedAccountKey: identity.accountKey });
  const page = result.payload;
  $('conversation').replaceChildren(new Option('请选择测试对话', ''));
  for (const item of page.items) $('conversation').append(new Option(item.title, item.id));
  nextOffset = page.nextOffset;
  $('list-status').textContent = `本页 ${page.items.length} 条，偏移 ${offset}；覆盖范围未验证`;
  status('已读取一页。项目、归档、临时会话和完整历史尚未验证。');
}
action('list', () => listPage(0));
action('next', () => listPage(nextOffset));
action('use-current', async () => {
  const tab = await chrome.tabs.get(Number($('source-tab').value));
  const url = new URL(tab.url);
  const match = url.origin === 'https://chatgpt.com' && /\/c\/([a-zA-Z0-9_-]{1,100})(?:\/|$)/.exec(url.pathname);
  if (!match) throw new Error('所选标签页尚未打开已有对话，请先在网站打开一条普通测试对话。');
  $('conversation').replaceChildren(new Option(tab.title || '当前页面对话', match[1]));
  nextOffset = null;
  $('list-status').textContent = '从所选页面地址取得对话 ID；没有验证列表接口。';
  status('已选择当前页面对话。采集时会重新核验账号和详情 ID。');
});
function displayPending() {
  $('capture-summary').textContent = pending ? JSON.stringify(pending.summary, null, 2) : '尚无采集结果';
}
action('capture', async () => {
  if (pending) throw new Error('已有待保存副本。请先保存并清除暂存，或明确清除后再采集。');
  const result = await runProbe({ kind: 'detail', conversationId: $('conversation').value,
    format: $('detail-format').value, expectedAccountKey: identity.accountKey });
  const archive = await buildArchive({ conversation: result.payload, identity: result.identity, capturedAt: result.capturedAt });
  if (new TextEncoder().encode(JSON.stringify(archive)).byteLength > 10 * 1024 * 1024) throw new Error('归档超过 P0 暂存上限，本次未保存。');
  await setSetting('pendingArchive', archive);
  pending = archive; displayPending(); $('local-status').textContent = '已在扩展中暂存，尚未写入本地目录。';
  status('已取得单次详情响应并暂存。请保存到本地，完整度以归档说明为准。');
});
action('choose-directory', async () => {
  if (!window.showDirectoryPicker) throw new Error('此浏览器环境没有真实目录选择能力，请使用桌面 Chrome / Edge。');
  directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ai-memory-collector-p0' });
  await setSetting('directory', directory);
  $('directory').textContent = directory.name;
  $('local-status').textContent = '已选择目录，尚未在此目录保存本次文件组。';
  status('测试目录已选择。');
});
action('reauthorize', async () => {
  const state = await directory.requestPermission({ mode: 'readwrite' });
  if (state !== 'granted') throw new Error('未获得目录读写权限。');
  status('目录权限已恢复。');
});
action('save-local', async () => {
  const result = await writeArchive(directory, pending);
  // Keep the exact bundle for safe retry; clear explicitly after inspecting the files.
  $('local-status').textContent = `已保存并读回核对：新写入 ${result.written} 个，已有相同内容 ${result.unchanged} 个。`;
  status('本地文件组已保存。请查看目录中的 JSON 与 Markdown；暂存副本可手动清除。');
});
action('discard', async () => {
  if (!window.confirm('清除扩展内的待保存副本？尚未落盘的内容将被移除；已保存的本地文件不受影响。')) { status('已保留暂存副本。'); return; }
  await setSetting('pendingArchive', null); pending = null; displayPending();
  $('local-status').textContent = '已清除本机暂存；没有删除本地文件。'; status('暂存副本已清除。');
});
function githubOptions() {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/.exec($('repository').value.trim());
  if (!match) throw new Error('仓库请填写 用户名/仓库名。');
  const token = $('github-token').value.trim();
  if (!token) throw new Error('请填写仅授权指定私有仓库的 Token。');
  return { owner: match[1], repo: match[2], branch: $('branch').value.trim() || undefined, token };
}
async function githubAction(write) {
  const options = githubOptions();
  status('正在请求 GitHub 站点权限；如出现浏览器授权弹窗，请选择允许。');
  await permissions('https://api.github.com/*');
  status(write ? '正在验证仓库、写入测试文件并读回；请勿重复点击。' : '正在检查 GitHub 仓库连接…');
  const result = await (write ? commitProbe(options) : probeRepository(options));
  $('github-status').textContent = write ?
    `测试结果：${result.status}，读回确认：${result.readbackVerified ? '通过' : '未通过'}。${result.writeVerified ? '本次写入已验证。' : '文件已存在且相同，本次未验证新写入权限。'}` :
    `私有仓库连接成功，分支 ${result.branch}。${result.empty ? '仓库为空，可进行测试写入。' : '尚未执行写入。'}`;
  status(write ? 'GitHub 连接测试完成，没有上传真实对话。' : '仓库只读检查完成。');
  // Remote success must remain visible even if remembering the form values fails.
  try {
    await setSetting('githubTarget', { repository: `${options.owner}/${options.repo}`, branch: options.branch || '' });
  } catch {
    status('GitHub 操作已成功，但本机未能记住仓库设置。下次打开需重新填写。');
  }
}
action('check-github', () => githubAction(false));
action('write-probe', () => githubAction(true));
// One panel per extension origin prevents concurrent writes by this prototype.
if (!navigator.locks) { locked = true; startupStatus('当前环境缺少页面互斥能力，原型暂不可用。', true); }
else {
  navigator.locks.request('ai-memory-collector-p0-panel', { ifAvailable: true }, async lock => {
    if (!lock) { locked = true; startupStatus('另一个采集台正在打开。请关闭此页，使用已有采集台。', true); refreshControls(); return; }
    try {
      [directory, pending] = await Promise.all([getSetting('directory'), getSetting('pendingArchive')]);
      const target = await getSetting('githubTarget');
      if (directory) $('directory').textContent = `${directory.name}（保存前检查权限）`;
      if (target) { $('repository').value = target.repository; $('branch').value = target.branch; }
      displayPending();
      locked = false;
      startupStatus(pending ? '已恢复待保存副本，可重新选择或授权目录后保存。' : '准备就绪，从连接 ChatGPT 开始。');
    } catch { locked = true; startupStatus('无法读取本机暂存，请检查浏览器存储权限。', true); }
    refreshControls();
    await new Promise(() => {});
  }).catch(() => { locked = true; refreshControls(); startupStatus('无法取得采集台锁，请关闭其他采集台后重试。', true); });
}
refreshControls();
