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
import { pipeNameFor, pipePathFor, pipeRequest, startPipeServer } from './pipe-channel.ts';
import { installRenderers } from './renderers.ts';
import { SETTLEMENT_CUSTOM_TYPE, sendSettlementNotice } from './settlement-card.ts';
import { createCoreClient } from './core-client.ts';
import { bareSessionId, deriveSubSessionState, readSessionFile, resolveSessionFileValue } from './session-tail.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { platformPaths } from './platform-paths.ts';
import { WRITE_LOCK_ENV } from './lock-core.ts';
import { ABORT_STOP_REASON, planSettleWake, shouldPushSettleReply } from './settle-wake-core.ts';
import { parseRuntimeManifest } from './tool-gate.ts';
import { planIndexMode } from './index-runtime.ts';
import { emptySubagentPortBox, sleepWhileSubsRunningNote } from './subagent-core.ts';
import { writeWorkerMarker, readWorkerMarker } from './worker-marker.ts';
import { openTreeOverlay, type TreeOverlayHandle } from './tree-overlay.ts';
import {
  DELEGATION_CUSTOM_TYPE,
  buildDelegationSection,
  foldDelegation,
  parseDelegationContext,
  type DelegationContext,
} from './delegation-core.ts';
import { formatDelegationTree, widgetLines } from './tree-view.ts';
import { createNoticeBuffer } from './index-notices.ts';
import { handlePipeRequest, type MachineRequest } from './index-pipe.ts';
import { installWriteLocks } from './index-locks.ts';
import { installConfigCommand } from './config-command.ts';
import { composeMasterRuntime, createRoleRuntime } from './index-roles.ts';
import { trace, traceRole } from './trace.ts';

function agentSessionsDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, 'sessions') : platformPaths.sessionsDir;
}

