/**
 * Settlement report documents (spec S6–S12): the worker writes `piher.rep.<address>` on every
 * settle, and the master delivers that document on the core's `turn` event, deduped by
 * (`taskId`, `turn`).
 *
 * Pure planners decide; adapters do I/O. The master poll loop (subagent-poller.ts) and the worker
 * settle hook (index.ts) both build on this module.
 */
import type { CoreClientLike } from './core-client.ts';

/** Report document value (spec S10): the worker's own closing words plus the turn they belong to. */
export interface ReportDocumentValue {
  taskId: string;
  turn: number;
  stopReason: string | null;
  session: string | null;
  text: string | null;
  at: number;
}

/** Document name for a worker address (spec S9): lowercase, at most 32 characters, terminal-name
 *  rules — the same rules `hc` enforces, so an address the core handed out always qualifies. Null
 *  when the address cannot name a document. */
export function reportDocName(address: string): string | null {
  const name = `piher.rep.${address}`;
  if (name.length > 32) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
  return name;
}

/** Command document name for a worker address (spec S9; written by P3, named here so both sides
 *  share one spelling). */
export function commandDocName(address: string): string | null {
  const name = `piher.cmd.${address}`;
  if (name.length > 32) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
  return name;
}

/** Structural guard for a document value: a foreign or half-written value is not a report. */
export function isReportDocumentValue(value: unknown): value is ReportDocumentValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.taskId === 'string' && v.taskId !== ''
    && typeof v.turn === 'number' && Number.isInteger(v.turn) && v.turn >= 0
    && (v.stopReason === null || typeof v.stopReason === 'string')
    && (v.session === null || typeof v.session === 'string')
    && (v.text === null || typeof v.text === 'string')
    && typeof v.at === 'number';
}

/** Dedupe key for one settlement delivery (spec S7): one notice per (`taskId`, `turn`). */
export function reportDeliveryKey(taskId: string, turn: number): string {
  return `${taskId}:${turn}`;
}

export type ReportDeliveryPlan =
  /** A settlement the master has not delivered yet. */
  | { kind: 'deliver' }
  /** The same (`taskId`, `turn`) already went out: a second `turn` event for it delivers nothing. */
  | { kind: 'duplicate' }
  /** Not this task's report (a stale document from another generation): leave it alone. */
  | { kind: 'ignore' };

/** Whether a report document read off the core settles the tracked task. */
export function planReportDelivery(input: {
  value: ReportDocumentValue;
  taskId: string;
  delivered: ReadonlySet<string>;
}): ReportDeliveryPlan {
  if (input.value.taskId !== input.taskId) return { kind: 'ignore' };
  if (input.delivered.has(reportDeliveryKey(input.value.taskId, input.value.turn))) return { kind: 'duplicate' };
  return { kind: 'deliver' };
}

export interface ReportWrite {
  version: number;
}

/**
 * Write a report document with compare-and-swap (spec S11): read the version, write against it,
 * and on `conflict` re-read once and retry — never an unconditional overwrite. Resolves false
 * when the document could not be written (no core, a repeated conflict); the pipe push stays the
 * fallback, so a failed write is logged, never thrown.
 */
export async function writeReportDocument(
  client: CoreClientLike,
  address: string,
  value: ReportDocumentValue,
): Promise<ReportWrite | null> {
  const name = reportDocName(address);
  if (!name || !client.available) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let current: { value: unknown; version: number } | null;
    try {
      current = await client.docGet(name);
    } catch {
      return null;
    }
    if (current === null) return null;
    try {
      const version = await client.docSet(name, value, current.version);
      return { version };
    } catch (err) {
      const kind = (err as { kind?: unknown })?.kind;
      if (kind !== 'conflict' || attempt > 0) return null;
    }
  }
  return null;
}
