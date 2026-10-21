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
  const store = overrides.store ?? new Map();
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
  const calls = { permissions: 0, probe: 0, write: 0, settings: [], localWrites: [], details: 0 };
  const permissions = overrides.permissions ?? (async () => true);
  const probeRepository = overrides.probe ?? (async () => ({ branch: 'main', private: true, empty: false }));
  const commitProbe = overrides.write ?? (async () => ({ status: 'created', readbackVerified: true, writeVerified: true }));
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), querySelectorAll: selector => selector === 'button' ? buttons : selector === 'input,select' ? inputs : feedback },
    window: { dispatchEvent() {}, confirm: () => true }, Event: class { constructor(type) { this.type = type; } },
    navigator: { locks: { request: (_name, _options, callback) => callback(overrides.lock === false ? null : {}) } },
    chrome: {
      permissions: { request: async (...args) => { calls.permissions++; return permissions(...args); } },
      tabs: { get: async () => ({ url: 'https://chatgpt.com/c/synthetic-conversation' }) },
      scripting: { executeScript: async ({ args: [request] }) => {
        if (request.kind === 'detail') calls.details++;
        return [{ frameId: 0, result: { ok: true, identity: { accountKey: 'synthetic-account', displayName: '测试身份' }, payload: {}, capturedAt: '2026-10-21T00:00:00.000Z' } }];
      } },
    },
    getSetting: overrides.getSetting ?? (async key => store.get(key)),
    setSetting: async (key, value) => {
      const copy = structuredClone(value);
      calls.settings.push({ key, value: copy });
      if (overrides.settingsFail) throw new Error('quota');
      if (overrides.beforeSave) await overrides.beforeSave(key, copy);
      store.set(key, copy);
    },
    probeRepository: async (...args) => { calls.probe++; return probeRepository(...args); },
    commitProbe: async (...args) => { calls.write++; return commitProbe(...args); },
    Option: class {}, URL, location: { href: 'chrome-extension://test/panel.html' }, TextEncoder,
    probeChatGPT() {}, buildArchive: overrides.buildArchive ?? (async () => ({ summary: { title: '合成新对话' }, files: [] })),
    writeArchive: async (...args) => {
      calls.localWrites.push(args);
      return overrides.localWrite ? overrides.localWrite(...args) : { written: 2, unchanged: 0 };
    },
  });
  vm.runInContext(source, context);
  await tick();
  if (overrides.prefill !== false) {
    nodes.get('repository').value = 'demo-owner/demo-private';
    nodes.get('github-token').value = 'synthetic-test-token';
  }
  return { nodes, calls, store,
    async click(id) { const node = nodes.get(id); assert.equal(node.disabled, false); await node.listeners.click(); },
    async change(id, value, event = 'change') {
      const node = nodes.get(id);
      assert.equal(node.disabled, false);
      if (typeof value === 'boolean') node.checked = value; else node.value = value;
      await node.listeners[event]();
    },
  };
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
  assert.ok(!JSON.stringify(p.calls.settings).includes('synthetic-test-token'));
});

test('ordinary settings survive a failed GitHub check and reopen without restoring trusted session state', async () => {
  const store = new Map();
  const p = await panel({ store, probe: async () => { throw new Error('offline'); } });
  p.nodes.get('github-status').textContent = '私有仓库连接成功，分支 main。';
  await p.change('repository', 'demo-owner/another-private', 'input');
  assert.match(p.nodes.get('github-status').textContent, /设置已更改/);
  await p.change('branch', 'archive', 'input');
  await p.change('detail-format', 'tree');
  p.nodes.get('personal-space').checked = true;
  p.nodes.get('source-tab').value = '99';
  await p.click('check-github');
  const reopened = await panel({ store, prefill: false });
  assert.equal(reopened.nodes.get('repository').value, 'demo-owner/another-private');
  assert.equal(reopened.nodes.get('branch').value, 'archive');
  assert.equal(reopened.nodes.get('detail-format').value, 'tree');
  assert.equal(reopened.nodes.get('github-token').value, '');
  assert.equal(reopened.nodes.get('remember-token').checked, false);
  assert.equal(reopened.nodes.get('personal-space').checked, false);
  assert.equal(reopened.nodes.get('source-tab').value, '');
  assert.equal(reopened.nodes.get('list').disabled, true);
  assert.ok(!JSON.stringify([...store]).includes('synthetic-test-token'));
  assert.deepEqual(Object.keys(store.get('formPreferences')).sort(), ['branch', 'detailFormat', 'rememberToken', 'repository', 'schemaVersion']);
});

