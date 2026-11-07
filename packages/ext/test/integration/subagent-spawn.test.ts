/** Spawn domain: readiness failures, the spawn tool (piped prompt injection, off-turn settlement,
 * rollback) and the injectable git adapter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CoreClientLike } from '../../src/core-client.ts';
import { pipeNameFor, startPipeServer, type PipeRequest } from '../../src/pipe-channel.ts';
import { readTaskRecord, repoTasksDir } from '../../src/task-store.ts';
import type { SubagentPortBox } from '../../src/subagent-core.ts';
import { NodeGitAdapter, createSpawner, type GitExecFile } from '../../src/subagent-spawn.ts';
import {
  TempHome, fakeCore, fakeWatch, fire, jsonl, mountSubagent, readTaskView, runSubagent, runSubagentRejects,
  seedTaskDocuments, terminalInfo, transcriptMessage, type FakePi,
} from '../test-utils.ts';

/* ── readiness failures ─────────────────────────────────────────── */

const spawnerFor = (client: Partial<CoreClientLike>, over: Record<string, unknown> = {}) => createSpawner({
  client: fakeCore(client),
  env: { socketPath: '/tmp/hc-test.sock', terminalId: 't0' },
  runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
  git: { listWorktrees: async () => [] },
  ...over,
} as Parameters<typeof createSpawner>[0]);

test('waitSubReady: a gone terminal and a live-but-unregistered one are distinguished', async (t) => {
  await t.test('a gone terminal fails fast with its last output instead of waiting out the timeout', async () => {
    const spawner = spawnerFor({
      getTerminal: async () => null,
      read: async () => ({ text: 'TypeError: boom at footer.render', complete: true }),
    });
    const started = Date.now();
    const out = await spawner.waitSubReady('/tmp/piher-a14-nonexistent', 'tA14');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.message, /exited before its pipe became ready/);
    assert.match(out.message, /TypeError: boom at footer\.render/);
    assert.ok(Date.now() - started < 10_000, 'a gone terminal must not wait for the readiness timeout');
  });

  await t.test('a live terminal that never opened its pipe is alive-but-not-ready, not gone', async () => {
    const terminalId = 'tH';
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'unknown' }),
      read: async () => ({ text: 'booting', complete: true }),
    }, { readinessTimeoutMs: 50 });
    const out = await spawner.waitSubReady('/tmp/piher-unknown-shell', terminalId);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.message, /pipe not ready within/);
    assert.match(out.message, /never registered its pipe/, 'a live terminal means "still booting", not "gone"');
  });
});

/* ── spawn tool: loopback pipe harness ──────────────────────────── */

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = 'Read-only survey: in the apnv3-backend repository, map where channel fees are touched. Write the full report.';

interface PipeEnv {
  cwd: string;
  home: TempHome;
  pi: FakePi;
  port: SubagentPortBox;
  frames: PipeRequest[];
  /** Terminals retired after a failed spawn (kill), in call order. */
  retired: string[];
  /** env blocks handed to `terminal.run` in spawn order. */
  spawnEnvs: Array<Record<string, string>>;
  /** `herdr.*` label blocks handed to `terminal.run` in spawn order. */
  spawnLabels: Array<Record<string, string>>;
  /** Report the worker's terminal as gone, as housekeeping would have reclaimed it. */
  paneGone: boolean;
  /** How many pipe connections die before one is served: a reclaimed pane's socket, then the revived one. */
  deadPipes: number;
  /** Uncancellable poll loop: make the children watch's `changed` never resolve, so a row it holds
   *  stays `running` for the rest of the test. */
  parkPollers(): void;
  /** Flipped per subtest: the next prompt frame is answered with an error. */
  rejectPrompt: boolean;
  /** Milliseconds every pipe answer is delayed: a spawn must not wait for the child. */
  pipeDelayMs: number;
  /** Simulate a master restart: dispose the session, mount fresh, and restore from the documents. */
  remount?: (reason: string) => Promise<void>;
}

/** Mounts the plugin with a loopback pipe server standing in for the worker pane (p2): it records
 * the frames piher sends and answers ok, so the real `pipeRequestTo` path is exercised end to end.
 * `paneSeq` hands out p2, p3, … (one pipe server per id) for multi-worker tests. */
