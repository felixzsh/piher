/** Spawn domain: readiness failures, the spawn tool (first task through the core, off-turn
 * settlement, rollback) and the injectable git adapter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CoreError, type CoreClientLike, type CoreStatus, type SendResult } from '../../src/core-client.ts';
import type { CommandDocumentValue } from '../../src/command-documents.ts';
import type { RuntimePolicy } from '../../src/runtime-policy.ts';
import { pipeNameFor, pipePathFor, startPipeServer } from '../../src/pipe-channel.ts';
import {
  readTaskRecord, repoTasksDir, taskRecordPath, TASK_VIEW_NAME,
} from '../../src/task-store.ts';
import { sessionStatePath } from '../../src/session-state.ts';
import type { SubagentPortBox } from '../../src/subagent-core.ts';
import type { TaskRow } from '../../src/task-row.ts';
import { BootFailure, NodeGitAdapter, createSpawner, planTaskSend, taskNotStartedText, type GitExecFile } from '../../src/subagent-spawn.ts';
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

test('waitReady/planTaskSend: the core decides readiness, and the turn proves delivery', async (t) => {
  await t.test('a gone terminal fails fast with its last output, and its pane is not kept', async () => {
    const spawner = spawnerFor({
      getTerminal: async () => null,
      read: async () => ({ text: 'TypeError: boom at footer.render', complete: true }),
    });
    const started = Date.now();
    const out = await spawner.waitReady('tA14');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.message, /exited before its agent reported ready/);
    assert.match(out.message, /TypeError: boom at footer\.render/);
    assert.equal(out.keepPane, false, 'nothing is left to keep');
    assert.ok(Date.now() - started < 10_000, 'a gone terminal must not wait for the readiness timeout');
  });

  await t.test('a program that never reports status is handed its task after the grace, not failed', async () => {
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'unknown' }),
      read: async () => ({ text: 'booting', complete: true }),
    }, { readinessTimeoutMs: 400 });
    const started = Date.now();
    const out = await spawner.waitReady('tH');
    assert.equal(out.ok, true, 'PI_PROGRAM_STATUS=0 must not make a worker unreachable');
    assert.ok(Date.now() - started <= 500, 'the grace, not the whole budget');
  });

  await t.test('a pane stuck in a turn of its own for the whole budget fails, keeping its pane', async () => {
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'working' }),
    }, { readinessTimeoutMs: 300 });
    const out = await spawner.waitReady('tW');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.message, /was not ready within/);
    assert.equal(out.keepPane, true, 'a live pane is kept so its output can be read');
  });

  await t.test('an agent blocked on a dialog is reported at once, with advice the kept pane can honour', async () => {
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'blocked' }),
    }, { readinessTimeoutMs: 90_000 });
    const started = Date.now();
    const out = await spawner.waitReady('tB');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.message, /blocked on a dialog/);
    assert.match(out.message, /answer that dialog in the pane, then retry this task/);
    assert.equal(out.keepPane, true);
    assert.ok(Date.now() - started < 2_000, 'no waiting out a budget a person has to answer');
  });

  await t.test('planTaskSend: S25 — `started: true` or a turn that began where none had', () => {
    const facts = (over: Partial<Parameters<typeof planTaskSend>[0]>) => planTaskSend({
      refusedNotIdle: false, started: null, turnBefore: 0, turnAfter: 0, statusAfter: 'idle',
      elapsedMs: 5, timeoutMs: 1000, ...over,
    });
    assert.deepEqual(facts({ started: true }), { kind: 'delivered' });
    // `started: null` proves nothing in either direction (S25): the turn decides.
    assert.deepEqual(facts({ turnAfter: 1 }), { kind: 'delivered' }, 'a new turn is the proof the core could not give');
    assert.deepEqual(facts({ statusAfter: 'working' }), { kind: 'delivered' }, 'a turn in flight is delivery');
    // No turn and no status: the text went in, so only the submit is missing.
    assert.deepEqual(facts({}), { kind: 'resubmit', delayMs: 500 });
    assert.deepEqual(facts({ started: false }), { kind: 'resubmit', delayMs: 500 });
    // A refused `if` gate typed nothing, so a fresh paste cannot duplicate.
    assert.deepEqual(facts({ refusedNotIdle: true }), { kind: 'repaste', delayMs: 500 });
    // No evidence either side (a core that would not answer) is not delivery.
    assert.deepEqual(facts({ turnBefore: null, turnAfter: null }), { kind: 'resubmit', delayMs: 500 });
    assert.deepEqual(facts({ started: false, statusAfter: 'idle' }), { kind: 'resubmit', delayMs: 500 }, 'null-ish alone is not a delivery');
    assert.deepEqual(facts({ elapsedMs: 1000 }), { kind: 'give-up' });
  });

  await t.test('taskNotStartedText promises only what the delivery loop knows', () => {
    const text = taskNotStartedText({
      paneId: 'p2', attempts: 3, elapsedMs: 4_000, last: { started: null, status: 'idle', turn: 0 },
    });
    assert.match(text, /took no turn from its first message after 3 attempts/);
    assert.match(text, /read it with action "output"/);
    assert.match(text, /retry this task or close it/);
    // The loop cannot know whether the core swallowed the text or the composer took it.
    assert.doesNotMatch(text, /holds the text/);
  });

  await t.test('deliverFirstTask: a send that started no turn is submitted, never pasted twice', async () => {
    const pastes: string[] = [];
    const keys: string[][] = [];
    let turn = 0;
    let composer = '';
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', turn }),
      // The measured loss (spec S22): the text lands in the composer and the core's Enter never
      // submits it. A second paste would put the brief in the turn twice.
      send: async (_id, text) => {
        pastes.push(text);
        composer += text;
        return pastes.length === 1 ? { started: null, status: 'idle', turn } : { started: true, status: 'working', turn };
      },
      keys: async (_id, pressed) => {
        keys.push([...pressed]);
        if (pressed.includes('enter') && composer !== '') {
          composer = '';
          turn += 1;
        }
      },
    }, { readinessTimeoutMs: 5_000 });
    await spawner.deliverFirstTask('t2', 'do the thing', { budgetMs: 5_000, statusAtReady: 'idle' });
    assert.deepEqual(pastes, ['do the thing'], 'the brief is pasted once');
    assert.deepEqual(keys, [['enter']], 'the retry submits what the composer already holds');
    assert.equal(turn, 1, 'the turn happened');
  });

  await t.test('deliverFirstTask: a send refused because the agent stopped being idle pastes nothing it can duplicate', async () => {
    let refuse = 1;
    const pastes: string[] = [];
    const gates: Array<string | undefined> = [];
    let turn = 0;
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', turn }),
      send: async (_id, text, opts) => {
        gates.push(opts?.if);
        if (refuse > 0) {
          refuse -= 1;
          // Nothing was typed: the core refused the paste because the status moved in the gap.
          throw new CoreError('terminal.send', 'status_mismatch', 'status is working', null);
        }
        pastes.push(text);
        turn += 1;
        return { started: true, status: 'working', turn };
      },
    }, { readinessTimeoutMs: 5_000 });
    await spawner.deliverFirstTask('t2', 'do the thing', { budgetMs: 5_000, statusAtReady: 'idle' });
    assert.deepEqual(pastes, ['do the thing'], 'one paste: the refused attempt typed nothing');
    assert.equal(gates[0], 'idle', 'the first paste is gated on the status the core sees at that moment');
    assert.equal(turn, 1, 'the turn happened');
  });

  await t.test('deliverFirstTask: a done agent is pasted without the idle gate, and a refusal drops it', async () => {
    let sends = 0;
    let turn = 0;
    const gates: Array<string | undefined> = [];
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'done', turn }),
      send: async (_id, _text, opts) => {
        sends += 1;
        gates.push(opts?.if);
        if (opts?.if === 'idle') throw new CoreError('terminal.send', 'status_mismatch', 'status is done', null);
        turn += 1;
        return { started: true, status: 'working', turn };
      },
    }, { readinessTimeoutMs: 5_000 });
    await spawner.deliverFirstTask('t2', 'x', { budgetMs: 5_000, statusAtReady: 'done' });
    assert.deepEqual(gates, [undefined], 'done has no gate in the core schema, so the paste goes ungated');
    assert.equal(sends, 1);

    // When the gate is on (the normal idle boot) a refusal must not survive as a stuck gate.
    let turn2 = 0;
    let refusals = 0;
    const spawner2 = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', turn: turn2 }),
      send: async (_id, _text, opts) => {
        if (opts?.if === 'idle' && refusals === 0) {
          refusals += 1;
          throw new CoreError('terminal.send', 'status_mismatch', 'status is done', null);
        }
        turn2 += 1;
        return { started: true, status: 'working', turn: turn2 };
      },
    }, { readinessTimeoutMs: 5_000 });
    await spawner2.deliverFirstTask('t2', 'x', { budgetMs: 5_000, statusAtReady: 'idle' });
    assert.equal(refusals, 1, 'one refused gate, then the ungated send landed');
  });

  await t.test('deliverFirstTask: a core that missed the start is believed through the turn, not re-sent', async () => {
    const pastes: string[] = [];
    const keys: string[][] = [];
    let turn = 0;
    const spawner = spawnerFor({
      // The turn went up, and the core still answered `started: null`: nobody can tell, but the turn
      // can. A second paste here would duplicate the brief; a resend would spend the whole budget.
      getTerminal: async (id) => terminalInfo({ id, status: 'done', turn }),
      send: async (_id, text) => {
        pastes.push(text);
        turn += 1;
        return { started: null, status: 'idle', turn: 0 };
      },
      keys: async (_id, pressed) => { keys.push([...pressed]); },
    }, { readinessTimeoutMs: 90_000 });
    const started = Date.now();
    await spawner.deliverFirstTask('t2', 'do the thing', { budgetMs: 90_000, statusAtReady: 'idle' });
    assert.deepEqual(pastes, ['do the thing'], 'one paste');
    assert.deepEqual(keys, [], 'no submit and no second send: the turn proves it');
    assert.ok(Date.now() - started < 5_000, 'the boot does not burn the readiness budget on a turn that ran');
  });

  await t.test('deliverFirstTask: the retries share the caller budget instead of spending a new one', async () => {
    const pastes: string[] = [];
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'idle', turn: 0 }),
      // Never a turn: only the budget can end this, and it is the caller's 500 ms, not a fresh 60 s.
      send: async (_id, text) => { pastes.push(text); return { started: null, status: 'idle', turn: 0 }; },
      keys: async () => {},
    }, { readinessTimeoutMs: 60_000 });
    const started = Date.now();
    await assert.rejects(
      () => spawner.deliverFirstTask('t2', 'x', { budgetMs: 500, statusAtReady: 'idle' }),
      (err: unknown) => err instanceof BootFailure && err.keepPane && /took no turn from its first message/.test(err.message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3_000, `one budget for the whole delivery (took ${elapsed}ms)`);
    assert.equal(pastes.length, 1, 'only the first attempt pastes; the rest submit what is there');
  });

  await t.test('deliverFirstTask: a hard refusal keeps the pane instead of killing it', async () => {
    const spawner = spawnerFor({
      getTerminal: async (id) => terminalInfo({ id, status: 'idle' }),
      send: async () => { throw new CoreError('terminal.send', 'blocked', 'the program is waiting on a dialog', null); },
    }, { readinessTimeoutMs: 2_000 });
    await assert.rejects(
      () => spawner.deliverFirstTask('t2', 'x', { budgetMs: 2_000, statusAtReady: 'idle' }),
      (err: unknown) => err instanceof BootFailure && err.keepPane && /could not take its first message: blocked:/.test(err.message),
    );
  });

  await t.test('deliverFirstTask: a pane that dies mid-delivery is not kept', async () => {
    let probes = 0;
    const spawner = spawnerFor({
      // Alive for the `before` probe, finished from then on: the worker died between readiness and
      // the delivery, so the row must not be kept for a terminal that is not there.
      getTerminal: async (id) => {
        probes += 1;
        return terminalInfo({ id, state: probes > 1 ? 'finished' : 'live', status: 'idle' });
      },
      send: async () => ({ started: null, status: 'idle', turn: 0 }),
      keys: async () => {},
    }, { readinessTimeoutMs: 1_000 });
    await assert.rejects(
      () => spawner.deliverFirstTask('t2', 'x', { budgetMs: 400, statusAtReady: 'idle' }),
      (err: unknown) => err instanceof BootFailure && err.keepPane === false,
    );
  });
});

/* ── spawn tool: loopback pipe harness ──────────────────────────── */

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = 'Read-only survey: in the apnv3-backend repository, map where channel fees are touched. Write the full report.';

