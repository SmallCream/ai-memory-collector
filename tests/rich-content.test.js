import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeRichText, extractRichReferences, renderRichText, parseSrcset, safePublicURL } from '../extension/lib/rich-content.js';
import { extractAssets, sanitizeAssetRecords, createAssetResolver } from '../extension/lib/assets.js';
import { buildArchive } from '../extension/lib/archive.js';

const identity = { accountKey: 'acct-demo', displayName: 'Synthetic account' };
const prefix = 'data/web/chatgpt/acct-demo';
const markdownPath = `${prefix}/conversations/2026/10/example__demo.md`;
const conversation = content => ({ id: 'demo', title: 'Rich content', create_time: 1792486800,
  messages: [{ id: 'user-msg', role: 'user', content }] });
const build = (source, assets) => buildArchive({ conversation: source, identity, assets,
  capturedAt: '2026-10-21T07:00:00Z', productionPrefix: prefix });

test('extracts actual Markdown and HTML media while code examples remain opaque', () => {
  const text = [
    '![first](https://images.example.test/a(1).png "title")',
    '`![example](https://images.example.test/inline.png)`',
    '```html', '<img src="https://images.example.test/fenced.png">', '```',
    '    <img src="https://images.example.test/indented.png">',
    '<pre><img src="https://images.example.test/pre.png"></pre>',
    '<code>&lt;img src="https://images.example.test/code.png"&gt;</code>',
    '<img alt="a > b" src="https://images.example.test/html.png">',
    '<script>const html = "<img src=\'https://images.example.test/script.png\'>";</script>',
    '<style>body { background:url(https://images.example.test/style.png) }</style>',
    '<iframe src="https://images.example.test/embed"><img src="https://images.example.test/frame.png"></iframe>',
  ].join('\n');
  assert.deepEqual(extractRichReferences(text).map(item => item.ref), [
    'https://images.example.test/a(1).png', 'https://images.example.test/html.png',
  ]);
  const rendered = renderRichText(text);
  assert.ok(rendered.includes('`![example](https://images.example.test/inline.png)`'));
  assert.ok(rendered.includes('```html\n<img src="https://images.example.test/fenced.png">\n```'));
  assert.match(rendered, /<pre>&lt;img/);
  assert.match(rendered, /script 动态内容未执行/);
  assert.doesNotMatch(rendered, /<iframe|<script|<style/);
});

