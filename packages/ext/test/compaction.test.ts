/**
 * E8: piher's state survives the master compacting its conversation.
 *
 * pi's compaction is a PREFIX operation (`docs/compaction.md`): everything before `firstKeptEntryId`
 * is replaced by a summary, and the extension hooks bracket it. Two properties are asserted here, and
 * both fail on the base commit:
 *
 * - a settlement announced while the summary is being written is delivered AFTER the cut, and nothing
 *   piher says is handed to pi inside the span being summarized;
 * - the fresh context is told who is still alive and unsettled, from the records (`compact-roster.ts`)
 *   — not from a conversation that no longer exists.
 *
 * The last test mounts the real composition root: the wiring in `index.ts` is the part a pure test
 * cannot vouch for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension from '../src/index.ts';
import {
  collectRosterTasks,
  planCompactRoster,
  ROSTER_MAX_BYTES,
  ROSTER_MAX_LINES,
  type RosterTask,
} from '../src/compact-roster.ts';
import { createCompactionGate } from '../src/compaction-gate.ts';
import { createNoticeBuffer, type NoticeRow } from '../src/index-notices.ts';
import type { SettlementEvent } from '../src/settlement-ledger.ts';
import { fakePi, fire, mountSubagent, taskRow, withCleanup, type CleanupContext, type FakePi } from './test-utils.ts';

const ROSTER_HEADER = /\[piher after compaction · from the records, not from the conversation:/;

/* ── the gate: nothing crosses the cut, and the records are re-stated after it ── */

const row = (pane: string, bytes = 20): NoticeRow => ({
  id: pane,
  description: `fase ${pane}`,
  outcome: 'settled',
  body: `${pane}: ${'x'.repeat(Math.max(0, bytes - pane.length - 2))}`,
});

/** A buffer over an observable sink, with the agent's own busy flag the gate reads as well. */
function harness(roster: string | null = '[piher after compaction · from the records, not from the conversation: 0 running · 0 settled-unread · 0 failed]') {
  const sent: string[] = [];
  let agentActive = false;
  const buffer = createNoticeBuffer({
    isBusy: () => agentActive,
    send: async (content) => { sent.push(content); },
  });
  const gate = createCompactionGate({
    buffer,
    roster: () => roster,
    isBusy: () => agentActive,
  });
  return { sent, buffer, gate, setBusy: (v: boolean) => { agentActive = v; } };
}

test('E8: a settlement announced inside a compaction is delivered after the cut, never into the prefix', async () => {
  const h = harness();
  // The master is mid-turn and a worker settles: buffered, as always.
  h.setBusy(true);
  await h.buffer.deliverNotice('settled tA (fase tA) — report attached', 'tA', null, undefined, row('tA'));
  // The turn ends and pi starts compacting: it is idle, which is exactly why the pause exists.
  h.setBusy(false);
  h.gate.before();
  assert.equal(h.gate.compacting(), true);
  // A second worker settles while the prefix is being summarized.
  await h.buffer.deliverNotice('settled tB (fase tB) — report attached', 'tB', null, undefined, row('tB'));
  // Even a turn boundary must not flush across the cut.
  await h.buffer.flush('followUp');
  assert.deepEqual(h.sent, [], 'nothing piher says lands inside the span being summarized');
  assert.deepEqual([...h.buffer.noticePending()].sort(), ['tA', 'tB'], 'both panes stay GC-exempt while held');

  await h.gate.after();
  assert.equal(h.sent.length, 1, 'the cut is the boundary: one message afterwards');
  const after = h.sent[0]!;
  assert.match(after, /tA/, 'the settlement from before the cut survived it');
  assert.match(after, /tB/, 'and the one announced during it');
  assert.match(after, ROSTER_HEADER, 'the fresh context is told the state, from the records');
  assert.equal(h.buffer.noticePending().size, 0, 'and both are delivered, so both panes are released');
  assert.equal(h.gate.compacting(), false);
});

test('E8: a failed or cancelled compaction cut nothing, so nothing is re-stated — only released', async () => {
  const h = harness();
  h.gate.before();
  await h.buffer.deliverNotice('settled tC (fase tC) — report attached', 'tC', null, undefined, row('tC'));
  h.gate.failed();
  assert.equal(h.gate.compacting(), false);
  assert.deepEqual(h.sent, [], 'the roster would lie about a context that was never cut');
  await h.buffer.flush('followUp');
  assert.equal(h.sent.length, 1, 'the held settlement is released as the ordinary delivery it was');
  assert.match(h.sent[0]!, /tC/);
  assert.doesNotMatch(h.sent[0]!, ROSTER_HEADER);
});

