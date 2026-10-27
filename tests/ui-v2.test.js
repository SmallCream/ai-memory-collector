import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { detailFailureMessage, sanitizeDetailFailure } from '../extension/lib/detail-errors.js';
import { assetFailureDiagnosticMessage, assetFailureAttemptSummaries } from '../extension/lib/asset-failure.js';

const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8');
const contentScript = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.value = ''; this.checked = false; this.disabled = false;
    this.hidden = false; this.textContent = ''; this.children = []; this.listeners = new Map(); this.attributes = {};
    const classes = new Set();
    this.classList = { add: value => classes.add(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value), contains: value => classes.has(value) };
  }
  set innerHTML(_) { throw new Error('UI must not render untrusted HTML'); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  remove() { this.removed = true; }
  async click() { if (!this.disabled) await this.listeners.get('click')?.(); }
}
const initialState = () => ({
  config: { setupComplete: true, autoEnabled: true, intervalMinutes: 30, github: { enabled: false, repository: 'example/archive', branch: '', hasToken: false } },
  identity: { accountKey: 'acct-demo', displayName: 'Demo User', platform: 'chatgpt' },
  account: { accountKey: 'acct-demo', alias: 'Demo', initialized: true, enabled: true },
  directory: { name: 'archive', granted: true }, job: null, githubStatus: null, tabId: 11,
});
async function setup(options = {}) {
  let state = structuredClone(options.state || initialState());
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const el = new Element(match[1]); el.hidden = /\bhidden\b/.test(match[2]); el.parentElement = new Element();
    elements.set(match[3], el);
  }
  elements.get('global-status').textContent = '正在读取本机配置…';
  const steps = Array.from({ length: 4 }, () => new Element('li'));
  const windowListeners = new Map();
  const all = [...elements.values()].filter(e => ['button', 'input', 'select'].includes(e.tagName));
  const events = [], messages = [], permissionRequests = [], intervalCallbacks = [], settings = new Map();
  const permissions = new Set(options.origins || []);
  const directory = { name: 'archive', requestPermission: async () => { events.push('directory-permission'); return 'granted'; } };
  settings.set('directory', directory);
  const body = new Element();
  const context = vm.createContext({
    document: { body, hidden: false, getElementById: id => { assert(elements.has(id), `unknown ID ${id}`); return elements.get(id); },
      querySelectorAll: () => all, querySelector: selector => steps[Number(/\d+/.exec(selector)?.[0])],
      createElement: tag => { const element = new Element(tag); options.createdElements?.push(element); return element; }, addEventListener() {} },
    window: { addEventListener: (name, callback) => windowListeners.set(name, callback), dispatchEvent: event => events.push(event.type),
      close: () => events.push('window-close'), showDirectoryPicker: async () => { events.push('directory-picker'); return directory; } },
    location: { href: options.url || 'chrome-extension://test/panel.html' }, URL: options.URL || URL, Blob, Date, Set, Map, Number, String, Array, Boolean, Event,
    setInterval: callback => { intervalCallbacks.push(callback); return 1; }, clearInterval() {},
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    getSetting: async key => settings.get(key), setSetting: async (key, value) => { events.push(`setting:${key}`); settings.set(key, value); },
    detailFailureMessage, sanitizeDetailFailure, assetFailureDiagnosticMessage, assetFailureAttemptSummaries,
    chrome: {
      runtime: { sendMessage: async message => {
        messages.push(structuredClone(message)); events.push(message.type);
        if (options.messageHook) {
          const result = await options.messageHook(message, structuredClone(state));
          if (result !== undefined) return result;
        }
        if (options.messageError && message.type === options.messageError) return { ok: false, error: { code: 'TEST', message: 'simulated failure' } };
        if (message.type === 'collector:bind') state.account = { ...state.account, enabled: true, alias: message.alias };
        if (message.type === 'collector:configure') state.config = { ...state.config, ...message };
        if (message.type === 'collector:github-config') state.config.github = { ...state.config.github, ...message, hasToken: Boolean(message.token || state.config.github.hasToken) };
        if (message.type === 'collector:directory-changed') state.directory = { name: directory.name, granted: true };
        return { ok: true, state: structuredClone(state) };
      } },
      permissions: {
        contains: async request => request.origins.every(origin => permissions.has(origin)),
        request: async request => {
          events.push(`permission:${request.origins[0]}`); permissionRequests.push([...request.origins]);
          if (options.grant === false) return false;
          request.origins.forEach(origin => permissions.add(origin)); return true;
        },
      },
      tabs: { create: async () => ({ id: 11 }) },
    },
  });
  const run = script.replace(/^import .*;\n/gm, '');
  await vm.runInContext(`(async()=>{${run}\n})()`, context);
  return { elements, messages, events, permissionRequests, state: () => state, setState: value => { state = value; }, context,
    focus: () => windowListeners.get('focus')(), click: id => elements.get(id).click(), poll: () => intervalCallbacks[0]() };
}

test('current account identity is plain text and initialized home has incremental and full actions', async () => {
  const state = initialState(); state.identity.displayName = '<img onerror=alert(1)>'; state.account.alias = '<script>unsafe</script>';
  const app = await setup({ state });
  assert.equal(app.elements.get('account-name').textContent, '<script>unsafe</script>');
  assert.equal(app.elements.get('home').hidden, false);
  assert.equal(app.elements.get('full-capture').hidden, false);
  await app.click('start-capture');
  await app.click('full-capture');
  assert.equal(app.messages.filter(x => x.type === 'collector:start').length, 1);
  await app.click('confirm-full-capture');
  assert.deepEqual(app.messages.filter(x => x.type === 'collector:start').map(x => x.mode), ['incremental', 'full']);
  assert.equal(app.messages.find(x => x.type === 'collector:start' && x.mode === 'full').expectedAccountKey, 'acct-demo');
});

test('unbound account cannot capture and bind targets observed account via background', async () => {
  const state = initialState(); state.account = null;
  const app = await setup({ state });
  assert.equal(app.elements.get('start-capture').disabled, true);
  assert.equal(app.elements.get('bind-account').hidden, false);
  app.elements.get('new-account-alias').value = 'My account';
  await app.click('bind-account');
  assert.equal(app.messages.find(x => x.type === 'collector:bind').alias, 'My account');
  assert.equal(app.elements.get('start-capture').disabled, false);
});

test('initial setup requires account bind and directory grant before final initialization', async () => {
  const state = initialState(); state.config.setupComplete = false; state.account = null; state.directory = { granted: false };
  const app = await setup({ state, url: 'chrome-extension://test/panel.html?setup=1&tab=22' });
  assert.equal(app.elements.get('wizard').hidden, false);
  await app.click('wizard-bind');
  assert.equal(app.elements.get('wizard-step-1').hidden, false);
  assert.equal(app.elements.get('wizard-next-1').disabled, true);
  const before = app.events.length;
  await app.click('wizard-choose-directory');
  assert.equal(app.events[before], 'directory-picker');
  assert.equal(app.elements.get('wizard-next-1').disabled, false);
  await app.click('wizard-next-1');
  assert.equal(app.elements.get('wizard-next-2').disabled, true);
  await app.click('wizard-skip-github');
  assert.equal(app.elements.get('wizard-step-3').hidden, false);
  await app.click('wizard-finish');
  assert.equal(app.messages.filter(x => x.type === 'collector:start').at(-1).mode, 'initial');
  assert.equal(app.messages.filter(x => x.type === 'collector:start').at(-1).tabId, 22);
});

test('GitHub grant denial cannot persist a token or enable sync', async () => {
  const app = await setup({ grant: false });
  await app.click('open-settings');
  app.elements.get('github-enabled').checked = true;
  app.elements.get('repository').value = 'example/data';
  app.elements.get('github-token').value = 'synthetic-secret';
  await app.click('save-github');
  assert(!app.messages.some(x => x.type === 'collector:github-config'));
  assert.match(app.elements.get('global-status').textContent, /未获得 GitHub/);
});

test('GitHub credentials are cleared from form after successful save and never echoed', async () => {
  const app = await setup(); await app.click('open-settings');
  app.elements.get('github-enabled').checked = true;
  app.elements.get('repository').value = 'example/data';
  app.elements.get('github-token').value = 'synthetic-secret';
  await app.click('save-github');
  assert.equal(app.elements.get('github-token').value, '');
  assert(app.messages.some(x => x.type === 'collector:github-test'));
  assert(!app.elements.get('global-status').textContent.includes('synthetic-secret'));
});

test('running tasks expose pause and prevent duplicate incremental or full controls', async () => {
  const state = initialState(); state.job = { status: 'running', mode: 'full', phase: 'details', discovered: 20, processed: 3 };
  const app = await setup({ state });
  assert.equal(app.elements.get('start-capture').hidden, true); assert.equal(app.elements.get('full-capture').hidden, true);
  assert.equal(app.elements.get('pause-capture').hidden, false);
  assert.equal(app.elements.get('job-count').textContent, '3 / 20');
  await app.click('pause-capture'); assert(app.messages.some(x => x.type === 'collector:pause'));
});

