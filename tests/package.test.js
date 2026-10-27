import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'collector-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'extension'));
  copyFileSync(new URL('../scripts/package.py', import.meta.url), join(root, 'scripts/package.py'));
  writeFileSync(join(root, 'extension/manifest.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, 'extension/panel.js'), 'console.log("fixture");\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  const run = (...args) => spawnSync('python3', ['scripts/package.py', ...args], { cwd: root, encoding: 'utf8' });
  const archive = join(root, 'dist/ai-memory-collector-1.2.3.zip');
  return { root, run, git, archive };
}

test('package bytes ignore mtimes and provenance matches checksum and clean source commit', t => {
  const f = fixture(t);
  assert.equal(f.run('--channel', 'test').status, 0);
  const first = readFileSync(f.archive);
  utimesSync(join(f.root, 'extension/panel.js'), new Date(), new Date('2020-01-01'));
  assert.equal(f.run('--channel', 'test').status, 0);
  assert.deepEqual(readFileSync(f.archive), first);
  const metadata = JSON.parse(readFileSync(f.archive.replace('.zip', '.json'), 'utf8'));
  assert.equal(metadata.channel, 'test'); assert.equal(metadata.sourceDirty, false);
  assert.equal(metadata.sourceCommit, f.git('rev-parse', 'HEAD'));
  assert.equal(metadata.fileCount, 2); assert.equal(metadata.bytes, first.length);
  assert.equal(metadata.sha256, createHash('sha256').update(first).digest('hex'));
  assert.equal(readFileSync(f.archive.replace('.zip', '.sha256'), 'utf8'), `${metadata.sha256}  ai-memory-collector-1.2.3.zip\n`);
});

test('stable package requires clean tagged source and refuses a development label', t => {
  const f = fixture(t);
  assert.notEqual(f.run('--channel', 'stable').status, 0);
  f.git('tag', 'v1.2.3'); assert.equal(f.run('--channel', 'stable').status, 0);
  writeFileSync(join(f.root, 'extension/panel.js'), 'changed');
  assert.notEqual(f.run('--channel', 'stable').status, 0);
  f.git('checkout', '--', 'extension/panel.js');
  writeFileSync(join(f.root, 'extension/manifest.json'), JSON.stringify({ version: '1.2.3', version_name: '1.2.3 development' }));
  f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Development');
  f.git('tag', '-f', 'v1.2.3');
  const result = f.run('--channel', 'stable'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /development-labelled/);
});

test('packaging refuses symlinks and unexpected files instead of including user data', t => {
  const f = fixture(t);
  symlinkSync(join(f.root, '.gitignore'), join(f.root, 'extension/private.js'));
  assert.notEqual(f.run().status, 0);
  rmSync(join(f.root, 'extension/private.js'));
  writeFileSync(join(f.root, 'extension/private.txt'), 'fixture');
  assert.notEqual(f.run().status, 0);
});
