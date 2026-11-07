/** Process-level infrastructure: DisposeLedger (HMR/D79), storage layout, OPTION_SPECS
 *  + RuntimePolicy, swallow/toolError bookkeeping, and the boot / installer guards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DisposeLedger } from '../src/ledger.ts';
import { createPlatformPaths } from '../src/platform-paths.ts';
import { OPTION_SPECS, formatOptionRows, optionValue, optionRows } from '../src/options.ts';
import { createRuntimePolicy, type RuntimePolicy } from '../src/runtime-policy.ts';
import {
  mainWorktreeRoot, piCoreSessionDirName,
  piSessionDirCandidates, sessionDirName,
} from '../src/storage-layout.ts';
import { repoTasksDir } from '../src/task-store.ts';
import { SWALLOW_BUFFER_MAX, formatSwallowedErrors, resetSwallowedErrors, swallow, swallowedErrors } from '../src/swallow.ts';
import { ToolError, toolError } from '../src/tool-error.ts';
import { withCleanup, type CleanupContext } from './test-utils.ts';

/* ── DisposeLedger ──────────────────────────────────────────────────────── */

test('ledger: disposeKey only tears down matching keys (hmr compensation), others stay', () => {
  const led = new DisposeLedger(), ran: string[] = [];
  led.add('F:/x/src/a.ts', () => ran.push('a'));
  led.add('F:/x/src/b.ts', () => ran.push('b'));
  led.add('F:/x/src/a.ts', () => ran.push('a2'));
  assert.equal(led.disposeKey('F:\\x\\src\\a.ts'), 2, 'Windows path shape must hit too'); assert.deepEqual(ran.sort(), ['a', 'a2']);
  assert.equal(led.size, 1, 'b is kept');
});

test('ledger: disposeAll is LIFO (cordis effect order) and survives a throwing disposer', () => {
  const led = new DisposeLedger(), ran: string[] = [];
  led.add('a', () => ran.push('1'));
  led.add('b', () => { throw new Error('boom'); });
  led.add('c', () => ran.push('3'));
  assert.equal(led.disposeAll(), 3); assert.deepEqual(ran, ['3', '1'], 'LIFO, the throw is swallowed'); assert.equal(led.size, 0);
});

test('ledger: add returns an undo fn (self-disposing resource is not torn down twice)', () => {
  const led = new DisposeLedger();
  let disposed = 0;
  led.add('a', () => disposed++)();
  assert.equal(led.size, 0); assert.equal(led.disposeKey('a'), 0, 'undone entries never match'); assert.equal(disposed, 0);
});

test('ledger: keys are normalized (file:// URL vs path, backslashes, logical names)', () => {
  for (const [registered, lookup] of [
    [resolve('x.ts'), pathToFileURL(resolve('x.ts')).href], // import.meta.url vs hmr filename
    ['F:\\repo\\piher\\x.ts', 'F:/repo/piher/x.ts'], // Windows hmr filename shape
    ['pi-surface', 'pi-surface'], // D79 logical name, verbatim
  ] as const) {
    const led = new DisposeLedger(), ran: string[] = [];
    led.add(registered, () => ran.push('hit'));
    assert.equal(led.disposeKey(lookup), 1, `${registered} ↔ ${lookup}`); assert.deepEqual(ran, ['hit']);
  }
});

/* ── routing telemetry removed with the context-economy machinery (S69) ── */

/* ── storage-layout / platform-paths ────────────────────────────────────── */

test('sessionDirName: percent-encoded separators (a/b ≠ a-b)', () => {
  assert.equal(sessionDirName('a/b'), '--a%2Fb--'); assert.equal(sessionDirName('a-b'), '--a-b--');
  assert.notEqual(sessionDirName('a/b'), sessionDirName('a-b')); assert.equal(sessionDirName('F:\\piher'), '--F%3A%5Cpiher--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--'); assert.equal(sessionDirName('a%b/c'), '--a%25b%2Fc--');
});

