/** Process-level infrastructure: DisposeLedger (HMR/D79), storage layout, OPTION_SPECS
 *  + RuntimePolicy, swallow/toolError bookkeeping, and the boot / installer guards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCordisApp, detectExposeInternals } from '../src/bootstrap.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { createPlatformPaths } from '../src/platform-paths.ts';
import { OPTION_SPECS, formatOptionRows, optionValue, optionRows } from '../src/options.ts';
import { createRuntimePolicy, type RuntimePolicy } from '../src/runtime-policy.ts';
import {
  ledgerFile, mainWorktreeRoot, piCoreSessionDirName,
  piSessionDirCandidates, sessionDirName,
} from '../src/storage-layout.ts';
import { SWALLOW_BUFFER_MAX, formatSwallowedErrors, resetSwallowedErrors, swallow, swallowedErrors } from '../src/swallow.ts';
import { POSIX_PROMPT, POWERSHELL_PROMPT, promptStrategyFor, terminalIdleMs, terminalReminderGraceMs } from '../src/terminal-core.ts';
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

test('mainWorktreeRoot/ledgerFile: the main checkout owns the ledger, a linked worktree points at it', withCleanup((cleanup) => {
  const main = cleanup.tempDir('ledger-main').path;
  mkdirSync(join(main, '.git'));
  assert.equal(ledgerFile(main), join(main, '.piher', 'history', 'history.jsonl'), 'the main checkout records into itself');
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
  assert.equal(ledgerFile(join(wt, 'src')), ledgerFile(main), 'the worktree writes the repository ledger');

  // No working tree: no ledger at all, and no fallback location.
  const outside = cleanup.tempDir('ledger-out').path;
  assert.equal(mainWorktreeRoot(outside), null);
  assert.equal(ledgerFile(outside), null);
  assert.equal(ledgerFile(join(outside, 'gone')), null, 'a collected checkout resolves to nothing');

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
  const set = optionRows({ PIHER_TERM_GRACE_MS: '0' }).find((r) => r.name === 'PIHER_TERM_GRACE_MS');
  assert.equal(set?.value, '0'); assert.equal(set?.source, 'env');
  const unset = optionRows({}).find((r) => r.name === 'PIHER_TERM_GRACE_MS');
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
    assert.equal(p.gitTimeoutMs, 10_000); assert.equal(p.subagentTimeoutMs, 600_000);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, ['Invalid PIHER_GIT_TIMEOUT_MS="nope", using default 10000', 'Invalid PIHER_SUBAGENT_TIMEOUT_MS="-1", using default 600000']);
  // A14: concurrent workers routinely take longer than 30s to boot.
  assert.equal(createRuntimePolicy().readinessTimeoutMs, 90_000);
}));

test('registry: legacy spellings still reach the real readers', withCleanup((cleanup) => {
  applyEnv(cleanup, { PIHER_TERM_IDLE_MS: '1234', PIHER_TERM_GRACE_MS: '4321' });
  assert.equal(terminalIdleMs(), 1234, 'legacy name works'); assert.equal(terminalReminderGraceMs(), 4321, 'canonical name works');
  assert.equal(promptStrategyFor({ PIHER_TERMINAL_PROMPT: 'powershell' }), POWERSHELL_PROMPT, 'legacy prompt name');
  assert.equal(promptStrategyFor({ PIHER_TERMINAL_PROMPT: 'bash' }), POSIX_PROMPT);
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

test('swallow: PIHER_TRACE / legacy PIHER_TRACE writes to stderr', () => {
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
  for (const file of ['src/plugins/subagent.ts', 'src/plugins/terminal.ts']) {
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

/* ── boot and installer guards: starting piher outside a dev checkout ─────── */
// Production must not loader.create() .ts files unless HMR is active (Node cannot strip types under
// node_modules; the loader path exists for dev HMR only), and the installer CLI must stay runnable
// from an npx cache (no repo checkout).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const master = readFileSync(fileURLToPath(new URL('../src/index-master.ts', import.meta.url)), 'utf8');

