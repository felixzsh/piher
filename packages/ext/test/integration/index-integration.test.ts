/**
 * index.ts composition root: process-mode mounting and the session lifecycle (notice buffering).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import extension from '../../src/index.ts';
import { pipeNameFor, pipeRequestTo, startPipeServer, type PipeRequest } from '../../src/pipe-channel.ts';
import { sessionDirName } from '../../src/storage-layout.ts';
import { WIDGET_MAX_LINES } from '../../src/tree-view.ts';
import { fakePi, fire, jsonl, subEntry, transcriptMessage, withCleanup, type CleanupContext, type FakePi } from '../test-utils.ts';
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

test('index core master: mounts subagent + bg_job + the four piher commands', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'master');
  try {
    for (const tool of ['subagent', 'bg_job']) assert.ok(pi.tools.has(tool), `core master mounts ${tool}`);
    assert.deepEqual([...pi.commands.keys()].sort(),
      ['piher-config', 'piher-locks', 'piher-role', 'piher-tree'],
      'the master mounts exactly the four piher commands');
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

/* ── resident widget + /piher-tree: the delegation surface the master alone owns ── */

test('widget + /piher-tree: both follow the subagent registry, and only the master renders either', withCleanup(async (cleanup) => {
  const cwd = cleanup.tempDir('piher-tree-ws').path;
  const branch = [
    { type: 'custom', customType: 'piher.subs', data: { version: 2, subs: [
      subEntry({ paneId: 'w2', slug: 'harden-pipe', description: 'harden pipe channel', kind: 'worker', createdAt: Date.now() - 120_000 }),
      subEntry({ taskId: 'task-2', paneId: 'w3', slug: 'run-e2e', description: 'e2e', status: 'settled', consumedAt: Date.now() - 60_000 }),
    ] } },
  ];
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const master = await mountIndex(cleanup, 'master', { HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-tree', HC_TERMINAL_ID: 't1' });
  try {
    const ctx = {
      cwd,
      ui: { setWidget: (id: string, lines: string[] | undefined) => { widgets.push({ id, lines }); } },
      sessionManager: { getBranch: () => branch },
    };
    await fire(master, 'session_start', { reason: 'new' }, ctx);
    // A fresh session starts with an empty registry and pi restores widget state on resume (calling
    // setWidget there breaks pi's '/' command panel), so startup paints nothing and says so by
    // removing the widget rather than by leaving an empty one behind.
    assert.equal(widgets.at(-1)?.id, 'piher-agents', 'the widget keeps its pi key (a rename would orphan the old one)');
    assert.equal(widgets.at(-1)?.lines, undefined, 'a fresh session carries no agent widget');

    // The registry is folded at session_start; the widget is a view of it, so the first turn
    // boundary is where the running children appear. One line per RUNNING worker: a settled row is
    // history, and history belongs to the tree.
    await fire(master, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    assert.equal(widgets.at(-1)?.id, 'piher-agents');
    assert.deepEqual(
      widgets.at(-1)?.lines,
      ['↳ harden-pipe (w2) · worker · running · 2m'],
      'the widget carries the running worker only, with its role, state and elapsed time',
    );

    // /piher-tree without ui.custom (RPC mode) degrades to one notify call carrying the same tree.
    const tree = master.commands.get('piher-tree');
    assert.ok(tree?.handler, '/piher-tree registers on the master');
    const notified: string[] = [];
    await (tree!.handler as (args: unknown, ctx: unknown) => Promise<void>)([], { ui: { notify: (t: string) => { notified.push(t); } } });
    const text = notified.join('\n');
    assert.match(text, /Delegation tree · 1 running · 1 settled/);
    assert.match(text, /● master \(this pane\)/);
    assert.match(text, /↳ harden-pipe \(w2 · running · worker\)/);
    assert.match(text, /✓ run-e2e \(w3 · settled \d+m ago\)/);

    // With ui.custom it opens as an overlay inside pi; a settlement repaints it without a reopen.
    type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => { render(w: number): string[]; handleInput(d: string): void };
    const opened: { factory?: Factory } = {};
    const { promise: closed, resolve: close } = Promise.withResolvers<unknown>();
    let repaints = 0;
    const opening = (tree!.handler as (args: unknown, ctx: unknown) => Promise<void>)('', {
      ui: { custom: (f: Factory) => { opened.factory = f; return closed; } },
    });
    assert.ok(opened.factory, '/piher-tree opens a ui.custom component');
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const view = opened.factory({ requestRender: () => { repaints += 1; } }, theme, undefined, close);
    assert.ok(view.render(100).some((line) => line.includes('harden-pipe')), 'the overlay renders the running worker');

    // A settlement (pipe reply → consumed row) reaches the open overlay at the next settle.
    const reply = await pipeRequestTo(cwd, 't1', { type: 'reply', id: 'reply-tree', paneId: 'w2', text: 'done', sessionFile: null });
    assert.equal(reply.type, 'ok');
    await fire(master, 'agent_settled', {}, ctx);
    assert.ok(repaints > 0, 'the settlement asks the open overlay to repaint');
    const after = view.render(100);
    assert.ok(after.some((line) => line.includes('Delegation tree · 0 running · 2 settled')), `repaint shows both settlements: ${JSON.stringify(after)}`);
    assert.ok(after.some((line) => line.includes('✓ harden-pipe')), 'the consumed row moves to the settled nodes');
    // Nothing runs any more, so the strip is removed rather than left as an empty widget (pi keeps an
    // empty array on screen as a stray blank line; undefined is how a widget is taken down).
    assert.equal(widgets.at(-1)?.lines, undefined, 'an idle master carries no agent widget');
    view.handleInput('\x1b');
    await opening;
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

test('widget cap + overlay scroll: more workers than the budget still renders one honest widget', withCleanup(async (cleanup) => {
  const cwd = cleanup.tempDir('piher-cap-ws').path;
  const branch = [
    { type: 'custom', customType: 'piher.subs', data: { version: 2, subs:
      Array.from({ length: WIDGET_MAX_LINES + 2 }, (_, i) => subEntry({ paneId: `w${i}`, slug: `task-${i}`, description: `task ${i}` })),
    } },
  ];
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const master = await mountIndex(cleanup, 'master', { HC_TERMINAL_SOCKET: '/tmp/piher-test-sock-cap', HC_TERMINAL_ID: 't1' });
  try {
    const ctx = {
      cwd,
      ui: { setWidget: (id: string, lines: string[] | undefined) => { widgets.push({ id, lines }); } },
      sessionManager: { getBranch: () => branch },
    };
    await fire(master, 'session_start', { reason: 'new' }, ctx);
    // The registry is folded at session_start; the widget paints at the first turn boundary.
    await fire(master, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    const lines = widgets.at(-1)?.lines ?? [];
    // pi slices a string-array widget to ten lines and appends its own `... (widget truncated)`,
    // so piher must hand over at most ten — tail included — or the fold hint is what gets cut.
    assert.equal(lines.length, WIDGET_MAX_LINES, 'the widget never exceeds pi’s line budget');
    assert.equal(lines.at(-1), `…+3 more subagents · /piher-tree`, 'and the tail names the exact remainder');

    // The tree still holds every worker, which is where the folded rows remain reachable.
    const tree = master.commands.get('piher-tree')!;
    type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => { render(w: number): string[]; handleInput(d: string): void };
    const opened: { factory?: Factory } = {};
    const { promise: closed, resolve: close } = Promise.withResolvers<unknown>();
    let repaints = 0;
    const opening = (tree.handler as (args: unknown, ctx: unknown) => Promise<void>)('', {
      ui: { custom: (f: Factory) => { opened.factory = f; return closed; } },
    });
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const view = opened.factory!({ requestRender: () => { repaints += 1; } }, theme, undefined, close);
    const first = view.render(100);
    // The overlay is fed by the whole registry, so the rows the widget folded are all still reachable
    // here (the viewport clips, the count in the header does not).
    assert.ok(first.some((line) => line.includes(`Delegation tree · ${WIDGET_MAX_LINES + 2} running · 0 settled`)), JSON.stringify(first));
    assert.ok(first.some((line) => line.includes('↑↓ scroll · esc close')), 'the overlay keeps its key hint');
    const before = repaints;
    view.handleInput('j');
    assert.ok(repaints > before, 'a scroll key repaints the overlay');
    view.handleInput('\x1b');
    await opening;
  } finally {
    await fire(master, 'session_shutdown');
  }
}));
