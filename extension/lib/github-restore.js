/** Read-only, commit-pinned repository downloads. No local writes or account rebinding. */
import { createGitHubClient, GitHubProbeError } from './github.js';

const MAX_ENTRIES = 100_000;
const MAX_TREE_REQUESTS = 2048;
const MAX_DEPTH = 64;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const encoder = new TextEncoder();
const isSha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class GitHubRestoreError extends GitHubProbeError {
  constructor(code, message) {
    super(code, message);
    this.name = 'GitHubRestoreError';
  }
}

function fail(code, message) { throw new GitHubRestoreError(code, message); }

function apiFor(config, fetchImpl) {
  if (!isRecord(config) || typeof config.repository !== 'string') {
    fail('INVALID_REPOSITORY', '请填写 owner/repository 格式的 GitHub 仓库。');
  }
  const parts = config.repository.split('/');
  if (parts.length !== 2) fail('INVALID_REPOSITORY', '请填写 owner/repository 格式的 GitHub 仓库。');
  return createGitHubClient({ owner: parts[0], repo: parts[1], branch: config.branch,
    token: config.token, fetchImpl });
}

/** Reject paths that cannot safely be restored on supported desktop filesystems. */
export function validateRestorePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1200 ||
      path.split('/').some(part => !part || part === '.' || part === '..' ||
        /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part) ||
        part.toLowerCase() === '.git' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('REMOTE_PATH', '远端包含不安全或不兼容的文件路径，本次未恢复。');
  }
  if (path.split('/').length > MAX_DEPTH) fail('REMOTE_TREE_LIMIT', '远端目录层级过深，本次未恢复。');
  return path;
}

function validateTreeEntry(entry, prefix = '', shallow = false) {
  if (!isRecord(entry) || typeof entry.path !== 'string' || !isSha(entry.sha) ||
      (shallow && entry.path.includes('/'))) {
    fail('INVALID_RESPONSE', '远端文件树结构无法验证。');
  }
  const path = validateRestorePath(prefix + entry.path);
  if (entry.type === 'tree' && entry.mode === '040000') {
    return { path, sha: entry.sha.toLowerCase(), type: 'tree', mode: '040000' };
  }
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
    fail('REMOTE_PATH_TYPE', '远端包含符号链接、子模块或不支持的文件类型，本次未恢复。');
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    fail('INVALID_RESPONSE', '远端文件大小无法验证。');
  }
  return { path, sha: entry.sha.toLowerCase(), size: entry.size, type: 'blob', mode: entry.mode };
}

function validateTreeResponse(data, expectedSha) {
  if (!isRecord(data) || !Array.isArray(data.tree) || typeof data.truncated !== 'boolean' ||
      (data.sha !== undefined && (!isSha(data.sha) || data.sha.toLowerCase() !== expectedSha))) {
    fail('INVALID_RESPONSE', '远端文件树响应无法验证。');
  }
  if (data.tree.length > MAX_ENTRIES) fail('REMOTE_TREE_LIMIT', '远端文件数量超过本次恢复上限。');
  return data;
}

function collectEntries() {
  const paths = new Map();
  const portablePaths = new Map();
  const directoryNames = new Map();
  function add(entry) {
    const key = entry.path.normalize('NFC').toLowerCase();
    if (paths.has(entry.path) || portablePaths.has(key)) {
      fail('REMOTE_PATH_COLLISION', '远端文件路径重复或在本地文件系统中冲突，本次未恢复。');
    }
    if (paths.size >= MAX_ENTRIES) fail('REMOTE_TREE_LIMIT', '远端文件数量超过本次恢复上限。');
    const pieces = entry.path.split('/');
    for (let i = 1; i < pieces.length; i++) {
      const directory = pieces.slice(0, i).join('/');
      const directoryKey = directory.normalize('NFC').toLowerCase();
      if (directoryNames.has(directoryKey) && directoryNames.get(directoryKey) !== directory) {
        fail('REMOTE_PATH_COLLISION', '远端父目录大小写或字符规范化冲突，本次未恢复。');
      }
      directoryNames.set(directoryKey, directory);
    }
    paths.set(entry.path, entry);
    portablePaths.set(key, entry.path);
  }
  function finish() {
    for (const entry of paths.values()) {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestorKey = parts.slice(0, i).join('/').normalize('NFC').toLowerCase();
        const ancestor = paths.get(portablePaths.get(ancestorKey));
        if (ancestor && (ancestor.type !== 'tree' || ancestor.path !== parts.slice(0, i).join('/'))) {
          fail('REMOTE_PATH_COLLISION', '远端父目录与文件或目录大小写冲突，本次未恢复。');
        }
      }
    }
    return [...paths.values()].filter(entry => entry.type === 'blob')
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  return { add, finish };
}

