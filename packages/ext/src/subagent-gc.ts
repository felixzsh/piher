/**
 * Subagent board hygiene: registry projection + recovery and terminal collection. Predicates live in
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
import { trace, traceRole } from './trace.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { swallow } from './swallow.ts';
import { foldSubsRegistry, registrySnapshot, sleep, SUBS_CUSTOM_TYPE, type SubEntry } from './subagent-core.ts';
import type { PaneStateSlot } from './plugins/bg-job.ts';

/* ── registry projection + recovery ─────────────────────────────── */

/** S53: `terminal.kill` then `terminal.rm` — the app closes the pane, and its tab goes with the last
 *  terminal. A terminal that already exited is not an error, and neither is one core reaped itself. */
export async function retirePane(
  client: Pick<CoreClientLike, 'kill' | 'remove'>,
  paneId: string,
): Promise<void> {
  try { await client.kill(paneId); } catch { /* already exited */ }
  try { await client.remove(paneId); } catch { /* core reaps finished terminals */ }
}

interface SubagentRegistryHost {
  pi: { appendEntry?: (customType: string, data: unknown) => void };
  client: CoreClientLike;
  subs: Map<string, SubEntry>;
  writeHistory: (entry: SubEntry, patch?: { status?: SubEntry['status']; closedAt?: number }, via?: string) => void;
}

interface SubagentRegistry {
  /** Append the registry snapshot to the session branch; duplicate snapshots are skipped. */
  persist(): void;
  rebuild(eventCtx: unknown): void;
  sweepZombieRunning(): Promise<void>;
}

export function createSubagentRegistry(host: SubagentRegistryHost): SubagentRegistry {
  let lastSnapshot = '';

  function persist(): void {
    try {
      const registry = registrySnapshot(host.subs.values());
      const snapshot = JSON.stringify(registry);
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      host.pi.appendEntry?.(SUBS_CUSTOM_TYPE, registry);
    } catch (err) {
      // Session logging must not break delegation; a silent failure here shows up as a ghost running row.
      swallow('subagent.persist-subs', err);
    }
  }

  function rebuild(eventCtx: unknown): void {
    try {
      const entries = (eventCtx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      const registry = foldSubsRegistry(entries as Parameters<typeof foldSubsRegistry>[0]);
      for (const entry of registry.subs) host.subs.set(entry.paneId, entry);
      lastSnapshot = ''; // branch replay replaced live state; force the next persist
    } catch {
      /* registry recovery failure must not block the live session */
    }
  }

  async function sweepZombieRunning(): Promise<void> {
    if (!host.client.available || host.subs.size === 0) return;
    let liveTerminalIds: ReadonlySet<string>;
    try {
      liveTerminalIds = new Set((await host.client.listTerminals()).map((terminal) => terminal.id));
    } catch {
      return; // do not close agents when the liveness lookup itself failed
    }
    let changed = false;
    for (const [paneId, entry] of host.subs) {
      if (entry.status !== 'running' || liveTerminalIds.has(paneId)) continue;
      // Its pane is gone, so it is not running — but nothing ended it: a vanished pane is unfinished
      // work, and unfinished work is what `resume` exists for. Only `close` may write `closed`.
      entry.status = 'settled';
      host.writeHistory(entry, { status: 'settled' }, 'zombie-sweep');
      trace(traceRole, 'gc-release', { pane: entry.paneId, via: 'zombie-sweep', taskId: entry.taskId });
      changed = true;
    }
    if (changed) persist();
  }

  return { persist, rebuild, sweepZombieRunning };
}

/* ── GC ─────────────────────────────────────────────────────────── */

interface GcHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(e: SubEntry, patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }, via?: string): void;
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
    const rows: CheckoutRowLike[] = [...h.subs.values()]
      .filter((e) => e.worktree?.path)
      .map((e) => ({
        kind: e.kind,
        status: e.status,
        consumedAt: e.consumedAt ?? null,
        worktreePath: e.worktree?.path ?? null,
      }));
    if (rows.length === 0) return;
    const sweep = decideCheckoutSpaces({ rows, ttlMs, now: Date.now(), remindedAt: remindedCheckouts });
    for (const path of sweep.close) {
      await h.checkoutSpace?.close(checkoutSpaceId(path)).catch(() => null);
    }
    for (const { path, since } of sweep.remind) {
      const idle = [...h.subs.values()].filter((e) => e.worktree?.path === path);
      const notice = formatIdleCheckoutNotice({
        name: basename(path),
        minutes: Math.round(ttlMs / 60000),
        panes: idle.map((e) => e.paneId),
      });
      try {
        await h.deliverNotice?.(notice, idle[0]?.paneId);
      } catch {
        continue; // refused (master mid-turn): the next tick retries the same reminder
      }
      remindedCheckouts.set(path, since);
    }
  }

  async function gcPass(): Promise<void> {
    if (h.subs.size === 0) return;
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
      running: [...h.subs.values()]
        .filter((e) => e.status === 'running')
        .slice(0, 8)
        .map((e) => `${e.paneId}:${statuses.get(e.paneId) ?? 'absent'}`)
        .join(','),
      watch: watch.connected,
    });
    const termPaneIds = h.terminalState.activePaneIds();
    const pendingNoticeIds = h.noticePending?.() ?? new Set<string>();

    const byTab = new Map<string, SubEntry[]>();
    for (const e of h.subs.values()) {
      if (!e.tabId) continue;
      const arr = byTab.get(e.tabId) ?? [];
      arr.push(e);
      byTab.set(e.tabId, arr);
    }
    const mainTabId = (await h.client.placementLabels())['herdr.tab'] ?? '';

    /**
     * Housekeeping never ends a task. The pane and the tab are piher's to reclaim, but the row is the
     * master's: it becomes `settled` (unfinished, resumable) and only `close` writes `closed`. A sweep
     * that stamped `closed` used to be undone by `send` reviving it, which is exactly the coupling
     * that made "close is final" contradictory.
     */
    const releaseRow = (e: SubEntry): void => {
      if (e.status !== 'running') return;
      e.status = 'settled';
      h.writeHistory(e, { status: 'settled' }, 'gc');
      trace(traceRole, 'gc-release', { pane: e.paneId, via: 'gc', taskId: e.taskId });
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
        entries,
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
    const candidates = [...h.subs.values()].filter(
      (e) => e.status === 'consumed' && !(e.tabId && closableTaskTabIds.has(e.tabId)),
    );
    for (const e of candidates) {
      if (termPaneIds.has(e.paneId) || pendingNoticeIds.has(e.paneId)) continue;
      // Never collect self, whatever the registry says: a poisoned entry once closed the master's terminal.
      if (h.env?.terminalId && e.paneId === h.env.terminalId) continue;
      if (!shouldClosePane({
        consumedAt: e.consumedAt ?? null,
        status: statuses.get(e.paneId),
        prevTurnStart,
        lifecycle: e.lifecycle,
      })) continue;
      if (statuses.get(e.paneId) === undefined) {
        releaseRow(e);
        continue;
      }
      await retire(e.paneId);
      releaseRow(e);
      await sleep(300);
    }
    await sweepCheckoutSpaces(ttlMs);
    h.persistSubs();
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
