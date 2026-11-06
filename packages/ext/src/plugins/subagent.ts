/**
 * subagent — master-only plugin entry: tool registration, action dispatch, the resume / send / interrupt /
 * output / role / list actions, and port binding. Inbound deps arrive via `piher.subagent-deps`; outbound
 * pipe/settle queries bind atomically onto `port.current`.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cordisGet } from '../cordis-services.ts';
import type { CoreClientLike, CoreEnv } from '../core-client.ts';
import {
  Semaphore,
  SUBAGENT_OUTPUT_SCHEMA,
  agoText,
  attachSubagentStructuredContent,
  buildAliveNotice,
  buildLaunchLine,
  idParam,
  flattenToolParams,
  isAlive,
  newestPerTaskId,
  rekeySub,
  resolveTaskIdPrefix,
  taskIdResolutionError,
  tabNameForTask,
  subRef,
  withAdmission,
  type AliveProbe,
  type SubEntry,
  type SubagentPort,
  type SubagentPortBox,
} from '../subagent-core.ts';
import {
  appendLedger,
  applyReportedSessionFile,
  inheritOutcome,
  latestGeneration,
  ledgerFile,
  readLedger,
  type HistoryEntry,
} from '../history-store.ts';
import { platformPaths } from '../platform-paths.ts';
import { loadRoleConfig } from '../role-loader.ts';
import type { Lifecycle } from '../role-manifest.ts';
import { toolError, ToolError } from '../tool-error.ts';
import { pipeNameFor, pipeRequestTo, type PipeRequest, type PipeResponse } from '../pipe-channel.ts';
import type { PaneStateSlot } from './bg-job.ts';
import { bareSessionId, resolveSessionFileValue } from '../session-tail.ts';
import { mainWorktreeRoot } from '../storage-layout.ts';
import { settlementCard, type SettlementCard } from '../settlement-card.ts';
import { DELEGATION_ENV, type DelegationContext } from '../delegation-core.ts';
import { swallow } from '../swallow.ts';
import { createGitIo, createSpawnAction, createSpawner } from '../subagent-spawn.ts';
import { createWorktreeIo } from '../worktree-io.ts';
import {
  missingCheckoutText,
  reconcileCheckouts,
  reconcileLines,
  releaseCheckout,
  releasedCheckoutLine,
  type WorktreeIo,
} from '../worktree.ts';
import { createPoller } from '../subagent-poller.ts';
import { createGcController, createSubagentRegistry, retirePane } from '../subagent-gc.ts';
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
  claimSettleNotice: (key: string) => boolean;
  /** Settlement notice injector from index: buffer while busy, flush at turn_end. */
  deliverNotice?: (content: string, paneId?: string, card?: SettlementCard | null) => Promise<void>;
  /** Panes whose settlement notice is still buffered (GC exemption). */
  noticePending?: () => ReadonlySet<string>;
  /** Pane-owning plugins (background jobs) are exempt from subagent panes collection. */
  terminalState: PaneStateSlot;
  /** Test seam for the checkout piher may create and the app space that shows it (S71). */
  worktreeIo?: WorktreeIo;
}

/** Sent with every request: what a call needs. Details live in SUBAGENT_MANUAL (`action: "help"`). */
const SUBAGENT_DESCRIPTION = [
  'Delegate a self-contained task to a subagent: a separate pi session in its own herdr terminal pane (its own context — it does NOT see this conversation; a human can talk to it in that pane).',
  'Actions (default spawn): spawn | send | output | list | interrupt | resume | role | close | help.',
  'spawn: `prompt` is the COMPLETE task, since only the prompt reaches it; `description` labels the pane. Several spawns in one message run in parallel (max 4).',
  'spawn places the worker by `cwd` (a checkout you have) or by `worktree` (a name, and piher creates the checkout, its branch and its space).',
  'spawn returns at once with the pane handle; the worker runs on and its result arrives later as a settlement notice at your next turn boundary — no need to sleep or poll.',
  'send: follow-up to a running or settled worker (steered between its tool calls). output: what it printed since your last check, plus its final report once done. resume: revive a collected task by taskId. role: switch a worker\'s role profile mid-session.',
  'help: the full manual (cwd/tab placement, role profiles, the delegation ledger).',
].join(' ');

