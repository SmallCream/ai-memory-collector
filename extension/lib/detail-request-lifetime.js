/** Bounded lifetime support for an outstanding, unusually slow detail read. */
export class DetailRequestTimeoutError extends Error {
  constructor() {
    super('详情读取等待超时，已保留进度，请稍后重试。');
    this.name = 'DetailRequestTimeoutError';
    this.code = 'TIMEOUT';
  }
}

export class CollectorRequestCancelledError extends Error {
  constructor() {
    super('采集已暂停，未完成的网络结果不会写入归档。');
    this.name = 'CollectorRequestCancelledError';
    this.code = 'COLLECTION_PAUSED';
  }
}

export function safeRetryAfter(code, value) {
  return ['HTTP_429', 'HTTP_503'].includes(code) && Number.isFinite(value) && value >= 0
    ? Math.min(86_400_000, Math.ceil(value)) : undefined;
}

// Runs only in this extension's ISOLATED world, never the website's MAIN world.
// Entries contain no URLs, credentials or response data. A tombstone also stops
// a previously queued injection which starts after the cancellation injection.
export function cancelChatGPTRequests(request) {
  const key = '__aiMemoryCollectorRequestsV1';
  if (location.origin !== 'https://chatgpt.com' || !Array.isArray(request?.ids)) return 0;
  const registry = globalThis[key] instanceof Map ? globalThis[key] : (globalThis[key] = new Map());
  const now = Date.now();
  for (const [id, entry] of registry) if (entry.createdAt < now - 3_600_000 && !entry.controller) registry.delete(id);
  let count = 0;
  for (const id of request.ids.slice(0, 100)) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
    const entry = registry.get(id) || { accountKey: request.accountKey || null, createdAt: now };
    if (request.accountKey && entry.accountKey && request.accountKey !== entry.accountKey) continue;
    entry.cancelled = true;
    registry.set(id, entry);
    try { entry.controller?.abort(); } catch { /* A lost document is already stopped. */ }
    count++;
  }
  return count;
}

let requestSequence = 0;
/** Cancellation races the browser reply as well as aborting the source fetch. */
export function createRequestControl(browser) {
  const active = new Map();
  const api = () => typeof browser === 'function' ? browser() : browser;
  return {
    async run(tabId, accountKey, operation) {
      const id = `collector-${Date.now().toString(36)}-${++requestSequence}`;
      const controller = new AbortController();
      const check = () => { if (controller.signal.aborted) throw new CollectorRequestCancelledError(); };
      const scope = { id, check, async race(work) {
        check();
        let stopped;
        const cancellation = new Promise((resolve, reject) => {
          stopped = () => reject(new CollectorRequestCancelledError());
          controller.signal.addEventListener('abort', stopped, { once: true });
        });
        try {
          const result = await Promise.race([Promise.resolve().then(() => { check(); return work(); }), cancellation]);
          check(); return result;
        } finally { controller.signal.removeEventListener('abort', stopped); }
      } };
      active.set(id, { tabId, accountKey, controller });
      try { check(); const result = await operation(scope); check(); return result; }
      finally { active.delete(id); }
    },
    cancel(tabId, { accountKey } = {}) {
      if (!Number.isSafeInteger(tabId) || tabId < 0 ||
          (accountKey !== undefined && !/^acct-[a-f0-9]{24}$/.test(accountKey))) return { cancelled: 0 };
      const ids = [];
      for (const [id, task] of active) if (task.tabId === tabId && (!accountKey || task.accountKey === accountKey)) {
        ids.push(id); task.controller.abort();
      }
      if (ids.length) {
        try {
          Promise.resolve(api()?.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED',
            func: cancelChatGPTRequests, args: [{ ids, ...(accountKey ? { accountKey } : {}) }] })).catch(() => {});
        } catch { /* Extension-side cancellation still rejects late replies. */ }
      }
      return { cancelled: ids.length };
    },
  };
}

export async function waitForDetailRequest(operation, { runtime, timers = globalThis } = {}) {
  let active = true, timeout, heartbeat;
  try {
    // The page bounds the detail HTTP read at 10 minutes; allow its two shorter
    // identity checks and result transfer without keeping a lost reply alive.
    const deadline = new Promise((resolve, reject) => {
      timeout = timers.setTimeout(() => {
        if (!active) return;
        active = false;
        reject(new DetailRequestTimeoutError());
      }, 660_000);
    });
    if (typeof runtime?.getPlatformInfo === 'function') {
      heartbeat = timers.setInterval(() => {
        if (!active) return;
        // A trivial extension API resets the worker timer during this one read.
        // Do not store platform data or expose keepalive errors to the archive.
        try { Promise.resolve(runtime.getPlatformInfo()).catch(() => {}); }
        catch { /* The bounded operation still decides success or failure. */ }
      }, 20_000);
    }
    // Racing observes late rejections too; a late reply cannot become success
    // after the watchdog has already rejected the caller's request.
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    active = false;
    if (heartbeat !== undefined) timers.clearInterval(heartbeat);
    if (timeout !== undefined) timers.clearTimeout(timeout);
  }
}
