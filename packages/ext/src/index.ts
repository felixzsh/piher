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
import { bareSessionId, deriveSubSessionState, readSessionFile, resolveSessionFileValue } from './session-tail.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { platformPaths } from './platform-paths.ts';
import { WRITE_LOCK_ENV } from './lock-core.ts';
import { ABORT_STOP_REASON, planSettleWake, shouldPushSettleReply } from './settle-wake-core.ts';
import { writeReportDocument } from './report-documents.ts';
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

  /** pi's sendUserMessage is fire-and-forget (void); callers of this wrapper still get a promise. */
  const sendUserMessageAs = (content: string, mode: 'steer' | 'followUp'): Promise<void> => {
    (pi as unknown as { sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => void })
      .sendUserMessage?.(content, { deliverAs: mode, triggerTurn: true });
    return Promise.resolve();
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
        sendUserMessageIn: (content) => sendUserMessageAs(content, 'followUp'),
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
   *  abort still has words. A worker still thinking has neither, and its report stays withheld. */
  function ownClosing(sinceTs: number): { text: string | null; why: string | null; file: string | null } {
    const ownFile = ownSessionFile
      ?? (sessionId ? resolveSessionFileValue(process.cwd(), agentSessionsDir(), sessionId) : null);
    if (!ownFile) return { text: null, why: null, file: null };
    const entries = readSessionFile(ownFile);
    // Same derivation the master's poller uses, so the two paths can never disagree.
    if (!entries) return { text: null, why: null, file: ownFile };
    const state = deriveSubSessionState(entries, sinceTs);
    return { text: state.text, why: state.why ?? null, file: ownFile };
  }

  /** Returns whether a settlement reply actually went out: a worker whose report never reached the
   *  master must not exit as if it had (S54 — the push comes first, the shutdown after). */
  async function pushSettleReply(aborted = false): Promise<boolean> {
    const req = pendingMachineRequest;
    if (!req || !req.from) {
      return false;
    }
    // An aborted settle is not a settlement: the closing message is still coming, and answering now
    // would burn the one-shot request + the parent's claim latch on a null-text reply ("left no
    // closing message") — the real closing message then never gets delivered. Keep the request armed.
    if (!shouldPushSettleReply({ aborted, lastStopReason })) {
      return false;
    }
    pendingMachineRequest = null;
    try {
      // A turn that ended with nothing to say but a reason — a refused tool, an error — must say
      // it: staying silent left the master waiting the whole vacuum budget for a report that was
      // never coming.
      const { text, why, file } = ownClosing(req.sinceTs);
      const report = text ?? why ?? null;
      if (report === null) {
        return false;
      }
      await pipeRequest(req.from, {
        type: 'reply',
        id: req.id,
        paneId: env?.terminalId ?? '',
        text: report,
        // Push the resolved PATH when readable; fall back to the bare id for the master-side mapping.
        sessionFile: file ?? (sessionId || null),
      }, 5000);
    } catch (err) {
      /* The requester's pollLoop is the fallback; surface the dead letter for triage. */
      console.error(`piher: settle reply push to ${req.from} failed: ${(err as Error)?.message ?? err}`);
      return false;
    }
    return true;
  }

  /** P1 (spec S6): write the settlement report document on every settle, whether or not the
   *  master asked — the pipe push above is gated on a pending request, which is the reason a
   *  master-side guess had to exist at all. Best effort like the push: a failed write is logged,
   *  never thrown, and an aborted or errored turn still reports nothing. */
  async function writeSettleDocument(aborted = false): Promise<boolean> {
    if (!isSubagent || !client.available || !env?.terminalId || !delegation) return false;
    if (!shouldPushSettleReply({ aborted, lastStopReason })) return false;
    const { text, why, file } = ownClosing(pendingMachineRequest?.sinceTs ?? 0);
    // A worker still thinking has no closing text and no reason: withhold like the pipe push.
    if (text === null && why === null) return false;
    let turn: number | null = null;
    try {
      turn = (await client.getTerminal(env.terminalId))?.turn ?? null;
    } catch {
      /* fall through to the logged skip below */
    }
    if (turn === null) {
      console.error(`piher: settle document for ${env.terminalId} skipped: the core would not report its turn`);
      return false;
    }
    const written = await writeReportDocument(client, env.terminalId, {
      taskId: delegation.taskId,
      turn,
      stopReason: lastStopReason,
      session: file ?? (sessionId || null),
      text,
      at: Date.now(),
    });
    if (!written) console.error(`piher: settle document for ${env.terminalId} was not written`);
    return written !== null;
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
    const pushed = pushSettleReply(aborted);
    // P1: the report document goes out on every settle regardless of the pipe push above.
    void writeSettleDocument(aborted);
    // S54: a role-declared `one-shot` worker exits once its report is in the master's hands. The
    // ordering is the whole risk — shutting down first loses the report the parent waits for — so the
    // exit hangs off the push, and never off an aborted turn (S52: an interrupted turn reports nothing).
    if (isSubagent && !aborted && delegation?.lifecycle === 'one-shot') {
      void pushed.then((sent) => { if (sent) ctx.shutdown(); });
    } else {
      void pushed;
    }
  });

  installConfigCommand({ pi });

  pi.on('session_shutdown', async () => {
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
