/**
 * Subagent spawn domain: git I/O, app tab placement, launch argv, readiness wait, and the `spawn`
 * action. Children are created by herdr-core (`terminal.run`) with the full argv, so no shell
 * prompt probe or pasted launch line is involved; the app adopts the terminal as a pane of its tab.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat as statCb } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { childEnvironment, isCoreErrorKind, type CoreClientLike, type CoreEnv, type SendResult } from './core-client.ts';
import { delegationEnv } from './delegation-core.ts';
import { saveTaskPrompt } from './prompt-store.ts';
import { bareSessionId } from './session-tail.ts';
import { mainWorktreeRoot } from './storage-layout.ts';
import { checkoutAckLine, checkoutSpaceId, ensureCheckout, planWorktree, releaseCheckout, type CheckoutIo, type CheckoutSpace, type WorktreeRecord } from './worktree.ts';
import { composeForRole } from './manifest-compose.ts';
import type { Lifecycle } from './role-manifest.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { toolError } from './tool-error.ts';
import {
  Semaphore,
  buildLaunchLine,
  buildLaunchParts,
  classifyWorktreeZone,
  formatSpawnFailure,
  isPathUnder,
  planLaunchValidation,
  planTabPlacement,
  sleep,
  withAdmission,
  withoutPlacement,
  type WorktreeZone,
} from './subagent-core.ts';
import { allocateTaskSlug, taskRef, type TaskEntry } from './task-row.ts';
import type { Poller } from './subagent-poller.ts';
import type { SessionIo } from './subagent-session.ts';
import { HRESUME_LABEL, hresumeSessionFile, hresumeReport } from './subagent-session.ts';

const statAsync = promisify(statCb);

/* ── git adapter ────────────────────────────────────────────────── */

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitError extends Error {
  readonly code?: string | number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Output ceiling for one git call: a large checkout blows past execFile's 1MB default (ENOBUFS). */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitAdapter {
  listWorktrees(cwd: string): Promise<GitResult>;
  status(cwd: string): Promise<GitResult>;
  /** Throws a GitError on failure/timeout; callers wanting "null on error" catch at the call site. */
  run(cwd: string, args: readonly string[]): Promise<GitResult>;
}

const execFile = promisify(nodeExecFile);

export class NodeGitAdapter implements GitAdapter {
  private readonly gitExecutable: string;
  private readonly timeoutMs: number;
  private readonly exec: GitExecFile;

  constructor(
    gitExecutable: string = 'git',
    timeoutMs: number = runtimePolicy.gitTimeoutMs,
    exec: GitExecFile = execFile as unknown as GitExecFile,
  ) {
    this.gitExecutable = gitExecutable;
    this.timeoutMs = timeoutMs;
    this.exec = exec;
  }

  listWorktrees(cwd: string): Promise<GitResult> {
    return this.run(cwd, ['worktree', 'list', '--porcelain']);
  }

  status(cwd: string): Promise<GitResult> {
    return this.run(cwd, ['status', '--short']);
  }

  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await this.exec(
        this.gitExecutable,
        ['-C', cwd, ...args],
        { timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER },
      );
      return { stdout, stderr };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw Object.assign(err instanceof Error ? err : new Error(), {
        message: `Git ${args[0] ?? 'command'} failed: ${message}`,
      }) as GitError;
    }
  }
}

export const defaultGitAdapter = new NodeGitAdapter();

/* ── git I/O used by spawn and GC ── */

const WORKTREES_CACHE_MS = 5000;

export interface GitIo {
  listWorktrees(cwd: string): Promise<string[]>;
}

export function createGitIo(git: GitAdapter = defaultGitAdapter): GitIo {
  let worktreesCache: { at: number; list: string[] } | null = null;

  async function listWorktrees(cwd: string): Promise<string[]> {
    if (worktreesCache && Date.now() - worktreesCache.at < WORKTREES_CACHE_MS) return worktreesCache.list;
    let list: string[] = [];
    try {
      const { stdout } = await git.listWorktrees(cwd);
      for (const line of String(stdout).split('\n')) {
        const m = /^worktree (.+)$/.exec(line.trim());
        if (m) list.push(m[1]!);
      }
    } catch {
      list = [];
    }
    worktreesCache = { at: Date.now(), list };
    return list;
  }

  return {
    listWorktrees,
  };
}

/* ── readiness and first-task delivery (pure planners) ─────────── */

const READY_BASE_INTERVAL_MS = 500;
const READY_MAX_INTERVAL_MS = 4000;
/** The screen tail only explains a failure, so it is sampled far less often than the core's status. */
const READY_TAIL_SAMPLE_MS = 2500;
/** Enough of the pane tail to carry a stack trace head into the failure text. */
const READY_TAIL_CHARS = 1200;
/** A program that never reports status (`PI_PROGRAM_STATUS=0`, or a pi that cannot answer the 7501
 *  query) leaves the core unable to gate us. After this much of the budget — half of it at most — the
 *  task is handed over anyway and the delivery's own facts decide (spec S14, S22): readiness must not
 *  depend on a program volunteering a status word. */
const READY_UNREPORTED_GRACE_MS = 3000;

