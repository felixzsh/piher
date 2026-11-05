/** Process-level integration: the cordis boot path and the installer CLI. These spawn real node
 *  processes and read install.mjs itself, so they live in the integral tier (see AGENTS.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCordisApp, detectExposeInternals } from '../../src/bootstrap.ts';
import { withCleanup, type CleanupContext } from '../test-utils.ts';

/* ── boot and installer guards: starting piher outside a dev checkout ─────── */
// Production must not loader.create() .ts files unless HMR is active (Node cannot strip types under
// node_modules; the loader path exists for dev HMR only), and the installer CLI must stay runnable
// from an npx cache (no repo checkout).
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const master = readFileSync(fileURLToPath(new URL('../../src/index-master.ts', import.meta.url)), 'utf8');

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
