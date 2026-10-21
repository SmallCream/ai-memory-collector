import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigStore, publicConfig, cleanAlias } from '../extension/lib/config.js';

function fixture(entries) {
  const store = new Map(entries);
  return createConfigStore({ getSetting: async key => structuredClone(store.get(key)),
    setSetting: async (key, value) => store.set(key, structuredClone(value)) });
}
test('P0 settings migrate without enabling upload, inventing bindings or exposing the remembered token', async () => {
  const store = fixture([['formPreferences', { repository: 'owner/data', branch: 'main', token: 'github_pat_secret', rememberToken: true }]]);
  const config = await store.read();
  assert.equal(config.github.repository, 'owner/data'); assert.equal(config.github.token, 'github_pat_secret');
  assert.equal(config.github.enabled, false); assert.equal(config.setupComplete, false); assert.deepEqual(config.accounts, {});
  assert.equal(JSON.stringify(publicConfig(config)).includes('github_pat_secret'), false);
});
test('legacy fallback keeps repository information while an unremembered token is discarded', async () => {
  const config = await fixture([['githubTarget', { repository: 'owner/old', branch: 'archive', token: 'secret' }]]).read();
  assert.equal(config.github.repository, 'owner/old'); assert.equal(config.github.branch, 'archive'); assert.equal(config.github.token, '');
});
test('concurrent config updates compose and aliases remove controls', async () => {
  const store = fixture([]);
  await Promise.all([store.change(config => ({ ...config, autoEnabled: false })), store.change(config => ({ ...config, intervalMinutes: 60 }))]);
  const config = await store.read(); assert.equal(config.autoEnabled, false); assert.equal(config.intervalMinutes, 60);
  assert.equal(cleanAlias('  small\u202ecream\u0000  '), 'smallcream');
});
test('v0.2 config retains account bindings and token while adding the LFS default', async () => {
  const previous = { schemaVersion: 2, setupComplete: true, autoEnabled: false, intervalMinutes: 60,
    accounts: { stable: { enabled: true, alias: 'Existing' } },
    github: { enabled: true, repository: 'owner/data', branch: 'main', token: 'saved-secret' } };
  const store = fixture([['collectorConfigV2', previous]]);
  const config = await store.read();
  assert.deepEqual(config.accounts, previous.accounts);
  assert.equal(config.github.token, 'saved-secret'); assert.equal(config.github.lfsEnabled, true);
  assert.equal(config.autoEnabled, false); assert.equal(config.setupComplete, true);
  assert.equal(publicConfig(config).github.lfsEnabled, true);
  assert.equal(JSON.stringify(publicConfig(config)).includes('saved-secret'), false);
  await store.change(current => { current.github.lfsEnabled = false; return current; });
  assert.equal((await store.read()).github.lfsEnabled, false);
});
