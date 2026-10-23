/**
 * Inspect source generation statuses without changing any native messages.
 * This function is self-contained so the injected probe can serialize it.
 * Callers must still validate the source graph and pagination independently.
 */
export function inspectMessageGeneration(native) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const unfinished = message => record(message) && ['pending', 'in_progress', 'streaming'].includes(message.status);
  const terminal = message => record(message) && message.author?.role === 'assistant' &&
    message.status === 'finished_successfully' && message.end_turn === true &&
    [undefined, null, '', 'all'].includes(message.recipient) &&
    [undefined, null, '', 'final'].includes(message.channel);
  const result = (unfinishedCount, historicalUnfinishedCount = 0) => ({
    unfinishedCount,
    historicalUnfinishedCount,
    unresolvedUnfinishedCount: unfinishedCount - historicalUnfinishedCount,
  });

  const mapping = record(native?.mapping) ? native.mapping : null;
  const nodes = new Map(mapping ? Object.entries(mapping) : []);
  if (!nodes.size) {
    const messages = Array.isArray(native?.messages) ? native.messages : [];
    // A flat response or a single page does not supply verified branch ancestry.
    return result(messages.filter(item => unfinished(item?.message ?? item)).length);
  }

  const unfinishedIds = [], terminalIds = [];
  for (const [id, node] of nodes) {
    if (unfinished(node?.message)) unfinishedIds.push(id);
    if (terminal(node?.message)) terminalIds.push(id);
  }
  if (!unfinishedIds.length) return result(0);

  const current = native?.current_node;
  if (typeof current !== 'string' || !nodes.has(current)) return result(unfinishedIds.length);

  // Walk from the selected tip toward its root. A selected-chain message needs
  // a later ending on that same chain; a completed sibling cannot close it.
  const currentChain = new Set(), currentClosedAncestors = new Set();
  let cursor = current, laterTerminal = false;
  while (cursor !== null && cursor !== undefined) {
    if (currentChain.has(cursor) || !nodes.has(cursor) || !record(nodes.get(cursor))) {
      return result(unfinishedIds.length);
    }
    const node = nodes.get(cursor);
    currentChain.add(cursor);
    if (laterTerminal) currentClosedAncestors.add(cursor);
    if (terminal(node.message)) laterTerminal = true;
    cursor = node.parent;
  }

  // Union the strict ancestors of all explicit endings. Once an ancestor was
  // visited, its own ancestry was visited too: each node is traversed at most
  // once across all terminal messages, avoiding repeated long-chain walks.
  const closedAncestors = new Set();
  for (const id of terminalIds) {
    cursor = nodes.get(id)?.parent;
    while (cursor !== null && cursor !== undefined && !closedAncestors.has(cursor)) {
      const node = nodes.get(cursor);
      if (!record(node)) break;
      closedAncestors.add(cursor);
      cursor = node.parent;
    }
  }

  let historicalUnfinishedCount = 0;
  for (const id of unfinishedIds) {
    if (id === current) continue;
    if (currentChain.has(id) ? currentClosedAncestors.has(id) : closedAncestors.has(id)) {
      historicalUnfinishedCount++;
    }
  }
  return result(unfinishedIds.length, historicalUnfinishedCount);
}
