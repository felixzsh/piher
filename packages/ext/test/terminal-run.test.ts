/** terminal-run: the exit-code reporter appended to a sent command, its parse, the log and the notice. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import {
  formatTerminalRunNotice,
  hasShellComment,
  lastLines,
  planTerminalRun,
  runExitCode,
  runOutput,
  shellRunsReporter,
  terminalRunLogPath,
  writeRunLog,
} from '../src/terminal-run.ts';

const plan = (text: string, over: Partial<Parameters<typeof planTerminalRun>[0]> = {}) =>
  planTerminalRun({ text, shellName: 'bash', shellIdle: true, nonce: 'ab12cd34', ...over });

/* ── planning ── */

test('planTerminalRun: a shell command carries its own exit reporter', () => {
  const run = plan('npm test');
  assert.ok(run);
  assert.equal(run.wrapped, `npm test; printf '\\n__PIHER_EXIT_%s__%d\\n' 'ab12cd34' "$?"`);
  assert.equal(run.marker, '__PIHER_EXIT_ab12cd34__');
  // The echo of the sent line shows the format placeholders, so the watcher cannot match its echo.
  assert.equal(run.wrapped.includes(run.marker), false);
});

test('planTerminalRun: trailing separators are dropped, then the reporter is appended', () => {
  assert.equal(plan('make build;  ')?.wrapped, `make build; printf '\\n__PIHER_EXIT_%s__%d\\n' 'ab12cd34' "$?"`);
  assert.equal(plan('make;;;')?.wrapped, `make; printf '\\n__PIHER_EXIT_%s__%d\\n' 'ab12cd34' "$?"`);
});

test('planTerminalRun: anything that cannot take a trailing printf is sent unchanged', () => {
  for (const text of [
    '', '   ',
    'sleep 5 &',
    'make &&',
    'make |',
    'make ||',
    'make \\',
    'cat <<EOF\nline\nEOF',
    'for i in 1 2; do\n  echo "$i"\ndone',
    'grep -n "#include" main.c; true  # trailing note',
  ]) {
    assert.equal(plan(text), null, `should not be wrapped: ${JSON.stringify(text)}`);
  }
  // A quoted hash is text, not a comment: the reporter still goes on.
  assert.ok(plan('echo "#done"'));
});

