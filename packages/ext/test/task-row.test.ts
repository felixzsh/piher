/** Task rows: predicates, the tolerant envelope parser, slugs, and the memory index. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateTaskSlug, applyReportedSessionFile, describeTaskState, isActionable, isClosed, isSpent,
  normalizeEntryKind, parseTaskDocument, parseTaskRow, slugifyTask, taskForPane, taskRef, toTaskRow,
  type TaskRow,
} from '../src/task-row.ts';
import { taskRow } from './test-utils.ts';

const row = (over: Parameters<typeof taskRow>[0] = {}): TaskRow => toTaskRow(taskRow(over));

test('predicates: closed, spent and actionable derive from the durable facts alone', () => {
  assert.equal(isClosed(row({ closedAt: null })), false);
  assert.equal(isClosed(row({ closedAt: 7 })), true);
  assert.equal(isSpent(row({ lifecycle: 'one-shot', consumedAt: 9 })), true);
  assert.equal(isSpent(row({ lifecycle: 'one-shot' })), false);
  const persistentRow = row({ consumedAt: 9 });
  assert.equal(isSpent(persistentRow), false, 'a persistent row is never spent');
  assert.equal(isActionable(row({})), true);
  assert.equal(isActionable(row({ closedAt: 1 })), false);
  assert.equal(isActionable(row({ lifecycle: 'one-shot', consumedAt: 1 })), false);
});

test('describeTaskState: the four state texts from predicates plus observation', () => {
  const live = { paneExists: true, agentStatus: 'working' };
  const blocked = { paneExists: true, agentStatus: 'blocked' };
  const idleAgent = { paneExists: true, agentStatus: 'idle' };
  const gone = { paneExists: false, agentStatus: null };
  assert.equal(describeTaskState(row({}), live), 'running', 'a turn in flight reads running');
  assert.equal(describeTaskState(row({}), blocked), 'running', 'a blocked turn is still in flight');
  assert.equal(describeTaskState(row({}), idleAgent), 'no report', 'no turn, no report consumed');
  const delivered = row({ consumedAt: 9 });
  assert.equal(describeTaskState(delivered, idleAgent), 'idle', 'a consumed report reads idle');
  assert.equal(describeTaskState(row({}), gone), 'no pane', 'a gone pane reads no pane');
  assert.equal(describeTaskState(delivered, gone), 'no pane', 'gone wins over consumed');
  assert.equal(describeTaskState(row({})), 'running', 'zero-observation base of a fresh spawn');
  assert.equal(describeTaskState(delivered), 'idle', 'zero-observation base of a delivery');
});

test('parseTaskRow: a row without a taskId is not a row; the rest defaults, never raises', () => {
  assert.equal(parseTaskRow(null), null);
  assert.equal(parseTaskRow([{ taskId: 'x' }]), null);
  assert.equal(parseTaskRow({ description: 'no id' }), null);
  const minimal = parseTaskRow({ taskId: 't1' })!;
  assert.equal(minimal.kind, 'task');
  assert.equal(minimal.lifecycle, 'persistent');
  assert.equal(minimal.closedAt, null);
  assert.equal(minimal.gen.paneId, '');
  assert.deepEqual(minimal.gen.launchCommand, []);
  assert.equal(parseTaskRow({ taskId: 't1', kind: 'resident', lifecycle: 'forever' })?.kind,
    'task');
  assert.equal(parseTaskRow({ taskId: 't1', lifecycle: 'forever' })?.lifecycle, 'persistent');
  assert.equal(parseTaskRow({ taskId: 't1', lifecycle: 'one-shot' })?.lifecycle, 'one-shot');
  const delivered = parseTaskRow({
    taskId: 't1',
    gen: { paneId: 'p1', reportDelivered: { fingerprint: 'tail', at: 5 } },
  })!;
  assert.deepEqual(delivered.gen.reportDelivered, { fingerprint: 'tail', at: 5 });
  const malformed = parseTaskRow({ taskId: 't1', gen: { reportDelivered: { fingerprint: 3 } } });
  assert.equal(malformed?.gen.reportDelivered, null);
});

test('parseTaskDocument: both envelopes share one tolerant reader', () => {
  assert.deepEqual(parseTaskDocument(null), { rows: [], taskIds: [] });
  assert.deepEqual(parseTaskDocument('torn{'), { rows: [], taskIds: [] });
  const future = parseTaskDocument({ version: 2, rows: [{ taskId: 't1' }] });
  assert.deepEqual(future, { rows: [], taskIds: [] }, 'a future version is foreign, not an error');
  assert.deepEqual(parseTaskDocument({ version: 1, rows: 'nope' }), { rows: [], taskIds: [] });
  const doc = parseTaskDocument({
    version: 1,
    rows: [{ taskId: 't1' }, { description: 'no id' }, { taskId: '', gen: {} }],
    taskIds: ['t1', '', 42, 't1'],
  });
  assert.equal(doc.rows.length, 1);
  assert.equal(doc.rows[0]!.taskId, 't1');
  assert.deepEqual(doc.taskIds, ['t1'], 'ids stay ordered, blank and duplicate ids go');
});

test('toTaskRow: the transient memory state never reaches the document', () => {
  const entry = taskRow({
    settleWindowStartedAt: 12, noticeAnnounced: { fingerprint: 'f', at: 3 },
  });
  const durable = toTaskRow(entry);
  const leaked = ['settleWindowStartedAt', 'noticeAnnounced'].filter((k) => k in durable);
  assert.deepEqual(leaked, [], 'no transient field reaches the document');
  assert.equal(durable.taskId, entry.taskId);
  assert.equal(durable.gen.paneId, entry.gen.paneId);
});

test('slugs: kebab-case, non-ASCII fallback, dedupe, display form', () => {
  assert.equal(slugifyTask('Fix Auth Flow!'), 'fix-auth-flow');
  assert.equal(slugifyTask('a'.repeat(40)), 'a'.repeat(24));
  assert.equal(allocateTaskSlug('fix auth', 'taskid', new Set(['fix-auth'])), 'fix-auth-2');
  assert.equal(allocateTaskSlug('中文', '9faaa0e5-rest', new Set()), 'task-9faaa0');
  assert.equal(taskRef({ paneId: 'p2', slug: 'fix-auth' }), 'fix-auth@p2');
  assert.equal(taskRef({ paneId: 'p2', slug: '' }), 'p2');
});

test('applyReportedSessionFile + normalizeEntryKind: the moved guards keep their contract', () => {
  assert.equal(applyReportedSessionFile(null, 'w.jsonl'), 'w.jsonl');
  assert.equal(applyReportedSessionFile('a.jsonl', 'bare-id'), 'a.jsonl', 'a bare id never wins');
  assert.equal(applyReportedSessionFile('a.jsonl', null), 'a.jsonl');
  assert.equal(normalizeEntryKind('short'), 'task');
  assert.equal(normalizeEntryKind('resident'), 'task');
  assert.equal(normalizeEntryKind(undefined), 'task');
  assert.equal(normalizeEntryKind('reviewer'), 'reviewer');
});

test('taskForPane: a pane resolves through its task, a dead id misses', () => {
  const entry = taskRow({ taskId: 't1', paneId: 'p1' });
  const tasks = new Map([['t1', entry]]);
  const panes = new Map([['p1', 't1']]);
  assert.equal(taskForPane(tasks, panes, 'p1'), entry);
  assert.equal(taskForPane(tasks, panes, 'p-gone'), undefined);
  assert.equal(taskForPane(tasks, new Map(), 'p1'), undefined, 'no index, no row');
});
