import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRichReferences, isDownloadReference, renderRichText } from '../extension/lib/rich-content.js';
import { analyzeAssets, extractAssets, sha256 } from '../extension/lib/assets.js';
import { buildArchive } from '../extension/lib/archive.js';

const page = 'https://github.com/example/project/blob/main/README.md';
const message = (id, text) => ({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] } });
const source = text => ({ id: 'synthetic-links', title: 'Synthetic links', create_time: 1792486800,
  messages: [message('synthetic-message', text)] });

test('ordinary GitHub file-viewer hyperlinks retain their URLs without becoming attachment resources', async () => {
  const text = `[说明](${page})\n<a href="${page}">说明</a>`;
  const native = source(text), snapshot = structuredClone(native);
  const inventory = await analyzeAssets(native);
  assert.equal(isDownloadReference(page), false);
  assert.deepEqual(extractRichReferences(text), []);
  assert.deepEqual(inventory.assets, []);
  assert.deepEqual(inventory.ordinaryLinkIds, [await sha256(`external:${page}`)]);
  assert.deepEqual(inventory.interfaceIconIds, []);
  assert.deepEqual(await extractAssets(native), []);
  const rendered = renderRichText(text, { resolveAsset: () => { throw new Error('ordinary link must not resolve as an asset'); } });
  assert.ok(rendered.includes(`[说明](${page})`));
  assert.ok(rendered.includes(`<a href="${page}" rel="noreferrer noopener">说明</a>`));
  assert.doesNotMatch(rendered, /待补采/);
  assert.deepEqual(native, snapshot);
});

test('reference-style GitHub links are ordinary links while linked images remain resources', async () => {
  const text = `[说明][guide]\n\n[guide]: <${page}> "guide"\n` +
    `[![图](https://images.example.test/chart.png)](${page})`;
  const inventory = await analyzeAssets(source(text));
  assert.deepEqual(inventory.ordinaryLinkIds, [await sha256(`external:${page}`)]);
  assert.deepEqual(inventory.assets.map(asset => asset.sourceRef), ['https://images.example.test/chart.png']);
  const rendered = renderRichText(text, { resolveAsset: () => '../../../assets/chart.png' });
  assert.ok(rendered.includes(`[说明](${page})`));
  assert.ok(rendered.includes(`[![图](../../../assets/chart.png)](${page})`));
});

test('GitHub page recognition is restricted to observed file-viewer routes and non-download queries', async () => {
  for (const url of [page, `${page}#L20`, `${page}?plain=1`,
    'https://github.com/example/project/blob/release/docs/format.md']) {
    assert.equal(isDownloadReference(url), false, url);
    assert.equal((await analyzeAssets(source(`[说明](${url})`))).ordinaryLinkIds.length, 1);
  }
  for (const url of [
    `${page}?raw=1`, `${page}?raw=true`, `${page}?download=1`, `${page}?unknown=1`,
    'https://github.com/example/project/raw/main/README.md',
    'https://raw.githubusercontent.com/example/project/main/README.md',
    'https://github.com/example/project/archive/refs/heads/main.zip',
    'https://github.com/example/project/releases/download/v1/report.pdf',
    'https://github.com.evil.example/example/project/blob/main/README.md',
    'https://example.test/github.com/example/project/blob/main/README.md',
    'https://github.com:8443/example/project/blob/main/README.md',
  ]) {
    assert.equal(isDownloadReference(url), true, url);
    const inventory = await analyzeAssets(source(`[文件](${url})`));
    assert.equal(inventory.assets.length, 1, url);
    assert.deepEqual(inventory.ordinaryLinkIds, [], url);
  }
});

test('literal code and inactive HTML cannot authorize legacy hyperlink retirement', async () => {
  const text = [`\`[说明](${page})\``, '```markdown', `[说明](${page})`, '```',
    `<pre><a href="${page}">example</a></pre>`, `<script>"[说明](${page})"</script>`].join('\n');
  const inventory = await analyzeAssets(source(text));
  assert.deepEqual(inventory.assets, []);
  assert.deepEqual(inventory.ordinaryLinkIds, []);
});

