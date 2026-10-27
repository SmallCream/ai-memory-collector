import { extractAssets } from './assets.js';
import { MAX_ASSET_BYTES, assetExtension } from './asset-store.js';
import { doubaoAssetReference } from './doubao-format.js';

/** Download only a resource reconfirmed by this account's original conversation. */
export function createDoubaoAssetResolver(browser, adapter, { fetchImpl = globalThis.fetch } = {}) {
  const active = new Set();
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  return {
    cancel(tabId, { accountKey } = {}) {
      for (const task of active) if (task.tabId === tabId && (!accountKey || task.accountKey === accountKey)) task.controller.abort();
    },
    async resolve({ tabId, account, conversationId, asset }) {
      const controller = new AbortController(), task = { tabId, accountKey: account.accountKey, controller };
      active.add(task); let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); }, 90000);
      try {
        const detail = await adapter.detail(tabId, { accountKey: account.accountKey, conversationId,
          shouldPause: () => controller.signal.aborted });
        const fresh = (await extractAssets(detail.payload)).find(item => item.id === asset.id && item.messageId === asset.messageId);
        if (!fresh || fresh.sourceRef !== asset.sourceRef) fail('ASSET_SOURCE_MISSING', '豆包原对话中未找到这个资源。');
        const raw = fresh.retrieval?.url;
        let url; try { url = new URL(raw); } catch { fail('ASSET_URL', '豆包附件暂无可读取地址。'); }
        const allowed = url.hostname.endsWith('.byteimg.com');
        if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || doubaoAssetReference(raw) !== asset.sourceRef) {
          fail('ASSET_URL', '此豆包资源地址尚未适配，原始来源已保留。');
        }
        if (!await browser.permissions.contains({ origins: [`${url.origin}/*`] })) fail('ASSET_PERMISSION', '请授权豆包图片域名后重试。');
        const response = await fetchImpl(url.href, { credentials: 'omit', redirect: 'error', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!response.ok) fail(`HTTP_${response.status}`, '豆包附件暂时无法下载。');
        const reader = response.body.getReader(), chunks = []; let length = 0;
        try { for (;;) { const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength; if (length > MAX_ASSET_BYTES) fail('ASSET_SIZE', '豆包附件超过 16 MiB 上限。'); chunks.push(value); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim();
        assetExtension(bytes, { ...asset, mimeType });
        const identity = await adapter.identify(tabId);
        if (identity.accountKey !== account.accountKey || identity.platform !== 'doubao') fail('ACCOUNT_CHANGED', '豆包账号已切换，附件未保存。');
        if (controller.signal.aborted) fail(expired ? 'TIMEOUT' : 'COLLECTION_PAUSED', '豆包附件读取已停止。');
        return { bytes, mimeType, quality: 'original' };
      } catch (error) {
        if (controller.signal.aborted) fail(expired ? 'TIMEOUT' : 'COLLECTION_PAUSED', '豆包附件读取已停止。');
        if (typeof error?.code === 'string') throw error;
        fail('NETWORK', '豆包附件读取未完成，原始来源已保留。');
      } finally { clearTimeout(timer); active.delete(task); }
    },
  };
}
