/**
 * `action: "reports"`: the call a batch delivery points at (E1). A notice that withholds report
 * bodies names the exact call that reads them, and reading ten must cost one turn, not ten — so this
 * file pins the two things that make that promise worth making: one call returns every report it can
 * fit and says how many did not, and a repeated id is one report, not two.
 *
 * The documents are the channel (S12, G10), so the fake client is a document store: nothing here
 * reads a task record, and a test asserting a byte count can see exactly which address answered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSubagentReports,
  planReportBatch,
  reportBatchBudget,
  reportBatchIds,
  type ReportIdRequest,
} from '../src/subagent-reports.ts';
import type { CoreClientLike } from '../src/core-client.ts';
import type { ReportDocumentValue } from '../src/report-documents.ts';

const doc = (taskId: string, text: string | null, at = 1_700_000_000_000): ReportDocumentValue =>
  ({ taskId, turn: 1, stopReason: null, session: null, text, at });

/** A core that holds report documents and counts the reads, so a duplicate can be seen at the seam. */
function fakeCore(docs: Record<string, ReportDocumentValue | 'not-a-report'>): CoreClientLike & { reads: string[] } {
  const reads: string[] = [];
  const core = {
    reads,
    async docGet(name: string) {
      reads.push(name);
      const entry = docs[name];
      if (entry === undefined) return { name, value: null, version: 1 };
      if (entry === 'not-a-report') return { name, value: { nonsense: true }, version: 1 };
      return { name, value: entry, version: 1 };
    },
  };
  return core as unknown as CoreClientLike & { reads: string[] };
}

/** The text of the single text block a tool result carries. */
const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content[0]!).text;

const request = (id: string, text: string | null, at = 1_700_000_000_000): ReportIdRequest =>
  ({ id, state: { kind: 'report', text, writtenAt: at } });

test('planReportBatch: ten reports in one call, whole, with the source named', () => {
  const bodies = Array.from({ length: 10 }, (_, i) => `report ${i + 1} `.padEnd(300, 'x'));
  const plan = planReportBatch(bodies.map((body, i) => request(`w${i + 1}`, body)), 6000);
  assert.equal(plan.included.length, 10, 'all ten fit the default budget');
  assert.deepEqual(plan.dropped, []);
  for (const [i, body] of bodies.entries()) {
    assert.ok(plan.text.includes(body.trimEnd()), `w${i + 1}'s report travels verbatim`);
    assert.ok(plan.text.includes(`piher.rep.w${i + 1}`), 'each block names the document that answered');
  }
  assert.match(plan.text, /source: report document \(piher\.rep\.<address>\)/,
    'the call says which channel answered');
});

test('planReportBatch: the budget cuts at report boundaries and says how many did not fit', () => {
  const bodies = Array.from({ length: 10 }, (_, i) => `report ${i + 1} `.padEnd(8108, 'x'));
  const plan = planReportBatch(bodies.map((body, i) => request(`w${i + 1}`, body)), 16000);
  assert.equal(plan.included.length, 1, 'one 8 KB report fits 16,000 chars, a second does not');
  assert.equal(plan.dropped.length, 9);
  assert.match(plan.text, /^9 did not fit the 16000-char budget: /m, 'the count is explicit');
  assert.match(plan.text, /w2 \(8108 chars\)/, 'and the size explains why');
  assert.ok(plan.text.includes(bodies[0]!.trimEnd()), 'the one report that fits travels whole');
  for (const body of bodies.slice(1)) assert.ok(!plan.text.includes(body.trimEnd()), 'a dropped body is absent');
});

test('planReportBatch: an unreadable id is named with what the read established, not counted as a fit', () => {
  const plan = planReportBatch([
    { id: 'w1', state: { kind: 'report', text: 'ok', writtenAt: 1 } },
    { id: 'w2', state: { kind: 'absent' } },
    { id: 'w3', state: { kind: 'unavailable' } },
    { id: 'w4', state: { kind: 'not-a-report' } },
    { id: 'w5', state: { kind: 'report', text: null, writtenAt: 1 } },
  ], 6000);
  assert.deepEqual(plan.included, ['w1']);
  assert.deepEqual(plan.dropped, [], 'nothing was withheld for space');
  assert.deepEqual(plan.unreadable, ['w2', 'w3', 'w4', 'w5']);
  assert.match(plan.text, /w2 · no report document is stored/);
  assert.match(plan.text, /w3 · the core did not answer/);
  assert.match(plan.text, /w4 · .*not a report/);
  assert.match(plan.text, /w5 · .*holds no text/);
});

