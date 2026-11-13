/**
 * The settlement ledger: the durable seam under the notice channel (E1). One append-only file per
 * session, sitting beside the task records it describes (`<repo>/.piher/tasks/`), holding one line
 * per fact piher knows about a worker.
 *
 * Why a file and not the core: the core's documents are key/value with compare-and-swap, so
 * "append" would be read-modify-write of an unbounded array — a lost update per writer instead of a
 * fact. One writer (the master's extension process) appending lines needs no CAS at all.
 *
 * Why beside the records and not in the session state root: the ledger and the row it explains
 * answer the same question together — the row is the task's current state, the ledger is what
 * happened to it — so they move, get backed up and get swept as one directory. The file is named per
 * session (`settlement-<sessionId>.jsonl`) because the delivery cursor is per session: a session
 * replays its own settlements, and two sessions never write the same file.
 *
 * The one rule that makes delivery lossless: **`deliveredSeq` is written only after pi accepted the
 * message**. The notice buffer holds RAM, so anything it was given and did not hand to pi is not
 * delivered — no matter what the row says. Writing the fact here first and the cursor last means a
 * crash, a `/reload` or a compaction re-delivers what was never read (at least once, idempotent by
 * `(taskId, at)`), instead of losing it for good.
 *
 * File format — one JSON object per line, terminated by `\n`, fields in this order:
 * `{seq, at, taskId, pane, turn, kind, group?, payloadRef?}`. Line-delimited rather than one JSON
 * document because the file only ever grows from its end: an append is one `write`, a torn tail
 * costs the last line and nothing else, and no reader ever rewrites what an earlier process wrote.
 * No migration and no compatibility window: a row with no ledger line is legacy and is not replayed.
 *
 * What the poller writes today are the three kinds the master acts on — `settled`, `failed`,
 * `pane-gone`; `spawned`, `booted`, `steered` and `closed` are in the format because they are the
 * same kind of fact, and the phases after this one record them. The file is never pruned by age or
 * count (S8): one line per settlement is the price of a settlement nobody can lose.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { swallow } from './swallow.ts';
import { repoTasksDir } from './task-store.ts';

/** Every fact kind the ledger understands. `settled | failed | pane-gone` are the ones the master
 *  acts on (a settlement notice); the rest are recorded facts with no delivery of their own yet. */
export const SETTLEMENT_EVENT_KINDS = [
  'spawned', 'booted', 'failed', 'settled', 'steered', 'closed', 'pane-gone',
] as const;

export type SettlementEventKind = (typeof SETTLEMENT_EVENT_KINDS)[number];

/** Kinds whose delivery the master acts on: these are what a restart re-delivers. */
const SETTLEMENT_FACT_KINDS: ReadonlySet<SettlementEventKind> = new Set<SettlementEventKind>([
  'settled', 'failed', 'pane-gone',
]);

export function isSettlementFact(kind: SettlementEventKind): boolean {
  return SETTLEMENT_FACT_KINDS.has(kind);
}

export interface SettlementEvent {
  /** Monotonic across the file, starting at 1. The cursor is a seq, never a time. */
  seq: number;
  /** When the fact happened: the settlement's own `at` for a report document, the observation's
   *  clock for a pane that went. Half of the delivery key `(taskId, at)`, alongside `taskId`. */
  at: number;
  taskId: string;
  /** The worker address the fact is about (its terminal id). */
  pane: string;
  /** The core's turn counter, or null when the observer could not read one. */
  turn: number | null;
  kind: SettlementEventKind;
  /** Reserved for E1's aggregate delivery (a phase's settlements in one group). Not emitted yet. */
  group?: string;
  /** Where the fact's payload lives (`piher.rep.<pane>` for a report document), so a re-delivery
   *  reads the body instead of trusting a copy of it. */
  payloadRef?: string;
}

/** The delivery key: one settlement, one identity, across restarts. */
export function settlementKey(taskId: string, at: number): string {
  return `${taskId}:${at}`;
}

/** One ledger line. Field order is fixed so the file stays readable and diffable. */
export function formatSettlementEvent(event: SettlementEvent): string {
  return JSON.stringify({
    seq: event.seq,
    at: event.at,
    taskId: event.taskId,
    pane: event.pane,
    turn: event.turn,
    kind: event.kind,
    ...(event.group === undefined ? {} : { group: event.group }),
    ...(event.payloadRef === undefined ? {} : { payloadRef: event.payloadRef }),
  });
}

