/**
 * E1's durable seam: the settlement ledger. The defect this file pins, verified in source (plan L14):
 * `handOver` announced a settlement and then stamped the row consumed, while the notice buffer holds
 * only RAM — so a settlement buffered while the master was busy, lost to a `/reload` or a crash, was
 * lost for good and `list` kept saying it had been delivered.
 *
 * The property is not "delivery is durable" but something narrower and checkable: the fact is written
 * before it is announced, the delivery is recorded only when pi accepted the message, and a restart
 * re-delivers what the record does not carry — at least once, deduplicated by `(taskId, at)`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  formatSettlementEvent, openSettlementLedger, parseSettlementCursor, parseSettlementLedger,
  planLedgerReplay, settlementKey, settlementLedgerPath, type SettlementEvent, type SettlementLedger,
} from '../src/settlement-ledger.ts';
import { createNoticeBuffer, type NoticeBuffer } from '../src/index-notices.ts';
import { createPoller, replaySettlements, type Poller, type PollerHost } from '../src/subagent-poller.ts';
import { describeTaskState, isSpent, parseTaskRow, toTaskRow, type TaskEntry } from '../src/task-row.ts';
import type { CoreClientLike } from '../src/core-client.ts';
import type { SessionIo } from '../src/subagent-session.ts';
import { fakeWatch, taskRow, terminalInfo } from './test-utils.ts';

/* ── the file format ────────────────────────────────────────────── */

const event = (over: Partial<SettlementEvent> = {}): SettlementEvent => ({
  seq: 1, at: 1_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled', ...over,
});

test('ledger format: one line per fact, fields in a fixed order, no field for what did not happen', () => {
  assert.equal(
    formatSettlementEvent(event()),
    '{"seq":1,"at":1000,"taskId":"task-a","pane":"pA","turn":1,"kind":"settled"}',
  );
  // A payload reference and a group ride only when they exist: a fact never carries a null it has to
  // be read past.
  assert.equal(
    formatSettlementEvent(event({ kind: 'pane-gone', turn: null, payloadRef: 'piher.rep.pA' })),
    '{"seq":1,"at":1000,"taskId":"task-a","pane":"pA","turn":null,"kind":"pane-gone","payloadRef":"piher.rep.pA"}',
  );
  assert.equal(settlementKey('task-a', 1_000), 'task-a:1000');
});

test('parseSettlementLedger: garbage, a repeat and a backwards seq are not facts; earlier ones survive', () => {
  const text = [
    formatSettlementEvent(event()),
    'not json at all',
    formatSettlementEvent(event({ seq: 2, at: 2_000, taskId: 'task-b', pane: 'pB' })),
    formatSettlementEvent(event({ seq: 2, at: 2_500, taskId: 'task-c', pane: 'pC' })), // same seq, dropped
    formatSettlementEvent(event({ seq: 1, at: 3_000, taskId: 'task-d', pane: 'pD' })), // backwards, dropped
    formatSettlementEvent(event({ seq: 3, at: 4_000, taskId: 'task-e', pane: 'pE', kind: 'closed' })),
  ].join('\n') + '\n';
  const parsed = parseSettlementLedger(text);
  assert.deepEqual(parsed.events.map((e) => `${e.seq}:${e.taskId}`), ['1:task-a', '2:task-b', '3:task-e']);
  assert.equal(parsed.lastSeq, 3);
  assert.equal(parsed.torn, false);
  assert.deepEqual(parseSettlementLedger(''), { events: [], lastSeq: 0, torn: false });
});

test('parseSettlementCursor: absent, torn or foreign reads 0 — a lost cursor re-delivers, never drops', () => {
  assert.equal(parseSettlementCursor('{"version":1,"deliveredSeq":7}'), 7);
  assert.equal(parseSettlementCursor('{"version":1,"deliveredSeq":'), 0);
  assert.equal(parseSettlementCursor('{"version":2,"deliveredSeq":7}'), 0);
  assert.equal(parseSettlementCursor('null'), 0);
});

/* ── the file: append, cursor, torn tail ───────────────────────── */

