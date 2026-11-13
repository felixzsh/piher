/**
 * Settlement report documents (spec S6–S13): the worker writes `piher.rep.<address>` on every
 * settle, and the master delivers that document on the core's `turn` event, deduped per
 * settlement.
 *
 * The document rules live here for both piher documents: the names (S9), the value guards and the
 * compare-and-swap write (S11) that the steering channel in `command-documents.ts` shares, so the
 * two can never disagree about how a document is spelled or written.
 *
 * Pure planners decide; adapters do I/O. The master poll loop (subagent-poller.ts), the worker
 * settle hook (index.ts) and the worker's command watch both build on this module.
 */
import type { CoreClientLike } from './core-client.ts';
import { reportsSettlement } from './settle-wake-core.ts';

/** Report document value (spec S10): the worker's own closing words plus the turn they belong to.
 *
 *  `stopReason` states the reason when the worker ended without words (spec S8): an errored or
 *  refused turn has no closing message, and the diagnosis — not the stopped-mid-turn word — is
 *  what lets the master act. A document with `text === null` therefore carries the diagnosis in
 *  `stopReason`, and a document with text carries the turn's own stop reason. */
export interface ReportDocumentValue {
  taskId: string;
  turn: number;
  stopReason: string | null;
  session: string | null;
  text: string | null;
  at: number;
}

/** The core's per-document ceiling; a value at or under it always fits. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

export function truncationMarker(droppedChars: number): string {
  return `\n\n[report truncated: ${droppedChars} characters over the core's document limit]`;
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

/** Command document name for a worker address (spec S9): one spelling for both sides — the master
 *  writes it, the worker's own watch reads it (see `command-documents.ts`). */
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

/** Dedupe key for one settlement delivery (spec S7): one notice per settlement.
 *
 *  The identity is the *document instance* — its address and the worker's own `at` — not
 *  (`taskId`, `turn`). `turn` is the core's counter and is recorded in the value for the master's
 *  eyes, but it cannot be the key: a revive reuses turn values on a new terminal (spec S3), and a
 *  settle that reads the record before the core has published the turn change would file a genuine
 *  settlement under the previous turn and lose it as a duplicate. `at` is minted by the worker once
 *  per settle, so it names exactly one settlement and repeats exactly for a re-read of the same
 *  document. */
export function reportDeliveryKey(address: string, at: number): string {
  return `${address}:${at}`;
}

/** The last settlement delivered for a row: which document, identified the same way. */
export interface DeliveredReport {
  address: string;
  at: number;
}

export type ReportDeliveryPlan =
  /** A settlement this request has not delivered yet. */
  | { kind: 'deliver' }
  /** The same (`taskId`, `turn`) already went out: a second `turn` event for it delivers nothing. */
  | { kind: 'duplicate' }
  /** The document predates the request boundary: it belongs to an earlier turn, whose report the
   *  poller already delivered. Delivering it would announce finished work as the answer to a request
   *  that is still running. */
  | { kind: 'stale' }
  /** Not this task's report (a stale document from another generation): leave it alone. */
  | { kind: 'foreign' };

/** Whether a report document read off the core settles the tracked task. */
export function planReportDelivery(input: {
  value: ReportDocumentValue;
  taskId: string;
  /** The worker address the document was read from; identifies the generation. */
  address: string;
  /** The current request's boundary: a document written before it answers an earlier request. */
  sinceTs: number;
  /** The settlement already delivered for this row. It names the document instance (`address`, `at`),
   *  so this is an exact identity, never a race between two clocks: a follow-up clearing the consume
   *  time must not make the report the poller already announced look like news. */
  delivered?: DeliveredReport | null;
  /** Settlements this mount delivered, by `reportDeliveryKey`. */
  deliveredKeys: ReadonlySet<string>;
}): ReportDeliveryPlan {
  if (input.value.taskId !== input.taskId) return { kind: 'foreign' };
  if (input.delivered && input.delivered.address === input.address && input.value.at <= input.delivered.at) {
    return { kind: 'duplicate' };
  }
  if (input.value.at < input.sinceTs) return { kind: 'stale' };
  if (input.deliveredKeys.has(reportDeliveryKey(input.address, input.value.at))) return { kind: 'duplicate' };
  return { kind: 'deliver' };
}

