import { assetExtension, inspectAttachmentBytes } from './asset-store.js';
import { createRequestControl, CollectorRequestCancelledError, safeRetryAfter } from './detail-request-lifetime.js';
import { sanitizeAssetFailureDiagnostics } from './asset-failure.js';

/** Read-only attachment retrieval. No download URL or session credential leaves the page. */
export const DEFAULT_ASSET_LIMIT = 16 * 1024 * 1024;
const ACCOUNT = /^acct-[a-f0-9]{24}$/;
const FILE = /^file[-_][A-Za-z0-9_-]{1,160}$/;
const LIBRARY = /^libfile_[A-Za-z0-9_-]{1,160}$/;
const CONVERSATION = /^[a-zA-Z0-9_-]{1,100}$/;
const FILE_MIMES = { zip: 'application/zip', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/javascript',
  py: 'text/x-python', css: 'text/css', yaml: 'application/yaml', yml: 'application/yaml', sql: 'application/sql', sh: 'application/x-sh', xml: 'application/xml', log: 'text/plain' };
function sandboxPath(reference) {
  if (typeof reference !== 'string' || !reference.startsWith('sandbox:/')) return null;
  let path; try { path = decodeURIComponent(reference.slice(8)); } catch { return null; }
  return path.startsWith('/') && !path.startsWith('//') && !/[\\\u0000-\u001f\u007f?#]/.test(path) &&
    !path.split('/').some(part => part === '.' || part === '..') ? path : null;
}

export class ChatGPTAssetError extends Error {
  constructor(code, message, state = 'pending', retryAfterMs, diagnostics) {
    super(message); this.name = 'ChatGPTAssetError'; this.code = code; this.state = state;
    const delay = safeRetryAfter(code, retryAfterMs);
    if (delay !== undefined) this.retryAfterMs = delay;
    const safeDiagnostics = sanitizeAssetFailureDiagnostics(diagnostics);
    if (safeDiagnostics.length) this.diagnostics = safeDiagnostics;
  }
}
const failure = (code, message, state, retryAfterMs, diagnostics) => { throw new ChatGPTAssetError(code, message, state, retryAfterMs, diagnostics); };
const isSource = value => { try { return new URL(value).origin === 'https://chatgpt.com'; } catch { return false; } };

function descriptor(input) {
  if (!input || typeof input !== 'object') failure('ASSET_INPUT', '缺少附件来源信息。', 'unavailable');
  const reference = input.sourceRef ?? input.assetPointer ?? input.asset_pointer;
  const referenceId = typeof reference === 'string' ? /^(?:sediment|file-service):\/\/(file[-_][A-Za-z0-9_-]+)$/.exec(reference)?.[1] : undefined;
  // Manifest `id` is a content-independent SHA-256 key, not a platform file ID.
  const fileId = input.fileId ?? input.sourceId ?? input.retrieval?.fileId ?? referenceId ?? (FILE.test(input.id || '') ? input.id : undefined);
  const libraryFileId = input.libraryFileId ?? input.library_file_id ?? input.retrieval?.libraryFileId ??
    (typeof reference === 'string' ? /^library:(libfile_[A-Za-z0-9_-]+)$/.exec(reference)?.[1] : undefined);
  const sourcePath = sandboxPath(reference);
  if (sourcePath && input.messageId != null && (typeof input.messageId !== 'string' || !CONVERSATION.test(input.messageId))) {
    failure('ASSET_INPUT', '附件来源消息标识不合法。', 'unavailable');
  }
  const retrievalURL = typeof input.retrieval?.url === 'string' && /^(?:https:|blob:)/.test(input.retrieval.url) ? input.retrieval.url : null;
  if ((fileId !== undefined && !FILE.test(fileId)) || (libraryFileId !== undefined && !LIBRARY.test(libraryFileId)) ||
      (!fileId && !libraryFileId && !retrievalURL && !sourcePath) || (referenceId && referenceId !== fileId)) {
    failure('ASSET_INPUT', '附件来源标识不合法或不一致。', 'unavailable');
  }
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const expectedHash = input.sha256 ?? input.contentHash;
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) failure('ASSET_INPUT', '附件哈希格式无效。', 'unavailable');
  return { fileId: fileId || null, libraryFileId: libraryFileId || null, retrievalURL, sandboxPath: sourcePath,
    kind: input.kind === 'image' ? 'image' : 'attachment',
    messageId: typeof input.messageId === 'string' && CONVERSATION.test(input.messageId) ? input.messageId : null,
    fileName: String(input.fileName ?? input.name ?? sourcePath?.split('/').at(-1) ?? '').slice(0, 200),
    mimeType: typeof (input.mimeType ?? input.mime_type) === 'string' ? (input.mimeType ?? input.mime_type).toLowerCase() : null,
    size: positive(input.expectedSize ?? input.size ?? input.sizeBytes ?? input.size_bytes), width: positive(input.width), height: positive(input.height),
    expectedHash: expectedHash || null };
}

/**
 * Library and file download routes remain opt-in. File download uses the
 * observed route with a task-owned conversation ID, never the current tab URL.
 * DOM fallback requires an exact matching resource ID; filenames are not ownership evidence.
 */
