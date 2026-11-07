/** End-to-end of the trace itself: with PIHER_TRACE set, the poller records why it decided. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('trace: a settle writes start, tick, claim, inject and consume lines', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'piher-trace-')), 'trace.log');
  process.env.PIHER_TRACE = file;
  const { trace } = await import('../src/trace.ts');
  trace('master', 'poll-start', { pane: 't9', since: 1 });
  trace('master', 'poll', { pane: 't9', state: 'idle', act: true });
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /master poll-start pane=t9 since=1$/);
  assert.match(lines[1]!, /master poll pane=t9 state=idle act=true$/);
});