test('mainWorktreeRoot/repoTasksDir: the main checkout owns the tasks, a linked worktree points at it', withCleanup((cleanup) => {
  const main = cleanup.tempDir('ledger-main').path;
  mkdirSync(join(main, '.git'));
  assert.equal(repoTasksDir(main), join(main, '.piher', 'tasks'), 'the main checkout records into itself');
  const nested = join(main, 'packages', 'deep');
  mkdirSync(nested, { recursive: true });
  assert.equal(mainWorktreeRoot(nested), main, 'a subdirectory resolves to its repository');

  // A linked worktree has a `.git` FILE; `commondir` names the shared git dir (`../..` from its gitdir).
  const wt = cleanup.tempDir('ledger-wt').path;
  const wtGitdir = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(wtGitdir, { recursive: true });
  writeFileSync(join(wtGitdir, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGitdir}\n`);
  assert.equal(mainWorktreeRoot(wt), main, 'never the worktree');
  mkdirSync(join(wt, 'src'), { recursive: true });
  assert.equal(repoTasksDir(join(wt, 'src')), repoTasksDir(main), 'the worktree writes the repository tasks');

  // No working tree: no tasks at all, and no fallback location.
  const outside = cleanup.tempDir('ledger-out').path;
  assert.equal(mainWorktreeRoot(outside), null);
  assert.equal(repoTasksDir(outside), null);
  assert.equal(repoTasksDir(join(outside, 'gone')), null, 'a collected checkout resolves to nothing');

  // A gitdir redirect without a commondir (submodule) owns no working tree here.
  const sub = cleanup.tempDir('ledger-sub').path;
  writeFileSync(join(sub, '.git'), `gitdir: ${join(main, '.git', 'modules', 'sub')}\n`);
  assert.equal(mainWorktreeRoot(sub), null);
}));

test('piCoreSessionDirName/piSessionDirCandidates: byte-identical to pi core, piher encodings as fallback', () => {
  // pi core (dist/migrations.js:102): `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  assert.equal(piCoreSessionDirName('/Users/yehaoyu/Documents/piher'), '--Users-yehaoyu-Documents-piher--');
  assert.equal(piCoreSessionDirName('F:\\piher'), '--F--piher--', 'a Windows drive has no leading separator');
  assert.equal(piCoreSessionDirName('/a%2Fb'), '--a%2Fb--', '`%` stays literal — why the old POSIX dirs all missed');
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirName('/home/u/proj'));
  assert.deepEqual(piSessionDirCandidates('/home/u/proj'), ['--home-u-proj--', '--%2Fhome%2Fu%2Fproj--']);
  assert.deepEqual(piSessionDirCandidates('F:\\piher'), ['--F--piher--', '--F%3A%5Cpiher--'], 'no duplicate on Windows');
});

test('createPlatformPaths: overrides win; sessionsDir defaults under agentDataDir', () => {
  const p = createPlatformPaths({ agentDataDir: '/x/agent' });
  assert.equal(p.agentDataDir, '/x/agent'); assert.equal(p.sessionsDir, join('/x/agent', 'sessions'));
  assert.equal(createPlatformPaths({ agentDataDir: '/x/agent', sessionsDir: '/custom/sessions' }).sessionsDir, '/custom/sessions');
});

test("createPlatformPaths: sessions live under pi's own agent dir, not XDG", { skip: !['linux', 'darwin'].includes(process.platform) }, () => {
  // pi writes sessions to ~/.pi/agent/sessions (storage-layout already assumes it) and does not follow
  // XDG_DATA_HOME. Deriving the default from XDG pointed at ~/.local/share/agent/sessions, which never
  // exists, so every resolution by session id silently found nothing — the worker could not read its own
  // transcript, so the instant settle reply was never sent and every report waited for the poller.
  assert.equal(createPlatformPaths().sessionsDir, join(homedir(), '.pi', 'agent', 'sessions'));
});

/* ── OPTION_SPECS registry + RuntimePolicy ──────────────────────────────── */

const POLICY_FIELDS: ReadonlyArray<keyof RuntimePolicy> = [
  'subagentTimeoutMs', 'gcTickMs', 'pollIntervalMs', 'settleWindowMs',
  'sessionTtlSeconds', 'gitTimeoutMs', 'readinessTimeoutMs',
];

const OPTION_NAMES = OPTION_SPECS.map((o) => o.name);

/** Unsets every registry name first so the developer's own PIHER_* exports cannot leak in. */
function applyEnv(cleanup: CleanupContext, env: Record<string, string | undefined>): void {
  const snap = cleanup.env();
  for (const name of OPTION_NAMES) snap.delete(name);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) snap.delete(key);
    else snap.set(key, value);
  }
}

