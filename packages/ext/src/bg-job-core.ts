/**
 * Background jobs (pure logic): one shell command runs as its own herdr terminal, and its exit is
 * reported once with the exit code, the last lines and the log path. The completion signal is the
 * child terminal's own state — `run` starts a program, so core reports `finished` and its exit code;
 * nothing is typed into a shell and no marker is scraped from a screen.
 *
 * This module holds no I/O: quoting, names, log slices and notice text are pure, so the policy stays
 * testable without a core socket.
 */
import { stripAnsi } from './ansi-text.ts';

/** Transcript card for the one notice a job gets (exit, check-in). */
export const JOB_NOTICE_CUSTOM_TYPE = 'piher.job-exit';
/** Label every job pane carries, so the app and a later mount can recognize one. */
export const JOB_LABEL_KEY = 'piher.job';
/**
 * Second label on a job pane: the facts the plugin's memory would have had. The registry is in
 * memory, so a reload forgets a running job while core keeps it alive; this label is what lets the
 * next mount adopt it instead of going blind. A command is metadata, not a log, so it is clipped.
 */
export const JOB_META_LABEL = 'piher.job.meta';
/** Command characters kept in the label; enough to name the job in a notice, never the whole script. */
export const META_COMMAND_MAX = 120;

/** A check-in is a glance, not a failure: the job keeps running when it fires. */
export const DEFAULT_TIMEOUT_S = 300;
export const MIN_TIMEOUT_S = 5;
export const MAX_TIMEOUT_S = 3600;
/** Lines handed to the model in a notice; the rest stays in the log. */
export const NOTICE_TAIL_LINES = 20;
/** Lines one `log` action may return, and the cap per line (progress bars print one endless line). */
export const MAX_LOG_LINES = 400;
export const MAX_LINE_CHARS = 2000;
/** Bytes read from either end of a log: a multi-GB build log must never be read whole. */
export const LOG_READ_BYTES = 1024 * 1024;

export type JobStatus = 'running' | 'finished' | 'stopped' | 'failed';

export interface JobRecord {
  id: string;
  label: string | null;
  command: string;
  cwd: string;
  paneId: string;
  logPath: string;
  startedAt: number;
  status: JobStatus;
  exitCode: number | null;
  endedAt: number | null;
  /** One check-in per job: a second one for the same silence adds nothing. */
  checkInSent: boolean;
  /** The notice reached pi: the job is spent and drops out of the list the launcher reads. */
  delivered: boolean;
  error?: string;
}

/**
 * `job-1`, `job-2`, …: short enough to paste. `tag` makes an id unique across reloads, which matters
 * because the plugin's registry is in memory: after an HMR reload the counter starts again, and a
 * `job-1` that names a different job in the same transcript is a silently wrong answer to `status`.
 * The `x` separator keeps the tag from reading as part of the counter: `job-1x39`, never `job-139`.
 */
export function nextJobId(sequence: number, tag = ''): string {
  return tag ? `job-${sequence}x${tag}` : `job-${sequence}`;
}

/**
 * Core terminal name: 1-32 of `a-z 0-9 - _`, unique among live terminals. The job id leads so a
 * human reading `hc ls` or the app sees which job a pane belongs to.
 */
export function jobCoreName(id: string, label: string | null): string {
  const slug = (label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug ? `${id}-${slug}` : id;
  const cut = base.slice(0, 32).replace(/-+$/g, '');
  const safe = cut.replace(/[^a-z0-9_-]+/g, '-');
  return safe.length > 0 ? safe : 'job';
}

/** POSIX single-quote: the only character that cannot appear literally inside single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv that runs the command as a program: `pipefail` makes the exit code the pipeline's, and
 * `tee` keeps the pane live for a human while the log holds the whole output. Nothing is typed into
 * a shell, so multi-line scripts, heredocs and pipes are ordinary.
 */
export function planJobArgv(command: string, logPath: string): readonly string[] {
  const body = command.replace(/\s+$/, '');
  // The body goes in a brace group: `|` binds tighter than `;`, so `a; b | tee log` would send `a`
  // straight to the pane and log only `b`. On its own lines, `}` also survives a trailing `&` and a
  // trailing `# comment`, both of which would swallow it on the same line.
  return ['bash', '-o', 'pipefail', '-c', `{\n${body}\n} 2>&1 | tee -a ${shellQuote(logPath)}`];
}

/** A check-in seconds value: clamped, never zero, and the default when the model omits or garbles it. */
export function clampTimeoutS(value: unknown, fallback: number = DEFAULT_TIMEOUT_S): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, n));
}