async function withPipeEnv(
  fn: (env: PipeEnv) => Promise<void>,
  opts: { childCwd?: string; paneSeq?: boolean; gitRepo?: boolean; sessionFile?: string | ((cwd: string) => string) } = {},
): Promise<void> {
  const home = new TempHome('piher-spawn-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-spawn-cwd-'));
  // The task directory lives inside the repository, so a main checkout needs a `.git`. The
  // `gitRepo: false` case is the "not inside a git repository" one: no tasks at all.
  if (opts.gitRepo !== false) mkdirSync(join(cwd, '.git'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  let parked = false;
  const env: PipeEnv = {
    cwd, home, pi: undefined as never, port: undefined as never, frames: [], retired: [], spawnEnvs: [], spawnLabels: [],
    parkPollers: () => { parked = true; }, rejectPrompt: false, pipeDelayMs: 0, paneGone: false, deadPipes: 0,
  };
  let paneCounter = 0;
  const nextPaneId = (): string => (opts.paneSeq ? `p${2 + paneCounter++}` : 'p2');
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const ensureServer = (paneId: string): void => {
    const server = startPipeServer(pipeNameFor(opts.childCwd ?? cwd, paneId), async (req) => {
      if (env.pipeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, env.pipeDelayMs));
      const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
      if (isPrompt) {
        env.frames.push(req);
        writeFileSync(sessionFile, jsonl(transcriptMessage('assistant', SUB_TEXT, Date.now())));
        if (env.rejectPrompt) return { type: 'error', id: req.id, message: 'sim rejected' };
      }
      return { type: 'ok', id: req.id };
    });
    servers.push(server);
    server.on('connection', (sock) => {
      // A reclaimed pane's pipe dies mid-request: the client must fall back to liveness, not hang.
      if (env.deadPipes > 0) {
        env.deadPipes -= 1;
        sock.destroy();
        return;
      }
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.unref();
  };
  ensureServer('p2');
  if (opts.paneSeq) { ensureServer('p3'); ensureServer('p4'); }
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.once('listening', resolve))));
  const clientOpts: Partial<CoreClientLike> = {
    getTerminal: async (id: string) => env.paneGone ? null : terminalInfo({
      id,
      labels: ['p2', 'p3', 'p4'].includes(id) ? { 'piher.session': sessionFile } : {},
    }),
    // The poller parks on the children watch: while parked, `changed` never resolves and the
    // snapshot reports the worker as working, so the row stays running with no polling.
    watchChildren: () => fakeWatch({
      terminals: () => ['p2', 'p3', 'p4'].map((id) => terminalInfo({
        id,
        status: parked ? 'working' : 'idle',
        labels: { 'piher.session': sessionFile },
      })),
      park: () => (parked ? new Promise<never>(() => {}) : false),
    }),
    read: async () => ({ text: '', complete: true }),
    run: async (o) => {
      env.spawnEnvs.push(o.env ?? {});
      env.spawnLabels.push(o.labels ?? {});
      return terminalInfo({ id: nextPaneId(), cwd: o.cwd, labels: o.labels });
    },
    kill: async (id) => { env.retired.push(id); },
  };
  let root: { fiber: { dispose(): Promise<unknown> } } | null = null;
  const sessionPath = typeof opts.sessionFile === 'function' ? opts.sessionFile(cwd) : opts.sessionFile ?? null;
  const mount = async (): Promise<void> => {
    const mounted = await mountSubagent({
      client: clientOpts,
      ...(sessionPath ? { deps: { getSessionFile: () => sessionPath, getCwd: () => cwd } } : {}),
    });
    env.pi = mounted.pi;
    env.port = mounted.port;
    root = mounted.root;
  };
  await mount();
  env.remount = async (reason: string): Promise<void> => {
    await root!.fiber.dispose();
    await mount();
    // The branch is empty on purpose: the restore reads the view and the records, never it.
    await fire(env.pi, 'session_start', { reason }, { sessionManager: { getBranch: () => [] } });
  };
  try {
    await fn(env);
  } finally {
    await root!.fiber.dispose();
    // Destroying the live connections first: a lingering client would keep close() pending forever.
    for (const sock of sockets) sock.destroy();
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    home.dispose();
  }
}
/** The spawn acknowledgement leaves boot (readiness, prompt injection) off the caller's turn. */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('spawn action: an acknowledgement now, the prompt later, the report as a notice', async (t) => {
  await withPipeEnv(async (env) => {
    await t.test('the call returns an acknowledgement without waiting for the child', async () => {
      env.parkPollers(); // no poll loop spinning while the assertions run
      // A child that answers slowly is exactly the case a spawn must not sit through.
      env.pipeDelayMs = 1000;
      const started = Date.now();
      const result = await runSubagent(env.pi, { description: 'probe', prompt: PROMPT }, env.cwd);
      const elapsed = Date.now() - started;
      const text = result.content[0]!.text;
      assert.match(text, /^started subagent [a-z0-9-]+@p2 \(task [0-9a-f-]+, persistent — stays until you close it\)/);
      assert.match(text, /settlement notice/);
      assert.doesNotMatch(text, /REPORT:/, 'the acknowledgement is not the report');
      // The child takes ≥2s to answer here (readiness ping + prompt): a blocking spawn would show it.
      assert.ok(elapsed < 900, `a spawn must not wait for its child (took ${elapsed}ms)`);
      assert.equal(result.details?.paneId, 'p2');

      await waitFor(() => env.frames.length === 1);
      assert.equal(env.frames.length, 1, 'the prompt is injected exactly once, off the caller turn');
      assert.equal((env.frames[0] as { text?: string }).text, PROMPT, 'the whole prompt reaches the worker');
    });

    await t.test('list shows the child while it runs, and the row stays running', async () => {
      env.pipeDelayMs = 0;
      const result = await runSubagent(env.pi, { description: 'long probe', prompt: PROMPT }, env.cwd);
      assert.equal(result.details?.paneId, 'p2');
      assert.equal(result.details?.role, 'task');
      await waitFor(() => env.frames.length === 2);
      const running = env.port.current?.listRunningSubs() ?? [];
      // The harness reuses the pane id across subtests, so the parked first task reads as running
      // too: one row per task, and the new worker is among them.
      assert.deepEqual(running.map((s) => s.description).sort(), ['long probe', 'probe']);
      assert.ok(running.some((s) => s.paneId === 'p2' && s.description === 'long probe'));
      const listed = (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      // The harness panes never report an agent status, so the contract reads `no report` here —
      // the row is still listed as actionable, which is what this subtest proves.
      assert.match(listed, /p2 \[no report/);
      assert.match(listed, /long probe/);
    });

    await t.test('a rejected prompt injection retires the terminal and reports the failed start', async () => {
      env.rejectPrompt = true;
      const text = (await runSubagent(env.pi, { description: 'probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      assert.match(text, /^started subagent/, 'the start is acknowledged before the pipe answers');
      const slug = /started subagent ([a-z0-9-]+)@/.exec(text)![1];
      const failedTaskId = /\(task ([0-9a-f-]+),/.exec(text)![1];
      await waitFor(() => env.retired.length === 1 && env.pi.userSent.length > 0);
      assert.deepEqual(env.retired, ['p2'], 'the failed terminal is killed');
      const notice = env.pi.userSent.at(-1)?.content ?? '';
      assert.match(notice, /failed to start/);
      assert.match(notice, /sim rejected/);
      // Scoped by slug: earlier subtests parked their workers on the same harness pane id.
      assert.ok(!(env.port.current?.listRunningSubs() ?? []).some((s) => s.slug === slug), 'no ghost running row for the failed start');
      assert.ok(!(env.port.current?.listRows() ?? []).some((s) => s.slug === slug), 'the final board no longer lists the failed task');
      assert.equal(readTaskRecord(env.cwd, failedTaskId), null, 'a spawn that never started leaves no record');
    });
  });
});

test('spawn env: the worker gets the spawn contract on top of the caller environment', async () => {
  await withPipeEnv(async (env) => {
    await runSubagent(env.pi, { description: 'probe', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    assert.equal(env.spawnEnvs.length, 1, 'one terminal created for the worker');
    assert.equal('PI_PROGRAM_STATUS' in env.spawnEnvs[0]!, false, 'piher never writes or silences the status source');
    assert.equal(env.spawnEnvs[0]!.PIHER_SUBAGENT, '1');
    // Delegation identity (RFC rfc-delegation-identity §2.1): the worker learns parent/task/role.
    const delegation = JSON.parse(env.spawnEnvs[0]!.PIHER_DELEGATION ?? 'null') as Record<string, unknown>;
    assert.equal(delegation.parentPaneId, 't0', 'parent terminal is the master terminal');
    assert.equal(delegation.description, 'probe');
    assert.equal(typeof delegation.taskId, 'string');
    assert.equal(delegation.role, 'worker-default');
    // A worker opens no pane: no placement label, so the app never adopts it. Its parent is still
    // this terminal, which is what makes the agents view nest it under the master.
    assert.equal('herdr.space' in env.spawnLabels[0]!, false);
    assert.equal('herdr.tab' in env.spawnLabels[0]!, false);
  });
});

test('spawn/send: the reply pipe is scoped by the master session cwd, not the worker cwd', async () => {
  const other = mkdtempSync(join(tmpdir(), 'piher-spawn-other-'));
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'cross-repo task', prompt: PROMPT, cwd: other }, env.cwd);
    assert.match(spawned.content[0]!.text, /^started subagent [a-z0-9-]+@p2 /);
    await waitFor(() => env.frames.length === 1);
    const expected = pipeNameFor(env.cwd, 't0');
    assert.equal((env.frames[0] as { from?: string }).from, expected, 'spawn replies to the master session pipe');
    assert.notEqual((env.frames[0] as { from?: string }).from, pipeNameFor(other, 't0'));

    const sent = await runSubagent(env.pi, { action: 'send', agentId: 'p2', message: 'wrap up and report' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent [a-z0-9-]+@p2/);
    assert.equal((env.frames[1] as { from?: string }).from, expected, 'follow_up replies to the same master pipe');
  }, { childCwd: other });
});

test('send: a settled persistent worker is still reachable', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'hola', prompt: PROMPT }, env.cwd);
    const paneId = spawned.details?.paneId as string;
    // The spawn's own boot (readiness ping + prompt) must be over, so the dead pipe the send meets is
    // the send's, not the boot's.
    await waitFor(() => env.frames.length === 1);
    env.port.current!.consumeReply(paneId, 'REPORT: hola');
    // A persistent worker delivered its result, not its life: the master keeps talking to it.
    const sent = await runSubagent(env.pi, { action: 'send', agentId: paneId, message: 'y ahora otra cosa' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent/);
    // A follow_up re-arms the row: the old consume time must go, or GC and the checkout sweep read a
    // worker with a turn in flight as finished.
    const rearmed = env.port.current!.listRows().find((s) => s.paneId === paneId);
    assert.equal(rearmed?.status, 'running');
    const taskId = spawned.details?.taskId as string;
    assert.equal(readTaskRecord(env.cwd, taskId)?.gen.consumedAt, null, 'the new request clears the settlement time');
    // The combined `slug@paneId` form is what spawn prints, so it is what a master copies back.
    const slug = /started subagent ([a-z0-9-]+)@/.exec(spawned.content[0]!.text)![1];
    const combined = await runSubagent(env.pi, { action: 'send', agentId: `${slug}@${paneId}`, message: 'otra vez' }, env.cwd);
    assert.match(combined.content[0]!.text, /Message sent to subagent/);
  });
});

test('send: a persistent worker whose pane was reclaimed is revived, not refused', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'hola', prompt: PROMPT }, env.cwd);
    const paneId = spawned.details?.paneId as string;
    // The spawn's own boot (readiness ping + prompt) must be over, so the dead pipe the send meets is
    // the send's, not the boot's.
    await waitFor(() => env.frames.length === 1);
    env.port.current!.consumeReply(paneId, 'REPORT: hola');
    // Housekeeping reclaims the pane of a settled worker; the task itself was never closed. The pane's
    // pipe goes with it, which is what a `send` sees first — no liveness RPC answers for it.
    env.paneGone = true;
    env.deadPipes = 1;
    const sent = await runSubagent(env.pi, { action: 'send', agentId: paneId, message: 'sigue aqui' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent/);
    assert.equal(env.spawnEnvs.length, 2, 'a second terminal carries the follow-up on the same session');
  });
});