export function createChatGPTAssetResolver(browser, { allowLibraryDownload = false, allowFileDownload = false,
  maxBytes = DEFAULT_ASSET_LIMIT } = {}) {
  const requests = createRequestControl(() => browser ?? globalThis.chrome);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_ASSET_LIMIT) {
    failure('ASSET_INPUT', '附件大小上限必须介于 1 字节和 16 MiB。', 'unavailable');
  }
  async function resolve({ tabId, account, asset, conversationId }) {
    const api = browser ?? globalThis.chrome;
    if (!Number.isSafeInteger(tabId) || tabId < 0) failure('TAB_REQUIRED', '请打开对应账号的 ChatGPT 页面。');
    const accountKey = typeof account === 'string' ? account : account?.accountKey;
    if (!ACCOUNT.test(accountKey || '') || (account?.platform && account.platform !== 'chatgpt')) {
      failure('IDENTITY', '缺少经过核验的 ChatGPT 账号。');
    }
    if (conversationId != null && (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId))) {
      failure('ASSET_INPUT', '附件所属对话标识不合法。', 'unavailable');
    }
    return requests.run(tabId, accountKey, async scope => {
    const source = descriptor(asset);
    if (source.size > maxBytes) failure('ASSET_TOO_LARGE', '附件超过本次自动获取的大小上限。');
    async function tabCheck() {
      let tab;
      try { tab = await api.tabs.get(tabId); } catch { failure('TAB_CLOSED', '附件来源标签页已关闭。'); }
      if (!isSource(tab.url) || (tab.pendingUrl && !isSource(tab.pendingUrl))) failure('TAB_CHANGED', '附件来源页面已离开 ChatGPT。');
    }
    await tabCheck();
    let result;
    try {
      const values = await scope.race(() => api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED',
        func: probeChatGPTAsset, args: [{ requestId: scope.id, expectedAccountKey: accountKey, asset: source, conversationId: conversationId ?? null,
          allowLibraryDownload: allowLibraryDownload === true, allowFileDownload: allowFileDownload === true, maxBytes }] }));
      result = values?.find(item => item.frameId === 0)?.result;
    } catch (error) {
      if (error instanceof CollectorRequestCancelledError) throw error;
      failure('TAB_UNAVAILABLE', '无法读取附件来源页面，请检查站点权限和登录状态。');
    }
    await tabCheck();
    if (!result?.ok) {
      const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(result?.error?.code || '') ? result.error.code : 'ASSET_PENDING';
      failure(code, typeof result?.error?.message === 'string' ? result.error.message : '附件尚未取得，等待补采。',
        result?.error?.state === 'unavailable' ? 'unavailable' : 'pending', result?.error?.retryAfterMs, result?.error?.diagnostics);
    }
    if (result.accountKey !== accountKey) failure('ACCOUNT_CHANGED', '附件采集期间账号发生变化，结果已丢弃。');
    const value = result.binary;
    if (!value || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > maxBytes ||
        !Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > Math.ceil(maxBytes / 49152) ||
        !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', ...Object.values(FILE_MIMES)].includes(value.mimeType) ||
        !['original', 'unverified'].includes(value.quality)) failure('ASSET_RESPONSE', '附件返回格式无效，未保存。');
    const bytes = new Uint8Array(value.byteLength);
    let offset = 0;
    try {
      for (const chunk of value.chunks) {
        if (typeof chunk !== 'string' || chunk.length > 65536 || chunk.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) throw new Error();
        const decoded = atob(chunk);
        if (offset + decoded.length > bytes.length) throw new Error();
        for (let i = 0; i < decoded.length; i++) bytes[offset++] = decoded.charCodeAt(i);
      }
    } catch { failure('ASSET_RESPONSE', '附件传输数据无效，未保存。'); }
    if (offset !== bytes.length) failure('ASSET_RESPONSE', '附件传输不完整，等待重试。');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (sha256 !== value.sha256 || (source.expectedHash && sha256 !== source.expectedHash)) failure('ASSET_HASH_MISMATCH', '附件内容校验失败，未保存。');
    let suffix;
    try { suffix = assetExtension(bytes, { kind: source.kind, fileName: source.fileName, mimeType: value.mimeType }); }
    catch { failure('ASSET_FORMAT', '附件类型或文件内容无法确认，未保存。'); }
    const extension = `.${suffix}`;
    let fileName = source.fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    if (!fileName) fileName = source.fileId || source.libraryFileId || `attachment-${sha256.slice(0, 16)}`;
    if (!fileName.toLowerCase().endsWith(extension)) fileName += extension;
    return { bytes, mimeType: value.mimeType, fileName, quality: value.quality, sha256,
      width: value.width ?? null, height: value.height ?? null, byteLength: bytes.byteLength, via: value.via };
    });
  }
  return Object.freeze({ resolve, cancel: (tabId, options) => requests.cancel(tabId, options) });
}

