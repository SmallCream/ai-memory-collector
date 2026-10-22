import { decodeHTMLEntities, extractRichReferences, referenceFileName, safePublicURL } from './rich-content.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SECRET_QUERY = /(?:token|signature|credential|authorization|api[_-]?key|^auth$|^sig$|^key$|key-pair-id|^expires$|^expiry$|^x-amz-|^x-goog-)/i;
const SOURCE_TYPES = new Set(['external', 'platform', 'temporary', 'embedded', 'unknown']);
const READY = new Set(['downloaded', 'ready', 'local', 'synced']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const REFERENCE_FIELDS = ['asset_pointer', 'asset_pointer_link', 'image_url', 'url', 'download_url', 'src'];
const cleanName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) : undefined;

// Prefer a downloadable URL over a native pointer regardless of traversal order.
// Preserve the first URL at equal priority: extraction cannot tell which of two
// signed URLs is still valid, and resolution still validates the chosen host.
function retrievalPriority(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return 0;
    if (url.protocol === 'https:') return 3;
    if (url.protocol === 'blob:') return 2;
    if (url.protocol === 'http:') return 1;
  } catch { /* opaque native pointer */ }
  return 0;
}
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Never return a credential-bearing URL as persistent metadata. */
export function classifyAssetReference(input, hint = {}) {
  const original = decodeHTMLEntities(String(input ?? '')).trim();
  const fileId = typeof hint.fileId === 'string' && SAFE_ID.test(hint.fileId) ? hint.fileId : undefined;
  const libraryFileId = typeof hint.libraryFileId === 'string' && /^libfile_[A-Za-z0-9_-]+$/.test(hint.libraryFileId) ? hint.libraryFileId : undefined;
  if (/^data:/i.test(original)) return { sourceType: 'embedded', sourceRef: '', original, fileId, libraryFileId };
  if (/^blob:/i.test(original)) return { sourceType: 'temporary', sourceRef: original.split(/[?#]/)[0], original, fileId, libraryFileId };
  if (/^https?:/i.test(original) && (fileId || libraryFileId)) return {
    sourceType: 'platform', sourceRef: fileId ? `file-service://${fileId}` : `library:${libraryFileId}`, original, fileId, libraryFileId,
  };
  if (/^(?:sediment|file-service|sandbox|platform-file|library):/i.test(original) || fileId || libraryFileId) {
    const pointer = original.split(/[?#]/)[0];
    const inferred = /^(?:sediment|file-service):\/\/(?:[^/]*\/)*((?:file[-_])[A-Za-z0-9_-]+)$/i.exec(pointer)?.[1];
    return { sourceType: 'platform', sourceRef: pointer || (libraryFileId ? `library:${libraryFileId}` : `file-service://${fileId}`),
      original, fileId: fileId || inferred, libraryFileId };
  }
  try {
    const url = new URL(original);
    if (['http:', 'https:'].includes(url.protocol)) {
      let temporary = Boolean(url.username || url.password);
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) { temporary = true; url.searchParams.delete(key); }
      if (url.hash && /(?:token|authorization|credential)=/i.test(url.hash)) { temporary = true; url.hash = ''; }
      return { sourceType: temporary ? 'temporary' : url.protocol === 'https:' ? 'external' : 'unknown', sourceRef: url.href, original };
    }
  } catch { /* opaque native reference or relative document resource */ }
  return { sourceType: 'unknown', sourceRef: original.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 4096), original };
}

function kindFor(value, fallback = 'attachment') {
  if (/image/i.test(value || '')) return 'image';
  if (/audio/i.test(value || '')) return 'audio';
  if (/video/i.test(value || '')) return 'video';
  return fallback;
}

function messages(conversation) {
  if (record(conversation?.mapping)) return Object.entries(conversation.mapping).map(([key, node]) => ({ message: node?.message, fallback: key }));
  return (conversation?.messages || []).map((item, index) => ({ message: item?.message ?? item, fallback: String(item?.id || index) }));
}

/**
 * Extract descriptors only. This function never fetches a URL or resolves a platform ID.
 * `retrieval` is deliberately non-enumerable: use it immediately in memory, never persist it.
 */
export async function extractAssets(conversation) {
  return (await analyzeAssets(conversation)).assets;
}

/** Also identify legacy descriptors proven to be interface icons by native context. */
export async function analyzeAssets(conversation) {
  const candidates = [];
  const fileContentReferences = new WeakSet();
  const add = (ref, info) => { if (typeof ref === 'string' && ref.trim()) candidates.push({ ref, ...info }); };
  function text(value, info) {
    for (const reference of extractRichReferences(value)) add(reference.ref, { ...info, kind: reference.kind,
      ...(reference.kind === 'attachment' ? { fileName: referenceFileName(reference.ref) } : {}),
      syntax: reference.syntax, attribute: reference.attribute });
  }
  function walk(value, info, depth = 0) {
    if (depth > 100 || value == null) return;
    const appPath = info.interfaceAppRoot && info.path.slice(info.interfaceAppRoot.length);
    if (info.path.startsWith(info.interfaceAppRoot) &&
        (appPath === '/icon' || /^\/items\/\d+\/icon$/.test(appPath))) info = { ...info, interfaceIcon: true };
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, { ...info, path: `${info.path}/${index}` }, depth + 1)); return; }
    if (typeof value === 'string') { if (info.prose) text(value, info); return; }
    if (!record(value)) return;
    const type = String(value.content_type ?? value.type ?? '');
    if (type === 'code') return;
    const media = /image|audio|video|file|attachment/i.test(type) || info.attachment;
    const pointerFileId = typeof value.asset_pointer === 'string' ? classifyAssetReference(value.asset_pointer).fileId : undefined;
    const fileId = value.file_id ?? value.fileId ??
      (info.attachment || fileContentReferences.has(value) ? value.id : undefined) ?? pointerFileId;
    const libraryFileId = value.library_file_id ?? value.libraryFileId;
    const mimeType = value.mime_type ?? value.mimeType ?? value.content_mime_type;
    const common = { ...info, fileId, libraryFileId, mimeType,
      fileName: value.name ?? value.file_name ?? value.filename, kind: kindFor(mimeType || type, info.kind),
      width: value.width, height: value.height, expectedSize: value.size_bytes ?? value.size ?? value.file_size, quality: value.quality };
    let found = false;
    for (const key of REFERENCE_FIELDS) {
      const ref = typeof value[key] === 'string' ? value[key] : value[key]?.url;
      if (ref && (media || key === 'asset_pointer' || key === 'asset_pointer_link' || key === 'image_url')) { add(ref, { ...common, path: `${info.path}/${key}` }); found = true; }
    }
    if (!found && (fileId || libraryFileId)) add(libraryFileId ? `library:${libraryFileId}` : `file-service://${fileId}`, common);
    for (const [key, child] of Object.entries(value)) {
      if (REFERENCE_FIELDS.includes(key) || ['file_id', 'fileId', 'library_file_id', 'libraryFileId'].includes(key)) continue;
      if (key === 'file_ids' && Array.isArray(child)) {
        for (const id of child) if (typeof id === 'string') add(`file-service://${id}`, { ...info, fileId: id, kind: 'attachment', path: `${info.path}/${key}` });
        continue;
      }
      const attachment = info.attachment || ['attachments', 'files'].includes(key);
      const prose = ['text', 'parts', 'content'].includes(key) || (key === 'html' && /html/i.test(type)) || (info.prose && key === 'value');
      if (key === 'metadata' && record(child) && common.kind === 'image' && (fileId || libraryFileId)) {
        // Native generated-image parts place this link inside their metadata.
        // Associate only this direct link with the owning image; do not pass
        // parent IDs to sibling attachments or arbitrary nested metadata.
        const link = typeof child.asset_pointer_link === 'string' ? child.asset_pointer_link : child.asset_pointer_link?.url;
        const childFileId = child.file_id ?? child.fileId, childLibraryId = child.library_file_id ?? child.libraryFileId;
        const consistent = (!childFileId || childFileId === fileId) && (!childLibraryId || childLibraryId === libraryFileId);
        if (link && consistent) {
          add(link, { ...common, path: `${info.path}/metadata/asset_pointer_link` });
          const rest = { ...child }; delete rest.asset_pointer_link;
          walk(rest, { ...info, path: `${info.path}/${key}`, attachment, prose }, depth + 1);
          continue;
        }
      }
      walk(child, { ...info, path: `${info.path}/${key}`, attachment, prose }, depth + 1);
    }
  }
  for (const item of messages(conversation)) {
    if (!record(item.message)) continue;
    const messageId = String(item.message.id ?? item.fallback);
    // Only the observed direct message-level file citation declares this ID
    // pair. Web citations and arbitrary nested `id` fields are not attachments.
    const references = item.message.metadata?.content_references;
    if (Array.isArray(references)) for (const ref of references) {
      if (record(ref) && ref.type === 'file' && typeof ref.id === 'string' && /^file[-_][A-Za-z0-9_-]{1,160}$/.test(ref.id) &&
          typeof ref.library_file_id === 'string' && /^libfile_[A-Za-z0-9_-]{1,160}$/.test(ref.library_file_id)) fileContentReferences.add(ref);
    }
    const internalViewer = item.message.author?.role === 'tool' && item.message.author?.name === 'container.open_image' &&
      item.message.content?.content_type === 'execution_output';
    walk(item.message, { messageId, path: `messages/${messageId}`, kind: 'attachment', prose: false, attachment: false,
      interfaceAppRoot: `messages/${messageId}/metadata/dil_v2_reasoning/appData`,
      internalAttachmentRoot: internalViewer ? `messages/${messageId}/metadata/attachments/` : null });
  }
  const result = new Map(), internalOnly = new Map(), interfaceIconIds = new Set();
  // Visible content wins even if the same reference also decorates a tool card.
  // Do not let icon metadata supply names, IDs or retrieval URLs to real media.
  for (const candidate of candidates.sort((a, b) => Number(Boolean(a.interfaceIcon)) - Number(Boolean(b.interfaceIcon)))) {
    const classified = classifyAssetReference(candidate.ref, candidate);
    if (classified.sourceType === 'embedded') classified.sourceRef = `embedded:sha256:${await sha256(classified.original)}`;
    // Interpreter paths are scoped to the generating message. Reusing a path
    // in a later response may mean a different version of the file.
    const stable = classified.fileId ? `platform:file:${classified.fileId}` : classified.libraryFileId ? `platform:library:${classified.libraryFileId}` :
      /^sandbox:/i.test(classified.sourceRef) ? JSON.stringify(['sandbox', candidate.messageId, classified.sourceRef]) : `${classified.sourceType}:${classified.sourceRef}`;
    const id = await sha256(stable);
    if (candidate.interfaceIcon) { if (!result.has(id)) interfaceIconIds.add(id); continue; }
    const occurrence = { messageId: candidate.messageId, path: candidate.path, kind: candidate.kind || 'attachment',
      ...(candidate.syntax ? { syntax: candidate.syntax } : {}), ...(candidate.attribute ? { attribute: candidate.attribute } : {}) };
    // Only this known viewer's attachment results are internal. Filename,
    // directory, HTTP status and other tool messages are not classification
    // evidence. Any additional ordinary occurrence keeps capture mandatory.
    internalOnly.set(id, internalOnly.get(id) !== false && Boolean(candidate.internalAttachmentRoot &&
      candidate.path.startsWith(candidate.internalAttachmentRoot)));
    let asset = result.get(id);
    if (!asset) {
      asset = { id, sourceRef: classified.sourceRef, sourceType: classified.sourceType, status: 'pending',
        ...(classified.fileId ? { fileId: classified.fileId } : {}), ...(classified.libraryFileId ? { libraryFileId: classified.libraryFileId } : {}),
        ...(typeof candidate.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(candidate.mimeType) ? { mimeType: candidate.mimeType } : {}),
        ...(cleanName(candidate.fileName) ? { fileName: cleanName(candidate.fileName) } : {}), messageId: candidate.messageId,
        kind: candidate.kind || 'attachment', occurrences: [], references: [] };
      Object.defineProperty(asset, 'retrieval', { value: { sourceRef: classified.original, url: classified.original,
        fileId: classified.fileId, libraryFileId: classified.libraryFileId }, enumerable: false, configurable: true });
      result.set(id, asset);
    }
    // Parts often carry the image pointer while metadata.attachments carries
    // the filename, library ID and MIME. They are one asset, not two downloads.
    for (const [key, value] of Object.entries({ fileId: classified.fileId, libraryFileId: classified.libraryFileId,
      fileName: cleanName(candidate.fileName), mimeType: candidate.mimeType })) {
      if (!asset[key] && typeof value === 'string' && value) asset[key] = value;
    }
    if (asset.kind === 'attachment' && candidate.kind !== 'attachment') asset.kind = candidate.kind;
    for (const key of ['width', 'height', 'expectedSize']) if (asset[key] === undefined && Number.isSafeInteger(candidate[key]) && candidate[key] >= 0) asset[key] = candidate[key];
    if (!asset.quality && typeof candidate.quality === 'string') asset.quality = cleanName(candidate.quality);
    const retrieval = asset.retrieval;
    if (classified.fileId) retrieval.fileId = classified.fileId;
    if (classified.libraryFileId) retrieval.libraryFileId = classified.libraryFileId;
    if (retrievalPriority(classified.original) > retrievalPriority(retrieval.url)) {
      retrieval.url = classified.original;
    }
    if (!asset.references.includes(classified.sourceRef)) asset.references.push(classified.sourceRef);
    if (!asset.occurrences.some(item => item.messageId === occurrence.messageId && item.path === occurrence.path && item.kind === occurrence.kind)) asset.occurrences.push(occurrence);
  }
  for (const asset of result.values()) if (internalOnly.get(asset.id)) asset.capturePolicy = 'internal-viewer';
  return { assets: [...result.values()], interfaceIconIds: [...interfaceIconIds] };
}

