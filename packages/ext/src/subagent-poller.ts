/**
 * Background settlement watcher: blocked gate, settle window, vacuum — plus its per-subagent
 * Cordis scope. Each loop reads the worker from the master's `WorkerWatch` snapshot and parks on its
 * change counter, so a worker that is working, blocked or idle costs no RPCs between events.
 */
import { Context } from '@deepseek-ai/cordis';
import type { CoreClientLike, CoreStatus, TerminalInfo } from './core-client.ts';
import {
  applyReportedSessionFile, isClosed, taskForPane, type TaskEntry, type TaskObservation,
} from './task-row.ts';
import { runtimePolicy, type RuntimePolicy } from './runtime-policy.ts';
import { formatFailureNotice, formatSettlementNotice, type SettlementNullReason } from './vocab.ts';
import { settlementCard, type SettlementCard, type SettlementOutcome } from './settlement-card.ts';
import { buildBlockedGateNotice, reportFingerprint } from './subagent-core.ts';
import { retirePane } from './subagent-gc.ts';
import type { SessionIo } from './subagent-session.ts';
import { trace, traceRole } from './trace.ts';

/** `null` = no word to act on (working, never reported, or the watch is blind). */
type WaitState = CoreStatus | null;

export type BlockedGatePlan =
  | { kind: 'stay-blocked'; notify: boolean }
  | { kind: 'clear-gate' }
  | { kind: 'pass' };

/** Blocked is sticky (one notice per gate); any other observed state clears the gate. */
export function planBlockedGate(state: WaitState, alreadyNotified: boolean): BlockedGatePlan {
  if (state === 'blocked') return { kind: 'stay-blocked', notify: !alreadyNotified };
  if (state !== null) return { kind: 'clear-gate' };
  return { kind: 'pass' };
}

export type SettleWindowTickPlan =
  | { kind: 'start-settle-window' }
  | { kind: 'wait' }
  | { kind: 'settle' };

/** The window delays settlement so a worker is not announced before its transcript settles; a
 *  finalized answer on a terminal that is not working skips it (the transcript cannot grow). */
export function planSettleWindowTick(input: {
  settleWindowStartedAt: number | null | undefined;
  now: number;
  windowMs: number;
  /** The transcript already holds a finalized answer (stopReason 'stop', no pending tool call). */
  finalized?: boolean;
}): SettleWindowTickPlan {
  if (!input.settleWindowStartedAt) return input.finalized ? { kind: 'settle' } : { kind: 'start-settle-window' };
  if (input.now - input.settleWindowStartedAt < input.windowMs) return { kind: 'wait' };
  return { kind: 'settle' };
}

export function planVacuumTick(input: {
  waitState: WaitState;
  paneAlive: boolean;
  now: number;
  lastActivityAt: number;
  timeoutMs: number;
}): { refreshActivity: boolean; action: 'pane-closed' | 'timeout' | 'continue' } {
  const refreshActivity = input.waitState === null;
  const lastActivityAt = refreshActivity ? input.now : input.lastActivityAt;
  if (!input.paneAlive) return { refreshActivity, action: 'pane-closed' };
  if (input.now - lastActivityAt > input.timeoutMs) return { refreshActivity, action: 'timeout' };
  return { refreshActivity, action: 'continue' };
}

/**
 * Closing text (only a terminal assistant message produces it) OR an ENDED turn settles; a mere
 * assistant message — the state between tool calls — must NOT qualify, or live workers get announced
 * as finished.
 *
 * The exception is an idle terminal with no tool in flight: a worker that stopped between calls is not
 * "between calls". Without it, a run that ended on a refused tool call (last message `toolUse`, result
 * already returned, nothing after) stayed invisible for the whole vacuum budget.
 */
export function isSettlementCandidate(input: {
  text: string | null;
  pendingTool: boolean;
  activity: boolean;
  turnEnded?: boolean;
  /** The pane itself is idle: nothing is being executed right now. */
  terminalIdle?: boolean;
}): boolean {
  if (input.text) return true;
  if (!input.pendingTool && input.turnEnded === true) return true;
  return !input.pendingTool && input.activity === true && input.terminalIdle === true;
}