/** Returned by `action: "help"`: the reference text kept out of the per-request description. */
const SUBAGENT_MANUAL = [
  'subagent manual — what a call needs beyond the description that rides every request; help returns this text.',
  '',
  'spawn — the subagent shares this workspace and works independently; its result is its final text answer, delivered as a settlement notice. The call returns at once with the worker handle, so never wait on it in-turn. `prompt` is the whole task: the worker does not see this conversation, so paths, acceptance criteria, the command that proves the work and what to report back all belong in it. Do not delegate the current step itself. Placement: by default panes group by git worktree — a subagent in your checkout shares your tab, one in a separate worktree gets its own tab named after the worktree directory. `tab` joins or creates a named task tab instead. `cwd` targets an existing directory or worktree you already have. `worktree` is a name, never a path: piher creates `~/.herdr/worktrees/<repo>/<slug>` (the name, anything outside A-Za-z0-9._- turned into a dash) on branch `<name>` from your HEAD, reuses it when it already sits on that branch, and asks the app for a space named after it — `cwd` and `worktree` are mutually exclusive.',
  '',
  'role + allowed_tools — when role matches a profile (searched: workspace .piher/roles/ → user-global ~/.pi/agent/piher/roles/ → builtin), the worker toolset becomes baseline ∪ allowed_tools minus role-deny tools (deny always wins). Custom roles: drop a JSON profile into .piher/roles/ (master/worker-default reserved). Unknown role names stay display labels. action role switches a live worker (pi transcript tool delta: applies on its next request, survives resume); the reply reports the tool diff.',
  '',
  'list — every worker of this session branch with live state (running / idle), pane ids, last activity, role and description.',
  '',
  'output — `agentId` required; returns the delta since your last output call (default 6000 chars, max_chars 100-16000) with status (running/idle/blocked/settled), revision and a truncated flag. TUI chrome is stripped; once the worker has finished, the complete transcript report is attached. A "buffer scrolled or reset" note means the full text was returned — normal for fullscreen TUI panes.',
  '',
  'send — `agentId` + `message`: if working, delivered at its next tool-call gap (seconds); if idle or settled, wakes a new turn. Do not spawn a duplicate for the same task. interrupt — aborts its current turn ONLY; the pane and its session stay and no report arrives for it, so it is not a stop.',
  '',
  'close — `agentId`: reclaims a worker that already finished — its pane and tab go, its session and ledger row stay, so action resume with that taskId revives it. A still-running worker is refused (a task must not disappear without a report): interrupt its turn first. A role that declares lifecycle one-shot is reclaimed this way automatically at its settlement. A checkout the spawn created with `worktree` goes with it: its space closes and the worktree is removed (never forced — a dirty one is refused, naming the files), while the branch survives in the repository.',
  '',
  'resume — `taskId`: revives a collected subagent from the delegation ledger in a new pane (pi --session); then use send. The ledger is append-only JSONL, one row per status change (taskId, description, status running|settled|consumed|closed, outcome, paneId, sessionFile, launchCommand, createdAt), one file per git repository at <repo>/.piher/history/history.jsonl in the main checkout — worktrees share it, and outside a git repository nothing is recorded. resume reads the current repository\'s ledger only. A still-running task is not resumed — use send or output.',
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

  const runtime = { nodePath: process.execPath, cliPath: process.argv[1] ?? '', extPath: d.extPath };
  const subSemaphore = new Semaphore(SUBAGENT_CONCURRENCY);
  /* Registry persisted as custom branch state so a parent restart can rebuild it. */
  const subs = new Map<string, SubEntry>();
  const outputCursors = new Map<string, SubagentOutputCursor>();
  /** Read counters shown in `subagent output` headers (one monotonic number per worker). */
  const outputRevisions = new Map<string, number>();
  const lastRequestIdByPane = new Map<string, string>();
  /** Pane id → its in-flight boot (pipe readiness, prompt injection); a follow-up waits for it. */
  const boots = new Map<string, Promise<void>>();
  /** Deduplicates gate notices while blocked but permits a later, distinct human question. */
  const blockedGateNotified = new Set<string>();

  /** B5: latest non-empty outcome per task, so closed generations do not hide settled results. */
  const lastOutcomeByTask = new Map<string, string>();

  function toHistory(e: SubEntry, outcome: string | null): HistoryEntry {
    return {
      taskId: e.taskId,
      kind: e.kind,
      paneId: e.paneId,
      ...(e.slug ? { slug: e.slug } : {}),
      tabId: e.tabId,
      tabName: e.tabName,
      // The ledger keeps the column for older readers; herdr-core has no workspace identity.
      workspaceId: '',
      cwd: e.cwd,
      description: e.description,
      sessionFile: e.sessionFile,
      launchCommand: e.launchCommand,
      status: e.status,
      outcome,
      createdAt: e.createdAt,
      consumedAt: e.consumedAt ?? null,
      closedAt: null,
      revivedFrom: e.revivedFrom ?? null,
      ...(e.worktree ? { worktree: e.worktree } : {}),
    };
  }

  function writeHistory(e: SubEntry, patch?: Partial<HistoryEntry>, via?: string, ledgerCwd?: string): void {
    const outcome = inheritOutcome(lastOutcomeByTask.get(e.taskId), patch?.outcome);
    if (typeof outcome === 'string' && outcome.length > 0) lastOutcomeByTask.set(e.taskId, outcome);
    appendLedger(ledgerCwd ?? e.cwd, { ...toHistory(e, outcome), ...(patch ?? {}), ...(via ? { via } : {}) });
  }

  const registry = createSubagentRegistry({ pi, client, subs, writeHistory });
  const { persist: persistSubs } = registry;
  const git = createGitIo();
  const worktree = d.worktreeIo ?? createWorktreeIo();

  /** S54/S71: a role-declared one-shot reclaims its pane and the checkout its spawn created. */
  function reclaim(entry: SubEntry): void {
    void (async () => {
      if (entry.worktree) {
        // S72: the ledger row outlives the checkout, so record that the space went with it — otherwise
        // the next start would report closing a space this reclaim already closed.
        const record = entry.worktree;
        const ledgerCwd = mainWorktreeRoot(entry.cwd) ?? entry.cwd;
        const released = await releaseCheckout(worktree, record).catch(() => null);
        if (released !== null && released.ok) {
          const spaceId = released.spaceError ? record.spaceId : null;
          writeHistory(entry, { worktree: { ...record, spaceId } }, 'one-shot-reclaim', ledgerCwd);
        }
      }
      await retirePane(client, entry.paneId);
    })();
  }

  const boundPort: SubagentPort = {
    applyReplySession(paneId, sessionFile) {
      const entry = subs.get(paneId);
      if (!entry) return;
      // Workers self-report a BARE session id over the pipe; the .jsonl-only guard in applyReportedSessionFile
      // would discard it and freeze a mis-attributed sessionFile forever, so map the id to its transcript path.
      const reported = resolveSessionFileValue(entry.cwd, defaultAgentSessionsDir(), sessionFile);
      const next = applyReportedSessionFile(entry.sessionFile, reported);
      if (next === entry.sessionFile) return;
      entry.sessionFile = next;
      persistSubs();
      writeHistory(entry, undefined, 'session-report');
    },
    listRunningSubs() {
      return [...subs.values()]
        .filter((s) => s.status === 'running')
        .map((s): WorkerWidgetRow => ({
          paneId: s.paneId,
          slug: s.slug,
          role: s.kind,
          state: s.status,
          startedAt: s.createdAt,
          description: s.description,
        }));
    },
    listRows() {
      return [...subs.values()]
        .filter((s) => s.status !== 'closed')
        .map((s) => ({
          paneId: s.paneId,
          slug: s.slug,
          description: s.description,
          kind: s.kind,
          status: s.status,
          settledAt: s.consumedAt ?? null,
        }));
    },
    settlementCard(paneId, outcome) {
      const entry = subs.get(paneId);
      return settlementCard({
        name: entry ? `${paneId} (${entry.description})` : paneId,
        ...(entry ? { kind: entry.kind, startedAt: entry.createdAt } : {}),
        outcome,
      });
    },
    consumeReply(paneId, outcome) {
      const entry = subs.get(paneId);
      if (!entry || entry.status === 'consumed' || entry.status === 'closed') return;
      entry.status = 'consumed';
      entry.consumedAt = Date.now();
      persistSubs();
      writeHistory(entry, { outcome: outcome ?? null, status: 'consumed' }, 'pipe-reply');
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
  const spawn = createSpawner({ client, env, runtime, git });
  const poller = createPoller({
    client,
    sessionRoot,
    subs,
    persistSubs,
    writeHistory,
    blockedGateNotified,
    session,
    injectNotice,
    claimSettleNotice: d.claimSettleNotice,
    reclaim,
  });
  const { startPoller, pollers } = poller;
  const gc = createGcController({
    client,
    env,
    subs,
    persistSubs,
    writeHistory,
    terminalState,
    noticePending: d.noticePending,
  });
  gc.startTicker(ctx);
  scoped.on('turn_start', () => gc.onTurnStart());
  const { readAskFlag, probeAlive } = session;
  const { spawnPaneInTaskTab, launchParts, approveFor, waitSubReady, findExistingPane } = spawn;

  /** P0-2: re-arm pollers for live running panes after a master restart, or settle notices stop arriving
   * and ledger rows stay 'running'. The `recover-*` requestId is never echoed by a worker, so this claim wins. */
  async function recoverRunningPollers(via: string): Promise<void> {
    if (!client.available) return;
    const running = [...subs.values()].filter((s) => s.status === 'running' && !pollers.has(s.paneId));
    if (running.length === 0) return;
    let liveTerminalIds: ReadonlySet<string>;
    try {
      liveTerminalIds = new Set((await client.listTerminals()).map((terminal) => terminal.id));
    } catch {
      return; // liveness lookup failed → do not guess
    }
    const recovered: string[] = [];
    for (const entry of running) {
      if (!liveTerminalIds.has(entry.paneId)) continue; // zombie sweep already closed those
      try {
        await startPoller(entry.paneId, entry.cwd, entry.createdAt, entry.description, `recover-${via}-${entry.paneId}`);
        recovered.push(`${entry.paneId} (${entry.description})`);
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

  /**
   * S72: a master session closes the spaces its own past left behind. The ledger row is the whole
   * input, so nothing is listed, pattern-matched or read out of the app's internal state, and only
   * the exact recorded `spaceId` is closed. A start with nothing to do says nothing; an app that
   * cannot be reached is reported, never raised (S43).
   */
  async function reconcilePast(eventCtx: unknown): Promise<void> {
    // Without the session's cwd there is no way to know which repository's ledger is meant, and
    // guessing would sweep a checkout this master is not running in.
    const cwd = (eventCtx as { cwd?: string } | null)?.cwd;
    if (!cwd) return;
    try {
      const outcomes = await reconcileCheckouts(worktree, readLedger(cwd));
      if (outcomes.length === 0) return;
      for (const o of outcomes) {
        // A space that was closed is gone for good: record it in the shape `close` writes, so the
        // next start finds nothing to do. One that would not close keeps its id, for that attempt.
        if (o.kind !== 'closed' || o.spaceError !== null) continue;
        appendLedger(cwd, {
          ...o.row,
          status: 'closed',
          closedAt: Date.now(),
          worktree: { ...o.record, spaceId: null },
          via: 'reconcile',
        });
      }
      try {
        await injectNotice(reconcileLines(outcomes).join('\n'));
      } catch { /* a missed notice must not fail the start */ }
    } catch (err) {
      swallow('subagent.reconcile', err);
    }
  }

  scoped.on('session_start', async (_event: unknown, eventCtx: unknown) => {
    registry.rebuild(eventCtx);
    await registry.sweepZombieRunning();
    await recoverRunningPollers('session_start');
    await reconcilePast(eventCtx);
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    registry.rebuild(eventCtx);
    await registry.sweepZombieRunning();
    await recoverRunningPollers('session_tree');
  });

  /** A failing subagent call must not read as a dead worker: probe liveness first, so the model
   * stops seizing work from a healthy subagent. */
  scoped.on('tool_result', async (rawEvent: unknown) => {
    const event = (rawEvent ?? {}) as { toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
    if (event.toolName !== 'subagent' || !event.isError) return;
    // Extract only ids of rows we know; leave unrelated errors untouched.
    const errText = (event.content ?? []).map((c) => c.text ?? '').join(' ');
    const paneId = [...subs.keys()].find((id) => errText.includes(id));
    if (!paneId) return;
    const entry = subs.get(paneId);
    if (!entry || entry.status === 'settled' || entry.status === 'consumed') return;
    const probe = await probeAlive(paneId, entry.cwd);
    if (!isAlive(probe, Date.now())) return; // keep the original error only when the agent is truly dead
    // Move a live agent to the poller so its eventual result replaces the false error.
    if (!pollers.has(paneId)) {
      startPoller(paneId, entry.cwd, entry.createdAt, entry.description, lastRequestIdByPane.get(paneId) ?? `probe-${paneId}`);
      persistSubs();
    }
    return {
      content: [{ type: 'text', text: buildAliveNotice({ paneId, description: entry.description, probe }, Date.now()) }],
    };
  });

  async function reviveEntry(entry: SubEntry): Promise<SubEntry> {
    const latest = latestGeneration(readLedger(entry.cwd), entry.taskId) ?? entry;
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
    // one jsonl): a mis-attributed ledger entry degrades to a fresh conversation instead.
    const resumeFile = latest.sessionFile && /\.jsonl$/.test(latest.sessionFile)
      && bareSessionId(latest.sessionFile) !== bareSessionId(d.getSessionId())
      ? latest.sessionFile : null;
    // D86 trust matches spawn; revive has no tool context, so use the process cwd.
    const approve = await approveFor(entry.cwd, process.cwd());
    const argv = launchParts(resumeFile, null, null, approve);
    const lifecycle = roleLifecycle(entry.kind);
    // Admission, not readiness: the slot is held only while the pane is created, so a revive still
    // waiting for its pipe cannot starve a spawn (S50). The wait below runs outside the slot.
    const spawned = await withAdmission(subSemaphore, () => spawnPaneInTaskTab(
      {
        desiredTab: entry.tabName || latest.tabName || null,
        description: entry.description,
        spaceId: (latest.worktree ?? entry.worktree)?.spaceId ?? null,
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
    Object.assign(entry, {
      paneId: spawned.paneId,
      tabId: spawned.tabId,
      tabName: spawned.tabName,
      sessionFile: resumeFile,
      status: 'running' as const,
      consumedAt: null,
      revivedFrom: latest.paneId,
      launchCommand: [buildLaunchLine(argv)],
      createdAt: Date.now(),
    });
    // A revived row is reclaimed at settlement too when its role still declares one-shot (S54).
    if (lifecycle === 'one-shot') entry.lifecycle = 'one-shot';
    else delete entry.lifecycle;
    writeHistory(entry, undefined, 'revive');
    return entry;
  }

  /** Rebuild a registry row from its latest ledger row; `over` carries the caller's own fields
   *  (status, pane identity, timestamps) so the ledger projection cannot drift between callers. */
  function entryFromHistory(h: HistoryEntry, over: Partial<SubEntry>): SubEntry {
    return {
      taskId: h.taskId,
      kind: h.kind,
      paneId: h.paneId,
      ...(h.slug ? { slug: h.slug } : {}),
      tabId: h.tabId,
      tabName: h.tabName ?? '',
      cwd: h.cwd,
      description: h.description,
      status: 'closed',
      sessionFile: h.sessionFile,
      launchCommand: h.launchCommand,
      createdAt: h.createdAt,
      consumedAt: h.consumedAt ?? null,
      revivedFrom: h.paneId,
      ...(h.worktree ? { worktree: h.worktree } : {}),
      ...over,
    };
  }

  function resolveSubEntry(rawId: string, cwd?: string): { entry: SubEntry } | { error: string } {
    if (!rawId) return { error: 'Error: unknown subagent id "" (see action list)' };
    const direct = subs.get(rawId);
    if (direct) return { entry: direct };
    // Phase 2 slug reference: exact match against live rows (paneId stays first for back-compat).
    // `slug@paneId` accepts both parts; a revived row changed its paneId, so the slug part wins then.
    const at = rawId.indexOf('@');
    const slugPart = at > 0 ? rawId.slice(0, at) : rawId;
    const panePart = at > 0 ? rawId.slice(at + 1) : null;
    const combined = panePart !== null
      ? (subs.get(panePart) ?? [...subs.values()].find((s) => s.slug === slugPart && s.paneId === panePart) ?? null)
      : null;
    if (combined) return { entry: combined };
    const bySlug = [...subs.values()].find((s) => s.slug === slugPart);
    if (bySlug) return { entry: bySlug };

    const byTaskId = newestPerTaskId(subs.values());
    const res = resolveTaskIdPrefix(rawId, byTaskId.keys());
    if (res.kind === 'resolved') return { entry: byTaskId.get(res.taskId)! };
    const resError = taskIdResolutionError(res, 'subagent id', rawId);
    if (resError) return { error: resError };

    if (cwd) {
      const hist = readLedger(cwd);
      const histRes = resolveTaskIdPrefix(rawId, Array.from(new Set(hist.map((e) => e.taskId))));
      if (histRes.kind === 'resolved') {
        const latest = latestGeneration(hist, histRes.taskId);
        if (latest) {
          const entry = entryFromHistory(latest, {});
          subs.set(entry.paneId, entry);
          return { entry };
        }
      }
      const histError = taskIdResolutionError(histRes, 'subagent id', rawId);
      if (histError) return { error: histError };
    }
    return { error: `Error: unknown subagent id "${rawId}" (see action list)` };
  }

  function targetOf(params: ToolParams, toolCtx: unknown): { entry: SubEntry; cwd: string } {
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const resolved = resolveSubEntry(idParam(params, 'agentId', 'taskId'), cwd);
    if ('error' in resolved) toolError(resolved.error);
    return { entry: resolved.entry, cwd };
  }

  async function ensureLive(entry: SubEntry): Promise<void> {
    if (entry.status !== 'closed') return;
    const previousPaneId = entry.paneId;
    await reviveEntry(entry);
    rekeySub(subs, previousPaneId, entry);
    persistSubs();
  }

  async function executeSubagentResume(params: ToolParams, toolCtx: unknown) {
    if (!client.available) return toolError('requires a herdr-core terminal.');
    const rawTaskId = idParam(params, 'taskId', 'agentId');
    if (!rawTaskId) return toolError('missing taskId for resume (see action list or delegation ledger).');
    const running = newestPerTaskId([...subs.values()].filter((s) => s.status === 'running'));
    const live = resolveTaskIdPrefix(rawTaskId, running.keys());
    const liveError = taskIdResolutionError(live, 'task id', rawTaskId);
    if (liveError) return toolError(liveError);
    if (live.kind === 'resolved') {
      const entry = running.get(live.taskId)!;
      return {
        content: [{ type: 'text', text: `task ${entry.taskId} is already running as pane ${entry.paneId}. Use action send or output; resume is only for a collected task whose pane is gone.` }],
        details: { paneId: entry.paneId, taskId: entry.taskId, alreadyRunning: true },
      };
    }
    // S41: one ledger per repository, so resume resolves against the current one — never a sweep of
    // other checkouts this master happened to spawn into.
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const ledger = ledgerFile(cwd);
    if (ledger === null) {
      return toolError(
        `resume needs a git repository: the delegation ledger lives inside the repository (<repo>/.piher/history/history.jsonl) and ${cwd} is not in one.`,
      );
    }
    const history = readLedger(cwd);
    const resolution = resolveTaskIdPrefix(rawTaskId, history.map((e) => e.taskId));
    if (resolution.kind !== 'resolved') {
      return toolError(taskIdResolutionError(resolution, 'task id', rawTaskId)
        ?? `Error: no history for task "${rawTaskId}" in this repository's ledger (${ledger}).`);
    }
    const taskId = resolution.taskId;
    const latest = latestGeneration(history, taskId);
    if (!latest) return toolError(`Error: no history for task "${taskId}" in this repository's ledger (${ledger}).`);

    try {
      // D94: reuse an existing pane for the same session to avoid competing pi processes.
      const existing = await findExistingPane(latest.sessionFile);
      // A ledger sessionFile mis-attributed to the master's own transcript would match the MASTER terminal here,
      // registering the master as its own subagent (later consumed, then closed by GC mid-run) — never adopt self.
      if (existing?.paneId === env?.terminalId) {
        return toolError(
          `Error: task ${taskId} is attributed to the master's own session (mis-recorded sessionFile in the ledger); it cannot be resumed here — spawn a fresh subagent for this work instead.`,
        );
      }
      const entry = entryFromHistory(latest, {
        paneId: existing?.paneId ?? '',
        tabId: existing?.tabId ?? '',
        tabName: latest.tabName ?? tabNameForTask(latest.description),
        status: 'running',
        createdAt: Date.now(),
        consumedAt: null,
      });
      if (existing) {
        subs.set(entry.paneId, entry);
        persistSubs();
        writeHistory(entry, undefined, 'resume');
      } else {
        await reviveEntry(entry);
        subs.set(entry.paneId, entry);
        persistSubs();
      }
      const how = existing
        ? 'reused existing pane with same session; pi still running there'
        : entry.sessionFile ? 'session restored' : 'session file missing; fresh conversation';
      return {
        content: [{ type: 'text', text: `resumed subagent ${subRef(entry)} from task ${taskId} (${how}).` }],
        details: { paneId: entry.paneId, taskId },
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
    entry: SubEntry,
    opts: {
      /** One request from the closed pipe protocol; its `type`/`id` drive the reply and settle keys. */
      build(): PipeRequest;
      ok(res: Extract<PipeResponse, { type: 'ok' }>, reqId: string): unknown;
      fail?(paneId: string): string;
      ready?: false;
    },
  ): Promise<unknown> {
    try {
      if (opts.ready !== false) {
        // A just-spawned worker is still booting: its prompt must reach it before any follow-up.
        await boots.get(entry.paneId);
        await ensureLive(entry);
        const ready = await waitSubReady(entry.cwd, entry.paneId);
        if (!ready.ok) throw new Error(ready.message);
      }
      const payload = opts.build();
      const res = await pipeRequestTo(entry.cwd, entry.paneId, payload);
      if (res.type !== 'ok') {
        throw new Error(`pipe ${payload.type} rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
      }
      return opts.ok(res, payload.id);
    } catch (err) {
      const what = opts.fail?.(entry.paneId) ?? `failed to reach subagent ${entry.paneId}`;
      return toolError(`Error: ${what}: ${(err as Error).message}`);
    }
  }

  /** Follow_up goes through the extension pipe with steering so supplemental instructions reach a
   * long-running worker within seconds during a tool-call gap; a plain queue waits for the run. */
  function executeSubagentSend(params: ToolParams, toolCtx: unknown) {
    const { entry, cwd } = targetOf(params, toolCtx);
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
        // An exception between status='running' and startPoller would leave a ghost running entry
        // with no poller (never settles, skipped by GC): roll back the status on failure.
        const prevStatus = entry.status;
        entry.status = 'running';
        persistSubs();
        try {
          lastRequestIdByPane.set(entry.paneId, reqId);
          startPoller(entry.paneId, entry.cwd, Date.now(), entry.description, reqId);
        } catch (inner) {
          entry.status = prevStatus;
          persistSubs();
          throw inner;
        }
        return { content: [{ type: 'text', text: `Message sent to subagent ${subRef(entry)}.` }], details: { paneId: entry.paneId } };
      },
    });
  }

  async function executeSubagentInterrupt(params: ToolParams, toolCtx: unknown) {
    const { entry } = targetOf(params, toolCtx);
    // Interrupt stops the current turn and nothing else, so a worker with no turn in flight has
    // nothing to stop. Both refusals name the way back: a no-op that also hides `resume` reads as
    // success and strands the caller.
    if (entry.status === 'closed') {
      return toolError(
        `Error: subagent ${subRef(entry)} is closed — its pane and tab are gone, so there is no turn to interrupt. action "resume" with taskId ${entry.taskId} revives its session in a new pane.`,
      );
    }
    if (entry.status !== 'running') {
      return toolError(
        `Error: subagent ${subRef(entry)} has no running turn (status: ${entry.status}) — interrupt stops the current turn only, and this worker already finished its last one. Send it a follow-up with action "send" if its pane is still listed, or revive it with action "resume" and taskId ${entry.taskId}.`,
      );
    }
    return pipeAction(entry, {
      ready: false,
      build: () => ({ type: 'interrupt', id: `int-${Date.now()}` }),
      ok: () => {
        // No settlement notice for an interrupted turn: the requester already knows.
        const lastId = lastRequestIdByPane.get(entry.paneId);
        if (lastId) d.claimSettleNotice(`${entry.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${subRef(entry)} (fire-and-return).` }], details: { paneId: entry.paneId } };
      },
    });
  }

  /** S53: reclaim a worker that already finished. `close` is not `cancel`: a worker that is still
   *  running is refused with a pointer at `interrupt`, because a task must not vanish without a report. */
  async function executeSubagentClose(params: ToolParams, toolCtx: unknown) {
    const { entry } = targetOf(params, toolCtx);
    if (entry.status === 'running') {
      return toolError(
        `Error: subagent ${subRef(entry)} is still running — close only reclaims a worker that already finished, and a task must not disappear without a report. Use action "interrupt" to stop its current turn (the pane and its session stay), then close it once it settles.`,
      );
    }
    if (entry.status === 'closed') {
      return {
        content: [{ type: 'text', text: `Subagent ${subRef(entry)} is already closed (pane and tab gone); action resume with taskId ${entry.taskId} revives its session.` }],
        details: { paneId: entry.paneId, taskId: entry.taskId, alreadyClosed: true },
      };
    }
    if (!client.available) return toolError('requires a herdr-core terminal.');
    // S71: close is terminal for what piher created. The checkout goes first, because a dirty one is
    // a refusal that must leave the worker reachable and the space as it was. The ledger row is
    // written through the repository root, since the checkout it records is about to disappear.
    const ledgerCwd = mainWorktreeRoot(entry.cwd) ?? entry.cwd;
    let checkoutLine = '';
    if (entry.worktree) {
      const released = await releaseCheckout(worktree, entry.worktree);
      if (!released.ok) return toolError(released.text);
      checkoutLine = ` ${releasedCheckoutLine(entry.worktree, released.removed, released.spaceError)};`;
      // A space that was closed is gone for good; one that could not be closed keeps its id so a
      // revived generation can still end it.
      entry.worktree = { ...entry.worktree, spaceId: released.spaceError ? entry.worktree.spaceId : null };
    }
    await retirePane(client, entry.paneId);
    entry.status = 'closed';
    persistSubs();
    // The ledger row survives the pane: `resume` revives from it, so the session is not lost.
    writeHistory(entry, { status: 'closed', closedAt: Date.now() }, 'close', ledgerCwd);
    return {
      content: [{ type: 'text', text: `Subagent ${subRef(entry)} closed — pane and tab gone;${checkoutLine} action resume with taskId ${entry.taskId} brings its session back.` }],
      details: { paneId: entry.paneId, taskId: entry.taskId },
    };
  }

  async function executeSubagentRole(params: ToolParams, toolCtx: unknown) {
    const roleName = String(params?.role ?? '').trim();
    if (!roleName) return toolError('Error: action "role" requires a target profile in `role` (same resolution as spawn)');
    const { entry } = targetOf(params, toolCtx);
    return pipeAction(entry, {
      fail: (id) => `failed to switch subagent ${id} to role ${roleName}`,
      build: () => ({ type: 'role', id: `role-${Date.now()}`, role: roleName }),
      ok: (res) => ({
        content: [{ type: 'text', text: `Subagent ${entry.paneId}: ${res.detail ?? `switched to ${roleName}`}` }],
        details: { paneId: entry.paneId, role: roleName },
      }),
    });
  }

  /** Live registry, newest row per task; closed rows stay visible so send can revive them. A task
   *  the bounded registry already pruned answers from the repository ledger, which keeps every row. */
  async function executeSubagentList(toolCtx: unknown) {
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const byTask = newestPerTaskId([...subs.values()]);
    const registered = new Set(byTask.keys());
    for (const row of readLedger(cwd)) {
      if (registered.has(row.taskId)) continue;
      const prev = byTask.get(row.taskId);
      if (prev && prev.createdAt >= (row.createdAt ?? 0)) continue;
      byTask.set(row.taskId, entryFromHistory(row, {}));
    }
    if (byTask.size === 0) {
      return { content: [{ type: 'text', text: 'No subagents started (from this session branch).' }], details: {} };
    }
    const probes = new Map<string, AliveProbe>();
    await Promise.all([...byTask.values()].map(async (sub) => {
      if (sub.status === 'closed') return;
      try {
        probes.set(sub.paneId, await probeAlive(sub.paneId, sub.cwd));
      } catch { /* best effort for display */ }
    }));
    const now = Date.now();
    const lines: string[] = [];
    for (const sub of byTask.values()) {
      const tabTag = sub.tabName ? ` [tab: ${sub.tabName}]` : '';
      if (sub.status === 'closed') {
        lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; action send revives)${tabTag} ${sub.description}`);
        continue;
      }
      if (sub.status === 'consumed' || sub.status === 'settled') {
        lines.push(`${subRef(sub)} [idle] (${sub.kind}, settled; action send revives)${tabTag} ${sub.description}`);
        continue;
      }
      const state = 'running';
      const probe = probes.get(sub.paneId);
      const statusTag = probe?.agentStatus ? ` ${probe.agentStatus}` : '';
      const activityTag = probe?.lastActivityMs != null ? `, active ${agoText(probe.lastActivityMs, now)}` : '';
      let gateTag = '';
      if (probe?.agentStatus === 'blocked') {
        const question = await readAskFlag(sub.paneId);
        gateTag = question ? ` — AWAITING HUMAN: "${question}"` : ' — AWAITING HUMAN decision';
      }
      lines.push(`${subRef(sub)} [${state}${statusTag}${activityTag}${gateTag}] (${sub.kind})${tabTag} ${sub.description}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
  }

  const executeSubagentSpawn = createSpawnAction({
    client,
    env,
    subSemaphore,
    subs,
    persistSubs,
    writeHistory,
    lastRequestIdByPane,
    boots,
    notifySpawnFailed: injectNotice,
    git,
    worktree,
    session,
    spawn,
    poller,
    getSessionId: d.getSessionId,
  });

  const outputActionDeps = {
    client,
    resolveEntry: (rawId: string, cwd: string) => resolveSubEntry(rawId, cwd),
    outputCursors,
    nextRevision: (paneId: string): number => {
      const next = (outputRevisions.get(paneId) ?? 0) + 1;
      outputRevisions.set(paneId, next);
      return next;
    },
    getCwd: (toolCtx: unknown): string => (toolCtx as { cwd?: string })?.cwd ?? process.cwd(),
    // Transcript fallback: small worker panes show only the opaque status overlay, so the pane delta can never
    // carry the final report. No preferred file — start from the worker's `piher.session` label, not a stale registry value.
    readFinalReport: async (paneId: string, entryCwd: string) =>
      (await session.subSessionState(paneId, entryCwd, 0)).text,
    persistSubs,
  };

  const ACTIONS: Record<string, (params: ToolParams, toolCtx: unknown, onUpdate?: (u: unknown) => void) => Promise<unknown>> = {
    spawn: (params, toolCtx) => executeSubagentSpawn(params, toolCtx),
    resume: (params, toolCtx) => executeSubagentResume(params, toolCtx),
    list: (_params, toolCtx) => executeSubagentList(toolCtx),
    send: (params, toolCtx) => executeSubagentSend(params, toolCtx),
    interrupt: (params, toolCtx) => executeSubagentInterrupt(params, toolCtx),
    output: (params, toolCtx) => executeSubagentOutput(params, toolCtx, outputActionDeps),
    role: (params, toolCtx) => executeSubagentRole(params, toolCtx),
    close: (params, toolCtx) => executeSubagentClose(params, toolCtx),
    help: async () => ({ content: [{ type: 'text', text: SUBAGENT_MANUAL }], details: {} }),
  };

  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    // B4: the model picks tools from the system prompt's snippet/guideline surface; delegation
    // decisions are made here, so state them rather than hoping for recall.
    promptSnippet: 'subagent: delegate a self-contained task to a pi worker pane (spawn/send/output/interrupt/resume/list/role/close/help).',
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
        Type.Literal('interrupt'),
        Type.Literal('output'),
        Type.Literal('role'),
        Type.Literal('close'),
        Type.Literal('help'),
      ], { description: 'Default spawn' })),
      description: Type.Optional(Type.String({ description: '[spawn] Pane label' })),
      prompt: Type.Optional(Type.String({ description: '[spawn] The complete self-contained task' })),
      cwd: Type.Optional(Type.String({ description: '[spawn] Existing directory or worktree to run in (absolute or workspace-relative)' })),
      worktree: Type.Optional(Type.String({ description: '[spawn] Name of a checkout piher creates for the worker (branch of the same name); mutually exclusive with cwd' })),
      role: Type.Optional(Type.String({ description: '[spawn|role] Role profile name; unknown names are display labels only' })),
      tab: Type.Optional(Type.String({ description: '[spawn] Task tab to join or create (default: grouped by worktree)' })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: '[spawn] Extra tools on top of the role baseline' })),
      taskId: Type.Optional(Type.String({ description: '[resume] Task id from the delegation ledger' })),
      agentId: Type.Optional(Type.String({ description: '[send|interrupt|output|role|close] Slug, pane id, or slug@paneId as printed by spawn/list' })),
      message: Type.Optional(Type.String({ description: '[send] Follow-up message' })),
      max_chars: Type.Optional(Type.Integer({ description: '[output] Output cap (default 6000, 100-16000)' })),
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
