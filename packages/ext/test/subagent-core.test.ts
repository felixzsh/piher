/** Subagent domain units: pure planners and notices (launch line, validation, tab placement,
 * readiness, liveness, task-id resolution) plus plugin wiring. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisposeLedger } from '../src/ledger.ts';
import { appendLedger, readLedger, type HistoryEntry } from '../src/history-store.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountSubagent, runSubagent, runSubagentRejects, subEntry, terminalInfo } from './test-utils.ts';
import {
  MAIN_TAB_NAME, SUBS_CUSTOM_TYPE, SUBS_REGISTRY_TAIL, TAB_NAME_MAX, Semaphore, agoText, buildAliveNotice, buildBlockedGateNotice,
  allocateSubSlug, registrySnapshot, slugifyTask, subRef,
  attachSubagentStructuredContent, buildLaunchLine, buildLaunchParts, entryScript, formatRoleCatalog, classifyWorktreeZone, foldSubsRegistry, formatSpawnFailure, isAlive,
  rekeySub, planLaunchValidation, planTabPlacement, resolveTaskIdPrefix,
  flattenToolParams, idParam, sleepWhileSubsRunningNote, tabNameForTask, type AliveProbe, type SubEntry,
} from '../src/subagent-core.ts';
import { planReadyAttempt, readyBackoffMs, readyFailureText } from '../src/subagent-spawn.ts';

const RT = { nodePath: '/usr/local/bin/node', cliPath: '/opt/pi/dist/cli.js', extPath: '/ext/index.ts' };

/** [case, command, running workers, note expected] */
const SLEEP_NOTE_CASES: Array<[string, string, number, boolean]> = [
  ['a long sleep while a worker runs', 'sleep 120; echo waited', 1, true],
  ['the longest of several sleeps counts', 'sleep 5 && make && sleep 300', 1, true],
  ['an `s` suffix is still seconds', 'cd x && sleep 90s; tail log', 2, true],
  ['exactly the threshold', 'sleep 60', 1, true],
  ['a short poll is left alone', 'sleep 30; tail -5 build.log', 1, false],
  ['no background worker → no note', 'sleep 840', 0, false],
  ['a minute suffix is not misread as seconds', 'sleep 2m', 1, false],
  ['a word containing sleep is not a sleep', 'grep nosleep 600 x', 1, false],
];

test('sleepWhileSubsRunningNote: long sleeps while background workers run get the auto-notice reminder', () => {
  for (const [name, command, workers, expected] of SLEEP_NOTE_CASES) {
    const running = Array.from({ length: workers }, (_, i) => ({ paneId: `p${i}`, slug: `task-${i}` }));
    const note = sleepWhileSubsRunningNote(command, running);
    assert.equal(note !== null, expected, name);
    if (note) assert.ok(note.includes('task-0@p0') && /arrives automatically/.test(note), name);
  }
});

test('foldSubsRegistry: a persisted report delivery survives the fold; a malformed one is dropped', () => {
  const row = (reportDelivered: unknown) => ({ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [{ paneId: 'p1', reportDelivered }] } });
  assert.deepEqual(foldSubsRegistry([row({ fingerprint: 'tail', at: 5 })]).subs[0]!.reportDelivered, { fingerprint: 'tail', at: 5 });
  assert.equal(foldSubsRegistry([row({ fingerprint: 3 })]).subs[0]!.reportDelivered, undefined);
});

test('buildLaunchLine: win32 uses PowerShell & syntax, POSIX starts via sh', () => {
  const parts = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  const posix = `'/usr/local/bin/node' '/opt/pi/dist/cli.js' '-e' '/ext/index.ts'`;
  assert.equal(buildLaunchLine(parts, 'win32'), `& ${posix}`);
  assert.equal(buildLaunchLine(parts, 'darwin'), posix);
  assert.equal(buildLaunchLine(parts, 'linux'), buildLaunchLine(parts, 'darwin'));
  // A quoted path stays a single literal under both syntaxes.
  assert.equal(buildLaunchLine(["it's a path"], 'darwin'), `'it'\\''s a path'`);
  assert.equal(buildLaunchLine(["it's a path"], 'win32'), `& 'it''s a path'`);
});

test('flattenToolParams: nested parameters fill missing top-level ids and do not override them', () => {
  const flat = flattenToolParams({ action: 'output', parameters: { agentId: 'wA:p3Z', max_chars: 5000 } });
  assert.equal(flat?.agentId, 'wA:p3Z');
  assert.equal(flat?.max_chars, 5000);
  assert.equal(idParam(flat, 'agentId', 'taskId'), 'wA:p3Z');
  assert.equal(idParam({ action: 'output', parameters: { agentId: 'wA:p3Z' } }, 'agentId'), 'wA:p3Z');
  assert.equal(flattenToolParams({ agentId: 'top', parameters: { agentId: 'nested' } })?.agentId, 'top');
});

test('buildLaunchParts: a compiled binary is not named twice (a duplicate becomes the first prompt)', () => {
  const binary = { nodePath: '/$bunfs/root/pi', cliPath: '/$bunfs/root/pi', extPath: '/ext/index.ts' };
  const parts = buildLaunchParts(binary, {}, { PIHER_TUI: 'regular' });
  assert.equal(parts[0], '/$bunfs/root/pi');
  assert.equal(parts[1], '-e', 'the entrypoint appears once, then the flags');
  assert.equal(parts.filter((part) => part === '/$bunfs/root/pi').length, 1);
  // An interpreter still needs its script.
  const script = { nodePath: '/usr/bin/node', cliPath: '/opt/pi/cli.js', extPath: '/ext/index.ts' };
  assert.deepEqual(buildLaunchParts(script, {}, { PIHER_TUI: 'regular' }).slice(0, 2), ['/usr/bin/node', '/opt/pi/cli.js']);
  // A binary with no script at all (argv[1] missing) must not become an empty argument.
  const bare = { nodePath: '/$bunfs/root/pi', cliPath: '', extPath: '/ext/index.ts' };
  assert.equal(buildLaunchParts(bare, {}, { PIHER_TUI: 'regular' })[1], '-e');
});

