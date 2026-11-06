/**
 * `bg-job`: one shell command as its own herdr terminal, reported once when it exits.
 *
 * The execution model is a *program*, not a typed shell line: `terminal.run` starts an argv, so core
 * reports the child's `finished` state and its exit code. Nothing is typed into a shell, no marker is
 * scraped from a screen, and no command has to be a single line at a POSIX prompt.
 *
 * Observation is event-driven with a heartbeat: `watchChildren` wakes this loop when the child
 * changes, and each wake verifies with `getTerminal`, so a lost event costs one heartbeat instead of
 * the result. The notice is delivered through pi's message API — the one channel an `hc` CLI cannot
 * offer — with a card, and a check-in that never wakes an idle agent.
 */
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { cordisGet } from '../cordis-services.ts';
import {
  childEnvironment,
  coreUnavailableHint,
  type CoreClientLike,
  type CoreEnv,
  type TerminalInfo,
} from '../core-client.ts';
import { toolError } from '../tool-error.ts';
import { optionValue } from '../options.ts';
import { swallow } from '../swallow.ts';
import {
  DEFAULT_TIMEOUT_S,
  JOB_LABEL_KEY,
  JOB_NOTICE_CUSTOM_TYPE,
  LOG_READ_BYTES,
  clampTimeoutS,
  formatJobCheckIn,
  formatJobListLine,
  formatJobNotice,
  formatJobStatus,
  jobCoreName,
  jobNoticeDetails,
  nextJobId,
  planJobArgv,
  readLogSlice,
  tailLines,
  type JobRecord,
  type JobStatus,
} from '../background-core.ts';

/** Panes a job owns; the index GC must never reclaim a running job's terminal. */
export interface PaneStateSlot {
  activePaneIds: () => Set<string>;
}

export interface BgJobDeps {
  client: CoreClientLike;
  /** This process's own terminal address; null outside a herdr-core terminal. */
  env: CoreEnv | null;
  state: PaneStateSlot;
}

/** Jobs allowed at once in one session: a runaway loop of jobs is worse than a refused start. */
const MAX_JOBS = 12;
/** Wake at least this often to re-check a child, so a missed event is never a missed result. */
const HEARTBEAT_MS = 5_000;
/** Lines read from the log for a notice; the model can ask for more with `log`. */
const NOTICE_TAIL_LINES = 20;

type ToolParams = Record<string, unknown> | undefined;

const BG_JOB_ACTIONS = ['start', 'status', 'log', 'stop', 'list'] as const;
type BgJobAction = (typeof BG_JOB_ACTIONS)[number];

