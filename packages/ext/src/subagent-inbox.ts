/**
 * `action: "inbox"`: what happened since the last thing the master saw (E1, E5).
 *
 * The ledger is the source and the task record is not (E5): a settlement whose record was swept is
 * still a fact in the file, and its report is read from `piher.rep.<pane>` — the same document
 * `output` and `reports` read — so a lost notice (a crash between acceptance and the cursor write, a
 * compaction that swallowed it, a console that scrolled past it) is recoverable without guessing.
 *
 * Three rules hold the action together:
 *
 * - **The cursor is the default boundary, and it crosses only what was returned.** `since` defaults
 *   to the delivered cursor, so a second call after a successful one answers "nothing new"; an
 *   explicit `since` is answered from the ledger alone, so two calls with the same `since` return the
 *   same facts. The cursor moves through `openBatch` — one step per call — so a restart cannot replay
 *   a range the master already read.
 * - **The ledger is the answer, the document only its body.** A missing document, a document that
 *   belongs to another task, and a worker that ended without words are three different facts: the row
 *   says which one the read established instead of passing a pointer off as a report.
 * - **An unreadable ledger is an error, never silence.** A file that holds bytes and not one fact is
 *   not this session's ledger (or it was overwritten), and an empty answer still names the range, the
 *   last seq, and a torn tail. A refusal or a failed read advances nothing.
 *
 * The format is the delivery's: one row per fact (identity, outcome, size), the body verbatim while
 * it fits the batch budget, otherwise the exact `output` call plus one `reports` line for all of them.
 * The only addition is the fact's `seq` at the head of its row — an answer that cannot name what it
 * returned cannot be resumed either.
 */
import type { CoreClientLike } from './core-client.ts';
import {
  batchReportPointer,
  formatNoticeRow,
  reportPointer,
  NOTICE_BODY_BUDGET_BYTES,
  type NoticeRow,
} from './index-notices.ts';
import { readReportDocument, reportDocName } from './report-documents.ts';
import {
  isSettlementFact,
  type SettlementEvent,
  type SettlementLedger,
} from './settlement-ledger.ts';
import { toolError } from './tool-error.ts';

/** Facts one call answers with by default: a burst of forty workers plus their follow-ups, bounded so
 *  a ledger nobody has read for a week cannot flood a context in one call. */
export const INBOX_DEFAULT_LIMIT = 50;

/** The most one call returns however large `limit` is: rows are cheap, the bodies they carry are not. */
export const INBOX_MAX_LIMIT = 200;

/** What a report document read established about one fact's body. The four failures are separate on
 *  purpose — "gone", "somebody else's", "no words" and "the core did not answer" are different facts,
 *  and one message for all of them would be a guess. */
export type InboxBody =
  /** The document holds this very settlement, with its words. */
  | { kind: 'report'; text: string; at: number }
  /** The document holds this settlement and the turn left no words: the reason is the report. */
  | { kind: 'no-text'; reason: string | null; at: number }
  /** The document holds a settlement of another task: the address was reused. */
  | { kind: 'other-task'; taskId: string; at: number }
  /** No readable document at that address (the address cannot name one, or nothing is stored). */
  | { kind: 'absent' }
  /** Something is stored there, but it is not a report piher can read. */
  | { kind: 'not-a-report' }
  /** The core did not answer, so nothing was established either way. */
  | { kind: 'unavailable' };

/** One fact as the answer needs it: the ledger line, the description a record may still hold, and
 *  what reading its document established. */
export interface InboxFact {
  event: SettlementEvent;
  /** The record's description, or `''` when the record was swept: the ledger never stored it. */
  description: string;
  body: InboxBody;
  /** The task a reused pane id addresses now, when it is not this one: a read through the pointer
   *  would return that task's work. */
  paneOwner?: string;
}

