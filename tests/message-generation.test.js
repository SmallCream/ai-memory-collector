import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inspectMessageGeneration } from '../extension/lib/message-generation.js';

const unfinishedStatuses = ['pending', 'in_progress', 'streaming'];
const message = (status, extra = {}) => ({ author: { role: 'assistant' }, status, content: { parts: ['original'] }, ...extra });
const ending = extra => message('finished_successfully', { end_turn: true, ...extra });
const node = (parent, value = null) => ({ parent, message: value, children: [] });
function tree(mapping, current = 'end') {
  const native = { mapping, current_node: current };
  for (const [id, value] of Object.entries(mapping)) {
    if (value?.parent != null && mapping[value.parent]) mapping[value.parent].children.push(id);
  }
  return native;
}
const counts = (unfinishedCount, historicalUnfinishedCount = 0) => ({
  unfinishedCount, historicalUnfinishedCount, unresolvedUnfinishedCount: unfinishedCount - historicalUnfinishedCount,
});

test('a later explicit ending closes each unfinished status on the selected parent chain without mutation', () => {
  for (const status of unfinishedStatuses) {
    const native = tree({ root: node(null), old: node('root', message(status)), end: node('old', ending()) });
    const before = structuredClone(native);
    assert.deepEqual(inspectMessageGeneration(native), counts(1, 1));
    assert.deepEqual(native, before);
    assert.equal(native.mapping.old.message.status, status);
  }
});

test('timestamps neither expire active statuses nor prevent structural closure', () => {
  const native = tree({ root: node(null), old: node('root', message('pending', { create_time: 9999999999 })),
    end: node('old', ending({ create_time: 1 })) });
  assert.deepEqual(inspectMessageGeneration(native), counts(1, 1));
  native.current_node = 'old';
  native.mapping.old.message.create_time = 1;
  assert.deepEqual(inspectMessageGeneration(native), counts(1));
});

test('the selected tip remains unresolved even when it has a completed descendant or sibling', () => {
  const native = tree({ root: node(null), active: node('root', message('streaming')),
    descendant: node('active', ending()), sibling: node('root', ending()) }, 'active');
  assert.deepEqual(inspectMessageGeneration(native), counts(1));
});

test('a completed sibling branch cannot close an unfinished selected ancestor', () => {
  const native = tree({ root: node(null), old: node('root', message('pending')),
    current: node('old', message('finished_successfully', { author: { role: 'user' } })),
    otherEnd: node('old', ending()) }, 'current');
  assert.deepEqual(inspectMessageGeneration(native), counts(1));
});

test('off-current unfinished branches need their own completed descendant', () => {
  const native = tree({ root: node(null), end: node('root', ending()),
    abandoned: node('root', message('pending')), closed: node('root', message('in_progress')),
    closedEnd: node('closed', ending()) });
  assert.deepEqual(inspectMessageGeneration(native), counts(2, 1));
});

test('every unfinished node needs evidence even when an earlier one is historical', () => {
  const native = tree({ root: node(null), old: node('root', message('pending')), closed: node('old', ending()),
    end: node('closed', message('in_progress')) });
  assert.deepEqual(inspectMessageGeneration(native), counts(2, 1));
});

test('only assistant final endings with an allowed recipient provide closure', () => {
  const invalidEndings = [
    { author: { role: 'user' } }, { author: { role: 'tool' } }, { author: null },
    { status: 'finished' }, { status: 'finished_successfully', end_turn: false }, { end_turn: undefined },
    { end_turn: 1 }, { recipient: 'python' }, { recipient: 'browser' }, { channel: 'analysis' },
    { channel: 'commentary' },
  ];
  for (const extra of invalidEndings) {
    const native = tree({ old: node(null, message('pending')), end: node('old', ending(extra)) });
    assert.deepEqual(inspectMessageGeneration(native), counts(1), JSON.stringify(extra));
  }
  for (const recipient of [undefined, null, '', 'all']) {
    for (const channel of [undefined, null, '', 'final']) {
      const native = tree({ old: node(null, message('pending')), end: node('old', ending({ recipient, channel })) });
      assert.deepEqual(inspectMessageGeneration(native), counts(1, 1));
    }
  }
});

test('flat messages and individual pages never receive historical exemptions', () => {
  for (const wrapper of [value => value, value => ({ message: value })]) {
    const messages = [...unfinishedStatuses.map(status => wrapper(message(status))), wrapper(ending())];
    for (const extra of [{}, { mapping: {} }, { page_info: { has_previous_page: false, has_next_page: false } }]) {
      assert.deepEqual(inspectMessageGeneration({ messages, ...extra }), counts(3));
    }
  }
});

test('caller-supplied generation summaries cannot turn unresolved source messages into historical ones', () => {
  const native = tree({ old: node(null, message('pending')), end: node('old', message('finished_successfully')) });
  native.generationState = counts(1, 1);
  native.sourceCompleteness = 'complete';
  assert.deepEqual(inspectMessageGeneration(native), counts(1));
});

test('unknown selected ancestry fails closed and malformed graphs cannot cause infinite traversal', () => {
  const examples = [
    tree({ old: node(null, message('pending')), end: node('old', ending()) }, 'missing'),
    tree({ old: node('end', message('pending')), end: node('old', ending()) }),
    tree({ old: node('missing', message('pending')), end: node('old', ending()) }),
    tree({ old: null, end: node('old', message('pending')) }),
  ];
  for (const native of examples) assert.deepEqual(inspectMessageGeneration(native), counts(1));
  assert.deepEqual(inspectMessageGeneration(null), counts(0));
  assert.deepEqual(inspectMessageGeneration({ messages: [null, {}, { message: null }] }), counts(0));
});

test('source node IDs use own entries without inherited property collisions', () => {
  const mapping = Object.fromEntries([
    ['__proto__', node(null, message('pending'))], ['constructor', node('__proto__', ending())],
  ]);
  assert.deepEqual(inspectMessageGeneration(tree(mapping, 'constructor')), counts(1, 1));
});

test('the helper can run from its source in an isolated context without module closures', () => {
  const isolated = vm.runInNewContext(`(${inspectMessageGeneration.toString()})`);
  const native = tree({ old: node(null, message('pending')), end: node('old', ending()) });
  assert.deepEqual(JSON.parse(JSON.stringify(isolated(native))), counts(1, 1));
});

test('many endings on a deep chain traverse parent links only a linear number of times', () => {
  const mapping = {}, length = 12000;
  let parentReads = 0;
  for (let index = 0; index < length; index++) {
    mapping[`m${index}`] = { message: index % 2 ? ending() : message('pending'),
      get parent() { parentReads++; return index ? `m${index - 1}` : null; } };
  }
  const native = { mapping, current_node: `m${length - 1}` };
  assert.deepEqual(inspectMessageGeneration(native), counts(length / 2, length / 2));
  assert.ok(parentReads <= length * 4, `parent reads should be linear, got ${parentReads}`);
});
