/**
 * Background settlement watcher: the worker's report document, the silence budget and a report for a
 * pane that closed — plus its per-subagent Cordis scope. Each loop reads the worker from the master's
 * `WorkerWatch` snapshot and parks on its change counter, so a worker that is working, blocked or idle
 * costs no RPCs between events. Nothing here derives settlement from a transcript or a timer (spec S5).
 */
import { Context } from '@deepseek-ai/cordis';
import type { CoreClientLike, CoreStatus, TerminalInfo } from './core-client.ts';
import {
  applyReportedSessionFile, isClosed, isSpent, taskForPane, type TaskEntry, type TaskObservation,
} from './task-row.ts';
import { runtimePolicy, type RuntimePolicy } from './runtime-policy.ts';
import { formatFailureNotice, formatSettlementNotice } from './vocab.ts';
import { settlementCard, type SettlementCard, type SettlementOutcome } from './settlement-card.ts';
import { buildBlockedGateNotice, reportFingerprint } from './subagent-core.ts';
import {
  isReportDocumentValue, planReportDelivery, reportDeliveryKey, reportDocName,
  type ReportDocumentValue,
} from './report-documents.ts';
import { retirePane } from './subagent-gc.ts';
import type { SessionIo } from './subagent-session.ts';

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

export type SilenceTickPlan = {
  /** The worker said nothing to act on (working, or the watch is blind): this tick is a heartbeat. */
  refreshActivity: boolean;
  action: 'pane-closed' | 'silence-timeout' | 'settled-without-report' | 'continue';
};

/**
 * The silence budget: the only timer left in settlement, and it is not a settlement path. A worker
 * that never reports anything DID fail to report, so its silence has to end somewhere — this decides
 * where, and reports a pane that is simply gone (a native fact, not a guess).
 *
 * The core's `turn` separates the two endings: a worker whose turn ran has settled and left no
 * report document (its write side is missing), which is not the same finding as a worker that never
 * got anywhere — and telling the master the second when it is the first is a lie about its work.
 */
export function planSilenceTick(input: {
  waitState: WaitState;
  paneAlive: boolean;
  now: number;
  lastActivityAt: number;
  timeoutMs: number;
  /** The core's turn counter for this terminal, or null when the watch cannot say. */
  turn: number | null;
}): SilenceTickPlan {
  const refreshActivity = input.waitState === null;
  const lastActivityAt = refreshActivity ? input.now : input.lastActivityAt;
  if (!input.paneAlive) return { refreshActivity, action: 'pane-closed' };
  if (input.now - lastActivityAt > input.timeoutMs) {
    return { refreshActivity, action: (input.turn ?? 0) >= 1 ? 'settled-without-report' : 'silence-timeout' };
  }
  return { refreshActivity, action: 'continue' };
}

export function buildSettlementNoticeText(
  agentLabel: string,
  closing: string | null,
  reportDeliveredAt: number | null = null,
): string {
  return formatSettlementNotice(agentLabel, closing, reportDeliveredAt);
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

/** The other ending of the silence budget: the core says a turn ran, and no report document reached
 *  the master (spec S6). Reporting this as silence would claim the worker produced nothing, when what
 *  is missing is its write side — an older piher build, no herdr extension in its pane, or a failed
 *  document write. */
export function formatNoReportNotice(input: {
  paneId: string;
  description: string;
  turn: number;
  idleSeconds: number;
}): string {
  return `Background subagent ${input.paneId} (${input.description}) ran turn ${input.turn} and no report document reached you, so nothing of what it said can be delivered — this is NOT the task's result. `
    + 'A settle always writes one, so the write side is missing: its pane has no report channel (an older piher build, or no herdr extension in it), or the document write failed. '
    + `Read what it did with subagent(action: "output", agentId ${input.paneId})${input.idleSeconds > 0 ? `, then continue it with action "send", retry it, or resume its session` : ''}.`;
}

/* ── pane scope ─────────────────────────────────────────────────── */

/** The shortest park for a wake with nothing to settle, and the longest. The core's events are the
 *  fast path (a watch wakes on any change), so this only bounds a retry — a refused notice, a pane
 *  waiting on a person, a blind watch — and it doubles while the worker stays quiet, so a long-lived
 *  watch is not a once-a-second poll. */
const MIN_RECHECK_PARK_MS = 1_000;
const MAX_RECHECK_PARK_MS = 30_000;

/** A revived pane can answer in the very second the poller starts, and a report written on that same
 *  second belongs to the new request. The boundary a document is judged against therefore carries a
 *  slack, so an answer landing exactly on it is news instead of a stale read. */
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
  session: SessionIo;
  injectNotice(content: string, paneId?: string, card?: SettlementCard | null): Promise<void>;
  /** S54/S71: what a one-shot settlement reclaims — the pane, and any checkout its spawn created. */
  reclaim?(entry: TaskEntry): void;
  now?: () => number;
  policy?: Partial<RuntimePolicy>;
}

