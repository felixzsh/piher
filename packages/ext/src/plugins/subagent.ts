/**
 * subagent — master-only plugin entry: tool registration, action dispatch, the resume / send / interrupt /
 * output / list actions, and port binding. Inbound deps arrive via `piher.subagent-deps`; the outbound
 * board `port.current` binds atomically.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cordisGet } from '../cordis-services.ts';
import { CORE_REQUIRED, type CoreClientLike, type CoreEnv } from '../core-client.ts';
import {
  Semaphore,
  SUBAGENT_OUTPUT_SCHEMA,
  attachSubagentStructuredContent,
  buildAliveNotice,
  buildLaunchLine,
  entryScript,
  formatRoleCatalog,
  idParam,
  flattenToolParams,
  isAlive,
  newestPerTaskId,
  resolveTaskIdPrefix,
  taskIdResolutionError,
  tabNameForTask,
  withAdmission,
  type AliveProbe,
  type SubagentPort,
  type SubagentPortBox,
} from '../subagent-core.ts';
import {
  describeTaskState,
  isActionable,
  isClosed,
  isSpent,
  taskForPane,
  taskRef,
  type ResolvedTaskEntry,
  type TaskEntry,
  type TaskObservation,
  type TaskRow,
} from '../task-row.ts';
import {
  deleteTaskRecord,
  listTaskRecords,
  readTaskRecord,
  repoTasksDir,
  writeTaskRecord,
  writeTaskView,
} from '../task-store.ts';
import { platformPaths } from '../platform-paths.ts';
import { listRoleNames, loadRoleConfig } from '../role-loader.ts';
import type { RuntimePolicy } from '../runtime-policy.ts';
import { runtimePolicy } from '../runtime-policy.ts';
import type { Lifecycle } from '../role-manifest.ts';
import { toolError, ToolError } from '../tool-error.ts';
import { readTaskPrompt } from '../prompt-store.ts';
import type { PaneStateSlot } from './bg-job.ts';
import { bareSessionId } from '../session-tail.ts';
import { mainWorktreeRoot } from '../storage-layout.ts';
import type { SettlementCard } from '../settlement-card.ts';
import { DELEGATION_ENV, type DelegationContext } from '../delegation-core.ts';
import { createGitIo, createSpawnAction, createSpawner } from '../subagent-spawn.ts';
import { createCheckoutIo, createCheckoutSpace } from '../worktree-io.ts';
import {
  missingCheckoutText,
  closeCheckoutSpace,
  releaseCheckout,
  releasedCheckoutLine,
  checkoutSpaceId,
  type CheckoutIo,
  type CheckoutSpace,
} from '../worktree.ts';
import { createPoller } from '../subagent-poller.ts';
import { awaitCommandPickup, commandDocumentOverflow, steerCommand, writeCommandDocument, type CommandPickup } from '../command-documents.ts';
import { MAX_DOCUMENT_BYTES, commandDocName, readReportDocument, type ReportDocumentRead } from '../report-documents.ts';
import { createGcController, restoreTasks, retirePane, seedForkView } from '../subagent-gc.ts';
import { createSessionIo, executeSubagentOutput, type SessionReport, type SubagentOutputCursor } from '../subagent-session.ts';
import type { WorkerWidgetRow } from '../tree-view.ts';

type ToolParams = Record<string, unknown> | undefined;

export interface SubagentDeps {
  client: CoreClientLike;
  env: CoreEnv | null;
  /** Extension entry (index.ts) path — launchLine `-e`. */
  extPath: string;
  /** Master tree root (scope mount). */
  sessionRoot: Context;
  port: SubagentPortBox;
  getSessionId: () => string;
  /** This session's transcript path, for piher's per-session state root; null when it has none. */
  getSessionFile?: () => string | null;
  /** Repository the restore reads task records from; the session's own checkout (default: cwd). */
  getCwd?: () => string;
  /** Test seam: tasks the session starts out holding, as a restore would have seeded them. */
  initialTasks?: TaskEntry[];
  /** Settlement notice injector from index: buffer while busy, flush at turn_end. */
  deliverNotice?: (content: string, paneId?: string, card?: SettlementCard | null) => Promise<void>;
  /** Panes whose settlement notice is still buffered (GC exemption). */
  noticePending?: () => ReadonlySet<string>;
  /** Pane-owning plugins (background jobs) are exempt from subagent panes collection. */
  terminalState: PaneStateSlot;
  /** Test seam for the budgets the loop reads, so a suite never waits out a production default. */
  policy?: Partial<RuntimePolicy>;
  /** Test seam for the checkout piher may create and the app space that shows it (S71). */
  checkoutIo?: CheckoutIo;
  checkoutSpace?: CheckoutSpace;
}

/** Sent with every request: what a call needs. Details live in SUBAGENT_MANUAL (`action: "help"`). */
const SUBAGENT_DESCRIPTION = [
  'Delegate a self-contained task to a subagent: a separate pi session in its own herdr pane (its own context — it does NOT see this conversation; a human can talk to it there).',
  'Actions (default spawn): spawn | send | retry | output | list | interrupt | resume | close | help.',
  'spawn: `prompt` is the COMPLETE task, since only it reaches the worker; `description` labels the pane. Several spawns per message run in parallel (max 4).',
  'spawn places the worker by `cwd` or by `worktree` (a name: piher creates the checkout and branch).',
  'spawn returns at once; the result arrives as a settlement notice at your next turn boundary — never sleep or poll.',
  'retry: re-sends the spawned prompt after a fault outside the task. send: follow-up steered between tool calls; a task with no pane revives first. output: report once finished, lines while it runs — normally unneeded. resume: revive an unfinished task by taskId. list: yours plus another session\'s live ones, marked.',
  'help: the full manual (placement, role profiles, the two documents).',
].join(' ');

/** Returned by `action: "help"`: the reference text kept out of the per-request description. */
const SUBAGENT_MANUAL = [
  'subagent manual — `help` returns this text: what a call needs beyond the always-sent description.',
  '',
  'spawn — an independent worker on this workspace; its result arrives as a settlement notice, so return at once and never wait in-turn. `prompt` is the whole task (the worker does not see this conversation): paths, acceptance criteria, what to report. Every spawn mints a `taskId` for later actions. `description` labels the pane. No pane by default; `tab` joins or creates a task tab. `cwd` runs in a checkout you have, `worktree` names one piher creates (branch of the same name); they are mutually exclusive.',
  '',
  'role + allowed_tools — the profile list below (name, description, tools, lifecycle); profiles come from workspace `.piher/roles/`, then the user directory, then builtin. `allowed_tools` adds on top; role denies always win. Unknown names stay display labels; a profile is fixed for life.',
  '',
  'durability — one task record per task at `<repo>/.piher/tasks/<taskId>.json` plus this session\'s view (`<sessionDir>/piher/<sessionId>/tasks.json`). Liveness is observed, never stored; spawn, settle, close write the record.',
  '',
  'list — every actionable task, one line per row: `<slug>@<paneId> [<state>] (<kind> · <lifecycle>) <description>`. States: `running` (turn in flight), `idle` (report consumed), `no report`, `no pane` (gone pane). Another session\'s live task shows marked `[otra sesión]`; its gone pane never shows. Closed and spent rows never print.',
  '',
  'output — `agentId`; the state plus the finalized report or, while it runs, the latest lines (`max_chars`, 100-16000; whole pane only with `full: true`). Normally unneeded: the settlement notice carries the words.',
  '',
  'send — `agentId` + `message`: steered into a working worker at its next tool gap. A task whose pane is gone revives a new generation first, then takes the text. A closed or spent task is refused. `Message sent` means the worker applied it; anything less says what is known.',
  '',
  'close — `agentId`; reclaims a finished worker: pane and tab go, and the record keeps the decision — close is final for every session, so later calls are refused and a new subagent is the only next step. A turn in flight is refused — interrupt first. One-shots reclaim automatically; a `worktree` checkout goes too (never forced; dirty refused, branch survives). Another session\'s live task closes the same way, no adoption step.',
  '',
  'retry — `agentId` or `taskId`, no message: re-sends the prompt stored at spawn, after a fault outside the task. A closed task or spent one-shot starts a new task with the same brief, role and checkout; no stored prompt names `send`.',
  '',
  'resume — `taskId`; revives an unfinished task in a new generation, reusing a live pane for the same session when one exists, never the master\'s own. A turn in flight is not resumed — use send or output. Closed tasks are refused, as is another session\'s (only its own resumes it). A missing transcript names its path, with `retry` as the way out.',
].join('\n');

