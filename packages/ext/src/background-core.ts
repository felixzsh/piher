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
/** Label every job pane carries, so the app and later sessions can recognize one. */
export const JOB_LABEL_KEY = 'piher.job';

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
  error?: string;
}

/** `job-1`, `job-2`, …: short enough to paste, unique within the session. */
export function nextJobId(sequence: number): string {
  return `job-${sequence}`;
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
  return ['bash', '-o', 'pipefail', '-c', `${body} 2>&1 | tee -a ${shellQuote(logPath)}`];
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
  return lines.slice(-Math.max(1, max)).join('\n').replace(/\s+$/, '');
}

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `…${line.slice(-MAX_LINE_CHARS)}`;
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
      + `background {action: "log", job_id: "${job.id}", mode: "tail", lines: 200, grep: "..."}.`,
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
    `Background job ${jobName(job)} is still running after ${elapsed}${size}. It was NOT stopped and needs no retry.`,
    `Command: ${job.command}`,
  ];
  if (tail.trim() !== '') lines.push('Last output:', tail);
  else lines.push('No output yet.');
  lines.push(
    `Look once with background {action: "log", job_id: "${job.id}"}, keep working, or end it with `
      + `background {action: "stop", job_id: "${job.id}"}.`,
  );
  return lines.join('\n');
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

/** One line per job for `list`: id, state, label or command, elapsed, log path. */
export function formatJobListLine(job: JobRecord, now: number): string {
  const ended = job.endedAt ?? now;
  const name = job.label ?? job.command.replace(/\s+/g, ' ').slice(0, 60);
  return `${job.id} · ${jobOutcome(job)} · ${name} · ${formatDuration(ended - job.startedAt)} · ${job.logPath}`;
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
