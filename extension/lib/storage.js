// P0 deliberately refuses every differing existing file. Updating archives is P1.
const DATABASE_NAME = 'ai-memory-collector-p0';
const STORE_NAME = 'settings';
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
let databasePromise;

function database() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('当前环境不支持本地持久存储，请在扩展页面中操作。'));
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onerror = () => {
        databasePromise = undefined;
        reject(new Error('无法打开本地持久存储，请检查浏览器存储权限。'));
      };
      request.onblocked = () => {
        databasePromise = undefined;
        reject(new Error('本地存储升级被其他扩展页面阻塞，请关闭其他验证页后重试。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = undefined;
        };
        resolve(db);
      };
    });
  }
  return databasePromise;
}

function validateKey(key) {
  if (typeof key !== 'string' || !key || key.length > 128) {
    throw new Error('本地设置键无效。');
  }
}

export async function getSetting(key) {
  validateKey(key);
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    let value;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(new Error('读取本地设置失败。'));
  });
}

// FileSystemDirectoryHandle values are supported by IndexedDB structured cloning.
export async function setSetting(key, value) {
  validateKey(key);
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    try {
      tx.objectStore(STORE_NAME).put(value, key);
    } catch {
      tx.abort();
      reject(new Error('数据无法保存到本地存储，暂存未完成。'));
      return;
    }
    // A successful put request is not sufficient: wait for transaction commit.
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error('本地暂存失败，请检查剩余空间后重试。'));
  });
}

function validateFiles(archive) {
  if (!Array.isArray(archive?.files) || archive.files.length === 0 || archive.files.length > 128) {
    throw new Error('待保存文件组无效。');
  }
  const paths = new Set();
  let bytes = 0;
  for (const file of archive.files) {
    if (typeof file?.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('待保存文件必须具有路径和文本内容。');
    }
    const segments = file.path.split('/');
    if (segments.length < 2 || segments[0] !== 'p0-captures' ||
        segments.some(part => !part || part === '.' || part === '..' ||
          /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part))) {
      throw new Error('文件路径超出 P0 归档范围或包含不安全字符。');
    }
    if (paths.has(file.path)) throw new Error('文件组包含重复路径。');
    paths.add(file.path);
    bytes += new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('本次试采集超过 10 MiB，P0 暂不保存此文件组。');
  }
  return archive.files;
}

async function parentHandle(root, path, create = false) {
  const segments = path.split('/');
  const name = segments.pop();
  let parent = root;
  for (const segment of segments) {
    parent = await parent.getDirectoryHandle(segment, { create });
  }
  return { parent, name };
}

async function readTextIfPresent(root, path) {
  try {
    const { parent, name } = await parentHandle(root, path);
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error('目标已有文件超过 P0 大小限制，已停止保存。');
    return await file.text();
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

function conflict() {
  return new Error('目标目录已有不同内容，P0 已停止保存以保护原文件。请为本次试采集选择新的空目录；更新与合并将在 P1 实现。');
}

/**
 * Writes only missing files. The caller must persist the entire pending archive
 * before calling and retain it on failure for a byte-identical retry.
 * Preflight is not a cross-program filesystem lock: don't edit the target folder
 * while this operation runs. A failure can leave an incomplete new file group.
 */
export async function writeArchive(directoryHandle, archive) {
  const files = validateFiles(archive);
  if (directoryHandle?.kind !== 'directory' || typeof directoryHandle.queryPermission !== 'function') {
    throw new Error('请先选择真实本地目录。');
  }
  if (await directoryHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    throw new Error('本地目录权限不可用，请点击重新授权后再保存。');
  }
  // Check every target before creating any directories or files.
  for (const file of files) {
    const present = await readTextIfPresent(directoryHandle, file.path);
    if (present !== null && present !== file.content) throw conflict();
  }
  let written = 0;
  let unchanged = 0;
  for (const file of files) {
    // Check again immediately before write to catch changes since preflight.
    const present = await readTextIfPresent(directoryHandle, file.path);
    if (present === file.content) {
      unchanged++;
      continue;
    }
    if (present !== null) throw conflict();
    const { parent, name } = await parentHandle(directoryHandle, file.path, true);
    const handle = await parent.getFileHandle(name, { create: true });
    const appeared = await handle.getFile();
    if (appeared.size !== 0) {
      if (await appeared.text() === file.content) {
        unchanged++;
        continue;
      }
      throw conflict();
    }
    let stream;
    try {
      stream = await handle.createWritable({ keepExistingData: false });
      await stream.write(file.content);
      await stream.close();
    } catch {
      try { await stream?.abort(); } catch { /* Closed/aborted stream. */ }
      throw new Error('本地文件写入未完成。请保留待保存任务，恢复目录权限或空间后重试。');
    }
    if (await (await handle.getFile()).text() !== file.content) {
      throw new Error('本地文件写入后的核对失败，未标记保存完成。请保留待保存任务。');
    }
    written++;
  }
  // Also detect edits to earlier files before reporting the whole group complete.
  for (const file of files) {
    if (await readTextIfPresent(directoryHandle, file.path) !== file.content) {
      throw new Error('文件组在保存期间发生变化，未标记保存完成。请保留待保存任务。');
    }
  }
  return { written, unchanged, paths: files.map(file => file.path) };
}