test('reference and linked images resolve structurally without collecting normal hyperlinks', () => {
  const text = '![reference][photo]\n\n[photo]: <https://images.example.test/ref.png> "caption"\n' +
    '[![thumbnail](https://images.example.test/thumb.png)](https://example.test/article)\n' +
    '[regular](https://example.test/not-an-image.png)';
  assert.deepEqual(extractRichReferences(text).map(item => item.ref), [
    'https://images.example.test/ref.png', 'https://images.example.test/thumb.png',
  ]);
  const result = renderRichText(text, { resolveAsset: () => '../../../assets/local.png' });
  assert.match(result, /!\[reference\]\(\.\.\/\.\.\/\.\.\/assets\/local.png\)/);
  assert.match(result, /\[!\[thumbnail\]/);
});

test('quoted and list-contained fences keep example resources literal', () => {
  for (const source of [
    '> ~~~html\n> <img src="https://example.test/example.png">\n> ~~~',
    '> > ```html\n> > ![example](https://example.test/example.png)\n> > ```',
    '- ~~~html\n  <img src="https://example.test/example.png">\n  ~~~',
    '10. ~~~html\n    <img src="https://example.test/example.png">\n    ~~~',
    '- - ~~~html\n    <img src="https://example.test/example.png">\n    ~~~',
    '> 1. ~~~html\n>    <img src="https://example.test/example.png">\n>    ~~~',
    '- > ~~~html\n  > <img src="https://example.test/example.png">\n  > ~~~',
  ]) {
    const text = source + '\n![actual](https://example.test/actual.png)';
    assert.deepEqual(extractRichReferences(text).map(item => item.ref), ['https://example.test/actual.png']);
    assert.ok(renderRichText(text).startsWith(source + '\n'));
  }
  const unfinished = '> ~~~html\n> <img src="https://example.test/example.png">';
  assert.deepEqual(extractRichReferences(unfinished), []);
  assert.equal(renderRichText(unfinished), unfinished + '\n> ~~~');
  assert.deepEqual(extractRichReferences(unfinished + '\n![actual](https://example.test/actual.png)').map(item => item.ref),
    ['https://example.test/actual.png']);
});

test('HTML tables, details and safe text attributes survive while active attributes are removed', () => {
  const text = '<details open id="app" onclick="alert(1)"><summary>Summary</summary>' +
    '<table style="background:url(https://tracker.example.test/x)"><tr><th colspan="2">Name</th></tr>' +
    '<tr><td>A</td><td><img src="https://images.example.test/a.png" onerror="alert(2)" title="a &quot; b"></td></tr></table></details>';
  const rendered = renderRichText(text, { resolveAsset: () => '../../../assets/a.png' });
  assert.match(rendered, /<details open><summary>Summary<\/summary>/);
  assert.match(rendered, /<th colspan="2">Name<\/th>/);
  assert.match(rendered, /<img src="\.\.\/\.\.\/\.\.\/assets\/a.png" title="a &quot; b">/);
  assert.doesNotMatch(rendered, /onclick|onerror|style=|id=|tracker/);
});

test('nested picture sources, video poster and srcset are resource nodes; links are not', () => {
  const source = '<video controls src="https://example.test/movie.mp4" poster="https://example.test/poster.png">' +
    '<source src="https://example.test/movie.webm" type="video/webm"></video>' +
    '<img srcset="https://example.test/a.png 1x, https://example.test/a2.png 2x">';
  assert.deepEqual(extractRichReferences(source).map(item => item.ref), [
    'https://example.test/movie.mp4', 'https://example.test/poster.png', 'https://example.test/movie.webm',
    'https://example.test/a.png', 'https://example.test/a2.png',
  ]);
  assert.deepEqual(parseSrcset('data:image/png;base64,AAAA 1x, https://example.test/a.png 2x'), [
    { url: 'data:image/png;base64,AAAA', descriptor: '1x' }, { url: 'https://example.test/a.png', descriptor: '2x' },
  ]);
  assert.deepEqual(extractRichReferences('<picture><source src="https://example.test/a.webp"><img src="https://example.test/a.png"></picture>').map(item => item.kind), ['image', 'image']);
});

test('malformed or dangerous HTML URLs cannot become executable links', () => {
  assert.equal(safePublicURL('javascript&#58;alert(1)'), null);
  assert.equal(safePublicURL('java&#x0a;script:alert(1)'), null);
  const result = renderRichText('<a href="javascript&#58;alert(1)" onclick="a()">read</a>\n<img src="javascript:alert(2)">\n<unclosed onclick="x"');
  assert.match(result, /<a>read<\/a>/);
  assert.match(result, /图片，待补采/);
  assert.match(result, /&lt;unclosed/);
  assert.doesNotMatch(result, /href="javascript|<img/);
});

test('native image pointer and metadata attachment merge filename and library identity', async () => {
  const source = conversation({ content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-demo-image', width: 1280, height: 960 },
    '请看图片',
  ] });
  source.messages[0].metadata = { attachments: [{ id: 'file-demo-image', library_file_id: 'libfile_demo_123',
    name: '简历.png', mime_type: 'image/png', size_bytes: 379055 }] };
  const [asset, ...others] = await extractAssets(source);
  assert.equal(others.length, 0);
  assert.match(asset.id, /^[a-f0-9]{64}$/);
  assert.equal(asset.sourceType, 'platform');
  assert.equal(asset.fileId, 'file-demo-image');
  assert.equal(asset.libraryFileId, 'libfile_demo_123');
  assert.equal(asset.fileName, '简历.png');
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.width, 1280); assert.equal(asset.height, 960); assert.equal(asset.expectedSize, 379055);
  assert.equal(sanitizeAssetRecords([asset])[0].expectedSize, 379055);
  assert.equal(asset.retrieval.libraryFileId, 'libfile_demo_123');
  assert.equal(asset.occurrences.length, 2);
  assert.equal(Object.keys(asset).includes('retrieval'), false);
});

