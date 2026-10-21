import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(root, 'extension');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version, 'Package and extension versions differ');
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'scripting', 'sidePanel']);
assert.deepEqual(manifest.optional_host_permissions, ['https://chatgpt.com/*', 'https://api.github.com/*']);
assert.equal(manifest.host_permissions, undefined, 'Site access must remain optional');
assert.equal(manifest.content_scripts, undefined, 'Content entry is registered only after site authorization');
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.background.type, 'module');
assert.equal(manifest.side_panel.default_path, 'panel.html');
assert.ok(Number(manifest.minimum_chrome_version) >= 120);
assert.match(manifest.content_security_policy.extension_pages, /script-src 'self';/);
assert.ok(!/unsafe-eval|unsafe-inline/.test(manifest.content_security_policy.extension_pages));
for (const path of [manifest.background.service_worker, manifest.side_panel.default_path,
  manifest.options_ui.page, 'content.js', 'adapters/index.js']) await access(resolve(extension, path));
async function checkDirectory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) { await checkDirectory(path); continue; }
    if (!/\.m?js$/.test(path)) continue;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\()['"](\.\.?\/[^'"]+)['"]/g)) await access(resolve(dirname(path), match[1]));
  }
}
await checkDirectory(extension);
await checkDirectory(resolve(root, 'tests'));
const html = await readFile(resolve(extension, 'panel.html'), 'utf8');
const panel = await readFile(resolve(extension, 'panel.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs');
for (const match of panel.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `Missing UI element: ${match[1]}`);
for (const match of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
  assert.ok(!/^(?:https?:)?\/\//.test(match[1]), 'Extension UI must use packaged assets');
  await access(resolve(extension, match[1]));
}
assert.ok(!/\son[a-z]+\s*=/i.test(html), 'Use packaged event handlers, not inline JavaScript');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  assert.match(match[1], /\bsrc=/);
  assert.equal(match[2].trim(), '');
}
console.log('Manifest, versions, permissions, JavaScript syntax, module imports and panel references passed.');
