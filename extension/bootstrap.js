// A separate loader can still explain failures when a module/import cannot load.
const outputs = () => [document.getElementById('global-status'), ...document.querySelectorAll('[data-action-status]')];
let ready = false;
function reportStartupFailure(message) {
  for (const element of outputs()) {
    if (!element) continue;
    element.textContent = message;
    element.classList.add('error');
  }
  for (const element of document.querySelectorAll('button,input,select')) element.disabled = true;
}
for (const element of document.querySelectorAll('button,input,select')) element.disabled = true;
const timer = setTimeout(() => {
  if (!ready) reportStartupFailure('页面初始化尚未完成（STARTUP_TIMEOUT）。请关闭其他采集台；若仍无响应，在扩展管理页重新加载插件后再打开。');
}, 12000);
window.addEventListener('collector:ready', () => { ready = true; clearTimeout(timer); }, { once: true });
import('./panel.js').catch(() => {
  clearTimeout(timer);
  reportStartupFailure('页面脚本加载失败（STARTUP_FAILED）。请确认通过扩展图标打开，在扩展管理页重新加载插件；更新时需替换整个 extension 文件夹。');
});
