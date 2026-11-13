/**
 * Settled-wake decision (prevents wake storms): a settle wake that injects messages creates a
 * self-triggering loop (settle → notice → new run → settle → …) that even ESC cannot break, so an
 * aborted previous turn injects nothing and a running set is announced once, re-announced only after
 * D96_REPEAT_NOTICE_MS or when the set changes.
 */

export const ABORT_STOP_REASON = 'aborted';

/** pi/provider failure stop. pi auto-retries these, so the run has not settled for the user. */
export const ERROR_STOP_REASON = 'error';

/** D96: cooldown before repeating a notice for the same running set. */
export const D96_REPEAT_NOTICE_MS = 10 * 60_000;

export interface SettleWakeInput {
  /** stopReason of the last assistant turn (null = treated as natural completion). */
  lastStopReason: string | null;
  /**
   * pi ≥ 1.1 carries `aborted` on agent_settled itself: authoritative for runs cancelled without a
   * final assistant message (ESC mid-tool), where stopReason tracking sees a stale natural reason.
   */
  aborted?: boolean;
  running: ReadonlyArray<{ paneId: string }>;
  lastNoticeKey: string | null;
  lastNoticeAt: number;
  now: number;
}

export interface SettleWakePlan {
  /** false means this settlement stays silent and emits no wake-up message. */
  wake: boolean;
  notice: boolean;
  /** New set key; empty running set → null. */
  noticeKey: string | null;
  noticeAt: number;
}

export function planSettleWake(input: SettleWakeInput): SettleWakePlan {
  if (input.aborted === true || input.lastStopReason === ABORT_STOP_REASON) {
    return {
      wake: false,
      notice: false,
      noticeKey: input.lastNoticeKey,
      noticeAt: input.lastNoticeAt,
    };
  }
  const key = input.running.length === 0 ? null : input.running.map((s) => s.paneId).sort().join(',');
  if (key === null) {
    return { wake: true, notice: false, noticeKey: null, noticeAt: input.lastNoticeAt };
  }
  const newSet = key !== input.lastNoticeKey;
  const cooled = input.now - input.lastNoticeAt >= D96_REPEAT_NOTICE_MS;
  const notice = newSet || cooled;
  return { wake: true, notice, noticeKey: key, noticeAt: notice ? input.now : input.lastNoticeAt };
}

/**
 * Whether a just-settled run has anything to report at all. A user abort ('aborted') settles a run
 * that may re-run, and an 'error' stop is an upstream failure pi retries — reporting then says
 * "finished, nothing to say" over live work, and a one-shot would exit on it, so the real closing
 * message could never arrive.
 */
export function reportsSettlement(input: {
  /** pi ≥ 1.1 agent_settled.aborted: the run was cancelled — the closing message may still come after a re-run. */
  aborted?: boolean;
  lastStopReason: string | null;
}): boolean {
  return input.aborted !== true
    && input.lastStopReason !== ABORT_STOP_REASON
    && input.lastStopReason !== ERROR_STOP_REASON;
}
