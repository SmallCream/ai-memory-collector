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
      !['writing', 'verified'].includes(pending.phase))) throw collectorError('ASSET_JOURNAL', '附件恢复记录无效，未覆盖本地文件。');
  if (pending && !await sameDirectory(pending.directory, directory)) throw collectorError('DIRECTORY_CHANGED', '附件写入尚未完成，请恢复原保存目录后继续。');
  return { key, pending };
}

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const ASSET_EXTENSIONS = 'png|jpg|gif|webp|avif|bin|zip|gz|tgz|pdf|docx|xlsx|pptx|txt|md|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|css|yaml|yml|sql|sh|xml|log';
export const isSupportedAssetExtension = value => new RegExp(`^(?:${ASSET_EXTENSIONS})$`).test(value);
export function assetPath(account, oid, extension = 'bin') {
  if (!/^[a-f0-9]{64}$/.test(oid) || !isSupportedAssetExtension(extension)) throw collectorError('ASSET_PATH', '附件路径无效。');
  return `${accountPrefix(account)}/assets/${oid}.${extension}`;
}
export function validateAssetPath(account, path, oid) {
  const prefix = accountPrefix(account);
  if (!/^[a-f0-9]{64}$/.test(oid) || typeof path !== 'string' || !path.startsWith(`${prefix}/assets/`) ||
      !new RegExp(`^${oid}\\.(${ASSET_EXTENSIONS})$`).test(path.slice(prefix.length + 8))) {
    throw collectorError('ASSET_PATH', '附件路径超出当前账号或与内容摘要不符。');
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
  if (bytes.length !== asset.size || await hashBytes(bytes) !== asset.oid) throw collectorError('ASSET_LOCAL_CONFLICT', '本地附件与归档摘要不同，已保留原文件。');
  return bytes;
}
async function writeUnlocked({ directory, account, asset, bytes: input, getSetting = defaultGet, setSetting = defaultSet }) {
  validateAssetPath(account, asset.localPath, asset.oid);
  if (!(input instanceof Uint8Array) || input.length > MAX_ASSET_BYTES) throw collectorError('ASSET_HASH', '附件大小或内容摘要核对失败。');
  const bytes = new Uint8Array(input);
  if (bytes.length !== asset.size || await hashBytes(bytes) !== asset.oid) {
    throw collectorError('ASSET_HASH', '附件大小或内容摘要核对失败。');
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
  // Never overwrite an existing asset, even if it appeared after our first read.
  if ((await handle.getFile()).size) {
    await verifiedLocalAsset({ directory, account, asset, getSetting }); await setSetting(key, null); return false;
  }
  let writer;
  try {
    writer = await handle.createWritable({ keepExistingData: false });
    await writer.write(bytes); await writer.close();
  } catch {
    try { await writer?.abort(); } catch { /* already closed */ }
    throw collectorError('ASSET_WRITE', '附件写入未完成，任务已保留。');
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


/** Pure, bounded attachment inspection; also serialized into the page resolver.
 * No unpacking or executing documents. ZIP central-directory names determine
 * Office formats; filenames alone never turn an HTML response into a ZIP/PDF.
 */
export function inspectAttachmentBytes(bytes, hint = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * 1024 * 1024) return null;
  const mime = String(hint.mimeType || '').split(';')[0].trim().toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(String(hint.fileName || ''))?.[1]?.toLowerCase();
  const neutral = !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream';
  const textTypes = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    ts: 'text/plain', tsx: 'text/plain', jsx: 'text/javascript', py: 'text/x-python', css: 'text/css',
    yaml: 'application/yaml', yml: 'application/yaml', sql: 'application/sql', sh: 'application/x-sh', xml: 'application/xml', log: 'text/plain' };
  const office = { docx: ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    xlsx: ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    pptx: ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'] };
  const ascii = (start, end) => new TextDecoder().decode(bytes.subarray(start, end));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  if (bytes.length >= 18 && bytes[0] === 31 && bytes[1] === 139 && bytes[2] === 8 && !(bytes[3] & 224)) {
    if (extension && !['gz', 'tgz'].includes(extension) || !neutral && !['application/gzip', 'application/x-gzip', 'application/x-compressed-tar'].includes(mime)) return null;
    return { extension: extension === 'tgz' ? 'tgz' : 'gz', mimeType: 'application/gzip' };
  }
  if (bytes.length >= 22 && ascii(0, 2) === 'PK' && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) {
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
      if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
    }
    if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10)) return null;
    const count = u16(end + 10), size = u32(end + 12), offset = u32(end + 16);
    if (count === 65535 || offset + size !== end || (count === 0 && (offset !== 0 || size !== 0))) return null;
    let cursor = offset; const names = [];
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > end || u32(cursor) !== 0x02014b50) return null;
      const nameLength = u16(cursor + 28), local = u32(cursor + 42), next = cursor + 46 + nameLength + u16(cursor + 30) + u16(cursor + 32);
      if (next > end || local + 30 > offset || u32(local) !== 0x04034b50 || u16(cursor + 34) !== 0) return null;
      const localData = local + 30 + u16(local + 26) + u16(local + 28);
      if (localData > offset || localData + u32(cursor + 20) > offset) return null;
      names.push(ascii(cursor + 46, cursor + 46 + nameLength)); cursor = next;
    }
    if (cursor !== end) return null;
    const requestedOffice = office[extension] ? extension : Object.keys(office).find(key => office[key][1] === mime);
    if (requestedOffice) {
      if (extension && extension !== requestedOffice || !neutral && !['application/zip', 'application/x-zip-compressed', office[requestedOffice][1]].includes(mime)) return null;
      if (!names.includes('[Content_Types].xml') || !names.some(name => name.startsWith(office[requestedOffice][0]))) return null;
      return { extension: requestedOffice, mimeType: office[requestedOffice][1] };
    }
    if (extension && extension !== 'zip' || !neutral && !['application/zip', 'application/x-zip-compressed'].includes(mime)) return null;
    return { extension: 'zip', mimeType: 'application/zip' };
  }
  if (ascii(0, 5) === '%PDF-') {
    if (extension && extension !== 'pdf' || !neutral && mime !== 'application/pdf' || !/%%EOF[\s\0]*$/.test(ascii(Math.max(0, bytes.length - 2048), bytes.length))) return null;
    return { extension: 'pdf', mimeType: 'application/pdf' };
  }
  const suffix = extension || Object.keys(textTypes).find(key => textTypes[key] === mime);
  if (!Object.hasOwn(textTypes, suffix || '')) return null;
  if (!neutral && !(mime.startsWith('text/') && mime !== 'text/html') && !Object.values(textTypes).includes(mime) && !['application/javascript', 'application/x-yaml', 'application/x-python-code'].includes(mime)) return null;
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content) || /^\s*(?:<!doctype\s+html|<html|<head|<body)(?:\s|>)/i.test(content)) return null;
  if (suffix === 'json') { try { JSON.parse(content); } catch { return null; } }
  return { extension: suffix, mimeType: textTypes[suffix] };
}

