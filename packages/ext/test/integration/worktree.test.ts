/** S71: a spawn may ask for its own checkout, `close` returns what piher created, and `resume` decides
 *  by existence. The git side runs against a real repository, so a branch or a dirty file is observed
 *  rather than modelled. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ledgerFile } from '../../src/history-store.ts';
import { pipeNameFor, startPipeServer } from '../../src/pipe-channel.ts';
import type { SubagentPortBox } from '../../src/subagent-core.ts';
import { HerdrAppSpaceIo, NodeCheckoutIo, parsePorcelain } from '../../src/worktree-io.ts';
import {
  checkoutAckLine,
  dirtyCheckoutText,
  ensureCheckout,
  missingCheckoutText,
  planWorktree,
  reconcileCheckouts,
  reconcileLines,
  releaseCheckout,
  slugifyWorktree,
  type CheckoutIo,
  type ReconcileRow,
  type SpaceIo,
  type WorktreeIo,
} from '../../src/worktree.ts';
import {
  TempHome, fakeWatch, fire, mountSubagent, runSubagent, runSubagentRejects, terminalInfo, type FakePi,
} from '../test-utils.ts';

/* ── planners ───────────────────────────────────────────────────── */

const PLAN = planWorktree({ name: 'probe', repoRoot: '/repos/piher', home: '/home/u' });
const plan = (() => {
  if (PLAN.kind !== 'ok') throw new Error(PLAN.text);
  return PLAN.plan;
})();
const PATH = join('/home/u', '.herdr', 'worktrees', 'piher', 'probe');

test('planWorktree: the name is the branch, the slug is the directory, and neither is a path', () => {
  assert.equal(plan.branch, 'probe');
  assert.equal(plan.slug, 'probe');
  assert.equal(plan.path, PATH);
  assert.equal(planWorktree({ name: ' probe ', repoRoot: '/repos/piher/', home: '/home/u' }).kind, 'ok');

  // The directory is the name made path-safe; the branch is the name untouched — and a slash is a
  // valid branch character, which is exactly how the two can differ.
  const slashed = planWorktree({ name: 'feat/Probe', repoRoot: '/repos/piher', home: '/home/u' });
  assert.equal(slashed.kind, 'ok');
  if (slashed.kind === 'ok') {
    assert.equal(slashed.plan.branch, 'feat/Probe');
    assert.equal(slashed.plan.slug, 'feat-Probe');
    assert.equal(slashed.plan.path, join('/home/u', '.herdr', 'worktrees', 'piher', 'feat-Probe'));
  }
  assert.equal(slugifyWorktree('a -- b__c.d'), 'a----b__c.d');
  assert.equal(slugifyWorktree('  -x-  '), 'x');

  // A path is refused; a branch name git likes is not this function's call.
  for (const name of ['', '  ', '~/.herdr/worktrees/probe', '/tmp/x', '../x', 'a\\b', '-flag', 'a@{b']) {
    const out = planWorktree({ name, repoRoot: '/repos/piher', home: '/home/u' });
    assert.equal(out.kind, 'error', `"${name}" must be refused`);
    if (out.kind !== 'error') continue;
    assert.match(out.text, name.trim() ? /is a name, not a path/ : /needs a name/);
  }
  // A name with nothing path-safe in it is refused instead of landing on the repo directory.
  const nonAscii = planWorktree({ name: '\u63a2\u9488', repoRoot: '/repos/piher', home: '/home/u' });
  assert.equal(nonAscii.kind, 'error');
  if (nonAscii.kind === 'error') assert.match(nonAscii.text, /no letters, digits, dot, dash or underscore/);
});

test('texts: a dirty refusal names the files, a missing checkout names branch and the command back', () => {
  const dirty = dirtyCheckoutText({ path: PATH, branch: 'probe' }, [' M src/a.ts', '?? b.ts']);
  assert.match(dirty, /uncommitted changes/);
  assert.match(dirty, /M src\/a\.ts, \?\? b\.ts/);
  assert.match(dirty, /branch probe survives/);
  const many = dirtyCheckoutText({ path: PATH, branch: 'probe' }, Array.from({ length: 11 }, (_, i) => `f${i}`));
  assert.match(many, /… 3 more/);

  const missing = missingCheckoutText({ taskId: 't1', cwd: PATH, worktree: { path: PATH, branch: 'probe', spaceId: null } });
  assert.match(missing, /worktree .*probe is gone/);
  assert.match(missing, new RegExp(`git worktree add ${PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} probe`));
  assert.match(missingCheckoutText({ taskId: 't2', cwd: '/gone' }), /its cwd \/gone is gone/);

  const ack = checkoutAckLine({ path: PATH, branch: 'probe', spaceId: 'sp7' }, 'created');
  assert.match(ack, new RegExp(PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ack, /branch probe, created the worktree, space sp7/);
  assert.match(checkoutAckLine({ path: PATH, branch: 'probe', spaceId: null }, 'reused'), /reusing the existing worktree, no app space/);
});

/* ── git porcelain ──────────────────────────────────────────────── */

test('parsePorcelain: paths and the branch each worktree holds, detached included', () => {
  const trees = parsePorcelain([
    'worktree /repos/piher',
    'HEAD 1234567890abcdef',
    'branch refs/heads/main',
    '',
    'worktree /home/u/.herdr/worktrees/piher/probe',
    'HEAD abcdef',
    'branch refs/heads/probe',
    '',
    'worktree /tmp/detached',
    'HEAD 999',
    'detached',
  ].join('\n'));
  assert.equal(trees.get('/repos/piher'), 'main');
  assert.equal(trees.get('/home/u/.herdr/worktrees/piher/probe'), 'probe');
  assert.equal(trees.get('/tmp/detached'), null);
});

/* ── real git: create, reuse, occupy, remove ────────────────────── */

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'piher-wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'piher test']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  return dir;
}

