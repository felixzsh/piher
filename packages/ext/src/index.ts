/**
 * piher extension entry point and composition root.
 *
 * Layout: index-runtime.ts picks the process mode (worker / bare pi / herdr master);
 * index-roles.ts the role runtime, index-pipe.ts the pipe protocol handler, index-notices.ts the
 * notice buffer, index-locks.ts write locks;
 * index-master.ts is the dynamic master mount.
 *
 * pi contract: onUpdate must have AgentToolResult shape (a string crashes the TUI); tool-result
 * details persist in session JSONL and getBranch() replay implements branch rollback.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  closePipeServer, ownsPipe, pipeNameFor, pipePathFor, pipeRequest, releasePipe, startPipeServer, takeOverPipe,
} from './pipe-channel.ts';
import { installRenderers } from './renderers.ts';
import { SETTLEMENT_CUSTOM_TYPE, sendSettlementNotice } from './settlement-card.ts';
import { createCoreClient } from './core-client.ts';
import type { DocWatch } from './core-client.ts';
import { bareSessionId, readSessionFile, readTurnClosing, resolveSessionFileValue } from './session-tail.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { platformPaths } from './platform-paths.ts';
import { WRITE_LOCK_ENV } from './lock-core.ts';
import { ABORT_STOP_REASON, planSettleWake, shouldPushSettleReply } from './settle-wake-core.ts';
import { writeReportDocument } from './report-documents.ts';
import { commandDocName } from './report-documents.ts';
import { clearCommandDocument, planCommandApplication } from './command-documents.ts';
import { parseRuntimeManifest } from './tool-gate.ts';
import { planIndexMode } from './index-runtime.ts';
import { emptySubagentPortBox, sleepWhileSubsRunningNote } from './subagent-core.ts';
import { writeWorkerMarker, readWorkerMarker } from './worker-marker.ts';
import {
  DELEGATION_CUSTOM_TYPE,
  buildDelegationSection,
  foldDelegation,
  parseDelegationContext,
  type DelegationContext,
} from './delegation-core.ts';
import { widgetLines } from './tree-view.ts';
import { createNoticeBuffer } from './index-notices.ts';
import { handlePipeRequest, type MachineRequest } from './index-pipe.ts';
import { installWriteLocks } from './index-locks.ts';
import { installConfigCommand } from './config-command.ts';
import { composeMasterRuntime, createRoleRuntime } from './index-roles.ts';

/** How often a worker re-checks that its own socket path still exists (see watchPipePath). */
const PIPE_WATCHDOG_MS = 10_000;

function agentSessionsDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, 'sessions') : platformPaths.sessionsDir;
}