/** Re-derive policy from freshly extracted native data, never persisted labels. */
export function reconcileAssetCapturePolicy(asset, fresh) {
  const result = { ...asset };
  if (asset.retrieval) Object.defineProperty(result, 'retrieval', { value: asset.retrieval, enumerable: false, configurable: true });
  if (fresh?.id === asset.id && fresh.capturePolicy === 'internal-viewer') result.capturePolicy = 'internal-viewer';
  else delete result.capturePolicy;
  if (result.capturePolicy !== 'internal-viewer' || result.errorCode !== 'HTTP_404' ||
      READY.has(result.status) || result.status === 'external' || result.autoRetrySuspended !== true) delete result.autoRetrySuspended;
  return result;
}

function safePath(path) {
  return typeof path === 'string' && path.length <= 2048 && !/[\\\u0000-\u001f\u007f?#]/.test(path) &&
    !path.startsWith('/') && path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

/** Whitelist synchronized resource fields; never serialize arbitrary fetch responses. */
export function sanitizeAssetRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(asset => record(asset) && /^[a-f0-9]{64}$/.test(asset.id || '')).map(asset => {
    const classification = classifyAssetReference(asset.sourceRef, asset);
    const item = { id: asset.id, sourceRef: classification.sourceRef,
      sourceType: SOURCE_TYPES.has(asset.sourceType) ? asset.sourceType : classification.sourceType,
      status: ['pending', 'downloaded', 'ready', 'local', 'synced', 'external', 'failed', 'unavailable'].includes(asset.status) ? asset.status : 'pending' };
    if (classification.sourceType === 'temporary' && item.sourceType === 'external') item.sourceType = 'temporary';
    for (const key of ['fileId', 'libraryFileId', 'fileName', 'mimeType', 'messageId', 'kind', 'errorCode', 'quality']) {
      if (typeof asset[key] === 'string') item[key] = cleanName(asset[key]);
    }
    if (asset.capturePolicy === 'internal-viewer') item.capturePolicy = 'internal-viewer';
    if (item.capturePolicy === 'internal-viewer' && item.errorCode === 'HTTP_404' && asset.autoRetrySuspended === true &&
        !READY.has(item.status) && item.status !== 'external') item.autoRetrySuspended = true;
    if (safePath(asset.localPath)) item.localPath = asset.localPath;
    if (typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256)) item.sha256 = asset.sha256;
    if (typeof asset.oid === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(asset.oid)) item.oid = asset.oid;
    if (Number.isSafeInteger(asset.size) && asset.size >= 0) item.size = asset.size;
    for (const key of ['width', 'height', 'expectedSize']) if (Number.isSafeInteger(asset[key]) && asset[key] >= 0) item[key] = asset[key];
    if (Array.isArray(asset.references)) item.references = [...new Set(asset.references.filter(ref => typeof ref === 'string').map(ref => classifyAssetReference(ref, asset).sourceRef))];
    if (Array.isArray(asset.occurrences)) item.occurrences = asset.occurrences.filter(record).map(occurrence => {
      const safe = {};
      for (const key of ['messageId', 'path', 'kind', 'syntax', 'attribute']) if (typeof occurrence[key] === 'string') safe[key] = cleanName(occurrence[key]);
      return safe;
    });
    return item;
  });
}

