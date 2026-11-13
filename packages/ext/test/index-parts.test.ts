/**
 * index.ts satellite parts: the D92 settlement-notice buffer with its rank hook, the process-mode
 * planner, cross-pane write locks, and the pi-surface proxy with its tombstone compensation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseNotices, createNoticeBuffer } from '../src/index-notices.ts';
import { planIndexMode, type IndexMode } from '../src/index-runtime.ts';
import { installWriteLocks } from '../src/index-locks.ts';
import { lockTokenKey, lockTokenValue } from '../src/lock-core.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { CoreEnv, TerminalInfo } from '../src/core-client.ts';
import { fakeCore, fakePi, fire, terminalInfo, type FakePi } from './test-utils.ts';

/* ── index-notices: D92 settlement-notice buffer ────────────────── */

/** A buffer whose delivery sink is observable; `busy` picks the immediate or the queueing branch. */
const noticeBuf = (busy: boolean) => {
  const sent: Array<{ content: string; mode: string }> = [];
  const buf = createNoticeBuffer({ isBusy: () => busy, send: async (content, mode) => { sent.push({ content, mode }); } });
  return { buf, sent };
};

test('createNoticeBuffer: idle delivers immediately and drops pane pending', async () => {
  const { buf, sent } = noticeBuf(false);
  await buf.deliverNotice('hello', 'p1');
  assert.deepEqual(sent, [{ content: 'hello', mode: 'followUp' }]);
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: busy queues; flush steer collapses and clears GC exemption', async () => {
  const { buf, sent } = noticeBuf(true);
  await buf.deliverNotice('a', 'p1');
  await buf.deliverNotice('b', 'p2');
  assert.equal(sent.length, 0);
  assert.deepEqual([...buf.noticePending()], ['p1', 'p2']);
  await buf.flush('steer');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, 'steer');
  assert.match(sent[0].content, /a/);
  assert.match(sent[0].content, /b/);
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: a settlement landing during compaction is buffered and flushed after it settles', async () => {
  // Mirrors index.ts: the agent is idle while compaction runs, so isBusy also covers compactionInFlight.
  const sent: Array<{ content: string; mode: string }> = [];
  let agentActive = false;
  let compactionInFlight = true;
  const buf = createNoticeBuffer({
    isBusy: () => agentActive || compactionInFlight,
    send: async (content, mode) => { sent.push({ content, mode }); },
  });
  await buf.deliverNotice('wA:p5F finished: report attached', 'wA:p5F');
  assert.equal(sent.length, 0, 'nothing is sent into a compacting session');
  assert.deepEqual([...buf.noticePending()], ['wA:p5F'], 'the pane stays GC-exempt while its notice is buffered');
  // The continuation run starts and ends; agent_settled flushes the buffer.
  compactionInFlight = false;
  await buf.flush('followUp');
  assert.deepEqual(sent, [{ content: 'wA:p5F finished: report attached', mode: 'followUp' }]);
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: a refused send is re-queued, not lost, and keeps its pane exempt', async () => {
  // The abort case: pi drops a prompt while it compacts, so the flush must hold the batch back
  // instead of splicing it away — the loss the buffering exists to prevent.
  let refuse = true;
  const sent: Array<{ content: string; mode: string; card?: unknown }> = [];
  const card = { name: 'wA:p5', role: 'worker', outcome: 'settled' as const, elapsedMs: 5 };
  const buf = createNoticeBuffer({
    isBusy: () => false,
    send: async (content, mode, c) => {
      if (refuse) throw new Error('session is compacting');
      sent.push({ content, mode, ...(c ? { card: c } : {}) });
    },
  });

  await buf.deliverNotice('settled wA:p5', 'wA:p5', card);
  assert.deepEqual(sent, []);
  assert.deepEqual([...buf.noticePending()], ['wA:p5'], 'the pane stays GC-exempt while its notice is undelivered');

  refuse = false;
  await buf.flush('followUp');
  assert.deepEqual(sent, [{ content: 'settled wA:p5', mode: 'followUp', card }], 'the retry keeps the card');
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: a batch a refused flush put back is delivered by the next flush', async () => {
  let busy = true;
  let refuse = true;
  const seen: string[] = [];
  const buf = createNoticeBuffer({
    isBusy: () => busy,
    send: async (content) => { if (refuse) throw new Error('compacting'); seen.push(content); },
  });
  await buf.deliverNotice('a', 'p1');
  await buf.deliverNotice('b', 'p2');
  await buf.flush('steer');
  assert.deepEqual(seen, [], 'the steer flush during compaction sent nothing');
  assert.deepEqual([...buf.noticePending()], ['p1', 'p2'], 'both panes stay exempt, nothing was released');
  refuse = false;
  busy = false;
  await buf.flush('followUp');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /a[\s\S]*b/);
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: delivery is recorded only when pi took the message', async () => {
  // The ledger's one ordering rule lives here: a notice the buffer holds, or a send pi refused, is not
  // a delivered settlement — so `onAccepted` must not fire for either.
  let busy = true;
  let refuse = true;
  const accepted: string[] = [];
  const buf = createNoticeBuffer({
    isBusy: () => busy,
    send: async () => {
      if (refuse) throw new Error('pi is mid-turn');
      return true;
    },
  });
  await buf.deliverNotice('buffered', 'p1', null, () => { accepted.push('buffered'); });
  assert.deepEqual(accepted, [], 'a notice only the buffer holds accepted nothing');

  await buf.flush('steer'); // refused
  assert.deepEqual(accepted, [], 'a refused send accepted nothing');

  busy = false;
  refuse = false;
  await buf.flush('followUp');
  assert.deepEqual(accepted, ['buffered'], 'the delivery pi took is the one that is recorded');
});

