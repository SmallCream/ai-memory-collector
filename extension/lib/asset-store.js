import { accountPrefix } from './archive-store.js';
import { hashBytes } from './lfs.js';
import { collectorError } from './config.js';
import { getSetting as defaultGet, setSetting as defaultSet } from './storage.js';

const locks = new WeakMap();
const journalKey = async (account, asset) => `assetWrite:${await hashBytes(new TextEncoder().encode(`${account.accountKey}:${asset.localPath}`))}`;
async function sameDirectory(left, right) {
  if (left === right) return true;
  try { return typeof left?.isSameEntry === 'function' && await left.isSameEntry(right); } catch { return false; }
}
async function pendingWrite({ directory, account, asset, getSetting = defaultGet }) {
  const key = await journalKey(account, asset), pending = await getSetting(key);
  if (pending && (pending.schemaVersion !== 1 || pending.accountKey !== account.accountKey ||
      pending.path !== asset.localPath || pending.oid !== asset.oid || pending.size !== asset.size ||
      !['writing', 'verified'].includes(pending.phase))) throw collectorError('ASSET_JOURNAL', '图片恢复记录无效，未覆盖本地文件。');
  if (pending && !await sameDirectory(pending.directory, directory)) throw collectorError('DIRECTORY_CHANGED', '图片写入尚未完成，请恢复原保存目录后继续。');
  return { key, pending };
}

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export function assetPath(account, oid, extension = 'bin') {
  if (!/^[a-f0-9]{64}$/.test(oid) || !/^(png|jpg|gif|webp|avif|bin)$/.test(extension)) throw collectorError('ASSET_PATH', '图片路径无效。');
  return `${accountPrefix(account)}/assets/${oid}.${extension}`;
}
export function validateAssetPath(account, path, oid) {
  const prefix = accountPrefix(account);
  if (!/^[a-f0-9]{64}$/.test(oid) || typeof path !== 'string' || !path.startsWith(`${prefix}/assets/`) ||
      !new RegExp(`^${oid}\\.(png|jpg|gif|webp|avif|bin)$`).test(path.slice(prefix.length + 8))) {
    throw collectorError('ASSET_PATH', '图片路径超出当前账号或与内容摘要不符。');
  }
  return path;
}
export async function readLocalBytes(directory, path, maxBytes = MAX_ASSET_BYTES) {
  if (!directory || await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw collectorError('DIRECTORY_PERMISSION', '请恢复保存目录权限。');
  if (typeof path !== 'string' || path.split('/').some(x => !x || x === '.' || x === '..' || /[\\\u0000-\u001f<>:"|?*]/u.test(x))) throw collectorError('ASSET_PATH', '文件路径无效。');
  try {
    const pieces = path.split('/'), name = pieces.pop(); let parent = directory;
    for (const piece of pieces) parent = await parent.getDirectoryHandle(piece);
    const file = await (await parent.getFileHandle(name)).getFile();
    if (file.size > maxBytes) throw collectorError('ASSET_SIZE', '文件超过当前单文件处理上限。');
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
}
export async function verifiedLocalAsset({ directory, account, asset, getSetting = defaultGet }) {
  validateAssetPath(account, asset.localPath, asset.oid);
  const bytes = await readLocalBytes(directory, asset.localPath);
  if (bytes === null) return null;
  // Empty files are not generally disposable: only our durable, unfinished
  // first-create record authorizes repair of an empty placeholder.
  if (bytes.length === 0 && asset.size > 0) {
    const { pending } = await pendingWrite({ directory, account, asset, getSetting });
    if (pending?.phase === 'writing') return null;
  }
  if (bytes.length !== asset.size || await hashBytes(bytes) !== asset.oid) throw collectorError('ASSET_LOCAL_CONFLICT', '本地图片与归档摘要不同，已保留原文件。');
  return bytes;
}
async function writeUnlocked({ directory, account, asset, bytes: input, getSetting = defaultGet, setSetting = defaultSet }) {
  validateAssetPath(account, asset.localPath, asset.oid);
  if (!(input instanceof Uint8Array) || input.length > MAX_ASSET_BYTES) throw collectorError('ASSET_HASH', '图片大小或内容摘要核对失败。');
  const bytes = new Uint8Array(input);
  if (bytes.length !== asset.size || await hashBytes(bytes) !== asset.oid) {
    throw collectorError('ASSET_HASH', '图片大小或内容摘要核对失败。');
  }
  const { key, pending } = await pendingWrite({ directory, account, asset, getSetting });
  if (await verifiedLocalAsset({ directory, account, asset, getSetting })) {
    if (pending) await setSetting(key, null);
    return false;
  }
  const plan = pending || { schemaVersion: 1, accountKey: account.accountKey, directory, path: asset.localPath,
    oid: asset.oid, size: asset.size, phase: 'writing' };
  if (!pending) await setSetting(key, plan);
  const pieces = asset.localPath.split('/'), name = pieces.pop(); let parent = directory;
  for (const piece of pieces) parent = await parent.getDirectoryHandle(piece, { create: true });
  const handle = await parent.getFileHandle(name, { create: true });
  // Never overwrite an existing image, even if it appeared after our first read.
  if ((await handle.getFile()).size) {
    await verifiedLocalAsset({ directory, account, asset, getSetting }); await setSetting(key, null); return false;
  }
  let writer;
  try {
    writer = await handle.createWritable({ keepExistingData: false });
    await writer.write(bytes); await writer.close();
  } catch {
    try { await writer?.abort(); } catch { /* already closed */ }
    throw collectorError('ASSET_WRITE', '图片写入未完成，任务已保留。');
  }
  await verifiedLocalAsset({ directory, account, asset, getSetting });
  await setSetting(key, { ...plan, phase: 'verified' });
  await setSetting(key, null); return true;
}
export function writeLocalAsset(input) {
  if (!input.directory || typeof input.directory !== 'object') return Promise.reject(collectorError('DIRECTORY_PERMISSION', '请恢复保存目录权限。'));
  let entries = locks.get(input.directory);
  if (!entries) { entries = new Map(); locks.set(input.directory, entries); }
  const key = `${input.account?.accountKey}:${input.asset?.localPath}`;
  const operation = (entries.get(key) || Promise.resolve()).catch(() => {}).then(() => writeUnlocked(input));
  entries.set(key, operation);
  operation.finally(() => { if (entries.get(key) === operation) entries.delete(key); }).catch(() => {});
  return operation;
}
export function imageExtension(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  const ascii = (start, end) => new TextDecoder().decode(bytes.subarray(start, end));
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'avif';
  throw collectorError('ASSET_NOT_IMAGE', '返回内容不是受支持的原始图片，已保留来源等待补采。');
}