interface ReadyFailure {
  readonly paneId: string;
  readonly reason: 'pane-gone' | 'timeout' | 'blocked' | 'error';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly lastStatus?: string | null;
  readonly tail?: string | null;
  /** Whether the caller really keeps the pane it names. The text must not promise `output`/retry
   *  on a pane the caller is about to retire (the revive path: no row will ever point at it). */
  readonly kept?: boolean;
}

type ReadyAttemptPlan =
  | { readonly kind: 'ready' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give-up'; readonly reason: 'pane-gone' | 'blocked' | 'error' | 'timeout' };

/** The status words that mean "this agent is not in a turn, so its composer takes input": `idle` is
 *  what a booted agent reports, `done` the same fact once its last turn finished (spec S2 words).
 *  `unknown` is not among them — it is the absence of a word — so a program that reports nothing is
 *  released by `planReadyAttempt`'s grace instead, never by this predicate. */
export function isReadyStatus(status: string | null | undefined): boolean {
  return status === 'idle' || status === 'done';
}

/** Whether the core has no word at all from this program: it reports nothing, so nothing about its
 *  readiness can be read from `status` and the delivery has to decide (spec S22). */
export function isUnreportedStatus(status: string | null | undefined): boolean {
  return status == null || status === 'unknown';
}

/** The budget left for an unreported program before it is treated as ready: a grace, never the whole
 *  budget, so a program that does report status is still waited for. */
export function unreportedGraceMs(timeoutMs: number): number {
  return Math.min(READY_UNREPORTED_GRACE_MS, Math.floor(Math.max(0, timeoutMs) / 2));
}

/** Decide one readiness attempt. `alive` is tri-state on purpose: an unavailable liveness probe
 * (`null`) must not be read as death, or a slow herdr socket fails spawns that are merely slow. */
export function planReadyAttempt(opts: {
  elapsedMs: number;
  attempt: number;
  timeoutMs: number;
  alive: boolean | null;
  status: string | null | undefined;
}): ReadyAttemptPlan {
  // A finished terminal is never ready, whatever word it last reported.
  if (opts.alive === false) return { kind: 'give-up', reason: 'pane-gone' };
  if (isReadyStatus(opts.status)) return { kind: 'ready' };
  // A dialog or a reported error needs a person, not more waiting: saying so at once is the only
  // advice that can still be acted on, because the boot keeps the pane it is talking about.
  if (opts.status === 'blocked') return { kind: 'give-up', reason: 'blocked' };
  if (opts.status === 'error') return { kind: 'give-up', reason: 'error' };
  // Nobody can tell: the program never reported. Hand the task over after the grace and let the
  // send's own result and the pane's turn decide, instead of failing a worker that cannot answer.
  if (isUnreportedStatus(opts.status) && opts.elapsedMs >= unreportedGraceMs(opts.timeoutMs)) {
    return { kind: 'ready' };
  }
  if (opts.elapsedMs >= opts.timeoutMs) return { kind: 'give-up', reason: 'timeout' };
  return { kind: 'retry', delayMs: readyBackoffMs(opts.attempt) };
}

/** Exponential backoff with a cap: 500ms, 1s, 2s, 4s, 4s, … */
export function readyBackoffMs(attempt: number, baseMs = READY_BASE_INTERVAL_MS, capMs = READY_MAX_INTERVAL_MS): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** n);
}

/** Whether a boot failure leaves a pane worth keeping: everything but a pane that is gone keeps its
 *  terminal, its task row and its record, because a person (a dialog to answer) or the master's next
 *  action (read it, retry, close) can still act on it. Retiring it would make the advice a lie and
 *  throw away the only place the reason is visible. */
export function keepsPane(reason: ReadyFailure['reason']): boolean {
  return reason !== 'pane-gone';
}

/** Failure text for the model. Every live-pane case names the action that follows from it: when the
 *  caller keeps the pane, `output` reads it and the task can be retried or closed; when it does not
 *  (`kept: false`), the text says the pane was retired instead of promising actions on nothing. */
export function readyFailureText(failure: ReadyFailure): string {
  const seconds = Math.round(failure.elapsedMs / 1000);
  const kept = failure.kept !== false && failure.reason !== 'pane-gone';
  const head = failure.reason === 'pane-gone'
    ? `subagent pane ${failure.paneId} exited before its agent reported ready (waited ${seconds}s)`
    : failure.reason === 'blocked'
      ? `subagent pane ${failure.paneId} is blocked on a dialog (trust, auth or a question)`
      : failure.reason === 'error'
        ? `subagent pane ${failure.paneId} reported an error before it was ready`
        : `subagent pane ${failure.paneId} was not ready within ${seconds}s (limit ${Math.round(failure.timeoutMs / 1000)}s)`;
  const why = failure.reason === 'pane-gone'
    ? 'The child process is gone — its last output below usually carries the reason.'
    : !kept
      ? 'Nothing was pasted, and the pane it created was retired: no task points at it, so it is not left behind.'
      : failure.reason === 'blocked'
        ? 'Nothing was pasted. The pane is kept: answer that dialog in the pane, then retry this task.'
        : failure.reason === 'error'
          ? 'Nothing was pasted. The pane is kept so its last output can be read; retry the task or close it.'
          : failure.lastStatus === 'working'
            ? 'Nothing was pasted: the pane is alive and already running a turn of its own. The pane is kept — give it time, read it with action "output", then retry this task.'
            : `The pane is alive but its agent never reported \`idle\` (last status: ${failure.lastStatus ?? 'none'}). The pane is kept: the child pi process may still be starting, or the program reports no status at all (piher's status comes from the program's own OSC 7501 report; \`PI_PROGRAM_STATUS=0\` turns that off).`;
  const tail = failure.tail ? `\nlast output of ${failure.paneId}:\n${failure.tail}` : '';
  return `${head}\n${why}${tail}`;
}

