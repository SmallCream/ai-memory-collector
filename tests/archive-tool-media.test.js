import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchive } from '../extension/lib/archive.js';
import { extractAssets } from '../extension/lib/assets.js';

const prefix = 'data/web/chatgpt/acct-synthetic';
const imagePart = suffix => ({ content_type: 'image_asset_pointer', asset_pointer: `sediment://file_synthetic_${suffix}`,
  metadata: { generation: { synthetic: true }, dalle: { synthetic: true } } });
const tool = (suffix = 'image') => ({ id: `tool-${suffix}`, author: { role: 'tool', name: 'synthetic.random_alias' },
  recipient: 'all', channel: 'commentary', content: { content_type: 'multimodal_text', parts: [imagePart(suffix)] } });
function source(message = tool()) {
  return { id: 'synthetic-generated-image', title: 'Synthetic generated image', create_time: 1792486800,
    messages: [
      { id: 'question', author: { role: 'user' }, content: { parts: ['Generate a synthetic picture.'] } },
      { id: 'before', author: { role: 'assistant' }, content: { parts: ['Preparing the picture.'] } },
      message,
      { id: 'caption', author: { role: 'assistant' }, content: { parts: ['Synthetic caption.'] } },
    ] };
}
async function build(conversation, ready = true) {
  const assets = await extractAssets(conversation);
  if (ready) for (const asset of assets) {
    asset.status = 'downloaded'; asset.localPath = `${prefix}/assets/${asset.fileId}.png`;
  }
  return buildArchive({ conversation, assets, productionPrefix: prefix,
    identity: { accountKey: 'acct-synthetic' }, capturedAt: '2026-10-25T00:00:00Z' });
}

test('tool-generated native images render local links between surrounding messages without changing JSON', async () => {
  const conversation = source(), snapshot = structuredClone(conversation);
  const result = await build(conversation), markdown = result.files[1].content;
  assert.equal(result.summary.displayedMessageCount, 4);
  assert.match(markdown, /!\[图片\]\(\.\.\/\.\.\/\.\.\/assets\/file_synthetic_image\.png\)/);
  assert.ok(markdown.indexOf('Preparing the picture.') < markdown.indexOf('![图片]'));
  assert.ok(markdown.indexOf('![图片]') < markdown.indexOf('Synthetic caption.'));
  assert.doesNotMatch(markdown, /synthetic\.random_alias|image_asset_pointer|generation|dalle/);
  assert.equal(result.manifest.conversations[conversation.id].rendererVersion, 'rich-3');
  assert.deepEqual(conversation, snapshot);
  assert.deepEqual(JSON.parse(result.files[0].content), snapshot);
});

test('generated images still appear as pending when no local file or external target is available', async () => {
  const result = await build(source(), false);
  assert.match(result.files[1].content, /〔图片，待补采〕/);
  assert.doesNotMatch(result.files[1].content, /!\[|sediment:\/\/|file-service:\/\//);
  assert.equal(result.summary.displayedMessageCount, 4);
});

test('visible image output ignores arbitrary tool names but never emits tool prose, instructions or code', async () => {
  for (const name of ['imagegen', 'image_gen.text2im', 'synthetic.other_alias']) {
    const message = tool(); message.author.name = name;
    const part = message.content.parts[0]; part.text = 'embedded-tool-instructions';
    message.content.parts.unshift('raw-tool-instructions', { content_type: 'text', text: 'tool-text' },
      { content_type: 'code', text: 'tool-code' }, { content_type: 'thoughts', text: 'tool-thoughts' },
      { content_type: 'future_widget', text: 'tool-widget' });
    message.metadata = { attachments: [{ id: 'file_synthetic_metadata_only', mime_type: 'image/png' }] };
    const result = await build(source(message));
    assert.match(result.files[1].content, /file_synthetic_image\.png/);
    assert.doesNotMatch(result.files[1].content, /raw-tool-instructions|embedded-tool-instructions|tool-text|tool-code|tool-thoughts|tool-widget|metadata_only/);
    assert.deepEqual(JSON.parse(result.files[0].content), source(message));
  }
});

test('hidden, analysis, non-user-directed and non-multimodal tool records remain excluded', async () => {
  const changes = [
    message => { message.metadata = { is_visually_hidden_from_conversation: true }; },
    message => { message.channel = 'analysis'; },
    message => { delete message.channel; },
    message => { message.recipient = 'python'; },
    message => { delete message.recipient; },
    message => { message.content.content_type = 'execution_output'; },
    message => { message.content = { content_type: 'text', parts: ['![tool-log](sediment://file_synthetic_log)'] }; },
    message => { message.content.parts = ['raw-tool-text']; },
    message => { message.content.parts[0].metadata.is_visually_hidden_from_conversation = true; },
    message => { message.author.role = 'system'; },
    message => { message.author.role = 'developer'; },
  ];
  for (const change of changes) {
    const message = tool(); change(message);
    const conversation = source(message), result = await build(conversation);
    assert.equal(result.summary.displayedMessageCount, 3);
    assert.doesNotMatch(result.files[1].content, /!\[|待补采|raw-tool-text|tool-log/);
    assert.deepEqual(JSON.parse(result.files[0].content), conversation);
  }
});

test('multiple explicit image parts preserve order and do not show a hidden sibling part', async () => {
  const message = tool('one'); message.channel = 'final';
  message.content.parts.push(imagePart('two'), { ...imagePart('hidden'), metadata: { is_visually_hidden_from_conversation: true } });
  const result = await build(source(message)), markdown = result.files[1].content;
  assert.equal((markdown.match(/!\[图片\]/g) || []).length, 2);
  assert.ok(markdown.indexOf('file_synthetic_one.png') < markdown.indexOf('file_synthetic_two.png'));
  assert.doesNotMatch(markdown, /file_synthetic_hidden/);
});

test('generated-image rendering follows the selected branch and never appends unselected assets', async () => {
  const conversation = { id: 'synthetic-branches', title: 'Synthetic branches', current_node: 'caption-a', mapping: {
    root: { id: 'root', parent: null, children: ['question'], message: null },
    question: { id: 'question', parent: 'root', children: ['image-a', 'image-b'],
      message: { id: 'question', author: { role: 'user' }, content: { parts: ['Generate an image.'] } } },
    'image-a': { id: 'image-a', parent: 'question', children: ['caption-a'], message: tool('branch_a') },
    'caption-a': { id: 'caption-a', parent: 'image-a', children: [],
      message: { id: 'caption-a', author: { role: 'assistant' }, content: { parts: ['Selected caption.'] } } },
    'image-b': { id: 'image-b', parent: 'question', children: [], message: tool('branch_b') },
  } };
  const result = await build(conversation);
  assert.equal(result.manifest.conversations[conversation.id].assets.length, 2);
  assert.match(result.files[1].content, /file_synthetic_branch_a\.png/);
  assert.doesNotMatch(result.files[1].content, /file_synthetic_branch_b/);
  assert.deepEqual(JSON.parse(result.files[0].content), conversation);
});
