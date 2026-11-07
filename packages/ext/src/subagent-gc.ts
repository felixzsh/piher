/**
 * Subagent board hygiene: task restore + recovery and terminal collection. Predicates live in
 * gc-core.ts; this adapter owns core kill/remove I/O and the ticker.
 */
import type { Context } from '@deepseek-ai/cordis';
import { basename } from 'node:path';
import type { CoreClientLike, CoreEnv, TerminalInfo } from './core-client.ts';
import {
  decideCheckoutSpaces,
  planChannelCheck,
  formatDeadChannelNotice,
  formatIdleCheckoutNotice,
  shouldClosePane,
  shouldCloseTaskTab,
  type CheckoutRowLike,
} from './gc-core.ts';
import type { SettlementCard } from './settlement-card.ts';
import { checkoutSpaceId, type CheckoutSpace } from './worktree.ts';
import { trace, traceRole } from './trace.ts';
import { sessionStatePath } from './session-state.ts';
import { pipeRequestTo } from './pipe-channel.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { sleep } from './subagent-core.ts';
import { isClosed, type TaskEntry, type TaskRow } from './task-row.ts';
import { readTaskRecord, readTaskView, seedTaskView, TASK_VIEW_NAME } from './task-store.ts';
import type { PaneStateSlot } from './plugins/bg-job.ts';

/* ── task restore + recovery ─────────────────────────────── */

/** S53: `terminal.kill` then `terminal.rm` — the app closes the pane, and its tab goes with the last
 *  terminal. A terminal that already exited is not an error, and neither is one core reaped itself. */
export async function retirePane(
  client: Pick<CoreClientLike, 'kill' | 'remove'>,
  paneId: string,
): Promise<void> {
  try { await client.kill(paneId); } catch { /* already exited */ }
  try { await client.remove(paneId); } catch { /* core reaps finished terminals */ }
}

export interface TaskBoardHost {
  client: CoreClientLike;
  tasks: Map<string, TaskEntry>;
  panes: Map<string, string>;
  writeRecord(entry: TaskEntry): void;
  /** Repository the restore reads records from (the session's own checkout). */
  restoreCwd: () => string;
  /** This session's transcript path; null when it has none (S25: the view stays in memory). */
  sessionFile: () => string | null;
  /** In-memory view: the task ids this session delegated, in order. */
  viewIds: string[];
}

/** Seed one memory entry from its record. Unresolved rows arrive running when no report was
 *  delivered yet, consumed when it was — so the recovery never re-arms a settled row. */
function seedEntryFromRow(host: Pick<TaskBoardHost, 'tasks' | 'panes'>, row: TaskRow): void {
  if (isClosed(row) || host.tasks.has(row.taskId)) return;
  const entry: TaskEntry = {
    ...row,
    gen: { ...row.gen },
    ...(row.worktree ? { worktree: { ...row.worktree } } : {}),
    status: row.gen.consumedAt !== null ? 'consumed' : 'running',
  };
  host.tasks.set(row.taskId, entry);
  if (row.gen.paneId) host.panes.set(row.gen.paneId, row.taskId);
}

/**
 * Restore on `session_start` (and `session_tree`): read the view, then each referenced record,
 * drop closed rows, seed memory. Additive: rows this session already holds are kept, and a
 * record that now says closed retires its memory row so every surface drops it. A record the
 * session's own repository does not hold reads as "no record" (S6) and is skipped.
 */
export function restoreTasks(host: TaskBoardHost, via = 'session_start', cwd?: string): void {
  try {
    const ids = readTaskView(host.sessionFile());
    if (ids) for (const id of ids) if (!host.viewIds.includes(id)) host.viewIds.push(id);
    const repo = cwd ?? host.restoreCwd();
    let restored = 0;
    for (const taskId of [...host.viewIds]) {
      const row = readTaskRecord(repo, taskId);
      if (!row) continue;
      const known = host.tasks.get(taskId);
      if (isClosed(row)) {
        if (known) known.status = 'closed';
        continue;
      }
      if (!known) {
        seedEntryFromRow(host, row);
        restored += 1;
      }
    }
    trace(traceRole, 'tasks-restore', { via, view: host.viewIds.length, restored, rows: host.tasks.size });
  } catch {
    /* recovery failure must not block the live session */
  }
}

/**
 * A fork inherits the state it branched from: copy the parent's view document once, before the
 * restore reads it. Records are shared, not copied: the fork continues the same tasks.
 */
export function seedForkView(sessionFile: string | null, previousSessionFile: string | null | undefined): void {
  const to = sessionStatePath(sessionFile ?? null, TASK_VIEW_NAME);
  const from = sessionStatePath(previousSessionFile ?? null, TASK_VIEW_NAME);
  if (!seedTaskView(to, from)) return;
  trace(traceRole, 'tasks-seed', { from: from ?? null, to: to ?? null });
}

/** Startup sweep: a row still marked running whose pane core no longer lists is not running —
 *  but nothing ended it. A vanished pane is unfinished work, and unfinished work is what
 *  `resume` exists for. Only `close` may write `closed`. */
