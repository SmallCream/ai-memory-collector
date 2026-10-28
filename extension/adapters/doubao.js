import { probeDoubao, cancelDoubaoRequests } from '../lib/doubao.js';
import { createRequestControl, waitForDetailRequest } from '../lib/detail-request-lifetime.js';
import { validateDoubaoConversation } from '../lib/doubao-format.js';

export function isDoubaoUrl(value) { try { return new URL(value).origin === 'https://www.doubao.com'; } catch { return false; } }
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function createDoubaoAdapter(browser) {
  const api = () => browser ?? globalThis.chrome;
  const requests = createRequestControl(api, cancelDoubaoRequests);
  async function read(tabId, input, scope) {
    async function checkTab() {
      let tab; try { tab = await api().tabs.get(tabId); } catch { fail('TAB_CLOSED', '豆包标签页已关闭。'); }
      if (!isDoubaoUrl(tab.url) || tab.pendingUrl && !isDoubaoUrl(tab.pendingUrl)) fail('TAB_CHANGED', '标签页已离开豆包。');
    }
    scope.check(); await checkTab();
    let frames;
    try { frames = await waitForDetailRequest(() => scope.race(() => api().scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED',
      func: probeDoubao, args: [{ ...input, requestId: scope.id }] })), { runtime: api().runtime }); }
    catch (error) { if (['COLLECTION_PAUSED', 'TIMEOUT'].includes(error?.code)) throw error; fail('TAB_UNAVAILABLE', '暂时无法读取豆包，请检查网站权限。'); }
    await checkTab(); scope.check();
    if (!Array.isArray(frames) || frames.length !== 1 || frames[0]?.frameId !== 0 || frames[0]?.error) fail('INVALID_RESPONSE', '豆包读取结果无效。');
    const result = frames[0].result;
    if (result?.ok === false && /^[A-Z][A-Z0-9_]{0,60}$/.test(result.error?.code || '')) fail(result.error.code, result.error.message);
    if (result?.ok !== true || result.identity?.platform !== 'doubao' || !/^acct-[a-f0-9]{24}$/.test(result.identity?.accountKey || '')) fail('INVALID_RESPONSE', '豆包账号无法确认。');
    if (input.expectedAccountKey && input.expectedAccountKey !== result.identity.accountKey) fail('ACCOUNT_CHANGED', '豆包账号已切换。');
    return result;
  }
  return Object.freeze({ platform: 'doubao', origin: 'https://www.doubao.com', matches: isDoubaoUrl,
    cancel: (tabId, options) => requests.cancel(tabId, options),
    identify: tabId => requests.run(tabId, null, async scope => (await read(tabId, { kind: 'identity' }, scope)).identity),
    fileUrl: (tabId, { accountKey, uri }) => requests.run(tabId, accountKey, async scope =>
      (await read(tabId, { kind: 'file-url', expectedAccountKey: accountKey, uri }, scope)).payload),
    list: (tabId, { accountKey, offset = 0 }) => requests.run(tabId, accountKey, async scope =>
      (await read(tabId, { kind: 'list', expectedAccountKey: accountKey, offset }, scope)).payload),
    detail: (tabId, { accountKey, conversationId, shouldPause = () => false, onProgress }) => requests.run(tabId, accountKey, async scope => {
      const input = { expectedAccountKey: accountKey, conversationId };
      const before = await read(tabId, { ...input, kind: 'info' }, scope);
      const version = info => JSON.stringify([info.update_time, info.latest_index, info.msg_cursor, info.name]);
      const messages = new Map(), regen = {}; let anchor, pages = 0, bytes = 0;
      for (;;) {
        if (shouldPause()) fail('COLLECTION_PAUSED', '采集已暂停。');
        if (++pages > 500) fail('DETAIL_PAGINATION', '豆包消息分页超过当前处理范围。');
        const { payload: page } = await read(tabId, { ...input, kind: 'messages', ...(anchor ? { anchor } : {}) }, scope);
        bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (bytes > 24 * 1024 * 1024) fail('SIZE', '豆包对话超过当前处理上限。');
        let added = 0;
        for (const message of page.messages) {
          if (messages.has(message.message_id)) {
            if (JSON.stringify(messages.get(message.message_id)) !== JSON.stringify(message)) fail('DETAIL_CHANGED', '豆包消息在分页期间发生变化。');
          } else { messages.set(message.message_id, message); added++; }
        }
        if (messages.size > 100000) fail('SIZE', '豆包消息数量超过当前处理上限。');
        if (page.regen_messages !== undefined && !record(page.regen_messages)) fail('FORMAT', '豆包重新生成记录无法解析。');
        for (const [key, value] of Object.entries(page.regen_messages || {})) {
          if (!/^[0-9]{1,20}$/.test(key)) fail('FORMAT', '豆包重新生成记录标识无效。');
          if (Object.hasOwn(regen, key) && JSON.stringify(regen[key]) !== JSON.stringify(value)) fail('DETAIL_CHANGED', '豆包历史版本在读取期间变化。');
          regen[key] = value;
        }
        try { await onProgress?.({ mode: 'full', pagesRead: pages, fetchedMessages: messages.size, reusedMessages: 0 }); } catch { /* diagnostics cannot invalidate a source read */ }
        if (page.has_more === false) break;
        // msg_cursor is the chain's retention boundary (observed as "1"),
        // not the next page. The website requests min(index_in_conv) - 1.
        const oldest = page.messages.reduce((min, m) => BigInt(m.index_in_conv) < min ? BigInt(m.index_in_conv) : min, BigInt(Number.MAX_SAFE_INTEGER));
        const cursor = oldest - 1n;
        if (page.has_more !== true || !added || cursor < 1n ||
            anchor && cursor >= BigInt(anchor)) fail('DETAIL_PAGINATION', '豆包消息游标未继续前进。');
        anchor = String(cursor);
      }
      const after = await read(tabId, { ...input, kind: 'info' }, scope);
      if (version(before.payload) !== version(after.payload)) fail('DETAIL_CHANGED', '豆包对话在读取期间变化，稍后重试。');
      const ordered = [...messages.values()].sort((a, b) => BigInt(a.index_in_conv) < BigInt(b.index_in_conv) ? -1 : BigInt(a.index_in_conv) > BigInt(b.index_in_conv) ? 1 : 0);
      const payload = { platform: 'doubao', sourceFormat: 'doubao-web-chain', conversation_id: conversationId,
        title: after.payload.name, create_time: Number(after.payload.create_time),
        update_time: ordered.reduce((latest, m) => Math.max(latest, Number(m.update_time)), Number(after.payload.update_time)),
        conversation: after.payload, messages: ordered, regen_messages: regen, has_more: false };
      validateDoubaoConversation(payload);
      return { identity: after.identity, payload, capturedAt: after.capturedAt, completeness: 'complete', sourceFormat: 'doubao-web-chain' };
    }),
  });
}
export const doubaoAdapter = createDoubaoAdapter();