test('Token is restored only after opt-in and unchecking removes the persisted value', async () => {
  const store = new Map();
  const p = await panel({ store });
  await p.change('remember-token', true);
  const reopened = await panel({ store, prefill: false });
  assert.equal(reopened.nodes.get('remember-token').checked, true);
  assert.equal(reopened.nodes.get('github-token').value, 'synthetic-test-token');
  await reopened.change('remember-token', false);
  // Unchecking stops persistence while allowing this page to keep using its input.
  assert.equal(reopened.nodes.get('github-token').value, 'synthetic-test-token');
  const again = await panel({ store, prefill: false });
  assert.equal(again.nodes.get('github-token').value, '');
  assert.equal(again.nodes.get('remember-token').checked, false);
  assert.ok(!Object.hasOwn(store.get('formPreferences'), 'token'));
});

test('forget Token follows in-flight saves and cannot be undone by an older snapshot', async () => {
  const store = new Map();
  let release;
  let count = 0;
  const p = await panel({ store, beforeSave: async () => {
    if (++count === 1) await new Promise(resolve => { release = resolve; });
  } });
  const saving = p.change('remember-token', true);
  await tick();
  const clearing = p.click('forget-token');
  assert.equal(p.nodes.get('github-token').value, '');
  assert.equal(p.nodes.get('remember-token').checked, false);
  assert.match(p.nodes.get('github-status').textContent, /Token 已清空/);
  release();
  await Promise.all([saving, clearing]);
  assert.equal(count, 2);
  assert.ok(!Object.hasOwn(store.get('formPreferences'), 'token'));
  const reopened = await panel({ store, prefill: false });
  assert.equal(reopened.nodes.get('github-token').value, '');
  assert.match(p.nodes.get('github-feedback').textContent, /已清除本机保存/);
});

test('legacy target and existing pending/directory survive the settings upgrade', async () => {
  const pending = { summary: { title: '虚构测试', displayedMessageCount: 3 } };
  const directory = { name: 'existing-test-folder' };
  const store = new Map([
    ['githubTarget', { repository: 'old-owner/private-data', branch: 'main' }],
    ['pendingArchive', pending], ['directory', directory],
  ]);
  const p = await panel({ store, prefill: false });
  assert.equal(p.nodes.get('repository').value, 'old-owner/private-data');
  assert.equal(p.nodes.get('branch').value, 'main');
  assert.match(p.nodes.get('directory').textContent, /existing-test-folder/);
  assert.match(p.nodes.get('capture-overview').textContent, /虚构测试.*阅读版 3 条消息/);
  assert.equal(p.nodes.get('save-local').disabled, false);
  assert.equal(store.get('pendingArchive'), pending);
  assert.equal(store.get('directory'), directory);
  await p.change('branch', 'archive');
  const reopened = await panel({ store, prefill: false });
  assert.equal(reopened.nodes.get('branch').value, 'archive');
});

test('forget failure is shown without claiming that the persisted Token was removed', async () => {
  const p = await panel({ settingsFail: true });
  await p.click('forget-token');
  assert.match(p.nodes.get('github-feedback').textContent, /未能确认.*清除/);
  assert.equal(p.nodes.get('github-feedback').classList.contains('error'), true);
  assert.equal(p.nodes.get('preferences-status').classList.contains('error'), true);
  assert.match(p.nodes.get('preferences-status').textContent, /可能仍保留/);
});

function localArchiveStore() {
  return new Map([
    ['directory', { name: 'synthetic-local-folder', kind: 'directory' }],
    ['pendingArchive', { summary: { title: '合成旧对话', displayedMessageCount: 2 }, files: [] }],
  ]);
}

