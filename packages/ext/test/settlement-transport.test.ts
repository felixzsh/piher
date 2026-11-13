/**
 * Transport: how many settlements survive one delivery, and what it costs. Pure functions, no model —
 * this measures the CHANNEL, not the master's judgment. Attention needs the fan-out first: with 3 of
 * 10 delivered, any wrong decision is explained by lost information, not by attention.
 *
 * Sizes are the measured distribution over 187 real settlements in this repo's sessions: median
 * 374 B, p90 8,108 B. Asserted, not printed, so a change in the channel breaks the suite.
 *
 * Every case drives the shipped code: `planNoticeBatch` is what `createNoticeBuffer.flush` calls, and
 * the multi-settlement cases go through the buffer itself, because the batch is the thing under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNoticeBuffer,
  noticeBodyBudgetBytes,
  planNoticeBatch,
  NOTICE_BODY_BUDGET_BYTES,
  type NoticeDelivery,
  type NoticeRow,
} from '../src/index-notices.ts';
import { formatSettlementNotice } from '../src/vocab.ts';

/** Median and p90 closing-message sizes, measured over 187 settlements (see plan L9/L10). */
const BODY_MEDIAN = 374;
const BODY_P90 = 8108;

/** A closing message of exactly `size` bytes, prefixed so it is identifiable in a delivery. */
function closingMessage(id: string, size: number): string {
  const head = `${id}: `;
  return head + 'x'.repeat(Math.max(0, size - head.length));
}

/** The notice builders are shared with the live code, so a delivery here is the real one. */
const notice = (id: string, size: number): string =>
  formatSettlementNotice(id, closingMessage(id, size));

const rowFor = (n: number, size: number): NoticeRow => ({
  id: `w${n}`,
  description: `fase ${n}`,
  outcome: 'settled',
  body: closingMessage(`w${n}`, size),
});

/** One buffered delivery of `n` settlements, as the master would receive it after a busy flush. */
async function deliverBatch(n: number, size: number, bodyBudgetBytes?: number) {
  const sent: string[] = [];
  let busy = true;
  const buf = createNoticeBuffer({
    isBusy: () => busy,
    ...(bodyBudgetBytes === undefined ? {} : { bodyBudgetBytes }),
    send: async (content) => { sent.push(content); },
  });
  for (let i = 1; i <= n; i += 1) {
    const body = closingMessage(`w${i}`, size);
    await buf.deliverNotice(formatSettlementNotice(`w${i}`, body), `w${i}`, null, undefined, rowFor(i, size));
  }
  busy = false;
  await buf.flush('followUp');
  assert.equal(sent.length, 1, 'one batch is one message');
  return sent[0]!;
}

/** How many of `bodies` reach the master verbatim, byte for byte. */
const carriedVerbatim = (text: string, bodies: readonly string[]): number =>
  bodies.filter((body) => text.includes(body)).length;

const bodiesFor = (n: number, size: number): string[] =>
  Array.from({ length: n }, (_, i) => closingMessage(`w${i + 1}`, size));

test('a lone settlement keeps the text it has always had, byte for byte', async () => {
  const body = closingMessage('w1', BODY_MEDIAN);
  const content = formatSettlementNotice('w1', body);
  const plan = planNoticeBatch([{ content, row: rowFor(1, BODY_MEDIAN) }])!;
  assert.equal(plan.text, content, 'one settlement is not a batch: no row, no header');
  // And through the buffer, a lone notice is still delivered with its own card.
  const sent: Array<{ content: string; card?: unknown }> = [];
  const card = { name: 'w1', role: null, outcome: 'settled' as const, elapsedMs: 5 };
  const buf = createNoticeBuffer({ isBusy: () => false, send: async (text, _mode, c) => { sent.push({ content: text, ...(c ? { card: c } : {}) }); } });
  await buf.deliverNotice(content, 'w1', card, undefined, rowFor(1, BODY_MEDIAN));
  assert.deepEqual(sent, [{ content, card }], 'the direct send is unchanged');
});

test('ten settlements in one delivery: ten rows, none missing, every median body inline', async () => {
  const text = await deliverBatch(10, BODY_MEDIAN);
  for (let i = 1; i <= 10; i += 1) {
    assert.ok(text.includes(`w${i} · fase ${i} · settled · ${BODY_MEDIAN} B`), `w${i} has its own row`);
  }
  assert.equal(carriedVerbatim(text, bodiesFor(10, BODY_MEDIAN)), 10, 'all ten median reports travel whole');
  assert.doesNotMatch(text, /full report: subagent/, 'nothing needs a pointer at the median');
  assert.doesNotMatch(text, /withheld/, 'and nothing is withheld');
  assert.ok(Buffer.byteLength(text) < 4 * NOTICE_BODY_BUDGET_BYTES,
    `ten median reports stay inside a small delivery (${Buffer.byteLength(text)} B)`);
});

test('ten p90 settlements: ten rows, ten pointers, no bodies — and one call reads them all', async () => {
  const text = await deliverBatch(10, BODY_P90);
  for (let i = 1; i <= 10; i += 1) {
    assert.ok(text.includes(`w${i} · fase ${i} · settled · ${BODY_P90} B`), `w${i} is still named`);
    assert.ok(text.includes(`full report: subagent(action:"output", agentId:"w${i}")`),
      `w${i}'s pointer names the exact call`);
  }
  assert.equal(carriedVerbatim(text, bodiesFor(10, BODY_P90)), 0, 'no 8 KB body fits the budget');
  // One pointer per worker would cost ten turns: the batch line names them all in a single call.
  const ids = Array.from({ length: 10 }, (_, i) => `"w${i + 1}"`).join(',');
  assert.ok(text.includes(`10 reports withheld above, in one call: subagent(action:"reports", ids:[${ids}])`),
    'the batch pointer is one call, with every withheld id in it');
  // The rows are what a delivery is: cheap, complete, and honest about what it left behind.
  assert.ok(Buffer.byteLength(text) < 2000, `ten pointer rows cost ${Buffer.byteLength(text)} B`);
});

