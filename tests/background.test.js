import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCollectorService } from '../extension/lib/collector-service.js';
import { safeError } from '../extension/lib/config.js';

const raw = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const source = raw.replace(/^import[\s\S]*?;\s*$/gm, '');
const UI = { id: 'collector-id', url: 'chrome-extension://collector-id/panel.html?tab=5' };
const PAGE = { id: 'collector-id', url: 'https://chatgpt.com/c/example', frameId: 0, tab: { id: 5 } };
const tick = () => new Promise(resolve => setImmediate(resolve));

function background({ command, open } = {}) {
  const events = {}, calls = [];
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const service = {
    async initialize() { calls.push(['initialize']); },
    async pump() { calls.push(['pump']); },
    async enableTab(tab) { calls.push(['enableTab', { ...tab }]); },
    async identify(tab, force) { calls.push(['identify', tab.id, force]); },
    async tabGone(id) { calls.push(['tabGone', id]); },
    async state() { calls.push(['state']); return { tabId: 5 }; },
    async command(message, tabId) { calls.push(['command', { ...message }, tabId]); return command ? command(message, tabId) : { ok: true, state: { config: { hasToken: true } } }; },
    async contentState(tabId) { calls.push(['contentState', tabId]); return { ok: true, status: 'idle', label: '采集器' }; },
  };
  const chrome = {
    runtime: { id: 'collector-id', getURL: path => `chrome-extension://collector-id/${path.replace(/^\//, '')}`,
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      async openOptionsPage() { calls.push(['options']); } },
    action: { onClicked: event('click') },
    sidePanel: {
      open(options) { calls.push(['open', { ...options }]); return open ? open(options) : Promise.resolve(); },
      async close(options) { calls.push(['close', { ...options }]); },
      async setOptions(options) { calls.push(['setOptions', { ...options }]); },
    },
    tabs: {
      onUpdated: event('updated'), onActivated: event('activated'), onRemoved: event('removed'),
      async get(id) { calls.push(['get', id]); return { id, url: 'https://chatgpt.com/c/example' }; },
      async create(options) { calls.push(['create', { ...options }]); },
      async sendMessage(id, message) { calls.push(['send', id, { ...message }]); },
    },
    alarms: { onAlarm: event('alarm') },
    permissions: { onAdded: event('permission-added'), onRemoved: event('permission-removed') },
  };
  const noop = () => {};
  vm.runInNewContext(source, { chrome, URL, Promise, console,
    createCollectorService: () => service, getAdapter: () => ({}), safeError, ALARM_NAME: 'collector-work',
    getSetting: noop, setSetting: noop, getSettingsByPrefix: noop, createCollectorEngine: noop,
    createChatGPTAssetResolver: () => ({ resolve: noop }),
    createAssetService: () => ({ save: noop, reconcileRestoredAssets: noop }), createRestoreService: () => ({}),
    createLocalMaintenance: () => ({}), readConversationArchive: noop, repairMissingMarkdown: noop,
    fetchRepositorySnapshot: noop, downloadRepositoryFile: noop,
    readAccountManifest: noop, hasConversationFiles: noop, readConversationBaseline: noop,
    saveConversation: noop, applyRemoteFiles: noop, syncArchives: noop, probeRepository: noop });
  function message(value, sender = UI) {
    const replies = [];
    const keepAlive = events.message(value, sender, reply => replies.push(reply));
    return { keepAlive, replies };
  }
  return { calls, events, service, chrome, message };
}

test('ChatGPT content bridge permits only opening panel and a redacted status', async () => {
  const app = background(); app.calls.length = 0;
  const response = app.message({ type: 'collector:content-state', tabId: 999 }, PAGE);
  await tick();
  assert.equal(response.keepAlive, true);
  assert.deepEqual(app.calls, [['contentState', 5]]);
  assert.deepEqual(response.replies, [{ ok: true, status: 'idle', label: '采集器' }]);
  assert.ok(!JSON.stringify(response.replies).includes('token'));
});

test('content script cannot configure, bind, capture, sync, or fetch private UI state', async () => {
  const app = background(); app.calls.length = 0;
  for (const type of ['collector:get-state', 'collector:configure', 'collector:github-config', 'collector:github-test',
    'collector:start', 'collector:bind', 'collector:resume', 'collector:pause', 'collector:retry-github',
    'collector:restore', 'collector:restore-retry', 'collector:retry-images',
    'collector:directory-changed', 'collector:permissions-changed', 'collector:close-panel']) {
    const response = app.message({ type, token: 'untrusted', mode: 'full' }, PAGE);
    assert.equal(response.keepAlive, false);
    assert.equal(response.replies[0]?.error.code, 'FORBIDDEN');
  }
  await tick(); assert.deepEqual(app.calls, []);
});

test('rejects untrusted origin, wrong extension identity, subframes and unrelated extension pages', async () => {
  const app = background(); app.calls.length = 0;
  for (const sender of [
    { ...PAGE, url: 'https://chatgpt.com.evil.example/c/example' },
    { ...PAGE, url: 'http://chatgpt.com/c/example' },
    { ...PAGE, frameId: 1 }, { ...PAGE, id: 'other-extension' }, { ...PAGE, tab: {} },
    { ...UI, url: 'chrome-extension://other-extension/panel.html' },
    { ...UI, url: 'chrome-extension://collector-id/help.html' },
    { ...UI, url: 'https://collector-id/panel.html' },
    { ...UI, id: 'other-extension' }, { id: 'collector-id', url: 'invalid' },
  ]) {
    const response = app.message({ type: 'collector:get-state' }, sender);
    assert.equal(response.keepAlive, false); assert.equal(response.replies.length, 0);
  }
  await tick(); assert.deepEqual(app.calls, []);
});

