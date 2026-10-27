import { extractRichReferences, renderRichText, safePublicURL, referenceFileName } from './rich-content.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
export const DOUBAO_RENDERER_VERSION = 'doubao-1';

// Older website responses serialize blocks into content; newer ones expose
// content_block. All consumers must validate and read the same block sequence.
function messageBlocks(message) {
  if (!Array.isArray(message.content_block)) return null;
  if (message.content_block.length || message.content_type !== 9999 || !message.content) return message.content_block;
  try { const blocks = JSON.parse(message.content); return Array.isArray(blocks) ? blocks : null; } catch { return null; }
}
export function validateDoubaoConversation(native) {
  const fail = () => { throw Object.assign(new Error('豆包消息尚未完整或稳定，已有归档保持不变。'), { code: 'PARTIAL_DETAIL' }); };
  if (native?.platform !== 'doubao' || native.sourceFormat !== 'doubao-web-chain' || !decimal(native.conversation_id) ||
      native.conversation?.conversation_id !== native.conversation_id || native.has_more !== false || !Array.isArray(native.messages) ||
      !Number.isFinite(native.update_time) || native.update_time < 0) fail();
  const ids = new Set(); let index = -1n;
  for (const m of native.messages) {
    const blocks = record(m) ? messageBlocks(m) : null;
    if (!record(m) || !decimal(m.message_id) || ids.has(m.message_id) || m.conversation_id !== native.conversation_id ||
        !decimal(m.index_in_conv) || BigInt(m.index_in_conv) <= index || m.status !== 0 ||
        !(m.content_status === 0 || m.content_status === 120 && m.ext?.is_interrupted === 'true') ||
        ![1, 2].includes(m.user_type) || m.ext?.is_finish !== '1' || !blocks ||
        blocks.some(b => !record(b) || b.is_finish !== true)) fail();
    ids.add(m.message_id); index = BigInt(m.index_in_conv);
  }
}

// Doubao embeds telemetry and fetch credentials in nested stringified metadata.
// Keep message text untouched while removing these non-content fields.
export function redactDoubaoMetadata(native, redactions) {
  function copy(value, path = '', metadata = false, depth = 0) {
    if (depth > 100) throw new Error('豆包消息结构过深。');
    if (Array.isArray(value)) return value.map((v, i) => copy(v, `${path}/${i}`, metadata, depth + 1));
    if (!record(value)) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value) && !/\/(?:text|title|code|content)$/.test(path)) {
        try { const url = new URL(value);
          for (const key of [...url.searchParams.keys()]) if (/(?:token|signature|credential|authorization|^sig$|^x-amz-|^x-goog-)/i.test(key)) url.searchParams.delete(key);
          url.username = ''; url.password = '';
          if (url.href !== value) redactions.push({ path, kind: 'doubao-signed-url' });
          return url.href;
        } catch { return value; }
      }
      if (metadata && typeof value === 'string' && /^[\[{]/.test(value)) {
        try { return JSON.stringify(copy(JSON.parse(value), path, true, depth + 1)); } catch { return ''; }
      }
      if (metadata && typeof value === 'string') return value.replace(/https?:\/\/(?:(?!&#|&quot;|&apos;)[^\s"'<>])+/g,
        url => copy(url, `${path}/url`, false, depth + 1));
      return value;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const next = `${path}/${key}`;
      if (/^(?:fetch_token|sec_sender|access_token|refresh_token|authorization|cookie|device_id|web_id|tea_uuid|inner_.+|log_id|perf_mark|trace_map)$/i.test(key)) {
        redactions.push({ path: next, kind: 'doubao-credential-or-telemetry' }); continue;
      }
      let content = item;
      if (['content', 'tts_content'].includes(key) && typeof item === 'string' && Number.isInteger(value.content_type)) {
        // This is a structured message envelope, not free-form prose. Redact
        // URLs/credentials inside it while preserving text fields verbatim.
        let parsed; try { parsed = JSON.parse(item); } catch { /* legacy plain text */ }
        if (record(parsed) || Array.isArray(parsed)) content = JSON.stringify(copy(parsed, next, false, depth + 1));
      }
      Object.defineProperty(result, key, { value: copy(content, next, metadata || ['extra', 'ext', 'meta_info', 'text_tags', 'search_references', 'pc_event_block'].includes(key), depth + 1), enumerable: true });
    }
    return result;
  }
  return copy(native);
}

export function doubaoAssetReference(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.origin + url.pathname : null; }
  catch { return null; }
}

