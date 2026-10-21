// Git LFS basic transfer protocol, independent of native git/git-lfs.
// https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
// https://github.com/git-lfs/git-lfs/blob/main/docs/api/basic-transfers.md
// Persist object IDs and queue state, never the short-lived action URLs/headers.
const MEDIA_TYPE = 'application/vnd.git-lfs+json';
const VERSION = 'https://git-lfs.github.com/spec/v1';
const METADATA_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_LFS_BYTES = 64 * 1024 * 1024;
// Exact GitHub-owned/service hosts only. In particular, do not trust all S3 buckets.
// https://docs.github.com/en/copilot/reference/copilot-allowlist-reference
export const GITHUB_LFS_HOSTS = Object.freeze([
  'github.com', 'api.github.com', 'lfs.github.com',
  'github-cloud.githubusercontent.com', 'objects.githubusercontent.com',
  'media.githubusercontent.com', 'github-cloud.s3.amazonaws.com',
]);

export class LfsError extends Error {
  constructor(code, message, { status = null, retryable = false, retryAfterMs = null, host = null } = {}) {
    super(message);
    this.name = 'LfsError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs;
    if (host) this.host = host;
  }
}
function fail(code, message, details) { throw new LfsError(code, message, details); }
function objectIdentity(value) {
  if (!value || typeof value.oid !== 'string' || !/^[a-f0-9]{64}$/.test(value.oid) ||
      !Number.isSafeInteger(value.size) || value.size < 0) {
    fail('LFS_INVALID_OBJECT', 'LFS 文件标识或大小无效。');
  }
  return { oid: value.oid, size: value.size };
}
function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('LFS_INVALID_BYTES', 'LFS 需要实际文件字节，不能上传文件链接。');
}
export async function hashBytes(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', asBytes(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function formatLfsPointer(value) {
  const { oid, size } = objectIdentity(value);
  return `version ${VERSION}\noid sha256:${oid}\nsize ${size}\n`;
}
/** Normal files return null; malformed/unsupported LFS-looking pointers fail closed. */
export function parseLfsPointer(text) {
  if (typeof text !== 'string' || !text.startsWith('version https://git-lfs.github.com/')) return null;
  const match = text.match(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (0|[1-9][0-9]*)\r?\n?$/);
  if (!match || text.length > 1024) fail('LFS_INVALID_POINTER', 'LFS 指针无效或使用了暂不支持的格式。');
  return objectIdentity({ oid: match[1], size: Number(match[2]) });
}

function validateConfig({ repository, token, fetchImpl = globalThis.fetch, allowedHosts = GITHUB_LFS_HOSTS,
  maxBytes = DEFAULT_MAX_LFS_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, branch } = {}) {
  const parts = typeof repository === 'string' ? repository.split('/') : [];
  if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0]) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1])) {
    fail('LFS_INVALID_REPOSITORY', '请填写 owner/repo 格式的 GitHub 仓库。');
  }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(token)) {
    fail('LFS_AUTH_REQUIRED', '请填写有效的 GitHub Token。');
  }
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail('LFS_INVALID_CONFIG', 'LFS 网络配置无效。');
  }
  if (!Array.isArray(allowedHosts) || allowedHosts.some(host => !GITHUB_LFS_HOSTS.includes(host))) {
    fail('LFS_INVALID_CONFIG', 'LFS 仅允许已审核的 GitHub 存储域名。');
  }
  if (branch != null && branch !== '' && (typeof branch !== 'string' || !branch || branch.length > 240 ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
      branch === '@' || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
      branch.endsWith('.') || branch.includes('//') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')))) {
    fail('LFS_INVALID_CONFIG', 'LFS 分支名无效。');
  }
  return { repository, token, fetchImpl, allowedHosts: new Set(allowedHosts), maxBytes, timeoutMs, branch,
    batchUrl: `https://github.com/${parts.map(encodeURIComponent).join('/')}.git/info/lfs/objects/batch` };
}

function retryAfter(response) {
  const value = response.headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(86_400_000, Math.max(0, ms)) : null;
}
function httpFailure(status, response, phase) {
  const details = { status, retryable: status === 408 || status === 429 || status >= 500, retryAfterMs: response ? retryAfter(response) : null };
  if (status === 401 || status === 403) fail(phase === 'action' ? 'LFS_ACTION_AUTH' : 'LFS_AUTH_REQUIRED',
    phase === 'action' ? 'LFS 文件链接授权失败，请重新获取下载或上传地址。' : 'GitHub LFS 授权失败，请检查 Token、仓库权限或组织策略。', details);
  if (status === 404 || status === 410) fail('LFS_NOT_FOUND', '未找到 LFS 文件或仓库，或当前授权无权读取。', details);
  if (status === 429) fail('LFS_RATE_LIMIT', 'GitHub LFS 正在限流，请稍后重试。', details);
  if (status === 507) fail('LFS_QUOTA', 'LFS 存储或流量额度不足，请检查 GitHub 额度。', { ...details, retryable: false });
  fail('LFS_HTTP_ERROR', `LFS 请求失败（HTTP ${status}）。`, details);
}