/** How long one closing text counts as announced for a pane (see noticeAnnounced). */
const NOTICE_DEDUPE_WINDOW_MS = 5 * 60_000;

export function buildSettlementNoticeText(
  agentLabel: string,
  closing: string | null,
  nullReason: SettlementNullReason = 'silent',
  reportDeliveredAt: number | null = null,
): string {
  return formatSettlementNotice(agentLabel, closing, nullReason, reportDeliveredAt);
}

export function formatPaneClosedNotice(paneId: string, description: string): string {
  return `Background subagent ${paneId} (${description}) stopped before settling (its pane closed).`;
}

export function formatSettleTimeoutNotice(input: {
  paneId: string;
  description: string;
  idleSeconds: number;
  startedAtIso: string;
}): string {
  return `Background subagent ${input.paneId} (${input.description}) has shown no progress for ${input.idleSeconds}s (observed since ${input.startedAtIso}). Run subagent(action: "list") to check its live state; if it is working, let it run — its settlement notice will arrive automatically. Do not sleep-wait.`;
}

/* ── pane scope ─────────────────────────────────────────────────── */

/** A revived pane can answer in the very second the poller starts. The transcript is read from the
 *  request boundary on, so an answer landing exactly on it used to read as no activity at all: the row
 *  then sat `running` until the settle timeout declared a worker that had finished to be `failed`. */
const REQUEST_BOUNDARY_SLACK_MS = 2_000;

export interface ScopeHooks {
  onDispose?: () => void;
}

export function createSessionRoot(hooks: ScopeHooks = {}): Context {
  const root = new Context();
  if (hooks.onDispose) {
    root.effect(() => () => { hooks.onDispose?.(); }, 'session-root');
  }
  return root;
}

export async function mountSubagentScope(
  root: Context,
  paneId: string,
  hooks: ScopeHooks = {},
) {
  // One argument only: the pinned cordis version takes just the plugin object; the pane id is the scope name.
  return root.plugin({
    name: `subagent:${paneId}`,
    apply(ctx: Context) {
      ctx.effect(() => () => { hooks.onDispose?.(); }, `subagent:${paneId}`);
    },
  });
}

export async function disposeSessionRoot(root: Context): Promise<void> {
  try {
    await root.fiber.dispose();
  } catch {
  }
}

/* ── poll loop ──────────────────────────────────────────────────── */

export interface PollerHost {
  client: CoreClientLike;
  sessionRoot: Context;
  tasks: Map<string, TaskEntry>;
  panes: Map<string, string>;
  writeRecord(e: TaskEntry): void;
  /** Refreshed from each observation the loop makes; feeds only the state text (S26). */
  noteObservation?: (paneId: string, obs: TaskObservation) => void;
  blockedGateNotified: Set<string>;
  session: SessionIo;
  injectNotice(content: string, paneId?: string, card?: SettlementCard | null): Promise<void>;
  /** S54/S71: what a one-shot settlement reclaims — the pane, and any checkout its spawn created. */
  reclaim?(entry: TaskEntry): void;
  claimSettleNotice(key: string): boolean;
  now?: () => number;
  policy?: Partial<RuntimePolicy>;
}

export interface Poller {
  startPoller(paneId: string, cwd: string, injectTs: number, description: string, requestId: string): Promise<void>;
  readonly pollers: Set<string>;
}

