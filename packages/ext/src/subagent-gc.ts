/**
 * Subagent board hygiene: task restore + recovery and terminal collection. Predicates live in
 * gc-core.ts; this adapter owns core kill/remove I/O and the ticker.
 */
import type { Context } from '@deepseek-ai/cordis';
import { basename } from 'node:path';
import type { CoreClientLike, CoreEnv, TerminalInfo } from './core-client.ts';
import {
  decideCheckoutSpaces,
  formatIdleCheckoutNotice,
  shouldClosePane,
  shouldCloseTaskTab,
  type CheckoutRowLike,
} from './gc-core.ts';
import type { SettlementCard } from './settlement-card.ts';
import { checkoutSpaceId, type CheckoutSpace } from './worktree.ts';
import { sessionStatePath } from './session-state.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { sleep } from './subagent-core.ts';
import {
  isClosed, type TaskEntry, type TaskObservation, type TaskRow,
} from './task-row.ts';
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
  /** Repository the restore reads records from (the session's own checkout). */
  restoreCwd: () => string;
  /** This session's transcript path; null when it has none (S25: the view stays in memory). */
  sessionFile: () => string | null;
  /** In-memory view: the task ids this session delegated, in order. */
  viewIds: string[];
}

/** Seed one memory entry from its record. Unresolved rows arrive running when no report was
 *  delivered yet, consumed when it was — so the recovery never re-arms a finished row. */
function seedEntryFromRow(host: Pick<TaskBoardHost, 'tasks' | 'panes'>, row: TaskRow): void {
  if (isClosed(row) || host.tasks.has(row.taskId)) return;
  const entry: TaskEntry = {
    ...row,
    gen: { ...row.gen },
    ...(row.worktree ? { worktree: { ...row.worktree } } : {}),
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
export function restoreTasks(host: TaskBoardHost, cwd?: string): void {
  try {
    const ids = readTaskView(host.sessionFile());
    if (ids) for (const id of ids) if (!host.viewIds.includes(id)) host.viewIds.push(id);
    const repo = cwd ?? host.restoreCwd();
    for (const taskId of [...host.viewIds]) {
      const row = readTaskRecord(repo, taskId);
      if (!row) continue;
      const known = host.tasks.get(taskId);
      // `close` is final across sessions (S24): the record's decision wins over memory, and it
      // only ever moves one way, so adopting it here can never resurrect a task.
      if (known && row.closedAt !== null) known.closedAt = row.closedAt;
      if (isClosed(row)) continue;
      if (!known) seedEntryFromRow(host, row);
    }
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
  seedTaskView(to, from);
}

/* ── GC ─────────────────────────────────────────────────────────── */

interface GcHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  tasks: Map<string, TaskEntry>;
  /** Refreshed from the pass snapshot; feeds only the state text surfaces print (S26). */
  noteObservation?: (taskId: string, obs: TaskObservation) => void;
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

  /** A checkout's space is nobody else's to sweep: close it when empty, and remind the master once
   *  about the window a finished-but-open worker left behind. Never ends a task, never ends a pane. */
  async function sweepCheckoutSpaces(ttlMs: number): Promise<void> {
    const rows: CheckoutRowLike[] = [...h.tasks.values()]
      .filter((e) => e.worktree?.path)
      .map((e) => ({
        kind: e.kind,
        consumedAt: e.gen.consumedAt ?? null,
        closedAt: e.closedAt,
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
    const liveIds = new Set(terminals.map((t) => t.id));
    // The snapshot is this pass's observation: it refreshes the cache displays read from, and
    // nothing else — housekeeping never ends a task, so a stale view can only mislabel one (S26).
    const now = Date.now();
    for (const e of h.tasks.values()) {
      if (!e.gen.paneId) continue;
      h.noteObservation?.(e.taskId, {
        paneExists: liveIds.has(e.gen.paneId),
        agentStatus: statuses.get(e.gen.paneId) ?? null,
        lastActivityMs: null,
        at: now,
      });
    }
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

    /** Housekeeping never ends a task: it reclaims panes, tabs and checkout spaces, and the rows
     *  stay exactly as the master left them — only `close` writes `closed` (S8, S9). */
    /** The pair `close` and a one-shot settlement use as well. */
    const retire = (id: string): Promise<void> => retirePane(h.client, id);

    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue;
      const tabTerminals = terminals.filter((t) => tabOf(t) === tabId);
      // A tab with no terminals holds no live work; its rows stay listed as `no pane` until the
      // master closes them or sends them back to life.
      if (tabTerminals.length === 0) continue;
      if (!autoCloseTabs) continue;
      if (!shouldCloseTaskTab({
        entries: entries.map((e) => ({
          kind: e.kind, consumedAt: e.gen.consumedAt, closedAt: e.closedAt,
        })),
        paneStatuses: tabTerminals.map((t) => t.status),
        ttlMs,
        now: Date.now(),
      })) continue;
      // Live terminal panes and not-yet-delivered settlement notices keep the tab alive.
      if (tabTerminals.some((t) => termPaneIds.has(t.id) || pendingNoticeIds.has(t.id))) continue;
      for (const t of tabTerminals) await retire(t.id);
      await sleep(300);
    }

    const closableTaskTabIds = new Set([...byTab.keys()].filter((t) => t !== mainTabId));
    const candidates = [...h.tasks.values()].filter(
      (e) => e.gen.consumedAt !== null && !isClosed(e)
        && !(e.gen.tabId && closableTaskTabIds.has(e.gen.tabId)),
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
      // A terminal the snapshot does not list is left alone: its row stays truthful, and the next
      // pass retries the decision instead of acting on a stale view.
      if (statuses.get(e.gen.paneId) === undefined) continue;
      await retire(e.gen.paneId);
      await sleep(300);
    }
    await sweepCheckoutSpaces(ttlMs);
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