test('direct file content references reuse the original image identity and retain all message occurrences', async () => {
  const fileId = 'file_synthetic_cited_image', libraryFileId = 'libfile_synthetic_cited_image';
  const source = conversation({ content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: `sediment://${fileId}`, width: 1, height: 1 },
  ] });
  source.messages[0].metadata = { attachments: [{ id: fileId, library_file_id: libraryFileId,
    name: 'synthetic-cited-image.png', mime_type: 'image/png', size_bytes: 100 }] };
  const [original] = await extractAssets(source);
  source.messages.push({ id: 'assistant-msg', role: 'assistant', content: { content_type: 'text', parts: ['Synthetic answer'] },
    metadata: { content_references: [{ type: 'file', source: 'my_files', id: fileId, library_file_id: libraryFileId,
      name: 'synthetic-cited-image.png', input_pointer: { message_id: null }, matched_text: 'synthetic-file-marker',
      alt: null, cloud_doc_url: null }] } });
  const snapshot = structuredClone(source);
  for (const messages of [source.messages, [...source.messages].reverse()]) {
    const assets = await extractAssets({ ...source, messages });
    assert.equal(assets.length, 1);
    const [asset] = assets;
    assert.equal(asset.id, original.id); assert.equal(asset.fileId, fileId); assert.equal(asset.libraryFileId, libraryFileId);
    assert.equal(asset.retrieval.fileId, fileId); assert.equal(asset.retrieval.libraryFileId, libraryFileId);
    assert.equal(asset.kind, 'image'); assert.equal(asset.expectedSize, 100); assert.equal(asset.width, 1);
    assert.equal(asset.occurrences.length, 3);
    for (const occurrence of original.occurrences) assert.ok(asset.occurrences.some(item =>
      item.messageId === occurrence.messageId && item.path === occurrence.path));
    assert.ok(asset.occurrences.some(item => item.messageId === 'assistant-msg' &&
      item.path === 'messages/assistant-msg/metadata/content_references/0'));
  }
  assert.deepEqual(source, snapshot);
});

test('content-reference IDs are inferred only for direct file entries with a valid file and library pair', async t => {
  const reference = { type: 'file', source: 'my_files', id: 'file_synthetic_reference',
    library_file_id: 'libfile_synthetic_reference', name: 'synthetic-reference.png' };
  for (const value of [
    { name: 'web reference', metadata: { content_references: [{ ...reference, type: 'web' }] } },
    { name: 'missing type', metadata: { content_references: [{ ...reference, type: undefined }] } },
    { name: 'non-file ID', metadata: { content_references: [{ ...reference, id: 'turn-synthetic-reference' }] } },
    { name: 'invalid library ID', metadata: { content_references: [{ ...reference, library_file_id: 'not-a-library-id' }] } },
    { name: 'missing library ID', metadata: { content_references: [{ ...reference, library_file_id: undefined }] } },
    { name: 'other metadata location', metadata: { other_references: [{ ...reference }] } },
    { name: 'nested content references', metadata: { nested: { content_references: [{ ...reference }] } } },
    { name: 'nested file object', metadata: { content_references: [{ type: 'web', nested: { ...reference } }] } },
    { name: 'not a reference list', metadata: { content_references: { 0: { ...reference } } } },
  ]) await t.test(value.name, async () => {
    const source = conversation({ content_type: 'text', parts: ['Synthetic answer'] });
    source.messages[0].metadata = value.metadata;
    const assets = await extractAssets(source);
    assert.ok(assets.every(asset => asset.fileId === undefined));
  });
  const source = conversation({ content_type: 'text', parts: ['Synthetic answer'] });
  source.messages[0].content.content_references = [{ ...reference }];
  assert.ok((await extractAssets(source)).every(asset => asset.fileId === undefined));
});

