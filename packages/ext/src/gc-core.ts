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
 *  settlement notice is still visible); a missing terminal → record closed (caller handles the write). */
export function shouldClosePane(opts: {
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
