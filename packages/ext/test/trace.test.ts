/** The settlement trace: one boring line per decision, readable after a real failure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTraceLine } from '../src/trace.ts';

test('formatTraceLine: iso time, pid, role, event, then k=v fields', () => {
  const line = formatTraceLine(Date.parse('2026-11-07T00:09:03.000Z'), 4242, 'master', 'poll', {
    pane: 't187', state: 'idle', textLen: 812, pend: false,
  });
  assert.equal(line, '2026-11-07T00:09:03.000Z 4242 master poll pane=t187 state=idle textLen=812 pend=false');
});

test('formatTraceLine: undefined is dropped, null is written, spaces are quoted', () => {
  const line = formatTraceLine(0, 1, 'worker', 'push-skip', {
    why: 'no-text', request: undefined, file: null, error: 'pipe closed after 5000ms',
  });
  assert.match(line, /why=no-text/);
  assert.equal(line.includes('request='), false, 'an absent field is not invented');
  assert.match(line, /file=null/, 'a null field is on the record, not silently dropped');
  assert.match(line, /error="pipe closed after 5000ms"/, 'a value with spaces stays one token');
});

test('formatTraceLine: an event with no fields is just the head', () => {
  assert.equal(formatTraceLine(0, 7, 'master', 'recover'), '1970-01-01T00:00:00.000Z 7 master recover');
});