export default async function (pi: ExtensionAPI) {
  const mode = planIndexMode();
  const isSubagent = mode.isSubagent;
  const roleBase = process.env.PIHER_ROLE_BASE || process.cwd();

  let sessionId: string = process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '';
  /** The transcript path pi itself reports for this session, cached at session_start. The settle push
   *  must read it, and re-deriving it from the bare id failed in a live worker (`hasFile=false`), which
   *  silently disabled the instant reply and left every settlement to the master's poller. */
  let ownSessionFile: string | null = null;
  const { client, env } = createCoreClient();
  /** RFC rfc-delegation-identity §2.1: resolved env → marker → branch fold; worker panes only. */
  let delegation: DelegationContext | null = parseDelegationContext(process.env.PIHER_DELEGATION);
  /** The transcript path core reports, cached at session start: piher's per-session state root
   *  (`piher/<id>/`) hangs off its directory, and re-deriving it by scanning the session dir fails
   *  before the file exists — which is exactly when `session_start` fires. */
  let ownSessionPath: string | null = null;
  const initialManifest =
    parseRuntimeManifest(process.env.PIHER_ROLE_MANIFEST) ??
    (mode.composeMaster ? composeMasterRuntime() : null);

  const roles = createRoleRuntime({ pi, roleBase, initialManifest, isSubagent });

  const rendererTypes = installRenderers(pi);
  /** A card is only worth sending when this host could register its renderer. */
  const cardsRendered = rendererTypes.includes(SETTLEMENT_CUSTOM_TYPE);

  let agentActive = false;
  let lastStopReason: string | null = null;
  let latestCtx: { abort?: () => void } | null = null;
  const subagentPort = emptySubagentPortBox();
  let d96NoticeKey: string | null = null;
  let d96NoticeAt = 0;

  /** Session identity: sessionManager is authoritative (env may be unset in print/RPC mode). */
  function reportedSessionFile(ctx: unknown): string | null {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
      return sm?.getSessionFile?.() ?? null;
    } catch {
      return null;
    }
  }

  function resolveSessionId(ctx: unknown): string {
    try {
      const sm = (ctx as {
        sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string };
      }).sessionManager;
      return bareSessionId(
        sm?.getSessionFile?.() ?? sm?.getSessionId?.() ?? process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '',
      );
    } catch {
      return bareSessionId(process.env.PI_SESSION_FILE ?? '');
    }
  }

  /** The resident widget carries one line per running subagent, and is removed when none runs. */
  function renderWorkerWidget(ctx: unknown): void {
    if (!mode.composeMaster) return;
    const ui = (ctx as { ui?: { setWidget?: (id: string, lines: string[] | undefined) => void } } | null | undefined)?.ui;
    const lines = widgetLines(subagentPort.current?.listRunningSubs() ?? [], Date.now());
    try {
      // pi keeps an empty array as an empty widget (a stray blank line above the editor); undefined
      // is the documented way to remove one.
      ui?.setWidget?.('piher-agents', lines.length > 0 ? lines : undefined);
    } catch {
      /* Older pi builds may omit widget support. */
    }
  }

  /** The widget is a view of the tasks, so a turn boundary or a settlement repaints it. */
  function repaintAgentViews(ctx: unknown): void {
    renderWorkerWidget(ctx);
  }

  /** Tool names by call id: the end event may omit the name the tools ledger records. */
  const runningTools = new Map<string, string>();
  pi.on('tool_execution_start', async (event: { toolCallId?: string; toolName?: string }) => {
    if (typeof event?.toolCallId === 'string' && typeof event?.toolName === 'string') runningTools.set(event.toolCallId, event.toolName);
  });

  /* ── Masters sleep-polled background workers (sleep 120…840) instead of trusting the settlement notice. ── */
  if (!isSubagent) {
    pi.on('tool_result', async (event: unknown) => {
      const rec = (event ?? {}) as { toolName?: unknown; input?: { command?: unknown }; content?: unknown };
      if (rec.toolName !== 'bash' || typeof rec.input?.command !== 'string') return;
      const note = sleepWhileSubsRunningNote(rec.input.command, subagentPort.current?.listRunningSubs() ?? []);
      if (!note) return;
      const content = Array.isArray(rec.content) ? rec.content as Array<{ type: 'text'; text: string }> : [];
      return { content: [...content, { type: 'text' as const, text: note }] };
    });
  }

  if (env) installWriteLocks(pi, { client, env, hard: process.env[WRITE_LOCK_ENV] === '1' });

  /** pi's sendUserMessage is fire-and-forget (void); callers of this wrapper get a promise that says
   *  whether pi actually took the message. A host without the method, or a throw from it, delivered
   *  nothing — and a caller that latched "applied" on that promise would never try again. */
  const sendUserMessageAs = (content: string, mode: 'steer' | 'followUp'): Promise<boolean> => {
    try {
      const api = pi as unknown as {
        sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => void;
      };
      if (typeof api.sendUserMessage !== 'function') return Promise.resolve(false);
      api.sendUserMessage(content, { deliverAs: mode, triggerTurn: true });
      return Promise.resolve(true);
    } catch (err) {
      console.error(`piher: pi refused a ${mode} message: ${(err as Error)?.message ?? err}`);
      return Promise.resolve(false);
    }
  };

  const notices = createNoticeBuffer({
    // pi core rejects prompts while the agent is mid-turn (and drops fire-and-forget sends), so a
    // settlement landing in that window must stay buffered until the run settles — otherwise the
    // result is lost with nobody left to retry it.
    isBusy: () => agentActive || lastStopReason === ABORT_STOP_REASON,
    send: (content, mode, card) => sendSettlementNotice(pi, {
      content,
      mode,
      ...(card ? { card } : {}),
      cardsRendered,
    }),
  });
  const deliverNotice = notices.deliverNotice;

  /* ── pipe channel: this pane's NDJSON server + the settle fast-path push (D48/D49/D50) ── */
  const pipeServerBox: { current: ReturnType<typeof startPipeServer> | null } = { current: null };
  let pipeWatchdog: ReturnType<typeof setInterval> | null = null;
  /** This instance's ownership generation for the pane's channel (see takeOverPipe). */
  let pipeGeneration = 0;
  let pendingMachineRequest: MachineRequest | null = null;
  /** Dedup latch for settle notices: one per paneId+request id per round. */
  const settleNoticeLatch = new Set<string>();
  function claimSettleNotice(key: string): boolean {
    if (settleNoticeLatch.has(key)) return false;
    settleNoticeLatch.add(key);
    return true;
  }

  async function startPipeServerFor(cwd: string): Promise<void> {
    const paneId = env?.terminalId ?? '';
    if (!paneId) {
      // No address means no channel: every follow-up to this pane is undeliverable, which is worth
      // saying out loud rather than discovering as a 90 s timeout on the other side.
      return;
    }
    const name = pipeNameFor(cwd, paneId);
    const path = pipePathFor(name);
    // Exactly one server per pane, whoever else is in this process. Taking ownership closes the
    // previous holder first — our own server on a rebind, or a second copy of this extension loaded in
    // the same pane (an installed package plus the spawner's `-e`). Binding before that close would let
    // libuv delete the new entry; leaving the previous holder alive would let a stale ctx answer.
    const generation = await takeOverPipe(paneId, async () => {
      const mine = pipeServerBox.current;
      pipeServerBox.current = null;
      if (pipeWatchdog) clearInterval(pipeWatchdog);
      pipeWatchdog = null;
      if (mine) await closePipeServer(mine);
    });
    pipeGeneration = generation;
    /** A bind failure is silent by construction (net.Server reports it on 'error'), so it is the one
     *  failure that used to leave a live worker unreachable with nothing in any log. */
    const bindFailed = (err: Error): void => {
      const code = (err as NodeJS.ErrnoException)?.code ?? null;
      void deliverNotice(
        `piher: this pane cannot receive follow-up messages — its pipe ${path} failed to bind`
        + `${code ? ` (${code})` : ''}. A master that sends to it will report the channel as dead.`,
        paneId,
        null,
      );
    };
    try {
      const server = startPipeServer(name, async (req) => handlePipeRequest(req, {
        paneId,
        port: subagentPort,
        claimSettleNotice,
        deliverNotice,
        sendUserMessageIn: (content) => sendUserMessageAs(content, 'followUp').then(() => undefined),
        sendUserMessageAs,
        abort: () => { latestCtx?.abort?.(); },
        setPendingMachineRequest: (next) => { pendingMachineRequest = next; },
      }), bindFailed);
      pipeServerBox.current = server;
      server.once('listening', () => {
        watchPipePath(cwd, path, paneId, generation);
      });
    } catch (err) {
      // A synchronous throw (path too long, permission) is the same outcome as a failed bind.
      bindFailed(err as Error);
    }
  }

  /** The path is a filesystem entry that a live listener does not own: anything that unlinks it (a
   *  stale pre-bind unlink from another instance, a tmp cleaner) leaves the socket open while every
   *  new connect() gets ENOENT — a worker that keeps working and cannot be reached. Nothing in the
   *  process notices, so this re-checks and rebinds. */
  function watchPipePath(cwd: string, path: string, paneId: string, generation: number): void {
    if (pipeWatchdog) clearInterval(pipeWatchdog);
    pipeWatchdog = setInterval(() => {
      // A channel someone else took over is not ours to heal, and healing it would start a tug of war.
      if (!ownsPipe(paneId, generation)) return;
      if (existsSync(path)) return;
      void startPipeServerFor(cwd);
    }, PIPE_WATCHDOG_MS);
    pipeWatchdog.unref?.();
  }

  /** The worker's own closing words: the finalized text, else the reason the turn ended without
   *  one (a refused tool, an error). Shared by the pipe push and the report document so the two
   *  can never disagree about whether the worker said anything: a turn that ended by token cap or
   *  abort still has words. A worker still thinking has neither, and its report stays withheld.
   *
   *  This reads the worker's OWN transcript for its OWN report; the master never derives settlement
   *  from a transcript (spec S5), so this is not a busywork copy of a master-side heuristic. */
  function ownClosing(sinceTs: number): { text: string | null; why: string | null; file: string | null } {
    const ownFile = ownSessionFile
      ?? (sessionId ? resolveSessionFileValue(process.cwd(), agentSessionsDir(), sessionId) : null);
    if (!ownFile) return { text: null, why: null, file: null };
    const entries = readSessionFile(ownFile);
    if (!entries) return { text: null, why: null, file: ownFile };
    const closing = readTurnClosing(entries, sinceTs);
    return { text: closing.text, why: closing.why, file: ownFile };
  }

  /** Everything one settle reports, resolved once: the closing words (or the reason the turn ended
   *  without any) and the core's turn. The push and the document read it from the same place, so
   *  they cannot disagree about which turn settled, and the turn costs one round trip instead of
   *  two. */
  type SettleReport = { text: string | null; why: string | null; file: string | null; turn: number | null };

  async function collectSettleReport(sinceTs: number): Promise<SettleReport> {
    const { text, why, file } = ownClosing(sinceTs);
    let turn: number | null = null;
    if (env?.terminalId) {
      try {
        turn = (await client.getTerminal(env.terminalId))?.turn ?? null;
      } catch {
        turn = null; // reported below; the push still carries the words
      }
    }
    return { text, why, file, turn };
  }

  /** Returns whether a settlement reply actually went out: a worker whose report never reached the
   *  master must not exit as if it had (S54 — the push comes first, the shutdown after).
   *
   *  Everything it decides on arrives in `input`, captured when the settle happened: the document is
   *  written before this runs, and `lastStopReason`/`pendingMachineRequest` are live state that a
   *  later turn (or a newer request) would have moved by then.
   *
   *  `docAt` is the `at` of the report document this reply settles, or null when no document was
   *  written. The master records it against the row, which is how a re-armed watch knows the report
   *  is already delivered (spec S7) — an identity, not a comparison of two clocks. */
  async function pushSettleReply(input: {
    aborted: boolean;
    turnStopReason: string | null;
    request: MachineRequest | null;
    report: SettleReport;
    docAt: number | null;
  }): Promise<boolean> {
    const { aborted, turnStopReason, request: req, report, docAt } = input;
    if (!req) {
      return false;
    }
    // An aborted settle is not a settlement: the closing message is still coming, and answering now
    // would burn the one-shot request + the parent's claim latch on a null-text reply ("left no
    // closing message") — the real closing message then never gets delivered. Keep the request armed.
    if (!shouldPushSettleReply({ aborted, lastStopReason: turnStopReason })) {
      return false;
    }
    // A newer request landed while this settlement's document was being written: the report answers
    // the request it settled, not that one.
    if (pendingMachineRequest !== req) {
      return false;
    }
    pendingMachineRequest = null;
    // A request with no requester pipe (a task the master handed over through the core, spec S14):
    // there is nobody to push to — the document written before this is the delivery (spec S6-S8).
    if (!req.from) {
      return false;
    }
    try {
      // A turn that ended with nothing to say but a reason — a refused tool, an error — must say
      // it: staying silent left the master waiting its whole silence budget for a report that was
      // never coming.
      const reportText = report.text ?? report.why ?? null;
      if (reportText === null) {
        return false;
      }
      await pipeRequest(req.from, {
        type: 'reply',
        id: req.id,
        paneId: env?.terminalId ?? '',
        text: reportText,
        // Push the resolved PATH when readable; fall back to the bare id for the master-side mapping.
        sessionFile: report.file ?? (sessionId || null),
        ...(docAt !== null ? { docAt } : {}),
      }, 5000);
    } catch (err) {
      /* The requester's pollLoop is the fallback; surface the dead letter for triage. */
      console.error(`piher: settle reply push to ${req.from} failed: ${(err as Error)?.message ?? err}`);
      return false;
    }
    return true;
  }

  /** P1 (spec S6, S8): write the settlement report document on every settle, whether or not the
   *  master asked — the pipe push above is gated on a pending request, which is the reason a
   *  master-side guess had to exist at all. Best effort like the push, but never silent: a write
   *  that could not land is logged with its reason, and the master still learns the report through
   *  the push (when one is pending) or the transcript fallback. */
  async function writeSettleDocument(input: {
    aborted: boolean;
    turnStopReason: string | null;
    report: SettleReport;
    hadRequest: boolean;
    /** The settlement's own `at`, minted by the caller so the push can name the document it settles. */
    at: number;
  }): Promise<boolean> {
    const { aborted, turnStopReason, report, hadRequest, at } = input;
    if (!isSubagent || !client.available || !env?.terminalId || !delegation) return false;
    if (!shouldPushSettleReply({ aborted, lastStopReason: turnStopReason })) return false;
    // A worker still thinking has no closing text and no reason: withhold like the pipe push.
    if (report.text === null && report.why === null) return false;
    if (report.turn === null) {
      console.error(`piher: settle document for ${env.terminalId} skipped: the core would not report its turn`);
      return false;
    }
    const written = await writeReportDocument(client, env.terminalId, {
      taskId: delegation.taskId,
      turn: report.turn,
      // A turn that ended without words states its reason here instead (spec S8): `stopReason`
      // alone would say "stop", which reads as a finished turn that had nothing to report.
      stopReason: report.text === null ? report.why : turnStopReason,
      session: report.file ?? (sessionId || null),
      text: report.text,
      at,
    });
    if (!written.ok) {
      console.error(`piher: settle document for ${env.terminalId} was not written: ${written.reason}`
        + (hadRequest
          ? ' (the pipe push carries the same report)'
          : ' (no request is pending: this settlement reaches the master through the transcript fallback)'));
      return false;
    }
    return true;
  }

  /* ── P3 (spec S15, S24): how a `send` reaches this worker ── */
  /** The command subscription. A second connection, because `events.subscribe` takes over the one it
   *  is sent on, and unfiltered, because a `doc` event is core-global (spec S24, S23). */
  let commandWatch: DocWatch | null = null;
  /** The id of the last command applied, so a re-read never applies the same one twice. */
  let appliedCommandId: string | null = null;
  /** Applies run one at a time: two notifications for one document must not both read it before it
   *  is cleared. */
  let commandApply: Promise<void> = Promise.resolve();

  /**
   * Read `piher.cmd.<address>` and apply what it holds (spec S15): pi's own
   * `sendUserMessage(text, {deliverAs})` is what keeps a steer delivered between tool calls instead
   * of behind the whole turn — `terminal.send` would only paste into the TUI.
   *
   * The value is cleared after it is applied, guarded by the version it was read at (spec S11): a
   * command left behind would be applied again by a restarted worker, which has no memory of ids.
   */
  async function applyCommandDocument(): Promise<void> {
    const address = env?.terminalId;
    const name = address ? commandDocName(address) : null;
    if (!name) return;
    const read = await client.docGet(name);
    if (read === null) return;
    const plan = planCommandApplication({
      value: read.value,
      appliedId: appliedCommandId,
      // A leftover command for another task is not this worker's to apply (S3): terminal addresses
      // restart with the core, so the address alone would let an old steer reach a new worker.
      taskId: delegation?.taskId ?? null,
    });
    if (plan.kind === 'none') return;
    if (plan.kind === 'apply') {
      // The latch follows the effect, never precedes it: a host that cannot send leaves the command
      // where it is, so the next notification tries again instead of reading as already applied.
      const handed = await sendUserMessageAs(plan.value.text, plan.value.deliverAs);
      if (!handed) {
        console.error(`piher: steering command ${plan.value.id} for ${address} was not handed to pi `
          + '(sendUserMessage is unavailable or refused it); the command stays in the core');
        return;
      }
    }
    appliedCommandId = plan.value.id;
    const cleared = await clearCommandDocument(client, name, read.version);
    if (!cleared) {
      // The master reads this same document and cannot tell an applied-but-uncleared steer from one
      // that was overwritten unread, so its result says "cannot be told". This log is the other half of
      // that event: the command WAS applied, and a restarted worker would apply it again.
      console.error(`piher: command ${plan.value.id} for ${address} was applied but could not be `
        + `cleared from ${name} at version ${read.version}: a newer command now holds the document, or `
        + 'the core refused the clear. A restarted worker, which has no memory of ids, would apply it '
        + 'again');
    }
  }

  function requestCommandApply(): void {
    commandApply = commandApply
      .then(() => applyCommandDocument())
      .catch((err: unknown) => {
        console.error(`piher: steering command for ${env?.terminalId ?? 'this worker'} could not be applied: ${(err as Error)?.message ?? err}`);
      });
  }

  /** Watch the core for this worker's commands. Workers only: a master has no address of its own to
   *  be steered at, and holds no subscription of its own (spec S24). */
  function startCommandWatch(): void {
    const address = env?.terminalId;
    if (!isSubagent || !address || !client.available) return;
    const name = commandDocName(address);
    commandWatch?.close();
    commandWatch = null;
    if (!name) return;
    commandWatch = client.watchDocuments((changed) => {
      // `null` is a (re)subscription: a command written while disconnected is still in the core, so
      // read once. A named event for anything else is not ours — documents are core-global.
      if (changed !== null && changed !== name) return;
      requestCommandApply();
    });
  }

  pi.on('session_start', async (event, ctx) => {
    sessionId = resolveSessionId(ctx);
    ownSessionPath = reportedSessionFile(ctx);
    latestCtx = ctx as { abort?: () => void } | null;
    // On resume pi restores widget state from the session; calling setWidget again
    // breaks the TUI '/' command-panel route (v1.3 M9).
    if ((event as { reason?: string } | undefined)?.reason !== 'resume') renderWorkerWidget(ctx);
    roles.syncFromBranch(ctx);
    if (isSubagent) {
      // The worker marker keeps the delegation identity next to the session file, so a /resume of
      // this session (which carries no spawn env) still knows who delegated it.
      const sm = typeof ctx === 'object' && ctx !== null && 'sessionManager' in ctx ? ctx.sessionManager : undefined;
      const sessionFile = (typeof sm?.getSessionFile === 'function' ? sm.getSessionFile() : undefined)
        ?? process.env.PI_SESSION_FILE ?? null;
      if (sessionFile) ownSessionFile = resolveSessionFileValue(process.cwd(), agentSessionsDir(), sessionFile);
      // RFC rfc-delegation-identity §2.1: env (spawn) > marker > branch fold (/resume).
      if (!delegation) delegation = readWorkerMarker(sessionFile)?.delegation ?? null;
      const branchEntries = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      const folded = foldDelegation(branchEntries as Parameters<typeof foldDelegation>[0]);
      if (!delegation && folded) delegation = folded;
      if (delegation && !folded) {
        // First-frame card: write once — the entry doubles as the /resume replay source.
        try {
          pi.appendEntry(DELEGATION_CUSTOM_TYPE, { version: 1, ...delegation, ts: Date.now() });
        } catch {
          /* Best effort; the marker already carries the identity. */
        }
      }
      // The master reads the worker's session file from this label.
      if (sessionFile) void client.setLabels({ 'piher.session': sessionFile });
      writeWorkerMarker(sessionFile, roles.state.manifest?.role, delegation ?? undefined);
    }

    await startPipeServerFor((ctx as { cwd?: string }).cwd ?? process.cwd());
    startCommandWatch();
  });

  /* RFC rfc-delegation-identity §2.2: worker identity + delivery contract ride the prompt
   * sections each turn (same diff discipline as piher-role; removal cleans up). */
  if (isSubagent) {
    pi.on('before_agent_start', async (event) => {
      const sections = event.systemPromptOptions?.sections;
      if (!sections) return;
      if (delegation) {
        const text = buildDelegationSection(delegation, env?.terminalId ?? '');
        if (sections['piher-delegation'] !== text) sections['piher-delegation'] = text;
      } else {
        delete sections['piher-delegation'];
      }
    });
  }

  pi.on('session_tree', async (_event, ctx) => {
    sessionId = resolveSessionId(ctx);
    ownSessionPath = reportedSessionFile(ctx) ?? ownSessionPath;
    // pi reverts the transcript loadout at the navigated branch point; the role
    // runtime follows the same point (same-origin, RFC §4.3).
    roles.syncFromBranch(ctx);
    repaintAgentViews(ctx);
  });

  /* pi 1.2 counts the run as busy from `before_agent_start`, not `turn_start`: a settlement
   * notice arriving in that window must enter the D92 buffer instead of being sent immediately. */
  pi.on('before_agent_start', async () => {
    agentActive = true;
  });

  pi.on('turn_start', async () => {
    agentActive = true;
    // A11: reset so a previous turn's abort cannot taint this one.
    lastStopReason = null;
    // P2 (spec S14): the master's first task now arrives through the core's own `send`, so no pipe
    // frame armed a request for it. Without one a settlement has no boundary (`sinceTs` fell back to
    // 0, letting an older closing message through) and a one-shot worker never exited. A local request
    // names this turn's start and has no requester pipe: the document is its delivery (spec S6-S8).
    if (isSubagent && pendingMachineRequest === null) {
      const at = Date.now();
      pendingMachineRequest = { id: `turn-${at}`, from: null, sinceTs: at };
    }
  });

  pi.on('turn_end', async (event: unknown, ctx) => {
    // Master registered this twice: the lifecycle handler skipped malformed events, the notice
    // flush ran regardless. The merged handler keeps both semantics.
    const msg = event !== null && typeof event === 'object' && 'message' in event ? (event as { message: unknown }).message : null;
    if (msg !== null && typeof msg === 'object') {
      const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
      if (role === 'assistant' && typeof stopReason === 'string') {
        lastStopReason = stopReason;
      }
    }
    repaintAgentViews(ctx);
    // A steer sent into an aborted turn is dropped by pi, after the flush has already released the
    // batch — the loss the buffer above exists to prevent. Keep the notices pending.
    if (lastStopReason !== ABORT_STOP_REASON) {
      void notices.flush('steer');
    }
  });

  pi.on('agent_settled', async (event: unknown, ctx) => {
    agentActive = false;
    repaintAgentViews(ctx);
    // pi ≥ 1.1 stamps cancelled runs on the event itself; stopReason tracking misses ESC mid-tool
    // (no final assistant message), so the event field is authoritative when present.
    const aborted = event !== null && typeof event === 'object' && 'aborted' in event && event.aborted === true;
    const plan = planSettleWake({
      lastStopReason,
      aborted,
      running: subagentPort.current?.listRunningSubs() ?? [],
      lastNoticeKey: d96NoticeKey,
      lastNoticeAt: d96NoticeAt,
      now: Date.now(),
    });
    d96NoticeKey = plan.noticeKey;
    d96NoticeAt = plan.noticeAt;
    // D96: master settled while background subagents still run → remind (worker port is unbound).
    if (plan.wake && plan.notice && !isSubagent) {
      const running = subagentPort.current?.listRunningSubs() ?? [];
      const brief = running.map((s) => `${s.paneId} (${s.description})`).join(', ');
      const notice = `Note: ${running.length} background subagent(s) still running: ${brief}. If your task depends on them, wait for their settlement (subagent list to check status); if you will not wait, state why you are abandoning them.`;
      void sendUserMessageAs(notice, 'followUp');
    }
    if (lastStopReason !== ABORT_STOP_REASON && !aborted) void notices.flush('followUp');
    // One report for this settle, resolved before either channel uses it: the request (read before
    // the push consumes it), the turn's stop reason, the closing words and the core's turn. All of it
    // is captured HERE, synchronously — the document write runs before the push, and by then a newer
    // turn or a newer request would have moved the live state these decisions depend on.
    const request = pendingMachineRequest;
    const turnStopReason = lastStopReason;
    const at = Date.now();
    const settled = collectSettleReport(request?.sinceTs ?? 0).catch((err: unknown) => {
      // A report that cannot be read must not become an unhandled rejection that silently cancels the
      // push: the words are gone, but the settle is still reported as "no closing message".
      console.error(`piher: settle report could not be read: ${(err as Error)?.message ?? err}`);
      return { text: null, why: null, file: ownSessionFile, turn: null } satisfies SettleReport;
    });
    // P1: the report document is written on every settle, and written BEFORE the reply leaves this
    // process. Two reasons, both ordering: the master's reply handling reclaims a one-shot worker's
    // pane immediately (the retire would otherwise cut the write short), and the reply names the
    // document's `at` so the master can record exactly which settlement the pipe delivered (S7).
    const pushed = settled
      .then(async (report) => {
        const written = await writeSettleDocument({ aborted, turnStopReason, report, hadRequest: request !== null, at });
        const sent = await pushSettleReply({ aborted, turnStopReason, request, report, docAt: written ? at : null });
        return { written, sent };
      });
    // S54: a role-declared `one-shot` worker exits once its report is in the master's hands. The
    // ordering is the whole risk — shutting down first loses the report the parent waits for. "In the
    // master's hands" is the document write (spec S6-S8, the channel that survives a restart) or the
    // pipe push, whichever happened; since P2 the first task's settlement has no pipe push at all.
    // An aborted turn reports nothing (S52).
    if (isSubagent && !aborted && delegation?.lifecycle === 'one-shot') {
      void pushed.then(({ written, sent }) => { if (written || sent) ctx.shutdown(); });
    } else {
      void pushed;
    }
  });

  installConfigCommand({ pi });

  pi.on('session_shutdown', async () => {
    // Nothing outlives the session it serves: the command subscription is a connection of its own.
    commandWatch?.close();
    commandWatch = null;
    // Stop the watchdog first: a rebind during shutdown would outlive the session it serves.
    if (pipeWatchdog) clearInterval(pipeWatchdog);
    pipeWatchdog = null;
    if (pipeServerBox.current) {
      const server = pipeServerBox.current;
      pipeServerBox.current = null;
      await closePipeServer(server);
    }
    if (env?.terminalId) releasePipe(env.terminalId, pipeGeneration);
  });

  /* ── master vs worker mount (dynamic: workers never load the cordis tree, C3) ── */
  if (mode.composeMaster) {
    const { mountMasterPlugins } = await import('./index-master.ts');
    await mountMasterPlugins({
      pi,
      client,
      env,
      extPath: fileURLToPath(import.meta.url),
      port: subagentPort,
      pipeServerBox,
      deliverNotice,
      noticePending: notices.noticePending,
      getSessionId: () => sessionId,
      // The task view lives beside the transcript; the reported path is authoritative, and the scan by
      // id is only the fallback for a host that reports an id instead of a file.
      getSessionFile: () => ownSessionPath
        ?? (sessionId ? resolveSessionFileValue(process.cwd(), agentSessionsDir(), sessionId) : null),
      claimSettleNotice,
    });

  }
}
