import test from 'node:test';
import assert from 'node:assert/strict';
import { assetFailureReason, assetFailureDiagnosticMessage, sanitizeAssetFailureDiagnostics,
  assetFailureAttemptSummaries } from '../extension/lib/asset-failure.js';

test('known format failures retain distinct bounded explanations, including both HTML rejection paths', () => {
  const cases = [
    ['附件请求返回了网页，未作为附件保存。', 'format_html_response'],
    ['附件请求返回了网页，未保存。', 'format_html_response'],
    ['附件类型或文件头无法确认，未保存为原图。', 'format_image_unconfirmed'],
    ['附件类型与来源信息不一致，未保存。', 'format_response_unconfirmed'],
    ['附件类型或文件内容无法确认，未保存。', 'format_content_validation_failed'],
    ['返回内容不是受支持的原始附件，已保留来源等待补采。', 'format_content_unsupported'],
    ['内嵌附件格式不正确。', 'format_embedded_encoding_invalid'],
  ];
  for (const [message, reason] of cases) {
    const diagnostic = assetFailureReason({ code: 'ASSET_FORMAT', message });
    assert.equal(diagnostic.reason, reason);
    assert.equal(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason }), diagnostic.message);
  }
  assert.match(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason: 'format_image_unconfirmed' }), /或/);
  assert.match(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason: 'format_response_unconfirmed' }), /为空/);
});

test('known input failures identify only the exact validation that reported them', () => {
  const cases = [
    ['缺少附件来源信息。', 'input_source_missing'],
    ['附件来源消息标识不合法。', 'input_message_invalid'],
    ['附件来源标识不合法或不一致。', 'input_source_invalid'],
    ['附件哈希格式无效。', 'input_hash_invalid'],
    ['附件大小上限必须介于 1 字节和 16 MiB。', 'input_limit_invalid'],
    ['附件所属对话标识不合法。', 'input_conversation_invalid'],
    ['附件请求缺少有效账号和资源信息。', 'input_context_invalid'],
    ['附件请求参数不合法。', 'input_parameters_invalid'],
  ];
  for (const [message, reason] of cases) {
    assert.equal(assetFailureReason({ code: 'ASSET_INPUT', message }).reason, reason);
    assert.equal(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason }), null);
  }
});

test('pre-0.3.15 image wording in existing queued errors receives the same safe reasons', () => {
  const cases = [
    ['ASSET_FORMAT', '图片请求返回了网页，未作为图片保存。', 'format_html_response'],
    ['ASSET_FORMAT', '图片类型或文件头无法确认，未保存为原图。', 'format_image_unconfirmed'],
    ['ASSET_FORMAT', '内嵌图片格式不正确。', 'format_embedded_encoding_invalid'],
    ['ASSET_INPUT', '缺少图片来源信息。', 'input_source_missing'],
    ['ASSET_INPUT', '图片来源标识不合法或不一致。', 'input_source_invalid'],
    ['ASSET_INPUT', '图片哈希格式无效。', 'input_hash_invalid'],
    ['ASSET_INPUT', '图片大小上限必须介于 1 字节和 16 MiB。', 'input_limit_invalid'],
    ['ASSET_INPUT', '图片所属对话标识不合法。', 'input_conversation_invalid'],
    ['ASSET_INPUT', '图片请求缺少有效账号和资源信息。', 'input_context_invalid'],
    ['ASSET_INPUT', '图片请求参数不合法。', 'input_parameters_invalid'],
  ];
  for (const [code, message, reason] of cases) {
    assert.deepEqual(assetFailureReason({ code, message }), { reason, message: assetFailureDiagnosticMessage({ code, reason }) });
    assert.equal(assetFailureReason({ code, message: `${message} https://example.com/?token=private` }), null);
  }
});

test('unknown, contaminated and mismatched messages never become diagnostic text', () => {
  const known = '附件请求返回了网页，未保存。';
  const sensitive = ' https://chatgpt.com/backend-api/estuary/content?sig=secret Bearer private <html>private body</html>';
  for (const error of [
    null, undefined, {}, 'ASSET_FORMAT',
    { code: 'ASSET_FORMAT', message: sensitive },
    { code: 'ASSET_FORMAT', message: known + sensitive },
    { code: 'ASSET_FORMAT', message: ` ${known}` },
    { code: 'ASSET_INPUT', message: known },
    { code: 'HTTP_403', message: known },
    { code: 'ASSET_FORMAT', message: { toString: () => known } },
    { code: { toString: () => 'ASSET_FORMAT' }, message: known },
  ]) assert.equal(assetFailureReason(error), null);
  for (const reason of [null, undefined, {}, '__proto__', 'constructor', sensitive, 'format_html_response ']) {
    assert.equal(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason, message: sensitive }), null);
  }
  assert.equal(assetFailureDiagnosticMessage({ code: 'HTTP_403', reason: 'format_html_response' }), null);
  assert.equal(assetFailureDiagnosticMessage(null), null);
  assert.equal(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason: 'format_html_response', message: sensitive }),
    '下载入口返回了网页内容，未作为附件保存。');
});

test('callers cannot replace the fixed vocabulary by mutating a previous diagnostic', () => {
  const error = { code: 'ASSET_FORMAT', message: '附件请求返回了网页，未保存。' };
  const diagnostic = assetFailureReason(error);
  diagnostic.message = 'private response'; diagnostic.reason = 'not-approved';
  assert.deepEqual(assetFailureReason(error), {
    reason: 'format_html_response', message: '下载入口返回了网页内容，未作为附件保存。',
  });
});