test('stop is available during identity checking and missing directory permission, with explicit account ownership', async () => {
  const state = initialState(); state.job = { status: 'running' }; state.identityChecking = true;
  state.directory.granted = false;
  const app = await setup({ state });
  assert.equal(app.elements.get('stop-capture').hidden, false);
  assert.equal(app.elements.get('stop-capture').disabled, false);
  await app.click('stop-capture');
  assert.ok(app.messages.some(value => value.type === 'collector:stop' && value.accountKey === state.account.accountKey));
});

test('stopped jobs offer a new scan instead of resuming the old queue or promising scheduled restart', async () => {
  const state = initialState(); state.job = { status: 'stopped', nextRetryAt: Date.now() + 60000 };
  const app = await setup({ state });
  assert.equal(app.elements.get('resume-capture').hidden, true);
  assert.equal(app.elements.get('stop-capture').hidden, true);
  assert.equal(app.elements.get('start-capture').hidden, false);
  assert.match(app.elements.get('home-heading').textContent, /已停止/);
  assert.match(app.elements.get('schedule-status').textContent, /重新开始/);
  assert.equal(app.elements.get('collection-details-status').textContent, '已停止');
  assert.doesNotMatch(app.elements.get('collection-wait').textContent, /等待重试/);
  await app.click('start-capture');
  assert.ok(app.messages.some(value => value.type === 'collector:start' && value.mode === 'incremental'));
});

test('settings poll updates status without erasing in-progress input', async () => {
  const app = await setup(); await app.click('open-settings');
  app.elements.get('repository').value = 'editing/new-value';
  app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('repository').value, 'editing/new-value');
});

test('collapsed content entry only exists on ChatGPT and contains no credential access', () => {
  vm.runInNewContext(contentScript, { location: { origin: 'https://example.com' } });
  assert(!/getSetting|api\.github|accessToken|cookie\s*=|fetch\(/.test(contentScript));
  assert.match(contentScript, /collector:open-panel/);
  assert.match(contentScript, /collector:content-state/);
});

test('partial initialization exposes retry without claiming initialization completed', async () => {
  const state = initialState(); state.account.initialized = false;
  state.job = { status: 'partial', mode: 'initial', phase: 'done', discovered: 12, processed: 12, added: 10, updated: 0, unchanged: 0, failed: 2, initializedComplete: false };
  const app = await setup({ state });
  assert.equal(app.elements.get('home-heading').textContent, '部分采集已完成');
  assert.equal(app.elements.get('resume-capture').hidden, false);
  assert.equal(app.elements.get('resume-capture').textContent, '重试未完成项');
  assert.equal(app.elements.get('start-capture').hidden, true);
  assert.equal(app.elements.get('count-failed').textContent, '2');
  await app.click('resume-capture');
  assert(app.messages.some(message => message.type === 'collector:resume'));
});

test('GitHub idle is not success and conflict copies are visible with pending retry', async () => {
  const state = initialState(); state.config.github.enabled = true; state.githubStatus = { status: 'idle' };
  const app = await setup({ state });
  assert.equal(app.elements.get('github-state').textContent, '等待首次同步');
  state.githubStatus = { status: 'conflicts', conflicts: 2, pending: 1, message: '不同版本已保留到冲突副本，原文没有丢弃。' };
  app.setState(state); app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('github-state').textContent, '已保留冲突副本');
  assert.equal(app.elements.get('github-detail').hidden, false);
  assert.equal(app.elements.get('retry-github').hidden, false);
  assert.match(app.elements.get('github-detail').textContent, /原文没有丢弃/);
});

test('top GitHub detail exposes persisted failure code instead of stale LFS progress and clears on retry', async () => {
  const state = initialState(); state.config.github.enabled = true;
  state.githubStatus = { status: 'pending', pending: 1, message: '附件正在分批上传，完成后自动提交对话。',
    error: { code: 'GITHUB_NETWORK', message: '请求失败 https://example.com/private?signature=secret ghp_hidden123 Bearer hidden456 <b>plain text</b>' } };
  const app = await setup({ state }), detail = app.elements.get('github-detail');
  assert.equal(detail.hidden, false); assert.equal(detail.classList.contains('warning-text'), true);
  assert.match(detail.textContent, /同步未完成（GITHUB_NETWORK）/);
  assert.doesNotMatch(detail.textContent, /分批上传|example\.com|signature=secret|ghp_hidden123|hidden456/);
  assert.match(detail.textContent, /<b>plain text<\/b>/);
  assert.equal(app.elements.get('retry-github').hidden, false);

  state.githubStatus = { status: 'syncing', pending: 1, error: null, message: '' };
  app.setState(state); app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('github-state').textContent, '同步中');
  assert.equal(detail.hidden, false); assert.equal(detail.classList.contains('warning-text'), false);

  state.githubStatus = { status: 'pending', pending: 1, error: { code: 'Bearer unsafe', message: '' } };
  app.setState(state); app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.match(detail.textContent, /GITHUB_ERROR/); assert.doesNotMatch(detail.textContent, /unsafe/);
});

test('login error remains visible inside settings and a missing site grant can be recovered', async () => {
  const state = initialState(); state.identity = null; state.account = null;
  state.error = { code: 'HTTP_401', message: '登录已失效，请在网站重新登录。' };
  const app = await setup({ state }); await app.click('open-settings');
  assert.equal(app.elements.get('context-error').hidden, false);
  assert.match(app.elements.get('context-error').textContent, /登录已失效/);
  state.error = { code: 'SITE_PERMISSION_REQUIRED', message: '请授权访问 ChatGPT。' };
  app.setState(state); await app.click('back-home');
  assert.equal(app.elements.get('home-grant').hidden, false);
  await app.click('home-grant');
  assert(app.events.includes('permission:https://chatgpt.com/*'));
});

test('clearing Token uses an explicit empty field while normal save omits an unchanged Token', async () => {
  const state = initialState(); state.config.github.hasToken = true;
  const app = await setup({ state }); await app.click('open-settings');
  await app.click('save-github');
  const saved = app.messages.filter(message => message.type === 'collector:github-config').at(-1);
  assert.equal(Object.hasOwn(saved, 'token'), false);
  await app.click('forget-token');
  const cleared = app.messages.filter(message => message.type === 'collector:github-config').at(-1);
  assert.equal(cleared.token, ''); assert.equal(cleared.enabled, false);
});


test('startup success clears its loading message while polling preserves action errors', async () => {
  const app = await setup({ grant: false });
  assert.equal(app.elements.get('global-status').textContent, '');
  await app.click('open-settings');
  app.elements.get('github-enabled').checked = true;
  app.elements.get('github-token').value = 'synthetic-secret';
  await app.click('save-github');
  const error = app.elements.get('global-status').textContent;
  assert.match(error, /未获得 GitHub/);
  app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('global-status').textContent, error);
});

test('a new device can restore without ChatGPT identity, completed setup or automatic uploading', async () => {
  const state = initialState(); state.identity = null; state.account = null;
  state.config.setupComplete = false; state.config.github.hasToken = true;
  state.error = { code: 'SOURCE_UNAVAILABLE', message: '未打开 ChatGPT。' };
  const app = await setup({ state, url: 'chrome-extension://test/panel.html?setup=1' });
  await app.click('wizard-open-restore');
  assert.equal(app.elements.get('wizard').hidden, true);
  assert.equal(app.elements.get('settings').hidden, false);
  assert.equal(app.elements.get('restore-github').disabled, false);
  const before = app.events.length;
  await app.click('restore-github');
  assert.equal(app.events[before], 'permission:https://api.github.com/*');
  assert(app.messages.some(message => message.type === 'collector:restore'));
  assert(!app.messages.some(message => ['collector:bind', 'collector:configure', 'collector:start'].includes(message.type)));
  assert.equal(app.permissionRequests[0].includes('https://*/*'), false);
  assert.deepEqual(app.permissionRequests[0], ['https://api.github.com/*']);
  await app.click('back-home'); assert.equal(app.elements.get('wizard').hidden, false);
});

test('restore permission denial does not start a job and an incomplete restore exposes retry', async () => {
  const state = initialState(); state.identity = null; state.account = null; state.config.github.hasToken = true;
  state.restoreStatus = { status: 'partial', progress: { total: 12, completed: 10, failed: 2 } };
  const denied = await setup({ state, grant: false }); await denied.click('open-restore');
  assert.equal(denied.elements.get('restore-retry').hidden, false);
  assert.equal(denied.elements.get('restore-count').textContent, '10 / 12');
  await denied.click('restore-retry');
  assert(!denied.messages.some(message => message.type === 'collector:restore-retry'));
  assert.match(denied.elements.get('global-status').textContent, /未获得 GitHub/);
  const allowed = await setup({ state }); await allowed.click('open-restore'); await allowed.click('restore-retry');
  assert(allowed.messages.some(message => message.type === 'collector:restore-retry'));
});