function isKind(value: unknown): value is SettlementEventKind {
  return typeof value === 'string' && (SETTLEMENT_EVENT_KINDS as readonly string[]).includes(value);
}

/** One line out of an unknown value. A line that is not a complete fact is not a fact: never throws. */
export function parseSettlementEvent(value: unknown): SettlementEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.seq !== 'number' || !Number.isInteger(rec.seq) || rec.seq < 1) return null;
  if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return null;
  if (typeof rec.taskId !== 'string' || rec.taskId === '') return null;
  if (typeof rec.pane !== 'string') return null;
  const turn = rec.turn === null || rec.turn === undefined
    ? null
    : (typeof rec.turn === 'number' && Number.isInteger(rec.turn) ? rec.turn : null);
  if (!isKind(rec.kind)) return null;
  return {
    seq: rec.seq,
    at: rec.at,
    taskId: rec.taskId,
    pane: rec.pane,
    turn,
    kind: rec.kind,
    ...(typeof rec.group === 'string' ? { group: rec.group } : {}),
    ...(typeof rec.payloadRef === 'string' ? { payloadRef: rec.payloadRef } : {}),
  };
}

export interface LedgerParse {
  events: SettlementEvent[];
  /** The highest seq a whole line carried: the next append is one past it. */
  lastSeq: number;
  /** The file ended mid-line: the fragment was dropped and every earlier event survived. */
  torn: boolean;
}

/**
 * Read the ledger tolerantly. Three things a crash can leave behind, and none of them costs an
 * earlier event: a last line with no terminator (the write never finished), a line that does not
 * parse at all (a fragment glued to the next append), and a repeated or backwards seq (only one
 * writer exists, so a repeat is not a fact). Monotonic acceptance is also what makes the parse
 * stable across a repaired tail.
 */
export function parseSettlementLedger(text: string): LedgerParse {
  const torn = text !== '' && !text.endsWith('\n');
  const lines = text.split('\n');
  if (torn) lines.pop();
  const events: SettlementEvent[] = [];
  let lastSeq = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = parseSettlementEvent(value);
    if (!event || event.seq <= lastSeq) continue;
    lastSeq = event.seq;
    events.push(event);
  }
  return { events, lastSeq, torn };
}

/** The cursor document: `{version: 1, deliveredSeq: n}`. Absent, torn or foreign reads as 0 — a
 *  lost cursor re-delivers (at most one duplicate each) instead of dropping a settlement. */
export function parseSettlementCursor(text: string): number {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const rec = parsed as Record<string, unknown>;
    if (rec.version !== 1) return 0;
    return typeof rec.deliveredSeq === 'number' && Number.isInteger(rec.deliveredSeq) && rec.deliveredSeq > 0
      ? rec.deliveredSeq
      : 0;
  } catch {
    return 0;
  }
}

/**
 * What a restart must re-deliver: every settlement fact after the cursor that this session does not
 * already hold. `settledThroughAt` is the per-task half of the rule — the record's `consumedAt`, now
 * written only when pi accepted — so the one event a crash can leave straddling "accepted, cursor
 * not yet written" is recognised and skipped instead of shown twice.
 */
export function planLedgerReplay(input: {
  events: readonly SettlementEvent[];
  deliveredSeq: number;
  /** The settlement time this session already holds for the task: `-1` when it holds none (deliver),
   *  and `Number.POSITIVE_INFINITY` when the task is final, so nothing of its history is re-delivered. */
  settledThroughAt: (taskId: string) => number;
}): SettlementEvent[] {
  const out: SettlementEvent[] = [];
  for (const event of input.events) {
    if (event.seq <= input.deliveredSeq) continue;
    if (!isSettlementFact(event.kind)) continue;
    if (event.at <= input.settledThroughAt(event.taskId)) continue;
    out.push(event);
  }
  return out;
}

/** `<repo>/.piher/tasks/settlement-<sessionId>.jsonl`; null when the session has no id or the
 *  checkout is not a git repository. The name stays out of `listTaskRecords`, which reads `.json`. */
export function settlementLedgerPath(cwd: string, sessionId: string): string | null {
  const id = sessionId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  if (id === '') return null;
  const dir = repoTasksDir(cwd);
  return dir === null ? null : join(dir, `settlement-${id}.jsonl`);
}

