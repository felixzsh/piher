/**
 * Transport benchmark, layer 1: how many settlements survive one delivery, and what a
 * byte-budgeted delivery would cost instead. Pure functions, no model — this measures the
 * CHANNEL, not the master's judgment. Attention needs the fan-out first: with 3 of 10 delivered,
 * any wrong decision is explained by lost information, not by attention.
 *
 * Sizes are the measured distribution over 187 real settlements in this repo's sessions:
 * median 374 B, p90 8,108 B. Asserted, not printed, so a change in the channel breaks the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseNotices } from '../src/index-notices.ts';
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

/** How many of `notices` reach the master verbatim, byte for byte. */
function carriedVerbatim(text: string, notices: readonly string[]): number {
  return notices.filter((n) => text.includes(n)).length;
}

/** Candidate design, NOT wired anywhere: the identity row is never budgeted — only report text
 *  is. A body that does not fit is replaced by a pointer naming the same agentId, so no
 *  settlement can disappear from a delivery. */
function deliverByBudget(
  rows: ReadonlyArray<{ id: string; purpose: string; body: string }>,
  bodyBudget: number,
): { text: string; bodies: string[]; pointers: string[]; bytes: number; bodyBytes: number } {
  const lines: string[] = [];
  const bodies: string[] = [];
  const pointers: string[] = [];
  let used = 0;
  for (const row of rows) {
    lines.push(`${row.id} · ${row.purpose} · settled · ${row.body.length} B`);
    if (used + row.body.length <= bodyBudget) {
      used += row.body.length;
      bodies.push(row.id);
      lines.push(row.body);
    } else {
      pointers.push(row.id);
      lines.push(`  full report: subagent(action:"output", agentId: "${row.id}")`);
    }
  }
  const text = lines.join('\n');
  return { text, bodies, pointers, bytes: Buffer.byteLength(text), bodyBytes: used };
}

const rowsFor = (n: number, size: number) => Array.from({ length: n }, (_, i) => ({
  id: `w${i + 1}`,
  purpose: `fase ${i + 1}`,
  body: closingMessage(`w${i + 1}`, size),
}));

test('today: every batch up to three is delivered whole', () => {
  for (const n of [1, 2, 3]) {
    const notices = Array.from({ length: n }, (_, i) => notice(`w${i + 1}`, BODY_MEDIAN));
    const text = collapseNotices(notices)!;
    assert.equal(carriedVerbatim(text, notices), n, `n=${n} is delivered whole`);
    assert.doesNotMatch(text, /more settlement/, `n=${n} has nothing hidden to report`);
  }
});

test('today: from four on, exactly three travel and the rest are a sentence', () => {
  for (const n of [4, 5, 10, 20, 50]) {
    const notices = Array.from({ length: n }, (_, i) => notice(`w${i + 1}`, BODY_MEDIAN));
    const text = collapseNotices(notices)!;
    assert.equal(carriedVerbatim(text, notices), 3, `n=${n} delivers three, not ${n}`);
    assert.match(text, new RegExp(`…${n - 3} more settlement\\(s\\) not shown individually`),
      `n=${n} names how many it withheld`);
  }
});

test('today: the withheld reports are absent from the delivery, not summarised', () => {
  const notices = Array.from({ length: 10 }, (_, i) => notice(`w${i + 1}`, BODY_MEDIAN));
  const text = collapseNotices(notices)!;
  const missing = notices.filter((n) => !text.includes(n));
  assert.equal(missing.length, 7, 'seven of ten reports never reach the master');
  // The tail is an instruction to go read transcripts: the recovery the tool exists to avoid.
  assert.match(text, /Read each worker's own transcript/);
});

test('today: bytes at ten are small because seven reports are missing, not because it is cheap', () => {
  for (const size of [BODY_MEDIAN, BODY_P90]) {
    const notices = Array.from({ length: 10 }, (_, i) => notice(`w${i + 1}`, size));
    const bytes = Buffer.byteLength(collapseNotices(notices)!);
    const all = Buffer.byteLength(notices.join('\n\n'));
    assert.ok(bytes < all, `delivering 3 of 10 costs less than 10 of 10 at ${size} B`);
    // The saving is the withheld text: 7 bodies never travel.
    assert.ok(all - bytes >= 7 * size * 0.9, `most of the gap is the seven withheld bodies`);
  }
});

test('candidate: the identity of every settlement survives, up to fifty', () => {
  for (const n of [4, 10, 20, 50]) {
    const rows = rowsFor(n, BODY_P90);
    const out = deliverByBudget(rows, 4096);
    assert.equal(out.bodies.length + out.pointers.length, n, `n=${n} accounts for every row`);
    for (const row of rows) {
      assert.ok(out.text.includes(`${row.id} · ${row.purpose} · settled`),
        `n=${n}: ${row.id} is announced even when its body does not fit`);
    }
  }
});

test('candidate: the body budget is respected, and the small ones travel whole', () => {
  const median = deliverByBudget(rowsFor(10, BODY_MEDIAN), 4096);
  assert.equal(median.bodies.length, 10, 'ten median reports (3.7 KB) fit under 4 KB');
  assert.equal(median.pointers.length, 0, 'and none needs a pointer');

  const p90 = deliverByBudget(rowsFor(10, BODY_P90), 4096);
  assert.equal(p90.bodies.length, 0, 'no 8 KB report fits under 4 KB');
  assert.equal(p90.pointers.length, 10, 'each one gets a pointer instead');
  assert.ok(median.bodyBytes <= 4096 && p90.bodyBytes <= 4096,
    `bodies stay inside the budget (${median.bodyBytes} and ${p90.bodyBytes})`);
});

test('candidate: a pointer names the agentId, so recovery is one call and never a search', () => {
  const out = deliverByBudget(rowsFor(10, BODY_P90), 4096);
  for (const id of out.pointers) {
    assert.ok(out.text.includes(`subagent(action:"output", agentId: "${id}")`),
      `${id}'s pointer carries the exact call`);
  }
});

test('candidate vs today at ten: more bytes, every report — the trade the channel must make', () => {
  const rows = rowsFor(10, BODY_MEDIAN);
  const today = Buffer.byteLength(collapseNotices(rows.map((r) => notice(r.id, r.body.length)))!);
  const candidate = deliverByBudget(rows, 4096).bytes;
  assert.ok(candidate > today, 'completeness costs bytes; the channel buys it back with brevity');
  // The honest ratio: today is cheaper only because it drops seven reports.
  assert.ok(candidate < today * 3, `candidate stays within 3x of today (${candidate} vs ${today})`);
  console.log(`[transport] N=10 median: today ${today} B (3 reports) · `
    + `candidate ${candidate} B (10 reports, 10 bodies) · `
    + `candidate@p90 ${deliverByBudget(rowsFor(10, BODY_P90), 4096).bytes} B (10 rows, 0 bodies)`);
});
