import { getSetting, setSetting } from './lib/storage.js';
import { getAdapter } from './adapters/index.js';
import { createCollectorEngine } from './lib/collector-engine.js';
import { readAccountManifest, hasConversationFiles, readConversationBaseline, readConversationArchive,
  repairMissingMarkdown, saveConversation, applyRemoteFiles } from './lib/archive-store.js';
import { syncArchives } from './lib/github-sync.js';
import { probeRepository } from './lib/github.js';
import { createCollectorService, ALARM_NAME } from './lib/collector-service.js';
import { safeError } from './lib/config.js';
import { createAssetService } from './lib/asset-service.js';
import { createChatGPTAssetResolver } from './lib/chatgpt-assets.js';
import { createRestoreService } from './lib/restore-service.js';
import { fetchRepositorySnapshot, downloadRepositoryFile } from './lib/github-restore.js';
import { createLocalMaintenance } from './lib/local-maintenance.js';

const resolver = createChatGPTAssetResolver(chrome, { allowLibraryDownload: true, allowFileDownload: true });
const adapter = getAdapter('chatgpt');
const lockedSave = input => service.withFileLock(() => saveConversation(input));
const lockedApply = input => service.withFileLock(() => applyRemoteFiles(input));
const assets = createAssetService({ getSetting, setSetting, readAccountManifest, saveConversation: lockedSave,
  resolveAsset: resolver.resolve, downloadRepositoryFile,
  refreshConversation: ({ tabId, ...request }) => adapter.detail(tabId, request),
  enqueueArchive: input => service.engine.enqueueArchive(input) });
const restore = createRestoreService({ getSetting, setSetting, fetchRepositorySnapshot, downloadRepositoryFile,
  applyRemoteFiles: lockedApply, readLocalManifest: readAccountManifest, hydrateAssets: assets.hydrateAssets,
  // Replayed local capture journals already carry authorized account ownership.
  // Queue them without creating a binding; only enabled configured accounts upload.
  enqueueRecovered: ({ account, archive }) => service.engine.enqueueArchive({ account: { ...account, enabled: true }, archive }) });
const maintenance = createLocalMaintenance({ getSetting, setSetting, readAccountManifest, readConversationArchive,
  repairMissingMarkdown: input => service.withFileLock(() => repairMissingMarkdown(input)),
  enqueueArchive: input => service.engine.enqueueArchive(input), requeueMissing: input => assets.requeueMissing(input) });
const service = createCollectorService({ browser: chrome, getSetting, setSetting,
  adapter, createEngine: createCollectorEngine,
  readAccountManifest, hasConversationFiles, readConversationBaseline, readConversationArchive,
  saveConversation: assets.save, applyRemoteFiles: lockedApply, syncArchives, probeRepository,
  assetService: assets, restoreService: restore, maintenanceService: maintenance, cancelAssets: resolver.cancel });
const extensionURL = new URL(chrome.runtime.getURL('/'));
const ignore = promise => Promise.resolve(promise).catch(() => {});
const trustedUI = sender => {
  try { const url = new URL(sender.url); return sender.id === chrome.runtime.id &&
    url.protocol === extensionURL.protocol && url.host === extensionURL.host && url.pathname === '/panel.html'; } catch { return false; }
};
const trustedSource = sender => {
  try { return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) &&
    new URL(sender.url).origin === 'https://chatgpt.com' && sender.frameId === 0; } catch { return false; }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const ui = trustedUI(sender), source = trustedSource(sender);
  if (!ui && !source) return false;
  if (source && !['collector:open-panel', 'collector:content-state'].includes(message.type)) {
    sendResponse({ ok: false, error: { code: 'FORBIDDEN', message: '网页只能打开采集器或读取简短状态。' } }); return false;
  }
  const tabId = source ? sender.tab.id : Number.isInteger(message.tabId) ? message.tabId : undefined;
  let work;
  if (message.type === 'collector:open-panel') {
    // Preserve the content button's user gesture; do not await storage first.
    try { work = Promise.resolve(chrome.sidePanel.open({ tabId })).then(() => ({ ok: true })); }
    catch (error) { sendResponse({ ok: false, error: safeError(error) }); return false; }
  } else if (message.type === 'collector:content-state') {
    work = service.contentState(tabId);
  } else if (message.type === 'collector:close-panel') {
    work = (async () => {
      const id = tabId ?? (await service.state()).tabId;
      if (!Number.isInteger(id)) return { ok: true };
      await ignore(chrome.tabs.sendMessage(id, { type: message.hide ? 'collector:hide-entry' : 'collector:show-entry' }));
      if (chrome.sidePanel.close) await chrome.sidePanel.close({ tabId: id });
      else {
        await chrome.sidePanel.setOptions({ tabId: id, enabled: false });
        await chrome.sidePanel.setOptions({ tabId: id, path: `panel.html?tab=${id}`, enabled: true });
      }
      return { ok: true };
    })();
  } else work = service.command(message, tabId);
  Promise.resolve(work).then(sendResponse).catch(error => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  if (tab.url?.startsWith('https://chatgpt.com/')) {
    ignore(chrome.tabs.sendMessage(tab.id, { type: 'collector:show-entry' }));
    ignore(chrome.sidePanel.open({ tabId: tab.id }).catch(async () => {
      await service.enableTab(tab);
      await chrome.sidePanel.open({ tabId: tab.id });
    }));
  } else ignore(chrome.runtime.openOptionsPage());
});
chrome.runtime.onInstalled.addListener(details => {
  ignore(service.initialize().then(() => {
    if (details.reason === 'install') return chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?setup=1') });
  }));
});
chrome.runtime.onStartup.addListener(() => ignore(service.initialize().then(() => service.pump())));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM_NAME) ignore(service.pump()); });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status === 'complete') ignore(service.enableTab(tab).then(async () => {
    if (change.url && !/^https:\/\/chatgpt\.com(?:\/|$)/.test(change.url)) await service.tabGone(id);
    await service.pump();
  }));
});
chrome.tabs.onActivated.addListener(info => ignore(chrome.tabs.get(info.tabId).then(async tab => {
  await service.enableTab(tab);
  if (tab.url?.startsWith('https://chatgpt.com/')) await service.identify(tab, true).catch(() => {});
  await service.pump();
})));
chrome.tabs.onRemoved.addListener(id => ignore(service.tabGone(id)));
chrome.permissions.onAdded.addListener(() => ignore(service.initialize()));
chrome.permissions.onRemoved.addListener(() => ignore(service.initialize()));
// Check on every worker incarnation; an update/restart may clear an alarm.
ignore(service.initialize());
