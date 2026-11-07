/** Subagent domain units: pure planners and notices (launch line, validation, tab placement,
 * readiness, liveness, task-id resolution) plus plugin wiring. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisposeLedger } from '../src/ledger.ts';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TempHome, fire, mountSubagent, runSubagent, runSubagentRejects, seedTaskDocuments, readTaskRecord,
  repoTasksDir, taskRow, terminalInfo,
} from './test-utils.ts';
import { forgetTaskPrompt, readTaskPrompt, saveTaskPrompt } from '../src/prompt-store.ts';
import {
  MAIN_TAB_NAME, TAB_NAME_MAX, Semaphore, agoText, buildAliveNotice, buildBlockedGateNotice,
  attachSubagentStructuredContent, buildLaunchLine, buildLaunchParts, entryScript, formatRoleCatalog, classifyWorktreeZone, formatSpawnFailure, isAlive,
  planLaunchValidation, planTabPlacement, resolveTaskIdPrefix,
  flattenToolParams, idParam, sleepWhileSubsRunningNote, tabNameForTask, type AliveProbe,
} from '../src/subagent-core.ts';
import {
  allocateTaskSlug, parseTaskDocument, slugifyTask, taskRef, type TaskEntry,
} from '../src/task-row.ts';
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
  const members = [
    'applyReplySession', 'listRunningSubs', 'consumeReply', 'settlementCard',
  ] as const;
  for (const key of members) {

    assert.equal(typeof port.current[key], 'function', `port member ${key}`);
  }
  const shape = port.current as unknown as Record<string, unknown>;
  assert.ok(!('listRows' in shape), 'the tree projection left the port');
  port.current.applyReplySession('unknown', null);

  // A cwd with no repository and no tasks: `list` answers from memory alone there.
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
  const shapeOrNull = port.current as unknown as Record<string, unknown> | null;
  assert.equal(typeof shapeOrNull?.['listRows'], 'undefined');
  await root.fiber.dispose();
});

test('subagent plugin: a reload restores the session view from the records and drops closed rows', async () => {
  // A main checkout is a directory holding `.git`; the task directory lives inside it.
  const repo = mkdtempSync(join(tmpdir(), 'piher-list-restore-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const home = new TempHome('piher-list-restore-');
  try {
    const sessionFile = join(home.dir('sessions'), '2026-01-01T00-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000000.jsonl');
    seedTaskDocuments(sessionFile, [
      {
        taskId: 'a1b2c3d4-0000-4000-8000-000000000001', paneId: 'w1:p9', cwd: repo,
        description: 'pruned worker', closedAt: Date.now(), tabName: '',
      },
      // Unfinished business in the same directory: a consumed row is resumable, so it must still show.
      {
        taskId: 'b2c3d4e5-0000-4000-8000-000000000002', paneId: 'w1:p8', cwd: repo,
        description: 'settled worker', consumedAt: 6, tabName: '',
      },
      {
        taskId: 'live-1', paneId: 'w1:p4', cwd: repo, description: 'live worker', tabName: '',
      },
    ]);
    const { root, pi } = await mountSubagent({
      // No core behind the mount: a live row would arm a recovery poll. The probes below still
      // answer, because `list` probes the rows it touches.
      client: {
        available: false,
        getTerminal: async (id: string) => terminalInfo({
          id, status: id === 'w1:p4' ? 'working' : 'idle',
        }),
      },
      deps: { getSessionFile: () => sessionFile, getCwd: () => repo },
    });
    try {
      await fire(pi, 'session_start', { reason: 'reload' }, {});
      const text = (await runSubagent(pi, { action: 'list' }, repo)).content[0]!.text;
      assert.doesNotMatch(text, /pruned worker/, 'a closed task was a decision: it is not listed');
      assert.match(text, /w1:p8 \[idle\] \(task · persistent\) settled worker/);
      assert.match(text, /w1:p4 \[running\] \(task · persistent\) live worker/);
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: eleven settlements prune nothing, the oldest still closes', async () => {
  // Records are never pruned by count or age: twelve settled tasks all survive a reload, and the
  // oldest one still closes by the ref `list` printed.
  const repo = mkdtempSync(join(tmpdir(), 'piher-no-tail-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const home = new TempHome('piher-no-tail-');
  try {
    const stamp = '2026-01-04T00-00-00-000Z_dddddddd-0000-4000-8000-000000000000.jsonl';
    const sessionFile = join(home.dir('sessions'), stamp);
    seedTaskDocuments(sessionFile, Array.from({ length: 12 }, (_, i) => ({
      taskId: `settle-${i}`, paneId: `p${i}`, cwd: repo, description: `settled worker ${i}`,
      createdAt: i, consumedAt: 1000 + i,
    })));
    const { root, pi } = await mountSubagent({
      client: { listTerminals: async () => [] },
      deps: { getSessionFile: () => sessionFile, getCwd: () => repo },
    });
    try {
      await fire(pi, 'session_start', { reason: 'reload' }, {});
      const text = (await runSubagent(pi, { action: 'list' }, repo)).content[0]!.text;
      assert.equal(text.split('\n').length, 12, 'every settled row survives the reload');
      // No document the suite wrote carries a status field: liveness is observed, never stored.
      const dir = repoTasksDir(repo)!;
      for (const name of readdirSync(dir)) {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        for (const row of parseTaskDocument(parsed).rows) assert.ok(!('status' in row));
      }
      const closed = await runSubagent(pi, { action: 'close', agentId: 'p0' }, repo);
      assert.match(closed.content[0]!.text, /closed — pane and tab gone/);
      const oldest = readTaskRecord(repo, 'settle-0');
      assert.ok(oldest, 'the oldest record exists');
      assert.ok(oldest.closedAt !== null, 'the oldest row closes');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: a restored row answers the ref `list` printed, and its close lands in the record', async () => {
  // A reload restores the session's tasks from the view and the records, so a worker the master
  // still sees in `list` is addressable by the ref it printed — and closing it writes `closedAt`.
  const repo = mkdtempSync(join(tmpdir(), 'piher-record-ref-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const home = new TempHome('piher-record-ref-');
  try {
    const sessionFile = join(home.dir('sessions'), '2026-01-02T00-00-00-000Z_bbbbbbbb-0000-4000-8000-000000000000.jsonl');
    const taskId = '407ca2e0-0000-4000-8000-000000000001';
    seedTaskDocuments(sessionFile, [{
      taskId,
      kind: 'task',
      paneId: 't195',
      slug: 't2-8a-2-shared-escalatio',
      tabId: '',
      cwd: repo,
      description: 'T2 8A.2 shared escalation log',
      createdAt: 5,
      consumedAt: 6,
    }]);
    const { root, pi } = await mountSubagent({
      client: { getTerminal: async (id: string) => terminalInfo({ id, status: 'idle' }) },
      tasks: [taskRow({ taskId: 'live-1', paneId: 'w1:p4', cwd: repo, description: 'live worker' })],
      deps: { getSessionFile: () => sessionFile, getCwd: () => repo },
    });
    try {
      await fire(pi, 'session_start', { reason: 'reload' }, {});
      const listed = (await runSubagent(pi, { action: 'list' }, repo)).content[0]!.text;
      assert.match(listed, /t2-8a-2-shared-escalatio@t195 \[idle\] \(task · persistent\)/);
      // The combined ref spawn prints is what a master copies back, and it used to answer "unknown".
      const closed = await runSubagent(pi, { action: 'close', agentId: 't2-8a-2-shared-escalatio@t195' }, repo);
      assert.match(closed.content[0]!.text, /Subagent t2-8a-2-shared-escalatio@t195 closed/);
      const record = readTaskRecord(repo, taskId);
      assert.ok(record && record.closedAt !== null, 'the decision lands in the record');
      // The bare pane id is the other form the master reached for.
      const again = await runSubagent(pi, { action: 'close', agentId: 't195' }, repo);
      assert.match(again.content[0]!.text, /close is final/, 'it answers by pane id too');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: tool_result hook only rewrites our errors, and stays silent for a dead pane', async () => {
  const { root, pi } = await mountSubagent({
    tasks: [taskRow({ paneId: 'w1:p2', cwd: '/tmp', description: 'dead worker', createdAt: 1 })],
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

test('subagent plugin: close records the decision even when the memory row is already closed', async () => {
  // A memory row can be closed while the record trails off at `consumed`: the record should still
  // say who ended it, or the row looks like work that stopped by itself.
  const repo = mkdtempSync(join(tmpdir(), 'piher-close-idem-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    seedTaskDocuments(null, [{
      taskId: 'task-idem', description: 'already closed', paneId: 'pGone',
      createdAt: 1, consumedAt: 2, kind: 'worker', cwd: repo,
      tabId: 't1', tabName: 'w', lifecycle: 'persistent',
    }]);
    const { root, pi } = await mountSubagent({
      client: { listTerminals: async () => [] },
      tasks: [taskRow({ paneId: 'pGone', taskId: 'task-idem', cwd: repo, closedAt: 1 })],
    });
    try {
      const res = await runSubagent(pi, { action: 'close', agentId: 'task-idem' }, repo);
      assert.match(res.content[0]!.text, /closed by the master/);
      assert.match(res.content[0]!.text, /close is final/);
      const record = readTaskRecord(repo, 'task-idem');
      assert.ok(record && record.closedAt !== null, 'the record now carries the decision');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: a task closed in another session does not come back as settled', async () => {
  // The restore reads the view, then each referenced record: a record that says closed retires its
  // memory row. Without this the row a master closed yesterday keeps offering `action send revives`
  // in every new session of that project.
  const cwd = mkdtempSync(join(tmpdir(), 'piher-closed-record-'));
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const home = new TempHome('piher-closed-record-');
  try {
    const sessionFile = join(home.dir('sessions'), '2026-01-03T00-00-00-000Z_cccccccc-0000-4000-8000-000000000000.jsonl');
    seedTaskDocuments(sessionFile, [{
      taskId: 'task-closed', description: 'already handled', paneId: 'pGone',
      createdAt: Date.now() - 60_000, closedAt: Date.now() - 30_000, kind: 'worker',
      cwd, tabId: 't1', tabName: 'w', lifecycle: 'persistent',
    }]);
    const { root, pi } = await mountSubagent({
      client: { listTerminals: async () => [] },
      // The session holds a settled copy of the same task; the restore retires it from the record.
      tasks: [taskRow({ paneId: 'pGone', taskId: 'task-closed', tabId: 't1', tabName: 'w', cwd })],
      deps: { getSessionFile: () => sessionFile, getCwd: () => cwd },
    });
    try {
      const res = await runSubagent(pi, { action: 'list' }, cwd);
      assert.doesNotMatch(res.content[0]!.text, /already handled/, 'a closed task is not offered again');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('subagent plugin: resume refuses a record closed before its report was consumed (S9)', async () => {
  // Close on a settled persistent worker writes `closedAt` with `consumedAt` still null. The resume
  // verdict derives from those durable facts, so a disk-only row — another session's closed task —
  // can never revive, whatever status a memory copy would have synthesized for it.
  const repo = mkdtempSync(join(tmpdir(), 'piher-resume-closed-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const taskId = 'c10aff1e-0000-4000-8000-000000000001';
  try {
    seedTaskDocuments(null, [{
      taskId, paneId: 'pGone', cwd: repo, description: 'closed before report',
      createdAt: 1, closedAt: 2, consumedAt: null,
    }]);
    const { root, pi } = await mountSubagent({ deps: { getCwd: () => repo } });
    try {
      const refused = await runSubagentRejects(pi, { action: 'resume', taskId }, repo);
      assert.match(refused, /closed by the master/);
      assert.match(refused, /close is final/);
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subagent plugin: send to a disk-closed task never revives a new generation (S9/S24)', async () => {
  // Memory still holds the row as running when another session closes its record. The pane is gone,
  // so `send` reaches `reviveEntry` — which re-reads the disk authority and refuses instead of
  // putting a live pane behind a record that still says closed.
  const repo = mkdtempSync(join(tmpdir(), 'piher-send-closed-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const taskId = 'c10aff1e-0000-4000-8000-000000000002';
  const seed = (closedAt: number | null): void => {
    seedTaskDocuments(null, [{
      taskId, paneId: 'pDead', cwd: repo, description: 'closed elsewhere',
      createdAt: 1, closedAt, consumedAt: null,
    }]);
  };
  try {
    seed(null);
    const { root, pi } = await mountSubagent({
      client: { getTerminal: async () => null },
      tasks: [taskRow({ paneId: 'pDead', taskId, cwd: repo })],
      deps: { getCwd: () => repo },
    });
    try {
      seed(2);
      const refused = await runSubagentRejects(pi, { action: 'send', agentId: 'pDead', message: 'x' }, repo);
      assert.match(refused, /closed by the master/);
      const record = readTaskRecord(repo, taskId);
      assert.equal(record?.gen.paneId, 'pDead', 'no new generation was revived');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
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
    tasks: [taskRow({ paneId: 'pZombie', taskId: 'task-zombie', tabId: 't1', tabName: 'w' })],
  });
  try {
    // Outside any repository the decision has nowhere to land, so the test checkout stays clean.
    const cwd = mkdtempSync(join(tmpdir(), 'piher-close-cwd-'));
    const res = await runSubagent(pi, { action: 'close', agentId: 'pZombie' }, cwd);
    assert.match(res.content[0]!.text, /closed — pane and tab gone/);
    assert.deepEqual(retired, ['pZombie', 'pZombie'], 'the dead pane is still retired best-effort');
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: send to a live pane with a dead pipe fails fast and says nothing was delivered', async () => {
  // The 90 s readiness wait is for a pane that was just made. A pane that was already alive has no
  // listener, and waiting there turns a dead channel into a timeout that reads like a slow boot —
  // while the message never arrived (a real session spent 92 s on it, twice).
  const { root, pi } = await mountSubagent({
    client: { getTerminal: async (id: string) => terminalInfo({ id, state: 'live', status: 'working' }) },
    tasks: [taskRow({ paneId: 't-dead-pipe', taskId: 'task-dead-pipe', cwd: '/test/no-pipe' })],
  });
  try {
    const startedAt = Date.now();
    const text = await runSubagentRejects(pi, { action: 'send', agentId: 't-dead-pipe', message: 'hola' });
    assert.ok(Date.now() - startedAt < 20_000, `no readiness budget for a live pane (took ${Date.now() - startedAt}ms)`);
    assert.match(text, /its message channel is dead/);
    assert.match(text, /NOTHING was delivered/);
    assert.match(text, /action "resume"/);
    assert.doesNotMatch(text, /pipe not ready within/, 'a dead pipe is not a slow boot');
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: retry re-sends the stored prompt instead of asking the master to write it again', async () => {
  // An upstream failure says nothing about the task: rewriting the brief costs real tokens. The stored
  // prompt is the retry, and a row without one must say so instead of sending nothing.
  const home = new TempHome('prompt-retry');
  try {
    const taskId = 'task-retry-1';
    saveTaskPrompt(taskId, 'the original brief');
    assert.equal(readTaskPrompt(taskId), 'the original brief');
    const { root, pi } = await mountSubagent({
      client: { getTerminal: async (id: string) => terminalInfo({ id, state: 'live', status: 'idle' }) },
      tasks: [taskRow({ paneId: 't-retry', taskId, cwd: '/test/no-pipe' })],
    });
    try {
      // No pipe server behind that cwd: the send path reports the dead channel, which proves the stored
      // text was what it tried to deliver.
      const dead = await runSubagentRejects(pi, { action: 'retry', agentId: 't-retry' });
      assert.match(dead, /message channel is dead/);
      assert.doesNotMatch(dead, /no stored prompt/);

      forgetTaskPrompt(taskId);
      const missing = await runSubagentRejects(pi, { action: 'retry', agentId: 't-retry' });
      assert.match(missing, /no stored prompt/, 'a row without a brief names the reason instead of sending nothing');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
  }
});

test('subagent plugin: retry on a spent one-shot spawns the same brief instead of refusing like resume', async () => {
  // A one-shot reviewer that already reported has no pane and no resumable session, which is exactly
  // what `resume` refuses. The retry must still happen: same brief, same role, same checkout.
  const home = new TempHome('prompt-oneshot');
  try {
    const taskId = 'task-shot-1';
    saveTaskPrompt(taskId, 'the review brief');
    const { root, pi } = await mountSubagent({
      client: { available: false },
      tasks: [taskRow({
        paneId: 't-shot', taskId, consumedAt: 5, lifecycle: 'one-shot', kind: 'reviewer',
        description: 'review X', cwd: '/test/checkout',
      })],
    });
    try {
      const text = await runSubagentRejects(pi, { action: 'retry', agentId: 't-shot' });
      assert.doesNotMatch(text, /already delivered its verdict/, 'resume refuses a spent one-shot; retry must not');
      assert.doesNotMatch(text, /no stored prompt/, 'the stored brief was found');
      assert.match(text, /herdr-core/, 'it went to spawn, which is the only way to retry a spent one-shot');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
  }
});

test('subagent plugin: retry works from a closed row too, by starting a new worker', async () => {
  // A row can be closed by the master or by housekeeping. `send` and `resume` refuse it, but a retry
  // is a request for the work, not a resurrection: it starts a fresh worker with the same brief.
  const home = new TempHome('prompt-closed');
  try {
    const taskId = 'task-closed-1';
    saveTaskPrompt(taskId, 'a brief');
    const { root, pi } = await mountSubagent({
      client: { available: false },
      tasks: [taskRow({
        paneId: 't-closed', taskId, closedAt: 5, kind: 'reviewer', description: 'review Y',
      })],
    });
    try {
      const text = await runSubagentRejects(pi, { action: 'retry', agentId: 't-closed' });
      assert.doesNotMatch(text, /close is final/);
      assert.doesNotMatch(text, /no stored prompt/);
      assert.match(text, /herdr-core/, 'it went to spawn with the stored brief');
    } finally {
      await root.fiber.dispose();
    }
  } finally {
    home.dispose();
  }
});

test('subagent plugin: close reclaims a running row whose pane has no turn in flight', async () => {
  // A settlement the poller missed leaves the row `running` while the agent is idle: refusing the
  // close then strands the task forever, and `interrupt` cannot help because there is no turn to stop.
  const repo = mkdtempSync(join(tmpdir(), 'piher-close-repo-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  for (const status of ['idle', 'done', 'error'] as const) {
    // One task per iteration: a close persists, so a shared id would read back already closed.
    const taskId = `task-idle-${status}`;
    const retired: string[] = [];
    const { root, pi } = await mountSubagent({
      client: {
        getTerminal: async (id: string) => terminalInfo({ id, state: 'live', status }),
        kill: async (id: string) => { retired.push(id); },
        remove: async (id: string) => { retired.push(id); },
      },
      tasks: [taskRow({ paneId: 'p-idle', taskId, cwd: repo })],
    });
    try {
      const res = await runSubagent(pi, { action: 'close', agentId: 'p-idle' }, repo);
      assert.match(res.content[0]!.text, /closed — pane and tab gone/, `status ${status} must be closable`);
      const record = readTaskRecord(repo, taskId);
      assert.ok(record && record.closedAt !== null, 'the record carries the decision');
    } finally {
      await root.fiber.dispose();
    }
  }
  rmSync(repo, { recursive: true, force: true });
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
    tasks: [taskRow({ paneId: 'p-busy', taskId: 'task-busy' })],
  });
  try {
    const refused = await runSubagentRejects(pi, { action: 'close', agentId: 'p-busy' });
    assert.match(refused, /still running[\s\S]*interrupt/);
    assert.match(refused, /once it has finished/, 'S12: no turn is ever called settled');
    assert.deepEqual(retired, [], 'a refused close touches nothing');
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: interrupt names the way back for a settled and for a closed worker', async () => {
  const { root, pi } = await mountSubagent({
    // Both refusals happen before anything touches a pane: no pipe, no core calls.
    client: { available: false },
    tasks: [
      taskRow({ paneId: 'p-settled', taskId: 'task-settled', consumedAt: 1 }),
      taskRow({ paneId: 'p-closed', taskId: 'task-closed', closedAt: 1 }),
    ],
  });
  try {
    const settled = await runSubagentRejects(pi, { action: 'interrupt', agentId: 'p-settled' });
    assert.match(settled, /no running turn/, 'a settled worker has no turn to stop, and says so');
    assert.match(settled, /\(its pane is gone\)/, 'the refusal names what it observed');
    assert.match(settled, /action "close"/, 'and points at close, not a wait');
    assert.match(settled, /resume[\s\S]*task-settled/, 'the refusal names resume(taskId)');
    const closed = await runSubagentRejects(pi, { action: 'interrupt', agentId: 'p-closed' });
    assert.match(closed, /closed/, 'a closed worker says it is closed');
    assert.match(closed, /new subagent/, 'and points at new work, not a revive');
    assert.match(closed, /task-closed/, 'naming the task that ended');
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
    tasks: [taskRow({ paneId: 'p-done', taskId: 'task-done', consumedAt: 5 })],
  });
  try {
    // Outside any repository the decision has nowhere to land, so the test checkout stays clean.
    const cwd = mkdtempSync(join(tmpdir(), 'piher-close-cwd-'));
    const closed = await runSubagent(pi, { action: 'close', agentId: 'p-done' }, cwd);
    assert.match(closed.content[0]!.text, /p-done.*closed/);
    assert.match(closed.content[0]!.text, /new subagent/, 'a closed task points at new work');
    assert.deepEqual(retired, ['kill:p-done', 'remove:p-done'], 'the kill+rm pair the GC uses: pane and tab go');
    assert.equal(closed.details?.taskId, 'task-done', 'the record keeps the taskId, so resume answers from it');

    // Closing an already-closed row is a no-op, with the finality spelled out.
    const again = await runSubagent(pi, { action: 'close', agentId: 'p-done' }, cwd);
    assert.match(again.content[0]!.text, /close is final/);
    assert.deepEqual(retired, ['kill:p-done', 'remove:p-done']);
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent plugin: list shows every row with its live state', async () => {
  const worker = (paneId: string, taskId: string, description: string): TaskEntry => taskRow({
    paneId, taskId, tabId: 't-1', tabName: '', cwd: '/workspace/repo', description, createdAt: 1,
  });
  const { root, pi } = await mountSubagent({
    client: {
      available: false, // keeps the session-recovery pollers out of a rendering-only test
      getTerminal: async (id) => terminalInfo({ id, status: 'working', labels: { 'herdr.tab': 't-1' } }),
    },
    tasks: [worker('p-1', 'task-1', 'Worker 1'), worker('p-2', 'task-2', 'Worker 2')],
  });
  try {
    const lines = (await runSubagent(pi, { action: 'list' })).content[0]!.text.split('\n');
    assert.equal(lines[0], 'p-1 [running] (task · persistent) Worker 1');
    assert.equal(lines[1], 'p-2 [running] (task · persistent) Worker 2');
  } finally {
    await root.fiber.dispose();
  }
});

/* ── Phase 2 task slugs (RFC rfc-delegation-identity §3.1) ──────── */