test('entryScript: an embedded bun path is not a script, a real file is', () => {
  // A compiled pi reports argv[1] as /$bunfs/root/pi, which no filesystem has. Passing it made it the
  // worker's first prompt: the child greeted "/$bunfs/root/pi" and then answered its real task, so
  // the launch looked like the message was injected twice.
  // The predicate lies inside a compiled binary: bun's fs answers for its own virtual root. The rule
  // must not ask it.
  assert.equal(entryScript('/$bunfs/root/pi', () => true), '');
  assert.equal(entryScript('/bunfs/root/pi', () => true), '');
  assert.equal(entryScript('B:\\~BUN\\root\\pi', () => true), '');
  assert.equal(entryScript('/opt/pi/cli.js', () => true), '/opt/pi/cli.js');
  assert.equal(entryScript('/opt/gone/cli.js', () => false), '');
  assert.equal(entryScript(undefined, () => true), '');
  assert.equal(entryScript('', () => true), '');
  // With no script, the relaunch line carries no positional prompt at all.
  const parts = buildLaunchParts(
    { nodePath: '/bin/pi', cliPath: entryScript('/$bunfs/root/pi', () => false), extPath: '/e.ts' },
    {},
    { PIHER_TUI: 'regular' },
  );
  assert.deepEqual(parts, ['/bin/pi', '-e', '/e.ts']);
});

test('buildLaunchParts: fullscreen TUI by default (static frames); PIHER_TUI=regular opts out', () => {
  const base = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  assert.deepEqual(buildLaunchParts(RT, {}, {}), [...base, '--tui-mode', 'fullscreen']);
  assert.deepEqual(buildLaunchParts(RT, {}, { PIHER_TUI: 'regular' }), base);
  assert.deepEqual(buildLaunchParts(RT, { approve: true, roleModel: 'zai/glm-4.7', resumeFile: '/s.jsonl' }, {}), [
    '/usr/local/bin/node', '/opt/pi/dist/cli.js', '-a', '-e', '/ext/index.ts',
    '--tui-mode', 'fullscreen', '--provider', 'zai', '--model', 'glm-4.7', '--session', '/s.jsonl',
  ]);
});

test('buildLaunchParts: the role thinking level rides the argv, right after its model', () => {
  assert.deepEqual(buildLaunchParts(RT, { roleModel: 'opencode-go/deepseek-v4.1-flash', roleThinking: 'high' }, {}), [
    '/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts',
    '--tui-mode', 'fullscreen', '--provider', 'opencode-go', '--model', 'deepseek-v4.1-flash', '--thinking', 'high',
  ]);
  // A role without a thinking level inherits the process default: no flag at all.
  assert.deepEqual(buildLaunchParts(RT, { roleModel: 'zai/glm-4.7' }, {}).includes('--thinking'), false);
  assert.deepEqual(buildLaunchParts(RT, { roleThinking: 'low' }, {}).includes('--thinking'), true);
});

test('buildLaunchParts: the provider is split off at the first "/" only', () => {
  const modelArgs = (roleModel: string) => {
    const parts = buildLaunchParts(RT, { roleModel }, { PIHER_TUI: 'regular' });
    return parts.slice(parts.indexOf('-e') + 2);
  };
  assert.deepEqual(modelArgs('openrouter/moonshotai/kimi-k2'), ['--provider', 'openrouter', '--model', 'moonshotai/kimi-k2']);
  assert.deepEqual(modelArgs('glm-5.3'), ['--model', 'glm-5.3'], 'a bare model id is not also passed as the provider');
  assert.deepEqual(modelArgs('/odd'), ['--model', '/odd']);
});

test('attachSubagentStructuredContent: stamps the action onto details; non-objects pass through', () => {
  const result = attachSubagentStructuredContent('spawn', {
    content: [{ type: 'text', text: 'started subagent p2' }],
    details: { paneId: 'p2', taskId: 'task-9', role: 'worker-default' },
  }) as { structuredContent: Record<string, unknown> };
  assert.deepEqual(result.structuredContent, { action: 'spawn', paneId: 'p2', taskId: 'task-9', role: 'worker-default' });
  assert.equal(
    (attachSubagentStructuredContent('list', { content: [], details: {} }) as { structuredContent: { action: string } }).structuredContent.action,
    'list',
    'empty details still yield the action',
  );
  assert.equal(attachSubagentStructuredContent('output', undefined), undefined);
});

test('rekeySub: a revived entry drops its dead pane id so it is listed (and swept) once', () => {
  const entry = subEntry({ paneId: 'w1:p3', status: 'closed' });
  const other = subEntry({ paneId: 'w1:p4' });
  const subs = new Map([['w1:p3', entry], ['w1:p4', other]]);
  entry.paneId = 'w1:p9'; // what reviveEntry does in place
  entry.status = 'running';
  rekeySub(subs, 'w1:p3', entry);
  assert.deepEqual([...subs.keys()].sort(), ['w1:p4', 'w1:p9']);
  assert.equal(subs.get('w1:p9'), entry);
  // A row that took over the old key in the meantime is not ours to delete.
  const squatter = subEntry({ paneId: 'w1:p9' });
  const map2 = new Map([['w1:p9', squatter]]);
  const moved = subEntry({ paneId: 'w1:p10' });
  rekeySub(map2, 'w1:p9', moved);
  assert.deepEqual([...map2.keys()].sort(), ['w1:p10', 'w1:p9']);
});

const mkSub = (over: Record<string, unknown>) => ({
  taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', cwd: 'F:\\piher', description: 'task',
  status: 'running', sessionFile: null, launchCommand: ['x'], createdAt: 1, ...over,
});

