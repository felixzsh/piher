/**
 * Child-session transcript I/O + pane-output reads for subagents. Path resolution, a worker's own
 * closing words and liveness probes share one candidate order (the session the worker's own Herdr
 * extension reports in the core's `hresume` label before the recent-file fallback, excluding the
 * master's own session and sessions claimed by other live terminals), so a transcript can never
 * cross sessions.
 *
 * Nothing here decides that a task settled: no caller may infer it (spec S5).
 */
import { accessSync, constants, statSync } from 'node:fs';
import type { CoreClientLike, CoreStatus, TerminalInfo } from './core-client.ts';
import {
  bareSessionId,
  listSessionFiles,
  readSessionFile,
  readTurnClosing,
  resolveSessionFileValue,
  type TurnClosing,
} from './session-tail.ts';
import { idParam, reportFingerprint, type AliveProbe } from './subagent-core.ts';
import { readReportDocument } from './report-documents.ts';
import { isClosed, type ResolvedTaskEntry, type TaskEntry } from './task-row.ts';
import { toolError } from './tool-error.ts';

/* ── the worker's session report (spec S18) ─────────────────────── */

/** The core label the worker's own Herdr extension writes: its `{agent, session, file, cwd, pid,
 *  boot}` view of the pi session running in that terminal. piher writes no session label of its own. */
export const HRESUME_LABEL = 'hresume';

/** The label piher writes on a worker's terminal at spawn: the task that terminal was made for. It is
 *  the one fact at an address that names the task rather than the conversation, so it is what makes an
 *  address identifiable at all — and unlike the address or the terminal's parent, it survives a core
 *  restart (spec S26). */
export const TASK_LABEL = 'piher.task';

/** What the `hresume` label reports that piher reads: the agent that wrote it and the transcript it
 *  names. Null when the label is absent, is not the documented object, or names no session — a report
 *  piher cannot read is not a session report, and treating it as one would point a resume at the wrong
 *  conversation. */
export interface HresumeReport {
  /** The reporter's own name for its agent kind (`pi` for a pi session); null when it names none. */
  agent: string | null;
  /** The reported `file` when it names one, else the reported `session` id (Herdr reports ids and
   *  paths interchangeably). */
  file: string;
}

