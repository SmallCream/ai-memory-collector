// Serialized by chrome.scripting.executeScript: this function must be self-contained.
// Experimental, read-only website endpoints. No token leaves this isolated execution.
export async function probeChatGPT(request) {
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  try {
    if (location.origin !== 'https://chatgpt.com') fail('ORIGIN', '请在 chatgpt.com 的已登录标签页中操作。');
    if (!request || !['identity', 'list', 'detail'].includes(request.kind)) fail('REQUEST', '不支持的采集操作。');
    if (request.kind !== 'identity' && !/^acct-[a-f0-9]{24}$/.test(request.expectedAccountKey || '')) {
      fail('IDENTITY', '请先识别当前账号。');
    }
    const limit = 20;
    if (request.kind === 'list' && (!Number.isInteger(request.offset) || request.offset < 0 || request.offset > 10000)) {
      fail('REQUEST', '分页位置无效。');
    }
    if (request.kind === 'detail' && (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.conversationId || '') || !['flat', 'tree'].includes(request.format))) {
      fail('REQUEST', '对话 ID 或详情接口类型无效。');
    }
    async function getJSON(path, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(path, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' },
          signal: controller.signal
        });
        if (!response.ok) {
          const status = response.status;
          fail(`HTTP_${status}`, status === 429 ? '平台限流，请稍后手动重试。' :
            status === 401 ? '登录已失效，请在网站重新登录。' :
            status === 403 ? '网站拒绝访问或需要验证，请回到网站处理。' :
            status === 404 ? '此接口或对话不可访问；不代表对话已删除。' : `读取失败（HTTP ${status}）。`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) fail('FORMAT', '网站没有返回 JSON，可能需要登录或完成验证。');
        // P0 bounds memory. Abort on oversized streamed responses, not after parsing them.
        const reader = response.body?.getReader();
        let text = '';
        if (reader) {
          let size = 0;
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); fail('SIZE', '响应超过 P0 的 8 MiB 上限，本次未归档。'); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } else {
          text = await response.text();
          if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) fail('SIZE', '响应超过 P0 上限。');
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
    const before = await session();
    const identity = { accountKey: before.accountKey, displayName: before.displayName, workspace: 'unverified' };
    if (request.expectedAccountKey && before.accountKey !== request.expectedAccountKey) fail('ACCOUNT_CHANGED', '账号已改变，请重新识别；本次结果未归档。');
    if (request.kind === 'identity') return { ok: true, identity, capability: 'session-observed-only' };
    let payload;
    if (request.kind === 'list') {
      const raw = await getJSON(`/backend-api/conversations?offset=${request.offset}&limit=${limit}&order=updated`, before.token);
      if (!Array.isArray(raw?.items) || raw.items.some(x => !x || typeof x.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id))) {
        fail('FORMAT', '列表结构与原型预期不符，本次不推进分页。');
      }
      const total = Number.isSafeInteger(raw.total) && raw.total >= 0 ? raw.total : null;
      // A full page is only a candidate for another request, not proof of full coverage.
      const nextOffset = raw.items.length === limit || (total !== null && request.offset + raw.items.length < total)
        ? request.offset + raw.items.length : null;
      payload = { items: raw.items.map(x => ({ id: x.id, title: typeof x.title === 'string' ? x.title.slice(0, 200) : '未命名对话',
        createTime: typeof x.create_time === 'string' || typeof x.create_time === 'number' ? x.create_time : null,
        updateTime: typeof x.update_time === 'string' || typeof x.update_time === 'number' ? x.update_time : null })),
        offset: request.offset, nextOffset: raw.items.length ? nextOffset : null, total, coverage: '普通列表的一页；项目、归档、临时会话未验证' };
    } else {
      const suffix = request.format === 'flat' ? `conversations/${request.conversationId}?num_turns=100` : `conversation/${request.conversationId}`;
      payload = await getJSON(`/backend-api/${suffix}`, before.token);
      const id = payload?.conversation_id ?? payload?.id;
      if (id !== request.conversationId) fail('CONVERSATION_ID', '返回对话 ID 不匹配，本次未归档。');
      if (request.format === 'flat' ? !Array.isArray(payload.messages) : !payload.mapping || typeof payload.mapping !== 'object' || Array.isArray(payload.mapping)) {
        fail('FORMAT', '详情结构与所选接口类型不符；可手动切换类型再试。');
      }
    }
    const after = await session();
    if (after.accountKey !== before.accountKey) fail('ACCOUNT_CHANGED', '请求期间账号发生变化，本次结果已丢弃。');
    return { ok: true, identity, payload, capturedAt: new Date().toISOString(), sourceFormat: 'chatgpt-web-detail',
      coverage: request.kind === 'detail' ? '单次响应；消息分页和全部分支完整度未验证' : payload.coverage };
  } catch (error) {
    return { ok: false, error: { code: error.code || (error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'),
      message: error.code ? error.message : error.name === 'AbortError' ? '请求超时，请稍后重试。' : '请求未完成，请检查网站登录状态和网络。' } };
  }
}