const registry = (...rows: unknown[]) => [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: rows } }];

const entryFrom = (row: Record<string, unknown>): SubEntry => foldSubsRegistry(registry(row)).subs[0]!;

test('foldSubsRegistry: last snapshot wins; legacy kinds normalize; v1 rows migrate', () => {
  const reg = foldSubsRegistry([
    { type: 'session' },
    { type: 'custom', customType: 'other', data: { x: 1 } },
    ...registry(mkSub({ paneId: 'w1:p1', status: 'settled' })),
    ...registry(mkSub({ paneId: 'w1:p2', status: 'consumed', kind: 'resident', tabName: 'research' })),
  ]);
  assert.equal(reg.version, 2);
  assert.equal(reg.subs.length, 1);
  assert.equal(reg.subs[0]!.paneId, 'w1:p2');
  assert.equal(reg.subs[0]!.status, 'consumed');
  assert.equal(reg.subs[0]!.kind, 'task', 'resident folds to task');
  assert.equal(reg.subs[0]!.tabName, 'research');

  assert.equal(entryFrom(mkSub({ paneId: 'w1:p3', kind: 'advisor' })).kind, 'advisor', 'unknown role names pass through');

  const v1 = entryFrom({ paneId: 'w1:p9', description: 'old', status: 'settled', createdAt: 5 });
  assert.equal(v1.taskId, 'w1:p9', 'v1 rows default taskId to the pane id');
  assert.equal(v1.kind, 'task');
  assert.equal(v1.cwd, '');
  assert.deepEqual(v1.launchCommand, []);

  assert.deepEqual(foldSubsRegistry([{ type: 'session' }] as never), { version: 2, subs: [] });
});

test('foldSubsRegistry: the settle window and the delivered report survive a persist/rebuild round-trip', () => {
  const row = entryFrom(mkSub({
    paneId: 'w1:p1',
    status: 'running',
    settleWindowStartedAt: 1234567890,
    reportDelivered: { fingerprint: 'abc', at: 7 },
  }));
  assert.equal(row.settleWindowStartedAt, 1234567890);
  assert.deepEqual(row.reportDelivered, { fingerprint: 'abc', at: 7 });

  const legacy = entryFrom(mkSub({ paneId: 'w1:p1', status: 'settled' }));
  assert.equal(legacy.settleWindowStartedAt, null);
  assert.equal(legacy.tabName, '', 'rows without a tab name fall back to empty');
  assert.equal(entryFrom(mkSub({ reportDelivered: { fingerprint: 1 } })).reportDelivered, undefined);
});

test('foldSubsRegistry: a one-shot lifetime survives the replay; any other row folds back to persistent', () => {
  assert.equal(entryFrom(mkSub({ lifecycle: 'one-shot' })).lifecycle, 'one-shot');
  assert.equal(entryFrom(mkSub({ lifecycle: 'forever' })).lifecycle, undefined);
  assert.equal(entryFrom(mkSub({})).lifecycle, undefined, 'a row from before the field stays persistent');
});

test('registrySnapshot: every running row plus a bounded tail of the most recently settled ones', () => {
  const running = [
    entryFrom(mkSub({ paneId: 'w1:p1', taskId: 'run-1', status: 'running' })),
    entryFrom(mkSub({ paneId: 'w1:p2', taskId: 'run-2', status: 'running' })),
  ];
  const settled = Array.from({ length: SUBS_REGISTRY_TAIL + 3 }, (_, i) =>
    entryFrom(mkSub({ paneId: `w1:s${i}`, taskId: `settled-${i}`, status: 'closed', createdAt: i + 1, consumedAt: i + 1 })));

  const snapshot = registrySnapshot([...running, ...settled]);
  const keptRunning = snapshot.subs.filter((s) => s.status === 'running').map((s) => s.paneId);
  assert.deepEqual(keptRunning, ['w1:p1', 'w1:p2'], 'a running worker is never pruned, however long the session');
  const keptSettled = snapshot.subs.filter((s) => s.status !== 'running').map((s) => s.paneId);
  assert.equal(keptSettled.length, SUBS_REGISTRY_TAIL, 'the tail is bounded');
  assert.deepEqual(keptSettled, settled.slice(3).map((s) => s.paneId), 'the newest settled rows are the ones kept, in order');

  const folded = foldSubsRegistry([{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: snapshot }]);
  assert.deepEqual(folded.subs.map((s) => s.paneId), snapshot.subs.map((s) => s.paneId), 'a restart rebuilds the same registry');
});

test('registrySnapshot: a settled row that never reached GC still counts by when it ran', () => {
  const rows = Array.from({ length: SUBS_REGISTRY_TAIL }, (_, i) =>
    entryFrom(mkSub({ paneId: `w1:s${i}`, taskId: `settled-${i}`, status: 'settled', createdAt: i + 1, consumedAt: 0 })));
  const late = entryFrom(mkSub({ paneId: 'w1:late', taskId: 'late', status: 'settled', createdAt: 99, consumedAt: null }));
  const kept = registrySnapshot([...rows, late]).subs.map((s) => s.paneId);
  assert.ok(kept.includes('w1:late'), 'the row that just settled is the one a caller still wants');
  assert.ok(!kept.includes('w1:s0'), 'and the oldest one is the one that goes');
});

test('Semaphore: queues past the cap, releases in order, reusable after drain', async () => {
  const sem = new Semaphore(2);
  const rel1 = await sem.acquire();
  const rel2 = await sem.acquire();
  assert.equal(sem.activeCount, 2);
  let queued = true;
  const p3 = sem.acquire().then((r) => { queued = false; return r; });
  assert.equal(queued, true, 'a third acquire queues while the cap is full');
  rel1();
  const rel3 = await p3;
  assert.equal(queued, false, 'release admits the queue head');
  assert.equal(sem.activeCount, 2);
  rel2();
  rel3();
  assert.equal(sem.activeCount, 0);
  (await sem.acquire())();
  assert.equal(sem.activeCount, 0);
});

