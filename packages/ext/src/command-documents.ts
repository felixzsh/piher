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
import { commandDocName, writeDocument, type DocumentWriteResult } from './report-documents.ts';

/** What a command asks for (spec S10). `send` writes `follow_up`; the rest are named so one value
 *  shape covers every command a worker may be handed. */
export type CommandType = 'prompt' | 'follow_up' | 'interrupt';

/** pi's own delivery modes (`pi.sendUserMessage`): `steer` is delivered after the tool calls the
 *  turn is running and before the next model call, `followUp` waits for the turn to end. */
export type CommandDeliverAs = 'steer' | 'followUp';

/** Command document value (spec S10). */
export interface CommandDocumentValue {
  id: string;
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
    && typeof v.type === 'string' && COMMAND_TYPES[v.type as CommandType] === true
    && typeof v.text === 'string' && v.text !== ''
    && typeof v.deliverAs === 'string' && DELIVERY_MODES[v.deliverAs as CommandDeliverAs] === true;
}

/** A unique id per command: two sends in the same millisecond must not look like one command. */
export function newCommandId(now = Date.now()): string {
  return `cmd-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What the master writes for `send`: a follow-up delivered as a steer (spec S15). */
export function steerCommand(text: string, id = newCommandId()): CommandDocumentValue {
  return { id, type: 'follow_up', text, deliverAs: 'steer' };
}

export type CommandPlan =
  /** A command this worker has not applied yet: hand it to pi. */
  | { kind: 'apply'; value: CommandDocumentValue }
  /** Already applied by this worker (a re-read, or an event that raced the clear): clear it, never
   *  apply it twice. */
  | { kind: 'duplicate'; value: CommandDocumentValue }
  /** Nothing to do: the document was cleared, or it does not hold a command. */
  | { kind: 'none' };

/** Whether a value read from `piher.cmd.<address>` is a command to apply. */
export function planCommandApplication(input: {
  value: unknown;
  /** The id this worker applied last; a document still carrying it was already delivered. */
  appliedId: string | null;
}): CommandPlan {
  if (!isCommandDocumentValue(input.value)) return { kind: 'none' };
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

/** Clear a command the worker applied (spec S11). A stale version is not an error: the document
 *  moved on, which means a newer command is waiting and this one must not be written over it.
 *  Clearing matters: a worker that restarts has no memory of ids, so a command left behind would
 *  be applied a second time. */
export async function clearCommandDocument(
  client: CoreClientLike,
  name: string,
  version: number,
): Promise<boolean> {
  try {
    await client.docSet(name, null, version);
    return true;
  } catch {
    return false;
  }
}

/** What became of a command the master wrote. */
export type CommandPickup =
  /** The worker cleared the document: it read the command and handed it to pi. */
  | { kind: 'applied' }
  /** Still sitting in the core, or a chain of writes that cannot say whether it was read. */
  | { kind: 'pending' }
  /** A newer command replaced ours in the very next version: ours was never read. */
  | { kind: 'replaced' }
  /** The document store could not answer; nothing is claimed either way. */
  | { kind: 'unknown'; reason: string };

/**
 * Classify one read of the command document against the write this master made.
 *
 * `doc.set` bumps the version on every write and a deletion retains it, so the version says how far
 * the document has moved: exactly one step means either the worker cleared ours or another command
 * overwrote it, and anything further cannot separate "applied and replaced since" from "overwritten
 * late" — that case stays `pending` rather than claiming a delivery it cannot prove.
 */
export function planCommandPickup(input: {
  read: { value: unknown; version: number } | null;
  /** The write being tracked: its id and the version `doc.set` answered for it. */
  wrote: { id: string; version: number };
}): CommandPickup {
  const { read, wrote } = input;
  if (read === null) return { kind: 'unknown', reason: 'no document store answered' };
  if (read.value === null) return { kind: 'applied' };
  const moved = read.version - wrote.version;
  if (isCommandDocumentValue(read.value) && read.value.id === wrote.id) return { kind: 'pending' };
  if (moved <= 1) return { kind: 'replaced' };
  return { kind: 'pending' };
}

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
  opts: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CommandPickup> {
  const interval = Math.max(1, opts.intervalMs ?? 20);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (;;) {
    let read: { value: unknown; version: number } | null;
    try {
      read = await client.docGet(name);
    } catch (err) {
      const message = (err as { message?: unknown })?.message;
      const reason = typeof message === 'string' && message !== '' ? message : String(err);
      return { kind: 'unknown', reason };
    }
    const pickup = planCommandPickup({ read, wrote });
    if (pickup.kind !== 'pending') return pickup;
    const left = deadline - Date.now();
    if (left <= 0) return pickup;
    await sleep(Math.min(interval, left));
  }
}
