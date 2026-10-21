const encoder = new TextEncoder(), decoder = new TextDecoder();
export function memoryBinaryFs() {
  const files = new Map(), folders = new Set(['']), settings = new Map(), writes = [];
  const identity = {};
  let allowed = 'granted', failure = null, clearFailure = false;
  const bytes = value => typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
  function copy(value) {
    if (value == null || typeof value !== 'object') return value;
    if (value.kind === 'directory') return value;
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value)) return value.map(copy);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  }
  function directory(prefix = '') {
    return { kind: 'directory', name: 'synthetic', identity,
      queryPermission: async () => allowed,
      isSameEntry: async other => other?.identity === identity,
      async getDirectoryHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!folders.has(path)) { if (!create) throw new DOMException('missing', 'NotFoundError'); folders.add(path); }
        return directory(path);
      },
      async getFileHandle(name, { create = false } = {}) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!files.has(path)) { if (!create) throw new DOMException('missing', 'NotFoundError'); files.set(path, new Uint8Array()); }
        return {
          getFile: async () => { const value = bytes(files.get(path)); return { size: value.length,
            text: async () => decoder.decode(value), arrayBuffer: async () => value.buffer }; },
          createWritable: async () => { let pending; return {
            write: async value => { pending = bytes(value); },
            close: async () => { if (failure?.(path)) throw new DOMException('full', 'QuotaExceededError'); files.set(path, pending); writes.push(path); },
            abort: async () => {},
          }; },
        };
      },
    };
  }
  function put(path, value) {
    const parts = path.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    files.set(path, bytes(value));
  }
  const getSetting = async key => copy(settings.get(key));
  const setSetting = async (key, value) => { if (value === null && clearFailure) throw new Error('checkpoint clear failed'); settings.set(key, copy(value)); };
  return { directory: directory(), files, settings, writes, put, getSetting, setSetting,
    text: path => decoder.decode(files.get(path)),
    fail: callback => { failure = callback; }, permission: value => { allowed = value; },
    failClear: value => { clearFailure = value; },
  };
}
