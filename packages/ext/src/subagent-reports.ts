/**
 * The batch pointer's other half (E1): a delivery that withholds report bodies names one call that
 * reads them, and this is that call. `reports` takes the ids a notice printed and returns their
 * reports from the same `piher.rep.<address>` documents `output` reads after a pane is gone (G10), so
 * recovering ten withheld reports costs one turn instead of ten.
 *
 * It never touches a task record: the documents are the durable channel (S12), and a read that
 * refreshed a record would make a read of someone else's settlement look like a delivery of this
 * session's.
 *
 * Pure planner, adapter does I/O — the split every piher channel uses, so the budget can be asserted
 * without a core.
 */
import type { CoreClientLike } from './core-client.ts';
import { readReportDocument, reportDocName } from './report-documents.ts';
import { toolError } from './tool-error.ts';
import { OUTPUT_DEFAULT_MAX_CHARS, OUTPUT_HARD_CAP_CHARS } from './subagent-session.ts';

/** What one id's document read established, as the planner needs it. */
export type ReportIdState =
  /** The document holds a report: its text is what the master asked for. */
  | { kind: 'report'; text: string | null; writtenAt: number }
  /** No readable document at that address (or the address cannot name one). */
  | { kind: 'absent' }
  /** Something is stored there, but it is not a report piher can read. */
  | { kind: 'not-a-report' }
  /** The core did not answer, so nothing was established. */
  | { kind: 'unavailable' };

export interface ReportIdRequest {
  id: string;
  state: ReportIdState;
}

export interface ReportBatchPlan {
  text: string;
  /** Ids whose report travelled whole. */
  included: string[];
  /** Ids whose report was there but did not fit the budget: the "N did not fit" marker counts these. */
  dropped: string[];
  /** Ids nothing could be read for (absent, not a report, or the core did not answer). */
  unreadable: string[];
}

/**
 * One call's worth of reports: whole reports only, in the order asked for.
 *
 * A body is never cut mid-sentence to squeeze it in. A report is the worker's own words and a
 * partial one reads as a complete answer that stops early, so the budget decides *which* reports
 * travel and the rest are counted by id, with the size that explains why they did not fit.
 */
export function planReportBatch(
  requests: readonly ReportIdRequest[],
  budgetChars: number,
): ReportBatchPlan {
  const included: string[] = [];
  const dropped: string[] = [];
  const unreadable: string[] = [];
  const blocks: string[] = [];
  const oversized: string[] = [];
  let spent = 0;
  for (const { id, state } of requests) {
    if (state.kind === 'report' && state.text !== null) {
      const bytes = state.text.length;
      if (spent + bytes <= budgetChars) {
        spent += bytes;
        included.push(id);
        blocks.push(
          `### ${id} · ${bytes} chars · report document piher.rep.${id} · `
          + `written ${new Date(state.writtenAt).toISOString()}\n${state.text}`,
        );
        continue;
      }
      dropped.push(id);
      oversized.push(`${id} (${bytes} chars)`);
      continue;
    }
    unreadable.push(id);
    blocks.push(`### ${id} · ${absentBecause(state)}`);
  }
  const header = `[Subagent Reports | source: report document (piher.rep.<address>) | `
    + `${requests.length} asked · ${included.length} included · ${dropped.length} over budget · `
    + `${unreadable.length} unreadable | budget ${budgetChars} chars]`;
  const lines = [header, ...blocks];
  if (dropped.length > 0) {
    // The explicit cut: what did not fit, by size, and the two calls that read it.
    lines.push(
      `${dropped.length} did not fit the ${budgetChars}-char budget: ${oversized.join(', ')}. `
      + `Raise max_chars (up to ${OUTPUT_HARD_CAP_CHARS}) or read one alone with `
      + `subagent(action:"output", agentId:"${dropped[0]}").`,
    );
  }
  return { text: lines.join('\n\n'), included, dropped, unreadable };
}

/** Why a request has no text, in the words of the read that established it. */
function absentBecause(state: ReportIdState): string {
  if (state.kind === 'absent') return 'no report document is stored at that address';
  if (state.kind === 'not-a-report') return 'the value stored there is not a report piher can read';
  if (state.kind === 'unavailable') return 'the core did not answer, so nothing was established';
  return 'the report document holds no text';
}

/** The requested character budget for the whole call: `max_chars`, bounded like `output`. */
export function reportBatchBudget(params: Record<string, unknown> | undefined): number {
  const requested = typeof params?.max_chars === 'number' ? params.max_chars : undefined;
  if (requested === undefined) return OUTPUT_DEFAULT_MAX_CHARS;
  return Math.max(1, Math.min(Math.trunc(requested), OUTPUT_HARD_CAP_CHARS));
}

/** The ids asked for, in the order printed, with duplicates collapsed: a repeated id is one report,
 *  and reading it twice would spend the budget on the same words. */
export function reportBatchIds(params: Record<string, unknown> | undefined): string[] {
  const raw = params?.ids;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const ids = list
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return [...new Set(ids)];
}

/** Read one id's report document into the planner's vocabulary. */
async function readOne(client: CoreClientLike, id: string): Promise<ReportIdRequest> {
  if (reportDocName(id) === null) return { id, state: { kind: 'absent' } };
  const read = await readReportDocument(client, id);
  if (read.kind === 'read') {
    return { id, state: { kind: 'report', text: read.value.text, writtenAt: read.value.at } };
  }
  return { id, state: { kind: read.kind } };
}

/**
 * `action: "reports"`: every report a delivery withheld, in one call, or an explicit count of the
 * ones that did not fit. The header names the source, because a read that says where it came from is
 * the difference between a document and a guess.
 */
export async function executeSubagentReports(
  params: Record<string, unknown> | undefined,
  deps: { client: CoreClientLike },
) {
  const ids = reportBatchIds(params);
  if (ids.length === 0) {
    return toolError(
      'Error: missing ids for reports. Pass it as a top-level argument '
      + '{"action":"reports","ids":["<pane id>", …]}, not nested under parameters.',
    );
  }
  const budget = reportBatchBudget(params);
  const requests = await Promise.all(ids.map((id) => readOne(deps.client, id)));
  const plan = planReportBatch(requests, budget);
  return {
    content: [{ type: 'text' as const, text: plan.text }],
    details: {
      source: 'report-document',
      asked: ids.length,
      included: plan.included.length,
      dropped: plan.dropped,
      unreadable: plan.unreadable,
    },
  };
}
