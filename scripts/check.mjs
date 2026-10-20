import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(root, 'extension');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['scripting']);
assert.deepEqual(manifest.optional_host_permissions, ['https://chatgpt.com/*', 'https://api.github.com/*']);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.externally_connectable, undefined);
await access(resolve(extension, manifest.background.service_worker));
await access(resolve(extension, manifest.options_ui.page));
async function checkDirectory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) { await checkDirectory(path); continue; }
    if (!/\.m?js$/.test(path)) continue;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/from ['"](\.\.?\/[^'"]+)['"]/g)) await access(resolve(dirname(path), match[1]));
  }
}
await checkDirectory(extension);
await checkDirectory(resolve(root, 'tests'));
const html = await readFile(resolve(extension, 'panel.html'), 'utf8');
const panel = await readFile(resolve(extension, 'panel.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs');
for (const match of panel.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `Missing UI element: ${match[1]}`);
for (const match of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) await access(resolve(extension, match[1]));
console.log('Manifest, JavaScript syntax, module imports and panel references passed.');