test('optionValue: a set value is read, an empty string counts as unset', () => {
  assert.equal(optionValue('PIHER_GIT_TIMEOUT_MS', { PIHER_GIT_TIMEOUT_MS: '5000' }), '5000');
  assert.equal(optionValue('PIHER_GIT_TIMEOUT_MS', { PIHER_GIT_TIMEOUT_MS: '7000' }), '7000');
  // `export X=` is common in shells; a blank value must not shadow the default.
  assert.equal(optionValue('PIHER_GIT_TIMEOUT_MS', { PIHER_GIT_TIMEOUT_MS: '  ' }), undefined);
  assert.equal(optionValue('PIHER_GIT_TIMEOUT_MS', {}), undefined);
  assert.equal(optionValue('NOT_AN_OPTION', { NOT_AN_OPTION: 'x' }), 'x', 'unregistered names are read verbatim');
});

test('optionRows/formatOptionRows: env / default provenance', () => {
  const set = optionRows({ PIHER_SESSION_TTL_SECONDS: '0' }).find((r) => r.name === 'PIHER_SESSION_TTL_SECONDS');
  assert.equal(set?.value, '0'); assert.equal(set?.source, 'env');
  const unset = optionRows({}).find((r) => r.name === 'PIHER_SESSION_TTL_SECONDS');
  assert.equal(unset?.source, 'default'); assert.equal(formatOptionRows({}).length, OPTION_SPECS.length);
  assert.match(formatOptionRows({})[0]!, /^\s+PIHER_[A-Z_]+ = .+\(default\)/);
});

test('createRuntimePolicy: every field comes from the registry; overrides > env > fallback', withCleanup((cleanup) => {
  applyEnv(cleanup, {});
  const fromRegistry = createRuntimePolicy();
  assert.deepEqual(Object.keys(fromRegistry).sort(), [...POLICY_FIELDS].sort(), 'RuntimePolicy fields match the registry');
  for (const field of POLICY_FIELDS) {
    const spec = OPTION_SPECS.find((o) => o.policy === field);
    assert.ok(spec, `${field} must be supplied by a OPTION_SPECS entry`);
    assert.equal(fromRegistry[field], Number(spec.fallback), `${field} default = registry fallback`);
    assert.notEqual(spec.min, undefined, `${spec.name} needs a min bound`);
  }
  assert.equal(createRuntimePolicy({ gitTimeoutMs: 42, subagentTimeoutMs: 99 }).gitTimeoutMs, 42, 'overrides win');

  applyEnv(cleanup, { PIHER_GIT_TIMEOUT_MS: '2500', PIHER_SUBAGENT_TIMEOUT_MS: '8000' });
  const p = createRuntimePolicy();
  assert.equal(p.gitTimeoutMs, 2500, 'canonical env applies'); assert.equal(p.subagentTimeoutMs, 8000, 'legacy name applies too');
  assert.equal(createRuntimePolicy({ gitTimeoutMs: 42 }).gitTimeoutMs, 42, 'override beats env');
}));

test('createRuntimePolicy: an invalid/out-of-range value warns once and falls back', withCleanup((cleanup) => {
  applyEnv(cleanup, { PIHER_GIT_TIMEOUT_MS: 'nope', PIHER_SUBAGENT_TIMEOUT_MS: '-1' });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const p = createRuntimePolicy();
    assert.equal(p.gitTimeoutMs, 10_000); assert.equal(p.subagentTimeoutMs, 300_000);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, ['Invalid PIHER_GIT_TIMEOUT_MS="nope", using default 10000', 'Invalid PIHER_SUBAGENT_TIMEOUT_MS="-1", using default 300000']);
  // A14: concurrent workers routinely take longer than 30s to boot.
  assert.equal(createRuntimePolicy().readinessTimeoutMs, 90_000);
}));