test('send/resume: short prefixes resolve at four characters and report ambiguity or misses', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'background task', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const fullTaskId = spawned.details?.taskId as string;
    assert.ok(typeof fullTaskId === 'string' && fullTaskId.length >= 8);
    const short8 = fullTaskId.slice(0, 8);
    const short4 = fullTaskId.slice(0, 4);

    const sent8 = await runSubagent(env.pi, { action: 'send', agentId: short8, message: '8-char prefix message' }, env.cwd);
    assert.match(sent8.content[0]!.text, /Message sent to subagent [a-z0-9-]+@p2/);
    assert.equal((env.frames[1] as { text?: string }).text, '8-char prefix message');

    await runSubagent(env.pi, { action: 'send', agentId: short4, message: '4-char prefix message' }, env.cwd);
    assert.equal(env.frames.length, 3);

    assert.match(await runSubagentRejects(env.pi, { action: 'send', agentId: fullTaskId.slice(0, 3), message: 'x' }, env.cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runSubagentRejects(env.pi, { action: 'send', agentId: '00000000', message: 'x' }, env.cwd), /unknown subagent id "00000000"/);

    const live = await runSubagent(env.pi, { action: 'resume', taskId: short8 }, env.cwd);
    assert.match(live.content[0]!.text, /already running as pane/);
    assert.equal(live.details?.taskId, fullTaskId);
    env.port.current?.consumeReply('p2', 'done');
    const resumed = await runSubagent(env.pi, { action: 'resume', taskId: short8 }, env.cwd);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.equal(resumed.details?.taskId, fullTaskId, 'resume reports the full taskId');
    assert.match(await runSubagentRejects(env.pi, { action: 'resume', taskId: fullTaskId.slice(0, 3) }, env.cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runSubagentRejects(env.pi, { action: 'resume', taskId: 'ffffffff' }, env.cwd), /no history for task "ffffffff"/);

    // A second generation sharing the prefix makes the four-character prefix ambiguous.
    const ambiguousTaskId = `${short4}9999-0000-1111-2222-333344445555`;
    seedTaskDocuments(null, [{
      taskId: ambiguousTaskId, kind: 'task', paneId: 'p3', tabId: 't0', cwd: env.cwd,
      description: 'ambiguous conflict task', sessionFile: null, launchCommand: ['node', 'cli.js'],
      createdAt: Date.now() + 10,
    }]);
    env.port.current?.consumeReply(String(resumed.details?.paneId), 'done');
    const ambiguous = await runSubagentRejects(env.pi, { action: 'resume', taskId: short4 }, env.cwd);
    assert.match(ambiguous, /ambiguous task id/);
    assert.match(ambiguous, new RegExp(fullTaskId));
    assert.match(ambiguous, new RegExp(ambiguousTaskId));
  });
});

