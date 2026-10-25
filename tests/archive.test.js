import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchive } from '../extension/lib/archive.js';

const identity = { accountKey: 'acct-demo', displayName: '演示账号' };
const capturedAt = '2026-10-20T09:00:00Z';
function fixture() {
  return {
    conversation_id: 'demo-conversation', title: '项目讨论', create_time: 1792486800,
    current_node: 'reply2', future_field: { preserved: true },
    mapping: {
      root: { id: 'root', parent: null, children: ['question'], message: null },
      question: { id: 'question', parent: 'root', children: ['reply1', 'reply2'], message: {
        id: 'message-q', author: { role: 'user' }, content: { content_type: 'text', parts: ['说明 authorization 和 token。\n```js\nconst x = 1;\n```'] },
      } },
      reply1: { id: 'reply1', parent: 'question', children: [], message: {
        id: 'message-a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['未选中的回复'] },
      } },
      reply2: { id: 'reply2', parent: 'question', children: [], message: {
        id: 'message-a2', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts: ['选中的回复', { content_type: 'image_asset_pointer', asset_pointer: 'asset-demo' }] },
      } },
    },
  };
}
const build = (conversation = fixture(), extra = {}) => buildArchive({ conversation, identity, capturedAt, ...extra });

test('native object keeps unknown fields, null root and unselected branch; MD follows current branch only', async () => {
  const source = fixture();
  const { files, summary } = await build(source);
  assert.deepEqual(JSON.parse(files[0].content), source);
  assert.match(files[1].content, /选中的回复/);
  assert.doesNotMatch(files[1].content, /未选中的回复/);
  assert.match(files[1].content, /〔图片〕/);
  assert.doesNotMatch(files[1].content, /image_asset_pointer|消息 ID|msg-|SHA-256|采集说明|渲染器/);
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.currentBranchMessageCount, 2);
  assert.equal(summary.coverage.messages, 'unknown');
  assert.match(files[0].path, /^p0-captures\/chatgpt\/acct-demo\/conversations\/2026\/10\//);
});

test('same identity keeps its first filename after title change and repeat capture is byte stable', async () => {
  const first = await build();
  const renamed = fixture(); renamed.title = '新的标题';
  const second = await build(renamed, { capturedAt: '2026-10-22T09:00:00Z', existingManifest: first.manifest });
  assert.equal(second.files[0].path, first.files[0].path);
  assert.match(second.files[1].content, /新的标题/);
  const third = await build(renamed, { capturedAt: '2026-10-23T09:00:00Z', existingManifest: second.manifest });
  assert.deepEqual(third.files, second.files);
});

test('safe Unicode filenames retain complete ID and fixed fallback time', async () => {
  const source = fixture(); source.title = '../坏标题:/\\?*😀'.repeat(10); delete source.create_time;
  const first = await build(source);
  assert.match(first.files[0].path, /__demo-conversation\.json$/);
  assert.equal(first.files[0].path.split('/').length, 7);
  assert.ok(!first.files[0].path.includes('\\'));
  source.create_time = 1000000;
  const later = await build(source, { existingManifest: first.manifest });
  assert.equal(later.files[0].path, first.files[0].path);
});

test('credential redaction is explicit and does not rewrite prose/code', async () => {
  const source = fixture();
  source.access_token = 'secret-token';
  source.attachment = { url: 'https://files.example.test/a?width=100&X-Amz-Signature=secret-signature', future: 'keep' };
  const prose = 'https://example.test/?token=user-authored-example';
  source.mapping.question.message.content.parts.push(prose);
  const result = await build(source);
  const native = JSON.parse(result.files[0].content);
  assert.equal(native.access_token, '[REDACTED]');
  assert.equal(native.attachment.url, 'https://files.example.test/a?width=100');
  assert.equal(native.mapping.question.message.content.parts.at(-1), prose);
  assert.equal(source.access_token, 'secret-token');
  assert.equal(result.summary.redactionCount, 2);
  assert.equal(result.manifest.conversations['demo-conversation'].redactions.length, 2);
  assert.doesNotMatch(result.files.map(f => f.content).join(''), /secret-token|secret-signature/);
});

test('missing parent, missing current node and cycles never fabricate a complete branch', async () => {
  const missing = fixture(); missing.mapping.question.parent = 'absent';
  const a = await build(missing);
  assert.equal(a.summary.coverage.messages, 'partial');
  assert.ok(a.summary.warnings.some(w => w.includes('缺少父节点')));
  const cycle = fixture(); cycle.mapping.question.parent = 'reply2';
  const b = await build(cycle);
  assert.equal(b.summary.coverage.messages, 'partial');
  assert.ok(b.summary.warnings.some(w => w.includes('循环')));
  const unknown = fixture(); delete unknown.current_node;
  const c = await build(unknown);
  assert.equal(c.summary.currentBranchMessageCount, 0);
  assert.doesNotMatch(c.files[1].content, /选中的回复/);
});