/** Terminal text as a log line: no ANSI, no carriage-return progress artifacts. */
export function stripOutput(text: string): string {
  return stripAnsi(text).replace(/\r/g, '');
}

/** Last `max` lines, one bounded line each: enough to judge, never a whole log in the context. */
export function tailLines(text: string, max: number): string {
  const lines = stripOutput(text).split('\n').map((line) => clipLine(line));
  // A trailing newline is not a line: left in, it costs the tail one line of real output.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-Math.max(1, max)).join('\n');
}

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `…${line.slice(-MAX_LINE_CHARS)}`;
}

/**
 * What the notice shows: the log when it has content, the pane otherwise. A command that dies before
 * `tee` starts (a shell syntax error, a `#` that swallows the pipe) leaves no log, and its output is
 * only on the pane — reporting "No output" there would hide the very error the model must read.
 */
export function chooseTail(logText: string | null, paneText: string, max: number): string {
  if (logText !== null && logText.trim() !== '') return tailLines(logText, max);
  if (paneText.trim() === '') return '';
  return tailLines(paneText, max);
}

/** The facts of a job that outlive its plugin instance. Short keys keep the label compact. */
export interface JobMeta {
  name: string | null;
  log: string;
  started: number;
  /** The check-in budget in seconds, so an adopted job knows how much of it is left. */
  timeout: number;
  command: string;
}

export function encodeJobMeta(meta: JobMeta): string {
  const command = meta.command.length > META_COMMAND_MAX
    ? `${meta.command.slice(0, META_COMMAND_MAX - 1)}…`
    : meta.command;
  return JSON.stringify({ n: meta.name, l: meta.log, s: meta.started, t: meta.timeout, c: command });
}

/** Tolerant on purpose: a label written by an older build must degrade, never throw. */
export function decodeJobMeta(raw: unknown): JobMeta | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const log = typeof rec.l === 'string' ? rec.l : '';
  const started = typeof rec.s === 'number' && Number.isFinite(rec.s) ? rec.s : 0;
  const timeout = typeof rec.t === 'number' && Number.isFinite(rec.t) ? rec.t : 0;
  const command = typeof rec.c === 'string' ? rec.c : '';
  const name = typeof rec.n === 'string' && rec.n ? rec.n : null;
  return { name, log, started, timeout, command };
}

/** What adoption needs from a terminal: the plugin reads nothing else. */
export interface AdoptableTerminal {
  id: string;
  /** The terminal that started it: core's lineage, the only boundary that is not a guess. */
  parent?: string | null;
  cwd: string;
  labels: Readonly<Record<string, string>>;
  state: 'live' | 'finished';
  exitCode: number | null;
}

export interface AdoptPlan {
  job: JobRecord;
  /** The child already exited while no watcher was listening: report it now. */
  finished: boolean;
  /** Milliseconds left before the check-in, 0 when it is already due. */
  remainingMs: number;
}

/**
 * Jobs a fresh mount should pick up: the panes still carrying this session's job label, minus the
 * ones it already tracks. A terminal with no meta label is adopted with what core knows and a
 * clipped command, because a job nobody watches is worse than one described imprecisely.
 */
