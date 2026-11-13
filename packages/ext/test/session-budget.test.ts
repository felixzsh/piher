/**
 * E6: what one SESSION carries of report text, not only what one delivery carries.
 *
 * The per-delivery budget judges every delivery alone; the session ceiling is the second, additional
 * limit (`session-budget.ts`). Three properties are asserted here, and all three fail on the base
 * commit: under the ceiling nothing changes, over it bodies become pointers and the delivery says why,
 * and the count is derived from durable state, so a restart does not hand the session a fresh ceiling.
 *
 * The per-delivery budget is not weakened by any of it: a body over 4 KB is still withheld while the
 * session has room, and the text then names the per-delivery reason, not the session one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoticeBuffer, NOTICE_BODY_BUDGET_BYTES, planNoticeBatch, type NoticeRow } from '../src/index-notices.ts';
import { mountSubagent } from './test-utils.ts';
import {
  formatSessionReportBytes,
  openSessionReportBytes,
  parseSessionReportBytes,
  portSessionBudget,
  remainingReportBytes,
  SESSION_REPORT_BUDGET_BYTES,
  sessionBudgetLine,
  sessionReportBudgetBytes,
  sessionReportBytesPath,
  type SessionReportBudget,
  type SessionReportCounter,
} from '../src/session-budget.ts';

const BODY_MEDIAN = 374;
const BODY_P90 = 8108;

const rowFor = (n: number, size: number): NoticeRow => {
  const head = `w${n}: `;
  return {
    id: `w${n}`,
    description: `fase ${n}`,
    outcome: 'settled',
    body: head + 'x'.repeat(Math.max(0, size - head.length)),
  };
};

const noticesFor = (n: number, size: number) =>
  Array.from({ length: n }, (_, i) => ({ content: `settled w${i + 1}`, row: rowFor(i + 1, size) }));

const bodiesFor = (n: number, size: number) => noticesFor(n, size).map((notice) => notice.row.body as string);

const carried = (text: string, bodies: readonly string[]): number =>
  bodies.filter((body) => text.includes(body)).length;

const tempFile = (name = 'settlement-s1.jsonl'): { dir: string; file: string; dispose(): void } => {
  const dir = mkdtempSync(join(tmpdir(), 'piher-budget-'));
  return { dir, file: join(dir, name), dispose: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A buffer whose sink and counter are observable: the two things this file is about. */
function buffer(opts: {
  counter: SessionReportCounter;
  busy?: boolean;
  refuse?: 'throw' | 'false' | null;
}) {
  const sent: string[] = [];
  const delivered: number[] = [];
  let busy = opts.busy ?? false;
  let refuse = opts.refuse ?? null;
  const buf = createNoticeBuffer({
    isBusy: () => busy,
    send: async (content) => {
      if (refuse === 'throw') throw new Error('pi is mid-turn');
      if (refuse === 'false') return false;
      sent.push(content);
    },
    sessionBudget: () => opts.counter.budget(),
    recordDeliveryBytes: (bytes) => {
      delivered.push(bytes);
      opts.counter.record(bytes);
    },
  });
  return {
    buf,
    sent,
    delivered,
    setBusy: (v: boolean) => { busy = v; },
    setRefuse: (v: 'throw' | 'false' | null) => { refuse = v; },
  };
}

/* ── the policy a process reads ─────────────────────────────────── */

test('E6: the session ceiling has one number, one knob, and a bounded reading', () => {
  assert.equal(SESSION_REPORT_BUDGET_BYTES, 32768, '32 KiB: the measured mean session (22 KB) plus room');
  assert.equal(sessionReportBudgetBytes({}), SESSION_REPORT_BUDGET_BYTES, 'unset → the registry default');
  assert.equal(sessionReportBudgetBytes({ PIHER_SESSION_REPORT_BUDGET_BYTES: '8192' }), 8192, 'the knob applies');
  assert.equal(sessionReportBudgetBytes({ PIHER_SESSION_REPORT_BUDGET_BYTES: '0' }), 0,
    '0 is legal: every body a pointer, which is the strictest honest setting');
  assert.equal(sessionReportBudgetBytes({ PIHER_SESSION_REPORT_BUDGET_BYTES: 'nope' }), SESSION_REPORT_BUDGET_BYTES,
    'an invalid value falls back rather than withholding everything');
});

