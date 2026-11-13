/** Settlement report documents (spec S6–S13): names, value guard, delivery plan, size fitting, CAS
 *  write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DOCUMENT_BYTES, fitReportDocument, isReportDocumentValue, planReportDelivery, reportDeliveryKey,
  reportDocName, writeReportDocument, type ReportDocumentValue,
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
  assert.equal(isReportDocumentValue(value({ text: null, stopReason: 'the tool call was refused' })), true,
    'a reason-only document is still a report (S8)');
  assert.equal(isReportDocumentValue({ ...value(), taskId: '' }), false);
  assert.equal(isReportDocumentValue({ ...value(), turn: -1 }), false);
  assert.equal(isReportDocumentValue({ ...value(), turn: 1.5 }), false);
  assert.equal(isReportDocumentValue({ ...value(), text: 42 }), false);
  assert.equal(isReportDocumentValue(null), false);
  assert.equal(isReportDocumentValue('REPORT: done'), false);
});

test('planReportDelivery: one notice per settlement; another task is foreign, an earlier turn stale', () => {
  const base = { taskId: 'task-1', address: 'p2', sinceTs: value().at, delivered: new Set<string>() };
  assert.deepEqual(planReportDelivery({ ...base, value: value() }), { kind: 'deliver' });
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), delivered: new Set([reportDeliveryKey('p2', 3)]) }),
    { kind: 'duplicate' },
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), delivered: new Set([reportDeliveryKey('p2', 2)]) }),
    { kind: 'deliver' },
    'a new turn is a new settlement',
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), taskId: 'other-task' }),
    { kind: 'foreign' },
    'a stale document from another generation settles nothing here',
  );
  // A document written before the request boundary answers an earlier turn: it must never be read
  // as the settlement of a request that is still running (the pipe already delivered it).
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), sinceTs: value().at + 1_000 }),
    { kind: 'stale' },
  );
});

test('planReportDelivery: a revived generation is not the predecessor\'s duplicate', () => {
  // Same task, same turn value, different terminal (spec S3): `turn` counts per terminal, so the pair
  // (taskId, turn) alone would refuse a revived worker's own first settlement.
  const delivered = new Set([reportDeliveryKey('p2', 1)]);
  assert.deepEqual(
    planReportDelivery({ value: value({ turn: 1 }), taskId: 'task-1', address: 'p7', sinceTs: 0, delivered }),
    { kind: 'deliver' },
  );
  assert.deepEqual(
    planReportDelivery({ value: value({ turn: 1 }), taskId: 'task-1', address: 'p2', sinceTs: 0, delivered }),
    { kind: 'duplicate' },
  );
});

test('fitReportDocument: a value that fits is untouched, an oversized one is trimmed, not lost', () => {
  const small = value();
  assert.deepEqual(fitReportDocument(small), small, 'no rewrite when it fits');

  const huge = value({ text: 'x'.repeat(MAX_DOCUMENT_BYTES + 5_000) });
  const fitted = fitReportDocument(huge);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), 'utf8') <= MAX_DOCUMENT_BYTES, 'the value fits the core limit');
  assert.ok((fitted.text ?? '').startsWith('xxx'), 'the report keeps its beginning');
  assert.match(fitted.text ?? '', /\[report truncated: \d+ characters over the core's document limit\]/);
  assert.equal(fitted.turn, huge.turn);
  assert.equal(fitted.taskId, huge.taskId);
  assert.equal(fitted.stopReason, huge.stopReason, 'only the text is trimmed');
});

test('writeReportDocument: the first write lands at version 0', async () => {
  const client = fakeCore();
  const written = await writeReportDocument(client, 't9', value());
  assert.deepEqual(written, { ok: true, version: 1 });
  assert.deepEqual((await client.docGet('piher.rep.t9'))?.value, value());
});

test('writeReportDocument: an oversized report still lands, with its text trimmed', async () => {
  const client = fakeCore();
  const written = await writeReportDocument(client, 't9', value({ text: 'y'.repeat(MAX_DOCUMENT_BYTES + 1_024) }));
  assert.equal(written.ok, true);
  const stored = (await client.docGet('piher.rep.t9'))?.value as ReportDocumentValue;
  assert.ok(Buffer.byteLength(JSON.stringify(stored), 'utf8') <= MAX_DOCUMENT_BYTES);
  assert.match(stored.text ?? '', /report truncated/);
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
  assert.deepEqual(written, { ok: true, version: 1 });
  assert.equal(sets, 2, 'one conflict, one retry');
  assert.equal(((await base.docGet('piher.rep.t9'))?.value as ReportDocumentValue).turn, 4);
});

test('writeReportDocument: repeated conflicts and a broken store fail with a reason, never silently', async () => {
  const conflicted: CoreClientLike = {
    ...fakeCore(),
    docSet: async () => { throw new CoreError('doc.set', 'conflict', 'stale', 'retry'); },
  };
  const fought = await writeReportDocument(conflicted, 't9', value());
  assert.equal(fought.ok, false);
  assert.match(fought.ok === false ? fought.reason : '', /conflicted twice at version 0/, 'the reason names the failure');

  // A transport failure gets one retry: the document is the authoritative channel.
  let gets = 0;
  const flaky: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => {
      gets += 1;
      if (gets === 1) throw new Error('connect ENOENT /tmp/hc.sock');
      return { value: null, version: 0 };
    },
  };
  assert.deepEqual(await writeReportDocument(flaky, 't9', value()), { ok: true, version: 1 });
  assert.equal(gets, 2, 'the transport failure is retried');

  const down: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => { throw new Error('connect ECONNREFUSED'); },
  };
  const failed = await writeReportDocument(down, 't9', value());
  assert.equal(failed.ok, false);
  assert.match(failed.ok === false ? failed.reason : '', /doc\.get failed: connect ECONNREFUSED/);

  assert.equal((await writeReportDocument({ ...fakeCore(), available: false }, 't9', value())).ok, false,
    'outside a core terminal there is nowhere to write');
  assert.equal((await writeReportDocument(fakeCore(), 'T9', value())).ok, false, 'no document name, no write');
});

test('planReportDelivery: a document no newer than the delivered settlement is a duplicate', () => {
  const base = { taskId: 'task-1', address: 'p2', sinceTs: 0, delivered: new Set<string>() };
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), deliveredAt: value().at }),
    { kind: 'duplicate' },
    'the pipe already delivered this one (S7)',
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), deliveredAt: value().at - 1 }),
    { kind: 'deliver' },
    'a newer document is a new settlement',
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), deliveredAt: null }),
    { kind: 'deliver' },
    'nothing delivered yet',
  );
});