test('file-reference recognition neither merges different file IDs by library ID nor leaks between extractions', async () => {
  const source = conversation({ content_type: 'text', parts: ['Synthetic answer'] });
  source.messages[0].metadata = { content_references: [
    { type: 'file', id: 'file_synthetic_one', library_file_id: 'libfile_synthetic_shared' },
    { type: 'file', id: 'file_synthetic_two', library_file_id: 'libfile_synthetic_shared' },
  ] };
  const assets = await extractAssets(source);
  assert.equal(assets.length, 2); assert.notEqual(assets[0].id, assets[1].id);
  assert.deepEqual(assets.map(asset => asset.fileId), ['file_synthetic_one', 'file_synthetic_two']);
  const separate = conversation({ content_type: 'text', parts: ['Another synthetic account'] });
  separate.messages[0].metadata = { content_references: [{ type: 'file', library_file_id: 'libfile_synthetic_shared' }] };
  const [unknown] = await extractAssets(separate);
  assert.equal(unknown.fileId, undefined);
  assert.ok(assets.every(asset => asset.id !== unknown.id));
});

test('native asset_pointer_link enriches the pointer asset without persisting its signed URL', async () => {
  const link = 'https://files.oaiusercontent.com/synthetic-image.png?sig=synthetic-private-signature';
  const source = conversation({ content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_synthetic_image', asset_pointer_link: link },
  ] });
  const snapshot = structuredClone(source);
  const [asset, ...others] = await extractAssets(source);
  assert.equal(others.length, 0);
  assert.equal(asset.fileId, 'file_synthetic_image');
  assert.equal(asset.sourceRef, 'sediment://file_synthetic_image');
  assert.equal(asset.retrieval.url, link);
  assert.equal(asset.occurrences.length, 2);
  assert.equal(Object.keys(asset).includes('retrieval'), false);
  assert.doesNotMatch(JSON.stringify(asset), /synthetic-private-signature/);
  assert.doesNotMatch(JSON.stringify(sanitizeAssetRecords([asset])), /synthetic-private-signature/);
  const archive = await build(source, [asset]);
  assert.doesNotMatch(JSON.stringify(archive.manifest), /synthetic-private-signature/);
  const archivedNative = structuredClone(snapshot);
  archivedNative.messages[0].content.parts[0].asset_pointer_link = link.split('?')[0];
  assert.deepEqual(JSON.parse(archive.files[0].content), archivedNative);
  assert.deepEqual(source, snapshot);
});

test('attachment links and native pointers merge in either traversal order', async () => {
  const link = 'https://files.oaiusercontent.com/synthetic.png?token=synthetic-only-secret';
  const content = { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_synthetic_attachment' },
  ] };
  const metadata = { attachments: [{ id: 'file_synthetic_attachment', asset_pointer_link: { url: link },
    library_file_id: 'libfile_synthetic_attachment', mime_type: 'image/png', name: 'synthetic.png' }] };
  for (const fields of [{ content, metadata }, { metadata, content }]) {
    const source = { id: 'demo', messages: [{ id: 'user-msg', role: 'user', ...fields }] };
    const assets = await extractAssets(source);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].retrieval.url, link);
    assert.equal(assets[0].retrieval.fileId, 'file_synthetic_attachment');
    assert.equal(assets[0].retrieval.libraryFileId, 'libfile_synthetic_attachment');
    assert.equal(assets[0].kind, 'image');
    assert.doesNotMatch(JSON.stringify(sanitizeAssetRecords(assets)), /synthetic-only-secret/);
  }
});

test('generated-image metadata link enriches only its owning pointer and preserves native input', async () => {
  const url = 'https://files.oaiusercontent.com/generated-synthetic.png?sig=synthetic-nested-secret';
  for (const link of [url, { url }]) {
    const source = conversation({ content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer',
      asset_pointer: 'sediment://file_synthetic_generated', library_file_id: 'libfile_synthetic_generated',
      width: 1024, height: 1024, size_bytes: 12345, metadata: { asset_pointer_link: link } }] });
    const before = structuredClone(source), assets = await extractAssets(source);
    assert.equal(assets.length, 1);
    const [asset] = assets;
    assert.equal(asset.fileId, 'file_synthetic_generated'); assert.equal(asset.libraryFileId, 'libfile_synthetic_generated');
    assert.equal(asset.kind, 'image'); assert.equal(asset.retrieval.url, url);
    assert.equal(asset.expectedSize, 12345); assert.equal(asset.width, 1024);
    assert.equal(asset.occurrences.length, 2);
    assert.match(asset.occurrences[1].path, /content\/parts\/0\/metadata\/asset_pointer_link$/);
    assert.doesNotMatch(JSON.stringify(asset), /synthetic-nested-secret/);
    assert.doesNotMatch(JSON.stringify(sanitizeAssetRecords(assets)), /synthetic-nested-secret/);
    assert.deepEqual(source, before);
  }
});

