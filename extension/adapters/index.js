import { chatgptAdapter, isChatGPTUrl } from './chatgpt.js';
import { doubaoAdapter, isDoubaoUrl } from './doubao.js';

// Only registered, packaged adapters can execute. No remotely loaded code.
const adapters = new Map([['chatgpt', chatgptAdapter], ['doubao', doubaoAdapter]]);
export const platformSites = Object.freeze([
  { platform: 'chatgpt', origin: 'https://chatgpt.com', label: 'ChatGPT', scriptId: 'collector-chatgpt-entry' },
  { platform: 'doubao', origin: 'https://www.doubao.com', label: '豆包', scriptId: 'collector-doubao-entry' },
]);
export function getAdapter(platform) {
  const adapter = adapters.get(platform);
  if (!adapter) {
    const error = new Error('当前版本尚未支持此 AI 平台。');
    error.code = 'UNSUPPORTED_PLATFORM';
    throw error;
  }
  return adapter;
}
export function adapterForUrl(url) { return isChatGPTUrl(url) ? chatgptAdapter : isDoubaoUrl(url) ? doubaoAdapter : null; }
export const supportedPlatforms = Object.freeze(['chatgpt', 'doubao']);

/** Route only by an observed tab origin; platform implementations stay independent. */
export function createPlatformAdapter(browser, registered = adapters) {
  async function route(tabId, method, input) {
    let tab; try { tab = await browser.tabs.get(tabId); } catch { throw Object.assign(new Error('来源标签页已关闭。'), { code: 'TAB_CLOSED' }); }
    const site = platformSites.find(site => { try { return new URL(tab.url).origin === site.origin; } catch { return false; } });
    const adapter = registered.get(site?.platform);
    if (!adapter) throw Object.assign(new Error('当前标签页不属于支持的平台。'), { code: 'TAB_CHANGED' });
    return adapter[method](tabId, input);
  }
  return {
    identify: tabId => route(tabId, 'identify'), list: (tabId, input) => route(tabId, 'list', input),
    detail: (tabId, input) => route(tabId, 'detail', input),
    cancel: (tabId, input) => Promise.allSettled([...registered.values()].map(adapter => adapter.cancel?.(tabId, input))),
  };
}
