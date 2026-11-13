/** S71: a spawn may ask for its own checkout, `close` returns what piher created, and `resume` decides
 *  by existence. The git side runs against a real repository, so a branch or a dirty file is observed
 *  rather than modelled. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listTaskRecords } from '../../src/task-store.ts';
import type { SubagentPortBox } from '../../src/subagent-core.ts';
import { HRESUME_LABEL } from '../../src/subagent-session.ts';
import { NodeCheckoutIo, parsePorcelain } from '../../src/worktree-io.ts';
import {
  checkoutAckLine,
  checkoutSpaceId,
  dirtyCheckoutText,
  ensureCheckout,
  missingCheckoutText,
  planWorktree,
  releaseCheckout,
  slugifyWorktree,
  type CheckoutIo,
} from '../../src/worktree.ts';
import {
  TempHome, fakeWatch, mountSubagent, runSubagent, runSubagentRejects, terminalInfo, type FakePi,
} from '../test-utils.ts';
import type { TerminalInfo } from '../../src/core-client.ts';

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

  const missing = missingCheckoutText({ taskId: 't1', cwd: PATH, worktree: { path: PATH, branch: 'probe' } });
  assert.match(missing, /worktree .*probe is gone/);
  assert.match(missing, new RegExp(`git worktree add ${PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} probe`));
  assert.match(missingCheckoutText({ taskId: 't2', cwd: '/gone' }), /its cwd \/gone is gone/);

  const ack = checkoutAckLine({ path: PATH, branch: 'probe' }, 'created');
  assert.match(ack, new RegExp(PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ack, /branch probe, created the worktree/);
  assert.match(checkoutAckLine({ path: PATH, branch: 'probe' }, 'reused'), /reusing the existing worktree/);
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

    // release: the worktree goes, the branch survives, and nothing talks to the app.
    const record = { path: planned.plan.path, branch: 'probe' };
    assert.deepEqual(await releaseCheckout(io, record), { ok: true, removed: true });
    assert.equal(existsSync(planned.plan.path), false);
    assert.ok(branches(repo).includes('probe'), 'the branch survives the worktree');

    // A dirty checkout is refused before anything is destroyed.
    assert.deepEqual(await ensureCheckout(io, { plan: planned.plan, cwd: repo }), { kind: 'created' });
    writeFileSync(join(planned.plan.path, 'uncommitted.txt'), 'x\n');
    const refused = await releaseCheckout(io, record);
    assert.equal(refused.ok, false);
    if (refused.ok === false) assert.match(refused.text, /uncommitted\.txt/);
    assert.ok(existsSync(planned.plan.path), 'a dirty worktree stays');
    rmSync(join(planned.plan.path, 'uncommitted.txt'));

    // A checkout a human already removed is not an error.
    await releaseCheckout(io, record);
    assert.deepEqual(await releaseCheckout(io, record), { ok: true, removed: false });
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
function taskRows(repo: string): Array<{
  taskId: string; worktree?: { path: string; branch: string }; consumed: boolean;
}> {
  return listTaskRecords(repo).map((row) => ({
    taskId: row.taskId,
    ...(row.worktree ? { worktree: row.worktree } : {}),
    consumed: row.gen.consumedAt !== null,
  }));
}

const PROMPT = 'probe the checkout';

interface WtHarness {
  repo: string;
  home: string;
  pi: FakePi;
  port: SubagentPortBox;
  /** `herdr.*` labels handed to `terminal.run`, in spawn order. */
  labels: Array<Record<string, string>>;
  /** Terminals the fake core lists — the app writes `herdr.tab` back onto a pane it adopted. */
  listed: TerminalInfo[];
  retired: string[];
  /** Spaces the app was asked to close, and a way to make the app unreachable. */
  spaces: { closed: string[]; fail: boolean };
  /** The worker settles the way a real one does: it writes its report document, and the master's own
   *  poll loop reads it. One notice per settlement, and the row is consumed here (spec S6-S8). */
  settle(paneId: string, taskId: string, text: string): Promise<void>;
}