export async function resolveChatGPTAsset({ browser, allowLibraryDownload = false, allowFileDownload = false,
  maxBytes = DEFAULT_ASSET_LIMIT, ...request }) {
  return createChatGPTAssetResolver(browser, { allowLibraryDownload, allowFileDownload, maxBytes }).resolve(request);
}

/**
 * A successful anonymous GET establishes availability now, not permanence.
 * Missing permission, CORS failures, redirects and unrecognized content stay unknown;
 * callers must not silently turn those results into managed/LFS attachments.
 * This helper does not request permissions or retain a copy of the image.
 */
export async function validateExternalAsset({ url, browser = globalThis.chrome, fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_ASSET_LIMIT, asset = {} } = {}) {
  const unknown = (reason, httpStatus) => ({ status: 'unknown', reason,
    ...(Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) });
  let source;
  try { source = new URL(url); } catch { return unknown('invalid-url'); }
  if (source.protocol !== 'https:' || source.username || source.password || (source.port && source.port !== '443')) return unknown('unsupported-url');
  const host = source.hostname.toLowerCase();
  // Do not let a conversation trigger requests to loopback or private-network literals.
  if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)) return unknown('non-public-host');
  const volatile = /^(?:token|access_token|sig|signature|expires|expiry|se|sv|skoid|sktid|skt|ske|sks|skv|policy|key-pair-id|x-amz-.+|x-goog-.+)$/i;
  if ([...source.searchParams.keys()].some(key => volatile.test(key))) return unknown('temporary-url');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_ASSET_LIMIT) return unknown('invalid-limit');
  try {
    if (!await browser?.permissions?.contains({ origins: [`${source.origin}/*`] })) return unknown('permission-required');
  } catch { return unknown('permission-required'); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  let reader;
  try {
    const response = await fetchImpl(source.href, { method: 'GET', credentials: 'omit', headers: {},
      referrerPolicy: 'no-referrer', redirect: 'manual', cache: 'no-store', signal: controller.signal });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return unknown('redirect');
    if (!response.ok) return unknown(response.status === 401 || response.status === 403 ? 'authentication-required' : 'http-error', response.status);
    const declaredSize = response.headers.get('content-length');
    if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > maxBytes) return unknown('too-large');
    const declaredMime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declaredMime === 'text/html' || declaredMime === 'application/xhtml+xml') return unknown('html-response');
    if (!['', 'application/octet-stream', 'binary/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', ...Object.values(FILE_MIMES), 'application/x-zip-compressed', 'application/javascript', 'text/x-python', 'application/x-python-code', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/xml'].includes(declaredMime)) return unknown('unsupported-content');
    reader = response.body?.getReader();
    if (!reader) return unknown('stream-unavailable');
    const chunks = []; let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) { await reader.cancel(); return unknown('too-large'); }
      chunks.push(value);
    }
    if (!byteLength) return unknown('empty-content');
    const bytes = new Uint8Array(byteLength); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
    const starts = signature => signature.every((value, index) => bytes[index] === value);
    let mimeType;
    if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && ascii(12, 4) === 'IHDR') mimeType = 'image/png';
    else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) mimeType = 'image/gif';
    else if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') mimeType = 'image/webp';
    else if (bytes.length >= 4 && starts([255, 216, 255])) mimeType = 'image/jpeg';
    if (asset.kind === 'attachment' && FILE_MIMES[/\.([a-z0-9]+)$/i.exec(asset.fileName || '')?.[1].toLowerCase()]) mimeType = null;
    if (!mimeType && asset.kind !== 'image') {
      try {
        const inspected = inspectAttachmentBytes(bytes, { ...asset, mimeType: declaredMime || asset.mimeType });
        if (!inspected) return unknown('content-mismatch');
        mimeType = inspected.mimeType;
      } catch { return unknown('content-mismatch'); }
    }
    if (!mimeType || (mimeType.startsWith('image/') && declaredMime && !['application/octet-stream', 'binary/octet-stream', mimeType].includes(declaredMime))) return unknown('content-mismatch');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    return { status: 'external', verifiedAt: new Date().toISOString(), mimeType, byteLength, sha256 };
  } catch { return unknown(controller.signal.aborted ? 'timeout' : 'network-or-cors'); }
  finally { clearTimeout(timer); controller.abort(); try { reader?.releaseLock(); } catch {} }
}

