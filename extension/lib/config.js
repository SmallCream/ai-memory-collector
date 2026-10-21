const CONFIG_KEY = 'collectorConfigV2';
export const INTERVALS = [15, 30, 60];
export const DEFAULT_CONFIG = Object.freeze({ schemaVersion: 2, setupComplete: false,
  autoEnabled: true, intervalMinutes: 30, accounts: {},
  github: { enabled: false, repository: '', branch: '', token: '', lfsEnabled: true } });

export function publicConfig(config) {
  return { setupComplete: config.setupComplete, autoEnabled: config.autoEnabled,
    intervalMinutes: config.intervalMinutes, github: {
      enabled: config.github.enabled, repository: config.github.repository,
      branch: config.github.branch, hasToken: Boolean(config.github.token), lfsEnabled: config.github.lfsEnabled !== false,
    } };
}

export function createConfigStore({ getSetting, setSetting }) {
  let queue = Promise.resolve();
  async function read() {
    const saved = await getSetting(CONFIG_KEY);
    if (saved?.schemaVersion === 2) return {
      ...structuredClone(DEFAULT_CONFIG), ...saved,
      github: { ...DEFAULT_CONFIG.github, ...saved.github },
    };
    const previous = await getSetting('formPreferences') || await getSetting('githubTarget') || {};
    const config = structuredClone(DEFAULT_CONFIG);
    // Keep the same IndexedDB origin/name and directory handle. Migration never
    // activates uploading private conversations just because a P0 probe existed.
    config.github.repository = typeof previous.repository === 'string' ? previous.repository : '';
    config.github.branch = typeof previous.branch === 'string' ? previous.branch : '';
    config.github.token = previous.rememberToken && typeof previous.token === 'string' ? previous.token : '';
    return config;
  }
  function change(update) {
    const result = queue.then(async () => {
      const current = await read();
      const next = await update(structuredClone(current));
      await setSetting(CONFIG_KEY, next);
      return next;
    });
    queue = result.catch(() => {});
    return result;
  }
  return { read, change };
}

export function cleanAlias(value, fallback) {
  const name = String(value || fallback || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return Array.from(name).slice(0, 80).join('') || '我的账号';
}

export function safeError(error) {
  const code = /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code : 'OPERATION_FAILED';
  // Only errors from our own modules are user-facing; browser/API raw errors may
  // include URLs, payloads or other account details.
  const message = code === 'OPERATION_FAILED' ? '操作未完成，请检查权限、登录状态或网络后重试。' :
    String(error.message || '操作未完成，请重试。').replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏]');
  return { code, message };
}

export function collectorError(code, message) {
  return Object.assign(new Error(message), { code });
}
