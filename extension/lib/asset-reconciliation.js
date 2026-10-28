import { sha256 } from './assets.js';

// Older collectors emitted a second, Library-only record for a file citation.
// Reconcile only that exact old identity using this conversation's native data;
// a filename or a Library ID by itself is not evidence for merging two files.
export async function reconcileFileCitation(asset, archived, extracted) {
  const exact = extracted.find(item => item.id === asset.id);
  const candidates = extracted.filter(item => /^file[-_][A-Za-z0-9_-]+$/.test(item.fileId || '') && item.libraryFileId === asset.libraryFileId);
  if (!/^libfile_[A-Za-z0-9_-]+$/.test(asset.libraryFileId || '') || candidates.length !== 1) return { asset, fresh: exact, retired: [] };
  const fresh = candidates[0], canonical = archived.find(item => item.id === fresh.id);
  if (!canonical || canonical.sourceType !== 'platform' || canonical.fileId !== fresh.fileId ||
      canonical.libraryFileId !== fresh.libraryFileId || (exact && exact.id !== fresh.id)) return { asset, fresh: exact, retired: [] };
  const aliasId = await sha256(`platform:library:${fresh.libraryFileId}`);
  const aliases = archived.filter(item => item.id === aliasId && !item.fileId && item.sourceType === 'platform' &&
    item.sourceRef === `library:${fresh.libraryFileId}` && item.libraryFileId === fresh.libraryFileId &&
    ['pending', 'failed', 'unavailable'].includes(item.status) && item.occurrences?.length && item.occurrences.every(occurrence =>
      fresh.occurrences?.some(current => current.messageId === occurrence.messageId && current.path === occurrence.path && current.kind === occurrence.kind)) &&
    ['width', 'height', 'expectedSize', 'sha256', 'mimeType'].every(field => item[field] === undefined ||
      [canonical[field], fresh[field]].every(value => value === undefined || value === item[field])));
  if (!aliases.length || (asset.id !== canonical.id && !aliases.some(item => item.id === asset.id))) {
    return { asset, fresh: exact, retired: [] };
  }
  const mergeList = (field, values) => [...new Map(values.flatMap(item => item[field] || []).map(value =>
    [typeof value === 'string' ? value : JSON.stringify(value), value])).values()];
  const merged = { ...fresh, ...canonical,
    references: mergeList('references', [fresh, canonical, ...aliases]),
    occurrences: mergeList('occurrences', [fresh, canonical, ...aliases]) };
  for (const field of ['width', 'height', 'expectedSize', 'sha256', 'mimeType']) if (merged[field] === undefined) {
    const previous = aliases.find(item => item[field] !== undefined);
    if (previous) merged[field] = previous[field];
  }
  return { asset: merged, fresh, retired: aliases.map(item => item.id) };
}

