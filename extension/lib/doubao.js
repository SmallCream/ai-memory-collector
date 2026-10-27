// Serialized into the extension's isolated world. Only observed, read-only IM
// endpoints are allowed; cookies remain in the current Doubao origin.
export async function probeDoubao(request) {
  const errors = new WeakMap();
  const fail = (code, message) => { const error = new Error(message); errors.set(error, { code, message }); throw error; };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const decimal = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
  let scope, registry;
  try {
    if (location.origin !== 'https://www.doubao.com' || window.top !== window) fail('ORIGIN', '请打开豆包网页端。');
    if (!['identity', 'list', 'info', 'messages'].includes(request?.kind)) fail('FORMAT', '豆包读取请求无效。');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId || '')) fail('FORMAT', '豆包读取标识无效。');
    const key = '__aiMemoryCollectorDoubaoRequestsV1';
    registry = globalThis[key] instanceof Map ? globalThis[key] : (globalThis[key] = new Map());
    for (const [id, entry] of registry) if (!entry.controller && entry.createdAt < Date.now() - 3600000) registry.delete(id);
    scope = registry.get(request.requestId) || { createdAt: Date.now(), accountKey: request.expectedAccountKey };
    registry.set(request.requestId, scope);
    const check = () => { if (scope.cancelled) fail('COLLECTION_PAUSED', '采集已暂停。'); };
    async function call(path, cmd, bodyKey, body) {
      check();
      const controller = new AbortController(); scope.controller = controller;
      let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); }, 30000);
      try {
        const url = new URL(path, location.origin);
        // Protocol parameters observed on the website; no device identifiers,
        // analytics IDs, access tokens or signature generation are copied.
        url.search = new URLSearchParams({ aid: '497858', real_aid: '497858', device_platform: 'web',
          doubao_device_platform: 'web', language: 'zh', version_code: '20800', pc_version: '3.42.5',
          doubao_pc_version: '3.42.5', pkg_type: 'release_version', region: 'CN', sys_region: 'CN',
          web_platform: 'browser', samantha_web: '1', 'use-olympus-account': '1' }).toString();
        const response = await fetch(url.href, { method: 'POST', credentials: 'same-origin', redirect: 'error',
          cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json; encoding=utf-8', 'agw-js-conv': 'str' },
          body: JSON.stringify({ cmd, uplink_body: { [bodyKey]: body }, sequence_id: crypto.randomUUID(), channel: 2, version: '1' }) });
        if (!response.ok) fail(`HTTP_${response.status}`, '豆包接口暂时无法读取，请检查登录或稍后重试。');
        if (!/application\/json/i.test(response.headers.get('content-type') || '')) fail('FORMAT', '豆包未返回有效 JSON。');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) { check(); const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 16 * 1024 * 1024) fail('SIZE', '豆包返回内容超过处理上限。'); chunks.push(value); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('FORMAT', '豆包返回结构无法解析。'); }
        if (!record(data) || data.cmd !== cmd || data.status_code !== 0 || !record(data.downlink_body)) fail('FORMAT', '豆包未确认读取成功，请检查登录或网站验证。');
        check(); return data.downlink_body;
      } catch (error) {
        check(); if (expired) fail('TIMEOUT', '豆包读取超时，进度已保留。');
        if (errors.has(error)) throw error;
        fail('NETWORK', '豆包读取未完成，进度已保留。');
      } finally { clearTimeout(timer); delete scope.controller; }
    }
    async function recent(offset = 0, limit = 20) {
      if (offset !== 0 && (!decimal(offset) || !Number.isSafeInteger(Number(offset)))) fail('FORMAT', '豆包列表游标无效。');
      const result = await call('/im/chain/recent_conv', 3200, 'pull_recent_conv_chain_uplink_body', {
        limit, message_count_per_conv: 0, api_version: 1, conv_version: Number(offset), direction: offset === 0 ? 3 : 1,
        option: { not_need_message: true, need_complete_conversation: true, need_coco_bot: offset === 0,
          need_pc_pin_chain: true, pc_pin_query_type: 0, exclude_archive: true, only_archive: false },
      });
      const value = result.pull_recent_conv_chain_downlink_body;
      if (!record(value) || (!decimal(value.user_id) || BigInt(value.user_id) === 0n) || !Array.isArray(value.cells) || typeof value.has_more !== 'boolean') fail('FORMAT', '豆包列表或账号结构无法确认。');
      return value;
    }
    async function identity(value) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`doubao:${value.user_id}`));
      const accountKey = 'acct-' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
      if (request.expectedAccountKey && request.expectedAccountKey !== accountKey) fail('ACCOUNT_CHANGED', '豆包登录账号已变化，原任务已暂停。');
      return { platform: 'doubao', accountKey, displayName: '豆包账号 ' + accountKey.slice(-6) };
    }
    const before = await recent(request.kind === 'list' ? request.offset ?? 0 : 0, request.kind === 'list' ? 20 : 1);
    const owner = await identity(before);
    let payload;
    if (request.kind === 'identity') payload = null;
    else if (request.kind === 'list') {
      const items = before.cells.map(cell => {
        const conv = cell?.conversation;
        if (!record(conv) || !decimal(conv.conversation_id) || typeof conv.name !== 'string' || !decimal(conv.update_time)) fail('FORMAT', '豆包列表包含尚未支持的会话结构，未标记扫描完成。');
        return { id: conv.conversation_id, title: conv.name, updateTime: conv.update_time };
      });
      const cursor = before.next_conv_version;
      if (before.has_more && (!decimal(cursor) || cursor === '0' || !items.length ||
          request.offset && BigInt(cursor) >= BigInt(request.offset))) fail('PAGINATION_STALLED', '豆包列表分页未前进。');
      payload = { items, nextOffset: before.has_more ? cursor : null, total: null };
    } else {
      if (!decimal(request.conversationId)) fail('FORMAT', '豆包对话标识无效。');
      if (request.kind === 'info') {
        const value = (await call('/im/conversation/info', 1110, 'get_conv_info_uplink_body', {
          conversation_id: request.conversationId, ext: { cold_start: 'true' }, bot_id: '', conversation_type: 3, option: { need_bot_info: false },
        })).get_conv_info_downlink_body;
        if (!record(value?.conversation_info) || value.user_id !== before.user_id ||
            value.conversation_info.creator_id !== before.user_id || value.conversation_info.conversation_id !== request.conversationId) fail('ACCOUNT_CHANGED', '豆包对话归属无法确认。');
        payload = value.conversation_info;
      } else {
        const anchor = request.anchor ?? String(Number.MAX_SAFE_INTEGER);
        if (!decimal(anchor) || !Number.isSafeInteger(Number(anchor))) fail('FORMAT', '豆包消息游标无效。');
        payload = (await call('/im/chain/single', 3100, 'pull_singe_chain_uplink_body', {
          conversation_id: request.conversationId, anchor_index: Number(anchor), conversation_type: 3,
          direction: 1, limit: 20, ext: {}, filter: { index_list: [] }, evaluate_ab_params: '', evaluate_common_params: '',
          option: { lazy_load_strategy: 0 },
        })).pull_singe_chain_downlink_body;
        if (!record(payload) || !Array.isArray(payload.messages) || typeof payload.has_more !== 'boolean' ||
            payload.messages.some(m => !record(m) || m.conversation_id !== request.conversationId || !decimal(m.message_id) || !decimal(m.index_in_conv))) fail('FORMAT', '豆包消息结构或对话归属无法确认。');
      }
    }
    const after = await recent(0, 1);
    if (after.user_id !== before.user_id) fail('ACCOUNT_CHANGED', '读取期间豆包账号已切换，结果未归档。');
    check();
    return { ok: true, identity: owner, payload, capturedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, error: errors.get(error) || { code: 'FORMAT', message: '豆包数据无法确认，已有归档保持不变。' } };
  } finally { if (registry && scope && !scope.cancelled) registry.delete(request.requestId); }
}

export function cancelDoubaoRequests(request) {
  if (location.origin !== 'https://www.doubao.com' || !Array.isArray(request?.ids)) return 0;
  const key = '__aiMemoryCollectorDoubaoRequestsV1';
  const registry = globalThis[key] instanceof Map ? globalThis[key] : (globalThis[key] = new Map());
  let count = 0;
  for (const id of request.ids) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
    const entry = registry.get(id) || { accountKey: request.accountKey, createdAt: Date.now() };
    if (entry.accountKey && request.accountKey && entry.accountKey !== request.accountKey) continue;
    entry.cancelled = true; registry.set(id, entry); entry.controller?.abort(); count++;
  }
  return count;
}