test('formatSpawnFailure: a start that never happened names the pane failure', () => {
  const text = formatSpawnFailure('scan', 'pane w1:p2 exited before its pipe became ready');
  assert.match(text, /failed to spawn subagent "scan"/);
  assert.match(text, /exited before its pipe became ready/);
});

const NOW = 1_800_000_000_000;
const probe = (over: Partial<AliveProbe>): AliveProbe => ({ paneExists: true, agentStatus: null, lastActivityMs: null, ...over });

test('isAlive: gone pane is death; working/blocked is life; idle/unknown ride session freshness', () => {
  assert.equal(isAlive(probe({ paneExists: false, agentStatus: 'working', lastActivityMs: NOW - 1000 }), NOW), false);
  assert.equal(isAlive(probe({ agentStatus: 'working' }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'blocked', lastActivityMs: NOW - 999_999 }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 119_999 }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 120_001 }), NOW), false);
  assert.equal(isAlive(probe({}), NOW), false);
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 30_001 }), NOW, 30_000), false);
});

test('agoText: relative times, clock skew clamps to zero', () => {
  assert.equal(agoText(NOW - 12_000, NOW), '12s ago');
  assert.equal(agoText(NOW - 180_000, NOW), '3m ago');
  assert.equal(agoText(NOW - 7_200_000, NOW), '2h ago');
  assert.equal(agoText(NOW + 5_000, NOW), '0s ago');
});

test('buildAliveNotice: a failing call on a live worker is not its outcome', () => {
  const text = buildAliveNotice(
    { paneId: 'wA:p3', description: 'Explore HR', probe: probe({ agentStatus: 'idle', lastActivityMs: NOW - 45_000 }) },
    NOW,
  );
  assert.match(text, /is ALIVE in pane wA:p3/);
  assert.match(text, /agent_status=idle/);
  assert.match(text, /last session activity 45s ago/);
  assert.match(text, /NOT the task's outcome/);
  assert.match(text, /settlement notice/);
  assert.match(text, /Do NOT redo its work/);
  assert.ok(!buildAliveNotice({ paneId: 'wA:p4', description: 'X', probe: probe({ agentStatus: 'working' }) }, NOW)
    .includes('last session activity'), 'unknown activity omits the clause');
});

test('buildBlockedGateNotice: the master must not take over or answer for the human', () => {
  const text = buildBlockedGateNotice({ paneId: 'wB:p3', description: 'Explore HR', question: 'which data source?' });
  assert.match(text, /BLOCKED waiting for a HUMAN decision in pane wB:p3/);
  assert.match(text, /question: "which data source\?"/);
  assert.match(text, /Do NOT take over its work/);
  assert.match(text, /Tell the user to open that terminal in the Herdr app/);
  assert.match(text, /subagent\(action: "send"\)/);
  assert.match(text, /do not redo the work yourself/);
  assert.ok(!buildBlockedGateNotice({ paneId: 'wB:p4', description: 'X', question: null }).includes('question:'));
});

test('planLaunchValidation: core availability, prompt, cwd and role/kind normalization', () => {
  const errorText = (result: { kind: string; text?: string }): string => (result.kind === 'error' ? result.text! : '');
  assert.match(errorText(planLaunchValidation({ prompt: 'x' }, false)), /herdr-core terminal/);
  assert.match(errorText(planLaunchValidation({ prompt: '   ' }, true)), /prompt/);
  // A missing `prompt` passes the schema (it is optional) and is refused here, where the mistake is
  // made: the refusal has to state the real constraint, not just that a string was empty.
  const noPrompt = errorText(planLaunchValidation({}, true));
  assert.match(noPrompt, /does not see this conversation/);
  assert.match(noPrompt, /self-contained/);

  const ok = planLaunchValidation({
    description: 'scan',
    prompt: 'do it',
    allowed_tools: ['read', 1, 'write'],
    tab: 'feat',
  }, true);
  assert.equal(ok.kind, 'ok');
  if (ok.kind !== 'ok') return;
  assert.equal(ok.spec.description, 'scan');
  assert.equal(ok.manifestRole, 'worker-default');
  assert.deepEqual(ok.suggested, ['read', 'write']);
  assert.equal(ok.tab, 'feat');
  assert.equal(ok.roleKind, 'task');
  const role = planLaunchValidation({ prompt: 'x', role: 'resident' }, true);
  assert.equal(role.kind === 'ok' && role.roleKind, 'task', 'legacy role labels fold to task');
});

test('readyBackoffMs: exponential with a cap (500ms → 1s → 2s → 4s → 4s)', () => {
  for (const [attempt, ms] of [[0, 500], [1, 1000], [2, 2000], [3, 4000], [4, 4000], [99, 4000], [-3, 500], [1.7, 1000]] as const) {
    assert.equal(readyBackoffMs(attempt), ms, `attempt ${attempt}`);
  }
});

test('planReadyAttempt: ready wins; a gone pane fails fast; an unknown probe keeps retrying', () => {
  const plan = (over: Partial<Parameters<typeof planReadyAttempt>[0]>) =>
    planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: true, ready: false, ...over });
  assert.deepEqual(plan({ ready: true }), { kind: 'ready' });
  assert.deepEqual(plan({ alive: false }), { kind: 'give-up', reason: 'pane-gone' });
  assert.deepEqual(plan({ alive: null }), { kind: 'retry', delayMs: 500 });
  assert.deepEqual(plan({ elapsedMs: 89_999, attempt: 7 }), { kind: 'retry', delayMs: 4000 });
  assert.deepEqual(plan({ elapsedMs: 90_000, attempt: 8 }), { kind: 'give-up', reason: 'timeout' });
  // A dead pane outranks the timeout: the more accurate reason wins.
  assert.deepEqual(plan({ elapsedMs: 120_000, attempt: 9, alive: false }), { kind: 'give-up', reason: 'pane-gone' });
});

