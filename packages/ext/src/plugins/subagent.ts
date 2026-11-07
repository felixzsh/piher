/**
 * subagent — master-only plugin entry: tool registration, action dispatch, the resume / send / interrupt /
 * output / list actions, and port binding. Inbound deps arrive via `piher.subagent-deps`; outbound
 * pipe/settle queries bind atomically onto `port.current`.
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
  applyReportedSessionFile,
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
import type { Lifecycle } from '../role-manifest.ts';
import { toolError, ToolError } from '../tool-error.ts';
import { readTaskPrompt } from '../prompt-store.ts';
import { pipeNameFor, pipePathFor, pipeRequestTo, type PipeRequest, type PipeResponse } from '../pipe-channel.ts';
import type { PaneStateSlot } from './bg-job.ts';
import { bareSessionId, resolveSessionFileValue } from '../session-tail.ts';
import { mainWorktreeRoot } from '../storage-layout.ts';
import { settlementCard, type SettlementCard } from '../settlement-card.ts';
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
import { createGcController, restoreTasks, retirePane, seedForkView } from '../subagent-gc.ts';
import { createSessionIo, executeSubagentOutput, type SubagentOutputCursor } from '../subagent-session.ts';
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
  claimSettleNotice: (key: string) => boolean;
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
  'send — `agentId` + `message`: steered into a working worker at its next tool gap. A task whose pane is gone revives a new generation first, then takes the text. A closed or spent task is refused. `interrupt` aborts the current turn only — the pane and session stay, and no report arrives.',
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
  const lastRequestIdByPane = new Map<string, string>();
  /** Pane id → its in-flight boot (pipe readiness, prompt injection); a follow-up waits for it. */
  const boots = new Map<string, Promise<void>>();
  /** Deduplicates gate notices while blocked but permits a later, distinct human question. */
  const blockedGateNotified = new Set<string>();

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
    applyReplySession(paneId, sessionFile) {
      const entry = taskForPane(tasks, panes, paneId);
      if (!entry) return;
      // Workers self-report a BARE session id over the pipe; the .jsonl-only guard in applyReportedSessionFile
      // would discard it and freeze a mis-attributed sessionFile forever, so map the id to its transcript path.
      const reported = resolveSessionFileValue(entry.cwd, defaultAgentSessionsDir(), sessionFile);
      const next = applyReportedSessionFile(entry.gen.sessionFile, reported);
      if (next === entry.gen.sessionFile) return;
      entry.gen.sessionFile = next;
      writeRecord(entry);
    },
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
    settlementCard(paneId, outcome) {
      const entry = taskForPane(tasks, panes, paneId);
      return settlementCard({
        name: entry ? `${paneId} (${entry.description})` : paneId,
        ...(entry ? { kind: entry.kind, startedAt: entry.createdAt } : {}),
        outcome,
      });
    },
    consumeReply(paneId, _outcome) {
      const entry = taskForPane(tasks, panes, paneId);
      if (!entry || entry.gen.consumedAt !== null || isClosed(entry)) return;
      entry.gen.consumedAt = Date.now();
      writeRecord(entry);
      // S54: a one-shot worker exits right after this push; its pane goes now, not at the GC TTL.
      if (entry.lifecycle === 'one-shot') reclaim(entry);
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

  const session = createSessionIo({ client, getSessionId: d.getSessionId, sessionsDir: defaultAgentSessionsDir });
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
    blockedGateNotified,
    session,
    injectNotice,
    claimSettleNotice: d.claimSettleNotice,
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
  const { spawnPaneInTaskTab, launchParts, approveFor, waitSubReady, findExistingPane } = spawn;

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
      try {
        await startPoller(entry.gen.paneId, entry.cwd, entry.gen.startedAt, entry.description, `recover-${via}-${entry.gen.paneId}`);
        recovered.push(`${entry.gen.paneId} (${entry.description})`);
      } catch {
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
      startPoller(paneId, entry.cwd, entry.gen.startedAt, entry.description, lastRequestIdByPane.get(paneId) ?? `probe-${paneId}`);
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
    // waiting for its pipe cannot starve a spawn (S50). The wait below runs outside the slot.
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
    const ready = await waitSubReady(entry.cwd, spawned.paneId);
    if (!ready.ok) throw new Error(ready.message);
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
      const how = existing
        ? 'reused existing pane with same session; pi still running there'
        : entry.gen.sessionFile ? 'session restored' : 'session file missing; fresh conversation';
      return {
        content: [{ type: 'text', text: `resumed subagent ${taskRef(entry.gen)} from task ${taskId} (${how}).` }],
        details: { paneId: entry.gen.paneId, taskId },
      };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return toolError(`Error: failed to resume task "${taskId}": ${(err as Error).message}`);
    }
  }

  /** The shared spine of every id-carrying action: revive a closed row, wait for its pipe, send one request,
   *  fold failures into the error wording. `interrupt` passes `ready: false`: a worker with no turn in
   *  flight is refused before the pipe instead of being woken to receive a stop. */
  async function pipeAction(
    entry: TaskEntry,
    opts: {
      /** One request from the closed pipe protocol; its `type`/`id` drive the reply and settle keys. */
      build(): PipeRequest;
      ok(res: Extract<PipeResponse, { type: 'ok' }>, reqId: string): unknown;
      fail?(paneId: string): string;
      ready?: false;
    },
  ): Promise<unknown> {
    const t0 = Date.now();
    const trace = (step: string): void => {
      if (process.env.PIHER_PIPE_TRACE === '1') console.error(`piher: pipeAction ${step} +${Date.now() - t0}ms`);
    };
    try {
      if (opts.ready !== false) {
        // A just-spawned worker is still booting: its prompt must reach it before any follow-up.
        const boot = boots.get(entry.gen.paneId);
        if (boot) {
          await boot;
          trace('boot');
        }
      }
      const payload = opts.build();
      let res: PipeResponse;
      try {
        // The pipe IS the liveness proof: a worker that answers it is alive, so a healthy `send` is
        // one round trip with no liveness RPC and no terminal read in front of it.
        res = await pipeRequestTo(entry.cwd, entry.gen.paneId, payload);
      } catch (err) {
        if (opts.ready === false) throw err;
        // A pipe that did not answer may mean the pane is gone: revive it, and only a pane made right
        // now is worth waiting for readiness. A pane that was already alive is not "starting": it has
        // no listener, and spending the 90 s readiness budget on it turns a dead channel into a
        // timeout that reads like a slow boot.
        const revived = await ensureLive(entry);
        trace(revived ? 'recovered-liveness' : 'alive-no-pipe');
        if (revived) {
          const ready = await waitSubReady(entry.cwd, entry.gen.paneId);
          trace('recovered-ready');
          if (!ready.ok) throw new Error(ready.message);
        }
        try {
          res = await pipeRequestTo(entry.cwd, entry.gen.paneId, payload);
        } catch (retryErr) {
          throw new Error(await pipeUnreachableText(entry, retryErr));
        }
      }
      trace('delivered');
      if (res.type !== 'ok') {
        throw new Error(`pipe ${payload.type} rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
      }
      return opts.ok(res, payload.id);
    } catch (err) {
      const what = opts.fail?.(entry.gen.paneId) ?? `failed to reach subagent ${entry.gen.paneId}`;
      return toolError(`Error: ${what}: ${(err as Error).message}`);
    }
  }

  /** Why a live pane did not take the request: a ping separates "nothing listens" (its extension
   *  host is not running, so the message was lost) from "listens but did not answer" (busy or
   *  rejecting). Both are honest; "retry is safe" is only true for the second. */
  async function pipeUnreachableText(entry: TaskEntry, err: unknown): Promise<string> {
    const path = pipePathFor(pipeNameFor(entry.cwd, entry.gen.paneId));
    let listening = false;
    try {
      listening = (await pipeRequestTo(entry.cwd, entry.gen.paneId, { type: 'ping', id: `ping-${Date.now()}` }, 2_000)).type === 'ok';
    } catch {
      listening = false;
    }
    const head = `subagent pane ${entry.gen.paneId} is alive but its message channel is dead (${path})`;
    const detail = String((err as Error)?.message ?? err);
    return listening
      ? `${head}: it answers a ping but did not take this request (${detail}). Nothing was confirmed delivered — check the pane before resending.`
      : `${head}: nothing answers there, so the worker's extension host is not running and NOTHING was delivered (${detail}). action "resume" with taskId ${entry.taskId} restarts it in a new pane; action "close" retires the row.`;
  }

  /** Follow_up goes through the extension pipe with steering so supplemental instructions reach a
   * long-running worker within seconds during a tool-call gap; a plain queue waits for the run. */
  function executeSubagentSend(params: ToolParams, toolCtx: unknown) {
    const { entry, cwd, foreign } = targetOf(params, toolCtx);
    // A closed worker or a spent one-shot is not a conversation partner any more.
    const spent = spentText(entry);
    if (spent !== null) return toolError(spent);
    // Another session's live task resolves so it can be closed, not steered: steering would
    // write a generation this session does not own (S7).
    if (foreign) return toolError(foreignRefusal(entry.taskId, 'send'));
    return pipeAction(entry, {
      build: () => ({
        type: 'follow_up',
        id: `fu-${Date.now()}`,
        text: String(params?.message ?? ''),
        // The reply pipe is the MASTER's (bound at session_start with this session's cwd);
        // entry.cwd would name a dead pipe for cross-repo workers.
        from: pipeNameFor(cwd, env?.terminalId ?? ''),
        steer: true,
      }),
      ok: (_res, reqId) => {
        // A follow_up re-arms the row: keeping the old consume time would read as finished while
        // a turn is in flight. Roll it back if no poller takes over.
        const prevConsumedAt = entry.gen.consumedAt;
        entry.gen.consumedAt = null;
        writeRecord(entry);
        try {
          lastRequestIdByPane.set(entry.gen.paneId, reqId);
          startPoller(entry.gen.paneId, entry.cwd, Date.now(), entry.description, reqId);
        } catch (inner) {
          entry.gen.consumedAt = prevConsumedAt;
          writeRecord(entry);
          throw inner;
        }
        return { content: [{ type: 'text', text: `Message sent to subagent ${taskRef(entry.gen)}.` }], details: { paneId: entry.gen.paneId } };
      },
    });
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
    // points at the natural next step instead of a wait. A probe that fails never refuses: the
    // pipe attempt itself is the honest test.
    // No ownership refusal here: `close` refuses a worker with a turn in flight and points at
    // `interrupt`, so refusing `interrupt` across sessions would make another session's stuck
    // worker impossible to end. Interrupting writes no document and adopts nothing.
    if (isClosed(entry)) {
      return toolError(
        `Error: subagent ${taskRef(entry.gen)} is closed — its pane and tab are gone, so there is `
        + 'no turn to interrupt. '
        + `Close is final for task ${entry.taskId} — start a new subagent for further work.`,
      );
    }
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
    return pipeAction(entry, {
      ready: false,
      build: () => ({ type: 'interrupt', id: `int-${Date.now()}` }),
      ok: () => {
        // No settlement notice for an interrupted turn: the requester already knows.
        const lastId = lastRequestIdByPane.get(entry.gen.paneId);
        if (lastId) d.claimSettleNotice(`${entry.gen.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${taskRef(entry.gen)} (fire-and-return).` }], details: { paneId: entry.gen.paneId } };
      },
    });
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
    lastRequestIdByPane,
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
    // carry the final report. No preferred file — start from the worker's `piher.session` label, not a stale registry value.
    readFinalReport: async (paneId: string, entryCwd: string) =>
      (await session.subSessionState(paneId, entryCwd, 0)).text,
    writeRecord,
  };

  const ACTIONS: Record<string, (params: ToolParams, toolCtx: unknown, onUpdate?: (u: unknown) => void) => Promise<unknown>> = {
    spawn: (params, toolCtx) => executeSubagentSpawn(params, toolCtx),
    resume: (params, toolCtx) => executeSubagentResume(params, toolCtx),
    list: (_params, toolCtx) => executeSubagentList(toolCtx),
    send: (params, toolCtx) => executeSubagentSend(params, toolCtx),
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
      void signal;
      const flat = flattenToolParams(params);
      const action = typeof flat?.action === 'string' && flat.action.trim() ? flat.action.trim() : 'spawn';
      const handler = ACTIONS[action];
      if (!handler) {
        return toolError(`Error: unknown action "${action}" (valid: ${Object.keys(ACTIONS).join(', ')})`);
      }
      return attachSubagentStructuredContent(action, await handler(flat, toolCtx, onUpdate));
    },
  });
}