test('resume: a task spawned from a linked worktree lives in the repository tasks and resumes from the main checkout', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'piher-resume-wt-'));
  await withPipeEnv(async (env) => {
    env.parkPollers();
    // A linked worktree is a `.git` FILE whose gitdir points into the main checkout and whose
    // commondir names the shared git dir — the repository, never the worktree, owns the tasks.
    const wtGitdir = join(env.cwd, '.git', 'worktrees', 'wt');
    mkdirSync(wtGitdir, { recursive: true });
    writeFileSync(join(wtGitdir, 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitdir}\n`);

    const spawned = await runSubagent(env.pi, { description: 'cross-worktree task', prompt: PROMPT, cwd: wt }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = spawned.details?.taskId as string;
    const paneId = spawned.details?.paneId as string;

    const repoLedger = repoTasksDir(env.cwd)!;
    // The spawn must not wait on the record write (S41 keeps it off the spawn's critical path), so a
    // test that reads the file waits for the write instead of assuming it already landed.
    const spawnedRecord = join(repoLedger, `${taskId}.json`);
    await waitFor(() => existsSync(spawnedRecord));
    assert.deepEqual(
      (JSON.parse(readFileSync(spawnedRecord, 'utf8')) as { rows: Array<{ cwd: string }> }).rows[0]!.cwd,
      wt,
      'the worktree spawn is recorded in the repository tasks',
    );
    assert.equal(repoTasksDir(wt), repoLedger, 'the worktree itself holds no tasks');

    assert.match(await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd).then((r) => r.content[0]!.text), /already running as pane/);
    env.port.current?.consumeReply(paneId, 'done');
    const resumed = await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.equal(resumed.details?.taskId, taskId);
    const row = readTaskRecord(env.cwd, taskId);
    assert.equal(row?.cwd, wt, 'revive keeps the checkout the task was spawned into');

    // A resume asked for from the worktree resolves the same task directory (S41): the miss
    // message names that directory, never one under the worktree or the agent root.
    const miss = await runSubagentRejects(env.pi, { action: 'resume', taskId: 'ffffffff' }, wt);
    assert.ok(miss.includes(repoLedger), `resume from a worktree reads the repository tasks: ${miss}`);
    assert.ok(!miss.includes(join(wt, '.piher')), 'never a task directory under the worktree');
  }, { childCwd: wt });
});

test('admission: resumes waiting for their pipe cannot hold a spawn behind them', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const first = await runSubagent(env.pi, { description: 'task that settles first', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = first.details?.taskId as string;
    env.port.current?.consumeReply(String(first.details?.paneId), 'done');
    const panesBefore = env.spawnLabels.length;

    // Every revive now waits ~400ms for its pane's pipe: a slow boot that DOES finish, so the wait is
    // the only thing the four calls are doing when the spawn arrives. The cap is four, so a cap that
    // covered readiness would leave no slot for the spawn.
    env.pipeDelayMs = 400;
    let finished = 0;
    const resumes = [1, 2, 3, 4].map(() => {
      const call = runSubagent(env.pi, { action: 'resume', taskId }, env.cwd);
      void call.then(() => { finished += 1; }, () => { finished += 1; });
      return call;
    });
    await waitFor(() => env.spawnLabels.length === panesBefore + 4);
    assert.equal(finished, 0, 'all four resumes are past pane creation and waiting for their pipes');

    const started = Date.now();
    const spawn = await runSubagent(env.pi, { description: 'task queued behind it', prompt: PROMPT }, env.cwd);
    const elapsed = Date.now() - started;
    assert.match(spawn.content[0]!.text, /^started subagent/);
    assert.ok(elapsed < 150, `a spawn must not queue behind a resume that waits for readiness (took ${elapsed}ms)`);
    assert.equal(finished, 0, 'the spawn returned while every resume was still waiting for its pipe');

    env.pipeDelayMs = 0;
    for (const resumed of await Promise.all(resumes)) {
      assert.match(resumed.content[0]!.text, /resumed subagent .* from task/);
    }
    await waitFor(() => env.frames.length === 2);
  });
});

test('tasks: a spawn outside a git repository still runs, records nothing and says why', async () => {
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await withPipeEnv(async (env) => {
      env.parkPollers();
      const spawned = await runSubagent(env.pi, { description: 'no-repository task', prompt: PROMPT }, env.cwd);
      await waitFor(() => env.frames.length === 1);
      assert.match(spawned.content[0]!.text, /^started subagent/, 'the spawn is not failed by bookkeeping');
      assert.equal(repoTasksDir(env.cwd), null);
      assert.match(spawned.details?.taskId as string, /^[0-9a-f-]{8,}$/, 'the task exists even with nowhere to record it');
      await waitFor(() => logged.some((l) => /no delegation ledger/.test(l)));
      assert.ok(logged.some((l) => /no delegation ledger/.test(l) && l.includes(env.cwd)), 'one line names the reason');
      const taskId = spawned.details?.taskId as string;
      assert.match(
        await runSubagentRejects(env.pi, { action: 'resume', taskId: 'ffffffff-0000-4111-8222-333333333333' }, env.cwd),
        /resume needs a git repository/,
        `no task directory can answer for ${taskId}`,
      );
    }, { gitRepo: false });
  } finally {
    console.error = origError;
  }
});

test('tasks: a real git worktree resolves to the main checkout (git, not a simulation)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'piher-ledger-real-'));
  const wt = mkdtempSync(join(tmpdir(), 'piher-ledger-real-wt-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', wt, '-b', 'ledger-wt');
    mkdirSync(join(repo, 'packages'));
    assert.equal(repoTasksDir(join(repo, 'packages')), repoTasksDir(repo), 'a subdirectory resolves to its repository');
    assert.equal(repoTasksDir(wt), join(repo, '.piher', 'tasks'), 'the worktree writes the repository tasks');
    assert.equal(repoTasksDir(dirname(repo)), null, 'no tasks above the repository');
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

/* ── git adapter (folded from git-adapter.test.ts) ──────────────── */

test('run: prefixes git -C cwd, forwards the timeout, and the wrappers build their own argv', async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const exec: GitExecFile = async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return { stdout: 'ok\n', stderr: '' };
  };
  const result = await new NodeGitAdapter('git', 1234, exec).run('/repo', ['rev-parse', 'HEAD']);
  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(calls, [{ file: 'git', args: ['-C', '/repo', 'rev-parse', 'HEAD'], timeout: 1234 }]);

  const seen: string[][] = [];
  const git = new NodeGitAdapter('git', 1000, async (_file, args) => { seen.push([...args]); return { stdout: 'out', stderr: '' }; });
  await git.listWorktrees('/wt');
  await git.status('/wt');
  assert.deepEqual(seen[0], ['-C', '/wt', 'worktree', 'list', '--porcelain']);
  assert.deepEqual(seen[1], ['-C', '/wt', 'status', '--short']);
});

const GIT_FAILURES: Array<{ name: string; args: string[]; thrown: () => unknown; expected: RegExp }> = [
  { name: 'Error carrying a code', args: ['status', '--porcelain'], thrown: () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), expected: /^Git status failed: ENOENT/ },
  { name: 'non-Error throw', args: ['diff'], thrown: () => 'boom', expected: /^Git diff failed: boom$/ },
];

test('run: every failure becomes a GitError naming the operation', async () => {
  for (const c of GIT_FAILURES) {
    const exec: GitExecFile = async () => { throw c.thrown(); };
    await assert.rejects(
      () => new NodeGitAdapter('git', 1000, exec).run('/repo', c.args),
      (err: Error) => {
        assert.match(err.message, c.expected, c.name);
        return true;
      },
    );
  }
});

test('slugs: spawn allocates and dedupes; list/send accept slug, slug@paneId, and bare paneId', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const first = await runSubagent(env.pi, { description: 'fix auth flow', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    assert.equal(first.details?.slug, 'fix-auth-flow');
    assert.equal(first.details?.paneId, 'p2');

    const second = await runSubagent(env.pi, { description: 'Fix Auth Flow!', prompt: PROMPT }, env.cwd);
    assert.equal(second.details?.slug, 'fix-auth-flow-2', 'a repeated description gets a numbered slug');
    assert.equal(second.details?.paneId, 'p3');
    // Both spawns inject their prompt off the caller's turn; wait for them before counting frames,
    // or a late boot prompt reads as the follow-up this test is about (spawn is always async).
    await waitFor(() => env.frames.length === 2);

    const listed = await runSubagent(env.pi, { action: 'list' }, env.cwd);
    const text = listed.content[0]!.text as string;
    assert.match(text, /fix-auth-flow@p2/, 'list prints slug@paneId');
    assert.match(text, /fix-auth-flow-2@p3/);

    // Bare slug, combined ref, and bare paneId all resolve to the SAME worker.
    for (const ref of ['fix-auth-flow', `fix-auth-flow@p2`, 'p2']) {
      env.frames.length = 0;
      const sent = await runSubagent(env.pi, { action: 'send', agentId: ref, message: `ping ${ref}` }, env.cwd);
      assert.match(sent.content[0]!.text, /Message sent to subagent fix-auth-flow@p2/, `ref "${ref}" resolves`);
      assert.equal(env.frames.length, 1, `ref "${ref}" reaches exactly one pane`);
      assert.equal((env.frames[0] as { type?: string }).type, 'follow_up', 'a send is a follow-up, not a boot prompt');
      assert.equal((env.frames[0] as { text?: string }).text, `ping ${ref}`);
    }
    // A stale combined ref (revived row changed its paneId) still resolves through the slug part.
    const stale = await runSubagent(
      env.pi, { action: 'send', agentId: 'fix-auth-flow@pOld', message: 'still me' }, env.cwd);
    assert.match(stale.content[0]!.text, /Message sent to subagent fix-auth-flow@p2/);
  }, { paneSeq: true });
});

/* ── P1: TaskRow + the two documents ───────────────────────────── */

test('tasks: a reload restores two workers from the records, and both close by ref', async () => {
  const sessionStamp = '2026-11-07T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000000.jsonl';
  const sessionFor = (cwd: string): string => join(cwd, sessionStamp);
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const sessionFile = sessionFor(env.cwd);
    const spawn = (description: string) =>
      runSubagent(env.pi, { description, prompt: PROMPT }, env.cwd);
    const first = await spawn('reload probe one');
    const second = await spawn('reload probe two');
    await waitFor(() => env.frames.length === 2);
    const ids = [first.details?.taskId, second.details?.taskId] as string[];
    const piBefore = env.pi;

    // A master restart: the branch is empty, so whatever `list` shows comes from the view
    // and the records alone. The old panes are gone with the old session, so core lists nothing.
    await env.remount!('reload');
    env.paneGone = true;
    const text = (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text;
    const refs = text.split('\n').map((line) => line.split(' ')[0]!);
    assert.equal(refs.length, 2, `a reload lists both workers: ${text}`);
    for (const ref of refs) assert.match(ref, /^[a-z0-9-]+@p[0-9]+$/);

    // Both refs close: settle first (a turn in flight is refused), then reclaim.
    for (const ref of refs) {
      const paneId = ref.split('@')[1]!;
      env.port.current!.consumeReply(paneId, 'REPORT: done');
      const closed = await runSubagent(env.pi, { action: 'close', agentId: ref }, env.cwd);
      assert.match(closed.content[0]!.text, /closed — pane and tab gone/);
    }

    // The view references both ids, and each record file holds its row.
    assert.deepEqual(readTaskView(sessionFile), ids);
    for (const [i, taskId] of ids.entries()) {
      const row = readTaskRecord(env.cwd, taskId);
      assert.equal(row?.taskId, taskId);
      assert.equal(row?.description, i === 0 ? 'reload probe one' : 'reload probe two');
      assert.equal(row?.gen.paneId, refs[i]!.split('@')[1]);
      assert.ok(row?.closedAt !== null, 'close wrote the decision into the record');
    }

    // No session entry was appended: the branch is not a document in this model.
    for (const [n, pi] of [piBefore, env.pi].entries()) {
      const subs = pi.entries.some(([type]) => type === 'piher.subs');
      assert.ok(!subs, `mount #${n + 1} appended no piher.subs entry`);
    }
  }, { paneSeq: true, sessionFile: sessionFor });
});