/** Whether a core error about the pane means nothing is there any more: the row and the advice must
 *  not claim a terminal the core says is gone (`not_found`, `finished`). Every other kind — a dialog,
 *  a status mismatch, a transient transport failure — leaves a pane a person or the master can act on. */
export function keepsPaneForCoreError(err: unknown): boolean {
  return !(isCoreErrorKind(err, 'not_found') || isCoreErrorKind(err, 'finished'));
}

/** What one delivery attempt proved (spec S25): `started: true`, or a turn that began where none had
 *  begun before. The core's `started` cannot say "no" — `null` means "the program does not report
 *  status, so nobody can tell" — so `null` alone proves nothing in either direction, and the turn is
 *  read on both sides of the send to decide it. */
export interface TaskAttemptFacts {
  /** The core refused the send with `status_mismatch`: nothing was typed, so a fresh send is safe. */
  refusedNotIdle: boolean;
  started: boolean | null;
  /** The pane's turn before the attempt. */
  turnBefore: number | null;
  /** The pane's turn and status right after the attempt. */
  turnAfter: number | null;
  statusAfter: string | null;
  elapsedMs: number;
  timeoutMs: number;
}

export type TaskSendPlan =
  | { readonly kind: 'delivered' }
  /** The text is in the composer and only the submit is missing: press Enter, never paste again. */
  | { readonly kind: 'resubmit'; readonly delayMs: number }
  /** Nothing was typed (the core's `if` gate refused): a fresh send is safe and cannot duplicate. */
  | { readonly kind: 'repaste'; readonly delayMs: number }
  | { readonly kind: 'give-up' };

export function planTaskSend(f: TaskAttemptFacts): TaskSendPlan {
  // Spec S25: delivery is `started: true`, or a turn that began where none had begun before.
  if (f.started === true) return { kind: 'delivered' };
  if (f.statusAfter === 'working') return { kind: 'delivered' };
  if (f.turnAfter !== null && f.turnBefore !== null && f.turnAfter > f.turnBefore) return { kind: 'delivered' };
  if (f.elapsedMs >= f.timeoutMs) return { kind: 'give-up' };
  return f.refusedNotIdle
    ? { kind: 'repaste', delayMs: readyBackoffMs(0) }
    : { kind: 'resubmit', delayMs: readyBackoffMs(0) };
}

/** The send never became a turn: name what the core answered, and keep the advice to what is known —
 *  the pane is alive and was not retired, which is all the delivery loop can prove. */
export function taskNotStartedText(opts: {
  paneId: string;
  attempts: number;
  elapsedMs: number;
  last: { started: boolean | null; status: string | null; turn: number };
}): string {
  const seconds = Math.round(opts.elapsedMs / 1000);
  const started = opts.last.started === null ? 'null (the agent never reported status)' : String(opts.last.started);
  return `subagent pane ${opts.paneId} took no turn from its first message after ${opts.attempts} attempts in ${seconds}s `
    + `(last result: started ${started}, status ${opts.last.status ?? 'none'}, turn ${opts.last.turn}). `
    + 'The pane is kept: read it with action "output", then retry this task or close it.';
}

/* ── spawner ────────────────────────────────────────────────────── */

interface SpawnerHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  runtime: { nodePath: string; cliPath: string; extPath: string };
  git: GitIo;
  /** Test override. Production reads `runtimePolicy.readinessTimeoutMs`. */
  readinessTimeoutMs?: number;
}

/** A boot failure, and whether the pane it names is worth keeping: a live pane that never took its
 *  task is not the same thing as a pane that died (see `keepsPane`). */
export class BootFailure extends Error {
  readonly keepPane: boolean;
  constructor(message: string, keepPane: boolean) {
    super(message);
    this.name = 'BootFailure';
    this.keepPane = keepPane;
  }
}

type ReadyOutcome =
  | { ok: true; status: string | null }
  | { ok: false; message: string; keepPane: boolean };

