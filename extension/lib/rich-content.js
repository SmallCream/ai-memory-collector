/** A conservative Markdown/HTML lexer. Code is opaque; only explicit resource nodes are rewritten. */
const VOID = new Set(['br', 'hr', 'img', 'source']);
const SAFE_TAGS = new Set(['a', 'p', 'div', 'span', 'br', 'hr', 'strong', 'b', 'em', 'i', 's', 'del', 'u',
  'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'details', 'summary', 'img', 'picture', 'audio', 'video', 'source', 'figure', 'figcaption', 'pre', 'code', 'sub', 'sup']);
const ACTIVE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'textarea',
  'button', 'select', 'input', 'link', 'meta', 'base']);
const ESCAPES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', tab: '\t', newline: '\n' };
const attrEscape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textEscape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const markdownLabel = value => String(value || '').replace(/[\r\n]/g, ' ').replace(/([\\\[\]])/g, '\\$1');
const normalizedLabel = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
const DOWNLOAD_EXTENSION = /\.(?:zip|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|tsv|md|jsonl?|ya?ml|xml|py|[cm]?js|tsx?|jsx|css|html?|sql|sh|r)$/i;

// Ordinary hyperlinks remain hyperlinks. Platform file pointers and explicit
// document downloads are also archive resources; a filename never implies a
// platform file ID or authorizes matching another resource by basename.
export function isDownloadReference(value, explicitDownload = false) {
  if (typeof value !== 'string') return false;
  const ref = decodeHTMLEntities(value).trim();
  if (!ref || /[\u0000-\u001f\u007f]/.test(ref)) return false;
  if (/^(?:sandbox|sediment|file-service|platform-file|library):/i.test(ref)) return true;
  if (/^blob:https:\/\/chatgpt\.com\//i.test(ref)) return true;
  try {
    const url = new URL(ref);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    return explicitDownload || DOWNLOAD_EXTENSION.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

export function referenceFileName(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const path = /^sandbox:\//i.test(value) ? value.slice('sandbox:'.length).split(/[?#]/)[0] : new URL(value).pathname;
    const name = decodeURIComponent(path.split('/').at(-1));
    return name && !/[\\/\u0000-\u001f\u007f]/.test(name) ? name : undefined;
  } catch { return undefined; }
}

export function decodeHTMLEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return ESCAPES[name.toLowerCase()] ?? whole;
    const number = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\uFFFD';
  });
}

function escaped(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count++;
  return count % 2 === 1;
}

function bracket(text, start, open = '[', close = ']') {
  if (text[start] !== open) return null;
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (escaped(text, index)) continue;
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return { value: text.slice(start + 1, index), end: index + 1 };
    if (text[index] !== close) { /* Only closing delimiters decrement depth. */ }
  }
  return null;
}

function destination(text, start) {
  if (text[start] !== '(') return null;
  let index = start + 1;
  while (/\s/.test(text[index] || '') && index < text.length) index++;
  let value = '';
  if (text[index] === '<') {
    const begin = ++index;
    while (index < text.length && (text[index] !== '>' || escaped(text, index))) index++;
    if (index === text.length) return null;
    value = text.slice(begin, index++);
  } else {
    const begin = index;
    let depth = 0;
    while (index < text.length) {
      if (!escaped(text, index)) {
        if (text[index] === '(') depth++;
        else if (text[index] === ')') { if (!depth) break; depth--; }
        else if (/\s/.test(text[index]) && !depth) break;
      }
      index++;
    }
    value = text.slice(begin, index);
  }
  while (/\s/.test(text[index] || '') && index < text.length) index++;
  // Optional link title is parsed as a quoted token, never as HTML attributes.
  if (text[index] === '"' || text[index] === "'") {
    const quote = text[index++];
    while (index < text.length && (text[index] !== quote || escaped(text, index))) index++;
    if (index === text.length) return null;
    index++;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
  }
  return text[index] === ')' ? { value: decodeHTMLEntities(value.replace(/\\([()<>\\])/g, '$1')), end: index + 1 } : null;
}

