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
import { appendLedger, ledgerFile } from '../../src/history-store.ts';
import type { SubagentPortBox } from '../../src/subagent-core.ts';
import { NodeGitAdapter, createSpawner, type GitExecFile } from '../../src/subagent-spawn.ts';
import {
  TempHome, fakeCore, fakeWatch, jsonl, mountSubagent, runSubagent, runSubagentRejects, subsSnapshot, terminalInfo, transcriptMessage, type FakePi,
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
  /** Uncancellable poll loop: make the children watch's `changed` never resolve, so a row it holds
   *  stays `running` for the rest of the test. */
  parkPollers(): void;
  /** Flipped per subtest: the next prompt frame is answered with an error. */
  rejectPrompt: boolean;
  /** Milliseconds every pipe answer is delayed: a spawn must not wait for the child. */
  pipeDelayMs: number;
}

/** Mounts the plugin with a loopback pipe server standing in for the worker pane (p2): it records
 * the frames piher sends and answers ok, so the real `pipeRequestTo` path is exercised end to end.
 * `paneSeq` hands out p2, p3, … (one pipe server per id) for multi-worker tests. */
async function withPipeEnv(
  fn: (env: PipeEnv) => Promise<void>,
  opts: { childCwd?: string; paneSeq?: boolean; gitRepo?: boolean } = {},
): Promise<void> {
  const home = new TempHome('piher-spawn-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-spawn-cwd-'));
  // The delegation ledger lives inside the repository, so a main checkout needs a `.git`. The
  // `gitRepo: false` case is the "not inside a git repository" one: no ledger at all.
  if (opts.gitRepo !== false) mkdirSync(join(cwd, '.git'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  let parked = false;
  const env: PipeEnv = {
    cwd, home, pi: undefined as never, port: undefined as never, frames: [], retired: [], spawnEnvs: [], spawnLabels: [],
    parkPollers: () => { parked = true; }, rejectPrompt: false, pipeDelayMs: 0, paneGone: false,
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
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.unref();
  };
  ensureServer('p2');
  if (opts.paneSeq) { ensureServer('p3'); ensureServer('p4'); }
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.once('listening', resolve))));
  const { root, pi, port } = await mountSubagent({
    client: {
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
    },
  });
  env.pi = pi;
  env.port = port;
  try {
    await fn(env);
  } finally {
    await root.fiber.dispose();
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
      assert.deepEqual(running.map((s) => s.paneId), ['p2']);
      assert.equal(running[0]!.description, 'long probe');
      const listed = (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      assert.match(listed, /p2 \[running/);
      assert.match(listed, /long probe/);
    });

    await t.test('a rejected prompt injection retires the terminal and reports the failed start', async () => {
      env.rejectPrompt = true;
      const text = (await runSubagent(env.pi, { description: 'probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      assert.match(text, /^started subagent/, 'the start is acknowledged before the pipe answers');
      await waitFor(() => env.retired.length === 1 && env.pi.userSent.length > 0);
      assert.deepEqual(env.retired, ['p2'], 'the failed terminal is killed');
      const notice = env.pi.userSent.at(-1)?.content ?? '';
      assert.match(notice, /failed to start/);
      assert.match(notice, /sim rejected/);
      assert.ok(!(env.port.current?.listRunningSubs() ?? []).some((s) => s.paneId === 'p2'), 'no ghost running row in the ledger');
      assert.ok(!subsSnapshot(env.pi)?.subs.some((s) => s.paneId === 'p2'), 'the final snapshot no longer lists the pane');
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
    await waitFor(() => env.port.current !== null);
    env.port.current!.consumeReply(paneId, 'REPORT: hola');
    // A persistent worker delivered its result, not its life: the master keeps talking to it.
    const sent = await runSubagent(env.pi, { action: 'send', agentId: paneId, message: 'y ahora otra cosa' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent/);
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
    await waitFor(() => env.port.current !== null);
    env.port.current!.consumeReply(paneId, 'REPORT: hola');
    // Housekeeping reclaims the pane of a settled worker; the task itself was never closed.
    env.paneGone = true;
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
    appendLedger(env.cwd, {
      taskId: ambiguousTaskId, kind: 'task', paneId: 'p3', tabId: 't0', workspaceId: 'w1', cwd: env.cwd,
      description: 'ambiguous conflict task', sessionFile: null, launchCommand: ['node', 'cli.js'],
      status: 'settled', createdAt: Date.now() + 10,
    });
    env.port.current?.consumeReply(String(resumed.details?.paneId), 'done');
    const ambiguous = await runSubagentRejects(env.pi, { action: 'resume', taskId: short4 }, env.cwd);
    assert.match(ambiguous, /ambiguous task id/);
    assert.match(ambiguous, new RegExp(fullTaskId));
    assert.match(ambiguous, new RegExp(ambiguousTaskId));
  });
});

test('resume: a task spawned from a linked worktree lives in the repository ledger and resumes from the main checkout', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'piher-resume-wt-'));
  await withPipeEnv(async (env) => {
    env.parkPollers();
    // A linked worktree is a `.git` FILE whose gitdir points into the main checkout and whose
    // commondir names the shared git dir — the repository, never the worktree, owns the ledger.
    const wtGitdir = join(env.cwd, '.git', 'worktrees', 'wt');
    mkdirSync(wtGitdir, { recursive: true });
    writeFileSync(join(wtGitdir, 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitdir}\n`);

    const spawned = await runSubagent(env.pi, { description: 'cross-worktree task', prompt: PROMPT, cwd: wt }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = spawned.details?.taskId as string;
    const paneId = spawned.details?.paneId as string;

    const repoLedger = ledgerFile(env.cwd)!;
    // The spawn must not wait on the ledger write (S41 keeps it off the spawn's critical path), so a
    // test that reads the file waits for the append instead of assuming it already landed.
    await waitFor(() => existsSync(repoLedger));
    assert.deepEqual(
      JSON.parse(readFileSync(repoLedger, 'utf8').trim().split('\n').at(-1)!).cwd,
      wt,
      'the worktree spawn is recorded in the repository ledger',
    );
    assert.equal(ledgerFile(wt), repoLedger, 'the worktree itself holds no ledger');

    assert.match(await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd).then((r) => r.content[0]!.text), /already running as pane/);
    env.port.current?.consumeReply(paneId, 'done');
    const resumed = await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.equal(resumed.details?.taskId, taskId);
    const row = subsSnapshot(env.pi)?.subs.find((s) => s.taskId === taskId);
    assert.equal(row?.cwd, wt, 'revive keeps the checkout the task was spawned into');

    // A resume asked for from the worktree resolves the same repository ledger (S41): the miss
    // message names that file, never a directory under the worktree or the agent root.
    const miss = await runSubagentRejects(env.pi, { action: 'resume', taskId: 'ffffffff' }, wt);
    assert.ok(miss.includes(repoLedger), `resume from a worktree reads the repository ledger: ${miss}`);
    assert.ok(!miss.includes(join(wt, '.piher')), 'never a ledger under the worktree');
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

test('ledger: a spawn outside a git repository still runs, records nothing and says why', async () => {
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await withPipeEnv(async (env) => {
      env.parkPollers();
      const spawned = await runSubagent(env.pi, { description: 'no-repository task', prompt: PROMPT }, env.cwd);
      await waitFor(() => env.frames.length === 1);
      assert.match(spawned.content[0]!.text, /^started subagent/, 'the spawn is not failed by bookkeeping');
      assert.equal(ledgerFile(env.cwd), null);
      assert.match(spawned.details?.taskId as string, /^[0-9a-f-]{8,}$/, 'the task exists even with nowhere to record it');
      await waitFor(() => logged.some((l) => /no delegation ledger/.test(l)));
      assert.ok(logged.some((l) => /no delegation ledger/.test(l) && l.includes(env.cwd)), 'one line names the reason');
      const taskId = spawned.details?.taskId as string;
      assert.match(
        await runSubagentRejects(env.pi, { action: 'resume', taskId: 'ffffffff-0000-4111-8222-333333333333' }, env.cwd),
        /resume needs a git repository/,
        `the ledger cannot answer for ${taskId}`,
      );
    }, { gitRepo: false });
  } finally {
    console.error = origError;
  }
});

test('ledger: a real git worktree resolves to the main checkout (git, not a simulation)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'piher-ledger-real-'));
  const wt = mkdtempSync(join(tmpdir(), 'piher-ledger-real-wt-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', wt, '-b', 'ledger-wt');
    mkdirSync(join(repo, 'packages'));
    assert.equal(ledgerFile(join(repo, 'packages')), ledgerFile(repo), 'a subdirectory resolves to its repository');
    assert.equal(ledgerFile(wt), join(repo, '.piher', 'history', 'history.jsonl'), 'the worktree writes the repository ledger');
    assert.equal(ledgerFile(dirname(repo)), null, 'no ledger above the repository');
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
    const stale = await runSubagent(env.pi, { action: 'send', agentId: 'fix-auth-flow@pOld', message: 'still me' }, env.cwd);
    assert.match(stale.content[0]!.text, /Message sent to subagent fix-auth-flow@p2/);
  }, { paneSeq: true });
});