test('E6: remaining room never counts backwards, and the line states the numbers it used', () => {
  assert.equal(remainingReportBytes({ deliveredBytes: 0, ceilingBytes: 100 }), 100);
  assert.equal(remainingReportBytes({ deliveredBytes: 100, ceilingBytes: 100 }), 0);
  assert.equal(remainingReportBytes({ deliveredBytes: 500, ceilingBytes: 100 }), 0, 'an overshoot spends the rest');
  const line = sessionBudgetLine({ deliveredBytes: 40960, ceilingBytes: 32768 });
  assert.match(line, /^session report budget: 40960 B of 32768 B of report text already delivered in this session/);
  assert.match(line, /travel as pointers here/, 'the delivery says why, in its own words');
  assert.match(line, /subagent\(action:"reports"\)/, 'and names the call that reads them');
});

/* ── the delivery: under the ceiling nothing changes ────────────── */

test('E6: the composition root reads the ceiling from the port, and has none without one', () => {
  assert.equal(portSessionBudget(null, SESSION_REPORT_BUDGET_BYTES), null, 'a worker, a bare pi: no accounting');
  assert.deepEqual(portSessionBudget({}, SESSION_REPORT_BUDGET_BYTES), null, 'a port that keeps no counter is the same');
  assert.deepEqual(portSessionBudget({ sessionReportBytes: () => 512 }, SESSION_REPORT_BUDGET_BYTES),
    { deliveredBytes: 512, ceilingBytes: SESSION_REPORT_BUDGET_BYTES }, 'the count comes from the ledger side');
});

test('E6: under the ceiling a delivery is byte for byte what it always was', () => {
  const fresh: SessionReportBudget = { deliveredBytes: 0, ceilingBytes: SESSION_REPORT_BUDGET_BYTES };
  const plain = planNoticeBatch(noticesFor(10, BODY_MEDIAN))!;
  const accounted = planNoticeBatch(noticesFor(10, BODY_MEDIAN), NOTICE_BODY_BUDGET_BYTES, fresh)!;
  assert.equal(accounted.text, plain.text, 'no session line, no different rows');
  assert.equal(accounted.inline.length, 10);
  assert.deepEqual(accounted.withheld, []);
  assert.equal(accounted.inlineBytes, plain.inline.length * BODY_MEDIAN,
    'the plan reports the bytes it inlined, which is what the counter adds');
  assert.doesNotMatch(accounted.text, /session report budget/, 'the ceiling has not bitten, so it is not mentioned');
});

test('E6: a session with room left inlines what fits and names the budget that withheld the rest', () => {
  // 500 B of room and ten median bodies: one fits, nine become pointers.
  const budget: SessionReportBudget = { deliveredBytes: SESSION_REPORT_BUDGET_BYTES - 500, ceilingBytes: SESSION_REPORT_BUDGET_BYTES };
  const plan = planNoticeBatch(noticesFor(10, BODY_MEDIAN), NOTICE_BODY_BUDGET_BYTES, budget)!;
  assert.equal(plan.inline.length, 1, 'first-fit against the room the session has left');
  assert.equal(plan.withheld.length, 9);
  assert.equal(plan.inlineBytes, BODY_MEDIAN);
  assert.match(plan.text, /9 reports withheld above, in one call/);
  assert.match(plan.text, new RegExp(`session report budget: ${budget.deliveredBytes} B of ${budget.ceilingBytes} B`),
    'the delivery says the SESSION budget withheld them, with the numbers');
});

