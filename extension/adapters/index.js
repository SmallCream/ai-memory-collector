import { chatgptAdapter, isChatGPTUrl } from './chatgpt.js';

// Only registered, packaged adapters can execute. No remotely loaded code.
const adapters = new Map([['chatgpt', chatgptAdapter]]);
export function getAdapter(platform) {
  const adapter = adapters.get(platform);
  if (!adapter) {
    const error = new Error('当前版本尚未支持此 AI 平台。');
    error.code = 'UNSUPPORTED_PLATFORM';
    throw error;
  }
  return adapter;
}
export function adapterForUrl(url) { return isChatGPTUrl(url) ? chatgptAdapter : null; }
export const supportedPlatforms = Object.freeze(['chatgpt']);