function tempFile(name = 'settlement-test.jsonl'): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'piher-ledger-'));
  return { path: join(dir, name), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ledger file: a fact appended is a fact a new process reads back, with its seq continuing', () => {
  const tmp = tempFile();
  try {
    const first = openSettlementLedger({ file: tmp.path });
    assert.equal(first.append({ at: 1_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'spawned' }).seq, 1);
    const settled = first.append({ at: 2_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled', payloadRef: 'piher.rep.pA' });
    assert.equal(settled.seq, 2);

    const reopened = openSettlementLedger({ file: tmp.path });
    assert.deepEqual(reopened.events().map((e) => e.kind), ['spawned', 'settled']);
    assert.equal(reopened.events()[1]!.payloadRef, 'piher.rep.pA');
    assert.equal(reopened.lastSeq(), 2);
    assert.equal(reopened.deliveredSeq(), 0, 'nothing was accepted, so nothing is delivered');
    assert.equal(reopened.append({ at: 3_000, taskId: 'task-b', pane: 'pB', turn: 1, kind: 'pane-gone' }).seq, 3);
  } finally {
    tmp.dispose();
  }
});

test('ledger file: one settlement appended twice keeps one line and one seq (a retry is the same fact)', () => {
  const tmp = tempFile();
  try {
    const ledger = openSettlementLedger({ file: tmp.path });
    const first = ledger.append({ at: 2_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled' });
    const again = ledger.append({ at: 2_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled' });
    assert.equal(again.seq, first.seq, 'the refused notice is retried under the same identity');
    assert.equal(ledger.lastSeq(), 1);
    assert.equal(readFileSync(tmp.path, 'utf8').trim().split('\n').length, 1);
    // A different settlement of the same task at a different `at` is its own fact.
    assert.equal(ledger.append({ at: 3_000, taskId: 'task-a', pane: 'pA', turn: 2, kind: 'settled' }).seq, 2);
  } finally {
    tmp.dispose();
  }
});

test('ledger file: the cursor is its own document, monotonic, and survives a re-open', () => {
  const tmp = tempFile();
  try {
    const ledger = openSettlementLedger({ file: tmp.path });
    ledger.append({ at: 1_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled' });
    ledger.append({ at: 2_000, taskId: 'task-a', pane: 'pA', turn: 2, kind: 'settled' });
    ledger.markDelivered(1);
    ledger.markDelivered(2);
    ledger.markDelivered(1); // never backwards
    assert.equal(ledger.deliveredSeq(), 2);
    assert.equal(parseSettlementCursor(readFileSync(`${tmp.path}.seq`, 'utf8')), 2);
    assert.equal(openSettlementLedger({ file: tmp.path }).deliveredSeq(), 2);
    // A cursor from a file that was replaced cannot hide the events that are actually there.
    appendFileSync(tmp.path, 'x');
    assert.equal(openSettlementLedger({ file: tmp.path }).deliveredSeq(), 2);
  } finally {
    tmp.dispose();
  }
});

test('ledger file: a torn tail costs the fragment and keeps every earlier settlement', () => {
  const tmp = tempFile();
  try {
    const first = openSettlementLedger({ file: tmp.path });
    first.append({ at: 1_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled' });
    first.append({ at: 2_000, taskId: 'task-b', pane: 'pB', turn: 1, kind: 'settled' });
    // A crash mid-append: half a line, no terminator.
    appendFileSync(tmp.path, '{"seq":3,"at":3000,"taskId":"task-c"');

    const reopened = openSettlementLedger({ file: tmp.path });
    assert.deepEqual(reopened.events().map((e) => e.taskId), ['task-a', 'task-b'], 'the two whole lines survive');
    assert.equal(reopened.lastSeq(), 2, 'the fragment never advances the seq');

    const next = reopened.append({ at: 4_000, taskId: 'task-d', pane: 'pD', turn: 1, kind: 'settled' });
    assert.equal(next.seq, 3, 'the fragment does not eat the next seq');
    const lines = readFileSync(tmp.path, 'utf8').split('\n');
    assert.equal(lines.length, 5, 'three lines, the fragment on its own line, and the empty tail');
    assert.deepEqual(
      openSettlementLedger({ file: tmp.path }).events().map((e) => e.taskId),
      ['task-a', 'task-b', 'task-d'],
      'the repaired boundary leaves the fragment unparseable, never glued to the next fact',
    );
  } finally {
    tmp.dispose();
  }
});

test('ledger path: beside the task records of the repository, named per session; nowhere outside git', () => {
  const tmp = tempFile('x');
  try {
    mkdirSync(join(tmp.path, '.git'), { recursive: true });
    const path = settlementLedgerPath(tmp.path, '01a1d237-e180-75f9-81fa-4ac642f1a592');
    assert.equal(path, join(tmp.path, '.piher', 'tasks', 'settlement-01a1d237-e180-75f9-81fa-4ac642f1a592.jsonl'));
    assert.ok(!path!.endsWith('.json'), 'the task-record reader must not mistake it for a record');
    // A session id cannot introduce a path: every separator is stripped, never resolved.
    const hostile = settlementLedgerPath(tmp.path, '../../etc');
    assert.equal(hostile, join(tmp.path, '.piher', 'tasks', 'settlement-....etc.jsonl'));
    assert.equal(settlementLedgerPath(tmp.path, ''), null);
  } finally {
    tmp.dispose();
  }
  const outside = { path: mkdtempSync(join(tmpdir(), 'piher-norepo-')), dispose() {} };
  try {
    assert.equal(settlementLedgerPath(outside.path, 'sess-1'), null, 'no repository, no ledger: memory only');
  } finally {
    rmSync(outside.path, { recursive: true, force: true });
  }
});

test('in memory: a session with nowhere to write behaves exactly as before, and still counts its seq', () => {
  const ledger = openSettlementLedger({ file: null });
  assert.equal(ledger.file, null);
  assert.equal(ledger.append({ at: 1_000, taskId: 'task-a', pane: 'pA', turn: 1, kind: 'settled' }).seq, 1);
  ledger.markDelivered(1);
  assert.equal(ledger.deliveredSeq(), 1);
});

/* ── replay planning (pure) ────────────────────────────────────── */

test('planLedgerReplay: after the cursor, minus what the records already carry, minus non-facts', () => {
  const events: SettlementEvent[] = [
    event({ seq: 1, at: 1_000, taskId: 'task-a' }),
    event({ seq: 2, at: 2_000, taskId: 'task-a' }), // accepted already: the crash-window duplicate
    event({ seq: 3, at: 3_000, taskId: 'task-b', kind: 'pane-gone' }),
    event({ seq: 4, at: 4_000, taskId: 'task-b', kind: 'spawned' }), // a recorded fact with no delivery
    event({ seq: 5, at: 5_000, taskId: 'task-c', pane: 'pC' }),
  ];
  const accepted: Record<string, number> = { 'task-a': 2_000, 'task-b': Number.POSITIVE_INFINITY };
  const plan = planLedgerReplay({
    events,
    deliveredSeq: 1,
    settledThroughAt: (taskId) => accepted[taskId] ?? -1,
  });
  assert.deepEqual(plan.map((e) => e.seq), [5], 'only the settlement nobody holds survives the plan');
  // With no cursor at all, everything a record does not hold is re-delivered.
  assert.deepEqual(
    planLedgerReplay({ events, deliveredSeq: 0, settledThroughAt: () => -1 }).map((e) => e.seq),
    [1, 2, 3, 5],
  );
  assert.deepEqual(
    planLedgerReplay({ events, deliveredSeq: 5, settledThroughAt: () => -1 }),
    [],
    'a cursor past every event replays nothing',
  );
});

/* ── the real poller, the real notice buffer, a restart ────────── */

// A report document is only readable at an address that can name one (lowercase, S9): a pane id
// with a capital in it has no document at all, which is the `absent` path, not a settlement.
const PANE = 'p-ship';
const TASK = 'task-settle';
const REPORT_AT = 13_000;
const REPORT_TEXT = 'REPORT: the fix is committed and two tests are green';

/**
 * The durable side of one process: the task record on disk, the ledger file, and the report document
 * in the core. A restart is a new process over the same three with nothing shared in memory — which
 * is the whole point, since the notice buffer is memory.
 */
interface World {
  records: Map<string, string>;
  docs: Map<string, unknown>;
  ledgerFile: string;
  now: number;
  /** What the test does between the loop's parks (a clock jump, ending the watch). */
  onPark: (() => boolean) | null;
  dispose(): void;
}

function createWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'piher-settle-'));
  const world: World = {
    records: new Map(),
    docs: new Map(),
    ledgerFile: join(dir, 'settlement-sess.jsonl'),
    now: REPORT_AT,
    onPark: null,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
  // The worker settled: its report document is in the core, exactly as a settle writes it.
  world.docs.set(`piher.rep.${PANE}`, {
    taskId: TASK, turn: 1, stopReason: 'stop', session: null, text: REPORT_TEXT, at: REPORT_AT,
  });
  // The record a spawn would have written: running, nothing delivered.
  const entry = taskRow({
    paneId: PANE, taskId: TASK, cwd: '/fake/cwd', description: 'ship the fix',
    createdAt: 10_000, lifecycle: 'one-shot',
  });
  world.records.set(TASK, JSON.stringify(toTaskRow(entry)));
  return world;
}

interface Booted {
  host: PollerHost;
  ledger: SettlementLedger;
  buffer: NoticeBuffer;
  /** The text pi accepted: what the master actually read. */
  accepted: string[];
  tasks: Map<string, TaskEntry>;
}

/** Start one process over a world: records read back from disk, a fresh buffer, the ledger reopened. */
function boot(world: World, opts: { busy: () => boolean }): Booted {
  const tasks = new Map<string, TaskEntry>();
  const panes = new Map<string, string>();
  for (const [taskId, text] of world.records) {
    const row = parseTaskRow(JSON.parse(text));
    if (!row) continue;
    tasks.set(taskId, row);
    if (row.gen.paneId) panes.set(row.gen.paneId, taskId);
  }
  const accepted: string[] = [];
  const buffer = createNoticeBuffer({
    isBusy: opts.busy,
    send: async (content) => { accepted.push(content); return true; },
  });
  const ledger = openSettlementLedger({ file: world.ledgerFile });
  const client = {
    available: true,
    getTerminal: async (id: string) => terminalInfo({ id, status: 'idle', turn: 1, labels: { 'herdr.tab': 't0' } }),
    listTerminals: async () => [terminalInfo({ id: PANE, status: 'idle', turn: 1, labels: {} })],
    watchChildren: () => fakeWatch({
      terminals: () => [terminalInfo({ id: PANE, status: 'idle', turn: 1, labels: { 'herdr.tab': 't0' } })],
      park: async (ms) => {
        world.now += ms;
        return world.onPark?.() ?? false;
      },
    }),
    docGet: async (name: string) => ({ value: world.docs.get(name) ?? null, version: world.docs.has(name) ? 1 : 0 }),
    kill: async () => {},
    remove: async () => {},
  } as unknown as CoreClientLike;

  const session = {
    readTurnClosing: async () => ({ text: null, why: null }),
    readAskFlag: async () => null,
    resolveSessionFile: async () => null,
    readSessionReport: async () => ({ kind: 'absent' } as const),
    reattributeStaleSessionFile: async () => null,
    probeAlive: async () => ({ paneExists: true, agentStatus: 'idle', lastActivityMs: 1 }),
  } satisfies SessionIo;

  const host: PollerHost = {
    client,
    sessionRoot: new Context(),
    tasks,
    panes,
    // What a restart reads back: the durable row, with the transient fields stripped.
    writeRecord: (e) => { world.records.set(e.taskId, JSON.stringify(toTaskRow(e))); },
    session,
    ledger,
    injectNotice: (content, paneId, card, onAccepted) => buffer.deliverNotice(content, paneId, card, onAccepted),
    now: () => world.now,
    policy: { subagentTimeoutMs: 3_600_000 },
  };
  return { host, ledger, buffer, accepted, tasks };
}

/** Run the real loop to its end. */
async function runLoop(booted: Booted, world: World): Promise<Poller> {
  const poller = createPoller(booted.host);
  // A settlement nobody accepted keeps the row unspent, so the loop has no natural end: the test
  // closes the row in memory once the notice is buffered (a close ends supervision, as it does live).
  // The cap is a safety net, not a step: without it a regression would leave the detached loop
  // parking forever and the whole suite hanging instead of failing.
  let parks = 0;
  world.onPark = () => {
    parks += 1;
    if (booted.buffer.noticePending().size > 0 || parks > 50) booted.tasks.get(TASK)!.closedAt = world.now;
    return false;
  };
  await poller.startPoller(PANE, '/tmp', 10_000, 'ship the fix');
  for (let i = 0; i < 5_000 && poller.pollers.size > 0; i += 1) await new Promise<void>((r) => setImmediate(r));
  assert.equal(poller.pollers.size, 0, 'the watch ended');
  world.onPark = null;
  return poller;
}

const recordOf = (world: World): TaskEntry => parseTaskRow(JSON.parse(world.records.get(TASK)!))!;

/** What the durable cursor says; a cursor never written is zero, not an error. */
const cursorOnDisk = (world: World): number => {
  try {
    return parseSettlementCursor(readFileSync(`${world.ledgerFile}.seq`, 'utf8'));
  } catch {
    return 0;
  }
};

test('E1 (a): a settlement the master never read is re-delivered exactly once after a restart', async () => {
  const world = createWorld();
  try {
    // ── process 1: the worker settles while the master is mid-turn ──
    const first = boot(world, { busy: () => true });
    await runLoop(first, world);

    assert.deepEqual(first.accepted, [], 'the master read nothing: the notice only reached the buffer');
    assert.equal(first.ledger.events().length, 1, 'the fact is written before it is announced');
    assert.equal(first.ledger.events()[0]!.kind, 'settled');
    assert.equal(first.ledger.events()[0]!.at, REPORT_AT);
    assert.equal(first.ledger.deliveredSeq(), 0, 'pi accepted nothing, so the cursor stays at zero');

    // ── (c) no readable state claims the delivery ──
    const before = recordOf(world);
    assert.equal(before.gen.consumedAt, null, 'the record never claims a delivery that did not happen');
    assert.equal(isSpent(before), false, 'one-shot spend waits for the master to read the report');
    assert.notEqual(describeTaskState(before), 'idle', 'the state text does not read as delivered');
    assert.equal(first.buffer.noticePending().size, 1, 'the pane stays GC-exempt while the notice is undelivered');

    // ── process 2: a `/reload` — the buffer is gone, the ledger is not ──
    const second = boot(world, { busy: () => false });
    assert.equal(second.ledger.events().length, 1, 'the ledger survived the restart');
    assert.equal(await replaySettlements(second.host), 1, 'exactly one re-delivery');
    assert.equal(second.accepted.length, 1, 'the master reads it exactly once');
    assert.match(second.accepted[0]!, /Re-delivered settlement \(piher ledger, seq 1, task task-settle\)/);
    assert.ok(second.accepted[0]!.includes(REPORT_TEXT), 'the body is read from the report document, not a copy');
    assert.match(second.accepted[0]!, /its notice never reached you/);
    assert.match(second.accepted[0]!, /this is the first delivery, not a new settlement/);

    const after = recordOf(world);
    assert.equal(after.gen.consumedAt, REPORT_AT, 'the accepted settlement is the one the row carries');
    assert.equal(isSpent(after), true, 'and only now is a one-shot spent');
    assert.equal(second.ledger.deliveredSeq(), 1, 'the cursor advances only now');

    // ── process 3: another start finds nothing left to deliver ──
    const third = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(third.host), 0, 'a delivered settlement is never re-delivered');
    assert.deepEqual(third.accepted, []);
  } finally {
    world.dispose();
  }
});

test('E1 (b): a settlement pi accepted before the restart is not delivered again', async () => {
  const world = createWorld();
  try {
    // The master is free: the notice goes straight through, so the ack is the delivery.
    const first = boot(world, { busy: () => false });
    await runLoop(first, world);

    assert.equal(first.accepted.length, 1, 'the master read the report before the restart');
    assert.match(first.accepted[0]!, /Background subagent p-ship \(ship the fix\) finished/);
    assert.equal(first.ledger.deliveredSeq(), 1, 'the cursor moved only because pi accepted');
    assert.equal(recordOf(world).gen.consumedAt, REPORT_AT);

    const second = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(second.host), 0);
    assert.deepEqual(second.accepted, [], 'what the master already read is not re-delivered');
  } finally {
    world.dispose();
  }
});

test('E1 (c): a notice the send refused stays undelivered, and the restart is what delivers it', async () => {
  // The buffer had the notice and pi refused the send (mid-turn, a host without the method): the entry
  // is put back, so the pane stays exempt and NOTHING recorded a delivery. Then the process dies.
  const world = createWorld();
  try {
    const first = boot(world, { busy: () => true });
    await runLoop(first, world);
    const refused = createNoticeBuffer({
      isBusy: () => false,
      send: async () => { throw new Error('pi is mid-turn'); },
    });
    first.host.injectNotice = (content, paneId, card, onAccepted) =>
      refused.deliverNotice(content, paneId, card, onAccepted);
    // The retry the next wake would make: refused again.
    await first.host.injectNotice('a settlement the master never saw', PANE);
    assert.equal(refused.noticePending().size, 1, 'a refused send keeps the pane exempt');
    assert.equal(recordOf(world).gen.consumedAt, null, 'and records no delivery');
    assert.equal(first.ledger.deliveredSeq(), 0);

    const second = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(second.host), 1, 'the ledger is what survives');
    assert.ok(second.accepted[0]!.includes(REPORT_TEXT));
  } finally {
    world.dispose();
  }
});

test('E1 (d): a crash between acceptance and the cursor write shows the master nothing twice', async () => {
  const world = createWorld();
  try {
    const first = boot(world, { busy: () => false });
    // The crash window, exactly: pi took the message and the record says so, but the process died
    // before the cursor document reached the disk.
    const lostCursor: SettlementLedger = {
      ...first.ledger,
      markDelivered: () => {},
    };
    first.host.ledger = lostCursor;
    await runLoop(first, world);

    assert.equal(first.accepted.length, 1, 'the master read the report once');
    assert.equal(recordOf(world).gen.consumedAt, REPORT_AT, 'the row survived the crash with its delivery');
    assert.equal(lostCursor.deliveredSeq(), 0, 'the cursor did not');

    const second = boot(world, { busy: () => false });
    assert.equal(second.ledger.deliveredSeq(), 0, 'the restart sees the same window');
    assert.equal(
      await replaySettlements(second.host),
      0,
      'the row already carries this settlement, so `(taskId, at)` deduplicates it',
    );
    assert.deepEqual(second.accepted, [], 'at most one duplicate is possible, and here it is zero');
  } finally {
    world.dispose();
  }
});

test('E1 (d): a settlement whose report document is gone is re-delivered as a pointer, not lost', async () => {
  // The dedupe must not become a silencer: when the record cannot prove the settlement was read and
  // the document was swept, the ledger still delivers the fact and names the call that recovers it.
  const world = createWorld();
  try {
    const first = boot(world, { busy: () => true });
    await runLoop(first, world);
    world.docs.delete(`piher.rep.${PANE}`); // the core's document is gone before the restart

    const second = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(second.host), 1);
    assert.match(second.accepted[0]!, /Its report document is no longer readable/);
    assert.match(second.accepted[0]!, /subagent\(action: "output", agentId p-ship\)/);
    assert.equal(recordOf(world).gen.consumedAt, REPORT_AT, 'the fact is delivered even without its body');
  } finally {
    world.dispose();
  }
});

/* ── the fact's own kind survives the replay (review #8) ──────── */

test('E1 (a): a replayed fact says what it was — a pane that went is not a document that was lost', async () => {
  // The silence budget and a pane that closed announce with no `payloadRef`: there is no document to
  // read, by construction. Saying "its report document is no longer readable" would invent one, and
  // would read as a settle that was merely lost instead of a worker that never settled.
  const world = createWorld();
  try {
    const out = boot(world, { busy: () => false });
    out.ledger.append({ at: 5_000, taskId: 'task-gone', pane: 'p-gone', turn: 1, kind: 'pane-gone' });
    out.ledger.append({ at: 6_000, taskId: 'task-quiet', pane: 'p-quiet', turn: 3, kind: 'failed' });

    const second = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(second.host), 2);
    const text = second.accepted[0]!;
    assert.doesNotMatch(text, /report document is no longer readable/, 'neither fact ever had a document');
    assert.match(text, /p-gone · .* · closed · no report/, 'a pane that went is closed, not a failure');
    assert.match(text, /p-quiet · .* · failed · no report/);
    // The lone-notice text is the batch of one; here both ride in one batch, so the diagnosis is what
    // the row's own wording has to keep — the replay must not claim a settle it cannot stand behind.
    assert.equal(second.ledger.deliveredSeq(), 2);
  } finally {
    world.dispose();
  }

  // And the text of a lone re-delivery: one fact, its own sentence.
  const loneWorld = createWorld();
  try {
    const out = boot(loneWorld, { busy: () => false });
    out.ledger.append({ at: 7_000, taskId: 'task-ghost', pane: 'p-ghost', turn: 2, kind: 'pane-gone' });
    const second = boot(loneWorld, { busy: () => false });
    assert.equal(await replaySettlements(second.host), 1);
    const text = second.accepted[0]!;
    assert.match(text, /Its pane was gone before it settled, so it never wrote a report/);
    assert.match(text, /ended at 1970-01-01T00:00:07.000Z/, 'a pane that went did not "settle"');

    const quiet = boot(loneWorld, { busy: () => false });
    assert.equal(await replaySettlements(quiet.host), 0, 'what the first restart recorded stays recorded');
    quiet.ledger.append({ at: 8_000, taskId: 'task-mute', pane: 'p-mute', turn: 1, kind: 'failed' });
    const third = boot(loneWorld, { busy: () => false });
    assert.equal(await replaySettlements(third.host), 1);
    assert.match(third.accepted[0]!, /Its wait ended with no report document at all/);
    assert.match(third.accepted[0]!, /this is NOT the task's result/);
  } finally {
    loneWorld.dispose();
  }
});

/* ── an identity that survives the roster (review #7) ─────────── */

test('E1 (a): a replay names the task, and says when the pane id belongs to another one', async () => {
  // The replay keys on `(taskId, at)`, but the notice named only the pane. A swept record plus a
  // reused pane id makes `agentId <pane>` resolve to the new task, so the read the notice prints
  // would return someone else's work as this settlement's.
  const world = createWorld();
  try {
    const out = boot(world, { busy: () => false });
    out.ledger.append({ at: 4_000, taskId: 'task-swept', pane: 'p-swept', turn: 1, kind: 'settled' });

    const second = boot(world, { busy: () => false });
    // What the roster says now: the swept task's pane id was reused by a task started since.
    second.host.panes.set('p-swept', 'task-new');
    assert.equal(await replaySettlements(second.host), 1);
    const text = second.accepted[0]!;
    assert.match(text, /Re-delivered settlement \(piher ledger, seq 1, task task-swept\)/);
    assert.match(text, /p-swept now belongs to another task/, 'the address is flagged, not trusted');
    assert.match(text, /returns that task's work, not this settlement \(task task-swept\)/);
  } finally {
    world.dispose();
  }

  // In a batch the replay's own wording rides in the row, so the task and the reuse have to be there.
  const batchWorld = createWorld();
  try {
    const out = boot(batchWorld, { busy: () => false });
    out.ledger.append({ at: 4_000, taskId: 'task-swept', pane: 'p-swept', turn: 1, kind: 'settled' });
    out.ledger.append({ at: 5_000, taskId: 'task-kept', pane: 'p-kept', turn: 1, kind: 'settled' });
    const second = boot(batchWorld, { busy: () => false });
    second.host.panes.set('p-swept', 'task-new');
    assert.equal(await replaySettlements(second.host), 2);
    const text = second.accepted[0]!;
    assert.match(text, /re-delivered from the piher ledger \(seq 1, task task-swept\); its pane p-swept/);
    assert.match(text, /now belongs to another task/);
    assert.match(text, /re-delivered from the piher ledger \(seq 2, task task-kept\): this is its first delivery/);
    assert.doesNotMatch(text, /task-kept; its pane/, 'a pane the task still owns is not warned about');
  } finally {
    batchWorld.dispose();
  }
});

/* ── the cursor as a prefix, and one batch per restart ─────────── */

test('E1 (a): an acceptance out of order does not hide the settlement below it', () => {
  // Acceptances do not arrive in seq order: a refused notice is requeued and retried while a later
  // fact's acceptance goes out. A cursor that jumped to the highest accepted seq would step over the
  // gap, and the seq below it would never be replayed.
  const world = createWorld();
  try {
    const first = boot(world, { busy: () => false });
    const early = first.ledger.append({ at: 1_000, taskId: 'task-early', pane: 'p-early', turn: 1, kind: 'settled' });
    const late = first.ledger.append({ at: 2_000, taskId: 'task-late', pane: 'p-late', turn: 1, kind: 'settled' });
    first.ledger.markDelivered(late.seq);
    assert.equal(early.seq, 1);
    assert.equal(late.seq, 2);
    assert.equal(first.ledger.deliveredSeq(), 0, 'the cursor does not cross a gap that is still open');
    assert.equal(cursorOnDisk(world), 0, 'and the durable cursor says the same');

    // ── a restart ──
    const second = boot(world, { busy: () => false });
    assert.equal(second.ledger.deliveredSeq(), 0, 'the restart sees the same open gap');
    assert.deepEqual(
      planLedgerReplay({
        events: second.ledger.events(),
        deliveredSeq: second.ledger.deliveredSeq(),
        settledThroughAt: () => -1,
      }).map((e) => e.seq),
      [early.seq, late.seq],
      'the settlement nobody accepted is still delivered after the restart',
    );

    // Once the gap closes here, the cursor crosses it — and it never goes back. The acceptance the
    // dead process made for seq 2 is not remembered across the restart (only the prefix is durable),
    // so seq 2 is delivered again: at-least-once, never a loss.
    second.ledger.markDelivered(early.seq);
    assert.equal(second.ledger.deliveredSeq(), early.seq);
    second.ledger.markDelivered(late.seq);
    assert.equal(second.ledger.deliveredSeq(), late.seq);
    second.ledger.markDelivered(early.seq);
    assert.equal(second.ledger.deliveredSeq(), late.seq, 'still monotonic');
    assert.equal(cursorOnDisk(world), late.seq);
  } finally {
    world.dispose();
  }
});

test('E1 (a): one delivery is one cursor step — a batch is written whole or not at all', () => {
  // The duplicate bound the ledger documents ("at most one each") is only true if a message pi took
  // as one message is recorded as one step. Recording it notice by notice would leave the rest of a
  // batch pi already read above the cursor, and the next start would show it again.
  const dir = mkdtempSync(join(tmpdir(), 'piher-batch-'));
  const file = join(dir, 'settlement-batch.jsonl');
  const cursorAt = (path: string): number => {
    try {
      return parseSettlementCursor(readFileSync(path, 'utf8'));
    } catch {
      return 0;
    }
  };
  try {
    const ledger = openSettlementLedger({ file });
    const one = ledger.append({ at: 1_000, taskId: 'task-one', pane: 'p-one', turn: 1, kind: 'settled' });
    const two = ledger.append({ at: 2_000, taskId: 'task-two', pane: 'p-two', turn: 1, kind: 'settled' });
    const batch = ledger.openBatch();
    ledger.markDelivered(one.seq);
    ledger.markDelivered(two.seq);
    assert.equal(ledger.deliveredSeq(), two.seq, 'both acceptances are in memory');
    assert.equal(cursorAt(`${file}.seq`), 0, 'and none of them is on disk yet: the window is the step');
    batch.end();
    assert.equal(cursorAt(`${file}.seq`), two.seq, 'the whole batch lands in one write');
    batch.end();
    assert.equal(cursorAt(`${file}.seq`), two.seq, 'ending a batch twice is not a second step');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E1 (a): an acceptance captured against the previous file moves no cursor (repoint)', () => {
  // `repoint` relaunches the ledger on another repository (a checkpoint moved the checkout) and
  // re-reads it. A notice buffered against the old file can still be accepted afterwards, and its
  // seq is the old file's — the new one's seq 1 may be another task's settlement.
  const dir = mkdtempSync(join(tmpdir(), 'piher-repoint-'));
  const from = join(dir, 'settlement-from.jsonl');
  const to = join(dir, 'settlement-to.jsonl');
  const cursorAt = (path: string): number => {
    try {
      return parseSettlementCursor(readFileSync(path, 'utf8'));
    } catch {
      return 0;
    }
  };
  try {
    const ledger = openSettlementLedger({ file: from });
    const stale = ledger.append({ at: 1_000, taskId: 'task-old', pane: 'p-old', turn: 1, kind: 'settled' });
    const epochBefore = ledger.epoch();
    ledger.repoint(to);
    assert.notEqual(ledger.epoch(), epochBefore, 'another file is another epoch');
    const fresh = ledger.append({ at: 2_000, taskId: 'task-new', pane: 'p-new', turn: 1, kind: 'settled' });
    assert.equal(fresh.seq, stale.seq, 'the two files number their facts independently: this is the trap');

    ledger.markDelivered(stale.seq, epochBefore);
    assert.equal(ledger.deliveredSeq(), 0, 'a seq minted for another file is not a fact about this one');
    assert.equal(cursorAt(`${to}.seq`), 0);

    // What the epoch prevents, said out loud: the same call without it is indistinguishable from
    // this file's own seq 1 — the base defect — and steps over a fact it never delivered.
    ledger.markDelivered(stale.seq);
    assert.equal(ledger.deliveredSeq(), fresh.seq, 'unguarded, the stale seq marks the new file delivered');
    ledger.markDelivered(fresh.seq, ledger.epoch());
    assert.equal(ledger.deliveredSeq(), fresh.seq, 'and the cursor stays monotonic');
    assert.equal(cursorAt(`${to}.seq`), fresh.seq);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E1 (a): an acceptance that lands after a repoint records no cursor in the new file', async () => {
  // The buffered notice is the real case: a steer reaches the master only while it is busy, so the
  // acceptance can arrive after the session's checkout moved and the ledger re-pointed. Its seq is
  // the old file's fact; recording it would mark the new file's seq accepted without delivering it.
  const world = createWorld();
  const cursorAt = (file: string): number => {
    try {
      return parseSettlementCursor(readFileSync(`${file}.seq`, 'utf8'));
    } catch {
      return 0;
    }
  };
  try {
    const held: Array<() => void> = [];
    const first = boot(world, { busy: () => false });
    const deliver = first.host.injectNotice;
    first.host.injectNotice = (content, paneId, card, onAccepted, row) => {
      // pi took the message; whether the acceptance is recorded is what this test withholds.
      if (onAccepted) held.push(onAccepted);
      return deliver(content, paneId, card, undefined, row);
    };
    await runLoop(first, world);
    assert.equal(first.ledger.events().length, 1, 'the fact is in the file the notice was announced for');
    assert.equal(held.length, 1, 'pi has the notice, its acceptance is still in flight');

    const moved = join(dirname(world.ledgerFile), 'settlement-moved.jsonl');
    first.ledger.repoint(moved);
    const other = first.ledger.append({ at: 9_000, taskId: 'task-other', pane: 'p-other', turn: 1, kind: 'settled' });

    held[0]!();
    assert.equal(first.ledger.deliveredSeq(), 0, 'the stale acceptance moved no cursor');
    assert.equal(cursorAt(moved), 0, 'and nothing was written for the new file');
    // The moved file's own fact is still above the cursor, so this process (and the next) replays it.
    assert.ok(other.seq > first.ledger.deliveredSeq());
  } finally {
    world.dispose();
  }
});

test('E1 (a): a restart carries every undelivered settlement in one delivery, and the cursor follows it', async () => {
  // At a start the master is idle, so a notice injected per event goes out alone with its own turn:
  // N settlements for N turns. The replay plans the same batch the live path plans — a row per
  // settlement, the bodies budgeted, one pointer for what was withheld — and hands it over once.
  const world = createWorld();
  try {
    const out = boot(world, { busy: () => false });
    out.ledger.append({
      at: 1_000, taskId: 'task-one', pane: 'p-one', turn: 1, kind: 'settled', payloadRef: 'piher.rep.p-one',
    });
    out.ledger.append({ at: 2_000, taskId: 'task-two', pane: 'p-two', turn: 1, kind: 'settled' });
    out.ledger.append({ at: 3_000, taskId: 'task-three', pane: 'p-three', turn: 1, kind: 'failed' });
    // Only the first settlement's document still holds exactly that settlement.
    world.docs.set('piher.rep.p-one', {
      taskId: 'task-one', turn: 1, stopReason: 'stop', session: null, text: 'ONE: the first conclusion', at: 1_000,
    });

    const second = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(second.host), 3, 'three settlements were carried');
    assert.equal(second.accepted.length, 1, 'in one delivery: not one message and one turn per settlement');
    const text = second.accepted[0]!;
    for (const id of ['p-one', 'p-two', 'p-three']) {
      assert.ok(text.includes(`${id} · `), `every settlement is named in the batch: ${id}`);
    }
    assert.ok(text.includes('ONE: the first conclusion'), 'a body whose document still matches travels inline');
    assert.match(text, /re-delivered from the piher ledger \(seq 1, task task-one\): this is its first delivery/);
    assert.match(text, /re-delivered from the piher ledger \(seq 3, task task-three\)/, 'the replay wording rides in the row');
    assert.ok(text.includes('subagent(action:"output", agentId:"p-two")'), 'the absent body names its own read');
    assert.equal(second.ledger.deliveredSeq(), 3, 'the cursor follows what the delivery carried');

    const third = boot(world, { busy: () => false });
    assert.equal(await replaySettlements(third.host), 0, 'nothing is re-delivered twice');
    assert.deepEqual(third.accepted, []);
  } finally {
    world.dispose();
  }

  // A refused batch carries nothing, so it records nothing: every seq stays above the cursor.
  const refusedWorld = createWorld();
  try {
    const out = boot(refusedWorld, { busy: () => false });
    out.ledger.append({ at: 1_000, taskId: 'task-one', pane: 'p-one', turn: 1, kind: 'settled' });
    out.ledger.append({ at: 2_000, taskId: 'task-two', pane: 'p-two', turn: 1, kind: 'settled' });
    const second = boot(refusedWorld, { busy: () => false });
    second.host.injectNotice = async () => { throw new Error('pi is mid-turn'); };
    assert.equal(await replaySettlements(second.host), 0);
    assert.deepEqual(second.accepted, []);
    assert.equal(second.ledger.deliveredSeq(), 0, 'a batch nobody took advances no cursor');
  } finally {
    refusedWorld.dispose();
  }
});