test('trusted extension UI can send commands even though chrome-extension URL origin is opaque', async () => {
  assert.equal(new URL(UI.url).origin, 'null');
  const app = background(); app.calls.length = 0;
  const response = app.message({ type: 'collector:configure', intervalMinutes: 30, tabId: 7 });
  await tick();
  assert.equal(response.replies[0].ok, true);
  assert.deepEqual(app.calls, [['command', { type: 'collector:configure', intervalMinutes: 30, tabId: 7 }, 7]]);
});

test('trusted extension UI can request repository restore without a ChatGPT tab', async () => {
  const app = background(); app.calls.length = 0;
  const response = app.message({ type: 'collector:restore' }, { ...UI, url: 'chrome-extension://collector-id/panel.html' });
  await tick();
  assert.equal(response.replies[0].ok, true);
  assert.deepEqual(app.calls, [['command', { type: 'collector:restore' }, undefined]]);
});

test('floating click calls native sidePanel.open synchronously with sender tab before async work', async () => {
  const app = background(); app.calls.length = 0;
  const response = app.message({ type: 'collector:open-panel', tabId: 999 }, PAGE);
  assert.deepEqual(app.calls, [['open', { tabId: 5 }]]);
  await tick(); assert.equal(response.replies[0].ok, true);
});

test('synchronous native panel failure returns a safe response without losing the click', () => {
  const app = background({ open() { throw new Error('Invalid tab: private browser details'); } });
  const response = app.message({ type: 'collector:open-panel' }, PAGE);
  assert.equal(response.keepAlive, false);
  assert.equal(response.replies[0].ok, false);
  assert.equal(response.replies[0].error.code, 'OPERATION_FAILED');
  assert.ok(!JSON.stringify(response.replies).includes('private browser details'));
});

test('toolbar restores entry and opens side panel without creating another collector page', async () => {
  const app = background(); app.calls.length = 0;
  app.events.click({ id: 5, url: 'https://chatgpt.com/c/example' });
  assert.ok(app.calls.some(c => c[0] === 'open'));
  await tick();
  assert.deepEqual(app.calls, [['send', 5, { type: 'collector:show-entry' }], ['open', { tabId: 5 }]]);
});

test('other website toolbar opens options, never injects or opens a site side panel', async () => {
  const app = background(); app.calls.length = 0;
  app.events.click({ id: 5, url: 'https://example.test/' }); await tick();
  assert.deepEqual(app.calls, [['options']]);
});

test('first installation opens setup once; updates and worker starts preserve configuration', async () => {
  const app = background();
  assert.deepEqual(app.calls, [['initialize']]);
  app.calls.length = 0;
  app.events.installed({ reason: 'install' }); await tick();
  assert.deepEqual(app.calls, [['initialize'], ['create', { url: 'chrome-extension://collector-id/panel.html?setup=1' }]]);
  app.calls.length = 0;
  app.events.installed({ reason: 'update', previousVersion: '0.1.5' }); await tick();
  assert.deepEqual(app.calls, [['initialize']]);
  app.calls.length = 0;
  app.events.startup(); await tick();
  assert.deepEqual(app.calls, [['initialize'], ['pump']]);
});

test('only collector alarms dispatch work; tab close invalidates source cache', async () => {
  const app = background(); app.calls.length = 0;
  app.events.alarm({ name: 'unrelated-alarm' }); await tick(); assert.deepEqual(app.calls, []);
  app.events.alarm({ name: 'collector-work' }); await tick(); assert.deepEqual(app.calls, [['pump']]);
  app.events.removed(5); await tick(); assert.deepEqual(app.calls.at(-1), ['tabGone', 5]);
});

test('background errors do not return raw browser error details', async () => {
  const app = background({ command: async () => { throw new Error('Authorization: secret-token-value'); } });
  const response = app.message({ type: 'collector:start' }); await tick();
  assert.equal(response.replies[0].ok, false);
  assert.equal(response.replies[0].error.code, 'OPERATION_FAILED');
  assert.ok(!JSON.stringify(response.replies).includes('secret-token-value'));
});

test('collapse/hide communicates only cosmetic state to content script', async () => {
  const app = background(); app.calls.length = 0;
  const response = app.message({ type: 'collector:close-panel', hide: true, tabId: 5 }); await tick();
  assert.equal(response.replies[0].ok, true);
  assert.deepEqual(app.calls, [['send', 5, { type: 'collector:hide-entry' }], ['close', { tabId: 5 }]]);
});

test('site enabling matches exact HTTPS ChatGPT origin and never similar domains', async () => {
  const calls = [], browser = { sidePanel: { async setOptions(options) { calls.push(options); } } };
  const service = createCollectorService({ browser, createEngine: () => ({}), getSetting: async () => undefined, setSetting: async () => {} });
  await service.enableTab({ id: 1, url: 'https://chatgpt.com/c/example' });
  await service.enableTab({ id: 2, url: 'https://gemini.google.com/' });
  await service.enableTab({ id: 3, url: 'https://chatgpt.com.evil.example/' });
  await service.enableTab({ id: 4, url: 'http://chatgpt.com/' });
  assert.deepEqual(calls, [
    { tabId: 1, enabled: true, path: 'panel.html?tab=1' },
    { tabId: 2, enabled: false }, { tabId: 3, enabled: false }, { tabId: 4, enabled: false },
  ]);
});

test('manifest exposes no external messages, executable remote code or web-accessible credential pages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual([...manifest.optional_host_permissions].sort(), [
    'https://chatgpt.com/*', 'https://*.oaiusercontent.com/*', 'https://*/*',
    'https://api.github.com/*',
  ].sort());
  assert.equal(manifest.host_permissions, undefined, 'All site access remains optional and gesture-authorized');
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'));
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self';/);
});
