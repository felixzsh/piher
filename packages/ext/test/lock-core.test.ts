/** lock-core (write locks): pure planners.
 *  Lock beacons: terminal label `piher.lock.<hash>` → value `terminalId|path`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireTokensFor, bashWriteTargets, findLockHolders, fnv1a64, isLockTokenKey, LOCK_TOKEN_PREFIX,
  lockTokenKey, lockTokenValue, normalizeLockPath, parseLockTokenValue, planWriteGuard, releaseTokensFor, WRITE_LOCK_ENV,
  WRITE_TOOLS, writePathsOfTool, type LockAgentView,
} from '../src/lock-core.ts';

// Platform-native forms: a foreign-platform path would resolve as relative on this host.
const CWD = process.platform === 'win32' ? 'F:\\proj' : '/proj';
/** Normalized form of locked file a.cs; LOCKED_ALT is the same file with case/separator jitter. */
const LOCKED = process.platform === 'win32' ? 'f:/proj/a.cs' : '/proj/a.cs';
const LOCKED_ALT = process.platform === 'win32' ? 'F:\\Proj\\A.CS' : '/Proj/A.CS';

const agent = (paneId: string, locks: Record<string, string>): LockAgentView => ({
  paneId, tokens: Object.fromEntries(Object.entries(locks).map(([p, holder]) => [lockTokenKey(p), lockTokenValue(p, holder)])),
});

const guard = (opts: { toolName: string; input: unknown; agents: readonly LockAgentView[]; ownPaneId: string; hard?: boolean }) =>
  planWriteGuard({ cwd: CWD, hard: false, ...opts });

test('normalizeLockPath: separators unified, lowercased, relative → absolute, trailing slash dropped', () => {
  const cases: Array<[string, string]> = process.platform === 'win32'
    ? [['F:\\A\\B.cs', 'f:/a/b.cs'], ['f:/a/b.cs', 'f:/a/b.cs'], ['src/x.ts', 'f:/proj/src/x.ts'], ['f:/a/', 'f:/a'], ['F:\\A\\..\\A\\B.cs', 'f:/a/b.cs']]
    : [['/A/B.cs', '/a/b.cs'], ['/a/b.cs', '/a/b.cs'], ['src/x.ts', '/proj/src/x.ts'], ['/a/', '/a'], ['/A/../A/B.cs', '/a/b.cs']];
  for (const [input, expected] of cases) assert.equal(normalizeLockPath(input, CWD), expected);
});

test('lockTokenKey: label-namespaced hash key, stable per path, distinct across paths', () => {
  const key = lockTokenKey('f:/some/long/path/to/a file.cs');
  assert.match(key, /^piher\.lock\.[0-9a-f]{16}$/); assert.ok(key.startsWith(LOCK_TOKEN_PREFIX));
  assert.equal(isLockTokenKey(key), true); assert.equal(isLockTokenKey('piher.demo'), false);
  assert.equal(isLockTokenKey(LOCK_TOKEN_PREFIX), false); assert.equal(lockTokenKey('f:/a.cs'), lockTokenKey('f:/a.cs'), 'all terminals must derive one key per path');
  assert.notEqual(lockTokenKey('f:/a.cs'), lockTokenKey('f:/b.cs')); assert.match(fnv1a64('f:/a.cs'), /^[0-9a-f]{16}$/);
});

test('lockTokenValue / parseLockTokenValue: round-trip; malformed value → null', () => {
  assert.deepEqual(parseLockTokenValue(lockTokenValue('f:/a.cs', 'w6:p9Q')), { holderPaneId: 'w6:p9Q', path: 'f:/a.cs' });
  assert.equal(parseLockTokenValue('no-separator'), null); assert.equal(parseLockTokenValue('|lead'), null);
  assert.equal(parseLockTokenValue('trail|'), null);
});

test('acquire/release tokens: hash keys, acquire carries paneId|path, release clears with null', () => {
  const acq = acquireTokensFor(['f:/a.cs', 'f:/b.cs'], 'pZ');
  assert.deepEqual(Object.keys(acq).sort(), [lockTokenKey('f:/a.cs'), lockTokenKey('f:/b.cs')].sort()); assert.equal(acq[lockTokenKey('f:/a.cs')], 'pZ|f:/a.cs');
  assert.deepEqual(releaseTokensFor(['f:/a.cs']), { [lockTokenKey('f:/a.cs')]: null });
});

test('writePathsOfTool: write/edit expose their path; other tools expose none', () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), ['edit', 'write'], 'only these tools register locks');
  assert.equal(WRITE_LOCK_ENV, 'PIHER_WRITE_LOCK', 'documented env knob for hard mode');
  assert.deepEqual(writePathsOfTool('write', { path: 'F:/a.cs', content: 'x' }), ['F:/a.cs']);
  assert.deepEqual(writePathsOfTool('edit', { path: 'F:/a.cs', edits: [] }), ['F:/a.cs']); assert.deepEqual(writePathsOfTool('bash', { command: 'rm x' }), []);
  assert.deepEqual(writePathsOfTool('read', { path: 'F:/a.cs' }), []); assert.deepEqual(writePathsOfTool('write', {}), []);
});