/**
 * Fit a report value inside the core's per-document ceiling (spec S13): the document keeps the
 * whole report when it fits, and otherwise keeps the longest prefix that does, plus a marker saying
 * how much was dropped. Only the text is trimmed — the settlement facts stay exact, so a truncated
 * report is still delivered rather than lost to an unwritable document.
 *
 * The prefix is found by binary search over the fit itself: byte length is not a function of the
 * character count (a quote, a newline or an escaped control character costs several bytes), so
 * shrinking by the overage in characters would overshoot — and for an escape-heavy report it drove
 * the text to nothing, delivering a body that was only the marker.
 */
export function fitReportDocument(value: ReportDocumentValue, maxBytes = MAX_DOCUMENT_BYTES): ReportDocumentValue {
  if (documentByteLength(value) <= maxBytes) return value;
  const original = value.text ?? '';
  const withPrefix = (keep: number): ReportDocumentValue => ({
    ...value,
    text: original.slice(0, keep) + truncationMarker(original.length - keep),
  });
  // Largest `keep` whose value fits. The marker alone may still not fit a pathological ceiling, in
  // which case the text is empty: never more than the ceiling, and never a silent lie about length.
  let low = 0;
  let high = original.length;
  let best: ReportDocumentValue | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withPrefix(mid);
    if (documentByteLength(candidate) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else if (mid === 0) {
      break;
    } else {
      high = mid - 1;
    }
  }
  return best ?? { ...value, text: '' };
}

/** Serialized size of a document value: what the core's per-document ceiling counts. */
export function documentByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

export type DocumentWriteResult =
  | { ok: true; version: number }
  | { ok: false; reason: string };

/**
 * Write a piher document with compare-and-swap (spec S11): read the version, write against it, and
 * on `conflict` re-read and retry — never an unconditional overwrite. A transport failure is
 * retried once: a document is the durable channel (a report to the master, a command to a worker),
 * so the one thing this must not do is give up while a second attempt could still deliver it. A
 * failure names its reason so the caller can say what was lost.
 *
 * `name` is null when the address cannot name a document (S9); `unsupported` is the reason that
 * caller wants to hear then.
 */
export async function writeDocument(
  client: CoreClientLike,
  name: string | null,
  value: unknown,
  opts: { attempts?: number; unsupported?: string } = {},
): Promise<DocumentWriteResult> {
  if (!name) return { ok: false, reason: opts.unsupported ?? 'this address cannot name a document (S9)' };
  if (!client.available) return { ok: false, reason: 'no herdr-core terminal' };
  const transportAttempts = Math.max(1, opts.attempts ?? 2);
  let reason = 'the core refused the document';
  for (let transport = 0; transport < transportAttempts; transport++) {
    for (let conflict = 0; conflict < 2; conflict++) {
      let current: { value: unknown; version: number } | null;
      try {
        current = await client.docGet(name);
      } catch (err) {
        reason = `doc.get failed: ${errorText(err)}`;
        break; // a transport problem: retry the whole attempt
      }
      if (current === null) return { ok: false, reason: 'no document store answered' };
      try {
        return { ok: true, version: await client.docSet(name, value, current.version) };
      } catch (err) {
        const kind = (err as { kind?: unknown })?.kind;
        if (kind !== 'conflict') {
          reason = `doc.set failed: ${errorText(err)}`;
          break; // transport: retry the attempt
        }
        reason = `doc.set conflicted twice at version ${current.version}`;
      }
    }
  }
  return { ok: false, reason };
}

/** A report document, fitted to the core's ceiling (S13) and written with the CAS discipline above. */
export async function writeReportDocument(
  client: CoreClientLike,
  address: string,
  value: ReportDocumentValue,
  opts: { attempts?: number } = {},
): Promise<DocumentWriteResult> {
  return writeDocument(client, reportDocName(address), fitReportDocument(value), {
    ...opts,
    unsupported: `"${address}" cannot name a document (S9)`,
  });
}

