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
import { childEnvironment, type CoreClientLike, type CoreEnv, type SendResult } from './core-client.ts';
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

interface ReadyFailure {
  readonly paneId: string;
  readonly reason: 'pane-gone' | 'timeout';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly lastStatus?: string | null;
  readonly tail?: string | null;
}

type ReadyAttemptPlan =
  | { readonly kind: 'ready' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give-up'; readonly reason: 'pane-gone' | 'timeout' };

/** Readiness for the first message: the agent is up and its composer takes input, which is the
 *  core's own `status` word `idle` (spec S14). A terminal that never reported has none, so it is not
 *  ready however long it lives. */
export function isReadyStatus(status: string | null | undefined): boolean {
  return status === 'idle';
}

/** Decide one readiness attempt. `alive` is tri-state on purpose: an unavailable liveness probe
 * (`null`) must not be read as death, or a slow herdr socket fails spawns that are merely slow. */
export function planReadyAttempt(opts: {
  elapsedMs: number;
  attempt: number;
  timeoutMs: number;
  alive: boolean | null;
  ready: boolean;
}): ReadyAttemptPlan {
  if (opts.ready) return { kind: 'ready' };
  if (opts.alive === false) return { kind: 'give-up', reason: 'pane-gone' };
  if (opts.elapsedMs >= opts.timeoutMs) return { kind: 'give-up', reason: 'timeout' };
  return { kind: 'retry', delayMs: readyBackoffMs(opts.attempt) };
}

/** Exponential backoff with a cap: 500ms, 1s, 2s, 4s, 4s, … */
export function readyBackoffMs(attempt: number, baseMs = READY_BASE_INTERVAL_MS, capMs = READY_MAX_INTERVAL_MS): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** n);
}

/** Failure text for the model; the cases stay distinguishable: pane died (the tail carries the
 *  reason), pane alive and working anyway, pane alive but its agent never said `idle`, pane alive and
 *  blocked on a dialog, pane alive and just slower than the timeout. */
export function readyFailureText(failure: ReadyFailure): string {
  const seconds = Math.round(failure.elapsedMs / 1000);
  const head = failure.reason === 'pane-gone'
    ? `subagent pane ${failure.paneId} exited before its agent reported ready (waited ${seconds}s)`
    : `subagent pane ${failure.paneId} was not ready within ${seconds}s (limit ${Math.round(failure.timeoutMs / 1000)}s)`;
  const why = failure.reason === 'pane-gone'
    ? 'The child process is gone — its last output below usually carries the reason.'
    : failure.lastStatus === 'working'
      ? 'The pane is alive and working, so the prompt may simply be slow to boot; retrying the same call is safe.'
      : failure.lastStatus === 'blocked'
        ? 'The pane is alive but its agent is blocked on a dialog (trust, auth or a question) — answer it in the pane, then retry the same call.'
        : `The pane is alive but its agent never reported \`idle\` (last status: ${failure.lastStatus ?? 'none'}) — the child pi process may still be starting, or it failed to load the piher extension.`;
  const tail = failure.tail ? `\nlast output of ${failure.paneId}:\n${failure.tail}` : '';
  return `${head}\n${why}${tail}`;
}

/** What one `terminal.send` proved (spec S22). Only `started: true` is delivery: `null` means the
 *  program never reported status and `false` that it stayed out of `working`, and in both the text
 *  sat in the composer without a turn. */
export type TaskSendPlan =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give-up' };

export function planTaskSend(opts: {
  started: boolean | null;
  elapsedMs: number;
  attempt: number;
  timeoutMs: number;
}): TaskSendPlan {
  if (opts.started === true) return { kind: 'delivered' };
  if (opts.elapsedMs >= opts.timeoutMs) return { kind: 'give-up' };
  return { kind: 'retry', delayMs: readyBackoffMs(opts.attempt) };
}

/** The send never became a turn: name what the core answered, so the model can decide (a dead
 *  agent answers nothing, a slow one answers later). */
export function taskNotStartedText(opts: {
  paneId: string;
  attempts: number;
  elapsedMs: number;
  last: { started: boolean | null; status: string | null; turn: number };
}): string {
  const seconds = Math.round(opts.elapsedMs / 1000);
  const started = opts.last.started === null ? 'null (the agent never reported status)' : String(opts.last.started);
  return `subagent pane ${opts.paneId} took no turn from its first message: ${opts.attempts} sends in ${seconds}s, `
    + `last result started ${started}, status ${opts.last.status ?? 'none'}, turn ${opts.last.turn}. `
    + 'The pane is alive and the text went in without starting a turn, so the task is still unsent — retrying the same call is safe.';
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

type ReadyOutcome = { ok: true } | { ok: false; message: string };

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
  /** Wait for the core to say the worker's agent is up and idle (never a ping on a private socket). */
  waitReady(paneId: string): Promise<ReadyOutcome>;
  /** Send the first task through the core, retrying until its own result reports a started turn. */
  deliverFirstTask(paneId: string, text: string): Promise<void>;
  findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null>;
}