export async function sweepZombieTasks(
  host: Pick<TaskBoardHost, 'client' | 'tasks' | 'writeRecord'>,
): Promise<void> {
  if (!host.client.available || host.tasks.size === 0) return;
  let liveTerminalIds: ReadonlySet<string>;
  try {
    liveTerminalIds = new Set((await host.client.listTerminals()).map((terminal) => terminal.id));
  } catch {
    return; // do not close agents when the liveness lookup itself failed
  }
  for (const entry of host.tasks.values()) {
    if (entry.status !== 'running' || (entry.gen.paneId && liveTerminalIds.has(entry.gen.paneId))) continue;
    entry.status = 'settled';
    host.writeRecord(entry);
    trace(traceRole, 'gc-release', { pane: entry.gen.paneId, via: 'zombie-sweep', taskId: entry.taskId });
  }
}

/* ── GC ─────────────────────────────────────────────────────────── */

interface GcHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  tasks: Map<string, TaskEntry>;
  panes: Map<string, string>;
  writeRecord(e: TaskEntry): void;
  terminalState: PaneStateSlot;
  noticePending?: () => ReadonlySet<string>;
  /** The app's window on a checkout. Closing it ends the terminals inside, so only an empty one goes. */
  checkoutSpace?: CheckoutSpace;
  /** Settlement notice injector: buffers while the master is busy, flushes at turn_end. */
  deliverNotice?: (content: string, paneId?: string, card?: SettlementCard | null) => Promise<void>;
}

interface GcController {
  runGcSafely(): Promise<void>;
  onTurnStart(): Promise<void>;
  startTicker(ctx: Context): void;
}

