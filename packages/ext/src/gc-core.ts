/** Task-tab GC decisions (D29 rules as a pure function; no I/O, no pi/herdr). */
export type GcEntryKind = string;
export type GcEntryStatus = 'running' | 'settled' | 'consumed' | 'closed';

export interface GcEntryLike {
  /** 'task' or a role name; legacy short/resident is a label only. */
  kind: GcEntryKind;
  status: GcEntryStatus;
  /** Consume timestamp (GC grace); closed rows keep the original value. */
  consumedAt?: number | null;
}

function isFinished(status: GcEntryStatus): boolean {
  return status === 'consumed' || status === 'closed' || status === 'settled';
}

/** Close a task tab only when every work pane finished, the grace TTL elapsed (`ttlMs=0` means never
 *  auto-close), no terminal is blocked and the rest are idle/done/error (unknown = never reported). */
export function shouldCloseTaskTab(opts: {
  entries: readonly GcEntryLike[];
  paneStatuses: readonly string[];
  ttlMs: number;
  now: number;
}): boolean {
  if (opts.entries.length === 0) return false;
  if (!opts.entries.every((e) => isFinished(e.status))) return false;
  if (!opts.entries.every((e) => (e.consumedAt ?? 0) > 0 && (e.consumedAt ?? 0) < opts.now - opts.ttlMs)) return false;
  if (opts.paneStatuses.some((s) => s === 'blocked')) return false;
  if (!opts.paneStatuses.every((s) => s === 'idle' || s === 'done' || s === 'error' || s === 'unknown')) return false;
  return true;
}

/** Pane-level collection (orphan / compat path): consumed before the previous turn (grace so the
 *  settlement notice is still visible); a missing terminal → record closed (caller handles the write). */export function shouldClosePane(opts: {
  consumedAt: number | null;
  status: string | undefined;
  prevTurnStart: number;
  /** Only a one-shot spends itself; a persistent worker is the master's to close. */
  lifecycle?: 'one-shot' | 'persistent';
}): boolean {
  if (opts.status === undefined) return true; // terminal gone → record settled
  // Killing a persistent worker's process buys nothing: it has no pane to reclaim, and the next
  // `send` would pay a cold start and revive a conversation that was never over.
  if (opts.lifecycle !== 'one-shot') return false;
  if (opts.status !== 'idle' && opts.status !== 'done' && opts.status !== 'error') return false;
  return (opts.consumedAt ?? 0) > 0 && opts.consumedAt! < opts.prevTurnStart;
}

/** A subagent row as the checkout sweep sees it: which checkout it works in, and whether it is done. */
export interface CheckoutRowLike extends GcEntryLike {
  worktreePath?: string | null;
}

export interface CheckoutSweep {
  /** Checkouts whose space closes: every row there is `closed`, so nothing is alive inside. */
  close: string[];
  /** Checkouts to remind the master about once, with the consume time the reminder is about. */
  remind: Array<{ path: string; since: number }>;
}

/**
 * A checkout's app space outlives the workers that used it, and nothing else sweeps it: a one-shot's
 * reclaim closes the space only for one-shots, so a persistent worker leaves its window behind. Two
 * decisions, and neither ends a task:
 *   - close the space when every row of that checkout is `closed` — an empty window is cleanup;
 *   - remind the master, once per settlement, when every row there finished but one is not closed.
 *     That window stays: `space.close` ends the terminals inside it, and an idle worker is still
 *     the master's to send more work to.
 */
export function decideCheckoutSpaces(opts: {
  rows: readonly CheckoutRowLike[];
  ttlMs: number;
  now: number;
  /** Path → the `since` a reminder was already delivered for; nothing new settled since. */
  remindedAt?: ReadonlyMap<string, number>;
}): CheckoutSweep {
  const byPath = new Map<string, CheckoutRowLike[]>();
  for (const row of opts.rows) {
    const path = row.worktreePath;
    if (!path) continue;
    const arr = byPath.get(path) ?? [];
    arr.push(row);
    byPath.set(path, arr);
  }
  const close: string[] = [];
  const remind: Array<{ path: string; since: number }> = [];
  for (const [path, rows] of byPath) {
    if (rows.every((r) => r.status === 'closed')) {
      close.push(path);
      continue;
    }
    if (opts.ttlMs <= 0) continue;
    if (!rows.every((r) => isFinished(r.status))) continue;
    const since = Math.max(...rows.map((r) => r.consumedAt ?? 0));
    if (since <= 0 || since >= opts.now - opts.ttlMs) continue;
    if (since <= (opts.remindedAt?.get(path) ?? 0)) continue;
    remind.push({ path, since });
  }
  return { close, remind };
}

/** One line the master can act on. It names the decision, never a countdown: nothing closes by
 *  itself, and housekeeping never ends a window that still holds an idle worker. */
export function formatIdleCheckoutNotice(opts: {
  name: string;
  minutes: number;
  panes: readonly string[];
}): string {
  const who = opts.panes.length > 0 ? ` (${opts.panes.join(', ')})` : '';
  return `Note: the checkout ${opts.name} has had no running subagent for ${opts.minutes} min${who}. ` +
    'Its app space stays open: housekeeping never closes a window with an idle worker in it. ' +
    'Close what you no longer need with subagent action:"close"; the checkout itself is never removed.';
}
