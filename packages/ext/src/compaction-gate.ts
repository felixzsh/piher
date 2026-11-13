/**
 * E8: piher's state crosses a compaction intact.
 *
 * Compaction is a prefix operation (`docs/compaction.md`): everything before `firstKeptEntryId` is
 * replaced by a summary, and the extension hooks bracket it — `session_before_compact` before the cut
 * (`session_compact` after it, `session_compact_failed` when it was cancelled or failed). Two
 * obligations follow, and they are one object because their order is the whole guarantee:
 *
 * 1. **Nothing piher says may land inside the prefix.** A settlement announced while the summary is
 *    being written would be one more message in the span being replaced: the master would read it, the
 *    summary would swallow it. `before()` pauses the notice buffer, so a notice that arrives in the
 *    window stays in RAM (its ledger fact is already durable) and is delivered after the cut. A
 *    cancelled compaction cut nothing, so `failed()` only resumes — no roster, no delivery.
 * 2. **The fresh context is told the state, from the records.** `after()` re-states the roster
 *    (`compact-roster.ts`) before the buffer resumes, so the roster rides the same message as whatever
 *    settlements were waiting: one injection, one turn, and never a summary of a summary.
 *
 * A master that is busy when the cut lands is left alone: pi queues a follow-up behind the running
 * turn, and the next turn boundary flushes the buffer as it always does. Sending into a running turn
 * is what the buffer exists to avoid.
 */
import type { NoticeBuffer } from './index-notices.ts';

export interface CompactionGateDeps {
  /** The one notice buffer this process delivers through. */
  buffer: Pick<NoticeBuffer, 'pause' | 'resume' | 'flush' | 'deliverNotice'>;
  /** The roster text from the records, or null for a host that holds no records (a worker, a bare
   *  pi): then the cut is still honoured and nothing is re-stated. */
  roster: () => string | null;
  /** True while the agent is in a turn, or after an abort that must not wake a new run. */
  isBusy: () => boolean;
}

export interface CompactionGate {
  /** `session_before_compact`: hold everything until the cut is done. */
  before(): void;
  /** `session_compact`: re-state the records, then release the buffer. */
  after(): Promise<void>;
  /** `session_compact_failed`: nothing was cut, so nothing is re-stated — only released. */
  failed(): void;
  /** Whether a compaction is in flight (a second `before` cannot happen, but a caller may ask). */
  compacting(): boolean;
}

export function createCompactionGate(deps: CompactionGateDeps): CompactionGate {
  let open = false;
  return {
    before() {
      if (open) return;
      open = true;
      deps.buffer.pause();
    },
    async after() {
      // A `session_compact` with no `before` (a hook mounted mid-compaction) cut nothing under us:
      // nothing was held, so nothing may be re-stated.
      if (!open) return;
      open = false;
      try {
        // Handed over while still paused: it joins the buffer, so the roster and the pending
        // settlements are one message instead of two turns.
        const roster = deps.roster();
        if (roster !== null) await deps.buffer.deliverNotice(roster);
      } finally {
        // Released even when the roster could not be built: a paused buffer would hold every later
        // settlement of the session.
        deps.buffer.resume();
      }
      if (!deps.isBusy()) await deps.buffer.flush('followUp');
    },
    failed() {
      open = false;
      deps.buffer.resume();
    },
    compacting: () => open,
  };
}