export default async function (pi: ExtensionAPI) {
  const mode = planIndexMode();
  const isSubagent = mode.isSubagent;
  const roleBase = process.env.PIHER_ROLE_BASE || process.cwd();

  let sessionId: string = process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '';
  const { client, env } = createCoreClient();
  /** RFC rfc-delegation-identity §2.1: resolved env → marker → branch fold; worker panes only. */
  let delegation: DelegationContext | null = parseDelegationContext(process.env.PIHER_DELEGATION);
  const initialManifest =
    parseRuntimeManifest(process.env.PIHER_ROLE_MANIFEST) ??
    (mode.composeMaster ? composeMasterRuntime() : null);

  const roles = createRoleRuntime({ pi, roleBase, initialManifest, isSubagent });

  const rendererTypes = installRenderers(pi);
  /** A card is only worth sending when this host could register its renderer. */
  const cardsRendered = rendererTypes.includes(SETTLEMENT_CUSTOM_TYPE);
  if (process.env.PIHER_TRACE) {
    console.error(`[piher] transcript renderers: ${rendererTypes.length ? rendererTypes.join(', ') : 'none'}`);
  }

  let agentActive = false;
  let lastStopReason: string | null = null;
  let latestCtx: { abort?: () => void } | null = null;
  const subagentPort = emptySubagentPortBox();
  let d96NoticeKey: string | null = null;
  let d96NoticeAt = 0;

  /** Session identity: sessionManager is authoritative (env may be unset in print/RPC mode). */
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

  /* ── /piher-tree overlay: rendered inside pi; open views repaint on worker updates. ── */
  let treeView: TreeOverlayHandle | null = null;

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

  /** Both views read the subagent registry, so a turn boundary or a settlement repaints them. */
  function repaintAgentViews(ctx: unknown): void {
    treeView?.refresh();
    renderWorkerWidget(ctx);
  }

  function renderTreeLines(): string[] {
    const rows = subagentPort.current?.listRows() ?? [];
    return formatDelegationTree({
      workers: subagentPort.current?.listRunningSubs() ?? [],
      settled: rows
        .filter((r) => r.status === 'settled' || r.status === 'consumed')
        .map((r) => ({ paneId: r.paneId, slug: r.slug, description: r.description, settledAt: r.settledAt })),
      now: Date.now(),
    });
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
  let pendingMachineRequest: MachineRequest | null = null;
  /** Dedup latch for settle notices: one per paneId+request id per round. */
  const settleNoticeLatch = new Set<string>();
  function claimSettleNotice(key: string): boolean {
    if (settleNoticeLatch.has(key)) return false;
    settleNoticeLatch.add(key);
    return true;
  }

  function startPipeServerFor(cwd: string): void {
    const paneId = env?.terminalId ?? '';
    if (!paneId) {
      // No address means no channel: every follow-up to this pane is undeliverable, which is worth
      // saying out loud rather than discovering as a 90 s timeout on the other side.
      trace(traceRole, 'pipe-listen', { ok: false, why: 'no-pane-id', cwd });
      return;
    }
    const name = pipeNameFor(cwd, paneId);
    const path = pipePathFor(name);
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* Previous instance. */ }
      pipeServerBox.current = null;
      trace(traceRole, 'pipe-rebind', { pane: paneId, path });
    }
    /** A bind failure is silent by construction (net.Server reports it on 'error'), so it is the one
     *  failure that used to leave a live worker unreachable with nothing in any log. */
    const bindFailed = (err: Error): void => {
      const code = (err as NodeJS.ErrnoException)?.code ?? null;
      trace(traceRole, 'pipe-listen', { ok: false, pane: paneId, path, code, error: err.message });
      void deliverNotice(
        `piher: this pane cannot receive follow-up messages — its pipe ${path} failed to bind`
        + `${code ? ` (${code})` : ''}. A master that sends to it will report the channel as dead.`,
        paneId,
        null,
      );
    };
    try {
      pipeServerBox.current = startPipeServer(name, async (req) => handlePipeRequest(req, {
        paneId,
        port: subagentPort,
        claimSettleNotice,
        deliverNotice,
        sendUserMessageIn: (content) => sendUserMessageAs(content, 'followUp'),
        sendUserMessageAs,
        abort: () => { latestCtx?.abort?.(); },
        setPendingMachineRequest: (next) => { pendingMachineRequest = next; },
        applyRoleSwitch: roles.applyRoleSwitch,
      }), bindFailed);
      trace(traceRole, 'pipe-listen', { ok: true, pane: paneId, path, cwd });
    } catch (err) {
      // A synchronous throw (path too long, permission) is the same outcome as a failed bind.
      bindFailed(err as Error);
    }
  }

  /** Returns whether a settlement reply actually went out: a worker whose report never reached the
   *  master must not exit as if it had (S54 — the push comes first, the shutdown after). */
  async function pushSettleReply(aborted = false): Promise<boolean> {
    const req = pendingMachineRequest;
    if (!req || !req.from) {
      trace(traceRole, 'push-skip', { why: 'no-request', hasReq: req !== null, from: req?.from ?? null });
      return false;
    }
    // An aborted settle is not a settlement: the closing message is still coming, and answering now
    // would burn the one-shot request + the parent's claim latch on a null-text reply ("left no
    // closing message") — the real closing message then never gets delivered. Keep the request armed.
    if (!shouldPushSettleReply({ aborted, lastStopReason })) {
      trace(traceRole, 'push-skip', { why: 'aborted-or-error', aborted, lastStopReason });
      return false;
    }
    pendingMachineRequest = null;
    try {
      const ownFile = sessionId ? resolveSessionFileValue(process.cwd(), agentSessionsDir(), sessionId) : null;
      let text: string | null = null;
      if (ownFile) {
        const entries = readSessionFile(ownFile);
        // Same derivation the master's poller uses, so the two paths can never disagree about whether
        // the worker said anything: a turn that ended by token cap or abort still has words.
        if (entries) {
          const state = deriveSubSessionState(entries, req.sinceTs);
          // A turn that ended with nothing to say but a reason — a refused tool, an error — must say
          // it: staying silent left the master waiting the whole vacuum budget for a report that was
          // never coming. A worker still thinking has no reason, and its push stays withheld.
          text = state.text ?? state.why ?? null;
        }
      }
      if (text === null) {
        trace(traceRole, 'push-skip', {
          why: 'no-text', request: req.id, since: req.sinceTs, file: ownFile, hasFile: ownFile !== null,
        });
        return false;
      }
      trace(traceRole, 'push-try', {
        request: req.id, since: req.sinceTs, file: ownFile, textLen: text.length, to: req.from,
      });
      await pipeRequest(req.from, {
        type: 'reply',
        id: req.id,
        paneId: env?.terminalId ?? '',
        text,
        // Push the resolved PATH when readable; fall back to the bare id for the master-side mapping.
        sessionFile: ownFile ?? (sessionId || null),
      }, 5000);
    } catch (err) {
      /* The requester's pollLoop is the fallback; surface the dead letter for triage. */
      trace(traceRole, 'push-failed', { request: req.id, to: req.from, error: String((err as Error)?.message ?? err) });
      console.error(`piher: settle reply push to ${req.from} failed: ${(err as Error)?.message ?? err}`);
      return false;
    }
    trace(traceRole, 'push-ok', { request: req.id, to: req.from });
    return true;
  }

  pi.on('session_start', async (event, ctx) => {
    sessionId = resolveSessionId(ctx);
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

    startPipeServerFor((ctx as { cwd?: string }).cwd ?? process.cwd());
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
    // S54: a role-declared `one-shot` worker exits once its report is in the master's hands. The
    // ordering is the whole risk — shutting down first loses the report the parent waits for — so the
    // exit hangs off the push, and never off an aborted turn (S52: an interrupted turn reports nothing).
    trace(traceRole, 'settle', {
      aborted, lastStopReason, isSubagent, lifecycle: delegation?.lifecycle ?? null,
      pushed: await Promise.resolve(pushed), hasRequest: pendingMachineRequest !== null,
    });
    if (isSubagent && !aborted && delegation?.lifecycle === 'one-shot') {
      void pushed.then((sent) => { if (sent) ctx.shutdown(); });
    } else {
      void pushed;
    }
  });

  installConfigCommand({ pi });

  pi.on('session_shutdown', async () => {
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* Already closed. */ }
      pipeServerBox.current = null;
    }
    treeView = null;
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
      claimSettleNotice,
    });

    /* ── /piher-tree (D113): every running subagent plus the settled nodes it can still be revived from. ── */
    pi.registerCommand('piher-tree', {
      description: 'Show the delegation tree: every running subagent and the settled nodes you can resume',
      handler: async (_args: unknown, ctx: unknown) => {
        const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void; custom?: (factory: unknown, options?: unknown) => Promise<unknown> } }).ui;
        const custom = typeof ui?.custom === 'function' ? ui.custom.bind(ui) : undefined;
        const opened = openTreeOverlay(custom, renderTreeLines, (handle) => { treeView = handle; });
        if (opened) {
          await opened;
          treeView = null;
          return;
        }
        // RPC mode / no custom components: one-shot text view.
        ui?.notify?.(renderTreeLines().join('\n'), 'info');
      },
    });
  }
}