test('restoring requires saved credentials and a granted destination; in-progress restore cannot start twice', async () => {
  const state = initialState(); state.config.github.hasToken = true; state.directory.granted = false;
  const app = await setup({ state }); await app.click('open-restore');
  assert.equal(app.elements.get('restore-github').disabled, true);
  state.directory.granted = true; state.restoreStatus = { status: 'running', total: 10, processed: 2 };
  app.setState(state); app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('restore-github').disabled, true);
  assert.equal(app.elements.get('restore-count').textContent, '2 / 10');
});

test('restore shows cloud-only attachment gaps separately from transfer failures and clears them when filled', async () => {
  const state = initialState(); state.config.github.hasToken = true;
  state.restoreStatus = { status: 'partial', total: 3, processed: 3, pending: 0, failed: 0,
    cloudMissing: 4, missingCloudConversations: 2 };
  const app = await setup({ state }); await app.click('open-restore');
  assert.equal(app.elements.get('restore-phase').textContent, '部分恢复完成');
  assert.equal(app.elements.get('restore-count').textContent, '3 / 3');
  assert.equal(app.elements.get('restore-retry').hidden, false);
  for (const id of ['restore-detail', 'transfer-restore-detail']) {
    const detail = app.elements.get(id).textContent;
    assert.match(detail, /本地缺少 4 个附件（涉及 2 条对话）/);
    assert.match(detail, /原电脑复制本地附件目录.*原始对话补采/);
    assert.match(detail, /GitHub 仅恢复对话文件/);
  }
  assert.match(app.elements.get('transfer-restore-detail').textContent, /失败 0/);
  assert.doesNotMatch(app.elements.get('restore-detail').textContent, /4 项未完成/);
  state.restoreStatus = { status: 'completed', total: 3, processed: 3, pending: 0, failed: 0,
    cloudMissing: 0, missingCloudConversations: 0 };
  app.setState(state); await app.poll();
  assert.equal(app.elements.get('restore-phase').textContent, '恢复完成');
  assert.equal(app.elements.get('restore-retry').hidden, true);
  assert.equal(app.elements.get('restore-detail').textContent, '');
  assert.doesNotMatch(app.elements.get('transfer-restore-detail').textContent, /本地缺少/);
});

test('restore retains network error guidance alongside cloud gaps and never labels known gaps complete', async () => {
  const state = initialState();
  state.restoreStatus = { status: 'completed', total: 2, processed: 1, failed: 1, pending: 0,
    cloudMissing: 3, missingCloudConversations: 1,
    error: { code: 'GITHUB_NETWORK', message: '请检查网络后重试。' } };
  const app = await setup({ state });
  assert.equal(app.elements.get('restore-phase').textContent, '部分恢复完成');
  assert.match(app.elements.get('restore-detail').textContent, /请检查网络后重试。.*本地缺少 3 个附件/);
  assert.match(app.elements.get('transfer-restore-detail').textContent, /失败 1.*GITHUB_NETWORK.*本地缺少 3 个附件/);
});

test('restore cloud gap counts reject invalid metadata and support nested progress', async () => {
  const state = initialState();
  state.restoreStatus = { status: 'completed', cloudMissing: -1, missingCloudConversations: '<b>bad</b>' };
  const app = await setup({ state });
  assert.equal(app.elements.get('restore-phase').textContent, '恢复完成');
  assert.doesNotMatch(app.elements.get('restore-detail').textContent, /本地缺少|bad/);
  state.restoreStatus = { status: 'running', progress: { total: 2, completed: 1, failed: 0,
    cloudMissing: 2, missingCloudConversations: 1 } };
  app.setState(state); await app.poll();
  assert.equal(app.elements.get('restore-phase').textContent, '正在恢复对话');
  assert.equal(app.elements.get('restore-retry').hidden, true);
  assert.match(app.elements.get('restore-detail').textContent, /收起面板不会主动暂停恢复。.*本地缺少 2 个附件（涉及 1 条对话）/);
});

test('legacy LFS option is dropped on save and restoring-only configuration is verified without enabling uploads', async () => {
  const state = initialState(); state.config.github.hasToken = true;
  state.config.github.lfsEnabled = true; state.config.github.autoRestore = true;
  const app = await setup({ state }); await app.click('open-settings'); await app.click('save-github');
  const message = app.messages.find(item => item.type === 'collector:github-config');
  assert.equal(message.enabled, false); assert.equal(message.lfsEnabled, undefined);
  assert.equal(message.autoRestore, true);
  assert(app.messages.some(item => item.type === 'collector:github-test'));
  assert.deepEqual(app.permissionRequests[0], ['https://api.github.com/*']);
  assert.equal(app.permissionRequests.flat().includes('https://*/*'), false);
});

test('broad HTTPS access is requested only by the optional external-image action', async () => {
  const app = await setup(); await app.click('open-settings');
  assert.deepEqual(app.permissionRequests, []);
  await app.click('grant-external-images');
  assert.deepEqual(app.permissionRequests, [['https://*/*']]);
  assert.equal(app.elements.get('grant-external-images').disabled, true);
  assert.match(app.elements.get('external-images-status').textContent, /已允许匿名检测/);
});

test('asset summary ignores obsolete cloud binary counters', async () => {
  const state = initialState(); state.assetStatus = { local: 5, uploaded: 3, pendingUpload: 2, pendingCapture: 1, failed: 1 };
  state.config.github.enabled = true; state.config.github.lfsEnabled = true;
  const app = await setup({ state });
  assert.equal(app.elements.get('asset-summary').hidden, false);
  assert.match(app.elements.get('asset-summary-text').textContent, /本地附件 5.*待采集 1（其中失败 1）/);
});

test('image failures are a subset of pending tasks and use queue diagnostics over stale counts', async () => {
  const state = initialState(); state.assetStatus = { pendingCapture: 1, failed: 0 };
  state.assetDiagnostics = { total: 30, pending: 30, failed: 30, failures: [
    { conversationId: 'chat-a', assetId: 'image-a', conversationTitle: '旅行计划', fileName: '地图.png', code: 'ASSET_PENDING', attempt: 2, retryAt: 0 },
  ] };
  const app = await setup({ state });
  assert.equal(app.elements.get('asset-summary-text').textContent, '待处理 30（其中失败 30）');
  assert.equal(app.elements.get('asset-failures').hidden, false);
  assert.equal(app.elements.get('asset-failures-heading').textContent, '查看失败原因（30）');
  const item = app.elements.get('asset-failure-list').children[0];
  assert.equal(item.children[0].textContent, '旅行计划');
  assert.equal(item.children[1].textContent, '地图.png');
  assert.match(item.children[2].textContent, /尚未取得可确认归属的原始附件/);
  assert.equal(item.children[3].textContent, 'ASSET_PENDING · 已尝试 2 次');
});

test('image diagnostics do not render raw server messages, signed URLs, credentials, or HTML', async () => {
  const state = initialState();
  state.assetDiagnostics = { total: 1, pending: 1, failed: 1, failures: [
    { conversationTitle: '<img onerror=alert(1)>', fileName: 'https://example.com/image?token=sensitive ghp_privateToken',
      code: 'UNKNOWN_ERROR', message: 'Bearer private-bearer https://example.com/image?sig=private-sig', attempt: 1 },
  ] };
  const app = await setup({ state });
  const parts = app.elements.get('asset-failure-list').children[0].children.map(child => child.textContent);
  assert.equal(parts[0], '<img onerror=alert(1)>');
  assert.equal(parts[1], '[链接已隐藏] [已隐藏]');
  assert.match(parts[2], /根据错误代码继续排查/);
  assert(!parts.join(' ').match(/private|sensitive|https:\/\//));
});

test('attachment failures show recognized format reasons without exposing arbitrary or mismatched diagnostic text', async () => {
  const state = initialState();
  state.assetDiagnostics = { total: 4, pending: 4, failed: 4, failures: [
    { code: 'ASSET_FORMAT', reason: 'format_html_response', message: 'unsafe response body https://example.com/?secret=1' },
    { code: 'ASSET_FORMAT', reason: 'format_unknown', message: 'unsafe arbitrary explanation' },
    { code: 'ASSET_INPUT', reason: 'format_html_response', message: 'unsafe mismatched explanation' },
    { code: 'ASSET_FORMAT', message: 'unsafe old response body' },
  ] };
  const app = await setup({ state });
  const explanations = app.elements.get('asset-failure-list').children.map(item => item.children[2].textContent);
  assert.equal(explanations[0], assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason: 'format_html_response' }));
  assert.ok(explanations[0]);
  assert.match(explanations[1], /未取得受支持的完整附件/);
  assert.match(explanations[2], /根据错误代码继续排查/);
  assert.equal(explanations[3], explanations[1]);
  assert.doesNotMatch(explanations.join(' '), /unsafe|https:\/\/|secret=1/);
});