test('findLockHolders: lists every other holder, dedupes, excludes self and cleared tokens', () => {
  const agents: LockAgentView[] = [
    agent('pA', { 'f:/a.cs': 'pA' }),
    agent('pB', { 'f:/a.cs': 'pB' }),
    agent('pC', { 'f:/a.cs': 'pA' }), // same holder twice
    { paneId: 'pD', tokens: { [lockTokenKey('f:/c.cs')]: null, unrelated: 'x' } },
  ];
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/a.cs'), ['pA', 'pB']); assert.deepEqual(findLockHolders(agents, 'pA', 'f:/a.cs'), ['pB'], 'self is excluded');
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/c.cs'), [], 'a cleared token holds nothing'); assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/zz.cs'), []);
});

test('planWriteGuard: non-write tool / missing path skip; no conflict pass; same-pane reentry pass', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  assert.equal(guard({ toolName: 'read', input: { path: 'a.cs' }, agents, ownPaneId: 'pB', hard: true }).kind, 'skip');
  assert.equal(guard({ toolName: 'write', input: {}, agents: [], ownPaneId: 'pB' }).kind, 'skip');
  assert.equal(guard({ toolName: 'write', input: { path: 'other.cs', content: '' }, agents, ownPaneId: 'pB', hard: true }).kind, 'pass');
  assert.equal(guard({ toolName: 'write', input: { path: 'a.cs', content: '' }, agents, ownPaneId: 'pA', hard: true }).kind, 'pass');
});

test('planWriteGuard: soft mode (default) → warn naming path/holders and both lookups, tool passes', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  const g = guard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB' });
  assert.equal(g.kind, 'warn');
  if (g.kind !== 'warn') return;
  assert.deepEqual(g.holderPaneIds, ['pA']); assert.deepEqual(g.paths, [LOCKED], 'the normalized path is what matches the token');
  assert.match(g.warning, /pA/); assert.match(g.warning, /a\.cs/i);
  assert.match(g.warning, /conflict|locked/i); assert.match(g.warning, /by pane pA /, 'single holder is singular');
  assert.match(g.warning, /\/piher-locks/, 'human view'); assert.match(g.warning, /hc ls.*piher\.lock\./, 'agent-readable view');
});

test('planWriteGuard: hard mode → block, reason lists every holder plus the lookup hint', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' }), agent('pB', { [LOCKED]: 'pB' })];
  const g = guard({ toolName: 'edit', input: { path: LOCKED_ALT, edits: [] }, agents, ownPaneId: 'pZ', hard: true });
  assert.equal(g.kind, 'block');
  if (g.kind !== 'block') return;
  assert.deepEqual(g.holderPaneIds, ['pA', 'pB']); assert.match(g.reason, /panes pA, pB/);
  assert.match(g.reason, /locked/i); assert.match(g.reason, /hc ls.*piher\.lock\./);
});

test('bashWriteTargets: obvious redirect / tee / sed -i / truncate targets, nothing guessed', () => {
  const cases: Array<[string | undefined, string[]]> = [
    ['echo hi > out.txt', ['out.txt']],
    ['npm test >> logs/build.log', ['logs/build.log']],
    ['cat a b > "my file.txt"', ['my file.txt']],
    ["printf x | tee -a 'report.csv'", ['report.csv']],
    ["sed -i '' 's/a/b/' src/app.ts", ['src/app.ts']],
    ["sed -i.bak 's/a/b/' src/app.ts", ['src/app.ts']],
    ['truncate -s 0 cache.db', ['cache.db']],
    ['echo x > a.txt && echo y >> a.txt', ['a.txt']], // deduped
    ['git status', []],
    ['echo "a > b"', []],
    ['make 2>&1', []],
    [undefined, []],
    ['', []],
  ];
  for (const [command, expected] of cases) {
    assert.deepEqual(bashWriteTargets(command), expected, `bashWriteTargets(${JSON.stringify(command)})`);
  }
});

test('planWriteGuard (bash): conflicting bash write warns even under hard lock, write tool still blocks', () => {
  const agents = [agent('p9', { [LOCKED]: 'p9' })];
  // hard mode cannot block shell writes: unparsed shell means false positives are too costly
  const bash = guard({ toolName: 'bash', input: { command: `sed -i '' 's/a/b/' ${LOCKED_ALT}` }, agents, ownPaneId: 'pB', hard: true });
  assert.equal(bash.kind, 'warn');
  if (bash.kind !== 'warn') return;
  assert.deepEqual(bash.paths, [LOCKED]); assert.match(bash.warning, /not blocked/);
  assert.match(bash.warning, /re-read the file/);

  const write = guard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB', hard: true });
  assert.equal(write.kind, 'block');
  assert.equal(guard({ toolName: 'bash', input: { command: 'echo hi > free.txt' }, agents, ownPaneId: 'pB', hard: true }).kind, 'pass');
  assert.equal(guard({ toolName: 'bash', input: { command: `echo x > ${LOCKED_ALT}` }, agents, ownPaneId: 'p9', hard: true }).kind, 'pass');
});