test('partial page and in-progress content are marked partial', async () => {
  const source = fixture(); source.page_info = { has_next_page: true };
  source.mapping.reply2.message.status = 'in_progress';
  const result = await build(source);
  assert.equal(result.summary.coverage.messages, 'partial');
  assert.equal(result.summary.coverage.branches, 'partial');
});

test('historical unfinished states remain exact in native JSON while generation metadata stays out of reading Markdown', async () => {
  for (const status of ['pending', 'streaming', 'in_progress']) {
    const source = fixture();
    // A selected ancestor has an explicit end-of-turn answer later on this path.
    source.mapping.question.message.status = status;
    Object.assign(source.mapping.reply2.message, { status: 'finished_successfully', end_turn: true });
    const result = await build(source);
    assert.deepEqual(JSON.parse(result.files[0].content), source);
    assert.equal(result.summary.coverage.messages, 'unknown');
    const expected = { policy: 'closed-descendant-v1', historicalUnfinishedCount: 1, unresolvedUnfinishedCount: 0 };
    assert.deepEqual(result.summary.generationState, expected);
    assert.deepEqual(result.manifest.conversations['demo-conversation'].generationState, expected);
    assert.ok(result.summary.warnings.some(warning => warning.includes('原样保留 1 条历史未完成状态消息')));
    assert.match(result.files[1].content, /说明 authorization 和 token/);
    assert.match(result.files[1].content, /选中的回复/);
    assert.doesNotMatch(result.files[1].content, /历史未完成状态|closed-descendant|采集不能/);
    assert.deepEqual((await build(source, { existingManifest: result.manifest })).files, result.files);
  }
});

test('an unfinished sibling or current node remains partial despite a completed answer elsewhere', async () => {
  for (const target of ['reply1', 'reply2']) {
    const source = fixture();
    Object.assign(source.mapping.reply2.message, { status: 'finished_successfully', end_turn: true });
    source.mapping[target].message.status = 'pending';
    const result = await build(source);
    assert.equal(result.summary.coverage.messages, 'partial');
    assert.equal(result.summary.generationState.unresolvedUnfinishedCount, 1);
    assert.deepEqual(JSON.parse(result.files[0].content), source);
  }
});

test('flat history cannot use a later answer as proof that an earlier pending status is historical', async () => {
  const source = { id: 'flat-pending', messages: [
    { id: 'q', author: { role: 'user' }, status: 'pending', content: 'Question' },
    { id: 'a', author: { role: 'assistant' }, status: 'finished_successfully', end_turn: true, content: 'Answer' },
  ], page_info: { has_previous_page: false, has_next_page: false } };
  const result = await build(source);
  assert.equal(result.summary.coverage.messages, 'partial');
  assert.equal(result.summary.generationState.historicalUnfinishedCount, 0);
  assert.equal(result.summary.generationState.unresolvedUnfinishedCount, 1);
});

test('unsafe or conflicting identity and foreign manifest rejected before files are built', async () => {
  await assert.rejects(build(fixture(), { identity: { accountKey: '../other' } }), /账号标识/);
  const source = fixture(); source.conversation_id = '../bad';
  await assert.rejects(build(source), /对话 ID/);
  const conflict = fixture(); conflict.id = 'different';
  await assert.rejects(build(conflict), /不一致/);
  const first = await build(); first.manifest.accountKey = 'other';
  await assert.rejects(build(fixture(), { existingManifest: first.manifest }), /归属/);
});

test('manifest traversal rejected, unknown fields such as __proto__ remain inert JSON data', async () => {
  const first = await build();
  const entry = first.manifest.conversations['demo-conversation'];
  entry.jsonPath = 'p0-captures/chatgpt/acct-demo/conversations/../elsewhere__demo-conversation.json';
  entry.markdownPath = entry.jsonPath.replace('.json', '.md');
  await assert.rejects(build(fixture(), { existingManifest: first.manifest }), /路径/);
  const source = fixture(); source.unknown = JSON.parse('{"__proto__":{"injected":true}}');
  const result = await build(source);
  assert.equal(JSON.parse(result.files[0].content).unknown.__proto__.injected, true);
  assert.equal({}.injected, undefined);
});

test('Markdown keeps code literal while blocking active HTML and unresolved images', async () => {
  const source = fixture(); source.title = '<img src=x onerror=alert(1)>';
  const body = '<script>alert(1)</script>\n![track](https://example.test/pixel)\n`<span>inline</span>`\n```html\n<img src=x onerror=alert(1)>\n```';
  source.mapping.reply2.message.content.parts = [body];
  const result = await build(source);
  assert.match(result.files[1].content, /&lt;img/);
  assert.match(result.files[1].content, /script 动态内容未执行/);
  assert.ok(result.files[1].content.includes('〔图片：track，待补采〕'));
  assert.ok(result.files[1].content.includes('`<span>inline</span>`'));
  assert.ok(result.files[1].content.includes('```html\n<img src=x onerror=alert(1)>\n```'));
  assert.equal(JSON.parse(result.files[0].content).mapping.reply2.message.content.parts[0], body);
});

