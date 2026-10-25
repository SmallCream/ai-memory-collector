// Exact internal error vocabulary only. Never expose raw error messages,
// response bodies, headers, download URLs or credentials through diagnostics.
const definitions = [
  ['ASSET_FORMAT', 'format_html_response', '下载入口返回了网页内容，未作为附件保存。',
    ['附件请求返回了网页，未作为附件保存。', '附件请求返回了网页，未保存。', '图片请求返回了网页，未作为图片保存。']],
  ['ASSET_FORMAT', 'format_image_unconfirmed', '图片文件头无法识别，或响应类型与文件内容不一致。',
    ['附件类型或文件头无法确认，未保存为原图。', '图片类型或文件头无法确认，未保存为原图。']],
  ['ASSET_FORMAT', 'format_image_header_unknown', '响应中未识别到受支持的图片文件头，未保存。',
    ['响应中未识别到受支持的图片文件头，未保存。']],
  ['ASSET_FORMAT', 'format_image_type_unsupported', '响应是当前下载器尚不支持的图片类型，未保存。',
    ['响应是当前下载器尚不支持的图片类型，未保存。']],
  ['ASSET_FORMAT', 'format_image_mime_mismatch', '已识别图片文件头，但响应声明的类型与图片内容不一致，未保存。',
    ['已识别图片文件头，但响应声明的类型与图片内容不一致，未保存。']],
  ['ASSET_FORMAT', 'format_response_unconfirmed', '返回内容为空，或响应类型与来源信息不一致。',
    ['附件类型与来源信息不一致，未保存。']],
  ['ASSET_FORMAT', 'format_content_validation_failed', '附件内容未通过格式校验，未保存。',
    ['附件类型或文件内容无法确认，未保存。']],
  ['ASSET_FORMAT', 'format_content_unsupported', '附件类型尚不支持，或内容未通过校验；来源已保留。',
    ['返回内容不是受支持的原始附件，已保留来源等待补采。']],
  ['ASSET_FORMAT', 'format_embedded_encoding_invalid', '内嵌附件编码无效，未保存。',
    ['内嵌附件格式不正确。', '内嵌图片格式不正确。']],
  ['ASSET_INPUT', 'input_source_missing', '缺少附件来源信息。', ['缺少附件来源信息。', '缺少图片来源信息。']],
  ['ASSET_INPUT', 'input_message_invalid', '附件来源消息标识不合法。', ['附件来源消息标识不合法。']],
  ['ASSET_INPUT', 'input_source_invalid', '附件来源标识缺失、不合法或不一致。', ['附件来源标识不合法或不一致。', '图片来源标识不合法或不一致。']],
  ['ASSET_INPUT', 'input_hash_invalid', '附件哈希格式无效。', ['附件哈希格式无效。', '图片哈希格式无效。']],
  ['ASSET_INPUT', 'input_limit_invalid', '附件大小上限配置无效，应介于 1 字节和 16 MiB。',
    ['附件大小上限必须介于 1 字节和 16 MiB。', '图片大小上限必须介于 1 字节和 16 MiB。']],
  ['ASSET_INPUT', 'input_conversation_invalid', '附件所属对话标识不合法。', ['附件所属对话标识不合法。', '图片所属对话标识不合法。']],
  ['ASSET_INPUT', 'input_context_invalid', '附件请求缺少有效账号和资源信息。', ['附件请求缺少有效账号和资源信息。', '图片请求缺少有效账号和资源信息。']],
  ['ASSET_INPUT', 'input_parameters_invalid', '附件请求参数不合法。', ['附件请求参数不合法。', '图片请求参数不合法。']],
];
const byReason = new Map(definitions.map(([code, reason, message]) => [reason, { code, message }]));
const byError = new Map(definitions.flatMap(([code, reason, message, sources]) =>
  sources.map(source => [`${code}\0${source}`, { reason, message }])));