function htmlToken(text, start) {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);
    return { type: 'comment', raw: text.slice(start, end < 0 ? text.length : end + 3), end: end < 0 ? text.length : end + 3 };
  }
  let index = start + 1, closing = false;
  if (text[index] === '/') { closing = true; index++; }
  const begin = index;
  while (/[A-Za-z0-9-]/.test(text[index] || '') && index < text.length) index++;
  if (index === begin || !/^[A-Za-z]/.test(text.slice(begin, index))) return null;
  const tag = text.slice(begin, index).toLowerCase();
  if (text[index] !== '>' && !/[\s/]/.test(text[index] || '')) return null;
  const attributes = [];
  let selfClosing = false;
  while (index < text.length) {
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    if (text[index] === '>') return { type: 'html', tag, closing, selfClosing: selfClosing || VOID.has(tag), attributes, end: index + 1, raw: text.slice(start, index + 1) };
    if (text[index] === '/' && text[index + 1] === '>') { selfClosing = true; index++; continue; }
    if (closing) return null;
    const attrBegin = index;
    while (index < text.length && !/[\s=/>"'<]/.test(text[index])) index++;
    if (index === attrBegin) return null;
    const name = text.slice(attrBegin, index).toLowerCase();
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    let value = '';
    if (text[index] === '=') {
      index++;
      while (/\s/.test(text[index] || '') && index < text.length) index++;
      if (text[index] === '"' || text[index] === "'") {
        const quote = text[index++], valueBegin = index;
        while (index < text.length && text[index] !== quote) index++;
        if (index === text.length) return null;
        value = text.slice(valueBegin, index++);
      } else {
        const valueBegin = index;
        while (index < text.length && !/[\s>]/.test(text[index])) index++;
        value = text.slice(valueBegin, index);
      }
    }
    if (!attributes.some(attribute => attribute.name === name)) attributes.push({ name, value: decodeHTMLEntities(value) });
  }
  return null;
}

/** srcset is tokenized separately: commas inside data URLs are not split as candidates. */
export function parseSrcset(value) {
  const result = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++;
    const begin = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    let url = value.slice(begin, index), descriptor = '';
    if (!url) break;
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      while (index < value.length && /\s/.test(value[index])) index++;
      const descriptorBegin = index;
      while (index < value.length && value[index] !== ',') index++;
      descriptor = value.slice(descriptorBegin, index).trim();
    }
    if (url && (!descriptor || /^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor))) result.push({ url, descriptor });
    if (value[index] === ',') index++;
  }
  return result;
}

// Container markers precede the fence in quoted/list code examples. Keep the
// original lines opaque; only inspect their prefix to locate a matching fence.
function fenceContainer(line) {
  let offset = 0, quotes = 0, lists = 0, continuation = '';
  while (offset < line.length) {
    const rest = line.slice(offset);
    const quote = /^ {0,3}>[ \t]?/.exec(rest);
    const list = !quote && /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(rest);
    const marker = quote || list;
    if (!marker) break;
    offset += marker[0].length;
    if (quote) { quotes++; continuation += marker[0]; }
    else { lists++; continuation += marker[0].replace(/[^ \t]/g, ' '); }
  }
  return { content: line.slice(offset), quotes, lists, continuation };
}