const aStamp = '2026-11-07T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000000.jsonl';

test('ownership: B lists A’s live worker foreign, drops and closes it', async () => {
  // Two mounts share one repository directory with different session files. Foreignness derives
  // from the view alone: a record the view does not name belongs to another session (S10 keeps
  // the durable facts fixed, so no owner field exists to read).
  const bStamp = '2026-11-07T00-00-00-000Z_bbbbbbbb-0000-4000-8000-000000000000.jsonl';
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(
      env.pi, { description: 'shared worker', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = spawned.details?.taskId as string;
    const slug = /started subagent ([a-z0-9-]+)@/.exec(spawned.content[0]!.text)![1];
    const ref = `${slug}@p2`;

    let bMode: 'working' | 'gone' | 'idle' = 'working';
    const bSession = join(env.cwd, bStamp);
    const bKilled: string[] = [];
    const bMount = await mountSubagent({
      client: {
        getTerminal: async (id: string) => bMode === 'gone'
          ? null
          : terminalInfo({ id, state: 'live', status: bMode }),
        kill: async (id: string) => { bKilled.push(`kill:${id}`); },
        remove: async (id: string) => { bKilled.push(`remove:${id}`); },
      },
      deps: { getSessionFile: () => bSession },
    });
    try {
      // B lists A's live worker with the foreign prefix, in the contract's line format.
      const listed = (await runSubagent(bMount.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      const foreignLine = `\\[otra sesión\\] ${slug}@p2 \\[running\\] ` +
        `\\(task · persistent\\) shared worker`;
      assert.match(listed, new RegExp(foreignLine));

      // Once the pane reports gone, B stops listing it: no `no pane` line for foreign rows.
      bMode = 'gone';
      const gone = (await runSubagent(bMount.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      assert.equal(gone, 'No subagents started (from this session view).');

      // B's close writes the decision into A's record and reclaims the pane — no adoption step.
      // The agent is idle, so no turn blocks the close.
      bMode = 'idle';
      const closed = await runSubagent(bMount.pi, { action: 'close', agentId: ref }, env.cwd);
      assert.match(closed.content[0]!.text, /closed — pane and tab gone/);
      assert.deepEqual(bKilled, ['kill:p2', 'remove:p2'], 'the foreign pane is retired');
      const record = readTaskRecord(env.cwd, taskId);
      assert.ok(record?.closedAt !== null, 'the decision lands in A’s record');
      assert.equal(readTaskView(bSession), null, 'no view document grows from foreign rows');

      // A's row is still open in A's memory, but its pane is gone with the old session: every
      // action now derives the finality from the record instead.
      env.paneGone = true;
      env.deadPipes = 100;
      assert.match(
        await runSubagentRejects(env.pi, { action: 'send', agentId: 'p2', message: 'x' }, env.cwd),
        /closed by the master/);
      assert.match(
        await runSubagentRejects(env.pi, { action: 'resume', taskId }, env.cwd),
        /closed by the master/);
      assert.match(
        await runSubagentRejects(env.pi, { action: 'retry', agentId: 'p2' }, env.cwd),
        /closed by the master/);

      // A's next read drops it: the record's decision wins over memory.
      await fire(env.pi, 'session_start', { reason: 'reload' }, {});
      assert.equal(
        (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text,
        'No subagents started (from this session view).');
    } finally {
      await bMount.root.fiber.dispose();
    }
  }, { sessionFile: (cwd) => join(cwd, aStamp) });
});

test('tasks: no transcript path keeps the view in memory, records still land (S25)', async () => {
  // No `sessionFile` option: the host reports no transcript path, so there is no view document —
  // only the in-memory view — while task records still land under the repository.
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(
      env.pi, { description: 'memory-view probe', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = spawned.details?.taskId as string;
    const text = (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text;
    assert.match(text, /memory-view probe/, 'list still shows the worker from the memory view');
    const row = readTaskRecord(env.cwd, taskId);
    assert.equal(row?.taskId, taskId, 'the task record still lands under the repository');
    assert.equal(row?.description, 'memory-view probe');
  });
});