export function planAdoption(
  terminals: readonly AdoptableTerminal[],
  known: ReadonlySet<string>,
  now: number,
  opts: { parent?: string | null } = {},
): AdoptPlan[] {
  const plans: AdoptPlan[] = [];
  const seen = new Set(known);
  for (const terminal of terminals) {
    const id = terminal.labels[JOB_LABEL_KEY];
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    // Another master's job is not this session's business: core reports every live terminal, so the
    // `piher.job` label alone would let a job from another project be adopted and announced here.
    if (opts.parent !== undefined && terminal.parent !== opts.parent) continue;
    seen.add(id);
    const meta = decodeJobMeta(terminal.labels[JOB_META_LABEL]);
    const started = meta !== null && meta.started > 0 ? meta.started : now;
    const timeout = meta !== null && meta.timeout > 0 ? meta.timeout : DEFAULT_TIMEOUT_S;
    const elapsed = Math.max(0, now - started);
    const job: JobRecord = {
      id,
      label: meta?.name ?? null,
      command: meta !== null && meta.command !== '' ? meta.command : '(started before this reload — command unknown)',
      cwd: terminal.cwd,
      paneId: terminal.id,
      logPath: meta?.log ?? '',
      startedAt: started,
      status: 'running',
      // Carry core's verdict in: a job that already exited is reported with its own exit code.
      exitCode: terminal.state === 'finished' ? terminal.exitCode : null,
      endedAt: null,
      // A job that already outlived its budget when it was adopted must not fire a check-in burst.
      checkInSent: elapsed >= timeout * 1000,
      delivered: false,
    };
    plans.push({
      job,
      finished: terminal.state === 'finished',
      remainingMs: Math.max(0, timeout * 1000 - elapsed),
    });
  }
  return plans;
}

export type LogSliceResult =
  | { ok: true; text: string; total: number; shown: number }
  | { ok: false; error: string };

/**
 * A bounded fragment of a log: `head` or `tail`, an optional regular-expression filter, and the
 * count of matching lines so the model knows how much it is not seeing.
 */
export function readLogSlice(
  text: string,
  opts: { mode?: 'head' | 'tail'; lines?: unknown; grep?: string } = {},
): LogSliceResult {
  const requested = typeof opts.lines === 'number' && Number.isFinite(opts.lines) ? Math.floor(opts.lines) : 100;
  const want = Math.min(MAX_LOG_LINES, Math.max(1, requested));
  let filter: RegExp | null = null;
  if (typeof opts.grep === 'string' && opts.grep.trim() !== '') {
    try {
      filter = new RegExp(opts.grep);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `invalid grep regular expression: ${message}` };
    }
  }
  const all = stripOutput(text).split('\n').map((line) => clipLine(line));
  // A trailing newline is not a line: counting it would report one line more than the file has.
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const matched = filter ? all.filter((line) => filter.test(line)) : all;
  const total = matched.length;
  if (total === 0) return { ok: true, text: '', total: 0, shown: 0 };
  const shownLines = opts.mode === 'head' ? matched.slice(0, want) : matched.slice(-want);
  return { ok: true, text: shownLines.join('\n'), total, shown: shownLines.length };
}

/** `1m 20s`, `8s`, `1h 04m`: the elapsed time as one readable token. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function jobName(job: Pick<JobRecord, 'id' | 'label'>): string {
  return job.label ? `${job.id} ("${job.label}")` : job.id;
}

/** One-line outcome, shared by the notice, `status` and `list`. */
export function jobOutcome(job: JobRecord): string {
  switch (job.status) {
    case 'running': return 'running';
    case 'stopped': return 'stopped';
    case 'failed': return `could not start: ${job.error ?? 'unknown error'}`;
    default:
      return job.exitCode === null ? 'finished without an exit code' : `exited with code ${job.exitCode}`;
  }
}

/**
 * Model-facing notice for a job that ended. Everything needed to act without polling: what ran,
 * where, how it ended, the last lines, and how to read more from the log.
 */
export function formatJobNotice(job: JobRecord, tail: string): string {
  const elapsed = job.endedAt === null ? '' : ` after ${formatDuration(job.endedAt - job.startedAt)}`;
  const lines = [`Background job ${jobName(job)} ${jobOutcome(job)}${elapsed}.`, `Command: ${job.command}`];
  if (tail.trim() !== '') lines.push('Last output:', tail);
  else lines.push('No output.');
  lines.push(
    `Full output: ${job.logPath} — read a bounded slice with `
      + `bg_job {action: "log", job_id: "${job.id}", mode: "tail", lines: 200, grep: "..."}.`,
  );
  return lines.join('\n');
}

/**
 * Model-facing check-in for a job that outlived its timeout. It is a glance, never a verdict: the
 * job keeps running, and the notice says so first so a model cannot read it as a failure to retry.
 */