test('attachment failures identify unnamed files using platform IDs or a short asset ID', async () => {
  const state = initialState(), assetId = 'a1'.repeat(32);
  const values = [
    { fileName: '原图.png', fileId: 'file_imageA', libraryFileId: 'libfile_imageA', assetId },
    { fileName: '', fileId: 'file_imageA', libraryFileId: 'libfile_imageA', assetId },
    { fileId: 'https://example.com/?token=private', libraryFileId: 'libfile_imageA', assetId },
    { fileId: '<script>private</script>', libraryFileId: 'Bearer private', assetId },
    { fileId: 'private file', libraryFileId: 'private library', assetId: 'https://example.com/private' },
  ];
  state.assetDiagnostics = { total: values.length, pending: values.length, failed: values.length,
    failures: values.map(value => ({ ...value, code: 'ASSET_FORMAT', attempt: 3 })) };
  const app = await setup({ state });
  const filenames = app.elements.get('asset-failure-list').children.map(item => item.children[1].textContent);
  assert.deepEqual(filenames, ['原图.png', 'file_imageA', 'libfile_imageA', '附件 a1a1a1a1a1a1', '未命名附件']);
  assert.doesNotMatch(filenames.join(' '), /private|https:|Bearer|script/);
});

test('attachment failure UI shows five safe response observations and preserves legacy rows', async () => {
  const secret = 'https://example.com/?token=private-token Bearer private-token <script>private-body</script>';
  const state = initialState();
  const responseDiagnostics = [
    { route: 'captured-resource', code: 'ASSET_FORMAT', httpStatus: 200, mimeType: 'image/jpeg', detectedType: 'png', byteLength: 68,
      url: secret, headers: { Authorization: secret }, message: secret, body: secret },
    { route: 'library-download', code: 'HTTP_403', httpStatus: 403, mimeType: 'text/html', detectedType: 'not-read' },
    { route: 'file-download', code: 'ASSET_FORMAT', httpStatus: 200, mimeType: secret, detectedType: 'unknown', byteLength: 8 },
    { route: 'visible-image', code: secret, httpStatus: -1, mimeType: 'missing', detectedType: secret, byteLength: '32', reason: secret },
    { route: 'visible-image', code: 'ASSET_FORMAT', mimeType: 'image/avif', detectedType: 'avif', byteLength: 512 },
    { route: 'interpreter-download', code: 'ASSET_NETWORK', httpStatus: 599, byteLength: 999 },
  ];
  state.assetDiagnostics = { total: 2, pending: 2, failed: 2, failures: [
    { fileId: 'file_imageA', code: 'ASSET_FORMAT', reason: 'format_image_mime_mismatch', attempt: 3, responseDiagnostics },
    { fileId: 'file_imageB', code: 'ASSET_FORMAT', reason: 'format_image_unconfirmed', attempt: 21 },
  ] };
  const app = await setup({ state });
  const [modern, legacy] = app.elements.get('asset-failure-list').children;
  assert.equal(modern.children.length, 9);
  assert.match(modern.children[2].textContent, /已识别图片文件头.*声明的类型/);
  assert.equal(modern.children[4].textContent, '对话资源 · HTTP 200 · ASSET_FORMAT · 声明：image/jpeg · 文件头：PNG · 68 字节');
  assert.match(modern.children[5].textContent, /文件库入口.*HTTP 403.*声明：text\/html.*未读取/);
  assert.match(modern.children[6].textContent, /文件下载入口.*声明：其他类型.*文件头：未知.*8 字节/);
  assert.equal(modern.children[7].textContent, '页面原图 · 声明：未声明');
  assert.match(modern.children[8].textContent, /页面原图.*声明：image\/avif.*文件头：AVIF.*512 字节/);
  const shown = modern.children.map(child => child.textContent).join('\n');
  assert.doesNotMatch(shown, /private|https:|Bearer|script|Authorization|生成文件入口|HTTP 599|999 字节/);
  assert.equal(legacy.children.length, 4);
  assert.match(legacy.children[2].textContent, /图片文件头无法识别，或响应类型/);
  assert.equal(legacy.children[3].textContent, 'ASSET_FORMAT · 已尝试 21 次');
  assert.equal(app.permissionRequests.length, 0);
});

test('image retry works while conversation scan is paused without sending a capture or resume command', async () => {
  const state = initialState(); state.job = { status: 'paused' };
  state.assetDiagnostics = { total: 1, pending: 1, failed: 1, failures: [] };
  const app = await setup({ state, url: 'chrome-extension://test/panel.html?tab=22' });
  assert.equal(app.elements.get('retry-images').hidden, false);
  assert.equal(app.elements.get('retry-images').disabled, false);
  await app.click('retry-images');
  assert.deepEqual(app.messages.filter(message => message.type === 'collector:retry-images'), [{ type: 'collector:retry-images', tabId: 22 }]);
  assert(!app.messages.some(message => ['collector:start', 'collector:resume'].includes(message.type)));
  assert.equal(app.permissionRequests.length, 0);
  assert.match(html, /逐项重试失败附件，不会重新扫描对话列表。对话采集暂停时，每项只尝试一次。/);
});

test('image retry cannot run without a matching enabled account, writable directory and source tab', async () => {
  const variations = [
    state => { state.account.enabled = false; },
    state => { state.account = null; },
    state => { state.identity = null; },
    state => { state.identity.accountKey = 'another-account'; },
    state => { state.directory.granted = false; },
    state => { state.tabId = null; },
  ];
  for (const change of variations) {
    const state = initialState(); state.assetDiagnostics = { total: 1, pending: 1, failed: 1, failures: [] }; change(state);
    const app = await setup({ state });
    assert.equal(app.elements.get('retry-images').disabled, true);
    await app.click('retry-images');
    assert(!app.messages.some(message => message.type === 'collector:retry-images'));
  }
});

test('image diagnostic details and retry action disappear after failures clear', async () => {
  const state = initialState();
  state.assetDiagnostics = { total: 1, pending: 1, failed: 1, failures: [{ code: 'HTTP_404', attempt: 1 }] };
  const app = await setup({ state });
  state.assetDiagnostics = { total: 0, pending: 0, failed: 0, failures: [] };
  app.setState(state); app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('asset-failures').hidden, true);
  assert.equal(app.elements.get('asset-failure-list').children.length, 0);
  assert.equal(app.elements.get('asset-failures-limit').hidden, true);
  assert.equal(app.elements.get('retry-images').hidden, true);
  assert.equal(app.elements.get('image-retry-note').hidden, true);
});

test('source refresh failures explain missing images and incomplete details safely', async () => {
  const state = initialState();
  state.assetDiagnostics = { total: 2, pending: 2, failed: 2, failures: [
    { code: 'ASSET_SOURCE_MISSING', message: 'https://example.com/?token=private', attempt: 1 },
    { code: 'INCOMPLETE_DETAIL', message: 'Bearer private-token', attempt: 1 },
  ] };
  const app = await setup({ state });
  const items = app.elements.get('asset-failure-list').children;
  assert.match(items[0].children[2].textContent, /最新对话中未找到此附件/);
  assert.match(items[1].children[2].textContent, /对话详情不完整，未覆盖已保存数据/);
  assert(!items.map(item => item.children[2].textContent).join('').includes('private'));
  assert.equal(app.elements.get('asset-failures-limit').hidden, true);
});

test('capped image diagnostics show that only the first 200 failures are listed', async () => {
  const state = initialState();
  state.assetDiagnostics = { total: 250, pending: 250, failed: 250,
    failures: Array.from({ length: 200 }, () => ({ code: 'ASSET_PENDING', attempt: 1 })) };
  const app = await setup({ state });
  assert.equal(app.elements.get('asset-failure-list').children.length, 200);
  assert.equal(app.elements.get('asset-failures-limit').hidden, false);
  assert.equal(app.elements.get('asset-failures-limit').textContent, '仅显示前 200 条失败记录，其余任务仍会保留。');
  assert.equal(app.elements.get('asset-summary-text').textContent, '待处理 250（其中失败 250）');
});