export function hresumeReport(label: string | null | undefined): HresumeReport | null {
  const raw = (label ?? '').trim();
  if (raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { agent, file, session } = parsed as { agent?: unknown; file?: unknown; session?: unknown };
  const reported = typeof file === 'string' && file.trim() !== ''
    ? file
    : typeof session === 'string' && session.trim() !== '' ? session : null;
  if (reported === null) return null;
  return { agent: typeof agent === 'string' && agent.trim() !== '' ? agent : null, file: reported };
}

/** The session a terminal reports through `hresume` (spec S18), as a value a transcript resolver can
 *  use. Null when the label carries no session report. */
export function hresumeSessionFile(label: string | null | undefined): string | null {
  return hresumeReport(label)?.file ?? null;
}

/** What a live terminal establishes about a task's conversation (spec S18).
 *
 *  A terminal address is not an identity: a core restart reuses terminal ids (spec S26 says so for
 *  command documents, and the same premise applies here), so the label at an address may describe
 *  somebody else's conversation. Ownership is therefore read from a fact piher itself wrote there — the
 *  terminal's `piher.task` label, set at spawn — plus the pi `hresume` report. A terminal with no such
 *  label, or one naming another task, is not this task's worker: a missing parent is not evidence of
 *  ownership, and neither is an address the record remembers. */
export type SessionReport =
  | { kind: 'reported'; file: string }
  /** The core answered: the terminal carries no readable pi `hresume` label. */
  | { kind: 'absent' }
  /** The address holds a terminal that is not this task's own worker. */
  | { kind: 'not-ours'; why: string }
  /** Ownership could not be established: the host cannot attribute an address to a task at all, so
   *  nothing was decided either way. Not `not-ours`: a host that wires no pane index would then deny
   *  every terminal silently (`identity: 'other'`), a fact it never established. */
  | { kind: 'unestablished'; why: string }
  /** The core answered: no such terminal. */
  | { kind: 'gone' }
  /** The core did not answer, so nothing was established either way. */
  | { kind: 'unavailable' };

/** Read one terminal's `hresume` report as this task's own (spec S18/S26).
 *
 *  `taskId` is the task this master's pane index assigns to the address: the terminal's own label must
 *  name it, and the report must come from pi. Both are required, because either one alone can be
 *  somebody else's — and neither the address nor the terminal's parent is evidence of ownership.
 *  `undefined` is "this host has no pane index", which establishes no ownership either way; `null`
 *  is an index that answered and knows no task at that address. */
function sessionReportOf(
  terminal: TerminalInfo | null,
  taskId: string | null | undefined,
): SessionReport {
  if (!terminal) return { kind: 'gone' };
  if (taskId === undefined) return { kind: 'unestablished', why: 'it wires no pane-to-task index' };
  if (!taskId) return { kind: 'not-ours', why: 'this session holds no task at that address' };
  const labelled = terminal.labels[TASK_LABEL] ?? null;
  if (labelled !== taskId) {
    return {
      kind: 'not-ours',
      why: labelled ? `its \`${TASK_LABEL}\` label names task ${labelled}` : `it carries no \`${TASK_LABEL}\` label`,
    };
  }
  const report = hresumeReport(terminal.labels[HRESUME_LABEL]);
  if (!report) return { kind: 'absent' };
  if (report.agent !== 'pi') {
    return { kind: 'not-ours', why: `its label was written by ${report.agent ?? 'an unnamed agent'}, not pi` };
  }
  return { kind: 'reported', file: report.file };
}

/* ── subagent output delta (pure) ───────────────────────────────── */

/** How much of a running worker's pane a default read shows: the latest lines, not the boot chrome. */
export const OUTPUT_TAIL_LINES = 40;
export const OUTPUT_TAIL_MAX_CHARS = 2500;
export const OUTPUT_DEFAULT_MAX_CHARS = 6000;
export const OUTPUT_HARD_CAP_CHARS = 16000;
const OUTPUT_MIN_OVERLAP = 16;
const OUTPUT_TAIL_CHARS = 500;

const BOX_CHARS = '│┃║╭╮╰╯┌┐└┘├┤┬┴┼─━═╌╍';
const FRAME_ONLY_LINE = new RegExp(`^[\\s${BOX_CHARS}]*[${BOX_CHARS}][\\s${BOX_CHARS}]*$`);
const SIDE_BORDER = /^\s*[│┃║] ?|\s*[│┃║]\s*$/g;
/** pi's status footer: `↑43k ↓13k R820k CH99.1% $0.017 …`, preceded by a `~/cwd (branch)` line. */
const PI_FOOTER_LINE = /^↑[\d.]+[kKmM]?\s+↓[\d.]+[kKmM]?\s/;
const PI_FOOTER_CWD_LINE = /^~?\/\S*( \([^)]*\))?$/;

/**
 * Strip TUI chrome from a worker pane read: frame-only box-drawing rows, side borders, right-padding,
 * pi's footer, and blank-line runs. A real read was ~20% whitespace, box glyphs and footer. Applied
 * before the delta, so the cursor tracks the same cleaned text on every call.
 */
