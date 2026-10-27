(() => {
  if (!['https://chatgpt.com', 'https://www.doubao.com'].includes(location.origin) || window.top !== window) return;
  const HOST_ID = 'ai-memory-collector-entry';
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = ':host{all:initial!important;position:fixed!important;right:12px!important;top:44%!important;z-index:2147483646!important;display:block!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif!important}:host([hidden]){display:none!important}.entry{display:flex;align-items:center;border:1px solid #dce3e9;border-radius:12px;background:#fff;box-shadow:0 3px 16px #182b3b17;color:#2d5f83;overflow:hidden}button{border:0;background:transparent;color:inherit;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;cursor:pointer;padding:12px 10px;min-height:44px}button:focus-visible{outline:2px solid #2d5f83;outline-offset:-3px}.open{display:flex;align-items:center;gap:7px}.mark{font-weight:600;background:#edf4f9;border-radius:5px;padding:3px 5px}.hide{font-size:16px;color:#7b8692;padding-left:4px;padding-right:10px}@media(prefers-color-scheme:dark){.entry{background:#25282c;border-color:#434c54;color:#b4d9f0;box-shadow:0 3px 16px #0003}.mark{background:#304551}.hide{color:#b3bdc6}}';
  const entry = document.createElement('div'); entry.className = 'entry';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'open'; open.setAttribute('aria-label', '展开记忆采集器');
  const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = 'M'; mark.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.textContent = '采集器';
  open.append(mark, label);
  const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide'; hide.textContent = '×'; hide.setAttribute('aria-label', '隐藏采集器入口，可从浏览器工具栏恢复');
  entry.append(open, hide); shadow.append(style, entry); document.documentElement.append(host);
  let hidden = false;
  try { hidden = sessionStorage.getItem('collector-entry-hidden') === '1'; } catch { /* Cosmetic preference only. */ }
  host.hidden = hidden;
  function setHidden(value) {
    host.hidden = value;
    try { sessionStorage.setItem('collector-entry-hidden', value ? '1' : '0'); } catch { /* Storage may be unavailable. */ }
  }
  open.addEventListener('click', () => {
    // Send immediately from a user gesture: sidePanel.open requires activation.
    try {
      chrome.runtime.sendMessage({ type: 'collector:open-panel' }).then(reply => {
        if (!reply?.ok) label.textContent = '点击工具栏打开';
      }).catch(() => { label.textContent = '请刷新页面'; });
    } catch { label.textContent = '请刷新页面'; }
  });
  hide.addEventListener('click', () => setHidden(true));
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'collector:show-entry') setHidden(false);
    if (message?.type === 'collector:hide-entry') setHidden(true);
  });
  async function update() {
    if (!chrome.runtime?.id) { host.remove(); clearInterval(timer); return; }
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'collector:content-state' });
      const state = reply?.state || reply;
      const status = state?.status || state?.job?.status;
      label.textContent = ['running', 'scanning', 'collecting', 'saving', 'syncing'].includes(status) ? '采集中' :
        ['paused', 'blocked', 'waiting', 'interrupted'].includes(status) ? '已暂停' :
        status === 'partial' ? '待补采' :
        ['completed', 'done'].includes(status) ? '已完成' : '采集器';
    } catch { /* Disconnected extension will be removed on the next pass. */ }
  }
  const timer = setInterval(() => { if (!document.hidden) update(); }, 5000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  update();
})();