test('E6: once the ceiling is spent every body is a pointer, and the text says why', () => {
  const spent: SessionReportBudget = { deliveredBytes: SESSION_REPORT_BUDGET_BYTES, ceilingBytes: SESSION_REPORT_BUDGET_BYTES };
  const plan = planNoticeBatch(noticesFor(10, BODY_MEDIAN), NOTICE_BODY_BUDGET_BYTES, spent)!;
  assert.equal(plan.inline.length, 0);
  assert.equal(plan.withheld.length, 10, 'identity is never budgeted: all ten are still named');
  assert.equal(carried(plan.text, bodiesFor(10, BODY_MEDIAN)), 0);
  assert.equal(plan.inlineBytes, 0);
  assert.match(plan.text, /subagent\(action:"reports", ids:\[/);
  assert.match(plan.text, /session report budget: 32768 B of 32768 B of report text already delivered in this session/);
});

test('E6: a lone settlement keeps its text while the session has room, and becomes a pointer after it', () => {
  const body = 'w1: ' + 'x'.repeat(BODY_P90);
  const only = [{ content: `Background subagent w1 (fase 1) finished: ${body}`, row: { ...rowFor(1, BODY_P90) } }];
  // Under the ceiling: the lone settlement is not a batch, so not even the per-delivery budget cuts it.
  const fresh = planNoticeBatch(only, NOTICE_BODY_BUDGET_BYTES, { deliveredBytes: 0, ceilingBytes: SESSION_REPORT_BUDGET_BYTES })!;
  assert.equal(fresh.text, only[0]!.content, 'unchanged, byte for byte');
  assert.equal(fresh.inlineBytes, BODY_P90);
  // Over it: one report may not spend a ceiling the whole session shares.
  const spent = planNoticeBatch(only, NOTICE_BODY_BUDGET_BYTES, { deliveredBytes: SESSION_REPORT_BUDGET_BYTES, ceilingBytes: SESSION_REPORT_BUDGET_BYTES })!;
  assert.equal(spent.inline.length, 0);
  assert.deepEqual(spent.withheld, ['w1']);
  assert.match(spent.text, /w1 · fase 1 · settled · 8108 B/, 'the row is still there: identity survives');
  assert.match(spent.text, /full report: subagent\(action:"output", agentId:"w1"\)/);
  assert.match(spent.text, /session report budget: 32768 B of 32768 B/);
  assert.doesNotMatch(spent.text, /x{100}/, 'the report text itself is not in the delivery');
});

test('E6: the per-delivery budget is not weakened — a p90 body is withheld with a fresh session, and no session line', () => {
  const plan = planNoticeBatch(
    noticesFor(10, BODY_P90),
    NOTICE_BODY_BUDGET_BYTES,
    { deliveredBytes: 0, ceilingBytes: SESSION_REPORT_BUDGET_BYTES },
  )!;
  assert.equal(plan.inline.length, 0, 'no 8 KB body fits 4 KB, whatever the session has left');
  assert.equal(plan.withheld.length, 10);
  assert.doesNotMatch(plan.text, /session report budget/, 'the session was not the reason, so it is not blamed');
});

/* ── the buffer: the count grows only with what pi took ─────────── */

test('E6: the counter grows only when pi took the message', async () => {
  const dir = tempFile();
  try {
    const counter = openSessionReportBytes({ file: dir.file });
    const h = buffer({ counter });
    h.setRefuse('throw');
    await h.buf.deliverNotice('settled w1', 'w1', null, undefined, rowFor(1, BODY_MEDIAN));
    assert.equal(counter.delivered(), 0, 'a refused send carried nothing, so it spends nothing');
    h.setRefuse('false');
    h.setBusy(true);
    await h.buf.deliverNotice('settled w1', 'w1', null, undefined, rowFor(1, BODY_MEDIAN));
    h.setBusy(false);
    await h.buf.flush('followUp');
    assert.equal(counter.delivered(), 0, 'a host with no send method carried nothing either');
    h.setRefuse(null);
    await h.buf.deliverNotice('settled w1', 'w1', null, undefined, rowFor(1, BODY_MEDIAN));
    assert.equal(counter.delivered(), BODY_MEDIAN, 'what pi read is what the session carried');
    assert.deepEqual(h.delivered, [BODY_MEDIAN], 'and exactly one delivery was recorded');
  } finally {
    dir.dispose();
  }
});

test('E6: the count survives a restart — it is derived from the durable sidecar, not from RAM', async () => {
  const dir = tempFile();
  try {
    const sidecar = sessionReportBytesPath(dir.file)!;
    assert.equal(sidecar, `${dir.file}.bytes`, 'beside the cursor the ledger writes, in the same directory');
    const first = openSessionReportBytes({ file: sidecar });
    first.record(SESSION_REPORT_BUDGET_BYTES);
    assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).deliveredBytes, SESSION_REPORT_BUDGET_BYTES,
      'written on acceptance, so a crash cannot un-spend it');

    // A second process — a `/reload`, a restart, a resumed session — reads the same ceiling.
    const after = openSessionReportBytes({ file: sidecar });
    assert.equal(after.delivered(), SESSION_REPORT_BUDGET_BYTES);
    const h = buffer({ counter: after });
    h.setBusy(true);
    for (let i = 1; i <= 3; i += 1) {
      await h.buf.deliverNotice(`settled w${i}`, `w${i}`, null, undefined, rowFor(i, BODY_MEDIAN));
    }
    h.setBusy(false);
    await h.buf.flush('followUp');
    assert.equal(h.sent.length, 1);
    assert.equal(carried(h.sent[0]!, bodiesFor(3, BODY_MEDIAN)), 0, 'the restarted session is still spent');
    assert.match(h.sent[0]!, /session report budget: 32768 B of 32768 B/);
    assert.equal(after.delivered(), SESSION_REPORT_BUDGET_BYTES, 'and withholding spends nothing');
  } finally {
    dir.dispose();
  }
});