test('image metadata link inheritance does not relabel sibling attachments or message metadata', async () => {
  const owned = 'https://files.oaiusercontent.com/owned.png?sig=owned-secret';
  const other = 'https://files.oaiusercontent.com/other.png?sig=other-secret';
  const messageLink = 'https://files.oaiusercontent.com/message.png?sig=message-secret';
  const source = conversation({ content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer',
    asset_pointer: 'sediment://file_synthetic_owner', metadata: { asset_pointer_link: owned,
      attachments: [{ id: 'file_synthetic_other', mime_type: 'image/png', asset_pointer_link: other }] } }] });
  source.messages[0].metadata = { asset_pointer_link: messageLink };
  const assets = await extractAssets(source);
  assert.equal(assets.length, 3);
  assert.equal(assets.find(a => a.fileId === 'file_synthetic_owner').retrieval.url, owned);
  assert.equal(assets.find(a => a.fileId === 'file_synthetic_other').retrieval.url, other);
  assert.equal(assets.find(a => a.retrieval.url === messageLink).fileId, undefined);
  assert.doesNotMatch(JSON.stringify(assets), /owned-secret|other-secret|message-secret/);
});

test('null nested image link remains unresolved and a conflicting metadata ID is not attached to the parent', async () => {
  const source = conversation({ content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer',
    asset_pointer: 'sediment://file_synthetic_parent', metadata: { asset_pointer_link: null } }] });
  let assets = await extractAssets(source);
  assert.equal(assets.length, 1); assert.equal(assets[0].status, 'pending');
  assert.equal(assets[0].retrieval.url, 'sediment://file_synthetic_parent');
  source.messages[0].content.parts[0].metadata = { file_id: 'file_synthetic_different',
    asset_pointer_link: 'https://files.oaiusercontent.com/different.png?sig=different-secret' };
  assets = await extractAssets(source);
  assert.equal(assets.length, 2);
  assert.equal(assets.find(a => a.fileId === 'file_synthetic_parent').retrieval.url, 'sediment://file_synthetic_parent');
  assert.match(assets.find(a => a.fileId === 'file_synthetic_different').retrieval.url, /^https:/);
});

test('deduplicated image retrieval prefers HTTPS over HTTP, blob and opaque pointers', async () => {
  const usable = 'https://files.oaiusercontent.com/synthetic.png?sig=synthetic-secret';
  const alternatives = ['sediment://file_synthetic_precedence', 'http://files.oaiusercontent.com/synthetic.png',
    'blob:https://chatgpt.com/00000000-0000-0000-0000-000000000000'];
  for (const alternate of alternatives) {
    for (const urls of [[alternate, usable], [usable, alternate]]) {
      const source = conversation({ content_type: 'multimodal_text', parts: urls.map(url => ({
        content_type: 'image', file_id: 'file_synthetic_precedence', url,
      })) });
      const assets = await extractAssets(source);
      assert.equal(assets.length, 1);
      assert.equal(assets[0].retrieval.url, usable);
      assert.doesNotMatch(JSON.stringify(assets), /synthetic-secret/);
    }
  }
});

test('null attachment links still retain the native pointer and library identity', async () => {
  const source = conversation({ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_synthetic_null' });
  source.messages[0].metadata = { attachments: [{ id: 'file_synthetic_null', asset_pointer_link: null,
    library_file_id: 'libfile_synthetic_null', mime_type: 'image/png' }] };
  const assets = await extractAssets(source);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].retrieval.url, 'sediment://file_synthetic_null');
  assert.equal(assets[0].retrieval.libraryFileId, 'libfile_synthetic_null');
});