export interface Spawner {
  spawnPaneInTaskTab(
    placement: {
      desiredTab?: string | null;
      description: string;
      zone?: WorktreeZone;
      spaceId?: string | null;
      visible: boolean;
    },
    cwd: string,
    envOver: Record<string, string>,
    argv: readonly string[],
  ): Promise<{ tabId: string; paneId: string; tabName: string }>;
  launchParts(resumeFile?: string | null, roleModel?: string | null, roleThinking?: string | null, approve?: boolean): string[];
  approveFor(cwd: string, masterCwd: string): Promise<boolean>;
  /** Wait for the core to say the worker's agent is up and idle (never a ping on a private socket),
   *  spending at most `budgetMs` of the caller's budget. `keepPane: false` is for a caller that cannot
   *  keep the pane it names (a revive): the outcome and the text both say it is retired. */
  waitReady(paneId: string, budgetMs?: number, opts?: { keepPane?: boolean }): Promise<ReadyOutcome>;
  /** Send the first task through the core and believe only the core's own result or a new turn. */
  deliverFirstTask(
    paneId: string,
    text: string,
    opts: { budgetMs: number; statusAtReady: string | null },
  ): Promise<void>;
  /** The boot budget: readiness plus the delivery retries share this one number. */
  readonly readinessTimeoutMs: number;
  findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null>;
}