async function withHarness(fn: (h: WtHarness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'piher-wt-home-'));
  const repo = gitRepo();
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const tempHome = new TempHome('wt-agent-');
  const panes = ['p2', 'p3', 'p4', 'p5'];
  /** One fresh transcript per pane: what the worker's own Herdr extension reports in `hresume`, and
   *  therefore the session a resume restores (spec S18). */
  const sessionDir = join(home, 'worker-sessions');
  mkdirSync(sessionDir, { recursive: true });
  const sessionFiles = new Map<string, string>();
  const sessionFor = (paneId: string): string => {
    const existing = sessionFiles.get(paneId);
    if (existing) return existing;
    const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${paneId}.jsonl`);
    writeFileSync(file, '{}\n');
    sessionFiles.set(paneId, file);
    return file;
  };
  /** Parks the poll loop until a test says otherwise: a settlement is what releases it. */
  const gates = new Set<() => void>();
  /** Set by a settlement that lands while the loop is NOT parked, so its next park returns at once
   *  instead of waiting for a wake that already came. */
  let wake = false;
  const releaseGates = (): void => { for (const release of [...gates]) release(); gates.clear(); };

  /** Poll loops that started: the settle boundary only exists once one is reading the pane. */
  let watchCalls = 0;
  const labels: Array<Record<string, string>> = [];
  const listed: TerminalInfo[] = [];
  const retired: string[] = [];
  const spaces: WtHarness['spaces'] = { closed: [], fail: false };
  let paneIndex = 0;
  const { root, pi, port, client } = await mountSubagent({
    deps: {
      // A spawn whose readiness never arrives must fail fast here; the production default is 90 s and
      // this suite used to wait it out, which is why the run needed --test-force-exit to end.
      policy: { readinessTimeoutMs: 3000 },
      checkoutIo: new NodeCheckoutIo(),
      checkoutSpace: {
        close: async (id) => {
          if (spaces.fail) return 'herdr-app did not answer';
          spaces.closed.push(id);
          return null;
        },
      },
    },
    client: {
      // The harness panes report an idle agent — a close must see a finished turn rather than a
      // silent one — and the session their own Herdr extension reports (spec S18).
      getTerminal: async (id: string) => terminalInfo({
        id,
        status: 'idle',
        labels: sessionFiles.has(id)
          ? { [HRESUME_LABEL]: JSON.stringify({ agent: 'pi', session: sessionFor(id), file: sessionFor(id) }) }
          : {},
      }),
      listTerminals: async () => listed,
      // The poll loop parks until a settlement releases it: an unparked fake watch would spin on
      // microtasks, and a worker that says nothing settles nothing.
      watchChildren: () => (watchCalls += 1, fakeWatch({
        terminals: () => [],
        park: () => new Promise<boolean>((resolve) => {
          if (wake) { wake = false; resolve(true); return; }
          gates.add(() => resolve(true));
        }),
      })),
      // S25: the first task is believed by the core's own result, so the harness's worker takes it.
      send: async () => ({ started: true, status: 'working' as const, turn: 1 }),
      run: async (o) => {
        labels.push({ ...o.labels });
        const id = panes[paneIndex++] ?? 'p9';
        sessionFor(id);
        return terminalInfo({ id, cwd: o.cwd, labels: o.labels });
      },
      kill: async (id) => { retired.push(id); },
    },
  });

  /** Writes the worker's report document and lets the master's poll loop read it. */
  const settle = async (paneId: string, taskId: string, text: string): Promise<void> => {
    // The settle boundary is the request the worker took, so the loop must have armed before the
    // document can answer anything (`watchChildren` is the first thing a poll loop does).
    await waitFor(() => watchCalls > 0);
    await client.docSet(`piher.rep.${paneId}`, {
      taskId, turn: 1, stopReason: 'stop', session: sessionFiles.get(paneId) ?? null, text, at: Date.now(),
    }, 0);
    wake = true;
    releaseGates();
    // The row is consumed by the master's loop, not by the test: wait for the fact, not a timer.
    await waitFor(() => taskRows(repo).some((r) => r.taskId === taskId && r.consumed));
  };
  try {
    await fn({ repo, home, pi, port, labels, listed, retired, spaces, settle });
  } finally {
    await root.fiber.dispose();
    releaseGates();
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

test('spawn worktree: one name makes the checkout, and says where it is', async () => {
  await withHarness(async (h) => {
    const result = await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'probe' }, h.repo);
    const text = result.content[0]!.text;
    const path = checkoutPath(h, 'probe');
    assert.match(text, /^started subagent [a-z0-9-]+@p2 \(task [0-9a-f-]+, persistent — stays until you close it\) in worktree /);
    assert.ok(text.includes(path), `the reply names the checkout: ${text}`);
    assert.match(text, /branch probe, created the worktree; open it with the app's Open worktree/);
    assert.equal(result.details?.worktree !== undefined, true, 'the answer carries the record');
    // The checkout is real, on its own branch, and the app was asked for a space that shows it.
    assert.ok(existsSync(join(path, 'README.md')));
    // The app opens the space from this label alone: no app call, and no tab of the master's.
    assert.equal(h.labels[0]!['herdr.space'], checkoutSpaceId(path));
    assert.equal('herdr.tab' in h.labels[0]!, false, 'the app makes the tab inside the space');

    // A second worker on the same checkout joins that tab instead of asking for one of its own: the
    // app wrote the tab id back onto the first pane, and the reviewer sits beside the worker it reads.
    h.listed.push(terminalInfo({
      id: 'p2',
      labels: { ...h.labels[0]!, 'herdr.tab': 'wtTab', [HRESUME_LABEL]: JSON.stringify({ agent: 'pi', session: 'w1', file: '/sessions/a.jsonl' }) },
    }));
    const reviewer = await runSubagent(
      h.pi,
      { description: 'review the probe run', prompt: PROMPT, worktree: 'probe' },
      h.repo,
    );
    assert.match(reviewer.content[0]!.text, /^started subagent [a-z0-9-]+@p3 /);
    assert.equal(h.labels[1]!['herdr.space'], checkoutSpaceId(path), 'still the checkout space');
    assert.equal(h.labels[1]!['herdr.tab'], 'wtTab', "the second worker joins the first one's tab");
    h.listed.length = 0;

    // The task record names the checkout `resume` and `close` depend on.
    const spawnTaskId = result.details?.taskId as string;
    await waitFor(() => taskRows(h.repo).some((r) => r.taskId === spawnTaskId));
    const forPath = taskRows(h.repo).filter((r) => r.worktree?.path === path);
    assert.deepEqual(forPath.at(-1)!.worktree, { path, branch: 'probe' });

    // Repeating the same name reuses it instead of failing on the occupied path.
    const again = await runSubagent(h.pi, { description: 'probe again', prompt: PROMPT, worktree: 'probe' }, h.repo);
    assert.match(again.content[0]!.text, /reusing the existing worktree/);

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
    assert.equal(h.labels.length, 0);
    assert.equal(existsSync(checkoutPath(h, 'probe')), false);
  });
});

test('close: the worktree goes, the branch survives; a dirty checkout is refused', async () => {
  await withHarness(async (h) => {
    const spawn = await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'probe' }, h.repo);
    const paneId = spawn.details?.paneId as string;
    const path = checkoutPath(h, 'probe');
    await waitFor(() => h.port.current !== null);
    await h.settle(paneId, spawn.details?.taskId as string, 'REPORT: done');

    writeFileSync(join(path, 'uncommitted.txt'), 'x\n');
    const refused = await runSubagentRejects(h.pi, { action: 'close', agentId: paneId }, h.repo);
    assert.match(refused, /uncommitted\.txt/);
    assert.match(refused, /branch probe survives/);
    assert.ok(existsSync(path), 'a refusal leaves the worktree alone');

    rmSync(join(path, 'uncommitted.txt'));
    const closed = (await runSubagent(h.pi, { action: 'close', agentId: paneId }, h.repo)).content[0]!.text;
    assert.deepEqual(h.spaces.closed, [checkoutSpaceId(path)], 'the master\'s close ends the window too');
    assert.match(closed, /worktree .*probe removed/);
    assert.match(closed, /branch probe survives/);
    assert.equal(existsSync(path), false);
    assert.ok(branches(h.repo).includes('probe'), 'close never deletes the branch');
    assert.ok(h.retired.includes(paneId), 'the pane is retired');

    // Close is final: resume is refused for what the master already decided, checkout or not.
    const resumed = await runSubagentRejects(h.pi, { action: 'resume', taskId: spawn.details?.taskId as string }, h.repo);
    assert.match(resumed, /closed by the master/);
    assert.match(resumed, /close is final/);
  });
});

test('resume: unfinished work revives; a closed worker is final', async () => {
  await withHarness(async (h) => {
    const spawn = await runSubagent(h.pi, { description: 'plain run', prompt: PROMPT, cwd: h.repo }, h.repo);
    const paneId = spawn.details?.paneId as string;
    const taskId = spawn.details?.taskId as string;
    await waitFor(() => h.port.current !== null);
    // A result that was read is unfinished business for a persistent worker: it stays revivable.
    await h.settle(paneId, taskId, 'REPORT: done');
    const resumed = await runSubagent(h.pi, { action: 'resume', taskId }, h.repo);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.notEqual(resumed.details?.paneId, paneId, 'a fresh pane holds the revived session');

    // Closing is the master's final word: no revival, no follow-up. Close only reclaims a worker
    // that already finished, so the revived one reports first.
    const revivedPane = resumed.details?.paneId as string;
    await waitFor(() => h.port.current !== null);
    await runSubagent(h.pi, { action: 'close', agentId: revivedPane }, h.repo);
    const refusedResume = await runSubagentRejects(h.pi, { action: 'resume', taskId }, h.repo);
    assert.match(refusedResume, /closed by the master/);
    assert.match(refusedResume, /close is final/);
    const refusedSend = await runSubagentRejects(h.pi, { action: 'send', agentId: revivedPane, message: 'more' }, h.repo);
    assert.match(refusedSend, /closed by the master/);
  });
});

test('one-shot: its settlement closes the space and keeps the checkout for the master', async () => {
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
    await h.settle(paneId, spawn.details?.taskId as string, 'REPORT: swept');
    await waitFor(() => h.spaces.closed.length > 0);
    // The window closes; the working tree stays, because the master decides whether to merge.
    assert.deepEqual(h.spaces.closed, [checkoutSpaceId(path)]);
    assert.ok(existsSync(path), 'a one-shot keeps its checkout for review');
    assert.ok(branches(h.repo).includes('shot'), 'the branch survives');

    // The reclaim records the checkout it left behind, so a later close or resume reads the truth.
    const sweptTaskId = spawn.details?.taskId as string;
    await waitFor(() => taskRows(h.repo).some((r) => r.taskId === sweptTaskId && r.consumed));
    const reclaimed = taskRows(h.repo).find((r) => r.taskId === sweptTaskId)!;
    assert.deepEqual(reclaimed.worktree, { path, branch: 'shot' });
    assert.equal(reclaimed.consumed, true);
  });
});

test('one-shot: a checkout still used by another worker keeps its space', async () => {
  await withHarness(async (h) => {
    mkdirSync(join(h.repo, '.piher', 'roles'), { recursive: true });
    writeFileSync(
      join(h.repo, '.piher', 'roles', 'sweeper.json'),
      JSON.stringify({ role: 'sweeper', version: '1.0.0', lifecycle: 'one-shot', manifest: { tools: ['bash'] } }),
    );
    // The worker of the checkout and the reviewer that reads it share one app space.
    const worker = await runSubagent(h.pi, { description: 'sweep run', prompt: PROMPT, worktree: 'shot' }, h.repo);
    const reviewer = await runSubagent(
      h.pi,
      { description: 'sweep review', prompt: PROMPT, role: 'sweeper', worktree: 'shot' },
      h.repo,
    );
    const path = checkoutPath(h, 'shot');
    assert.equal((worker.details?.paneId as string) !== (reviewer.details?.paneId as string), true);
    await waitFor(() => h.port.current !== null);

    await h.settle(reviewer.details?.paneId as string, reviewer.details?.taskId as string, 'REPORT: swept');
    const reviewerTaskId = reviewer.details?.taskId as string;
    await waitFor(() => taskRows(h.repo).some((r) => r.taskId === reviewerTaskId && r.consumed));
    assert.deepEqual(h.spaces.closed, [], 'the worker is still in that space, so its tab stays');
    assert.ok(existsSync(path), 'the checkout stays for the master either way');
  });
});

test('resume: a revived worker goes back to the space its checkout owns', async () => {
  await withHarness(async (h) => {
    const spawn = await runSubagent(h.pi, { description: 'probe run', prompt: PROMPT, worktree: 'shot' }, h.repo);
    const paneId = spawn.details?.paneId as string;
    const taskId = spawn.details?.taskId as string;
    const path = checkoutPath(h, 'shot');
    const space = checkoutSpaceId(path);
    assert.equal(h.labels[0]!['herdr.space'], space, 'the first pane names the checkout space');
    await waitFor(() => h.port.current !== null);
    // Read the result: unfinished business for a persistent worker, so `resume` revives it.
    await h.settle(paneId, taskId, 'REPORT: done');
    h.listed.push(terminalInfo({ id: paneId, labels: { ...h.labels[0]!, 'herdr.tab': 'wtTab' } }));

    const resumed = await runSubagent(h.pi, { action: 'resume', taskId }, h.repo);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    const revived = h.labels.at(-1)!;
    // Without the space label the app adopts the revived pane into the focused space, and the
    // worker reappears in a workspace that is not its checkout's.
    assert.equal(revived['herdr.space'], space, 'the revived pane names the checkout space again');
    assert.equal(revived['herdr.tab'], 'wtTab', 'and joins the tab already there');
  });
});
