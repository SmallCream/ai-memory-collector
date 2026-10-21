import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const PANEL = 'chrome-extension://collector-id/panel.html';

function background({ tabs: initialTabs = [], createdLoadsImmediately = true, update, contexts } = {}) {
  const tabs = new Map(initialTabs.map(tab => [tab.id, { ...tab }]));
  const calls = { creates: [], updates: [], windows: [], warnings: [], contexts: 0 };
  let listener;
  let nextId = 100;
  const chrome = {
    action: { onClicked: { addListener(fn) { listener = fn; } } },
    runtime: {
      getURL: path => `chrome-extension://collector-id/${path}`,
      async getContexts(filter) {
        assert.deepEqual(Array.from(filter.contextTypes), ['TAB']);
        calls.contexts++;
        if (contexts) return contexts({ tabs, calls });
        return [...tabs.values()].filter(tab => tab.loaded !== false).map(tab => ({
          tabId: tab.id, windowId: tab.windowId, documentUrl: tab.url,
        }));
      },
    },
    tabs: {
      async create(options) {
        calls.creates.push({ ...options });
        const tab = { id: nextId++, windowId: 1, url: options.url, loaded: createdLoadsImmediately };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      },
      async update(id, options) {
        calls.updates.push({ id, ...options });
        if (update) await update({ id, options, tabs, calls });
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        Object.assign(tab, options);
        return { ...tab };
      },
    },
    windows: { async update(id, options) { calls.windows.push({ id, ...options }); } },
  };
  vm.runInNewContext(source, { chrome, URL, console: { warn(message) { calls.warnings.push(message); } } });
  return { calls, tabs, click: (tab = { id: 5, windowId: 1 }) => listener(tab) };
}

test('icon click focuses an existing collector without navigation or changing its source', async () => {
  const url = `${PANEL}?tab=7`;
  const app = background({ tabs: [{ id: 10, windowId: 2, url }] });
  await app.click({ id: 8, windowId: 1 });
  await app.click({ id: 9, windowId: 1 });
  assert.equal(app.calls.creates.length, 0);
  assert.deepEqual(app.calls.updates, [{ id: 10, active: true }, { id: 10, active: true }]);
  assert.deepEqual(app.calls.windows, [{ id: 2, focused: true }, { id: 2, focused: true }]);
  assert.equal(app.tabs.get(10).url, url);
});

test('rapid clicks create only one collector even before its document context has loaded', async () => {
  const app = background({ createdLoadsImmediately: false });
  await Promise.all([app.click({ id: 5, windowId: 1 }), app.click({ id: 6, windowId: 1 }), app.click()]);
  assert.deepEqual(app.calls.creates, [{ url: `${PANEL}?tab=5` }]);
  assert.equal(app.calls.updates.length, 2);
  assert.equal(app.calls.warnings.length, 0);
});

test('a collector closed during activation is rechecked before creating a replacement', async () => {
  const app = background({
    tabs: [{ id: 10, windowId: 1, url: PANEL }],
    update({ id, tabs }) { if (id === 10) tabs.delete(id); },
  });
  await app.click();
  assert.equal(app.calls.contexts, 2);
  assert.deepEqual(app.calls.creates, [{ url: `${PANEL}?tab=5` }]);
  assert.equal(app.calls.warnings.length, 0);
});

test('a closed cached collector can be opened again after startup', async () => {
  const app = background({ createdLoadsImmediately: false });
  await app.click();
  app.tabs.delete(100);
  await app.click({ id: 12, windowId: 1 });
  assert.deepEqual(app.calls.creates, [{ url: `${PANEL}?tab=5` }, { url: `${PANEL}?tab=12` }]);
});

test('unrelated extension paths and other origins are not treated as the collector', async () => {
  const app = background({ tabs: [
    { id: 1, windowId: 1, url: 'chrome-extension://collector-id/help.html' },
    { id: 2, windowId: 1, url: 'chrome-extension://other-id/panel.html' },
    { id: 3, windowId: 1, url: 'https://example.test/panel.html' },
  ] });
  await app.click();
  assert.equal(app.calls.creates.length, 1);
  assert.equal(app.calls.updates.length, 0);
});

test('an activation API error does not create duplicate pages or expose raw errors', async () => {
  const app = background({
    tabs: [{ id: 10, windowId: 1, url: PANEL }],
    update() { throw new Error('Unexpected failure with sensitive details'); },
  });
  await app.click();
  await app.click();
  assert.equal(app.calls.creates.length, 0);
  assert.equal(app.calls.warnings.length, 2);
  assert.ok(app.calls.warnings.every(message => !message.includes('sensitive')));
});
