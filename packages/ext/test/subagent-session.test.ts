/** Child-session I/O and output reads: candidate resolution, liveness probes, a worker's closing
 * words with cache invalidation, the output delta, the `output` action, and the `hresume` report a
 * worker's session is resolved from. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreClientLike } from '../src/core-client.ts';
import type { TaskSeed } from './test-utils.ts';
import { sessionDirName, bareSessionId } from '../src/session-tail.ts';
import {
  cleanPaneChrome, computeSubagentOutputDelta, createSessionIo, cutPaneReportCopy, formatSubagentOutput, HRESUME_LABEL,
  hresumeSessionFile, resolveSubagentStatus, tailOfPaneRead,
  type SubagentOutputCursor,
} from '../src/subagent-session.ts';
import { readTaskRecord } from '../src/task-store.ts';
import {
  TempHome, fakeCore, fire, jsonl, mountSubagent, runSubagent, runSubagentRejects,
  seedTaskDocuments, taskRow, terminalInfo, transcriptMessage,
  type FakePi,
} from './test-utils.ts';

const TS = 1_800_000_000_000;
const sessions = () => mkdtempSync(join(tmpdir(), 'piher-session-'));
const NO_CLOSING = { text: null, why: null };

/** Terminal id used by the single-worker session fixtures. */
const PANE = 'tW';

/** CoreClientLike whose terminals carry the core's `hresume` label — the worker's own session
 *  report (spec S18), written by its Herdr extension. The label value is the documented object; the
 *  tests below pass the file or the bare id they care about. */
const hresumeLabel = (fileOrId: string): string => JSON.stringify({
  agent: 'pi', session: bareSessionId(fileOrId), file: fileOrId, cwd: '/w', pid: 1, boot: 'b',
});

const sessionClient = (sessionsByPane: Record<string, string>): CoreClientLike => fakeCore({
  listTerminals: async () => Object.entries(sessionsByPane)
    .map(([id, file]) => terminalInfo({ id, labels: { [HRESUME_LABEL]: hresumeLabel(file) } })),
  getTerminal: async (id) => (sessionsByPane[id]
    ? terminalInfo({ id, labels: { [HRESUME_LABEL]: hresumeLabel(sessionsByPane[id]!) } })
    : null),
});

/** SessionIo over a scripted `hresume` label; `sessionsDir` is where candidate files are scanned. */
const io = (reported: string | null, sessionsDir: string, ownSession = '') => createSessionIo({
  client: sessionClient(reported ? { [PANE]: reported } : {}),
  getSessionId: () => ownSession,
  sessionsDir: () => sessionsDir,
});

const writeSession = (file: string, lines: unknown[], append = false): void => {
  writeFileSync(file, jsonl(...lines), append ? { flag: 'a' } : undefined);
};

test('readTurnClosing: a reported but not-yet-created session file is skipped, not fatal', async () => {
  const dir = sessions();
  const closing = await io(join(dir, 'not-created-yet.jsonl'), dir).readTurnClosing(PANE, dir, Date.now());
  assert.deepEqual(closing, NO_CLOSING);
});

test('readTurnClosing: a readable session reports the turn\'s own words', async () => {
  const dir = sessions();
  const file = join(dir, 'child.jsonl');
  writeSession(file, [transcriptMessage('assistant', 'ok', TS + 10)]);
  assert.deepEqual(await io(file, dir).readTurnClosing(PANE, dir, TS), { text: 'ok', why: null });
});

test('readTurnClosing: a turn caught between tool calls reports only what it said, not a verdict', async () => {
  const dir = sessions();
  const file = join(dir, 'child-midflight.jsonl');
  writeSession(file, [
    transcriptMessage('user', 'task', TS),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: TS + 10, stopReason: 'toolUse' } },
    transcriptMessage('toolResult', 'ok', TS + 20),
  ]);
  assert.deepEqual(await io(file, dir).readTurnClosing(PANE, dir, TS), NO_CLOSING);
});

test('readTurnClosing: cache invalidates on append (a stale hit would hide the finished words)', async () => {
  const dir = sessions();
  const file = join(dir, 'child-growing.jsonl');
  writeSession(file, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: TS + 10, stopReason: 'toolUse' } }]);
  const session = io(file, dir);
  assert.deepEqual(await session.readTurnClosing(PANE, dir, TS), NO_CLOSING);
  writeSession(file, [transcriptMessage('assistant', 'finished', TS + 20)], true);
  assert.deepEqual(await session.readTurnClosing(PANE, dir, TS), { text: 'finished', why: null });
});

