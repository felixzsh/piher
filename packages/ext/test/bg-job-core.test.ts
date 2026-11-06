/** bg-job-core: the command plan, names, log slices and the two notices a job can produce. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_S,
  JOB_LABEL_KEY,
  JOB_META_LABEL,
  chooseTail,
  clock,
  decodeJobMeta,
  encodeJobMeta,
  expiredDelivered,
  listedJobs,
  planAdoption,
  MAX_LOG_LINES,
  MAX_TIMEOUT_S,
  MIN_TIMEOUT_S,
  clampTimeoutS,
  formatDuration,
  formatJobCheckIn,
  formatJobListLine,
  formatJobNotice,
  formatJobStatus,
  jobCoreName,
  jobNoticeDetails,
  jobOutcome,
  nextJobId,
  planJobArgv,
  readLogSlice,
  shellQuote,
  stripOutput,
  tailLines,
  type JobRecord,
} from '../src/bg-job-core.ts';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    label: 'build release',
    command: 'cargo build --release',
    cwd: '/repo',
    paneId: 't7',
    logPath: '/tmp/piher-jobs/job-1.log',
    startedAt: 1_000,
    status: 'finished',
    exitCode: 0,
    endedAt: 81_000,
    checkInSent: false,
    delivered: false,
    ...overrides,
  };
}

test('a job id is short and pasteable', () => {
  assert.equal(nextJobId(1), 'job-1');
  assert.equal(nextJobId(42), 'job-42');
  // A reload restarts the counter, so the instance tag is what keeps `job-1` from naming a
  // different job in the same transcript.
  assert.equal(nextJobId(1, 'k3'), 'job-1xk3', 'the tag never reads as part of the counter');
  assert.match(jobCoreName(nextJobId(1, 'k3'), 'build release'), /^job-1xk3-build-release$/);
});

test('the pane name leads with the job id and stays inside core limits', () => {
  assert.equal(jobCoreName('job-3', 'Build Release!'), 'job-3-build-release');
  assert.equal(jobCoreName('job-3', null), 'job-3');
  // Accents and punctuation collapse; the id must survive the 32-character cut.
  const long = jobCoreName('job-12', 'a'.repeat(80));
  assert.equal(long.length, 32);
  assert.ok(long.startsWith('job-12-'));
  assert.match(long, /^[a-z0-9_-]{1,32}$/);
});

test('quoting survives an apostrophe in the log path', () => {
  assert.equal(shellQuote('/tmp/a b.log'), `'/tmp/a b.log'`);
  assert.equal(shellQuote("/tmp/it's.log"), `'/tmp/it'\\''s.log'`);
});

test('the command runs under bash with pipefail and a tee log', () => {
  const argv = planJobArgv('cargo build\n', "/tmp/job's.log");
  assert.deepEqual(argv.slice(0, 4), ['bash', '-o', 'pipefail', '-c']);
  const script = argv[4]!;
  assert.equal(script, `{\ncargo build\n} 2>&1 | tee -a '/tmp/job'\\''s.log'`);
});

test('a multiline command stays one script, with no line-at-a-prompt restriction', () => {
  const argv = planJobArgv('set -e\nfor i in 1 2; do echo "$i"; done', '/tmp/l.log');
  assert.ok(argv[4]!.includes('for i in 1 2'));
});

test('every command of a ; list reaches the log, not just the last', () => {
  // `a; b | tee` would log only `b`: the brace group is what makes the log the whole output.
  const script = planJobArgv('echo one; echo two', '/tmp/l.log')[4]!;
  assert.equal(script, '{\necho one; echo two\n} 2>&1 | tee -a \'/tmp/l.log\'');
});

test('a trailing comment or backgrounded command cannot swallow the closing brace', () => {
  assert.equal(planJobArgv('echo x # why not', '/tmp/l')[4]!, '{\necho x # why not\n} 2>&1 | tee -a \'/tmp/l\'');
  assert.equal(planJobArgv('serve &', '/tmp/l')[4]!, '{\nserve &\n} 2>&1 | tee -a \'/tmp/l\'');
});

test('the check-in seconds are clamped, and a garbled value falls back to the default', () => {
  assert.equal(clampTimeoutS(120), 120);
  assert.equal(clampTimeoutS(1), MIN_TIMEOUT_S);
  assert.equal(clampTimeoutS(9_999), MAX_TIMEOUT_S);
  assert.equal(clampTimeoutS(undefined), DEFAULT_TIMEOUT_S);
  assert.equal(clampTimeoutS('nonsense'), DEFAULT_TIMEOUT_S);
  assert.equal(clampTimeoutS(42.9), 42);
});

test('log text loses escape sequences and carriage returns before it is shown', () => {
  assert.equal(stripOutput('\x1b[31mred\x1b[0m\r\nplain'), 'red\nplain');
});

test('a tail keeps the newest lines and bounds an endless one', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const tail = tailLines(`${lines}\n`, 3);
  assert.equal(tail, 'line 48\nline 49\nline 50', 'a trailing newline costs no line');
  const endless = 'x'.repeat(5_000);
  const clipped = tailLines(endless, 1);
  assert.ok(clipped.length < 5_000);
  assert.ok(clipped.startsWith('…'));
});

test('a log slice reads either end, filters with grep and reports what it is not showing', () => {
  const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const head = readLogSlice(log, { mode: 'head', lines: 3 });
  assert.ok(head.ok);
  assert.equal(head.text, 'line 1\nline 2\nline 3');
  assert.equal(head.total, 30);

  const tail = readLogSlice(log, { mode: 'tail', lines: 2 });
  assert.ok(tail.ok);
  assert.equal(tail.text, 'line 29\nline 30');

  const grep = readLogSlice(`${log}\nERROR boom`, { mode: 'tail', lines: 10, grep: 'ERROR' });
  assert.ok(grep.ok);
  assert.equal(grep.total, 1);
  assert.equal(grep.text, 'ERROR boom');
});

test('a log slice caps the line count and reports an unusable grep', () => {
  const many = Array.from({ length: 900 }, (_, i) => `${i}`).join('\n');
  const slice = readLogSlice(many, { mode: 'head', lines: 10_000 });
  assert.ok(slice.ok);
  assert.equal(slice.shown, MAX_LOG_LINES);

  const bad = readLogSlice(many, { grep: '(' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /invalid grep/);
});

test('an empty log is not an error', () => {
  const slice = readLogSlice('', { mode: 'tail', lines: 10 });
  assert.ok(slice.ok);
  assert.equal(slice.total, 0);
});

test('elapsed time reads as one token', () => {
  assert.equal(formatDuration(8_000), '8s');
  assert.equal(formatDuration(80_000), '1m 20s');
  assert.equal(formatDuration(3_900_000), '1h 05m');
});

test('the exit notice carries the outcome, the last lines and how to read more', () => {
  const notice = formatJobNotice(job(), 'compiling piher\nfinished');
  assert.match(notice, /Background job job-1 \("build release"\) exited with code 0 after 1m 20s\./);
  assert.match(notice, /Command: cargo build --release/);
  assert.match(notice, /Last output:\ncompiling piher\nfinished/);
  assert.match(notice, /Full output: \/tmp\/piher-jobs\/job-1\.log/);
  assert.match(notice, /action: "log", job_id: "job-1"/);
});

test('a failed job names its exit code and a job without output says so', () => {
  const failed = formatJobNotice(job({ exitCode: 101 }), '');
  assert.match(failed, /exited with code 101/);
  assert.match(failed, /No output\./);
});

test('a job that never started reports why, not an exit code', () => {
  const failed = formatJobNotice(job({ status: 'failed', exitCode: null, error: 'spawn EACCES' }), '');
  assert.match(failed, /could not start: spawn EACCES/);
});

test('a check-in says the job is alive first, so it cannot be read as a failure', () => {
  const notice = formatJobCheckIn(job({ status: 'running', exitCode: null, endedAt: null }), 181_000, 'still going', 8_192);
  assert.match(notice, /was still running after 3m 00s, 8 KB of log \(checked at \d\d:\d\d:\d\d\)\./);
  assert.match(notice, /It was NOT stopped and needs no retry\./);
  assert.match(notice, /If its exit notice has arrived since, this check-in is already history\./);
  assert.match(notice, /action: "stop"/);
});

test('a check-in dates itself, so a late delivery cannot read as the present', () => {
  const at = new Date(2026, 10, 6, 16, 55, 14).getTime();
  const notice = formatJobCheckIn(job({ status: 'running', exitCode: null, endedAt: null, startedAt: at - 5_000 }), at, '', null);
  assert.match(notice, /\(checked at 16:55:14\)/);
  assert.equal(clock(at), '16:55:14');
});

test('a check-in with no output yet still shows the command', () => {
  const notice = formatJobCheckIn(job({ status: 'running', exitCode: null, endedAt: null }), 301_000, '', null);
  assert.match(notice, /No output yet\./);
  assert.match(notice, /Command: cargo build --release/);
});

test('status and list lines never paste a whole log', () => {
  const status = formatJobStatus(job({ status: 'running', exitCode: null, endedAt: null }), 5_000);
  assert.match(status, /state: running · 4s/);
  assert.match(status, /pane: t7/);
  const list = formatJobListLine(job({ exitCode: 2 }), 81_000);
  assert.match(list, /^job-1 · exited with code 2 · build release · 1m 20s · /);
  const unlabeled = formatJobListLine(job({ label: null, command: 'npm   test' }), 81_000);
  assert.match(unlabeled, /· npm test · /);
});

test('outcome text is shared by the notice, status and list', () => {
  assert.equal(jobOutcome(job()), 'exited with code 0');
  assert.equal(jobOutcome(job({ status: 'running', exitCode: null, endedAt: null })), 'running');
  assert.equal(jobOutcome(job({ status: 'stopped', exitCode: null })), 'stopped');
  assert.equal(jobOutcome(job({ status: 'finished', exitCode: null })), 'finished without an exit code');
});

test('the renderer details carry the facts, never the notice body', () => {
  const details = jobNoticeDetails(job(), 81_000, false);
  assert.deepEqual(details, {
    jobId: 'job-1',
    label: 'build release',
    status: 'finished',
    exitCode: 0,
    durationMs: 80_000,
    command: 'cargo build --release',
    logPath: '/tmp/piher-jobs/job-1.log',
    checkIn: false,
  });
});

test('a running job measures elapsed time against now', () => {
  const details = jobNoticeDetails(job({ status: 'running', endedAt: null }), 6_000, true);
  assert.equal(details.durationMs, 5_000);
  assert.equal(details.checkIn, true);
});

test('the notice falls back to the pane when the log was never written', () => {
  // A body a shell rejects before `tee` runs leaves no log; the pane is the only witness.
  assert.equal(chooseTail(null, 'bash: syntax error near unexpected token', 5), 'bash: syntax error near unexpected token');
  assert.equal(chooseTail('   \n', 'line on the pane', 5), 'line on the pane');
  // A log with content wins: it is the whole output, the pane is only a window.
  assert.equal(chooseTail('one\ntwo\nthree\n', 'pane text', 2), 'two\nthree');
  assert.equal(chooseTail(null, '   ', 5), '');
});

test('a job label roundtrips, and a long command is clipped there', () => {
  const meta = { name: 'build release', log: '/tmp/l.log', started: 1_000, timeout: 300, command: 'cargo build' };
  assert.deepEqual(decodeJobMeta(encodeJobMeta(meta)), meta);
  const long = encodeJobMeta({ ...meta, command: 'x'.repeat(400) });
  assert.ok(long.length < 400 + 120, 'the label stays metadata-sized');
  assert.match(decodeJobMeta(long)!.command, /…$/);
});

test('a label written by another build degrades instead of throwing', () => {
  assert.equal(decodeJobMeta(undefined), null);
  assert.equal(decodeJobMeta('not json'), null);
  assert.equal(decodeJobMeta('[1,2]'), null);
  assert.deepEqual(decodeJobMeta('{}'), { name: null, log: '', started: 0, timeout: 0, command: '' });
});

test('adoption picks up a live job with its remaining check-in budget', () => {
  const now = 100_000;
  const meta = encodeJobMeta({ name: 'tests', log: '/tmp/j.log', started: now - 40_000, timeout: 300, command: 'npm test' });
  const plans = planAdoption([{
    id: 't9', cwd: '/repo', labels: { [JOB_LABEL_KEY]: 'job-1xk3', [JOB_META_LABEL]: meta },
    state: 'live', exitCode: null,
  }], new Set(), now);
  assert.equal(plans.length, 1);
  const plan = plans[0]!;
  assert.equal(plan.finished, false);
  assert.equal(plan.job.id, 'job-1xk3');
  assert.equal(plan.job.label, 'tests');
  assert.equal(plan.job.paneId, 't9');
  assert.equal(plan.job.status, 'running');
  assert.equal(plan.remainingMs, 260_000, '300s budget minus the 40s already spent');
  assert.equal(plan.job.checkInSent, false);
});

test('adoption reports a job that exited while nobody was watching', () => {
  const now = 100_000;
  const plans = planAdoption([{
    id: 't9', cwd: '/repo', labels: { [JOB_LABEL_KEY]: 'job-2', [JOB_META_LABEL]: encodeJobMeta({ name: null, log: '', started: now - 9_000, timeout: 300, command: 'false' }) },
    state: 'finished', exitCode: 1,
  }], new Set(), now);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.finished, true);
  assert.equal(plans[0]!.job.exitCode, 1, "core's exit code survives the reload");
});

test('adoption ignores what it already tracks, foreign panes, and fires no late check-in', () => {
  const now = 1_700_000_000_000;
  const live = (id: string, labels: Record<string, string>) => ({ id: `t-${id}`, cwd: '/repo', labels, state: 'live' as const, exitCode: null });
  const plans = planAdoption([
    live('known', { [JOB_LABEL_KEY]: 'job-1' }),
    live('foreign', { 'piher.session': 'abc' }),
    live('stale', { [JOB_LABEL_KEY]: 'job-3', [JOB_META_LABEL]: encodeJobMeta({ name: null, log: '', started: now - 600_000, timeout: 300, command: 'sleep' }) }),
  ], new Set(['job-1']), now);
  assert.deepEqual(plans.map((plan) => plan.job.id), ['job-3']);
  assert.equal(plans[0]!.job.checkInSent, true, 'a job already past its budget is not discovered again');
  assert.equal(plans[0]!.job.command, 'sleep');
});

test('a job from a build without the meta label is still adopted, with what core knows', () => {
  const now = 100_000;
  const plans = planAdoption([{
    id: 't7', cwd: '/repo', labels: { [JOB_LABEL_KEY]: 'job-9' }, state: 'live', exitCode: null,
  }], new Set(), now);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.job.logPath, '');
  assert.match(plans[0]!.job.command, /command unknown/);
  assert.equal(plans[0]!.job.startedAt, now);
});

test('a delivered job leaves the list: the launcher already acted on its notice', () => {
  const jobs = [
    job({ id: 'job-1', delivered: true }),
    job({ id: 'job-2', status: 'running', exitCode: null, endedAt: null }),
    job({ id: 'job-3', delivered: false, exitCode: 3 }),
  ];
  assert.deepEqual(listedJobs(jobs).map((entry) => entry.id), ['job-2', 'job-3']);
  assert.deepEqual(listedJobs([]), []);
});

test('delivered records are kept for a short tail, then dropped while the log survives', () => {
  const delivered = Array.from({ length: 8 }, (_, i) => job({ id: `job-${i + 1}`, delivered: true, endedAt: 1_000 + i }));
  const expired = expiredDelivered(delivered, 5);
  assert.deepEqual(expired, ['job-1', 'job-2', 'job-3'], 'the three oldest deliveries go');
  assert.deepEqual(expiredDelivered(delivered.slice(0, 3), 5), []);
  // A delivered running record is impossible, but a `stopped` one is delivered and still sorted.
  assert.deepEqual(expiredDelivered([job({ id: 'job-9', status: 'stopped', delivered: true, endedAt: 5 })], 0), ['job-9']);
});

test('a job adopted from a reload starts un-delivered, because its notice is owed', () => {
  const plans = planAdoption([{
    id: 't9', cwd: '/repo', labels: { [JOB_LABEL_KEY]: 'job-2x1' }, state: 'finished', exitCode: 0,
  }], new Set(), Date.now());
  assert.equal(plans[0]!.job.delivered, false);
});