export interface InboxLedgerState {
  /** The file this answer was read from; null when the session has nowhere durable to write. */
  file: string | null;
  /** The highest seq the ledger holds: the repeated "it ends here" that rules out silence. */
  lastSeq: number;
  /** The last line was unfinished when it was read: the newest fact may be the missing one. */
  torn: boolean;
}

export interface InboxSelection {
  /** The settlements to answer with, in seq order. */
  facts: SettlementEvent[];
  /** Settlements above the range kept: what a next call returns. */
  more: number;
  /** Ledger facts that are not settlements (recorded, nothing to deliver). */
  notSettlements: number;
}

/** The facts after `since`, in seq order, at most `limit` of them: a slice of one ordered pass, so a
 *  retry of the same call returns the same slice. */
export function selectInboxFacts(input: {
  events: readonly SettlementEvent[];
  since: number;
  limit: number;
}): InboxSelection {
  const after = input.events.filter((event) => event.seq > input.since);
  const settlements = after.filter((event) => isSettlementFact(event.kind));
  const facts = settlements.slice(0, input.limit);
  return {
    facts,
    more: settlements.length - facts.length,
    notSettlements: after.length - settlements.length,
  };
}

/** `since`: the call's own boundary, or the delivered cursor when it names none. A value that is not
 *  a whole number of facts is refused: guessing one would answer about a range nobody asked for. */
export function inboxSince(params: Record<string, unknown> | undefined, deliveredSeq: number): number {
  const raw = params?.since;
  if (raw === undefined || raw === null) return deliveredSeq;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    toolError(`inbox takes "since" as a whole number of facts (0 = the whole ledger), not ${JSON.stringify(raw)}.`);
  }
  return raw;
}

/** `limit`: how many facts one answer may carry. */
export function inboxLimit(params: Record<string, unknown> | undefined): number {
  const raw = params?.limit;
  if (raw === undefined || raw === null) return INBOX_DEFAULT_LIMIT;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    toolError(`inbox takes "limit" as a positive whole number of facts, not ${JSON.stringify(raw)}.`);
  }
  return Math.min(raw, INBOX_MAX_LIMIT);
}

const outcomeOf = (kind: SettlementEvent['kind']): NoticeRow['outcome'] =>
  kind === 'settled' ? 'settled' : kind === 'pane-gone' ? 'closed' : 'failed';

/** Why this row carries no body, as the read established it — never as a guess. */
function bodyNote(fact: InboxFact): string | undefined {
  const { event, body } = fact;
  const address = `piher.rep.${event.pane}`;
  switch (body.kind) {
    case 'report':
      return undefined;
    case 'no-text':
      return body.reason === null
        ? 'it ended without a report: no closing message'
        : `it ended without a report: ${body.reason}`;
    case 'other-task':
      return `${address} now holds task ${body.taskId} (settled ${new Date(body.at).toISOString()}), `
        + 'not this one: its address was reused, so the read above returns that task\'s work';
    case 'not-a-report':
      return `the value stored at ${address} is not a report piher can read`;
    case 'unavailable':
      return 'the core did not answer, so nothing was established';
    case 'absent':
      if (event.payloadRef !== undefined) {
        return `${address} is gone, so the report cannot be read any more`;
      }
      return event.kind === 'pane-gone'
        ? 'its pane was gone before it settled, so it never wrote a report'
        : 'its wait ended with no report document at all';
  }
}

/** A pane id is borrowed: after a sweep and a reused address, every read through the pointer returns
 *  the new task's work. The row says so rather than printing a call that answers about somebody else. */
function reuseNote(fact: InboxFact): string | undefined {
  const owner = fact.paneOwner;
  if (owner === undefined || owner === fact.event.taskId) return undefined;
  return `its address ${fact.event.pane} now belongs to task ${owner}`;
}

function factNote(fact: InboxFact): string | undefined {
  const parts = [bodyNote(fact), reuseNote(fact)];
  const said = parts.filter((part): part is string => part !== undefined && part !== '');
  return said.length === 0 ? undefined : said.join('; ');
}