/** Interpret existing queue errors without copying any unrecognized text. */
export function assetFailureReason(error) {
  if (typeof error?.code !== 'string' || typeof error?.message !== 'string') return null;
  const found = byError.get(`${error.code}\0${error.message}`);
  return found ? { ...found } : null;
}

/** UI lookup also checks the reason belongs to the displayed error code. */
export function assetFailureDiagnosticMessage(error) {
  if (typeof error?.reason !== 'string') return null;
  const found = byReason.get(error.reason);
  return found && found.code === error.code ? found.message : null;
}

const routes = new Set(['captured-resource', 'library-download', 'interpreter-download', 'file-download', 'visible-image']);
const mimeTypes = new Set(['missing', 'unknown', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/avif', 'image/heif', 'image/heic', 'image/svg+xml', 'image/bmp', 'image/tiff',
  'application/octet-stream', 'binary/octet-stream', 'application/json', 'application/problem+json',
  'text/html', 'text/plain', 'application/zip', 'application/x-zip-compressed', 'application/pdf']);
const detectedTypes = new Set(['not-read', 'empty', 'unknown', 'png', 'jpeg', 'gif', 'webp',
  'avif', 'heif', 'bmp', 'tiff', 'svg', 'html', 'json', 'zip', 'pdf']);
const diagnosticCodes = new Set(['ASSET_FORMAT', 'ASSET_PROTOCOL', 'ASSET_URL', 'ASSET_REDIRECT',
  'ASSET_NETWORK', 'ASSET_TIMEOUT', 'ASSET_STREAM', 'ASSET_TOO_LARGE', 'ASSET_VARIANT',
  'ASSET_HASH_MISMATCH', 'ASSET_PENDING', 'COLLECTION_PAUSED']);

/** Only enums and bounded numbers cross the page, storage and UI boundaries. */
export function sanitizeAssetFailureDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const entry of value.slice(0, 5)) {
    if (!entry || typeof entry !== 'object' || !routes.has(entry.route)) continue;
    const item = { route: entry.route };
    if (diagnosticCodes.has(entry.code) || typeof entry.code === 'string' && /^HTTP_[1-5]\d{2}$/.test(entry.code)) item.code = entry.code;
    if (Number.isSafeInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) item.httpStatus = entry.httpStatus;
    if (typeof entry.mimeType === 'string') item.mimeType = mimeTypes.has(entry.mimeType) ? entry.mimeType : 'unknown';
    if (detectedTypes.has(entry.detectedType)) item.detectedType = entry.detectedType;
    if (Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0 && entry.byteLength <= 16 * 1024 * 1024) item.byteLength = entry.byteLength;
    const reason = byReason.get(entry.reason);
    if (reason && reason.code === item.code) item.reason = entry.reason;
    output.push(item);
  }
  return output;
}

/** Fixed Chinese labels; never display response text, raw headers or URLs. */
export function assetFailureAttemptSummaries(value) {
  const names = { 'captured-resource': '对话资源', 'library-download': '文件库入口',
    'interpreter-download': '生成文件入口', 'file-download': '文件下载入口', 'visible-image': '页面原图' };
  const signatures = { 'not-read': '未读取', empty: '空内容', unknown: '未知',
    png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', avif: 'AVIF', heif: 'HEIF',
    bmp: 'BMP', tiff: 'TIFF', svg: 'SVG', html: '网页', json: 'JSON', zip: 'ZIP', pdf: 'PDF' };
  return sanitizeAssetFailureDiagnostics(value).map(item => [names[item.route],
    item.httpStatus ? `HTTP ${item.httpStatus}` : '', item.code || '',
    item.mimeType ? `声明：${item.mimeType === 'missing' ? '未声明' : item.mimeType === 'unknown' ? '其他类型' : item.mimeType}` : '',
    item.detectedType ? `文件头：${signatures[item.detectedType]}` : '',
    item.byteLength !== undefined ? `${item.byteLength} 字节` : ''].filter(Boolean).join(' · '));
}
