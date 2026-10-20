// Run the actual panel event handlers with browser/storage/network boundaries mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function panel(overrides = {}) {
  const nodes = new Map();
  function element(id, tag, text = '') {
    const classes = new Set();
    return { id, tag, textContent: text, value: '', disabled: false, checked: false, listeners: {}, attributes: {},
      classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, add(name) { classes.add(name); }, contains(name) { return classes.has(name); } },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      replaceChildren() {}, append() {}, closest() { return this.section; } };
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>([^<]*)/g)) nodes.set(match[2], element(match[2], match[1], match[3].trim()));
  const feedback = [];
  for (const match of html.matchAll(/<section\b[\s\S]*?<\/section>/g)) {
    const ids = [...match[0].matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    const output = ids.map(id => nodes.get(id)).find(node => node?.id.endsWith('-feedback'));
    const section = { querySelector() { return output; } };
    for (const id of ids) if (nodes.has(id)) nodes.get(id).section = section;
    feedback.push(output);
  }
  const buttons = [...nodes.values()].filter(x => x.tag === 'button');
  const inputs = [...nodes.values()].filter(x => ['input', 'select'].includes(x.tag));
  const calls = { permissions: 0, probe: 0, write: 0, settings: [] };
  const permissions = overrides.permissions ?? (async () => true);
  const probeRepository = overrides.probe ?? (async () => ({ branch: 'main', private: true, empty: false }));
  const commitProbe = overrides.write ?? (async () => ({ status: 'created', readbackVerified: true, writeVerified: true }));
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), querySelectorAll: selector => selector === 'button' ? buttons : selector === 'input,select' ? inputs : feedback },
    window: { dispatchEvent() {}, confirm: () => true }, Event: class { constructor(type) { this.type = type; } },
    navigator: { locks: { request: (_name, _options, callback) => callback(overrides.lock === false ? null : {}) } },
    chrome: { permissions: { request: async (...args) => { calls.permissions++; return permissions(...args); } } },
    getSetting: overrides.getSetting ?? (async () => undefined),
    setSetting: async (key, value) => { calls.settings.push({ key, value }); if (overrides.settingsFail) throw new Error('quota'); },
    probeRepository: async (...args) => { calls.probe++; return probeRepository(...args); },
    commitProbe: async (...args) => { calls.write++; return commitProbe(...args); },
    Option: class {}, URL, location: { href: 'chrome-extension://test/panel.html' }, TextEncoder,
    probeChatGPT() {}, buildArchive() {}, writeArchive() {}
  });
  vm.runInContext(source, context);
  await tick();
  nodes.get('repository').value = 'demo-owner/demo-private';
  nodes.get('github-token').value = 'synthetic-test-token';
  return { nodes, calls, async click(id) { const node = nodes.get(id); assert.equal(node.disabled, false); await node.listeners.click(); } };
}

test('GitHub click immediately shows nearby progress and busy state while awaiting permission', async () => {
  let release;
  const p = await panel({ permissions: () => new Promise(resolve => { release = resolve; }) });
  const waiting = p.click('check-github');
  assert.match(p.nodes.get('github-feedback').textContent, /授权弹窗/);
  assert.equal(p.nodes.get('check-github').textContent, '处理中…');
  assert.equal(p.nodes.get('write-probe').disabled, true);
  assert.equal(p.nodes.get('repository').disabled, true);
  release(true); await waiting;
  assert.match(p.nodes.get('github-status').textContent, /私有仓库连接成功/);
  assert.equal(p.nodes.get('check-github').textContent, '检查仓库连接');
  assert.equal(p.nodes.get('check-github').disabled, false);
});
test('permission denial is displayed at clicked section and restores controls', async () => {
  const p = await panel({ permissions: async () => false });
  await p.click('check-github');
  assert.match(p.nodes.get('github-feedback').textContent, /SITE_PERMISSION_DENIED/);
  assert.equal(p.nodes.get('github-feedback').classList.contains('error'), true);
  assert.equal(p.calls.probe, 0);
  assert.equal(p.nodes.get('github-token').disabled, false);
});
test('authentication failure and code appear next to GitHub buttons, not only at top', async () => {
  const p = await panel({ probe: async () => { const e = new Error('GitHub 授权失效，请检查 Token。'); e.code = 'AUTH_REQUIRED'; throw e; } });
  await p.click('check-github');
  assert.match(p.nodes.get('github-feedback').textContent, /AUTH_REQUIRED/);
  assert.equal(p.nodes.get('github-feedback').textContent, p.nodes.get('global-status').textContent);
});
test('invalid form is explained locally before requesting browser permissions', async () => {
  const p = await panel();
  p.nodes.get('github-token').value = '';
  await p.click('check-github');
  assert.match(p.nodes.get('github-feedback').textContent, /请填写/);
  assert.equal(p.calls.permissions, 0);
});
test('completed remote write remains successful when remembering local settings fails', async () => {
  const p = await panel({ settingsFail: true });
  await p.click('write-probe');
  assert.match(p.nodes.get('github-status').textContent, /本次写入已验证/);
  assert.match(p.nodes.get('github-feedback').textContent, /操作已成功.*未能记住/);
  assert.equal(p.nodes.get('github-feedback').classList.contains('error'), false);
  assert.equal(p.calls.write, 1);
});
test('duplicate panel and startup storage errors are visible at all sections', async () => {
  for (const options of [{ lock: false }, { getSetting: async () => { throw new Error('blocked'); } }]) {
    const p = await panel(options);
    assert.match(p.nodes.get('github-feedback').textContent, /另一个采集台|无法读取本机暂存/);
    assert.equal(p.nodes.get('check-github').disabled, true);
  }
});
test('error display redacts actual input token and never persists it', async () => {
  const p = await panel({ probe: async () => { throw new Error('network synthetic-test-token'); } });
  await p.click('check-github');
  assert.ok(!p.nodes.get('github-feedback').textContent.includes('synthetic-test-token'));
  assert.equal(p.calls.settings.length, 0);
});