export function tokenizeRichText(value) {
  const text = String(value ?? ''), tokens = [];
  let index = 0, plainStart = 0;
  const push = token => { if (plainStart < index) tokens.push({ type: 'text', raw: text.slice(plainStart, index) }); tokens.push(token); index = token.end; plainStart = index; };
  while (index < text.length) {
    if (index === 0 || text[index - 1] === '\n') {
      const lineEnd = text.indexOf('\n', index), end = lineEnd < 0 ? text.length : lineEnd + 1;
      const line = text.slice(index, lineEnd < 0 ? text.length : lineEnd);
      const container = fenceContainer(line);
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(container.content);
      if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
        const closing = new RegExp(`^ {0,${container.lists ? container.continuation.length + 3 : 3}}(\`{3,}|~{3,})\\s*$`);
        let cursor = end, closed = false;
        while (cursor < text.length) {
          const newline = text.indexOf('\n', cursor), boundary = newline < 0 ? text.length : newline + 1;
          const nextContainer = fenceContainer(text.slice(cursor, newline < 0 ? text.length : newline));
          // A fenced block in a quote ends when that quote ends, even if the
          // author omitted its closing fence. Later real images remain visible.
          if (nextContainer.quotes < container.quotes) break;
          const candidate = closing.exec(nextContainer.content);
          if (candidate && nextContainer.quotes === container.quotes && nextContainer.lists === 0 &&
              candidate[1][0] === opening[1][0] && candidate[1].length >= opening[1].length) { cursor = boundary; closed = true; break; }
          cursor = boundary;
        }
        push({ type: 'code', raw: text.slice(index, cursor),
          close: closed ? '' : container.continuation + opening[1] + (cursor < text.length ? '\n' : ''), end: cursor }); continue;
      }
      if (/^(?: {4}|\t)/.test(line)) { push({ type: 'code', raw: text.slice(index, end), end }); continue; }
      const definition = /^ {0,3}\[([^\]]+)\]:\s*(.*)$/.exec(line);
      if (definition) {
        const parsed = destination(`(${definition[2]})`, 0);
        if (parsed) { push({ type: 'definition', label: normalizedLabel(definition[1]), ref: parsed.value, raw: text.slice(index, end), end }); continue; }
      }
    }
    if (text[index] === '`' && !escaped(text, index)) {
      let runEnd = index + 1;
      while (text[runEnd] === '`') runEnd++;
      const size = runEnd - index;
      let cursor = runEnd, end = null;
      while (cursor < text.length) {
        if (text[cursor] !== '`') { cursor++; continue; }
        let next = cursor + 1;
        while (text[next] === '`') next++;
        if (next - cursor === size) { end = next; break; }
        cursor = next;
      }
      if (end !== null) { push({ type: 'code', raw: text.slice(index, end), end }); continue; }
    }
    if (text[index] === '<' && !escaped(text, index)) {
      const token = htmlToken(text, index);
      if (token) {
        // Native HTML code examples are opaque, just like Markdown code fences.
        if (['pre', 'code'].includes(token.tag) && !token.closing) {
          const close = new RegExp(`</${token.tag}\\s*>`, 'ig'); close.lastIndex = token.end;
          const match = close.exec(text), end = match ? match.index + match[0].length : text.length;
          push({ type: 'html-code', tag: token.tag, body: text.slice(token.end, match?.index ?? text.length), end, raw: text.slice(index, end) }); continue;
        }
        if (ACTIVE.has(token.tag) && !token.closing) {
          let end = token.end;
          if (!token.selfClosing && !['input', 'link', 'meta', 'base', 'embed'].includes(token.tag)) {
            const close = new RegExp(`</${token.tag}\\s*>`, 'ig'); close.lastIndex = end;
            const match = close.exec(text); end = match ? match.index + match[0].length : text.length;
          }
          push({ type: 'inactive', tag: token.tag, raw: text.slice(index, end), end }); continue;
        }
        push(token); continue;
      }
    }
    const image = text[index] === '!' && text[index + 1] === '[' && !escaped(text, index);
    if (image || (text[index] === '[' && !escaped(text, index))) {
      const labelStart = index + (image ? 1 : 0), name = bracket(text, labelStart);
      if (name) {
        const direct = destination(text, name.end);
        const reference = !direct ? bracket(text, name.end) : null;
        if (direct || reference || image) {
          const end = direct?.end ?? reference?.end ?? name.end;
          push({ type: image ? 'image' : 'link', alt: name.value,
            ref: direct?.value, reference: direct ? null : normalizedLabel(reference?.value || name.value),
            raw: text.slice(index, end), end }); continue;
        }
      }
    }
    index++;
  }
  if (plainStart < text.length) tokens.push({ type: 'text', raw: text.slice(plainStart) });
  const definitions = new Map(tokens.filter(token => token.type === 'definition').map(token => [token.label, token.ref]));
  for (const token of tokens) if (token.reference && definitions.has(token.reference)) token.ref = definitions.get(token.reference);
  return tokens;
}