const SUBAGENT_CONCURRENCY = 4;

/** Role-declared lifetime (roles.md S9): only `one-shot` changes behaviour, and a role that cannot be
 *  resolved is a persistent worker — a renamed or deleted role file never reclaims a pane by surprise. */
function roleLifecycle(roleName: string): Lifecycle {
  if (roleName === 'task') return 'persistent';
  try {
    return loadRoleConfig(roleName, { baseDir: process.cwd() }).lifecycle === 'one-shot' ? 'one-shot' : 'persistent';
  } catch {
    return 'persistent';
  }
}

function defaultAgentSessionsDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR || platformPaths.agentDataDir;
  return join(base, 'sessions');
}

/** The outcomes a `send` reports in its result: `unread` is a refusal, never a message. */
type ReportedPickup = Exclude<CommandPickup, { kind: 'unread' }>;

/**
 * What a `send` says it achieved (spec S15). `Message sent to subagent <ref>.` is the contract's
 * wording for a delivered steer, so it is used only when the worker cleared the document one version
 * after the write; every other outcome says what is actually known. Nothing here claims a steer was
 * *not* applied — no read of the document can establish that (spec S7 forbids delivering the same
 * steer twice, so an unprovable claim must not invite a resend). `unread` never gets here: it is a
 * refusal (`unreadCommandText`).
 */
function steerResultText(ref: string, paneId: string, commandId: string, pickup: ReportedPickup): string {
  if (pickup.kind === 'applied') return `Message sent to subagent ${ref}.`;
  const document = `piher.cmd.${paneId}`;
  if (pickup.kind === 'unsettled') {
    // The worker's own log records the same event: it applied the command and its clear lost to a
    // newer write. The document cannot separate that from our write being overwritten unread.
    return `Message written for subagent ${ref} as command ${commandId} in ${document}, but another `
      + 'write took the document before its fate was known: whether the worker applied it cannot be '
      + 'told — it may have been applied and left behind when a newer command arrived. Check with '
      + 'action "output" before resending.';
  }
  return `Message written for subagent ${ref} as command ${commandId} in ${document}, but delivery is unconfirmed: ${pickup.reason}. Check with action "output" before resending.`;
}

/**
 * The non-refusal reading of an unread command, for the operator who set the pickup budget to 0
 * (`PIHER_COMMAND_PICKUP_MS`): the send reported the write alone, exactly as the knob documents.
 */
function writtenOnlyText(ref: string, paneId: string, commandId: string): string {
  return `Message written for subagent ${ref} as command ${commandId} in piher.cmd.${paneId}: the core `
    + 'holds it (PIHER_COMMAND_PICKUP_MS=0 does not wait for the worker to read it). Check with action '
    + '"output" before resending.';
}

/**
 * The refusal for a command nothing confirmed reading (spec S16 keeps the diagnosis this replaces):
 * a live pane whose extension host is not watching. Three things leave this trace and none of them
 * can be told apart from the document: the host is not running; it read the command and its clear
 * lost; or its document watch is reconnecting and will read it within seconds (a core restart). The
 * write landed, so nothing is lost — but nothing is confirmed delivered either, and a master that
 * called that delivered would wait for a turn that may never start.
 */
function unreadCommandText(paneId: string, taskId: string, command: string, budgetMs: number): string {
  return `Error: subagent pane ${paneId} is alive but its message channel is dead (${command} was not `
    + `confirmed read within ${budgetMs} ms): the worker's extension host is not running there; or it `
    + 'read the command and could not clear it; or its document watch is reconnecting after a core '
    + 'restart and will read it within seconds. NOTHING is confirmed delivered and the command stays '
    + 'in the core, so a worker that comes back applies it — check action "output" before resending, '
    + 'or raise PIHER_COMMAND_PICKUP_MS if the core is just slow. '
    + `action "resume" with taskId ${taskId} restarts it in a new pane; action "close" retires the row.`;
}

/** The `resume` refusal, in the words the tool contract fixes (docs/spec/contracts.md): it names the
 *  three places the session could still be and says only what each read established. A clause is
 *  never asserted on a read that did not happen — a label read that the core never answered, or a
 *  document that was never written, say so in their own words, and "no session to resume" is only
 *  claimed when the core actually answered. */
function noSessionText(input: {
  taskId: string;
  paneId: string;
  address: ReportDocumentRead;
  /** Null when the address was not read at all: it holds another task's report document. */
  report: SessionReport | null;
  foreignAddress: boolean;
}): string {
  const tail = 'reviving it would start a fresh conversation. Use action "spawn" for new work, or '
    + '"retry" to start a new task from the same brief.';
  if (input.report?.kind === 'unavailable' || input.address.kind === 'unavailable') {
    return `Error: task ${input.taskId} cannot be checked for a session right now: the core did not `
      + `answer for its terminal ${input.paneId || '(none)'} or its settlement document, so no session `
      + 'could be read. Try action "resume" again once the core answers.';
  }
  // The address holds another task's report: this task's session was never established there, so
  // this is not the "no session anywhere" refusal — it is "this address is not yours".
  if (input.foreignAddress) {
    return `Error: task ${input.taskId} cannot be resumed at its address ${input.paneId}: that address `
      + "now holds another task's settlement document, so the terminal there and its `hresume` label are "
      + "that worker's conversation, not this task's, and its record carries no session either — reviving "
      + `it would start a fresh conversation. Use action "spawn" for new work, or "retry" to start a new `
      + 'task from the same brief.';
  }
  const terminal = input.paneId === ''
    ? 'it has no terminal left'
    : input.report?.kind === 'gone'
      ? 'its core terminal is gone'
      : input.report?.kind === 'not-ours'
        ? `its core terminal ${input.paneId} is not its own (${input.report.why})`
        : 'its core terminal reports no session';
  const document = input.address.kind === 'read'
    ? 'its settlement document reported no session'
    : 'it has no settlement document';
  return `Error: task ${input.taskId} has no session to resume: ${terminal}, ${document}, and its `
    + `record carries none — ${tail}`;
}