test('signed URLs are temporary and never appear in synchronized asset metadata', async () => {
  const secret = 'private-credential-value';
  const source = conversation(`<img src="https://files.example.test/picture.png?width=200&amp;sig=${secret}&amp;se=tomorrow">`);
  const assets = await extractAssets(source);
  assert.equal(assets.length, 1); assert.equal(assets[0].sourceType, 'temporary');
  assert.ok(assets[0].retrieval.url.includes(secret));
  assert.ok(!JSON.stringify(assets).includes(secret));
  assert.ok(!JSON.stringify(sanitizeAssetRecords(assets)).includes(secret));
  assert.equal(createAssetResolver(assets, markdownPath)(assets[0].retrieval.url), null);
});

test('signed native URLs with file IDs persist only platform references', async () => {
  const assets = await extractAssets(conversation({ content_type: 'image', file_id: 'file-demo', url: 'https://files.example.test/a.png?token=never-store-this' }));
  assert.equal(assets[0].sourceType, 'platform');
  assert.equal(assets[0].sourceRef, 'file-service://file-demo');
  assert.ok(assets[0].retrieval.url.includes('never-store-this'));
  assert.ok(!JSON.stringify(assets).includes('never-store-this'));
});

test('public HTTPS candidates are pending until validated; unsafe schemes do not become external', async () => {
  const assets = await extractAssets(conversation('![public](https://images.example.test/photo.png)\n![local](file:///etc/passwd)'));
  assert.equal(assets[0].sourceType, 'external'); assert.equal(assets[0].status, 'pending');
  assert.equal(assets[1].sourceType, 'unknown');
  assert.equal(createAssetResolver(assets, markdownPath)(assets[0].sourceRef), null);
  assets[0].status = 'external';
  assert.equal(createAssetResolver(assets, markdownPath)(assets[0].sourceRef), assets[0].sourceRef);
});

test('same-account local images are relative and other-account or traversing paths stay unavailable', async () => {
  const assets = await extractAssets(conversation('![photo](https://images.example.test/photo.png)'));
  assets[0].status = 'downloaded'; assets[0].localPath = `${prefix}/assets/图 片.png`;
  assert.equal(createAssetResolver(assets, markdownPath)(assets[0].sourceRef), '../../../assets/%E5%9B%BE%20%E7%89%87.png');
  assets[0].localPath = 'data/web/chatgpt/another-account/assets/a.png';
  assert.equal(createAssetResolver(assets, markdownPath)(assets[0].sourceRef), null);
  assets[0].localPath = `${prefix}/assets/../../outside.png`;
  assert.equal(createAssetResolver(assets, markdownPath)(assets[0].sourceRef), null);
});

test('archive stores descriptors in manifest only and regenerates HTML/image output without changing native data', async () => {
  const source = conversation('<details><summary>图片</summary><table><tr><td><img src="https://images.example.test/a.png"></td></tr></table></details>');
  const assets = await extractAssets(source);
  assets[0].status = 'downloaded'; assets[0].localPath = `${prefix}/assets/a.png`;
  assets[0].untrustedResponseHeaders = { Authorization: 'secret' };
  const result = await build(source, assets);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
  assert.match(result.files[1].content, /<img src="\.\.\/\.\.\/\.\.\/assets\/a.png">/);
  assert.equal(result.manifest.conversations.demo.assets.length, 1);
  assert.ok(!JSON.stringify(result.manifest).includes('untrustedResponseHeaders'));
  assert.ok(!JSON.stringify(result.manifest).includes('retrieval'));
});

test('embedded image can resolve after descriptors have been serialized and reloaded', async () => {
  const source = conversation('![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)');
  const assets = await extractAssets(source);
  assert.equal(assets[0].sourceType, 'embedded'); assert.match(assets[0].sourceRef, /^embedded:sha256:/);
  assets[0].status = 'downloaded'; assets[0].localPath = `${prefix}/assets/pixel.png`;
  const result = await build(source, JSON.parse(JSON.stringify(assets)));
  assert.match(result.files[1].content, /!\[pixel\]\(\.\.\/\.\.\/\.\.\/assets\/pixel.png\)/);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
});