test('planTerminalRun: only a known POSIX shell at an idle prompt is a run', () => {
  assert.equal(plan('npm test', { shellIdle: false }), null);
  // fish and nushell do not parse `cmd; printf …`: the line must go out exactly as typed.
  for (const shellName of ['fish', 'nu', 'nushell', 'pwsh', 'powershell', 'cmd', 'csh', 'tcsh', 'xonsh', 'elvish', '']) {
    assert.equal(plan('npm test', { shellName }), null, `${shellName || '(unnamed)'} must not be wrapped`);
  }
  for (const shellName of ['/bin/bash', '/usr/bin/zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'BASH', '-bash']) {
    assert.ok(plan('npm test', { shellName }), `${shellName} is a POSIX shell`);
  }
});

test('shellRunsReporter: basenames, extensions and login-shell dashes are normalised', () => {
  assert.equal(shellRunsReporter('/usr/bin/bash'), true);
  assert.equal(shellRunsReporter('C:\\Program Files\\Git\\bin\\bash.exe'), true);
  assert.equal(shellRunsReporter('-zsh'), true);
  assert.equal(shellRunsReporter('/usr/bin/fish'), false);
  assert.equal(shellRunsReporter(''), false);
});

test('planTerminalRun: each run gets a distinct marker', () => {
  const a = planTerminalRun({ text: 'true', shellName: 'bash', shellIdle: true });
  const b = planTerminalRun({ text: 'true', shellName: 'bash', shellIdle: true });
  assert.ok(a && b);
  assert.notEqual(a.marker, b.marker);
});

test('hasShellComment: quotes and escapes hide a hash, whitespace exposes one', () => {
  assert.equal(hasShellComment('echo hello'), false);
  assert.equal(hasShellComment('echo "a # b"'), false);
  assert.equal(hasShellComment("echo '# not a comment'"), false);
  assert.equal(hasShellComment('echo \\#escaped'), false);
  assert.equal(hasShellComment('echo hi # note'), true);
  assert.equal(hasShellComment('# leading'), true);
  assert.equal(hasShellComment('make; # after a separator'), true);
});

/* ── reading the pane back ── */

const PANE = [
  '$ npm test; printf \'\\n__PIHER_EXIT_%s__%d\\n\' \'ab12cd34\' "$?"',
  '> ext@0.5.2 test',
  'ok 1 - something',
  'not ok 2 - another',
  '',
  '__PIHER_EXIT_ab12cd34__1',
  '$ ',
].join('\n');

test('runExitCode: the reporter line yields the real status, an unsubstituted echo does not', () => {
  assert.equal(runExitCode(PANE, '__PIHER_EXIT_ab12cd34__'), 1);
  assert.equal(runExitCode(PANE, '__PIHER_EXIT_ffffffff__'), null);
  assert.equal(runExitCode('__PIHER_EXIT_ab12cd34__', '__PIHER_EXIT_ab12cd34__'), null);
  assert.equal(runExitCode('still running', '__PIHER_EXIT_ab12cd34__'), null);
});

test('runExitCode: the reporter line must match exactly, not as a substring', () => {
  assert.equal(runExitCode('__PIHER_EXIT_ab12cd34__1 extra', '__PIHER_EXIT_ab12cd34__'), null);
  assert.equal(runExitCode('log: __PIHER_EXIT_ab12cd34__0', '__PIHER_EXIT_ab12cd34__'), null);
  assert.equal(runExitCode('__PIHER_EXIT_ab12cd34__-1', '__PIHER_EXIT_ab12cd34__'), -1);
});

test('runOutput: the run\'s output only, without the echoed reporter line or the marker', () => {
  const output = runOutput(PANE, '__PIHER_EXIT_ab12cd34__');
  assert.equal(output, ['> ext@0.5.2 test', 'ok 1 - something', 'not ok 2 - another'].join('\n'));
});

test('runOutput: output that merely mentions the marker prefix is kept', () => {
  // Only this run's own echo is dropped: a command that greps the piher source prints these lines.
  const text = [
    `$ grep -rn __PIHER_EXIT_ src/terminal-run.ts; printf '\\n__PIHER_EXIT_%s__%d\\n' 'ab12cd34' "$?"`,
    'src/terminal-run.ts:24:const MARKER = \'__PIHER_EXIT_\';',
    'src/terminal-run.ts:120:  return `${MARKER}${nonce}__`;',
    '__PIHER_EXIT_ab12cd34__0',
  ].join('\n');
  assert.equal(
    runOutput(text, '__PIHER_EXIT_ab12cd34__'),
    [
      'src/terminal-run.ts:24:const MARKER = \'__PIHER_EXIT_\';',
      'src/terminal-run.ts:120:  return `${MARKER}${nonce}__`;',
    ].join('\n'),
  );
});

test('runOutput: a run with no output leaves an empty log body', () => {
  const text = [`$ true; printf '\\n__PIHER_EXIT_%s__%d\\n' 'ab12cd34' "$?"`, '__PIHER_EXIT_ab12cd34__0'].join('\n');
  assert.equal(runOutput(text, '__PIHER_EXIT_ab12cd34__'), '');
});

test('lastLines: keeps the tail and everything when the text is short', () => {
  assert.equal(lastLines('a\nb\nc', 5), 'a\nb\nc');
  assert.equal(lastLines('a\nb\nc\nd', 2), 'c\nd');
  assert.equal(lastLines('', 3), '');
});

/* ── a real shell proves the reporter ── */

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const REPORTED_CODES = [['true', 0], ['sleep 0.1; false', 1], ['(exit 7)', 7], ['echo hi | grep -q hi', 0]] as const;

for (const [command, expected] of REPORTED_CODES) {
  test(`the reporter reports a real exit code for \`${command}\``, (t) => {
    if (!bashAvailable()) return t.skip('bash not available');
    const run = plan(command);
    assert.ok(run);
    const stdout = execFileSync('bash', ['-c', run.wrapped], { encoding: 'utf8' });
    assert.equal(runExitCode(stdout, run.marker), expected);
  });
}

test('the reporter survives a failing pipeline only with pipefail, as documented', (t) => {
  if (!bashAvailable()) return t.skip('bash not available');
  const command = 'false | true';
  const plain = plan(command);
  assert.ok(plain);
  const plainOut = execFileSync('bash', ['-c', plain.wrapped], { encoding: 'utf8' });
  assert.equal(runExitCode(plainOut, plain.marker), 0, 'the last command decides the status');

  const piped = plan(`set -o pipefail; ${command}`);
  assert.ok(piped);
  const pipedOut = execFileSync('bash', ['-c', piped.wrapped], { encoding: 'utf8' });
  assert.equal(runExitCode(pipedOut, piped.marker), 1);
});

/* ── log and notice ── */

test('terminalRunLogPath: absolute, under the temp dir, pane-safe', () => {
  const path = terminalRunLogPath({ paneId: 'wD:p2/x', now: Date.UTC(2026, 0, 2, 3, 4, 5) });
  assert.equal(path.startsWith(tmpdir()), true);
  assert.equal(path.includes('wD-p2-x'), true);
  assert.equal(path.endsWith('.log'), true);
  assert.equal(dirname(path).includes('piher-terminal-runs'), true);
  assert.equal(path.includes(':'), tmpdir().includes(':'));
});

test('writeRunLog: creates its directory and names an existing file', () => {
  const path = terminalRunLogPath({ paneId: 'p-test', stamp: `${process.pid}-${Date.now()}` });
  try {
    writeRunLog(path, 'ok 1\nok 2');
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(path, 'utf8'), 'ok 1\nok 2\n');
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('formatTerminalRunNotice: exit code, tail and the log path it names', () => {
  assert.equal(
    formatTerminalRunNotice({
      terminalId: 'term-1',
      label: 'build',
      exitCode: 2,
      tail: 'not ok 2',
      logPath: '/tmp/run.log',
    }),
    'terminal term-1 (build) finished: exit 2.\nLast lines:\nnot ok 2\nFull output: /tmp/run.log',
  );
  assert.equal(
    formatTerminalRunNotice({ terminalId: 'term-1', label: null, exitCode: 0, tail: '', logPath: null }),
    'terminal term-1 finished: exit 0.',
  );
});

test('formatTerminalRunNotice: a shell that exited still reports its outcome', () => {
  // `exit 7` closes the pane, so the run's own reporter never prints; core's status stands in.
  assert.equal(
    formatTerminalRunNotice({ terminalId: 'term-1', label: 'x', exitCode: 7, shellExited: true, tail: '', logPath: null }),
    'terminal term-1 (x) finished: the shell exited (exit 7).',
  );
  assert.equal(
    formatTerminalRunNotice({ terminalId: 'term-1', label: null, exitCode: null, shellExited: true, tail: 'bye', logPath: '/tmp/l' }),
    'terminal term-1 finished: the shell exited before its command could report a status.\nLast lines:\nbye\nFull output: /tmp/l',
  );
  assert.equal(
    formatTerminalRunNotice({ terminalId: 'term-1', label: null, exitCode: null, tail: '', logPath: null }),
    'terminal term-1 finished without a status to report.',
  );
});