/** Bounded response reading: do not trust Content-Length or buffer arbitrary remote data. */
async function readBytes(response, limit) {
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    fail('LFS_SIZE_LIMIT', 'LFS 响应超过允许的文件大小。');
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) fail('LFS_SIZE_LIMIT', 'LFS 响应超过允许的文件大小。');
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        fail('LFS_SIZE_LIMIT', 'LFS 响应超过允许的文件大小。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function createLfsClient(input) {
  const config = validateConfig(input);
  const authorization = `Basic ${btoa(`x-access-token:${config.token}`)}`;
  const secretForms = [config.token, authorization, authorization.slice(6)];
  const containsSecret = value => secretForms.some(secret => value.includes(secret));
  function limitObject(value) {
    const identity = objectIdentity(value);
    if (identity.size > config.maxBytes) fail('LFS_SIZE_LIMIT', '图片或附件超过此版本允许的单文件大小。');
    return identity;
  }
  async function request(url, options, { phase, responseType = 'none', limit = METADATA_LIMIT } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await config.fetchImpl.call(globalThis, url, {
        ...options, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) httpFailure(response.status, response, phase);
      if (responseType === 'none') { await response.body?.cancel(); return null; }
      const bytes = await readBytes(response, limit);
      if (responseType === 'bytes') return bytes;
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail('LFS_INVALID_RESPONSE', 'LFS 返回了无法解析的响应。'); }
    } catch (error) {
      if (error instanceof LfsError) throw error;
      fail(controller.signal.aborted ? 'LFS_TIMEOUT' : 'LFS_NETWORK_OR_PERMISSION',
        controller.signal.aborted ? 'LFS 请求超时，请稍后重试。' : 'LFS 网络请求失败，请检查网络及扩展的域名访问权限。', { retryable: true });
    } finally { clearTimeout(timer); }
  }
  async function batch(operation, objects) {
    const data = await request(config.batchUrl, {
      method: 'POST', headers: { Accept: MEDIA_TYPE, 'Content-Type': MEDIA_TYPE, Authorization: authorization },
      body: JSON.stringify({ operation, transfers: ['basic'], hash_algo: 'sha256', objects,
        ...(config.branch ? { ref: { name: `refs/heads/${config.branch}` } } : {}) }),
    }, { phase: 'batch', responseType: 'json' });
    if (!data || !Array.isArray(data.objects) || data.objects.length !== objects.length ||
        (data.transfer != null && data.transfer !== 'basic') || (data.hash_algo != null && data.hash_algo !== 'sha256')) {
      fail('LFS_INVALID_RESPONSE', 'LFS 返回了不支持的传输方式或文件列表。');
    }
    if (!objects.length) return null;
    const expected = objects[0], object = data.objects[0];
    if (object?.oid !== expected.oid || object?.size !== expected.size) fail('LFS_INVALID_RESPONSE', 'LFS 响应的文件标识与请求不一致。');
    if (object.error) {
      if (!Number.isInteger(object.error.code)) fail('LFS_INVALID_RESPONSE', 'LFS 返回了无效的文件错误信息。');
      httpFailure(object.error.code, null, 'object');
    }
    if (object.actions != null && (typeof object.actions !== 'object' || Array.isArray(object.actions))) {
      fail('LFS_INVALID_RESPONSE', 'LFS 文件动作无效。');
    }
    return { object, receivedAt: Date.now() };
  }
  function action(value, receivedAt) {
    let url;
    try { url = new URL(value?.href); } catch { fail('LFS_INVALID_ACTION', 'LFS 返回的文件地址无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || containsSecret(url.href)) {
      fail('LFS_INVALID_ACTION', 'LFS 文件地址不安全，已停止传输。');
    }
    if (!config.allowedHosts.has(url.hostname)) {
      const host = /^[a-z0-9.-]{1,253}$/.test(url.hostname) ? url.hostname : null;
      fail('LFS_HOST_NOT_ALLOWED', 'LFS 返回了尚未允许的存储域名，未发送凭证或文件。', { host });
    }
    let expiresAt = Infinity;
    if (value.expires_in != null) {
      if (!Number.isFinite(value.expires_in) || value.expires_in < 0) fail('LFS_INVALID_ACTION', 'LFS 链接有效期无效。');
      expiresAt = receivedAt + value.expires_in * 1000;
    } else if (value.expires_at != null) {
      expiresAt = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN;
      if (!Number.isFinite(expiresAt)) fail('LFS_INVALID_ACTION', 'LFS 链接有效期无效。');
    }
    if (expiresAt <= Date.now()) fail('LFS_ACTION_EXPIRED', 'LFS 文件地址已过期，请重新获取。', { retryable: true });
    const supplied = value.header ?? {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).length > 40) {
      fail('LFS_INVALID_ACTION', 'LFS 文件请求头无效。');
    }
    const headers = {};
    const seen = new Set();
    for (const [name, content] of Object.entries(supplied)) {
      const lower = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) || typeof content !== 'string' ||
          content.length > 16_384 || /[\x00-\x1f\x7f]/.test(content) || containsSecret(content) || seen.has(lower)) {
        fail('LFS_INVALID_ACTION', 'LFS 文件请求头无效，已停止传输。');
      }
      seen.add(lower);
      // Browser controls these; silently dropping signed headers would corrupt requests.
      if (['cookie', 'cookie2', 'host', 'content-length', 'origin', 'referer', 'connection', 'user-agent',
        'transfer-encoding', 'accept-encoding', 'proxy-authorization', 'proxy-authenticate'].includes(lower) ||
          lower.startsWith('sec-') || lower.startsWith('proxy-')) {
        fail('LFS_UNSUPPORTED_HEADER', 'LFS 返回了浏览器不支持的请求头，未发送文件。');
      }
      headers[name] = content;
    }
    return { url: url.href, headers, expiresAt };
  }
  function withContentType(headers, fallback) {
    return Object.keys(headers).some(key => key.toLowerCase() === 'content-type') ? headers : { ...headers, 'Content-Type': fallback };
  }
  async function withFreshAction(run) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await run(); }
      catch (error) {
        if (attempt || !['LFS_ACTION_EXPIRED', 'LFS_ACTION_AUTH'].includes(error.code)) throw error;
        // Only a fresh Batch may replace an expired signed address. No timers/retry loops.
      }
    }
  }
  return {
    /** Read-only. Without an object this checks Batch only, not object access or write access. */
    async checkDownload(value) {
      if (value == null) {
        await batch('download', []);
        return { status: 'batch-reachable', downloadVerified: false, writeVerified: false };
      }
      const identity = limitObject(value);
      return withFreshAction(async () => {
        const result = await batch('download', [identity]);
        if (!result.object.actions?.download) fail('LFS_INVALID_RESPONSE', 'LFS 未提供文件下载地址。');
        action(result.object.actions.download, result.receivedAt);
        return { ...identity, status: 'available', downloadVerified: false, writeVerified: false };
      });
    },
    async upload({ bytes: value, oid, size, mimeType } = {}) {
      // Copy once: caller mutations during an await must not change bytes after hashing.
      const inputBytes = asBytes(value);
      if (inputBytes.byteLength > config.maxBytes) fail('LFS_SIZE_LIMIT', '图片或附件超过此版本允许的单文件大小。');
      const bytes = new Uint8Array(inputBytes);
      const identity = { oid: await hashBytes(bytes), size: bytes.byteLength };
      if ((oid != null && oid !== identity.oid) || (size != null && size !== identity.size)) {
        fail('LFS_HASH_MISMATCH', '本地文件内容与记录不一致，未上传。');
      }
      if (mimeType != null && (typeof mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType))) {
        fail('LFS_INVALID_MIME', '图片或附件类型无效。');
      }
      return withFreshAction(async () => {
        const result = await batch('upload', [identity]);
        if (!result.object.actions || Object.keys(result.object.actions).length === 0) {
          return { ...identity, status: 'already-present', verified: true };
        }
        if (!result.object.actions.upload) fail('LFS_INVALID_RESPONSE', 'LFS 未提供上传地址，无法确认文件已存在。');
        const upload = action(result.object.actions.upload, result.receivedAt);
        // Validate verify before uploading, but re-check expiry after the PUT.
        if (result.object.actions.verify) action(result.object.actions.verify, result.receivedAt);
        await request(upload.url, { method: 'PUT', headers: withContentType(upload.headers, 'application/octet-stream'), body: bytes }, { phase: 'action' });
        let verified = false;
        if (result.object.actions.verify) {
          const verify = action(result.object.actions.verify, result.receivedAt);
          await request(verify.url, { method: 'POST', headers: withContentType(verify.headers, MEDIA_TYPE), body: JSON.stringify(identity) }, { phase: 'action' });
          verified = true;
        }
        // A successful basic PUT is sufficient when the server has no verify action.
        return { ...identity, status: 'uploaded', verified };
      });
    },
    async download(value) {
      const identity = limitObject(value);
      return withFreshAction(async () => {
        const result = await batch('download', [identity]);
        if (!result.object.actions?.download) fail('LFS_INVALID_RESPONSE', 'LFS 未提供文件下载地址。');
        const download = action(result.object.actions.download, result.receivedAt);
        const bytes = await request(download.url, { method: 'GET', headers: download.headers }, { phase: 'action', responseType: 'bytes', limit: identity.size });
        if (bytes.byteLength !== identity.size || await hashBytes(bytes) !== identity.oid) {
          fail('LFS_HASH_MISMATCH', '下载的图片或附件校验失败，未保存损坏内容。');
        }
        return bytes;
      });
    },
  };
}
