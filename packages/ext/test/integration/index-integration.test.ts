/**
 * index.ts composition root: process-mode mounting and the session lifecycle (notice buffering).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import extension from '../../src/index.ts';
import { pipeNameFor, pipePathFor, pipeRequestTo, startPipeServer, type PipeRequest, type PipeResponse } from '../../src/pipe-channel.ts';
import { sessionDirName } from '../../src/storage-layout.ts';
import { WIDGET_MAX_LINES } from '../../src/tree-view.ts';
import { fakePi, fire, jsonl, seedTaskDocuments, transcriptMessage, withCleanup, type CleanupContext, type FakePi } from '../test-utils.ts';
import { readWorkerMarker, writeWorkerMarker } from '../../src/worker-marker.ts';

type IndexMode = 'worker' | 'core-worker' | 'bare' | 'master';

/**
 * Boots the real composition root on one process-mode branch. `extra` lands on top of the mode
 * baseline (`undefined` deletes), so a test names only the variables it cares about.
 */
async function mountIndex(
  cleanup: CleanupContext,
  mode: IndexMode,
  extra: Record<string, string | undefined> = {},
): Promise<FakePi> {
  const env = cleanup.env();
  // Every piher env a parent session may already carry: this suite runs inside delegated panes too,
  // where an ambient delegation/role/session would otherwise decide what the mount sees.
  for (const key of [
    'PIHER_SUBAGENT', 'HC_TERMINAL_SOCKET', 'HC_TERMINAL_ID',
    'PIHER_ROLE_MANIFEST', 'PIHER_ROLE_BASE', 'PIHER_DELEGATION',
    'PI_SESSION_FILE', 'PI_SESSION_ID',
  ]) {
    env.delete(key);
  }
  if (mode === 'worker' || mode === 'core-worker') env.set('PIHER_SUBAGENT', '1');
  if (mode === 'master' || mode === 'core-worker') {
    env.set('HC_TERMINAL_SOCKET', '/tmp/piher-test-core.sock');
    env.set('HC_TERMINAL_ID', mode === 'master' ? 't1' : 't2');
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) env.delete(key);
    else env.set(key, value);
  }
  const pi = fakePi();
  await extension(pi as never);
  return pi;
}

/* ── mount surface per process mode ─────────────────────────────── */

test('index mount surface: worker and bare pi mount no core plugin', async (t) => {
  for (const mode of ['worker', 'bare'] as const) await t.test(mode, withCleanup(async (cleanup) => {
    const pi = await mountIndex(cleanup, mode);
    for (const tool of ['subagent', 'bg_job', 'list_agents', 'terminal_open']) assert.ok(!pi.tools.has(tool), `${mode} must not register ${tool}`);
    assert.ok(!pi.commands.has('piher-tree'), `${mode} has no delegation tree to show`);
    assert.ok(!pi.commands.has('locks'), 'write locks need a core terminal');
    assert.ok(!pi.commands.has('dashboard'), '/dashboard is gone');

    // A full session lifecycle must not throw outside a core terminal.
    const ctx = { sessionManager: { getBranch: () => [] } };
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    await fire(pi, 'turn_start');
    await fire(pi, 'tool_execution_start', { toolCallId: 'c1', toolName: 'read' });
    await fire(pi, 'tool_execution_end', { toolCallId: 'c1' });
    await fire(pi, 'agent_settled', {}, ctx);
    await fire(pi, 'session_shutdown');
  }));
});

test('index core master: mounts subagent, bg_job, three commands', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'master');
  try {
    for (const tool of ['subagent', 'bg_job']) assert.ok(pi.tools.has(tool), `core master mounts ${tool}`);
    assert.deepEqual([...pi.commands.keys()].sort(),
      ['piher-config', 'piher-locks', 'piher-role'],
      'the master mounts exactly the three piher commands: no delegation tree');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

/* ── role manifest ──────────────────────────────────────────────── */

test('role manifest deny returns terminate for the whole batch', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', {
    PIHER_ROLE_MANIFEST: JSON.stringify({ role: 'probe', version: 'v1', tools: ['read'], permissions: { bash: 'deny' }, unknownTools: 'deny' }),
  });
  const verdicts: unknown[] = [];
  for (const handler of pi.listeners.get('tool_call') ?? []) {
    verdicts.push(await handler({ toolName: 'bash' }));
  }
  const verdict = verdicts[0] as { block?: boolean; terminate?: boolean; reason?: string };
  assert.equal(verdict.block, true);
  assert.equal(verdict.terminate, true, 'denied batches must be able to stop without another model call');
  assert.match(verdict.reason ?? '', /bash/);
}));

test('role manifest ask: a role file writing `ask` never loads, so the gate is never armed with it', withCleanup(async (cleanup) => {
  const ws = cleanup.tempDir('ask-role-ws').path;
  const rolesDir = join(ws, '.piher', 'roles');
  await mkdir(rolesDir, { recursive: true });
  await writeFile(join(rolesDir, 'probe.json'), JSON.stringify({
    role: 'probe', version: '1.0.0', manifest: { tools: ['bash'], rules: { '*': 'ask' } },
  }));
  const pi = await mountIndex(cleanup, 'worker', {
    PIHER_ROLE_BASE: ws,
    PIHER_ROLE_MANIFEST: JSON.stringify({ role: 'worker', version: '1.0.0', tools: ['read'], permissions: { '*': 'allow' } }),
  });
  const notices: Array<{ text: string; level?: string }> = [];
  const ctx = { ui: { notify: (text: string, level?: string) => { notices.push({ text, level }); } } };
  const run = pi.commands.get('piher-role')!.handler as (...a: unknown[]) => Promise<void>;

  await run('probe', ctx);
  assert.equal(notices.length, 1, 'one message to the human who asked, and nothing armed');
  assert.equal(notices[0]?.level, 'error');
  const text = notices[0]?.text ?? '';
  assert.match(text, /failed validation/, 'the refusal is a validation failure, not a runtime block');
  assert.match(text, /rules\["\*"\]: "ask" is not a permission/, 'the issue names the rule and the value');
  assert.match(text, /piher ships no human-gate tool/, 'and says why nothing could ever grant it');

  await run('', ctx);
  assert.match(notices[1]?.text ?? '', /Current role: worker/, 'the failed switch left the role alone');
}));