/** The one line that says what was read, so an answer can never be silence. */
function inboxHeader(input: {
  since: number;
  facts: readonly InboxFact[];
  notSettlements: number;
  ledger: InboxLedgerState;
  budget: number;
}): string {
  const count = input.facts.length;
  const parts = [
    '[Subagent inbox',
    `ledger ${input.ledger.file ?? 'in memory (no repository: nothing durable)'}`,
    `after #${input.since}`,
    count === 0 ? 'nothing new' : `${count} settlement${count === 1 ? '' : 's'}`,
    `ledger ends at #${input.ledger.lastSeq}`,
    ...(input.notSettlements > 0
      ? [`${input.notSettlements} recorded fact${input.notSettlements === 1 ? '' : 's'} with nothing to deliver`]
      : []),
    ...(input.ledger.torn ? ['its last line is unfinished, so the newest fact may be missing'] : []),
    `budget ${input.budget} B`,
  ];
  return `${parts.join(' | ')}]`;
}

export interface InboxPlan {
  text: string;
  /** The seqs the answer carries, in order: the only seqs the cursor may cross. */
  seqs: number[];
  /** Pane ids whose report travelled whole. */
  inline: string[];
  /** Pane ids whose report was readable but did not fit: the "N withheld" line names them. */
  withheld: string[];
}

/**
 * Render one answer. Bodies are first-fit in seq order, exactly as a batch delivery spends them; a
 * body that does not fit becomes the exact `output` call, and one `reports` line covers every withheld
 * id so a truncated answer still costs one turn to complete.
 */
export function planInbox(input: {
  since: number;
  facts: readonly InboxFact[];
  more: number;
  notSettlements?: number;
  ledger: InboxLedgerState;
  bodyBudget?: number;
}): InboxPlan {
  const budget = input.bodyBudget ?? NOTICE_BODY_BUDGET_BYTES;
  const inline: string[] = [];
  const withheld: string[] = [];
  const seqs: number[] = [];
  const blocks: string[] = [];
  let spent = 0;
  for (const fact of input.facts) {
    const { event } = fact;
    const body = fact.body.kind === 'report' ? fact.body.text : null;
    const note = factNote(fact);
    const row: NoticeRow = {
      seq: event.seq,
      id: event.pane,
      description: fact.description,
      outcome: outcomeOf(event.kind),
      body,
      ...(note === undefined ? {} : { note }),
    };
    const lines = [formatNoticeRow(row)];
    if (body !== null) {
      const bytes = Buffer.byteLength(body, 'utf8');
      if (spent + bytes <= budget) {
        spent += bytes;
        inline.push(event.pane);
        lines.push(body);
      } else {
        withheld.push(event.pane);
        lines.push(reportPointer(event.pane));
      }
    } else {
      // No body in this row: name the read that gets what the worker did, whatever the ending was.
      lines.push(reportPointer(event.pane));
    }
    if (note !== undefined) lines.push(note);
    blocks.push(lines.join('\n'));
    seqs.push(event.seq);
  }
  // The withheld ids are deduplicated for the call: two facts of one address are one document, and a
  // pointer list that repeats an id would ask for the same report twice.
  const unique = [...new Set(withheld)];
  if (unique.length > 0) blocks.push(batchReportPointer(unique));
  const header = inboxHeader({
    since: input.since,
    facts: input.facts,
    notSettlements: input.notSettlements ?? 0,
    ledger: input.ledger,
    budget,
  });
  const lines = [header, ...(blocks.length > 0 ? ['', blocks.join('\n\n')] : [])];
  if (input.more > 0) {
    const last = seqs.at(-1) ?? input.since;
    lines.push('', `${input.more} more after #${last}: call inbox again for them.`);
  }
  return { text: lines.join('\n'), seqs, inline, withheld };
}