export function createSpawner(h: SpawnerHost): Spawner {
  const readyTimeoutMs = h.readinessTimeoutMs ?? runtimePolicy.readinessTimeoutMs;

  async function approveFor(cwd: string, masterCwd: string): Promise<boolean> {
    if (isPathUnder(cwd, masterCwd)) return true;
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await h.git.listWorktrees(masterCwd) });
    return zone.zone === 'worktree';
  }

  /** Wait for the core's readiness with backoff; give up early when the pane is gone, blocked or in
   * error. The screen tail is sampled while the pane exists so a crash that leaves a shell still
   * explains itself. `budgetMs` is what the caller has left: one budget per boot, never a fresh one per
   * attempt. `opts.keepPane: false` is for a caller that cannot keep the pane it names (a revive), so
   * both the outcome and the text say the pane is retired instead of promising actions on it. */
  async function waitReady(
    paneId: string,
    budgetMs: number = readyTimeoutMs,
    opts: { keepPane?: boolean } = {},
  ): Promise<ReadyOutcome> {
    const startedAt = Date.now();
    let attempt = 0;
    let lastTailAt = 0;
    let tail: string | null = null;

    while (true) {
      const now = Date.now();
      const elapsedMs = now - startedAt;
      const probe = await probeChildPane(paneId);
      if (now - lastTailAt >= READY_TAIL_SAMPLE_MS || attempt === 0) {
        lastTailAt = now;
        const sampled = await paneTail(paneId);
        if (sampled) tail = sampled;
      }
      const plan = planReadyAttempt({
        elapsedMs, attempt, timeoutMs: budgetMs, alive: probe.alive, status: probe.status,
      });
      if (plan.kind === 'ready') return { ok: true, status: probe.status };
      if (plan.kind === 'give-up') {
        const keepPane = opts.keepPane === false ? false : keepsPane(plan.reason);
        const failure: ReadyFailure = {
          paneId,
          reason: plan.reason,
          elapsedMs: Math.max(elapsedMs, 1),
          timeoutMs: budgetMs,
          lastStatus: probe.status,
          tail,
          kept: keepPane,
        };
        return { ok: false, message: readyFailureText(failure), keepPane };
      }
      attempt += 1;
      // Never sleep past the budget: a retry may not overshoot the deadline the caller is waiting on.
      await sleep(Math.min(plan.delayMs, Math.max(0, budgetMs - elapsedMs)));
    }
  }

  /** Hand the worker its first task through the core (spec S14, S22) inside the caller's remaining
   * budget. Three rules, in order:
   *
   *  - the paste is conditional on the status the core sees when it types (`if: idle`) whenever the
   *    agent reports a status, so readiness and paste are one request and a status change in the gap
   *    (a person typing, a turn starting) cannot land the paste in a program that stopped being idle;
   *  - a send the core did not report as started is never re-pasted: its own result says the text went
   *    in, so the composer holds the brief and only the submit is missing — Enter submits it, which
   *    cannot put the brief in the turn twice;
   *  - a turn that was not there before the attempt, or one still in flight, is delivery even when
   *    `started` is null, because that word only ever means "nobody can tell". */
  async function deliverFirstTask(
    paneId: string,
    text: string,
    opts: { budgetMs: number; statusAtReady: string | null },
  ): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = opts.budgetMs;
    // `if: idle` only where it can hold: for a program the core has a word from, and only when that
    // word is `idle` (the schema's gate has no `done`). On a program that reports nothing the gate
    // would refuse forever, so the delivery's own facts decide instead.
    let gateAllowed = !isUnreportedStatus(opts.statusAtReady);
    let gate: { if?: 'idle' } = opts.statusAtReady === 'idle' ? { if: 'idle' } : {};
    let before = await probeChildPane(paneId);
    let pending: 'send' | 'enter' = 'send';
    let attempts = 0;

    while (true) {
      let result: SendResult | null = null;
      let refusedNotIdle = false;
      try {
        if (pending === 'send') result = await h.client.send(paneId, text, gate);
        else await h.client.keys(paneId, ['enter']);
      } catch (err) {
        if (pending === 'send' && isCoreErrorKind(err, 'status_mismatch')) {
          // Nothing was typed, so a fresh send is safe; and the core's status reading is out of step
          // with ours, so stop gating on its word and let the turn facts decide.
          refusedNotIdle = true;
          gateAllowed = false;
          gate = {};
        } else {
          throw new BootFailure(
            `subagent pane ${paneId} could not take its first message: ${(err as Error)?.message ?? String(err)}`,
            keepsPaneForCoreError(err),
          );
        }
      }
      attempts += 1;
      const after = await probeChildPane(paneId);
      const plan = planTaskSend({
        refusedNotIdle,
        started: result?.started ?? null,
        turnBefore: before.turn,
        turnAfter: after.turn,
        statusAfter: after.status,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
      });
      if (plan.kind === 'delivered') return;
      if (plan.kind === 'give-up') {
        throw new BootFailure(taskNotStartedText({
          paneId,
          attempts,
          elapsedMs: Date.now() - startedAt,
          last: result ?? { started: null, status: after.status, turn: after.turn ?? 0 },
        }), after.alive !== false);
      }
      pending = plan.kind === 'resubmit' ? 'enter' : 'send';
      await sleep(plan.delayMs);
      // Readiness again, on the same budget and before every retry: the measured failure is a send
      // issued before the agent reports `idle`, and the identical send after it starts the turn.
      const ready = await waitReady(paneId, Math.max(0, timeoutMs - (Date.now() - startedAt)));
      if (!ready.ok) throw new BootFailure(ready.message, ready.keepPane);
      if (gateAllowed) gate = ready.status === 'idle' ? { if: 'idle' } : {};
      before = await probeChildPane(paneId);
    }
  }

  /** The core's facts about the pane: liveness, its own status word and its turn. A core failure
   * degrades to "unknown", never "dead" — and to no turn at all, which reads as "no evidence". */
  async function probeChildPane(paneId: string): Promise<{ alive: boolean | null; status: string | null; turn: number | null }> {
    try {
      const terminal = await h.client.getTerminal(paneId);
      return {
        alive: terminal != null && terminal.state !== 'finished',
        status: terminal?.status ?? null,
        turn: terminal?.turn ?? null,
      };
    } catch {
      /* core unreachable: liveness stays unknown, never "dead" */
      return { alive: null, status: null, turn: null };
    }
  }

  /** Last visible output, for the failure text only: a screen read never decides anything (spec S16). */
  async function paneTail(paneId: string): Promise<string | null> {
    try {
      const read = await h.client.read(paneId, { lines: 40 });
      return read.text ? read.text.slice(-READY_TAIL_CHARS) : null;
    } catch {
      /* reaped terminal or socket blip: the caller keeps the last cached tail */
      return null;
    }
  }

  /**
   * Create the worker terminal where its labels say.
   *
   * A worker opens no pane at all unless asked: with no placement label the app never adopts it, so
   * it lives in core alone. The app's agents view still lists it — that view walks the core's
   * terminals and nests pane-less children under their parent (`mods/agents/main.js:176`), with
   * `peek` to watch one on demand. A pane beside the master was noise nobody asked for.
   *
   * Two cases do ask for a pane: a worker in its own checkout names the checkout's `herdr.space`
   * (the app's worktree button), and an explicit `tab` joins a tab of this master's space. A second
   * worker on that same checkout also joins the tab the app made there, so a worker and its reviewer
   * sit in one tab instead of two.
   */
  async function spawnPaneInTaskTab(
    placement: {
      desiredTab?: string | null;
      description: string;
      zone?: WorktreeZone;
      spaceId?: string | null;
      /** Only an explicit `tab` puts the worker in this master's space. */
      visible: boolean;
    },
    cwd: string,
    envOver: Record<string, string>,
    argv: readonly string[],
  ): Promise<{ tabId: string; paneId: string; tabName: string }> {
    const plan = planTabPlacement({
      desiredTab: placement.desiredTab,
      description: placement.description,
      zone: placement.zone,
    });
    const placementLabels = await h.client.placementLabels();
    // A second worker on the same checkout joins the tab the app already made in its space, so a
    // worker and the reviewer that reads it sit side by side instead of in two tabs of one space.
    const checkoutTab = placement.spaceId ? await tabInCheckoutSpace(placement.spaceId) : '';
    const labels = placement.spaceId
      ? {
        ...withoutPlacement(placementLabels),
        'herdr.space': placement.spaceId,
        ...(checkoutTab ? { 'herdr.tab': checkoutTab } : {}),
      }
      : !placement.visible
        ? withoutPlacement(placementLabels)
        : plan.tabId ? { ...placementLabels, 'herdr.tab': plan.tabId } : placementLabels;
    const terminal = await h.client.run({
      argv: [...argv],
      cwd,
      env: childEnvironment(process.env, envOver),
      labels,
      noNotify: true,
    });
    return placement.spaceId
      ? { tabId: checkoutTab, paneId: terminal.id, tabName: '' }
      : !placement.visible
        ? { tabId: '', paneId: terminal.id, tabName: '' }
        : {
          tabId: plan.tabId ?? placementLabels['herdr.tab'] ?? '',
          paneId: terminal.id,
          tabName: plan.tabName,
        };
  }

  /** The tab the app already made inside a checkout's space, if a terminal is there already.
   *
   * A space spawn names only `herdr.space`: the app creates the space and a tab inside it, and writes
   * the tab id back onto the terminal it adopted. Reading it from the sibling is what keeps the
   * second spawn of a checkout in that same tab; the first one of a checkout finds nothing here and
   * lets the app make the tab. A worker of ours wins over an unrelated terminal that happens to sit
   * in the space, and any failure falls back to today's behaviour (a tab of its own).
   */
  async function tabInCheckoutSpace(spaceId: string): Promise<string> {
    try {
      const terminals = await h.client.listTerminals({ all: true });
      const inSpace = terminals.filter((t) => t.labels['herdr.space'] === spaceId && t.labels['herdr.tab']);
      const ours = inSpace.find((t) => hresumeSessionFile(t.labels[HRESUME_LABEL]) !== null);
      return (ours ?? inSpace[0])?.labels['herdr.tab'] ?? '';
    } catch {
      return '';
    }
  }

  /** D94: reuse a terminal that already runs the same session instead of competing on one transcript.
   *  The worker's own Herdr extension reports its session in the `hresume` label (spec S18), and only a
   *  pi process is a candidate: another agent's label matching the same id is not a pi session to
   *  share, and reusing it would point the row at a program piher cannot resume. */
  async function findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    const wanted = bareSessionId(sessionFile);
    try {
      const terminals = await h.client.listTerminals();
      const match = terminals.find((t) => {
        const reported = hresumeReport(t.labels[HRESUME_LABEL]);
        return reported != null && reported.agent === 'pi' && bareSessionId(reported.file) === wanted;
      });
      if (!match) return null;
      return { paneId: match.id, tabId: match.labels['herdr.tab'] ?? '' };
    } catch {
      return null;
    }
  }

  return {
    spawnPaneInTaskTab,
    launchParts: (resumeFile, roleModel, roleThinking, approve) => buildLaunchParts(h.runtime, { resumeFile, roleModel, roleThinking, approve: approve ?? false }),
    approveFor,
    waitReady,
    deliverFirstTask,
    readinessTimeoutMs: readyTimeoutMs,
    findExistingPane,
  };
}