export function cleanPaneChrome(text: string): string {
  // Frame rows are judged before border stripping, which would otherwise leave them as blank lines.
  const lines = text.split('\n')
    .filter((line) => !FRAME_ONLY_LINE.test(line))
    .map((line) => line.replace(SIDE_BORDER, '').trimEnd());
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (PI_FOOTER_LINE.test(line)) continue;
    if (PI_FOOTER_CWD_LINE.test(line) && PI_FOOTER_LINE.test(lines[i + 1] ?? '')) continue;
    if (line === '' && kept[kept.length - 1] === '') continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Normalized-text length of the report opening that identifies the pane's rendered copy. */
const REPORT_KEY_CHARS = 24;

/**
 * The pane shows the final report rendered (markdown stripped, long lines cut at pane width), so it
 * is a lossy copy of the transcript text. When the transcript report is attached, cut the pane delta
 * where the report's opening appears (whitespace and markdown markers ignored). Null: no copy found.
 */
export function cutPaneReportCopy(delta: string, report: string): string | null {
  const isNoise = (ch: string): boolean => /[\s`*_#>]/.test(ch);
  const key = [...report].filter((ch) => !isNoise(ch)).slice(0, REPORT_KEY_CHARS).join('');
  if (key.length < REPORT_KEY_CHARS) return null;
  let normalized = '';
  const origin: number[] = [];
  for (let i = 0; i < delta.length; i++) {
    if (isNoise(delta[i]!)) continue;
    normalized += delta[i];
    origin.push(i);
  }
  const at = normalized.indexOf(key);
  if (at < 0) return null;
  const lineStart = delta.lastIndexOf('\n', origin[at]!) + 1;
  const before = delta.slice(0, lineStart).trimEnd();
  const marker = '(the pane\'s rendered copy of the final report is omitted — full text in the Subagent Report section below)';
  return before ? `${before}\n${marker}` : marker;
}

export type SubagentStatus = 'running' | 'idle' | 'blocked' | 'settled';

export interface SubagentOutputCursor {
  tail: string;
  fullLength: number;
  /** Fingerprint of the last transcript report delivered to this pane; deduplicates the fallback across polls. */
  reportTail?: string;
}

function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}

function extractTail(text: string, tailChars = OUTPUT_TAIL_CHARS): string {
  return text.length <= tailChars ? text : text.slice(text.length - tailChars);
}

/**
 * Incremental delta between the previous cursor and the current full buffer: an initial read returns
 * bounded full text, an append the text after the previous tail; ambiguous repeats and scrolled-off
 * boundaries degrade to full text with `restart: true`.
 */
export function computeSubagentOutputDelta(
  prevCursor: SubagentOutputCursor | null | undefined,
  currText: string,
  options?: { maxChars?: number; minOverlap?: number; tailChars?: number },
): { delta: string; restart: boolean; truncated: boolean; nextCursor: SubagentOutputCursor } {
  const maxChars = Math.max(1, Math.min(options?.maxChars ?? OUTPUT_DEFAULT_MAX_CHARS, OUTPUT_HARD_CAP_CHARS));
  const minOverlap = options?.minOverlap ?? OUTPUT_MIN_OVERLAP;
  const tailChars = options?.tailChars ?? OUTPUT_TAIL_CHARS;
  const nextCursor = (): SubagentOutputCursor => ({
    tail: extractTail(currText, tailChars),
    fullLength: currText.length,
  });
  const carry = (text: string, restart: boolean) => {
    const bounded = boundText(text, maxChars);
    return { delta: bounded.text, restart, truncated: bounded.truncated, nextCursor: nextCursor() };
  };

  if (!prevCursor || !prevCursor.tail) return carry(currText, false);

  const prevTail = prevCursor.tail;
  // Same length and suffix → nothing new; keep the cursor (and its report fingerprint) as-is.
  if (currText.length === prevCursor.fullLength && currText.endsWith(prevTail)) {
    return { delta: '', restart: false, truncated: false, nextCursor: prevCursor };
  }

  const firstIdx = currText.indexOf(prevTail);
  if (firstIdx !== -1) {
    // Repeats of the tail make the boundary ambiguous; fall back to the whole buffer.
    if (firstIdx !== currText.lastIndexOf(prevTail)) return carry(currText, true);
    const rawDelta = currText.slice(firstIdx + prevTail.length);
    if (rawDelta.length === 0) return { delta: '', restart: false, truncated: false, nextCursor: prevCursor };
    return carry(rawDelta, false);
  }

  // Tail scrolled off the top: the longest suffix of prevTail matching a prefix of currText is the boundary.
  const maxPossibleOverlap = Math.min(prevTail.length - 1, currText.length);
  const effectiveMinOverlap = Math.min(minOverlap, prevTail.length);
  for (let k = maxPossibleOverlap; k >= effectiveMinOverlap; k--) {
    if (currText.startsWith(prevTail.slice(prevTail.length - k))) return carry(currText.slice(k), false);
  }
  return carry(currText, true);
}

type StatusInput = { consumed: boolean; closed: boolean; status?: CoreStatus | null };

/** First matching rule wins; a worker with no other signal is running. An `error` terminal ended
 *  its turn like `done`, so the transcript decides what came out. The local facts are durable
 *  ones (a delivered report, the master's decision), never a stored status (S12). */
const STATUS_RULES: ReadonlyArray<{ status: SubagentStatus; match: (i: StatusInput) => boolean }> = [
  { status: 'blocked', match: (i) => i.status === 'blocked' },
  { status: 'running', match: (i) => i.status === 'working' },
  {
    status: 'settled',
    match: (i) => i.closed || i.consumed || i.status === 'done' || i.status === 'error',
  },
  { status: 'idle', match: (i) => i.status === 'idle' },
];

export function resolveSubagentStatus(input: StatusInput): SubagentStatus {
  return STATUS_RULES.find((rule) => rule.match(input))?.status ?? 'running';
}

export interface FormatSubagentOutputOpts {
  paneId: string;
  status: SubagentStatus;
  revision: number;
  bufferTruncated: boolean;
  deltaResult: { delta: string; restart: boolean; truncated: boolean };
  askQuestion?: string | null;
  /** Set for a tail read: the header then says the pane was not dumped in full. */
  tailNote?: string | null;
}

export function formatSubagentOutput(opts: FormatSubagentOutputOpts): string {
  const parts: string[] = [];
  const metaItems: string[] = [
    `pane: ${opts.paneId}`,
    `status: ${opts.status}${opts.status === 'blocked' && opts.askQuestion ? ` (question: "${opts.askQuestion}")` : ''}`,
    `revision: ${opts.revision}`,
  ];
  if (opts.deltaResult.restart) {
    metaItems.push('buffer scrolled or reset — full text returned (not a process restart)');
  }
  if (opts.bufferTruncated || opts.deltaResult.truncated) metaItems.push('truncated: true');
  if (opts.tailNote) metaItems.push(opts.tailNote);
  parts.push(`[Subagent Output | ${metaItems.join(' | ')}]`);
  parts.push(opts.deltaResult.delta.length === 0 ? '(no new output since last read)' : opts.deltaResult.delta);
  return parts.join('\n');
}

/** The last lines of a pane read: what a running worker is doing now, without its boot chrome. */
export function tailOfPaneRead(text: string, lines = OUTPUT_TAIL_LINES, chars = OUTPUT_TAIL_MAX_CHARS): string {
  const all = text.split('\n');
  const joined = (all.length > lines ? all.slice(-lines) : all).join('\n');
  return joined.length > chars ? joined.slice(joined.length - chars) : joined;
}

/* ── session file resolution + liveness probes ──────────────────── */

export interface SessionIoHost {
  client: CoreClientLike;
  getSessionId: () => string;
  sessionsDir: () => string;
  /** The task this master's pane index assigns to an address, or null when it knows none. It is the
   *  task the terminal's `piher.task` label must name for its report to count (spec S18/S26): an
   *  address alone identifies nothing. Left out on a host with no such index: ownership is then
   *  reported as unestablished, never as another task's. */
  getTaskIdForPane?: (paneId: string) => string | null;
}

export interface ResolveSessionFileOpts {
  /** Reject candidates last written before this timestamp, so a request is never attributed to a
   * session file that was not written after the request was injected (spawn-race mis-attribution). */
  minMtimeMs?: number;
}

export interface SessionIo {
  resolveSessionFile(paneId: string, cwd: string, preferred?: string | null, opts?: ResolveSessionFileOpts): Promise<string | null>;
  /** What the terminal at this address reports about the conversation now (spec S18, S26): a pi
   *  `hresume` report from a terminal labelled with this task, or the reason there is none. */
  readSessionReport(paneId: string): Promise<SessionReport>;
  readAskFlag(paneId: string): Promise<string | null>;
  probeAlive(paneId: string, cwd: string): Promise<AliveProbe>;
  /** The worker's own closing words, for its report and for `output`. Never a settlement decision. */
  readTurnClosing(paneId: string, cwd: string, sinceTs: number, preferred?: string | null): Promise<TurnClosing>;
  /** Re-attribute a generation's sessionFile with no writes since `sinceTs`: accept herdr's per-pane
   *  report when it is fresh, else keep `preferred` when that is fresh. The live report is the
   *  authority (spec S18), so a fresh report repairs a row value that is fresh but wrong; null means
   *  "keep the old one" (never an mtime guess). Spawn's mtime fallback can adopt a PRE-EXISTING
   *  session file, and this is the only repair of that value — the one `resume` restores and an
   *  existing pane is matched by. */
  reattributeStaleSessionFile(paneId: string, cwd: string, sinceTs: number, preferred: string | null): Promise<string | null>;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

function stampOf(file: string): FileStamp | null {
  try {
    const s = statSync(file);
    if (!s.isFile()) return null;
    accessSync(file, constants.R_OK);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Memo of values derived from a session file, invalidated by (size, mtime, sinceTs): worker
 * sessions reach tens of MB, and the poll loop re-derives the same state every tick. */
class DerivedCache<T> {
  private readonly entries = new Map<string, { key: string; value: T }>();
  private readonly limit: number;

  constructor(limit = 32) {
    this.limit = limit;
  }

  get(file: string, stamp: FileStamp, sinceTs: number): T | undefined {
    const hit = this.entries.get(file);
    return hit && hit.key === `${stamp.size}:${stamp.mtimeMs}:${sinceTs}` ? hit.value : undefined;
  }

  set(file: string, stamp: FileStamp, sinceTs: number, value: T): void {
    this.entries.delete(file);
    this.entries.set(file, { key: `${stamp.size}:${stamp.mtimeMs}:${sinceTs}`, value });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }
}

export function createSessionIo(h: SessionIoHost): SessionIo {
  const closingCache = new DerivedCache<TurnClosing>();

  /** What the terminal at this address reports about the conversation now (spec S18), read from the
   *  core: the only authoritative report a worker makes about its own session. */
  async function readSessionReport(paneId: string): Promise<SessionReport> {
    if (!paneId) return { kind: 'gone' };
    try {
      return sessionReportOf(await h.client.getTerminal(paneId), h.getTaskIdForPane?.(paneId));
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /** This task's terminal report plus the sessions claimed by other terminals; one `terminal.list`
   *  serves both, so the poll hot paths pay a single RPC. */
  async function reportedAndTaken(paneId: string): Promise<{
    reported: string | null;
    taken: Set<string>;
    /** 'ours' | 'other' when this task's label decides it, 'unknown' when the host cannot attribute an
     *  address to a task at all (no pane index wired). */
    identity: 'ours' | 'other' | 'unknown';
  }> {
    const taken = new Set<string>();
    let paneReport: SessionReport | null = null;
    // `undefined` when the host wires no index: ownership stays undecided instead of becoming 'other'.
    const taskId = h.getTaskIdForPane?.(paneId);
    try {
      for (const terminal of await h.client.listTerminals({ all: true })) {
        if (terminal.id === paneId) {
          paneReport = sessionReportOf(terminal, taskId);
          continue;
        }
        const sessionFile = hresumeSessionFile(terminal.labels[HRESUME_LABEL]);
        if (sessionFile) taken.add(bareSessionId(sessionFile));
      }
    } catch {
      /* the list is how other terminals' claims are read; the pane itself is asked below */
    }
    // list may not include a terminal created moments ago: ask for it directly before giving up.
    paneReport ??= await readSessionReport(paneId);
    return {
      reported: paneReport.kind === 'reported' ? paneReport.file : null,
      taken,
      identity: paneReport.kind === 'not-ours'
        ? 'other'
        : paneReport.kind === 'unestablished' ? 'unknown' : 'ours',
    };
  }

  /** Ordered candidates: the worker's own `hresume` report (authoritative, spec S18), the value the
   *  row already carries (which is where a settlement document's `session` lands), then the newest
   *  session files.
   *
   *  A session another terminal reports is never adopted — it is a conversation already claimed. The
   *  pane's own report is the exception: a person attaching to the same session in a second pane makes
   *  the session "taken", and filtering the worker's own report through that set would throw away the
   *  only authoritative candidate. And when the address holds a terminal that does not carry this
   *  task's label, nothing about the pane is a candidate at all: an address identifies no conversation
   *  (S26). */
  async function resolveSessionFileCandidates(paneId: string, cwd: string, preferred?: string | null): Promise<string[]> {
    // A sub's sessionFile must never resolve to the master's own transcript (compare via
    // bareSessionId: herdr reports ids and paths interchangeably).
    const own = bareSessionId(h.getSessionId());
    const { reported, taken, identity } = await reportedAndTaken(paneId);
    const out: string[] = [];
    const push = (file: string | null, claimedByAnother: boolean): void => {
      if (!file || out.includes(file)) return;
      const id = bareSessionId(file);
      if (own && id === own) return;
      if (claimedByAnother && taken.has(id)) return;
      out.push(file);
    };
    push(reported, false);
    push(resolveSessionFileValue(cwd, h.sessionsDir(), preferred), true);
    // Only a decided ownership lets the newest session files stand in for a missing report: an address
    // nobody can attribute proves nothing about which conversation is this task's.
    if (identity !== 'ours') return out;
    for (const f of listSessionFiles(cwd, h.sessionsDir(), 4)) push(f, true);
    return out;
  }

  async function* readableCandidates(paneId: string, cwd: string, preferred?: string | null): AsyncGenerator<{ file: string; stamp: FileStamp }> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd, preferred)) {
      // herdr reports .jsonl paths before the file exists; vanished paths are skipped, never surfaced.
      const stamp = stampOf(file);
      if (stamp) yield { file, stamp };
    }
  }

  async function resolveSessionFile(
    paneId: string,
    cwd: string,
    preferred?: string | null,
    opts?: ResolveSessionFileOpts,
  ): Promise<string | null> {
    for await (const { file, stamp } of readableCandidates(paneId, cwd, preferred)) {
      if (opts?.minMtimeMs != null && stamp.mtimeMs < opts.minMtimeMs) continue;
      return file;
    }
    return null;
  }

  /** The blocked question text: pi's OSC 7501 reporter carries it as the status message. */
  async function readAskFlag(paneId: string): Promise<string | null> {
    return readBlockedQuestion(h.client, paneId);
  }

  async function probeAlive(paneId: string, cwd: string): Promise<AliveProbe> {
    const probe: AliveProbe = { paneExists: false, agentStatus: null, lastActivityMs: null };
    try {
      const terminal = await h.client.getTerminal(paneId);
      probe.paneExists = terminal != null && terminal.state !== 'finished';
      probe.agentStatus = terminal?.status ?? null;
    } catch {
      /* core unavailable: liveness stays unknown (false), never a guessed death */
    }
    for await (const { stamp } of readableCandidates(paneId, cwd)) {
      if (probe.lastActivityMs == null || stamp.mtimeMs > probe.lastActivityMs) probe.lastActivityMs = stamp.mtimeMs;
    }
    return probe;
  }

  async function reattributeStaleSessionFile(
    paneId: string,
    cwd: string,
    sinceTs: number,
    preferred: string | null,
  ): Promise<string | null> {
    // Tolerate fs timestamp granularity against the pre-injection injectTs capture.
    const minMtimeMs = sinceTs - 2_000;
    const own = bareSessionId(h.getSessionId());
    const { reported, taken, identity } = await reportedAndTaken(paneId);
    // Own/taken exclusions apply to `preferred` too: a registry value pointing at the master's own
    // transcript is always "fresh", so the gate cannot veto it.
    const fresh = (file: string | null): string | null => {
      if (!file) return null;
      const id = bareSessionId(file);
      if (own && id === own) return null;
      if (taken.has(id)) return null;
      const stamp = stampOf(file);
      return stamp && stamp.mtimeMs >= minMtimeMs ? file : null;
    };
    // The live report is the authority (spec S18), so a fresh one repairs the row before the value the
    // row already carries is trusted: a report that lags, is stale, or comes from a terminal that is
    // not this task's own leaves room for the row's own post-request value. Null means "keep the old
    // one", never an mtime guess.
    const fromReport = identity === 'other' ? null : fresh(resolveSessionFileValue(cwd, h.sessionsDir(), reported));
    return fromReport ?? fresh(preferred);
  }

  async function readTurnClosingFor(
    paneId: string,
    cwd: string,
    sinceTs: number,
    preferred?: string | null,
  ): Promise<TurnClosing> {
    for await (const { file, stamp } of readableCandidates(paneId, cwd, preferred)) {
      const cached = closingCache.get(file, stamp, sinceTs);
      if (cached) return cached;
      const entries = readSessionFile(file);
      if (!entries?.length) continue;
      const closing = readTurnClosing(entries, sinceTs);
      closingCache.set(file, stamp, sinceTs, closing);
      return closing;
    }
    return { text: null, why: null };
  }

  return {
    resolveSessionFile,
    readSessionReport,
    readAskFlag,
    probeAlive,
    readTurnClosing: readTurnClosingFor,
    reattributeStaleSessionFile,
  };
}

/* ── output action ──────────────────────────────────────────────── */

interface SubagentOutputRead {
  text: string;
  /** False when part of what was asked for may be missing (a full-screen app read while working). */
  complete: boolean;
}

/** Blocked question text: pi's OSC 7501 reporter carries it as the status message. */
async function readBlockedQuestion(client: CoreClientLike, paneId: string): Promise<string | null> {
  try {
    const terminal = await client.getTerminal(paneId);
    if (!terminal || terminal.status !== 'blocked') return null;
    const msg = terminal.statusMsg?.trim();
    return msg ? msg : null;
  } catch {
    return null;
  }
}

/** The requested output cap: `max_chars`, with `maxChars` accepted for older calls. */
function outputMaxChars(params: Record<string, unknown> | undefined): number {
  const requested = typeof params?.max_chars === 'number'
    ? params.max_chars
    : typeof params?.maxChars === 'number' ? params.maxChars : undefined;
  return Math.max(1, Math.min(requested ?? OUTPUT_DEFAULT_MAX_CHARS, OUTPUT_HARD_CAP_CHARS));
}

/** `output` after the pane is gone: the report document is the only text left, and the header must
 *  say which channel answered — a header that read like a pane read would point a master at a
 *  terminal that no longer exists. */
export function formatReportDocumentOutput(input: {
  paneId: string;
  status: SubagentStatus;
  revision: number;
  text: string | null;
  stopReason: string | null;
  writtenAt: number;
  truncated: boolean;
}): string {
  const meta = [
    `pane: ${input.paneId}`,
    `status: ${input.status}`,
    `revision: ${input.revision}`,
    `source: report document (its pane is gone: this is what piher.rep.${input.paneId} holds, not a pane read)`,
    `written: ${new Date(input.writtenAt).toISOString()}`,
  ];
  if (input.truncated) meta.push('truncated: true');
  const body = input.text !== null
    ? input.text
    : `(no report text) ${input.stopReason ?? 'the worker left no closing message'}`;
  return `[Subagent Report | ${meta.join(' | ')}]\n${body}`;
}

/** The read the pane no longer answers: the worker's own report document, which outlives both the
 *  pane and the record (spec S12). Returns the `output` result, or an error naming which of the
 *  document's own states left nothing to read. */
async function outputFromReportDocument(input: {
  entry: TaskEntry;
  status: SubagentStatus;
  foreign: boolean;
  client: CoreClientLike;
  params: Record<string, unknown> | undefined;
  paneError: unknown;
  nextRevision: (paneId: string) => number;
  writeRecord?: (entry: TaskEntry) => void;
}) {
  const { entry } = input;
  const paneId = entry.gen.paneId;
  const name = `piher.rep.${paneId}`;
  const read = await readReportDocument(input.client, paneId);
  const unavailable = read.kind === 'read'
    ? read.value.taskId === entry.taskId
      ? null
      : `the report document ${name} belongs to task ${read.value.taskId}, not this one`
    : read.kind === 'absent' ? `no report document is stored at ${name}`
      : read.kind === 'not-a-report' ? `the value stored at ${name} is not a report piher can read`
        : `the core did not answer, so ${name} could not be read`;
  if (read.kind !== 'read' || unavailable !== null) {
    const cause = input.paneError instanceof Error ? input.paneError.message : String(input.paneError);
    return toolError(`Error: failed to read output for subagent ${paneId}: ${cause}. Its pane is gone and ${unavailable}.`);
  }
  const value = read.value;
  const bounded = value.text === null
    ? { text: null as string | null, truncated: false }
    : boundText(value.text, outputMaxChars(input.params));
  // The report is delivered once `output` returned it, exactly as the transcript fallback records it.
  if (value.text !== null && !input.foreign) {
    entry.gen.reportDelivered = { fingerprint: reportFingerprint(value.text), at: Date.now() };
    input.writeRecord?.(entry);
  }
  const revision = input.nextRevision(paneId);
  return {
    content: [{
      type: 'text' as const,
      text: formatReportDocumentOutput({
        paneId,
        status: input.status,
        revision,
        text: bounded.text,
        stopReason: value.stopReason,
        writtenAt: value.at,
        truncated: bounded.truncated,
      }),
    }],
    details: {
      paneId,
      status: input.status,
      revision,
      source: 'report-document',
      truncated: bounded.truncated,
      restart: false,
      deltaLength: bounded.text?.length ?? 0,
      reportDelivered: true,
    },
  };
}

export async function executeSubagentOutput(
  params: Record<string, unknown> | undefined,
  toolCtx: unknown,
  deps: {
    client: CoreClientLike;
    resolveEntry: (rawId: string, cwd?: string) => ResolvedTaskEntry;
    outputCursors: Map<string, SubagentOutputCursor>;
    /** Monotonic per-pane read counter shown in the header. */
    nextRevision: (paneId: string) => number;
    /** Last finalized assistant text from the worker's transcript: the pane read alone cannot
     * recover it when the fullscreen TUI shows only the status overlay. Optional for tests. The third
     * argument is the session the row already carries, which is tried AFTER the live label (spec S18). */
    readFinalReport?: (paneId: string, entryCwd: string, preferred: string | null) => Promise<string | null>;
    /** Persists the generation's `reportDelivered` so the settlement notice can skip a report already shown. */
    writeRecord?: (entry: TaskEntry) => void;
  },
) {
  const rawId = idParam(params, 'agentId', 'taskId');
  if (!rawId) return toolError('Error: missing agentId for output. Pass it as a top-level argument {"action":"output","agentId":"<pane id>"}, not nested under parameters.');

  const cwd = (toolCtx as { cwd?: string } | undefined)?.cwd;
  const resolved = deps.resolveEntry(rawId, cwd);
  if ('error' in resolved) return toolError(resolved.error);

  const entry = resolved.entry;
  const foreign = resolved.foreign;
  let terminalStatus: CoreStatus | null = null;
  try {
    terminalStatus = (await deps.client.getTerminal(entry.gen.paneId))?.status ?? null;
  } catch {
  }

  const status = resolveSubagentStatus({
    consumed: entry.gen.consumedAt !== null,
    closed: isClosed(entry),
    status: terminalStatus,
  });
  const askQuestion = terminalStatus === 'blocked' ? await readBlockedQuestion(deps.client, entry.gen.paneId) : null;

  let rawRead: SubagentOutputRead;
  try {
    const read = await deps.client.read(entry.gen.paneId);
    rawRead = { text: read.text, complete: read.complete };
  } catch (err) {
    // The pane is gone: a one-shot's pane is reclaimed at settlement and the GC removes stale ones.
    // The document is what outlives it, so answer from it and say which channel answered.
    return outputFromReportDocument({
      entry,
      status,
      foreign,
      client: deps.client,
      params,
      paneError: err,
      nextRevision: deps.nextRevision,
      ...(deps.writeRecord ? { writeRecord: deps.writeRecord } : {}),
    });
  }

  const prevCursor = deps.outputCursors.get(entry.gen.paneId);
  const maxChars = outputMaxChars(params);
  const deltaResult = computeSubagentOutputDelta(prevCursor, cleanPaneChrome(rawRead.text), { maxChars });
  // A resumed process has no cursor; the durable delivery record keeps the report from repeating.
  deltaResult.nextCursor.reportTail ??= prevCursor?.reportTail ?? entry.gen.reportDelivered?.fingerprint;

  // Transcript fallback: the terminal delta can be empty (or footer-only) while the finished
  // report exists only in the session file. Surface it once per distinct report.
  let reportSection: string | null = null;
  if ((status === 'settled' || status === 'idle') && deps.readFinalReport) {
    try {
      const report = await deps.readFinalReport(entry.gen.paneId, entry.cwd, entry.gen.sessionFile);
      const fingerprint = report ? reportFingerprint(report) : '';
      if (report && fingerprint && fingerprint !== deltaResult.nextCursor.reportTail) {
        const bounded = boundText(report, maxChars);
        reportSection = `[Subagent Report | latest finalized message from session transcript${bounded.truncated ? ' | truncated' : ''}]\n${bounded.text}`;
        deltaResult.nextCursor.reportTail = fingerprint;
        deltaResult.delta = cutPaneReportCopy(deltaResult.delta, report) ?? deltaResult.delta;
        // Another session's delivery marker is its own to persist; reading here stays read-only.
        if (!bounded.truncated && !foreign) {
          entry.gen.reportDelivered = { fingerprint, at: Date.now() };
          deps.writeRecord?.(entry);
        }
      }
    } catch {
    }
  }
  const revision = deps.nextRevision(entry.gen.paneId);

  // A finished worker answers with its report; a running one with the last lines it printed. The whole
  // pane buffer is boot chrome (banner, skills, extensions) around the same text, so dumping it by
  // default is what made a master carry a worker's startup into its own context.
  const wantFull = params?.full === true;
  // A tail is a fresh view each time, so it must not spend the buffer before someone asks for it in
  // full. A full read and a delivered report still advance the cursor: that is what makes an
  // unchanged report stay delivered exactly once.
  if (wantFull || reportSection) deps.outputCursors.set(entry.gen.paneId, deltaResult.nextCursor);
  const shown = wantFull || reportSection
    ? deltaResult
    : { ...deltaResult, restart: false, delta: tailOfPaneRead(deltaResult.delta) };

  const formatted = formatSubagentOutput({
    paneId: entry.gen.paneId,
    status,
    revision,
    bufferTruncated: !rawRead.complete,
    deltaResult: shown,
    askQuestion,
    tailNote: wantFull || reportSection
      ? null
      : `latest output only — pass full: true for the whole pane (${deltaResult.delta.length} chars held back)`,
  });

  return {
    content: [{ type: 'text' as const, text: reportSection ? `${formatted}\n${reportSection}` : formatted }],
    details: {
      paneId: entry.gen.paneId,
      status,
      revision,
      truncated: !rawRead.complete || deltaResult.truncated,
      restart: deltaResult.restart,
      deltaLength: deltaResult.delta.length,
      reportDelivered: Boolean(reportSection),
    },
  };
}