test('internal viewer attachments remain visibly undownloaded outside ordinary failure counts', async () => {
  const state = initialState();
  state.assetStatus = { local: 12, uploaded: 4, pendingUpload: 8, failed: 1, pendingCapture: 1 };
  state.assetDiagnostics = { total: 1, pending: 0, failed: 0, failures: [], internalMissing: 1, internalFailures: [
    { conversationTitle: '看图对话', fileName: 'internal-image.png', messageId: 'tool-message', fileId: 'file_demo', code: 'HTTP_404', attempt: 6, retryAt: Date.now() },
  ] };
  const app = await setup({ state });
  assert.equal(app.elements.get('asset-summary-text').textContent, '本地附件 12 · 内部附件未下载 1');
  assert.equal(app.elements.get('asset-failures').hidden, true);
  assert.equal(app.elements.get('retry-images').hidden, true);
  assert.equal(app.elements.get('asset-internal').hidden, false);
  assert.equal(app.elements.get('asset-internal-heading').textContent, '内部附件未下载（1）');
  const parts = app.elements.get('asset-internal-list').children[0].children.map(child => child.textContent);
  assert.deepEqual(parts.slice(0, 2), ['看图对话', 'internal-image.png']);
  assert.match(parts[2], /container.open_image.*尚未取得原始图片/);
  assert.equal(parts[3], 'HTTP_404 · 已尝试 6 次 · 已停止自动重试');
  assert.equal(parts[4], '消息：tool-message · 文件：file_demo');
  assert(!parts.join('').includes('重试等待至'));
  assert.match(html, /已停止自动重试；来源记录已保留/);
});

test('internal retry is an explicit account-scoped image action independent of normal failures', async () => {
  const state = initialState(); state.job = { status: 'paused' };
  state.assetDiagnostics = { total: 2, pending: 1, failed: 1, failures: [], internalMissing: 1, internalFailures: [] };
  const app = await setup({ state, url: 'chrome-extension://test/panel.html?tab=22' });
  assert.equal(app.elements.get('retry-internal-images').disabled, false);
  await app.click('retry-images'); await app.click('retry-internal-images');
  assert.deepEqual(app.messages.filter(message => message.type === 'collector:retry-images'), [
    { type: 'collector:retry-images', tabId: 22 },
    { type: 'collector:retry-images', tabId: 22, includeInternal: true },
  ]);
  assert(!app.messages.some(message => ['collector:start', 'collector:resume'].includes(message.type)));
});

test('internal retry requires matching enabled account, directory access and source tab', async () => {
  for (const change of [
    state => { state.account.enabled = false; }, state => { state.account = null; },
    state => { state.identity = null; }, state => { state.identity.accountKey = 'other'; },
    state => { state.directory.granted = false; }, state => { state.tabId = null; },
  ]) {
    const state = initialState(); state.assetDiagnostics = { internalMissing: 1, internalFailures: [] }; change(state);
    const app = await setup({ state });
    assert.equal(app.elements.get('retry-internal-images').disabled, true);
    await app.click('retry-internal-images');
    assert(!app.messages.some(message => message.type === 'collector:retry-images'));
  }
});

test('internal attachment diagnostics sanitize source labels and clear after successful retry', async () => {
  const state = initialState();
  state.assetDiagnostics = { internalMissing: 250, internalFailures: [
    { conversationTitle: '<script>unsafe</script>', fileName: 'https://example.com/?sig=private',
      messageId: 'Bearer private', fileId: 'ghp_private', message: 'raw private response', code: 'HTTP_404', attempt: 1 },
  ] };
  const app = await setup({ state });
  const parts = app.elements.get('asset-internal-list').children[0].children.map(child => child.textContent);
  assert.equal(parts[0], '<script>unsafe</script>');
  assert(!parts.join('').includes('private'));
  assert.equal(app.elements.get('asset-internal-limit').hidden, false);
  assert.equal(app.elements.get('asset-internal-limit').textContent, '仅显示前 1 条记录，其余来源记录仍会保留。');
  state.assetDiagnostics = { pending: 0, failed: 0, failures: [], internalMissing: 0, internalFailures: [] };
  app.setState(state); app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('asset-internal').hidden, true);
  assert.equal(app.elements.get('asset-internal-list').children.length, 0);
  assert.equal(app.elements.get('retry-internal-images').disabled, true);
});


function visibleText(element) { return [element.textContent, ...element.children.map(visibleText)].join(' '); }
function logItem(extra = {}) {
  return { stage: 'detail', title: '项目讨论', conversationId: 'synthetic-conversation', status: 'running',
    startedAt: Date.now() - 120_000, updatedAt: Date.now() - 120_000, ...extra };
}

test('collection details show real current work, retry queue and recent steps while preserving expansion', async () => {
  const state = initialState();
  state.job = { status: 'running', phase: 'details', discovered: 5, processed: 2, pages: 1,
    diagnostics: { total: 5, remaining: 3, saved: 2, skipped: 0, failed: 0, retrying: 1,
      items: [{ conversationId: 'synthetic-next', title: '下一段对话', status: 'retry', attempt: 2, code: 'HTTP_429', nextRetryAt: Date.now() + 60_000 }] } };
  state.activity = { collection: { current: logItem(), recent: [logItem({ status: 'success', stage: 'save', finishedAt: Date.now() - 60_000 })] } };
  const app = await setup({ state });
  assert.equal(app.elements.get('collection-details').hidden, false);
  assert.match(visibleText(app.elements.get('collection-current')), /读取对话详情 · 项目讨论/);
  assert.match(visibleText(app.elements.get('collection-current')), /暂未收到新进展，可能仍在等待响应/);
  assert.match(visibleText(app.elements.get('collection-queue')), /下一段对话 · 等待重试/);
  assert.match(visibleText(app.elements.get('collection-queue')), /HTTP_429/);
  assert.match(app.elements.get('collection-detail-counts').textContent, /失败／重试 1 条/);
  assert.match(visibleText(app.elements.get('collection-recent')), /保存对话文件 · 本步骤完成/);
  app.elements.get('collection-details').open = true;
  app.elements.get('collection-queue').scrollTop = 72;
  await app.poll();
  assert.equal(app.elements.get('collection-details').open, true);
  assert.equal(app.elements.get('collection-queue').scrollTop, 72);
});

test('message progress distinguishes downloaded pages from locally reused history', async () => {
  const state = initialState();
  state.job = { status: 'running', phase: 'details', messageProgress: {
    mode: 'tail-merge', pagesRead: 1, fetchedMessages: 5, reusedMessages: 100, addedMessages: 2, updatedMessages: 0,
  } };
  const app = await setup({ state });
  assert.equal(app.elements.get('collection-message-progress').hidden, false);
  assert.match(app.elements.get('collection-message-progress').textContent, /尾部增量（较早历史未重新核对）/);
  assert.match(app.elements.get('collection-message-progress').textContent, /接收 5 条消息 · 复用 100 条历史消息/);
  state.job.messageProgress = null; app.setState(state); await app.poll();
  assert.equal(app.elements.get('collection-message-progress').hidden, true);
});

test('collection failures show a whitelisted reason and conversation ID across queue, current and recent steps', async () => {
  const state = initialState();
  const failure = { title: '同名对话', conversationId: 'synthetic-failed-id', status: 'failed',
    code: 'INCOMPLETE_DETAIL', reason: 'TREE_MISSING_CHILD' };
  state.job = { status: 'partial', diagnostics: { total: 1, items: [failure] } };
  state.activity = { collection: { current: logItem(failure), recent: [logItem(failure)] } };
  const app = await setup({ state });
  for (const id of ['collection-queue', 'collection-current', 'collection-recent']) {
    const text = visibleText(app.elements.get(id));
    assert.ok(text.includes(`原因：${detailFailureMessage(failure)}（TREE_MISSING_CHILD）`));
    assert.match(text, /对话 ID：synthetic-failed-id/);
  }
});

test('unknown diagnostic reasons are not rendered and older incomplete records ask for a new observation', async () => {
  for (const reason of [undefined, 'Bearer sensitive-token https://example.test/private?sig=secret']) {
    const state = initialState();
    const failure = { title: '旧采集记录', status: 'retry', code: 'INCOMPLETE_DETAIL', reason };
    state.job = { status: 'partial', diagnostics: { total: 1, items: [failure] } };
    state.activity = { collection: { current: logItem(failure), recent: [logItem(failure)] } };
    const app = await setup({ state });
    for (const id of ['collection-queue', 'collection-current', 'collection-recent']) {
      const text = visibleText(app.elements.get(id));
      assert.match(text, /详情完整性未确认；此记录没有具体原因，请继续采集后查看新记录。/);
      assert.doesNotMatch(text, /sensitive-token|example\.test|sig=secret|Bearer/);
    }
  }
  const state = initialState();
  state.job = { status: 'partial', diagnostics: { total: 1, items: [{ title: '网络失败', status: 'retry',
    code: 'HTTP_429', reason: 'TREE_MISSING_CHILD' }] } };
  const app = await setup({ state });
  assert.doesNotMatch(visibleText(app.elements.get('collection-queue')), /原因：|TREE_MISSING_CHILD/);
});

