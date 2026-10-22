/** Bounded lifetime support for an outstanding, unusually slow detail read. */
export class DetailRequestTimeoutError extends Error {
  constructor() {
    super('详情读取等待超时，已保留进度，请稍后重试。');
    this.name = 'DetailRequestTimeoutError';
    this.code = 'TIMEOUT';
  }
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