export function assetExtension(bytes, asset = {}) {
  const suffix = /\.([a-z0-9]+)$/i.exec(String(asset.fileName || ''))?.[1]?.toLowerCase();
  const imageName = /^(png|jpe?g|gif|webp|avif)$/.test(suffix || '');
  const namedFile = suffix && suffix !== 'bin' && !imageName && isSupportedAssetExtension(suffix);
  if (asset.kind === 'image' || imageName || (!namedFile && /^image\//i.test(asset.mimeType || ''))) return imageExtension(bytes);
  const inspected = inspectAttachmentBytes(bytes, asset);
  if (!inspected) throw collectorError('ASSET_FORMAT', '返回内容不是受支持的原始附件，已保留来源等待补采。');
  return inspected.extension;
}

export function canCaptureAsset(asset) {
  if (asset.kind === 'image' || /^image\//i.test(asset.mimeType || '') || /\.(png|jpe?g|gif|webp|avif)$/i.test(asset.fileName || '')) return true;
  if (asset.kind !== 'attachment') return false;
  if (['platform', 'temporary', 'embedded'].includes(asset.sourceType)) return true;
  const extension = /\.([a-z0-9]+)$/i.exec(String(asset.fileName || ''))?.[1]?.toLowerCase();
  return Boolean(extension && extension !== 'bin' && isSupportedAssetExtension(extension));
}