/* ── session lifecycle ──────────────────────────────────────────── */

test('index session lifecycle: a session start leaves no state behind on shutdown', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: undefined, PI_SESSION_ID: undefined });
  const sessionDir = cleanup.tempDir('index-prune').path;

  const sessionId = 'sess_idx_prune';
  const ctx = { sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId, getBranch: () => [] } };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  await fire(pi, 'session_shutdown');

  // S69: nothing under the per-session root is piher's to prune any more; the directory is untouched.
  assert.equal(existsSync(join(sessionDir, 'piher', sessionId)), false);
}));

test('index: /piher-config reports configuration and hands a guided change to the agent', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker');

  assert.ok(pi.commands.has('piher-config'), 'D104 command is registered');

  const notes: Array<{ text: string; level?: string }> = [];
  const cwd = cleanup.tempDir('piher-config-ws').path;
  const ctx = { cwd, ui: { notify: (text: string, level?: string) => { notes.push({ text, level }); } }, isProjectTrusted: () => false };
  const run = pi.commands.get('piher-config')!.handler as (...a: unknown[]) => Promise<void>;
  /** Runs the command and returns the notify text it produced. */
  const runNotes = async (args: string) => { notes.length = 0; await run(args, ctx); return notes.map((n) => n.text).join('\n'); };

  const showOutput = await runNotes('show env');
  for (const re of [/env — Runtime policy env/, /PIHER_GIT_TIMEOUT_MS = /, /PIHER_SUBAGENT_TIMEOUT_MS = /]) {
    assert.match(showOutput, re);
  }

  assert.match(await runNotes('show bogus'), /unknown plane "bogus"/);
  assert.equal(notes[0]?.level, 'warning');

  assert.match(await runNotes('check'), /piher config check \(workspace trusted: false\)/);

  assert.match(await runNotes('doc'), /config report written:/);
  assert.equal(existsSync(join(cwd, '.piher', 'config-report.md')), true, 'report file is written into the workspace');

  assert.match(await runNotes(''), /asking the agent to guide the change/);
  assert.equal(pi.sent.length, 1, 'bare invocation injects exactly one guidance message');
  const injected = pi.sent[0]!.msg;
  assert.equal(injected.customType, 'piher.config-guide');
  assert.equal(injected.display, false);
  assert.match(String(injected.content), /^\[PIHER-CONFIG\]/);
  assert.deepEqual(pi.sent[0]!.opts, { triggerTurn: true });
}));

test('index: turn_start resets lastStopReason (A11) so a stale abort cannot swallow the next settlement', withCleanup(async (cleanup) => {
  const paneId = 'p_a11_test';
  const pi = await mountIndex(cleanup, 'master', { HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-a11', HC_TERMINAL_ID: paneId });
  const cwd = cleanup.tempDir('piher-a11-ws').path;
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };

  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);

    // Turn 1 was aborted by the user (ESC), so the abort latch is set on purpose: a child settling
    // right after must NOT wake the agent (D92).
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'aborted' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);

    // Turn 2 ends without a stopReason (the narrow window A11 is about): pre-fix the stale
    // "aborted" survives and the notice arriving in the settle gap is buffered forever.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', {}, ctx);
    const res = await pipeRequestTo(cwd, paneId, { type: 'reply', id: 'r-a11', paneId: 'p_child', text: 'child finished', sessionFile: null });
    assert.equal(res.type, 'ok');
    assert.equal(pi.userSent.length, 0, 'a notice arriving mid-settle is buffered, not injected');

    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(pi.userSent.length, 1, 'the buffered notice must reach the user when the turn settles');
    assert.match(pi.userSent[0]!.content, /child finished/);
    assert.deepEqual(pi.userSent[0]!.opts, { deliverAs: 'followUp', triggerTurn: true });
  } finally {
    await fire(pi, 'session_shutdown'); // close the pipe server even when an assertion fails
  }
}));

