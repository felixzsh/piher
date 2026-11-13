/**
 * Open invariants: one skipped test per invariant piher does not yet hold at scale, each carrying
 * the evidence that made it open and the property that closes it. See
 * docs/spec/hc-native/invariants.md for the closed ones and for why these twelve exist.
 *
 * E1 and E5 left this file when they closed: a row per settlement in every delivery
 * (`settlement-transport.test.ts`) and a read that recovers what the master missed
 * (`subagent-inbox.test.ts`) are their pins now, and the invariants document says so. E6 and E8 left
 * it the same way: `session-budget.test.ts` holds the session ceiling, and `compaction.test.ts` the
 * pause across the cut and the roster re-stated from the records. E11 left last: `subagent-poller.test.ts`
 * holds the external kill that reaches the master as one pane-gone fact and the settle-then-reap that
 * delivers only the settle.
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

test('E10: per-worker cost in the core does not grow with N', OPEN(
  'E10',
  'each worker holds an unfiltered events.subscribe, so every event is delivered N times',
  'a worker subscribes to what concerns it, not to every element event of the core',
), () => {
  assert.fail('E10 open: subscriptions are unfiltered per worker');
});
