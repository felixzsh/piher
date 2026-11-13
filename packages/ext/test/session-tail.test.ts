/** Session liveness: transcript tail parsing (session-tail) and settled wake. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listSessionFiles, parseSessionEntries, readTurnClosing, sessionDirName, sessionFileById,
  type SessionEntryLike, type TurnClosing,
} from '../src/session-tail.ts';
import { planSettleWake, shouldPushSettleReply } from '../src/settle-wake-core.ts';
import { jsonl, transcriptMessage, withCleanup } from './test-utils.ts';

const msg = (role: string, text: string, ts: number, stopReason = 'stop') =>
  transcriptMessage(role, text, ts, stopReason) as SessionEntryLike;
const idle: TurnClosing = { text: null, why: null };
/** Writes a session transcript at `dir/name` (creating `dir`) and returns its path. */
const writeTranscript = (dir: string, name: string): string => {
  const file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, jsonl({ type: 'session' }));
  return file;
};

test('parseSessionEntries: tolerates malformed lines, blank lines and non-object records', () => {
  const entries = parseSessionEntries(`{bad json\n\n${jsonl(msg('assistant', 'hello', 100), 'nope', { type: 'session' })}`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'message');
  assert.equal(entries[1].type, 'session');
});

test('readTurnClosing: the words a turn left behind, with no settlement verdict in them', async (t) => {
  const tail = (over: Partial<TurnClosing>): TurnClosing => ({ ...idle, ...over });
  const cases: Array<{ name: string; entries: SessionEntryLike[]; sinceTs: number; closing: TurnClosing }> = [
    { name: 'finalized text wins over the toolUse intermediate', sinceTs: 0, closing: tail({ text: 'final answer' }),
      entries: [msg('user', 'task', 1), msg('assistant', 'thinking...', 2, 'toolUse'), msg('assistant', 'final answer', 3)] },
    { name: 'sinceTs drops finalized text written before the boundary', entries: [msg('assistant', 'old', 100), msg('assistant', 'new', 200)], sinceTs: 150, closing: tail({ text: 'new' }) },
    { name: 'a turn that ended without a clean stop still has words (token cap, abort)',
      entries: [msg('user', 'task', 1), msg('assistant', 'capped answer', 9, 'length')], sinceTs: 0,
      closing: tail({ text: 'capped answer' }) },
    { name: 'a run that stopped on a refused tool says which role refused which tool',
      entries: [
        msg('user', 'task', 1),
        msg('assistant', '', 5, 'toolUse'),
        { type: 'message', message: { role: 'toolResult', timestamp: 6, content: [{ type: 'text', text: 'role "reviewer" does not permit tool "ctx_execute" (manifest tools: bash, read).' }] } } as SessionEntryLike,
      ],
      sinceTs: 0,
      closing: tail({ why: 'It stopped after a refused tool call: the `reviewer` manifest does not permit `ctx_execute`. Fix the role profile or the task, then continue it.' }) },
    { name: 'an ended turn with no words at all says nothing', entries: [msg('user', 'task', 1), msg('assistant', '   ', 9, 'aborted')], sinceTs: 0, closing: idle },
    { name: 'assistant timestamp at the boundary counts', entries: [msg('assistant', 'a', 100)], sinceTs: 100, closing: tail({ text: 'a' }) },
    { name: 'a timestamp older than the boundary is invisible', entries: [msg('assistant', 'a', 100)], sinceTs: 101, closing: idle },
    { name: 'no assistant message → nothing', entries: [msg('user', 'hi', 1)], sinceTs: 0, closing: idle },
    { name: 'a tool call in flight reads as no words: the caller decides what that means', entries: [msg('user', 'q', 1), msg('assistant', 'working', 10, 'toolUse')], sinceTs: 5, closing: tail({ text: 'working' }) },
    { name: 'a tool result alone has no words', entries: [msg('user', 'q', 1), { type: 'message', message: { role: 'toolResult', content: [], timestamp: 11 } } as SessionEntryLike], sinceTs: 5, closing: idle },
    { name: 'assistant without stopReason (streaming) still has its words', sinceTs: 1, closing: tail({ text: 'x' }),
      entries: [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 6 } }] },
  ];
  for (const c of cases) await t.test(c.name, () => assert.deepEqual(readTurnClosing(c.entries, c.sinceTs), c.closing));
});

test('sessionDirName: cwd → collision-resistant session dir', () => {
  assert.equal(sessionDirName('F:\\piher'), '--F%3A%5Cpiher--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--');
});

