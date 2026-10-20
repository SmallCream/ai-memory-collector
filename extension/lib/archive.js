/** P0 archive builder. Native web-detail JSON is authoritative; Markdown is derived. */
export const RENDERER_VERSION = 'p0-1';
const PLATFORM = 'chatgpt';
const SECRET_KEYS = new Set(['accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'authorization', 'cookie', 'set-cookie', 'sessiontoken', 'session_token',
  'csrf_token', 'csrftoken', 'api_key', 'apikey', 'password']);
const SECRET_QUERY = /^(?:token|access_token|refresh_token|authorization|auth|api_key|key|signature|sig|credential|security-token|key-pair-id|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkedKey(value, label, maximum = 160) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} 必须是稳定的字母、数字、下划线或连字符标识。`);
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw new Error(`${label} 不能使用系统保留名称。`);
  return value;
}

function dateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 9999) return null;
  return date.toISOString();
}

function cleanTitle(value) {
  const text = typeof value === 'string' ? value : '未命名对话';
  const safe = text.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  return Array.from(safe || '未命名对话').slice(0, 40).join('').replace(/[. ]+$/g, '') || '未命名对话';
}

function scrubUrl(value, path, redactions) {
  if (!/^https?:\/\//i.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { return value; }
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(key)) { url.searchParams.delete(key); changed = true; }
  }
  if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
  if (url.hash && /(?:access_token|refresh_token|token|authorization)=/i.test(url.hash)) { url.hash = ''; changed = true; }
  if (changed) redactions.push({ path, kind: 'url-credentials' });
  return changed ? url.toString() : value;
}

function sanitizedCopy(value, path, redactions, ancestors = new Set(), depth = 0, prose = false) {
  if (depth > 100) throw new Error('对话结构过深，P0 未处理该数据。');
  if (typeof value === 'string') return prose ? value : scrubUrl(value, path, redactions);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new Error('对话包含非 JSON 值。');
  if (ancestors.has(value)) throw new Error('对话 JSON 包含循环对象。');
  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map((item, index) => sanitizedCopy(item, `${path}/${index}`, redactions, ancestors, depth + 1, prose));
  } else {
    copy = {};
    for (const key of Object.keys(value).sort()) {
      const nextPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      let next;
      if (SECRET_KEYS.has(key.toLowerCase())) {
        next = '[REDACTED]';
        redactions.push({ path: nextPath, kind: 'credential-field' });
      } else {
        // Text/code and string content parts remain exact, even if they discuss tokens or contain URLs.
        const textValue = ['text', 'code', 'title'].includes(key) || key === 'parts' || (key === 'content' && typeof value[key] === 'string');
        next = sanitizedCopy(value[key], nextPath, redactions, ancestors, depth + 1, textValue);
      }
      Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
  }
  ancestors.delete(value);
  return copy;
}

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function hash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fence(value, language = 'text') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

function label(value) {
  return String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*{}[\]()#+.!_|]/g, '\\$&');
}

function selectedBranch(conversation) {
  const mapping = conversation.mapping;
  const warnings = [];
  const nodes = [];
  if (!isRecord(mapping) || !Object.keys(mapping).length) {
    warnings.push('此接口返回 messages 数组；按返回顺序展示，尚未验证消息顺序或单一分支归属。');
    const arrayNodes = conversation.messages.map((item, index) => ({
      nodeKey: String(item.id ?? item.message?.id ?? `unverified-item-${index}`),
      node: own(item, 'message') ? item : { message: item },
    }));
    if (conversation.messages.some(item => !item.id && !item.message?.id)) warnings.push('部分消息没有稳定 ID，展示锚点暂按位置生成。');
    return { nodes: arrayNodes, warnings, partial: false, mode: 'source-array' };
  }
  let cursor = conversation.current_node;
  if (typeof cursor !== 'string' || !own(mapping, cursor)) {
    warnings.push('未取得有效 current_node；不猜测当前分支，原生 mapping 已保留。');
    return { nodes, warnings, partial: true, mode: 'current-branch' };
  }
  const seen = new Set();
  while (cursor !== null && cursor !== undefined) {
    if (seen.has(cursor)) { warnings.push('当前分支存在父节点循环；仅展示可确认部分。'); break; }
    if (typeof cursor !== 'string' || !own(mapping, cursor)) { warnings.push('当前分支缺少父节点；仅展示已取得部分。'); break; }
    seen.add(cursor);
    const node = mapping[cursor];
    nodes.push({ nodeKey: cursor, node });
    cursor = node.parent;
  }
  nodes.reverse();
  return { nodes, warnings, partial: warnings.length > 0, mode: 'current-branch' };
}

function checkedManifest(existingManifest, prefix, accountKey) {
  if (existingManifest === undefined || existingManifest === null) {
    return { schemaVersion: 1, platform: PLATFORM, accountKey, conversations: {} };
  }
  if (!isRecord(existingManifest) || existingManifest.schemaVersion !== 1 || existingManifest.platform !== PLATFORM ||
      existingManifest.accountKey !== accountKey || !isRecord(existingManifest.conversations)) {
    throw new Error('现有归档清单格式或账号归属不匹配，未覆盖。');
  }
  const paths = new Set();
  for (const [id, entry] of Object.entries(existingManifest.conversations)) {
    checkedKey(id, '清单对话 ID');
    if (!isRecord(entry) || entry.conversationId !== id || typeof entry.jsonPath !== 'string' ||
        typeof entry.markdownPath !== 'string' || entry.markdownPath !== entry.jsonPath.replace(/\.json$/, '.md') ||
        !entry.jsonPath.startsWith(`${prefix}/conversations/`) || !entry.jsonPath.endsWith(`__${id}.json`)) {
      throw new Error('现有清单中的对话路径或归属不合法。');
    }
    for (const path of [entry.jsonPath, entry.markdownPath]) {
      if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') ||
          /[\u0000-\u001f\u007f]/.test(path) || paths.has(path)) throw new Error('现有清单存在不安全或重复路径。');
      paths.add(path);
    }
  }
  return structuredClone(existingManifest);
}

/**
 * Build only P0 capture paths, never the production data/ namespace.
 * Filesystem callers must independently verify ownership and external edits before writing.
 */
export async function buildArchive({ conversation, identity, capturedAt, existingManifest } = {}) {
  const hasMapping = isRecord(conversation?.mapping) && Object.keys(conversation.mapping).length > 0;
  const hasMessages = Array.isArray(conversation?.messages);
  if (!isRecord(conversation) || (!hasMapping && !hasMessages)) {
    throw new Error('详情缺少有效 mapping 或 messages，无法归档。');
  }
  const accountKey = checkedKey(identity?.accountKey, '账号标识', 120);
  const id = checkedKey(conversation.conversation_id ?? conversation.id, '对话 ID');
  if (conversation.conversation_id && conversation.id && conversation.conversation_id !== conversation.id) {
    throw new Error('详情中的对话 ID 不一致，未归档。');
  }
  for (const node of hasMapping ? Object.values(conversation.mapping) : conversation.messages) {
    if (!isRecord(node)) throw new Error('原生消息节点结构不合法。');
  }
  const captureTime = dateValue(capturedAt);
  if (!captureTime) throw new Error('capturedAt 必须是有效时间。');
  const prefix = `p0-captures/${PLATFORM}/${accountKey}`;
  const manifest = checkedManifest(existingManifest, prefix, accountKey);
  const previous = own(manifest.conversations, id) ? manifest.conversations[id] : null;
  const redactions = [];
  const native = sanitizedCopy(conversation, '', redactions);
  const content = json(native);
  const contentHash = await hash(content);
  const branch = selectedBranch(native);
  const warnings = [...branch.warnings];
  const sourcePartial = native.is_incomplete === true || native.page_info?.has_next_page === true || native.page_info?.has_previous_page === true;
  if (sourcePartial) warnings.push('来源提示还有未取得内容，当前档案为部分覆盖。');
  const allNodes = hasMapping ? Object.values(native.mapping) : native.messages.map(item => own(item, 'message') ? item : { message: item });
  if (allNodes.some(node => ['in_progress', 'streaming'].includes(node.message?.status))) {
    warnings.push('存在生成中的消息；该采集不能视为完整稳定版本。');
  }
  if (redactions.length) warnings.push(`已脱敏 ${redactions.length} 个结构化认证字段或 URL，详情见清单。`);
  const title = typeof native.title === 'string' ? native.title : '未命名对话';
  const sourceCreated = dateValue(native.create_time);
  const namingTime = previous?.namingTime || sourceCreated || captureTime;
  const timestamp = namingTime.slice(0, 19).replace(/:/g, '-') + 'Z';
  const titleBudget = 240 - new TextEncoder().encode(`${timestamp}____${id}.json`).length;
  let pathTitle = cleanTitle(title);
  while (new TextEncoder().encode(pathTitle).length > titleBudget) pathTitle = Array.from(pathTitle).slice(0, -1).join('');
  const stem = `${timestamp}__${pathTitle}__${id}`;
  const jsonPath = previous?.jsonPath || `${prefix}/conversations/${namingTime.slice(0, 4)}/${namingTime.slice(5, 7)}/${stem}.json`;
  const markdownPath = previous?.markdownPath || jsonPath.replace(/\.json$/, '.md');
  for (const [otherId, entry] of Object.entries(manifest.conversations)) {
    if (otherId !== id && [entry.jsonPath, entry.markdownPath].some(path => path === jsonPath || path === markdownPath)) {
      throw new Error('对话路径与其他档案冲突，未覆盖。');
    }
  }
  const coverage = {
    messages: branch.partial || sourcePartial || warnings.some(warning => warning.includes('生成中')) ? 'partial' : 'unknown',
    branches: sourcePartial ? 'partial' : 'unknown',
    attachments: 'references-only',
  };
  const selectedMessages = branch.nodes.filter(({ node }) => node.message !== null && node.message !== undefined);
  const messageCount = allNodes.filter(node => node.message !== null && node.message !== undefined).length;
  const displayLabel = branch.mode === 'source-array' ? '接口返回顺序（未验证分支）' : '当前分支';
  const lines = [
    `# ${label(title)}`, '',
    '> P0 采集快照：网页详情格式，消息和分支完整度尚未验证；附件只保留引用。', '',
    `- 对话 ID：${label(id)}`,
    `- 原文 SHA-256：${contentHash}`,
    `- 格式：chatgpt-web-detail；渲染器：${RENDERER_VERSION}`,
    `- ${displayLabel}展示 ${selectedMessages.length} 条消息；原生结构共保存 ${messageCount} 条消息。`, '',
  ];
  if (warnings.length) lines.push('## 采集说明', '', ...warnings.map(warning => `- ${label(warning)}`), '');
  lines.push(`## ${displayLabel}`, '');
  if (!selectedMessages.length) lines.push('无法确认可展示的当前分支。请查看 JSON 原档。', '');
  for (const { nodeKey, node } of selectedMessages) {
    const message = node.message;
    const anchor = `msg-${(await hash(nodeKey)).slice(0, 24)}`;
    lines.push(`### ${label(message.author?.role || message.role || 'unknown')} · ${anchor}`, '');
    lines.push(`消息 ID：${label(message.id ?? nodeKey)}`, '');
    const body = message.content;
    if (isRecord(body) && Array.isArray(body.parts)) {
      for (const part of body.parts) lines.push(fence(part, typeof part === 'string' ? 'text' : 'json'), '');
      const extra = Object.fromEntries(Object.entries(body).filter(([key]) => !['parts', 'content_type'].includes(key)));
      if (Object.keys(extra).length) lines.push('附加内容字段：', '', fence(extra, 'json'), '');
    } else if (typeof body === 'string') lines.push(fence(body), '');
    else if (body !== undefined) lines.push('未展开的原生内容：', '', fence(body, 'json'), '');
    else lines.push('该消息没有可渲染的 content 字段；其他原生字段保存在 JSON 中。', '');
  }
  const markdown = `${lines.join('\n').trimEnd()}\n`;
  const entry = {
    conversationId: id, jsonPath, markdownPath, sourceFormat: 'chatgpt-web-detail',
    contentHash, markdownHash: await hash(markdown), rendererVersion: RENDERER_VERSION,
    title, namingTime, pathTimeBasis: previous?.pathTimeBasis || (sourceCreated ? 'source-created' : 'first-observed'),
    firstCapturedAt: previous?.firstCapturedAt || captureTime,
    // Repeated identical capture is byte-stable, including the derived manifest.
    lastChangedAt: previous?.contentHash === contentHash ? previous.lastChangedAt : captureTime,
    coverage, renderMode: branch.mode, redactions, warnings,
  };
  Object.defineProperty(manifest.conversations, id, { value: entry, enumerable: true, writable: true, configurable: true });
  const account = { schemaVersion: 1, platform: PLATFORM, accountKey,
    displayName: typeof identity?.displayName === 'string' ? identity.displayName : accountKey,
    dataPath: prefix, purpose: 'p0-capture' };
  return {
    files: [
      { path: jsonPath, content }, { path: markdownPath, content: markdown },
      { path: `${prefix}/archive/manifest.json`, content: json(manifest) },
      { path: `${prefix}/account.json`, content: json(account) },
    ], manifest,
    summary: { conversationId: id, title, contentHash, sourceFormat: 'chatgpt-web-detail',
      nodeCount: allNodes.length, messageCount,
      currentBranchMessageCount: branch.mode === 'current-branch' ? selectedMessages.length : null,
      displayedMessageCount: selectedMessages.length, renderMode: branch.mode,
      coverage, warnings, redactionCount: redactions.length, jsonPath, markdownPath },
  };
}
