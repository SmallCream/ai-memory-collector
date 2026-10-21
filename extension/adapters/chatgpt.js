import { probeChatGPT } from '../lib/chatgpt.js';

export class AdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'AdapterError'; this.code = code; }
}

export function isChatGPTUrl(value) {
  try { return new URL(value).origin === 'https://chatgpt.com'; }
  catch { return false; }
}

function validIdentity(value) {
  return value?.platform === 'chatgpt' && /^acct-[a-f0-9]{24}$/.test(value.accountKey || '') &&
    typeof value.displayName === 'string';
}

/** Injectable Chrome dependency supports tests without a live logged-in account. */
export function createChatGPTAdapter(browser) {
  async function run(tabId, request) {
    const api = browser ?? globalThis.chrome;
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new AdapterError('TAB_REQUIRED', '请打开已登录的 ChatGPT 标签页。');
    let tab;
    try { tab = await api.tabs.get(tabId); }
    catch { throw new AdapterError('TAB_CLOSED', 'ChatGPT 标签页已关闭，重新打开后可继续采集。'); }
    if (!isChatGPTUrl(tab.url) || (tab.pendingUrl && !isChatGPTUrl(tab.pendingUrl))) {
      throw new AdapterError('TAB_CHANGED', '采集标签页已离开 ChatGPT，任务已暂停。');
    }
    let results;
    try {
      results = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED',
        func: probeChatGPT, args: [request] });
    } catch {
      // Browser exceptions may contain page URLs; do not pass them into logs/UI.
      throw new AdapterError('TAB_UNAVAILABLE', '暂时无法读取 ChatGPT 页面，请检查网站权限、登录状态或重新载入页面。');
    }
    const result = results?.find(item => item.frameId === 0)?.result;
    if (!result?.ok) {
      const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(result?.error?.code || '') ? result.error.code : 'INVALID_RESPONSE';
      const message = typeof result?.error?.message === 'string' ? result.error.message : '未取得有效的采集结果，请稍后重试。';
      throw new AdapterError(code, message);
    }
    if (!validIdentity(result.identity) ||
        (request.expectedAccountKey && result.identity.accountKey !== request.expectedAccountKey)) {
      throw new AdapterError('ACCOUNT_CHANGED', '账号身份不匹配，本次结果未归档。');
    }
    // Navigation during the injected read invalidates its result, even when the
    // old document finished a request after the tab navigated elsewhere.
    let after;
    try { after = await api.tabs.get(tabId); }
    catch { throw new AdapterError('TAB_CLOSED', 'ChatGPT 标签页已关闭，结果未归档。'); }
    if (!isChatGPTUrl(after.url) || (after.pendingUrl && !isChatGPTUrl(after.pendingUrl))) {
      throw new AdapterError('TAB_CHANGED', '采集标签页已离开 ChatGPT，结果未归档。');
    }
    return result;
  }
  return Object.freeze({
    platform: 'chatgpt',
    origin: 'https://chatgpt.com',
    matches: isChatGPTUrl,
    async identify(tabId) { return (await run(tabId, { kind: 'identity' })).identity; },
    async list(tabId, { accountKey, offset = 0 } = {}) {
      const result = await run(tabId, { kind: 'list', expectedAccountKey: accountKey, offset });
      return result.payload;
    },
    async detail(tabId, { accountKey, conversationId } = {}) {
      const result = await run(tabId, { kind: 'detail', expectedAccountKey: accountKey, conversationId, format: 'auto' });
      if (result.completeness !== 'complete') throw new AdapterError('INCOMPLETE_DETAIL', '详情完整度未确认，原归档保持不变。');
      return { payload: result.payload, capturedAt: result.capturedAt, identity: result.identity,
        completeness: result.completeness, sourceFormat: result.sourceFormat, coverage: result.coverage };
    },
  });
}

export const chatgptAdapter = createChatGPTAdapter();