test('listSessionFiles/sessionFileById: both dir candidates, newest-first order', withCleanup(async (cleanup) => {
  const flat = cleanup.tempDir('sess2').path;
  const dir = path.join(flat, '--F--piher--');
  const at = (n: number) => writeTranscript(dir, `2026-01-01T00-00-0${n}_${['aaaa', 'bbbb', 'cccc'][n]}.jsonl`);
  const [a, b, c] = [at(0), at(1), at(2)];
  const t = Date.now();
  [a, b, c].forEach((f, i) => fs.utimesSync(f, new Date(t - 3000 + i * 1000), new Date(t - 3000 + i * 1000)));
  assert.deepEqual(listSessionFiles('F:\\piher', flat, 2), [c, b]);
  assert.equal(sessionFileById('F:\\piher', flat, 'bbbb'), b);
  assert.equal(sessionFileById('F:\\piher', flat, 'zzzz'), null);
  assert.equal(sessionFileById('Z:\\nowhere', flat, 'bbbb'), null);

  // pi core's own POSIX dir name must resolve, and so must piher's collision-resistant encoding.
  const cwd = '/Users/yehaoyu/Documents/piher';
  const tmp = cleanup.tempDir('sess-a8').path;
  const core = path.join(tmp, '--Users-yehaoyu-Documents-piher--');
  const f = writeTranscript(core, '2026-01-01T00-00-00_dead.jsonl');
  assert.deepEqual(listSessionFiles(cwd, tmp, 4), [f]);
  assert.equal(sessionFileById(cwd, tmp, 'dead'), f);
  assert.equal(sessionFileById(cwd, tmp, 'beef'), null);
  const encoded = path.join(tmp, '--%2FUsers%2Fyehaoyu%2FDocuments%2Fpiher--');
  const g = writeTranscript(encoded, '2026-01-01T00-00-01_beef.jsonl');
  assert.equal(sessionFileById(cwd, tmp, 'beef'), g);
  assert.equal(listSessionFiles(cwd, tmp, 4).length, 2);
}));

/* ── settle wake: no wake storm (one notice per running set per 10 min) ── */
const SUBS = [{ paneId: 'wA:p6' }, { paneId: 'wA:p7' }];
const KEY = 'wA:p6,wA:p7';
const T0 = 100 * 60_000;

test('abort suppression: a settled turn after ESC wakes nothing and keeps the dedup anchor', () => {
  const plan = planSettleWake({ lastStopReason: 'aborted', running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, false);
  assert.equal(plan.notice, false);
  assert.equal(plan.noticeKey, null);
  assert.equal(plan.noticeAt, 0);
});

test('agent_settled.aborted (pi ≥ 1.1): a cancelled run wakes nothing even when stopReason looks natural', () => {
  const plan = planSettleWake({ lastStopReason: 'stop', aborted: true, running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, false, 'ESC mid-tool settles without a final assistant message — stopReason is stale');
  assert.equal(plan.notice, false);
});

test('shouldPushSettleReply: an aborted settle keeps the machine request armed for the re-run', () => {
  assert.equal(shouldPushSettleReply({ aborted: true, lastStopReason: 'stop' }), false);
  assert.equal(shouldPushSettleReply({ lastStopReason: 'stop' }), true);
  // A provider failure pi retries is not a settlement: answering would consume the request with a
  // null-text reply before the retry can deliver the real closing message.
  assert.equal(shouldPushSettleReply({ lastStopReason: 'error' }), false);
});

test('natural settle with a new running set → one notice carrying the set key', () => {
  const plan = planSettleWake({ lastStopReason: 'stop', running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, true);
  assert.equal(plan.noticeKey, KEY);
  assert.equal(plan.noticeAt, T0);
});

test('same running set: a settle seconds later stays silent, 10 minutes later re-notifies', () => {
  const at = (now: number) => planSettleWake({ lastStopReason: 'stop', running: SUBS, lastNoticeKey: KEY, lastNoticeAt: T0, now });
  const selfLoop = at(T0 + 1000); // the run started by the notice settles within seconds
  assert.equal(selfLoop.wake, true);
  assert.equal(selfLoop.notice, false);
  assert.equal(selfLoop.noticeKey, KEY, 'the anchor is untouched');
  assert.equal(at(T0 + 10 * 60_000 - 1).notice, false);
  const due = at(T0 + 10 * 60_000);
  assert.equal(due.notice, true);
  assert.equal(due.noticeAt, T0 + 10 * 60_000);
});

test('a changed running set bypasses the cooldown; an empty set resets the anchor', () => {
  const grown = planSettleWake({ lastStopReason: 'stop', running: [...SUBS, { paneId: 'wA:p9' }], lastNoticeKey: KEY, lastNoticeAt: T0, now: T0 + 5000 });
  assert.equal(grown.notice, true, 'a new sub bypasses the cooldown');
  const emptied = planSettleWake({ lastStopReason: 'stop', running: [], lastNoticeKey: KEY, lastNoticeAt: T0, now: T0 + 5000 });
  assert.equal(emptied.notice, false);
  assert.equal(emptied.noticeKey, null, 'an empty set resets the anchor so the next subs notify again');
});

test('unknown stopReason (null, older pi) counts as a natural end: no notice is lost', () => {
  const plan = planSettleWake({ lastStopReason: null, running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, true);
});

/* ── settle fast-path: an aborted settle must not answer the machine request ── */

test('settle reply guard: a user abort keeps the request armed', () => {
  const natural = { lastStopReason: 'stop' as const };
  assert.equal(shouldPushSettleReply(natural), true, 'a genuine settle answers the pending machine request');
  assert.equal(shouldPushSettleReply({ lastStopReason: 'error' }), false, 'provider error is retried: keep the request armed for the retry');
  assert.equal(shouldPushSettleReply({ lastStopReason: 'aborted' }), false, 'a user-aborted run may re-run');
  assert.equal(shouldPushSettleReply({ lastStopReason: null }), true, 'an unknown stopReason (older pi) still replies');
});
