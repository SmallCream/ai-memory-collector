// Exact internal error vocabulary only. Never expose raw error messages,
// response bodies, headers, download URLs or credentials through diagnostics.
const definitions = [
  ['ASSET_FORMAT', 'format_html_response', '下载入口返回了网页内容，未作为附件保存。',
    ['附件请求返回了网页，未作为附件保存。', '附件请求返回了网页，未保存。', '图片请求返回了网页，未作为图片保存。']],
  ['ASSET_FORMAT', 'format_image_unconfirmed', '图片文件头无法识别，或响应类型与文件内容不一致。',
    ['附件类型或文件头无法确认，未保存为原图。', '图片类型或文件头无法确认，未保存为原图。']],
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
