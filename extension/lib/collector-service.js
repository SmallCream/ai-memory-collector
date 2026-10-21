import { createConfigStore, publicConfig, cleanAlias, collectorError, safeError, INTERVALS } from './config.js';
import { createActivityLog } from './activity-log.js';
export const ALARM_NAME = 'collector-work';
const ORIGIN = 'https://chatgpt.com/*';
const SCRIPT_ID = 'collector-chatgpt-entry';
const matches = value => { try { return new URL(value).origin === 'https://chatgpt.com'; } catch { return false; } };

export function createCollectorService({ browser, getSetting, setSetting, adapter, createEngine,
  readAccountManifest, saveConversation, applyRemoteFiles, syncArchives, probeRepository,
  assetService, restoreService,
  now = Date.now, later = setTimeout }) {
  const settings = createConfigStore({ getSetting, setSetting });
  const identities = new Map(), syncLocks = new Map(), identityReads = new Map();
  const activity = createActivityLog({ getSetting, setSetting, now });
  let pumping = null, continuation = null, startupError = null;
  let mutationQueue = Promise.resolve();
  // Filesystem mutation (collection, remote winner reconciliation, directory
  // replacement) must have one owner. Engine locks alone do not cover GitHub's
  // applyRemoteFiles path or a directory handle swap between two ticks.
  function exclusive(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }
  const engine = createEngine({ getSetting, setSetting, getDirectory: () => getSetting('directory'),
    readAccountManifest, adapter, saveConversation, now });

  async function directoryState() {
    const directory = await getSetting('directory');
    let granted = false;
    try { granted = Boolean(directory) && await directory.queryPermission({ mode: 'readwrite' }) === 'granted'; } catch { /* stale handle */ }
    return { name: directory?.name || '', granted };
  }
  async function sourceTab(preferred) {
    if (Number.isInteger(preferred)) {
      try { const tab = await browser.tabs.get(preferred); if (matches(tab.url)) return tab; } catch { /* closed */ }
      throw collectorError('TAB_UNAVAILABLE', '当前 ChatGPT 标签页已关闭或离开网站，请重新打开。');
    }
    const active = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (active[0] && matches(active[0].url)) return active[0];
    return (await browser.tabs.query({ url: ORIGIN })).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  }
  async function identify(tab, force = false, waitForPause = true) {
    if (!tab) return null;
    const cached = identities.get(tab.id);
    if (!force && cached && now() - cached.at < 10000) return cached.identity;
    try {
      const identity = await adapter.identify(tab.id);
      if (cached?.identity.accountKey && cached.identity.accountKey !== identity.accountKey) {
        const paused = engine.pause(cached.identity.accountKey);
        if (waitForPause) await paused; else void paused.catch(() => {});
      }
      identities.set(tab.id, { at: now(), identity });
      return identity;
    } catch (error) {
      identities.delete(tab.id);
      if (cached?.identity.accountKey) {
        const paused = engine.pause(cached.identity.accountKey);
        if (waitForPause) await paused; else void paused.catch(() => {});
      }
      throw error;
    }
  }
  async function context(tabId, force = false) {
    const tab = await sourceTab(tabId);
    if (!tab) throw collectorError('TAB_UNAVAILABLE', '请打开并登录 ChatGPT，插件会自动识别。');
    const identity = await identify(tab, force), config = await settings.read();
    return { tab, identity, account: config.accounts[identity.accountKey], config };
  }
  async function state(tabId) {
    const config = await settings.read();
    let current = null, error = startupError;
    if (await browser.permissions.contains({ origins: [ORIGIN] })) {
      try {
        const tab = await sourceTab(tabId);
        if (!tab) throw collectorError('TAB_UNAVAILABLE', '请打开并登录 ChatGPT，插件会自动识别。');
        const cached = identities.get(tab.id);
        if (cached && (now() - cached.at >= 10000 || identityReads.has(tab.id))) {
          // Polling remains observable while identity verification or an older
          // account's paused tick is waiting. The UI labels this cached identity.
          if (!identityReads.has(tab.id)) {
            const check = identify(tab, true, false);
            identityReads.set(tab.id, check);
            void check.catch(() => {}).finally(() => { if (identityReads.get(tab.id) === check) identityReads.delete(tab.id); });
          }
          current = { tab, identity: cached.identity, account: config.accounts[cached.identity.accountKey], identityChecking: true };
        } else {
          const identity = await identify(tab, false, false);
          current = { tab, identity, account: config.accounts[identity.accountKey] };
        }
      } catch (e) { error = safeError(e); }
    } else error = { code: 'SITE_PERMISSION_REQUIRED', message: '请先授权访问 ChatGPT，之后会自动识别当前账号。' };
    const account = current?.account || null, directory = await directoryState();
    return { config: publicConfig(config), directory,
      identity: current?.identity || null, identityChecking: current?.identityChecking === true, account,
      job: account ? await engine.getState(account.accountKey) : null,
      lastResult: account?.lastResult || null,
      nextRunAt: config.autoEnabled && account?.enabled ? account.nextRunAt || now() : null,
      githubStatus: account ? await getSetting(`githubStatus:${account.accountKey}`) || { status: 'idle' } : { status: 'idle' },
      assetStatus: account ? await getSetting(`assetStatus:${account.accountKey}`) || null : null,
      assetDiagnostics: account && assetService?.diagnostics ? await assetService.diagnostics({ account,
        directory: directory.granted ? await getSetting('directory') : null, github: config.github }) : null,
      outboxSummary: account && engine.getOutboxSummary ? await engine.getOutboxSummary(account.accountKey) : null,
      activity: Object.fromEntries(await Promise.all(Object.entries({ collection: 'collection', download: 'download',
        upload: 'upload', github: 'github', restoreImages: 'restore-images', restore: 'restore' }).map(async ([name, channel]) =>
        [name, name === 'restore' ? await activity.read('repository', channel) : account ? await activity.read(account.accountKey, channel) : null]))),
      restoreStatus: restoreService ? await restoreService.state() : null,
      legacyPending: Boolean(await getSetting('pendingArchive')), error, tabId: current?.tab.id ?? null };
  }
  async function bind(alias, tabId) {
    const { identity } = await context(tabId, true);
    await settings.change(config => {
      const old = config.accounts[identity.accountKey];
      config.accounts[identity.accountKey] = { ...old, platform: 'chatgpt', accountKey: identity.accountKey,
        displayName: identity.displayName, alias: old?.alias || cleanAlias(alias, identity.displayName),
        storageKey: old?.storageKey || identity.accountKey, enabled: true,
        initialized: old?.initialized || false, nextRunAt: old?.nextRunAt || now() };
      return config;
    });
  }
  async function configure(message) {
    if (message.intervalMinutes !== undefined && !INTERVALS.includes(message.intervalMinutes)) throw collectorError('INVALID_INTERVAL', '请选择 15、30 或 60 分钟。');
    if (message.setupComplete === true) {
      const config = await settings.read();
      if (!Object.values(config.accounts).some(a => a.enabled) || !(await directoryState()).granted) throw collectorError('SETUP_INCOMPLETE', '请先启用账号并选择已授权的保存目录。');
    }
    await settings.change(config => {
      if (typeof message.autoEnabled === 'boolean') config.autoEnabled = message.autoEnabled;
      if (typeof message.setupComplete === 'boolean') config.setupComplete = message.setupComplete;
      if (message.intervalMinutes !== undefined) {
        config.intervalMinutes = message.intervalMinutes;
        for (const account of Object.values(config.accounts)) account.nextRunAt = now() + config.intervalMinutes * 60000;
      }
      return config;
    });
  }
  async function replaceDirectory() {
    const candidate = await getSetting('directoryCandidate'), original = await getSetting('directory');
    if (!candidate) return;
    if (candidate.kind !== 'directory' || typeof candidate.queryPermission !== 'function') throw collectorError('DIRECTORY_PERMISSION', '请选择有效的本地文件夹。');
    if (await candidate.queryPermission({ mode: 'readwrite' }) !== 'granted') throw collectorError('DIRECTORY_PERMISSION', '新目录尚未获得读写权限。');
    let same = false;
    try { same = Boolean(original) && await original.isSameEntry(candidate); } catch { /* new directory */ }
    if (!same) {
      const config = await settings.read();
      for (const account of Object.values(config.accounts)) {
        if (await getSetting(`archiveJournal:${account.platform}:${account.accountKey}`)) {
          throw collectorError('DIRECTORY_PENDING', '原目录还有未完成的文件写入，请先恢复原目录权限并继续保存，再更换目录。');
        }
      }
      for (const account of Object.values(config.accounts)) await engine.reset(account.accountKey);
      await settings.change(current => {
        for (const account of Object.values(current.accounts)) { account.initialized = false; account.lastResult = null; account.nextRunAt = now(); }
        return current;
      });
    }
    await setSetting('directory', candidate);
    await setSetting('directoryCandidate', null);
  }
  async function githubConfig(message) {
    const before = await settings.read();
    await settings.change(config => {
      const previous = config.github;
      const repository = String(message.repository ?? previous.repository).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (repository && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw collectorError('INVALID_REPOSITORY', '请输入 owner/repository 格式的仓库。');
      const token = typeof message.token === 'string' ? message.token.trim() : previous.token;
      config.github = { ...previous, repository, branch: String(message.branch ?? previous.branch).trim(), token,
        lfsEnabled: typeof message.lfsEnabled === 'boolean' ? message.lfsEnabled : previous.lfsEnabled !== false,
        enabled: typeof message.enabled === 'boolean' ? message.enabled : previous.enabled };
      if (config.github.enabled && (!repository || !token)) throw collectorError('GITHUB_CONFIG', '启用 GitHub 同步需要仓库和 Token。');
      return config;
    });
    const after = await settings.read();
    if (before.github.repository !== after.github.repository || before.github.branch !== after.github.branch) {
      for (const account of Object.values(after.accounts)) {
        await setSetting(`assetReceipts:${account.accountKey}`, null);
        await setSetting(`assetUploads:${account.accountKey}`, null);
        const assetStatus = await getSetting(`assetStatus:${account.accountKey}`);
        if (assetStatus) await setSetting(`assetStatus:${account.accountKey}`, { ...assetStatus, uploaded: 0, pendingUpload: assetStatus.local || 0 });
        const job = await engine.getState(account.accountKey);
        const needsBackfill = account.initialized === true || Boolean(before.github.repository);
        await setSetting(`githubStatus:${account.accountKey}`, { status: 'pending', needsBackfill,
          backfillAfterJobId: job?.id || null,
          pending: (await engine.getOutbox(account.accountKey)).length,
          message: needsBackfill ? '仓库已变更，请执行全量补采，将已有归档同步到新仓库。' : '等待首次采集后同步。' });
      }
    }
  }
  async function testGitHub() {
    if (!await browser.permissions.contains({ origins: ['https://api.github.com/*'] })) throw collectorError('GITHUB_PERMISSION', '请先允许访问 GitHub API。');
    const { github } = await settings.read(), [owner, repo] = github.repository.split('/');
    return probeRepository({ owner, repo, branch: github.branch, token: github.token });
  }
  function continueSoon() {
    if (continuation !== null) return;
    continuation = later(() => {
      continuation = null;
      // A slow page/upload may still own the pump when this short timer fires.
      // Schedule after it settles rather than losing the continuation entirely.
      if (pumping) void pumping.then(continueSoon, continueSoon);
      else void pump().catch(() => {});
    }, 1200);
  }
  async function synchronize(account, force = false) {
    if (syncLocks.has(account.accountKey)) return syncLocks.get(account.accountKey);
    const promise = (async () => {
      const { github } = await settings.read();
      if (!github.enabled || !github.token || !await browser.permissions.contains({ origins: ['https://api.github.com/*'] })) return;
      if ((await engine.getState(account.accountKey))?.status === 'running') return;
      const key = `githubStatus:${account.accountKey}`, previous = await getSetting(key);
      if (!force && previous?.nextRetryAt > now()) return;
      const pending = await engine.getOutbox(account.accountKey), outbox = [];
      let bytes = 0;
      const pointerPaths = new Set();
      for (const bundle of pending) {
        const size = new TextEncoder().encode(JSON.stringify(bundle.files)).byteLength;
        const assets = new Set(pointerPaths);
        for (const file of bundle.files) if (file.path.endsWith('/archive/manifest.json')) {
          try { for (const entry of Object.values(JSON.parse(file.content).conversations || {})) {
            for (const asset of entry.assets || []) if (asset.status === 'downloaded' && asset.localPath) assets.add(asset.localPath);
          } } catch { /* Sync validation reports malformed bundles without discarding them. */ }
        }
        if (outbox.length && (outbox.length >= 10 || bytes + size > 24 * 1024 * 1024 || assets.size + (outbox.length + 1) * 4 > 480)) break;
        for (const path of assets) pointerPaths.add(path);
        outbox.push(bundle); bytes += size;
      }
      if (!outbox.length) return;
      await setSetting(key, { ...previous, status: 'syncing', pending: pending.length });
      try {
        const assetPointers = assetService ? await assetService.prepareUploads({ directory: await getSetting('directory'), account, config: github, bundles: outbox }) : [];
        const result = await activity.run(account.accountKey, 'github', { stage: 'commit', total: outbox.length },
          () => syncArchives({ config: github, bundles: outbox, assetPointers }));
        const latest = (await settings.read()).github;
        if (latest.repository !== github.repository || latest.branch !== github.branch || latest.enabled !== github.enabled) {
          throw collectorError('GITHUB_TARGET_CHANGED', '同步目标已变化，待上传数据已保留，请重新同步。');
        }
        for (const winner of result.remoteWinners || []) {
          const directory = await getSetting('directory');
          const saved = await activity.run(account.accountKey, 'github', { stage: 'apply-remote',
            title: winner.entry?.title, conversationId: winner.entry?.conversationId },
          () => applyRemoteFiles({ directory, account, files: winner.files }));
          if (saved?.recovered) await engine.enqueueArchive({ account, archive: saved.recovered });
        }
        await engine.acknowledgeOutbox(account.accountKey, outbox.map(x => x.id));
        if (assetService?.acknowledgeUploads) await assetService.acknowledgeUploads(account);
        const remaining = (await engine.getOutbox(account.accountKey)).length;
        const job = await engine.getState(account.accountKey);
        const needsBackfill = Boolean(previous?.needsBackfill) && !(job?.status === 'completed' && job.initializedComplete &&
          job.id !== previous.backfillAfterJobId && remaining === 0);
        await setSetting(key, { status: result.conflicts?.length ? 'conflicts' : remaining || needsBackfill ? 'pending' : 'synced',
          pending: remaining, conflicts: result.conflicts?.length || 0, lastSyncedAt: now(), commitSha: result.commitSha,
          needsBackfill, backfillAfterJobId: previous?.backfillAfterJobId || null,
          message: needsBackfill ? '仓库已变更，请执行全量补采，将已有归档同步到新仓库。' :
            result.conflicts?.length ? '不同版本已保留到冲突副本，原文没有丢弃。' : '' });
        if (remaining) continueSoon();
      } catch (error) {
        if (error.code === 'LFS_UPLOAD_PENDING') {
          await setSetting(key, { ...previous, status: 'pending', pending: pending.length,
            message: '图片正在分批上传，完成后自动提交对话。', nextRetryAt: 0 });
          continueSoon(); return;
        }
        const attempt = (previous?.attempt || 0) + 1;
        await setSetting(key, { ...previous, status: 'pending', pending: pending.length, error: safeError(error), attempt,
          nextRetryAt: now() + Math.min(60, 2 ** Math.min(attempt, 6)) * 60000 });
        if (force) throw error;
      }
    })();
    syncLocks.set(account.accountKey, promise);
    try { await promise; } finally { syncLocks.delete(account.accountKey); }
  }
  async function finish(account, job, config) {
    if (!['completed', 'partial'].includes(job?.status)) return;
    await settings.change(current => {
      const saved = current.accounts[account.accountKey];
      if (!saved) return current;
      if (job.initializedComplete) saved.initialized = true;
      const completedAt = Number.isFinite(job.completedAt) ? job.completedAt : now();
      if (saved.lastJobId !== job.id || saved.lastJobCompletedAt !== completedAt || saved.lastResult?.status !== job.status) {
        saved.lastJobId = job.id;
        saved.lastJobCompletedAt = completedAt;
        saved.lastResult = { mode: job.mode, status: job.status, added: job.added, updated: job.updated,
          unchanged: job.unchanged, failed: job.failed, completedAt };
        saved.nextRunAt = completedAt + current.intervalMinutes * 60000;
      }
      return current;
    });
  }
  async function processTab(tab, seen) {
    let identity;
    try { identity = await identify(tab); } catch { return; }
    if (seen.has(identity.accountKey)) return;
    seen.add(identity.accountKey);
    let config = await settings.read(), account = config.accounts[identity.accountKey];
    if (!account?.enabled || !config.setupComplete) return;
    let job = await engine.getState(account.accountKey);
    // A worker may have stopped after the engine committed completion but before
    // config.lastResult was written. Reconcile that checkpoint before deciding
    // whether another scheduled run is due.
    if (['completed', 'partial'].includes(job?.status)) {
      await finish(account, job, config);
      config = await settings.read(); account = config.accounts[identity.accountKey];
    }
    if (job?.status === 'blocked' && ['SOURCE_UNAVAILABLE', 'TAB_REQUIRED', 'TAB_CLOSED', 'TAB_CHANGED', 'TAB_UNAVAILABLE',
      'SITE_PERMISSION_DENIED', 'IDENTITY', 'HTTP_401'].includes(job.error?.code) && (await directoryState()).granted) {
      job = await engine.resume({ account, tabId: tab.id });
    }
    if (job?.status === 'running' && !syncLocks.has(account.accountKey)) {
      job = await engine.tick({ account, tabId: tab.id });
      await finish(account, job, config);
      if (job?.status === 'running' && (!job.nextRetryAt || job.nextRetryAt <= now())) continueSoon();
    } else if (config.autoEnabled && (!job || ['completed', 'partial'].includes(job.status)) &&
        (account.nextRunAt || 0) <= now() && !syncLocks.has(account.accountKey)) {
      await engine.start({ account, tabId: tab.id, mode: account.initialized ? 'incremental' : 'initial' });
      continueSoon();
    }
    if (assetService && (await directoryState()).granted) {
      const work = await assetService.tick({ directory: await getSetting('directory'), account, tabId: tab.id,
        manualOnly: job?.status === 'paused' });
      if (work.runnable) continueSoon();
    }
    if (job?.status !== 'running') await synchronize(account);
  }
  function pump() {
    if (pumping) return pumping;
    pumping = exclusive(async () => {
      const seen = new Set();
      if (await browser.permissions.contains({ origins: [ORIGIN] })) {
        const tabs = await browser.tabs.query({ url: ORIGIN });
        for (const tab of tabs.sort((a, b) => Number(b.active) - Number(a.active))) {
          try { await processTab(tab, seen); } catch { /* resumable state is persisted */ }
        }
      }
      const config = await settings.read();
      for (const account of Object.values(config.accounts)) if (account.enabled && !seen.has(account.accountKey)) {
        await engine.suspend(account.accountKey, 'SOURCE_UNAVAILABLE');
        await synchronize(account);
      }
      if (restoreService && config.github.repository && config.github.token && (await directoryState()).granted &&
          await browser.permissions.contains({ origins: ['https://api.github.com/*'] })) {
        try {
          let restore = await restoreService.state();
          const due = await getSetting('restoreNextRunAt') || 0;
          if (config.github.enabled && !['running', 'pending'].includes(restore?.status) && due <= now()) {
            await restoreService.start({ config: config.github, directory: await getSetting('directory') });
            await setSetting('restoreNextRunAt', now() + config.intervalMinutes * 60000);
          }
          restore = await restoreService.tick({ config: config.github, directory: await getSetting('directory') });
          if (restore?.status === 'running' && (!restore.nextRetryAt || restore.nextRetryAt <= now())) continueSoon();
        } catch { /* restore has its own durable state; collection stays independent */ }
      }
    }).finally(() => { pumping = null; });
    return pumping;
  }
  async function enableTab(tab) {
    await browser.sidePanel.setOptions({ tabId: tab.id, enabled: matches(tab.url),
      ...(matches(tab.url) ? { path: `panel.html?tab=${tab.id}` } : {}) });
  }
  async function registerContent() {
    if (!await browser.permissions.contains({ origins: [ORIGIN] })) {
      const scripts = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (scripts.length) await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      // tabs.query without host access still exposes tab IDs; no reading of page
      // content or broad host permission is needed to hide our own UI.
      for (const tab of await browser.tabs.query({})) {
        await browser.sidePanel.setOptions({ tabId: tab.id, enabled: false });
        try { await browser.tabs.sendMessage(tab.id, { type: 'collector:hide-entry' }); } catch { /* no content entry */ }
      }
      for (const cached of identities.values()) await engine.suspend(cached.identity.accountKey, 'SITE_PERMISSION_DENIED');
      identities.clear();
      return;
    }
    const scripts = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (!scripts.length) await browser.scripting.registerContentScripts([{ id: SCRIPT_ID, matches: [ORIGIN], js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
    for (const tab of await browser.tabs.query({ url: ORIGIN })) {
      await enableTab(tab);
      try { await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch { /* navigating */ }
    }
  }
  async function initialize() {
    try {
      await browser.sidePanel.setOptions({ enabled: false });
      if (!await browser.alarms.get(ALARM_NAME)) await browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
      await registerContent(); startupError = null;
    } catch (error) { startupError = safeError(error); }
  }
  async function executeCommand(message, tabId) {
    switch (message.type) {
      case 'collector:get-state': return { ok: true, state: await state(tabId) };
      case 'collector:bind': await bind(message.alias, tabId); break;
      case 'collector:configure': await configure(message); break;
      case 'collector:directory-changed': await replaceDirectory(); break;
      case 'collector:github-config': await githubConfig(message); break;
      case 'collector:github-test': return { ok: true, result: await testGitHub(), state: await state(tabId) };
      case 'collector:restore':
      case 'collector:restore-retry': {
        if (!restoreService) throw collectorError('RESTORE_UNAVAILABLE', '当前版本不支持恢复。');
        const { github } = await settings.read();
        if (!(await directoryState()).granted) throw collectorError('DIRECTORY_PERMISSION', '请先选择并授权本地保存目录。');
        if (!await browser.permissions.contains({ origins: ['https://api.github.com/*'] })) throw collectorError('GITHUB_PERMISSION', '请先允许访问 GitHub。');
        await restoreService.start({ config: github, directory: await getSetting('directory'), force: message.type === 'collector:restore-retry' });
        continueSoon(); break;
      }
      case 'collector:permissions-changed': await registerContent(); break;
      case 'collector:retry-images': {
        if (!assetService?.retryFailed) throw collectorError('ASSET_UNAVAILABLE', '当前版本不支持图片补采。');
        if (!await browser.permissions.contains({ origins: [ORIGIN] })) throw collectorError('SITE_PERMISSION_REQUIRED', '请先恢复 ChatGPT 站点访问权限。');
        const { account } = await context(tabId, true);
        if (!account?.enabled) throw collectorError('ACCOUNT_DISABLED', '请先启用当前账号。');
        if (!(await directoryState()).granted) throw collectorError('DIRECTORY_PERMISSION', '请在设置中恢复保存目录权限。');
        await assetService.retryFailed({ account, ...(message.includeInternal === true ? { includeInternal: true } : {}) }); continueSoon(); break;
      }
      case 'collector:start': {
        const { account, tab, config } = await context(tabId, true);
        if (!account?.enabled || !config.setupComplete) throw collectorError('SETUP_INCOMPLETE', '请先完成配置并启用此账号。');
        if (!(await directoryState()).granted) throw collectorError('DIRECTORY_PERMISSION', '请在设置中恢复保存目录权限。');
        if (syncLocks.has(account.accountKey)) throw collectorError('BUSY', '正在同步本地文件，请稍后开始采集。');
        await engine.start({ account, tabId: tab.id, mode: message.mode }); continueSoon(); break;
      }
      case 'collector:pause': { const { account } = await context(tabId); if (account) await engine.pause(account.accountKey); break; }
      case 'collector:resume': {
        const { account, tab } = await context(tabId, true);
        if (!account?.enabled) throw collectorError('ACCOUNT_DISABLED', '请先启用此账号。');
        if (syncLocks.has(account.accountKey)) throw collectorError('BUSY', '正在同步本地文件，请稍后继续采集。');
        await engine.resume({ account, tabId: tab.id }); continueSoon(); break;
      }
      case 'collector:retry-github': { const { account } = await context(tabId); if (account) await synchronize(account, true); break; }
      default: throw collectorError('UNKNOWN_COMMAND', '不支持的插件操作。');
    }
    return { ok: true, state: await state(tabId) };
  }
  function command(message, tabId) {
    if (message.type === 'collector:get-state') return executeCommand(message, tabId);
    return exclusive(() => executeCommand(message, tabId));
  }
  return { initialize, command, state, pump, enableTab, identify, engine,
    async tabGone(tabId) {
      const cached = identities.get(tabId);
      identities.delete(tabId);
      if (cached?.identity.accountKey) await exclusive(() => engine.suspend(cached.identity.accountKey, 'SOURCE_UNAVAILABLE'));
      continueSoon();
    },
    async contentState(tabId) {
      try { const s = await state(tabId); return { ok: true, account: s.account?.alias || s.identity?.displayName || '',
        status: s.job?.status || 'idle', running: s.job?.status === 'running',
        label: s.job?.status === 'running' ? '采集中' : s.job?.status === 'completed' ? '已完成' : '采集器' };
      } catch { return { ok: true, label: '采集器', status: 'idle', running: false }; }
    } };
}
