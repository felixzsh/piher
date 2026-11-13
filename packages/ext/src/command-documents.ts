/**
 * Steering command documents (spec S9–S11, S15, S24): a `send` reaches a worker through the core.
 *
 * The master writes `piher.cmd.<address>` with the text and how it must be delivered; the worker's
 * own extension watches `doc` notifications, reads the value and applies it with
 * `pi.sendUserMessage(text, {deliverAs})`. That is what keeps pi's steering semantics — delivered
 * between tool calls, not behind the whole turn (S15); `terminal.send` only pastes into the TUI.
 *
 * Two consequences of the core's own rules shape this module:
 *  - a `doc` event carries the name and the version, never the value (S23), so the trigger is the
 *    event and the value is one `doc.get`;
 *  - `events.subscribe` takes over its connection (S24), and a document is core-global, so the
 *    worker's watch is a second, unfiltered subscription (see `CoreClientLike.watchDocuments`).
 *
 * Pure planners decide; adapters do I/O. `report-documents.ts` owns the naming rules and the
 * compare-and-swap write both documents share.
 */
import type { CoreClientLike } from './core-client.ts';
import {
  MAX_DOCUMENT_BYTES, commandDocName, documentByteLength, writeDocument, type DocumentWriteResult,
} from './report-documents.ts';

/** What a command asks for (spec S10). `send` writes `follow_up`; the rest are named so one value
 *  shape covers every command a worker may be handed. */
export type CommandType = 'prompt' | 'follow_up' | 'interrupt';

/** pi's own delivery modes (`pi.sendUserMessage`): `steer` is delivered after the tool calls the
 *  turn is running and before the next model call, `followUp` waits for the turn to end. */
export type CommandDeliverAs = 'steer' | 'followUp';

/** Command document value (spec S10, plus the task it belongs to). A document outlives a core
 *  restart and terminal addresses restart with the core, so the id alone cannot say whether a
 *  leftover command is for the worker now living at this address: the task id can, and the worker
 *  refuses a command that is not its own — exactly as the report guard refuses a foreign report. */
export interface CommandDocumentValue {
  id: string;
  /** The task the command was written for (spec S3: the address names, the task id identifies). */
  taskId: string;
  type: CommandType;
  text: string;
  deliverAs: CommandDeliverAs;
}

const COMMAND_TYPES: Record<CommandType, true> = { prompt: true, follow_up: true, interrupt: true };
const DELIVERY_MODES: Record<CommandDeliverAs, true> = { steer: true, followUp: true };

/** Types this channel may hand to pi as a user message (spec S10's `interrupt` is not one). */
const APPLICABLE_TYPES: Record<CommandType, true | undefined> = {
  prompt: true, follow_up: true, interrupt: undefined,
};

/** Structural guard: a foreign or half-written value is not a command, and must never be applied.
 *  `deliverAs` is required — pi rejects a message sent while streaming without it. */
export function isCommandDocumentValue(value: unknown): value is CommandDocumentValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && v.id !== ''
    && typeof v.taskId === 'string' && v.taskId !== ''
    && typeof v.type === 'string' && COMMAND_TYPES[v.type as CommandType] === true
    && typeof v.text === 'string' && v.text !== ''
    && typeof v.deliverAs === 'string' && DELIVERY_MODES[v.deliverAs as CommandDeliverAs] === true;
}