test('createNoticeBuffer: a host with no send method records no delivery', async () => {
  // `sendSettlementNotice` answers false when pi has no way to take a message: requeued, not claimed.
  const buf = createNoticeBuffer({ isBusy: () => false, send: async () => false });
  let accepted = 0;
  await buf.deliverNotice('nowhere to go', 'p1', null, () => { accepted += 1; });
  assert.equal(accepted, 0, 'nothing reached the master, so nothing is recorded');
  assert.deepEqual([...buf.noticePending()], ['p1'], 'and the pane stays exempt for the retry');
});

test('collapseNotices: empty → null; ≤3 verbatim; >3 → first three + count/pointer tail', () => {
  assert.equal(collapseNotices([]), null, 'an empty batch is not injected');
  const three = [5, 6, 7].map((n) => `Background subagent w8:p${n} (task) finished.`);
  // At or below the cap the panes' own wording survives byte-identical: no wrapper, no tail line.
  for (const batch of [[three[0]!], three]) assert.equal(collapseNotices(batch), batch.join('\n\n'));

  const over = collapseNotices([...three, 'n4', 'n5'])!;
  assert.ok(over.startsWith(`${three.join('\n\n')}\n\n`));
  const tail = over.split('\n\n').pop()!;
  assert.match(tail, /2 more settlement\(s\) not shown individually/);
  assert.match(tail, /worker's own transcript/);
  assert.match(tail, /subagent list for running agents/);
  assert.ok(!over.includes('\n\nn4') && !over.includes('\n\nn5'));
});

/** Busy buffer whose send is observable: the batch is only visible through the collapsed send. */
const busyNotices = (sendImpl?: (content: string) => Promise<void>) => {
  const sent: string[] = [];
  const buf = createNoticeBuffer({
    isBusy: () => true,
    send: async (content) => { if (sendImpl) await sendImpl(content); sent.push(content); },
  });
  return { buf, sent };
};

test('createNoticeBuffer: a notice buffered while a send is pending keeps its pane exempt from GC', async () => {
  const gate = Promise.withResolvers<void>();
  const { buf, sent } = busyNotices(async () => { await gate.promise; });
  for (const [n, pane] of [['a', 'p1'], ['b', 'p2'], ['c', 'p3'], ['d', 'p4']] as const) await buf.deliverNotice(n, pane);
  const flushing = buf.flush('steer');
  await buf.deliverNotice('late', 'p7'); // settles during the send await; the agent is still busy
  gate.resolve();
  await flushing;
  assert.equal(sent.length, 1);
  assert.deepEqual([...buf.noticePending()], ['p7'], 'only the flushed batch releases its panes');
  await buf.flush('followUp');
  assert.equal(sent[1], 'late');
  assert.equal(buf.noticePending().size, 0);
});

/* ── index-runtime: process-mode planner ────────────────────────── */

test('planIndexMode: worker flag wins inside a core terminal; core terminal → master; no core → neither', () => {
  const coreEnv = { HC_TERMINAL_SOCKET: '/tmp/s', HC_TERMINAL_ID: 't1' };
  const CASES: Array<[string, NodeJS.ProcessEnv, IndexMode]> = [
    ['worker flag inside core', { ...coreEnv, PIHER_SUBAGENT: '1' }, { isSubagent: true, hasCore: true, composeMaster: false }],
    ['core terminal without the worker flag', coreEnv, { isSubagent: false, hasCore: true, composeMaster: true }],
    ['terminal id without a socket', { HC_TERMINAL_ID: 't1' }, { isSubagent: false, hasCore: false, composeMaster: false }],
    ['core unavailable', {}, { isSubagent: false, hasCore: false, composeMaster: false }],
  ];
  for (const [name, env, expect] of CASES) assert.deepEqual(planIndexMode(env), expect, name);
});

/* ── index-locks: write-lock installer wiring ───────────────────── */

/** pi's tool_call dispatch: the first handler that returns a verdict wins. */
async function toolCallVerdict(pi: FakePi, event: unknown, ctx: unknown) {
  for (const handler of pi.listeners.get('tool_call') ?? []) {
    const verdict = await handler(event, ctx) as { block?: boolean; reason?: string } | undefined;
    if (verdict) return verdict;
  }
  return undefined;
}

/** One live terminal: the address plus whatever the case overrides. */
const terminalAt = (id: string, over: Partial<TerminalInfo> = {}): TerminalInfo => terminalInfo({ id, status: 'working', ...over });

test('installWriteLocks: a peer lock blocks a relative write at the pane-resolved cwd', async (t) => {
  const win = process.platform === 'win32';
  const ctxCwd = win ? 'C:\\repo' : '/repo';
  const CASES: Array<{ name: string; own: Partial<TerminalInfo>; lockedPath: string }> = [
    // The terminal's own foreground cwd outranks the event ctx.cwd:
    // 'file.ts' then resolves into /repo/sub and collides with t2's lock on /repo/sub/file.ts.
    { name: 'foreground cwd from the live terminal list outranks ctx.cwd', own: { foreground: { pid: 1, name: 'pi', argv: [], cwd: win ? 'C:\\repo\\sub' : '/repo/sub' } },
      lockedPath: win ? 'c:/repo/sub/file.ts' : '/repo/sub/file.ts' },
    // No foreground info: ctx.cwd is the resolution root.
    { name: 'falls back to ctx.cwd when the pane reports none', own: {}, lockedPath: win ? 'c:/repo/file.ts' : '/repo/file.ts' },
  ];

  for (const c of CASES) {
    await t.test(c.name, async () => {
      const reported: Array<Record<string, string | null>> = [];
      const client = fakeCore({
        listTerminals: async () => [
          // t1 is our own terminal; t2 holds a lock on the resolved target path.
          terminalAt('t1', c.own),
          terminalAt('t2', { labels: { [lockTokenKey(c.lockedPath)]: lockTokenValue(c.lockedPath, 't2') } }),
        ],
        setLabels: async (labels) => { reported.push(labels); },
      });
      const env: CoreEnv = { socketPath: '/tmp/core.sock', terminalId: 't1' };
      const pi = fakePi();
      const handle = installWriteLocks(pi as never, { client, env, hard: true });

      const verdict = await toolCallVerdict(pi, { toolName: 'write', toolCallId: 'call-1', input: { path: 'file.ts' } }, { cwd: ctxCwd });

      assert.ok(verdict?.block, 'a relative write colliding with a peer lock must be blocked');
      assert.match(verdict.reason ?? '', /locked by pane t2/);
      assert.deepEqual(handle.getHeldLocks(), [], 'a blocked call must not acquire the lock');
      assert.deepEqual(reported, [], 'a blocked call must not claim the lock in the pane registry');
    });
  }
});

/* ── pi-surface: the per-module registration proxy (D79) ────────── */

const callTool = (pi: FakePi, name: string, ...a: unknown[]) => pi.tools.get(name)?.execute?.(...a);

/** Mount a generation: a `demo` tool returning `tag`, plus a turn_start handler counting its fires. */
function mount(s: PiSurface<FakePi>, key: string, tag: string): { fired: () => number } {
  let fired = 0;
  const scoped = s.forModule(key);
  scoped.registerTool({ name: 'demo', execute: async () => tag });
  scoped.on('turn_start', () => { fired++; });
  return { fired: () => fired };
}

test('surface: registrations pass through while the generation is alive', async () => {
  const pi = fakePi();
  const scoped = new PiSurface(pi).forModule('core/a');
  let fired = 0;
  scoped.on('session_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  await fire(pi, 'session_start');
  assert.equal(fired, 1);
  assert.equal(await callTool(pi, 't1'), 'OK');
});

test('surface: disposeModule tombstones the handler and puts the tool inert', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  assert.equal(s.disposeModule('core/a'), true);
  await fire(pi, 'turn_start');
  assert.equal(fired, 0, 'a tombstoned handler must not fire (hmr double-fire fix)');
  assert.match(((await callTool(pi, 't1')) as { content: Array<{ text: string }> }).content[0]!.text, /disposed/);
  assert.equal(s.disposeModule('core/a'), false, 'a second dispose is an idempotent false');
});

test('surface: hot swap — the new generation wins and the old handler stays silent', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const v1 = mount(s, 'core/a', 'v1');
  s.disposeModule('core/a'); // hmr compensation tears the old generation down
  const v2 = mount(s, 'core/a', 'v2');
  assert.equal(await callTool(pi, 'demo'), 'v2', 'tools overwrite by name: the new version wins');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 0, 'the old handler is tombstoned (no double fire)');
  assert.equal(v2.fired(), 1, 'the new handler fires once');
});