test('registry: every registered name reaches the reader that owns it', withCleanup((cleanup) => {
  applyEnv(cleanup, { PIHER_JOBS_DIR: '/tmp/piher-job-test' });
  assert.equal(optionValue('PIHER_JOBS_DIR'), '/tmp/piher-job-test');
}));

test('registry self-consistency: PIHER_* names, integer fallbacks', () => {
  for (const spec of OPTION_SPECS) {
    assert.match(spec.name, /^PIHER_/, `${spec.name} is the namespace`);
    if (spec.min !== undefined) assert.match(spec.fallback, /^\d+$/, `${spec.name} is an integer option`);
  }
});

/* ── swallow ────────────────────────────────────────────────────────────── */

test('swallow: records tag/cause/time instead of throwing (cleanup must continue)', () => {
  resetSwallowedErrors();
  assert.doesNotThrow(() => swallow('role.persist-switch', new ReferenceError('persistEdit is not defined'), {}));
  const [entry] = swallowedErrors();
  assert.equal(entry!.tag, 'role.persist-switch'); assert.match(entry!.message, /ReferenceError: persistEdit is not defined/); assert.ok(entry!.at > 0);
});

test('swallow: the ring buffer is bounded (no unbounded growth per session)', () => {
  resetSwallowedErrors();
  for (let i = 0; i < SWALLOW_BUFFER_MAX + 25; i += 1) swallow('t', new Error(`e${i}`), {});
  const entries = swallowedErrors();
  assert.equal(entries.length, SWALLOW_BUFFER_MAX); assert.match(entries[entries.length - 1]!.message, /e74$/, 'the newest entry is kept');
});

test('swallow: PIHER_TRACE writes the entry to stderr, silence otherwise', () => {
  resetSwallowedErrors();
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try {
    swallow('x.y', new Error('loud'), { PIHER_TRACE: '1' });
    swallow('x.z', new Error('quiet'), {});
    swallow('x.w', new Error('legacy'), { PIHER_TRACE: '1' });
  } finally {
    console.error = orig;
  }
  assert.equal(seen.length, 2); assert.match(seen[0]!, /swallowed x\.y: Error: loud/); assert.match(seen[1]!, /swallowed x\.w: Error: legacy/);
});

test('formatSwallowedErrors: explicit empty state, otherwise the last 10', () => {
  resetSwallowedErrors();
  assert.match(formatSwallowedErrors(), /none this session/);
  for (let i = 0; i < 12; i += 1) swallow(`tag${i}`, new Error(`m${i}`), {});
  const text = formatSwallowedErrors();
  assert.match(text, /swallowed errors: 12 this session \(last 10\)/); assert.match(text, /tag11: Error: m11/);
  assert.doesNotMatch(text, /tag1: Error: m1$/m, 'the oldest entries are dropped');
});

/* ── tool errors (A1) ───────────────────────────────────────────────────── */

// pi only flags a failed tool result when execute() throws; "Error: …" text in returned content is
// invisible to the model and to hooks keyed on event.isError. Guard the tool modules against it.
test('A1: tool modules never return a hard failure as text', () => {
  const offenders: string[] = [];
  for (const file of ['src/plugins/subagent.ts', 'src/plugins/bg-job.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (/content: \[\{ type: 'text', text: (`|')[^`']*Error:/.test(code)
        || /content: \[\{ type: 'text', text: (resolved\.error|launch\.text|isoGuard\.text)/.test(code)) {
        offenders.push(`${file}:${i + 1}: ${code.slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `failures still returned as values (the model cannot see isError):\n${offenders.join('\n')}`);
});

test('A1: toolError drops the redundant "Error: " prefix and keeps the cause', () => {
  assert.throws(() => toolError('Error: boom'), (err: unknown) => { assert.ok(err instanceof ToolError); assert.equal((err as Error).message, 'boom');
    return true;
  });
  assert.throws(() => toolError('boom'), (err: unknown) => { assert.equal((err as Error).message, 'boom');
    return true;
  });
});