/** Content resources only: never turn avatars, toolbar icons or search thumbnails into downloads. */
export function doubaoResources(native) {
  const result = [];
  for (const message of native.messages || []) {
    const messageId = message.message_id;
    const add = (url, kind, path, fileName) => {
      if (typeof url !== 'string' || !safePublicURL(doubaoAssetReference(url) || '')) return;
      const parsed = new URL(url), managed = parsed.hostname.endsWith('.byteimg.com') || parsed.hostname === 'www.doubao.com';
      result.push({ url, sourceRef: managed ? doubaoAssetReference(url) : url, managed, kind, messageId, path,
        fileName: fileName || referenceFileName(url) || (kind === 'image' ? '豆包图片' : '豆包附件') });
    };
    function media(value, path, kind, depth = 0) {
      if (depth > 30 || value == null) return;
      if (Array.isArray(value)) { value.forEach((item, i) => media(item, `${path}/${i}`, kind, depth + 1)); return; }
      if (!record(value)) return;
      if (value.image_ori) { media(value.image_ori, `${path}/image_ori`, 'image', depth + 1); return; }
      for (const [key, item] of Object.entries(value)) {
        if (/icon|thumb|avatar|preview|cover/i.test(key)) continue;
        if (['url', 'url_v2', 'download_url', 'image_url', 'file_url'].includes(key) && typeof item === 'string') {
          add(item, kind, `${path}/${key}`, value.file_name || value.name);
          if (key === 'url' && item) break;
        } else if (record(item) || Array.isArray(item)) media(item, `${path}/${key}`, kind, depth + 1);
      }
    }
    for (const [i, block] of (messageBlocks(message) || []).entries()) {
      for (const [key, value] of Object.entries(block.content || {})) {
        if (/^(?:image|images|file|files|attachment)(?:_block|_list)?$/.test(key)) media(value, `messages/${messageId}/content_block/${i}/${key}`, /image/.test(key) ? 'image' : 'attachment');
        if (key === 'text_block' && typeof value?.text === 'string') for (const ref of extractRichReferences(value.text)) add(ref.ref, ref.kind, `messages/${messageId}/content_block/${i}/text`, referenceFileName(ref.ref));
      }
    }
    if (typeof message.content === 'string' && message.content && !(messageBlocks(message) || []).length) {
      let body; try { body = JSON.parse(message.content); } catch { /* legacy plain text */ }
      if (Array.isArray(body?.entities)) for (const [i, entity] of body.entities.entries()) {
        for (const [key, value] of Object.entries(entity?.entity_content || {})) {
          if (['image', 'file', 'attachment'].includes(key)) media(value, `messages/${messageId}/entities/${i}/${key}`, key === 'image' ? 'image' : 'attachment');
        }
      }
      const text = typeof body?.text === 'string' ? body.text : body === undefined ? message.content : '';
      for (const ref of extractRichReferences(text)) add(ref.ref, ref.kind, `messages/${messageId}/content`, referenceFileName(ref.ref));
    }
  }
  return result;
}

export function renderDoubaoMessages(native, resolveAsset) {
  const resources = doubaoResources(native);
  return native.messages.map(message => {
    const resolve = ref => resolveAsset(doubaoAssetReference(ref) || ref, { messageId: message.message_id }) || resolveAsset(ref, { messageId: message.message_id });
    const parts = [];
    for (const block of messageBlocks(message) || []) {
      const body = block.content || {};
      if (typeof body.text_block?.text === 'string') parts.push(renderRichText(body.text_block.text, { resolveAsset: resolve }));
      else if (body.file_operation_block) {
        const file = body.file_operation_block;
        const text = typeof file.content === 'string' ? file.content : '';
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
        parts.push(`文件：${renderRichText(file.file_name || file.path || '未命名文件')}\n\n${fence}text\n${text}\n${fence}`);
      } else if (!['thinking_block', 'elapsed_block', 'search_query_result_block', 'tips_block'].some(key => body[key])) {
        parts.push('〔此消息块的完整内容与资源信息保留在原始 JSON 中〕');
      }
    }
    if (!parts.length && message.content) {
      let body; try { body = JSON.parse(message.content); } catch { /* legacy plain text */ }
      const text = typeof body?.text === 'string' ? body.text : body === undefined ? message.content : '〔非正文消息内容保留在原始 JSON 中〕';
      parts.push(renderRichText(text, { resolveAsset: resolve }));
    }
    if (message.content_status === 120 && message.ext?.is_interrupted === 'true') parts.unshift('〔来源已标记此条回复中断，以下保留已返回内容〕');
    for (const resource of resources.filter(r => r.messageId === message.message_id && !r.path.endsWith('/text') && !r.path.endsWith('/content'))) {
      const target = resolve(resource.sourceRef);
      const name = renderRichText(resource.fileName).replace(/[\[\]\n]/g, ' ');
      parts.push(target ? `${resource.kind === 'image' ? '!' : ''}[${name}](${target})` : `〔${name}：附件尚未保存，原始来源已保留〕`);
    }
    return { speaker: message.user_type === 1 ? '你' : '豆包', text: parts.filter(Boolean).join('\n\n') || '〔非正文内容已保留在原始 JSON 中〕' };
  });
}
