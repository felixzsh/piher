/**
 * `action: "inbox"` — the master's own read of its ledger (E1, E5).
 *
 * The defect this file pins: a settlement notice could be lost without anyone lying. The process
 * restarted between accepting a notice and recording that it was read, a compaction swallowed the
 * boundary, a console scrolled past it — and the only way back was to guess which worker had
 * finished. The ledger already held the facts (E1's durability), so what was missing is a read that
 * says *"what happened since the last thing I saw"*: after `since` (default: the delivered cursor),
 * in the delivery's own row format, each row naming its seq, with the cursor crossed over exactly
 * what came back.
 *
 * Two properties matter more than the wording, and every test below is about one of them:
 *
 * - **the ledger is the source and the record is not** (E5): a task record swept from disk must not
 *   stop the fact from being answered, and the body comes from `piher.rep.<pane>` — or the row says
 *   what the read established instead of passing a pointer off as a report;
 * - **nothing is marked as read that was not returned**: a `limit` that truncates leaves the rest
 *   below the next call, a foreign ledger is an error that moves nothing, and a repeated call with
 *   the same `since` answers the same facts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeSubagentInbox,
  inboxLimit,
  inboxSince,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  planInbox,
  selectInboxFacts,
  type InboxDeps,
  type InboxFact,
} from '../src/subagent-inbox.ts';
import {
  formatSettlementEvent,
  openSettlementLedger,
  parseSettlementCursor,
  type SettlementEvent,
  type SettlementLedger,
} from '../src/settlement-ledger.ts';
import { NOTICE_BODY_BUDGET_BYTES } from '../src/index-notices.ts';
import type { CoreClientLike } from '../src/core-client.ts';
import type { ReportDocumentValue } from '../src/report-documents.ts';
import { fakeCore, runSubagent, mountSubagent } from './test-utils.ts';

/** The p90 closing-message size: the measured body that no 4 KB budget carries inline. */
const BODY_P90 = 8108;

const AT = [11_000, 12_000, 13_000];

const report = (taskId: string, text: string | null, at: number): ReportDocumentValue =>
  ({ taskId, turn: 1, stopReason: text === null ? 'overloaded' : 'stop', session: null, text, at });

/** The body a world's document carries, so a row's byte count is asserted from the text itself. */
const bodyOf = (n: number): string => `p-w${n}: the report of task-${n}`;

/** A ledger on a real file plus a core holding the documents: one sweepable world per test. */
interface World {
  ledger: SettlementLedger;
  file: string;
  docs: Record<string, unknown>;
  dir: string;
  dispose(): void;
}

