import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticReport } from '../extension/lib/diagnostics.js';

test('export rebuilds allowlisted metadata and correlated aliases without private state', () => {
  const privateText = 'PRIVATE_SECRET';
  const item = { operationId: privateText + 'operation', taskId: privateText + 'task', conversationId: privateText + 'chat',
    assetId: privateText + 'asset', title: privateText, fileName: privateText + '.png', token: privateText, url: 'https://secret.test/?sig=' + privateText,
    status: 'failed', stage: 'detail', code: 'INCOMPLETE_DETAIL', reason: 'PAGE_VERSION_CHANGED', startedAt: 1, finishedAt: 2, occurrences: 3 };
  const snapshot = { platform: 'doubao', accountKey: privateText, accounts: [{ label: privateText }], config: { token: privateText },
    job: { id: item.taskId, status: 'partial', mode: 'initial', title: privateText, discovered: 1, statistics: { listReads: 1, detailReads: 2, detailConversations: 1, privateText } },
    channels: { collection: { current: item, history: [item] }, download: { history: [{ ...item, stage: 'download', code: 'HTTP_403' }] } } };
  const report = createDiagnosticReport(snapshot, { version: '0.4.9', now: 10 });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SECRET|secret\.test|\.png|sig=|"token"|"title"|"fileName"|"accountKey"/);
  assert.equal(report.records.length, 2);
  assert.equal(report.records[0].conversation, report.records[1].conversation);
  assert.equal(report.records[0].task, report.collection.task);
  assert.equal(report.records[0].reason, 'PAGE_VERSION_CHANGED');
  assert.equal(report.records[1].code, 'HTTP_403');
});

test('unknown codes stages statuses versions and reasons cannot smuggle free text into export', () => {
  const report = createDiagnosticReport({ platform: 'PRIVATE', channels: { collection: { history: [{
    stage: 'PRIVATE', status: 'PRIVATE', code: 'PRIVATE_TOKEN_VALUE', reason: 'PRIVATE', size: 'PRIVATE',
    startedAt: NaN, finishedAt: Infinity, response: 'PRIVATE' }] } }, job: { id: 'PRIVATE', status: 'PRIVATE', mode: 'PRIVATE' } }, { version: 'PRIVATE' });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.equal(report.records[0].code, 'OTHER_ERROR'); assert.equal(report.collection.statistics, null);
});