test('index: before_agent_start marks the run busy so settlement notices enter the D92 buffer', withCleanup(async (cleanup) => {
  const paneId = 'p_busy_start';
  const pi = await mountIndex(cleanup, 'master', { HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-busy', HC_TERMINAL_ID: paneId });
  const cwd = cleanup.tempDir('piher-busy-ws').path;
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };
  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    // pi 1.2 counts the run as busy here, before turn_start fires.
    await fire(pi, 'before_agent_start', { messageType: 'user', prompt: 'start', systemPromptOptions: { sections: {} } });
    const res = await pipeRequestTo(cwd, paneId, { type: 'reply', id: 'r-busy-start', paneId: 'p_child', text: 'child finished', sessionFile: null });
    assert.equal(res.type, 'ok');
    assert.equal(pi.userSent.length, 0, 'a notice arriving during the start window is buffered');
    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(pi.userSent.length, 1, 'the buffered notice flushes once the run settles');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

test('settle fast-path (D49): an aborted settle keeps the machine request armed; the genuine settle pushes the reply', withCleanup(async (cleanup) => {
  const childPane = 'p_settle_child';
  // Own transcript under the temp agent home so the genuine settle finds its closing text.
  const home = cleanup.tempDir('piher-settle-home').path;
  const cwd = cleanup.tempDir('piher-settle-ws').path;
  const parentCwd = cleanup.tempDir('piher-settle-parent').path;
  const pi = await mountIndex(cleanup, 'master', {
    HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-settle',
    HC_TERMINAL_ID: childPane,
    PI_CODING_AGENT_DIR: home,
    PI_SESSION_FILE: 'smoke-sess-0001',
  });
  const ctx = { cwd, sessionManager: { getBranch: () => [] }, isIdle: () => true };
  const replies: PipeRequest[] = [];
  const replyArrived = Promise.withResolvers<void>();
  const parent = startPipeServer(pipeNameFor(parentCwd, 'p_settle_parent'), (req) => {
    replies.push(req);
    replyArrived.resolve();
    return Promise.resolve({ type: 'ok', id: req.id });
  });

  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    const prompted = await pipeRequestTo(cwd, childPane, {
      type: 'prompt', id: 'prompt-smoke', text: 'go', from: pipeNameFor(parentCwd, 'p_settle_parent'),
    });
    assert.equal(prompted.type, 'ok');

    // The run "settles" on an abort (a user ESC): pre-fix this consumed the request with a
    // null-text reply, so the worker's real closing message could never be delivered.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'aborted' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(replies.length, 0, 'an aborted settle must not answer the machine request');

    // A provider error is retried by pi: it is not a settlement either, and answering would consume
    // the one-shot request with a null-text reply before the retry delivers the real closing message.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'error' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(replies.length, 0, 'an error stop must keep the machine request armed');

    // The continuation run genuinely settles: the still-armed request now carries the real text.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    const sessDir = join(home, 'sessions', sessionDirName(process.cwd()));
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, '2026-09-22T00-00-00-000Z_smoke-sess-0001.jsonl'),
      jsonl(
        { type: 'session', id: 'smoke-sess-0001' },
        transcriptMessage('assistant', 'services stopped, tree clean; the full report is in /tmp/report.md', Date.now() + 1000),
      ),
    );
    await fire(pi, 'agent_settled', {}, ctx);
    // pushSettleReply is fire-and-forget, and the reply crosses a real unix socket: await the
    // arrival signal with a deadline (deterministic time control cannot cross a socket).
    const deadline = setTimeout(() => replyArrived.reject(new Error('settle reply did not arrive within 2s')), 2000);
    deadline.unref?.();
    await replyArrived.promise;
    clearTimeout(deadline);
    assert.equal(replies.length, 1, 'exactly one settle reply, from the genuine settle');
    const reply = replies[0]!;
    assert.ok(reply.type === 'reply', `expected a reply, got ${reply.type}`);
    assert.equal(reply.id, 'prompt-smoke');
    assert.match(reply.text ?? '', /full report is in/);
    assert.equal(reply.paneId, childPane);
  } finally {
    parent.close();
    await fire(pi, 'session_shutdown'); // close the child's pipe server even when an assertion fails
  }
}));

test('S54 one-shot lifetime: the report reaches the parent before the worker shuts down', withCleanup(async (cleanup) => {
  const childPane = 'p_oneshot_child';
  const home = cleanup.tempDir('piher-oneshot-home').path;
  const cwd = cleanup.tempDir('piher-oneshot-ws').path;
  const parentCwd = cleanup.tempDir('piher-oneshot-parent').path;
  const replies: PipeRequest[] = [];
  /** Reply count observed at the moment the worker asked to exit — the ordering, measured. */
  const repliesAtShutdown: number[] = [];
  const replyArrived = Promise.withResolvers<void>();
  const parent = startPipeServer(pipeNameFor(parentCwd, 'p_oneshot_parent'), (req) => {
    replies.push(req);
    replyArrived.resolve();
    return Promise.resolve({ type: 'ok', id: req.id });
  });
  const pi = await mountIndex(cleanup, 'worker', {
    HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-oneshot',
    HC_TERMINAL_ID: childPane,
    PI_CODING_AGENT_DIR: home,
    PI_SESSION_FILE: 'oneshot-sess-0001',
    PIHER_DELEGATION: JSON.stringify({
      parentPaneId: 'p_oneshot_parent',
      parentSessionId: 'aaaa1111',
      taskId: 't-oneshot',
      description: 'review the diff',
      role: 'reviewer',
      lifecycle: 'one-shot',
    }),
  });
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => [] },
    isIdle: () => true,
    shutdown: () => { repliesAtShutdown.push(replies.length); },
  };
  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    const prompted = await pipeRequestTo(cwd, childPane, {
      type: 'prompt', id: 'prompt-oneshot', text: 'review it', from: pipeNameFor(parentCwd, 'p_oneshot_parent'),
    });
    assert.equal(prompted.type, 'ok');

    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    const sessDir = join(home, 'sessions', sessionDirName(process.cwd()));
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, '2026-09-22T00-00-00-000Z_oneshot-sess-0001.jsonl'),
      jsonl(
        { type: 'session', id: 'oneshot-sess-0001' },
        transcriptMessage('assistant', 'Verdict: one bug, two nits — details in the report.', Date.now() + 1000),
      ),
    );
    await fire(pi, 'agent_settled', {}, ctx);
    const deadline = setTimeout(() => replyArrived.reject(new Error('settle reply did not arrive within 2s')), 2000);
    deadline.unref?.();
    await replyArrived.promise;
    clearTimeout(deadline);
    // The exit hangs off the push, so the shutdown lands after it: wait (bounded) for the exit.
    for (let i = 0; i < 50 && repliesAtShutdown.length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(repliesAtShutdown, [1], 'the report was already at the parent when the worker asked to exit');
    const reply = replies[0]!;
    assert.ok(reply.type === 'reply', `expected a reply, got ${reply.type}`);
    assert.match(reply.text ?? '', /Verdict: one bug, two nits/);
  } finally {
    parent.close();
    await fire(pi, 'session_shutdown');
  }
}));

/* ── settle without a pipe frame (P2: the first task rides the core, spec S14) ── */

/** A core that answers only what a settle needs: one terminal with a turn, and a document store
 *  that records every write so a test can read what the worker published (spec S6-S8). */