export function createSpawner(h: SpawnerHost): Spawner {
  const readyTimeoutMs = h.readinessTimeoutMs ?? runtimePolicy.readinessTimeoutMs;

  async function approveFor(cwd: string, masterCwd: string): Promise<boolean> {
    if (isPathUnder(cwd, masterCwd)) return true;
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await h.git.listWorktrees(masterCwd) });
    return zone.zone === 'worktree';
  }

  /** Wait for the core's readiness with backoff; give up early when the pane is gone. The screen tail
   * is sampled while the pane exists so a crash that leaves a shell still explains itself. */
  async function waitReady(paneId: string): Promise<ReadyOutcome> {
    const startedAt = Date.now();
    let attempt = 0;
    let lastTailAt = 0;
    let alive: boolean | null = null;
    let lastStatus: string | null = null;
    let tail: string | null = null;

    while (true) {
      const now = Date.now();
      const elapsedMs = now - startedAt;
      const probe = await probeChildPane(paneId);
      alive = probe.alive;
      lastStatus = probe.status;
      if (now - lastTailAt >= READY_TAIL_SAMPLE_MS || attempt === 0) {
        lastTailAt = now;
        const sampled = await paneTail(paneId);
        if (sampled) tail = sampled;
      }
      const plan = planReadyAttempt({
        elapsedMs, attempt, timeoutMs: readyTimeoutMs, alive, ready: isReadyStatus(lastStatus),
      });
      if (plan.kind === 'ready') return { ok: true };
      if (plan.kind === 'give-up') {
        const failure: ReadyFailure = {
          paneId,
          reason: plan.reason,
          elapsedMs: Math.max(elapsedMs, 1),
          timeoutMs: readyTimeoutMs,
          lastStatus,
          tail,
        };
        return { ok: false, message: readyFailureText(failure) };
      }
      attempt += 1;
      await sleep(plan.delayMs);
    }
  }

  /** Hand the worker its first task through the core and believe only a started turn (spec S14,
   * S22). A send the core did not report as started left the text unsubmitted, so the same text is
   * sent again once the agent reports `idle` — inside one readiness budget, so a dead agent still
   * fails the spawn instead of looping. */
  async function deliverFirstTask(paneId: string, text: string): Promise<void> {
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
      let result: SendResult;
      try {
        result = await h.client.send(paneId, text);
      } catch (err) {
        throw new Error(`subagent pane ${paneId} refused its first message: ${(err as Error)?.message ?? String(err)}`);
      }
      const plan = planTaskSend({ started: result.started, elapsedMs: Date.now() - startedAt, attempt, timeoutMs: readyTimeoutMs });
      if (plan.kind === 'delivered') return;
      if (plan.kind === 'give-up') {
        throw new Error(taskNotStartedText({ paneId, attempts: attempt + 1, elapsedMs: Date.now() - startedAt, last: result }));
      }
      await sleep(plan.delayMs);
      // Readiness before every retry: the measured failure is a send issued before the agent reports
      // `idle`, and the identical send after it starts the turn. The budget is the caller's clock.
      const ready = await waitReady(paneId);
      if (!ready.ok) throw new Error(ready.message);
      attempt += 1;
    }
  }

  /** The core's facts about the pane: liveness and its own status word. A core failure degrades to
   * "unknown", never "dead". */
  async function probeChildPane(paneId: string): Promise<{ alive: boolean | null; status: string | null }> {
    try {
      const terminal = await h.client.getTerminal(paneId);
      return { alive: terminal != null && terminal.state !== 'finished', status: terminal?.status ?? null };
    } catch {
      /* core unreachable: liveness stays unknown, never "dead" */
      return { alive: null, status: null };
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
      const ours = inSpace.find((t) => t.labels['piher.session']);
      return (ours ?? inSpace[0])?.labels['herdr.tab'] ?? '';
    } catch {
      return '';
    }
  }

  /** D94: reuse a terminal that already runs the same session instead of competing on one transcript.
   *  Workers self-report their session file in the `piher.session` label. */
  async function findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    const wanted = bareSessionId(sessionFile);
    try {
      const terminals = await h.client.listTerminals();
      const match = terminals.find((t) => {
        const reported = t.labels['piher.session'];
        return reported != null && bareSessionId(reported) === wanted;
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
  lastRequestIdByPane: Map<string, number | string>;
  /** Pane id → its in-flight boot (readiness, first task, session resolution). */
  boots: Map<string, Promise<void>>;
  /** A spawn whose pane never came up: the only report a failed start can make off the turn. */
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
  const { spawnPaneInTaskTab, launchParts, waitReady, deliverFirstTask } = h.spawn;
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
      const injectId = `prompt-${taskId}`;
      const boot = (async (): Promise<void> => {
        // S14: the core's own status is the readiness gate — the worker's private pipe is not asked.
        const ready = await waitReady(paneId);
        if (!ready.ok) throw new Error(ready.message);
        // The `piher.session` label lags right after spawn, so the mtime fallback would otherwise adopt
        // the newest PRE-EXISTING session in cwd; only a file written after the terminal existed counts.
        entry.gen.sessionFile = await resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: spawnedAt - 2_000 });
        h.writeRecord(entry);
        // M11: the first task goes through the core's own `send`, reserving the PTY keyboard channel
        // for the human; injection and injectTs must stay together or the spawn leaves a ghost row.
        // S22: only a `started: true` result is delivery, so a send that left the text in the composer
        // is retried instead of believed.
        const injectTs = Date.now();
        await deliverFirstTask(paneId, spec.prompt);
        h.lastRequestIdByPane.set(paneId, injectId);
        void startPoller(paneId, cwd, injectTs, spec.description, injectId);
        h.writeRecord(entry);
      })();
      h.boots.set(paneId, boot);
      void boot.catch(async (err: unknown) => {
        // A worker that never came up leaves nothing behind, and a failed start must not look like a
        // task that is quietly still running: retire the pane, drop the row and its record, say so.
        h.dropTask?.(taskId);
        tasks.delete(taskId);
        panes.delete(paneId);
        discardCheckout();
        try { await client.kill(paneId); } catch { /* already gone */ }
        try { await client.remove(paneId); } catch { /* core reaps finished terminals */ }
        try {
          await h.notifySpawnFailed(
            `Subagent "${spec.description}" (pane ${paneId}, task ${taskId}) failed to start: ${(err as Error)?.message ?? String(err)} Nothing is running there; spawn it again if the task still matters.`,
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
