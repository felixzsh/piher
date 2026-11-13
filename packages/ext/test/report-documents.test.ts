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
  const base = { taskId: 'task-1', address: 'p2', sinceTs: value().at, deliveredKeys: new Set<string>() };
  assert.deepEqual(planReportDelivery({ ...base, value: value() }), { kind: 'deliver' });
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), deliveredKeys: new Set([reportDeliveryKey('p2', value().at)]) }),
    { kind: 'duplicate' },
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: value(), deliveredKeys: new Set([reportDeliveryKey('p2', value().at - 1)]) }),
    { kind: 'deliver' },
    'a new settle is a new settlement',
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
  // Same task, same turn value, different terminal (spec S3): `turn` counts per terminal, so a key
  // built on it would refuse a revived worker's own first settlement.
  const deliveredKeys = new Set([reportDeliveryKey('p2', value().at)]);
  assert.deepEqual(
    planReportDelivery({ value: value({ turn: 1 }), taskId: 'task-1', address: 'p7', sinceTs: 0, deliveredKeys }),
    { kind: 'deliver' },
  );
  assert.deepEqual(
    planReportDelivery({ value: value({ turn: 1 }), taskId: 'task-1', address: 'p2', sinceTs: 0, deliveredKeys }),
    { kind: 'duplicate' },
  );
});

test('planReportDelivery: the pipe\'s document is suppressed even when its `at` is newer than the read that recorded it', () => {
  // The harmful ordering finding 1 named: the reply is written before the document, so the document's
  // `at` can land AFTER the master stamped the row. The identity the pipe reports is the document's
  // own `at`, so the comparison is exact — a later read cannot slip past it.
  const base = { taskId: 'task-1', address: 'p2', sinceTs: 0, deliveredKeys: new Set<string>() };
  const doc = value({ at: 1_700_000_009_999 });
  assert.deepEqual(
    planReportDelivery({ ...base, value: doc, delivered: { address: 'p2', at: doc.at } }),
    { kind: 'duplicate' },
    'the document the pipe delivered is never announced again',
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: doc, delivered: { address: 'p2', at: doc.at - 5_000 } }),
    { kind: 'deliver' },
    'a document from an earlier settle is still not suppressed by a newer watermark',
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: doc, delivered: { address: 'p9', at: doc.at + 60_000 } }),
    { kind: 'deliver' },
    'a watermark for another address (another generation) suppresses nothing',
  );
  assert.deepEqual(
    planReportDelivery({ ...base, value: doc, delivered: null }),
    { kind: 'deliver' },
    'nothing delivered yet',
  );
});

test('planReportDelivery: a stale turn read cannot swallow a settlement', () => {
  // If the core had not published the turn change when the worker read it, two genuinely different
  // settles can carry the same `turn`. They are different documents, so both are delivered: the
  // settlement identity is the document, never the core's counter.
  const deliveredKeys = new Set([reportDeliveryKey('p2', 1_700_000_000_000)]);
  assert.deepEqual(
    planReportDelivery({
      value: value({ turn: 3, at: 1_700_000_005_000 }),
      taskId: 'task-1', address: 'p2', sinceTs: 0, deliveredKeys,
    }),
    { kind: 'deliver' },
    'same turn, later settle: a real settlement, not a duplicate',
  );
});

test('fitReportDocument: an escape-heavy report keeps a real prefix, not just the marker', () => {
  // NUL and SOH serialize to `\u0000`/`\u0001` — six bytes per character — so a byte overage is
  // nothing like a character count: subtracting it from the character index drove the whole report to
  // nothing, and a body that is only the marker is delivered as if it were the report.
  const head = 'REPORT: the survey is done.\n';
  const escapeHeavy = head + '\u0000\u0001'.repeat(400_000);
  assert.ok(Buffer.byteLength(JSON.stringify(escapeHeavy), 'utf8') > 2 * MAX_DOCUMENT_BYTES);
  const fitted = fitReportDocument(value({ text: escapeHeavy }));
  const text = fitted.text ?? '';
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), 'utf8') <= MAX_DOCUMENT_BYTES, 'the value fits the ceiling');
  assert.ok(text.startsWith(head), 'the beginning of the report survives');
  assert.ok(text.length > 100_000, `a real prefix survives (kept ${text.length} of ${escapeHeavy.length} characters)`);
  assert.match(text, /\[report truncated: \d+ characters over the core's document limit\]/);
  const kept = text.slice(0, text.indexOf('\n\n[report truncated'));
  assert.ok(escapeHeavy.startsWith(kept), 'the kept text is a verbatim prefix');
  assert.ok(text.includes(`truncated: ${escapeHeavy.length - kept.length} characters`), 'the marker counts exactly what was dropped');
});

test('fitReportDocument: a report at the ceiling is kept whole', () => {
  const text = 'z'.repeat(MAX_DOCUMENT_BYTES - 1_000);
  const fitted = fitReportDocument(value({ text }));
  assert.equal(fitted.text, text, 'no marker when nothing had to be dropped');
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