test('flat messages stay native and are displayed as unverified source order, not a proven branch', async () => {
  const source = {
    conversation_id: 'flat-demo', title: '分页详情', create_time: 1792486800, current_node: 'answer',
    messages: [
      { id: 'question', role: 'user', content: '你好' },
      { id: 'node-answer', message: { id: 'answer', author: { role: 'assistant' }, content: { parts: ['你好，世界'] } } },
    ],
    page_info: { has_previous_page: true, has_next_page: false }, future_field: { keep: true },
  };
  const result = await build(source);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
  assert.equal(result.summary.renderMode, 'source-array');
  assert.equal(result.summary.messageCount, 2);
  assert.equal(result.summary.currentBranchMessageCount, null);
  assert.equal(result.summary.coverage.messages, 'partial');
  assert.ok(result.manifest.conversations['flat-demo'].warnings.some(warning => warning.includes('按返回顺序')));
  assert.doesNotMatch(result.files[1].content, /接口返回顺序|采集说明/);
  assert.match(result.files[1].content, /你好，世界/);
  assert.doesNotMatch(result.files[1].content, /## 当前分支/);
});

test('empty flat array archives without claiming verified completeness', async () => {
  const result = await build({ id: 'empty-demo', title: '空对话', messages: [], page_info: {} });
  assert.equal(result.summary.messageCount, 0);
  assert.equal(result.summary.coverage.messages, 'unknown');
  assert.deepEqual(JSON.parse(result.files[0].content).messages, []);
});

test('long Unicode title fits a filesystem component without shortening the source ID', async () => {
  const source = fixture(); source.title = '标题😀'.repeat(40); source.conversation_id = 'a'.repeat(160);
  const result = await build(source);
  const component = result.files[0].path.split('/').at(-1);
  assert.ok(new TextEncoder().encode(component).length <= 240);
  assert.ok(component.endsWith(`${source.conversation_id}.json`));
});

test('flat string content URLs remain exact authored prose', async () => {
  const content = 'https://example.test/?token=authored-example';
  const result = await build({ id: 'flat-prose', messages: [{ id: 'm1', role: 'user', content }] });
  assert.equal(JSON.parse(result.files[0].content).messages[0].content, content);
  assert.equal(result.summary.redactionCount, 0);
});

test('readable Markdown contains just title, speakers and normally formatted conversation', async () => {
  const body = '**结论**\n\n- 先保存 JSON\n- 再生成 Markdown\n\n| 格式 | 用途 |\n| --- | --- |\n| JSON | 原始数据 |\n\n```js\nconst html = "<div>example</div>";\n```';
  const source = { id: 'reading-demo', title: '归档格式', messages: [
    { id: 'q', role: 'user', content: '怎样保存？' },
    { id: 'a', role: 'assistant', content: { content_type: 'text', parts: [body] } },
  ], page_info: { has_next_page: true } };
  const result = await build(source);
  assert.equal(result.files[1].content, `# 归档格式\n\n**你：**\n\n怎样保存？\n\n---\n\n**ChatGPT：**\n\n${body}\n`);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
  assert.equal(result.summary.coverage.messages, 'partial');
  assert.ok(result.manifest.conversations['reading-demo'].warnings.length);
  assert.equal(result.manifest.conversations['reading-demo'].rendererVersion, 'rich-3');
});

test('internal and hidden messages stay in JSON but do not clutter the reading view', async () => {
  const source = { id: 'visible-demo', messages: [
    { id: 's', role: 'system', content: 'system-only' },
    { id: 'd', role: 'developer', content: 'developer-only' },
    { id: 'q', role: 'user', content: 'question-visible' },
    { id: 'reason', role: 'assistant', channel: 'analysis', content: 'analysis-only' },
    { id: 'call', role: 'assistant', recipient: 'browser', content: 'tool-call-only' },
    { id: 'tool', role: 'tool', content: 'tool-result-only' },
    { id: 'hidden', role: 'assistant', metadata: { is_visually_hidden_from_conversation: true }, content: 'hidden-only' },
    { id: 'a', role: 'assistant', channel: 'final', recipient: 'all', content: [{ type: 'text', text: 'answer-visible' }] },
    { id: 'empty', role: 'assistant', content: { parts: [''] } },
  ] };
  const result = await build(source);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
  assert.equal(result.summary.messageCount, 9);
  assert.equal(result.summary.displayedMessageCount, 2);
  assert.match(result.files[1].content, /question-visible/);
  assert.match(result.files[1].content, /answer-visible/);
  assert.doesNotMatch(result.files[1].content, /system-only|developer-only|analysis-only|tool-call-only|tool-result-only|hidden-only/);
});

test('an unfinished code fence is closed before the next speaker without changing JSON', async () => {
  for (const delimiter of ['```', '~~~~']) {
    const body = `${delimiter}js\nconst example = 1;`;
    const source = { id: 'fence-demo', messages: [
      { id: 'q', role: 'user', content: body },
      { id: 'a', role: 'assistant', content: '下一条回复' },
    ] };
    const result = await build(source);
    assert.ok(result.files[1].content.includes(`${body}\n${delimiter}\n\n---\n\n**ChatGPT：**`));
    assert.equal(JSON.parse(result.files[0].content).messages[0].content, body);
  }
});