/** Last `mode` fragment of a log: only one end is read, so a multi-GB log never enters memory. */
async function readLogEnd(path: string, mode: 'head' | 'tail'): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return '';
    const length = Math.min(size, LOG_READ_BYTES);
    const position = mode === 'head' ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function logSize(path: string): Promise<number | null> {
  try {
    const handle = await open(path, 'r');
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export default function bgJobPlugin(ctx: Context): void {
  const surface = cordisGet(ctx, 'piher.surface');
  const { client, env, state } = cordisGet(ctx, 'piher.bg-job-deps');
  const pi = surface.raw as {
    sendMessage?: (
      message: { customType: string; content: string; display?: boolean; details?: unknown },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) => void;
  };
  const scoped = surface.forModule(import.meta.url);

  const jobs = new Map<string, JobRecord>();
  /** Live watch loops and check-in timers, so a shutdown or HMR stops them. */
  const watches = new Map<string, { cancel: () => void }>();
  const timers = new Map<string, NodeJS.Timeout>();
  let sequence = 0;

  const logDir = optionValue('PIHER_JOBS_DIR') ?? join(tmpdir(), 'piher-jobs');

  state.activePaneIds = () => new Set(
    [...jobs.values()].filter((job) => job.status === 'running').map((job) => job.paneId),
  );

  const fail = (msg: string): never => toolError(msg);
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  /** Cancel this job's watch and check-in; both are no-ops when already gone. */
  function stopWatchers(jobId: string): void {
    watches.get(jobId)?.cancel();
    watches.delete(jobId);
    const timer = timers.get(jobId);
    if (timer) clearTimeout(timer);
    timers.delete(jobId);
  }

  function sendNotice(content: string, details: Record<string, unknown>, wake: boolean): void {
    try {
      // The card is the same content for a human; `details` never repeats the whole text.
      pi.sendMessage?.(
        { customType: JOB_NOTICE_CUSTOM_TYPE, content, display: true, details },
        wake ? { deliverAs: 'steer', triggerTurn: true } : { deliverAs: 'followUp' },
      );
    } catch {
      /* A host without custom messages keeps the job; only the notice is lost. */
    }
  }

  /**
   * Settle one job exactly once: the notice carries the exit code, the last lines and the log path,
   * so the model needs neither `wait` nor a sleep loop. A settle wakes an idle master; a check-in
   * does not.
   */
  async function settleJob(job: JobRecord, status: JobStatus, exitCode: number | null, error?: string): Promise<void> {
    if (job.status !== 'running') return;
    job.status = status;
    job.exitCode = exitCode;
    job.endedAt = Date.now();
    if (error !== undefined) job.error = error;
    stopWatchers(job.id);
    let tail = '';
    try {
      const text = await readLogEnd(job.logPath, 'tail');
      tail = text === null ? '' : tailLines(text, NOTICE_TAIL_LINES);
    } catch (err) {
      swallow('bg-job.notice-tail', err);
    }
    sendNotice(formatJobNotice(job, tail), jobNoticeDetails(job, job.endedAt, false), true);
  }

  /**
   * Watch one child until it exits. `watchChildren` supplies the fast path; the probe on every wake
   * is authoritative, so a stale snapshot cannot report a job that already ended as running.
   */
  function startWatch(job: JobRecord): void {
    const watch = client.watchChildren();
    const state = { cancelled: false };
    const handle = { cancel: () => { state.cancelled = true; } };
    watches.set(job.id, handle);
    void (async () => {
      try {
        while (!state.cancelled && job.status === 'running') {
          const since = watch.version(job.paneId);
          await watch.changed(job.paneId, since, HEARTBEAT_MS);
          if (state.cancelled || job.status !== 'running') return;
          const info: TerminalInfo | null = await client.getTerminal(job.paneId).catch(() => null);
          if (info === null) {
            // A vanished pane is not evidence of success: report it as a failure to confirm.
            await settleJob(job, 'failed', null, 'the terminal disappeared before reporting an exit');
            return;
          }
          if (info.state === 'finished') {
            await settleJob(job, 'finished', info.exitCode);
            return;
          }
        }
      } catch (err) {
        // A dead socket ends the watch silently; the log and the pane survive for a later look.
        swallow('bg-job.watch', err);
      } finally {
        if (watches.get(job.id) === handle) watches.delete(job.id);
      }
    })();
  }

  /** One check-in per job, delivered without waking an idle master: it is a glance, not a verdict. */
  function armCheckIn(job: JobRecord, seconds: number): void {
    const timer = setTimeout(() => {
      timers.delete(job.id);
      if (job.status !== 'running' || job.checkInSent) return;
      job.checkInSent = true;
      void (async () => {
        const text = await readLogEnd(job.logPath, 'tail').catch(() => null);
        const tail = text === null ? '' : tailLines(text, NOTICE_TAIL_LINES);
        const bytes = await logSize(job.logPath).catch(() => null);
        sendNotice(formatJobCheckIn(job, Date.now(), tail, bytes), jobNoticeDetails(job, Date.now(), true), false);
      })();
    }, seconds * 1000);
    timer.unref?.();
    timers.set(job.id, timer);
  }

  function runningCount(): number {
    return [...jobs.values()].filter((job) => job.status === 'running').length;
  }

  function findJob(id: unknown): JobRecord | null {
    if (typeof id !== 'string' || id === '') return null;
    return jobs.get(id) ?? null;
  }

  /** Refresh one job from core: a session that lost an event still reports the truth. */
  async function refresh(job: JobRecord): Promise<void> {
    if (job.status !== 'running') return;
    const info = await client.getTerminal(job.paneId).catch(() => null);
    if (info === null) {
      job.status = 'failed';
      job.endedAt = Date.now();
      job.error = 'the terminal disappeared before reporting an exit';
      stopWatchers(job.id);
      return;
    }
    if (info.state === 'finished') await settleJob(job, 'finished', info.exitCode);
  }

  async function executeStart(params: ToolParams, ctx: unknown) {
    if (!client.available || !env) {
      return fail('bg-job requires a herdr-core terminal (HC_TERMINAL_SOCKET/HC_TERMINAL_ID)');
    }
    const command = typeof params?.command === 'string' ? params.command.trim() : '';
    if (command === '') return fail('command is required: the shell command to run in the background');
    if (runningCount() >= MAX_JOBS) {
      return fail(`${MAX_JOBS} background jobs are already running in this session; `
        + 'finish or stop one with bg-job {action: "stop", job_id: "..."} first');
    }
    const cwd = typeof params?.cwd === 'string' && params.cwd
      ? params.cwd
      : (ctx as { cwd?: string }).cwd ?? process.cwd();
    const label = typeof params?.name === 'string' && params.name.trim() !== ''
      ? params.name.trim().slice(0, 80)
      : null;
    const timeoutS = clampTimeoutS(params?.timeout_s);
    const id = nextJobId(++sequence);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(logDir, `${id}-${stamp}.log`);
    try {
      await mkdir(logDir, { recursive: true });
    } catch (err) {
      return fail(`cannot create the log directory ${logDir}: ${errText(err)}`);
    }
    let info: TerminalInfo;
    try {
      // Keep the job in this terminal's app tab, and label it so `hc ls` and the app can name it.
      const labels = await client.placementLabels();
      info = await client.run({
        argv: [...planJobArgv(command, logPath)],
        cwd,
        env: childEnvironment(process.env, {}),
        labels: { ...labels, [JOB_LABEL_KEY]: id },
        name: jobCoreName(id, label),
        // The notice comes through pi's message API, never as a note typed into the master's PTY.
        noNotify: true,
      });
    } catch (err) {
      return fail(coreUnavailableHint(err) ?? `failed to start the background job: ${errText(err)}`);
    }
    const job: JobRecord = {
      id,
      label,
      command,
      cwd,
      paneId: info.id,
      logPath,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      endedAt: null,
      checkInSent: false,
    };
    jobs.set(id, job);
    startWatch(job);
    armCheckIn(job, timeoutS);
    const text = [
      `background job ${id}${label ? ` ("${label}")` : ''} started (pane ${info.id}).`,
      `log: ${logPath}`,
      `You will be told once when it exits (exit code, last lines, log path). Keep working or end your turn.`,
      `A check-in arrives after ${timeoutS}s if it is still running; it is not a failure and the job keeps going.`,
    ].join('\n');
    return {
      content: [{ type: 'text' as const, text }],
      details: { jobId: id, paneId: info.id, logPath, status: 'running', timeoutSeconds: timeoutS },
    };
  }

  async function executeStatus(params: ToolParams) {
    const job = findJob(params?.job_id);
    if (!job) return fail(`unknown job "${String(params?.job_id)}" (see action list)`);
    await refresh(job);
    const tail = await readLogEnd(job.logPath, 'tail').catch(() => null);
    const preview = tail === null || tail.trim() === '' ? '' : tailLines(tail, NOTICE_TAIL_LINES);
    const text = preview === ''
      ? formatJobStatus(job, Date.now())
      : `${formatJobStatus(job, Date.now())}\nLast output:\n${preview}`;
    return {
      content: [{ type: 'text' as const, text }],
      details: { jobId: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath },
    };
  }

  async function executeLog(params: ToolParams) {
    const job = findJob(params?.job_id);
    if (!job) return fail(`unknown job "${String(params?.job_id)}" (see action list)`);
    const mode: 'head' | 'tail' = params?.mode === 'head' ? 'head' : 'tail';
    const text = await readLogEnd(job.logPath, mode).catch(() => null);
    if (text === null) return fail(`no log for ${job.id} at ${job.logPath} (the job may have failed to start)`);
    const slice = readLogSlice(text, {
      mode,
      lines: typeof params?.lines === 'number' ? params.lines : 100,
      ...(typeof params?.grep === 'string' ? { grep: params.grep } : {}),
    });
    if (!slice.ok) return fail(slice.error);
    if (slice.total === 0) {
      return {
        content: [{ type: 'text' as const, text: `${job.id}: no matching lines in ${mode} of ${job.logPath}` }],
        details: { jobId: job.id, total: 0, shown: 0, logPath: job.logPath },
      };
    }
    const header = `${job.id} · ${mode} ${slice.shown}/${slice.total} matching lines · ${job.logPath}`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n${slice.text}` }],
      details: { jobId: job.id, total: slice.total, shown: slice.shown, logPath: job.logPath },
    };
  }

  async function executeStop(params: ToolParams) {
    const job = findJob(params?.job_id);
    if (!job) return fail(`unknown job "${String(params?.job_id)}" (see action list)`);
    if (job.status !== 'running') {
      return {
        content: [{ type: 'text' as const, text: `${job.id} was already ${job.status}.` }],
        details: { jobId: job.id, status: job.status },
      };
    }
    // Whoever stopped the job already knows: a stop never notifies.
    job.status = 'stopped';
    job.endedAt = Date.now();
    stopWatchers(job.id);
    try {
      await client.kill(job.paneId);
      await client.remove(job.paneId);
    } catch (err) {
      return fail(coreUnavailableHint(err) ?? `stop failed (the job may already be gone): ${errText(err)}`);
    }
    return {
      content: [{ type: 'text' as const, text: `stopped ${job.id}; its log stays at ${job.logPath}.` }],
      details: { jobId: job.id, status: 'stopped', logPath: job.logPath },
    };
  }

  async function executeList() {
    const all = [...jobs.values()].sort((left, right) => right.startedAt - left.startedAt);
    for (const job of all) await refresh(job);
    if (all.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No background jobs in this session.' }], details: { count: 0 } };
    }
    const now = Date.now();
    return {
      content: [{ type: 'text' as const, text: all.map((job) => formatJobListLine(job, now)).join('\n') }],
      details: { count: all.length },
    };
  }

  scoped.registerTool({
    name: 'bg-job',
    label: 'Background job',
    description: [
      'Run one shell command in the background as its own Herdr terminal and be told once when it exits.',
      'You get the exit code, the last lines and the log path; the whole output stays in the log and is',
      'read on demand with action "log" (head, tail, lines, grep). Do not poll or sleep: keep working or end your turn.',
      'A check-in arrives if the job outlives timeout_s; it is a glance, not a failure, and the job keeps running.',
      'Actions: start (default), status, log, stop, list.',
      'The command runs under bash with pipefail, so the exit code is the pipeline\'s last failing command.',
    ].join(' '),
    promptSnippet: 'bg-job: run a command in the background and be told once when it exits (exit code, last lines, log).',
    promptGuidelines: [
      'Prefer bg-job over bash for anything slow or of unknown duration (builds, test suites, CI, installs, deploys, servers, migrations); keep bash for short commands that finish in seconds.',
      'After start, continue other work or end the turn: never poll status or log to wait for the end.',
      'When a check-in arrives the job is still running: look once with log, then keep waiting or stop it — never re-send the command.',
      'Use bash for anything interactive: bg-job has no way to answer a prompt, and a command that asks for input just hangs.',
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union(BG_JOB_ACTIONS.map((name) => Type.Literal(name)), {
        description: 'Default start',
      })),
      command: Type.Optional(Type.String({
        description: '[start] Shell command to run: any multiline script, pipe or heredoc; it must not need input',
      })),
      name: Type.Optional(Type.String({
        description: '[start] Short human-readable label, e.g. "build release"',
      })),
      cwd: Type.Optional(Type.String({
        description: '[start] Working directory (default: the session cwd)',
      })),
      timeout_s: Type.Optional(Type.Number({
        description: `[start] Check in if it is still running after this many seconds (default ${DEFAULT_TIMEOUT_S}, 5-3600)`,
      })),
      job_id: Type.Optional(Type.String({
        description: '[status|log|stop] Job id returned by start, e.g. job-1',
      })),
      mode: Type.Optional(Type.Union([Type.Literal('head'), Type.Literal('tail')], {
        description: '[log] Read from the start or the end (default tail)',
      })),
      lines: Type.Optional(Type.Number({
        description: '[log] How many lines to return (1-400, default 100)',
      })),
      grep: Type.Optional(Type.String({
        description: '[log] Keep only lines matching this regular expression',
      })),
    }),
    async execute(_tc: string, params: ToolParams, _sig: AbortSignal | undefined, _upd: unknown, ctx: unknown) {
      const action = (typeof params?.action === 'string' ? params.action : 'start') as BgJobAction;
      switch (action) {
        case 'start': return executeStart(params, ctx);
        case 'status': return executeStatus(params);
        case 'log': return executeLog(params);
        case 'stop': return executeStop(params);
        case 'list': return executeList();
        default:
          return fail(`unknown action "${action}" (valid: ${BG_JOB_ACTIONS.join(', ')})`);
      }
    },
  });

  // Jobs end with this terminal (core's default), so shutdown only stops the bookkeeping: a timer
  // that outlived the session would keep reading a log nobody asked about.
  const dispose = (): void => {
    for (const id of [...timers.keys()]) stopWatchers(id);
    for (const id of [...watches.keys()]) stopWatchers(id);
  };
  scoped.on('session_shutdown', async () => { dispose(); });
  ctx.effect(() => dispose, 'bg-job-watchers');
}
