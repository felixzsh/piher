/**
 * D92 settlement-notice buffer: `sendUserMessage(followUp)` only delivers when the agent has no
 * more tool calls, so a long master run would queue every settlement and flood at the end. Buffer
 * while busy; flush at turn_end (steer) / agent_settled (followUp).
 *
 * A flush is a batch, and a batch is not a sample of itself (E1): every settlement in it gets a row
 * carrying its pane, its description and the size of its report, however many arrived. Only report
 * TEXT is budgeted (E6) — a body travels verbatim while it fits, and a body that does not fit is
 * replaced by the exact call that reads it, never by an instruction to go looking.
 *
 * Two budgets, and the stricter one decides (E6): the per-delivery budget below, and what the session
 * has left of its own ceiling (`session-budget.ts`). The session ceiling is an ADDITIONAL limit — a
 * delivery's allowance is `min(per-delivery, session's remaining room)` — so nothing here can ever
 * make one delivery carry more than the per-delivery budget alone allowed. A delivery the session
 * ceiling shaped says so in its own text: a master is told why a report is a pointer, not left to
 * infer it.
 */

import type { SettlementCard } from './settlement-card.ts';
import { integerOption } from './options.ts';
import { remainingReportBytes, sessionBudgetLine, type SessionReportBudget } from './session-budget.ts';

export type NoticeSendMode = 'steer' | 'followUp';

/** Report bytes one batch carries inline by default; `PIHER_NOTICE_BODY_BUDGET_BYTES` overrides it.
 *  4 KB is the measured trade (plan L10): ten median reports (374 B) travel whole, and no p90 report
 *  (8,108 B) does — the fan-out case either way, with every settlement still named. */
export const NOTICE_BODY_BUDGET_BYTES = 4096;

/** The delivery budget a process reads: the registry default, or the environment's value. */
export function noticeBodyBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  return integerOption('PIHER_NOTICE_BODY_BUDGET_BYTES', env);
}

/** The parts of a settlement a batch row needs, and the only ones a byte budget may touch. `id`,
 *  `description` and `outcome` are identity: they are printed for every settlement in the batch.
 *  `body` is the worker's own text, and it is what the budget buys. */
export interface NoticeRow {
  /** The ledger fact this row answers for, when the row is not a live settlement: `inbox` prints it
   *  so a fact can be named by seq. Absent for the live delivery, whose text is unchanged without
   *  it. */
  seq?: number;
  /** Pane / agent id — also the address its report document is named after. */
  id: string;
  /** What the worker was asked to do, in the words `list` prints. */
  description: string;
  /** The word the row prints for what happened: one settlement's own outcome, or the budget's
   *  non-settlement endings (`no-progress`, `no-report`), which are not task results. */
  outcome: 'settled' | 'failed' | 'closed' | 'no-progress' | 'no-report';
  /** The report text, or null when this row carries none (see `note`). */
  body: string | null;
  /** One line for a row with no body: why there is none. Never withheld — it is a diagnosis, not
   *  report text. */
  note?: string;
}

/** One pending notice as a batch sees it. */
export interface NoticeDelivery {
  /** The notice as a lone settlement delivers it: the exact text of a batch of one. */
  content: string;
  row?: NoticeRow;
}

/** What one delivery decided: the text, and which reports travelled (`inline`) against which became
 *  pointers (`withheld`) — the tests assert completeness through these, not by parsing the text. */
export interface NoticeBatchPlan {
  text: string;
  inline: string[];
  withheld: string[];
  /** Report bytes this delivery carried inline: the only number the session ceiling may spend. */
  inlineBytes: number;
}

/** The one call that reads a report whose body is not in the delivery. The address is the pane id, so
 *  the call needs no search: the same `output` path a lone settlement already uses (G10). */
export function reportPointer(id: string, indent = '  '): string {
  return `${indent}full report: subagent(action:"output", agentId:"${id}")`;
}

/** One call for every withheld report: N pointers must not cost N turns. */
export function batchReportPointer(ids: readonly string[]): string {
  const list = ids.map((id) => `"${id}"`).join(',');
  return `${ids.length} report${ids.length === 1 ? '' : 's'} withheld above, in one call: `
    + `subagent(action:"reports", ids:[${list}])`;
}

/** How a batch describes one row: identity first, then what the delivery did with its report. A row
 *  that carries the fact's `seq` names it before the address, so a listed fact is addressable.
 *  Exported for `inbox`, which renders ledger facts with the very same row a batch would print. */
export function formatNoticeRow(row: NoticeRow): string {
  const description = row.description === '' ? '(no description)' : row.description;
  const report = row.body === null ? 'no report' : `${Buffer.byteLength(row.body, 'utf8')} B`;
  const seq = row.seq === undefined ? '' : `#${row.seq} · `;
  return `${seq}${row.id} · ${description} · ${row.outcome} · ${report}`;
}