test('surface: ledger interlock — disposing a key flips its tombstone', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  let fired = 0;
  s.forModule('core/a').on('session_start', () => { fired++; });
  ledger.disposeKey('core/a'); // the same path hmr/reload takes
  await fire(pi, 'session_start');
  assert.equal(fired, 0, 'ledger compensation is a tombstone');
});

test('surface: hmr ordering — a disposeKey after the remount must not kill the new generation', async () => {
  // Real cordis-plugin-hmr order: registry.delete → the replacement remounts on the same key →
  // emit('hmr/reload') → ledger.disposeKey(file). Generations mounted after the ledger entry are
  // exempt, so the replacement's tools survive instead of dying on arrival.
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  const KEY = 'file:///F:/repo/src/plugins/demo.ts';
  const v1 = mount(s, KEY, 'v1');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 1, 'precondition: v1 alive');

  const v2 = mount(s, KEY, 'v2'); // the replacement body runs and re-registers
  ledger.disposeKey(KEY); // compensation arrives only after the remount

  assert.equal(await callTool(pi, 'demo'), 'v2', 'the new generation must survive (dead-on-arrival regression)');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 1, 'the old generation went no-op at remount (no double fire)');
  assert.equal(v2.fired(), 1, 'the new generation fires');
});

test('surface: pi 0.86 unsubscribe — retirement removes the listener instead of only tombstoning it', async () => {
  const base = fakePi();
  const removed: string[] = [];
  const pi: FakePi = {
    ...base,
    on(event, handler) {
      base.on(event, handler);
      return () => {
        base.listeners.set(event, (base.listeners.get(event) ?? []).filter((h) => h !== handler));
        removed.push(event);
      };
    },
  };
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  await fire(pi, 'turn_start');
  assert.equal(fired, 1);
  assert.deepEqual(removed, [], 'no early unsubscribe while alive');

  s.disposeModule('core/a');
  assert.deepEqual(removed, ['turn_start'], 'retirement calls the unsubscribe');
  assert.deepEqual(pi.listeners.get('turn_start') ?? [], [], 'the dispatch list really shrinks');
  assert.match(((await callTool(pi, 't1')) as { content: Array<{ text: string }> }).content[0]!.text, /disposed/, 'tools still tombstone: pi has no unregisterTool');
});