test('readyFailureText: crash, working-but-slow and never-registered are distinguishable', () => {
  const crashed = readyFailureText({
    paneId: 'wX:p9',
    reason: 'pane-gone',
    elapsedMs: 4_200,
    timeoutMs: 90_000,
    tail: "TypeError: Cannot read properties of undefined (reading 'total')",
  });
  assert.match(crashed, /wX:p9 exited before its pipe became ready/);
  assert.match(crashed, /last output of wX:p9/);

  const slow = readyFailureText({
    paneId: 'wX:p9', reason: 'timeout', elapsedMs: 90_000, timeoutMs: 90_000, lastStatus: 'working',
  });
  assert.match(slow, /pipe not ready within 90s/);
  assert.match(slow, /alive and working/);

  const stuck = readyFailureText({ paneId: 'wX:p9', reason: 'timeout', elapsedMs: 90_000, timeoutMs: 90_000, lastStatus: 'idle' });
  assert.match(stuck, /never registered its pipe/);
  assert.ok(!stuck.includes('last output'));
});

test('resolveTaskIdPrefix: exact beats length, prefixes need four chars and report ambiguity', () => {
  const candidates = [
    'c1b5274d-1111-2222-3333-444455556666',
    'c1b5899a-aaaa-bbbb-cccc-ddddeeeeffff',
    'a2f48901-0000-1111-2222-333344445555',
    'p2',
  ];
  const resolved = resolveTaskIdPrefix('c1b5274d', candidates);
  assert.equal(resolved.kind === 'resolved' && resolved.taskId, candidates[0]);
  const four = resolveTaskIdPrefix('A2F4', candidates);
  assert.equal(four.kind === 'resolved' && four.taskId, candidates[2], 'prefix match is case-insensitive');
  const ambiguous = resolveTaskIdPrefix('c1b5', candidates);
  assert.ok(ambiguous.kind === 'ambiguous');
  if (ambiguous.kind === 'ambiguous') assert.deepEqual(ambiguous.candidates, [candidates[0], candidates[1]]);
  assert.equal(resolveTaskIdPrefix('c1b', candidates).kind, 'too_short');
  assert.equal(resolveTaskIdPrefix('ffff', candidates).kind, 'not_found');
  assert.equal(resolveTaskIdPrefix('  ', candidates).kind, 'not_found');
  const exact = resolveTaskIdPrefix('p2', candidates);
  assert.equal(exact.kind === 'resolved' && exact.taskId, 'p2');
});

test('tabNameForTask: collapse, truncate, fall back', () => {
  assert.equal(tabNameForTask('  Field   notes  '), 'Field notes');
  assert.equal(tabNameForTask('a'.repeat(30)), 'a'.repeat(TAB_NAME_MAX));
  assert.equal(tabNameForTask('   '), 'task');
});