test('slugifyTask / allocateTaskSlug / taskRef: kebab-case, non-ASCII fallback, dedupe, display form', () => {
  const CJK = '\u4e2d\u6587'; // a non-ASCII (CJK) word: wide glyphs, no ASCII letters
  assert.equal(slugifyTask('Fix Auth Flow!'), 'fix-auth-flow');
  assert.equal(slugifyTask('  read--me  '), 'read-me');
  assert.equal(slugifyTask('a'.repeat(40)), 'a'.repeat(24), 'slug caps at 24 chars');
  assert.equal(slugifyTask(CJK), '', 'non-ASCII words sanitize to nothing');
  const taken = new Set(['fix-auth']);
  assert.equal(allocateTaskSlug('fix auth', 'taskid', taken), 'fix-auth-2');
  assert.equal(allocateTaskSlug('fix auth', 'taskid', new Set(['fix-auth', 'fix-auth-2'])), 'fix-auth-3');
  assert.equal(allocateTaskSlug(CJK, '9faaa0e5-rest', new Set()), 'task-9faaa0', 'non-ASCII falls back to a taskId prefix');
  assert.equal(taskRef({ paneId: 'p2', slug: 'fix-auth' }), 'fix-auth@p2');
  assert.equal(taskRef({ paneId: 'p2', slug: '' }), 'p2', 'slug-less rows keep the bare paneId (back-compat)');
});


test('subagent plugin: a closed memory row is not resurrected from its record', async () => {
  // The restore seeds only unresolved rows, so a record left at `consumed` never brings back a
  // task the master already ended — a close that never took effect on screen.
  const repo = mkdtempSync(join(tmpdir(), 'piher-no-resurrect-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  seedTaskDocuments(null, [{
    taskId: 'task-ended', description: 'ended worker', paneId: 'pGone',
    createdAt: 10, consumedAt: 20, kind: 'worker', cwd: repo,
    tabId: 't1', tabName: 'w', lifecycle: 'persistent',
  }]);
  const { root, pi } = await mountSubagent({
    client: { listTerminals: async () => [] },
    tasks: [taskRow({ paneId: 'pGone', taskId: 'task-ended', cwd: repo, closedAt: 20 })],
  });
  try {
    const text = (await runSubagent(pi, { action: 'list' }, repo)).content[0]!.text;
    assert.doesNotMatch(text, /ended worker/, 'closed is closed, whatever the record still holds');
  } finally {
    await root.fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});