export function createPoller(h: PollerHost): Poller {
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  /** Current tracked request per pane. startPoller refreshes it even while a poller runs: a
   * follow_up must judge settlement against its own injectTs, not the original request's. */
  const requestByPane = new Map<string, { injectTs: number; description: string; requestId: string }>();
  const now = h.now ?? Date.now;
  const settleWindowMs = h.policy?.settleWindowMs ?? runtimePolicy.settleWindowMs;
  const timeoutMs = h.policy?.subagentTimeoutMs ?? runtimePolicy.subagentTimeoutMs;
  /** Safety re-check while no event arrives; events, not this interval, drive the loop. */
  const recheckMs = h.policy?.pollIntervalMs ?? runtimePolicy.pollIntervalMs;
  const watch = h.client.watchChildren();

  /**
   * The card a poller decision draws: a failure carries the same role and elapsed fields a settle
   * does, so the two never read as different kinds of event.
   */
  const cardFor = (
    entry: TaskEntry | undefined,
    paneId: string,
    description: string,
    outcome: SettlementOutcome,
  ): SettlementCard => settlementCard({
    name: `${paneId} (${description})`,
    ...(entry ? { kind: entry.kind, startedAt: entry.createdAt } : {}),
    outcome,
    now: now(),
  });

  /** The worker as the watch sees it. A blind watch (disconnected) never settles or fails anything. */
  async function observe(paneId: string): Promise<{ state: CoreStatus | 'exited' | null; alive: boolean }> {
    if (!watch.connected) return { state: null, alive: true };
    let info: TerminalInfo | null | undefined = watch.get(paneId);
    if (!info) {
      // Not in the snapshot: a fresh spawn racing its `created` event, or a terminal that is gone.
      try {
        info = await h.client.getTerminal(paneId);
        // Where the state came from decides whether a stale snapshot or core itself is the problem.
        trace(traceRole, 'observe-fallback', {
          pane: paneId, source: 'getTerminal', state: info?.state ?? null, status: info?.status ?? null,
        });
      } catch (err) {
        trace(traceRole, 'observe-fallback', {
          pane: paneId, source: 'unavailable', error: String((err as Error)?.message ?? err),
        });
        return { state: null, alive: true }; // an unreachable socket must not be read as a dead terminal
      }
    }
    if (!info || info.state === 'finished') return { state: 'exited', alive: false };
    return { state: info.status, alive: true };
  }

  async function pollLoop(
    paneId: string,
    cwd: string,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    const startedAt = now();
    let lastActivityAt = now();
    /** Claimed settle key: on a rejected injection the claim stays ours, so the next wake retries
     *  the notice instead of suppressing it as someone else's. */
    let claimedKey: string | null = null;
    /** Stop watching this pane: stamp the delivery and write the record first, or a restart
     *  replays a ghost running row. Settling is `consumedAt` plus the write — nothing else. */
    const consume = (at: number): void => {
      const row = taskForPane(h.tasks, h.panes, paneId);
      if (!row) return;
      row.gen.consumedAt = at;
      h.writeRecord(row);
      // S54: a one-shot worker exits after pushing its report, so its pane is reclaimed here — the
      // notice already carries the text, and the pane must not linger for the GC TTL.
      if (row.lifecycle === 'one-shot') {
        if (h.reclaim) h.reclaim(row);
        else void retirePane(h.client, paneId);
      }
    };
    /** Hand one settlement to the master: claim, notice, consume. The row is consumed only after the
     *  notice is accepted, and a claim we own is retried on the next wake — a rejected injection must
     *  not strand a finished worker as `running` with no notice, nor consume the row while the result
     *  is still undelivered. Returns 'retry' when the notice was refused. */
    async function handOver(
      entry: TaskEntry,
      closing: string | null,
      activity: boolean,
      request: { injectTs: number; description: string; requestId: string },
      /** The turn ended with no report: the transcript's own reason (an error, a refused tool). A
       *  settlement notice over it would read as success. */
      failure: string | null = null,
    ): Promise<'done' | 'retry'> {
      // Null closing text is ambiguous — a mis-attributed transcript reads like a worker that died
      // silent — so the transcript is the only signal: no readable candidate at all (activity false)
      // makes "left no closing message" a lie.
      const nullReason: SettlementNullReason = closing == null && !activity ? 'attribution-suspect' : 'silent';
      if (!entry.gen.sessionFile) {
        entry.gen.sessionFile = applyReportedSessionFile(
          entry.gen.sessionFile,
          await h.session.resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: request.injectTs - 2_000 }),
        );
      }
      const claimKey = `${paneId}:${request.requestId}`;
      if (claimedKey !== claimKey) {
        const claimed = h.claimSettleNotice(claimKey);
        trace(traceRole, 'claim', { pane: paneId, key: claimKey, claimed, closingLen: closing?.length ?? null });
        if (!claimed) {
          consume(now());
          return 'done';
        }
        claimedKey = claimKey;
      }
      // The same closing text, already announced for this pane, is one settlement: a recovery re-arm and
      // a live request carry different ids, so the claim alone lets the master read it twice. The window
      // keeps a genuinely new turn that happens to say the same words from being swallowed.
      const fingerprint = closing === null ? null : reportFingerprint(closing);
      const announced = entry.noticeAnnounced;
      if (fingerprint !== null && announced && announced.fingerprint === fingerprint
        && now() - announced.at < NOTICE_DEDUPE_WINDOW_MS) {
        trace(traceRole, 'notice-dup', { pane: paneId, request: request.requestId, at: announced.at });
        consume(now());
        return 'done';
      }
      // `subagent output` may already have returned this exact report: point there, don't repeat it.
      const delivered = closing && entry.gen.reportDelivered?.fingerprint === reportFingerprint(closing)
        ? entry.gen.reportDelivered.at
        : null;
      const notice = failure !== null
        ? formatFailureNotice(`${paneId} (${request.description})`, failure)
        : buildSettlementNoticeText(`${paneId} (${request.description})`, closing, nullReason, delivered);
      try {
        // Tag the pane: a notice buffered while the master is busy must keep its row GC-exempt
        // until the flush actually delivers it.
        await h.injectNotice(notice, paneId, cardFor(entry, paneId, request.description, failure !== null ? 'failed' : 'settled'));
        trace(traceRole, 'inject-ok', { pane: paneId, request: request.requestId, closingLen: closing?.length ?? null });
      } catch (err) {
        trace(traceRole, 'inject-failed', { pane: paneId, request: request.requestId, error: String((err as Error)?.message ?? err) });
        return 'retry';
      }
      if (fingerprint !== null) {
        entry.noticeAnnounced = { fingerprint, at: now() };
      }
      consume(now());
      trace(traceRole, 'consumed', { pane: paneId, via: 'poll-settle', request: request.requestId });
      return 'done';
    }

    const watchReady = await watch.ready();
    trace(traceRole, 'poll-start', {
      pane: paneId, since: injectTs, request: requestId, cwd, file: taskForPane(h.tasks, h.panes, paneId)?.gen.sessionFile ?? null,
      watchReady, watchConnected: watch.connected,
    });
    try {
      while (true) {
        const current = requestByPane.get(paneId) ?? { injectTs, description, requestId };
        const entry = taskForPane(h.tasks, h.panes, paneId);
        if (!entry || isClosed(entry) || entry.gen.consumedAt !== null) {
          trace(traceRole, 'poll-exit', {
            pane: paneId,
            reason: !entry ? 'row-gone' : isClosed(entry) ? 'closed' : 'consumed',
            request: current.requestId,
          });
          return;
        }

        // Read the version BEFORE the state: an event landing in between still wakes the park below.
        const seen = watch.version(paneId);
        const park = async (ms: number): Promise<boolean> => {
          const woke = await watch.changed(paneId, seen, Math.max(0, ms));
          trace(traceRole, 'park', { pane: paneId, ms, wokeByEvent: woke, seen, version: watch.version(paneId) });
          return woke;
        };
        const { state, alive } = await observe(paneId);
        // The loop's own observations refresh the display cache; a blind watch notes nothing, so a
        // stale snapshot can never overwrite a liveness the loop actually saw (S26).
        if (watch.connected) {
          h.noteObservation?.(paneId, {
            paneExists: alive,
            agentStatus: state === 'exited' ? null : state,
            lastActivityMs: null,
            at: now(),
          });
        }
        // Working is activity (vacuum heartbeat); `exited`/`unknown` carry no word to gate or settle on.
        const waitState: WaitState = state === 'exited' || state === 'unknown' || state === 'working' ? null : state;
        if (state === 'working' && entry.settleWindowStartedAt) {
          // A new turn restarts the settle window from scratch.
          entry.settleWindowStartedAt = null;
        }
        const gate = planBlockedGate(waitState, h.blockedGateNotified.has(paneId));
        if (gate.kind === 'stay-blocked') {
          if (gate.notify) {
            h.blockedGateNotified.add(paneId);
            const question = await h.session.readAskFlag(paneId);
            try {
              await h.injectNotice(buildBlockedGateNotice({ paneId, description: current.description, question }));
            } catch {
              /* list_agents can recover a missed notice */
            }
          }
          lastActivityAt = now(); // a person is being asked: waiting on them is not a stall
          await park(recheckMs);
          continue;
        }
        if (gate.kind === 'clear-gate') h.blockedGateNotified.delete(paneId);

        if (state === 'idle' || state === 'done' || state === 'error') {
          // Spawn can mis-attribute the generation's sessionFile (the `piher.session` label lags;
          // the mtime fallback records the newest PRE-EXISTING session), freezing settlement
          // detection until the vacuum timeout.
          if (entry.gen.sessionFile) {
            const fixed = await h.session.reattributeStaleSessionFile(paneId, cwd, current.injectTs, entry.gen.sessionFile);
            if (fixed && fixed !== entry.gen.sessionFile) {
              entry.gen.sessionFile = fixed;
              h.writeRecord(entry);
            }
          } else {
            entry.gen.sessionFile = applyReportedSessionFile(
              entry.gen.sessionFile,
              await h.session.resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: current.injectTs - 2_000 }),
            );
          }
          const s = await h.session.subSessionState(paneId, cwd, current.injectTs, entry.gen.sessionFile);
          trace(traceRole, 'poll', {
            pane: paneId, state, textLen: s.text ? s.text.length : null, pend: s.pendingTool,
            act: s.activity, ended: s.turnEnded ?? null, window: entry.settleWindowStartedAt ?? null,
            since: current.injectTs, request: current.requestId, file: entry.gen.sessionFile,
            watch: watch.connected,
          });

          const terminalIdle = state === 'idle' || state === 'done' || state === 'error';
          const candidate = isSettlementCandidate({ ...s, terminalIdle });
          if (!candidate) {
            trace(traceRole, 'no-candidate', {
              pane: paneId, state, terminalIdle, textLen: s.text ? s.text.length : null,
              pend: s.pendingTool, act: s.activity, ended: s.turnEnded ?? null,
            });
          }
          if (candidate) {
            // With no closing words, a stated reason (refused tool, errored turn) IS the report.
            const closing = s.text ?? s.why ?? null;
            const tick = planSettleWindowTick({
              settleWindowStartedAt: entry.settleWindowStartedAt,
              now: now(),
              windowMs: settleWindowMs,
              finalized: closing != null && !s.pendingTool,
            });
            trace(traceRole, 'settle-candidate', {
              pane: paneId, tick: tick.kind, closingLen: closing?.length ?? null, pend: s.pendingTool,
              act: s.activity, window: entry.settleWindowStartedAt ?? null,
            });
            if (tick.kind === 'start-settle-window') {
              entry.settleWindowStartedAt = now();
              await park(settleWindowMs);
              continue;
            }
            if (tick.kind === 'wait') {
              await park(settleWindowMs - (now() - (entry.settleWindowStartedAt ?? now())));
              continue;
            }
            entry.settleWindowStartedAt = null;
            // No text but a stated reason means the turn died (a provider error, a refused tool): the
            // reason is the diagnosis, never a report.
            const failure = s.text === null ? (s.why ?? null) : null;
            if (await handOver(entry, closing, s.activity, current, failure) === 'retry') {
              // Notification refused (e.g. the master is mid-turn): leave the row running and
              // re-detect the same closing text on the next wake.
              await park(recheckMs);
              continue;
            }
            return;
          }
        }

        const vacuum = planVacuumTick({ waitState, paneAlive: alive, now: now(), lastActivityAt, timeoutMs });
        if (vacuum.refreshActivity) lastActivityAt = now();
        if (vacuum.action === 'pane-closed') {
          consume(now());
          try {
            await h.injectNotice(formatPaneClosedNotice(paneId, current.description), paneId,
              cardFor(entry, paneId, current.description, 'failed'));
          } catch { /* non-fatal */ }
          return;
        }
        if (vacuum.action === 'timeout') {
          // The turn can end without a closing text readable after the request boundary (a revived
          // pane answering in the same second, a transcript re-attributed mid-run). Before declaring
          // `failed`, read the transcript once more with no boundary: an assistant answer sitting at
          // the end of it IS the settlement, and "failed" for a worker that finished is a lie.
          const late = await h.session.subSessionState(paneId, cwd, 0, entry.gen.sessionFile).catch(() => null);
          const lateClosing = late?.text ?? late?.why ?? null;
          trace(traceRole, 'timeout', {
            pane: paneId, request: current.requestId, idleMs: now() - lastActivityAt,
            lateTextLen: lateClosing?.length ?? null, latePend: late?.pendingTool ?? null,
            lateAct: late?.activity ?? null, file: entry.gen.sessionFile,
          });
          if (late && lateClosing != null && !late.pendingTool) {
            entry.settleWindowStartedAt = null;
            const lateFailure = late.text === null ? (late.why ?? null) : null;
            if (await handOver(entry, lateClosing, late.activity, current, lateFailure) === 'retry') {
              await park(recheckMs);
              continue;
            }
            return;
          }
          consume(now());
          trace(traceRole, 'consumed', { pane: paneId, via: 'poll-timeout', request: current.requestId });
          const notice = formatSettleTimeoutNotice({
            paneId,
            description: current.description,
            idleSeconds: Math.round((now() - lastActivityAt) / 1000),
            startedAtIso: new Date(startedAt).toISOString(),
          });
          try {
            await h.injectNotice(notice, paneId,
              cardFor(entry, paneId, current.description, 'failed'));
          } catch { /* non-fatal */ }
          return;
        }
        await park(Math.min(recheckMs, timeoutMs - (now() - lastActivityAt)));
      }
    } finally {
      pollers.delete(paneId);
    }
  }

  function startPoller(paneId: string, cwd: string, injectTs: number, description: string, requestId: string): Promise<void> {
    // Always refresh first: a follow_up arriving while the spawn poller still runs must move
    // settlement judgment to the new request instead of being dropped by the has() guard.
    const sinceTs = Math.max(0, injectTs - REQUEST_BOUNDARY_SLACK_MS);
    requestByPane.set(paneId, { injectTs: sinceTs, description, requestId });
    if (pollers.has(paneId)) return Promise.resolve();
    pollers.add(paneId);
    return (async () => {
      try {
        if (!subScopes.has(paneId)) {
          const fiber = await mountSubagentScope(h.sessionRoot, paneId, {
            onDispose: () => { pollers.delete(paneId); },
          });
          subScopes.set(paneId, fiber);
        }
        await pollLoop(paneId, cwd, sinceTs, description, requestId);
        const fiber = subScopes.get(paneId);
        subScopes.delete(paneId);
        try { await fiber?.dispose(); } catch { /* already gone */ }
      } catch (err) {
        pollers.delete(paneId);
        console.error(`piher: subagent poller ${paneId} crashed: ${(err as Error)?.message ?? err}`);
      }
    })();
  }

  return { startPoller, pollers };
}