async function readTree(api, treeSha) {
  const first = validateTreeResponse((await api.request(`/git/trees/${treeSha}?recursive=1`)).data, treeSha);
  const entries = collectEntries();
  if (!first.truncated) {
    for (const entry of first.tree) entries.add(validateTreeEntry(entry));
    return entries.finish();
  }

  // The Trees API has no page cursor. Discard the incomplete recursive response
  // and traverse immutable, nonrecursive subtrees instead.
  const pending = [{ sha: treeSha, prefix: '', ancestors: new Set() }];
  const cache = new Map();
  let requests = 1;
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i];
    if (current.ancestors.has(current.sha)) fail('REMOTE_TREE_CYCLE', '远端文件树存在循环引用，本次未恢复。');
    let data = cache.get(current.sha);
    if (!data) {
      if (requests >= MAX_TREE_REQUESTS) fail('REMOTE_TREE_LIMIT', '远端目录过多，请缩小恢复范围后重试。');
      requests++;
      data = validateTreeResponse((await api.request(`/git/trees/${current.sha}`)).data, current.sha);
      if (data.truncated) fail('REMOTE_TREE_INCOMPLETE', '远端单层目录仍被截断，无法安全恢复完整数据。');
      cache.set(current.sha, data);
    }
    for (const raw of data.tree) {
      const entry = validateTreeEntry(raw, current.prefix, true);
      entries.add(entry);
      if (entry.type === 'tree') {
        pending.push({ sha: entry.sha, prefix: entry.path + '/',
          ancestors: new Set([...current.ancestors, current.sha]) });
      }
    }
  }
  return entries.finish();
}

/** Pins a private repository to one commit. Reading does not require a ChatGPT account. */
export async function fetchRepositorySnapshot({ config, fetchImpl = globalThis.fetch }) {
  let api = apiFor(config, fetchImpl);
  const metadata = (await api.request()).data;
  if (!isRecord(metadata) || metadata.private !== true) {
    fail('PRIVATE_REPOSITORY_REQUIRED', '只允许恢复私有数据仓库，请检查仓库配置。');
  }
  const branch = config.branch || metadata.default_branch;
  if (typeof branch !== 'string' || !branch) fail('INVALID_RESPONSE', '无法确认仓库默认分支。');
  // Reuse client validation for both explicit and server-returned branch names.
  api = apiFor({ ...config, branch }, fetchImpl);
  const reference = await api.request(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { allowed: [404, 409] });
  const base = { repository: `${api.config.owner}/${api.config.repo}`, branch };
  if (reference.status !== 200) {
    const branches = (await api.request('/branches?per_page=1')).data;
    if (!Array.isArray(branches)) fail('INVALID_RESPONSE', '无法确认仓库分支状态。');
    if (branches.length) fail('BRANCH_NOT_FOUND', '指定分支不存在，未改用其他分支恢复。');
    return { ...base, commitSha: null, treeSha: null, entries: [], empty: true };
  }
  if (reference.data?.object?.type !== 'commit' || !isSha(reference.data.object.sha)) {
    fail('INVALID_RESPONSE', '无法确认目标分支提交。');
  }
  const commitSha = reference.data.object.sha.toLowerCase();
  const commit = (await api.request(`/git/commits/${commitSha}`)).data;
  if (!isSha(commit?.tree?.sha) || (commit.sha !== undefined && (!isSha(commit.sha) || commit.sha.toLowerCase() !== commitSha))) {
    fail('INVALID_RESPONSE', '无法确认目标提交的文件树。');
  }
  const treeSha = commit.tree.sha.toLowerCase();
  const entries = await readTree(api, treeSha);
  return { ...base, commitSha, treeSha, entries, empty: false };
}

function decodeBlob(data, entry, maxBytes) {
  if (!isRecord(data) || !Number.isSafeInteger(data.size) || data.size !== entry.size ||
      data.size > maxBytes || typeof data.content !== 'string' ||
      (data.sha !== undefined && (!isSha(data.sha) || data.sha.toLowerCase() !== entry.sha))) {
    fail('REMOTE_BLOB', '远端文件元信息或大小与快照不一致。');
  }
  let bytes;
  if (data.encoding === 'base64') {
    if (data.content.length > Math.ceil(maxBytes / 3) * 8 + 1024) fail('REMOTE_FILE_SIZE', '远端文件超过本次下载上限。');
    const text = data.content.replace(/[\r\n\t ]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
      fail('REMOTE_BLOB', '远端文件编码无法验证。');
    }
    try { bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0)); }
    catch { fail('REMOTE_BLOB', '远端文件编码无法验证。'); }
  } else if (data.encoding === 'utf-8' || data.encoding === 'utf8') {
    if (data.content.length > maxBytes) fail('REMOTE_FILE_SIZE', '远端文件超过本次下载上限。');
    bytes = encoder.encode(data.content);
  } else {
    fail('REMOTE_BLOB', '远端文件编码不受支持。');
  }
  if (bytes.byteLength !== entry.size || bytes.byteLength > maxBytes) {
    fail('REMOTE_BLOB', '远端文件实际大小与快照不一致。');
  }
  return bytes;
}

/** Downloads an ordinary Git blob by immutable SHA; LFS hydration is a separate step. */
export async function downloadRepositoryFile({ config, entry, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES }) {
  const file = validateTreeEntry(entry);
  if (file.type !== 'blob') fail('REMOTE_PATH_TYPE', '只能下载普通文件。');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BLOB_BYTES) {
    fail('INVALID_DOWNLOAD_LIMIT', '文件下载上限不合法。');
  }
  if (file.size > maxBytes) fail('REMOTE_FILE_SIZE', '远端文件超过本次下载上限。');
  const api = apiFor(config, fetchImpl);
  const data = (await api.request(`/git/blobs/${file.sha}`)).data;
  const bytes = decodeBlob(data, file, maxBytes);
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const gitBytes = new Uint8Array(header.byteLength + bytes.byteLength);
  gitBytes.set(header); gitBytes.set(bytes, header.byteLength);
  const actualSha = [...new Uint8Array(await crypto.subtle.digest(file.sha.length === 40 ? 'SHA-1' : 'SHA-256', gitBytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  if (actualSha !== file.sha) fail('REMOTE_HASH', '远端文件摘要与快照不一致，未保存。');
  return bytes;
}