export function createAssetResolver(records, markdownPath) {
  const assets = sanitizeAssetRecords(records), byReference = new Map();
  const prefix = String(markdownPath || '').split('/').slice(0, 4).join('/') + '/';
  const addReference = (reference, asset) => {
    const matches = byReference.get(reference) || [];
    if (!matches.some(item => item.id === asset.id)) matches.push(asset);
    byReference.set(reference, matches);
  };
  for (const asset of assets) {
    addReference(asset.sourceRef, asset);
    for (const reference of asset.references || []) addReference(reference, asset);
    if (asset.fileId) for (const scheme of ['file-service', 'sediment']) addReference(`${scheme}://${asset.fileId}`, asset);
    if (asset.libraryFileId) addReference(`library:${asset.libraryFileId}`, asset);
    const ephemeral = records.find(item => item?.id === asset.id)?.retrieval?.sourceRef;
    if (typeof ephemeral === 'string') addReference(ephemeral, asset);
  }
  return (ref, { messageId } = {}) => {
    const classified = classifyAssetReference(ref);
    let matches = byReference.get(ref) || byReference.get(classified.sourceRef) || [];
    if (typeof messageId === 'string' && (/^sandbox:/i.test(classified.sourceRef) || matches.length > 1)) {
      matches = matches.filter(asset => asset.messageId === messageId || asset.occurrences?.some(item => item.messageId === messageId));
    }
    // An unscoped repeated sandbox path has no single correct local version.
    const asset = matches.length === 1 ? matches[0] : null;
    if (!asset) return null;
    if (READY.has(asset.status) && safePath(asset.localPath) && asset.localPath.startsWith(prefix)) {
      const from = markdownPath.split('/').slice(0, -1), to = asset.localPath.split('/');
      while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
      return '../'.repeat(from.length) + to.map(segment => encodeURIComponent(segment)).join('/');
    }
    if (asset.sourceType === 'external' && asset.status === 'external' && /^https:\/\//i.test(asset.sourceRef)) return safePublicURL(asset.sourceRef);
    return null;
  };
}