test('retry waiting and paused jobs never infer stalled work from an old completed step', async () => {
  const state = initialState(); state.job = { status: 'running', nextRetryAt: Date.now() + 600_000, discovered: 1, processed: 0 };
  state.activity = { collection: { current: logItem({ status: 'failed', code: 'HTTP_429', finishedAt: Date.now() - 90_000 }) } };
  const app = await setup({ state });
  assert.equal(app.elements.get('collection-details-status').textContent, '等待重试');
  assert.match(app.elements.get('collection-wait').textContent, /等待重试至/);
  assert.doesNotMatch(visibleText(app.elements.get('collection-current')), /暂未收到新进展/);
  state.job.status = 'paused'; app.setState(state); await app.poll();
  assert.equal(app.elements.get('collection-details-status').textContent, '已暂停');
  assert.match(app.elements.get('collection-wait').textContent, /点击“继续采集”/);
  state.job.status = 'running'; state.job.nextRetryAt = null; state.activity.collection.current.status = 'interrupted';
  app.setState(state); await app.poll();
  assert.match(visibleText(app.elements.get('collection-current')), /上次处理已中断/);
  assert.doesNotMatch(visibleText(app.elements.get('collection-current')), /暂未收到新进展/);
});

test('invalid script replies show a fixed reason while old collection and GitHub failures stay distinct', async () => {
  const state = initialState();
  state.job = { status: 'partial', diagnostics: { total: 1, items: [{ title: '对话', conversationId: 'synthetic',
    code: 'INVALID_RESPONSE', reason: 'SCRIPT_RESULT_MISSING', status: 'retry', attempt: 1 }] } };
  state.activity = { github: { current: logItem({ status: 'failed', code: 'INVALID_RESPONSE', stage: 'commit' }), recent: [] } };
  const app = await setup({ state });
  assert.match(visibleText(app.elements.get('collection-queue')), /采集脚本没有返回结果/);
  assert.match(visibleText(app.elements.get('collection-queue')), /SCRIPT_RESULT_MISSING/);
  assert.doesNotMatch(visibleText(app.elements.get('transfer-current')), /采集脚本/);
  state.job.diagnostics.items[0].reason = 'https://secret.invalid/?token=private';
  app.setState(state); await app.poll();
  assert.match(visibleText(app.elements.get('collection-queue')), /此记录没有具体原因/);
  assert.doesNotMatch(visibleText(app.elements.get('collection-queue')), /secret.invalid|token=private/);
});

test('transfer details distinguish local downloads from conversation commit and expose downloads and restore scope', async () => {
  const state = initialState(); state.config.github.enabled = true;
  state.githubStatus = { status: 'pending', pending: 1 };
  state.assetDiagnostics = { pending: 1, failed: 1, internalMissing: 0, captureTotal: 1, captureItems: [
    { title: '截图讨论', fileName: '截图.png', status: 'retry', attempt: 1, code: 'HTTP_403' }], uploadTotal: 1,
    uploadItems: [{ title: '另一段对话', fileName: '结果.png', status: 'uploaded', size: 2048 }] };
  state.outboxSummary = { total: 1, items: [{ conversationId: 'synthetic-commit', title: '待提交对话', createdAt: Date.now() - 1000 }] };
  state.activity = { upload: { current: logItem({ status: 'success', stage: 'upload-image', fileName: '结果.png', finishedAt: Date.now(), completed: 1, total: 1 }), recent: [] } };
  state.restoreStatus = { total: 5, processed: 3, pending: 2, failed: 0 };
  const app = await setup({ state });
  assert.doesNotMatch(visibleText(app.elements.get('transfer-current')), /附件上传/);
  assert.equal(app.elements.has('upload-queue'), false);
  assert.match(visibleText(app.elements.get('download-queue')), /HTTP_403/);
  assert.match(visibleText(app.elements.get('outbox-queue')), /待提交对话 · 等待提交/);
  assert.match(app.elements.get('transfer-wait').textContent, /对话和附件各自保留进度/);
  assert.match(app.elements.get('transfer-restore-detail').textContent, /已处理 3 \/ 5 条/);
  assert.match(html, /仓库恢复（全部账号）/);
  app.elements.get('transfer-details').open = true;
  await app.poll(); assert.equal(app.elements.get('transfer-details').open, true);
});

test('diagnostic rows are bounded, redact source credentials, and clear when account changes', async () => {
  const state = initialState();
  state.job = { status: 'running', diagnostics: { total: 80, items: Array.from({ length: 80 }, (_, i) => ({
    title: `<img onerror=alert(1)> ${i} https://example.com/?sig=secret ghp_syntheticsecret`, status: 'pending' })) } };
  state.activity = { collection: { current: logItem({ title: 'Bearer synthetic-secret https://example.com/private' }),
    recent: Array.from({ length: 25 }, () => logItem({ status: 'success' })) } };
  const app = await setup({ state });
  assert.equal(app.elements.get('collection-queue').children.length, 50);
  assert.equal(app.elements.get('collection-recent').children.length, 20);
  assert.match(app.elements.get('collection-queue-note').textContent, /共 80 项，显示前 50 项/);
  const text = visibleText(app.elements.get('collection-queue')) + visibleText(app.elements.get('collection-current'));
  assert.doesNotMatch(text, /sig=secret|syntheticsecret|synthetic-secret|https:\/\//);
  assert.match(text, /<img onerror=alert\(1\)>/);
  const next = initialState(); next.identity.accountKey = 'acct-other'; next.account.accountKey = 'acct-other';
  app.setState(next); await app.poll();
  assert.equal(app.elements.get('collection-details').hidden, true);
  assert.equal(app.elements.get('collection-queue').children.length, 0);
  assert.equal(app.elements.get('collection-recent').children.length, 0);
});

test('identity checking labels cached account progress and disables account mutations while allowing settings', async () => {
  const state = initialState(); state.identityChecking = true;
  const app = await setup({ state });
  assert.equal(app.elements.get('account-badge').textContent, '核验中');
  assert.equal(app.elements.get('identity-checking-note').hidden, false);
  for (const id of ['start-capture', 'full-capture', 'pause-capture', 'retry-github', 'retry-images']) assert.equal(app.elements.get(id).disabled, true);
  assert.equal(app.elements.get('open-settings').disabled, false);
  state.identityChecking = false; app.setState(state); await app.poll();
  assert.equal(app.elements.get('identity-checking-note').hidden, true);
  assert.equal(app.elements.get('start-capture').disabled, false);
});

test('read-only progress polling continues during a long command without reenabling mutation controls', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const state = initialState(); state.config.github.enabled = true; state.githubStatus = { status: 'pending', pending: 1 };
  const app = await setup({ state, messageHook: async message => {
    if (message.type === 'collector:retry-github') await held;
  } });
  const command = app.click('retry-github');
  await new Promise(resolve => setImmediate(resolve));
  state.activity = { github: { current: logItem({ stage: 'commit', title: 'current conversation' }) } };
  app.setState(state); await app.poll();
  assert.match(visibleText(app.elements.get('transfer-current')), /current conversation/);
  assert.equal(app.elements.get('retry-github').disabled, true);
  release(); await command;
  assert.equal(app.elements.get('retry-github').disabled, false);
});

test('overlapping polls share one read and stale poll cannot overwrite a newer command response', async () => {
  let releasePoll, releaseCommand, pollReads = 0;
  const pendingPoll = new Promise(resolve => { releasePoll = resolve; });
  const pendingCommand = new Promise(resolve => { releaseCommand = resolve; });
  const state = initialState(); state.config.github.enabled = true; state.githubStatus = { status: 'pending', pending: 1 };
  const fresh = structuredClone(state); fresh.githubStatus = { status: 'synced', pending: 0 };
  const app = await setup({ state, messageHook: async (message, snapshot) => {
    if (message.type === 'collector:get-state' && ++pollReads > 1) { await pendingPoll; return { ok: true, state: snapshot }; }
    if (message.type === 'collector:retry-github') { await pendingCommand; return { ok: true, state: fresh }; }
  } });
  const command = app.click('retry-github'); await new Promise(resolve => setImmediate(resolve));
  const first = app.poll(), second = app.poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pollReads, 2);
  releaseCommand(); await new Promise(resolve => setImmediate(resolve));
  releasePoll(); await Promise.all([command, first, second]);
  assert.equal(app.elements.get('github-state').textContent, '已同步');
});

test('a failed status read clearly marks retained diagnostic records as stale', async () => {
  let fail = false;
  const app = await setup({ messageHook: message => fail && message.type === 'collector:get-state' ? { ok: false, error: { message: 'read failed' } } : undefined });
  fail = true; await app.poll();
  assert.equal(app.elements.get('transfer-connection').hidden, false);
  assert.match(app.elements.get('transfer-connection').textContent, /不能据此确认任务仍在运行/);
  fail = false; await app.poll();
  assert.equal(app.elements.get('transfer-connection').hidden, true);
});


