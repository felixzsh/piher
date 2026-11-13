/** Board hygiene: gc-core decision tables (task tabs, terminals) and the plugin-level GC pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fakeWatch, fire, listTaskRecords, mountSubagent, runSubagent, seedTaskDocuments, taskRow,
  terminalInfo, type TaskSeed,
} from '../test-utils.ts';
import type { TaskEntry } from '../../src/task-row.ts';
import { checkoutSpaceId } from '../../src/worktree.ts';
import type { TerminalInfo } from '../../src/core-client.ts';
import {
  decideCheckoutSpaces, formatIdleCheckoutNotice, shouldClosePane, shouldCloseTaskTab,
  type CheckoutRowLike, type GcEntryLike,
} from '../../src/gc-core.ts';
import * as gcCore from '../../src/gc-core.ts';

const NOW = 1_000_000;
const TTL = 600_000;
const work = (over: Partial<GcEntryLike> = {}): GcEntryLike => ({
  kind: 'task',
  consumedAt: NOW - TTL - 1000,
  ...over,
});

test('shouldCloseTaskTab: closes only when every work pane finished and the grace TTL elapsed', () => {
  const tab = (over: Partial<GcEntryLike>, paneStatuses: string[], ms = TTL, now = NOW) =>
    shouldCloseTaskTab({ entries: [work(over)], paneStatuses, ttlMs: ms, now });
  assert.equal(tab({}, ['idle', 'unknown']), true);
  assert.equal(shouldCloseTaskTab({ entries: [], paneStatuses: ['idle'], ttlMs: TTL, now: NOW }), false, 'the main tab never closes');
  assert.equal(tab({ consumedAt: null }, ['working']), false, 'an undelivered report holds it');
  assert.equal(tab({ consumedAt: NOW - 1000 }, ['idle']), false, 'grace period');
  assert.equal(tab({ closedAt: NOW - TTL - 1000 }, ['idle']), true, 'a closed task needs no grace');
  assert.equal(tab({ kind: 'advisor', consumedAt: null }, ['working']), false);
  assert.equal(tab({}, ['blocked']), false, 'a human gate keeps the tab');
  assert.equal(tab({}, ['working']), false);
});

test('shouldClosePane: only a one-shot pane is reclaimed; a persistent worker is the master\'s', () => {
  const pane = (over: Partial<Parameters<typeof shouldClosePane>[0]> = {}) =>
    shouldClosePane({ prevTurnStart: NOW, consumedAt: NOW - 1000, status: 'idle', lifecycle: 'one-shot', ...over });
  // The same row as a persistent worker is never reclaimed: killing it buys nothing and costs a
  // cold start on the next `send`, reviving a conversation that was never over.
  assert.equal(pane({ lifecycle: 'persistent' }), false);
  assert.equal(pane({ lifecycle: undefined }), false);
  assert.equal(pane(), true);
  assert.equal(pane({ status: 'done' }), true);
  assert.equal(pane({ status: 'error' }), true);
  assert.equal(pane({ status: 'working' }), false);
  assert.equal(pane({ status: 'blocked' }), false);
  assert.equal(pane({ status: 'unknown' }), false);
  assert.equal(pane({ consumedAt: NOW + 500 }), false, 'consumed this turn keeps the notice visible');
  assert.equal(pane({ consumedAt: null }), false);
  const unlisted = pane({ consumedAt: null, status: undefined });
  assert.equal(unlisted, false, 'an unlisted terminal is not ours to close');
});

/* ── plugin-level GC ────────────────────────────────────────────── */

const pane = (id: string): TerminalInfo => terminalInfo({ id, status: 'idle', labels: { 'herdr.tab': 'tMAIN' } });
const seedData = (paneId: string, cwd: string, over: TaskSeed = {}): TaskSeed => ({
  paneId, taskId: `task-${paneId}`, tabId: 'tMAIN', tabName: 'main', cwd, description: 'pane-gc regression',
  consumedAt: Date.now() - 120_000, createdAt: Date.now() - 150_000,
  lifecycle: 'one-shot', ...over,
});
const consumed = (paneId: string, cwd: string, over: TaskSeed = {}): TaskEntry =>
  taskRow(seedData(paneId, cwd, over));

/** Seeds `tasks`, runs one GC pass with `liveTerminals` in the children watch (and core's list),
 * then reports the retired terminal ids and the live board. */
async function gcPass(
  liveTerminals: string[],
  tasks: TaskEntry[],
): Promise<{ closed: string[] }> {
  const closed: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      placementLabels: async () => ({ 'herdr.tab': 'tMAIN' }),
      listTerminals: async () => liveTerminals.map(pane),
      watchChildren: () => fakeWatch({ terminals: () => liveTerminals.map(pane) }),
      kill: async (id) => { closed.push(id); },
    },
    tasks,
  });
  try {
    await fire(pi, 'turn_start');
    return { closed };
  } finally {
    await root.fiber.dispose();
  }
}

test('GC pass: panes are reclaimed, tasks are not closed', async () => {  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-'));
  const seeds = [seedData('pAlive', cwd), seedData('pGone', cwd)];
  mkdirSync(join(cwd, '.git'), { recursive: true });
  seedTaskDocuments(null, seeds);
  const before = listTaskRecords(cwd);
  const { closed } = await gcPass(['pAlive'], seeds.map(taskRow));
  assert.deepEqual(closed, ['pAlive'], 'the pane is retired');
  // Housekeeping frees panes but writes no rows: only `close` ends a task.
  assert.deepEqual(listTaskRecords(cwd), before);
});

