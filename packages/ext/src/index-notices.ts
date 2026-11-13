/**
 * D92 settlement-notice buffer: `sendUserMessage(followUp)` only delivers when the agent has no
 * more tool calls, so a long master run would queue every settlement and flood at the end. Buffer
 * while busy; flush at turn_end (steer) / agent_settled (followUp), collapsing large batches. */

import type { SettlementCard } from './settlement-card.ts';

export type NoticeSendMode = 'steer' | 'followUp';

export const NOTICE_MAX_SHOWN = 3;

/** Collapse a batch into one message body: empty → null; above the cap, the first max originals plus
 *  a tail pointing at history / subagent list. A single-item batch stays byte-identical to the
 *  direct-send format. */
export function collapseNotices(contents: readonly string[], max = NOTICE_MAX_SHOWN): string | null {
  if (contents.length === 0) return null;
  if (contents.length <= max) return contents.join('\n\n');
  const hidden = contents.length - max;
  const tail = `…${hidden} more settlement(s) not shown individually. Read each worker's own transcript `
    + 'for the full result; use subagent list for running agents.';
  return [...contents.slice(0, max), tail].join('\n\n');
}

export interface NoticeBuffer {
  /** Hand one notice over. Resolving means the buffer has it — buffered while busy, or handed to pi.
   *  `onAccepted` fires only when pi actually took the message, which is the only moment a delivery
   *  may be recorded (a buffered notice is RAM, and RAM does not survive a `/reload`). */
  deliverNotice(
    content: string,
    paneId?: string,
    card?: SettlementCard | null,
    onAccepted?: () => void,
  ): Promise<void>;
  noticePending(): ReadonlySet<string>;
  flush(mode: NoticeSendMode): Promise<void>;
}

export function createNoticeBuffer(opts: {
  /** True while the agent is in a turn, or after an abort that must not wake a new run. */
  isBusy: () => boolean;
  /** One collapsed body; the card describes a single settlement and is omitted for a batch. False
   *  means pi was not given the message (a host with no send method), so nothing may be recorded. */
  send: (content: string, mode: NoticeSendMode, card?: SettlementCard) => Promise<boolean | void>;
}): NoticeBuffer {
  type PendingNotice = { content: string; paneId?: string; card?: SettlementCard; onAccepted?: () => void };
  const pending: PendingNotice[] = [];
  const pendingPaneIds = new Set<string>();
  /** A refused send is not a delivered settlement: keep the batch and its panes for the next flush. */
  const requeue = (notices: readonly PendingNotice[]): void => {
    pending.unshift(...notices);
  };
  /** Record the deliveries pi accepted. A callback that throws must not cost the rest of the batch. */
  const acceptAll = (notices: readonly PendingNotice[]): void => {
    for (const notice of notices) {
      try {
        notice.onAccepted?.();
      } catch (err) {
        console.error(`piher: settlement acceptance handler failed: ${(err as Error)?.message ?? err}`);
      }
    }
  };
  return {
    async deliverNotice(content, paneId, card, onAccepted) {
      const notice: PendingNotice = { content, paneId, ...(card ? { card } : {}), ...(onAccepted ? { onAccepted } : {}) };
      if (content !== '' && paneId !== undefined) pendingPaneIds.add(paneId);
      if (opts.isBusy()) {
        pending.push(notice);
        return;
      }
      let accepted: boolean | void;
      try {
        accepted = await opts.send(content, 'followUp', card ?? undefined);
      } catch (err) {
        // pi drops prompts while the agent is mid-turn; holding the notice keeps it (and keeps its
        // pane GC-exempt) until a flush can deliver it, instead of losing the settlement here.
        requeue([notice]);
        return;
      }
      if (accepted === false) {
        // The host has no way to take a message: nothing was delivered, so nothing is recorded.
        requeue([notice]);
        return;
      }
      if (content !== '' && paneId !== undefined) pendingPaneIds.delete(paneId);
      acceptAll([notice]);
    },
    noticePending: () => pendingPaneIds,
    async flush(mode) {
      if (pending.length === 0) return;
      const flushed = pending.splice(0);
      const collapsed = collapseNotices(flushed.map((n) => n.content));
      if (collapsed) {
        let accepted: boolean | void;
        try {
          accepted = await opts.send(collapsed, mode, flushed.length === 1 ? flushed[0]!.card : undefined);
        } catch {
          requeue(flushed);
          return;
        }
        if (accepted === false) {
          requeue(flushed);
          return;
        }
      }
      // Release only this batch's panes, and only once it is delivered: a notice buffered during the
      // send await, or a batch a refused send put back, is still undelivered and its pane must stay.
      for (const { paneId } of flushed) {
        if (paneId !== undefined && !pending.some((n) => n.paneId === paneId)) pendingPaneIds.delete(paneId);
      }
      // One collapsed message carries every notice in the batch: pi accepted them together. An empty
      // batch carried nothing, so nobody's delivery is recorded.
      if (collapsed) acceptAll(flushed);
    },
  };
}