/** One task or follow-up as the worker received it, with the channel that carried it: the core's own
 *  `terminal.send` (every first task since P2) or the private pipe (still the follow-up channel until
 *  P3 moves steering to the core). */
interface Delivery {
  channel: 'core' | 'pipe';
  type: string;
  id: string;
  text: string;
  /** The reply pipe a pipe frame named; empty for a core send, where the core knows the caller. */
  from: string;
}

interface PipeEnv {
  cwd: string;
  home: TempHome;
  pi: FakePi;
  port: SubagentPortBox;
  /** Every task and follow-up the worker received, in delivery order, with its channel. */
  frames: Delivery[];
  /** Terminals retired after a failed spawn (kill), in call order. */
  retired: string[];
  /** env blocks handed to `terminal.run` in spawn order. */
  spawnEnvs: Array<Record<string, string>>;
  /** `herdr.*` label blocks handed to `terminal.run` in spawn order. */
  spawnLabels: Array<Record<string, string>>;
  /** Report the worker's terminal as gone, as housekeeping would have reclaimed it. */
  paneGone: boolean;
  /** Report a pane as finished the moment it is created: a child that died before it was ready. */
  paneFinished: boolean;
  /** How many pipe connections die before one is served: a reclaimed pane's socket, then the revived one. */
  deadPipes: number;
  /** Uncancellable poll loop: make the children watch's `changed` never resolve, so a row it holds
   *  stays `running` for the rest of the test. */
  parkPollers(): void;
  /** Flipped per subtest: the core refuses the next send (a blocked program, say). */
  rejectSend: boolean;
  /** A core error kind that every send throws instead (a pane the core says is gone, say). */
  sendError: string | null;
  /** Milliseconds the core takes to answer one `send`: a spawn must not sit through it. */
  sendDelayMs: number;
  /** Answers the fake core gives its next sends, one per send; empty means "went working at once".
   *  `started: null` is the measured lost send (spec S22). */
  sendResults: SendResult[];
  /** Texts pasted into a worker's composer, in order. A send the core refused pastes nothing. */
  pastes: Array<{ paneId: string; text: string }>;
  /** What sits unsubmitted in each pane's composer: a send that did not start a turn leaves its text
   *  there, and Enter submits it (spec S22's measured loss). */
  composer: Record<string, string>;
  /** Sends the fake core refused with `status_mismatch`: nothing was typed. */
  statusMismatches: number;
  /** How many of the next sends are refused with `status_mismatch` (the status moved in the gap). */
  refuseSend: number;
  /** Panes whose agent never reports `idle`, so readiness has to wait for the core. */
  notReady: Set<string>;
  /** The status word the core reports per pane; a missing entry means an idle agent. */
  statuses: Record<string, CoreStatus>;
  /** Core `turn` per pane, as the children watch reports it. */
  turns: Record<string, number>;
  /** Wake a gated poll loop once, simulating the core's turn event. */
  wakeWorker(): void;
  /** Gate the children watch: parks wait for a wake (or time out) instead of resolving at once. */
  gated: boolean;
  /** Transcript text the pipe server appends on a prompt; null appends nothing, so no transcript
   *  settlement can fire and only a report document settles the worker. */
  transcript: string | null;
  /** The fake core client, with its document store: the worker's report documents live here. */
  client: CoreClientLike;
  /** Pipe connections accepted per pane. Steering goes through the core (spec S15), so a `send`
   *  leaves this at zero — that is the test's evidence the private channel is not in the path. */
  pipeConnections: Record<string, number>;
  /** Every command document the master wrote, as the worker's own watch would read it (spec S10). */
  commands: Array<{ paneId: string; value: CommandDocumentValue }>;
  /** What the stand-in worker does with a command: apply it (hands the text to `frames` as a core
   *  delivery and clears the document, the way the real watch does) or leave it sitting in the core,
   *  which is a worker whose extension is not watching. */
  commandPickup: 'applied' | 'silent';
  /** The worker session file the pipe server appends to. */
  workerSessionFile: string;
  /** Simulate a master restart: dispose the session, mount fresh, and restore from the documents. */
  remount?: (reason: string) => Promise<void>;
}