/** Read one fact's body: the document only counts when it still names exactly this settlement. */
async function readBody(deps: InboxDeps, event: SettlementEvent): Promise<InboxBody> {
  if (reportDocName(event.pane) === null) return { kind: 'absent' };
  const read = await readReportDocument(deps.client, event.pane);
  if (read.kind !== 'read') return { kind: read.kind };
  const value = read.value;
  if (value.taskId !== event.taskId || value.at !== event.at) {
    return { kind: 'other-task', taskId: value.taskId, at: value.at };
  }
  return value.text === null
    ? { kind: 'no-text', reason: value.stopReason ?? null, at: value.at }
    : { kind: 'report', text: value.text, at: value.at };
}

export interface InboxDeps {
  /** This session's ledger: the source of the answer, and the cursor it moves. */
  ledger: SettlementLedger;
  /** The core's document store, which holds the report bodies. */
  client: CoreClientLike;
  /** The description this session's record holds for a task, or `''` when it was swept. */
  description(taskId: string): string;
  /** The task a pane id addresses now, when it is not the fact's own. */
  paneOwner?(pane: string): string | undefined;
  /** The batch's report-text budget; a test passes the number it asserts on. */
  bodyBudget?: number;
}

/**
 * `action: "inbox"`: the facts after `since` (default: the delivered cursor), in the delivery's own
 * format, with the cursor crossed over exactly what was returned.
 *
 * The order is the guarantee, as everywhere in the ledger: read and render first, record second. A
 * refused call, a foreign ledger or a failed read returns before the cursor is touched, so nothing
 * the master never saw can be marked as seen.
 */
export async function executeSubagentInbox(
  params: Record<string, unknown> | undefined,
  deps: InboxDeps,
) {
  const ledger = deps.ledger;
  const bytes = ledger.sourceBytes();
  if (ledger.events().length === 0 && bytes > 0) {
    // A file with content and not one fact is not this session's ledger: answering "nothing new"
    // would be a claim about a file that was never read.
    toolError(
      `the settlement ledger ${ledger.file ?? '(in memory)'} holds ${bytes} B and not one readable `
      + 'fact: it is not this session\'s ledger, or it was overwritten. Nothing was returned and the '
      + `cursor was not moved (it stands at #${ledger.deliveredSeq()}).`,
    );
  }
  const since = inboxSince(params, ledger.deliveredSeq());
  const limit = inboxLimit(params);
  const selection = selectInboxFacts({ events: ledger.events(), since, limit });
  // The file this answer is planned from: a `repoint` while the documents are being read (a session
  // checkpoint mid-await) makes these seqs another file's business.
  const epoch = ledger.epoch();
  const facts: InboxFact[] = await Promise.all(selection.facts.map(async (event) => {
    const paneOwner = deps.paneOwner?.(event.pane);
    return {
      event,
      description: deps.description(event.taskId),
      body: await readBody(deps, event),
      ...(paneOwner === undefined || paneOwner === event.taskId ? {} : { paneOwner }),
    };
  }));
  const plan = planInbox({
    since,
    facts,
    more: selection.more,
    notSettlements: selection.notSettlements,
    ledger: { file: ledger.file, lastSeq: ledger.lastSeq(), torn: ledger.torn() },
    ...(deps.bodyBudget === undefined ? {} : { bodyBudget: deps.bodyBudget }),
  });
  // One step for one answer: a crash between two seqs must not leave half of a range the master read
  // above the cursor, and a range it never read below it.
  if (plan.seqs.length > 0) {
    const group = ledger.openBatch();
    try {
      for (const seq of plan.seqs) ledger.markDelivered(seq, epoch);
    } finally {
      group.end();
    }
  }
  return {
    content: [{ type: 'text' as const, text: plan.text }],
    details: {
      source: 'settlement-ledger',
      ledger: ledger.file,
      since,
      limit,
      lastSeq: ledger.lastSeq(),
      returned: plan.seqs,
      more: selection.more,
      inline: plan.inline,
      withheld: plan.withheld,
      deliveredSeq: ledger.deliveredSeq(),
    },
  };
}