/** Plan one delivery: empty → null (nothing to send); a batch of one → its own text, byte for byte.
 *
 *  For a real batch the budget is first-fit in arrival order — arrival order is the order the master
 *  will act on, and a reordering by size would make the same batch deliver differently on a retry. */
export function planNoticeBatch(
  notices: readonly NoticeDelivery[],
  bodyBudget: number = NOTICE_BODY_BUDGET_BYTES,
  session?: SessionReportBudget | null,
): NoticeBatchPlan | null {
  if (notices.length === 0) return null;
  const inline: string[] = [];
  const withheld: string[] = [];
  const [only] = notices;
  if (notices.length === 1) {
    const row = only?.row;
    const bytes = row?.body == null ? 0 : Buffer.byteLength(row.body, 'utf8');
    // A lone settlement is not a batch: it keeps the text (and the card) it has always had, and the
    // per-delivery budget does not cut it. The session ceiling is the one budget it cannot outrun,
    // and spending it on one report would silence the rest of the session's settlements.
    if (row?.body != null && session != null && bytes > remainingReportBytes(session)) {
      withheld.push(row.id);
      const text = [formatNoticeRow(row), reportPointer(row.id), sessionBudgetLine(session)].join('\n');
      return { text, inline, withheld, inlineBytes: 0 };
    }
    if (row?.body != null) inline.push(row.id);
    return { text: only?.content ?? '', inline, withheld, inlineBytes: bytes };
  }
  // The stricter of the two ceilings: a delivery never gets more than its own budget, and never more
  // than the session has left.
  const allowance = session == null ? bodyBudget : Math.min(bodyBudget, remainingReportBytes(session));
  const blocks: string[] = [];
  let spent = 0;
  for (const notice of notices) {
    const row = notice.row;
    // A notice with no row (a pane-closed or blind-watch warning) is one line of identity already.
    if (!row) {
      blocks.push(notice.content);
      continue;
    }
    const lines = [formatNoticeRow(row)];
    if (row.body !== null) {
      const bytes = Buffer.byteLength(row.body, 'utf8');
      if (spent + bytes <= allowance) {
        spent += bytes;
        inline.push(row.id);
        lines.push(row.body);
      } else {
        withheld.push(row.id);
        lines.push(reportPointer(row.id));
      }
    } else {
      // No body in this row: name the read that gets what the worker did, whatever the ending was.
      lines.push(reportPointer(row.id));
    }
    if (row.note !== undefined) lines.push(row.note);
    blocks.push(lines.join('\n'));
  }
  if (withheld.length > 0) blocks.push(batchReportPointer(withheld));
  // E6: when the session ceiling — not the per-delivery budget — shaped this delivery, the delivery
  // says so with its own numbers. Under the ceiling the text is byte for byte what it always was.
  if (session != null && allowance < bodyBudget) blocks.push(sessionBudgetLine(session));
  return { text: blocks.join('\n\n'), inline, withheld, inlineBytes: spent };
}

export interface NoticeBuffer {
  /** Hand one notice over. Resolving means the buffer has it — buffered while busy, or handed to pi.
   *  `row` is what a batch needs to keep this settlement legible once the batch is a list of rows.
   *  `onAccepted` fires only when pi actually took the message, which is the only moment a delivery
   *  may be recorded (a buffered notice is RAM, and RAM does not survive a `/reload`). */
  deliverNotice(
    content: string,
    paneId?: string,
    card?: SettlementCard | null,
    onAccepted?: () => void,
    row?: NoticeRow,
  ): Promise<void>;
  noticePending(): ReadonlySet<string>;
  flush(mode: NoticeSendMode): Promise<void>;
  /** E8: hold everything, including a flush, until the compaction's cut is done. A settlement that
   *  arrives in the window is RAM for a moment and a ledger fact forever; it is delivered after the
   *  cut instead of being summarized away with the prefix. */
  pause(): void;
  resume(): void;
  paused(): boolean;
}

