import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettingsByPrefix } from '../extension/lib/storage.js';

test('journal enumeration reads only the requested prefix and waits for transaction completion', async () => {
  const priorDB = globalThis.indexedDB, priorRange = globalThis.IDBKeyRange;
  const handle = { kind: 'directory', name: 'original' };
  const records = new Map([['assetWrite:a', { directory: handle, phase: 'writing' }], ['assetWrite:b', null], ['collectorConfigV2', { token: 'not part of journal read' }]]);
  let transaction, request, remaining, aborted = false;
  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  globalThis.indexedDB = { open: () => {
    const opening = {};
    opening.result = { transaction: (store, mode) => {
      assert.equal(store, 'settings'); assert.equal(mode, 'readonly');
      transaction = { objectStore: () => ({ openCursor: range => {
        assert.deepEqual(range, { lower: 'assetWrite:', upper: 'assetWrite:\uffff' });
        remaining = [...records].filter(([key]) => key >= range.lower && key <= range.upper);
        request = {};
        const advance = () => queueMicrotask(() => {
          if (aborted) { transaction.onabort(); return; }
          const next = remaining.shift();
          request.result = next ? { key: next[0], value: next[1], continue: advance } : null;
          request.onsuccess();
        });
        advance(); return request;
      } }) };
      return transaction;
    } };
    queueMicrotask(() => opening.onsuccess()); return opening;
  } };
  try {
    let settled = false;
    const pending = getSettingsByPrefix('assetWrite:').then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    transaction.oncomplete();
    const entries = await pending;
    assert.deepEqual(entries.map(x => x.key), ['assetWrite:a', 'assetWrite:b']);
    assert.equal(entries[0].value.directory, handle);
    assert.equal(entries[1].value, null);
    aborted = true;
    await assert.rejects(getSettingsByPrefix('assetWrite:'), /读取未完成的写入记录失败/);
    await assert.rejects(getSettingsByPrefix(''), /本地设置键无效/);
  } finally { globalThis.indexedDB = priorDB; globalThis.IDBKeyRange = priorRange; }
});
