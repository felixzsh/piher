/**
 * Open invariants: one skipped test per invariant piher does not yet hold at scale, each carrying
 * the evidence that made it open and the property that closes it. See
 * docs/spec/hc-native/invariants.md for the closed ones and for why these twelve exist.
 *
 * Why skipped and not failing: the suite is green at every commit, and a red test would pin
 * nothing. The convention is the opposite of a TODO comment — when the fix lands, the test moves
 * to the file that owns that behaviour, and this entry disappears. `node --test` prints it as
 * skipped until then, so the list cannot rot silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OPEN = (id: string, evidence: string, property: string) =>
  ({ skip: `${id} open — ${evidence}. Property: ${property}` });

test('E1: every settlement in a delivery, with its identity', OPEN(
  'E1',
  'measured: one delivery carries 3 of 10 settlements for N>3 (plan L10/L11)',
  'every settled workerId appears in the delivery, and a withheld report is a pointer, not silence',
), () => {
  assert.fail('E1 open: byte-budgeted delivery (row per settlement) is not implemented');
});

test('E2: a worker that did its work is never reported as a failed start', OPEN(
  'E2',
  'measured: 2 of 10 spawns reported "failed to start" while t1hr had already answered (plan L11)',
  'a child that took its task and finished is a settle; only a child that never took it is a boot failure',
), () => {
  assert.fail('E2 open: the readiness gate loses a child that finishes before it is observed');
});

test('E5: a report stays reachable when its record was swept', OPEN(
  'E5',
  'G10 closed the pane case; a swept record leaves no path from an address to its document',
  'the report document survives, or is addressable, after the task record is gone',
), () => {
  assert.fail('E5 open: output needs the record to find the document');
});

test('E6: report bytes delivered to the master are bounded per session', OPEN(
  'E6',
  'a 16 KB cap exists per notice; measured 191 KB of settlements in one session',
  'a session-level budget decides what is inlined, not only a per-notice cap',
), () => {
  assert.fail('E6 open: no session-wide accounting of delivered report bytes');
});

test('E8: piher state survives the master compacting its conversation', OPEN(
  'E8',
  'the notice buffer is not paused across a compaction and the roster is not re-injected',
  'pending settlements are flushed after the cut, and the live roster is re-stated from the records',
), () => {
  assert.fail('E8 open: no session_before_compact/session_compact handling');
});

test('E9: a spawn burst produces no false boot failures', OPEN(
  'E9',
  'measured 20% false failures with 10 spawns in one batch (plan L11)',
  'N spawns in one batch yield N starts, and any failure names a real cause',
), () => {
  assert.fail('E9 open: readiness budget is per spawn and the burst is not admitted');
});

test('E10: per-worker cost in the core does not grow with N', OPEN(
  'E10',
  'each worker holds an unfiltered events.subscribe, so every event is delivered N times',
  'a worker subscribes to what concerns it, not to every element event of the core',
), () => {
  assert.fail('E10 open: subscriptions are unfiltered per worker');
});

test('E11: a terminal killed from outside reaches the master as a settlement', OPEN(
  'E11',
  'a pane killed outside piher keeps its row believing it is alive until liveness corrects',
  'an externally ended worker settles with an exit fact, not with silence',
), () => {
  assert.fail('E11 open: external kills are not settlements');
});

test('E12: the master is never told to redo work that was done', OPEN(
  'E12',
  'consequence of E2: the failure notice says "spawn it again" over a completed child',
  'no notice invites a retry of work whose report exists',
), () => {
  assert.fail('E12 open: a false boot failure makes the master re-run a completed task');
});