export function createNoticeBuffer(opts: {
  /** True while the agent is in a turn, or after an abort that must not wake a new run. */
  isBusy: () => boolean;
  /** The batch's report-text budget; a process reads `PIHER_NOTICE_BODY_BUDGET_BYTES` here, and a
   *  test passes the number it asserts on. */
  bodyBudgetBytes?: number;
  /** One collapsed body; the card describes a single settlement and is omitted for a batch. False
   *  means pi was not given the message (a host with no send method), so nothing may be recorded. */
  send: (content: string, mode: NoticeSendMode, card?: SettlementCard) => Promise<boolean | void>;
  /** Open one acceptance batch for a multi-notice delivery: the arguments are what the batch records
   *  on the acceptance side, and `end` closes it. A batch pi took as a single message must be one
   *  cursor step, or a crash between two handlers would re-deliver the rest of a message the master
   *  already read. Absent (a buffer with no ledger behind it) keeps one step per notice. */
  openBatch?: () => { end(): void } | null;
  /** E6: what this session has already carried — read at every delivery, so the ceiling shrinks as
   *  the session goes. A process reads the durable sidecar (`session-budget.ts`) here; a test passes
   *  a number. Absent or null means no session ceiling, which is a host that keeps no records. */
  sessionBudget?: () => SessionReportBudget | null;
  /** Record report bytes pi accepted. Called only after the send was taken, like `onAccepted`. */
  recordDeliveryBytes?: (bytes: number) => void;
}): NoticeBuffer {
  const bodyBudget = opts.bodyBudgetBytes ?? noticeBodyBudgetBytes();
  const sessionOf = (): SessionReportBudget | null => opts.sessionBudget?.() ?? null;
  const recordBytes = (bytes: number): void => {
    if (bytes <= 0) return;
    try {
      opts.recordDeliveryBytes?.(bytes);
    } catch (err) {
      // A counter that cannot be written costs bytes, never a settlement: the delivery stands.
      console.error(`piher: session report counter failed: ${(err as Error)?.message ?? err}`);
    }
  };
  type PendingNotice = {
    content: string; paneId?: string; card?: SettlementCard; onAccepted?: () => void; row?: NoticeRow;
  };
  const pending: PendingNotice[] = [];
  const pendingPaneIds = new Set<string>();
  /** E8: while a compaction is cutting its prefix, nothing is handed to pi. */
  let paused = false;
  /** A refused send is not a delivered settlement: keep the batch and its panes for the next flush. */
  const requeue = (notices: readonly PendingNotice[]): void => {
    pending.unshift(...notices);
  };
  /** Record the deliveries pi accepted. A callback that throws must not cost the rest of the batch. */
  const acceptAll = (notices: readonly PendingNotice[]): void => {
    for (const notice of notices) {
      try {
        notice.onAccepted?.();
      } catch (err) {
        console.error(`piher: settlement acceptance handler failed: ${(err as Error)?.message ?? err}`);
      }
    }
  };
  return {
    async deliverNotice(content, paneId, card, onAccepted, row) {
      const notice: PendingNotice = {
        content,
        paneId,
        ...(card ? { card } : {}),
        ...(onAccepted ? { onAccepted } : {}),
        ...(row ? { row } : {}),
      };
      if (content !== '' && paneId !== undefined) pendingPaneIds.add(paneId);
      if (paused || opts.isBusy()) {
        pending.push(notice);
        return;
      }
      // Even a lone notice is planned: under the session ceiling it is byte for byte what it always
      // was, and over it the plan is the row and the pointer that say why (E6).
      const plan = planNoticeBatch([{ content, ...(row ? { row } : {}) }], bodyBudget, sessionOf());
      const text = plan?.text ?? content;
      const keepsCard = text === content ? card ?? undefined : undefined;
      let accepted: boolean | void;
      try {
        accepted = await opts.send(text, 'followUp', keepsCard);
      } catch (err) {
        // pi drops prompts while the agent is mid-turn; holding the notice keeps it (and keeps its
        // pane GC-exempt) until a flush can deliver it, instead of losing the settlement here.
        requeue([notice]);
        return;
      }
      if (accepted === false) {
        // The host has no way to take a message: nothing was delivered, so nothing is recorded.
        requeue([notice]);
        return;
      }
      if (content !== '' && paneId !== undefined) pendingPaneIds.delete(paneId);
      acceptAll([notice]);
      recordBytes(plan?.inlineBytes ?? 0);
    },
    noticePending: () => pendingPaneIds,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    paused: () => paused,
    async flush(mode) {
      // A flush inside a compaction would put the batch into the prefix being summarized (E8).
      if (paused || pending.length === 0) return;
      const flushed = pending.splice(0);
      const plan = planNoticeBatch(
        flushed.map((n) => ({ content: n.content, ...(n.row ? { row: n.row } : {}) })),
        bodyBudget,
        sessionOf(),
      );
      if (plan && plan.text !== '') {
        let accepted: boolean | void;
        try {
          accepted = await opts.send(plan.text, mode, flushed.length === 1 ? flushed[0]!.card : undefined);
        } catch {
          requeue(flushed);
          return;
        }
        if (accepted === false) {
          requeue(flushed);
          return;
        }
      }
      // Release only this batch's panes, and only once it is delivered: a notice buffered during the
      // send await, or a batch a refused send put back, is still undelivered and its pane must stay.
      for (const { paneId } of flushed) {
        if (paneId !== undefined && !pending.some((n) => n.paneId === paneId)) pendingPaneIds.delete(paneId);
      }
      // One collapsed message carries every notice in the batch: pi accepted them together, so they
      // are recorded together — one cursor step for the batch, not one per handler. An empty batch
      // carried nothing, so nobody's delivery is recorded.
      if (plan && plan.text !== '') {
        const batch = opts.openBatch?.() ?? null;
        try {
          acceptAll(flushed);
        } finally {
          batch?.end();
        }
        // E6: what pi took is what the session has carried. Recorded after acceptance, like the
        // cursor, so a refused send or a notice still in RAM adds nothing.
        recordBytes(plan.inlineBytes);
      }
    },
  };
}
