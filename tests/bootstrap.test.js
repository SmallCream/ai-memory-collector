import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/bootstrap.js', import.meta.url), 'utf8');
function setup() {
  const global = { textContent: '', classList: { add() {} } };
  const local = { textContent: '', classList: { add() {} } };
  const button = { disabled: false };
  let timer;
  const context = vm.createContext({
    document: { getElementById: () => global, querySelectorAll: selector => selector === '[data-action-status]' ? [local] : [button] },
    window: { addEventListener() {} },
    setTimeout(callback) { timer = callback; return 1; }, clearTimeout() {},
  });
  // No dynamic import loader is available: represents a failed local module load.
  vm.runInContext(source, context);
  return { global, local, button, timeout: () => timer() };
}
test('failed module import produces visible local error and disabled controls', async () => {
  const state = setup();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(state.local.textContent, /STARTUP_FAILED/);
  assert.equal(state.local.textContent, state.global.textContent);
  assert.equal(state.button.disabled, true);
});
test('startup delay reports a local timeout instead of leaving inert-looking buttons', () => {
  const state = setup();
  state.timeout();
  assert.match(state.local.textContent, /STARTUP_TIMEOUT/);
  assert.equal(state.button.disabled, true);
});