function errorText(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  return typeof message === 'string' && message !== '' ? message : String(err);
}

/* ── the worker's write side of a settlement (spec S6/S8) ──────── */

/** Why a settle wrote no report document. */
export type SettleWriteSkip =
  /** Not a worker at all (the master's own session): it has no report to make. */
  | 'not-a-subagent'
  /** The worker's core client is unavailable: there is no document channel to write through. */
  | 'no-core-client'
  /** No `HC_TERMINAL_ID`: without an address nothing can name a document (spec S9). */
  | 'no-address'
  /** No delegation marker: the pane did not get piher's spawn contract (an older build, or a
   *  terminal started by hand), so it does not know the task it would report for. */
  | 'no-delegation'
  /** This settle reports nothing by rule (an abort, or an error pi retries — S52). */
  | 'reports-nothing';

export type SettleWritePlan =
  | {
    kind: 'write';
    value: ReportDocumentValue;
    /** The core would not report the turn: it is written as 0 rather than losing the settlement. */
    turnUnknown: boolean;
  }
  | { kind: 'skip'; reason: SettleWriteSkip };

/**
 * Whether one settle writes its report document, and with what value (spec S6/S8).
 *
 * Every settle a worker has a channel for writes, including a settle with nothing to say: that
 * document carries `text: null` and `stopReason: null`, which is what lets the master tell "settled
 * with nothing to say" from "never settled". Skipping is reserved for a settle that reports nothing
 * at all and for a worker with no channel — the one case it cannot report itself, which the master
 * then diagnoses from the core's `turn` (spec S5) instead of calling it silence.
 *
 * The empty document cannot land in the middle of a run: `agent_settled` means "pi has no remaining
 * automatic work for that session-level run", and a queued steer or a follow-up counts as remaining
 * work that "can still continue" before it (pi 1.5.2, `docs/json.md:48` and `docs/extensions.md:336`,
 * both read for this). A queued steer therefore keeps the run from settling, so no empty interim
 * settle can fire between a finished turn and the turn the steer starts — the empty document means
 * what it says: this run ended and had nothing to add.
 */
export function planSettleWrite(input: {
  isSubagent: boolean;
  clientAvailable: boolean;
  address: string | null | undefined;
  delegationTaskId: string | null | undefined;
  aborted: boolean;
  lastStopReason: string | null;
  /** The core's turn counter, or null when the core would not report it. */
  turn: number | null;
  turnStopReason: string | null;
  text: string | null;
  /** Why the turn ended without words (a refused tool, an error). */
  why: string | null;
  session: string | null;
  /** The settlement's own stamp: the document's identity (spec S7). */
  at: number;
}): SettleWritePlan {
  if (!input.isSubagent) return { kind: 'skip', reason: 'not-a-subagent' };
  if (!input.clientAvailable) return { kind: 'skip', reason: 'no-core-client' };
  if (!input.address) return { kind: 'skip', reason: 'no-address' };
  if (!input.delegationTaskId) return { kind: 'skip', reason: 'no-delegation' };
  if (!reportsSettlement({ aborted: input.aborted, lastStopReason: input.lastStopReason })) {
    return { kind: 'skip', reason: 'reports-nothing' };
  }
  return {
    kind: 'write',
    turnUnknown: input.turn === null,
    value: {
      taskId: input.delegationTaskId,
      // The turn is the core's counter, recorded for the master's eyes; the document's identity is
      // `at`. A core that will not answer costs the counter, never the settlement.
      turn: input.turn ?? 0,
      // A turn that ended without words states its reason here instead (spec S8): `stopReason`
      // alone would say "stop", which reads as a finished turn that had nothing to report.
      stopReason: input.text === null ? input.why : input.turnStopReason,
      session: input.session,
      text: input.text,
      at: input.at,
    },
  };
}