export function createGcController(h: GcHost): GcController {
  let prevTurnStart = Date.now();
  let gcRunning = false;
  /** Path → the settlement a checkout reminder was already delivered for. */
  const remindedCheckouts = new Map<string, number>();
  /** Panes whose dead channel was already announced: one notice per loss, cleared when it answers. */
  const deadChannelNotified = new Set<string>();

  /** A checkout's space is nobody else's to sweep: close it when empty, and remind the master once
   *  about the window a finished-but-open worker left behind. Never ends a task, never ends a pane. */
  async function sweepCheckoutSpaces(ttlMs: number): Promise<void> {
    const rows: CheckoutRowLike[] = [...h.tasks.values()]
      .filter((e) => e.worktree?.path)
      .map((e) => ({
        kind: e.kind,
        status: e.status,
        consumedAt: e.gen.consumedAt ?? null,
        worktreePath: e.worktree?.path ?? null,
      }));
    if (rows.length === 0) return;
    const sweep = decideCheckoutSpaces({ rows, ttlMs, now: Date.now(), remindedAt: remindedCheckouts });
    for (const path of sweep.close) {
      await h.checkoutSpace?.close(checkoutSpaceId(path)).catch(() => null);
    }
    for (const { path, since } of sweep.remind) {
      const idle = [...h.tasks.values()].filter((e) => e.worktree?.path === path);
      const notice = formatIdleCheckoutNotice({
        name: basename(path),
        minutes: Math.round(ttlMs / 60000),
        panes: idle.map((e) => e.gen.paneId),
      });
      try {
        await h.deliverNotice?.(notice, idle[0]?.gen.paneId);
      } catch {
        continue; // refused (master mid-turn): the next tick retries the same reminder
      }
      remindedCheckouts.set(path, since);
    }
  }

  async function gcPass(): Promise<void> {
    if (h.tasks.size === 0) return;
    const ttlMs = runtimePolicy.sessionTtlSeconds * 1000;
    const autoCloseTabs = ttlMs > 0;
    // The periodic pass reads the children snapshot instead of listing terminals every tick; a
    // blind watch (core unreachable) skips the pass rather than closing rows on a stale view.
    const watch = h.client.watchChildren();
    await watch.ready();
    if (!watch.connected) return;
    const terminals = watch.list().filter((t) => t.state === 'live');
    const statuses = new Map(terminals.map((t) => [t.id, t.status]));
    const tabOf = (t: TerminalInfo): string => t.labels['herdr.tab'] ?? '';
    // Piher's own view of the running rows, side by side with what core says: the comparison that
    // shows a desync (`hc` sees `done`, the row still says `running`).
    trace(traceRole, 'gc-view', {
      panes: terminals.length,
      running: [...h.tasks.values()]
        .filter((e) => e.status === 'running')
        .slice(0, 8)
        .map((e) => `${e.gen.paneId}:${statuses.get(e.gen.paneId) ?? 'absent'}`)
        .join(','),
      watch: watch.connected,
    });
    const termPaneIds = h.terminalState.activePaneIds();
    const pendingNoticeIds = h.noticePending?.() ?? new Set<string>();

    const byTab = new Map<string, TaskEntry[]>();
    for (const e of h.tasks.values()) {
      if (!e.gen.tabId) continue;
      const arr = byTab.get(e.gen.tabId) ?? [];
      arr.push(e);
      byTab.set(e.gen.tabId, arr);
    }
    const mainTabId = (await h.client.placementLabels())['herdr.tab'] ?? '';

    /**
     * Housekeeping never ends a task. The pane and the tab are piher's to reclaim, but the row is the
     * master's: it becomes `settled` (unfinished, resumable) and only `close` writes `closed`. A sweep
     * that stamped `closed` used to be undone by `send` reviving it, which is exactly the coupling
     * that made "close is final" contradictory.
     */
    const releaseRow = (e: TaskEntry): void => {
      if (e.status !== 'running') return;
      e.status = 'settled';
      h.writeRecord(e);
      trace(traceRole, 'gc-release', { pane: e.gen.paneId, via: 'gc', taskId: e.taskId });
    };
    /** The pair `close` and a one-shot settlement use as well. */
    const retire = (id: string): Promise<void> => retirePane(h.client, id);

    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue;
      const tabTerminals = terminals.filter((t) => tabOf(t) === tabId);
      if (tabTerminals.length === 0) {
        for (const e of entries) releaseRow(e);
        continue;
      }
      if (!autoCloseTabs) continue;
      if (!shouldCloseTaskTab({
        entries: entries.map((e) => ({ kind: e.kind, status: e.status, consumedAt: e.gen.consumedAt })),
        paneStatuses: tabTerminals.map((t) => t.status),
        ttlMs,
        now: Date.now(),
      })) continue;
      // Live terminal panes and not-yet-delivered settlement notices keep the tab alive.
      if (tabTerminals.some((t) => termPaneIds.has(t.id) || pendingNoticeIds.has(t.id))) continue;
      for (const t of tabTerminals) await retire(t.id);
      for (const e of entries) releaseRow(e);
      await sleep(300);
    }

    const closableTaskTabIds = new Set([...byTab.keys()].filter((t) => t !== mainTabId));
    const candidates = [...h.tasks.values()].filter(
      (e) => e.status === 'consumed' && !(e.gen.tabId && closableTaskTabIds.has(e.gen.tabId)),
    );
    for (const e of candidates) {
      if (termPaneIds.has(e.gen.paneId) || pendingNoticeIds.has(e.gen.paneId)) continue;
      // Never collect self, whatever the board says: a poisoned entry once closed the master's terminal.
      if (h.env?.terminalId && e.gen.paneId === h.env.terminalId) continue;
      if (!shouldClosePane({
        consumedAt: e.gen.consumedAt ?? null,
        status: statuses.get(e.gen.paneId),
        prevTurnStart,
        lifecycle: e.lifecycle,
      })) continue;
      if (statuses.get(e.gen.paneId) === undefined) {
        releaseRow(e);
        continue;
      }
      await retire(e.gen.paneId);
      releaseRow(e);
      await sleep(300);
    }
    await sweepCheckoutSpaces(ttlMs);
    await sweepChannels(statuses);
  }

  /** A worker's message channel is what makes a follow-up possible at all. Ping it and say so once
   *  when it is gone: the alternative is the master finding out on the next `send`, which is exactly
   *  when the message matters. Never settles, never closes, never touches the row. */
  async function sweepChannels(statuses: ReadonlyMap<string, string>): Promise<void> {
    for (const e of [...h.tasks.values()]) {
      if (!e.gen.paneId) continue;
      const status = statuses.get(e.gen.paneId);
      if (planChannelCheck({ rowStatus: e.status, terminalStatus: status }) === 'skip') continue;
      // Past the planner the terminal is listed and reported: the notice may name its state.
      const reported = status ?? 'unknown';
      let ok = false;
      try {
        ok = (await pipeRequestTo(e.cwd, e.gen.paneId, { type: 'ping', id: `hb-${Date.now()}` }, 1_500)).type === 'ok';
      } catch {
        ok = false;
      }
      trace(traceRole, 'pipe-heartbeat', { pane: e.gen.paneId, ok, status: reported });
      if (ok) {
        deadChannelNotified.delete(e.gen.paneId);
        continue;
      }
      if (deadChannelNotified.has(e.gen.paneId)) continue;
      deadChannelNotified.add(e.gen.paneId);
      try {
        await h.deliverNotice?.(formatDeadChannelNotice({ paneId: e.gen.paneId, taskId: e.taskId, status: reported }), e.gen.paneId, null);
      } catch {
        /* the next pass re-announces: the latch is only set for a delivered notice */
        deadChannelNotified.delete(e.gen.paneId);
      }
    }
  }

  async function runGcSafely(): Promise<void> {
    if (gcRunning) return;
    gcRunning = true;
    try {
      await gcPass();
    } catch { /* next turn/tick retries */ } finally {
      gcRunning = false;
    }
  }

  return {
    runGcSafely,
    async onTurnStart(): Promise<void> {
      const now = Date.now();
      await runGcSafely();
      prevTurnStart = now;
    },
    startTicker(ctx: Context): void {
      const gcTickMs = runtimePolicy.gcTickMs;
      const gcTicker = gcTickMs > 0 ? setInterval(() => { void runGcSafely(); }, gcTickMs) : null;
      ctx.effect(() => () => {
        clearInterval(gcTicker ?? undefined);
      }, 'gc-ticker');
    },
  };
}