test('probeAlive: the terminal record decides liveness; a finished terminal is gone', async () => {
  const dir = sessions();
  const ioFor = (over: Partial<CoreClientLike>) => createSessionIo({ client: fakeCore(over), getSessionId: () => '', sessionsDir: () => dir });
  const probe = await ioFor({
    getTerminal: async (id) => terminalInfo({ id, status: 'unknown' }),
  }).probeAlive('tH3', dir);
  assert.equal(probe.paneExists, true);
  assert.equal(probe.agentStatus, 'unknown');

  const gone = ioFor({ getTerminal: async (id) => terminalInfo({ id, state: 'finished' }) });
  assert.equal((await gone.probeAlive('tH3', dir)).paneExists, false, 'a finished terminal is not alive');
  const missing = ioFor({});
  assert.equal((await missing.probeAlive('tH3', dir)).paneExists, false);
});

/* ── candidate resolution: own/taken sessions are never adopted ─── */

/** Agent home with a project session dir ready for candidate files. */
function projectSessions(prefix: string) {
  const home = new TempHome(prefix);
  const cwd = '/tmp/proj';
  const dir = home.dir('sessions', sessionDirName(cwd));
  const sessionsDir = join(home.path, 'sessions');
  const file = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, '{}\n');
    return path;
  };
  return { home, cwd, file, sessionsDir };
}

const MASTER_ID = '01a0bd3a-c2e5-7569-8d2c-aea4d82630cd';