test('structured tables render without discarding cells or exposing raw HTML in values', async () => {
  const source = conversation({ content_type: 'table', columns: [{ key: 'name', title: '名字' }, { key: 'score', title: '成绩' }],
    rows: [{ name: 'A|B', score: '<script>alert(1)</script>' }, { name: 'C', score: 95 }] });
  const result = await build(source, []);
  assert.match(result.files[1].content, /\| 名字 \| 成绩 \|/);
  assert.match(result.files[1].content, /A\\\|B/);
  assert.match(result.files[1].content, /script 动态内容未执行/);
  assert.match(result.files[1].content, /\| C \| 95 \|/);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
});

test('known internal payloads disappear from reading view while unknown content is explained and preserved', async () => {
  const source = { id: 'demo', messages: [
    { id: 'thought', role: 'assistant', content: { content_type: 'thoughts', text: 'internal-only' } },
    { id: 'card', role: 'assistant', content: { content_type: 'future_widget', fields: { keep: true } } },
    { id: 'visible', role: 'assistant', content: 'Visible response' },
  ] };
  const result = await build(source, []);
  assert.doesNotMatch(result.files[1].content, /internal-only|非文本内容/);
  assert.match(result.files[1].content, /future\\_widget/);
  assert.match(result.files[1].content, /原始数据保留在 JSON/);
  assert.deepEqual(JSON.parse(result.files[0].content), source);
});

test('unterminated code fences are closed for the next speaker but never scanned for assets', () => {
  const source = '```html\n<img src="https://images.example.test/example.png">';
  assert.equal(extractRichReferences(source).length, 0);
  assert.equal(renderRichText(source), source + '\n```');
  assert.equal(tokenizeRichText(source)[0].type, 'code');
});

test('download links become attachment resources while examples and ordinary hyperlinks remain untouched', () => {
  const source = [
    '[下载 ZIP](sandbox:/workspace/scratch/synthetic/dist/archive.zip)',
    '[报告][document]',
    '[document]: <sandbox:/mnt/data/report%20final.pdf>',
    '<a href="sandbox:/mnt/data/table.xlsx">表格</a>',
    '<a href="https://files.example.test/export" download="bundle.zip">导出</a>',
    '[说明](https://example.test/guide)',
    '[公开文档](https://files.example.test/report.docx)',
    '`[示例](sandbox:/mnt/data/code.zip)`',
    '```markdown', '[示例](sandbox:/mnt/data/fenced.zip)', '```',
    '<pre><a href="sandbox:/mnt/data/example.zip">example</a></pre>',
    '<a href="javascript:alert(1)" download>unsafe</a>',
  ].join('\n');
  const references = extractRichReferences(source);
  assert.deepEqual(references.map(reference => reference.ref), [
    'sandbox:/workspace/scratch/synthetic/dist/archive.zip', 'sandbox:/mnt/data/report%20final.pdf',
    'sandbox:/mnt/data/table.xlsx', 'https://files.example.test/export', 'https://files.example.test/report.docx',
  ]);
  assert.ok(references.every(reference => reference.kind === 'attachment'));
  assert.equal(references[2].attribute, 'href');
});

test('sandbox attachment identities retain exact full paths and never borrow IDs from matching filenames', async () => {
  const source = conversation('[first](sandbox:/mnt/data/one/archive.zip)\n[second](sandbox:/mnt/data/two/archive.zip)\n' +
    '[encoded](sandbox:/mnt/data/%E6%96%87%E4%BB%B6%20final.docx)');
  source.messages[0].metadata = { attachments: [{ id: 'file_synthetic_other_archive', name: 'archive.zip', mime_type: 'application/zip' }] };
  const snapshot = structuredClone(source);
  const assets = await extractAssets(source);
  assert.equal(assets.length, 4);
  assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
  for (const asset of assets.slice(0, 3)) {
    assert.equal(asset.kind, 'attachment'); assert.equal(asset.sourceType, 'platform');
    assert.equal(asset.fileId, undefined); assert.equal(asset.libraryFileId, undefined);
    assert.equal(asset.retrieval.url, asset.sourceRef); assert.equal(asset.status, 'pending');
  }
  assert.deepEqual(assets.slice(0, 3).map(asset => asset.fileName), ['archive.zip', 'archive.zip', '文件 final.docx']);
  assert.deepEqual(source, snapshot);
});

