/**
 * Adoption on mount: a reload forgets the job registry while core keeps the jobs alive, so a fresh
 * mount asks core which panes still carry its label and picks them up — a live one keeps its watch,
 * and one that exited while nobody was listening is reported with its own exit code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisProvide } from '../../src/cordis-services.ts';
import { PiSurface } from '../../src/pi-surface.ts';
import bgJobPlugin from '../../src/plugins/bg-job.ts';
import { JOB_LABEL_KEY, JOB_META_LABEL, JOB_NOTICE_CUSTOM_TYPE, encodeJobMeta } from '../../src/bg-job-core.ts';
import { fakeCore, fakePi, fire, terminalInfo, withCleanup, type FakePi } from '../test-utils.ts';

async function mount(client: Parameters<typeof fakeCore>[0], pi: FakePi = fakePi()): Promise<{ pi: FakePi; root: Context }> {
  const root = new Context();
  cordisProvide(root, 'piher.surface', new PiSurface(pi as unknown as object));
  cordisProvide(root, 'piher.bg-job-deps', {
    client: fakeCore(client),
    env: { socketPath: '/tmp/hc-test.sock', terminalId: 't0' },
    state: { activePaneIds: () => new Set<string>() },
  });
  await root.plugin(bgJobPlugin);
  return { pi, root };
}

function jobTerminal(over: { id: string; jobId: string; started?: number; state?: 'live' | 'finished'; exitCode?: number | null }) {
  return terminalInfo({
    id: over.id,
    cwd: '/repo',
    state: over.state ?? 'live',
    exitCode: over.exitCode ?? null,
    labels: {
      [JOB_LABEL_KEY]: over.jobId,
      [JOB_META_LABEL]: encodeJobMeta({
        name: 'build',
        log: '/tmp/piher-jobs/job.log',
        started: over.started ?? Date.now() - 1_000,
        timeout: 300,
        command: 'cargo build',
      }),
    },
  });
}

test('mount: a job that exited during the reload is reported with its own exit code', withCleanup(async () => {
  const terminals = [jobTerminal({ id: 't9', jobId: 'job-1xk3', state: 'finished', exitCode: 101 })];
  const { pi, root } = await mount({ listTerminals: async () => terminals });
  try {
    await fire(pi, 'session_start', {}, {});
    const notice = pi.sent.find((m) => m.msg.customType === JOB_NOTICE_CUSTOM_TYPE);
    assert.ok(notice, 'the owed exit notice is delivered on mount');
    assert.match(String(notice.msg.content), /exited with code 101/);
    assert.equal((notice.msg.details as { jobId?: string }).jobId, 'job-1xk3');
  } finally {
    await root.fiber.dispose();
  }
}));

test('mount: a live job is adopted, listed, and keeps its watch', withCleanup(async () => {
  const terminals = [jobTerminal({ id: 't9', jobId: 'job-2xk3' })];
  const watched: string[] = [];
  const { pi, root } = await mount({
    listTerminals: async () => terminals,
    getTerminal: async (id) => terminals.find((terminal) => terminal.id === id) ?? null,
    watchChildren: () => ({
      connected: true,
      ready: async () => true,
      get: () => undefined,
      list: () => [],
      version: (id) => { watched.push(id); return 0; },
      // Park like the real client does: `changed` waits for an event or the heartbeat.
      changed: () => new Promise<boolean>(() => {}),
      close: () => {},
    }),
  });
  try {
    await fire(pi, 'session_start', {}, {});
    const list = await pi.tools.get('bg_job')!.execute!('tc', { action: 'list' }, undefined, undefined, {}) as {
      content: Array<{ text: string }>;
    };
    assert.match(list.content[0]!.text, /job-2xk3 · running · build/);
    assert.deepEqual(watched, ['t9'], 'the adopted job is watched through its pane');
    assert.equal(pi.sent.length, 0, 'a running job says nothing on mount');
  } finally {
    await root.fiber.dispose();
  }
}));

test('mount: adopting twice cannot double-count or re-report a job', withCleanup(async () => {
  const terminals = [jobTerminal({ id: 't9', jobId: 'job-3xk3', state: 'finished', exitCode: 0 })];
  const { pi, root } = await mount({ listTerminals: async () => terminals });
  try {
    await fire(pi, 'session_start', {}, {});
    await fire(pi, 'session_start', {}, {});
    assert.equal(pi.sent.filter((m) => m.msg.customType === JOB_NOTICE_CUSTOM_TYPE).length, 1);
  } finally {
    await root.fiber.dispose();
  }
}));

test('mount: a pane that is not a job is ignored', withCleanup(async () => {
  const { pi, root } = await mount({
    listTerminals: async () => [terminalInfo({ id: 't5', labels: { 'piher.session': 'abc' } })],
  });
  try {
    await fire(pi, 'session_start', {}, {});
    assert.equal(pi.sent.length, 0);
    const list = await pi.tools.get('bg_job')!.execute!('tc', { action: 'list' }, undefined, undefined, {}) as {
      content: Array<{ text: string }>;
    };
    assert.match(list.content[0]!.text, /No background jobs/);
  } finally {
    await root.fiber.dispose();
  }
}));
