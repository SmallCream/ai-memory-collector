import { probeChatGPT } from '../lib/chatgpt.js';
import { collectMessagePages, fullMessageSync } from '../lib/message-sync.js';
import { sanitizeDetailFailure } from '../lib/detail-errors.js';

export class AdapterError extends Error {
  constructor(code, message, reason) {
    super(message); this.name = 'AdapterError'; this.code = code;
    Object.assign(this, sanitizeDetailFailure({ code, reason }));
  }
}

export function isChatGPTUrl(value) {
  try { return new URL(value).origin === 'https://chatgpt.com'; }
  catch { return false; }
}

function validIdentity(value) {
  return value?.platform === 'chatgpt' && /^acct-[a-f0-9]{24}$/.test(value.accountKey || '') &&
    typeof value.displayName === 'string';
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Injectable Chrome dependency supports tests without a live logged-in account. */
export function createChatGPTAdapter(browser, { now = Date.now } = {}) {
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
    async function checkSourceAfterRead() {
      let after;
      try { after = await api.tabs.get(tabId); }
      catch { throw new AdapterError('TAB_CLOSED', 'ChatGPT 标签页已关闭，结果未归档。'); }
      if (!isChatGPTUrl(after.url) || (after.pendingUrl && !isChatGPTUrl(after.pendingUrl))) {
        throw new AdapterError('TAB_CHANGED', '采集标签页已离开 ChatGPT，结果未归档。');
      }
    }
    async function invalidResponse(reason) {
      // An interrupted document can also lose its injection result. Prefer the
      // observed tab state to guessing why the browser returned no usable data.
      await checkSourceAfterRead();
      throw new AdapterError('INVALID_RESPONSE', '未取得有效的采集结果，已保留进度，稍后重试。', reason);
    }
    if (!Array.isArray(results) || results.some(item => !record(item))) return invalidResponse('SCRIPT_RESULTS_INVALID');
    const mainFrames = results.filter(item => item.frameId === 0);
    if (mainFrames.length > 1) return invalidResponse('SCRIPT_RESULTS_INVALID');
    if (!mainFrames.length) return invalidResponse('SCRIPT_MAIN_FRAME_MISSING');
    const frame = mainFrames[0];
    // Error details may contain page data or URLs. Never pass them into logs.
    if (frame.error !== null && frame.error !== undefined) return invalidResponse('SCRIPT_EXECUTION_FAILED');
    const result = frame.result;
    if (result === null || result === undefined) return invalidResponse('SCRIPT_RESULT_MISSING');
    if (!record(result) || typeof result.ok !== 'boolean') return invalidResponse('SCRIPT_ENVELOPE_INVALID');
    if (result.ok === false) {
      if (!record(result.error) || typeof result.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,60}$/.test(result.error.code)) {
        return invalidResponse('SCRIPT_ENVELOPE_INVALID');
      }
      const code = result.error.code;
      const message = typeof result?.error?.message === 'string' ? result.error.message : '未取得有效的采集结果，请稍后重试。';
      throw new AdapterError(code, message, result?.error?.reason);
    }
    if (!validIdentity(result.identity) ||
        (request.expectedAccountKey && result.identity.accountKey !== request.expectedAccountKey)) {
      throw new AdapterError('ACCOUNT_CHANGED', '账号身份不匹配，本次结果未归档。');
    }
    // Navigation during the injected read invalidates its result, even when the
    // old document finished a request after the tab navigated elsewhere.
    await checkSourceAfterRead();
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
    async detail(tabId, { accountKey, conversationId, baseline = null, forceFull = false, onProgress, shouldPause = () => false } = {}) {
      const request = { kind: 'detail', expectedAccountKey: accountKey, conversationId };
      const checkPaused = () => {
        if (shouldPause()) throw new AdapterError('COLLECTION_PAUSED', '采集已暂停，原归档保持不变。');
      };
      const readDetail = async extra => {
        checkPaused();
        try { return await run(tabId, { ...request, ...extra }); }
        finally { checkPaused(); }
      };
      const treeBaseline = baseline?.payload?.mapping && Object.keys(baseline.payload.mapping).length > 0;
      const flatBaseline = !treeBaseline && Array.isArray(baseline?.payload?.messages);
      const tree = async () => {
        const result = await readDetail({ format: 'tree', requireComplete: true });
        if (result.completeness !== 'complete') throw new AdapterError('INCOMPLETE_DETAIL', '详情完整度未确认，原归档保持不变。', 'DETAIL_COMPLETENESS_UNKNOWN');
        if (!result.payload?.mapping || !Object.keys(result.payload.mapping).length) throw new AdapterError('FORMAT', '消息树结构无法确认，原归档保持不变。');
        const messageSync = fullMessageSync(result.payload, baseline, now());
        try { await onProgress?.({ pagesRead: 1, fetchedMessages: messageSync.fetchedMessages, reusedMessages: 0, mode: 'full' }); }
        catch { /* Diagnostic updates are not capture acknowledgements. */ }
        return { payload: result.payload, capturedAt: result.capturedAt, identity: result.identity,
          completeness: 'complete', sourceFormat: result.sourceFormat, coverage: result.coverage, messageSync };
      };
      const flat = async () => {
        let latest;
        const captured = await collectMessagePages({ conversationId, baseline, forceFull, now: now(), onProgress,
          readPage: async before => {
            const result = await readDetail({ format: 'page', ...(before ? { before } : {}) });
            if (result.completeness !== 'page') throw new AdapterError('INCOMPLETE_DETAIL', '分页结构完整度未确认，原归档保持不变。', 'DETAIL_COMPLETENESS_UNKNOWN');
            if (!before) latest = result;
            return result.payload;
          } });
        return { ...captured, ...(captured.messageSync.mode === 'tail-merge' ? { baselineContentHash: baseline.entry.contentHash } : {}),
          capturedAt: latest.capturedAt, identity: latest.identity, completeness: 'complete',
          sourceFormat: latest.sourceFormat,
          coverage: captured.messageSync.mode === 'tail-merge'
            ? '当前分支尾部已核对；较早消息复用本地归档，未重新读取全部历史。'
            : '已沿消息游标取得当前分支；其他分支覆盖范围未验证。' };
      };
      // A current-branch array cannot replace a tree containing abandoned branches.
      if (treeBaseline) return tree();
      if (!flatBaseline) {
        try { return await tree(); }
        catch (error) {
          if (!['HTTP_404', 'FORMAT'].includes(error.code)) throw error;
          return flat();
        }
      }
      try { return await flat(); }
      catch (error) {
        if (!['HTTP_404', 'FORMAT', 'INCOMPLETE_DETAIL', 'DETAIL_PAGINATION', 'DETAIL_CHANGED'].includes(error.code)) throw error;
        return tree();
      }
    },
  });
}

export const chatgptAdapter = createChatGPTAdapter();
