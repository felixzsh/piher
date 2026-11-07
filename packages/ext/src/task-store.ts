/**
 * The task document store: one atomic writer and reader for both durable documents (S5, S6).
 *
 * - task record `<repo>/.piher/tasks/<taskId>.json` — `{version:1, rows:[TaskRow]}`, one row;
 * - session view `<sessionDir>/piher/<sessionId>/tasks.json` — `{version:1, taskIds:[...]}`.
 *
 * Every write is a temporary file + rename, so a crash mid-write leaves the previous document
 * intact (S6). A missing, torn or foreign document reads as "no record" and never raises (S6).
 * Nothing durable is pruned by age or by count (S8).
 */
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionStatePath } from './session-state.ts';
import { mainWorktreeRoot } from './storage-layout.ts';
import { parseTaskDocument, toTaskRow, type TaskEntry, type TaskRow } from './task-row.ts';
import { swallow } from './swallow.ts';

export const TASKS_DIR_NAME = 'tasks';
export const TASK_VIEW_NAME = 'tasks.json';

/**
 * The task directory of the repository containing `cwd`: one directory per repository inside
 * the main checkout, so every worktree of a repository shares it. Outside a git repository
 * there is no directory and no fallback. `.piher/tasks/` must be git-ignored (never the
 * parent `.piher/`, whose `roles/` are meant to be committed).
 */
export function repoTasksDir(cwd: string): string | null {
  const root = mainWorktreeRoot(cwd);
  return root === null ? null : join(root, '.piher', TASKS_DIR_NAME);
}

export function taskRecordPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.json`);
}

/** Replace the document atomically (tmp + rename): a crash mid-write must not leave half of one. */
function writeDocument(file: string, doc: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
    renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[piher] task document write failed: ${file}: ${(err as Error).message}`);
    return false;
  }
}

/** One log line per checkout with no repository, so a long session outside git stays readable. */
const noRepoLogged = new Set<string>();

function logNoRepo(cwd: string): void {
  // A checkout the spawn itself removed is not a misconfiguration: the rows it wrote while it
  // existed are its history, and a line about a path that no longer exists only reads as an error.
  if (!existsSync(cwd)) return;
  if (noRepoLogged.has(cwd)) return;
  noRepoLogged.add(cwd);
  console.error(
    `[piher] no delegation ledger: ${cwd} is not inside a git repository, ` +
      'so delegation history is not recorded and resume needs one',
  );
}

/**
 * Write one task record: the task, its current generation and its decision. Best-effort —
 * bookkeeping must never break delegation. Only the durable row is written; the transient
 * memory state stays out of the document (S11, S12).
 */
export function writeTaskRecord(cwd: string, entry: TaskEntry): boolean {
  const dir = repoTasksDir(cwd);
  if (dir === null) {
    logNoRepo(cwd);
    return false;
  }
  const row: TaskRow = toTaskRow(entry);
  return writeDocument(taskRecordPath(dir, row.taskId), { version: 1, rows: [row] });
}

/**
 * Delete one task record (S8: besides `close`, deleting its record file is the only way a task
 * leaves use). What never started leaves nothing behind; anything else goes through `close`.
 */
export function deleteTaskRecord(cwd: string, taskId: string): void {
  const dir = repoTasksDir(cwd);
  if (dir === null || taskId.trim() === '') return;
  try {
    rmSync(taskRecordPath(dir, taskId), { force: true });
  } catch (err) {
    swallow('task-store.delete-record', err);
  }
}

/** Read one task record by id. A missing, torn or foreign document is "no record", never raised. */
export function readTaskRecord(cwd: string, taskId: string): TaskRow | null {
  const dir = repoTasksDir(cwd);
  if (dir === null || taskId.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(taskRecordPath(dir, taskId), 'utf8'));
    const row = parseTaskDocument(parsed).rows[0] ?? null;
    // The file name is the address: a row for another task inside is a foreign document.
    if (!row || row.taskId !== taskId) return null;
    return row;
  } catch (err) {
    swallow('task-store.read-record', err);
    return null;
  }
}

/** Every readable record of the repository containing `cwd`: the candidate set `resume`
 *  resolves against. Unreadable files are skipped, not fatal. */
export function listTaskRecords(cwd: string): TaskRow[] {
  const dir = repoTasksDir(cwd);
  if (dir === null) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    swallow('task-store.list-records', err);
    return [];
  }
  const rows: TaskRow[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const row = readTaskRecord(cwd, name.slice(0, -'.json'.length));
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * The session's view: the ordered task ids it delegated. Null when the session has nowhere to
 * sit (no transcript path — the view then stays in memory only, S25) or when the document is
 * missing, torn or foreign.
 */
export function readTaskView(sessionFile: string | null | undefined): string[] | null {
  const file = sessionStatePath(sessionFile ?? null, TASK_VIEW_NAME);
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parseTaskDocument(parsed).taskIds;
  } catch (err) {
    swallow('task-store.read-view', err);
    return null;
  }
}

/** Replace the session view. A session with no transcript path keeps it in memory only (S25). */
export function writeTaskView(
  sessionFile: string | null | undefined,
  taskIds: readonly string[],
): boolean {
  const file = sessionStatePath(sessionFile ?? null, TASK_VIEW_NAME);
  if (!file) return false;
  return writeDocument(file, { version: 1, taskIds: [...taskIds] });
}

/** A fork gets the view it branched from: the parent's document is copied once, before the
 *  restore reads it. Records are shared, not copied: the fork continues the same tasks. */
export function seedTaskView(to: string | null, from: string | null): boolean {
  if (!to || !from || to === from) return false;
  try {
    if (existsSync(to) || !existsSync(from)) return false;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    return true;
  } catch (err) {
    swallow('task-store.seed-view', err);
    return false;
  }
}
