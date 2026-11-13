/** Settlement report documents (spec S6–S13): names, value guard, delivery plan, size fitting, CAS
 *  write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DOCUMENT_BYTES, fitReportDocument, isReportDocumentValue, planReportDelivery, planSettleWrite,
  readReportDocument, reportDeliveryKey, reportDocName, writeReportDocument, type ReportDocumentValue,
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

test('the document store follows the measured version rule: a delete bumps it', async () => {
  // Measured on hc 0.1.20 (private core, 2026-11-13): doc.set at v0 answers 1, at v1 answers 2,
  // doc.set(null, v2) answers **3**, doc.get then reads {value: null, version: 3}, and the next
  // doc.set(v3) answers 4. The core's prose says a deletion "retains its version"; that means the
  // counter keeps a history, not that it stands still — and `planCommandPickup` reads the worker's
  // ack off exactly that step, so this model and the rule must not drift apart silently.
  const client = fakeCore();
  assert.equal(await client.docSet('probe.doc', { a: 1 }, 0), 1);
  assert.equal(await client.docSet('probe.doc', { a: 2 }, 1), 2);
  assert.equal(await client.docSet('probe.doc', null, 2), 3, 'the delete lands at version + 1');
  assert.deepEqual(await client.docGet('probe.doc'), { value: null, version: 3 });
  assert.equal(await client.docSet('probe.doc', { a: 3 }, 3), 4,
    'the next write lands two above the version the delete started from');
  // Without the stale-version refusal the sequence would be a coincidence rather than a rule.
  await assert.rejects(
    () => client.docSet('probe.doc', { a: 4 }, 2),
    (err: unknown) => (err as { kind?: string }).kind === 'conflict',
  );
});

test('readReportDocument: an absent, a deleted, a malformed and an unread document are different facts', async () => {
  const value = { taskId: 't9', turn: 1, stopReason: 'stop', session: null, text: 'done', at: 5_000 };
  const storing = async (stored: unknown) => readReportDocument(fakeCore({
    docGet: async (name: string) => (name === 'piher.rep.t9' ? { value: stored, version: 2 } : null),
  }), 't9');
  assert.deepEqual(await storing(value), { kind: 'read', value });
  // The core's own "nothing is stored": a missing name and a deleted value (a delete leaves `null`).
  assert.deepEqual(await readReportDocument(fakeCore({ docGet: async () => null }), 't9'), { kind: 'absent' });
  assert.deepEqual(await storing(null), { kind: 'absent' });
  // Stored but not a report is its own fact: a refusal must not call that "no document".
  assert.deepEqual(await storing({ text: 'not a report' }), { kind: 'not-a-report' });
  // An address that cannot name a document (spec S9) has nothing to read either.
  assert.deepEqual(await readReportDocument(fakeCore(), 'Not An Address'), { kind: 'absent' });
  // The core did not answer: nothing was established.
  assert.deepEqual(
    await readReportDocument(fakeCore({ docGet: async () => { throw new Error('connect ECONNREFUSED'); } }), 't9'),
    { kind: 'unavailable' },
  );
});

test('writeReportDocument: the first write lands at version 0', async () => {
  const client = fakeCore();
  const written = await writeReportDocument(client, 't9', value());
  assert.deepEqual(written, { ok: true, version: 1 });
  assert.deepEqual((await client.docGet('piher.rep.t9'))?.value, value());
});

/* ── the worker's write side (spec S6/S8) ───────────────────────── */

/** One settle, as index.ts sees it; each test overrides only the part it is about. */
const settle = (over: Partial<Parameters<typeof planSettleWrite>[0]> = {}) => planSettleWrite({
  isSubagent: true,
  clientAvailable: true,
  address: 'p9',
  delegationTaskId: 'task-9',
  aborted: false,
  lastStopReason: 'stop',
  turn: 4,
  turnStopReason: 'stop',
  text: 'REPORT: the work is done',
  why: null,
  session: '/w/s.jsonl',
  at: 1_700_000_000_000,
  ...over,
});

test('planSettleWrite: every settle with a channel writes, and nothing-to-say writes too', () => {
  const withText = settle();
  assert.deepEqual(withText, {
    kind: 'write',
    turnUnknown: false,
    value: {
      taskId: 'task-9', turn: 4, stopReason: 'stop', session: '/w/s.jsonl',
      text: 'REPORT: the work is done', at: 1_700_000_000_000,
    },
  });

  // A settle with no closing text and no reason: the document says exactly that. It is what lets the
  // master tell "settled with nothing to say" from "never settled" (the deleted path used to deliver
  // this as "It left no closing message").
  const empty = settle({ text: null });
  assert.equal(empty.kind, 'write');
  assert.ok(empty.kind === 'write');
  assert.equal(empty.value.text, null);
  assert.equal(empty.value.stopReason, null, 'no reason is stated, and the stop word is not invented');
  assert.equal(isReportDocumentValue(empty.value), true, 'the master can read it back');
});

test('planSettleWrite: a reason replaces the stop word, and the turn\'s own reason is kept with text', () => {
  const refused = settle({ text: null, why: 'the `reviewer` manifest does not permit `bash`' });
  assert.ok(refused.kind === 'write');
  assert.equal(refused.value.text, null);
  assert.equal(refused.value.stopReason, 'the `reviewer` manifest does not permit `bash`');

  const capped = settle({ turnStopReason: 'length' });
  assert.ok(capped.kind === 'write');
  assert.equal(capped.value.stopReason, 'length', 'a turn that ended by token cap keeps its own reason');
});

test('planSettleWrite: a worker with no channel skips, and names the part that is missing', () => {
  assert.deepEqual(settle({ isSubagent: false }), { kind: 'skip', reason: 'not-a-subagent' });
  assert.deepEqual(settle({ clientAvailable: false }), { kind: 'skip', reason: 'no-core-client' });
  assert.deepEqual(settle({ address: null }), { kind: 'skip', reason: 'no-address' });
  assert.deepEqual(settle({ delegationTaskId: undefined }), { kind: 'skip', reason: 'no-delegation' });
  // A settle that reports nothing by rule: an abort, or an error pi retries (S52).
  assert.deepEqual(settle({ aborted: true }), { kind: 'skip', reason: 'reports-nothing' });
  assert.deepEqual(settle({ lastStopReason: 'error' }), { kind: 'skip', reason: 'reports-nothing' });
});

test('planSettleWrite: a turn the core would not report costs the counter, not the settlement', () => {
  const unknown = settle({ turn: null });
  assert.ok(unknown.kind === 'write', 'the report still goes out');
  assert.equal(unknown.turnUnknown, true, 'and the substitution is named, not silent');
  assert.equal(unknown.value.turn, 0);
});

test('planSettleWrite + writeReportDocument: an empty settle reaches the core as a report', async () => {
  const client = fakeCore();
  const plan = planSettleWrite({
    isSubagent: true, clientAvailable: true, address: 'p9', delegationTaskId: 'task-9',
    aborted: false, lastStopReason: 'stop', turn: 2, turnStopReason: 'stop',
    text: null, why: null, session: null, at: 1_700_000_000_001,
  });
  assert.ok(plan.kind === 'write');
  assert.deepEqual(await writeReportDocument(client, 'p9', plan.value), { ok: true, version: 1 });
  const stored = (await client.docGet('piher.rep.p9'))?.value as ReportDocumentValue;
  assert.deepEqual(stored, plan.value);
  assert.equal(isReportDocumentValue(stored), true, 'the master reads it as a settlement, not as absence');
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

