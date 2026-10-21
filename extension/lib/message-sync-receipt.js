/** Small, dependency-free validation shared by local writes and GitHub merges. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counters = ['incrementalRuns', 'pagesRead', 'fetchedMessages', 'reusedMessages', 'addedMessages', 'updatedMessages'];

export function sanitizeMessageSync(value, native) {
  if (!record(value) || value.schemaVersion !== 1 || !['full', 'tail-merge'].includes(value.mode) ||
      !['flat', 'tree'].includes(value.format)) return null;
  const format = record(native?.mapping) && Object.keys(native.mapping).length ? 'tree' : Array.isArray(native?.messages) ? 'flat' : null;
  if (value.format !== format || value.scope !== (format === 'tree' ? 'returned-tree' : 'selected-branch') ||
      (format === 'tree' && value.mode !== 'full')) return null;
  const validTime = time => Number.isSafeInteger(time) && time >= 0 && time <= 253402300799999;
  if (!validTime(value.fullReadAt) || !validTime(value.checkedAt) || value.fullReadAt > value.checkedAt) return null;
  if (counters.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  if (value.mode === 'full' && (value.fullReadAt !== value.checkedAt || value.incrementalRuns !== 0 || value.reusedMessages !== 0)) return null;
  if (value.mode === 'tail-merge' && (value.incrementalRuns < 1 || value.reusedMessages < 1 || value.addedMessages < 1)) return null;
  return Object.fromEntries(['schemaVersion', 'format', 'mode', 'scope', 'fullReadAt', 'checkedAt', ...counters].map(key => [key, value[key]]));
}

/** For identical native bytes, a newer full check outranks a later tail check. */
export function selectMessageSync(native, ...values) {
  return values.map(value => sanitizeMessageSync(value, native)).filter(Boolean).sort((left, right) =>
    right.fullReadAt - left.fullReadAt || right.checkedAt - left.checkedAt || right.incrementalRuns - left.incrementalRuns)[0] || null;
}
