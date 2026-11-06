/**
 * Subagent board hygiene: registry projection + recovery and terminal collection. Predicates live in
 * gc-core.ts; this adapter owns core kill/remove I/O and the ticker.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CoreClientLike, CoreEnv, TerminalInfo } from './core-client.ts';
import { shouldClosePane, shouldCloseTaskTab } from './gc-core.ts';
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
      entry.status = 'closed';
      host.writeHistory(entry, { status: 'closed', closedAt: Date.now() }, 'zombie-sweep');
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
}

interface GcController {
  runGcSafely(): Promise<void>;
  onTurnStart(): Promise<void>;
  startTicker(ctx: Context): void;
}

export function createGcController(h: GcHost): GcController {
  let prevTurnStart = Date.now();
  let gcRunning = false;

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

    const closeRow = (e: SubEntry): void => {
      if (e.status === 'closed') return;
      e.status = 'closed';
      h.writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
    };
    /** The pair `close` and a one-shot settlement use as well. */
    const retire = (id: string): Promise<void> => retirePane(h.client, id);

    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue;
      const tabTerminals = terminals.filter((t) => tabOf(t) === tabId);
      if (tabTerminals.length === 0) {
        for (const e of entries) closeRow(e);
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
      for (const e of entries) closeRow(e);
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
      })) continue;
      if (statuses.get(e.paneId) === undefined) {
        closeRow(e);
        continue;
      }
      await retire(e.paneId);
      closeRow(e);
      await sleep(300);
    }
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
