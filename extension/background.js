const collectorURL = new URL(chrome.runtime.getURL('panel.html'));
let launchQueue = Promise.resolve();
let lastOpenedTabId = null;

function isCollectorURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === collectorURL.protocol && url.host === collectorURL.host &&
      url.pathname === collectorURL.pathname;
  } catch { return false; }
}

function isMissingTab(error) {
  return /No tab with id|Invalid tab ID/i.test(error?.message || '');
}

async function findCollector(preferredWindowId) {
  // Enumerate only this extension's pages; no permission to read all tab URLs.
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const candidates = contexts.filter(context => Number.isInteger(context.tabId) && context.tabId >= 0 &&
    isCollectorURL(context.documentUrl));
  const existing = candidates.find(context => context.windowId === preferredWindowId) || candidates[0];
  if (existing) return existing;

  // tabs.create may resolve before the document appears in getContexts. Remember
  // that tab during loading so rapid clicks cannot create multiple collectors.
  if (lastOpenedTabId !== null) {
    let tab;
    try { tab = await chrome.tabs.get(lastOpenedTabId); }
    catch (error) {
      if (!isMissingTab(error)) throw error;
      lastOpenedTabId = null;
      return null;
    }
    if (isCollectorURL(tab.pendingUrl || tab.url)) return { tabId: tab.id, windowId: tab.windowId };
    if (!tab.url && !tab.pendingUrl) throw new Error('Cannot verify the existing collector tab.');
    lastOpenedTabId = null;
  }
  return null;
}

async function openCollector(sourceTab = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await findCollector(sourceTab.windowId);
    if (!existing) {
      const url = new URL(collectorURL);
      if (Number.isInteger(sourceTab.id) && sourceTab.id >= 0) url.searchParams.set('tab', String(sourceTab.id));
      const created = await chrome.tabs.create({ url: url.href });
      lastOpenedTabId = created.id;
      return;
    }
    try {
      // Activate only. Navigating/reloading would discard the current operation
      // and would silently change the source selected by the existing collector.
      const tab = await chrome.tabs.update(existing.tabId, { active: true });
      lastOpenedTabId = existing.tabId;
      await chrome.windows.update(tab?.windowId ?? existing.windowId, { focused: true });
      return;
    } catch (error) {
      if (!isMissingTab(error) || attempt === 1) throw error;
      if (lastOpenedTabId === existing.tabId) lastOpenedTabId = null;
      // The user may close a tab between discovery and activation. Re-enumerate
      // before creating a replacement, in case another collector remains open.
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  // MV3 can deliver another click while a previous create/focus is awaiting.
  launchQueue = launchQueue.then(() => openCollector(tab)).catch(() => {
    console.warn('无法打开采集台，请稍后再点击扩展图标。');
  });
  return launchQueue;
});

