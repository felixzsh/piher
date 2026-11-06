/** background-core: the command plan, names, log slices and the two notices a job can produce. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_S,
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
} from '../src/background-core.ts';

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
    ...overrides,
  };
}

test('a job id is short and pasteable', () => {
  assert.equal(nextJobId(1), 'job-1');
  assert.equal(nextJobId(42), 'job-42');
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
  assert.ok(script.startsWith('cargo build 2>&1 | tee -a '));
  assert.ok(script.includes(`'/tmp/job'\\''s.log'`));
});

test('a multiline command stays one script, with no line-at-a-prompt restriction', () => {
  const argv = planJobArgv('set -e\nfor i in 1 2; do echo "$i"; done', '/tmp/l.log');
  assert.ok(argv[4]!.includes('for i in 1 2'));
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
  const tail = tailLines(lines, 3);
  assert.equal(tail, 'line 48\nline 49\nline 50');
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
  assert.match(notice, /is still running after 3m 00s, 8 KB of log\./);
  assert.match(notice, /It was NOT stopped and needs no retry\./);
  assert.match(notice, /action: "stop"/);
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
