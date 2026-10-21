import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

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
  directory: { name: 'archive', granted: true }, job: null, githubStatus: null,
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
  const events = [], messages = [], intervalCallbacks = [], settings = new Map();
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
    getSetting: async key => settings.get(key), setSetting: async (key, value) => { events.push(`setting:${key}`); settings.set(key, value); },
    chrome: {
      runtime: { sendMessage: async message => {
        messages.push(structuredClone(message)); events.push(message.type);
        if (options.messageError && message.type === options.messageError) return { ok: false, error: { code: 'TEST', message: 'simulated failure' } };
        if (message.type === 'collector:bind') state.account = { ...state.account, enabled: true, alias: message.alias };
        if (message.type === 'collector:configure') state.config = { ...state.config, ...message };
        if (message.type === 'collector:github-config') state.config.github = { ...state.config.github, ...message, hasToken: Boolean(message.token || state.config.github.hasToken) };
        if (message.type === 'collector:directory-changed') state.directory = { name: directory.name, granted: true };
        return { ok: true, state: structuredClone(state) };
      } },
      permissions: { request: async request => { events.push(`permission:${request.origins[0]}`); return options.grant !== false; } },
      tabs: { create: async () => ({ id: 11 }) },
    },
  });
  const run = script.replace(/^import .*;\n/m, '');
  await vm.runInContext(`(async()=>{${run}\n})()`, context);
  return { elements, messages, events, state: () => state, setState: value => { state = value; }, context,
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