test('new image response reasons distinguish unknown bytes, unsupported image types and MIME mismatch', () => {
  const reasons = [
    ['format_image_header_unknown', '响应中未识别到受支持的图片文件头，未保存。'],
    ['format_image_type_unsupported', '响应是当前下载器尚不支持的图片类型，未保存。'],
    ['format_image_mime_mismatch', '已识别图片文件头，但响应声明的类型与图片内容不一致，未保存。'],
  ];
  for (const [reason, message] of reasons) {
    assert.deepEqual(assetFailureReason({ code: 'ASSET_FORMAT', message }), { reason, message });
    assert.equal(assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason }), message);
    assert.equal(assetFailureDiagnosticMessage({ code: 'HTTP_403', reason }), null);
    assert.equal(assetFailureReason({ code: 'ASSET_FORMAT', message: `${message} private response` }), null);
  }
  assert.equal(new Set(reasons.map(([reason]) => assetFailureDiagnosticMessage({ code: 'ASSET_FORMAT', reason }))).size, 3);
  assert.equal(assetFailureReason({ code: 'ASSET_FORMAT', message: '图片类型或文件头无法确认，未保存为原图。' }).reason,
    'format_image_unconfirmed');
});

test('response diagnostics retain only safe bounded source observations and reject secret fields', () => {
  const secret = 'https://chatgpt.com/backend-api/file?sig=private-token Bearer private-token <html>private-body</html>';
  const raw = [{ route: 'file-download', code: 'ASSET_FORMAT', reason: 'format_image_mime_mismatch',
    httpStatus: 200, mimeType: 'image/jpeg', detectedType: 'png', byteLength: 1024,
    url: secret, headers: { authorization: secret }, body: secret, message: secret },
  { route: 'visible-image', code: secret, reason: secret, httpStatus: 999,
    mimeType: `image/png; secret=${secret}`, detectedType: secret, byteLength: 16 * 1024 * 1024 + 1 },
  { route: secret, code: 'ASSET_FORMAT', mimeType: 'image/png', byteLength: 10 },
  { route: 'library-download', code: 'HTTP_403', reason: 'format_html_response', httpStatus: 403,
    mimeType: 'missing', detectedType: 'not-read', byteLength: 0 }];
  const cleaned = sanitizeAssetFailureDiagnostics(raw);
  assert.deepEqual(cleaned, [
    { route: 'file-download', code: 'ASSET_FORMAT', reason: 'format_image_mime_mismatch',
      httpStatus: 200, mimeType: 'image/jpeg', detectedType: 'png', byteLength: 1024 },
    { route: 'visible-image', mimeType: 'unknown' },
    { route: 'library-download', code: 'HTTP_403', httpStatus: 403, mimeType: 'missing', detectedType: 'not-read', byteLength: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(cleaned), /private|https:|Bearer|<html>|headers|body|authorization/);
  assert.deepEqual(sanitizeAssetFailureDiagnostics(cleaned), cleaned);
  assert.equal(raw[0].url, secret, 'sanitizing must not mutate the original failure');
});

test('response diagnostics cap observations at five and reject malformed numbers without coercion', () => {
  const raw = Array.from({ length: 7 }, (_, index) => ({ route: 'file-download', code: 'HTTP_429',
    httpStatus: 429, byteLength: index, mimeType: 'application/json', detectedType: 'json' }));
  const cleaned = sanitizeAssetFailureDiagnostics(raw);
  assert.equal(cleaned.length, 5);
  assert.deepEqual(cleaned.map(item => item.byteLength), [0, 1, 2, 3, 4]);
  for (const bad of [null, undefined, {}, 'private', 10]) assert.deepEqual(sanitizeAssetFailureDiagnostics(bad), []);
  for (const value of [-1, 200.5, '200', Infinity, NaN, {}]) {
    const [item] = sanitizeAssetFailureDiagnostics([{ route: 'captured-resource', code: 'ASSET_FORMAT',
      httpStatus: value, byteLength: value }]);
    assert.equal(item.httpStatus, undefined);
    assert.equal(item.byteLength, undefined);
  }
  const [maximum] = sanitizeAssetFailureDiagnostics([{ route: 'interpreter-download', code: 'ASSET_FORMAT', byteLength: 16 * 1024 * 1024 }]);
  assert.equal(maximum.byteLength, 16 * 1024 * 1024);
});

test('response summaries use Chinese fixed labels and omit unrecognized text at the UI boundary', () => {
  const lines = assetFailureAttemptSummaries([
    { route: 'file-download', code: 'ASSET_FORMAT', httpStatus: 200, mimeType: 'image/jpeg', detectedType: 'png', byteLength: 68 },
    { route: 'library-download', code: 'HTTP_403', httpStatus: 403, mimeType: 'missing', detectedType: 'not-read' },
    { route: 'visible-image', code: 'ASSET_FORMAT', mimeType: 'private-mime', detectedType: 'avif', byteLength: 0,
      reason: 'https://example.com/?token=private', body: '<script>private</script>' },
  ]);
  assert.equal(lines[0], '文件下载入口 · HTTP 200 · ASSET_FORMAT · 声明：image/jpeg · 文件头：PNG · 68 字节');
  assert.equal(lines[1], '文件库入口 · HTTP 403 · HTTP_403 · 声明：未声明 · 文件头：未读取');
  assert.equal(lines[2], '页面原图 · ASSET_FORMAT · 声明：其他类型 · 文件头：AVIF · 0 字节');
  assert.doesNotMatch(lines.join('\n'), /private|https:|script/);
});
