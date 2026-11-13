/** Settlement report documents (spec S6–S11): names, value guard, delivery plan, CAS write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReportDocumentValue, planReportDelivery, reportDeliveryKey, reportDocName, writeReportDocument,
  type ReportDocumentValue,
} from '../src/report-documents.ts';
import { CoreError, type CoreClientLike } from '../src/core-client.ts';
import { fakeCore } from './test-utils.ts';

const value = (over: Partial<ReportDocumentValue> = {}): ReportDocumentValue => ({
  taskId: 'task-1', turn: 3, stopReason: 'stop', session: '/w/s.jsonl', text: 'REPORT: done', at: 1_700_000_000_000,
  ...over,
});

test('reportDocName: a worker address names its report document, junk does not', () => {
  assert.equal(reportDocName('t1'), 'piher.rep.t1');
  assert.equal(reportDocName('p2'), 'piher.rep.p2');
  assert.equal(reportDocName('T1'), null, 'uppercase breaks the terminal-name rules (S9)');
  assert.equal(reportDocName('t 1'), null, 'spaces break the terminal-name rules');
  assert.equal(reportDocName('t'.repeat(23)), null, 'the whole name stays within 32 characters');
});

test('isReportDocumentValue: only a full report value qualifies', () => {
  assert.equal(isReportDocumentValue(value()), true);
  assert.equal(isReportDocumentValue(value({ text: null })), true, 'a reason-only document is still a report (S8)');
  assert.equal(isReportDocumentValue({ ...value(), taskId: '' }), false);
  assert.equal(isReportDocumentValue({ ...value(), turn: -1 }), false);
  assert.equal(isReportDocumentValue({ ...value(), turn: 1.5 }), false);
  assert.equal(isReportDocumentValue({ ...value(), text: 42 }), false);
  assert.equal(isReportDocumentValue(null), false);
  assert.equal(isReportDocumentValue('REPORT: done'), false);
});

test('planReportDelivery: one notice per (taskId, turn); other tasks are ignored', () => {
  assert.deepEqual(
    planReportDelivery({ value: value(), taskId: 'task-1', delivered: new Set() }),
    { kind: 'deliver' },
  );
  assert.deepEqual(
    planReportDelivery({ value: value(), taskId: 'task-1', delivered: new Set([reportDeliveryKey('task-1', 3)]) }),
    { kind: 'duplicate' },
  );
  assert.deepEqual(
    planReportDelivery({ value: value(), taskId: 'task-1', delivered: new Set([reportDeliveryKey('task-1', 2)]) }),
    { kind: 'deliver' },
    'a new turn is a new settlement',
  );
  assert.deepEqual(
    planReportDelivery({ value: value(), taskId: 'other-task', delivered: new Set() }),
    { kind: 'ignore' },
    'a stale document from another generation settles nothing here',
  );
});

test('writeReportDocument: the first write lands at version 0', async () => {
  const client = fakeCore();
  const written = await writeReportDocument(client, 't9', value());
  assert.deepEqual(written, { version: 1 });
  assert.deepEqual((await client.docGet('piher.rep.t9'))?.value, value());
});

test('writeReportDocument: a conflict is answered by doc.get and a retry, never an overwrite', async () => {
  const base = fakeCore();
  let sets = 0;
  const client: CoreClientLike = {
    ...base,
    docSet: async (name, v, version) => {
      sets += 1;
      if (sets === 1) throw new CoreError('doc.set', 'conflict', 'stale', 'read doc.get and retry with its version');
      return base.docSet(name, v, version);
    },
  };
  const written = await writeReportDocument(client, 't9', value({ turn: 4 }));
  assert.deepEqual(written, { version: 1 });
  assert.equal(sets, 2, 'one conflict, one retry');
  assert.equal(((await base.docGet('piher.rep.t9'))?.value as ReportDocumentValue).turn, 4);
});

test('writeReportDocument: a repeated conflict and a missing core write nothing and throw nothing', async () => {
  const conflicted: CoreClientLike = {
    ...fakeCore(),
    docSet: async () => { throw new CoreError('doc.set', 'conflict', 'stale', 'retry'); },
  };
  assert.equal(await writeReportDocument(conflicted, 't9', value()), null);
  assert.equal(
    await writeReportDocument({ ...fakeCore(), available: false }, 't9', value()),
    null,
    'outside a core terminal there is nowhere to write',
  );
  assert.equal(await writeReportDocument(fakeCore(), 'T9', value()), null, 'no document name, no write');
});
