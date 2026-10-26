// Exact internal error vocabulary only. Never expose raw error messages,
// response bodies, headers, download URLs or credentials through diagnostics.
const externalDefinitions = [
  ['permission-required', 'external_permission_required', '尚未授权检测此外链域名；原链接已保留，文件未保存到本地。'],
  ['redirect', 'external_redirect_unresolved', '外链返回了跳转，当前验证器未继续访问目标；原链接已保留，文件未保存到本地。'],
  ['authentication-required', 'external_authentication_required', '外链要求登录或拒绝匿名访问；未转发账号凭据，原链接已保留。'],
  ['http-not-found', 'external_http_not_found', '外链返回 HTTP 404，当前地址未提供文件；不能据此判断文件已永久失效，原链接已保留。'],
  ['http-error', 'external_http_error', '外链服务器返回了非成功状态；原链接已保留，文件未保存到本地。'],
  ['html-response', 'external_html_response', '外链返回了网页内容，未当作附件保存；原链接已保留。'],
  ['unsupported-content', 'external_content_unsupported', '外链返回的内容类型尚不支持验证；原链接已保留，文件未保存到本地。'],
  ['content-mismatch', 'external_content_mismatch', '外链返回的内容未通过附件格式校验；原链接已保留，文件未保存到本地。'],
  ['timeout', 'external_timeout', '外链验证超时；原链接已保留，文件未保存到本地。'],
  ['network-or-cors', 'external_network_or_cors', '外链请求未完成，可能是网络或跨域访问限制；原链接已保留。'],
  ['too-large', 'external_too_large', '外链内容超过自动验证的大小上限；原链接已保留，文件未保存到本地。'],
  ['empty-content', 'external_empty_content', '外链返回了空内容；原链接已保留，文件未保存到本地。'],
  ['stream-unavailable', 'external_stream_unavailable', '外链响应无法按大小上限读取；原链接已保留，文件未保存到本地。'],
  ['temporary-url', 'external_temporary_url', '外链包含临时访问参数，未按公开永久链接验证；来源记录已保留。'],
  ['invalid-url', 'external_invalid_url', '外链地址格式无法识别；来源记录已保留，未发起文件获取。'],
  ['unsupported-url', 'external_unsupported_url', '外链协议或地址形式不受支持；来源记录已保留，未发起文件获取。'],
  ['non-public-host', 'external_non_public_host', '外链目标不属于允许自动访问的公网域名；来源记录已保留。'],
  ['invalid-limit', 'external_invalid_limit', '外链验证的大小上限配置无效；原链接已保留，未发起文件获取。'],
  ['unknown', 'external_unknown', '外链暂时未完成验证；原链接已保留，尚不能确认是否可以获取文件。'],
];
const byExternalReason = new Map(externalDefinitions.map(([source, reason, message]) => [source, { reason, message }]));

/** Translate only verifier enums; raw response fields never become UI text. */
export function externalAssetFailure(result) {
  const source = result?.reason === 'http-error' && result?.httpStatus === 404 ? 'http-not-found' : result?.reason;
  const found = typeof source === 'string' && byExternalReason.get(source) || byExternalReason.get('unknown');
  return { code: 'ASSET_LINK_UNKNOWN', message: found.message };
}

const definitions = [
  ['ASSET_PROTOCOL', 'protocol_file_not_found', '来源接口返回 file_not_found，当前入口未提供文件；原始来源已保留。',
    ['来源接口返回 file_not_found，当前入口未提供文件；原始来源已保留。']],
  ...externalDefinitions.map(([, reason, message]) => ['ASSET_LINK_UNKNOWN', reason, message, [message]]),
  ['ASSET_LINK_UNKNOWN', 'external_permission_required', byExternalReason.get('permission-required').message,
    ['请在设置中允许检测外链附件；链接已保留。']],
  ['ASSET_LINK_UNKNOWN', 'external_unknown', byExternalReason.get('unknown').message,
    ['外链暂时无法匿名验证，链接已保留，未自动上传。']],
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
    ['附件类型或文件内容无法确认，未保存。', '附件内容未通过 gzip 格式校验，未保存。', 'gzip 附件不完整或校验失败，未保存。']],
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

const routes = new Set(['captured-resource', 'library-download', 'interpreter-download', 'executor-download', 'file-download', 'visible-image']);
const mimeTypes = new Set(['missing', 'unknown', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/avif', 'image/heif', 'image/heic', 'image/svg+xml', 'image/bmp', 'image/tiff',
  'application/octet-stream', 'binary/octet-stream', 'application/json', 'application/problem+json',
  'text/html', 'text/plain', 'application/zip', 'application/x-zip-compressed', 'application/pdf',
  'application/gzip', 'application/x-gzip', 'application/x-compressed-tar', 'application/x-tar']);
const detectedTypes = new Set(['not-read', 'empty', 'unknown', 'png', 'jpeg', 'gif', 'webp',
  'avif', 'heif', 'bmp', 'tiff', 'svg', 'html', 'json', 'zip', 'gzip', 'pdf']);
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
    'interpreter-download': '生成文件入口', 'executor-download': '工作区文件入口', 'file-download': '文件下载入口', 'visible-image': '页面原图' };
  const signatures = { 'not-read': '未读取', empty: '空内容', unknown: '未知',
    png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', avif: 'AVIF', heif: 'HEIF',
    bmp: 'BMP', tiff: 'TIFF', svg: 'SVG', html: '网页', json: 'JSON', zip: 'ZIP', gzip: 'GZIP', pdf: 'PDF' };
  return sanitizeAssetFailureDiagnostics(value).map(item => [names[item.route],
    item.httpStatus ? `HTTP ${item.httpStatus}` : '', item.code || '',
    item.mimeType ? `声明：${item.mimeType === 'missing' ? '未声明' : item.mimeType === 'unknown' ? '其他类型' : item.mimeType}` : '',
    item.detectedType ? `文件头：${signatures[item.detectedType]}` : '',
    item.byteLength !== undefined ? `${item.byteLength} 字节` : ''].filter(Boolean).join(' · '));
}