export interface SettlementLedger {
  /** The backing file, or null when this session has nowhere durable to write (no repository). Then
   *  every method still works, in memory only — the session behaves exactly as it did before. */
  readonly file: string | null;
  events(): readonly SettlementEvent[];
  lastSeq(): number;
  /** The last seq pi accepted. Everything above it is re-delivered on the next start. */
  deliveredSeq(): number;
  /** Record one fact. Idempotent by `(taskId, at)` for settlement facts: a refused notice is
   *  retried with the same identity, so a retry never forks one settlement into two ledger lines. */
  append(input: Omit<SettlementEvent, 'seq'>): SettlementEvent;
  /** Advance the cursor. Call it only after pi accepted the message — never before. */
  markDelivered(seq: number): void;
  /** Point this same ledger at another file and re-read it. One object serves the whole process, so
   *  the poller that captured it at mount keeps writing to whatever the session's checkout became. */
  repoint(file: string | null): void;
}

/** tmp + rename: a crash mid-write leaves the previous cursor intact, like the task documents. */
function writeCursor(file: string, value: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, deliveredSeq: value })}\n`);
    renameSync(tmp, file);
  } catch (err) {
    // A cursor left behind only costs a duplicate on the next start; it never drops a settlement.
    console.error(`[piher] settlement cursor write failed: ${file}: ${(err as Error).message}`);
  }
}

/**
 * Open (or create) the ledger for a session. `file: null` keeps everything in memory, which is what
 * a session with no repository and no place for state gets.
 */
export function openSettlementLedger(opts: { file: string | null }): SettlementLedger {
  let file: string | null = null;
  let cursorFile: string | null = null;
  let events: SettlementEvent[] = [];
  let lastSeq = 0;
  /** A torn tail left no terminator, so the next append must start a fresh line before its own. */
  let needsSeparator = false;
  let delivered = 0;
  /** Facts already appended, by `(taskId, at)`: the retry of a refused notice finds its own line. */
  const facts = new Map<string, SettlementEvent>();

  function load(next: string | null): void {
    file = next;
    cursorFile = next === null ? null : `${next}.seq`;
    let text = '';
    if (file !== null) {
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        swallow('settlement-ledger.read', err);
      }
    }
    const parsed = parseSettlementLedger(text);
    events = parsed.events;
    lastSeq = parsed.lastSeq;
    needsSeparator = parsed.torn;
    delivered = 0;
    if (cursorFile !== null) {
      try {
        delivered = parseSettlementCursor(readFileSync(cursorFile, 'utf8'));
      } catch (err) {
        swallow('settlement-ledger.read-cursor', err);
      }
    }
    // A cursor ahead of the file is not a fact about the file: the ledger was truncated or replaced,
    // so trust the events that are actually there.
    delivered = Math.min(delivered, lastSeq);
    facts.clear();
    for (const event of events) {
      if (isSettlementFact(event.kind)) facts.set(settlementKey(event.taskId, event.at), event);
    }
  }

  load(opts.file);

  return {
    get file() {
      return file;
    },
    events: () => events,
    lastSeq: () => lastSeq,
    deliveredSeq: () => delivered,
    append(input) {
      if (isSettlementFact(input.kind)) {
        const seen = facts.get(settlementKey(input.taskId, input.at));
        if (seen) return seen;
      }
      const seq = lastSeq + 1;
      const event: SettlementEvent = { seq, ...input };
      lastSeq = seq;
      const target = file;
      if (target !== null) {
        try {
          mkdirSync(dirname(target), { recursive: true });
          appendFileSync(target, `${needsSeparator ? '\n' : ''}${formatSettlementEvent(event)}\n`);
          needsSeparator = false;
        } catch (err) {
          // The fact is still in memory and this process still delivers it; only a crash before the
          // next successful append could lose it, which is where the ledger already was.
          console.error(`[piher] settlement ledger append failed: ${target}: ${(err as Error).message}`);
        }
      }
      events.push(event);
      if (isSettlementFact(event.kind)) facts.set(settlementKey(event.taskId, event.at), event);
      return event;
    },
    markDelivered(seq) {
      if (!Number.isInteger(seq) || seq <= delivered) return;
      delivered = seq;
      if (cursorFile !== null) writeCursor(cursorFile, seq);
    },
    repoint(next) {
      if (next === file) return;
      load(next);
    },
  };
}