test('GC pass: the master terminal is never collected, whatever the registry claims', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-self-'));
  const seeds = [seedData('t0', cwd)];
  mkdirSync(join(cwd, '.git'), { recursive: true });
  seedTaskDocuments(null, seeds);
  const before = listTaskRecords(cwd);
  const { closed } = await gcPass(['t0'], seeds.map(taskRow)); // t0 is the master itself
  assert.deepEqual(closed, [], 'kill must never target the master');
  assert.deepEqual(listTaskRecords(cwd), before, 'the row is left alone');
});

test('tasks: a worker whose pane is gone is listed as actionable, not dropped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-zombie-'));
  const { root, pi } = await mountSubagent({
    client: { listTerminals: async () => [] },
    tasks: [taskRow({
      paneId: 'pZombie', taskId: 'task-zombie', cwd, description: 'zombie worker',
    })],
  });
  try {
    // No sweep settles it anymore: a vanished pane is unfinished work, shown as `no pane` until
    // the master closes it or sends it back to life.
    const text = (await runSubagent(pi, { action: 'list' }, cwd)).content[0]!.text;
    assert.match(text, /pZombie \[no pane\] \(task · persistent\) zombie worker/);
  } finally {
    await root.fiber.dispose();
  }
});

test('planChannelCheck: gone with the private socket', () => {
  // P5 deleted the ping this planned: a follow-up is a document write now (spec S15), so there is no
  // per-worker channel to lose and no heartbeat to announce it.
  assert.equal('planChannelCheck' in gcCore, false);
  assert.equal('formatDeadChannelNotice' in gcCore, false);
});

test('decideCheckoutSpaces: an empty window closes, a finished-but-open one only gets a reminder', () => {
  const path = '/home/u/.herdr/worktrees/piher/probe';
  const row = (over: Partial<GcEntryLike> = {}): CheckoutRowLike => ({ ...work(over), worktreePath: path });
  const decide = (rows: ReturnType<typeof row>[], remindedAt?: Map<string, number>) =>
    decideCheckoutSpaces({ rows, ttlMs: TTL, now: NOW, remindedAt });

  // Every row closed → the space is an empty window: cleanup, no reminder.
  const shut = { closedAt: NOW - TTL - 1000 };
  assert.deepEqual(decide([row(shut), row(shut)]), { close: [path], remind: [] });
  // A finished row nobody closed keeps its window: a reminder, never a close.
  assert.deepEqual(decide([row()]), { close: [], remind: [{ path, since: NOW - TTL - 1000 }] });
  // One live sibling is enough to hold both decisions.
  assert.deepEqual(decide([row(shut), row({ consumedAt: null })]), { close: [], remind: [] });
  // The grace window still runs.
  assert.deepEqual(decide([row({ consumedAt: NOW - 1000 })]), { close: [], remind: [] });
  // One reminder per settlement: the same `since` never fires twice.
  const once = new Map([[path, NOW - TTL - 1000]]);
  assert.deepEqual(decide([row()], once), { close: [], remind: [] });
  // A revive that settles again is new activity, so it may remind again.
  assert.deepEqual(decide([row({ consumedAt: NOW - TTL - 500 })], once).remind.length, 1);
  // Rows with no checkout take no part in the sweep.
  assert.deepEqual(decide([{ ...work(), worktreePath: null }]), { close: [], remind: [] });
  assert.equal(decideCheckoutSpaces({ rows: [row()], ttlMs: 0, now: NOW }).remind.length, 0, 'ttl 0 disables the reminder');

  const notice = formatIdleCheckoutNotice({ name: 'probe', minutes: 10, panes: ['p2', 'p3'] });
  assert.match(notice, /checkout probe has had no running subagent for 10 min \(p2, p3\)/);
  assert.match(notice, /stays open/);
  assert.match(notice, /subagent action:"close"/);
});

/** A checkout sweep pass: one row per worker, all in the same checkout. */
async function checkoutPass(tasks: TaskEntry[], passes = 1): Promise<{
  closed: string[]; notices: string[];
}> {
  const closed: string[] = [];
  const notices: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      placementLabels: async () => ({ 'herdr.tab': 'tMAIN' }),
      listTerminals: async () => [],
      watchChildren: () => fakeWatch({ terminals: () => [] }),
      kill: async () => {},
    },
    deps: {
      checkoutSpace: { close: async (id: string) => { closed.push(id); return null; } },
      deliverNotice: async (content: string) => { notices.push(content); },
    },
    tasks,
  });
  try {
    for (let i = 0; i < passes; i += 1) await fire(pi, 'turn_start');
    return { closed, notices };
  } finally {
    await root.fiber.dispose();
  }
}

test('GC pass: a checkout with a finished-but-open worker is reminded once and kept', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'checkout-gc-'));
  const path = join(cwd, 'probe');
  const wt = { path, branch: 'probe' };
  const old = Date.now() - 700_000;
  const rows = [
    consumed('p2', path, { tabId: '', worktree: wt, consumedAt: old }),
    consumed('p3', path, { tabId: '', taskId: 'task-p3', worktree: wt, consumedAt: old }),
  ];
  const { closed, notices } = await checkoutPass(rows, 2);
  assert.deepEqual(closed, [], 'an idle worker keeps its window: space.close ends its terminal');
  assert.equal(notices.length, 1, 'the reminder is delivered once, not every tick');
  assert.match(notices[0]!, /checkout probe has had no running subagent for 10 min/);
});

test('GC pass: a checkout whose workers are all closed has its space closed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'checkout-gc-closed-'));
  const path = join(cwd, 'probe');
  const wt = { path, branch: 'probe' };
  const rows = [consumed('p2', path, { tabId: '', worktree: wt, closedAt: Date.now() - 600_000 })];
  const { closed, notices } = await checkoutPass(rows);
  assert.deepEqual(closed, [checkoutSpaceId(path)], 'an empty window is cleanup, not a decision');
  assert.deepEqual(notices, []);
});