test('planTabPlacement: a named tab or a worktree gets its own stable app tab; the main checkout joins the master', () => {
  const cases: Array<[string, Parameters<typeof planTabPlacement>[0], unknown]> = [
    ['an explicit tab is its own tab', { desiredTab: 'research', description: 'x' }, { tabName: 'research', tabId: 'tbpiher-research' }],
    ['the same tab name always maps to the same app tab', { desiredTab: 'Spike Two', description: 'x' }, { tabName: 'Spike Two', tabId: 'tbpiher-spike-two' }],
    ['a whitespace-only tab name counts as absent', { desiredTab: '   ', description: 'spike', zone: { zone: 'main', tabName: null } }, { tabName: MAIN_TAB_NAME, tabId: null }],
    ['the main checkout joins the master tab', { description: 'notes', zone: { zone: 'main', tabName: null } }, { tabName: MAIN_TAB_NAME, tabId: null }],
    ['a worktree gets a tab named after its directory', { description: 'bug#2', zone: { zone: 'worktree', tabName: 'hotfix-2' } }, { tabName: 'hotfix-2', tabId: 'tbpiher-hotfix-2' }],
    ['no zone derives the name from the description', { description: 'field notes' }, { tabName: 'field notes', tabId: 'tbpiher-field-notes' }],
    ['a tab literally named main joins the master tab', { desiredTab: 'main', description: 'x' }, { tabName: MAIN_TAB_NAME, tabId: null }],
    // A non-ASCII tab name sanitizes to nothing, so the id falls back to a stable hash.
    ['a non-ASCII tab name keeps a hashed id', { desiredTab: '\u8c03\u7814', description: 'x' }, { tabName: '\u8c03\u7814', tabId: 'tbpiher-' + fnvSlug('\u8c03\u7814') }],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(planTabPlacement(input), expected, name);
  assert.equal(planTabPlacement({ desiredTab: 'research', description: 'x' }).tabId, planTabPlacement({ desiredTab: 'research', description: 'y' }).tabId, 'repeat spawns join one tab');
});

/** Mirrors the id derivation in subagent-core for non-ASCII names (FNV-1a over code points). */
function fnvSlug(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of name) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

test('classifyWorktreeZone: main checkout, sibling worktree, unrelated dir, prefix trap', () => {
  const worktrees = ['F:/repo', 'F:/wt/hotfix-2', 'F:/wt/hotfix-3'];
  const cases: Array<[string, string, unknown]> = [
    ['the main checkout and its children', 'F:\\repo\\packages', { zone: 'main', tabName: null }],
    ['a sibling worktree, named after its directory', 'F:\\wt\\hotfix-2\\src', { zone: 'worktree', tabName: 'hotfix-2' }],
    ['case-insensitive matching', 'f:/WT/HOTFIX-3', { zone: 'worktree', tabName: 'hotfix-3' }],
    ['an unrelated directory is main', 'C:\\temp', { zone: 'main', tabName: null }],
    ['a name prefix is not a parent (/repo-x vs /repo)', 'F:/repo-x', { zone: 'main', tabName: null }],
  ];
  for (const [name, cwd, expected] of cases) {
    assert.deepEqual(classifyWorktreeZone({ cwd, masterCwd: 'F:/repo', worktrees }), expected, name);
  }
});

/* ── plugin wiring ──────────────────────────────────────────────── */

test('subagent plugin: one tool, lifecycle hooks, port binding and unbinding', async () => {
  const { root, pi, port } = await mountSubagent();
  assert.ok(pi.tools.has('subagent'));
  assert.ok(!pi.tools.has('list_agents'), 'no legacy tool aliases');
  assert.ok((pi.listeners.get('session_start') ?? []).length >= 1);
  assert.ok((pi.listeners.get('turn_start') ?? []).length >= 1, 'GC turn_start hook');
  assert.ok(port.current, 'port bound at mount');
  for (const key of ['applyReplySession', 'listRunningSubs'] as const) {
    assert.equal(typeof port.current[key], 'function', `port member ${key}`);
  }
  port.current.applyReplySession('unknown', null);

  // A cwd with no repository and no ledger: `list` answers from the registry alone there.
  assert.match((await runSubagent(pi, { action: 'list' }, mkdtempSync(join(tmpdir(), 'piher-no-ledger-')))).content[0]!.text, /No subagents started/);
  await assert.rejects(runSubagent(pi, { action: 'explode' }), /unknown action "explode"/);

  await root.fiber.dispose();
  assert.equal(port.current, null, 'port unbound on dispose');
});

test('subagent plugin: ledger tombstone makes the tool inert', async () => {
  const ledger = new DisposeLedger();
  const { root, pi, port } = await mountSubagent({ ledger });
  assert.equal(ledger.disposeKey(new URL('../src/plugins/subagent.ts', import.meta.url).href), 1);
  assert.match((await runSubagent(pi, { action: 'list' })).content[0]!.text, /disposed/);
  assert.equal(typeof port.current?.listRows, 'function');
  await root.fiber.dispose();
});

test('subagent plugin: list answers for a task the registry already pruned, from the repository ledger', async () => {
  // A main checkout is a directory holding `.git`; the ledger lives inside it.
  const repo = mkdtempSync(join(tmpdir(), 'piher-list-ledger-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    const pruned: HistoryEntry = {
      taskId: 'a1b2c3d4-0000-4000-8000-000000000001',
      kind: 'task',
      paneId: 'w1:p9',
      tabId: 'tb9',
      workspaceId: 'w1',
      cwd: repo,
      description: 'pruned worker',
      sessionFile: null,
      launchCommand: [],
      status: 'closed',
      createdAt: 5,
      consumedAt: 6,
    };
    assert.deepEqual(appendLedger(repo, pruned), { ok: true });
    // Unfinished business in the same ledger: a settled row is resumable, so it must still show.
    assert.deepEqual(appendLedger(repo, {
      ...pruned,
      taskId: 'b2c3d4e5-0000-4000-8000-000000000002',
      paneId: 'w1:p8',
      description: 'settled worker',
      status: 'settled',
    }), { ok: true });
    // The same task the registry holds, recorded once more in the ledger: the live row must win.
    assert.deepEqual(appendLedger(repo, {
      ...pruned,
      taskId: 'live-1',
      paneId: 'w1:p4',
      description: 'stale ledger copy',
      createdAt: 1,
    }), { ok: true });
    const { root, pi } = await mountSubagent({
      // No core in a ledger-merge test: the startup zombie sweep would close the running row (its fake
      // terminal list is empty), and a live row would arm a recovery poll.
      client: { available: false },
      subs: [subEntry({ taskId: 'live-1', paneId: 'w1:p4', cwd: repo, description: 'live worker' })],
    });
    try {
      const text = (await runSubagent(pi, { action: 'list' }, repo)).content[0]!.text;
      assert.doesNotMatch(text, /pruned worker/, 'a closed task was a decision: it is not listed');
      assert.match(text, /w1:p8 \[idle\] \(task · persistent, settled; action send revives\) settled worker/);
      assert.match(text, /w1:p4 \[running[^\n]*live worker/);
      assert.doesNotMatch(text, /stale ledger copy/, 'a row the registry still holds is not repeated from the ledger');
      assert.equal(text.split('\n').filter((line) => line.includes('live worker')).length, 1);

      // The ledger read is the repository's: another checkout's history cannot leak in.
      const elsewhere = mkdtempSync(join(tmpdir(), 'piher-no-ledger-'));
      assert.doesNotMatch((await runSubagent(pi, { action: 'list' }, elsewhere)).content[0]!.text, /pruned worker/);
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: tool_result hook only rewrites our errors, and stays silent for a dead pane', async () => {
  const { root, pi } = await mountSubagent({
    subs: [subEntry({ paneId: 'w1:p2', cwd: '/tmp', description: 'dead worker', createdAt: 1 })],
  });
  const hook = (pi.listeners.get('tool_result') ?? [])[0]!;
  const call = (event: Record<string, unknown>) => hook(event) as Promise<unknown>;
  assert.equal(await call({ toolName: 'subagent', toolCallId: 'tc1', isError: true, content: [{ type: 'text', text: 'Error: failed to reach subagent w1:p2: pipe not ready' }] }), undefined);
  assert.equal(await call({ toolName: 'subagent', toolCallId: 'tc2', isError: false, content: [] }), undefined);
  assert.equal(await call({ toolName: 'bash', toolCallId: 'tc3', isError: true, content: [] }), undefined);
  assert.equal(await call({ toolName: 'subagent', toolCallId: 'tc4', isError: true, content: [{ type: 'text', text: 'Error: unknown action' }] }), undefined);
  await root.fiber.dispose();
});

test('formatRoleCatalog: name, description, lifecycle and tools — what a master needs to pick', () => {
  const text = formatRoleCatalog([
    { name: 'reviewer', description: 'Static reviewer of a bounded change', tools: ['read', 'bash'], lifecycle: 'one-shot' },
    { name: 'worker', description: null, tools: [], lifecycle: 'persistent' },
    { name: 'broken', invalid: 'manifest.tools must be an array' },
  ]);
  assert.match(text, /role profiles available here/, 'discovery is the tool\'s job, not the filesystem\'s');
  assert.match(text, /- reviewer — Static reviewer of a bounded change \(one-shot · tools: read, bash\)/);
  assert.match(text, /- worker — no description \(persistent · tools: none declared\)/);
  assert.match(text, /- broken — INVALID: manifest\.tools must be an array/, 'a broken profile is reported, not hidden');
  assert.match(formatRoleCatalog([]), /none in this workspace/, 'an empty catalog still answers the question');
});

test('subagent plugin: help returns the manual, and a missing action normalizes to spawn', async () => {
  const { root, pi } = await mountSubagent();
  const def = pi.tools.get('subagent')!;
  const help = await runSubagent(pi, { action: 'help' });
  assert.match(help.content[0]!.text, /^subagent manual/);
  for (const topic of ['cwd', 'role + allowed_tools', 'resume', 'history.jsonl']) assert.ok(help.content[0]!.text.includes(topic), topic);
  // Either shape answers "which agents do I have"; the machine's own role files decide which.
  assert.match(help.content[0]!.text, /role profiles( available here| — none)/, 'help lists the launchable profiles, so no hunting for role files');
  assert.equal(String(def.description).includes('history.jsonl'), false, 'ledger detail rides help, not every request');
  assert.deepEqual(def.prepareArguments?.({ description: 'x', prompt: 'y' }), { description: 'x', prompt: 'y', action: 'spawn' });
  assert.deepEqual(def.prepareArguments?.({ action: 'list' }), { action: 'list' });
  assert.deepEqual(def.prepareArguments?.(undefined), { action: 'spawn' });
  await root.fiber.dispose();
});

test('subagent plugin: close records the decision even when the registry is already closed', async () => {
  // A registry row can be closed while the ledger trails off at `consumed`: the project's history
  // should still say who ended it, or the row looks like work that stopped by itself.
  const repo = mkdtempSync(join(tmpdir(), 'piher-close-idem-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  appendLedger(repo, {
    taskId: 'task-idem', description: 'already closed', status: 'consumed', paneId: 'pGone',
    createdAt: 1, consumedAt: 2, via: 'pipe-reply', kind: 'worker', cwd: repo,
    tabId: 't1', tabName: 'w', lifecycle: 'persistent',
  } as unknown as HistoryEntry);
  const { root, pi } = await mountSubagent({
    client: { listTerminals: async () => [] },
    subs: [subEntry({ paneId: 'pGone', taskId: 'task-idem', cwd: repo, status: 'closed' })],
  });
  try {
    const res = await runSubagent(pi, { action: 'close', agentId: 'task-idem' }, repo);
    assert.match(res.content[0]!.text, /already closed/);
    const rows = readLedger(repo).filter((row) => row.taskId === 'task-idem');
    assert.equal(rows.at(-1)!.status, 'closed', 'the ledger now records the decision');
  } finally {
    await root.fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: a task closed in another session does not come back as settled', async () => {
  // The branch snapshot a session restores can be older than the ledger; the ledger is append-only, so
  // its last row is the newest word. Without this the row a master closed yesterday keeps offering
  // `action send revives` in every new session of that project.
  const cwd = mkdtempSync(join(tmpdir(), 'piher-closed-ledger-'));
  mkdirSync(join(cwd, '.git'), { recursive: true });
  appendLedger(cwd, {
    taskId: 'task-closed', description: 'already handled', status: 'closed', paneId: 'pGone',
    createdAt: Date.now() - 60_000, closedAt: Date.now() - 30_000, via: 'close', kind: 'worker',
    cwd, tabId: 't1', tabName: 'w', lifecycle: 'persistent',
  } as unknown as HistoryEntry);
  const { root, pi } = await mountSubagent({
    client: { listTerminals: async () => [] },
    // The session restored a settled copy of the same task from its branch.
    subs: [subEntry({ paneId: 'pGone', taskId: 'task-closed', tabId: 't1', tabName: 'w', status: 'settled' })],
  });
  try {
    const res = await runSubagent(pi, { action: 'list' }, cwd);
    assert.doesNotMatch(res.content[0]!.text, /already handled/, 'a closed task is not offered again');
  } finally {
    await root.fiber.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('subagent plugin: close reclaims a running row whose pane is already gone', async () => {
  // A worker that stopped without a report leaves its row `running`. From a session that did not spawn
  // it there is no pane to probe alive, so refusing the close would keep that row forever.
  const retired: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      getTerminal: async () => null,
      kill: async (id: string) => { retired.push(id); },
      remove: async (id: string) => { retired.push(id); },
    },
    subs: [subEntry({ paneId: 'pZombie', taskId: 'task-zombie', tabId: 't1', tabName: 'w', status: 'running' })],
  });
  try {
    const res = await runSubagent(pi, { action: 'close', agentId: 'pZombie' });
    assert.match(res.content[0]!.text, /closed — pane and tab gone/);
    assert.deepEqual(retired, ['pZombie', 'pZombie'], 'the dead pane is still retired best-effort');
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: close refuses a running worker with a pointer at interrupt', async () => {
  const retired: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      available: false, // no pipe, no pollers: the refusal happens before anything touches core
      // The refusal is about a pane that could still report: a live one.
      getTerminal: async (id: string) => terminalInfo({ id, state: 'live' }),
      kill: async (id: string) => { retired.push(`kill:${id}`); },
      remove: async (id: string) => { retired.push(`remove:${id}`); },
    },
    subs: [subEntry({ paneId: 'p-busy', taskId: 'task-busy', status: 'running', consumedAt: null })],
  });
  try {
    assert.match(await runSubagentRejects(pi, { action: 'close', agentId: 'p-busy' }), /still running[\s\S]*interrupt/);
    assert.deepEqual(retired, [], 'a refused close touches nothing');
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: interrupt names the way back for a settled and for a closed worker', async () => {
  const { root, pi } = await mountSubagent({
    // Both refusals happen before anything touches a pane: no pipe, no core calls.
    client: { available: false },
    subs: [
      subEntry({ paneId: 'p-settled', taskId: 'task-settled', status: 'settled', consumedAt: 1 }),
      subEntry({ paneId: 'p-closed', taskId: 'task-closed', status: 'closed' }),
    ],
  });
  try {
    const settled = await runSubagentRejects(pi, { action: 'interrupt', agentId: 'p-settled' });
    assert.match(settled, /no running turn/, 'a settled worker has no turn to stop, and says so');
    assert.match(settled, /resume[\s\S]*task-settled/, 'the refusal names resume(taskId)');
    const closed = await runSubagentRejects(pi, { action: 'interrupt', agentId: 'p-closed' });
    assert.match(closed, /closed[\s\S]*resume/, 'a closed worker points at resume');
    assert.match(closed, /task-closed/, 'with the taskId to revive');
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: close reclaims a finished worker and keeps its task resumable', async () => {
  const retired: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      available: true,
      kill: async (id: string) => { retired.push(`kill:${id}`); },
      remove: async (id: string) => { retired.push(`remove:${id}`); },
    },
    subs: [subEntry({ paneId: 'p-done', taskId: 'task-done', status: 'consumed', consumedAt: 5 })],
  });
  try {
    const closed = await runSubagent(pi, { action: 'close', agentId: 'p-done' });
    assert.match(closed.content[0]!.text, /p-done.*closed/);
    assert.match(closed.content[0]!.text, /resume/);
    assert.deepEqual(retired, ['kill:p-done', 'remove:p-done'], 'the kill+rm pair the GC uses: pane and tab go');
    assert.equal(closed.details?.taskId, 'task-done', 'the ledger row keeps the taskId, so resume can revive it');

    // Closing an already-closed row is a no-op, with the way back spelled out.
    const again = await runSubagent(pi, { action: 'close', agentId: 'p-done' });
    assert.match(again.content[0]!.text, /already closed/);
    assert.deepEqual(retired, ['kill:p-done', 'remove:p-done']);
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: list shows every row with its live state', async () => {
  const worker = (paneId: string, taskId: string, description: string): SubEntry => subEntry({
    paneId, taskId, tabId: 't-1', tabName: '', cwd: '/workspace/repo', description, createdAt: 1,
  });
  const { root, pi } = await mountSubagent({
    client: {
      available: false, // keeps the session-recovery pollers out of a rendering-only test
      getTerminal: async (id) => terminalInfo({ id, status: 'working', labels: { 'herdr.tab': 't-1' } }),
    },
    subs: [worker('p-1', 'task-1', 'Worker 1'), worker('p-2', 'task-2', 'Worker 2')],
  });
  try {
    const lines = (await runSubagent(pi, { action: 'list' })).content[0]!.text.split('\n');
    assert.equal(lines[0], 'p-1 [running working] (task · persistent) Worker 1');
    assert.equal(lines[1], 'p-2 [running working] (task · persistent) Worker 2');
  } finally {
    await root.fiber.dispose();
  }
});

/* ── Phase 2 task slugs (RFC rfc-delegation-identity §3.1) ──────── */

test('slugifyTask / allocateSubSlug / subRef: kebab-case, non-ASCII fallback, dedupe, display form', () => {
  const CJK = '\u4e2d\u6587'; // a non-ASCII (CJK) word: wide glyphs, no ASCII letters
  assert.equal(slugifyTask('Fix Auth Flow!'), 'fix-auth-flow');
  assert.equal(slugifyTask('  read--me  '), 'read-me');
  assert.equal(slugifyTask('a'.repeat(40)), 'a'.repeat(24), 'slug caps at 24 chars');
  assert.equal(slugifyTask(CJK), '', 'non-ASCII words sanitize to nothing');
  const taken = new Set(['fix-auth']);
  assert.equal(allocateSubSlug('fix auth', 'taskid', taken), 'fix-auth-2');
  assert.equal(allocateSubSlug('fix auth', 'taskid', new Set(['fix-auth', 'fix-auth-2'])), 'fix-auth-3');
  assert.equal(allocateSubSlug(CJK, '9faaa0e5-rest', new Set()), 'task-9faaa0', 'non-ASCII falls back to a taskId prefix');
  assert.equal(subRef({ paneId: 'p2', slug: 'fix-auth' }), 'fix-auth@p2');
  assert.equal(subRef({ paneId: 'p2' }), 'p2', 'slug-less rows keep the bare paneId (back-compat)');
});

test('foldSubsRegistry: slug parses, survives replay, and old rows without it stay undefined', () => {
  const entries = [
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [{ paneId: 'p2', taskId: 't1' }] } },
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [{ paneId: 'p2', taskId: 't1', slug: 'fix-auth' }, { paneId: 'p3', taskId: 't2' }] } },
  ];
  const registry = foldSubsRegistry(entries);
  assert.equal(registry.subs.find((s) => s.paneId === 'p2')?.slug, 'fix-auth');
  assert.equal(registry.subs.find((s) => s.paneId === 'p3')?.slug, undefined);
});
