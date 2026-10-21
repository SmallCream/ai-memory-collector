/** Experimental read-only image retrieval. No download URL or session credential leaves the page. */
export const DEFAULT_ASSET_LIMIT = 16 * 1024 * 1024;
const ACCOUNT = /^acct-[a-f0-9]{24}$/;
const FILE = /^file[-_][A-Za-z0-9_-]{1,160}$/;
const LIBRARY = /^libfile_[A-Za-z0-9_-]{1,160}$/;

export class ChatGPTAssetError extends Error {
  constructor(code, message, state = 'pending') {
    super(message); this.name = 'ChatGPTAssetError'; this.code = code; this.state = state;
  }
}
const failure = (code, message, state) => { throw new ChatGPTAssetError(code, message, state); };
const isSource = value => { try { return new URL(value).origin === 'https://chatgpt.com'; } catch { return false; } };

function descriptor(input) {
  if (!input || typeof input !== 'object') failure('ASSET_INPUT', '缺少图片来源信息。', 'unavailable');
  const reference = input.sourceRef ?? input.assetPointer ?? input.asset_pointer;
  const referenceId = typeof reference === 'string' ? /^(?:sediment|file-service):\/\/(file[-_][A-Za-z0-9_-]+)$/.exec(reference)?.[1] : undefined;
  // Manifest `id` is a content-independent SHA-256 key, not a platform file ID.
  const fileId = input.fileId ?? input.sourceId ?? input.retrieval?.fileId ?? referenceId ?? (FILE.test(input.id || '') ? input.id : undefined);
  const libraryFileId = input.libraryFileId ?? input.library_file_id ?? input.retrieval?.libraryFileId ??
    (typeof reference === 'string' ? /^library:(libfile_[A-Za-z0-9_-]+)$/.exec(reference)?.[1] : undefined);
  const retrievalURL = typeof input.retrieval?.url === 'string' && /^(?:https:|blob:)/.test(input.retrieval.url) ? input.retrieval.url : null;
  if ((fileId !== undefined && !FILE.test(fileId)) || (libraryFileId !== undefined && !LIBRARY.test(libraryFileId)) ||
      (!fileId && !libraryFileId && !retrievalURL) || (referenceId && referenceId !== fileId)) {
    failure('ASSET_INPUT', '图片来源标识不合法或不一致。', 'unavailable');
  }
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const expectedHash = input.sha256 ?? input.contentHash;
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) failure('ASSET_INPUT', '图片哈希格式无效。', 'unavailable');
  return { fileId: fileId || null, libraryFileId: libraryFileId || null, retrievalURL,
    fileName: String(input.fileName ?? input.name ?? '').slice(0, 200),
    mimeType: typeof (input.mimeType ?? input.mime_type) === 'string' ? (input.mimeType ?? input.mime_type).toLowerCase() : null,
    size: positive(input.expectedSize ?? input.size ?? input.sizeBytes ?? input.size_bytes), width: positive(input.width), height: positive(input.height),
    expectedHash: expectedHash || null };
}

/**
 * Library download remains opt-in until verified in the installed browser.
 * Only the observed /api/library/files/{library_file_id}/download route is tried.
 * DOM fallback requires an exact matching resource ID; filenames are not ownership evidence.
 */