test('E6: a lost or foreign counter reads as 0 — it never invents a spent session', () => {
  const dir = tempFile();
  try {
    assert.equal(parseSessionReportBytes(''), 0);
    assert.equal(parseSessionReportBytes('{not json'), 0);
    assert.equal(parseSessionReportBytes('{"version":2,"deliveredBytes":999}'), 0, 'another format is not this count');
    assert.equal(parseSessionReportBytes('{"version":1,"deliveredBytes":-4}'), 0);
    assert.equal(parseSessionReportBytes(formatSessionReportBytes(4096)), 4096, 'and the format round-trips');
    const missing = openSessionReportBytes({ file: join(dir.dir, 'nope.jsonl.bytes') });
    assert.equal(missing.delivered(), 0);
    const mixed = openSessionReportBytes({ file: join(dir.dir, 'mixed.bytes') });
    writeFileSync(join(dir.dir, 'mixed.bytes'), 'garbage');
    mixed.repoint(join(dir.dir, 'mixed.bytes'));
    assert.equal(mixed.delivered(), 0);
  } finally {
    dir.dispose();
  }
});

test('E6: the counter the composition root reads is the plugin\'s, and it survives a remount', async () => {
  // The seam `index.ts` reads (`port.sessionReportBytes` / `port.recordReportBytes`): the count lives
  // beside the session's ledger, so a `/reload` — a fresh mount reading the same repository — resumes
  // the ceiling instead of starting from zero.
  const repo = mkdtempSync(join(tmpdir(), 'piher-budget-repo-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const mount = () => mountSubagent({
    deps: { getSessionId: () => 'session-1', getCwd: () => repo },
  });
  const first = await mount();
  try {
    assert.equal(first.port.current!.sessionReportBytes!(), 0, 'a fresh session has carried nothing');
    first.port.current!.recordReportBytes!(2048);
    assert.equal(first.port.current!.sessionReportBytes!(), 2048);
  } finally {
    await first.root.fiber.dispose();
  }
  const second = await mount();
  try {
    assert.equal(second.port.current!.sessionReportBytes!(), 2048, 'the same session resumes its own count');
  } finally {
    await second.root.fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('E6: a delivery reports what it inlined, so the count can only track the delivered text', async () => {
  const dir = tempFile();
  try {
    const counter = openSessionReportBytes({ file: dir.file, ceiling: SESSION_REPORT_BUDGET_BYTES });
    const h = buffer({ counter });
    h.setBusy(true);
    for (let i = 1; i <= 4; i += 1) {
      await h.buf.deliverNotice(`settled w${i}`, `w${i}`, null, undefined, rowFor(i, BODY_MEDIAN));
    }
    h.setBusy(false);
    await h.buf.flush('followUp');
    assert.equal(counter.delivered(), 4 * BODY_MEDIAN, 'the bytes travelled, not the rows');
    // And a roster-shaped notice (no row) spends nothing: it carries no report text.
    await h.buf.deliverNotice('[piher after compaction · from the records…]');
    assert.equal(counter.delivered(), 4 * BODY_MEDIAN);
  } finally {
    dir.dispose();
  }
});