test('a hung state read times out visibly and its late response cannot replace newer progress', async () => {
  const timers = new Map(); let timerId = 0, reads = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const state = initialState();
  const app = await setup({ state,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    messageHook: async (message, snapshot) => {
      if (message.type === 'collector:get-state' && ++reads === 2) { await held; return { ok: true, state: snapshot }; }
    } });
  const pending = app.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  [...timers.values()][0](); await pending;
  assert.match(app.elements.get('global-status').textContent, /读取后台状态超时/);
  assert.equal(app.elements.get('transfer-connection').hidden, false);
  const updated = initialState(); updated.account.alias = '最新账号记录'; app.setState(updated); await app.poll();
  assert.equal(app.elements.get('account-name').textContent, '最新账号记录');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.get('account-name').textContent, '最新账号记录');
});

test('GitHub queue explains waiting for collection rather than implying an active upload', async () => {
  const state = initialState(); state.config.github.enabled = true; state.job = { status: 'running', phase: 'details' };
  state.outboxSummary = { total: 2, items: [] };
  const app = await setup({ state });
  assert.equal(app.elements.get('transfer-details-status').textContent, '等待提交');
  assert.match(app.elements.get('transfer-wait').textContent, /对话采集中，完成本轮后提交 GitHub/);
});

test('local backup switches are independent from GitHub configuration and preserve paused assets', async () => {
  const state = initialState(); state.config.localAssetsEnabled = false;
  state.assetDiagnostics = { pending: 2, failed: 0, captureTotal: 2,
    captureItems: [{ title: '本地对话', fileName: 'photo.png', status: 'paused-by-setting' }] };
  const app = await setup({ state });
  assert.equal(app.elements.get('local-assets-policy').hidden, false);
  assert.match(visibleText(app.elements.get('download-queue')), /按设置暂停下载/);
  assert.equal(app.elements.get('repair-local').disabled, false);
  await app.click('open-settings');
  assert.equal(app.elements.get('local-assets-enabled').checked, false);
  app.elements.get('local-assets-enabled').checked = true;
  app.elements.get('auto-enabled').checked = false;
  await app.click('save-schedule');
  const saved = app.messages.filter(x => x.type === 'collector:configure').at(-1);
  assert.equal(saved.localAssetsEnabled, true); assert.equal(saved.autoEnabled, false);
  assert(!app.messages.some(x => x.type === 'collector:github-config'));
});

test('local-only home hides stale cloud queues and errors while showing local progress', async () => {
  const state = initialState();
  state.config.github = { enabled: false, lfsEnabled: false, autoRestore: false, repository: '', hasToken: false };
  state.githubStatus = { status: 'pending', pending: 40, nextRetryAt: Date.now() + 60000, error: { code: 'GITHUB_NETWORK' } };
  state.outboxSummary = { total: 40, items: [{ title: 'old cloud queue' }] };
  state.assetStatus = { local: 5, uploaded: 3, pendingUpload: 2, pendingCapture: 1 };
  state.activity = { upload: { current: logItem({ status: 'failed', stage: 'upload-image', title: 'old upload' }) } };
  const app = await setup({ state });
  for (const id of ['github-destination', 'github-detail', 'retry-github', 'outbox-queue-section', 'restore-queue-section', 'open-restore']) {
    assert.equal(app.elements.get(id).hidden, true, id);
  }
  assert.equal(app.elements.get('transfer-heading').textContent, '附件下载详情');
  assert.equal(app.elements.get('transfer-details-status').textContent, '本地备份');
  assert.doesNotMatch(app.elements.get('asset-summary-text').textContent, /上传/);
  assert.doesNotMatch(app.elements.get('transfer-detail-counts').textContent, /待提交/);
  assert.doesNotMatch(visibleText(app.elements.get('transfer-current')), /old upload/);
});

test('connecting GitHub in the wizard does not implicitly enable upload or attachment inclusion', async () => {
  const state = initialState(); state.config.setupComplete = false;
  const app = await setup({ state });
  await app.click('wizard-bind'); await app.click('wizard-next-1');
  app.elements.get('wizard-repository').value = 'example/backup';
  app.elements.get('wizard-token').value = 'synthetic-token';
  await app.click('wizard-connect-github');
  const saved = app.messages.find(x => x.type === 'collector:github-config');
  assert.equal(saved.enabled, false); assert.equal(saved.lfsEnabled, undefined); assert.equal(saved.autoRestore, false);
  assert.deepEqual(app.permissionRequests, [['https://api.github.com/*']]);
  await app.click('wizard-next-2'); await app.click('wizard-finish');
  assert.equal(app.messages.filter(x => x.type === 'collector:configure').at(-1).localAssetsEnabled, true);
});

test('manual GitHub backup works with automatic uploads off and follows saved attachment scope', async () => {
  const state = initialState(); state.config.github.hasToken = true; state.config.github.lfsEnabled = false;
  const app = await setup({ state }); await app.click('open-settings');
  assert.equal(app.elements.get('backup-github-now').disabled, false);
  await app.click('backup-github-now');
  assert(app.messages.some(x => x.type === 'collector:retry-github'));
  assert(!app.messages.some(x => x.type === 'collector:github-config'));
  assert.deepEqual(app.permissionRequests, [['https://api.github.com/*']]);
  state.githubStatus = { status: 'pending', manual: true, pending: 2 };
  app.setState(state); await app.poll();
  assert.equal(app.elements.get('github-destination').hidden, false);
  assert.equal(app.elements.has('upload-queue-section'), false);
  assert.match(app.elements.get('github-detail').textContent, /保存在本地/);
});

test('upload and automatic restore can be disabled without requesting revoked permissions', async () => {
  const state = initialState();
  state.config.github = { enabled: true, lfsEnabled: true, autoRestore: true, hasToken: true, repository: 'example/archive', branch: '' };
  const app = await setup({ state, grant: false }); await app.click('open-settings');
  app.elements.get('github-enabled').checked = false; app.elements.get('github-auto-restore').checked = false;
  await app.click('save-github');
  const saved = app.messages.filter(x => x.type === 'collector:github-config').at(-1);
  assert.equal(saved.enabled, false); assert.equal(saved.autoRestore, false); assert.equal(saved.lfsEnabled, undefined);
  assert.deepEqual(app.permissionRequests, []);
  assert.equal(app.elements.get('global-status').textContent, '');
});

test('completeness distinguishes external unsupported failed and setting-paused attachments with bounded safe rows', async () => {
  const state = initialState(); state.config.localAssetsEnabled = false;
  state.assetDiagnostics = { conversationTotal: 70, unsupported: 1, conversations: Array.from({ length: 60 }, (_, i) => ({
    conversationId: `chat-${i}`, title: `<b>原文</b> https://private.invalid/?sig=secret ghp_synthetictoken`,
    sourceComplete: i !== 1, total: 10, local: 6, external: 1, failed: 1, unsupported: 1, paused: 1, pending: 0,
  })) };
  const app = await setup({ state });
  assert.equal(app.elements.get('archive-completeness').hidden, false);
  assert.equal(app.elements.get('archive-completeness-list').children.length, 50);
  assert.match(app.elements.get('archive-completeness-note').textContent, /前 50 条/);
  const first = visibleText(app.elements.get('archive-completeness-list').children[0]);
  assert.match(first, /正文已保存.*附件 10 个，已保存 6 个/);
  assert.match(first, /失败 1.*仅外链 1.*暂不支持 1.*按设置暂停 1/);
  assert.doesNotMatch(first, /private\.invalid|sig=secret|ghp_synthetictoken/);
  assert.match(first, /<b>原文<\/b>/);
  assert.match(visibleText(app.elements.get('archive-completeness-list').children[1]), /正文完整性待确认/);
  app.elements.get('archive-completeness').open = true;
  await app.poll(); assert.equal(app.elements.get('archive-completeness').open, true);
  state.assetDiagnostics = {}; app.setState(state); await app.poll();
  assert.equal(app.elements.get('archive-completeness').hidden, true);
  assert.equal(app.elements.get('archive-completeness-list').children.length, 0);
});

test('local repair has a separate action and exposes bounded maintenance progress', async () => {
  const state = initialState(); state.config.localAssetsEnabled = false;
  state.maintenanceStatus = { status: 'completed', checked: 4, total: 4, repaired: 1, missingAssets: 2, missingConversations: ['chat-missing'], conflicts: 1 };
  const app = await setup({ state });
  assert.match(app.elements.get('maintenance-status').textContent, /已检查 4 \/ 4 条.*已修复 1.*附件缺失 2.*正文待补采 1.*保留人工修改 1/);
  await app.click('repair-local');
  assert(app.messages.some(x => x.type === 'collector:repair-local'));
  assert(!app.messages.some(x => x.type === 'collector:start' || x.type === 'collector:configure'));
  state.maintenanceStatus.status = 'running'; app.setState(state); await app.poll();
  assert.equal(app.elements.get('repair-local').disabled, true);
});

