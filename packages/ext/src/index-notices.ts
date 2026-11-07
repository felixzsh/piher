/**
 * D92 settlement-notice buffer: `sendUserMessage(followUp)` only delivers when the agent has no
 * more tool calls, so a long master run would queue every settlement and flood at the end. Buffer
 * while busy; flush at turn_end (steer) / agent_settled (followUp), collapsing large batches. */

import type { SettlementCard } from './settlement-card.ts';
import { trace, traceRole } from './trace.ts';

export type NoticeSendMode = 'steer' | 'followUp';

export const NOTICE_MAX_SHOWN = 3;

/** Collapse a batch into one message body: empty → null; above the cap, the first max originals plus
 *  a tail pointing at history / subagent list. A single-item batch stays byte-identical to the
 *  direct-send format. */
export function collapseNotices(contents: readonly string[], max = NOTICE_MAX_SHOWN): string | null {
  if (contents.length === 0) return null;
  if (contents.length <= max) return contents.join('\n\n');
  const hidden = contents.length - max;
  const tail = `…${hidden} more settlement(s) not shown individually. See the history ledger for full results (path formula in the subagent resume tool description); use subagent list for running agents.`;
  return [...contents.slice(0, max), tail].join('\n\n');
}

export interface NoticeBuffer {
  deliverNotice(content: string, paneId?: string, card?: SettlementCard | null): Promise<void>;
  noticePending(): ReadonlySet<string>;
  flush(mode: NoticeSendMode): Promise<void>;
}

export function createNoticeBuffer(opts: {
  /** True while the agent is in a turn, or after an abort that must not wake a new run. */
  isBusy: () => boolean;
  /** One collapsed body; the card describes a single settlement and is omitted for a batch. */
  send: (content: string, mode: NoticeSendMode, card?: SettlementCard) => Promise<void>;
}): NoticeBuffer {
  const pending: Array<{ content: string; paneId?: string; card?: SettlementCard }> = [];
  const pendingPaneIds = new Set<string>();
  /** A refused send is not a delivered settlement: keep the batch and its panes for the next flush. */
  const requeue = (notices: readonly { content: string; paneId?: string; card?: SettlementCard }[]): void => {
    pending.unshift(...notices);
  };
  return {
    async deliverNotice(content, paneId, card) {
      if (content !== '' && paneId !== undefined) pendingPaneIds.add(paneId);
      if (opts.isBusy()) {
        pending.push({ content, paneId, ...(card ? { card } : {}) });
        trace(traceRole, 'notice-buffered', { pane: paneId ?? null, queued: pending.length, contentLen: content.length });
        return;
      }
      try {
        await opts.send(content, 'followUp', card ?? undefined);
        trace(traceRole, 'notice-sent', { pane: paneId ?? null, contentLen: content.length });
      } catch (err) {
        // pi drops prompts while the agent is mid-turn; holding the notice keeps it (and keeps its
        // pane GC-exempt) until a flush can deliver it, instead of losing the settlement here.
        requeue([{ content, paneId, ...(card ? { card } : {}) }]);
        trace(traceRole, 'notice-requeued', {
          pane: paneId ?? null, queued: pending.length, error: String((err as Error)?.message ?? err),
        });
        return;
      }
      if (content !== '' && paneId !== undefined) pendingPaneIds.delete(paneId);
    },
    noticePending: () => pendingPaneIds,
    async flush(mode) {
      if (pending.length === 0) return;
      const flushed = pending.splice(0);
      const collapsed = collapseNotices(flushed.map((n) => n.content));
      if (collapsed) {
        try {
          await opts.send(collapsed, mode, flushed.length === 1 ? flushed[0]!.card : undefined);
          trace(traceRole, 'notice-flushed', { mode, count: flushed.length, contentLen: collapsed.length });
        } catch (err) {
          requeue(flushed);
          trace(traceRole, 'notice-flush-failed', {
            mode, count: flushed.length, error: String((err as Error)?.message ?? err),
          });
          return;
        }
      }
      // Release only this batch's panes, and only once it is delivered: a notice buffered during the
      // send await, or a batch a refused send put back, is still undelivered and its pane must stay.
      for (const { paneId } of flushed) {
        if (paneId !== undefined && !pending.some((n) => n.paneId === paneId)) pendingPaneIds.delete(paneId);
      }
    },
  };
}
