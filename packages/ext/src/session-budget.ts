/**
 * E6: what one session may carry of report TEXT, not only what one delivery may.
 *
 * The per-delivery budget (`PIHER_NOTICE_BODY_BUDGET_BYTES`, 4 KB) judges every delivery on its own,
 * so a session that settles a hundred workers pays 4 KB a hundred times and never notices. Measured
 * over this repo's own sessions: **528 KB of report text delivered across 187 settlements in 24
 * sessions, 93% of it from 41% of the settlements** — the cost is a tail, and a per-delivery budget
 * cannot see a tail. So a second ceiling, this one for the session: 32 KiB of report text (≈ 8k
 * tokens), which is the measured *mean* session (22 KB) with room to spare. An ordinary session is
 * unchanged and the tail is bounded.
 *
 * Two properties make the counter honest, and both are about where it lives:
 *
 * - **It is durable.** The count sits in a sidecar beside the settlement ledger (`<ledger>.bytes`),
 *   written the way the cursor is — tmp + rename, one small JSON object — so a restart, a `/reload`
 *   or a compaction never hands the same conversation a fresh ceiling. RAM would.
 * - **It only grows with what pi took.** It is recorded after the message was accepted, exactly like
 *   the ledger cursor: a refused send, a notice the buffer still holds, or a host with no send method
 *   adds nothing, so the number states what the master actually read.
 *
 * The ceiling is not a replacement for the per-delivery budget: a delivery's inline body allowance is
 * `min(per-delivery budget, what the session has left)`, so nothing here can ever make one delivery
 * carry more than it did before.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { integerOption } from './options.ts';
import { swallow } from './swallow.ts';

/** Report bytes one session carries inline by default; `PIHER_SESSION_REPORT_BUDGET_BYTES` overrides
 *  it. 32 KiB is the measured mean session (22 KB of report text) plus room: the tail gets cut, the
 *  ordinary session never notices. */
export const SESSION_REPORT_BUDGET_BYTES = 32768;

/** The session budget a process reads: the registry default, or the environment's value. */
export function sessionReportBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  return integerOption('PIHER_SESSION_REPORT_BUDGET_BYTES', env);
}

/** What one delivery is judged against: the session's ceiling and what it has already carried. */
export interface SessionReportBudget {
  /** Report bytes pi has already taken in this session. */
  deliveredBytes: number;
  /** The ceiling those bytes are counted against. */
  ceilingBytes: number;
}

/** The room a session has left. Never negative: an overshoot (a lone report larger than the whole
 *  ceiling) spends the rest of the session, and says so, instead of counting backwards. */
export function remainingReportBytes(budget: SessionReportBudget): number {
  return Math.max(0, budget.ceilingBytes - budget.deliveredBytes);
}

/** What the composition root hands the notice buffer: the ceiling this process reads, and the count
 *  the subagent plugin keeps beside the ledger. No port (a worker, a bare pi) means this host keeps no
 *  records and no accounting — null, and the delivery is judged per delivery as it always was. */
export function portSessionBudget(
  port: { sessionReportBytes?: () => number } | null | undefined,
  ceilingBytes: number,
): SessionReportBudget | null {
  const deliveredBytes = port?.sessionReportBytes?.();
  return deliveredBytes === undefined ? null : { deliveredBytes, ceilingBytes };
}

/** The one line a delivery adds when the session ceiling — and not the per-delivery budget — is why
 *  its bodies are pointers. It states the numbers it used, so the master can see what it is paying. */
export function sessionBudgetLine(budget: SessionReportBudget): string {
  return `session report budget: ${budget.deliveredBytes} B of ${budget.ceilingBytes} B of report text `
    + 'already delivered in this session, so report bodies travel as pointers here '
    + '(subagent(action:"reports") or "output" reads them in full)';
}

/** The sidecar: beside the cursor the ledger writes (`<ledger>.jsonl.seq`), so one session's
 *  accounting stays one directory. Null when the session has nowhere durable to write — the count is
 *  then this process's alone, exactly as the ledger is. */
export function sessionReportBytesPath(ledgerFile: string | null): string | null {
  return ledgerFile === null ? null : `${ledgerFile}.bytes`;
}

/** `{version: 1, deliveredBytes: n}`. Absent, torn or foreign reads as 0: a lost count costs bytes on
 *  the next delivery (the session is treated as fresh), never a settlement. */
export function parseSessionReportBytes(text: string): number {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const rec = parsed as Record<string, unknown>;
    if (rec.version !== 1) return 0;
    const bytes = rec.deliveredBytes;
    return typeof bytes === 'number' && Number.isInteger(bytes) && bytes > 0 ? bytes : 0;
  } catch {
    return 0;
  }
}

export function formatSessionReportBytes(deliveredBytes: number): string {
  return `${JSON.stringify({ version: 1, deliveredBytes })}\n`;
}

export interface SessionReportCounter {
  /** The sidecar, or null when this session has nowhere durable to write. */
  readonly file: string | null;
  readonly ceiling: number;
  /** What pi has taken so far in this session. */
  delivered(): number;
  /** The budget a delivery reads right now. */
  budget(): SessionReportBudget;
  /** Add what pi accepted. Call it only after the message was taken, like the cursor. */
  record(bytes: number): void;
  /** Follow the ledger to another file (a session checkpoint may move the checkout). */
  repoint(file: string | null): void;
}

/** tmp + rename, like the cursor and the task documents: a crash mid-write leaves the previous count
 *  intact. A count left behind only means the next delivery is judged on the older, smaller number —
 *  it never drops a settlement. */
function writeCount(file: string, value: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, formatSessionReportBytes(value));
    renameSync(tmp, file);
  } catch (err) {
    console.error(`[piher] session report counter write failed: ${file}: ${(err as Error).message}`);
  }
}

/** Open (or create) this session's counter. `file: null` keeps it in memory, which is what a session
 *  with no repository and no place for state gets. */
export function openSessionReportBytes(opts: {
  file: string | null;
  ceiling?: number;
}): SessionReportCounter {
  const ceiling = opts.ceiling ?? sessionReportBudgetBytes();
  let file: string | null = null;
  let delivered = 0;

  function load(next: string | null): void {
    file = next;
    delivered = 0;
    if (next === null) return;
    try {
      delivered = parseSessionReportBytes(readFileSync(next, 'utf8'));
    } catch (err) {
      swallow('session-budget.read', err);
    }
  }

  load(opts.file);

  return {
    get file() {
      return file;
    },
    ceiling,
    delivered: () => delivered,
    budget: () => ({ deliveredBytes: delivered, ceilingBytes: ceiling }),
    record(bytes) {
      if (!Number.isInteger(bytes) || bytes <= 0) return;
      delivered += bytes;
      if (file !== null) writeCount(file, delivered);
    },
    repoint(next) {
      if (next === file) return;
      load(next);
    },
  };
}