async function mountSettleCore(socketPath: string, turn: number): Promise<{
  docs: Array<{ name: string; value: unknown; version: number }>;
  calls: string[];
  close(): Promise<void>;
}> {
  const docs: Array<{ name: string; value: unknown; version: number }> = [];
  const calls: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const req = JSON.parse(buf.slice(0, idx)) as { id: number; method: string; params: Record<string, unknown> };
      calls.push(req.method);
      let result: unknown = {};
      if (req.method === 'terminal.get') {
        result = { address: req.params.terminal, state: 'live', labels: {}, turn, status: { state: 'idle' } };
      } else if (req.method === 'doc.get') {
        result = { value: null, version: 0 };
      } else if (req.method === 'doc.set') {
        docs.push({ name: String(req.params.name), value: req.params.value, version: Number(req.params.version) });
        result = { version: 1 };
      }
      sock.end(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { docs, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Boots a one-shot worker whose task arrived through the core (no pipe frame armed a request) and
 *  fires one full turn over a session file the test writes. */
async function firePtyTurn(cleanup: CleanupContext, opts: {
  pane: string;
  /** A closing message written BEFORE this turn, this many ms old: a stale report to be ignored. */
  stale?: { text: string; ageMs: number };
  /** The turn's own closing message, stamped when the turn wrote it; null for a turn without words. */
  closing?: string | null;
  /** What this settle should end in: a document (waited for) or nothing at all (a short grace). */
  expect: 'write' | 'silent';
}): Promise<{ docs: Array<{ name: string; value: unknown; version: number }>; calls: string[]; shutdowns: number; pi: FakePi }> {
  const home = cleanup.tempDir(`piher-pty-home-${opts.pane}`).path;
  const cwd = cleanup.tempDir(`piher-pty-ws-${opts.pane}`).path;
  const sockDir = cleanup.tempDir(`piher-pty-sock-${opts.pane}`).path;
  const core = await mountSettleCore(join(sockDir, 'core.sock'), 1);
  const sessionId = `pty-sess-${opts.pane}`;
  const pi = await mountIndex(cleanup, 'worker', {
    HC_TERMINAL_SOCKET: join(sockDir, 'core.sock'),
    HC_TERMINAL_ID: opts.pane,
    PI_CODING_AGENT_DIR: home,
    PI_SESSION_FILE: sessionId,
    PIHER_DELEGATION: JSON.stringify({
      parentPaneId: 'p_parent', parentSessionId: 'aaaa1111', taskId: 't-pty',
      description: 'typed brief', role: 'reviewer', lifecycle: 'one-shot',
    }),
  });
  let shutdowns = 0;
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => [] },
    isIdle: () => true,
    shutdown: () => { shutdowns += 1; },
  };
  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    const sessDir = join(home, 'sessions', sessionDirName(process.cwd()));
    await mkdir(sessDir, { recursive: true });
    const file = join(sessDir, `2026-09-22T00-00-00-000Z_${sessionId}.jsonl`);
    const scrolled = [
      { type: 'session', id: sessionId },
      ...(opts.stale ? [transcriptMessage('assistant', opts.stale.text, Date.now() - opts.stale.ageMs)] : []),
    ];
    await writeFile(file, jsonl(...scrolled));
    // No pipe frame: the master's brief came through `terminal.send` and pi starts the turn itself.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    // The turn's own words are stamped now, after its start — what a real transcript looks like.
    if (opts.closing != null) {
      await writeFile(file, jsonl(...scrolled, transcriptMessage('assistant', opts.closing, Date.now())));
    }
    await fire(pi, 'agent_settled', {}, ctx);
    const deadline = Date.now() + (opts.expect === 'write' ? 2_000 : 150);
    while (Date.now() < deadline && (shutdowns === 0 || core.docs.length === 0)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return { docs: core.docs, calls: core.calls, shutdowns, pi };
  } finally {
    await fire(pi, 'session_shutdown');
    await core.close();
  }
}

test('S54/P2: a one-shot whose brief came through the core still writes its report and exits', withCleanup(async (cleanup) => {
  const pane = 'p_pty_one';
  const result = await firePtyTurn(cleanup, {
    pane,
    closing: 'REPORT: the typed brief was answered.',
    expect: 'write',
  });
  // The document is the delivery for a task with no requester pipe, and the exit waits for it.
  assert.equal(result.docs.length, 1, `one report document, written on the settle (core calls: ${result.calls.join(',')})`);
  const doc = result.docs[0]!;
  assert.equal(doc.name, `piher.rep.${pane}`);
  assert.equal((doc.value as { text?: string }).text, 'REPORT: the typed brief was answered.');
  assert.equal((doc.value as { turn?: number }).turn, 1);
  assert.equal(result.shutdowns, 1, 'the one-shot exited once its report was in the master\'s hands');
}));

test('S54/P2: a settle with no closing words of its own never publishes an older turn\'s report', withCleanup(async (cleanup) => {
  const pane = 'p_pty_two';
  const result = await firePtyTurn(cleanup, {
    pane,
    stale: { text: 'STALE: a report from before this turn.', ageMs: 60_000 },
    closing: null,
    expect: 'silent',
  });
  // The request boundary is this turn's start (no pipe frame armed one), not the beginning of the
  // session: with a zero boundary the stale closing message above would have settled this turn.
  assert.deepEqual(result.docs, [], 'nothing was published, and no stale text was passed off as this turn');
  assert.equal(result.shutdowns, 0, 'a worker with nothing to report does not exit as if it had');
}));

test('a persistent worker settles without exiting', withCleanup(async (cleanup) => {
  const childPane = 'p_persistent_child';
  let shutdowns = 0;
  const pi = await mountIndex(cleanup, 'worker', {
    HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-persistent',
    HC_TERMINAL_ID: childPane,
    PIHER_DELEGATION: JSON.stringify({
      parentPaneId: 'p_parent', parentSessionId: 'aaaa1111', taskId: 't-keep',
      description: 'long task', role: 'worker-default', lifecycle: 'persistent',
    }),
  });
  const ctx = { sessionManager: { getBranch: () => [] }, isIdle: () => true, shutdown: () => { shutdowns += 1; } };
  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 0, 'a persistent worker stays available for the next send');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

/* ── worker marker: delegation identity next to the session file ── */

test('worker session_start writes the restore marker next to its session file', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: undefined, PI_SESSION_ID: undefined });
  const dir = cleanup.tempDir('wmark');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  await fire(pi, 'session_start', { reason: 'new' }, {
    sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path },
    cwd: dir.path,
  });
  assert.equal(existsSync(join(dir.path, 'piher', 'a1b2c3d4', 'worker.json')), true, 'marker keyed by bare session id');
  await fire(pi, 'session_shutdown');
}));

/* ── delegation identity chain (RFC rfc-delegation-identity §2): env > marker > branch fold ── */

const DELEGATION_ENV_JSON = JSON.stringify({
  parentPaneId: 'wD:p1',
  parentSessionId: 'e5f6a7b8',
  taskId: 't-42',
  description: 'harden pipe channel',
  role: 'worker-default',
  lifecycle: 'persistent',
});

/** Fires one before_agent_start and returns the sections map the handler mutated. */
async function delegationSections(pi: FakePi): Promise<Record<string, string>> {
  const sections: Record<string, string> = {};
  await fire(pi, 'before_agent_start', { systemPromptOptions: { sections } });
  return sections;
}