export interface Poller {
  /** Resolves to whether the watch is armed; the loop itself runs detached. */
  startPoller(paneId: string, cwd: string, injectTs: number, description: string, requestId: string): Promise<boolean>;
  readonly pollers: Set<string>;
}

export function createPoller(h: PollerHost): Poller {
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  /** Current tracked request per pane. startPoller refreshes it even while a poller runs: a
   * follow_up must judge settlement against its own injectTs, not the original request's. */
  const requestByPane = new Map<string, { injectTs: number; description: string; requestId: string }>();
  /** Settlements already handed over from a report document, keyed by (`address`, `at`) — the
   *  document instance (spec S7). The address identifies the generation and `at` identifies the
   *  settle, so a re-read of the same document is a repeat while a revived worker's own settlement
   *  is still delivered. */
  const deliveredReports = new Set<string>();
  const now = h.now ?? Date.now;
  const timeoutMs = h.policy?.subagentTimeoutMs ?? runtimePolicy.subagentTimeoutMs;
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

  /** One `doc.get` for the worker's report document (spec S23): the `turn`/`status` event above
   *  is the trigger, this read is the settlement. Null when no document was written, when it is
   *  not a report, or when the document store cannot answer — then there is nothing to settle, and
   *  the silence budget (not a guess) owns the wait. */
  async function readReportDocument(paneId: string): Promise<ReportDocumentValue | null> {
    const name = reportDocName(paneId);
    if (!name) return null;
    try {
      const got = await h.client.docGet(name);
      if (got && isReportDocumentValue(got.value)) return got.value;
    } catch {
      /* a blind document store must not kill the loop */
    }
    return null;
  }

  /** The worker as the watch sees it. A blind watch (disconnected) never settles or fails anything. */
  async function observe(paneId: string): Promise<{
    state: CoreStatus | 'exited' | null;
    alive: boolean;
    /** The core's turn counter: a settle happened iff it moved above zero (spec S2, S5). */
    turn: number | null;
  }> {
    if (!watch.connected) return { state: null, alive: true, turn: null };
    let info: TerminalInfo | null | undefined = watch.get(paneId);
    if (!info) {
      // Not in the snapshot: a fresh spawn racing its `created` event, or a terminal that is gone.
      try {
        info = await h.client.getTerminal(paneId);
      } catch {
        return { state: null, alive: true, turn: null }; // an unreachable socket must not be read as a dead terminal
      }
    }
    if (!info || info.state === 'finished') return { state: 'exited', alive: false, turn: info?.turn ?? null };
    return { state: info.status, alive: true, turn: info.turn ?? null };
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
    /** Hand one settlement to the master: notice, then consume. The row is consumed only after the
     *  notice is accepted, and a refused one is retried on the next wake — a rejected injection must
     *  not strand a finished worker as `running` with no notice, nor consume the row while the result
     *  is still undelivered. Returns 'retry' when the notice was refused.
     *
     *  There is no claim latch here: the settlement's identity IS the document instance (`address`,
     *  `at`), which `deliverDocument` checks before calling this. A claim keyed by request would
     *  swallow the worker's NEXT unrequested settle (a person typing in its pane, a queued steer)
     *  and consume a report it never announced. */
    async function handOver(
      entry: TaskEntry,
      closing: string | null,
      request: { injectTs: number; description: string; requestId: string },
      /** The report states a reason instead of a text (an error, a refused tool). A settlement
       *  notice over it would read as success. */
      failure: string | null = null,
    ): Promise<'done' | 'retry'> {
      if (!entry.gen.sessionFile) {
        entry.gen.sessionFile = applyReportedSessionFile(
          entry.gen.sessionFile,
          await h.session.resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: request.injectTs - 2_000 }),
        );
      }
      // `subagent output` may already have returned this exact report: point there, don't repeat it.
      const delivered = closing && entry.gen.reportDelivered?.fingerprint === reportFingerprint(closing)
        ? entry.gen.reportDelivered.at
        : null;
      const notice = failure !== null
        ? formatFailureNotice(`${paneId} (${request.description})`, failure)
        : buildSettlementNoticeText(`${paneId} (${request.description})`, closing, delivered);
      try {
        // Tag the pane: a notice buffered while the master is busy must keep its row GC-exempt
        // until the flush actually delivers it.
        await h.injectNotice(notice, paneId, cardFor(entry, paneId, request.description, failure !== null ? 'failed' : 'settled'));
      } catch {
        return 'retry';
      }
      consume(now());
      return 'done';
    }

    /** Deliver this pane's report document when it holds an undelivered settlement of the current
     *  request (spec S6–S8, S23): one `doc.get`, no transcript read.
     *
     *  - `delivered` the report went out, the row is consumed;
     *  - `retry` the notice was refused (the master is mid-turn), so the next wake retries;
     *  - `duplicate` this settlement was already delivered — the same document instance;
     *  - `stale` the document answers an earlier request, not this one;
     *  - `foreign` the document belongs to another task;
     *  - `absent` no report document yet: nothing to settle, the silence budget owns the wait. */
    async function deliverDocument(
      entry: TaskEntry,
      request: { injectTs: number; description: string; requestId: string },
    ): Promise<'delivered' | 'retry' | 'duplicate' | 'stale' | 'foreign' | 'absent'> {
      const value = await readReportDocument(paneId);
      if (!value) return 'absent';
      const plan = planReportDelivery({
        value,
        taskId: entry.taskId,
        address: paneId,
        sinceTs: request.injectTs,
        delivered: entry.deliveredReport ?? null,
        deliveredKeys: deliveredReports,
      });
      if (plan.kind !== 'deliver') return plan.kind;
      if (!entry.gen.sessionFile && value.session) {
        entry.gen.sessionFile = value.session;
        h.writeRecord(entry);
      }
      // A document with no text states the reason instead (spec S8): an errored or refused turn has
      // no closing message, and the diagnosis — never the turn's stop word — is what the master can
      // act on.
      const failure = value.text === null ? (value.stopReason ?? null) : null;
      if (await handOver(entry, value.text, request, failure) === 'retry') return 'retry';
      deliveredReports.add(reportDeliveryKey(paneId, value.at));
      entry.deliveredReport = { address: paneId, at: value.at };
      return 'delivered';
    }

    await watch.ready();
    /** One notice per blocked episode, scoped to this watch: the host-wide set existed only because a
     *  re-armed watch could inherit another request's notice, and a watch cannot outlive its request. */
    let blockedNotified = false;
    /** Park length for wakes with nothing to settle: it doubles while the worker says nothing new and
     *  resets the moment anything changes — the watch's own events are the fast path, and a quiet
     *  worker (idle, blocked on a person) must not cost a wake a second. */
    let recheckMs = MIN_RECHECK_PARK_MS;
    let lastStamp: string | null = null;
    /** Whether the row was already settled when this watch was armed. Such a watch was armed for
     *  nothing and ends at once. A row settled WHILE the loop runs does not end it: that worker's next
     *  settle (a person typing in its pane, a queued steer) writes a document, and S6 says the master
     *  must read it. */
    const armedConsumed = taskForPane(h.tasks, h.panes, paneId)?.gen.consumedAt !== null;
    /** The generation's transcript can be mis-attributed at spawn (the `hresume` report lags, and the
     *  mtime fallback can adopt a PRE-EXISTING session), and that value is what `resume` restores and an
     *  existing pane is matched by. Repair it from the core's own report while the worker is here; a
     *  document's `session` field is the other, later repair. */
    const repairSessionFile = async (entry: TaskEntry, sinceTs: number): Promise<void> => {
      if (!entry.gen.sessionFile) return;
      const fixed = await h.session.reattributeStaleSessionFile(paneId, cwd, sinceTs, entry.gen.sessionFile);
      if (!fixed || fixed === entry.gen.sessionFile) return;
      entry.gen.sessionFile = fixed;
      h.writeRecord(entry);
    };
    try {
      while (true) {
        const current = requestByPane.get(paneId) ?? { injectTs, description, requestId };
        const entry = taskForPane(h.tasks, h.panes, paneId);
        if (!entry || isClosed(entry) || isSpent(entry)) return;
        if (armedConsumed) return;

        // Read the version BEFORE the state: an event landing in between still wakes the park below.
        const seen = watch.version(paneId);
        const park = async (ms: number): Promise<boolean> => {
          const woke = await watch.changed(paneId, seen, Math.max(0, ms));
          return woke;
        };
        const { state, alive, turn } = await observe(paneId);
        // Back off only while the worker says nothing new: any change is news and resets the park.
        const stamp = `${state ?? '-'}:${turn ?? '-'}`;
        if (stamp === lastStamp) recheckMs = Math.min(MAX_RECHECK_PARK_MS, recheckMs * 2);
        else { recheckMs = MIN_RECHECK_PARK_MS; lastStamp = stamp; }
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
        // Working is activity (the silence budget's heartbeat); `exited`/`unknown` carry no word to
        // act on, and `idle`/`done`/`error` are the states a report arrives in.
        const waitState: WaitState = state === 'exited' || state === 'unknown' || state === 'working' ? null : state;
        if (state === 'idle' || state === 'done' || state === 'error') {
          await repairSessionFile(entry, current.injectTs);
        }
        const gate = planBlockedGate(waitState, blockedNotified);
        if (gate.kind === 'stay-blocked') {
          if (gate.notify) {
            blockedNotified = true;
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
        if (gate.kind === 'clear-gate') blockedNotified = false;

        // A row already settled when this loop reached it keeps one reader and nothing else: the
        // worker's next settle (a person typing in its attachable pane, a queued steer) writes a
        // document, and S6 says the master must read it.
        // The wait is the silence budget, not a poll cadence — a new settle changes the core's status
        // first, and that event wakes this park, so an idle worker costs no RPCs (a `doc` event is no
        // help: spec S23 keeps them off this subscription).
        if (entry.gen.consumedAt !== null) {
          const landed = await deliverDocument(entry, current);
          if (isSpent(entry) || state === 'exited' || !alive) return;
          if (landed === 'retry') await park(recheckMs);
          else {
            lastActivityAt = now();
            await park(timeoutMs);
          }
          continue;
        }

        // ── the report document: the settlement channel (spec S6–S8, S23) ──
        // Read on any wake that does not say the worker is mid-turn. A pane that has exited is
        // included: its document may hold a complete report, and announcing "stopped before
        // settling" over a written report would turn a finished worker into a failure.
        if (state !== 'working' && state !== 'blocked') {
          const doc = await deliverDocument(entry, current);
          if (doc === 'retry') {
            await park(recheckMs);
            continue;
          }
          if (doc === 'delivered') continue; // the consumed-row reader above takes over on the next pass
          // `duplicate`, `stale`, `foreign` and `absent` fall through: the document says nothing about
          // THIS request, so the silence budget below owns the wait.
        }

        const tick = planSilenceTick({ waitState, paneAlive: alive, now: now(), lastActivityAt, timeoutMs, turn });
        if (tick.refreshActivity) lastActivityAt = now();
        if (tick.action === 'pane-closed') {
          consume(now());
          try {
            await h.injectNotice(formatPaneClosedNotice(paneId, current.description), paneId,
              cardFor(entry, paneId, current.description, 'failed'));
          } catch { /* non-fatal */ }
          return;
        }
        if (tick.action === 'silence-timeout' || tick.action === 'settled-without-report') {
          // The budget ends the wait, not the supervision: the row is consumed here (its `consumedAt`
          // is what the tab, pane and checkout sweeps wait on), and the master is told which of the
          // two endings this was. The watch stays alive — this is the only master-side reader of
          // `piher.rep.*`, and a worker that settles again (a person typing in its attachable pane, a
          // queued steer) still has a report to deliver (S6/S21).
          consume(now());
          const notice = tick.action === 'silence-timeout'
            ? formatSettleTimeoutNotice({
              paneId,
              description: current.description,
              idleSeconds: Math.round((now() - lastActivityAt) / 1000),
              startedAtIso: new Date(startedAt).toISOString(),
            })
            : formatNoReportNotice({
              paneId,
              description: current.description,
              turn: turn ?? 0,
              idleSeconds: Math.round((now() - lastActivityAt) / 1000),
            });
          try {
            await h.injectNotice(notice, paneId,
              cardFor(entry, paneId, current.description, 'failed'));
          } catch { /* non-fatal */ }
          continue;
        }
        await park(Math.min(recheckMs, timeoutMs - (now() - lastActivityAt)));
      }
    } finally {
      pollers.delete(paneId);
    }
  }

  /**
   * Arm this pane's settlement watch. Resolves to whether the watch is armed — not to when it ends: a
   * watch outlives the settlement that consumes its row (it keeps reading the worker's later reports,
   * spec S6), so the loop runs detached and its lifetime is not a caller's to await. Callers that
   * must not claim more than happened (recovery, which announces "re-armed") read the boolean.
   */
  async function startPoller(
    paneId: string,
    cwd: string,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<boolean> {
    // Always refresh first: a follow_up arriving while the spawn poller still runs must move
    // settlement judgment to the new request instead of being dropped by the has() guard.
    const sinceTs = Math.max(0, injectTs - REQUEST_BOUNDARY_SLACK_MS);
    requestByPane.set(paneId, { injectTs: sinceTs, description, requestId });
    if (pollers.has(paneId)) return true; // an armed watch already reads this pane
    pollers.add(paneId);
    try {
      if (!subScopes.has(paneId)) {
        const fiber = await mountSubagentScope(h.sessionRoot, paneId, {
          onDispose: () => { pollers.delete(paneId); },
        });
        subScopes.set(paneId, fiber);
      }
    } catch (err) {
      pollers.delete(paneId);
      console.error(`piher: subagent watch for ${paneId} could not be armed: ${(err as Error)?.message ?? err}`);
      return false;
    }
    void (async () => {
      try {
        await pollLoop(paneId, cwd, sinceTs, description, requestId);
      } catch (err) {
        console.error(`piher: subagent poller ${paneId} crashed: ${(err as Error)?.message ?? err}`);
      } finally {
        pollers.delete(paneId);
        const fiber = subScopes.get(paneId);
        subScopes.delete(paneId);
        try { await fiber?.dispose(); } catch { /* already gone */ }
      }
    })();
    return true;
  }

  return { startPoller, pollers };
}
