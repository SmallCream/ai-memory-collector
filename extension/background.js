chrome.action.onClicked.addListener(async (tab) => {
  const url = new URL(chrome.runtime.getURL('panel.html'));
  if (Number.isInteger(tab.id)) url.searchParams.set('tab', String(tab.id));
  await chrome.tabs.create({ url: url.href });
});