test('bootstrap: Loader mounts, hmr stays off, dispose runs the shutdown hook', async () => {
  let disposed = false;
  const app = await createCordisApp({ onDispose: () => { disposed = true; } });
  assert.equal(app.loaderReady, true);
  const withLoader = app.root as unknown as { loader?: { builtins: Record<string, unknown> } };
  assert.ok(withLoader.loader, 'the loader service is on the tree'); assert.ok(withLoader.loader.builtins.group, 'the cordis:group builtin is registered (D80③)');
  assert.equal(app.hmrActive, false, 'no --expose-internals + PIHER_HMR → hmr is not mounted (zero watchers)');
  assert.equal(typeof detectExposeInternals(), 'boolean');
  assert.equal(detectExposeInternals(), process.execArgv.includes('--expose-internals'), 'the flag is read from the current execArgv');
  await app.root.fiber.dispose();
  assert.equal(disposed, true, 'onDispose runs on tree teardown (session_shutdown path)');
});

test('production mount uses loader.create only when HMR is active', () => {
  assert.match(master, /loaderReady && cordisApp\.hmrActive/); assert.match(master, /loadEntry\(sessionRoot, useLoader,/);
});

test('prepare links node_modules/.bin/piher-setup so in-repo npx finds the CLI', () => {
  const r = spawnSync(process.execPath, [join(root, 'install.mjs'), '--prepare'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.ok(existsSync(join(root, 'node_modules', '.bin', 'piher-setup')));
});

test('installer CLI: version --json and --help', () => {
  const cli = join(root, 'install.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /piher-setup version/);
  assert.match(help.stdout, /piher-setup update/);
  const ver = spawnSync(process.execPath, [cli, 'version', '--json'], { encoding: 'utf8' });
  assert.equal(ver.status, 0, ver.stderr);
  const data = JSON.parse(ver.stdout);
  assert.equal(data.installer.name, 'piher-setup'); assert.ok(data.installer.version);
  assert.ok('piExt' in data && 'core' in data && 'latest' in data);
  assert.ok(!('herdr' in data), 'TUI plugin status is gone');
  assert.ok(typeof data.core === 'object' && data.core !== null && 'version' in data.core && 'app' in data.core);
});

/* The npx cache `npx piher-setup` runs from holds install.mjs + package.json and never
 * packages/ext. The guards below replay a real CLI run against exactly that layout with
 * pi / hc / npm faked at the process boundary, so the contract is observed through the
 * installer's effects (exit code, the commands it shells out to) instead of
 * being locked to the installer's source text. */

/** Fake CLI on PATH: records its argv in the call log, then decides its own stdout / exit code. */
function fakeCli(name: string, dirs: { bin: string; fake: string; log: string }, decide: string): void {
  const script = join(dirs.fake, `${name}.cjs`);
  writeFileSync(script, [
    "const { appendFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(dirs.log)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + '\\n');`,
    decide,
  ].join('\n') + '\n');
  if (process.platform === 'win32') {
    // npm global bins are .cmd shims on win32; the installer already spawns them through cmd.exe.
    writeFileSync(join(dirs.bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = join(dirs.bin, name);
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
}

interface NpxLayoutProbe {
  /** Copy of install.mjs, alone in a cache-shaped dir (install.mjs + package.json, no packages/). */
  installerDir: string;
  /** The pi-installed piher entry the version report resolves — never the cache path above. */
  extEntry: string;
  /** The throwaway PI_CODING_AGENT_DIR (its settings.json lists pi's registered packages). */
  agentDir: string;
  /** Every command the installer shelled out to, in order. */
  calls(): string[][];
  run(...argv: string[]): { status: number | null; stdout: string; stderr: string };
}

/** `hcVersion: null` fakes an installed-but-unusable `hc`; the default is a healthy 0.1.16. */
interface NpxLayoutProbeOptions {
  hcVersion?: string | null;
}

/** PI_CODING_AGENT_DIR keeps the real ~/.pi out of the run; fakes keep networks out of it. */
function npxLayoutProbe(cleanup: CleanupContext, opts: NpxLayoutProbeOptions = {}): NpxLayoutProbe {
  const dir = cleanup.tempDir('piher-npx-').path;
  const installerDir = join(dir, 'installer');
  const agentDir = join(dir, 'pi-agent');
  const binDir = join(dir, 'bin');
  const fakeDir = join(dir, 'fakes');
  const logFile = join(dir, 'calls.jsonl');
  const extPkg = join(agentDir, 'npm', 'node_modules', 'piher');
  const extEntry = join(extPkg, 'src', 'index.ts');

  for (const d of [installerDir, binDir, fakeDir, dirname(extEntry)]) mkdirSync(d, { recursive: true });
  copyFileSync(join(root, 'install.mjs'), join(installerDir, 'install.mjs'));
  writeFileSync(join(installerDir, 'package.json'), JSON.stringify({ name: 'piher-setup', version: '1.0.0' }));
  writeFileSync(join(extPkg, 'package.json'), JSON.stringify({ name: 'piher', version: '1.0.0' }));
  writeFileSync(extEntry, 'export default {};\n');

  fakeCli('pi', { bin: binDir, fake: fakeDir, log: logFile }, "if (args[0] === '--version') console.log('1.4.0');");
  const hcDecide = opts.hcVersion === null
    ? 'process.exit(1);'
    : `if (args[0] === '--version') console.log('${opts.hcVersion ?? '0.1.16'}');`;
  fakeCli('hc', { bin: binDir, fake: fakeDir, log: logFile }, hcDecide);
  fakeCli('npm', { bin: binDir, fake: fakeDir, log: logFile }, "console.log('1.0.0');");

  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'; // win32 spells it Path
  env[pathKey] = `${binDir}${delimiter}${env[pathKey] ?? ''}`;
  const cli = join(installerDir, 'install.mjs');

  return {
    installerDir, extEntry, agentDir,
    calls: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    run: (...argv) => spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env }),
  };
}

test('npx user-mode install never needs the repo layout: install.mjs alone registers the extension', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  const r = probe.run('install');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = probe.calls();
  assert.ok(calls.some((c) => c.join(' ') === 'pi install npm:piher'), `expected \`pi install npm:piher\`, got ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter((c) => c.some((a) => a.includes(probe.installerDir))), [], 'the npx cache path must never reach pi');
}));

test('version --json reports the core preflight without TUI plugin state', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  const r = probe.run('version', '--json');
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.core.version, '0.1.16');
  assert.ok(!('herdr' in data), 'no plugin status in the report');
}));

test('installer dies with the core install hint when hc is missing or unusable', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup, { hcVersion: null });
  const r = probe.run('install');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /herdr-core \(hc\) ≥ 0\.1\.16 required/);
  assert.match(r.stderr, /curl -fsSL https:\/\/releases\.herdr\.dev\/core\/install\.sh \| sh/);
  assert.deepEqual(probe.calls().filter((c) => c[0] === 'pi' && c[1] !== '--version'), [], 'nothing is installed when the core preflight fails');
}));


test('update refreshes the install in place: `pi update` runs and nothing is removed first', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  const r = probe.run('update');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = probe.calls();
  assert.ok(calls.some((c) => c.join(' ') === 'pi update npm:piher'), `expected \`pi update npm:piher\`, got ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter((c) => c.some((a) => a === 'remove' || a === 'uninstall')), [], 'update must not uninstall before updating');
}));

test('a piher registration from another source is reported as-is and blocks a second registration', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  const checkout = cleanup.tempDir('piher-checkout-').path;
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'piher', version: '9.9.9' }));
  const settings = join(probe.agentDir, 'settings.json');
  // pi stores a local install relative to the agent dir.
  writeFileSync(settings, JSON.stringify({ packages: ['npm:pi-web-access', relative(probe.agentDir, checkout)] }));

  const status = JSON.parse(probe.run('version', '--json').stdout);
  assert.equal(status.piExt.spec, `local:${checkout}`);
  assert.equal(status.piExt.version, '9.9.9');

  const refused = probe.run('install');
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`pi remove ${checkout}`), refused.stderr);
  assert.deepEqual(probe.calls().filter((c) => c[0] === 'pi' && c[1] !== '--version'), [], 'nothing is installed on a conflict');

  // The same package at another version is the install target itself, not a conflict.
  writeFileSync(settings, JSON.stringify({ packages: ['npm:piher@0.4.1'] }));
  assert.equal(probe.run('install').status, 0);
}));
