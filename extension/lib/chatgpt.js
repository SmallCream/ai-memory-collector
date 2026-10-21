// Serialized by chrome.scripting.executeScript: keep this function self-contained.
// Experimental, read-only website endpoints. Session credentials never leave it.
export async function probeChatGPT(request) {
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  try {
    if (location.origin !== 'https://chatgpt.com') fail('ORIGIN', '请在 chatgpt.com 的已登录标签页中操作。');
    if (!request || !['identity', 'list', 'detail'].includes(request.kind)) fail('REQUEST', '不支持的采集操作。');
    if (request.kind !== 'identity' && !/^acct-[a-f0-9]{24}$/.test(request.expectedAccountKey || '')) {
      fail('IDENTITY', '请先识别当前账号。');
    }
    const limit = 20;
    if (request.kind === 'list' && (!Number.isInteger(request.offset) || request.offset < 0 || request.offset > 100000)) {
      fail('REQUEST', '分页位置无效或超过本次采集范围。');
    }
    if (request.kind === 'detail' && (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.conversationId || '') ||
        !['auto', 'flat', 'tree'].includes(request.format))) {
      fail('REQUEST', '对话 ID 或详情接口类型无效。');
    }
    async function getJSON(path, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(path, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          const status = response.status;
          fail(`HTTP_${status}`, status === 429 ? '平台限流，任务会保留进度，稍后重试。' :
            status === 401 ? '登录已失效，请在网站重新登录。' :
            status === 403 ? '网站拒绝访问或需要验证，请回到网站处理。' :
            status === 404 ? '此接口或对话不可访问；不代表对话已删除。' : `读取失败（HTTP ${status}）。`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) fail('FORMAT', '网站没有返回 JSON，可能需要登录或完成验证。');
        const reader = response.body?.getReader();
        let text = '';
        if (reader) {
          let size = 0;
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); fail('SIZE', '响应超过 8 MiB 上限，本次未归档。'); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } else {
          text = await response.text();
          if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) fail('SIZE', '响应超过 8 MiB 上限，本次未归档。');
        }
        try { return JSON.parse(text); } catch { fail('FORMAT', '返回结构无法解析，请等待适配器更新。'); }
      } finally { clearTimeout(timer); }
    }
    async function session() {
      const payload = await getJSON('/api/auth/session');
      if (typeof payload?.user?.id !== 'string' || !payload.user.id || typeof payload.accessToken !== 'string' || !payload.accessToken) {
        fail('IDENTITY', '无法取得稳定账号身份和有效会话；请确认网站已登录。');
      }
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`chatgpt:${payload.user.id}`));
      const accountKey = 'acct-' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
      return { accountKey, displayName: typeof payload.user.name === 'string' ? payload.user.name.slice(0, 100) : accountKey,
        token: payload.accessToken };
    }
    function detailShape(payload, format) {
      if (!record(payload)) fail('FORMAT', '详情返回结构无法识别。');
      const id = payload.conversation_id ?? payload.id;
      if (id !== request.conversationId) fail('CONVERSATION_ID', '返回对话 ID 不匹配，本次未归档。');
      if (format === 'flat' ? !Array.isArray(payload.messages) : !record(payload.mapping)) {
        fail('FORMAT', '详情结构已变化，请等待适配器更新。');
      }
    }
    function completeDetail(payload, format) {
      const partial = () => fail('INCOMPLETE_DETAIL', '详情尚不完整或仍在生成，已保留原归档，等待后续补采。');
      const page = payload.page_info;
      if (payload.is_incomplete === true || payload.has_more === true || payload.has_more_messages === true ||
          payload.has_next_page === true || payload.has_previous_page === true ||
          page?.has_next_page === true || page?.has_previous_page === true || page?.has_more === true) partial();
      const inProgress = message => message && ['in_progress', 'streaming', 'pending'].includes(message.status);
      if (format === 'flat') {
        // A limited messages response without explicit end markers is not proof
        // of complete history. Do not invent undocumented cursor parameters.
        if (!record(page) || page.has_previous_page !== false || page.has_next_page !== false) partial();
        const seen = new Set();
        for (const item of payload.messages) {
          if (!record(item)) partial();
          const message = own(item, 'message') ? item.message : item;
          if (message === null) continue;
          if (!record(message) || inProgress(message)) partial();
          const id = message.id ?? item.id;
          if (typeof id !== 'string' || !id || seen.has(id)) partial();
          seen.add(id);
        }
      } else {
        const mapping = payload.mapping;
        const keys = Object.keys(mapping);
        if (!keys.length || typeof payload.current_node !== 'string' || !own(mapping, payload.current_node)) partial();
        for (const key of keys) {
          const node = mapping[key];
          if (!record(node) || (node.message != null && !record(node.message)) || inProgress(node.message)) partial();
          if (node.parent !== null && node.parent !== undefined &&
              (typeof node.parent !== 'string' || !own(mapping, node.parent))) partial();
          if (node.children !== undefined && (!Array.isArray(node.children) ||
              node.children.some(child => typeof child !== 'string' || !own(mapping, child)))) partial();
        }
        // Check every component, including non-selected branches, in linear time.
        const verified = new Set();
        for (const key of keys) {
          const chain = new Set();
          let cursor = key;
          while (cursor !== null && cursor !== undefined && !verified.has(cursor)) {
            if (chain.has(cursor) || !own(mapping, cursor)) partial();
            chain.add(cursor);
            cursor = mapping[cursor].parent;
          }
          for (const id of chain) verified.add(id);
        }
      }
      return 'complete';
    }
    const before = await session();
    const identity = { platform: 'chatgpt', accountKey: before.accountKey, displayName: before.displayName, workspace: 'unverified' };
    if (request.expectedAccountKey && before.accountKey !== request.expectedAccountKey) fail('ACCOUNT_CHANGED', '账号已改变，请重新识别；本次结果未归档。');
    if (request.kind === 'identity') return { ok: true, identity, capability: 'session-observed-only' };
    let payload, format, completeness = 'unknown';
    if (request.kind === 'list') {
      const raw = await getJSON(`/backend-api/conversations?offset=${request.offset}&limit=${limit}&order=updated`, before.token);
      if (!record(raw) || !Array.isArray(raw.items) || raw.items.length > limit ||
          raw.items.some(x => !record(x) || typeof x.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id))) {
        fail('FORMAT', '列表结构发生变化，本次不推进分页。');
      }
      if (new Set(raw.items.map(x => x.id)).size !== raw.items.length) fail('PAGINATION_STALLED', '列表页含重复对话，未标记扫描完成，请稍后重试。');
      if (raw.total !== null && raw.total !== undefined && (!Number.isSafeInteger(raw.total) || raw.total < 0)) {
        fail('FORMAT', '列表总数无效，本次不推进分页。');
      }
      const total = raw.total ?? null;
      if (raw.offset !== undefined && raw.offset !== request.offset) fail('PAGINATION_STALLED', '列表分页位置不匹配，已停止本轮扫描。');
      if (!raw.items.length && total !== null && request.offset < total) fail('PAGINATION_STALLED', '列表提前返回空页，未标记扫描完成，请稍后重试。');
      if (total !== null && raw.items.length && request.offset + raw.items.length > total) {
        fail('PAGINATION_CHANGED', '扫描时列表总数发生变化，已保留进度，请重新检查。');
      }
      // When the reported total is unknown, a full page requires another read.
      const more = total === null ? raw.items.length === limit : request.offset + raw.items.length < total;
      const nextOffset = more ? request.offset + raw.items.length : null;
      if (nextOffset !== null && nextOffset > 100000) fail('PAGINATION_LIMIT', '本轮分页超过 100000 条，未标记扫描完成。');
      payload = { items: raw.items.map(x => ({ id: x.id, title: typeof x.title === 'string' ? x.title.slice(0, 200) : '未命名对话',
        createTime: typeof x.create_time === 'string' || typeof x.create_time === 'number' ? x.create_time : null,
        updateTime: typeof x.update_time === 'string' || typeof x.update_time === 'number' ? x.update_time : null })),
        offset: request.offset, nextOffset, total, coverage: '当前会话的普通列表；项目、归档、临时会话未验证' };
    } else {
      format = request.format === 'auto' ? 'tree' : request.format;
      const read = async type => {
        const suffix = type === 'flat' ? `conversations/${request.conversationId}?num_turns=100` : `conversation/${request.conversationId}`;
        const value = await getJSON(`/backend-api/${suffix}`, before.token);
        detailShape(value, type);
        return value;
      };
      try { payload = await read(format); }
      catch (error) {
        // Auth, rate limits, identity mismatches and partial trees never fall back.
        if (request.format !== 'auto' || !['HTTP_404', 'FORMAT'].includes(error.code)) throw error;
        format = 'flat';
        payload = await read(format);
      }
      // Preserve the original P0 probe's explicit formats for diagnostics only.
      // The production adapter always requests auto and enforces completeness.
      if (request.format === 'auto') completeness = completeDetail(payload, format);
    }
    const after = await session();
    if (after.accountKey !== before.accountKey) fail('ACCOUNT_CHANGED', '请求期间账号发生变化，本次结果已丢弃。');
    return { ok: true, identity, payload, capturedAt: new Date().toISOString(), sourceFormat: 'chatgpt-web-detail',
      ...(request.kind === 'detail' ? { detailFormat: format, completeness } : {}),
      coverage: request.kind === 'detail' ? '已检查返回结构；全部历史和平台全部分支完整度仍未验证，附件仅保留引用' : payload.coverage };
  } catch (error) {
    return { ok: false, error: { code: error.code || (error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'),
      message: error.code ? error.message : error.name === 'AbortError' ? '请求超时，请稍后重试。' : '请求未完成，请检查网站登录状态和网络。' } };
  }
}