test('E8: a busy master keeps the roster and its settlements held until its own turn boundary', async () => {
  const h = harness();
  h.gate.before();
  await h.buffer.deliverNotice('settled tD (fase tD) — report attached', 'tD', null, undefined, row('tD'));
  h.setBusy(true); // an overflow recovery: the run continues after the cut
  await h.gate.after();
  assert.deepEqual(h.sent, [], 'pi queues a follow-up behind a running turn; the buffer waits instead');
  h.setBusy(false);
  await h.buffer.flush('followUp');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /tD[\s\S]*from the records/, 'the roster rode the same message, in order');
});

test('E8: a session_compact with no before re-states nothing (a hook mounted mid-compaction)', async () => {
  const h = harness();
  await h.gate.after();
  assert.deepEqual(h.sent, []);
});

/* ── the roster: from the records, bounded, and naming what is waiting ── */

const live = (n: number, description = `fase ${n}`) => ({
  taskId: `task-${n}`,
  paneId: `t${n}`,
  description,
  startedAt: 1_000,
});

const fact = (n: number, over: Partial<SettlementEvent> = {}): SettlementEvent => ({
  seq: n,
  at: 5_000,
  taskId: `task-${n}`,
  pane: `t${n}`,
  turn: 1,
  kind: 'settled',
  ...over,
});