test('failure classes and cross-run cooldown show actionable waiting without raw error strings', async () => {
  const state = initialState();
  state.assetDiagnostics = { pending: 1, failed: 1, failures: [{ conversationTitle: '附件', fileName: 'large.zip',
    code: 'ASSET_SIZE', attempt: 4, waitingFor: 'unsupported', retryAt: Date.now() + 60000 }],
    captureTotal: 1, captureItems: [{ title: '附件', fileName: 'large.zip', status: 'waiting-unsupported' }] };
  state.job = { status: 'running', accountCooldownUntil: Date.now() + 60000, diagnostics: { total: 1,
    items: [{ title: '重试对话', status: 'failed', retryDisposition: 'cooldown', attempt: 0, totalAttempts: 8 }] } };
  const app = await setup({ state });
  assert.match(visibleText(app.elements.get('asset-failure-list')), /等待格式适配或手动重试/);
  assert.doesNotMatch(visibleText(app.elements.get('asset-failure-list')), /重试等待至/);
  assert.match(visibleText(app.elements.get('download-queue')), /等待格式适配或手动重试/);
  assert.match(visibleText(app.elements.get('collection-queue')), /冷却后重试.*累计尝试 8 次/);
  assert.match(app.elements.get('collection-wait').textContent, /当前账号请求已降速/);
});

test('maintenance displays conversation counts separately from filesystem checks', async () => {
  const state = initialState();
  state.maintenanceStatus = { status: 'partial', checked: 17, conversationsChecked: 3, totalConversations: 4,
    repairedMarkdown: 1, missingAttachments: 2, missingConversationCount: 1, missingConversations: ['x'], conflicts: 1 };
  const app = await setup({ state });
  assert.match(app.elements.get('maintenance-status').textContent, /已检查 3 \/ 4 条.*已修复 1.*附件缺失 2/);
  assert.doesNotMatch(app.elements.get('maintenance-status').textContent, /已检查 17/);
});

test('manual backup waits for repository edits to be saved', async () => {
  const state = initialState(); state.config.github.hasToken = true; state.config.github.lfsEnabled = true;
  const app = await setup({ state }); await app.click('open-settings');
  app.elements.get('repository').value = 'example/new-archive';
  await app.elements.get('repository').listeners.get('input')();
  assert.equal(app.elements.get('backup-github-now').disabled, true);
  await app.click('backup-github-now');
  assert(!app.messages.some(x => x.type === 'collector:retry-github'));
  await app.click('save-github');
  assert.equal(app.elements.get('backup-github-now').disabled, false);
  await app.click('backup-github-now');
  assert.deepEqual(app.permissionRequests.at(-1), ['https://api.github.com/*']);
});

test('wizard cannot announce a verified connection without repository credentials', async () => {
  const state = initialState(); state.config.setupComplete = false;
  const app = await setup({ state }); await app.click('wizard-bind'); await app.click('wizard-next-1');
  await app.click('wizard-connect-github');
  assert.equal(app.elements.get('wizard-next-2').disabled, true);
  assert.match(app.elements.get('global-status').textContent, /仓库与 Token/);
  assert(!app.messages.some(x => x.type === 'collector:github-config'));
});


test('opening and refocusing the panel request identity refresh but passive polling does not', async () => {
  const app = await setup();
  assert.equal(app.messages.find(message => message.type === 'collector:get-state').refreshIdentity, true);
  await app.poll();
  assert.equal(app.messages.at(-1).refreshIdentity, false);
  app.focus(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.messages.at(-1).refreshIdentity, true);
});


test('diagnostic entry filters local records, previews a bounded report and saves only that report', async () => {
  const blobs = [], createdElements = [];
  class ExportURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return 'blob:synthetic'; }
    static revokeObjectURL() {}
  }
  const record = { operationId: 'op-one', taskId: 'run-one', stage: 'download', status: 'failed', code: 'HTTP_404',
    title: 'Local private title', fileName: 'private.png', startedAt: Date.now() - 1000, finishedAt: Date.now() };
  const snapshot = { accountKey: 'acct-demo', accounts: [{ accountKey: 'acct-demo', platform: 'chatgpt', label: 'Demo' }], channels: { download: { history: [record] } } };
  const report = { schemaVersion: 1, records: [{ code: 'HTTP_404', conversation: 'conversation-1' }] };
  const app = await setup({ URL: ExportURL, createdElements, messageHook: message => {
    if (message.type === 'collector:diagnostics') return { ok: true, diagnostics: structuredClone(snapshot) };
    if (message.type === 'collector:export-diagnostics') return { ok: true, report };
    if (message.type === 'collector:clear-diagnostics') { snapshot.channels.download.history = []; return { ok: true, diagnostics: structuredClone(snapshot) }; }
  } });
  await app.click('open-diagnostics');
  assert.equal(app.elements.get('diagnostics').hidden, false); assert.equal(app.elements.get('home').hidden, true);
  assert.equal(app.elements.get('diagnostics-list').children.length, 1);
  app.elements.get('diagnostics-code').value = 'HTTP_403'; app.elements.get('diagnostics-code').listeners.get('input')();
  assert.equal(app.elements.get('diagnostics-list').children.length, 0);
  await app.click('preview-diagnostics');
  assert.equal(app.elements.get('diagnostics-export').hidden, false);
  assert.doesNotMatch(app.elements.get('diagnostics-preview').textContent, /private/);
  await app.click('save-diagnostics');
  assert.deepEqual(JSON.parse(await blobs[0].text()), report);
  assert.equal(createdElements.find(element => element.tagName === 'a').download, 'ai-memory-collector-diagnostics.json');
  const before = app.messages.filter(message => message.type === 'collector:get-state').length;
  await app.poll(); assert.equal(app.messages.filter(message => message.type === 'collector:get-state').length, before);
  await app.click('clear-diagnostics'); assert.equal(app.elements.get('diagnostics-export').hidden, true);
});

test('read summary distinguishes unique details and attempts and never invents old counters', async () => {
  const state = initialState(); state.job = { status: 'completed', discovered: 222, processed: 222, skipped: 220, added: 1, updated: 1,
    statistics: { listReads: 12, detailReads: 3, detailConversations: 2 } };
  const app = await setup({ state });
  assert.match(app.elements.get('run-summary').textContent, /未变化跳过 220/);
  assert.match(app.elements.get('collection-read-counts').textContent, /正文读取 2 条／3 次/);
  delete state.job.statistics; app.setState(state); await app.poll();
  assert.match(app.elements.get('collection-read-counts').textContent, /未记录/);
});


test('full capture confirmation can be cancelled and expires on account change or identity verification', async () => {
  const app = await setup();
  await app.click('full-capture');
  assert.equal(app.elements.get('full-capture-confirmation').hidden, false);
  await app.click('cancel-full-capture');
  await app.click('confirm-full-capture');
  assert.equal(app.messages.some(x => x.type === 'collector:start'), false);
  await app.click('full-capture');
  const state = initialState(); state.account.accountKey = 'other'; state.identity.accountKey = 'other';
  app.setState(state); await app.poll();
  assert.equal(app.elements.get('full-capture-confirmation').hidden, true);
  await app.click('confirm-full-capture');
  assert.equal(app.messages.some(x => x.type === 'collector:start'), false);
  await app.click('full-capture');
  state.identityChecking = true; app.setState(state); await app.poll();
  assert.equal(app.elements.get('full-capture-confirmation').hidden, true);
});

test('home separates completed conversations from failed attachments and hides unused cloud', async () => {
  const state = initialState(); state.job = { status: 'completed', discovered: 2, processed: 2, skipped: 2 };
  state.assetStatus = { local: 5, failed: 1, pendingCapture: 1, internalMissing: 1 };
  const app = await setup({ state });
  assert.equal(app.elements.get('home-heading').textContent, '本轮对话检查完成');
  assert.match(app.elements.get('overview-attachments').textContent, /本地附件 5.*失败 1.*内部附件未下载 1/);
  assert.match(app.elements.get('overview-problems').textContent, /附件失败 1/);
  assert.equal(app.elements.get('overview-cloud').hidden, true);
  assert.equal(app.elements.get('repair-recommended').hidden, true);
  state.maintenanceStatus = { missingAssets: 1 }; app.setState(state); await app.poll();
  assert.equal(app.elements.get('repair-recommended').hidden, false);
  await app.click('repair-recommended');
  assert.equal(app.messages.filter(x => x.type === 'collector:repair-local').length, 1);
});

test('first use keeps cloud optional and full capture out of primary actions', async () => {
  const app = await setup();
  assert.match(app.elements.get('overview-attachments').textContent, /尚无可显示的统计/);
  const primary = html.match(/<div class="main-actions">([\s\S]*?)<\/div>/)[1];
  assert.doesNotMatch(primary, /id="full-capture"|id="repair-local"/);
  for (const id of ['advanced-actions', 'wizard-cloud-options']) {
    const tag = html.match(new RegExp('<details[^>]*id="' + id + '"[^>]*>'))[0];
    assert.doesNotMatch(tag, /\bopen\b/);
  }
  assert.ok(html.indexOf('id="wizard-skip-github"') < html.indexOf('id="wizard-cloud-options"'));
});