const branches = (repo: string): string[] =>
  execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);

test('ensureCheckout: created once, reused on the same branch, refused on another branch or a plain directory', async () => {
  const repo = gitRepo();
  const home = mkdtempSync(join(tmpdir(), 'piher-wt-home-'));
  const io = new NodeCheckoutIo();
  const planned = planWorktree({ name: 'probe', repoRoot: repo, home });
  assert.equal(planned.kind, 'ok');
  if (planned.kind !== 'ok') return;
  try {
    assert.deepEqual(await ensureCheckout(io, { plan: planned.plan, cwd: repo }), { kind: 'created' });
    assert.ok(existsSync(planned.plan.path), 'the worktree is on disk');
    assert.ok(branches(repo).includes('probe'), 'the branch was created');
    assert.equal(
      execFileSync('git', ['-C', planned.plan.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      'probe',
    );
    // Idempotent: the same name reuses the checkout it already made.
    assert.deepEqual(await ensureCheckout(io, { plan: planned.plan, cwd: repo }), { kind: 'reused' });

    // A second name that wants the occupied path is refused, naming path and branch.
    const occupied = await ensureCheckout(io, { plan: { path: planned.plan.path, branch: 'other', slug: 'other' }, cwd: repo });
    assert.equal(occupied.kind, 'error');
    if (occupied.kind === 'error') {
      assert.match(occupied.text, /already a worktree of another branch \(probe\)/);
      assert.match(occupied.text, /branch other/);
    }

    // A directory that git knows nothing about is never touched.
    const stray = join(home, 'stray');
    mkdirSync(stray, { recursive: true });
    const strayOut = await ensureCheckout(io, { plan: { path: stray, branch: 'stray', slug: 'stray' }, cwd: repo });
    assert.equal(strayOut.kind, 'error');
    if (strayOut.kind === 'error') assert.match(strayOut.text, /exists but is not a worktree/);

    // release: the space goes first, then the worktree; the branch survives.
    const closed: string[] = [];
    const space: SpaceIo = {
      create: async () => ({ spaceId: 'sp1' }),
      close: async (id) => { closed.push(id); return null; },
    };
    const record = { path: planned.plan.path, branch: 'probe', spaceId: 'sp1' };
    assert.deepEqual(await releaseCheckout({ checkout: io, space }, record), { ok: true, removed: true, spaceError: null });
    assert.deepEqual(closed, ['sp1']);
    assert.equal(existsSync(planned.plan.path), false);
    assert.ok(branches(repo).includes('probe'), 'the branch survives the worktree');

    // A dirty checkout is refused before anything is destroyed.
    assert.deepEqual(await ensureCheckout(io, { plan: planned.plan, cwd: repo }), { kind: 'created' });
    writeFileSync(join(planned.plan.path, 'uncommitted.txt'), 'x\n');
    const refused = await releaseCheckout({ checkout: io, space }, { ...record, spaceId: 'sp2' });
    assert.equal(refused.ok, false);
    if (refused.ok === false) assert.match(refused.text, /uncommitted\.txt/);
    assert.ok(existsSync(planned.plan.path), 'a dirty worktree stays');
    assert.deepEqual(closed, ['sp1'], 'the space is not closed on a refusal');

    // A space the app could not close still costs only the space.
    rmSync(join(planned.plan.path, 'uncommitted.txt'));
    const noSpace: SpaceIo = { create: async () => null, close: async () => 'herdr-app exited 3 without answering' };
    const released = await releaseCheckout({ checkout: io, space: noSpace }, { ...record, spaceId: 'sp3' });
    assert.deepEqual(released, { ok: true, removed: true, spaceError: 'herdr-app exited 3 without answering' });
    assert.equal(existsSync(planned.plan.path), false, 'the checkout is removed anyway');

    // A checkout a human already removed is not an error: only the space is left to close.
    const spaceIds: string[] = [];
    const again = await releaseCheckout({
      checkout: io,
      space: { create: async () => null, close: async (id) => { spaceIds.push(id); return null; } },
    }, record);
    assert.deepEqual(again, { ok: true, removed: false, spaceError: null });
    assert.deepEqual(spaceIds, ['sp1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureCheckout: a failed git add is reported with its own words, not a thrown spawn', async () => {
  const checkout: CheckoutIo = {
    worktrees: async () => new Map(),
    validBranch: async () => true,
    branchExists: async () => false,
    add: async () => { throw new Error('fatal: invalid reference: HEAD'); },
    head: async () => null,
    dirtyFiles: async () => [],
    remove: async () => {},
    exists: async () => false,
  };
  const out = await ensureCheckout(checkout, { plan, cwd: '/repos/piher' });
  assert.equal(out.kind, 'error');
  if (out.kind === 'error') assert.match(out.text, /could not create the checkout .*invalid reference: HEAD/);
});

test('ensureCheckout: git decides what a branch name may be, and a slash is allowed', async () => {
  const repo = gitRepo();
  const home = mkdtempSync(join(tmpdir(), 'piher-wt-home-'));
  const io = new NodeCheckoutIo();
  try {
    // A space cannot name a branch: git says so, and the message names the name, not git's argv.
    const spaced = planWorktree({ name: 'Probe two', repoRoot: repo, home });
    assert.equal(spaced.kind, 'ok', 'the shape check passes; only git can refuse a space');
    if (spaced.kind === 'ok') {
      const out = await ensureCheckout(io, { plan: spaced.plan, cwd: repo });
      assert.equal(out.kind, 'error');
      if (out.kind === 'error') {
        assert.match(out.text, /"Probe two" is not a valid branch name/);
        assert.match(out.text, /git refuses it/);
      }
      assert.equal(existsSync(spaced.plan.path), false, 'nothing is created for a refused name');
    }

    // A slash is a branch character, so the checkout is made and the directory is the slug.
    const slashed = planWorktree({ name: 'feat/algo', repoRoot: repo, home });
    assert.equal(slashed.kind, 'ok');
    if (slashed.kind !== 'ok') return;
    assert.deepEqual(await ensureCheckout(io, { plan: slashed.plan, cwd: repo }), { kind: 'created' });
    assert.ok(existsSync(slashed.plan.path));
    assert.equal(basename(slashed.plan.path), 'feat-algo');
    assert.ok(branches(repo).includes('feat/algo'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── herdr-app adapter ──────────────────────────────────────────── */

/** What `execFile` rejects with: the exit code, and whatever the process wrote before it exited. */
function execFileError(over: { code?: number | string | null; stdout?: string; killed?: boolean } = {}): Error {
  return Object.assign(new Error('Command failed: herdr-app'), { stdout: '', stderr: '', ...over });
}

test('HerdrAppSpaceIo: space.new names the space, returns focus, and a dead window is a null', async () => {
  const home = mkdtempSync(join(tmpdir(), 'piher-wt-app-'));
  const calls: string[][] = [];
  let mode: 'ok' | 'gone' | 'failed' | 'down' = 'ok';
  const exec = async (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    if (mode === 'down') throw execFileError({ code: 'ENOENT' });
    // The real shape of "that space is not here": exit 1, and the answer on stdout.
    if (mode === 'gone') throw execFileError({ code: 1, stdout: JSON.stringify({ error: 'no space "sp9"' }) });
    if (mode === 'failed') throw execFileError({ code: 1, stdout: JSON.stringify({ error: 'space "sp9" is busy' }) });
    return { stdout: JSON.stringify({ space: 'sp9', tab: 'tb9', terminal: 't9/1' }), stderr: '' };
  };
  const space = new HerdrAppSpaceIo('herdr-app', 1000, exec as never, home);
  try {
    // No `.active` file: there is nowhere to return to, and that is not a failure.
    assert.deepEqual(await space.create('probe', PATH), { spaceId: 'sp9' });
    assert.deepEqual(calls, [['do', 'space.new', '--folder', PATH, '--name', 'probe']]);

    // The app activates the space it makes, so the person is put back where they were.
    mkdirSync(join(home, '.herdr', 'space-ids'), { recursive: true });
    writeFileSync(join(home, '.herdr', 'space-ids', '.active'), 'sp1\n');
    calls.length = 0;
    assert.deepEqual(await space.create('probe', PATH), { spaceId: 'sp9' });
    assert.deepEqual(calls, [
      ['do', 'space.new', '--folder', PATH, '--name', 'probe'],
      ['do', 'space.select', '--id', 'sp1'],
    ]);

    calls.length = 0;
    assert.equal(await space.close('sp9'), null);
    assert.deepEqual(calls, [['do', 'space.close', '--id', 'sp9', '--confirmed', 'true']]);
    // P16: a space that is already gone answers exit 1 and `no space …` — nothing left to close, so
    // it is a success, or an idempotent sweep would re-alarm on every start.
    mode = 'gone';
    assert.equal(await space.close('sp9'), null);
    // A different error is still an error, body or no body.
    mode = 'failed';
    assert.equal(await space.close('sp9'), 'space "sp9" is busy');
    // Real silence names its cause: no binary, a timeout, or a bare non-zero exit.
    mode = 'down';
    assert.equal(await space.create('probe', PATH), null);
    assert.equal(await space.close('sp9'), 'herdr-app is not installed — no `herdr-app` on PATH');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('HerdrAppSpaceIo: silence names the cause — no binary, a timeout, a bare non-zero exit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'piher-wt-app-'));
  let failure: Error = execFileError();
  const exec = async () => { throw failure; };
  const space = new HerdrAppSpaceIo('herdr-app', 1000, exec as never, home);
  try {
    failure = Object.assign(new Error('spawn herdr-app ENOENT'), { code: 'ENOENT' });
    assert.match(String(await space.close('sp1')), /is not installed — no `herdr-app` on PATH/);

    failure = execFileError({ code: null, killed: true, stdout: '' });
    assert.match(String(await space.close('sp1')), /did not answer within 1000 ms/);

    failure = execFileError({ code: 3 });
    assert.match(String(await space.close('sp1')), /exited 3 without answering/);

    // Output that is not JSON is not an answer either: the cause is still the exit code.
    failure = execFileError({ code: 1, stdout: 'Error: permission denied\n' });
    assert.match(String(await space.close('sp1')), /exited 1 without answering/);

    // A silence is never a success: the row keeps its id for the next attempt.
    assert.notEqual(await space.close('sp1'), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── reconciliation at session_start (S72) ─────────────────────── */

/** The repository's ledger rows, in file order. */
function ledgerRows(repo: string): Array<Record<string, unknown>> {
  const file = ledgerFile(repo);
  if (file === null || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function checkoutRecord(path: string, branch: string, spaceId: string | null) {
  return { path, branch, spaceId };
}

/** A `WorktreeIo` whose existence answer comes from a list, recording every space it closes. */
function reconcileFakes(opts: { present?: readonly string[]; closeError?: string | null } = {}) {
  const present = new Set(opts.present ?? []);
  const closed: string[] = [];
  const checked: string[] = [];
  const checkout: CheckoutIo = {
    worktrees: async () => new Map(),
    validBranch: async () => true,
    branchExists: async () => false,
    add: async () => {},
    head: async () => null,
    dirtyFiles: async () => [],
    remove: async () => {},
    exists: async (path) => { checked.push(path); return present.has(path); },
  };
  const space: SpaceIo = {
    create: async () => null,
    close: async (id) => { closed.push(id); return opts.closeError ?? null; },
  };
  return { io: { checkout, space }, closed, checked };
}

test('reconcileCheckouts: a gone checkout closes its recorded space exactly once', async () => {
  const f = reconcileFakes();
  // Append-only ledger: three rows for one task, one checkout, one space.
  const outcomes = await reconcileCheckouts(f.io, [
    { taskId: 't1', status: 'running', worktree: checkoutRecord(PATH, 'probe', 'sp1') },
    { taskId: 't1', status: 'settled', worktree: checkoutRecord(PATH, 'probe', 'sp1') },
    { taskId: 't1', status: 'running', worktree: checkoutRecord(PATH, 'probe', 'sp1') },
  ]);
  assert.deepEqual(f.closed, ['sp1'], 'closed once, not once per row');
  assert.deepEqual(f.checked, [PATH], 'the existence of the recorded path is the whole test');
  assert.equal(outcomes.length, 1);
  const first = outcomes[0];
  assert.equal(first?.kind, 'closed');
  if (first?.kind !== 'closed') return;
  assert.equal(first.spaceId, 'sp1');
  assert.equal(first.spaceError, null);
  const pathPattern = PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(reconcileLines(outcomes)[0]!, new RegExp(`${pathPattern}.*is gone; closed its space sp1`));

  // A path still on disk is a checkout in use: nothing is closed and nothing is said.
  const live = reconcileFakes({ present: [PATH] });
  const liveRow = { taskId: 't2', status: 'running', worktree: checkoutRecord(PATH, 'probe', 'sp2') };
  assert.deepEqual(await reconcileCheckouts(live.io, [liveRow]), []);
  assert.deepEqual(live.closed, []);

  // A ledger with nothing of piher's in it never reaches the app at all.
  const quiet = reconcileFakes();
  assert.deepEqual(await reconcileCheckouts(quiet.io, []), []);
  assert.deepEqual(await reconcileCheckouts(quiet.io, [
    { taskId: 't3', status: 'running', cwd: '/gone/elsewhere' } as unknown as ReconcileRow,
  ]), []);
  assert.deepEqual([...quiet.checked, ...quiet.closed], [], 'a row piher did not write is never touched');
});

test('reconcileCheckouts: a space that cannot be closed is reported; no id names nothing', async () => {
  // Unreachable app: the outcome carries the failure instead of throwing it.
  const down = reconcileFakes({ closeError: 'herdr-app exited 1 without answering' });
  const unreachable = await reconcileCheckouts(down.io, [
    { taskId: 't4', status: 'running', worktree: checkoutRecord(PATH, 'probe', 'sp4') },
  ]);
  assert.deepEqual(down.closed, ['sp4']);
  assert.deepEqual(unreachable, [{
    kind: 'closed',
    row: { taskId: 't4', status: 'running', worktree: checkoutRecord(PATH, 'probe', 'sp4') },
    record: checkoutRecord(PATH, 'probe', 'sp4'),
    spaceId: 'sp4',
    spaceError: 'herdr-app exited 1 without answering',
  }]);
  assert.match(reconcileLines(unreachable)[0]!, /is gone; space sp4 was not closed \(herdr-app/);

  // The process died between the two writes: a running row with a checkout and no id.
  const gapIo = reconcileFakes();
  const gap = await reconcileCheckouts(gapIo.io, [
    { taskId: 't5', status: 'running', worktree: checkoutRecord(PATH, 'probe', null) },
  ]);
  assert.deepEqual(gapIo.closed, [], 'there is no id to close');
  assert.equal(gap.length, 1);
  assert.equal(gap[0]?.kind, 'unnamed');
  assert.match(reconcileLines(gap)[0]!, /without a space id/);
  assert.match(reconcileLines(gap)[0]!, /check the app's spaces by hand/);

  // A row piher itself closed out (close, one-shot reclaim, a failed spawn) is a space already gone.
  for (const status of ['closed', 'settled', 'consumed']) {
    assert.deepEqual(await reconcileCheckouts(gapIo.io, [
      { taskId: 't6', status, worktree: checkoutRecord(PATH, 'probe', null) },
    ]), [], `${status} with no id is not a gap`);
  }
  assert.deepEqual(gapIo.closed, []);
});

/* ── the tool: spawn/close/resume/one-shot ──────────────────────── */

interface WtHarness {
  repo: string;
  home: string;
  pi: FakePi;
  port: SubagentPortBox;
  /** `herdr.*` labels handed to `terminal.run`, in spawn order. */
  labels: Array<Record<string, string>>;
  retired: string[];
  /** S72: the ledger as it stood each time the spawn asked the app for a space. */
  ledgerAtCreate: Array<Array<Record<string, unknown>>>;
  spaces: { created: Array<{ name: string; folder: string }>; closed: string[]; failCreate: boolean; closeError: string | null };
}

const PROMPT = 'probe the checkout';

async function withHarness(
  fn: (h: WtHarness) => Promise<void>,
  /** Replace the in-memory space adapter, e.g. with the real one over a fake `herdr-app`. */
  opts: { space?: (home: string) => SpaceIo } = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'piher-wt-home-'));
  const repo = gitRepo();
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const tempHome = new TempHome('wt-agent-');
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const repoName = basename(repo);
  /** Every cwd a worker may run in, and the pane ids the fake core hands out. */
  const cwds = [
    join(home, '.herdr', 'worktrees', repoName, 'probe'),
    join(home, '.herdr', 'worktrees', repoName, 'feat-Probe'),
    join(home, '.herdr', 'worktrees', repoName, 'shot'),
    repo,
  ];
  const panes = ['p2', 'p3', 'p4', 'p5'];
  for (const cwd of cwds) {
    for (const paneId of panes) {
      const server = startPipeServer(pipeNameFor(cwd, paneId), async (req) => ({ type: 'ok', id: req.id }));
      servers.push(server);
      server.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });
      server.unref();
    }
  }
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.once('listening', resolve))));

  const spaces: WtHarness['spaces'] = { created: [], closed: [], failCreate: false, closeError: null };
  const ledgerAtCreate: WtHarness['ledgerAtCreate'] = [];
  const labels: Array<Record<string, string>> = [];
  const retired: string[] = [];
  let paneIndex = 0;
  const io: WorktreeIo = {
    checkout: new NodeCheckoutIo(),
    space: opts.space ? opts.space(home) : {
      create: async (name, folder) => {
        if (spaces.failCreate) return null;
        ledgerAtCreate.push(ledgerRows(repo));
        spaces.created.push({ name, folder });
        return { spaceId: `sp${spaces.created.length}` };
      },
      close: async (id) => {
        if (spaces.closeError) return spaces.closeError;
        spaces.closed.push(id);
        return null;
      },
    },
  };
  const { root, pi, port } = await mountSubagent({
    deps: { worktreeIo: io },
    client: {
      getTerminal: async (id: string) => terminalInfo({ id }),
      // Parked forever: an unparked fake watch makes the poll loop spin on microtasks.
      watchChildren: () => fakeWatch({ terminals: () => [], park: () => new Promise<boolean>(() => {}) }),
      run: async (o) => {
        labels.push({ ...o.labels });
        return terminalInfo({ id: panes[paneIndex++] ?? 'p9', cwd: o.cwd, labels: o.labels });
      },
      kill: async (id) => { retired.push(id); },
    },
  });
  try {
    await fn({ repo, home, pi, port, labels, retired, spaces, ledgerAtCreate });
  } finally {
    await root.fiber.dispose();
    for (const sock of sockets) sock.destroy();
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    tempHome.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const checkoutPath = (h: WtHarness, name: string): string =>
  join(h.home, '.herdr', 'worktrees', basename(h.repo), slugifyWorktree(name));

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('spawn worktree: one name makes the checkout and its space, and says both back', async () => {
  await withHarness(async (h) => {
    const result = await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'probe' }, h.repo);
    const text = result.content[0]!.text;
    const path = checkoutPath(h, 'probe');
    assert.match(text, /^started subagent [a-z0-9-]+@p2 \(task [0-9a-f-]+\) in worktree /);
    assert.ok(text.includes(path), `the reply names the checkout: ${text}`);
    assert.match(text, /branch probe, created the worktree, space sp1/);
    assert.equal(result.details?.worktree !== undefined, true, 'the answer carries the record');
    // The checkout is real, on its own branch, and the app was asked for a space that shows it.
    assert.ok(existsSync(join(path, 'README.md')));
    assert.deepEqual(h.spaces.created, [{ name: 'probe', folder: path }]);
    assert.equal(h.labels[0]!['herdr.space'], 'sp1', 'the worker is placed in that space');
    assert.equal('herdr.tab' in h.labels[0]!, false, 'no tab label of the master leaks into the new space');

    // The ledger rows carry the record resume and close depend on: one with no space id before the app
    // is asked, then the id itself.
    await waitFor(() => ledgerRows(h.repo).some((r) => r.via === 'spawn'));
    const rows = ledgerRows(h.repo);
    const forPath = rows.filter((r) => (r.worktree as { path?: string } | undefined)?.path === path);
    const ids = forPath.map((r) => (r.worktree as { spaceId: string | null }).spaceId);
    assert.deepEqual(ids.slice(0, 2), [null, 'sp1'], 'no id before the app was asked, then the id');
    // The `null` is the row the ordering rule requires; from the moment the id lands, every row
    // about this checkout carries it, or resume/close/sweep would read the wrong row and see
    // no space to close.
    const afterId = ids.slice(1);
    assert.equal(afterId.every((id) => id === 'sp1'), true, 'no row after the id loses it');
    assert.deepEqual(forPath.at(-1)!.worktree, { path, branch: 'probe', spaceId: 'sp1' });

    // Repeating the same name reuses it instead of failing on the occupied path.
    const again = await runSubagent(h.pi, { description: 'probe again', prompt: PROMPT, worktree: 'probe' }, h.repo);
    assert.match(again.content[0]!.text, /reusing the existing worktree/);
    assert.match(again.content[0]!.text, /space sp2/, 'a second space still shows the second worker');
    assert.equal(h.spaces.created.length, 2);

    // The directory is the slug; the branch keeps the name as given, slash included.
    const slashed = await runSubagent(h.pi, { description: 'slashed name', prompt: PROMPT, worktree: 'feat/Probe' }, h.repo);
    const slashedText = slashed.content[0]!.text;
    const slashedPath = join(h.home, '.herdr', 'worktrees', basename(h.repo), 'feat-Probe');
    assert.ok(slashedText.includes(slashedPath), `the reply names the slugged checkout: ${slashedText}`);
    assert.match(slashedText, /branch feat\/Probe/);
    assert.ok(branches(h.repo).includes('feat/Probe'), 'the branch is the name, untouched');
    assert.ok(existsSync(join(slashedPath, 'README.md')));
  });
});

test('spawn worktree: cwd together with worktree is refused, naming which one to use', async () => {
  await withHarness(async (h) => {
    const text = await runSubagentRejects(h.pi, { description: 'x', prompt: PROMPT, worktree: 'probe', cwd: h.repo }, h.repo);
    assert.match(text, /`cwd` and `worktree` are mutually exclusive/);
    assert.match(text, /pass `worktree: "<name>"` and no `cwd`, or `cwd` and no `worktree`/);
    assert.equal(h.spaces.created.length, 0, 'nothing is created for a refused call');
    assert.equal(h.labels.length, 0);
    assert.equal(existsSync(checkoutPath(h, 'probe')), false);
  });
});

test('spawn worktree: an unreachable app costs the space, never the checkout', async () => {
  await withHarness(async (h) => {
    h.spaces.failCreate = true;
    const text = (await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'probe' }, h.repo)).content[0]!.text;
    assert.match(text, /no app space \(herdr-app was unreachable; the checkout still works\)/);
    assert.ok(existsSync(checkoutPath(h, 'probe')));
    assert.equal(h.labels[0]!['herdr.space'], 'sp0', 'without a space the worker keeps the master placement');
    assert.equal(h.labels[0]!['herdr.tab'], 'tbpiher-probe', 'and gets the tab of its worktree zone');
  });
});

test('close: the space and the worktree go, the branch survives; a dirty checkout is refused', async () => {
  await withHarness(async (h) => {
    const spawn = await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'probe' }, h.repo);
    const paneId = spawn.details?.paneId as string;
    const path = checkoutPath(h, 'probe');
    await waitFor(() => h.port.current !== null);
    h.port.current!.consumeReply(paneId, 'REPORT: done');

    writeFileSync(join(path, 'uncommitted.txt'), 'x\n');
    const refused = await runSubagentRejects(h.pi, { action: 'close', agentId: paneId }, h.repo);
    assert.match(refused, /uncommitted\.txt/);
    assert.match(refused, /branch probe survives/);
    assert.deepEqual(h.spaces.closed, [], 'a refusal leaves the space alone');
    assert.ok(existsSync(path), 'a refusal leaves the worktree alone');

    rmSync(join(path, 'uncommitted.txt'));
    const closed = (await runSubagent(h.pi, { action: 'close', agentId: paneId }, h.repo)).content[0]!.text;
    assert.deepEqual(h.spaces.closed, ['sp1']);
    assert.match(closed, /worktree .*probe removed/);
    assert.match(closed, /space sp1 closed/);
    assert.match(closed, /branch probe survives/);
    assert.equal(existsSync(path), false);
    assert.ok(branches(h.repo).includes('probe'), 'close never deletes the branch');
    assert.ok(h.retired.includes(paneId), 'the pane is retired');

    // resume decides by existence: the checkout is gone, so the refusal carries the way back.
    const resumed = await runSubagentRejects(h.pi, { action: 'resume', taskId: spawn.details?.taskId as string }, h.repo);
    assert.match(resumed, new RegExp(`git worktree add ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} probe`));
    assert.match(resumed, /branch probe survives/);
  });
});

test('resume: a worker in a plain cwd still revives after close', async () => {
  await withHarness(async (h) => {
    const spawn = await runSubagent(h.pi, { description: 'plain run', prompt: PROMPT, cwd: h.repo }, h.repo);
    const paneId = spawn.details?.paneId as string;
    await waitFor(() => h.port.current !== null);
    h.port.current!.consumeReply(paneId, 'REPORT: done');
    await runSubagent(h.pi, { action: 'close', agentId: paneId }, h.repo);
    const resumed = await runSubagent(h.pi, { action: 'resume', taskId: spawn.details?.taskId as string }, h.repo);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.notEqual(resumed.details?.paneId, paneId, 'a fresh pane holds the revived session');
  });
});

test('one-shot: its settlement reclaims the checkout it was spawned into', async () => {
  await withHarness(async (h) => {
    mkdirSync(join(h.repo, '.piher', 'roles'), { recursive: true });
    writeFileSync(
      join(h.repo, '.piher', 'roles', 'sweeper.json'),
      JSON.stringify({ role: 'sweeper', version: '1.0.0', lifecycle: 'one-shot', manifest: { tools: ['bash'] } }),
    );
    const spawn = await runSubagent(h.pi, { description: 'sweep run', prompt: PROMPT, role: 'sweeper', worktree: 'shot' }, h.repo);
    const paneId = spawn.details?.paneId as string;
    const path = checkoutPath(h, 'shot');
    assert.ok(existsSync(path), 'the one-shot got its checkout');
    await waitFor(() => h.port.current !== null);
    h.port.current!.consumeReply(paneId, 'REPORT: swept');
    await waitFor(() => !existsSync(path));
    assert.equal(existsSync(path), false, 'a one-shot leaves nothing to clean up');
    assert.deepEqual(h.spaces.closed, ['sp1']);
    assert.ok(branches(h.repo).includes('shot'), 'the branch survives');

    // S72: the reclaim records that the space went with the checkout, so a later start finds nothing.
    await waitFor(() => ledgerRows(h.repo).some((r) => r.via === 'one-shot-reclaim'));
    const reclaimed = ledgerRows(h.repo).filter((r) => r.via === 'one-shot-reclaim').at(-1)!;
    assert.deepEqual(reclaimed.worktree, { path, branch: 'shot', spaceId: null });
    assert.notEqual(reclaimed.status, 'running');
  });
});

/* ── the silent pass at session_start (S72) ─────────────────────── */

/** A ledger row as piher writes it, with the fields this pass reads. */
function ledgerRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: 'task-seed',
    kind: 'task',
    paneId: 'p7',
    tabId: 'tb',
    workspaceId: '',
    cwd: '/repos/piher',
    description: 'seeded run',
    sessionFile: null,
    launchCommand: [],
    status: 'running',
    createdAt: 1,
    ...over,
  };
}

function seedLedger(repo: string, rows: ReadonlyArray<Record<string, unknown>>): void {
  const file = ledgerFile(repo)!;
  mkdirSync(join(repo, '.piher', 'history'), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('session_start: a gone checkout closes its space once, and a clean start says nothing', async () => {
  await withHarness(async (h) => {
    const repoName = basename(h.repo);
    const gone = join(h.home, '.herdr', 'worktrees', repoName, 'gone');
    const goneRow = ledgerRow({
      taskId: 't-gone',
      cwd: gone,
      worktree: { path: gone, branch: 'gone', spaceId: 'spG' },
    });
    seedLedger(h.repo, [
      goneRow,
      // A checkout still on disk: its space stays, whatever the branch is called.
      ledgerRow({ taskId: 't-live', cwd: h.repo, worktree: { path: h.repo, branch: 'main', spaceId: 'spLive' } }),
      // A row piher did not write: no `worktree`, so not its business.
      ledgerRow({ taskId: 't-other', cwd: '/somewhere/gone' }),
    ]);

    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    assert.deepEqual(h.spaces.closed, ['spG'], 'exactly the recorded id, exactly once');
    const said = h.pi.userSent.map((m) => m.content).join('\n');
    assert.match(said, /is gone; closed its space spG/);
    assert.equal(/spLive/.test(said), false, 'a checkout in use is not reported');
    assert.equal(/t-other/.test(said), false, 'a row piher did not write is not reported');
    // The row is closed out in the shape `close` writes, so the next start has nothing to do.
    const closedOut = ledgerRows(h.repo).at(-1)!;
    assert.equal(closedOut.taskId, 't-gone');
    assert.equal(closedOut.status, 'closed');
    assert.deepEqual(closedOut.worktree, { path: gone, branch: 'gone', spaceId: null });

    const before = h.pi.userSent.length;
    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    assert.deepEqual(h.spaces.closed, ['spG'], 'nothing is closed a second time');
    assert.equal(h.pi.userSent.length, before, 'a start with nothing to do prints nothing');
  });
});

test('session_start: an unreachable app is reported and never fails or blocks the start', async () => {
  await withHarness(async (h) => {
    const gone = join(h.home, '.herdr', 'worktrees', basename(h.repo), 'gone');
    seedLedger(h.repo, [ledgerRow({
      taskId: 't-gone',
      cwd: gone,
      worktree: { path: gone, branch: 'gone', spaceId: 'spG' },
    })]);
    h.spaces.closeError = 'herdr-app is not installed — no `herdr-app` on PATH';
    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    const said = h.pi.userSent.map((m) => m.content).join('\n');
    assert.match(said, /space spG was not closed \(herdr-app is not installed/);
    // The id survives for the next attempt instead of being recorded as ended.
    assert.equal(ledgerRows(h.repo).length, 1);
  });
});

test('session_start: a space the app says is already gone is closed for good, and a second start asks nothing', async () => {
  const asked: string[][] = [];
  await withHarness(async (h) => {
    const gone = join(h.home, '.herdr', 'worktrees', basename(h.repo), 'gone');
    seedLedger(h.repo, [ledgerRow({
      taskId: 't-gone',
      cwd: gone,
      worktree: { path: gone, branch: 'gone', spaceId: 'spG' },
    })]);

    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    assert.deepEqual(asked.map((args) => args.join(' ')), ['do space.close --id spG --confirmed true'], 'the recorded id, once');
    const said = h.pi.userSent.map((m) => m.content).join('\n');
    assert.match(said, /is gone; closed its space spG/);
    assert.equal(/was not closed/.test(said), false, 'nothing left to close is not a failure');
    // The row is marked, so the id is never asked for again.
    const closedOut = ledgerRows(h.repo).at(-1)!;
    assert.equal(closedOut.taskId, 't-gone');
    assert.equal(closedOut.status, 'closed');
    assert.deepEqual(closedOut.worktree, { path: gone, branch: 'gone', spaceId: null });

    const before = h.pi.userSent.length;
    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    assert.equal(asked.length, 1, 'a closed space is not asked about a second time');
    assert.equal(h.pi.userSent.length, before, 'and the second start prints nothing');
  }, {
    // The real adapter over the app's real answer for a space that no longer exists.
    space: () => new HerdrAppSpaceIo('herdr-app', 1000, (async (_file: string, args: readonly string[]) => {
      asked.push([...args]);
      throw execFileError({ code: 1, stdout: JSON.stringify({ error: 'no space "spG"' }) });
    }) as never),
  });
});

test('session_start: a ledger with no checkout of piher\'s never reaches the app', async () => {
  await withHarness(async (h) => {
    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    seedLedger(h.repo, [ledgerRow({ taskId: 't-plain', cwd: h.repo })]);
    await fire(h.pi, 'session_start', {}, { cwd: h.repo });
    assert.deepEqual(h.spaces.closed, []);
    assert.deepEqual(h.spaces.created, []);
    assert.deepEqual(h.pi.userSent, [], 'silent when there is nothing to do');
    assert.equal(ledgerRows(h.repo).length, 1, 'nothing was appended either');
  });
});

test('spawn worktree: the row is written before the space is asked for', async () => {
  await withHarness(async (h) => {
    const path = checkoutPath(h, 'probe');
    await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'probe' }, h.repo);
    // What the ledger held at the moment `space.new` was called: the checkout, and no id yet.
    const atCreate = h.ledgerAtCreate[0] ?? [];
    assert.equal(atCreate.length, 1, 'one row existed while the space was being made');
    assert.deepEqual(atCreate[0]!.worktree, { path, branch: 'probe', spaceId: null });
    assert.equal(atCreate[0]!.status, 'running');
    // Then the id, as soon as the app answered.
    await waitFor(() => ledgerRows(h.repo).some((r) => r.via === 'spawn-space'));
    const ids = ledgerRows(h.repo)
      .filter((r) => (r.worktree as { path?: string } | undefined)?.path === path)
      .map((r) => (r.worktree as { spaceId: string | null }).spaceId);
    assert.deepEqual(ids.slice(0, 2), [null, 'sp1']);
  });
});
