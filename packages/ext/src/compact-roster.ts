/**
 * E8b: what piher says about itself right after a compaction, read from the records.
 *
 * pi's compaction is a PREFIX operation (`docs/compaction.md`): the summary replaces every message
 * before `firstKeptEntryId`, so a spawn or a settlement that happened inside the summarized span is
 * prose in a summary, not a fact the master can act on. It cannot be rebuilt from what the master
 * remembers — the master's memory is the thing that was just cut — so the state is re-stated from the
 * two durable sources piher already keeps: the session's task records and the settlement ledger's
 * unread facts.
 *
 * The block is deliberately small and fixed: a wave of ten workers fits, a session with thirty costs
 * the eight that matter most plus a count, and `ROSTER_MAX_BYTES` is asserted at thirty so no
 * compaction can become the most expensive message of the session.
 */
import type { SettlementEvent } from './settlement-ledger.ts';

/** What a task is, from piher's own accounting. `settled-unread` is a settlement in the ledger that
 *  the master has not accepted: it is waiting, not lost. */
export type RosterState = 'settled-unread' | 'failed' | 'running';

export interface RosterTask {
  /** The address every action takes, and the identity every row prints. */
  paneId: string;
  /** What the worker was asked to do; `''` when its record was swept (the ledger outlives records). */
  description: string;
  state: RosterState;
  /** Since it settled (`settled-unread`, `failed`) or since it started (`running`); null when the
   *  record does not say. */
  elapsedMs?: number | null;
}

/** A line for each of eight tasks: enough for the ten-worker wave, bounded for the thirty-worker one. */
export const ROSTER_MAX_LINES = 8;

/** One description is one line: a brief is often a paragraph, and the roster is not the brief. */
export const ROSTER_DESCRIPTION_MAX = 40;

/** The ceiling of one roster block at thirty tasks, asserted in `compaction.test.ts`. */
export const ROSTER_MAX_BYTES = 1200;

/** The order a master acts in: read what is waiting, then what failed, then wait for what runs. */
const STATE_ORDER: Record<RosterState, number> = { 'settled-unread': 0, failed: 1, running: 2 };

const STATE_HINT: Record<RosterState, string> = {
  'settled-unread': 'its settlement is waiting, not lost',
  failed: 'it failed; its report names why',
  running: 'still running',
};

/** A worker the task records still say is awaiting a report: the durable half of "alive". */
export interface LiveTask {
  taskId: string;
  /** The address actions take. */
  paneId: string;
  description: string;
  /** Since it started, for the elapsed a master needs to judge whether to keep waiting. */
  startedAt: number;
}

/**
 * Merge the two durable sources into the roster: the ledger's settlement facts above the delivered
 * cursor (a fact the master has not accepted — whatever the notice buffer is holding, its fact is
 * already on disk), and the records' live rows. A task with an unread fact is `settled-unread` (or
 * `failed`), never `running`: the settlement exists, it just has not arrived.
 */
export function collectRosterTasks(input: {
  live: readonly LiveTask[];
  events: readonly SettlementEvent[];
  deliveredSeq: number;
  now: number;
}): RosterTask[] {
  const unread = new Map<string, SettlementEvent>();
  for (const event of input.events) {
    if (event.seq <= input.deliveredSeq) continue;
    // Only the facts the master acts on: a `spawned` or `steered` line is not a settlement.
    if (event.kind !== 'settled' && event.kind !== 'failed' && event.kind !== 'pane-gone') continue;
    // The newest fact of a task is the one it is known by: a retry settles the same task again.
    unread.set(event.taskId, event);
  }
  const out: RosterTask[] = [];
  for (const task of input.live) {
    const fact = unread.get(task.taskId);
    if (fact) {
      out.push({
        paneId: fact.pane,
        description: task.description,
        state: fact.kind === 'failed' ? 'failed' : 'settled-unread',
        elapsedMs: input.now - fact.at,
      });
      continue;
    }
    out.push({
      paneId: task.paneId,
      description: task.description,
      state: 'running',
      elapsedMs: input.now - task.startedAt,
    });
  }
  // A fact whose record was swept is still a fact: the ledger outlives the records, so the roster
  // names it with the address the fact carries and no description.
  const known = new Set(input.live.map((task) => task.taskId));
  for (const [taskId, fact] of unread) {
    if (known.has(taskId)) continue;
    out.push({
      paneId: fact.pane,
      description: '',
      state: fact.kind === 'failed' ? 'failed' : 'settled-unread',
      elapsedMs: input.now - fact.at,
    });
  }
  return out;
}

function elapsedText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return ` ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ` ${minutes}m`;
  return ` ${Math.floor(minutes / 60)}h`;
}

function clipped(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(no description)';
  return flat.length <= ROSTER_DESCRIPTION_MAX ? flat : `${flat.slice(0, ROSTER_DESCRIPTION_MAX - 1)}…`;
}

/** One roster block, from the records. Never null: after a compaction the master must be told what
 *  piher holds, and "nothing at all" is exactly the state it cannot verify by itself. */
export function planCompactRoster(tasks: readonly RosterTask[]): string {
  const counts: Record<RosterState, number> = { running: 0, 'settled-unread': 0, failed: 0 };
  for (const task of tasks) counts[task.state] += 1;
  const header = '[piher after compaction · from the records, not from the conversation: '
    + `${counts.running} running · ${counts['settled-unread']} settled-unread · ${counts.failed} failed]`;
  if (tasks.length === 0) {
    return `${header}\n  no worker of this session is live and nothing settled is waiting`;
  }
  // A stable sort, so the same records print the same roster: the state decides, then arrival order.
  const ordered = tasks
    .map((task, at) => ({ task, at }))
    .sort((a, b) => (STATE_ORDER[a.task.state] - STATE_ORDER[b.task.state]) || (a.at - b.at))
    .map(({ task }) => task);
  const lines = ordered.slice(0, ROSTER_MAX_LINES).map((task) =>
    `  ${task.paneId} · ${task.state}${elapsedText(task.elapsedMs)} · ${clipped(task.description)}`
    + ` — ${STATE_HINT[task.state]}`);
  const rest = ordered.length - lines.length;
  // The actions are named because the roster is where the master learns the vocabulary again.
  const trailer = rest > 0
    ? `  and ${rest} more unsettled: subagent(action:"list") names every one, action:"inbox" the unread`
    : '  subagent(action:"inbox") reads the waiting settlements; action:"list" the whole picture';
  return [header, ...lines, trailer].join('\n');
}
