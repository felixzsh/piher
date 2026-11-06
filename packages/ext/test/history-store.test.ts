/** Delegation ledger (history-store): append-only JSONL, one file per repository inside its main checkout. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReportedSessionFile, appendHistory, appendLedger, generationsByTask, inheritOutcome, inspectHistory,
  latestGeneration, ledgerFile, normalizeEntryKind, parseHistoryEntries, readHistory, readLedger, type HistoryEntry,
} from '../src/history-store.ts';
import { jsonl, withCleanup } from './test-utils.ts';

const mk = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', workspaceId: 'w1', cwd: 'F:\\piher',
  description: 'task', sessionFile: 'C:\\sess\\a.jsonl', launchCommand: ['node', 'cli.js'], status: 'running',
  createdAt: 1, ...over,
});

test('ledgerFile: one file per repository, inside the main checkout', withCleanup(async (cleanup) => {
  const repo = cleanup.tempDir('hist-repo').path;
  fs.mkdirSync(path.join(repo, '.git'));
  assert.equal(ledgerFile(repo), path.join(repo, '.piher', 'history', 'history.jsonl'));
  assert.equal(ledgerFile(cleanup.tempDir('hist-outside').path), null, 'no git repository → no ledger');
}));

test('appendLedger/readLedger: a repo row round-trips; outside a repository the write is dropped, not thrown', withCleanup(async (cleanup) => {
  const repo = cleanup.tempDir('hist-ledger').path;
  fs.mkdirSync(path.join(repo, '.git'));
  assert.equal(appendLedger(cleanup.tempDir('hist-norepo').path, mk()).ok, false, 'outside a repo: nothing recorded');
  assert.equal(appendLedger(repo, mk({ status: 'settled', outcome: 'done' })).ok, true);
  assert.deepEqual(readLedger(cleanup.tempDir('hist-norepo').path), [], 'no ledger to read outside a repo');
  assert.deepEqual(readLedger(repo).map((e) => e.status), ['settled']);
}));

test('parseHistoryEntries: skips junk lines, non-objects, rows without taskId and invalid statuses', () => {
  const entries = parseHistoryEntries(`{bad\n\n${jsonl(mk())}garbage`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, 't1');
  assert.equal(parseHistoryEntries(jsonl({ paneId: 'p', status: 'running' })).length, 0);
  assert.equal(parseHistoryEntries(jsonl({ taskId: 't1', status: 'nope' })).length, 0);
});

test('inspectHistory/readHistory: missing vs unreadable (directory); both read as empty', withCleanup(async (cleanup) => {
  const missing = path.join(cleanup.tempDir('hist-none').path, 'history.jsonl');
  assert.equal(inspectHistory(missing).status, 'missing');
  assert.deepEqual(readHistory(missing), []);
  assert.equal(inspectHistory(cleanup.tempDir('hist-dir').path).status, 'unreadable');
}));

test('appendHistory: a file where the parent directory should be → ok:false', withCleanup(async (cleanup) => {
  const tmp = cleanup.tempDir('hist-block').path;
  const blocker = path.join(tmp, 'notdir');
  fs.writeFileSync(blocker, 'x');
  assert.equal(appendHistory(path.join(blocker, 'history.jsonl'), mk()).ok, false);
}));

test('appendLedger: an unwritable repository reports the failure instead of throwing (the spawn continues)', withCleanup(async (cleanup) => {
  const repo = cleanup.tempDir('hist-ro').path;
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.piher'), 'not a directory');
  const res = appendLedger(repo, mk());
  assert.equal(res.ok, false);
  assert.ok(!res.ok && /EEXIST|ENOTDIR|EACCES/.test(res.error.message), res.ok ? '' : res.error.message);
}));

test('append/read round-trip: rows append in order and the directory is created on demand', withCleanup(async (cleanup) => {
  const file = path.join(cleanup.tempDir('hist').path, 'history.jsonl');
  appendHistory(file, mk());
  appendHistory(file, mk({ status: 'closed', closedAt: 2 }));
  const entries = readHistory(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].status, 'closed');
  assert.ok(fs.existsSync(file));
}));

test('generationsByTask/latestGeneration: generations fold per task and follow the revival chain', () => {
  const entries = [
    mk({ paneId: 'w1:p1', status: 'closed', closedAt: 10, taskId: 't1' }), mk({ paneId: 'w1:p2', status: 'running', revivedFrom: 'w1:p1', taskId: 't1', createdAt: 20 }),
    mk({ paneId: 'w1:p3', taskId: 't2', createdAt: 5 }),
  ];
  const gens = generationsByTask(entries);
  assert.equal(gens.get('t1')?.length, 2);
  assert.equal(gens.get('t2')?.length, 1);
  const latest = latestGeneration(entries, 't1');
  assert.equal(latest?.paneId, 'w1:p2');
  assert.equal(latest?.revivedFrom, 'w1:p1');
  assert.equal(latestGeneration(entries, 'tX'), null);
});

test('normalizeEntryKind: short/resident/missing → task; role names unchanged (also on disk read)', () => {
  assert.equal(normalizeEntryKind('short'), 'task');
  assert.equal(normalizeEntryKind('resident'), 'task');
  assert.equal(normalizeEntryKind(undefined), 'task');
  assert.equal(normalizeEntryKind(''), 'task');
  assert.equal(normalizeEntryKind('advisor'), 'advisor');
  assert.equal(normalizeEntryKind('websearch'), 'websearch');
  const legacy = parseHistoryEntries(JSON.stringify(mk({ kind: 'resident' })));
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].kind, 'task');
});

test('applyReportedSessionFile: only a .jsonl path is accepted; an invalid report never overwrites', () => {
  assert.equal(applyReportedSessionFile('old.jsonl', 'C:\\sess\\a.jsonl'), 'C:\\sess\\a.jsonl');
  assert.equal(applyReportedSessionFile('old.jsonl', 'not-a-path'), 'old.jsonl');
  assert.equal(applyReportedSessionFile(null, 'C:\\sess\\b.jsonl'), 'C:\\sess\\b.jsonl');
  assert.equal(applyReportedSessionFile(null, null), null);
});

test('inheritOutcome: an omitted patch value inherits the latest non-empty outcome', () => {
  assert.equal(inheritOutcome('final report…', undefined), 'final report…', 'undefined → inherit');
  assert.equal(inheritOutcome(null, 'settle timeout'), 'settle timeout');
  assert.equal(inheritOutcome('final report…', null), null, 'an explicit null also wins');
  assert.equal(inheritOutcome(undefined, undefined), null);
});

test('via: the writer marker survives a round-trip (one row per event, auditable)', () => {
  const rows = parseHistoryEntries(jsonl(
    { taskId: 't1', kind: 'task', paneId: 'p1', status: 'consumed', outcome: 'x', createdAt: 1, via: 'poll-settle' },
    { taskId: 't1', kind: 'task', paneId: 'p1', status: 'closed', createdAt: 2, via: 'gc' },
  ));
  assert.deepEqual(rows.map((r) => r.via), ['poll-settle', 'gc']);
});

test('appendLedger: a checkout that no longer exists is not announced as a misconfiguration', () => {
  // A worktree the close removed still has rows in the registry; writing one more must not print
  // "not inside a git repository" about a path nobody can visit.
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => { lines.push(String(line)); };
  try {
    const gone = path.join(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'piher-gone-')), 'nested');
    const res = appendLedger(gone, {
      taskId: 't-gone', description: 'x', status: 'closed', paneId: 'p1', createdAt: 1,
      kind: 'worker', cwd: gone, tabId: 't1', tabName: 'w',
    } as never);
    assert.equal(res.ok, false, 'nothing is recorded: there is nowhere to record it');
    assert.deepEqual(lines, [], 'and nothing says a removed checkout is not a repository');
  } finally {
    console.error = original;
  }
});