export function formatJobCheckIn(job: JobRecord, now: number, tail: string, logBytes: number | null): string {
  const elapsed = formatDuration(now - job.startedAt);
  const size = logBytes === null ? '' : `, ${Math.max(1, Math.round(logBytes / 1024))} KB of log`;
  const lines = [
    `Background job ${jobName(job)} was still running after ${elapsed}${size} (checked at ${clock(now)}). `
      + 'It was NOT stopped and needs no retry. If its exit notice has arrived since, this check-in is already history.',
    `Command: ${job.command}`,
  ];
  if (tail.trim() !== '') lines.push('Last output:', tail);
  else lines.push('No output yet.');
  lines.push(
    `Look once with bg_job {action: "log", job_id: "${job.id}"}, keep working, or end it with `
      + `bg_job {action: "stop", job_id: "${job.id}"}.`,
  );
  return lines.join('\n');
}

/** `16:55:14`: the moment a check-in observed the job, so a late delivery cannot be mistaken for now. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/** `status` for one job: the same facts as the notice, with the pane's address while it is live. */
export function formatJobStatus(job: JobRecord, now: number): string {
  const ended = job.endedAt ?? now;
  const lines = [
    `job: ${job.id}${job.label ? ` (${job.label})` : ''}`,
    `command: ${job.command}`,
    `cwd: ${job.cwd}`,
    `state: ${jobOutcome(job)} · ${formatDuration(ended - job.startedAt)}`,
    `pane: ${job.paneId} · log: ${job.logPath}`,
  ];
  return lines.join('\n');
}

/**
 * The jobs `list` shows: running ones, plus the ones whose notice has not been handed to pi yet.
 * A delivered job is spent — its log stays on disk and the notice carries the path — so keeping it
 * in the list only spends the launcher's context on something it already acted on.
 */
/**
 * What `list` answers: the jobs that still owe this session a notice. `all` also shows the delivered
 * ones the registry keeps for `status`/`log` (`DELIVERED_TAIL` of them) and any job whose cwd sits
 * outside `cwd`, so a master working across checkouts can see whose work is whose.
 */
export function listedJobs(
  jobs: Iterable<JobRecord>,
  opts: { all?: boolean; cwd?: string | null } = {},
): JobRecord[] {
  const root = opts.cwd ?? null;
  return [...jobs]
    .filter((job) => (opts.all === true ? true : !job.delivered))
    .filter((job) => (root === null ? true : isInside(root, job.cwd)))
    .sort((left, right) => right.startedAt - left.startedAt);
}

/** A job belongs to a directory when it runs there or below it. */
export function isInside(root: string, dir: string): boolean {
  const base = root.endsWith('/') ? root : `${root}/`;
  return dir === root || dir.startsWith(base);
}

/** Delivered records kept for `status`/`log` on an old id; the rest are dropped, the log survives. */
export const DELIVERED_TAIL = 5;

/** Job ids to drop once `DELIVERED_TAIL` delivered records are kept; oldest delivery first. */
export function expiredDelivered(jobs: Iterable<JobRecord>, keep = DELIVERED_TAIL): string[] {
  const delivered = [...jobs].filter((job) => job.delivered)
    .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0));
  return delivered.slice(0, Math.max(0, delivered.length - Math.max(0, keep))).map((job) => job.id);
}

/** One line per job for `list`: id, state, label or command, elapsed, log path. */
export function formatJobListLine(job: JobRecord, now: number, sessionCwd?: string | null): string {
  const ended = job.endedAt ?? now;
  const name = job.label ?? job.command.replace(/\s+/g, ' ').slice(0, 60);
  // A job outside the session's own checkout says where it ran: two projects, two answers.
  const away = sessionCwd && !isInside(sessionCwd, job.cwd) ? ` · in ${job.cwd}` : '';
  return `${job.id} · ${jobOutcome(job)} · ${name} · ${formatDuration(ended - job.startedAt)} · ${job.logPath}${away}`;
}

/** The `details` a renderer needs; never the whole notice text. */
export function jobNoticeDetails(job: JobRecord, now: number, checkIn: boolean): Record<string, unknown> {
  return {
    jobId: job.id,
    label: job.label,
    status: job.status,
    exitCode: job.exitCode,
    durationMs: (job.endedAt ?? now) - job.startedAt,
    command: job.command,
    logPath: job.logPath,
    checkIn,
  };
}