export function createChatGPTAssetResolver(browser, { allowLibraryDownload = false, maxBytes = DEFAULT_ASSET_LIMIT } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_ASSET_LIMIT) {
    failure('ASSET_INPUT', '图片大小上限必须介于 1 字节和 16 MiB。', 'unavailable');
  }
  async function resolve({ tabId, account, asset }) {
    const api = browser ?? globalThis.chrome;
    if (!Number.isSafeInteger(tabId) || tabId < 0) failure('TAB_REQUIRED', '请打开对应账号的 ChatGPT 页面。');
    const accountKey = typeof account === 'string' ? account : account?.accountKey;
    if (!ACCOUNT.test(accountKey || '') || (account?.platform && account.platform !== 'chatgpt')) {
      failure('IDENTITY', '缺少经过核验的 ChatGPT 账号。');
    }
    const source = descriptor(asset);
    if (source.size > maxBytes) failure('ASSET_TOO_LARGE', '图片超过本次自动获取的大小上限。');
    async function tabCheck() {
      let tab;
      try { tab = await api.tabs.get(tabId); } catch { failure('TAB_CLOSED', '图片来源标签页已关闭。'); }
      if (!isSource(tab.url) || (tab.pendingUrl && !isSource(tab.pendingUrl))) failure('TAB_CHANGED', '图片来源页面已离开 ChatGPT。');
    }
    await tabCheck();
    let result;
    try {
      const values = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED',
        func: probeChatGPTAsset, args: [{ expectedAccountKey: accountKey, asset: source,
          allowLibraryDownload: allowLibraryDownload === true, maxBytes }] });
      result = values?.find(item => item.frameId === 0)?.result;
    } catch { failure('TAB_UNAVAILABLE', '无法读取图片来源页面，请检查站点权限和登录状态。'); }
    await tabCheck();
    if (!result?.ok) {
      const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(result?.error?.code || '') ? result.error.code : 'ASSET_PENDING';
      failure(code, typeof result?.error?.message === 'string' ? result.error.message : '图片尚未取得，等待补采。',
        result?.error?.state === 'unavailable' ? 'unavailable' : 'pending');
    }
    if (result.accountKey !== accountKey) failure('ACCOUNT_CHANGED', '图片采集期间账号发生变化，结果已丢弃。');
    const value = result.binary;
    if (!value || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > maxBytes ||
        !Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > Math.ceil(maxBytes / 49152) ||
        !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.mimeType) ||
        !['original', 'unverified'].includes(value.quality)) failure('ASSET_RESPONSE', '图片返回格式无效，未保存。');
    const bytes = new Uint8Array(value.byteLength);
    let offset = 0;
    try {
      for (const chunk of value.chunks) {
        if (typeof chunk !== 'string' || chunk.length > 65536 || chunk.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) throw new Error();
        const decoded = atob(chunk);
        if (offset + decoded.length > bytes.length) throw new Error();
        for (let i = 0; i < decoded.length; i++) bytes[offset++] = decoded.charCodeAt(i);
      }
    } catch { failure('ASSET_RESPONSE', '图片传输数据无效，未保存。'); }
    if (offset !== bytes.length) failure('ASSET_RESPONSE', '图片传输不完整，等待重试。');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (sha256 !== value.sha256 || (source.expectedHash && sha256 !== source.expectedHash)) failure('ASSET_HASH_MISMATCH', '图片内容校验失败，未保存。');
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[value.mimeType];
    let fileName = source.fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    if (!fileName) fileName = source.fileId || source.libraryFileId || `image-${sha256.slice(0, 16)}`;
    if (!fileName.toLowerCase().endsWith(extension)) fileName += extension;
    return { bytes, mimeType: value.mimeType, fileName, quality: value.quality, sha256,
      width: value.width ?? null, height: value.height ?? null, byteLength: bytes.byteLength, via: value.via };
  }
  return Object.freeze({ resolve });
}

export async function resolveChatGPTAsset({ browser, allowLibraryDownload = false, maxBytes = DEFAULT_ASSET_LIMIT, ...request }) {
  return createChatGPTAssetResolver(browser, { allowLibraryDownload, maxBytes }).resolve(request);
}

/**
 * A successful anonymous GET establishes availability now, not permanence.
 * Missing permission, CORS failures, redirects and unrecognized content stay unknown;
 * callers must not silently turn those results into managed/LFS attachments.
 * This helper does not request permissions or retain a copy of the image.
 */
export async function validateExternalAsset({ url, browser = globalThis.chrome, fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_ASSET_LIMIT } = {}) {
  const unknown = reason => ({ status: 'unknown', reason });
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
    if (!response.ok) return unknown(response.status === 401 || response.status === 403 ? 'authentication-required' : 'http-error');
    const declaredSize = response.headers.get('content-length');
    if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > maxBytes) return unknown('too-large');
    const declaredMime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['', 'application/octet-stream', 'binary/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(declaredMime)) return unknown('unsupported-content');
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
    if (!mimeType || (declaredMime && !['application/octet-stream', 'binary/octet-stream', mimeType].includes(declaredMime))) return unknown('content-mismatch');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    return { status: 'external', verifiedAt: new Date().toISOString(), mimeType, byteLength, sha256 };
  } catch { return unknown(controller.signal.aborted ? 'timeout' : 'network-or-cors'); }
  finally { clearTimeout(timer); controller.abort(); try { reader?.releaseLock(); } catch {} }
}