test('resolveSessionFile: the master transcript and sessions claimed by other terminals are excluded', async () => {
  const { home, cwd, file, sessionsDir } = projectSessions('piher-session-own-');
  const master = file('2026-09-20T05-12-19-942Z_01a0bd3a-c2e5-7569-8d2c-aea4d82630cd.jsonl');
  const stale = file('2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  const sub = file('2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  // The master writes continuously, so an mtime fallback would pick it first.
  utimesSync(sub, 1_000, 1_000);
  utimesSync(stale, 2_000, 2_000);
  utimesSync(master, 3_000, 3_000);

  const ioFor = (labels: Record<string, string> = {}) => createSessionIo({
    client: sessionClient(labels), getSessionId: () => MASTER_ID, sessionsDir: () => sessionsDir,
  });
  assert.equal(await ioFor().resolveSessionFile('tW', cwd), stale);

  // The worker's own label points at the master's file; another terminal claims a bare id.
  const reported = ioFor({
    'tW': master,
    'tOther': master,
    'tBare': '01a0bd34-1ccd-73e1-a93f-e57e7f124d49',
  });
  assert.equal(
    await reported.resolveSessionFile('tW', cwd),
    sub,
    'own and taken labels (paths or bare ids) are rejected',
  );
  home.dispose();
});

test('resolveSessionFile: the own label wins over the mtime order; a pipe self-report outranks a lagging label', async () => {
  const { home, cwd, file, sessionsDir } = projectSessions('piher-session-pref-');
  const sub = file('2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  const preferred = file('2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  const reported = file('2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  utimesSync(preferred, 1_000, 1_000);
  utimesSync(reported, 2_000, 2_000);
  const ioFor = (labels: Record<string, string> = {}) => createSessionIo({
    client: sessionClient(labels),
    getSessionId: () => '22222222-2222-3333-4444-555555555555',
    sessionsDir: () => sessionsDir,
  });
  assert.equal(
    await ioFor({ 'tW': sub }).resolveSessionFile('tW', cwd),
    sub,
    'the worker\'s own `hresume` label wins (spec S18)',
  );
  assert.equal(await ioFor().resolveSessionFile('tOther', cwd, preferred), preferred, 'the session the row already carries wins over the fallback');
  assert.equal(await ioFor({ 'tOther': reported }).resolveSessionFile('tOther', cwd), reported, 'without a preferred value the label order holds');
  home.dispose();
});

test('reattributeStaleSessionFile: repairs a stale or poisoned value from the worker label, never guesses', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'piher-session-reattr-'));
  const file = (name: string): string => {
    const path = join(agentDir, name);
    writeFileSync(path, '{}\n');
    return path;
  };
  const ownFile = file('2026-09-21T06-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl');
  const takenFile = file('2026-09-21T06-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl');
  const foreignFile = file('2026-09-21T06-05-00-000Z_33333333-3333-4333-8333-333333333333.jsonl');
  const stalePreferred = file('2026-09-16T07-15-46-751Z_44444444-4444-4444-8444-444444444444.jsonl');
  utimesSync(stalePreferred, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

  const ioFor = (reported: string) => createSessionIo({
    client: sessionClient({ 'tStale': reported, 'tOther': takenFile }),
    getSessionId: () => ownFile,
    sessionsDir: () => agentDir,
  });
  const reattribute = (reported: string, preferred: string | null) =>
    ioFor(reported).reattributeStaleSessionFile('tStale', '/tmp/proj', Date.now(), preferred);

  assert.equal(
    await reattribute(ownFile, stalePreferred),
    null,
    'an own-transcript report is rejected even though the file is fresh',
  );
  assert.equal(await reattribute(foreignFile, stalePreferred), foreignFile);
  assert.equal(await reattribute(foreignFile, foreignFile), foreignFile, 'a fresh preferred is kept as-is');
  // The master rewrites its own transcript continuously, so freshness alone must not preserve poison;
  // the report repairs it instead of returning null (= keep the old value).
  assert.equal(await reattribute(foreignFile, ownFile), foreignFile);
  assert.equal(await reattribute(foreignFile, takenFile), foreignFile);
});


/* ── output delta (pure) ────────────────────────────────────────── */
const CURSOR = (tail: string, fullLength: number): SubagentOutputCursor => ({ tail, fullLength });

test('tailOfPaneRead: the latest lines, bounded, never the whole boot chrome', () => {
  const boot = Array.from({ length: 200 }, (_, i) => `banner ${i}`).join('\n') + '\nthe answer';
  const tail = tailOfPaneRead(boot);
  assert.equal(tail.split('\n').length, 40);
  assert.ok(tail.endsWith('the answer'));
  assert.ok(!tail.includes('banner 0'), 'the startup banner is not in a tail read');
  assert.equal(tailOfPaneRead('a\nb', 40, 2), '\nb', 'the char bound keeps the end');
  assert.equal(tailOfPaneRead(''), '');
});

test('computeSubagentOutputDelta: full, empty, appended and truncated deltas', async (t) => {
  await t.test('first call returns the full buffer bounded to maxChars', () => {
    const res = computeSubagentOutputDelta(null, 'Line 1\nLine 2\nLine 3\n', { maxChars: 100 });
    assert.equal(res.delta, 'Line 1\nLine 2\nLine 3\n');
    assert.equal(res.restart, false);
    assert.equal(res.truncated, false);
    assert.equal(res.nextCursor.fullLength, 21);
    assert.ok(res.nextCursor.tail.endsWith('Line 3\n'));
  });

  await t.test('unchanged buffer returns an empty delta and keeps the cursor', () => {
    const text = 'Line 1\nLine 2\n';
    const initial = computeSubagentOutputDelta(null, text);
    const second = computeSubagentOutputDelta(initial.nextCursor, text);
    assert.equal(second.delta, '');
    assert.equal(second.truncated, false);
    assert.equal(second.nextCursor, initial.nextCursor);
  });

  await t.test('an append yields only the new text', () => {
    const first = computeSubagentOutputDelta(null, 'Step 1: start\nStep 2: build\n');
    const second = computeSubagentOutputDelta(first.nextCursor, 'Step 1: start\nStep 2: build\nStep 3: test passed\n');
    assert.equal(second.delta, 'Step 3: test passed\n');
    assert.equal(second.restart, false);
    assert.equal(second.nextCursor.fullLength, second.delta.length + first.nextCursor.fullLength);
  });

  await t.test('a delta over maxChars is truncated from the beginning', () => {
    const res = computeSubagentOutputDelta(CURSOR('START\n', 6), 'START\n' + 'x'.repeat(500) + 'END', { maxChars: 50 });
    assert.equal(res.restart, false);
    assert.equal(res.truncated, true);
    assert.equal(res.delta.length, 50);
    assert.ok(res.delta.endsWith('END'));
  });
});

test('computeSubagentOutputDelta: ambiguous tails, partial scrolls and clears restart with the full text', async (t) => {
  await t.test('a repeated tail is ambiguous → full text with restart', () => {
    const text = 'ping\nping\nping\nping\n';
    const res = computeSubagentOutputDelta(CURSOR('ping\n', 5), text);
    assert.equal(res.restart, true);
    assert.equal(res.delta, text);
  });

  await t.test('a partially scrolled buffer resyncs on the longest overlap', () => {
    const res = computeSubagentOutputDelta(
      CURSOR('line 15\nline 16\nline 17\nline 18\nline 19\nline 20\n', 200),
      'line 18\nline 19\nline 20\nline 21: new!\n',
      { minOverlap: 16 },
    );
    assert.equal(res.restart, false);
    assert.equal(res.delta, 'line 21: new!\n');
  });

  await t.test('a clear screen (no overlap) degrades to full text with restart', () => {
    const currText = 'Brand New Task Running\nAll previous scrolled away\n';
    const res = computeSubagentOutputDelta(CURSOR('Old Task Step 1\nOld Task Step 2\n', 100), currText);
    assert.equal(res.restart, true);
    assert.equal(res.delta, currText);
  });
});

test('resolveSubagentStatus: blocked > working > settled > idle, running as the default', () => {
  const local = { consumed: false, closed: false };
  assert.equal(resolveSubagentStatus({ ...local, status: 'blocked' }), 'blocked');
  assert.equal(resolveSubagentStatus({ ...local, status: 'working' }), 'running');
  assert.equal(resolveSubagentStatus({ consumed: true, closed: false, status: 'idle' }), 'settled');
  assert.equal(resolveSubagentStatus({ consumed: false, closed: true, status: 'idle' }), 'settled');
  assert.equal(resolveSubagentStatus({ ...local, status: 'done' }), 'settled');
  const errored = resolveSubagentStatus({ ...local, status: 'error' });
  assert.equal(errored, 'settled', 'an error ends the turn');
  assert.equal(resolveSubagentStatus({ ...local, status: 'idle' }), 'idle');
  assert.equal(resolveSubagentStatus({ ...local, status: 'unknown' }), 'running');
  assert.equal(resolveSubagentStatus({ ...local, status: null }), 'running');
});

test('formatSubagentOutput: header, body, empty-delta notice and flags', () => {
  const formatted = formatSubagentOutput({
    paneId: 'wD:p6', status: 'running', revision: 5, bufferTruncated: false,
    deltaResult: { delta: 'Compiling module A...\nDone.', restart: false, truncated: false },
  });
  assert.match(formatted, /\[Subagent Output \| pane: wD:p6 \| status: running \| revision: 5\]/);
  assert.match(formatted, /Compiling module A\.\.\.\nDone\./);

  const flagged = formatSubagentOutput({
    paneId: 'wD:p6', status: 'blocked', revision: 2, bufferTruncated: true, askQuestion: 'Confirm overwrite?',
    deltaResult: { delta: '', restart: true, truncated: false },
  });
  assert.match(flagged, /status: blocked \(question: "Confirm overwrite\?"\)/);
  assert.match(flagged, /buffer scrolled or reset — full text returned \(not a process restart\)/);
  assert.match(flagged, /truncated: true/);
  assert.match(flagged, /\(no new output since last read\)/);
  assert.doesNotMatch(flagged, /restart: true/);
});

/* ── output action ──────────────────────────────────────────────── */

const worker = (paneId: string, over: TaskSeed = {}) =>
  taskRow({ paneId, taskId: `task-${paneId}`, tabId: 't1', tabName: 'worker', ...over });

/** A throwing terminal list stands the settlement-watch recovery down, so it cannot re-arm
 * a seeded row mid-test (no poller is armed to consume it). */
const NO_TERMINALS = { listTerminals: async (): Promise<never> => { throw new Error('terminal.list unavailable in this fixture'); } };

/** Mounts the plugin over a scripted core client with one seeded worker row, then disposes it. */
async function withWorker(
  body: (pi: FakePi) => Promise<void>,
  client: Partial<CoreClientLike> = {},
  seed: TaskSeed = {},
): Promise<void> {
  const { root, pi } = await mountSubagent({
    client: { ...NO_TERMINALS, ...client }, tasks: [worker('pWorker', seed)],
  });
  try {
    await body(pi);
  } finally {
    await root.fiber.dispose();
  }
}

/** The worker terminal's status plus the buffer `terminal.read` answers with. */
const outputPane = (text: () => string, over: Partial<Parameters<typeof terminalInfo>[0]> = {}) => ({
  getTerminal: async (id: string) => terminalInfo({ id, ...over }),
  read: async () => ({ text: text(), complete: true }),
});

test('output action: missing and unknown ids fail with actionable messages', async () => {
  const { root, pi } = await mountSubagent();
  try {
    await assert.rejects(runSubagent(pi, { action: 'output' }), /missing agentId for output/);
    await assert.rejects(runSubagent(pi, { action: 'output', agentId: 'nope' }), /unknown subagent id "nope"/);
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: a default read is a repeatable tail, a full read is the delta reader', async () => {
  let output = 'Initial output line 1\nInitial output line 2\n';
  await withWorker(async (pi) => {
    const first = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(first.content[0]!.text.includes('Initial output line 1'), true);
    output += 'Progress: compiling module B\n';
    const second = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.match(second.content[0]!.text, /Progress: compiling module B/);
    assert.match(second.content[0]!.text, /Initial output line 2/, 'a tail repeats: it spent no cursor');
    // `full` is where delta accounting lives, so two full reads are incremental.
    const fullOne = await runSubagent(pi, { action: 'output', agentId: 'pWorker', full: true });
    assert.match(fullOne.content[0]!.text, /Initial output line 1/);
    output += 'Progress: linking\n';
    const fullTwo = await runSubagent(pi, { action: 'output', agentId: 'pWorker', full: true });
    assert.match(fullTwo.content[0]!.text, /Progress: linking/);
    assert.doesNotMatch(fullTwo.content[0]!.text, /Initial output line 2/, 'only the delta is returned');
  }, outputPane(() => output));
});

test('output action: the default read is the latest lines, not the boot chrome (full: true returns it all)', async () => {
  const boot = Array.from({ length: 120 }, (_, i) => `boot line ${i}`).join('\n') + '\nthe worker is working';
  await withWorker(async (pi) => {
    const tail = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.match(tail.content[0]!.text, /the worker is working/);
    assert.doesNotMatch(tail.content[0]!.text, /boot line 0$/, 'the startup banner is not dumped into a master');
    assert.match(tail.content[0]!.text, /pass full: true/);
    const full = await runSubagent(pi, { action: 'output', agentId: 'pWorker', full: true });
    assert.match(full.content[0]!.text, /boot line 0\b/, 'the full read still has the whole buffer');
    assert.doesNotMatch(full.content[0]!.text, /pass full: true/);
  }, outputPane(() => boot));
});

test('output action: an incomplete terminal read is reported as truncated', async () => {
  await withWorker(async (pi) => {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.match(res.content[0]!.text, /partial screen/);
    assert.equal(res.details!.truncated, true);
  }, {
    ...outputPane(() => ''),
    read: async () => ({ text: 'partial screen\n', complete: false }),
  });
});

test('output action: a human gate is reported with its question', async () => {
  await withWorker(async (pi) => {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(res.details!.status, 'blocked');
    assert.match(res.content[0]!.text, /status: blocked \(question: "Should we delete existing tables\?"\)/);
  }, outputPane(() => 'waiting\n', { status: 'blocked', statusMsg: 'Should we delete existing tables?' }));
});

test('output action: a settled row reports settled even while the pane is idle', async () => {
  await withWorker(async (pi) => {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(res.details!.status, 'settled');
    assert.match(res.content[0]!.text, /status: settled/);
  }, outputPane(() => 'Task completed successfully.\n', { status: 'idle' }), { consumedAt: 5 });
});

test('output action: an idle pane showing only its overlay still surfaces the transcript report, once', async () => {
  const home = new TempHome('piher-out-home-');
  const reportFile = home.dir('sessions', 'sub-report');
  const report = join(reportFile, '2026-09-20T07-00-00-000Z_55555555-6666-4777-8888-999999999999.jsonl');
  writeSession(report, [transcriptMessage('assistant', 'FINAL REPORT: region enum + converter delivered byte-identical to dev_eu', Date.now())]);

  await withWorker(async (pi) => {
    const first = await runSubagent(pi, { action: 'output', agentId: 'pWorker', max_chars: 3000 });
    assert.equal(first.details!.status, 'idle');
    assert.ok((first.details!.deltaLength as number) > 0, 'the overlay footer is the pane text');
    assert.equal(first.details!.reportDelivered, true);
    assert.match(first.content[0]!.text, /Subagent Report \| latest finalized message from session transcript/);
    assert.match(first.content[0]!.text, /FINAL REPORT: region enum/);

    const second = await runSubagent(pi, { action: 'output', agentId: 'pWorker', max_chars: 3000 });
    assert.equal(second.details!.deltaLength, 0);
    assert.equal(second.details!.reportDelivered, false, 'an unchanged report is not re-delivered');
    assert.doesNotMatch(second.content[0]!.text, /Subagent Report/);
  }, outputPane(() => '\n$ cargo test\n   +3 hidden (7✓)\n', { status: 'idle', labels: { [HRESUME_LABEL]: hresumeLabel(report) } }));
  home.dispose();
});

/** Shape of a real worker pane read (01a17b50): padded frame rows, the rendered report with its
 *  markdown stripped and long lines cut at pane width, then pi's cwd + token footer. */
const RENDERED_PANE = [
  '                                       │',
  ' Fix committed to bugfix/zentao-20718-apn (commit bbde792a72, not pushed).              ',
  '',
  '',
  ' - extractTalentToMq(ids, region) routes the index by the normalized reg',
  '──────────────────────────────────────────',
  '~/IdeaProjects/wt-apn-bug20718 (bugfix/zentao-20718-apn)',
  '↑43k ↓13k R820k CH99.1% $0.017 4.2%/1.0M (auto)            ',
].join('\n');
const TRANSCRIPT_REPORT = 'Fix committed to `bugfix/zentao-20718-apn` (commit `bbde792a72`, not pushed).\n\n- `extractTalentToMq(ids, region)` routes the index by the normalized region; `_source.region` stays.';

test('cleanPaneChrome: frame rows, side borders, padding, blank runs and the pi footer go; content stays', () => {
  assert.equal(
    cleanPaneChrome(RENDERED_PANE),
    ' Fix committed to bugfix/zentao-20718-apn (commit bbde792a72, not pushed).\n\n - extractTalentToMq(ids, region) routes the index by the normalized reg',
  );
  // A path line is only footer chrome directly above the token line.
  assert.equal(cleanPaneChrome('~/repo (main)\nbuild ok'), '~/repo (main)\nbuild ok');
  assert.equal(cleanPaneChrome('│ boxed line │'), 'boxed line');
});

test('cutPaneReportCopy: the lossy rendered copy is cut at its opening; text before it survives', () => {
  const pane = `$ mvn test\nBUILD SUCCESS\n${cleanPaneChrome(RENDERED_PANE)}`;
  const cut = cutPaneReportCopy(pane, TRANSCRIPT_REPORT);
  assert.ok(cut?.startsWith('$ mvn test\nBUILD SUCCESS\n(the pane'), cut ?? 'null');
  assert.doesNotMatch(cut!, /extractTalentToMq/);
  assert.equal(cutPaneReportCopy('unrelated output only\n', TRANSCRIPT_REPORT), null);
  assert.equal(cutPaneReportCopy(pane, 'tiny'), null, 'a too-short report never matches by accident');
});

test('output action: the transcript report replaces the pane copy and the delivery is persisted', async () => {
  const home = new TempHome('piher-out-dedupe-');
  const dir = home.dir('sessions', 'sub-dedupe');
  const session = join(dir, '2026-10-27T05-12-00-000Z_66666666-6666-4777-8888-999999999999.jsonl');
  writeSession(session, [transcriptMessage('assistant', TRANSCRIPT_REPORT, Date.now())]);
  const repo = mkdtempSync(join(tmpdir(), 'piher-out-record-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const taskId = 'task-pWorker';
  const { root, pi } = await mountSubagent({
    client: {
      ...NO_TERMINALS,
      ...outputPane(() => RENDERED_PANE, { status: 'idle', labels: { [HRESUME_LABEL]: hresumeLabel(session) } }),
    },
    tasks: [taskRow({ paneId: 'pWorker', taskId, cwd: repo })],
  });
  try {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    const text = res.content[0]!.text;
    assert.equal(res.details!.reportDelivered, true);
    assert.match(text, /rendered copy of the final report is omitted/);
    assert.equal(text.match(/extractTalentToMq/g)?.length, 1, 'the report appears once, from the transcript');
    assert.doesNotMatch(text, /↑43k|R820k|──/, 'TUI chrome is stripped');
    assert.match(text, /`_source\.region` stays/, 'the complete transcript text, not the cut pane line');
    const record = readTaskRecord(repo, taskId);
    assert.equal(record?.gen.reportDelivered?.fingerprint, TRANSCRIPT_REPORT.slice(-64),
      'the delivery survives a resume');
  } finally {
    await root.fiber.dispose();
  }
  home.dispose();
  rmSync(repo, { recursive: true, force: true });
});

/* ── reply-session healing ──────────────────────────────────────── */

test('resume: a record pointing at the master session is refused; another pane is reused', async () => {
  const home = new TempHome('piher-resume-self-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-resume-self-cwd-'));
  const masterFile = join(cwd, 'master-session.jsonl');
  const otherFile = join(cwd, 'other-session.jsonl');
  writeFileSync(masterFile, '{}\n');
  writeFileSync(otherFile, '{}\n');
  // The records belong to the repository: a main checkout is a directory holding `.git`.
  mkdirSync(join(cwd, '.git'), { recursive: true });
  // Both rows are this session's own: the view names them, so resume may act on them.
  const stamp = '2026-01-05T00-00-00-000Z_ffffffff-0000-4000-8000-000000000000.jsonl';
  const sessionFile = join(home.dir('sessions'), stamp);
  const base = {
    kind: 'task' as const, tabId: 't0', cwd,
    launchCommand: ['node', 'cli.js'],
  };
  const t1 = '8183022d-a733-4292-911b-850e6dffba5a';
  const t2 = '937f4abf-0000-4111-8222-333333333333';
  seedTaskDocuments(sessionFile, [
    {
      ...base, taskId: t1, paneId: 'wA:p25', description: 'Investigate bug 19812',
      sessionFile: masterFile, createdAt: Date.now(),
    },
    {
      ...base, taskId: t2, paneId: 'wA:p2old', description: 'healthy task',
      sessionFile: otherFile, createdAt: Date.now() + 1,
    },
  ]);

  const { root, pi, port } = await mountSubagent({
    env: { terminalId: 'p0' },
    client: {
      listTerminals: async () => [
        terminalInfo({ id: 'p0', labels: { [HRESUME_LABEL]: hresumeLabel(masterFile) } }),
        terminalInfo({ id: 'p2', labels: { [HRESUME_LABEL]: hresumeLabel(otherFile) } }),
      ],
      getTerminal: async (id) => terminalInfo({
        id,
        labels: { [HRESUME_LABEL]: hresumeLabel(id === 'p0' ? masterFile : otherFile) },
      }),
    },
    deps: { getSessionFile: () => sessionFile, getCwd: () => cwd },
  });
  try {
    await fire(pi, 'session_start', { reason: 'reload' }, {});

    assert.match(await runSubagentRejects(pi, { action: 'resume', taskId: '8183022d' }, cwd), /master's own session/);
    const panes = port.current!.listRunningSubs();
    assert.ok(!panes.some((s) => s.paneId === 'p0'), 'the master pane never enters the board');

    const ok = await runSubagent(pi, { action: 'resume', taskId: '937f4abf' }, cwd);
    assert.match(ok.content[0]!.text, /reused existing pane/);
    assert.equal(ok.details?.paneId, 'p2');
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});
/* ── the session a worker reports (spec S18) ────────────────────── */

test('hresumeSessionFile: the documented object yields its file, else its bare session id', () => {
  assert.equal(
    hresumeSessionFile(JSON.stringify({ agent: 'pi', session: 'abc-123', file: '/s/abc-123.jsonl', cwd: '/w', pid: 7, boot: 'b' })),
    '/s/abc-123.jsonl',
    'the reported file is what a transcript resolver can open',
  );
  assert.equal(
    hresumeSessionFile(JSON.stringify({ agent: 'pi', session: 'abc-123', cwd: '/w' })),
    'abc-123',
    'an id alone is still a report: herdr reports ids and paths interchangeably',
  );
  // A label piher cannot read is not a session report: guessing here is how a resume lands on the
  // wrong conversation.
  for (const junk of [null, undefined, '', '   ', 'not json', '[]', '{}', JSON.stringify({ agent: 'pi', file: '' })]) {
    assert.equal(hresumeSessionFile(junk as string | null | undefined), null, `no report in ${JSON.stringify(junk)}`);
  }
});

test('resume: a task with no session anywhere is refused, and the refusal names what is missing', async () => {
  const home = new TempHome('piher-resume-nosession-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-resume-nosession-cwd-'));
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const viewFile = join(home.dir('views'), '2026-09-20T07-00-00-000Z_77777777-7777-4777-8777-777777777777.jsonl');
  const taskId = '88888888-8888-4888-8888-888888888888';
  // The row survived, its conversation did not: no session file, and the terminal reports no
  // `hresume` label — exactly the case that used to resume into a fresh conversation silently.
  seedTaskDocuments(viewFile, [{
    taskId, paneId: 'pGone', tabId: 't0', tabName: 'main',
    cwd, description: 'lost conversation', sessionFile: null, createdAt: Date.now() - 60_000,
  }]);
  const { root, pi } = await mountSubagent({
    client: {
      listTerminals: async () => [terminalInfo({ id: 'pGone', status: 'idle', labels: {} })],
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', labels: {} }),
    },
    deps: {
      getSessionId: () => '77777777-7777-4777-8777-777777777777',
      getSessionFile: () => viewFile,
      getCwd: () => cwd,
    },
  });
  try {
    await fire(pi, 'session_start', { reason: 'reload' }, {});
    const refused = await runSubagentRejects(pi, { action: 'resume', taskId }, cwd);
    assert.match(refused, /has no session to resume/);
    assert.match(refused, /`hresume` label/, 'the refusal names the report that is missing');
    assert.match(refused, /`session`/, 'and the document field that would have carried it');
    assert.match(refused, /fresh conversation/);
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});

test('session recovery: a still-running subagent gets its settlement watch re-armed', async () => {
  const home = new TempHome('piher-recover-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-recover-cwd-'));
  void home.dir('sessions', sessionDirName(cwd));

  const notices: string[] = [];
  // The task's record belongs to a repository: the restore reads it from there.
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const viewFile = join(home.dir('views'), '2026-09-20T06-10-00-000Z_bbbb2222-3333-4444-8555-666666666666.jsonl');
  const taskId = 'cccc3333-4444-4555-8666-777777777777';
  const createdAt = Date.now() - 120_000;
  seedTaskDocuments(viewFile, [{
    taskId, paneId: 'p9', tabId: 't0', tabName: 'main',
    cwd, description: 'Fix bugs in a separate checkout',
    sessionFile: null, createdAt,
  }]);
  // The worker's own report, written into the core: the only thing that settles a task now (spec S5).
  const reportAt = Date.now();
  const report = {
    taskId, turn: 1, stopReason: 'stop', session: null,
    text: 'RECOVERED_REPORT: fix committed, 199 tests green', at: reportAt,
  };
  const { root, pi } = await mountSubagent({
    client: {
      listTerminals: async () => [terminalInfo({ id: 'p9', status: 'idle', labels: {} })],
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', labels: {} }),
      docGet: async (name) => (name === 'piher.rep.p9'
        ? { value: report, version: 1 }
        : { value: null, version: 0 }),
    },
    deps: {
      getSessionId: () => 'bbbb2222-3333-4444-8555-666666666666',
      getSessionFile: () => viewFile,
      getCwd: () => cwd,
      deliverNotice: async (content: string) => { notices.push(content); },
    },
  });
  try {
    await fire(pi, 'session_start', { reason: 'reload' }, {});
    // The re-armed watch reads the core's document on its first tick; the restore itself is async.
    const deadline = Date.now() + 5_000;
    while (!notices.some((n) => n.includes('Its report, in its own words')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(notices.some((n) => n.includes('settlement watch re-armed')), `missing recovery notice: ${JSON.stringify(notices)}`);
    const settle = notices.find((n) => n.includes('Its report, in its own words'));
    assert.ok(settle, `missing settlement notice: ${JSON.stringify(notices)}`);
    assert.match(settle!, /RECOVERED_REPORT/);
    assert.ok(readTaskRecord(cwd, taskId)?.gen.consumedAt !== null, 'the settlement lands in the record');
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});

test('session recovery: a watch that could not arm is not announced as re-armed', async () => {
  // The notice is a claim about what the master now has. A session root that refuses the mount leaves
  // the row with no reader at all, so the honest notice is none — not "re-armed".
  const home = new TempHome('piher-recover-dead-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-recover-dead-cwd-'));
  const notices: string[] = [];
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const viewFile = join(home.dir('views'), '2026-09-20T06-10-00-000Z_dddd2222-3333-4444-8555-666666666666.jsonl');
  seedTaskDocuments(viewFile, [{
    taskId: 'eeee3333-4444-4555-8666-777777777777', paneId: 'p9', tabId: 't0', tabName: 'main',
    cwd, description: 'unarmable probe', sessionFile: null, createdAt: Date.now() - 120_000,
  }]);
  const { root, pi } = await mountSubagent({
    client: {
      listTerminals: async () => [terminalInfo({ id: 'p9', status: 'idle', labels: {} })],
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', labels: {} }),
    },
    deps: {
      // A root that cannot take a scope: the mount is the only way to arm a watch.
      sessionRoot: { plugin: () => { throw new Error('the session root is gone'); } } as never,
      getSessionId: () => '',
      getSessionFile: () => viewFile,
      getCwd: () => cwd,
      deliverNotice: async (content: string) => { notices.push(content); },
    },
  });
  try {
    await fire(pi, 'session_start', { reason: 'reload' }, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(notices, [], 'nothing was armed, so nothing is claimed');
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});