test('worker session_start: delegation env writes the first-frame entry, the prompt section, and the marker', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('delegation-env');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  const pi = await mountIndex(cleanup, 'worker', {
    PI_SESSION_FILE: sessionFile,
    PIHER_DELEGATION: DELEGATION_ENV_JSON,
  });
  const ctx = { sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path } };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  const entry = pi.entries.find(([type]) => type === 'piher.delegation');
  assert.ok(entry, 'first-frame delegation entry written');
  assert.deepEqual(entry![1], { version: 1, parentPaneId: 'wD:p1', parentSessionId: 'e5f6a7b8', taskId: 't-42', description: 'harden pipe channel', role: 'worker-default', lifecycle: 'persistent', ts: (entry![1] as { ts: number }).ts });
  const sections = await delegationSections(pi);
  assert.match(sections['piher-delegation'] ?? '', /delegated subagent of the master pane wD:p1/);
  assert.match(sections['piher-delegation'] ?? '', /Task: harden pipe channel/);
  assert.deepEqual(readWorkerMarker(sessionFile)!.delegation, JSON.parse(DELEGATION_ENV_JSON));
  await fire(pi, 'session_shutdown');
}));

test('restored worker: no env — the marker and the branch entry each re-arm the delegation identity', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('delegation-restore');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  writeWorkerMarker(sessionFile, 'worker-default', JSON.parse(DELEGATION_ENV_JSON));
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: sessionFile });
  await fire(pi, 'session_start', { reason: 'resume' }, {
    sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path },
  });
  assert.match((await delegationSections(pi))['piher-delegation'] ?? '', /master pane wD:p1/, 'marker alone re-arms the section');

  const pi2 = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: sessionFile });
  await mkdir(join(dir.path, 'piher'), { recursive: true });
  await fire(pi2, 'session_start', { reason: 'resume' }, {
    sessionManager: {
      getBranch: () => [{ type: 'custom', customType: 'piher.delegation', data: JSON.parse(DELEGATION_ENV_JSON) }],
      getSessionFile: () => sessionFile,
      getSessionDir: () => dir.path,
    },
  });
  assert.match((await delegationSections(pi2))['piher-delegation'] ?? '', /master pane wD:p1/, 'branch entry alone re-arms the section');
  assert.equal(pi2.entries.filter(([type]) => type === 'piher.delegation').length, 0, 'an existing branch entry is not duplicated');
  await fire(pi, 'session_shutdown');
  await fire(pi2, 'session_shutdown');
}));

