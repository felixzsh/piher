/** Steering command documents (spec S9–S11, S15): names, value guard, CAS write, the read trigger
 *  pattern and the pickup classification a `send` reports from. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitCommandPickup, clearCommandDocument, isCommandDocumentValue, newCommandId,
  planCommandApplication, planCommandPickup, steerCommand, writeCommandDocument,
  type CommandDocumentValue,
} from '../src/command-documents.ts';
import { commandDocName } from '../src/report-documents.ts';
import { CoreError, type CoreClientLike } from '../src/core-client.ts';
import { fakeCore } from './test-utils.ts';

const command = (over: Partial<CommandDocumentValue> = {}): CommandDocumentValue => ({
  id: 'cmd-1', type: 'follow_up', text: 'wrap up and report', deliverAs: 'steer', ...over,
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
  assert.equal(isCommandDocumentValue(command({ text: '' })), false,
    'a command with no text is nothing to apply');
  assert.equal(isCommandDocumentValue({ ...command(), type: 'steer' }), false,
    'unknown command type');
  // pi rejects a message sent while streaming without a delivery mode, so a value without one is
  // not a command this worker may apply.
  assert.equal(isCommandDocumentValue({ id: 'cmd-1', type: 'follow_up', text: 'x' }), false);
  assert.equal(isCommandDocumentValue(command({ deliverAs: 'nextTurn' as never })), false);
});

test('steerCommand: a send is a follow-up delivered as a steer (S15)', () => {
  const value = steerCommand('go on');
  assert.equal(value.type, 'follow_up');
  assert.equal(value.deliverAs, 'steer');
  assert.equal(value.text, 'go on');
  assert.notEqual(newCommandId(), newCommandId(),
    'two commands in one millisecond are not the same command');
});

test('planCommandApplication: apply what is new, clear what was applied, ignore junk', () => {
  const apply = (appliedId: string | null, value: unknown = command()) =>
    planCommandApplication({ value, appliedId });
  assert.deepEqual(apply(null), { kind: 'apply', value: command() });
  assert.deepEqual(apply('cmd-0'), { kind: 'apply', value: command() });
  assert.deepEqual(apply('cmd-1'), { kind: 'duplicate', value: command() });
  assert.deepEqual(apply('cmd-1', null), { kind: 'none' });
  assert.deepEqual(apply(null, { text: 'half written' }), { kind: 'none' });
  // Stopping a turn is pi's abort, not a user message: an `interrupt` value is never delivered as
  // text.
  assert.deepEqual(apply(null, command({ type: 'interrupt' })), { kind: 'none' });
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

test('clearCommandDocument: a stale version is not an error, and clears nothing', async () => {
  const client = fakeCore();
  await writeCommandDocument(client, 't2', command());
  // Applied at version 1, cleared against it.
  assert.equal(await clearCommandDocument(client, 'piher.cmd.t2', 1), true);
  assert.deepEqual(await client.docGet('piher.cmd.t2'), { value: null, version: 2 });
  // A newer command sits there now: the stale clear must not delete it.
  await writeCommandDocument(client, 't2', command({ id: 'cmd-2' }));
  assert.equal(await clearCommandDocument(client, 'piher.cmd.t2', 1), false,
    'the stale version is refused');
  assert.equal(((await client.docGet('piher.cmd.t2'))?.value as CommandDocumentValue).id, 'cmd-2');
});

test('planCommandPickup: cleared is applied; a replaced or unread document is not', () => {
  const wrote = { id: 'cmd-1', version: 1 };
  const at = (value: unknown, version: number, base = wrote) =>
    planCommandPickup({ read: { value, version }, wrote: base });
  assert.deepEqual(at(null, 2), { kind: 'applied' });
  assert.deepEqual(at(command(), 1), { kind: 'pending' }, 'still ours and unread');
  assert.deepEqual(at(command({ id: 'cmd-2' }), 2), { kind: 'replaced' },
    'one step on, another command: ours was overwritten before the worker read it');
  assert.deepEqual(at(command({ id: 'cmd-2' }), 3), { kind: 'pending' },
    'two steps on cannot separate applied-and-replaced from overwritten-late');
  const lateWrite = { id: 'cmd-1', version: 2 };
  assert.deepEqual(at(command({ id: 'cmd-2' }), 2, lateWrite), { kind: 'replaced' },
    'the step is measured from the version this write answered');
  assert.deepEqual(planCommandPickup({ read: null, wrote }), {
    kind: 'unknown', reason: 'no document store answered',
  });
});

test('awaitCommandPickup: waits for the clear, gives up at the budget, never guesses', async () => {
  // A store that applies the command on the second read.
  let reads = 0;
  const slow: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => {
      reads += 1;
      return reads >= 2 ? { value: null, version: 2 } : { value: command(), version: 1 };
    },
  };
  const applied = await awaitCommandPickup(slow, 'piher.cmd.t2', { id: 'cmd-1', version: 1 }, 1_000,
    { sleep: async () => {} });
  assert.deepEqual(applied, { kind: 'applied' });
  assert.equal(reads, 2, 'the loop re-reads until the worker clears it');

  const never: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => ({ value: command(), version: 1 }),
  };
  assert.deepEqual(await awaitCommandPickup(never, 'piher.cmd.t2', { id: 'cmd-1', version: 1 }, 0),
    { kind: 'pending' }, 'a zero budget reports the write alone');

  const broken: CoreClientLike = {
    ...fakeCore(),
    docGet: async () => { throw new Error('connect ECONNREFUSED'); },
  };
  const write = { id: 'cmd-1', version: 1 };
  const unconfirmed = await awaitCommandPickup(broken, 'piher.cmd.t2', write, 1_000);
  assert.deepEqual(unconfirmed, { kind: 'unknown', reason: 'connect ECONNREFUSED' });
});