/* ── spawn action ───────────────────────────────────────────────── */

interface SpawnActionHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  subSemaphore: Semaphore;
  tasks: Map<string, TaskEntry>;
  panes: Map<string, string>;
  writeRecord(entry: TaskEntry): void;
  appendView(taskId: string): void;
  /** A spawn that never started leaves no record and no view id behind. */
  dropTask?(taskId: string): void;
  /** Pane id → its in-flight boot (readiness, first task, session resolution). */
  boots: Map<string, Promise<void>>;
  /** A spawn whose boot failed off the caller's turn: the only report a failed start can make. */
  notifySpawnFailed: (content: string) => Promise<void>;
  git: GitIo;
  /** S71: the checkout piher may create on request. */
  checkout: CheckoutIo;
  /** Closes the app space a checkout worker opened; omitted means no app at all. */
  checkoutSpace?: CheckoutSpace;
  session: SessionIo;
  spawn: Spawner;
  poller: Poller;
  /** Master session id for the delegation identity handed to the worker. */
  getSessionId: () => string;
}

export function createSpawnAction(h: SpawnActionHost) {
  const { client, env, git, tasks, panes } = h;
  const { resolveSessionFile } = h.session;
  const { spawnPaneInTaskTab, launchParts, waitReady, deliverFirstTask, readinessTimeoutMs } = h.spawn;
  const { startPoller } = h.poller;

  return async function executeSubagentSpawn(
    params: Record<string, unknown> | undefined,
    toolCtx: unknown,
  ): Promise<unknown> {
    const launch = planLaunchValidation(params, client.available);
    if (launch.kind === 'error') return toolError(launch.text);
    const { spec, cwdParam, worktreeParam, roleKind: kind, suggested, manifestRole, tab } = launch;
    const masterCwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const taskId = randomUUID();
    // Validate the role before any pane exists: this early return has no cleanup path.
    let roleManifestEnv: Record<string, string> = {};
    let roleModel: string | null = null;
    let roleThinking: string | null = null;
    /** S54: one-shot lifetimes get their pane reclaimed at settlement instead of at the GC TTL. */
    let roleLifecycle: Lifecycle = 'persistent';
    // Delegation identity (RFC rfc-delegation-identity §2.1): the worker learns who delegated it.
    let delegationEnvPatch: Record<string, string> = {};
    try {
      const { role, manifest } = composeForRole(manifestRole ?? 'worker-default', suggested, { loadRoleOpts: { baseDir: masterCwd } });
      roleManifestEnv = {
        PIHER_ROLE_MANIFEST: JSON.stringify({
          role: role.role,
          version: role.version,
          tools: manifest.tools,
          permissions: manifest.permissions,
          unknownTools: manifest.unknownTools,
          // Without guidelines parseRuntimeManifest yields none and the piher-role prompt section silently no-ops.
          ...(role.guidelines?.length ? { guidelines: role.guidelines } : {}),
          ...(role.instructions ? { instructions: role.instructions } : {}),
        }),
        // Role base: /piher-role resolves .piher/roles/ against the MASTER's checkout.
        PIHER_ROLE_BASE: masterCwd,
      };
      // S9/S54: the lifetime is the role's, and the worker learns it from its own delegation record.
      roleLifecycle = role.lifecycle === 'one-shot' ? 'one-shot' : 'persistent';
      delegationEnvPatch = delegationEnv({
        parentPaneId: env?.terminalId ?? '',
        parentSessionId: bareSessionId(h.getSessionId()),
        taskId,
        description: spec.description,
        role: role.role,
        lifecycle: roleLifecycle,
      });
      if (typeof role.model === 'string' && role.model.trim()) roleModel = role.model.trim();
      if (typeof role.thinking === 'string' && role.thinking.trim()) roleThinking = role.thinking.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Error: role "${manifestRole}" manifest invalid — ${msg}`);
    }
    let cwd = masterCwd;
    let worktreeRecord: WorktreeRecord | null = null;
    let worktreeOutcome: 'created' | 'reused' | null = null;
    /** Only what this call created may be undone by this call (S71). */
    let createdCheckout = false;
    /** A spawn that fails after the checkout was made leaves nothing behind for the human. */
    const discardCheckout = (): void => {
      const record = worktreeRecord;
      if (!createdCheckout || !record) return;
      void (async (): Promise<void> => {
        await releaseCheckout(h.checkout, record, h.checkoutSpace).catch(() => null);
      })();
    };
    if (worktreeParam) {
      const repoRoot = mainWorktreeRoot(masterCwd);
      if (!repoRoot) {
        return toolError(`Error: \`worktree\` needs a git repository: ${masterCwd} is not inside one, so there is no branch to create the checkout from.`);
      }
      const planned = planWorktree({ name: worktreeParam, repoRoot, home: homedir() });
      if (planned.kind === 'error') return toolError(planned.text);
      const ensured = await ensureCheckout(h.checkout, { plan: planned.plan, cwd: masterCwd });
      if (ensured.kind === 'error') return toolError(ensured.text);
      createdCheckout = ensured.kind === 'created';
      worktreeOutcome = ensured.kind;
      cwd = planned.plan.path;
      worktreeRecord = { path: planned.plan.path, branch: planned.plan.branch };
      // S72: the task record names the checkout, so `resume` and `close` find it after a restart.
      // The app opens it by listing worktrees, so there is nothing else to record.
    } else if (cwdParam) {
      cwd = pathResolve(masterCwd, cwdParam);
      try {
        if (!(await statAsync(cwd)).isDirectory()) throw new Error('not a directory');
      } catch {
        return toolError(`Error: \`cwd\` is not an existing directory: ${cwdParam}`);
      }
    }
    // D86 R1: group by the git worktree containing cwd (main checkout → main tab; other → its tab).
    // A checkout piher just made is not in the (cached) worktree list yet, so it is its own case.
    const zone: WorktreeZone = worktreeRecord
      ? { zone: 'worktree', tabName: basename(worktreeRecord.path) }
      : classifyWorktreeZone({ cwd, masterCwd, worktrees: await git.listWorktrees(masterCwd) });
    // A checkout piher just made gets its own app space, named by the label the app adopts.
    const spaceId = worktreeRecord ? checkoutSpaceId(worktreeRecord.path) : null;
    // D86 trust: pass -a only for the master's checkout/worktrees; external dirs stay behind pi's Trust dialog.
    const approve = worktreeRecord != null || isPathUnder(cwd, masterCwd) || zone.zone === 'worktree';

    let paneId = '';
    try {
      const spawnedAt = Date.now();
      const argv = launchParts(null, roleModel, roleThinking, approve);
      // The slot covers pane creation only: the readiness wait and the prompt injection run off this
      // call's turn (S50), so they must never hold a slot a spawn would have to queue behind.
      const spawned = await withAdmission(h.subSemaphore, () => spawnPaneInTaskTab(
        {
          desiredTab: tab,
          description: spec.description,
          zone,
          spaceId,
          // An explicit `tab` is the only reason to give a worker a pane in this master's space.
          visible: tab != null && String(tab).trim() !== '',
        },
        cwd,
        // Status comes ONLY from pi's native OSC 7501 reporter; piher never writes it.
        { PIHER_SUBAGENT: '1', ...roleManifestEnv, ...delegationEnvPatch },
        argv,
      ));
      paneId = spawned.paneId;
      // Allocate once per spawn; revives keep the row's slug (stability beats beauty).
      const slug = allocateTaskSlug(
        spec.description,
        taskId,
        new Set([...tasks.values()].map((s) => s.gen.slug ?? '').filter(Boolean)),
      );
      const entry: TaskEntry = {
        taskId,
        kind,
        lifecycle: roleLifecycle,
        cwd,
        description: spec.description,
        ...(worktreeRecord ? { worktree: worktreeRecord } : {}),
        createdAt: Date.now(),
        closedAt: null,
        gen: {
          paneId,
          slug,
          tabId: spawned.tabId,
          tabName: spawned.tabName,
          sessionFile: null,
          launchCommand: [buildLaunchLine(argv)],
          startedAt: Date.now(),
          consumedAt: null,
          reportDelivered: null,
        },
      };
      // A spawn's acknowledgement is the whole answer: what follows happens off the caller's turn.
      // Spawn writes the record and the view, then answers (domain: spawn reads nothing).
      tasks.set(taskId, entry);
      panes.set(paneId, taskId);
      h.writeRecord(entry);
      h.appendView(taskId);
      // Keep the brief: an upstream failure is nobody's fault in the task, and `retry` re-sends this
      // text instead of making the master spend tokens writing it again.
      saveTaskPrompt(taskId, spec.prompt);
      const boot = (async (): Promise<void> => {
        // S14: the core's own status is the readiness gate, and the send's own result is delivery.
        // One budget for the whole boot (readiness + delivery retries): a retry may not restart a
        // clock the first attempt already spent, since a `send`/`retry` action waits on this boot.
        const deadline = Date.now() + readinessTimeoutMs;
        const ready = await waitReady(paneId, readinessTimeoutMs);
        if (!ready.ok) throw new BootFailure(ready.message, ready.keepPane);
        // The worker's `hresume` report lags right after spawn (its own Herdr extension writes it a
        // moment later), so the mtime fallback would otherwise adopt the newest PRE-EXISTING session in
        // cwd; only a file written after the terminal existed counts.
        entry.gen.sessionFile = await resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: spawnedAt - 2_000 });
        h.writeRecord(entry);
        // M11: the first task goes through the core's own `send`, reserving the PTY keyboard channel
        // for the human; injection and injectTs must stay together or the spawn leaves a ghost row.
        // S22: the send's own result (or a turn that did not exist before it) is delivery, and a send
        // that left the text in the composer is submitted, never pasted again.
        const injectTs = Date.now();
        await deliverFirstTask(paneId, spec.prompt, {
          budgetMs: Math.max(0, deadline - Date.now()),
          statusAtReady: ready.status,
        });
        void startPoller(paneId, cwd, injectTs, spec.description);
        h.writeRecord(entry);
      })();
      h.boots.set(paneId, boot);
      void boot.catch(async (err: unknown) => {
        const reason = (err as Error)?.message ?? String(err);
        const keep = err instanceof BootFailure && err.keepPane;
        // A pane that is gone leaves nothing behind: retire the terminal, drop the row and its record.
        // A pane that is alive is kept with its row, because the failure text tells the master to read
        // it, answer its dialog or retry — advice a kill would make impossible.
        if (!keep) {
          h.dropTask?.(taskId);
          tasks.delete(taskId);
          panes.delete(paneId);
          discardCheckout();
          try { await client.kill(paneId); } catch { /* already gone */ }
          try { await client.remove(paneId); } catch { /* core reaps finished terminals */ }
        } else {
          // A kept row has no settlement to come, and every reclaim path (the tab sweep, the pane
          // sweep, the checkout sweep) waits on `gen.consumedAt`, which only a settlement sets. The
          // poller is what sets it here: its silence budget is the watchdog that ends a worker which
          // never took its task, and it also owns the blocked-gate notice for a pane a person must
          // answer. Without it the pane, row, record and any checkout would live out the session.
          void startPoller(paneId, cwd, Date.now(), spec.description);
        }
        try {
          await h.notifySpawnFailed(
            keep
              ? `Subagent "${spec.description}" (pane ${paneId}, task ${taskId}) is up but did not take its first message: ${reason} The pane and the task are still there — read it with action "output" (agentId ${paneId}), then retry task ${taskId} or close it. If nothing answers, its silence budget ends it.`
              : `Subagent "${spec.description}" (pane ${paneId}, task ${taskId}) failed to start: ${reason} Nothing is running there; spawn it again if the task still matters.`,
          );
        } catch { /* a missed notice must not break the session */ }
      }).finally(() => {
        if (h.boots.get(paneId) === boot) h.boots.delete(paneId);
      });
      return {
        content: [{
          type: 'text',
          text: `started subagent ${taskRef(entry.gen)} (task ${taskId}, ${roleLifecycle === 'one-shot' ? 'one-shot — reports once and exits' : 'persistent — stays until you close it'})${worktreeRecord && worktreeOutcome ? ` ${checkoutAckLine(worktreeRecord, worktreeOutcome)}` : ''}. Your prompt is already its first message — do not resend it. Its result arrives as a settlement notice at your next turn boundary — do not sleep or poll for it.`,
        }],
        details: {
          paneId,
          taskId,
          role: kind,
          ...(slug ? { slug } : {}),
          ...(worktreeRecord ? { worktree: worktreeRecord } : {}),
        },
      };
    } catch (err) {
      // A mid-spawn failure must remove the task and retire its terminal, or a ghost entry never settles.
      if (paneId) {
        h.dropTask?.(taskId);
        tasks.delete(taskId);
        panes.delete(paneId);
        discardCheckout();
        void (async () => {
          try { await client.kill(paneId); } catch { /* already gone */ }
          try { await client.remove(paneId); } catch { /* core reaps finished terminals */ }
        })();
      }
      return {
        content: [{
          type: 'text',
          text: formatSpawnFailure(spec.description, String((err as Error)?.message ?? err)),
        }],
        details: {},
      };
    }
  };
}