test('explicit HTML downloads remain attachments even when their URL is a GitHub file-viewer route', async () => {
  const text = `<a href="${page}" download="README.md">保存</a>`;
  assert.equal(isDownloadReference(page, true), true);
  assert.deepEqual(extractRichReferences(text), [{ ref: page, kind: 'attachment', attribute: 'href', syntax: 'html' }]);
  const inventory = await analyzeAssets(source(text));
  assert.equal(inventory.assets.length, 1);
  assert.deepEqual(inventory.ordinaryLinkIds, []);
  assert.match(renderRichText(text, { resolveAsset: () => '../../../assets/synthetic.md' }), /href="\.\.\/\.\.\/\.\.\/assets\/synthetic.md"/);
});

test('a real resource occurrence prevents retiring a shared ordinary hyperlink independently of traversal order', async () => {
  for (const resource of [
    message('image', `![image](${page})`),
    message('html-image', `<img src="${page}">`),
    message('explicit-download', `<a href="${page}" download>保存</a>`),
    { id: 'metadata-url', metadata: { attachments: [{ url: page, name: 'README.md', mime_type: 'text/markdown' }] } },
    { id: 'platform-metadata', metadata: { attachments: [{ id: 'file_synthetic_readme', url: page, name: 'README.md', mime_type: 'text/markdown' }] } },
    { id: 'library-metadata', metadata: { attachments: [{ library_file_id: 'libfile_synthetic_readme', url: page, name: 'README.md' }] } },
  ]) for (const reverse of [false, true]) {
    const ordinary = message('ordinary', `[说明](${page})`);
    const native = { messages: reverse ? [resource, ordinary] : [ordinary, resource] };
    const inventory = await analyzeAssets(native);
    assert.equal(inventory.assets.length, 1, resource.id);
    assert.deepEqual(inventory.ordinaryLinkIds, [], resource.id);
    assert.equal(inventory.assets[0].messageId, resource.id);
    assert.equal(inventory.assets[0].occurrences.length, 1);
  }
});

test('native attachment URLs are not downgraded when there is no ordinary hyperlink', async () => {
  const native = { messages: [{ id: 'native', metadata: { attachments: [
    { id: 'file_synthetic_native', url: page, name: 'README.md' },
  ] } }] };
  const inventory = await analyzeAssets(native);
  assert.equal(inventory.assets[0].sourceType, 'platform');
  assert.equal(inventory.assets[0].fileId, 'file_synthetic_native');
  assert.equal(inventory.assets[0].retrieval.url, page);
  assert.deepEqual(inventory.ordinaryLinkIds, []);
});

test('a preserved ordinary hyperlink cannot donate metadata or local targets to a separate real resource', async () => {
  const native = source(`[说明](${page})\n![image](${page})`);
  const inventory = await analyzeAssets(native);
  assert.equal(inventory.assets.length, 1);
  assert.equal(inventory.assets[0].kind, 'image');
  assert.equal(inventory.assets[0].fileName, undefined);
  const calls = [];
  const rendered = renderRichText(native.messages[0].content.parts[0], {
    resolveAsset: (ref, hint) => { calls.push({ ref, hint }); return '../../../assets/image.png'; },
  });
  assert.deepEqual(calls, [{ ref: page, hint: { kind: 'image' } }]);
  assert.ok(rendered.includes(`[说明](${page})`));
  assert.match(rendered, /!\[image\]\(\.\.\/\.\.\/\.\.\/assets\/image.png\)/);
});

test('archive rendering keeps the original file-viewer link and native JSON even with legacy asset metadata', async () => {
  const native = source(`[说明](${page})`), snapshot = structuredClone(native);
  const archive = await buildArchive({ conversation: native, identity: { accountKey: 'acct-demo', displayName: 'Synthetic' },
    productionPrefix: 'data/web/chatgpt/acct-demo', capturedAt: '2026-10-21T07:00:00Z', assets: [{
      id: await sha256(`external:${page}`), sourceRef: page, sourceType: 'external', kind: 'attachment', status: 'downloaded',
      localPath: `data/web/chatgpt/acct-demo/assets/${'a'.repeat(64)}.md`, fileName: 'README.md',
    }] });
  assert.deepEqual(JSON.parse(archive.files[0].content), snapshot);
  assert.ok(archive.files[1].content.includes(`[说明](${page})`));
  assert.doesNotMatch(archive.files[1].content, /assets\/|待补采/);
});