/** Mounts the plugin with a fake core plus a loopback pipe server standing in for the worker pane
 * (p2): the pipe records the follow-up frames piher still sends and answers ok, while the first task
 * of every spawn rides the core's own `send` (spec S14). `paneSeq` hands out p2, p3, … for multi-worker
 * tests; `pipes: false` starts no pipe server at all, which is the worker that never serves one. */
async function withPipeEnv(
  fn: (env: PipeEnv) => Promise<void>,
  opts: { childCwd?: string; paneSeq?: boolean; pipes?: boolean; gitRepo?: boolean; sessionFile?: string | ((cwd: string) => string); policy?: Partial<RuntimePolicy> } = {},
): Promise<void> {
  const home = new TempHome('piher-spawn-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'piher-spawn-cwd-'));
  // The task directory lives inside the repository, so a main checkout needs a `.git`. The
  // `gitRepo: false` case is the "not inside a git repository" one: no tasks at all.
  if (opts.gitRepo !== false) mkdirSync(join(cwd, '.git'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  let parked = false;
  /** A gated poll loop parks until `wakeWorker` simulates the core's turn event. */
  let wake = false;
  const env: PipeEnv = {
    cwd, home, pi: undefined as never, port: undefined as never, frames: [], retired: [], spawnEnvs: [], spawnLabels: [],
    parkPollers: () => { parked = true; }, rejectSend: false, sendError: null, sendDelayMs: 0, paneGone: false, paneFinished: false, deadPipes: 0,
    sendResults: [], notReady: new Set<string>(), statuses: {},
    pastes: [], composer: {}, statusMismatches: 0, refuseSend: 0,
    turns: {}, wakeWorker: () => { wake = true; }, gated: false, transcript: SUB_TEXT,
    client: undefined as never, workerSessionFile: sessionFile,
    pipeConnections: {}, commands: [], commandPickup: 'applied',
  };
  let paneCounter = 0;
  const nextPaneId = (): string => (opts.paneSeq ? `p${2 + paneCounter++}` : 'p2');
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const ensureServer = (paneId: string): void => {
    const server = startPipeServer(pipeNameFor(opts.childCwd ?? cwd, paneId), async (req) => {
      const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
      if (isPrompt) {
        env.frames.push({ channel: 'pipe', type: req.type, id: req.id, text: req.text, from: req.from ?? '' });
        if (env.transcript !== null) writeFileSync(sessionFile, jsonl(transcriptMessage('assistant', env.transcript, Date.now())));
      }
      return { type: 'ok', id: req.id };
    });
    servers.push(server);
    server.on('connection', (sock) => {
      // P3 (spec S15): steering never comes this way, so a connection here is the test's own evidence
      // that the send channel is still the private pipe.
      env.pipeConnections[paneId] = (env.pipeConnections[paneId] ?? 0) + 1;
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
  if (opts.pipes !== false) {
    ensureServer('p2');
    if (opts.paneSeq) { for (const id of ['p3', 'p4', 'p5', 'p6']) ensureServer(id); }
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.once('listening', resolve))));
  }
  /** The worker's agent takes the composer: what a turn would receive, now one delivery. */
  const submit = (id: string): void => {
    const text = env.composer[id];
    if (text === undefined || text === '') return;
    delete env.composer[id];
    env.frames.push({ channel: 'core', type: 'prompt', id: `send-${env.frames.length + 1}`, text, from: '' });
    env.turns[id] = (env.turns[id] ?? 0) + 1;
    if (env.transcript !== null) {
      writeFileSync(sessionFile, jsonl(transcriptMessage('assistant', env.transcript, Date.now())));
    }
  };
  /** The core's documents, with the compare-and-swap versions `doc.set` enforces (spec S11). */
  const docs = new Map<string, { value: unknown; version: number }>();
  /** The worker's own command watch (spec S15): record the command, hand its text to pi, clear the
   *  document at the version it was read at — a newer command written meanwhile stays where it is. */
  const deliverCommand = (name: string, value: unknown, version: number): void => {
    const paneId = name.slice('piher.cmd.'.length);
    env.commands.push({ paneId, value: value as CommandDocumentValue });
    if (env.commandPickup !== 'applied') return;
    setTimeout(() => {
      const command = value as CommandDocumentValue;
      env.frames.push({ channel: 'core', type: command.type, id: command.id, text: command.text, from: '' });
      if (docs.get(name)?.version === version) docs.set(name, { value: null, version: version + 1 });
    }, 0);
  };
  const clientOpts: Partial<CoreClientLike> = {
    // The document store stands in for the core's, and for the worker's own command watch: a command
    // the master writes is read and cleared by the worker's extension (spec S15), asynchronously, the
    // way the real one is. `commandPickup: 'silent'` is a worker whose extension is not watching.
    docGet: async (name: string) => docs.get(name) ?? { value: null, version: 0 },
    docSet: async (name: string, value: unknown, version: number) => {
      const current = docs.get(name)?.version ?? 0;
      if (current !== version) {
        throw new CoreError('doc.set', 'conflict', `version ${version} is stale (now ${current})`, 'read doc.get and retry with its version');
      }
      const next = version + 1;
      docs.set(name, { value, version: next });
      if (value !== null && name.startsWith('piher.cmd.')) deliverCommand(name, value, next);
      return next;
    },
    getTerminal: async (id: string) => env.paneGone ? null : terminalInfo({
      id,
      // S14: the core's status word is the readiness gate, so an agent that has not said `idle` yet is
      // reported as never having reported — what `run --bg` shows before the worker boots.
      status: env.notReady.has(id) ? 'unknown' : env.statuses[id] ?? 'idle',
      state: env.paneFinished ? 'finished' : 'live',
      turn: env.turns[id] ?? 0,
      labels: ['p2', 'p3', 'p4', 'p5', 'p6'].includes(id) ? { 'piher.session': sessionFile } : {},
    }),
    // S14/S22: the first task rides the core's own `send`, and its result is the only delivery proof.
    // The paste lands in the composer; the core's own Enter submits it unless the scripted result says
    // the turn never started — the measured loss, where a second paste would put the brief in the turn
    // twice.
    send: async (id: string, text: string, o?: { if?: 'idle' | 'working' }) => {
      if (env.sendError) throw new CoreError('terminal.send', env.sendError, `the core says ${env.sendError}`, null);
      if (env.rejectSend) throw new Error('blocked: the program is waiting on a dialog');
      if (env.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, env.sendDelayMs));
      const status = env.notReady.has(id) ? 'unknown' : env.statuses[id] ?? 'idle';
      if (env.refuseSend > 0) {
        env.refuseSend -= 1;
        env.statusMismatches += 1;
        throw new CoreError('terminal.send', 'status_mismatch', `status is ${status}, not ${o?.if ?? 'any'}`, null);
      }
      if (o?.if && status !== o.if) {
        env.statusMismatches += 1;
        throw new CoreError('terminal.send', 'status_mismatch', `status is ${status}`, null);
      }
      env.pastes.push({ paneId: id, text });
      env.composer[id] = (env.composer[id] ?? '') + text;
      const scripted = env.sendResults.shift();
      const started = scripted ? scripted.started : true;
      if (started === true) submit(id);
      return {
        started,
        status: scripted?.status ?? (started === true ? 'working' : status),
        turn: env.turns[id] ?? 0,
      };
    },
    // Enter submits whatever the composer holds; on an empty composer it does nothing, and it can never
    // add a second copy of the brief.
    keys: async (id: string, pressed: readonly string[]) => {
      if (pressed.includes('enter')) submit(id);
    },
    // The poller parks on the children watch: while parked, `changed` never resolves and the
    // snapshot reports the worker as working, so the row stays running with no polling.
    watchChildren: () => fakeWatch({
      terminals: () => ['p2', 'p3', 'p4', 'p5', 'p6'].map((id) => terminalInfo({
        id,
        status: parked ? 'working' : 'idle',
        turn: env.turns[id] ?? 0,
        labels: { 'piher.session': sessionFile },
      })),
      park: (ms) => {
        if (parked) return new Promise<never>(() => {});
        if (!env.gated) return false;
        if (wake) { wake = false; return true; }
        // A gated loop waits for the turn event, briefly: long enough to stage it, short enough
        // that an unstaged loop never spins hot. Unref'd, so the gate cannot hold the process.
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(wake ? (wake = false, true) : false), Math.min(ms, 20));
          timer.unref?.();
        });
      },
    }),
    read: async () => ({ text: '', complete: true }),
    run: async (o) => {
      env.spawnEnvs.push(o.env ?? {});
      env.spawnLabels.push(o.labels ?? {});
      // A new pane exists, so the old pane's disappearance no longer describes this worker.
      env.paneGone = false;
      return terminalInfo({ id: nextPaneId(), cwd: o.cwd, labels: o.labels });
    },
    kill: async (id) => { env.retired.push(id); },
  };
  let root: { fiber: { dispose(): Promise<unknown> } } | null = null;
  const sessionPath = typeof opts.sessionFile === 'function' ? opts.sessionFile(cwd) : opts.sessionFile ?? null;
  const mount = async (): Promise<void> => {
    const mounted = await mountSubagent({
      client: clientOpts,
      ...((sessionPath || opts.policy)
        ? {
          deps: {
            ...(sessionPath ? { getSessionFile: () => sessionPath, getCwd: () => cwd } : {}),
            ...(opts.policy ? { policy: opts.policy } : {}),
          },
        }
        : {}),
    });
    env.pi = mounted.pi;
    env.port = mounted.port;
    env.client = mounted.client;
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
/** The spawn acknowledgement leaves boot (readiness, first task, poller) off the caller's turn. */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('spawn action: an acknowledgement now, the prompt later, the report as a notice', async (t) => {
  await withPipeEnv(async (env) => {
    await t.test('the call returns an acknowledgement without waiting for the child', async () => {
      env.parkPollers(); // no poll loop spinning while the assertions run
      // A child that answers slowly is exactly the case a spawn must not sit through.
      env.sendDelayMs = 1000;
      const started = Date.now();
      const result = await runSubagent(env.pi, { description: 'probe', prompt: PROMPT }, env.cwd);
      const elapsed = Date.now() - started;
      const text = result.content[0]!.text;
      assert.match(text, /^started subagent [a-z0-9-]+@p2 \(task [0-9a-f-]+, persistent — stays until you close it\)/);
      assert.match(text, /settlement notice/);
      assert.doesNotMatch(text, /REPORT:/, 'the acknowledgement is not the report');
      // The core takes a second to answer its `send` here: a blocking spawn would show it.
      assert.ok(elapsed < 900, `a spawn must not wait for its child (took ${elapsed}ms)`);
      assert.equal(result.details?.paneId, 'p2');

      await waitFor(() => env.frames.length === 1);
      assert.equal(env.frames.length, 1, 'the prompt is delivered exactly once, off the caller turn');
      assert.equal(env.frames[0]!.channel, 'core', 'the first task rides the core, not the private pipe');
      assert.equal(env.frames[0]!.text, PROMPT, 'the whole prompt reaches the worker');
    });

    await t.test('list shows the child while it runs, and the row stays running', async () => {
      env.sendDelayMs = 0;
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
      // The harness panes never report a turn, so the contract reads `no report` here — the row is
      // still listed as actionable, which is what this subtest proves.
      assert.match(listed, /p2 \[no report/);
      assert.match(listed, /long probe/);
    });

    await t.test('a live pane that refused its first send is kept, and the master is told what to do', async () => {
      env.rejectSend = true;
      const text = (await runSubagent(env.pi, { description: 'blocked probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      assert.match(text, /^started subagent/, 'the start is acknowledged before the core answers');
      const slug = /started subagent ([a-z0-9-]+)@/.exec(text)![1];
      const failedTaskId = /\(task ([0-9a-f-]+),/.exec(text)![1];
      await waitFor(() => env.pi.userSent.length > 0);
      // A refusal says nothing about the pane's health: killing it would make the advice a lie and
      // throw away the only place the reason is visible.
      assert.deepEqual(env.retired, [], 'a live pane is not retired');
      const notice = env.pi.userSent.at(-1)?.content ?? '';
      assert.match(notice, /is up but did not take its first message/);
      assert.match(notice, /blocked: the program is waiting on a dialog/);
      assert.match(notice, /read it with action "output"/);
      assert.match(notice, /then retry task /);
      assert.ok(readTaskRecord(env.cwd, failedTaskId) !== null, 'the task is still there to retry or close');
      // It also stays listed: a row whose pane is alive is actionable.
      const listed = (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      assert.match(listed, /blocked probe/);
      // Scoped by slug: earlier subtests parked their workers on the same harness pane id.
      assert.ok((env.port.current?.listRunningSubs() ?? []).some((s) => s.slug === slug), 'the kept task stays listed');
      env.rejectSend = false;
    });

    await t.test('a pane that died before it was ready is retired and its row dropped', async () => {
      env.paneFinished = true;
      const text = (await runSubagent(env.pi, { description: 'dead probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      assert.match(text, /^started subagent/, 'the start is acknowledged before the pane dies');
      const deadTaskId = /\(task ([0-9a-f-]+),/.exec(text)![1];
      await waitFor(() => env.retired.length === 1 && env.pi.userSent.length > 0);
      assert.deepEqual(env.retired, ['p2'], 'the dead terminal is killed');
      const notice = env.pi.userSent.at(-1)?.content ?? '';
      assert.match(notice, /failed to start/);
      assert.match(notice, /Nothing is running there/);
      assert.equal(readTaskRecord(env.cwd, deadTaskId), null, 'a spawn that never started leaves no record');
      env.paneFinished = false;
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

test('send: a follow-up to a worker in another checkout rides the core, and opens no pipe', async () => {
  const other = mkdtempSync(join(tmpdir(), 'piher-spawn-other-'));
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'cross-repo task', prompt: PROMPT, cwd: other }, env.cwd);
    assert.match(spawned.content[0]!.text, /^started subagent [a-z0-9-]+@p2 /);
    await waitFor(() => env.frames.length === 1);
    // The first task rides the core, so the core knows the caller; only the follow-up names a pipe.
    assert.equal(env.frames[0]!.channel, 'core');

    const sent = await runSubagent(env.pi, { action: 'send', agentId: 'p2', message: 'wrap up and report' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent [a-z0-9-]+@p2/);
    // P3 (spec S15): a follow-up is a command document named by the worker's core address, so neither
    // the worker's checkout nor the master's enters its name — and no socket is opened for it.
    assert.deepEqual(env.commands.map((c) => c.paneId), ['p2'], 'one command, named by the worker address');
    assert.equal(env.commands[0]!.value.type, 'follow_up');
    assert.equal(env.commands[0]!.value.deliverAs, 'steer', 'a follow-up is steered into the running turn');
    assert.equal(env.commands[0]!.value.text, 'wrap up and report');
    assert.equal(env.frames[1]!.channel, 'core', 'the worker took it through the core, not the private pipe');
    assert.equal(env.frames[1]!.text, 'wrap up and report');
    assert.equal(env.pipeConnections.p2 ?? 0, 0, 'the send opened no connection to a pipe name');
  }, { childCwd: other });
});

test('send: a settled persistent worker is still reachable', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'hola', prompt: PROMPT }, env.cwd);
    const paneId = spawned.details?.paneId as string;
    // The spawn's own boot (readiness + first task) must be over, so the dead pipe the send meets is
    // the send's, not the boot's.
    await waitFor(() => env.frames.length === 1);
    env.port.current!.consumeReply(paneId, 'REPORT: hola');
    // A persistent worker delivered its result, not its life: the master keeps talking to it.
    const sent = await runSubagent(env.pi, { action: 'send', agentId: paneId, message: 'y ahora otra cosa' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent/);
    // A follow_up re-arms the row: the old consume time must go, or GC and the checkout sweep read a
    // worker with a turn in flight as finished.
    const rearmed = env.port.current!.listRunningSubs().find((s) => s.paneId === paneId);
    assert.ok(rearmed, 'the re-armed row still awaits its report');
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
    // The spawn's own boot (readiness + first task) must be over, so the dead pipe the send meets is
    // the send's, not the boot's.
    await waitFor(() => env.frames.length === 1);
    env.port.current!.consumeReply(paneId, 'REPORT: hola');
    // Housekeeping reclaims the pane of a settled worker; the task itself was never closed. The core
    // no longer lists the terminal, which is what a `send` sees first (spec S3).
    env.paneGone = true;
    const sent = await runSubagent(env.pi, { action: 'send', agentId: paneId, message: 'sigue aqui' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent/);
    assert.equal(env.spawnEnvs.length, 2, 'a second terminal carries the follow-up on the same session');
    assert.equal(env.pipeConnections.p2 ?? 0, 0, 'the revive opened no pipe either');
  });
});

test('P3: a send steers a worker that is mid-turn, and the result reports the delivery', async (t) => {
  await withPipeEnv(async (env) => {
    env.parkPollers();

    await t.test('a steer to a working worker is applied, and its tool result says so', async () => {
      const spawned = await runSubagent(env.pi, { description: 'steer probe', prompt: PROMPT }, env.cwd);
      const paneId = spawned.details?.paneId as string;
      await waitFor(() => env.frames.length === 1);
      // The worker is mid-tool-call: the core reports it working, which is the state this channel
      // exists for (`terminal.send --if idle` refuses exactly here).
      env.statuses[paneId] = 'working';
      const sent = await runSubagent(env.pi, { action: 'send', agentId: paneId, message: 'wrap up and report' }, env.cwd);
      // S15: the contract's wording, used only because the worker read the command (spec contracts.md).
      assert.match(sent.content[0]!.text, /^Message sent to subagent [a-z0-9-]+@p2\.$/);
      assert.equal(env.commands.length, 1, 'one command document carried the send');
      assert.equal(env.commands[0]!.paneId, 'p2', 'named by the worker address (S9)');
      assert.equal(env.commands[0]!.value.deliverAs, 'steer', 'delivered as pi’s steer, not queued behind the turn');
      assert.equal(env.commands[0]!.value.text, 'wrap up and report');
      assert.equal(env.frames.at(-1)!.channel, 'core');
      assert.equal(env.frames.at(-1)!.text, 'wrap up and report', 'the worker received the text itself');
      assert.equal(env.pipeConnections.p2 ?? 0, 0, 'the send opened no connection to a pipe name');
      // Applying it is not the same as being read: the worker cleared the document it applied (S11).
      assert.equal((await env.client.docGet('piher.cmd.p2'))?.value, null, 'the applied command is cleared');
      delete env.statuses[paneId];
    });

    await t.test('a worker that never reads its command is not reported as delivered', async () => {
      env.commandPickup = 'silent';
      const panesBefore = env.commands.length;
      const sent = await runSubagent(env.pi, { action: 'send', agentId: 'p2', message: 'anyone there?' }, env.cwd);
      const text = sent.content[0]!.text;
      assert.doesNotMatch(text, /^Message sent/, 'a command nobody read is not a delivered message');
      assert.match(text, /Message written for subagent/);
      assert.match(text, /has not applied it yet/);
      assert.match(text, /piher\.cmd\.p2/, 'the result names the document that holds it');
      assert.equal(env.commands.length, panesBefore + 1, 'the write did land in the core');
      const held = await env.client.docGet('piher.cmd.p2');
      assert.equal((held?.value as { text?: string } | null)?.text, 'anyone there?', 'the command stays queued (S12)');
      env.commandPickup = 'applied';
    });
  }, { policy: { commandPickupMs: 300 } });
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
    assert.equal(env.frames[1]!.text, '8-char prefix message');

    await runSubagent(env.pi, { action: 'send', agentId: short4, message: '4-char prefix message' }, env.cwd);
    assert.equal(env.frames.length, 3);
    // Two follow-ups in, the worker is mid-turn, which is what `resume` must refuse.
    env.statuses.p2 = 'working';

    assert.match(await runSubagentRejects(env.pi, { action: 'send', agentId: fullTaskId.slice(0, 3), message: 'x' }, env.cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runSubagentRejects(env.pi, { action: 'send', agentId: '00000000', message: 'x' }, env.cwd), /unknown subagent id "00000000"/);

    const live = await runSubagent(env.pi, { action: 'resume', taskId: short8 }, env.cwd);
    assert.match(live.content[0]!.text, /already running as pane/);
    assert.equal(live.details?.taskId, fullTaskId);
    env.port.current?.consumeReply('p2', 'done');
    delete env.statuses.p2;
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

    // The worker holds its first turn, so `resume` must refuse it; once the report is read, the row is
    // a collected task whose pane is gone and a revive is the honest answer.
    env.statuses.p2 = 'working';
    assert.match(await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd).then((r) => r.content[0]!.text), /already running as pane/);
    env.port.current?.consumeReply(paneId, 'done');
    delete env.statuses.p2;
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

test('admission: resumes waiting for their pane cannot hold a spawn behind them', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const first = await runSubagent(env.pi, { description: 'task that settles first', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = first.details?.taskId as string;
    env.port.current?.consumeReply(String(first.details?.paneId), 'done');
    const panesBefore = env.spawnLabels.length;

    // Every revive now waits for its pane's agent to report `idle` from the core: a slow boot that
    // DOES finish, so the wait is the only thing the four calls are doing when the spawn arrives. The
    // cap is four, so a cap that covered readiness would leave no slot for the spawn.
    env.notReady.add('p2');
    let finished = 0;
    const resumes = [1, 2, 3, 4].map(() => {
      const call = runSubagent(env.pi, { action: 'resume', taskId }, env.cwd);
      void call.then(() => { finished += 1; }, () => { finished += 1; });
      return call;
    });
    await waitFor(() => env.spawnLabels.length === panesBefore + 4);
    assert.equal(finished, 0, 'all four resumes are past pane creation and waiting for the core');

    const started = Date.now();
    const spawn = await runSubagent(env.pi, { description: 'task queued behind it', prompt: PROMPT }, env.cwd);
    const elapsed = Date.now() - started;
    assert.match(spawn.content[0]!.text, /^started subagent/);
    assert.ok(elapsed < 150, `a spawn must not queue behind a resume that waits for readiness (took ${elapsed}ms)`);
    assert.equal(finished, 0, 'the spawn returned while every resume was still waiting for its agent');

    env.notReady.delete('p2');
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
      assert.ok(row, `record exists for ${taskId}`);
      assert.equal(row.taskId, taskId);
      assert.equal(row.description, i === 0 ? 'reload probe one' : 'reload probe two');
      assert.equal(row.gen.paneId, refs[i]!.split('@')[1]);
      assert.ok(row.closedAt !== null, 'close wrote the decision into the record');
    }

    // No session entry was appended: the branch is not a document in this model.
    for (const [n, pi] of [piBefore, env.pi].entries()) {
      const subs = pi.entries.some(([type]) => type === 'piher.subs');
      assert.ok(!subs, `mount #${n + 1} appended no piher.subs entry`);
    }
  }, { paneSeq: true, sessionFile: sessionFor });
});

const aStamp = '2026-11-07T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000000.jsonl';

// A foreign action must leave the row's identity and decision alone. The owning session's
// poller still watches the pane and may honestly write delivery fields (gen.consumedAt,
// gen.reportDelivered) into its own record at any moment — one writer per document — so
// only those two are excluded; everything else is fixed at spawn or by a decision this
// session would have seen. A byte comparison would fail on the owner's write, not on ours.
function stableRowFields(row: TaskRow) {
  return {
    taskId: row.taskId,
    description: row.description,
    kind: row.kind,
    lifecycle: row.lifecycle,
    cwd: row.cwd,
    worktree: row.worktree,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    gen: {
      paneId: row.gen.paneId,
      slug: row.gen.slug,
      tabId: row.gen.tabId,
      tabName: row.gen.tabName,
      sessionFile: row.gen.sessionFile,
      launchCommand: row.gen.launchCommand,
      startedAt: row.gen.startedAt,
    },
  };
}

test('ownership: foreign rows list marked, close final, retry starts new', async () => {
  // Two mounts share one repository directory with different session files. Foreignness derives
  // from the view alone: a record the view does not name belongs to another session (S10 keeps
  // the durable facts fixed, so no owner field exists to read).
  const bStamp = '2026-11-07T00-00-00-000Z_bbbbbbbb-0000-4000-8000-000000000000.jsonl';
  const words = ['one', 'two', 'three', 'four'];
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const workers: Array<{ taskId: string; slug: string; paneId: string }> = [];
    for (const [i, word] of words.entries()) {
      const spawned = await runSubagent(
        env.pi, { description: `shared worker ${word}`, prompt: PROMPT }, env.cwd);
      const text = spawned.content[0]!.text;
      workers.push({
        taskId: spawned.details?.taskId as string,
        slug: /started subagent ([a-z0-9-]+)@/.exec(text)![1]!,
        paneId: `p${2 + i}`,
      });
    }
    await waitFor(() => env.frames.length === 4);
    const [w1, w2, w3, w4] = workers;
    if (!w1 || !w2 || !w3 || !w4) throw new Error('four workers were not spawned');

    // B also spawns (a retry below needs it): its own pane ids and pipe, parked pollers.
    const bFrames: Delivery[] = [];
    const bSockets = new Set<Socket>();
    const qServer = startPipeServer(pipeNameFor(env.cwd, 'q2'), async (req) => {
      if (req.type === 'prompt' || req.type === 'follow_up') {
        bFrames.push({ channel: 'pipe', type: req.type, id: req.id, text: req.text, from: req.from ?? '' });
      }
      return { type: 'ok', id: req.id };
    });
    qServer.on('connection', (sock) => {
      bSockets.add(sock);
      sock.on('close', () => bSockets.delete(sock));
    });
    await new Promise<void>((resolve) => qServer.once('listening', resolve));
    let bPaneSeq = 0;
    let bMode: 'working' | 'gone' | 'idle' = 'working';
    const bSession = join(env.cwd, bStamp);
    const bKilled: string[] = [];
    const bMount = await mountSubagent({
      client: {
        getTerminal: async (id: string) => bMode === 'gone'
          ? null
          : terminalInfo({ id, state: 'live', status: bMode }),
        listTerminals: async () => [],
        watchChildren: () => fakeWatch({
          terminals: () => [], park: () => new Promise<never>(() => {}),
        }),
        run: async (o) => terminalInfo({ id: `q${2 + bPaneSeq++}`, cwd: o.cwd, labels: o.labels }),
        // S14: B's retry spawns, so its first task rides B's own core client.
        send: async (_id: string, text: string) => {
          bFrames.push({ channel: 'core', type: 'prompt', id: `send-${bFrames.length + 1}`, text, from: '' });
          return { started: true, status: 'working', turn: 1 };
        },
        kill: async (id: string) => { bKilled.push(`kill:${id}`); },
        remove: async (id: string) => { bKilled.push(`remove:${id}`); },
      },
      deps: { getSessionFile: () => bSession },
    });
    try {
      // B lists A's live workers with the foreign prefix, in the contract's line format.
      const listed = (await runSubagent(bMount.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      const lines = listed.split('\n');
      assert.equal(lines.length, 4, `B lists all four foreign workers: ${listed}`);
      for (const [i, w] of workers.entries()) {
        const foreignLine = `^\\[otra sesión\\] ${w.slug}@${w.paneId} \\[running\\]`;
        assert.match(lines[i]!, new RegExp(foreignLine), `worker ${i} is marked foreign`);
      }

      // Send and retry on a live foreign row refuse with ownership, not finality: steering
      // would write a generation this session does not own.
      const bSend = { action: 'send', agentId: w1!.paneId, message: 'x' };
      assert.match(await runSubagentRejects(bMount.pi, bSend, env.cwd), /belongs to another session/);
      assert.match(
        await runSubagentRejects(bMount.pi, { action: 'retry', agentId: w1!.paneId }, env.cwd),
        /belongs to another session/);

      // Foreign output answers from live probes: the row's identity and decision are
      // unchanged (delivery fields excluded — see stableRowFields), and B's view is untouched.
      const before = stableRowFields(readTaskRecord(env.cwd, w1!.taskId)!);
      const out = await runSubagent(bMount.pi, { action: 'output', agentId: w1!.paneId }, env.cwd);
      assert.equal(out.details!.reportDelivered, false);
      assert.deepEqual(stableRowFields(readTaskRecord(env.cwd, w1!.taskId)!), before);
      assert.equal(readTaskView(bSession), null, 'no view document grows from foreign rows');

      // Once the panes report gone, B stops listing them: no `no pane` line for foreign rows.
      bMode = 'gone';
      const gone = (await runSubagent(bMount.pi, { action: 'list' }, env.cwd)).content[0]!.text;
      assert.equal(gone, 'No subagents started (from this session view).');

      // B's close drives one worker per id form the list line offers. The agents are idle,
      // so no turn blocks any close; nothing is adopted anywhere.
      bMode = 'idle';
      const closes = [
        w1!.slug,
        `${w2!.slug}@${w2!.paneId}`,
        w3!.paneId,
        w4!.taskId.slice(0, 8),
      ];
      for (const ref of closes) {
        const closed = await runSubagent(bMount.pi, { action: 'close', agentId: ref }, env.cwd);
        assert.match(closed.content[0]!.text, /closed — pane and tab gone/, `close by ${ref}`);
      }
      assert.deepEqual(bKilled, [
        'kill:p2', 'remove:p2', 'kill:p3', 'remove:p3',
        'kill:p4', 'remove:p4', 'kill:p5', 'remove:p5',
      ], 'every foreign pane is retired');
      for (const w of workers) {
        const row = readTaskRecord(env.cwd, w.taskId);
        assert.ok(row, `${w.paneId} record exists`);
        assert.ok(row.closedAt !== null, `${w.paneId} decision lands`);
      }
      assert.equal(readTaskView(bSession), null, 'closes adopt nothing into the view');

      // A's rows are still open in A's memory, but the refresh adopts the record's decision:
      // send and resume refuse with finality, and the next list drops them — all with no reload.
      assert.match(
        await runSubagentRejects(env.pi, { action: 'send', agentId: 'p2', message: 'x' }, env.cwd),
        /closed by the master/);
      assert.match(
        await runSubagentRejects(env.pi, { action: 'resume', taskId: w1!.taskId }, env.cwd),
        /closed by the master/);
      assert.equal(
        (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text,
        'No subagents started (from this session view).');

      // A's retry on its B-closed row starts a new own task (S2): new id, same brief, and the
      // old record stays final on its original pane.
      const aRetried = await runSubagent(env.pi, { action: 'retry', agentId: 'p2' }, env.cwd);
      assert.match(aRetried.content[0]!.text, /^started subagent/);
      const aNewId = aRetried.details?.taskId as string;
      assert.ok(aNewId && aNewId !== w1!.taskId, 'a new task, not a resurrection');
      const aOldRow = readTaskRecord(env.cwd, w1!.taskId);
      assert.ok(aOldRow, 'the old record still exists');
      assert.ok(aOldRow.closedAt !== null, 'the old row stays final');
      assert.equal(aOldRow.gen.paneId, 'p2', 'no new generation on the closed task');
      const aNewRow = readTaskRecord(env.cwd, aNewId);
      assert.ok(aNewRow, 'the new record exists');
      assert.equal(aNewRow.description, 'shared worker one');

      // Retry on a foreign closed task starts a NEW task (S2): a new id in B's view alone,
      // A's brief re-sent, A's row identity and decision unchanged (delivery excluded).
      const aRecordBefore = stableRowFields(readTaskRecord(env.cwd, w1!.taskId)!);
      const retried = await runSubagent(
        bMount.pi, { action: 'retry', agentId: w1!.taskId }, env.cwd);
      assert.match(retried.content[0]!.text, /^started subagent/);
      const newTaskId = retried.details?.taskId as string;
      assert.ok(newTaskId !== w1!.taskId, 'a new task, not a resurrection');
      assert.deepEqual(readTaskView(bSession), [newTaskId], 'B’s view gains only the new id');
      assert.equal(readTaskRecord(env.cwd, newTaskId)?.description, 'shared worker one');
      await waitFor(() => bFrames.length === 1);
      assert.equal(bFrames[0]!.text, PROMPT, 'the stored brief is re-sent');
      assert.deepEqual(
        stableRowFields(readTaskRecord(env.cwd, w1!.taskId)!), aRecordBefore, 'A’s row is untouched');
    } finally {
      await bMount.root.fiber.dispose();
      for (const sock of bSockets) sock.destroy();
      await new Promise<void>((resolve) => qServer.close(() => resolve()));
    }
  }, { paneSeq: true, sessionFile: (cwd) => join(cwd, aStamp) });
});

test('tasks: spawn and close create exactly the two documents, nothing else', async () => {
  // The phase headline: one task record plus the session view — no ledger, no registry file,
  // no branch entry, and no status key anywhere in either document.
  const stamp = '2026-11-07T00-00-00-000Z_dddddddd-0000-4000-8000-000000000000.jsonl';
  const keysOf = (value: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(value)) {
      for (const entry of value) keysOf(entry, acc);
      return acc;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        acc.push(key);
        keysOf(entry, acc);
      }
    }
    return acc;
  };
  const treeOf = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (at: string, prefix: string): void => {
      for (const name of readdirSync(at)) {
        const full = join(at, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        out.push(rel);
        if (statSync(full).isDirectory()) walk(full, rel);
      }
    };
    walk(dir, '');
    return out.sort();
  };
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const sessionFile = join(env.cwd, stamp);
    const spawned = await runSubagent(
      env.pi, { description: 'two-document probe', prompt: PROMPT }, env.cwd);
    await waitFor(() => env.frames.length === 1);
    const taskId = spawned.details?.taskId as string;
    env.port.current!.consumeReply('p2', 'REPORT: done');
    env.paneGone = true;
    const closed = await runSubagent(env.pi, { action: 'close', agentId: 'p2' }, env.cwd);
    assert.match(closed.content[0]!.text, /closed — pane and tab gone/);

    // Document one: the task record holds exactly one row, with the decision and no status.
    const recordFile = taskRecordPath(repoTasksDir(env.cwd)!, taskId);
    const recordJson: unknown = JSON.parse(readFileSync(recordFile, 'utf8'));
    const envelope = recordJson as { version: unknown; rows: unknown[] };
    assert.equal(envelope.version, 1);
    assert.equal(envelope.rows.length, 1, 'one row per record file');
    const row = readTaskRecord(env.cwd, taskId);
    assert.ok(row, 'the record parses');
    assert.equal(row.taskId, taskId);
    assert.ok(row.closedAt !== null, 'close wrote the decision');
    assert.ok(!keysOf(recordJson).includes('status'), 'no status key anywhere in the record');

    // Document two: the session view references exactly this task id, as ids and nothing else.
    assert.deepEqual(readTaskView(sessionFile), [taskId]);
    const viewPath = sessionStatePath(sessionFile, TASK_VIEW_NAME)!;
    const viewJson: unknown = JSON.parse(readFileSync(viewPath, 'utf8'));
    assert.equal((viewJson as { version: unknown }).version, 1);
    assert.ok(!keysOf(viewJson).includes('status'), 'no status key in the view either');
    assert.ok(!keysOf(viewJson).includes('rows'), 'the view holds ids, not rows');

    // Nothing else: neither the repository nor the session state holds a third document.
    assert.deepEqual(treeOf(join(env.cwd, '.piher')), ['tasks', `tasks/${taskId}.json`]);
    const branched = env.pi.entries.some(([type]) => type === 'piher.subs');
    assert.ok(!branched, 'no branch entry was appended');
  }, { sessionFile: (cwd) => join(cwd, stamp) });
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

/* ── P1: settlement from the report document (spec S6–S7) ─────────────── */

test('P1: the worker report document settles on the turn event — exactly once', async () => {
  await withPipeEnv(async (env) => {
    // No transcript settlement is possible here: the pipe server appends nothing, so only the
    // report document can settle this worker.
    env.transcript = null;
    env.gated = true;
    const spawned = await runSubagent(env.pi, { description: 'doc probe', prompt: PROMPT }, env.cwd);
    const paneId = spawned.details?.paneId as string;
    const taskId = spawned.details?.taskId as string;
    await waitFor(() => env.frames.length === 1);

    // The worker's own write, on its settle: the exact value the master must deliver.
    const DOC_TEXT = 'REPORT: the document is the settlement';
    await env.client.docSet(`piher.rep.${paneId}`, {
      taskId, turn: 1, stopReason: 'stop', session: null, text: DOC_TEXT, at: Date.now(),
    }, 0);
    // The settle window is pushed beyond any test budget, so the transcript heuristic cannot fire:
    // the settlement below can only come from the document, on the core's turn event.
    env.turns[paneId] = 1;
    env.wakeWorker();
    await waitFor(() => env.pi.userSent.length === 1);
    const notice = env.pi.userSent[0]!.content;
    assert.match(notice, /Background subagent p2 \(doc probe\) finished and will do no further work/);
    assert.ok(notice.includes(DOC_TEXT), 'the settlement carries exactly the stored document text');

    // A second turn for the same document value delivers nothing twice.
    env.turns[paneId] = 2;
    env.wakeWorker();
    // The poll loop is gone (the settlement consumed the row), so no code path can deliver again;
    // one loop quantum passes to prove no straggler was already in flight.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(env.pi.userSent.length, 1, 'the same document value never settles twice');
    const listed = (await runSubagent(env.pi, { action: 'list' }, env.cwd)).content[0]!.text;
    assert.match(listed, /doc-probe@p2 \[idle\]/, 'the settlement consumed the row');
  }, { policy: { settleWindowMs: 3_600_000, subagentTimeoutMs: 3_600_000, pollIntervalMs: 50 } });
});

/* ── P2: the first task from the core (spec S14, S22) ───────────────── */

test('P2: the first task rides the core, gated on readiness and on the send result', async (t) => {
  // No pipe server at all: this worker never serves one, and the spawn must not care.
  await withPipeEnv(async (env) => {
    env.parkPollers();

    await t.test('a worker that never serves a pipe still receives its task, and its turn goes up', async () => {
      const spawned = await runSubagent(env.pi, { description: 'core-first task', prompt: PROMPT }, env.cwd);
      const paneId = spawned.details?.paneId as string;
      await waitFor(() => env.turns[paneId] === 1);
      assert.equal(env.frames.length, 1, 'the task is delivered exactly once');
      assert.equal(env.frames[0]!.channel, 'core', "the first task is the core's own send");
      assert.equal(env.frames[0]!.text, PROMPT, 'the whole brief reaches the worker');
      assert.equal(env.turns[paneId], 1, 'the send started a turn');
      // The socket the old readiness ping needed never exists for this worker.
      assert.equal(existsSync(pipePathFor(pipeNameFor(env.cwd, paneId))), false, 'no worker pipe was opened');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(env.frames.length, 1, 'a started turn is never re-sent');
    });

    await t.test('a send whose result is `started: null` is submitted, never pasted twice', async () => {
      // The measured loss (spec S22): the text goes in and the core's Enter never submits it. The
      // composer holds the brief, so the retry submits it — a second paste would put the master's
      // instructions in the turn twice.
      env.sendResults = [{ started: null, status: 'idle', turn: 0 }];
      const pastesBefore = env.pastes.length;
      const spawned = await runSubagent(env.pi, { description: 'lost first send', prompt: PROMPT }, env.cwd);
      const paneId = spawned.details?.paneId as string;
      const before = env.turns[paneId] ?? 0;
      await waitFor(() => env.turns[paneId] === before + 1);
      const pastes = env.pastes.slice(pastesBefore);
      assert.equal(pastes.length, 1, 'the brief is pasted exactly once, in the form that counts');
      const sent = env.frames.filter((f) => f.channel === 'core').slice(-1)[0]!;
      assert.equal(sent.text, PROMPT, 'the turn holds the brief once, not twice');
      assert.notEqual(sent.text, `${PROMPT}${PROMPT}`, 'no duplicate brief from a second paste');
      assert.equal(env.turns[paneId], before + 1, 'the retried submit started the turn');
      assert.equal(env.composer[paneId], undefined, 'the composer is empty once the turn took it');
      assert.equal(existsSync(pipePathFor(pipeNameFor(env.cwd, paneId))), false, 'still no worker pipe');
    });
  }, { pipes: false });
});

test('P2: readiness does not depend on the program reporting, and the paste is gated', async (t) => {
  await withPipeEnv(async (env) => {
    env.parkPollers();

    await t.test('a program that reports nothing still gets its brief (PI_PROGRAM_STATUS=0)', async () => {
      // No status word at all: the core cannot gate us, so readiness must not wait out the budget.
      env.notReady.add('p2');
      const spawned = await runSubagent(env.pi, { description: 'silent program', prompt: PROMPT }, env.cwd);
      const paneId = spawned.details?.paneId as string;
      const taskId = spawned.details?.taskId as string;
      await waitFor(() => env.turns[paneId] === 1);
      assert.deepEqual(env.frames.filter((f) => f.channel === 'core').map((f) => f.text), [PROMPT]);
      assert.equal(env.turns[paneId], 1, 'the turn happened without any status word');
      assert.deepEqual(env.retired, [], 'the worker is not killed for not reporting');
      assert.ok(readTaskRecord(env.cwd, taskId) !== null, 'the task is recorded');
      env.notReady.delete('p2');
    });

    await t.test('a status change between the readiness read and the paste types nothing, and pastes once', async () => {
      // The core refuses the paste because the agent is no longer idle: nothing went in, so a fresh
      // send is safe and the brief cannot be duplicated.
      const pastesBefore = env.pastes.length;
      const turnsBefore = env.turns.p2 ?? 0;
      env.refuseSend = 1;
      const spawned = await runSubagent(env.pi, { description: 'status race', prompt: PROMPT }, env.cwd);
      const paneId = spawned.details?.paneId as string;
      await waitFor(() => env.turns[paneId] === turnsBefore + 1);
      assert.equal(env.statusMismatches, 1, 'the core refused the first paste');
      assert.deepEqual(env.pastes.slice(pastesBefore).map((p) => p.text), [PROMPT], 'one paste, not two');
      assert.deepEqual(env.frames.filter((f) => f.channel === 'core').slice(-1).map((f) => f.text), [PROMPT]);
      assert.equal(env.turns[paneId], turnsBefore + 1, 'the gated retry started the turn');
    });

    await t.test('a blocked worker is kept with its task, and the master is told how to unblock it', async () => {
      env.statuses.p2 = 'blocked';
      const text = (await runSubagent(env.pi, { description: 'trust dialog probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      assert.match(text, /^started subagent/);
      const taskId = /\(task ([0-9a-f-]+),/.exec(text)![1];
      await waitFor(() => env.pi.userSent.length > 0);
      assert.deepEqual(env.retired, [], 'the pane a person must answer is not killed');
      const notice = env.pi.userSent.at(-1)?.content ?? '';
      assert.match(notice, /is up but did not take its first message/);
      assert.match(notice, /blocked on a dialog/);
      assert.match(notice, /answer that dialog in the pane, then retry this task/);
      assert.ok(readTaskRecord(env.cwd, taskId) !== null, 'the task survives so it can be retried');
      delete env.statuses.p2;
    });
  }, { pipes: false, policy: { readinessTimeoutMs: 800 } });
});

test('P2: a kept boot failure ends on its own, and a pane the core says is gone is not kept', async (t) => {
  await withPipeEnv(async (env) => {
    // A short silence budget: this is the watchdog that makes a kept row reclaimable (its
    // `gen.consumedAt` is what the tab, pane and checkout sweeps all wait on).
    await t.test('a kept failure is reclaimed by its silence budget, not left for the session', async () => {
      env.rejectSend = true;
      const text = (await runSubagent(env.pi, { description: 'kept probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      const taskId = /\(task ([0-9a-f-]+),/.exec(text)![1];
      await waitFor(() => env.pi.userSent.length > 0);
      assert.ok(readTaskRecord(env.cwd, taskId) !== null, 'the kept row is there (and so is its pane)');
      // The poller armed by the kept boot is the only thing that can set `consumedAt` here: no
      // settlement is coming, and the tab, pane and checkout sweeps all wait on that field.
      await waitFor(() => (readTaskRecord(env.cwd, taskId)?.gen.consumedAt ?? null) !== null, 8_000);
      const row = readTaskRecord(env.cwd, taskId);
      assert.ok((row?.gen.consumedAt ?? null) !== null, 'the silence budget consumed the kept row');
      assert.match(
        env.pi.userSent.map((m) => m.content).join('\n'),
        /has shown no progress/,
        'and the master was told the worker went silent',
      );
      assert.deepEqual(env.retired, [], 'the pane itself was not killed by the watchdog');
      env.rejectSend = false;
    });

    await t.test('a core error that says the pane is gone retires it, and the notice stops claiming it', async () => {
      env.sendError = 'not_found';
      const text = (await runSubagent(env.pi, { description: 'gone probe', prompt: PROMPT }, env.cwd)).content[0]!.text;
      const taskId = /\(task ([0-9a-f-]+),/.exec(text)![1];
      await waitFor(() => env.retired.length === 1 && env.pi.userSent.length > 0);
      assert.deepEqual(env.retired, ['p2'], 'a pane the core cannot find is retired');
      const notice = env.pi.userSent.at(-1)?.content ?? '';
      assert.match(notice, /failed to start/);
      assert.match(notice, /not_found/);
      assert.doesNotMatch(notice, /still there/, 'the advice must not name a terminal that is gone');
      assert.equal(readTaskRecord(env.cwd, taskId), null, 'and the row goes with it');
      env.sendError = null;
    });
  }, { pipes: false, policy: { readinessTimeoutMs: 2_000, subagentTimeoutMs: 250, pollIntervalMs: 30, settleWindowMs: 0 } });
});

test('P2: a revive that cannot come up retires the pane no row will ever point at', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: 'revive probe', prompt: PROMPT }, env.cwd);
    const paneId = spawned.details?.paneId as string;
    const taskId = spawned.details?.taskId as string;
    await waitFor(() => env.frames.length === 1);
    // Settled and collected: the row is now revivable, and the swap that would adopt the new pane
    // runs only after readiness.
    env.port.current!.consumeReply(paneId, 'REPORT: done');
    env.statuses[paneId] = 'blocked';
    const error = await runSubagentRejects(env.pi, { action: 'resume', taskId }, env.cwd);
    assert.match(error, /blocked on a dialog/);
    assert.match(error, /pane it created was retired/, 'the text must not promise a pane it does not keep');
    assert.doesNotMatch(error, /answer that dialog in the pane, then retry/);
    assert.ok(error.includes(taskId), 'and it names the task that still points where it did');
    assert.deepEqual(env.retired, [paneId], 'the fresh pane is retired, not orphaned');
    // The row keeps the generation it had: no pane id it never adopted.
    assert.equal(readTaskRecord(env.cwd, taskId)?.gen.paneId, paneId);
    delete env.statuses[paneId];
  });
});
