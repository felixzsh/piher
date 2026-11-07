/** The task document store: atomic writes, tolerant reads, one writer per document. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskDocument } from '../src/task-row.ts';
import { sessionStatePath } from '../src/session-state.ts';
import {
  deleteTaskRecord, listTaskRecords, readTaskRecord, readTaskView, repoTasksDir,
  seedTaskView, taskRecordPath, TASK_VIEW_NAME, writeTaskRecord, writeTaskView,
} from '../src/task-store.ts';
import { taskRow } from './test-utils.ts';

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'piher-store-repo-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
};

const sessionFile = (): string =>
  join(mkdtempSync(join(tmpdir(), 'piher-store-sess-')),
    '2026-01-01T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000000.jsonl');

test('record round-trip: one row inside the shared envelope, read back whole', () => {
  const dir = repo();
  try {
    const entry = taskRow({ taskId: 'task-1', paneId: 'p1', cwd: dir, description: 'probe' });
    assert.equal(writeTaskRecord(dir, entry), true);
    const file = taskRecordPath(repoTasksDir(dir)!, 'task-1');
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { version: number; rows: unknown[] };
    assert.equal(envelope.version, 1);
    assert.equal(envelope.rows.length, 1, 'a record file holds exactly one row');
    const row = readTaskRecord(dir, 'task-1')!;
    assert.equal(row.taskId, 'task-1');
    assert.equal(row.description, 'probe');
    assert.equal(row.gen.paneId, 'p1');
    assert.ok(!('status' in row), 'the transient turn state is not durable');
    assert.ok(!existsSync(`${file}.tmp`), 'no tmp file survives the atomic write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record reads: missing, torn, foreign and mismatched documents are no record', () => {
  const dir = repo();
  try {
    assert.equal(readTaskRecord(dir, 'absent'), null, 'missing reads as no record');
    const noRepo = readTaskRecord('/no-such-checkout-xyz', 'absent');
    assert.equal(noRepo, null, 'no repository, no record');
    const file = taskRecordPath(repoTasksDir(dir)!, 'torn');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{"version": 1, "rows": [');
    assert.equal(readTaskRecord(dir, 'torn'), null, 'torn reads as no record');
    writeFileSync(file, JSON.stringify({ version: 2, rows: [{ taskId: 'torn' }] }));
    assert.equal(readTaskRecord(dir, 'torn'), null, 'foreign reads as no record');
    writeFileSync(file, JSON.stringify({ version: 1, rows: [{ taskId: 'someone-else' }] }));
    assert.equal(readTaskRecord(dir, 'torn'), null, 'a row for another task reads as no record');
    assert.deepEqual(listTaskRecords(dir), [], 'unreadable files are skipped, not fatal');
    assert.deepEqual(listTaskRecords('/no-such-checkout-xyz'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('view round-trip: the ordered ids, nothing else', () => {
  const file = sessionFile();
  const view = sessionStatePath(file, TASK_VIEW_NAME)!;
  try {
    assert.equal(writeTaskView(file, ['b', 'a']), true);
    assert.deepEqual(readTaskView(file), ['b', 'a'], 'order is the delegation order');
    assert.equal(writeTaskView(file, ['b', 'a', 'b']), true);
    assert.deepEqual(parseTaskDocument(JSON.parse(readFileSync(view, 'utf8'))).taskIds,
      ['b', 'a'], 'duplicates never reach the document');
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true });
  }
});

test('view reads: no transcript path, missing and torn documents read as no view', () => {
  assert.equal(readTaskView(null), null, 'S25: no transcript path means no view file');
  assert.equal(readTaskView(join(tmpdir(), 'piher-no-dir-xyz', 's.jsonl')), null);
  assert.equal(writeTaskView(null, ['x']), false, 'a view with nowhere to sit stays in memory');
  const file = sessionFile();
  const view = sessionStatePath(file, TASK_VIEW_NAME)!;
  try {
    mkdirSync(join(view, '..'), { recursive: true });
    writeFileSync(view, 'torn{');
    assert.equal(readTaskView(file), null, 'torn reads as no view, never raises');
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true });
  }
});

test('seedTaskView: a fork copies the parent view once, never twice', () => {
  const parent = sessionFile();
  const child = sessionFile();
  try {
    assert.equal(writeTaskView(parent, ['t1', 't2']), true);
    const to = sessionStatePath(child, TASK_VIEW_NAME)!;
    const from = sessionStatePath(parent, TASK_VIEW_NAME)!;
    assert.equal(seedTaskView(to, from), true);
    assert.deepEqual(readTaskView(child), ['t1', 't2']);
    assert.equal(seedTaskView(to, from), false, 'an existing child view is never overwritten');
    assert.equal(seedTaskView(to, join(tmpdir(), 'piher-no-file-xyz.json')), false);
    assert.equal(seedTaskView(null, from), false);
  } finally {
    rmSync(join(parent, '..'), { recursive: true, force: true });
    rmSync(join(child, '..'), { recursive: true, force: true });
  }
});

test('deleteTaskRecord: what never started leaves nothing behind', () => {
  const dir = repo();
  try {
    const entry = taskRow({ taskId: 'stillborn', paneId: 'p9', cwd: dir });
    assert.equal(writeTaskRecord(dir, entry), true);
    assert.ok(existsSync(taskRecordPath(repoTasksDir(dir)!, 'stillborn')));
    deleteTaskRecord(dir, 'stillborn');
    assert.equal(readTaskRecord(dir, 'stillborn'), null);
    deleteTaskRecord(dir, 'stillborn');
    deleteTaskRecord('/no-such-checkout-xyz', 'stillborn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no repository: writes are dropped with one line, reads stay empty', () => {
  const outside = mkdtempSync(join(tmpdir(), 'piher-store-out-'));
  try {
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      assert.equal(writeTaskRecord(outside, taskRow({ cwd: outside })), false);
      assert.equal(writeTaskRecord(outside, taskRow({ cwd: outside })), false);
    } finally {
      console.error = origError;
    }
    assert.equal(logged.filter((l) => l.includes(outside)).length, 1, 'one line per checkout');
    assert.equal(readTaskRecord(outside, 'x'), null);
    assert.deepEqual(listTaskRecords(outside), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