test('a batch of fifty still names fifty settlements: identity is never budgeted', async () => {
  const text = await deliverBatch(50, BODY_P90);
  const missing = Array.from({ length: 50 }, (_, i) => `w${i + 1}`)
    .filter((id) => !text.includes(`${id} · fase ${id.slice(1)} · settled · ${BODY_P90} B`));
  assert.deepEqual(missing, [], 'not one settlement is dropped, however many arrive');
  const plan = planNoticeBatch(
    Array.from({ length: 50 }, (_, i) => ({ content: 'ignored', row: rowFor(i + 1, BODY_P90) })),
  )!;
  assert.equal(plan.inline.length + plan.withheld.length, 50, 'every settlement is accounted for');
});

test('the body budget is a knob: a smaller one withholds more, and says how many', async () => {
  const text = await deliverBatch(10, BODY_MEDIAN, 5 * BODY_MEDIAN);
  assert.equal(carriedVerbatim(text, bodiesFor(10, BODY_MEDIAN)), 5, 'the budget decides, not the count');
  assert.match(text, /5 reports withheld above, in one call/);
  assert.doesNotMatch(text, /not shown individually|own transcript/, 'and never withholds silently');
});

test('the budget reads its registry default, and the env override wins', () => {
  assert.equal(NOTICE_BODY_BUDGET_BYTES, 4096, 'the measured trade: ten median reports, no p90 one');
  assert.equal(noticeBodyBudgetBytes({}), NOTICE_BODY_BUDGET_BYTES, 'unset → the registry default');
  assert.equal(noticeBodyBudgetBytes({ PIHER_NOTICE_BODY_BUDGET_BYTES: '8192' }), 8192, 'the knob applies');
  assert.equal(noticeBodyBudgetBytes({ PIHER_NOTICE_BODY_BUDGET_BYTES: 'nope' }), NOTICE_BODY_BUDGET_BYTES,
    'an invalid value falls back rather than withholding everything');
});

test('a notice with no row (a pane-closed warning) still travels as written', () => {
  const plan = planNoticeBatch([
    { content: 'Background subagent w1 (fase 1) stopped before settling (its pane closed).' },
    { content: 'ignored', row: rowFor(2, BODY_MEDIAN) },
  ])!;
  assert.match(plan.text, /^Background subagent w1 \(fase 1\) stopped before settling/);
  assert.ok(plan.text.includes('w2 · fase 2 · settled · 374 B'), 'and the row batch follows it');
});

test('a row with no body names the read that gets it, and repeats no report twice', () => {
  const plan = planNoticeBatch([
    { content: 'ignored', row: { id: 'w1', description: 'fase 1', outcome: 'settled', body: 'the answer' } },
    {
      content: 'ignored',
      row: {
        id: 'w2', description: 'fase 2', outcome: 'settled', body: null,
        note: 'its report was already returned by subagent(action:"output") at 12:03:04, so it is not repeated here',
      },
    },
    {
      content: 'ignored',
      row: { id: 'w3', description: 'fase 3', outcome: 'failed', body: null, note: 'no report — provider outage' },
    },
  ])!;
  assert.ok(plan.text.includes('w2 · fase 2 · settled · no report'), 'a read report has its row too');
  assert.ok(plan.text.includes('already returned by subagent(action:"output")'), 'and says why it is not repeated');
  assert.ok(plan.text.includes('w3 · fase 3 · failed · no report'));
  assert.ok(plan.text.includes('full report: subagent(action:"output", agentId:"w3")'),
    'a failure still names the read, as a lone notice always has');
  assert.equal(plan.text.split('the answer').length - 1, 1, 'the delivered body appears once');
});

test('measured: what a delivery costs at ten, and what the budget buys', async () => {
  const median: NoticeDelivery[] = Array.from({ length: 10 }, (_, i) => ({
    content: notice(`w${i + 1}`, BODY_MEDIAN), row: rowFor(i + 1, BODY_MEDIAN),
  }));
  const p90: NoticeDelivery[] = Array.from({ length: 10 }, (_, i) => ({
    content: notice(`w${i + 1}`, BODY_P90), row: rowFor(i + 1, BODY_P90),
  }));
  const all = Buffer.byteLength(median.map((n) => n.content).join('\n\n'));
  const delivered = Buffer.byteLength(planNoticeBatch(median)!.text);
  const pointed = Buffer.byteLength(planNoticeBatch(p90)!.text);
  assert.ok(delivered < all, 'rows cost less than ten repeated notice heads');
  assert.ok(delivered > Buffer.byteLength(median.slice(0, 3).map((n) => n.content).join('\n\n')),
    'and more than the three a sample would have carried: completeness is what the bytes buy');
  console.log(`[transport] N=10 median: 10 of 10 in ${delivered} B (rows, all bodies; `
    + `${all} B verbatim) · N=10 p90: 10 rows, 0 bodies, ${pointed} B with one batch pointer`);
});

/** The candidate shape is now the shipped one: the test above is the acceptance, this keeps the
 *  measured identity rule visible where the numbers are. */
test('every withheld body names its own id twice: once in the row, once in the exact call', async () => {
  const text = await deliverBatch(3, BODY_P90);
  for (let i = 1; i <= 3; i += 1) {
    const occurrences = text.split(`"w${i}"`).length - 1;
    assert.ok(occurrences >= 2, `w${i} appears in its row and in the call that reads it (${occurrences})`);
  }
});
