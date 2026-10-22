import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { detailFailureMessage, sanitizeDetailFailure } from '../extension/lib/detail-errors.js';

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
      createElement: tag => new Element(tag), addEventListener() {} },
    window: { addEventListener: (name, callback) => windowListeners.set(name, callback), dispatchEvent: event => events.push(event.type),
      close: () => events.push('window-close'), showDirectoryPicker: async () => { events.push('directory-picker'); return directory; } },
    location: { href: options.url || 'chrome-extension://test/panel.html' }, URL, Date, Set, Map, Number, String, Array, Boolean, Event,
    setInterval: callback => { intervalCallbacks.push(callback); return 1; }, clearInterval() {},
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    getSetting: async key => settings.get(key), setSetting: async (key, value) => { events.push(`setting:${key}`); settings.set(key, value); },
    detailFailureMessage, sanitizeDetailFailure,
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
    click: id => elements.get(id).click(), poll: () => intervalCallbacks[0]() };
}

test('current account identity is plain text and initialized home has incremental and full actions', async () => {
  const state = initialState(); state.identity.displayName = '<img onerror=alert(1)>'; state.account.alias = '<script>unsafe</script>';
  const app = await setup({ state });
  assert.equal(app.elements.get('account-name').textContent, '<script>unsafe</script>');
  assert.equal(app.elements.get('home').hidden, false);
  assert.equal(app.elements.get('full-capture').hidden, false);
  await app.click('start-capture');
  await app.click('full-capture');
  assert.deepEqual(app.messages.filter(x => x.type === 'collector:start').map(x => x.mode), ['incremental', 'full']);
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
  assert(app.permissionRequests[0].includes('https://github-cloud.s3.amazonaws.com/*'));
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

test('LFS default is preserved on save and restoring-only configuration is verified without enabling uploads', async () => {
  const state = initialState(); state.config.github.hasToken = true;
  const app = await setup({ state }); await app.click('open-settings'); await app.click('save-github');
  const message = app.messages.find(item => item.type === 'collector:github-config');
  assert.equal(message.enabled, false); assert.equal(message.lfsEnabled, true);
  assert(app.messages.some(item => item.type === 'collector:github-test'));
  assert(app.permissionRequests[0].includes('https://lfs.github.com/*'));
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

test('asset summary distinguishes pending images from successful uploads', async () => {
  const state = initialState(); state.assetStatus = { local: 5, uploaded: 3, pendingUpload: 2, pendingCapture: 1, failed: 1 };
  const app = await setup({ state });
  assert.equal(app.elements.get('asset-summary').hidden, false);
  assert.match(app.elements.get('asset-summary-text').textContent, /本地图片 5.*已上传 3.*待采集 1（其中失败 1）.*待上传 2/);
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
  assert.match(item.children[2].textContent, /尚未取得可确认归属的原图/);
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
  assert.match(html, /逐张重试失败图片，不会重新扫描对话列表。对话采集暂停时，每项只尝试一次。/);
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
  assert.match(items[0].children[2].textContent, /最新对话中未找到这张图片/);
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
  assert.equal(app.elements.get('asset-summary-text').textContent, '本地图片 12 · 已上传 4 · 待上传 8 · 内部附件未下载 1');
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

test('transfer details distinguish file upload from conversation commit and expose downloads and restore scope', async () => {
  const state = initialState(); state.config.github.enabled = true;
  state.githubStatus = { status: 'pending', pending: 1 };
  state.assetDiagnostics = { pending: 1, failed: 1, internalMissing: 0, captureTotal: 1, captureItems: [
    { title: '截图讨论', fileName: '截图.png', status: 'retry', attempt: 1, code: 'HTTP_403' }], uploadTotal: 1,
    uploadItems: [{ title: '另一段对话', fileName: '结果.png', status: 'uploaded', size: 2048 }] };
  state.outboxSummary = { total: 1, items: [{ conversationId: 'synthetic-commit', title: '待提交对话', createdAt: Date.now() - 1000 }] };
  state.activity = { upload: { current: logItem({ status: 'success', stage: 'upload-image', fileName: '结果.png', finishedAt: Date.now(), completed: 1, total: 1 }), recent: [] } };
  state.restoreStatus = { total: 5, processed: 3, pending: 2, failed: 0 };
  const app = await setup({ state });
  assert.match(visibleText(app.elements.get('transfer-current')), /图片上传 · 本步骤完成/);
  assert.match(visibleText(app.elements.get('upload-queue')), /结果.png · 已上传/);
  assert.match(visibleText(app.elements.get('download-queue')), /HTTP_403/);
  assert.match(visibleText(app.elements.get('outbox-queue')), /待提交对话 · 等待提交/);
  assert.match(app.elements.get('transfer-wait').textContent, /还需要提交 JSON、Markdown 与清单/);
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
  state.activity = { upload: { current: logItem({ stage: 'upload-image', fileName: 'current.png' }) } };
  app.setState(state); await app.poll();
  assert.match(visibleText(app.elements.get('transfer-current')), /current.png/);
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