test('E8: the roster names a live worker and a settled-unread one, and counts what failed', () => {
  const tasks = collectRosterTasks({
    live: [live(1, 'implementa el gate'), live(2, 'mira el contrato'), live(3, 'lanza la suite')],
    events: [
      // Below the cursor: a settlement the master already acted on is not waiting for anything.
      fact(1, { taskId: 'task-1', pane: 't1' }),
      fact(4, { taskId: 'task-2', pane: 't2' }),
      fact(5, { taskId: 'task-3', pane: 't3', kind: 'failed' }),
    ],
    deliveredSeq: 3,
    now: 5_000 + 4 * 60_000,
  });
  assert.deepEqual(tasks.map((t) => [t.paneId, t.state]).sort(), [
    ['t1', 'running'],
    ['t2', 'settled-unread'],
    ['t3', 'failed'],
  ], 'a task with an unread fact is settled-unread (or failed), never running');
  const text = planCompactRoster(tasks);
  assert.match(text, /^\[piher after compaction · from the records, not from the conversation:/);
  assert.match(text, /1 running · 1 settled-unread · 1 failed/);
  assert.match(text, /t2 · settled-unread 4m · mira el contrato — its settlement is waiting, not lost/);
  assert.match(text, /t3 · failed 4m · lanza la suite — it failed; its report names why/);
  assert.match(text, /t1 · running 4m · implementa el gate — still running/);
  assert.match(text, /subagent\(action:"inbox"\)/, 'the master is told how to read what is waiting');
});

test('E8: a settled-unread worker whose record was swept is still named — the ledger outlives records', () => {
  const tasks = collectRosterTasks({
    live: [],
    events: [fact(1, { taskId: 'task-9', pane: 't9' })],
    deliveredSeq: 0,
    now: 5_000,
  });
  assert.deepEqual(tasks, [{ paneId: 't9', description: '', state: 'settled-unread', elapsedMs: 0 }]);
  assert.match(planCompactRoster(tasks), /t9 · settled-unread 0s · \(no description\)/);
});

test('E8: nothing to state is stated — the master cannot verify an empty roster by itself', () => {
  const text = planCompactRoster([]);
  assert.match(text, /^\[piher after compaction · from the records, not from the conversation:/);
  assert.match(text, /0 running · 0 settled-unread · 0 failed/);
  assert.match(text, /no worker of this session is live and nothing settled is waiting/);
});

test(`E8: thirty unsettled workers cost one bounded block (<= ${ROSTER_MAX_BYTES} B)`, () => {
  const tasks = collectRosterTasks({
    // Long briefs, thirty of them: the roster still may not become the session's most expensive message.
    live: Array.from({ length: 30 }, (_, i) => live(i + 1, `fase ${i + 1}: ${'describe el trabajo '.repeat(20)}`)),
    events: [],
    deliveredSeq: 0,
    now: 1_000 + 65 * 60_000,
  });
  const text = planCompactRoster(tasks);
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes <= ROSTER_MAX_BYTES, `thirty tasks cost ${bytes} B, over the ${ROSTER_MAX_BYTES} B ceiling`);
  assert.equal(text.split('\n').length, ROSTER_MAX_LINES + 2, 'a header, eight lines and the trailer');
  assert.match(text, /30 running · 0 settled-unread · 0 failed/, 'the count is never truncated');
  assert.match(text, /and 22 more unsettled: subagent\(action:"list"\) names every one/);
  assert.doesNotMatch(text, /describe el trabajo describe el trabajo describe el trabajo describe/, 'a brief is clipped to one line');
});

test('E8: the order is the order a master acts in — waiting first, then failures, then running', () => {
  const tasks: RosterTask[] = [
    { paneId: 'r1', description: 'a', state: 'running' },
    { paneId: 'f1', description: 'b', state: 'failed' },
    { paneId: 'u1', description: 'c', state: 'settled-unread' },
  ];
  const lines = planCompactRoster(tasks).split('\n');
  assert.match(lines[1]!, /u1 · settled-unread/);
  assert.match(lines[2]!, /f1 · failed/);
  assert.match(lines[3]!, /r1 · running/);
});

/* ── the wiring: the real composition root answers the compaction hooks ── */

type IndexMode = 'worker' | 'master';

async function mountIndex(cleanup: CleanupContext, mode: IndexMode): Promise<FakePi> {
  const env = cleanup.env();
  for (const key of [
    'PIHER_SUBAGENT', 'HC_TERMINAL_SOCKET', 'HC_TERMINAL_ID',
    'PIHER_ROLE_MANIFEST', 'PIHER_ROLE_BASE', 'PIHER_DELEGATION',
    'PI_SESSION_FILE', 'PI_SESSION_ID',
  ]) env.delete(key);
  if (mode === 'worker') env.set('PIHER_SUBAGENT', '1');
  else {
    env.set('HC_TERMINAL_SOCKET', '/tmp/piher-compaction-test.sock');
    env.set('HC_TERMINAL_ID', 't1');
  }
  const pi = fakePi();
  await extension(pi as never);
  return pi;
}

test('E8: index.ts mounts the compaction hooks — one roster per successful compaction, none on a failure', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'master');
  try {
    for (const hook of ['session_before_compact', 'session_compact', 'session_compact_failed']) {
      assert.ok((pi.listeners.get(hook) ?? []).length > 0, `${hook} is hooked`);
    }
    await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
    const before = pi.userSent.length;
    await fire(pi, 'session_before_compact', { reason: 'manual', preparation: {}, branchEntries: [] });
    assert.equal(pi.userSent.length, before, 'nothing is injected into the prefix');
    await fire(pi, 'session_compact', { reason: 'manual', fromExtension: false });
    assert.equal(pi.userSent.length, before + 1, 'one message after the cut');
    assert.match(pi.userSent.at(-1)!.content, ROSTER_HEADER);
    assert.deepEqual(pi.userSent.at(-1)!.opts, { deliverAs: 'followUp', triggerTurn: true });
    await fire(pi, 'session_compact_failed', { reason: 'manual', aborted: true });
    assert.equal(pi.userSent.length, before + 1, 'a cancelled compaction cut nothing, so nothing is re-stated');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

test('E8: a worker re-states nothing — it holds no delegation records to state', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker');
  try {
    await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
    const before = pi.userSent.length;
    await fire(pi, 'session_before_compact', { reason: 'threshold', preparation: {}, branchEntries: [] });
    await fire(pi, 'session_compact', { reason: 'threshold', fromExtension: false });
    assert.equal(pi.userSent.length, before, 'a worker has no roster, and an empty one would be noise');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

/** The plugin's own adapter: the port answers with the records' live rows, not with a guess. This
 *  pins the seam `index.ts` reads (`port.compactRoster`), so a rename cannot leave the roster dead. */
test('E8: the subagent port builds the roster from the session records', withCleanup(async () => {
  const tasks = [
    taskRow({ taskId: 'task-live', paneId: 'tLive', description: 'espera el informe' }),
    // A delivered report is settled, and a closed task is final: neither is "unsettled".
    taskRow({ taskId: 'task-read', paneId: 'tRead', description: 'ya entregado', consumedAt: 5 }),
    taskRow({ taskId: 'task-done', paneId: 'tDone', description: 'cerrado', closedAt: 9 }),
  ];
  const mounted = await mountSubagent({ tasks });
  try {
    const text = mounted.port.current!.compactRoster!();
    assert.match(text ?? '', ROSTER_HEADER);
    assert.match(text ?? '', /tLive · running 0s · espera el informe/);
    assert.match(text ?? '', /1 running · 0 settled-unread · 0 failed/);
    assert.doesNotMatch(text ?? '', /tRead|tDone/, 'a settled or closed task is not waiting for anything');
  } finally {
    await mounted.root.fiber.dispose();
  }
}));
