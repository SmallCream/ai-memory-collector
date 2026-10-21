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
