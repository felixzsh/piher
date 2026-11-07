/**
 * One always-on trace for the settlement path, on both sides of the delegation: the worker that
 * finishes and the master that must be told. A line answers "why did the notice not arrive": which
 * side ran, which decision point was reached, and the data that decision saw (pane, request, sinceTs,
 * session file, derived state, claim result).
 *
 * TEMPORARY (remove once the settlement failure is fixed): this ships enabled so a real failure leaves
 * evidence behind instead of a silent gap. `PIHER_TRACE=<file>` overrides the path, `PIHER_TRACE=off`
 * silences it, and the test suite never writes (node --test sets NODE_TEST_CONTEXT).
 *
 * The format is deliberately boring — `<iso> <pid> <role> <event> k=v k=v` — because it is read by a
 * person (or an agent) after the fact, not parsed by a machine at runtime.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where a trace goes when nobody says otherwise: pi's own agent directory. */
export const DEFAULT_TRACE_FILE = join(homedir(), '.pi', 'agent', 'piher', 'trace.log');

/** One rotated generation is kept; the file is diagnostics, not an archive. */
const MAX_BYTES = 4 * 1024 * 1024;

const TRACE_FILE: string | null = (() => {
  const raw = process.env.PIHER_TRACE?.trim();
  if (raw === 'off' || raw === '0') return null;
  // An explicit path wins even under the test runner (that is how the trace is tested); without one
  // the suite stays silent, because it runs the settlement path thousands of times.
  if (raw) return raw;
  if (process.env.NODE_TEST_CONTEXT) return null;
  return DEFAULT_TRACE_FILE;
})();

export const traceEnabled = TRACE_FILE !== null;
export const traceFile = TRACE_FILE;

export type TraceRole = 'master' | 'worker';

/** `undefined` drops a field, so a caller can pass what it has without inventing a value. */
export type TraceFields = Record<string, string | number | boolean | null | undefined>;

function quote(value: string): string {
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
}

export function formatTraceLine(
  at: number,
  pid: number,
  role: TraceRole,
  event: string,
  fields: TraceFields = {},
): string {
  const head = `${new Date(at).toISOString()} ${pid} ${role} ${event}`;
  const tail: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    tail.push(`${key}=${value === null ? 'null' : quote(String(value))}`);
  }
  return tail.length === 0 ? head : `${head} ${tail.join(' ')}`;
}

let created = false;

/** Rotate before a write that would cross the cap. One `statSync` per write is the price of not
 *  needing a timer; a trace that silently fills a disk is worse than a slow one. */
function rotateIfNeeded(): void {
  try {
    if (statSync(TRACE_FILE!).size < MAX_BYTES) return;
    renameSync(TRACE_FILE!, `${TRACE_FILE!}.1`);
  } catch {
    /* missing file or a rename race: the next write creates it */
  }
}

/** Append one line. Never throws: a broken trace path must not break a settlement. */
export function trace(role: TraceRole, event: string, fields: TraceFields = {}): void {
  if (TRACE_FILE === null) return;
  try {
    if (!created) {
      mkdirSync(dirname(TRACE_FILE), { recursive: true });
      created = true;
    }
    rotateIfNeeded();
    appendFileSync(TRACE_FILE, `${formatTraceLine(Date.now(), process.pid, role, event, fields)}\n`);
  } catch {
    /* a trace is diagnostics, not a dependency */
  }
}

/** The role of this process: the worker is the one pi launched as a delegated session. */
export const traceRole: TraceRole = process.env.PIHER_SUBAGENT === '1' ? 'worker' : 'master';
