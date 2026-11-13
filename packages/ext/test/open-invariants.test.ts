/**
 * Open invariants: one skipped test per invariant piher does not yet hold at scale, each carrying
 * the evidence that made it open and the property that closes it. See
 * docs/spec/hc-native/invariants.md for the closed ones and for why these twelve exist.
 *
 * E1 and E5 left this file when they closed: a row per settlement in every delivery
 * (`settlement-transport.test.ts`) and a read that recovers what the master missed
 * (`subagent-inbox.test.ts`) are their pins now, and the invariants document says so.
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