function world(facts: readonly number[] = [1, 2, 3]): World {
  const dir = mkdtempSync(join(tmpdir(), 'piher-inbox-'));
  const file = join(dir, 'settlement-sess.jsonl');
  const ledger = openSettlementLedger({ file });
  const docs: Record<string, unknown> = {};
  for (const n of facts) {
    const pane = `p-w${n}`;
    const taskId = `task-${n}`;
    const at = AT[n - 1]!;
    ledger.append({ at, taskId, pane, turn: 1, kind: 'settled', payloadRef: `piher.rep.${pane}` });
    docs[`piher.rep.${pane}`] = report(taskId, bodyOf(n), at);
  }
  return { ledger, file, docs, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A core whose document store holds exactly `docs`. */
async function coreWith(docs: Record<string, unknown>): Promise<CoreClientLike> {
  const client = fakeCore();
  for (const [name, value] of Object.entries(docs)) await client.docSet(name, value, 0);
  return client;
}

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

const detailsOf = (result: unknown): Record<string, unknown> =>
  (result as { details: Record<string, unknown> }).details;

/** No record at all: the task rows were swept, which is the E5 case. */
const swept = (): Pick<InboxDeps, 'description'> => ({ description: () => '' });

const run = async (
  w: World,
  params: Record<string, unknown>,
  deps: Partial<InboxDeps> = {},
) => executeSubagentInbox(params, {
  ledger: w.ledger,
  client: await coreWith(w.docs),
  ...swept(),
  ...deps,
});

/* ── the boundary: since, and the cursor it defaults to ─────────── */

test('inbox: since 0 returns every fact, in seq order, each naming its seq', async () => {
  const w = world();
  try {
    const result = await run(w, { action: 'inbox', since: 0 });
    const text = textOf(result);
    assert.deepEqual(detailsOf(result).returned, [1, 2, 3], 'every fact, and the seqs it answered');
    const at = [1, 2, 3].map((n) => text.indexOf(`#${n} · p-w${n} · `));
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'the rows are in seq order');
    assert.ok(at.every((i) => i >= 0), 'every row names its fact by seq');
    for (const n of [1, 2, 3]) assert.ok(text.includes(`p-w${n}: the report of task-${n}`), 'with its body');
    assert.match(text, /^\[Subagent inbox \| ledger .*settlement-sess\.jsonl \| after #0 \| 3 settlements/);
  } finally {
    w.dispose();
  }
});

test('inbox: since N returns only what follows it, in seq order', async () => {
  const w = world();
  try {
    const text = textOf(await run(w, { action: 'inbox', since: 2 }));
    assert.deepEqual(detailsOf(await run(w, { action: 'inbox', since: 2 })).returned, [3]);
    assert.ok(!text.includes('p-w1 · '), 'a fact at or below the boundary is not in the answer');
    assert.ok(!text.includes('p-w2 · '));
    assert.ok(text.includes('#3 · p-w3 · '), 'the one fact after it is');
  } finally {
    w.dispose();
  }
});

test('inbox: the default boundary is the delivered cursor, so a second call returns nothing new', async () => {
  const w = world([1]);
  try {
    const first = await run(w, { action: 'inbox' });
    assert.deepEqual(detailsOf(first).returned, [1], 'an unread fact is answered by default');
    assert.equal(detailsOf(first).since, 0, 'the boundary was the cursor it started from');
    assert.equal(w.ledger.deliveredSeq(), 1, 'and the cursor crossed it');

    const second = await run(w, { action: 'inbox' });
    assert.deepEqual(detailsOf(second).returned, []);
    assert.match(textOf(second), /after #1 \| nothing new \| ledger ends at #1/,
      'the empty answer names the range it read instead of going silent');
  } finally {
    w.dispose();
  }
});

test('inbox: two calls with the same since return the same facts', async () => {
  const w = world();
  try {
    const first = await run(w, { action: 'inbox', since: 1 });
    const again = await run(w, { action: 'inbox', since: 1 });
    assert.deepEqual(detailsOf(again).returned, detailsOf(first).returned, 'an explicit since is its own boundary');
    assert.equal(textOf(again), textOf(first), 'the same question gets the same answer, byte for byte');
  } finally {
    w.dispose();
  }
});

test('inbox: a settlement the live path already delivered is not re-returned', async () => {
  const w = world([1, 2]);
  try {
    // What an accepted delivery records, whatever carried it (`openBatch` is the batch seam).
    const group = w.ledger.openBatch();
    try {
      w.ledger.markDelivered(1);
      w.ledger.markDelivered(2);
    } finally {
      group.end();
    }
    const text = textOf(await run(w, { action: 'inbox' }));
    assert.match(text, /after #2 \| nothing new/);
    assert.deepEqual(detailsOf(await run(w, { action: 'inbox' })).returned, []);
  } finally {
    w.dispose();
  }
});

/* ── the limit, and the cursor it bounds ───────────────────────── */

test('inbox: limit truncates the answer and leaves the rest for the next call', async () => {
  const w = world();
  try {
    const first = await run(w, { action: 'inbox', since: 0, limit: 2 });
    assert.deepEqual(detailsOf(first).returned, [1, 2], 'two facts, and no more');
    assert.equal(detailsOf(first).more, 1, 'the one it left is counted');
    const text = textOf(first);
    assert.match(text, /1 more after #2: call inbox again for them\./);
    assert.ok(!text.includes('p-w3: the report'), 'the truncated fact is not in this answer');

    const second = await run(w, { action: 'inbox' });
    assert.deepEqual(detailsOf(second).returned, [3], 'the next call continues where the cursor stopped');
    assert.equal(detailsOf(second).more, 0);
  } finally {
    w.dispose();
  }
});

test('inbox: the cursor advances over exactly the facts returned, one step per call', async () => {
  const w = world();
  try {
    await run(w, { action: 'inbox', since: 0, limit: 1 });
    assert.equal(w.ledger.deliveredSeq(), 1, 'one returned fact, one step');
    // On disk, not only in memory: the next process must not replay what this one answered.
    assert.equal(parseSettlementCursor(readFileSync(`${w.file}.seq`, 'utf8')), 1, 'one cursor write');
    assert.equal(w.ledger.events().length, 3, 'the rest of the ledger is untouched');
    const next = await run(w, { action: 'inbox' });
    assert.deepEqual(detailsOf(next).returned, [2, 3], 'and the unanswered tail is still answerable');
    assert.equal(w.ledger.deliveredSeq(), 3);
    assert.equal(parseSettlementCursor(readFileSync(`${w.file}.seq`, 'utf8')), 3);
  } finally {
    w.dispose();
  }
});

/* ── the ledger is the answer, the document only the body ──────── */

test('inbox: a swept record still answers — the ledger is the source, not the record', async () => {
  const w = world([1]);
  try {
    // `description: () => ''` is what the plugin sees once the task record is gone.
    const result = await run(w, { action: 'inbox', since: 0 });
    const text = textOf(result);
    assert.ok(text.includes('p-w1: the report of task-1'), 'the body comes from the document');
    assert.ok(text.includes(`#1 · p-w1 · (no description) · settled · ${Buffer.byteLength(bodyOf(1))} B`),
      'and the row says the description is gone instead of inventing one');
  } finally {
    w.dispose();
  }
});

test('inbox: a report document that is gone is named as gone, and the fact still comes back', async () => {
  const w = world([1]);
  try {
    delete w.docs['piher.rep.p-w1'];
    const result = await run(w, { action: 'inbox', since: 0 });
    const text = textOf(result);
    assert.ok(text.includes('#1 · p-w1 · (no description) · settled · no report'), 'the fact is still named');
    assert.ok(text.includes('full report: subagent(action:"output", agentId:"p-w1")'),
      'with the exact call that reads what is left');
    assert.ok(text.includes('piher.rep.p-w1 is gone, so the report cannot be read any more'),
      'and the reason it did not establish the body');
    assert.equal(w.ledger.deliveredSeq(), 1, 'a fact whose body is gone is still a fact the master has');
  } finally {
    w.dispose();
  }
});

test('inbox: another task\'s document is never passed off as this fact\'s report', async () => {
  const w = world([1]);
  try {
    // The address was reused: the document at `piher.rep.p-w1` now holds a later task's settlement.
    w.docs['piher.rep.p-w1'] = report('task-later', 'THE OTHER TASK REPORT', AT[0]! + 5_000);
    const text = textOf(await run(w, { action: 'inbox', since: 0 }));
    assert.ok(!text.includes('THE OTHER TASK REPORT'), 'the other task\'s words are not delivered');
    assert.ok(text.includes('#1 · p-w1 · (no description) · settled · no report'));
    assert.match(text, /holds task task-later .*not this one: its address was reused/);
  } finally {
    w.dispose();
  }
});

test('inbox: a worker that ended without words says so, and its fact is not a failure', async () => {
  const w = world([1]);
  try {
    w.docs['piher.rep.p-w1'] = report('task-1', null, AT[0]!);
    const text = textOf(await run(w, { action: 'inbox', since: 0 }));
    assert.ok(text.includes('it ended without a report: overloaded'), 'the reason is the report');
    assert.ok(text.includes('#1 · p-w1 · (no description) · settled · no report'));
  } finally {
    w.dispose();
  }
});

test('inbox: a fact with no document at all says which ending left none', async () => {
  const w = world([]);
  try {
    // A pane killed before it settled never wrote a document: that is a `pane-gone` fact.
    w.ledger.append({ at: 20_000, taskId: 'task-gone', pane: 'p-gone', turn: null, kind: 'pane-gone' });
    const text = textOf(await run(w, { action: 'inbox', since: 0 }));
    assert.ok(text.includes('#1 · p-gone · (no description) · closed · no report'), 'closed, not failed');
    assert.ok(text.includes('its pane was gone before it settled, so it never wrote a report'));
  } finally {
    w.dispose();
  }
});

test('inbox: a reused address names the task it belongs to now', async () => {
  const w = world([1]);
  try {
    delete w.docs['piher.rep.p-w1'];
    const text = textOf(await run(w, { action: 'inbox', since: 0 }, {
      description: () => '',
      paneOwner: (pane) => (pane === 'p-w1' ? 'task-newer' : undefined),
    }));
    assert.ok(text.includes('its address p-w1 now belongs to task task-newer'),
      'the pointer would answer about another task, so the row says so');
  } finally {
    w.dispose();
  }
});

/* ── the budget: rows always, bodies while they fit ────────────── */

test('inbox: a report over the budget becomes its exact pointer, and one call reads it', async () => {
  const w = world([1, 2]);
  try {
    const body = 'x'.repeat(BODY_P90);
    w.docs['piher.rep.p-w2'] = report('task-2', body, AT[1]!);
    const result = await run(w, { action: 'inbox', since: 0 });
    const text = textOf(result);
    assert.ok(text.includes('p-w1: the report of task-1'), 'the body that fits travels verbatim');
    assert.ok(!text.includes(body), 'the one that does not is withheld');
    assert.ok(text.includes('full report: subagent(action:"output", agentId:"p-w2")'));
    assert.ok(text.includes('1 report withheld above, in one call: subagent(action:"reports", ids:["p-w2"])'));
    assert.deepEqual(detailsOf(result).withheld, ['p-w2']);
    assert.deepEqual(detailsOf(result).inline, ['p-w1']);
    assert.ok(Buffer.byteLength(text) < NOTICE_BODY_BUDGET_BYTES + 1_000,
      `a withheld body costs a pointer, not a report (${Buffer.byteLength(text)} B)`);
  } finally {
    w.dispose();
  }
});

/* ── an unreadable ledger is an error, never silence ───────────── */

test('inbox: a foreign ledger is an error naming what was read, and it moves nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piher-inbox-foreign-'));
  const file = join(dir, 'settlement-sess.jsonl');
  try {
    writeFileSync(file, 'this is not a ledger\nand neither is this\n');
    const ledger = openSettlementLedger({ file });
    await assert.rejects(
      () => executeSubagentInbox({ action: 'inbox', since: 0 }, {
        ledger, client: fakeCore(), ...swept(),
      }),
      (err: Error) => {
        assert.equal(err.name, 'ToolError');
        assert.match(err.message, /holds \d+ B and not one readable fact/);
        assert.ok(err.message.includes(file), 'the error names the file it read');
        assert.match(err.message, /the cursor was not moved/);
        return true;
      },
    );
    assert.equal(ledger.deliveredSeq(), 0, 'a refused read crosses nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox: a ledger that ends mid-line says so, and answers the facts that are whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piher-inbox-torn-'));
  const file = join(dir, 'settlement-sess.jsonl');
  try {
    const fact: SettlementEvent = {
      seq: 1, at: 1_000, taskId: 'task-1', pane: 'p-w1', turn: 1, kind: 'settled',
    };
    // A crash mid-append: the last line never finished, so that fact is gone and this one survives.
    writeFileSync(file, `${formatSettlementEvent(fact)}\n{"seq":2,"at":2000,"taskId":"task-2"`);
    const ledger = openSettlementLedger({ file });
    const text = textOf(await executeSubagentInbox({ action: 'inbox', since: 0 }, {
      ledger, client: fakeCore(), ...swept(),
    }));
    assert.ok(text.includes('#1 · p-w1 · '), 'the whole fact is answered');
    assert.match(text, /its last line is unfinished, so the newest fact may be missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox: a recorded fact with nothing to deliver is counted, never rendered as a settlement', async () => {
  const w = world([]);
  try {
    w.ledger.append({ at: 5_000, taskId: 'task-x', pane: 'p-x', turn: null, kind: 'spawned' });
    const text = textOf(await run(w, { action: 'inbox', since: 0 }));
    assert.match(text, /1 recorded fact with nothing to deliver/);
    assert.ok(!text.includes('#1 · p-x · '), 'a spawn is not a settlement row');
  } finally {
    w.dispose();
  }
});

test('inbox: no ledger file at all still answers with what it read', async () => {
  const ledger = openSettlementLedger({ file: null });
  const text = textOf(await executeSubagentInbox({ action: 'inbox' }, {
    ledger, client: fakeCore(), ...swept(),
  }));
  assert.match(text, /ledger in memory \(no repository: nothing durable\) \| after #0 \| nothing new/);
});

/* ── the call's own bounds, and the planner ───────────────────── */

test('inboxSince and inboxLimit: the call\'s own bounds, refused rather than guessed', () => {
  assert.equal(inboxSince({}, 4), 4, 'no since means the delivered cursor');
  assert.equal(inboxSince({ since: 0 }, 4), 0, 'an explicit 0 is the whole ledger, not a fallback');
  assert.equal(inboxLimit({}), INBOX_DEFAULT_LIMIT);
  assert.equal(inboxLimit({ limit: 3 }), 3);
  assert.equal(inboxLimit({ limit: INBOX_MAX_LIMIT + 500 }), INBOX_MAX_LIMIT, 'the cap holds');
  for (const bad of [{ since: -1 }, { since: 1.5 }, { since: '2' }, { limit: 0 }, { limit: 'x' }]) {
    const fn = 'since' in bad ? () => inboxSince(bad, 0) : () => inboxLimit(bad);
    assert.throws(fn, (err: Error) => err.name === 'ToolError', JSON.stringify(bad));
  }
});

test('selectInboxFacts: a slice of one seq-ordered pass, with what it left behind', () => {
  const events: SettlementEvent[] = [
    { seq: 1, at: 1_000, taskId: 'task-1', pane: 'p1', turn: 1, kind: 'settled' },
    { seq: 2, at: 2_000, taskId: 'task-2', pane: 'p2', turn: null, kind: 'spawned' },
    { seq: 3, at: 3_000, taskId: 'task-3', pane: 'p3', turn: 1, kind: 'failed' },
    { seq: 4, at: 4_000, taskId: 'task-4', pane: 'p4', turn: 1, kind: 'settled' },
  ];
  const plan = selectInboxFacts({ events, since: 0, limit: 2 });
  assert.deepEqual(plan.facts.map((e) => e.seq), [1, 3], 'the settlements, in order, up to the limit');
  assert.equal(plan.more, 1, 'the settlement it left is counted');
  assert.equal(plan.notSettlements, 1, 'and the fact with no delivery is accounted for, not hidden');
});

test('planInbox: a fact with no body still names the read, and never the seq of another fact', () => {
  const fact = (seq: number, body: InboxFact['body']): InboxFact => ({
    event: { seq, at: 1_000 * seq, taskId: `task-${seq}`, pane: `p-w${seq}`, turn: 1, kind: 'settled' },
    description: `fase ${seq}`,
    body,
  });
  const plan = planInbox({
    since: 0,
    facts: [fact(1, { kind: 'absent' }), fact(2, { kind: 'unavailable' })],
    more: 0,
    ledger: { file: '/tmp/settlement-sess.jsonl', lastSeq: 2, torn: false },
  });
  assert.deepEqual(plan.seqs, [1, 2], 'only the facts it carried may be crossed');
  assert.match(plan.text, /#1 · p-w1 · fase 1 · settled · no report/);
  assert.match(plan.text, /#2 · p-w2 · fase 2 · settled · no report/);
  assert.match(plan.text, /the core did not answer, so nothing was established/);
});

/* ── the action is wired, not only planned ────────────────────── */

test('subagent(action:"inbox") reads the session\'s own ledger at the call\'s checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piher-inbox-plugin-'));
  try {
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(join(dir, '.piher', 'tasks'), { recursive: true });
    const file = join(dir, '.piher', 'tasks', 'settlement-sess-inbox.jsonl');
    const fact: SettlementEvent = {
      seq: 1, at: AT[0]!, taskId: 'task-1', pane: 'p-w1', turn: 1, kind: 'settled',
      payloadRef: 'piher.rep.p-w1',
    };
    writeFileSync(file, `${formatSettlementEvent(fact)}\n`);
    const client = await coreWith({ 'piher.rep.p-w1': report('task-1', 'the report from the file', AT[0]!) });
    const { pi, root } = await mountSubagent({ client, deps: { getSessionId: () => 'sess-inbox' } });
    try {
      const result = await runSubagent(pi, { action: 'inbox', since: 0 }, dir);
      const text = textOf(result);
      assert.ok(text.includes('#1 · p-w1 · '), 'the fact written by an earlier process is answered');
      assert.ok(text.includes('the report from the file'), 'with its body, from the document');
      assert.ok(text.includes(file), 'and the answer names the ledger it read');
      assert.deepEqual(detailsOf(result).returned, [1]);
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
