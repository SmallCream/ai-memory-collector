import { createConfigStore, publicConfig, cleanAlias, collectorError, safeError, INTERVALS } from './config.js';
import { createActivityLog } from './activity-log.js';
import { createLocalUploadQueue } from './local-upload-queue.js';
export const ALARM_NAME = 'collector-work';
const ORIGIN = 'https://chatgpt.com/*';
const SCRIPT_ID = 'collector-chatgpt-entry';
const matches = value => { try { return new URL(value).origin === 'https://chatgpt.com'; } catch { return false; } };

export function createCollectorService({ browser, getSetting, setSetting, getSettingsByPrefix, adapter, createEngine,
  readAccountManifest, hasConversationFiles, readConversationBaseline, saveConversation, applyRemoteFiles, syncArchives, probeRepository,
  assetService, restoreService, maintenanceService, readConversationArchive, cancelAssets,
  now = Date.now, later = setTimeout }) {
  const settings = createConfigStore({ getSetting, setSetting });
  const identities = new Map(), syncLocks = new Map(), identityReads = new Map(), accountWork = new Map();
  const activity = createActivityLog({ getSetting, setSetting, now });
  let pumping = null, continuation = null, startupError = null, restoring = null, changingDirectory = false;
  let mutationQueue = Promise.resolve();
  let fileQueue = Promise.resolve();
  // Short commands and file commits are serialized independently of network
  // waits. Each account still has one worker; directory replacement drains it.
  function exclusive(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }
  function withFileLock(operation) {
    const result = fileQueue.then(operation, operation);
    fileQueue = result.catch(() => {});
    return result;
  }
  async function cancelSource(tabId, accountKey) {
    await Promise.allSettled([
      adapter.cancel?.(tabId, { accountKey }), cancelAssets?.(tabId, { accountKey }),
    ]);
  }
  function runAccount(accountKey, operation) {
    if (accountWork.has(accountKey)) return accountWork.get(accountKey);
    const work = Promise.resolve().then(operation).finally(() => {
      if (accountWork.get(accountKey) === work) accountWork.delete(accountKey);
    });
    accountWork.set(accountKey, work);
    return work;
  }
  function queueAccount(accountKey, operation) {
    const prior = accountWork.get(accountKey) || Promise.resolve();
    const work = prior.catch(() => {}).then(operation).finally(() => {
      if (accountWork.get(accountKey) === work) accountWork.delete(accountKey);
    });
    accountWork.set(accountKey, work); return work;
  }
  const engine = createEngine({ getSetting, setSetting, getDirectory: () => getSetting('directory'),
    readAccountManifest, hasConversationFiles, readConversationBaseline, adapter, saveConversation, now,
    shouldQueueUpload: async () => (await settings.read()).github.enabled });
  const uploadQueue = readConversationArchive ? createLocalUploadQueue({ getSetting, setSetting,
    readAccountManifest, readConversationArchive, enqueueArchive: input => engine.enqueueArchive(input), now }) : null;

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
        await cancelSource(tab.id, cached.identity.accountKey);
        const paused = engine.pause(cached.identity.accountKey);
        if (waitForPause) await paused; else void paused.catch(() => {});
      }
      identities.set(tab.id, { at: now(), identity });
      return identity;
    } catch (error) {
      identities.delete(tab.id);
      if (cached?.identity.accountKey) {
        const interrupted = (await engine.getState(cached.identity.accountKey))?.status === 'running';
        await cancelSource(tab.id, cached.identity.accountKey);
        const code = ['HTTP_401', 'HTTP_403', 'SITE_PERMISSION_DENIED', 'TAB_REQUIRED', 'TAB_CLOSED',
          'TAB_CHANGED', 'TAB_UNAVAILABLE'].includes(error?.code) ? error.code : 'IDENTITY';
        const suspended = engine.suspend(cached.identity.accountKey, code, { interrupted });
        if (waitForPause) await suspended; else void suspended.catch(() => {});
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
        directory: directory.granted ? await getSetting('directory') : null,
        captureEnabled: config.localAssetsEnabled !== false }) : null,
      maintenanceStatus: account && maintenanceService ? await maintenanceService.state(account) : null,
      outboxSummary: account && engine.getOutboxSummary ? await engine.getOutboxSummary(account.accountKey) : null,
      activity: Object.fromEntries(await Promise.all(Object.entries({ collection: 'collection', download: 'download',
        github: 'github', restore: 'restore' }).map(async ([name, channel]) =>
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
      if (typeof message.localAssetsEnabled === 'boolean') config.localAssetsEnabled = message.localAssetsEnabled;
      if (typeof message.setupComplete === 'boolean') config.setupComplete = message.setupComplete;
      if (message.intervalMinutes !== undefined) {
        config.intervalMinutes = message.intervalMinutes;
        for (const account of Object.values(config.accounts)) account.nextRunAt = now() + config.intervalMinutes * 60000;
      }
      return config;
    });
    continueSoon();
  }
  async function replaceDirectory() {
    const candidate = await getSetting('directoryCandidate'), original = await getSetting('directory');
    if (!candidate) return;
    if (candidate.kind !== 'directory' || typeof candidate.queryPermission !== 'function') throw collectorError('DIRECTORY_PERMISSION', '请选择有效的本地文件夹。');
    if (await candidate.queryPermission({ mode: 'readwrite' }) !== 'granted') throw collectorError('DIRECTORY_PERMISSION', '新目录尚未获得读写权限。');
    let same = false;
    try { same = Boolean(original) && await original.isSameEntry(candidate); } catch { /* new directory */ }
    if (!same) changingDirectory = true;
    try {
    if (!same) {
      if (pumping) await pumping;
      const config = await settings.read();
      if (restoring) throw collectorError('BUSY', '正在恢复本地文件，请等待当前文件保存完成后更换目录。');
      // Cancel reads first, then let already-started journal commits settle.
      await Promise.allSettled([...identities].map(async ([tabId, cached]) => {
        const paused = engine.pause(cached.identity.accountKey);
        await cancelSource(tabId, cached.identity.accountKey); await paused;
      }));
      await Promise.allSettled([...accountWork.values()]);
      await fileQueue;
      // Restore can write archives for accounts that have no local binding.
      // Unknown directory ownership must also keep the pending write recoverable.
      for (const { value: pending } of await getSettingsByPrefix('archiveJournal:')) {
        if (!pending) continue;
        let belongsToOriginal = !pending.directory || pending.directory === original;
        if (!belongsToOriginal && original) {
          try { belongsToOriginal = await original.isSameEntry(pending.directory); } catch { belongsToOriginal = true; }
        }
        if (belongsToOriginal) throw collectorError('DIRECTORY_PENDING', '原目录还有未完成的文件写入，请先恢复原目录权限并继续保存，再更换目录。');
      }
      // Asset journals can exist before their hashes reach a conversation manifest.
      // Inspect the durable journal store, including accounts restored without a binding.
      for (const { value: pending } of await getSettingsByPrefix('assetWrite:')) {
        if (!pending) continue;
        let belongsToOriginal = pending.directory === original;
        if (!belongsToOriginal && original) {
          try { belongsToOriginal = await original.isSameEntry(pending.directory); } catch { belongsToOriginal = true; }
        }
        if (belongsToOriginal) throw collectorError('DIRECTORY_PENDING', '原目录还有未完成的附件写入，请先在原目录重试附件，再更换目录。');
      }
      for (const account of Object.values(config.accounts)) await engine.reset(account.accountKey);
      await settings.change(current => {
        for (const account of Object.values(current.accounts)) { account.initialized = false; account.lastResult = null; account.nextRunAt = now(); }
        return current;
      });
    }
    await setSetting('directory', candidate);
    await setSetting('directoryCandidate', null);
    } finally { changingDirectory = false; continueSoon(); }
  }
  async function githubConfig(message) {
    await settings.change(async config => {
      const previous = config.github;
      const repository = String(message.repository ?? previous.repository).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (repository && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw collectorError('INVALID_REPOSITORY', '请输入 owner/repository 格式的仓库。');
      const token = typeof message.token === 'string' ? message.token.trim() : previous.token;
      config.github = { ...previous, repository, branch: String(message.branch ?? previous.branch).trim(), token,
        autoRestore: typeof message.autoRestore === 'boolean' ? message.autoRestore : previous.autoRestore === true,
        enabled: typeof message.enabled === 'boolean' ? message.enabled : previous.enabled,
        revision: Number.isSafeInteger(previous.revision) && previous.revision >= 0 && previous.revision < Number.MAX_SAFE_INTEGER
          ? previous.revision + 1 : 1 };
      if ((config.github.enabled || config.github.autoRestore) && (!repository || !token)) throw collectorError('GITHUB_CONFIG', '启用 GitHub 备份或恢复需要仓库和 Token。');
      const changedTarget = previous.repository !== config.github.repository || previous.branch !== config.github.branch;
      const needsLocalScan = changedTarget || (!previous.enabled && config.github.enabled);
      // Keep settings and their task intent under the same short config lock.
      // An older network operation cannot restore a cancelled manual request or
      // erase this new target's backfill when its response arrives later.
      for (const account of Object.values(config.accounts)) {
        const key = `githubStatus:${account.accountKey}`, status = await getSetting(key) || {};
        await setSetting(key, { ...status, revision: config.github.revision, error: null, nextRetryAt: 0,
          ...(status.status === 'syncing' ? { status: 'pending', message: '备份设置已更新，待处理数据已保留。' } : {}),
          ...(changedTarget ? { status: 'pending', pending: (await engine.getOutbox(account.accountKey)).length,
            message: '将从本地归档建立备份任务。' } : {}),
          ...(needsLocalScan ? { status: 'pending', needsBackfill: true, backfillStarted: false, manual: false,
            message: '将从本地归档建立备份任务。' } : {}),
          ...(message.enabled === false ? { manual: false } : {}) });
      }
      return config;
    });
    continueSoon();
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
  async function synchronize(account, force = false, expectedRevision = null) {
    if (syncLocks.has(account.accountKey)) return syncLocks.get(account.accountKey);
    const promise = (async () => {
      const { github } = await settings.read();
      if (changingDirectory || expectedRevision !== null && github.revision !== expectedRevision) return;
      const key = `githubStatus:${account.accountKey}`;
      const sameSettings = value => ['repository', 'branch', 'token', 'enabled', 'autoRestore', 'revision']
        .every(field => value?.[field] === github[field]);
      const stillCurrent = async () => sameSettings((await settings.read()).github);
      async function whileCurrent(operation) {
        let current = false;
        // Serialize only local intent/receipt changes, never a network wait.
        // Checking and writing in separate awaits would still race a settings
        // change between the check and the old operation's status update.
        await settings.change(async config => {
          if (!sameSettings(config.github)) return config;
          current = true; await operation(); return config;
        });
        return current;
      }
      const writeStatus = value => whileCurrent(() => setSetting(key, { ...value, revision: github.revision || 0 }));
      let previous = await getSetting(key) || {};
      const manual = force || previous.manual === true && previous.manualRepository === github.repository && previous.manualBranch === github.branch;
      if ((!github.enabled && !manual) || !github.token || !await browser.permissions.contains({ origins: ['https://api.github.com/*'] })) return;
      if ((await engine.getState(account.accountKey))?.status === 'running') return;
      if (!force && previous?.nextRetryAt > now()) return;
      if (manual) previous = { ...previous, manual: true, manualRepository: github.repository, manualBranch: github.branch };
      if (uploadQueue && (previous.needsBackfill || force)) {
        const input = { directory: await getSetting('directory'), account, github };
        try {
          if (!await whileCurrent(async () => {
            if (!previous.backfillStarted || force) {
              await uploadQueue.start(input); previous.backfillStarted = true;
            }
            const scan = await uploadQueue.tick(input);
            previous.backfill = scan;
            previous.needsBackfill = scan?.status !== 'completed';
            await setSetting(key, { ...previous, revision: github.revision || 0 });
            if (scan?.status === 'running') continueSoon();
          })) return;
        } catch (error) {
          if (!await writeStatus({ ...previous, error: safeError(error), status: 'pending', nextRetryAt: now() + 60000 })) return;
          if (force) throw error;
          return;
        }
      }
      const pending = await engine.getOutbox(account.accountKey), outbox = [];
      let bytes = 0;
      for (const bundle of pending) {
        const size = new TextEncoder().encode(JSON.stringify(bundle.files)).byteLength;
        if (outbox.length && (outbox.length >= 10 || bytes + size > 24 * 1024 * 1024)) break;
        outbox.push(bundle); bytes += size;
      }
      if (!outbox.length) {
        if (previous.manual || previous.backfill) await writeStatus({ ...previous,
          status: previous.needsBackfill ? ['running', 'waiting'].includes(previous.backfill?.status) ? 'pending' : 'partial' : 'synced', pending: 0,
          manual: previous.needsBackfill && ['running', 'waiting'].includes(previous.backfill?.status) ? manual : false,
          nextRetryAt: previous.backfill?.status === 'waiting' ? previous.backfill.nextRetryAt : 0,
          message: previous.backfill?.status === 'waiting' ? '本地归档暂时无法读取，等待自动重试。' :
            previous.backfill?.status === 'running' ? '正在准备剩余的本地归档。' :
              previous.needsBackfill ? '部分本地归档尚未加入备份，请先补齐缺失或处理文件冲突。' : '当前本地归档已完成备份。' });
        return;
      }
      // A new attempt supersedes the last attempt's display state. Keep its
      // attempt count/backfill checkpoint, but do not show an old error or
      // upload message while this request is running.
      if (!await writeStatus({ ...previous, status: 'syncing', pending: pending.length,
        message: '', error: null, nextRetryAt: 0 })) return;
      try {
        if (!await stillCurrent()) return;
        const result = await activity.run(account.accountKey, 'github', { stage: 'commit', total: outbox.length },
          () => syncArchives({ config: github, bundles: outbox, isCurrent: stillCurrent }));
        await whileCurrent(async () => {
          for (const winner of result.remoteWinners || []) {
            const directory = await getSetting('directory');
            const saved = await activity.run(account.accountKey, 'github', { stage: 'apply-remote',
              title: winner.entry?.title, conversationId: winner.entry?.conversationId },
            () => applyRemoteFiles({ directory, account, files: winner.files }));
            if (saved?.recovered) await engine.enqueueArchive({ account, archive: saved.recovered, forceUpload: manual });
          }
          await engine.acknowledgeOutbox(account.accountKey, outbox.map(x => x.id));
          const remaining = (await engine.getOutbox(account.accountKey)).length;
          const needsBackfill = Boolean(previous.needsBackfill);
          await setSetting(key, { ...previous, revision: github.revision || 0,
            status: result.conflicts?.length ? 'conflicts' : remaining || needsBackfill ? 'pending' : 'synced',
            pending: remaining, conflicts: result.conflicts?.length || 0, lastSyncedAt: now(), commitSha: result.commitSha,
            needsBackfill, error: null, nextRetryAt: previous.backfill?.status === 'waiting' ? previous.backfill.nextRetryAt : 0, attempt: 0,
            manual: manual && (remaining > 0 || ['running', 'waiting'].includes(previous.backfill?.status)),
            message: previous.backfill?.status === 'waiting' ? '已备份可读取的文件，剩余本地归档等待自动重试。' :
              needsBackfill ? '正在从本地归档建立备份任务；缺失或冲突文件需先处理。' :
              result.conflicts?.length ? '不同版本已保留到冲突副本，原文没有丢弃。' :
                '对话文件已备份；图片和附件保存在本地。' });
          if (remaining) continueSoon();
        });
      } catch (error) {
        const attempt = (previous?.attempt || 0) + 1;
        if (!await writeStatus({ ...previous, status: 'pending', pending: pending.length, message: '', error: safeError(error), attempt,
          nextRetryAt: now() + Math.min(60, 2 ** Math.min(attempt, 6)) * 60000 })) return;
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
  async function maintain(account) {
    if (!maintenanceService || !(await directoryState()).granted) return;
    const result = await maintenanceService.tick({ directory: await getSetting('directory'), account });
    if (result?.runnable) continueSoon();
  }
  async function cooldown(account) {
    const source = engine.getRetryState ? await engine.getRetryState(account.accountKey) : null;
    const assets = assetService?.getCooldown ? await assetService.getCooldown(account) : 0;
    return Math.max(source?.cooldownUntil || 0, source?.accountCooldownUntil || 0, assets || 0);
  }
  async function processTab(tab, identity) {
    let config = await settings.read(), account = config.accounts[identity.accountKey];
    if (!account?.enabled || !config.setupComplete) return;
    await maintain(account);
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
    if (job?.status === 'running' && !syncLocks.has(account.accountKey) && await cooldown(account) <= now()) {
      job = await engine.tick({ account, tabId: tab.id });
      await finish(account, job, config);
      if (job?.status === 'running' && (!job.nextRetryAt || job.nextRetryAt <= now())) continueSoon();
    } else if (config.autoEnabled && (!job || ['completed', 'partial'].includes(job.status)) &&
        (account.nextRunAt || 0) <= now() && !syncLocks.has(account.accountKey)) {
      await engine.start({ account, tabId: tab.id, mode: account.initialized ? 'incremental' : 'initial' });
      continueSoon();
    }
    if (assetService && (await directoryState()).granted) {
      // Network waits do not own the global file lock. Honor current settings,
      // including a toggle changed while the preceding detail was in flight.
      config = await settings.read();
      const work = await assetService.tick({ directory: await getSetting('directory'), account, tabId: tab.id,
        captureEnabled: config.localAssetsEnabled !== false, networkAllowed: await cooldown(account) <= now(),
        manualOnly: job?.status === 'paused' });
      if (work.runnable) continueSoon();
    }
    if (job?.status !== 'running') await synchronize(account);
  }
  async function restoreTick() {
    if (restoring || pumping || changingDirectory || accountWork.size || !restoreService) return restoring;
    const work = (async () => {
      const config = await settings.read();
      if (!config.github.repository || !config.github.token || !(await directoryState()).granted ||
        !await browser.permissions.contains({ origins: ['https://api.github.com/*'] })) return;
      try {
        let restore = await restoreService.state();
        const due = await getSetting('restoreNextRunAt') || 0;
        let request = await getSetting('restoreRequest') || {};
        if (config.github.autoRestore && !['running', 'pending'].includes(restore?.status) && due <= now()) {
          await restoreService.start({ config: config.github, directory: await getSetting('directory') });
          request = { manual: false, repository: config.github.repository, branch: config.github.branch };
          await setSetting('restoreRequest', request);
          await setSetting('restoreNextRunAt', now() + config.intervalMinutes * 60000);
        }
        const manual = request.manual && request.repository === config.github.repository && request.branch === config.github.branch;
        if (!config.github.autoRestore && !manual) return;
        restore = await restoreService.tick({ config: config.github, directory: await getSetting('directory') });
        if (restore?.status === 'running' && (!restore.nextRetryAt || restore.nextRetryAt <= now())) continueSoon();
        if (manual && !['running', 'pending'].includes(restore?.status)) await setSetting('restoreRequest', { ...request, manual: false });
      } catch { /* Recovery state remains owned by the restore service. */ }
    })().finally(() => { if (restoring === work) restoring = null; });
    restoring = work; return work;
  }
  function pump() {
    if (pumping) return pumping.then(work => Promise.allSettled(work));
    // Only discovery is single-flight. Already-running accounts are reused;
    // another account can make progress while one long detail is still reading.
    const dispatch = (async () => {
      if (changingDirectory) return [];
      if (restoring) return [restoring];
      const seen = new Set(), work = [];
      if (await browser.permissions.contains({ origins: [ORIGIN] })) {
        const tabs = await browser.tabs.query({ url: ORIGIN });
        await Promise.allSettled(tabs.sort((a, b) => Number(b.active) - Number(a.active)).map(async tab => {
          const identity = await identify(tab);
          if (seen.has(identity.accountKey)) return;
          seen.add(identity.accountKey);
          if (restoring || changingDirectory) return;
          work.push(runAccount(identity.accountKey, () => processTab(tab, identity)));
        }));
      }
      const config = await settings.read();
      for (const account of Object.values(config.accounts)) if (account.enabled && !seen.has(account.accountKey)) {
        if (restoring || changingDirectory) break;
        work.push(runAccount(account.accountKey, async () => {
          await engine.suspend(account.accountKey, 'SOURCE_UNAVAILABLE');
          await maintain(account);
          await synchronize(account);
        }));
      }
      return work;
    })();
    pumping = dispatch.finally(() => { pumping = null; });
    return pumping.then(work => Promise.allSettled(work)).then(() => restoreTick());
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
      for (const [tabId, cached] of identities) {
        const interrupted = (await engine.getState(cached.identity.accountKey))?.status === 'running';
        await cancelSource(tabId, cached.identity.accountKey);
        await engine.suspend(cached.identity.accountKey, 'SITE_PERMISSION_DENIED', { interrupted });
      }
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
        await setSetting('restoreRequest', { manual: true, repository: github.repository, branch: github.branch });
        continueSoon(); break;
      }
      case 'collector:repair-local': {
        if (!maintenanceService) throw collectorError('MAINTENANCE_UNAVAILABLE', '当前版本不支持本地补齐。');
        if (!(await directoryState()).granted) throw collectorError('DIRECTORY_PERMISSION', '请先恢复保存目录权限。');
        const config = await settings.read();
        let current;
        try { current = (await context(tabId)).account; } catch { /* local checks need no login */ }
        const accounts = current?.enabled ? [current] : Object.values(config.accounts).filter(account => account.enabled);
        for (const account of accounts) await queueAccount(account.accountKey, async () => {
          await maintenanceService.start({ account });
          if (assetService?.requestMissing) await assetService.requestMissing({ account });
        });
        continueSoon(); break;
      }
      case 'collector:permissions-changed': await registerContent(); break;
      case 'collector:retry-images': {
        if (!assetService?.retryFailed) throw collectorError('ASSET_UNAVAILABLE', '当前版本不支持附件补采。');
        if (!await browser.permissions.contains({ origins: [ORIGIN] })) throw collectorError('SITE_PERMISSION_REQUIRED', '请先恢复 ChatGPT 站点访问权限。');
        const { account } = await context(tabId, true);
        if (!account?.enabled) throw collectorError('ACCOUNT_DISABLED', '请先启用当前账号。');
        if (!(await directoryState()).granted) throw collectorError('DIRECTORY_PERMISSION', '请在设置中恢复保存目录权限。');
        await queueAccount(account.accountKey, () => assetService.retryFailed({ account,
          ...(message.includeInternal === true ? { includeInternal: true } : {}) })); continueSoon(); break;
      }
      case 'collector:start': {
        const { account, tab, config } = await context(tabId, true);
        if (!account?.enabled || !config.setupComplete) throw collectorError('SETUP_INCOMPLETE', '请先完成配置并启用此账号。');
        if (!(await directoryState()).granted) throw collectorError('DIRECTORY_PERMISSION', '请在设置中恢复保存目录权限。');
        if (syncLocks.has(account.accountKey)) throw collectorError('BUSY', '正在同步本地文件，请稍后开始采集。');
        await engine.start({ account, tabId: tab.id, mode: message.mode }); continueSoon(); break;
      }
      case 'collector:pause': {
        // Use the most recently verified ownership for cancellation; never wait
        // for a second identity request before signalling an in-flight read.
        const cached = identities.get(tabId);
        const current = cached ? { account: (await settings.read()).accounts[cached.identity.accountKey], tab: { id: tabId } } : await context(tabId);
        if (current.account) {
          const paused = engine.pause(current.account.accountKey);
          await cancelSource(current.tab.id, current.account.accountKey); await paused;
        }
        break;
      }
      case 'collector:resume': {
        const { account, tab } = await context(tabId, true);
        if (!account?.enabled) throw collectorError('ACCOUNT_DISABLED', '请先启用此账号。');
        if (syncLocks.has(account.accountKey)) throw collectorError('BUSY', '正在同步本地文件，请稍后继续采集。');
        await engine.resume({ account, tabId: tab.id }); continueSoon(); break;
      }
      case 'collector:retry-github': {
        let current;
        try { current = (await context(tabId)).account; } catch { /* local backups do not require source login */ }
        let accounts = [], revision;
        // A new manual intent supersedes any in-flight attempt, even when the
        // destination is unchanged. Its old response must not clear this work.
        await settings.change(async config => {
          if (changingDirectory) throw collectorError('BUSY', '正在更换保存目录，请稍后备份。');
          const github = config.github;
          if (!github.repository || !github.token) throw collectorError('GITHUB_CONFIG', '请先配置 GitHub 仓库和 Token。');
          revision = Number.isSafeInteger(github.revision) && github.revision >= 0 && github.revision < Number.MAX_SAFE_INTEGER
            ? github.revision + 1 : 1;
          github.revision = revision;
          const selected = current && config.accounts[current.accountKey];
          accounts = selected?.enabled ? [selected] : Object.values(config.accounts).filter(account => account.enabled);
          for (const account of accounts) {
            const key = `githubStatus:${account.accountKey}`, old = await getSetting(key) || {};
            await setSetting(key, { ...old, revision, manual: true, manualRepository: github.repository, manualBranch: github.branch,
              needsBackfill: Boolean(uploadQueue), backfillStarted: false, nextRetryAt: 0, error: null });
          }
          return config;
        });
        for (const account of accounts) {
          if (!accountWork.has(account.accountKey)) await runAccount(account.accountKey, () => synchronize(account, true, revision));
          else void accountWork.get(account.accountKey).then(continueSoon, continueSoon);
        }
        continueSoon(); break;
      }
      default: throw collectorError('UNKNOWN_COMMAND', '不支持的插件操作。');
    }
    return { ok: true, state: await state(tabId) };
  }
  function command(message, tabId) {
    // Pause signals the current page reader without waiting for the filesystem
    // owner. Its durable job update still uses the engine's per-account lock.
    if (['collector:get-state', 'collector:pause', 'collector:retry-github'].includes(message.type)) return executeCommand(message, tabId);
    return exclusive(() => executeCommand(message, tabId));
  }
  return { initialize, command, state, pump, enableTab, identify, engine, withFileLock,
    async tabGone(tabId) {
      const cached = identities.get(tabId);
      identities.delete(tabId);
      if (cached?.identity.accountKey) {
        const interrupted = (await engine.getState(cached.identity.accountKey))?.status === 'running';
        await cancelSource(tabId, cached.identity.accountKey);
        await engine.suspend(cached.identity.accountKey, 'SOURCE_UNAVAILABLE', { interrupted });
      }
      continueSoon();
    },
    async contentState(tabId) {
      try { const s = await state(tabId); return { ok: true, account: s.account?.alias || s.identity?.displayName || '',
        status: s.job?.status || 'idle', running: s.job?.status === 'running',
        label: s.job?.status === 'running' ? '采集中' : s.job?.status === 'completed' ? '已完成' : '采集器' };
      } catch { return { ok: true, label: '采集器', status: 'idle', running: false }; }
    } };
}
