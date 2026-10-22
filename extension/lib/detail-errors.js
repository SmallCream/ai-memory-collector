// Fixed diagnostic vocabulary only: never retain payloads, node IDs, URLs, or
// raw browser/network errors in a failure reason.
const messages = Object.freeze({
  SOURCE_PARTIAL: '接口明确标记本次返回的详情尚不完整或仍有未返回的内容。',
  TREE_CURRENT_NODE: '消息树为空、缺少当前节点标识，或当前节点不在返回结果中。',
  TREE_NODE_SHAPE: '消息树中存在无法识别的节点或消息结构。',
  MESSAGE_IN_PROGRESS: '存在尚不能确认已结束的消息，可能仍在生成或保留了未确认的中断状态；本次不覆盖归档，可稍后重试。',
  TREE_MISSING_PARENT: '消息树的父节点引用无效，或指向本次未返回的节点。',
  TREE_MISSING_CHILD: '消息树的子节点引用无效，或指向本次未返回的节点。',
  TREE_PARENT_CYCLE: '消息树的父节点关系形成循环，无法确认完整的消息顺序。',
  PAGE_FLAGS: '消息分页的结束标记缺失或不符合当前支持的格式。',
  PAGE_DIRECTION: '消息页的前后分页标记与返回内容不一致，无法确认分支边界。',
  PAGE_MESSAGE_LIMIT: '单页消息数量超过当前支持的上限。',
  MESSAGE_SHAPE: '返回的消息结构无法识别，或包含空的消息记录。',
  MESSAGE_ID: '消息 ID 缺失、格式异常或在同页内重复。',
  PAGE_CURSOR_MISMATCH: '分页游标与本页首末消息不对应，无法安全衔接历史。',
  PAGE_VERSION_MISSING: '需要拼接多页，但响应缺少可核对的更新时间或当前节点。',
  PAGE_VERSION_CHANGED: '读取期间对话版本发生变化，或最新页复核结果不一致。',
  PAGE_CURSOR_STALLED: '历史分页游标没有继续前进，无法确认历史已完整读取。',
  PAGE_OVERLAP_CONFLICT: '相邻消息页的重叠内容不一致，无法安全合并。',
  DETAIL_COMPLETENESS_UNKNOWN: '详情接口未返回适配器已确认的完整性结果。',
  SCRIPT_RESULTS_INVALID: '浏览器返回的脚本执行结果格式异常，或包含重复的主页面结果。',
  SCRIPT_MAIN_FRAME_MISSING: '浏览器没有返回主页面的采集结果。',
  SCRIPT_EXECUTION_FAILED: '浏览器报告页面采集脚本执行失败，未取得可归档的结果。',
  SCRIPT_RESULT_MISSING: '页面采集脚本没有返回结果，或结果未能传回扩展。',
  SCRIPT_ENVELOPE_INVALID: '采集脚本返回的成功或失败标记不符合约定，无法确认结果。',
});
const codes = new Set(['INCOMPLETE_DETAIL', 'DETAIL_PAGINATION', 'DETAIL_CHANGED', 'FORMAT']);
export function sanitizeDetailFailure(error) {
  if (typeof error?.reason !== 'string' || !Object.hasOwn(messages, error.reason)) return {};
  const transport = error.reason.startsWith('SCRIPT_');
  return (transport ? error.code === 'INVALID_RESPONSE' : codes.has(error.code)) ? { reason: error.reason } : {};
}
export function detailFailureMessage(error) {
  const { reason } = sanitizeDetailFailure(error);
  return reason ? messages[reason] : '';
}