function htmlReferences(token, parentTags = []) {
  if (token.type !== 'html' || token.closing || !SAFE_TAGS.has(token.tag)) return [];
  const result = [];
  const mime = token.attributes.find(attribute => attribute.name === 'type')?.value || '';
  const kind = token.tag === 'img' ? 'image' : token.tag === 'source' ?
    mime.startsWith('image/') || parentTags.includes('picture') ? 'image' :
      mime.startsWith('video/') || parentTags.includes('video') ? 'video' :
        mime.startsWith('audio/') || parentTags.includes('audio') ? 'audio' : 'attachment' : token.tag;
  for (const attr of token.attributes) {
    if (attr.name === 'href' && token.tag === 'a' && isDownloadReference(attr.value,
      token.attributes.some(attribute => attribute.name === 'download'))) {
      result.push({ ref: attr.value, kind: 'attachment', attribute: attr.name });
    }
    if (attr.name === 'src' && ['img', 'audio', 'video', 'source'].includes(token.tag)) result.push({ ref: attr.value, kind, attribute: attr.name });
    if (attr.name === 'poster' && token.tag === 'video') result.push({ ref: attr.value, kind: 'image', attribute: 'poster' });
    if (attr.name === 'srcset' && ['img', 'source'].includes(token.tag)) {
      for (const candidate of parseSrcset(attr.value)) result.push({ ref: candidate.url, kind: 'image', attribute: 'srcset', descriptor: candidate.descriptor });
    }
  }
  return result;
}

export function extractRichReferences(text) {
  const result = [], stack = [];
  for (const token of tokenizeRichText(text)) {
    if (token.type === 'image' && token.ref) result.push({ ref: token.ref, kind: 'image', syntax: 'markdown' });
    else if (token.type === 'link') {
      if (isDownloadReference(token.ref)) result.push({ ref: token.ref, kind: 'attachment', syntax: 'markdown' });
      result.push(...extractRichReferences(token.alt));
    }
    else if (token.type === 'html') {
      result.push(...htmlReferences(token, stack).map(item => ({ ...item, syntax: 'html' })));
      if (token.closing) { const at = stack.lastIndexOf(token.tag); if (at >= 0) stack.splice(at); }
      else if (!token.selfClosing) stack.push(token.tag);
    }
  }
  return result;
}

export function safePublicURL(value) {
  try {
    const decoded = decodeHTMLEntities(value).trim();
    if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
    const url = new URL(decoded);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    for (const key of url.searchParams.keys()) if (/(?:token|signature|credential|authorization|api[_-]?key|^auth$|^sig$|^key$|key-pair-id)/i.test(key)) return null;
    if (/(?:token|authorization|credential)=/i.test(url.hash)) return null;
    return url.href;
  } catch { return null; }
}