// Serialized by executeScript. Keep all helpers and constants inside this function.
export async function probeChatGPTAsset(request) {
  const fail = (code, message, state = 'pending', retryAfterMs, reason) => {
    throw Object.assign(new Error(message), { code, state, ...(reason ? { reason } : {}), ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) });
  };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  let registry, scope;
  const requestId = typeof request?.requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) ? request.requestId : null;
  const checkCancelled = () => { if (scope?.cancelled) fail('COLLECTION_PAUSED', '采集已暂停，未完成的网络结果不会写入归档。'); };
  function retryAfter(response) {
    if (![429, 503].includes(response.status)) return undefined;
    const raw = response.headers.get('retry-after');
    if (typeof raw !== 'string' || raw.length > 100) return undefined;
    const value = raw.trim();
    const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 :
      /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) - Date.now() : NaN;
    return Number.isFinite(milliseconds) ? Math.min(86_400_000, Math.max(0, Math.ceil(milliseconds))) : undefined;
  }
  const nextSource = error => {
    if (['COLLECTION_PAUSED', 'HTTP_429', 'HTTP_503'].includes(error?.code)) throw error;
    return error;
  };
  const maxAllowed = 16 * 1024 * 1024;
  const diagnostics = [];
  let currentDiagnostic = null;
  const safeMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heif', 'image/heic',
    'image/svg+xml', 'image/bmp', 'image/tiff', 'application/octet-stream', 'binary/octet-stream', 'application/json',
    'application/problem+json', 'text/html', 'text/plain', 'application/zip', 'application/x-zip-compressed', 'application/pdf']);
  const safeDiagnosticCode = code => typeof code === 'string' && (/^HTTP_[1-5]\d{2}$/.test(code) ||
    ['ASSET_FORMAT', 'ASSET_PROTOCOL', 'ASSET_URL', 'ASSET_REDIRECT', 'ASSET_NETWORK', 'ASSET_TIMEOUT', 'ASSET_STREAM',
      'ASSET_TOO_LARGE', 'ASSET_VARIANT', 'ASSET_HASH_MISMATCH', 'ASSET_PENDING', 'COLLECTION_PAUSED'].includes(code)) ? code : null;
  function signatureType(bytes) {
    if (!bytes.length) return 'empty';
    const starts = values => values.every((value, index) => bytes[index] === value);
    const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
    if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && ascii(12, 4) === 'IHDR') return 'png';
    if (bytes.length >= 4 && starts([255, 216, 255])) return 'jpeg';
    if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
    if (bytes.length >= 16 && ascii(4, 4) === 'ftyp') {
      if (['avif', 'avis'].includes(ascii(8, 4))) return 'avif';
      if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(ascii(8, 4))) return 'heif';
    }
    if (bytes.length >= 26 && ascii(0, 2) === 'BM') return 'bmp';
    if (starts([73, 73, 42, 0]) || starts([77, 77, 0, 42])) return 'tiff';
    if (starts([80, 75, 3, 4]) || starts([80, 75, 5, 6])) return 'zip';
    if (ascii(0, 5) === '%PDF-') return 'pdf';
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
    if (/^(?:<!doctype\s+html|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/i.test(head)) return 'html';
    if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(head)) return 'svg';
    if (/^(?:\{|\[)/.test(head)) return 'json';
    return 'unknown';
  }
  const filePattern = /^file[-_][A-Za-z0-9_-]{1,160}$/;
  const libraryPattern = /^libfile_[A-Za-z0-9_-]{1,160}$/;
  const conversationPattern = /^[a-zA-Z0-9_-]{1,100}$/;
  const fileMimes = { zip: 'application/zip', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/javascript',
    py: 'text/x-python', css: 'text/css', yaml: 'application/yaml', yml: 'application/yaml', sql: 'application/sql', sh: 'application/x-sh', xml: 'application/xml', log: 'text/plain' };
  let asset, maximum, fileDownloadURL, interpreterDownloadURL, resolvedFileId;
  function safeURL(value, { blob = false, interpreterResult = false } = {}) {
    let url; try { url = new URL(value, 'https://chatgpt.com'); } catch { fail('ASSET_URL', '附件地址无法识别。'); }
    if (blob && url.protocol === 'blob:' && /^blob:https:\/\/chatgpt\.com\/[A-Za-z0-9-]+$/.test(url.href)) return url;
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) fail('ASSET_URL', '附件地址不在允许的来源范围内。');
    const host = url.hostname;
    const cdn = host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com') ||
      /^oai(?:sdmntpr|sdsorpr|dalleapi)[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host) ||
      /^oaisdmntpr[a-z0-9-]*aws\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
    if (host !== 'chatgpt.com' && !cdn) fail('ASSET_URL', '附件下载目标尚未支持，等待适配。');
    if (host === 'chatgpt.com') {
      const exactLibrary = asset.libraryFileId && url.pathname === `/api/library/files/${asset.libraryFileId}/download`;
      const observedFile = url.pathname.startsWith('/backend-api/files/') &&
        [asset.fileId, asset.libraryFileId].filter(Boolean).some(id => url.pathname.split('/').includes(id));
      // This observed redirect route identifies the resource in the query, not
      // the path. Reject ambiguous IDs; its signed URL stays inside this probe.
      const contentIds = url.searchParams.getAll('id');
      const validContentId = url.pathname === '/backend-api/estuary/content' && contentIds.length === 1 && filePattern.test(contentIds[0]);
      // The interpreter entry itself is bound to conversation + message + full
      // sandbox path. Only its actual response may establish a new file ID.
      if (interpreterResult && validContentId && !asset.fileId && !resolvedFileId) resolvedFileId = contentIds[0];
      const observedContent = validContentId && contentIds[0] === (asset.fileId || resolvedFileId);
      const exactInterpreter = interpreterDownloadURL && url.href === interpreterDownloadURL;
      if (!exactLibrary && !observedFile && !observedContent && !exactInterpreter) fail('ASSET_URL', '附件下载地址与当前资源不匹配。');
    }
    return url;
  }
  async function bytesOf(response, limit) {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) fail('ASSET_TOO_LARGE', '附件响应超过大小上限。');
    const reader = response.body?.getReader();
    if (!reader) fail('ASSET_STREAM', '当前环境不能安全读取有界附件响应。');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      checkCancelled();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('ASSET_TOO_LARGE', '附件响应超过大小上限。'); }
      chunks.push(value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  async function requestData(url, token, limit, sessionRequest = false, allowNativeRedirectFollow = false) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    if (scope) scope.controller = controller;
    const checkDeadline = () => {
      checkCancelled();
      if (controller.signal.aborted) fail('ASSET_TIMEOUT', '附件读取超时，请稍后重试。');
    };
    const rememberResponse = response => {
      if (sessionRequest || !currentDiagnostic) return;
      delete currentDiagnostic.httpStatus; delete currentDiagnostic.byteLength;
      currentDiagnostic.detectedType = 'not-read';
      if (Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599) currentDiagnostic.httpStatus = response.status;
      const mime = (response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      currentDiagnostic.mimeType = !mime ? 'missing' : safeMimes.has(mime) ? mime : 'unknown';
    };
    try {
      checkDeadline();
      const sameOrigin = new URL(url, 'https://chatgpt.com').origin === 'https://chatgpt.com' && !String(url).startsWith('blob:');
      const options = { method: 'GET', credentials: sameOrigin ? 'include' : 'omit',
        cache: 'no-store', redirect: sessionRequest ? 'error' : 'manual', referrerPolicy: 'no-referrer',
        headers: token && sameOrigin ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal };
      let response = await fetch(url, options);
      rememberResponse(response);
      checkDeadline();
      if (response.type === 'opaqueredirect' && !sessionRequest && allowNativeRedirectFollow &&
          ((asset.libraryFileId && url === `https://chatgpt.com/api/library/files/${asset.libraryFileId}/download`) ||
            (fileDownloadURL && url === fileDownloadURL) || (interpreterDownloadURL && url === interpreterDownloadURL))) {
        // Browser fetch hides Location on manual redirects. Only these canonical
        // platform download entries may delegate a redirect chain to the browser.
        // Fetch removes Authorization on cross-origin redirects; same-origin
        // credentials keep cookies off the CDN. Intermediate anonymous requests
        // are not prevalidated; the final destination is checked before reading.
        response = await fetch(url, { ...options, redirect: 'follow', credentials: 'same-origin' });
        rememberResponse(response);
        checkDeadline();
        if (response.type === 'opaqueredirect' || response.type === 'opaque' || (response.status >= 300 && response.status < 400)) {
          fail('ASSET_REDIRECT', '附件下载跳转未完成，等待补采。');
        }
        if (typeof response.url !== 'string' || !/^https:\/\//.test(response.url)) fail('ASSET_URL', '附件下载的最终地址无法确认，未读取内容。');
        safeURL(response.url, { interpreterResult: url === interpreterDownloadURL });
      }
      if (response.type === 'opaqueredirect') fail('ASSET_REDIRECT', '网页返回了不可检查的跳转，请等待资源适配或打开原图补采。');
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) fail('ASSET_REDIRECT', '附件下载跳转无法解析。');
        return { redirect: new URL(location, url).href };
      }
      if (!response.ok) fail(`HTTP_${response.status}`, response.status === 429 ? '附件请求受到限流，请稍后重试。' :
        response.status === 401 || response.status === 403 ? '附件暂时无法访问，请检查登录和访问权限。' : '附件资源暂时不可用，等待补采。', 'pending', retryAfter(response));
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (mime === 'text/html') fail('ASSET_FORMAT', '附件请求返回了网页，未作为附件保存。');
      const disposition = response.headers.get('content-disposition') || '';
      const bytes = await bytesOf(response, sessionRequest ? Math.min(limit, 1024 * 1024) : limit);
      checkDeadline();
      if (!sessionRequest && currentDiagnostic) {
        currentDiagnostic.byteLength = bytes.byteLength;
        currentDiagnostic.detectedType = signatureType(bytes);
      }
      return { bytes, mime,
        attachment: /^attachment(?:;|$)/i.test(disposition) };
    } catch (error) { checkDeadline(); throw error; }
    finally { clearTimeout(timer); controller.abort(); if (scope?.controller === controller) scope.controller = null; }
  }
  async function session() {
    const response = await requestData('https://chatgpt.com/api/auth/session', null, 1024 * 1024, true);
    if (response.mime !== 'application/json') fail('IDENTITY', '无法核验当前附件所属账号。');
    let value; try { value = JSON.parse(new TextDecoder().decode(response.bytes)); } catch { fail('IDENTITY', '无法核验当前附件所属账号。'); }
    if (!record(value?.user) || typeof value.user.id !== 'string' || !value.user.id || typeof value.accessToken !== 'string' || !value.accessToken) {
      fail('IDENTITY', '请先登录 ChatGPT，再补采附件。');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`chatgpt:${value.user.id}`));
    const accountKey = 'acct-' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
    return { accountKey, token: value.accessToken };
  }
  function imageInfo(bytes, declared) {
    const starts = signature => signature.every((value, index) => bytes[index] === value);
    const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
    let mime, width = null, height = null;
    if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && ascii(12, 4) === 'IHDR') {
      mime = 'image/png'; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      width = view.getUint32(16); height = view.getUint32(20);
    } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
      mime = 'image/gif'; width = bytes[6] | (bytes[7] << 8); height = bytes[8] | (bytes[9] << 8);
    } else if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      mime = 'image/webp';
      if (bytes.length >= 30 && ascii(12, 4) === 'VP8X') {
        width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
        height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      }
    } else if (bytes.length >= 4 && starts([255, 216, 255])) {
      mime = 'image/jpeg';
      let cursor = 2;
      while (cursor + 4 < bytes.length) {
        if (bytes[cursor] !== 255) break;
        const marker = bytes[cursor + 1];
        if (marker === 217 || marker === 218) break;
        const size = (bytes[cursor + 2] << 8) | bytes[cursor + 3];
        if (size < 2 || cursor + 2 + size > bytes.length) break;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8) {
          height = (bytes[cursor + 5] << 8) | bytes[cursor + 6]; width = (bytes[cursor + 7] << 8) | bytes[cursor + 8]; break;
        }
        cursor += size + 2;
      }
    }
    if (!mime) {
      if (['avif', 'heif', 'bmp', 'tiff', 'svg'].includes(signatureType(bytes))) {
        fail('ASSET_FORMAT', '响应是当前下载器尚不支持的图片类型，未保存。', 'pending', undefined, 'format_image_type_unsupported');
      }
      fail('ASSET_FORMAT', '响应中未识别到受支持的图片文件头，未保存。', 'pending', undefined, 'format_image_header_unknown');
    }
    if (declared && !['application/octet-stream', 'binary/octet-stream', mime].includes(declared)) {
      fail('ASSET_FORMAT', '已识别图片文件头，但响应声明的类型与图片内容不一致，未保存。', 'pending', undefined, 'format_image_mime_mismatch');
    }
    if ((width !== null && (!width || !height || width * height > 100000000)) ||
        (asset.width && width !== null && asset.width !== width) || (asset.height && height !== null && asset.height !== height)) {
      fail('ASSET_VARIANT', '取得的附件尺寸与原图不一致，等待获取原图。');
    }
    if (asset.mimeType && asset.mimeType !== mime) fail('ASSET_VARIANT', '取得的附件格式与来源信息不一致。');
    if (asset.size && asset.size !== bytes.byteLength) fail('ASSET_VARIANT', '取得的附件大小与原始附件不一致，等待获取原图。');
    return { mime, width, height };
  }
  function contentInfo(bytes, declared) {
    const suffix = /\.([a-z0-9]+)$/i.exec(asset.fileName || '')?.[1].toLowerCase();
    const aliases = { 'application/x-zip-compressed': 'application/zip', 'application/javascript': 'text/javascript',
      'application/x-python-code': 'text/x-python', 'text/yaml': 'application/yaml', 'application/x-yaml': 'application/yaml', 'text/xml': 'application/xml' };
    const normalized = aliases[declared] || declared;
    const expectedMime = fileMimes[suffix] || Object.values(fileMimes).find(mime => mime === (aliases[asset.mimeType] || asset.mimeType)) ||
      Object.values(fileMimes).find(mime => mime === normalized);
    if (asset.kind === 'image' || /^image\//i.test(asset.mimeType || '') || !expectedMime) return imageInfo(bytes, declared);
    const sourceMime = aliases[asset.mimeType] || asset.mimeType;
    const officeType = ['docx', 'xlsx', 'pptx'].some(key => fileMimes[key] === expectedMime);
    if (sourceMime && !['application/octet-stream', 'binary/octet-stream', expectedMime].includes(sourceMime) && !(officeType && sourceMime === 'application/zip') && !(sourceMime === 'text/plain' && !['zip', 'pdf', 'docx', 'xlsx', 'pptx'].includes(suffix))) {
      fail('ASSET_VARIANT', '附件格式与来源信息不一致，未保存。');
    }
    const binaryType = ['application/zip', 'application/pdf', ...['docx', 'xlsx', 'pptx'].map(key => fileMimes[key])].includes(expectedMime);
    const compatibleText = normalized === 'text/plain' && !binaryType;
    const officeZip = officeType && normalized === 'application/zip';
    if (!bytes.length || (normalized && !['application/octet-stream', 'binary/octet-stream', expectedMime].includes(normalized) && !compatibleText && !officeZip)) {
      fail('ASSET_FORMAT', '附件类型与来源信息不一致，未保存。');
    }
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
    if (/^(?:<!doctype\s+html|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/i.test(head)) fail('ASSET_FORMAT', '附件请求返回了网页，未保存。');
    if (asset.size && asset.size !== bytes.byteLength) fail('ASSET_VARIANT', '附件大小与来源信息不一致，未保存。');
    // Final byte/signature/container validation runs in the extension before a
    // single byte is written. The isolated probe only returns a bounded payload.
    return { mime: expectedMime, width: null, height: null };
  }
  async function download(value, token, via) {
    let url = safeURL(value, { blob: true }).href;
    const seen = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (seen.has(url)) fail('ASSET_REDIRECT', '附件地址发生循环跳转。');
      seen.add(url);
      const result = await requestData(url, token, maximum, false,
        (via === 'library-download' || via === 'file-download' || via === 'interpreter-download') && attempt === 0);
      let next = result.redirect;
      const jsonFile = /\.json$/i.test(asset.fileName || '') || asset.mimeType === 'application/json';
      const entryRoute = url === interpreterDownloadURL || url === fileDownloadURL || (asset.libraryFileId && url === `https://chatgpt.com/api/library/files/${asset.libraryFileId}/download`);
      if (result.mime === 'application/json' && !(jsonFile && (result.attachment || !entryRoute))) {
        let payload; try { payload = JSON.parse(new TextDecoder().decode(result.bytes)); } catch { fail('ASSET_PROTOCOL', '附件下载响应无法解析。'); }
        const links = record(payload) ? ['download_url', 'downloadUrl', 'download_uri', 'downloadUri', 'url'].map(key => payload[key]).filter(value => typeof value === 'string') : [];
        const unique = [...new Set(links)];
        if (unique.length !== 1) fail('ASSET_PROTOCOL', '附件下载响应结构尚未支持，等待适配。');
        next = unique[0];
      }
      if (next) { url = safeURL(next, { interpreterResult: url === interpreterDownloadURL }).href; continue; }
      const info = contentInfo(result.bytes, result.mime);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result.bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (asset.expectedHash && sha256 !== asset.expectedHash) fail('ASSET_HASH_MISMATCH', '附件内容哈希与已知原图不一致。');
      const chunks = [];
      for (let offset = 0; offset < result.bytes.length; offset += 49152) {
        const chunk = result.bytes.subarray(offset, offset + 49152);
        let binary = ''; for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
        chunks.push(btoa(binary));
      }
      return { chunks, byteLength: result.bytes.byteLength, sha256, mimeType: info.mime,
        width: info.width, height: info.height, via,
        quality: asset.expectedHash || (asset.size && !info.mime.startsWith('image/')) || (asset.size && asset.width && asset.height && info.width === asset.width && info.height === asset.height) ? 'original' : 'unverified' };
    }
    fail('ASSET_REDIRECT', '附件跳转次数超过限制，等待适配。');
  }
  async function attemptDownload(value, token, via) {
    currentDiagnostic = { route: via, detectedType: 'not-read' };
    try { return await download(value, token, via); }
    catch (error) {
      const code = safeDiagnosticCode(error?.code) || (error?.name === 'AbortError' ? 'ASSET_TIMEOUT' : 'ASSET_NETWORK');
      if (diagnostics.length < 5) {
        const item = { ...currentDiagnostic, code };
        if (['format_image_type_unsupported', 'format_image_header_unknown', 'format_image_mime_mismatch'].includes(error?.reason)) item.reason = error.reason;
        diagnostics.push(item);
      }
      throw error;
    } finally { currentDiagnostic = null; }
  }
  function visibleImages() {
    if (typeof document === 'undefined') return [];
    const ids = [asset.fileId, asset.libraryFileId].filter(Boolean);
    const exactId = value => typeof value === 'string' && ids.some(id => value === id || value === `sediment://${id}` ||
      value.split(/[/?#=&\s]/).includes(id));
    const matches = element => {
      const values = ['data-file-id', 'data-library-file-id', 'data-asset-id', 'data-asset-pointer'].map(key => element.getAttribute?.(key));
      values.push(element.src, element.currentSrc, element.href);
      return values.some(exactId);
    };
    const urls = [];
    for (const img of Array.from(document.querySelectorAll('img')).slice(0, 500)) {
      if (!img.getClientRects?.().length || !img.complete || !(img.naturalWidth > 0)) continue;
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(img); if (style.display === 'none' || style.visibility === 'hidden') continue;
      }
      // Do not match arbitrary conversation-level ancestors: they can contain
      // another attachment. Require this image or its direct wrapper to own ID.
      if (!matches(img) && !(img.parentElement && matches(img.parentElement))) continue;
      if (asset.width && img.naturalWidth < asset.width) continue;
      if (asset.height && img.naturalHeight < asset.height) continue;
      const url = img.currentSrc || img.src;
      if (typeof url === 'string') urls.push(url);
    }
    return [...new Set(urls)].slice(0, 4);
  }
  try {
    if (location.origin !== 'https://chatgpt.com') fail('ORIGIN', '请在已登录的 ChatGPT 页面中读取附件。');
    if (!record(request) || !/^acct-[a-f0-9]{24}$/.test(request.expectedAccountKey || '') || !record(request.asset)) fail('ASSET_INPUT', '附件请求缺少有效账号和资源信息。', 'unavailable');
    if (request.requestId !== undefined && !requestId) fail('ASSET_INPUT', '采集请求标识无效。', 'unavailable');
    if (requestId) {
      const key = '__aiMemoryCollectorRequestsV1';
      registry = globalThis[key] instanceof Map ? globalThis[key] : (globalThis[key] = new Map());
      scope = { accountKey: request.expectedAccountKey, createdAt: Date.now(),
        cancelled: registry.get(requestId)?.cancelled === true, controller: null };
      registry.set(requestId, scope);
      checkCancelled();
    }
    asset = request.asset; maximum = request.maxBytes;
    if ((request.conversationId != null && (typeof request.conversationId !== 'string' || !conversationPattern.test(request.conversationId))) ||
        (!asset.fileId && !asset.libraryFileId && !asset.retrievalURL && !asset.sandboxPath) || (asset.fileId && !filePattern.test(asset.fileId)) ||
        (asset.libraryFileId && !libraryPattern.test(asset.libraryFileId)) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > maxAllowed ||
        (asset.expectedHash && !/^[a-f0-9]{64}$/.test(asset.expectedHash)) ||
        (asset.messageId != null && (typeof asset.messageId !== 'string' || !conversationPattern.test(asset.messageId))) ||
        (asset.sandboxPath && (typeof asset.sandboxPath !== 'string' || !asset.sandboxPath.startsWith('/') || asset.sandboxPath.startsWith('//') ||
          /[\\\u0000-\u001f\u007f?#]/.test(asset.sandboxPath) || asset.sandboxPath.split('/').some(part => part === '.' || part === '..'))) ||
        ['size', 'width', 'height'].some(key => asset[key] != null && (!Number.isSafeInteger(asset[key]) || asset[key] < 1))) {
      fail('ASSET_INPUT', '附件请求参数不合法。', 'unavailable');
    }
    if (asset.size > maximum) fail('ASSET_TOO_LARGE', '附件超过本次自动获取的大小上限。');
    if (request.allowFileDownload === true && asset.fileId && request.conversationId) {
      fileDownloadURL = `https://chatgpt.com/backend-api/files/download/${asset.fileId}?conversation_id=${request.conversationId}&download_intent=false&inline=true`;
    }
    if (request.allowFileDownload === true && asset.sandboxPath && asset.messageId && request.conversationId) {
      const entry = new URL(`https://chatgpt.com/backend-api/conversation/${request.conversationId}/interpreter/download`);
      entry.searchParams.set('download_intent', 'true');
      entry.searchParams.set('message_id', asset.messageId);
      entry.searchParams.set('sandbox_path', asset.sandboxPath);
      interpreterDownloadURL = entry.href;
    }
    // The transient URL comes from the captured attachment, never from a guessed endpoint.
    if (asset.retrievalURL) safeURL(asset.retrievalURL, { blob: true });
    const before = await session();
    if (before.accountKey !== request.expectedAccountKey) fail('ACCOUNT_CHANGED', '当前账号与附件来源账号不一致。');
    let binary, lastError;
    if (asset.retrievalURL) {
      try { binary = await attemptDownload(asset.retrievalURL, before.token, 'captured-resource'); }
      catch (error) { lastError = nextSource(error); }
    }
    if (!binary && request.allowLibraryDownload === true && asset.libraryFileId) {
      try { binary = await attemptDownload(`https://chatgpt.com/api/library/files/${asset.libraryFileId}/download`, before.token, 'library-download'); }
      catch (error) { lastError = nextSource(error); }
    }
    if (!binary && interpreterDownloadURL) {
      try { binary = await attemptDownload(interpreterDownloadURL, before.token, 'interpreter-download'); }
      catch (error) { lastError = nextSource(error); }
    }
    if (!binary && fileDownloadURL) {
      try { binary = await attemptDownload(fileDownloadURL, before.token, 'file-download'); }
      catch (error) { lastError = nextSource(error); }
    }
    if (!binary) {
      for (const url of visibleImages()) {
        try { binary = await attemptDownload(url, before.token, 'visible-image'); break; }
        catch (error) { lastError = nextSource(error); }
      }
    }
    const after = await session();
    if (after.accountKey !== before.accountKey) fail('ACCOUNT_CHANGED', '读取附件期间账号发生变化，结果已丢弃。');
    if (!binary) {
      if (lastError) throw lastError;
      fail('ASSET_PENDING', '未找到可确认归属的附件下载来源。请重新采集原对话，补齐来源消息、文件路径或平台文件标识后重试。');
    }
    return { ok: true, accountKey: before.accountKey, binary };
  } catch (error) {
    const known = /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '');
    return { ok: false, error: { code: known ? error.code : error?.name === 'AbortError' ? 'ASSET_TIMEOUT' : 'ASSET_NETWORK',
      state: error?.state === 'unavailable' ? 'unavailable' : 'pending',
      ...(diagnostics.length ? { diagnostics } : {}),
      ...(['HTTP_429', 'HTTP_503'].includes(error?.code) && Number.isFinite(error.retryAfterMs)
        ? { retryAfterMs: Math.min(86_400_000, Math.max(0, Math.ceil(error.retryAfterMs))) } : {}),
      message: known ? error.message : '附件读取未完成，请检查当前登录状态、站点权限或网络后重试。' } };
  } finally { if (registry && registry.get(requestId) === scope) registry.delete(requestId); }
}