/** A unique id per command: two sends in the same millisecond must not look like one command. */
export function newCommandId(now = Date.now()): string {
  return `cmd-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What the master writes for `send`: a follow-up delivered as a steer (spec S15). */
export function steerCommand(
  text: string,
  taskId: string,
  id = newCommandId(),
): CommandDocumentValue {
  return { id, taskId, type: 'follow_up', text, deliverAs: 'steer' };
}

/** The core refuses a document over its ceiling (1 MiB). A steer that large is a mistake, and
 *  trimming it would deliver half an instruction, so it is refused with the sizes named instead of
 *  written (spec S13's ceiling, S15's channel). Null when the value fits. */
export function commandDocumentOverflow(
  value: CommandDocumentValue,
  maxBytes = MAX_DOCUMENT_BYTES,
): number | null {
  const bytes = documentByteLength(value);
  return bytes > maxBytes ? bytes : null;
}

export type CommandPlan =
  /** A command this worker has not applied yet: hand it to pi. */
  | { kind: 'apply'; value: CommandDocumentValue }
  /** Already applied by this worker (a re-read, or an event that raced the clear): clear it, never
   *  apply it twice. */
  | { kind: 'duplicate'; value: CommandDocumentValue }
  /** Nothing to do: the document was cleared, it holds no command, or it is another task's. */
  | { kind: 'none' };

/** Whether a value read from `piher.cmd.<address>` is a command this worker must apply. */
export function planCommandApplication(input: {
  value: unknown;
  /** The id this worker applied last; a document still carrying it was already delivered. */
  appliedId: string | null;
  /** This worker's own task id, or null when it has no delegation identity at all. */
  taskId: string | null;
}): CommandPlan {
  if (!isCommandDocumentValue(input.value)) return { kind: 'none' };
  // S26: a worker refuses a command whose task id is not its own — and a worker with no identity
  // refuses every command, because it cannot be the one the command was written for. A pane a
  // person started by hand may sit at an address that held another task, with that task's steer
  // still in the core; without this, it would apply it.
  if (input.taskId === null || input.value.taskId !== input.taskId) return { kind: 'none' };
  // Stopping a turn is pi's abort, not a user message: an `interrupt` value is left alone rather
  // than delivered as text, and the master still interrupts over the pane channel (spec S16).
  if (!APPLICABLE_TYPES[input.value.type]) return { kind: 'none' };
  if (input.appliedId !== null && input.value.id === input.appliedId) {
    return { kind: 'duplicate', value: input.value };
  }
  return { kind: 'apply', value: input.value };
}

/** Write the command a worker must apply. The CAS retry lives in `writeDocument` (spec S11). */
export function writeCommandDocument(
  client: CoreClientLike,
  address: string,
  value: CommandDocumentValue,
  opts: { attempts?: number } = {},
): Promise<DocumentWriteResult> {
  return writeDocument(client, commandDocName(address), value, {
    ...opts,
    unsupported: `"${address}" cannot name a command document (S9)`,
  });
}

/** How often a failed clear is retried: a steer that was applied must not stay in the core, or a
 *  restarted worker (which has no memory of ids) applies it a second time. */
const CLEAR_ATTEMPTS = 3;

/** Clear a command the worker applied (spec S11), retrying a transport failure. A stale version is
 *  not retried: the document moved on, which means a newer command is waiting and this one must not
 *  be written over it — that command carries its own fate. Returns whether the document is gone. */
export async function clearCommandDocument(
  client: CoreClientLike,
  name: string,
  version: number,
  opts: { attempts?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? CLEAR_ATTEMPTS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await client.docSet(name, null, version);
      return true;
    } catch (err) {
      const kind = (err as { kind?: unknown })?.kind;
      if (kind === 'conflict') return false; // a newer command is there: not ours to delete
    }
  }
  return false;
}

/** What became of a command the master wrote. */
export type CommandPickup =
  /** The document was cleared one version after our write: the worker read the command and handed
   *  it to pi. */
  | { kind: 'applied' }
  /** Our command is still there, unread: nothing read it within the budget. */
  | { kind: 'unread' }
  /** The document moved on past ours, so no read can say whether ours was applied: it may have been
   *  applied and then left behind when a newer write took the document. */
  | { kind: 'unsettled' }
  /** The store could not answer, or the document went backwards; nothing is claimed either way. */
  | { kind: 'unknown'; reason: string };

/**
 * Classify one read of the command document against the write this master made.
 *
 * The ack is the *version the absence landed at*, never absence alone. Measured on `hc 0.1.20`
 * (private core, 2026-11-13): `doc.set` at v0 answers 1, at v1 answers 2,
 * `doc.set(null, version 2)` answers **3** — a delete bumps the version like any write — `doc.get`
 * then reads `{value: null, version: 3}`, and the next `doc.set(version 3)` answers 4. (The
 * schema's "deletions retain their version" means the counter keeps a history, not that it stands
 * still.) So absence at exactly our version + 1 is our clear, and further on it is somebody else's
 * write being read: two sibling sends for one worker (A at v1, B at v2, B read and cleared to v3)
 * leave A looking at `{value: null, version: 3}`, which is not A's delivery.
 *
 * The one thing a read can never establish is that a command was *not* applied. Ours at v1, another
 * command written at v2 while the worker was reading ours: the worker hands ours to pi, its clear
 * is refused with `conflict`, and the document holds theirs — indistinguishable from our write
 * being overwritten before anyone read it. That is `unsettled`, and it must never be reported as
 * "nothing was applied" (spec S7 forbids a second delivery of the same steer).
 */
export function planCommandPickup(input: {
  read: { value: unknown; version: number } | null;
  /** The write being tracked: its id and the version `doc.set` answered for it. */
  wrote: { id: string; version: number };
}): CommandPickup {
  const { read, wrote } = input;
  if (read === null) return { kind: 'unknown', reason: 'no document store answered' };
  const moved = read.version - wrote.version;
  // A document that went backwards was lost (a store that forgot it, a different core): the version
  // we wrote against no longer describes anything.
  if (moved < 0) {
    return { kind: 'unknown', reason: `version ${read.version}, behind ${wrote.version}` };
  }
  if (moved === 1 && read.value === null) return { kind: 'applied' };
  if (isCommandDocumentValue(read.value) && read.value.id === wrote.id) return { kind: 'unread' };
  return { kind: 'unsettled' };
}

/** First and largest wait between two reads: a steer is read in milliseconds when a worker is
 *  watching, so the reads back off instead of hammering the core while the tool call blocks. */
const PICKUP_FIRST_WAIT_MS = 10;
const PICKUP_MAX_WAIT_MS = 160;

/**
 * Wait for the worker to read the command, within `budgetMs`. The write already landed in the core
 * (it is durable), so this buys exactly one thing: the difference between "the core holds it" and
 * "the worker applied it". A worker whose extension is not running cannot apply anything, and a
 * master that said "sent" there would be guessing.
 */
export async function awaitCommandPickup(
  client: CoreClientLike,
  name: string,
  wrote: { id: string; version: number },
  budgetMs: number,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    /** Test seam for the budget clock, so a wait is measured by its waits and not by wall time. */
    now?: () => number;
    /** The tool call's own signal: a cancelled send stops reading the core. */
    signal?: AbortSignal;
  } = {},
): Promise<CommandPickup> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const now = opts.now ?? Date.now;
  const deadline = now() + Math.max(0, budgetMs);
  let wait = PICKUP_FIRST_WAIT_MS;
  for (;;) {
    if (opts.signal?.aborted) return { kind: 'unknown', reason: 'cancelled' };
    let read: { value: unknown; version: number } | null;
    try {
      read = await client.docGet(name);
    } catch (err) {
      const message = (err as { message?: unknown })?.message;
      const reason = typeof message === 'string' && message !== '' ? message : String(err);
      return { kind: 'unknown', reason };
    }
    const pickup = planCommandPickup({ read, wrote });
    // Only "still ours, unread" can improve by waiting: every other answer is final — an applied
    // command does not become unapplied, and further writes cannot undo a replace or a settle.
    if (pickup.kind !== 'unread') return pickup;
    const left = deadline - now();
    if (left <= 0) return pickup;
    await sleep(Math.min(wait, left));
    wait = Math.min(wait * 2, PICKUP_MAX_WAIT_MS);
  }
}