function destinationEscape(value) { return String(value).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E'); }

export function renderRichText(value, { resolveAsset = () => null } = {}) {
  const stack = [];
  const output = tokenizeRichText(value).map(token => {
    if (token.type === 'code') return token.raw + (token.close ? `${token.raw.endsWith('\n') ? '' : '\n'}${token.close}` : '');
    if (token.type === 'html-code') return `<${token.tag}>${textEscape(decodeHTMLEntities(token.body))}</${token.tag}>`;
    if (token.type === 'comment') return '';
    if (token.type === 'inactive') return `〔${token.tag} 动态内容未执行，原始内容保留在 JSON〕`;
    if (token.type === 'text') return token.raw.replace(/</g, '&lt;');
    if (token.type === 'definition') return safePublicURL(token.ref) ? token.raw : '';
    if (token.type === 'image') {
      if (!token.ref) return token.raw.replace(/</g, '&lt;');
      const target = resolveAsset(token.ref, { kind: 'image' });
      return target ? `![${markdownLabel(token.alt)}](${destinationEscape(target)})` : `〔图片${token.alt ? `：${markdownLabel(token.alt)}` : ''}，待补采〕`;
    }
    if (token.type === 'link') {
      const attachment = isDownloadReference(token.ref);
      const target = (attachment ? resolveAsset(token.ref, { kind: 'attachment' }) : null) ||
        (token.ref?.startsWith('#') ? token.ref : safePublicURL(token.ref));
      const label = renderRichText(token.alt, { resolveAsset });
      return target ? `[${label}](${destinationEscape(target)})` : `${label}${attachment ? '〔附件待补采〕' : ''}`;
    }
    if (token.type !== 'html') return '';
    if (!SAFE_TAGS.has(token.tag)) return textEscape(token.raw);
    if (token.closing) {
      const at = stack.lastIndexOf(token.tag);
      if (at < 0) return '';
      return stack.splice(at).reverse().map(tag => `</${tag}>`).join('');
    }
    const attrs = [];
    let hasImage = false, pendingAttachment = false;
    for (const attr of token.attributes) {
      const name = attr.name, value = attr.value;
      if (['alt', 'title'].includes(name)) attrs.push(`${name}="${attrEscape(value)}"`);
      else if (['width', 'height', 'colspan', 'rowspan', 'start'].includes(name) && /^\d{1,5}$/.test(value)) attrs.push(`${name}="${value}"`);
      else if (name === 'align' && /^(left|center|right)$/.test(value)) attrs.push(`align="${value}"`);
      else if (name === 'open' && token.tag === 'details') attrs.push('open');
      else if (name === 'controls' && ['audio', 'video'].includes(token.tag)) attrs.push('controls');
      else if (name === 'type' && token.tag === 'source' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(value)) attrs.push(`type="${attrEscape(value)}"`);
      else if (name === 'href' && token.tag === 'a') {
        const attachment = isDownloadReference(value, token.attributes.some(attribute => attribute.name === 'download'));
        const href = (attachment ? resolveAsset(value, { kind: 'attachment' }) : null) ||
          (value.startsWith('#') ? value : safePublicURL(value));
        if (href) attrs.push(`href="${attrEscape(href)}"`, 'rel="noreferrer noopener"');
        else if (attachment) pendingAttachment = true;
      } else if ((name === 'src' && ['img', 'audio', 'video', 'source'].includes(token.tag)) || (name === 'poster' && token.tag === 'video')) {
        const target = resolveAsset(value, { kind: name === 'poster' ? 'image' : token.tag });
        if (target) { attrs.push(`${name}="${attrEscape(target)}"`); hasImage = true; }
      } else if (name === 'srcset' && ['img', 'source'].includes(token.tag)) {
        const candidates = parseSrcset(value).map(item => {
          const target = resolveAsset(item.url, { kind: 'image' });
          return target ? `${target}${item.descriptor ? ' ' + item.descriptor : ''}` : null;
        }).filter(Boolean);
        if (candidates.length) { attrs.push(`srcset="${attrEscape(candidates.join(', '))}"`); hasImage = true; }
      }
    }
    if (token.tag === 'img' && !hasImage) return '〔图片，待补采〕';
    if (['audio', 'video'].includes(token.tag) && !attrs.includes('controls')) attrs.push('controls');
    if (!token.selfClosing) stack.push(token.tag);
    return `<${token.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${pendingAttachment ? '〔附件待补采〕' : ''}`;
  });
  output.push(...stack.reverse().map(tag => `</${tag}>`));
  return output.join('').replace(/^\n+|\n+$/g, '');
}