// Serialized by executeScript. Keep all helpers and constants inside this function.
export async function probeChatGPTAsset(request) {
  const fail = (code, message, state = 'pending') => { throw Object.assign(new Error(message), { code, state }); };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const maxAllowed = 16 * 1024 * 1024;
  const filePattern = /^file[-_][A-Za-z0-9_-]{1,160}$/;
  const libraryPattern = /^libfile_[A-Za-z0-9_-]{1,160}$/;
  let asset, maximum;
  function safeURL(value, { blob = false } = {}) {
    let url; try { url = new URL(value, 'https://chatgpt.com'); } catch { fail('ASSET_URL', '图片地址无法识别。'); }
    if (blob && url.protocol === 'blob:' && /^blob:https:\/\/chatgpt\.com\/[A-Za-z0-9-]+$/.test(url.href)) return url;
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) fail('ASSET_URL', '图片地址不在允许的来源范围内。');
    const host = url.hostname;
    const cdn = host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com') ||
      /^oai(?:sdmntpr|sdsorpr|dalleapi)[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host) ||
      /^oaisdmntpr[a-z0-9-]*aws\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
    if (host !== 'chatgpt.com' && !cdn) fail('ASSET_URL', '图片下载目标尚未支持，等待适配。');
    if (host === 'chatgpt.com') {
      const exactLibrary = asset.libraryFileId && url.pathname === `/api/library/files/${asset.libraryFileId}/download`;
      const observedFile = url.pathname.startsWith('/backend-api/files/') &&
        [asset.fileId, asset.libraryFileId].filter(Boolean).some(id => url.pathname.split('/').includes(id));
      if (!exactLibrary && !observedFile) fail('ASSET_URL', '图片下载地址与当前资源不匹配。');
    }
    return url;
  }
  async function bytesOf(response, limit) {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) fail('ASSET_TOO_LARGE', '图片响应超过大小上限。');
    const reader = response.body?.getReader();
    if (!reader) fail('ASSET_STREAM', '当前环境不能安全读取有界图片响应。');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('ASSET_TOO_LARGE', '图片响应超过大小上限。'); }
      chunks.push(value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  async function requestData(url, token, limit, sessionRequest = false) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const sameOrigin = new URL(url, 'https://chatgpt.com').origin === 'https://chatgpt.com' && !String(url).startsWith('blob:');
      const response = await fetch(url, { method: 'GET', credentials: sameOrigin ? 'include' : 'omit',
        cache: 'no-store', redirect: sessionRequest ? 'error' : 'manual', referrerPolicy: 'no-referrer',
        headers: token && sameOrigin ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      if (response.type === 'opaqueredirect') fail('ASSET_REDIRECT', '网页返回了不可检查的跳转，请等待资源适配或打开原图补采。');
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) fail('ASSET_REDIRECT', '图片下载跳转无法解析。');
        return { redirect: new URL(location, url).href };
      }
      if (!response.ok) fail(`HTTP_${response.status}`, response.status === 429 ? '图片请求受到限流，请稍后重试。' :
        response.status === 401 || response.status === 403 ? '图片暂时无法访问，请检查登录和访问权限。' : '图片资源暂时不可用，等待补采。');
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (mime === 'text/html') fail('ASSET_FORMAT', '图片请求返回了网页，未作为图片保存。');
      return { bytes: await bytesOf(response, mime === 'application/json' ? Math.min(limit, 1024 * 1024) : limit), mime };
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function session() {
    const response = await requestData('https://chatgpt.com/api/auth/session', null, 1024 * 1024, true);
    if (response.mime !== 'application/json') fail('IDENTITY', '无法核验当前图片所属账号。');
    let value; try { value = JSON.parse(new TextDecoder().decode(response.bytes)); } catch { fail('IDENTITY', '无法核验当前图片所属账号。'); }
    if (!record(value?.user) || typeof value.user.id !== 'string' || !value.user.id || typeof value.accessToken !== 'string' || !value.accessToken) {
      fail('IDENTITY', '请先登录 ChatGPT，再补采图片。');
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
    if (!mime || (declared && !['application/octet-stream', 'binary/octet-stream', mime].includes(declared))) {
      fail('ASSET_FORMAT', '图片类型或文件头无法确认，未保存为原图。');
    }
    if ((width !== null && (!width || !height || width * height > 100000000)) ||
        (asset.width && width !== null && asset.width !== width) || (asset.height && height !== null && asset.height !== height)) {
      fail('ASSET_VARIANT', '取得的图片尺寸与原图不一致，等待获取原图。');
    }
    if (asset.mimeType && asset.mimeType !== mime) fail('ASSET_VARIANT', '取得的图片格式与来源信息不一致。');
    if (asset.size && asset.size !== bytes.byteLength) fail('ASSET_VARIANT', '取得的图片大小与原始附件不一致，等待获取原图。');
    return { mime, width, height };
  }
  async function download(value, token, via) {
    let url = safeURL(value, { blob: true }).href;
    const seen = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (seen.has(url)) fail('ASSET_REDIRECT', '图片地址发生循环跳转。');
      seen.add(url);
      const result = await requestData(url, token, maximum);
      let next = result.redirect;
      if (result.mime === 'application/json') {
        let payload; try { payload = JSON.parse(new TextDecoder().decode(result.bytes)); } catch { fail('ASSET_PROTOCOL', '图片下载响应无法解析。'); }
        const links = record(payload) ? ['download_url', 'downloadUrl', 'download_uri', 'downloadUri', 'url'].map(key => payload[key]).filter(value => typeof value === 'string') : [];
        const unique = [...new Set(links)];
        if (unique.length !== 1) fail('ASSET_PROTOCOL', '图片下载响应结构尚未支持，等待适配。');
        next = unique[0];
      }
      if (next) { url = safeURL(next).href; continue; }
      const info = imageInfo(result.bytes, result.mime);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result.bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (asset.expectedHash && sha256 !== asset.expectedHash) fail('ASSET_HASH_MISMATCH', '图片内容哈希与已知原图不一致。');
      const chunks = [];
      for (let offset = 0; offset < result.bytes.length; offset += 49152) {
        const chunk = result.bytes.subarray(offset, offset + 49152);
        let binary = ''; for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
        chunks.push(btoa(binary));
      }
      return { chunks, byteLength: result.bytes.byteLength, sha256, mimeType: info.mime,
        width: info.width, height: info.height, via,
        quality: asset.expectedHash || (asset.size && asset.width && asset.height && info.width === asset.width && info.height === asset.height) ? 'original' : 'unverified' };
    }
    fail('ASSET_REDIRECT', '图片跳转次数超过限制，等待适配。');
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
    if (location.origin !== 'https://chatgpt.com') fail('ORIGIN', '请在已登录的 ChatGPT 页面中读取图片。');
    if (!record(request) || !/^acct-[a-f0-9]{24}$/.test(request.expectedAccountKey || '') || !record(request.asset)) fail('ASSET_INPUT', '图片请求缺少有效账号和资源信息。', 'unavailable');
    asset = request.asset; maximum = request.maxBytes;
    if ((!asset.fileId && !asset.libraryFileId && !asset.retrievalURL) || (asset.fileId && !filePattern.test(asset.fileId)) ||
        (asset.libraryFileId && !libraryPattern.test(asset.libraryFileId)) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > maxAllowed ||
        (asset.expectedHash && !/^[a-f0-9]{64}$/.test(asset.expectedHash)) ||
        ['size', 'width', 'height'].some(key => asset[key] != null && (!Number.isSafeInteger(asset[key]) || asset[key] < 1))) {
      fail('ASSET_INPUT', '图片请求参数不合法。', 'unavailable');
    }
    if (asset.size > maximum) fail('ASSET_TOO_LARGE', '图片超过本次自动获取的大小上限。');
    // The transient URL comes from the captured attachment, never from a guessed endpoint.
    if (asset.retrievalURL) safeURL(asset.retrievalURL, { blob: true });
    const before = await session();
    if (before.accountKey !== request.expectedAccountKey) fail('ACCOUNT_CHANGED', '当前账号与图片来源账号不一致。');
    let binary, lastError;
    if (asset.retrievalURL) {
      try { binary = await download(asset.retrievalURL, before.token, 'captured-resource'); }
      catch (error) { lastError = error; }
    }
    if (!binary && request.allowLibraryDownload === true && asset.libraryFileId) {
      try { binary = await download(`https://chatgpt.com/api/library/files/${asset.libraryFileId}/download`, before.token, 'library-download'); }
      catch (error) { lastError = error; }
    }
    if (!binary) {
      for (const url of visibleImages()) {
        try { binary = await download(url, before.token, 'visible-image'); break; }
        catch (error) { lastError = error; }
      }
    }
    const after = await session();
    if (after.accountKey !== before.accountKey) fail('ACCOUNT_CHANGED', '读取图片期间账号发生变化，结果已丢弃。');
    if (!binary) {
      if (lastError) throw lastError;
      fail('ASSET_PENDING', '未找到可确认归属的原图。请打开对应图片后补采，或等待资源接口适配。');
    }
    return { ok: true, accountKey: before.accountKey, binary };
  } catch (error) {
    const known = /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '');
    return { ok: false, error: { code: known ? error.code : error?.name === 'AbortError' ? 'ASSET_TIMEOUT' : 'ASSET_NETWORK',
      state: error?.state === 'unavailable' ? 'unavailable' : 'pending',
      message: known ? error.message : '图片读取未完成，请检查当前登录状态、站点权限或网络后重试。' } };
  }
}
