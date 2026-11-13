/** Steering command documents (spec S9–S11, S15): names, value guard, CAS write, the read trigger
 *  pattern and the pickup classification a `send` reports from. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitCommandPickup, clearCommandDocument, commandDocumentOverflow, isCommandDocumentValue,
  newCommandId, planCommandApplication, planCommandPickup, steerCommand, writeCommandDocument,
  type CommandDocumentValue,
} from '../src/command-documents.ts';
import { MAX_DOCUMENT_BYTES, commandDocName } from '../src/report-documents.ts';
import { CoreError, type CoreClientLike } from '../src/core-client.ts';
import { fakeCore } from './test-utils.ts';

const TASK = 'task-1';

const command = (over: Partial<CommandDocumentValue> = {}): CommandDocumentValue => ({
  id: 'cmd-1', taskId: TASK, type: 'follow_up', text: 'wrap up and report', deliverAs: 'steer',
  ...over,
});

test('commandDocName: a worker address names its command document, junk does not', () => {
  assert.equal(commandDocName('t2'), 'piher.cmd.t2');
  assert.equal(commandDocName('p2'), 'piher.cmd.p2');
  assert.equal(commandDocName('T2'), null, 'uppercase breaks the terminal-name rules (S9)');
  assert.equal(commandDocName('t 2'), null, 'spaces break the terminal-name rules');
  assert.equal(commandDocName('t'.repeat(23)), null, 'the whole name stays within 32 characters');
  assert.equal(commandDocName('t'.repeat(22)), `piher.cmd.${'t'.repeat(22)}`,
    'and the boundary is exact');
});

test('isCommandDocumentValue: only a full command value qualifies', () => {
  assert.equal(isCommandDocumentValue(command()), true);
  assert.equal(isCommandDocumentValue(command({ type: 'prompt', deliverAs: 'followUp' })), true);
  assert.equal(isCommandDocumentValue(command({ type: 'interrupt' })), true);
  assert.equal(isCommandDocumentValue(null), false);
  assert.equal(isCommandDocumentValue([]), false);
  assert.equal(isCommandDocumentValue('wrap up'), false);
  assert.equal(isCommandDocumentValue(command({ id: '' })), false,
    'a command without an id cannot be deduped');
  assert.equal(isCommandDocumentValue({ ...command(), taskId: '' }), false,
    'a command with no task id cannot be told apart from another task’s (S3)');
  assert.equal(isCommandDocumentValue(command({ text: '' })), false,
    'a command with no text is nothing to apply');
  assert.equal(isCommandDocumentValue({ ...command(), type: 'steer' }), false,
    'unknown command type');
  // pi rejects a message sent while streaming without a delivery mode, so a value without one is
  // not a command this worker may apply.
  assert.equal(isCommandDocumentValue({ id: 'cmd-1', taskId: TASK, type: 'follow_up', text: 'x' }),
    false);
  assert.equal(isCommandDocumentValue(command({ deliverAs: 'nextTurn' as never })), false);
});

test('steerCommand: a send is a follow-up delivered as a steer (S15)', () => {
  const value = steerCommand('go on', TASK);
  assert.equal(value.type, 'follow_up');
  assert.equal(value.deliverAs, 'steer');
  assert.equal(value.text, 'go on');
  assert.equal(value.taskId, TASK,
    'the command names its task, so a stale one cannot steer a new worker');
  assert.notEqual(newCommandId(), newCommandId(),
    'two commands in one millisecond are not the same command');
});

test('commandDocumentOverflow: over the core ceiling is measured, not truncated', () => {
  assert.equal(commandDocumentOverflow(command()), null);
  const huge = command({ text: 'x'.repeat(MAX_DOCUMENT_BYTES) });
  const bytes = commandDocumentOverflow(huge);
  assert.ok(bytes !== null && bytes > MAX_DOCUMENT_BYTES, 'the size is reported, not the failure');
});

test('planCommandApplication: apply what is new, clear what was applied, ignore junk', () => {
  const plan = (
    appliedId: string | null,
    value: unknown = command(),
    taskId: string | null = TASK,
  ) =>
    planCommandApplication({ value, appliedId, taskId });
  assert.deepEqual(plan(null), { kind: 'apply', value: command() });
  assert.deepEqual(plan('cmd-0'), { kind: 'apply', value: command() });
  assert.deepEqual(plan('cmd-1'), { kind: 'duplicate', value: command() });
  assert.deepEqual(plan('cmd-1', null), { kind: 'none' });
  assert.deepEqual(plan(null, { text: 'half written' }), { kind: 'none' });
  // Stopping a turn is pi's abort, not a user message: an `interrupt` value is never delivered as
  // text.
  assert.deepEqual(plan(null, command({ type: 'interrupt' })), { kind: 'none' });
  // S3: an address outlives the worker that had it. A command written for another task is not this
  // worker's, however it got here.
  assert.deepEqual(plan(null, command({ taskId: 'task-other' })), { kind: 'none' },
    'a foreign task id is refused, never applied');
  // A worker with no delegation identity cannot be the one a command was written for, so it applies
  // none: a hand-started pane at an address that once held another task must not take its steer.
  assert.deepEqual(plan(null, command(), null), { kind: 'none' },
    'a worker with no identity refuses every command');
});

test('writeCommandDocument: CAS lands, a conflict retries, failures name a reason', async () => {
  const client = fakeCore();
  assert.deepEqual(await writeCommandDocument(client, 't2', command()), { ok: true, version: 1 });
  assert.deepEqual((await client.docGet('piher.cmd.t2'))?.value, command());

  const base = fakeCore();
  let sets = 0;
  const conflicted: CoreClientLike = {
    ...base,
    docSet: async (name, value, version) => {
      sets += 1;
      if (sets === 1) {
        throw new CoreError('doc.set', 'conflict', 'stale',
          'read doc.get and retry with its version');
      }
      return base.docSet(name, value, version);
    },
  };
  const written = await writeCommandDocument(conflicted, 't2', command());
  assert.deepEqual(written, { ok: true, version: 1 });
  assert.equal(sets, 2, 'one conflict, one retry — never an unconditional overwrite (S11)');

  const offline = { ...fakeCore(), available: false };
  assert.equal((await writeCommandDocument(offline, 't2', command())).ok, false,
    'outside a core terminal there is nowhere to write');
  const unnamable = await writeCommandDocument(fakeCore(), 'T2', command());
  assert.equal(unnamable.ok, false);
  assert.match(unnamable.ok === false ? unnamable.reason : '', /cannot name a command document/,
    'S9 refusal');
});

test('clearCommandDocument: retries a transport failure, never deletes a newer write', async () => {
  const client = fakeCore();
  await writeCommandDocument(client, 't2', command());
  // Applied at version 1, cleared against it.
  assert.equal(await clearCommandDocument(client, 'piher.cmd.t2', 1), true);
  assert.deepEqual(await client.docGet('piher.cmd.t2'), { value: null, version: 2 });

  // A transport failure is retried: the applied steer must not stay behind for a restarted worker.
  let down = 2;
  const flaky: CoreClientLike = {
    ...fakeCore(),
    docSet: async () => {
      down -= 1;
      if (down > 0) throw new Error('connect ECONNRESET');
      return 1;
    },
  };
  assert.equal(await clearCommandDocument(flaky, 'piher.cmd.t2', 1), true,
    'a transport failure is retried');

  // A newer command sits there now: the stale clear must not delete it, and is not retried.
  await writeCommandDocument(client, 't2', command({ id: 'cmd-2' }));
  assert.equal(await clearCommandDocument(client, 'piher.cmd.t2', 1), false,
    'the stale version is refused');
  assert.equal(((await client.docGet('piher.cmd.t2'))?.value as CommandDocumentValue).id, 'cmd-2');
});

test('planCommandPickup: the ack is the version the absence landed at, never absence', () => {
  const wrote = { id: 'cmd-1', version: 1 };
  const at = (value: unknown, version: number) =>
    planCommandPickup({ read: { value, version }, wrote });
  const late = { id: 'cmd-1', version: 5 };
  // The worker cleared the document one step after our write: ours was read and handed to pi.
  assert.deepEqual(at(null, 2), { kind: 'applied' });
  // Two sibling sends for one worker: A at v1, B at v2, B read and cleared to v3. A must not read
  // that absence as its own delivery — and it cannot deny it either, so it claims nothing.
  assert.deepEqual(at(null, 3), { kind: 'unsettled' });
  // A store that forgot the document answers version 0: nothing can be concluded about the write.
  assert.equal(at(null, 0).kind, 'unknown');
  const behind = planCommandPickup({ read: { value: null, version: 2 }, wrote: late });
  assert.equal(behind.kind, 'unknown', 'a document behind the write is lost, not applied');
  assert.deepEqual(at(command(), 1), { kind: 'unread' }, 'still ours and unread');
  // Ours at v1, another command written at v2 while the worker was reading ours: it may have
  // been applied and left behind when its clear was refused, so nothing here says it was not read.
  assert.deepEqual(at(command({ id: 'cmd-2' }), 2), { kind: 'unsettled' },
    'a newer command one step on is not proof that ours was never read');
  assert.deepEqual(at(command({ id: 'cmd-2' }), 3), { kind: 'unsettled' },
    'and further on it is just as unprovable');
  assert.deepEqual(planCommandPickup({ read: null, wrote }), {
    kind: 'unknown', reason: 'no document store answered',
  });
});

test('awaitCommandPickup: backs off, stops for good news, gives up at the budget', async () => {
  const waited: number[] = [];
  let clock = 0;
  // A wait advances the budget clock, so the test measures reads per budget, not wall time.
  const sleep = async (ms: number) => { waited.push(ms); clock += ms; };
  const now = () => clock;
  // A store that applies the command on the third read.
  let reads = 0;
  const slow: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => {
      reads += 1;
      return reads >= 3 ? { value: null, version: 2 } : { value: command(), version: 1 };
    },
  };
  const applied = await awaitCommandPickup(slow, 'piher.cmd.t2', { id: 'cmd-1', version: 1 },
    10_000, { sleep, now });
  assert.deepEqual(applied, { kind: 'applied' });
  assert.equal(reads, 3, 'the loop re-reads until the worker clears it');
  assert.deepEqual(waited, [10, 20], 'the waits grow instead of hammering the core');

  // The budget ends an unread wait: how many reads it cost is bounded by the backoff.
  waited.length = 0;
  clock = 0;
  const never: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => ({ value: command(), version: 1 }),
  };
  assert.deepEqual(
    await awaitCommandPickup(never, 'piher.cmd.t2', { id: 'cmd-1', version: 1 }, 0, { sleep, now }),
    { kind: 'unread' }, 'a zero budget reports the write alone');
  const unread = await awaitCommandPickup(never, 'piher.cmd.t2', { id: 'cmd-1', version: 1 }, 400,
    { sleep, now });
  assert.deepEqual(unread, { kind: 'unread' });
  assert.ok(waited.length <= 8,
    `a 400 ms wait costs a handful of reads, not one per interval (${waited.length})`);
  assert.ok(waited.at(-1)! > waited[0]!, 'and the waits grow');

  // A cancelled tool call stops reading the core.
  const aborted = AbortSignal.abort();
  const write = { id: 'cmd-1', version: 1 };
  assert.deepEqual(await awaitCommandPickup(never, 'piher.cmd.t2', write, 5_000,
    { signal: aborted }), { kind: 'unknown', reason: 'cancelled' });

  const broken: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => { throw new Error('connect ECONNREFUSED'); },
  };
  const unconfirmed = await awaitCommandPickup(broken, 'piher.cmd.t2', { id: 'cmd-1', version: 1 },
    1_000);
  assert.deepEqual(unconfirmed, { kind: 'unknown', reason: 'connect ECONNREFUSED' });
});
