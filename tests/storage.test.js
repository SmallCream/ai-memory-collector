import test from 'node:test';
import assert from 'node:assert/strict';
import { writeArchive } from '../extension/lib/storage.js';

function missing() { return new DOMException('missing', 'NotFoundError'); }

function fakeDirectory({ initial = {}, permission = 'granted', corruptWrites = false } = {}) {
  const entries = new Map(Object.entries(initial));
  const created = [];
  const writes = [];
  const dirs = new Set(['']);
  for (const path of entries.keys()) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) { dirs.add(parts.join('/')); parts.pop(); }
  }
  function directory(prefix = '') {
    return {
      kind: 'directory',
      queryPermission: async () => permission,
      async getDirectoryHandle(name, { create = false } = {}) {
        const key = prefix ? `${prefix}/${name}` : name;
        if (!dirs.has(key)) {
          if (!create) throw missing();
          dirs.add(key); created.push(key);
        }
        return directory(key);
      },
      async getFileHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!entries.has(path)) {
          if (!create) throw missing();
          entries.set(path, ''); created.push(path);
        }
        return {
          kind: 'file',
          async getFile() {
            const content = entries.get(path);
            return { size: Buffer.byteLength(content), text: async () => content };
          },
          async createWritable() {
            let staged;
            return {
              write: async content => { staged = content; },
              close: async () => {
                writes.push(path);
                entries.set(path, corruptWrites ? `${staged}!` : staged);
              },
              abort: async () => {},
            };
          },
        };
      },
    };
  }
  return { handle: directory(), entries, created, writes };
}

const firstPath = 'p0-captures/chatgpt/demo/conversations/a.json';
const secondPath = 'p0-captures/chatgpt/demo/conversations/a.md';
const bundle = { files: [{ path: firstPath, content: '{"ok":true}\n' }, { path: secondPath, content: '# 你好\n' }] };

test('writes a new group to actual handles and retries unchanged without writes', async () => {
  const fs = fakeDirectory();
  const result = await writeArchive(fs.handle, bundle);
  assert.deepEqual(result, { written: 2, unchanged: 0, paths: [firstPath, secondPath] });
  assert.equal(fs.entries.get(secondPath), '# 你好\n');
  assert.deepEqual(await writeArchive(fs.handle, bundle), { written: 0, unchanged: 2, paths: [firstPath, secondPath] });
  assert.equal(fs.writes.length, 2);
});

test('preflight refuses a later conflicting file before creating earlier missing files', async () => {
  const fs = fakeDirectory({ initial: { [secondPath]: 'manual note' } });
  await assert.rejects(writeArchive(fs.handle, bundle), /已有不同内容/u);
  assert.deepEqual(fs.created, []);
  assert.deepEqual(fs.writes, []);
  assert.equal(fs.entries.get(secondPath), 'manual note');
});

test('an identical earlier file permits resuming a partially completed group', async () => {
  const fs = fakeDirectory({ initial: { [firstPath]: bundle.files[0].content } });
  assert.deepEqual(await writeArchive(fs.handle, bundle), { written: 1, unchanged: 1, paths: [firstPath, secondPath] });
  assert.deepEqual(fs.writes, [secondPath]);
});

test('does not request permission implicitly or write without a grant', async () => {
  const fs = fakeDirectory({ permission: 'prompt' });
  fs.handle.requestPermission = async () => { throw new Error('should not be called'); };
  await assert.rejects(writeArchive(fs.handle, bundle), /重新授权/u);
  assert.deepEqual(fs.created, []);
});

test('rejects unsafe paths and duplicate destinations', async () => {
  for (const path of ['../outside.json', '/p0-captures/a', 'data/a', 'p0-captures/../a', 'p0-captures/a\\b', 'p0-captures//a', 'p0-captures/a\0b', 'p0-captures/a.']) {
    const fs = fakeDirectory();
    await assert.rejects(writeArchive(fs.handle, { files: [{ path, content: 'x' }] }), /路径/u);
    assert.deepEqual(fs.created, []);
  }
  await assert.rejects(writeArchive(fakeDirectory().handle, { files: [bundle.files[0], bundle.files[0]] }), /重复路径/u);
});

test('limits aggregate UTF-8 archive size before any writes', async () => {
  const fs = fakeDirectory();
  await assert.rejects(writeArchive(fs.handle, { files: [{ path: firstPath, content: '好'.repeat(4 * 1024 * 1024) }] }), /10 MiB/u);
  assert.deepEqual(fs.created, []);
});

test('failed post-write comparison never reports success', async () => {
  const fs = fakeDirectory({ corruptWrites: true });
  await assert.rejects(writeArchive(fs.handle, bundle), /核对失败/u);
  assert.equal(fs.writes.length, 1);
});
