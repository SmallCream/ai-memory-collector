import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repository = resolve(import.meta.dirname, '..');
const updater = join(repository, 'update-macos.command');
const sha = 'a'.repeat(40);

function fixture(t, { installed = '0.1.3', remote = '0.1.4', remoteKey, installedKey } = {}) {
  // macOS may spell its temporary directory through /var -> /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'collector-updater-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), state = join(root, 'updater state');
  const parent = join(root, '原安装路径 with spaces'), target = join(parent, 'extension');
  const sourceParent = join(root, 'archive'), source = join(sourceParent, `ai-memory-collector-${sha}`, 'extension');
  mkdirSync(bin); mkdirSync(parent); mkdirSync(sourceParent);
  cpSync(join(repository, 'extension'), target, { recursive: true });
  cpSync(join(repository, 'extension'), source, { recursive: true });
  function manifest(folder, version, key) {
    const value = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    value.version = version;
    if (key !== undefined) value.key = key;
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(value));
  }
  manifest(target, installed, installedKey); manifest(source, remote, remoteKey);
  const zip = join(root, 'source.zip');
  function pack() {
    rmSync(zip, { force: true });
    const result = spawnSync('zip', ['-qry', zip, `ai-memory-collector-${sha}`], { cwd: sourceParent, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  pack();
  const log = join(root, 'calls.log');
  function native(name, body) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  }
  native('uname', `process.stdout.write('Darwin\\n');`);
  native('osascript', `
    const vm = require('node:vm');
    const args = process.argv.slice(2), i = args.indexOf('-e');
    if (i < 0) throw Error('Expected an inline script');
    const script = args[i + 1];
    if (script.includes('choose folder')) process.stdout.write(process.env.AMC_TEST_TARGET + '\\n');
    else {
      try { process.stdout.write(String(vm.runInNewContext(script + '; run(args)', { args: args.slice(i + 2) })) + '\\n'); }
      catch (e) { process.stderr.write(e.message + '\\n'); process.exit(1); }
    }
  `);
  native('ditto', `require('node:fs').cpSync(process.argv[2], process.argv[3], { recursive: true });`);
  native('curl', `
    const fs = require('node:fs'), args = process.argv.slice(2);
    fs.appendFileSync(process.env.AMC_TEST_LOG, args[args.length - 1] + '\\n');
    if (process.env.AMC_TEST_NETWORK_FAIL) process.exit(22);
    const destination = args[args.indexOf('--output') + 1], url = args[args.length - 1];
    if (url === 'https://api.github.com/repos/SmallCream/ai-memory-collector/git/ref/heads/main') fs.writeFileSync(destination, JSON.stringify({object: {sha: '${sha}'}}));
    else if (url === 'https://codeload.github.com/SmallCream/ai-memory-collector/zip/${sha}') fs.copyFileSync(process.env.AMC_TEST_ZIP, destination);
    else throw Error('Unexpected network endpoint: ' + url);
  `);
  native('mv', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (process.env.AMC_TEST_FAIL_REPLACE && args[0].includes('/.ai-memory-collector-stage.') && args[1] === process.env.AMC_TEST_TARGET) process.exit(1);
    const result = require('node:child_process').spawnSync('/bin/mv', args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `);
  function run(args = [], extra = {}) {
    return spawnSync('bash', [updater, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AMC_UPDATER_STATE_DIR: state, AMC_TEST_TARGET: target, AMC_TEST_ZIP: zip, AMC_TEST_LOG: log, ...extra },
      encoding: 'utf8', timeout: 15000,
    });
  }
  function version(folder = target) { return JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version; }
  function backups() { return readdirSync(parent).filter(x => x.startsWith('.ai-memory-collector-backup.')).map(x => join(parent, x)); }
  function targetState() { return join(state, createHash('sha256').update(target).digest('hex')); }
  return { root, target, source, parent, state, log, pack, run, version, backups, targetState };
}

test('macOS updater replaces the same folder, preserves adjacent data and retains old code', t => {
  const f = fixture(t);
  writeFileSync(join(f.parent, 'personal-conversation.json'), 'private local fixture');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.version(), '0.1.4');
  assert.equal(f.backups().length, 1);
  assert.equal(f.version(f.backups()[0]), '0.1.3');
  assert.equal(readFileSync(join(f.parent, 'personal-conversation.json'), 'utf8'), 'private local fixture');
  assert.equal(readFileSync(join(f.state, 'target-path'), 'utf8').trim(), f.target);
  assert.match(result.stdout, /重新加载/);
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 2);
});

test('remembered folder is reused; identical code and Finder metadata need no update', t => {
  const f = fixture(t, { installed: '0.1.4' });
  writeFileSync(join(f.target, '.DS_Store'), 'finder fixture');
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /无需更新/);
  assert.equal(f.backups().length, 0);
  result = f.run([], { AMC_TEST_TARGET: '/not/a/real/directory' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /无需更新/);
  assert.equal(readFileSync(join(f.target, '.DS_Store'), 'utf8'), 'finder fixture');
});

test('legacy P0 installation upgrades to the renamed v0.2 product in the same directory', t => {
  const f = fixture(t, { installed: '0.1.5', remote: '0.2.0' });
  const manifest = JSON.parse(readFileSync(join(f.target, 'manifest.json'), 'utf8'));
  manifest.name = 'AI Memory Collector · P0';
  writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(manifest));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.version(), '0.2.0');
  assert.equal(JSON.parse(readFileSync(join(f.target, 'manifest.json'), 'utf8')).name, 'AI Memory Collector');
  assert.equal(f.backups().length, 1);
  assert.equal(f.version(f.backups()[0]), '0.1.5');
  assert.equal(readFileSync(join(f.state, 'target-path'), 'utf8').trim(), f.target);
});

test('network failure does not modify the installed extension', t => {
  const f = fixture(t);
  const result = f.run([], { AMC_TEST_NETWORK_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.version(), '0.1.3');
  assert.equal(f.backups().length, 0);
  assert.match(result.stderr, /原插件未修改/);
});

test('an older installation can gain a bootstrap file introduced by a later version', t => {
  const f = fixture(t, { installed: '0.1.0' });
  rmSync(join(f.target, 'bootstrap.js'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.version(), '0.1.4');
  assert.ok(existsSync(join(f.target, 'bootstrap.js')));
});

test('invalid source manifest and changed extension identity are refused', async t => {
  await t.test('wrong product', t => {
    const f = fixture(t);
    const manifest = JSON.parse(readFileSync(join(f.source, 'manifest.json')));
    manifest.name = 'Different product';
    writeFileSync(join(f.source, 'manifest.json'), JSON.stringify(manifest)); f.pack();
    assert.notEqual(f.run().status, 0);
    assert.equal(f.version(), '0.1.3'); assert.equal(f.backups().length, 0);
  });
  await t.test('changed key', t => {
    const f = fixture(t, { remoteKey: 'YWJj' });
    const result = f.run();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /身份 key/);
    assert.equal(f.version(), '0.1.3'); assert.equal(f.backups().length, 0);
  });
});

test('personal JSON inside the extension and archive directories are never moved', async t => {
  await t.test('unknown JSON', t => {
    const f = fixture(t);
    writeFileSync(join(f.target, 'personal-conversation.json'), 'private fixture');
    const result = f.run();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /保护个人数据/);
    assert.equal(readFileSync(join(f.target, 'personal-conversation.json'), 'utf8'), 'private fixture');
    assert.equal(f.version(), '0.1.3'); assert.equal(f.backups().length, 0);
  });
  await t.test('archive directory', t => {
    const f = fixture(t);
    mkdirSync(join(f.target, 'p0-captures'));
    const result = f.run();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /独立目录/);
    assert.ok(existsSync(join(f.target, 'p0-captures'))); assert.ok(!existsSync(f.log));
  });
});

test('a failed directory swap restores the original installed code', t => {
  const f = fixture(t);
  const result = f.run([], { AMC_TEST_FAIL_REPLACE: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.version(), '0.1.3');
  assert.match(result.stderr, /已恢复原插件目录/);
  const retry = f.run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.version(), '0.1.4');
});

test('rollback restores previous code locally and saves the replaced version', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const result = f.run(['--rollback'], { AMC_TEST_NETWORK_FAIL: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.version(), '0.1.3');
  assert.equal(f.backups().length, 2);
  assert.deepEqual(f.backups().map(x => f.version(x)).sort(), ['0.1.3', '0.1.4']);
});

test('an interrupted swap with a missing target recovers before retrying a download', t => {
  const f = fixture(t);
  assert.equal(f.run([], { AMC_TEST_NETWORK_FAIL: '1' }).status, 1);
  const backup = join(f.parent, '.ai-memory-collector-backup.interrupted');
  assert.equal(spawnSync('/bin/mv', [f.target, backup]).status, 0);
  writeFileSync(join(f.targetState(), 'last-backup.next'), backup + '\n');
  const result = f.run([], { AMC_TEST_NETWORK_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /已恢复上次中断/);
  assert.equal(f.version(), '0.1.3');
});

test('symbolic links in the source ZIP are refused before extraction', t => {
  const f = fixture(t);
  symlinkSync('/tmp', join(f.source, 'unsafe')); f.pack();
  const result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /压缩包包含符号链接/);
  assert.equal(f.version(), '0.1.3'); assert.equal(f.backups().length, 0);
});

test('removing the retired LFS module preserves it in the rollback backup', t => {
  const f = fixture(t, { installed: '0.3.23', remote: '0.3.24' });
  writeFileSync(join(f.target, 'lib/lfs.js'), '// old LFS implementation');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.version(), '0.3.24');
  assert.equal(existsSync(join(f.target, 'lib/lfs.js')), false);
  assert.equal(readFileSync(join(f.backups()[0], 'lib/lfs.js'), 'utf8'), '// old LFS implementation');
  const rollback = f.run(['--rollback']);
  assert.equal(rollback.status, 0, rollback.stderr + rollback.stdout);
  assert.equal(f.version(), '0.3.23');
  assert.equal(readFileSync(join(f.target, 'lib/lfs.js'), 'utf8'), '// old LFS implementation');
});
