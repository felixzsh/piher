/** The per-session registry document: the durable copy that replaced the bounded `piher.subs` branch
 *  entry. What matters here is that a reload never drops a row the master can still address. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fire, mountSubagent, runSubagent, subEntry } from './test-utils.ts';
import { readRegistryFile, seedRegistryFile, writeRegistryFile } from '../src/subagent-registry-file.ts';
import { makeRegistry, type SubEntry } from '../src/subagent-core.ts';
import { sessionStatePath } from '../src/session-state.ts';

const SESSION = '2026-11-07T01-43-01-979Z_01a1b3ac-645b-7278-8851-42511cb0192e.jsonl';

function scratch(): { dir: string; sessionFile: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'piher-registry-file-'));
  const sessionFile = join(dir, 'sessions', SESSION);
  return { dir, sessionFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('registry file: rewritten in place, a torn document reads as absent, and a fork seeds once', () => {
  const s = scratch();
  try {
    const file = sessionStatePath(s.sessionFile, 'registry.json');
    assert.ok(file, 'a transcript path has a per-session state root');
    assert.equal(readRegistryFile(file), null, 'nothing written yet');

    writeRegistryFile(file, makeRegistry([subEntry({ paneId: 't1', slug: 'one', taskId: 'task-1' })]));
    assert.deepEqual(readRegistryFile(file)?.subs.map((row) => row.paneId), ['t1']);

    // The document is replaced, not appended: one row in, one row out.
    writeRegistryFile(file, makeRegistry([subEntry({ paneId: 't2', slug: 'two', taskId: 'task-2' })]));
    assert.deepEqual(readRegistryFile(file)?.subs.map((row) => row.paneId), ['t2']);

    writeFileSync(file, '{"version":2,"subs":[{"paneId":');
    assert.equal(readRegistryFile(file), null, 'a half-written document is no registry, not a crash');

    // A fork inherits its parent's document exactly once.
    const child = sessionStatePath(join(s.dir, 'sessions', '2026-11-07T02-00-00-000Z_01a1dead-0000-7000-8000-000000000000.jsonl'), 'registry.json');
    assert.ok(child);
    writeRegistryFile(file, makeRegistry([subEntry({ paneId: 'tParent', taskId: 'task-parent' })]));
    assert.equal(seedRegistryFile(child, file), true);
    assert.deepEqual(readRegistryFile(child)?.subs.map((row) => row.paneId), ['tParent']);
    assert.equal(seedRegistryFile(child, file), false, 'a session that already has state is never overwritten');
    assert.equal(seedRegistryFile(child, join(s.dir, 'missing.json')), false, 'a missing parent seeds nothing');
  } finally {
    s.dispose();
  }
});

/** Rows older than the old tail of ten, newest first: the shape that lost `t195`. */
function settledRows(count: number, repo: string): SubEntry[] {
  return Array.from({ length: count }, (_, i) => subEntry({
    taskId: `task-${i.toString().padStart(2, '0')}`,
    paneId: `p${i.toString().padStart(2, '0')}`,
    slug: `worker-${i.toString().padStart(2, '0')}`,
    description: `worker ${i}`,
    cwd: repo,
    status: 'consumed',
    createdAt: 1_000 + i,
    consumedAt: 2_000 + i,
  }));
}

test('registry file: a row older than ten settlements survives a reload', async () => {
  const s = scratch();
  try {
    const rows = settledRows(13, s.dir);
    // A real session writes the document on its first state change; closing a row is one.
    const first = await mountSubagent({
      subs: rows,
      deps: { getSessionFile: () => s.sessionFile },
    });
    const file = sessionStatePath(s.sessionFile, 'registry.json');
    try {
      await runSubagent(first.pi, { action: 'close', agentId: 'worker-12@p12' }, s.dir);
    } finally {
      await first.root.fiber.dispose();
    }
    assert.ok(file && existsSync(file), 'the registry document exists after a change');
    assert.equal(readRegistryFile(file)!.subs.length, 13, 'every row is kept, not a tail of ten');

    // The reload: a new extension instance whose branch carries nothing (the state that used to be
    // all it had). The document is the whole memory now.
    const second = await mountSubagent({
      subs: [],
      deps: { getSessionFile: () => s.sessionFile },
    });
    try {
      await fire(second.pi, 'session_start', { reason: 'reload' }, { sessionManager: { getBranch: () => [] } });
      const listed = (await runSubagent(second.pi, { action: 'list' }, s.dir)).content[0]!.text;
      assert.match(listed, new RegExp('worker-00@p00'), 'the oldest row is still the master\'s business');
      const closed = await runSubagent(second.pi, { action: 'close', agentId: 'worker-00@p00' }, s.dir);
      assert.match(closed.content[0]!.text, /Subagent worker-00@p00 closed/, 'and it answers the ref list printed');
    } finally {
      await second.root.fiber.dispose();
    }
  } finally {
    s.dispose();
  }
});

test('registry file: a fork starts with the registry its parent had', async () => {
  const s = scratch();
  try {
    const parentFile = sessionStatePath(s.sessionFile, 'registry.json')!;
    mkdirSync(dirname(parentFile), { recursive: true });
    writeRegistryFile(parentFile, makeRegistry([
      subEntry({ taskId: 'task-parent', paneId: 'tParent', slug: 'parent-worker', cwd: s.dir, status: 'consumed', consumedAt: 5 }),
    ]));
    const childSession = join(s.dir, 'sessions', '2026-11-07T02-00-00-000Z_01a1dead-0000-7000-8000-000000000000.jsonl');
    const mounted = await mountSubagent({
      subs: [],
      deps: { getSessionFile: () => childSession },
    });
    try {
      assert.equal(readRegistryFile(sessionStatePath(childSession, 'registry.json')), null, 'a fresh fork has none');
      await fire(mounted.pi, 'session_start', { reason: 'fork', previousSessionFile: s.sessionFile }, {
        sessionManager: { getBranch: () => [] },
      });
      assert.deepEqual(
        readRegistryFile(sessionStatePath(childSession, 'registry.json'))?.subs.map((row) => row.paneId),
        ['tParent'],
        'the fork inherited the parent document',
      );
      assert.match((await runSubagent(mounted.pi, { action: 'list' }, s.dir)).content[0]!.text, /parent-worker@tParent/);
    } finally {
      await mounted.root.fiber.dispose();
    }
  } finally {
    s.dispose();
  }
});