test('master and delegation-less workers never grow a piher-delegation section', withCleanup(async (cleanup) => {
  const master = await mountIndex(cleanup, 'master', { PIHER_DELEGATION: DELEGATION_ENV_JSON });
  // mountIndex only clears its baseline keys: unset the delegation env explicitly for the worker mount.
  const worker = await mountIndex(cleanup, 'worker', { PIHER_DELEGATION: undefined });
  try {
    assert.equal('piher-delegation' in (await delegationSections(master)), false, 'master ignores the delegation env');
    await fire(worker, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
    assert.equal('piher-delegation' in (await delegationSections(worker)), false, 'no delegation → no section');
    assert.equal(worker.entries.filter(([type]) => type === 'piher.delegation').length, 0);
  } finally {
    // Shutdown must run even on assertion failure, or the mounted cordis handles hang the runner.
    await fire(master, 'session_shutdown');
    await fire(worker, 'session_shutdown');
  }
}));

/* ── resident widget: the delegation surface the master alone owns ── */

test('widget: follows restored tasks, master renders it alone', withCleanup(async (cleanup) => {
  const cwd = cleanup.tempDir('piher-tree-ws').path;
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const sessionFile = join(cleanup.tempDir('piher-tree-sess').path, '2026-01-01T00-00-00-000Z_dddddddd-0000-4000-8000-000000000000.jsonl');
  seedTaskDocuments(sessionFile, [
    { taskId: 'task-1', paneId: 'w2', slug: 'harden-pipe', description: 'harden pipe channel', kind: 'worker', cwd, createdAt: Date.now() - 120_000 },
    {
      taskId: 'task-2', paneId: 'w3', slug: 'run-e2e', description: 'e2e',
      consumedAt: Date.now() - 60_000, cwd,
    },
  ]);
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const master = await mountIndex(cleanup, 'master', { HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-tree', HC_TERMINAL_ID: 't1' });
  try {
    const ctx = {
      cwd,
      ui: { setWidget: (id: string, lines: string[] | undefined) => { widgets.push({ id, lines }); } },
      sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile },
    };
    await fire(master, 'session_start', { reason: 'new' }, ctx);
    // A fresh session starts with an empty registry and pi restores widget state on resume (calling
    // setWidget there breaks pi's '/' command panel), so startup paints nothing and says so by
    // removing the widget rather than by leaving an empty one behind.
    assert.equal(widgets.at(-1)?.id, 'piher-agents', 'the widget keeps its pi key (a rename would orphan the old one)');
    assert.equal(widgets.at(-1)?.lines, undefined, 'a fresh session carries no agent widget');

    // The tasks are restored at session_start; the widget is a view of them, so the first turn
    // boundary is where the running children appear. One line per RUNNING worker: a settled row is
    // history, and history belongs to the tree.
    await fire(master, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    assert.equal(widgets.at(-1)?.id, 'piher-agents');
    assert.deepEqual(
      widgets.at(-1)?.lines,
      ['↳ harden-pipe (w2) · worker · running · 2m'],
      'the widget carries the running worker only, with its role, state and elapsed time',
    );

    // No delegation tree command: the widget is the only delegation surface now.
    assert.ok(!master.commands.has('piher-tree'), 'no piher-tree command is registered');

    // A settlement (pipe reply → consumed row) takes the widget down at the next settle.
    const reply = await pipeRequestTo(cwd, 't1', { type: 'reply', id: 'reply-tree', paneId: 'w2', text: 'done', sessionFile: null });
    assert.equal(reply.type, 'ok');
    await fire(master, 'agent_settled', {}, ctx);
    // Nothing runs any more, so the strip is removed rather than left as an empty widget (pi keeps an
    // empty array on screen as a stray blank line; undefined is how a widget is taken down).
    assert.equal(widgets.at(-1)?.lines, undefined, 'an idle master carries no agent widget');
  } finally {
    await fire(master, 'session_shutdown');
  }
}));

test('widget: a bare or worker pane never sets one (no delegation surface to show)', async (t) => {
  for (const mode of ['bare', 'worker'] as const) {
    await t.test(mode, withCleanup(async (cleanup) => {
      const widgets: string[] = [];
      const pi = await mountIndex(cleanup, mode);
      const ctx = { sessionManager: { getBranch: () => [] }, ui: { setWidget: (id: string) => { widgets.push(id); } } };
      await fire(pi, 'session_start', { reason: 'new' }, ctx);
      await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
      await fire(pi, 'agent_settled', {}, ctx);
      await fire(pi, 'session_shutdown');
      assert.deepEqual(widgets, [], `${mode} never sets the agent widget`);
    }));
  }
});

test('widget cap: overflow still renders one honest widget', withCleanup(async (cleanup) => {
  const cwd = cleanup.tempDir('piher-cap-ws').path;
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const sessionFile = join(cleanup.tempDir('piher-cap-sess').path, '2026-01-01T00-00-00-000Z_eeeeeeee-0000-4000-8000-000000000000.jsonl');
  seedTaskDocuments(sessionFile, Array.from({ length: WIDGET_MAX_LINES + 2 }, (_, i) => ({
    taskId: `cap-task-${i}`, paneId: `w${i}`, slug: `task-${i}`, description: `task ${i}`, cwd,
  })));
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const master = await mountIndex(cleanup, 'master', { HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-cap', HC_TERMINAL_ID: 't1' });
  try {
    const ctx = {
      cwd,
      ui: { setWidget: (id: string, lines: string[] | undefined) => { widgets.push({ id, lines }); } },
      sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile },
    };
    await fire(master, 'session_start', { reason: 'new' }, ctx);
    // The tasks are restored at session_start; the widget paints at the first turn boundary.
    await fire(master, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    const lines = widgets.at(-1)?.lines ?? [];
    // pi slices a string-array widget to ten lines and appends its own `... (widget truncated)`,
    // so piher must hand over at most ten — tail included — or the fold hint is what gets cut.
    assert.equal(lines.length, WIDGET_MAX_LINES, 'the widget never exceeds pi’s line budget');
    assert.equal(lines.at(-1), '…+3 more subagents · subagent list', 'the tail names it');

    // The folded rows stay reachable through the action the tail names.
    assert.ok(!master.commands.has('piher-tree'), 'no tree command takes over the overflow');
  } finally {
    await fire(master, 'session_shutdown');
  }
}));

/* ── P1: the worker writes its report document on every settle (spec S6, S8) ── */

interface DocCall { method: string; params: Record<string, unknown> }

/** A core socket that answers the calls a worker's settle makes, recording them in order. */
async function withWorkerCore(
  /** A timeline shared with the caller's own channel, so a test can assert which request landed
   *  first across the core socket and the pipe — exactly what findings 1 and 4 are about. */
  order: string[],
  body: (socketPath: string, calls: DocCall[]) => Promise<void>,
): Promise<void> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'piher-worker-core-')), 's.sock');
  const calls: DocCall[] = [];
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const req = JSON.parse(buf.slice(0, idx)) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: req.method, params: req.params });
      order.push(req.method);
      const result = req.method === 'terminal.get'
        ? { address: 't2', turn: 2, state: 'live', cwd: '/w', labels: {} }
        : req.method === 'doc.get' ? { value: null, version: 0 }
          : req.method === 'doc.set' ? { version: 1 }
            : {};
      sock.end(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
    });
  });
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  server.listen(socketPath, resolve);
  await listening;
  try {
    await body(socketPath, calls);
  } finally {
    server.close();
    if (process.platform !== 'win32') rmSync(dirname(socketPath), { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('worker settle: the report document is written with no request pending, stating the reason when there are no words', withCleanup(async (cleanup) => {
  const agentDir = cleanup.tempDir('piher-worker-agent').path;
  const cwd = cleanup.tempDir('piher-worker-cwd').path;
  const sessionFile = join(agentDir, '2026-01-01T00-00-00-000Z_ffffffff-0000-4000-8000-000000000000.jsonl');
  await withWorkerCore([], async (socketPath, calls) => {
    const pi = await mountIndex(cleanup, 'core-worker', {
      HC_TERMINAL_SOCKET: socketPath,
      HC_TERMINAL_ID: 't2',
      PI_CODING_AGENT_DIR: agentDir,
      PI_SESSION_FILE: sessionFile,
      PIHER_DELEGATION: JSON.stringify({ taskId: 'task-doc-worker', description: 'doc worker', role: 'worker' }),
    });
    const ctx = { cwd, sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile } };
    try {
      await fire(pi, 'session_start', { reason: 'new' }, ctx);
      await fire(pi, 'turn_start');
      // A refused tool and an ended turn with no words, written by the turn itself (after its start):
      // the diagnosis, not the stop word, is the report.
      writeFileSync(sessionFile, jsonl(
        transcriptMessage('toolResult', 'Error: role "worker" does not permit tool "bash"', Date.now(), 'stop'),
        { type: 'message', message: { role: 'assistant', content: [], timestamp: Date.now(), stopReason: 'stop' } },
      ));
      await fire(pi, 'agent_settled', {}, ctx);
      // No request is pending here (S6): the write is off the settle's critical path, so the test
      // waits for it instead of assuming it already landed.
      await waitFor(() => calls.some((c) => c.method === 'doc.set'));

      const writes = calls.filter((c) => c.method === 'doc.set');
      assert.equal(writes.length, 1, `the settle writes one report document: ${JSON.stringify(calls.map((c) => c.method))}`);
      assert.equal(writes[0]!.params.name, 'piher.rep.t2', 'the document is named after the worker address (S9)');
      const value = writes[0]!.params.value as { taskId: string; turn: number; stopReason: string; text: string | null };
      assert.equal(value.taskId, 'task-doc-worker', 'the task id travels inside the value (S3)');
      assert.equal(value.turn, 2, 'the turn comes from the core record');
      assert.equal(value.text, null);
      assert.match(value.stopReason, /does not permit `bash`/,
        'a turn with no words states the reason, not the stop word (S8)');
      assert.equal(writes[0]!.params.version, 0, 'the write is compare-and-swap against the read version (S11)');
    } finally {
      await fire(pi, 'session_shutdown');
    }
  });
}));

test('worker settle: a one-shot worker waits for its document write before shutting down', withCleanup(async (cleanup) => {
  const agentDir = cleanup.tempDir('piher-oneshot-agent').path;
  // The worker's pipe is derived from its cwd, so the harness owns a checkout of its own.
  const cwd = cleanup.tempDir('piher-oneshot-cwd').path;
  const sessionFile = join(agentDir, '2026-01-01T00-00-00-000Z_bbbbbbbb-0000-4000-8000-000000000000.jsonl');
  const masterPipe = pipeNameFor(cwd, 'tm');
  const replies: PipeRequest[] = [];
  const order: string[] = [];
  const master = startPipeServer(masterPipe, async (req) => {
    replies.push(req);
    order.push(req.type);
    return { type: 'ok', id: req.id };
  });
  await new Promise<void>((resolve) => master.once('listening', resolve));
  try {
    await withWorkerCore(order, async (socketPath, calls) => {
      const pi = await mountIndex(cleanup, 'core-worker', {
        HC_TERMINAL_SOCKET: socketPath,
        HC_TERMINAL_ID: 't2',
        PI_CODING_AGENT_DIR: agentDir,
        PI_SESSION_FILE: sessionFile,
        PIHER_DELEGATION: JSON.stringify({
          taskId: 'task-one-shot', description: 'one-shot worker', role: 'worker', lifecycle: 'one-shot',
        }),
      });
      const shutdowns: string[] = [];
      const ctx = {
        cwd,
        shutdown: () => { shutdowns.push(calls.map((c) => c.method).join(',')); },
        sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile },
      };
      try {
        await fire(pi, 'session_start', { reason: 'new' }, ctx);
        // A master request over the worker's pipe: the settle push has somewhere to go, which is what
        // S54 hangs the one-shot exit off.
        let prompted: PipeResponse | null = null;
        const deadline = Date.now() + 5_000;
        while (prompted === null && Date.now() < deadline) {
          prompted = await pipeRequestTo(cwd, 't2', { type: 'prompt', id: 'pr-1', text: 'do the thing', from: masterPipe }, 1_000)
            .catch(() => null);
        }
        assert.equal(prompted?.type, 'ok', 'the worker served its pipe prompt');
        // The transcript is written inside the request boundary, so the settle has words to deliver.
        writeFileSync(sessionFile, jsonl(transcriptMessage('assistant', 'REPORT: one-shot done', Date.now())));

        await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
        await fire(pi, 'agent_settled', {}, ctx);
        await waitFor(() => shutdowns.length === 1);
        assert.equal(shutdowns.length, 1, 'the one-shot worker exits once its report is out');
        assert.match(shutdowns[0]!, /doc\.set/, 'the document write completed before the shutdown');
        const reply = replies.find((r) => r.type === 'reply');
        assert.ok(reply, 'the pipe push went out too');
        const value = calls.find((c) => c.method === 'doc.set')!.params.value as { text: string | null; at: number };
        assert.equal(value.text, 'REPORT: one-shot done');
        // The document is on disk BEFORE the reply leaves the worker: the master reclaims a
        // one-shot worker's pane as soon as it handles that reply, so a write still in flight would be
        // cut short and the durable document S6/S12 rely on would never exist (finding 4).
        const setAt = order.indexOf('doc.set');
        const replyAt = order.indexOf('reply');
        assert.ok(setAt >= 0, 'the document was written');
        assert.ok(setAt < replyAt, `doc.set (${setAt}) precedes the reply (${replyAt}): ${order.join(',')}`);
        // The reply names the very document it settles, which is how the master records the delivery
        // as an identity instead of comparing its own clock with the worker's (spec S7).
        assert.equal((reply as { docAt?: number }).docAt, value.at,
          'the reply carries the settlement document identity');
      } finally {
        await fire(pi, 'session_shutdown');
      }
    });
  } finally {
    await new Promise<void>((resolve) => master.close(() => resolve()));
    if (process.platform !== 'win32') rmSync(pipePathFor(masterPipe), { force: true });
  }
}));

/* ── P3: a send reaches the worker as a command document (spec S15, S23, S24) ── */

interface DocCall { method: string; params: Record<string, unknown> }

/** A core socket that answers a worker's calls and can notify it: documents live here, and a
 *  successful write is announced to every `events.subscribe` connection, the way the core does. */
async function withDocCore(
  body: (core: {
    socketPath: string;
    calls: DocCall[];
    /** Connections that subscribed, with their params and a way to notify them. */
    subscriptions: Array<{ params: Record<string, unknown>; notify: (name: string, version: number) => void }>;
    /** The master's side of a write: store the value and emit the `doc` event it causes (S23). */
    write: (name: string, value: unknown) => number;
    /** Read a document as the test sees it, version included. */
    read: (name: string) => { value: unknown; version: number } | undefined;
  }) => Promise<void>,
): Promise<void> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'piher-doc-core-')), 's.sock');
  const calls: DocCall[] = [];
  const docs = new Map<string, { value: unknown; version: number }>();
  const subscriptions: Array<{ params: Record<string, unknown>; notify: (name: string, version: number) => void }> = [];
  const live = new Set<(line: string) => void>();
  const notifyAll = (name: string, version: number): void => {
    for (const sub of subscriptions) sub.notify(name, version);
  };
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    let seq = 0;
    const subscription = (params: Record<string, unknown>): { params: Record<string, unknown>; notify: (name: string, version: number) => void } => {
      const entry = {
        params,
        notify: (name: string, version: number): void => {
          seq += 1;
          // The measured notification payload (hc 0.1.20): the name and the version, never the value.
          sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq, type: 'doc', data: { name, version } } })}\n`);
        },
      };
      subscriptions.push(entry);
      // A subscriber that closed its connection (the worker's session_shutdown does) is gone: nothing
      // is notified on a dead socket.
      sock.on('close', () => {
        const at = subscriptions.indexOf(entry);
        if (at >= 0) subscriptions.splice(at, 1);
      });
      return entry;
    };
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, idx)) as { id: number; method: string; params: Record<string, unknown> };
        buf = buf.slice(idx + 1);
        calls.push({ method: req.method, params: req.params });
        if (req.method === 'events.subscribe') {
          // No filters can be asserted here: only an unfiltered subscription carries `doc` events.
          subscription(req.params);
          // `channel: null` is plain mode: this connection now carries only notifications (S24).
          sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { channel: null, seq: 0, terminals: [] } })}\n`);
          continue;
        }
        let result: Record<string, unknown> = {};
        if (req.method === 'terminal.get') {
          result = { address: 't2', turn: 1, state: 'live', cwd: '/w', labels: {} };
        } else if (req.method === 'doc.get') {
          const held = docs.get(String(req.params.name));
          result = { value: held?.value ?? null, version: held?.version ?? 0 };
        } else if (req.method === 'doc.set') {
          const name = String(req.params.name);
          const current = docs.get(name)?.version ?? 0;
          if (current !== Number(req.params.version)) {
            sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'conflict', data: { kind: 'conflict' } } })}\n`);
            continue;
          }
          const version = current + 1;
          docs.set(name, { value: req.params.value, version });
          result = { version };
          sock.end(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
          notifyAll(name, version);
          continue;
        }
        sock.end(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
      }
    });
    live.add((line) => sock.write(line));
  });
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  server.listen(socketPath, resolve);
  await listening;
  try {
    await body({
      socketPath,
      calls,
      subscriptions,
      write: (name, value) => {
        const version = (docs.get(name)?.version ?? 0) + 1;
        docs.set(name, { value, version });
        notifyAll(name, version);
        return version;
      },
      read: (name) => docs.get(name),
    });
  } finally {
    server.close();
    if (process.platform !== 'win32') rmSync(dirname(socketPath), { recursive: true, force: true });
  }
}

test('P3: a send steers the worker while its tool call is in flight, through its own document watch', withCleanup(async (cleanup) => {
  const agentDir = cleanup.tempDir('piher-steer-agent').path;
  const cwd = cleanup.tempDir('piher-steer-cwd').path;
  const sessionFile = join(agentDir, '2026-01-01T00-00-00-000Z_cccccccc-0000-4000-8000-000000000000.jsonl');
  await withDocCore(async (core) => {
    const pi = await mountIndex(cleanup, 'core-worker', {
      HC_TERMINAL_SOCKET: core.socketPath,
      HC_TERMINAL_ID: 't2',
      PI_CODING_AGENT_DIR: agentDir,
      PI_SESSION_FILE: sessionFile,
      PIHER_DELEGATION: JSON.stringify({ taskId: 'task-steer', description: 'steer worker', role: 'worker' }),
    });
    const ctx = { cwd, sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile } };
    try {
      await fire(pi, 'session_start', { reason: 'new' }, ctx);
      await waitFor(() => core.subscriptions.length === 1);
      assert.equal(core.subscriptions.length, 1, 'the worker holds one document subscription');
      // S24/S23: the subscription is unfiltered, and it is a connection of its own — a scoped one
      // never sees a `doc` event, and the subscription carries only notifications.
      assert.deepEqual(core.subscriptions[0]!.params, {}, 'the subscription carries no filter');
      assert.ok(core.calls.some((c) => c.method === 'events.subscribe'), 'subscribed over the core socket');

      // The master sends while the worker is mid-tool-call.
      await fire(pi, 'turn_start');
      await fire(pi, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash' });
      const version = core.write('piher.cmd.t2', {
        id: 'cmd-1', type: 'follow_up', text: 'stop and report what you have', deliverAs: 'steer',
      });
      assert.equal(version, 1);

      await waitFor(() => pi.userSent.length === 1);
      assert.equal(pi.userSent.length, 1, 'the command reached pi while the tool call was in flight');
      // S15: pi's own steering mode is what puts it at the next tool gap; the turn had not ended here
      // (no tool_execution_end, no agent_settled), so nothing waited for the turn to finish.
      assert.deepEqual(pi.userSent[0], {
        content: 'stop and report what you have',
        opts: { deliverAs: 'steer', triggerTurn: true },
      });
      // S11: the worker clears what it applied, guarded by the version it read — a command left
      // behind would be applied again by a restarted worker, which has no memory of ids.
      await waitFor(() => core.read('piher.cmd.t2')?.value === null);
      assert.equal(core.read('piher.cmd.t2')?.value, null, 'the applied command is cleared');
      assert.equal(core.read('piher.cmd.t2')?.version, 2, 'the clear is compare-and-swap, not an overwrite');
      const clears = core.calls.filter((c) => c.method === 'doc.set' && c.params.value === null);
      assert.equal(clears.length, 1, 'one CAS clear');
      assert.equal(clears[0]!.params.version, 1, 'cleared against the version it read');

      // A repeat notification for the same (now cleared) document applies nothing twice.
      core.subscriptions[0]!.notify('piher.cmd.t2', 2);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(pi.userSent.length, 1, 'a re-read never applies the same command twice');

      // Another document's event is not ours: documents are core-global, so the watch sees them all.
      core.write('piher.cmd.t9', { id: 'cmd-other', type: 'follow_up', text: 'not for me', deliverAs: 'steer' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(pi.userSent.length, 1, 'another worker’s command is ignored');

      // A value that is not a command is never handed to pi (a foreign or half-written document).
      core.write('piher.cmd.t2', { text: 'no id, no deliverAs' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(pi.userSent.length, 1, 'a value that is not a command is not applied');

      // A second command after the first is applied again — the id, not the position, is the identity.
      core.write('piher.cmd.t2', {
        id: 'cmd-2', type: 'follow_up', text: 'now summarize', deliverAs: 'followUp',
      });
      await waitFor(() => pi.userSent.length === 2);
      assert.deepEqual(pi.userSent[1], { content: 'now summarize', opts: { deliverAs: 'followUp', triggerTurn: true } });

      // The subscription dies with the session: nothing is left watching the core.
      await fire(pi, 'session_shutdown');
      await waitFor(() => core.subscriptions.length === 0);
      assert.equal(core.subscriptions.length, 0, 'the session closed its subscription');
      const before = core.calls.length;
      core.write('piher.cmd.t2', { id: 'cmd-3', type: 'follow_up', text: 'after shutdown', deliverAs: 'steer' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(pi.userSent.length, 2, 'no command is applied after the session ends');
      assert.equal(core.calls.length, before, 'the closed watch stops reading the core');
    } finally {
      await fire(pi, 'session_shutdown');
    }
  });
}));