test('downloaded Markdown and HTML attachments render local hyperlinks, preserving native JSON and account isolation', async () => {
  const source = conversation('[下载 ZIP](sandbox:/workspace/scratch/synthetic/dist/archive.zip)\n' +
    '<a href="sandbox:/mnt/data/report.pdf" download="report.pdf" onclick="bad()">报告</a>');
  const snapshot = structuredClone(source), assets = await extractAssets(source);
  for (const [index, asset] of assets.entries()) {
    asset.status = 'downloaded'; asset.localPath = `${prefix}/assets/${'a'.repeat(64)}.${index ? 'pdf' : 'zip'}`;
  }
  const archive = await build(source, JSON.parse(JSON.stringify(assets)));
  assert.match(archive.files[1].content, /\[下载 ZIP\]\(\.\.\/\.\.\/\.\.\/assets\/[a-f0-9]+\.zip\)/);
  assert.match(archive.files[1].content, /<a href="\.\.\/\.\.\/\.\.\/assets\/[a-f0-9]+\.pdf" rel="noreferrer noopener">报告<\/a>/);
  assert.doesNotMatch(archive.files[1].content, /onclick|sandbox:|待补采/);
  assert.deepEqual(JSON.parse(archive.files[0].content), snapshot);
  assets[0].localPath = `data/web/chatgpt/other/assets/${'a'.repeat(64)}.zip`;
  const blocked = await build(source, assets);
  assert.match(blocked.files[1].content, /下载 ZIP〔附件待补采〕/);
  assert.doesNotMatch(blocked.files[1].content, /other\/assets/);
});

test('unavailable download links retain their labels with a pending marker and never expose signed credentials', () => {
  const text = '[下载 ZIP](sandbox:/mnt/data/archive.zip)\n' +
    '<a href="sandbox:/mnt/data/report.pdf">报告</a>\n' +
    '[私有文档](https://files.example.test/report.docx?sig=synthetic-secret)\n' +
    '[普通网页](https://example.test/article)';
  const rendered = renderRichText(text);
  assert.match(rendered, /下载 ZIP〔附件待补采〕/);
  assert.match(rendered, /<a>〔附件待补采〕报告<\/a>/);
  assert.match(rendered, /私有文档〔附件待补采〕/);
  assert.match(rendered, /\[普通网页\]\(https:\/\/example.test\/article\)/);
  assert.doesNotMatch(rendered, /synthetic-secret|sandbox:/);
});

test('a repeated sandbox path keeps each generating message version separate in Markdown', async () => {
  const ref = 'sandbox:/mnt/data/archive.zip';
  const source = conversation(`[first](${ref}) [same file](${ref})`);
  source.messages.push({ id: 'assistant-next', role: 'assistant', content: `[second](${ref})` });
  const assets = await extractAssets(source);
  assert.equal(assets.length, 2); assert.notEqual(assets[0].id, assets[1].id);
  for (const [index, asset] of assets.entries()) {
    asset.status = 'downloaded'; asset.localPath = `${prefix}/assets/${String(index + 1).repeat(64)}.zip`;
  }
  const resolver = createAssetResolver(assets, markdownPath);
  assert.equal(resolver(ref), null);
  assert.equal(resolver(ref, { messageId: 'missing-message' }), null);
  assert.equal(resolver(ref, { messageId: 'user-msg' }), `../../../assets/${'1'.repeat(64)}.zip`);
  const archive = await build(source, assets);
  assert.ok(archive.files[1].content.includes(`[first](../../../assets/${'1'.repeat(64)}.zip)`));
  assert.ok(archive.files[1].content.includes(`[same file](../../../assets/${'1'.repeat(64)}.zip)`));
  assert.ok(archive.files[1].content.includes(`[second](../../../assets/${'2'.repeat(64)}.zip)`));
  assets[1].status = 'pending'; delete assets[1].localPath;
  const incomplete = await build(source, assets);
  assert.ok(incomplete.files[1].content.includes(`[first](../../../assets/${'1'.repeat(64)}.zip)`));
  assert.match(incomplete.files[1].content, /second〔附件待补采〕/);
});