test('executeSubagentReports: ten withheld reports come back in one call', async () => {
  const docs: Record<string, ReportDocumentValue> = {};
  for (let i = 1; i <= 10; i += 1) docs[`piher.rep.w${i}`] = doc(`t${i}`, `the report of w${i} `.padEnd(374, 'y'));
  const core = fakeCore(docs);
  const result = await executeSubagentReports(
    { action: 'reports', ids: Array.from({ length: 10 }, (_, i) => `w${i + 1}`) },
    { client: core },
  );
  const text = textOf(result);
  assert.equal(core.reads.length, 10, 'one document read per id');
  for (let i = 1; i <= 10; i += 1) assert.ok(text.includes(`the report of w${i}`), `w${i} is in the answer`);
  const details = (result as { details: { included: number; dropped: string[] } }).details;
  assert.equal(details.included, 10);
  assert.deepEqual(details.dropped, [], 'ten median reports fit the default budget');
});

test('executeSubagentReports: a duplicate id returns one payload, not two', async () => {
  const core = fakeCore({ 'piher.rep.w1': doc('t1', 'the only report') });
  const result = await executeSubagentReports(
    { action: 'reports', ids: ['w1', 'w1', ' w1 '] },
    { client: core },
  );
  const text = textOf(result);
  assert.equal(core.reads.length, 1, 'the document is read once');
  assert.equal(text.split('the only report').length - 1, 1, 'and its text appears exactly once');
  assert.match(text, /1 asked/, 'the call asked for one report');
});

test('executeSubagentReports: a late id over budget is reported, not silently missing', async () => {
  const docs: Record<string, ReportDocumentValue> = {
    'piher.rep.w1': doc('t1', 'a'.repeat(5000)),
    'piher.rep.w2': doc('t2', 'b'.repeat(5000)),
  };
  const result = await executeSubagentReports(
    { action: 'reports', ids: ['w1', 'w2'], max_chars: 6000 },
    { client: fakeCore(docs) },
  );
  const text = textOf(result);
  assert.ok(text.includes('a'.repeat(5000)), 'the first report travels whole');
  assert.ok(!text.includes('b'.repeat(5000)), 'the second does not');
  assert.match(text, /1 did not fit the 6000-char budget: w2 \(5000 chars\)/);
  assert.match(text, /subagent\(action:"output", agentId:"w2"\)/, 'the exact call that reads it');
});

test('executeSubagentReports: no ids is a refusal that says how to call it', async () => {
  // `toolError` throws: pi marks a tool result failed only when execute() throws (docs/extensions.md).
  await assert.rejects(
    () => executeSubagentReports({ action: 'reports', ids: [] }, { client: fakeCore({}) }),
    (err: Error) => {
      assert.equal(err.name, 'ToolError');
      assert.match(err.message, /^missing ids for reports/);
      assert.match(err.message, /"action":"reports","ids":\[/);
      return true;
    },
  );
});

test('reportBatchBudget and reportBatchIds: the call\'s own bounds', () => {
  assert.equal(reportBatchBudget({}), 6000, 'the same default as output');
  assert.equal(reportBatchBudget({ max_chars: 200 }), 200);
  assert.equal(reportBatchBudget({ max_chars: 999_999 }), 16000, 'and the same hard cap');
  assert.deepEqual(reportBatchIds({ ids: ['w1', 7, '', ' w2 ', 'w1'] }), ['w1', 'w2'],
    'non-strings, blanks and repeats are one id each');
  assert.deepEqual(reportBatchIds({ ids: 'w3' }), ['w3'], 'a single id is accepted');
  assert.deepEqual(reportBatchIds({}), []);
});