async function selectNextConversation(p) {
  p.nodes.get('source-tab').value = '1';
  p.nodes.get('personal-space').checked = true;
  await p.click('identify');
  await p.change('conversation', 'synthetic-next');
}

test('verified local save clears durable pending, survives reopen and permits the next capture', async () => {
  const store = localArchiveStore();
  const p = await panel({ store });
  await selectNextConversation(p);
  await p.click('save-local');
  assert.equal(store.get('pendingArchive'), null);
  assert.match(p.nodes.get('local-status').textContent, /已保存并读回核对/);
  assert.match(p.nodes.get('capture-overview').textContent, /已保存：合成旧对话.*下一条/);
  assert.equal(p.nodes.get('discard').disabled, true);
  const reopened = await panel({ store });
  assert.equal(reopened.nodes.get('save-local').disabled, true);
  assert.match(reopened.nodes.get('capture-overview').textContent, /尚无采集结果/);
  await p.click('capture');
  assert.equal(p.calls.details, 1);
  assert.equal(store.get('pendingArchive').summary.title, '合成新对话');
});

test('pending stays protected until file verification and durable cleanup both finish', async () => {
  const store = localArchiveStore(), original = store.get('pendingArchive');
  let finishWrite, finishCleanup;
  const p = await panel({ store,
    localWrite: () => new Promise(resolve => { finishWrite = resolve; }),
    beforeSave: (key, value) => {
      if (key === 'pendingArchive' && value === null) return new Promise(resolve => { finishCleanup = resolve; });
    },
  });
  const saving = p.click('save-local');
  assert.equal(store.get('pendingArchive'), original);
  assert.equal(p.calls.settings.length, 0);
  finishWrite({ written: 2, unchanged: 0 });
  await tick();
  assert.equal(store.get('pendingArchive'), original);
  assert.equal(p.nodes.get('capture').disabled, true);
  assert.match(p.nodes.get('capture-overview').textContent, /已有采集副本/);
  finishCleanup(); await saving;
  assert.equal(store.get('pendingArchive'), null);
});

test('failed file writes preserve the original pending without attempting cleanup', async () => {
  const store = localArchiveStore(), original = store.get('pendingArchive');
  const p = await panel({ store, localWrite: async () => { throw new Error('文件组核对失败，保留待保存任务。'); } });
  await p.click('save-local');
  assert.equal(store.get('pendingArchive'), original);
  assert.equal(p.calls.settings.some(x => x.key === 'pendingArchive'), false);
  assert.equal(p.nodes.get('save-local').disabled, false);
  assert.match(p.nodes.get('local-feedback').textContent, /核对失败/);
});

test('cleanup failure keeps verified-save feedback and pending, then an idempotent retry releases it', async () => {
  const store = localArchiveStore(), original = store.get('pendingArchive');
  let failCleanup = true;
  const p = await panel({ store,
    localWrite: async () => ({ written: 0, unchanged: 2 }),
    beforeSave: async key => { if (key === 'pendingArchive' && failCleanup) throw new Error('quota'); },
  });
  await p.click('save-local');
  assert.equal(store.get('pendingArchive'), original);
  assert.match(p.nodes.get('local-status').textContent, /已保存并读回核对.*已有相同内容 2/);
  assert.match(p.nodes.get('local-feedback').textContent, /本地文件已保存.*暂存清理失败/);
  assert.equal(p.nodes.get('local-feedback').classList.contains('error'), true);
  failCleanup = false;
  await p.click('save-local');
  assert.equal(store.get('pendingArchive'), null);
  assert.match(p.nodes.get('local-feedback').textContent, /暂存已自动清理/);
  assert.equal(p.nodes.get('local-feedback').classList.contains('error'), false);
});

test('uncleared pending blocks a new detail request and names the conversation to save', async () => {
  const store = localArchiveStore(), original = store.get('pendingArchive');
  const p = await panel({ store });
  await selectNextConversation(p);
  await p.click('capture');
  assert.match(p.nodes.get('capture-feedback').textContent, /合成旧对话.*保存 JSON 与 Markdown/);
  assert.equal(p.calls.details, 0);
  assert.equal(p.calls.settings.length, 0);
  assert.equal(store.get('pendingArchive'), original);
});