export default function subagentPlugin(ctx: Context): void {
  const surface = cordisGet(ctx, 'piher.surface');
  const d = cordisGet(ctx, 'piher.subagent-deps');
  const { client, env, sessionRoot, port, terminalState } = d;
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
    /** Fire-and-forget in pi: the method returns void, not a promise. */
    sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
  };
  const scoped = surface.forModule(import.meta.url);

  /** Every launchable profile, read at call time: workspace roles change without restarting pi. */
  function roleCatalog(cwd: string): string {
    const profiles = listRoleNames(cwd, undefined).map((name) => {
      try {
        const role = loadRoleConfig(name, { baseDir: cwd });
        return {
          name,
          description: role.description ?? null,
          tools: role.manifest.tools,
          lifecycle: role.lifecycle === 'one-shot' ? ('one-shot' as const) : ('persistent' as const),
        };
      } catch (err) {
        return { name, invalid: (err as Error).message.split('\n')[0] ?? 'invalid manifest' };
      }
    });
    return formatRoleCatalog(profiles);
  }

  const runtime = { nodePath: process.execPath, cliPath: entryScript(process.argv[1], existsSync), extPath: d.extPath };
  const subSemaphore = new Semaphore(SUBAGENT_CONCURRENCY);
  /* Tasks this session owns, keyed by taskId: a task outlives its pane (S1). */
  const tasks = new Map<string, TaskEntry>();
  /* Pane→task index: the pane id is part of the generation, so calls arriving by pane id
   * resolve through the task. A revive re-keys it; the task map is never re-keyed. */
  const panes = new Map<string, string>();
  /* In-memory session view: the task ids this session delegated, in order (S4). Spawn appends;
   * without a transcript path it stays in memory only (S25). */
  const viewIds: string[] = [];
  /* Observation cache: the last liveness core reported per task. It feeds only the state text
   *  surfaces print; an action never reads it to decide (S26). */
  const observations = new Map<string, TaskObservation>();

  /** Record one probe result for the state text. Stale entries mislabel, never authorize (S26). */
  function noteObservation(taskId: string, probe: AliveProbe): void {
    observations.set(taskId, {
      paneExists: probe.paneExists,
      agentStatus: probe.agentStatus,
      lastActivityMs: probe.lastActivityMs,
      at: Date.now(),
    });
  }
  const outputCursors = new Map<string, SubagentOutputCursor>();
  /** Read counters shown in `subagent output` headers (one monotonic number per worker). */
  const outputRevisions = new Map<string, number>();
  /** Pane id → its in-flight boot (readiness, first task); a follow-up waits for it. */
  const boots = new Map<string, Promise<void>>();

  /** Write one task record: the task, its current generation and its decision. */
  function writeRecord(entry: TaskEntry): void {
    writeTaskRecord(entry.cwd, entry);
  }

  /** Write the close decision onto the freshest record: the rename is atomic against a torn
   *  file, not against a lost field, so a concurrent report delivery from the owning session
   *  is merged in, never dropped by flushing a snapshot read earlier in the call. */
  function writeCloseRecord(cwd: string, entry: TaskEntry): void {
    const at = Date.now();
    entry.closedAt = at;
    const fresh = readTaskRecord(cwd, entry.taskId);
    if (!fresh) {
      writeTaskRecord(cwd, entry);
      return;
    }
    fresh.closedAt = at;
    writeTaskRecord(cwd, fresh);
    // Keep memory truthful: the record may carry a delivery this session had not seen.
    if (fresh.gen.consumedAt !== null) entry.gen.consumedAt = fresh.gen.consumedAt;
    if (fresh.gen.reportDelivered !== null) entry.gen.reportDelivered = fresh.gen.reportDelivered;
  }

  /** The disk is the authority (S24): adopt durable decisions another session may have written
   *  since this row was read. Facts only move toward final — closedAt, consumedAt and the
   *  delivered fingerprint are set, never cleared — so a refresh can never revive a task. */
  function refreshFromRecord(entry: TaskEntry): void {
    const row = readTaskRecord(entry.cwd, entry.taskId);
    if (!row) return;
    if (row.closedAt !== null) entry.closedAt = row.closedAt;
    if (row.gen.consumedAt !== null) entry.gen.consumedAt = row.gen.consumedAt;
    if (row.gen.reportDelivered !== null) entry.gen.reportDelivered = row.gen.reportDelivered;
  }

  /** A spawn appends its id to the view; every other operation touches one record. */
  function appendView(taskId: string): void {
    if (!viewIds.includes(taskId)) viewIds.push(taskId);
    writeTaskView(d.getSessionFile?.() ?? null, viewIds);
  }

  /** A spawn that never started leaves no record and no view id behind. */
  function dropTask(taskId: string): void {
    const entry = tasks.get(taskId);
    if (entry) deleteTaskRecord(entry.cwd, taskId);
    observations.delete(taskId);
    const at = viewIds.indexOf(taskId);
    if (at >= 0) {
      viewIds.splice(at, 1);
      writeTaskView(d.getSessionFile?.() ?? null, viewIds);
    }
  }

  const board = {
    client,
    tasks,
    panes,
    restoreCwd: () => d.getCwd?.() ?? process.cwd(),
    sessionFile: () => d.getSessionFile?.() ?? null,
    viewIds,
  };

  // Test seam: the session starts out holding these tasks, the way a restore would have seeded them.
  for (const seed of d.initialTasks ?? []) {
    tasks.set(seed.taskId, seed);
    if (seed.gen.paneId) panes.set(seed.gen.paneId, seed.taskId);
    if (!viewIds.includes(seed.taskId)) viewIds.push(seed.taskId);
  }
  const git = createGitIo();
  const checkout = d.checkoutIo ?? createCheckoutIo();
  const checkoutSpace = d.checkoutSpace ?? createCheckoutSpace();

  /** True while another row of this session still works in the checkout at `path`. The app space is
   *  the checkout's, not the worker's: a reviewer and the worker it reads share one, and closing it
   *  under the survivor takes its tab away while the worker keeps running in it. */
  function checkoutInUseByAnother(entry: TaskEntry, path: string): boolean {
    for (const other of tasks.values()) {
      if (other === entry || isClosed(other)) continue;
      if (other.worktree?.path === path) return true;
    }
    return false;
  }

  /** S54/S71: a role-declared one-shot reclaims its pane and the checkout its spawn created. */
  function reclaim(entry: TaskEntry): void {
    void (async () => {
      if (entry.worktree) {
        // A one-shot closes its window, never its checkout: the master decides whether to merge, and
        // the working tree is what it reviews. Removing it here would leave only the branch behind.
        const record = entry.worktree;
        // A checkout can host more than one worker (a reviewer reading its worker's tree), so the
        // space goes only with the last row that works in it — never under a live sibling.
        if (!checkoutInUseByAnother(entry, record.path)) {
          await closeCheckoutSpace(checkoutSpace, record).catch(() => null);
        }
        writeRecord(entry);
      }
      await retirePane(client, entry.gen.paneId);
    })();
  }

  const boundPort: SubagentPort = {
    listRunningSubs() {
      // The widget shows the tasks still awaiting a report. The state text comes from the last
      // observation, defaulting to the zero-observation base a fresh spawn shares (S26).
      return [...tasks.values()]
        .filter((s) => isActionable(s) && s.gen.consumedAt === null)
        .map((s): WorkerWidgetRow => ({
          paneId: s.gen.paneId,
          slug: s.gen.slug,
          role: s.kind,
          state: describeTaskState(s, observations.get(s.taskId)),
          startedAt: s.createdAt,
          description: s.description,
        }));
    },
  };
  port.current = boundPort;
  ctx.effect(() => () => {
    if (port.current === boundPort) port.current = null;
  }, 'subagent-port');

  const injectNotice = (content: string, paneId?: string, card?: SettlementCard | null): Promise<void> => {
    if (d.deliverNotice) return d.deliverNotice(content, paneId, card);
    pi.sendUserMessage?.(content, { deliverAs: 'followUp' });
    return Promise.resolve();
  };

  const session = createSessionIo({
    client,
    getSessionId: d.getSessionId,
    sessionsDir: defaultAgentSessionsDir,
    getTerminalId: () => env?.terminalId ?? null,
  });
  const spawn = createSpawner({ client, env, runtime, git, readinessTimeoutMs: d.policy?.readinessTimeoutMs });
  const poller = createPoller({
    client,
    sessionRoot,
    tasks,
    panes,
    writeRecord,
    noteObservation: (paneId, obs) => {
      const taskId = panes.get(paneId);
      if (taskId) noteObservation(taskId, obs);
    },
    session,
    injectNotice,
    reclaim,
    policy: d.policy,
  });
  const { startPoller, pollers } = poller;
  const gc = createGcController({
    client,
    env,
    tasks,
    noteObservation,
    terminalState,
    noticePending: d.noticePending,
    checkoutSpace,
    deliverNotice: d.deliverNotice,
  });
  gc.startTicker(ctx);
  scoped.on('turn_start', () => gc.onTurnStart());
  const { probeAlive } = session;
  const { spawnPaneInTaskTab, launchParts, approveFor, waitReady, findExistingPane } = spawn;
  /** How long a `send` waits for the worker to read the command it wrote (spec S15). */
  const commandPickupMs = d.policy?.commandPickupMs ?? runtimePolicy.commandPickupMs;

  /** Re-arm settlement watches after a restart: only rows still awaiting a report whose pane core
   *  still lists. A delivered report needs no watch; a closed task is final; a gone pane is
   *  `resume` work, not a re-arm. The liveness lookup decides — never a stored status. */
  async function recoverRunningPollers(via: string): Promise<void> {
    if (!client.available) return;
    const running = [...tasks.values()].filter((s) =>
      isActionable(s) && s.gen.consumedAt === null && !pollers.has(s.gen.paneId));
    if (running.length === 0) return;
    let liveTerminalIds: ReadonlySet<string>;
    try {
      liveTerminalIds = new Set((await client.listTerminals()).map((terminal) => terminal.id));
    } catch {
      return; // liveness lookup failed → do not guess
    }
    const recovered: string[] = [];
    for (const entry of running) {
      // A gone pane is resume work, not a re-arm.
      if (!liveTerminalIds.has(entry.gen.paneId)) continue;
      // Only a watch that actually armed is announced: `startPoller` answers that fact, not the intent.
      if (await startPoller(entry.gen.paneId, entry.cwd, entry.gen.startedAt, entry.description)) {
        recovered.push(`${entry.gen.paneId} (${entry.description})`);
      }
    }
    if (recovered.length > 0) {
      try {
        await injectNotice(
          `Session recovery (${via}): ${recovered.length} background subagent(s) still running — settlement watch re-armed for: ${recovered.join('; ')}.`,
        );
      } catch { /* non-fatal */ }
    }
  }

  scoped.on('session_start', async (event: unknown, eventCtx: unknown) => {
    // The reason is core's own word for it (`startup`, `reload`, `new`, `resume`, `fork`): a fork is
    // the only one that lands on a session file with no state of its own, so it inherits the parent's
    // view document before the restore reads it.
    const reason = (event as { reason?: string } | undefined)?.reason;
    const previous = (event as { previousSessionFile?: string } | undefined)?.previousSessionFile;
    if (reason === 'fork' || reason === 'resume') seedForkView(d.getSessionFile?.() ?? null, previous ?? null);
    // Records live in the session's own repository: its checkout from the event context, else the
    // configured override, else the process checkout.
    const ctxCwd = (eventCtx as { cwd?: string } | undefined)?.cwd;
    restoreTasks(board, typeof ctxCwd === 'string' ? ctxCwd : undefined);
    await recoverRunningPollers('session_start');
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    const ctxCwd = (eventCtx as { cwd?: string } | undefined)?.cwd;
    restoreTasks(board, typeof ctxCwd === 'string' ? ctxCwd : undefined);
    await recoverRunningPollers('session_tree');
  });

  /** A failing subagent call must not read as a dead worker: probe liveness first, so the model
   * stops seizing work from a healthy subagent. */
  scoped.on('tool_result', async (rawEvent: unknown) => {
    const event = (rawEvent ?? {}) as { toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
    if (event.toolName !== 'subagent' || !event.isError) return;
    // Extract only ids of rows we know; leave unrelated errors untouched.
    const errText = (event.content ?? []).map((c) => c.text ?? '').join(' ');
    const paneId = [...panes.keys()].find((id) => errText.includes(id));
    if (!paneId) return;
    const entry = taskForPane(tasks, panes, paneId);
    if (!entry || isClosed(entry) || isSpent(entry)) return;
    const probe = await probeAlive(paneId, entry.cwd);
    if (!isAlive(probe, Date.now())) return; // keep the original error only when the agent is truly dead
    // Move a live agent to the poller so its eventual result replaces the false error.
    if (!pollers.has(paneId)) {
      startPoller(paneId, entry.cwd, entry.gen.startedAt, entry.description);
      writeRecord(entry);
    }
    return {
      content: [{ type: 'text', text: buildAliveNotice({ paneId, description: entry.description, probe }, Date.now()) }],
    };
  });

  async function reviveEntry(entry: TaskEntry): Promise<TaskEntry> {
    // A revive only continues a resident row: a transient record copy from another session must
    // never grow a generation here — that write belongs to its own session (S7).
    if (tasks.get(entry.taskId) !== entry) {
      throw new ToolError(
        `Error: task ${entry.taskId} belongs to another session; only its own session can revive `
        + 'it — close it with action "close" if its work is over.',
      );
    }
    const latest: TaskRow = readTaskRecord(entry.cwd, entry.taskId) ?? entry;
    // S9: close is final for every session, and the disk is the authority. A closed (or spent)
    // task never grows a new generation — otherwise a live pane would sit behind a record that
    // still says closed, and the revive would carry the stale `closedAt` into the new record.
    const verdict = spentText(latest);
    if (verdict !== null) throw new ToolError(verdict);
    // S71: resume decides by existence, never by a flag — the same refusal whether `close`, a
    // one-shot settlement or a human removed the checkout.
    if (!existsSync(entry.cwd)) {
      throw new ToolError(missingCheckoutText({
        taskId: entry.taskId,
        cwd: entry.cwd,
        worktree: latest.worktree ?? entry.worktree ?? null,
      }));
    }
    // Never relaunch the master's own transcript in a worker pane (two pi processes competing on
    // one jsonl): a mis-attributed record degrades to a fresh conversation instead.
    const resumeFile = latest.gen.sessionFile && /\.jsonl$/.test(latest.gen.sessionFile)
      && bareSessionId(latest.gen.sessionFile) !== bareSessionId(d.getSessionId())
      ? latest.gen.sessionFile : null;
    // D86 trust matches spawn; revive has no tool context, so use the process cwd.
    const approve = await approveFor(entry.cwd, process.cwd());
    const argv = launchParts(resumeFile, null, null, approve);
    const lifecycle = roleLifecycle(entry.kind);
    // Admission, not readiness: the slot is held only while the pane is created, so a revive still
    // waiting for its agent to report ready cannot starve a spawn (S50). The wait below runs outside
    // the slot.
    const spawned = await withAdmission(subSemaphore, () => spawnPaneInTaskTab(
      {
        desiredTab: entry.gen.tabName || latest.gen.tabName || null,
        description: entry.description,
        // A revive keeps the visibility the worker was given: only one that had a tab gets a pane.
        visible: entry.gen.tabId !== '',
        // A revived worker goes back to the window its checkout owns. Without this a spawn carries
        // no `herdr.space` at all, and the app adopts the pane into whatever space is focused — the
        // worker reappears in a different workspace than the one its checkout lives in.
        zone: entry.worktree ? { zone: 'worktree', tabName: basename(entry.worktree.path) } : undefined,
        spaceId: entry.worktree ? checkoutSpaceId(entry.worktree.path) : null,
      },
      entry.cwd,
      {
        PIHER_SUBAGENT: '1',
        [DELEGATION_ENV]: JSON.stringify({
          parentPaneId: env?.terminalId ?? '',
          parentSessionId: bareSessionId(d.getSessionId()),
          taskId: entry.taskId,
          description: entry.description,
          role: entry.kind === 'task' ? 'worker-default' : entry.kind,
          lifecycle,
        } satisfies DelegationContext),
      },
      argv,
    ));
    // A revive that cannot come up has no row to give its pane: the generation swap below never runs,
    // so this terminal would exist with no record and no reaper. Ask waitReady for the retired wording
    // and retire it here — the row keeps pointing at the generation it had.
    const ready = await waitReady(spawned.paneId, undefined, { keepPane: false });
    if (!ready.ok) {
      try { await client.kill(spawned.paneId); } catch { /* already gone */ }
      try { await client.remove(spawned.paneId); } catch { /* core reaps finished terminals */ }
      throw new Error(`${ready.message} Task ${entry.taskId} still points at pane ${entry.gen.paneId}.`);
    }
    const previousPaneId = entry.gen.paneId;
    Object.assign(entry.gen, {
      paneId: spawned.paneId,
      tabId: spawned.tabId,
      tabName: spawned.tabName,
      sessionFile: resumeFile,
      consumedAt: null,
      launchCommand: [buildLaunchLine(argv)],
      startedAt: Date.now(),
    });
    // S3: only the generation is replaced — `createdAt` is the task's durable fact, and the new
    // generation's start rides `gen.startedAt` above.
    // A revived row is reclaimed at settlement too when its role still declares one-shot (S54).
    entry.lifecycle = lifecycle;
    // A task outlives its pane: the pane index moves to the new generation, and the dead id must
    // go, or a later zombie sweep closes the live row.
    if (previousPaneId !== entry.gen.paneId) panes.delete(previousPaneId);
    panes.set(entry.gen.paneId, entry.taskId);
    writeRecord(entry);
    return entry;
  }

  /** A row that lives only as a record, never adopted: actions read it, never join it to the
   *  tasks, the panes or the view (S4). */
  function transientFromRecord(row: TaskRow): TaskEntry {
    const worktree = row.worktree ? { worktree: { ...row.worktree } } : {};
    return { ...row, gen: { ...row.gen }, ...worktree };
  }

  /** Ownership refusal: the row belongs to another session, so this one may only close it (S24).
   *  Close and interrupt never reach here; send, retry and resume do. */
  function foreignRefusal(taskId: string, action: string): string {
    return `Error: task ${taskId} belongs to another session (list marks it [otra sesión]); `
      + `action "${action}" only runs where the task lives. Close it with action "close" `
      + 'if its work is over — close is final for every session.';
  }

  /** Resolve every id `list` prints (S17): this session's rows first, then the repository records
   *  in the same form order — pane id, `slug@paneId`, bare slug, taskId prefix. A record match
   *  belongs to another session: resolved for action, never adopted into the view (S4). */
  function resolveSubEntry(rawId: string, cwd?: string): ResolvedTaskEntry {
    if (!rawId) return { error: 'Error: unknown subagent id "" (see action list)' };
    const direct = taskForPane(tasks, panes, rawId);
    if (direct) return { entry: direct, foreign: false };
    // Slug reference: exact match against live rows (paneId stays first for back-compat).
    // `slug@paneId` accepts both parts; a revived task changed its paneId, so the slug part wins then.
    const at = rawId.indexOf('@');
    const slugPart = at > 0 ? rawId.slice(0, at) : rawId;
    const panePart = at > 0 ? rawId.slice(at + 1) : null;
    const combined = panePart !== null
      ? (taskForPane(tasks, panes, panePart)
        ?? [...tasks.values()].find((s) => s.gen.slug === slugPart && s.gen.paneId === panePart) ?? null)
      : null;
    if (combined) return { entry: combined, foreign: false };
    const bySlug = [...tasks.values()].find((s) => s.gen.slug === slugPart);
    if (bySlug) return { entry: bySlug, foreign: false };

    // Beyond the view: another session's record, same form order. Exact pane and slug ids match
    // at any length; only prefixes keep the four-character rule.
    const records = listTaskRecords(cwd ?? d.getCwd?.() ?? process.cwd());
    const recordByPane = new Map<string, TaskRow>();
    for (const row of records) {
      if (!row.gen.paneId || recordByPane.has(row.gen.paneId)) continue;
      recordByPane.set(row.gen.paneId, row);
    }
    const foreignPane = recordByPane.get(rawId);
    if (foreignPane) return { entry: transientFromRecord(foreignPane), foreign: true };
    const foreignCombined = panePart !== null
      ? (recordByPane.get(panePart)
        ?? records.find((r) => r.gen.slug === slugPart && r.gen.paneId === panePart) ?? null)
      : null;
    if (foreignCombined) return { entry: transientFromRecord(foreignCombined), foreign: true };
    const foreignSlug = records.find((r) => r.gen.slug === slugPart);
    if (foreignSlug) return { entry: transientFromRecord(foreignSlug), foreign: true };

    const byTaskId = newestPerTaskId(tasks.values());
    const res = resolveTaskIdPrefix(rawId, byTaskId.keys());
    if (res.kind === 'resolved') return { entry: byTaskId.get(res.taskId)!, foreign: false };
    const resError = taskIdResolutionError(res, 'subagent id', rawId);
    if (resError) return { error: resError };

    const recordRes = resolveTaskIdPrefix(rawId, records.map((r) => r.taskId));
    if (recordRes.kind === 'resolved') {
      const row = records.find((r) => r.taskId === recordRes.taskId)!;
      return { entry: transientFromRecord(row), foreign: true };
    }
    const recordError = taskIdResolutionError(recordRes, 'subagent id', rawId);
    if (recordError) return { error: recordError };
    return { error: `Error: unknown subagent id "${rawId}" (see action list)` };
  }

  /**
   * `close` is the master's final word on a worker and a one-shot spends itself when its result is
   * consumed: neither may be revived. Resume exists for work that was left unfinished.
   */
  /** Refusal verdict from the durable facts alone (S12): a synthesized memory status never
   *  authorizes it, so a closed record answers final whatever the caller resolved. */
  function spentText(row: TaskRow): string | null {
    if (isClosed(row)) {
      return `Error: task ${row.taskId} was closed by the master; close is final, so there is nothing to resume or send to. Start a new subagent for further work.`;
    }
    if (isSpent(row)) {
      return `Error: task ${row.taskId} was a one-shot and already delivered its verdict; there is nothing to resume. Spawn a new one-shot for new work.`;
    }
    return null;
  }

  function targetOf(
    params: ToolParams,
    toolCtx: unknown,
  ): { entry: TaskEntry; cwd: string; foreign: boolean } {
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const resolved = resolveSubEntry(idParam(params, 'agentId', 'taskId'), cwd);
    if ('error' in resolved) toolError(resolved.error);
    // Freshness at the single shared spine: no decision below may read a stale memory copy.
    // Transient rows are already fresh — they were read from the record in this same call.
    if (!resolved.foreign) refreshFromRecord(resolved.entry);
    return { entry: resolved.entry, cwd, foreign: resolved.foreign };
  }

  /**
   * Bring back a worker whose pane is gone but whose task was never closed. Housekeeping reclaims
   * panes and tabs (`gc`), so a persistent worker with a consumed report usually has no pane left; `send` used to
   * read that as `closed` and revive, which collapsed "not live" and "closed by the master" into one
   * state. They are different: a closed task is final, a vanished pane is unfinished work.
   */
  /** Returns whether a pane was actually made: only a fresh pane is still booting. */
  /** Bring back a worker whose pane is gone but whose task is still actionable. The probe decides;
   *  a closed or spent task never reaches here (`send` refuses it first, `reviveEntry` guards). */
  async function ensureLive(entry: TaskEntry): Promise<boolean> {
    let alive = false;
    try {
      alive = (await probeAlive(entry.gen.paneId, entry.cwd)).paneExists;
    } catch {
      alive = true; // a probe that fails must not spawn a second pane over a live one
    }
    if (alive) return false;
    await reviveEntry(entry);
    return true;
  }

  /** The settlement document at a worker address, as the core holds it (spec S12 keeps it across a
   *  core restart): where a record that lost its session can still find it, and the fact that says
   *  whether the address is still this task's. */
  function readAddressReport(paneId: string): Promise<ReportDocumentRead> {
    return paneId ? readReportDocument(client, paneId) : Promise.resolve({ kind: 'absent' as const });
  }

  async function executeSubagentResume(params: ToolParams, toolCtx: unknown) {
    if (!client.available) return toolError(`subagent: ${CORE_REQUIRED}`);
    const rawTaskId = idParam(params, 'taskId', 'agentId');
    // Refuse a spent task by its record verdict, before any pane is made for it.
    {
      const known = resolveSubEntry(rawTaskId ?? '');
      if ('entry' in known) {
        const spent = spentText(known.entry);
        if (spent !== null) return toolError(spent);
      }
    }
    if (!rawTaskId) return toolError('missing taskId for resume (see action list).');
    // A task with a turn in flight is not resumed — use send or output. The probe decides (S26).
    // A delivered report ends the turn, so consumed rows skip the probe; a live but silent pane
    // with an active settlement watch — or a boot still injecting its first prompt — still counts
    // as in flight, so resume never doubles it.
    {
      const live = resolveTaskIdPrefix(rawTaskId, tasks.keys());
      if (live.kind === 'resolved') {
        const entry = tasks.get(live.taskId)!;
        let running = false;
        if (entry.gen.consumedAt === null) {
          try {
            const probe = await probeAlive(entry.gen.paneId, entry.cwd);
            noteObservation(entry.taskId, probe);
            const silent = probe.agentStatus === null || probe.agentStatus === 'unknown';
            const tracked = pollers.has(entry.gen.paneId) || boots.has(entry.gen.paneId);
            running = probe.paneExists && (probe.agentStatus === 'working'
              || probe.agentStatus === 'blocked'
              || (silent && tracked));
          } catch {
            running = false; // a failed probe never strands a resume; the revive path re-checks
          }
        }
        if (running) {
          const busyText =
            `task ${entry.taskId} is already running as pane ${entry.gen.paneId}. `
            + 'Use action send or output; resume is only for a collected task whose pane is gone.';
          return {
            content: [{ type: 'text', text: busyText }],
            details: { paneId: entry.gen.paneId, taskId: entry.taskId, alreadyRunning: true },
          };
        }
      } else {
        const liveError = taskIdResolutionError(live, 'task id', rawTaskId);
        if (liveError) return toolError(liveError);
      }
    }
    // S41: one task directory per repository, so resume resolves against the current one — never a
    // sweep of other checkouts this master happened to spawn into.
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const dir = repoTasksDir(cwd);
    if (dir === null) {
      return toolError(
        `resume needs a git repository: task records live inside the repository (<repo>/.piher/tasks) and ${cwd} is not in one.`,
      );
    }
    const records = listTaskRecords(cwd);
    const resolution = resolveTaskIdPrefix(rawTaskId, records.map((e) => e.taskId));
    if (resolution.kind !== 'resolved') {
      return toolError(taskIdResolutionError(resolution, 'task id', rawTaskId)
        ?? `Error: no history for task "${rawTaskId}" in this repository's tasks (${dir}).`);
    }
    const taskId = resolution.taskId;
    const latest = readTaskRecord(cwd, taskId);
    if (!latest) return toolError(`Error: no history for task "${taskId}" in this repository's tasks (${dir}).`);
    // Resume needs an unresolved task: a closed one is final, a spent one-shot has no session
    // left. The verdict derives from the record's durable facts, never from a synthesized status —
    // a record closed before its report was consumed still says closed (S9).
    {
      const verdict = spentText(latest);
      if (verdict !== null) return toolError(verdict);
    }
    // S18/S26: this task's session can be in three places — its record, the settlement document its
    // worker wrote at its address (S12 keeps it across a core restart), and the core's `hresume` label
    // on that address. An address is not an identity: a core restart reuses terminal ids, so the label
    // is read only from a terminal this task's master made, and only when the document does not show
    // the address already belongs to another task. With none of the three, a resume would start a
    // fresh conversation under the old task's name — refuse instead of pretending, saying only what
    // was actually read.
    let restoredFrom: 'document' | 'label' | null = null;
    if (!latest.gen.sessionFile) {
      const address = await readAddressReport(latest.gen.paneId);
      // The document names the task that wrote it: another task's document means the address was
      // reused, and whatever `hresume` sits there now is that other worker's conversation.
      const foreignAddress = address.kind === 'read' && address.value.taskId !== taskId;
      const report = foreignAddress ? null : await session.readSessionReport(latest.gen.paneId);
      const fromDocument = address.kind === 'read' && address.value.taskId === taskId ? address.value.session : null;
      const fromLabel = report?.kind === 'reported' ? report.file : null;
      const adopted = fromDocument ?? fromLabel;
      if (!adopted) {
        return toolError(noSessionText({ taskId, paneId: latest.gen.paneId, address, report, foreignAddress }));
      }
      latest.gen.sessionFile = adopted;
      restoredFrom = fromDocument ? 'document' : 'label';
      // The record is what a later resume reads, so the report is written down the moment it is used.
      writeTaskRecord(latest.cwd, latest);
    }
    // D94: reuse an existing pane for the same session to avoid competing pi processes. This
    // lookup only reads terminal labels, so it runs before the ownership check below.
    const existing = await findExistingPane(latest.gen.sessionFile);
    // A record sessionFile mis-attributed to the master's own transcript would match the MASTER
    // terminal here, registering the master as its own subagent — never adopt self, whatever
    // session the row belongs to.
    if (existing?.paneId === env?.terminalId) {
      return toolError(
        `Error: task ${taskId} is attributed to the master's own session (mis-recorded sessionFile `
        + 'in the record); it cannot be resumed here — '
        + 'spawn a fresh subagent for this work instead.',
      );
    }
    // Reviving would write a generation this session does not own (S7): another session's task
    // is resumed where it lives, never adopted here (S4).
    if (!viewIds.includes(taskId)) return toolError(foreignRefusal(taskId, 'resume'));

    try {
      const entry: TaskEntry = {
        ...latest,
        gen: {
          ...latest.gen,
          paneId: existing?.paneId ?? '',
          tabId: existing?.tabId ?? '',
          tabName: latest.gen.tabName || tabNameForTask(latest.description),
          consumedAt: null,
        },
      };
      // One row per task: the revived generation replaces whatever the restore seeded, and stale
      // pane ids for it go so the index never points at the dead generation.
      for (const [paneId, id] of [...panes]) if (id === taskId) panes.delete(paneId);
      tasks.set(taskId, entry);
      if (existing) {
        panes.set(entry.gen.paneId, taskId);
        writeRecord(entry);
      } else {
        await reviveEntry(entry);
        tasks.set(entry.taskId, entry);
      }
      const source = restoredFrom === 'document'
        ? 'session restored from its settlement document'
        : restoredFrom === 'label'
          ? 'session restored from its core `hresume` report'
          : 'session restored';
      const how = existing
        ? `${source}; reused existing pane with same session, pi still running there`
        : source;
      return {
        content: [{ type: 'text', text: `resumed subagent ${taskRef(entry.gen)} from task ${taskId} (${how}).` }],
        details: { paneId: entry.gen.paneId, taskId },
      };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return toolError(`Error: failed to resume task "${taskId}": ${(err as Error).message}`);
    }
  }

  /** Re-arm a row for the turn a steer started: keeping the old consume time would read as a worker
   *  with nothing in flight, and the settlement (spec S5) is judged against this request. Rolled back
   *  when no watch takes over — `startPoller` answers that, and a watch that could not arm would
   *  otherwise leave the row re-armed with no reader, so the steer's report would never be delivered. */
  function rearmAfterSteer(entry: TaskEntry): void {
    const prevConsumedAt = entry.gen.consumedAt;
    entry.gen.consumedAt = null;
    writeRecord(entry);
    const rollback = (): void => {
      // Only the value this call cleared: a settlement that landed in between owns `consumedAt` now.
      if (entry.gen.consumedAt !== null) return;
      entry.gen.consumedAt = prevConsumedAt;
      writeRecord(entry);
    };
    void startPoller(entry.gen.paneId, entry.cwd, Date.now(), entry.description)
      .then((armed) => { if (!armed) rollback(); }, rollback);
  }

  /**
   * A follow-up rides the core (spec S15): the master writes `piher.cmd.<address>` and the worker's
   * own extension applies it with `pi.sendUserMessage(text, {deliverAs})`, which is what keeps pi's
   * steering semantics — delivered between tool calls, not behind the whole turn. `terminal.send`
   * would only paste into the TUI, so it is not this channel either.
   *
   * The write is durable, so the result separates two facts instead of blurring them: the core holds
   * the command, and (when the worker read it) the worker applied it.
   */
  async function executeSubagentSend(params: ToolParams, toolCtx: unknown, signal?: AbortSignal) {
    const { entry, foreign } = targetOf(params, toolCtx);
    // A closed worker or a spent one-shot is not a conversation partner any more.
    const spent = spentText(entry);
    if (spent !== null) return toolError(spent);
    // Another session's live task resolves so it can be closed, not steered: steering would
    // write a generation this session does not own (S7).
    if (foreign) return toolError(foreignRefusal(entry.taskId, 'send'));
    if (!client.available) return toolError(`subagent: ${CORE_REQUIRED}`);
    const text = String(params?.message ?? '');
    // The worker's guard refuses a value with no text, so an empty follow-up would sit in the core
    // forever as a command nobody can apply: refuse it where the master can still act on it.
    if (text.trim() === '') {
      return toolError('Error: action send needs a non-empty message — there is nothing to steer the worker with.');
    }
    const command = steerCommand(text, entry.taskId);
    const overflow = commandDocumentOverflow(command);
    if (overflow !== null) {
      // The measured number is the whole serialized document, not just the text: the id, the task id,
      // the type and escaping are inside it too.
      return toolError(`Error: action send refuses a ${overflow}-byte command document (the message `
        + 'plus its envelope: id, task id, type and deliver-as): the core allows '
        + `${MAX_DOCUMENT_BYTES} bytes per document, and a steer cut in half is worse than one not `
        + 'sent. Split it into smaller sends.');
    }
    try {
      // A just-spawned worker is still booting: its first task must land before any follow-up.
      const boot = boots.get(entry.gen.paneId);
      if (boot) await boot;
      // A pane the core no longer lists cannot read a document, and housekeeping reclaims the panes
      // of settled workers: revive first (S3) and write to the generation that now exists.
      await ensureLive(entry);
      const written = await writeCommandDocument(client, entry.gen.paneId, command);
      if (!written.ok) {
        return toolError(`Error: failed to reach subagent ${entry.gen.paneId}: ${written.reason} — nothing was delivered.`);
      }
      const name = commandDocName(entry.gen.paneId);
      const pickup = name
        ? await awaitCommandPickup(client, name, { id: command.id, version: written.version }, commandPickupMs, { signal: signal ?? undefined })
        : { kind: 'unknown' as const, reason: 'the address cannot name a document (S9)' };
      // A delivery the worker took re-arms the row, and so does one whose fate we could not read: an
      // `unknown` (a cancelled call, a doc.get failure) may still be applied a moment later, and a row
      // left `consumed` would then be reaping evidence against a turn nobody watches, with its report
      // dropped. A command nobody read (`unread`) or that the document moved past (`unsettled`) started
      // no turn of ours: re-arming would claim one and then report silence for work never received.
      if (pickup.kind === 'applied' || pickup.kind === 'unknown') rearmAfterSteer(entry);
      if (pickup.kind === 'unread') {
        const document = name ?? `piher.cmd.${entry.gen.paneId}`;
        // PIHER_COMMAND_PICKUP_MS=0 is the documented "report the write alone" mode: the operator asked
        // for no ack, so an unread command is not a failure, it is the answer.
        return commandPickupMs <= 0
          ? {
            content: [{ type: 'text', text: writtenOnlyText(taskRef(entry.gen), entry.gen.paneId, command.id) }],
            details: { paneId: entry.gen.paneId },
          }
          : toolError(unreadCommandText(entry.gen.paneId, entry.taskId, document, commandPickupMs));
      }
      return {
        content: [{ type: 'text', text: steerResultText(taskRef(entry.gen), entry.gen.paneId, command.id, pickup) }],
        details: { paneId: entry.gen.paneId },
      };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return toolError(`Error: failed to reach subagent ${entry.gen.paneId}: ${(err as Error).message}`);
    }
  }

  /** Re-send the prompt this task was spawned with. An upstream failure (a provider outage, a dropped
   *  stream) says nothing about the task, and rewriting the brief costs the master real tokens: the
   *  stored prompt makes the retry free. A closed task or spent one-shot starts a new task with it —
   *  there is no live turn to send into. */
  async function executeSubagentRetry(params: ToolParams, toolCtx: unknown) {
    const { entry, foreign } = targetOf(params, toolCtx);
    const spawnNew = (brief: string) => executeSubagentSpawn({
      prompt: brief,
      description: entry.description,
      cwd: entry.cwd,
      ...(entry.kind !== 'task' ? { role: entry.kind } : {}),
      ...(entry.worktree ? { worktree: entry.worktree.branch } : {}),
    }, toolCtx);
    const needBrief = (): string => {
      const brief = readTaskPrompt(entry.taskId);
      if (brief === null) {
        throw new ToolError(
          `Error: no stored prompt for task ${entry.taskId} — piher keeps the brief `
          + 'of a spawn it made, and this task has none (a resumed session, or a row from '
          + 'another checkout). Send the task again with action "send".',
        );
      }
      return brief;
    };
    // S2, no session qualifier: a closed task or a spent one-shot starts a NEW task. The new task
    // is this session's own — new taskId, own view and record — so a foreign closed row retries
    // the same way, and the old row is untouched.
    if (spentText(entry) !== null) return spawnNew(needBrief());
    // An actionable foreign row refuses: this session may not steer another session's live
    // conversation (S7).
    if (foreign) return toolError(foreignRefusal(entry.taskId, 'retry'));
    return executeSubagentSend({ ...params, message: needBrief() }, toolCtx);
  }

  async function executeSubagentInterrupt(params: ToolParams, toolCtx: unknown) {
    const { entry } = targetOf(params, toolCtx);
    // Interrupt stops the current turn and nothing else. A closed task is final; otherwise the
    // probe decides — a worker with no turn in flight has nothing to stop, and naming `close`
    // points at the natural next step instead of a wait. A probe that fails never refuses: the core
    // call below is the honest test.
    // No ownership refusal here: `close` refuses a worker with a turn in flight and points at
    // `interrupt`, so refusing `interrupt` across sessions would make another session's stuck
    // worker impossible to end. Interrupting writes no document and adopts nothing.
    // Nor is `isSpent` consulted (`isSpent` means the master already holds this task's report, not
    // that the worker has no turn): a person may type into a persistent worker's attachable pane
    // after its report was consumed (S21), and that turn is exactly what someone wants stopped. The
    // probe below decides whether there is a turn, and it is the only fact this action needs.
    if (isClosed(entry)) {
      return toolError(
        `Error: subagent ${taskRef(entry.gen)} is closed — its pane and tab are gone, so there is `
        + 'no turn to interrupt. '
        + `Close is final for task ${entry.taskId} — start a new subagent for further work.`,
      );
    }
    // Nothing left in piher can stop a turn without the core: the interrupt IS a core call now.
    let probe: AliveProbe;
    try {
      probe = await probeAlive(entry.gen.paneId, entry.cwd);
    } catch {
      probe = { paneExists: true, agentStatus: null, lastActivityMs: null };
    }
    noteObservation(entry.taskId, probe);
    const inFlight = probe.paneExists
      && (probe.agentStatus === 'working' || probe.agentStatus === 'blocked');
    if (!inFlight) {
      const observed = !probe.paneExists
        ? 'its pane is gone'
        : `its agent reports ${probe.agentStatus ?? 'no turn'}`;
      return toolError(
        `Error: subagent ${taskRef(entry.gen)} has no running turn (${observed}) — interrupt stops `
        + 'the current turn only, and there is nothing to stop. '
        + 'Close it with action "close" if its work is accepted, send it a follow-up '
        + 'with action "send" if its pane is still listed, or revive it with action "resume" '
        + `and taskId ${entry.taskId}.`,
      );
    }
    // Nothing left in piher can stop a turn without the core, and a worker with no turn in flight is
    // refused above by what the core said — this is the last point the core is still needed.
    if (!client.available) return toolError(`subagent: ${CORE_REQUIRED}`);
    // P5 (spec S19): the core's own `terminal.interrupt` is the only place left to stop a turn. It
    // stops it the way a person would: it presses the stop key in that pane — `esc` for a program
    // that reports status, else `ctrl+c` (the vendored core contract, `terminal.interrupt`), and it
    // never escalates. So this action DOES type into the worker's PTY, exactly as the first task
    // does; what stayed with the human is every other keystroke, because no report, steer or control
    // message of piher's is injected as one, and the pane's keyboard is otherwise left alone (D45).
    // The core reports what happened to the turn, so the result states it instead of inferring it
    // (spec S17).
    try {
      const outcome = await client.interrupt(entry.gen.paneId);
      // A core that will not say what happened to the turn is not a failure of the interrupt: the
      // request went out. The result says which of the two it is (spec S17 keeps the core the
      // authority on an ending, so nothing here is inferred).
      const detail = outcome === 'still_working'
        ? ' The core reports the turn still running; it was asked to stop.'
        : outcome === 'exited'
          ? ' Its process had already exited.'
          : outcome === 'stopped' ? ' The core reports the turn stopped.' : '';
      return {
        content: [{ type: 'text', text: `Interrupt accepted for subagent ${taskRef(entry.gen)} (fire-and-return).${detail}` }],
        details: { paneId: entry.gen.paneId },
      };
    } catch (err) {
      return toolError(`Error: failed to interrupt subagent ${entry.gen.paneId}: ${(err as Error).message}`);
    }
  }

  /** S53: reclaim a worker that already finished. `close` is not `cancel`: a worker that is still
   *  running is refused with a pointer at `interrupt`, because a task must not vanish without a report. */
  async function executeSubagentClose(params: ToolParams, toolCtx: unknown) {
    const { entry } = targetOf(params, toolCtx);
    if (isClosed(entry)) {
      // Memory can be closed while the record still holds no such decision (a close that happened
      // elsewhere, or a sweep). Record the decision here too, so the record says who ended it
      // instead of trailing off at `consumed`.
      const latest = readTaskRecord(entry.cwd, entry.taskId);
      if (!latest || !isClosed(latest)) writeCloseRecord(entry.cwd, entry);
      const finality = `Error: task ${entry.taskId} was closed by the master; close is final, `
        + 'so there is nothing to resume or send to. Start a new subagent for further work.';
      return {
        content: [{ type: 'text', text: finality }],
        details: { paneId: entry.gen.paneId, taskId: entry.taskId, alreadyClosed: true },
      };
    }
    // S14: a task must not disappear while someone could still report it. The probe decides for
    // every row now that no stored status says otherwise: only a pane with a turn in flight is
    // protected, and an unknown status is treated as in flight because core has not said otherwise.
    // A failed probe must not authorise the removal of a task.
    let live = true;
    let finished = false;
    try {
      const probe = await probeAlive(entry.gen.paneId, entry.cwd);
      noteObservation(entry.taskId, probe);
      live = probe.paneExists;
      finished = probe.agentStatus === 'idle'
        || probe.agentStatus === 'done'
        || probe.agentStatus === 'error';
    } catch {
      live = true;
    }
    if (live && !finished) {
      return toolError(
        `Error: subagent ${taskRef(entry.gen)} is still running — close only reclaims `
        + 'a worker that already finished, and a task must not disappear without a report. '
        + 'Use action "interrupt" to stop its current turn (the pane and its session stay), '
        + 'then close it once it has finished.',
      );
    }
    // Nothing to reclaim: fall through and record the decision, so `list` stops offering it.
    if (!client.available) return toolError(`subagent: ${CORE_REQUIRED}`);
    // S71: close is terminal for what piher created. The checkout goes first, because a dirty one is
    // a refusal that must leave the worker reachable. The record is resolved through the repository
    // root before the release, since the checkout it records is about to disappear.
    const toolCwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    // The checkout a job/worker named can be gone (a removed worktree), and `mainWorktreeRoot` cannot
    // resolve a repository from a path that no longer exists: the decision would be written nowhere.
    const recordCwd = mainWorktreeRoot(entry.cwd) ?? mainWorktreeRoot(toolCwd) ?? toolCwd;
    let checkoutLine = '';
    if (entry.worktree) {
      const released = await releaseCheckout(checkout, entry.worktree, checkoutSpace);
      if (!released.ok) return toolError(released.text);
      checkoutLine = ` ${releasedCheckoutLine(entry.worktree, released.removed)};`;
    }
    await retirePane(client, entry.gen.paneId);
    // The record survives the pane so the decision is durable: `list` and the refusals answer from it.
    writeCloseRecord(recordCwd, entry);
    const doneText = `Subagent ${taskRef(entry.gen)} closed — pane and tab gone;${checkoutLine} `
      + 'close is final — start a new subagent for further work.';
    return {
      content: [{ type: 'text', text: doneText }],
      details: { paneId: entry.gen.paneId, taskId: entry.taskId },
    };
  }

  /** The session's actionable tasks first, then another session's live ones, marked (S13/S23).
   *  A closed or spent row is never printed, and a foreign record whose pane is gone is not
   *  printed at all. Every row shown is probed — the probe feeds the state text (S26). */
  async function executeSubagentList(toolCtx?: unknown) {
    const rows = [...tasks.values()];
    // Every own row is re-read before it is shown: another session may have closed it since the
    // restore, and `list` must drop it on sight, not on the next reload (S24).
    for (const row of rows) refreshFromRecord(row);
    const visible = rows.filter(isActionable);
    const cwd = (toolCtx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const foreign = listTaskRecords(cwd)
      .filter((row) => isActionable(row) && !viewIds.includes(row.taskId) && !tasks.has(row.taskId))
      .sort((a, b) => a.createdAt - b.createdAt || (a.taskId < b.taskId ? -1 : 1));
    const probes = new Map<string, AliveProbe>();
    const probeRow = async (row: TaskRow, note: boolean): Promise<void> => {
      try {
        const probe = await probeAlive(row.gen.paneId, row.cwd);
        probes.set(row.taskId, probe);
        if (note) noteObservation(row.taskId, probe);
      } catch { /* best effort: the cache below covers a failed probe */ }
    };
    await Promise.all([
      ...visible.map((row) => probeRow(row, true)),
      ...foreign.map((row) => probeRow(row, false)),
    ]);
    const lines: string[] = [];
    for (const row of visible) {
      const cached = probes.get(row.taskId) ?? observations.get(row.taskId) ?? null;
      const head = `${taskRef(row.gen)} [${describeTaskState(row, cached)}]`;
      lines.push(`${head} (${row.kind} · ${row.lifecycle}) ${row.description}`);
    }
    for (const row of foreign) {
      const probe = probes.get(row.taskId);
      if (!probe?.paneExists) continue;
      const head = `${taskRef(row.gen)} [${describeTaskState(row, probe)}]`;
      lines.push(`[otra sesión] ${head} (${row.kind} · ${row.lifecycle}) ${row.description}`);
    }
    if (lines.length === 0) {
      const text = 'No subagents started (from this session view).';
      return { content: [{ type: 'text', text }], details: {} };
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
  }

  const executeSubagentSpawn = createSpawnAction({
    client,
    env,
    subSemaphore,
    tasks,
    panes,
    writeRecord,
    appendView,
    dropTask,
    boots,
    notifySpawnFailed: injectNotice,
    git,
    checkout,
    checkoutSpace,
    session,
    spawn,
    poller,
    getSessionId: d.getSessionId,
  });

  const outputActionDeps = {
    client,
    resolveEntry: (rawId: string, cwd?: string) => {
      const resolved = resolveSubEntry(rawId, cwd);
      if (!('error' in resolved) && !resolved.foreign) refreshFromRecord(resolved.entry);
      return resolved;
    },
    outputCursors,
    nextRevision: (paneId: string): number => {
      const next = (outputRevisions.get(paneId) ?? 0) + 1;
      outputRevisions.set(paneId, next);
      return next;
    },
    // Transcript fallback: small worker panes show only the opaque status overlay, so the pane delta can never
    // carry the final report. The row's own session is the first candidate, so a reused address can never
    // hand the task another conversation's last words; behind it the worker's own `hresume` report decides
    // (spec S18).
    readFinalReport: async (paneId: string, entryCwd: string, preferred: string | null) =>
      (await session.readTurnClosing(paneId, entryCwd, 0, preferred)).text,
    writeRecord,
  };

  const ACTIONS: Record<string, (params: ToolParams, toolCtx: unknown, onUpdate?: (u: unknown) => void, signal?: AbortSignal) => Promise<unknown>> = {
    spawn: (params, toolCtx) => executeSubagentSpawn(params, toolCtx),
    resume: (params, toolCtx) => executeSubagentResume(params, toolCtx),
    list: (_params, toolCtx) => executeSubagentList(toolCtx),
    send: (params, toolCtx, _onUpdate, signal) => executeSubagentSend(params, toolCtx, signal),
    retry: (params, toolCtx) => executeSubagentRetry(params, toolCtx),
    interrupt: (params, toolCtx) => executeSubagentInterrupt(params, toolCtx),
    output: (params, toolCtx) => executeSubagentOutput(params, toolCtx, outputActionDeps),
    close: (params, toolCtx) => executeSubagentClose(params, toolCtx),
    help: async (_params, toolCtx) => {
      const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
      return { content: [{ type: 'text' as const, text: `${SUBAGENT_MANUAL}\n\n${roleCatalog(cwd)}` }], details: {} };
    },
  };

  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    // B4: the model picks tools from the system prompt's snippet/guideline surface; delegation
    // decisions are made here, so state them rather than hoping for recall.
    promptSnippet: 'subagent: delegate a self-contained task to a pi worker pane (spawn/send/output/interrupt/resume/list/close/help).',
    promptGuidelines: [
      'Use subagent for self-contained work whose result is what matters: output that would flood this context, long builds/test runs, or independent parts of a bigger change that can run in parallel.',
      'The worker does not see this conversation: put paths, acceptance criteria, the test command and what to report back into the prompt.',
      'Pass agentId, taskId, message and max_chars as top-level arguments, not inside a parameters object.',
    ],
    description: SUBAGENT_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('spawn'),
        Type.Literal('resume'),
        Type.Literal('list'),
        Type.Literal('send'),
        Type.Literal('retry'),
        Type.Literal('interrupt'),
        Type.Literal('output'),
        Type.Literal('close'),
        Type.Literal('help'),
      ], { description: 'Default spawn' })),
      description: Type.Optional(Type.String({ description: '[spawn] Pane label' })),
      prompt: Type.Optional(Type.String({ description: '[spawn] The complete self-contained task' })),
      cwd: Type.Optional(Type.String({ description: '[spawn] Existing directory or worktree to run in (absolute or workspace-relative)' })),
      worktree: Type.Optional(Type.String({ description: '[spawn] Name of a checkout piher creates for the worker (branch of the same name); mutually exclusive with cwd' })),
      role: Type.Optional(Type.String({ description: '[spawn] Role profile name; action help lists the profiles available here (description, tools, lifecycle). Unknown names are display labels only' })),
      tab: Type.Optional(Type.String({ description: '[spawn] Task tab to join or create (default: grouped by worktree)' })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: '[spawn] Extra tools on top of the role baseline' })),
      taskId: Type.Optional(Type.String({ description: '[resume] Task id of a collected task, as printed by list' })),
      agentId: Type.Optional(Type.String({ description: '[send|interrupt|output|close] Slug, pane id, or slug@paneId as printed by spawn/list' })),
      message: Type.Optional(Type.String({ description: '[send] Follow-up message' })),
      max_chars: Type.Optional(Type.Integer({ description: '[output] Output cap (default 6000, 100-16000)' })),
      full: Type.Optional(Type.Boolean({ description: '[output] Return the whole pane buffer instead of the latest lines (default false)' })),
    }),
    outputSchema: SUBAGENT_OUTPUT_SCHEMA,
    // B2: `action` is optional in the schema; normalize it so the validated arguments and the
    // code path never disagree and `spawn` is explicit in logs.
    prepareArguments: (args: unknown) => {
      const rec = flattenToolParams(args && typeof args === 'object' ? args as Record<string, unknown> : {}) ?? {};
      const hasAction = typeof rec.action === 'string' && rec.action.trim() !== '';
      return hasAction ? rec : { ...rec, action: 'spawn' };
    },
    async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, toolCtx: unknown) {
      void toolCallId;
      const flat = flattenToolParams(params);
      const action = typeof flat?.action === 'string' && flat.action.trim() ? flat.action.trim() : 'spawn';
      const handler = ACTIONS[action];
      if (!handler) {
        return toolError(`Error: unknown action "${action}" (valid: ${Object.keys(ACTIONS).join(', ')})`);
      }
      return attachSubagentStructuredContent(action, await handler(flat, toolCtx, onUpdate, signal));
    },
  });
}
