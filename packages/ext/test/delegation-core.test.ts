/** Delegation identity pure chain: env → context → prompt section, plus the branch fold
 * and the record validator shared by the marker and the custom entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_CUSTOM_TYPE,
  DELEGATION_ENV,
  buildDelegationSection,
  delegationEnv,
  delegationFromRecord,
  foldDelegation,
  parseDelegationContext,
} from '../src/delegation-core.ts';

const CTX = {
  parentPaneId: 'wD:p1',
  parentSessionId: 'a1b2c3d4',
  taskId: 't-9',
  description: 'refactor auth flow',
  role: 'reviewer',
  lifecycle: 'persistent' as const,
};

test('delegationEnv ↔ parseDelegationContext: JSON roundtrip, contract env name', () => {
  const env = delegationEnv(CTX);
  assert.deepEqual(Object.keys(env), [DELEGATION_ENV]);
  assert.deepEqual(parseDelegationContext(env[DELEGATION_ENV]), CTX);
});

test('parseDelegationContext: absent/torn/malformed input degrades to null', () => {
  for (const bad of [undefined, null, '', '{', '[]', '"text"', '{"taskId":"t"}', '{"description":"d"}'])
    assert.equal(parseDelegationContext(bad), null, JSON.stringify(bad));
});

test('parseDelegationContext: empty parent ids are tolerated (tests/RPC), role defaults', () => {
  const parsed = parseDelegationContext(JSON.stringify({ parentPaneId: '', parentSessionId: '', taskId: 't', description: 'd' }));
  assert.deepEqual(parsed, { parentPaneId: '', parentSessionId: '', taskId: 't', description: 'd', role: 'worker-default', lifecycle: 'persistent' });
});

test('parseDelegationContext: the lifetime is total — only `one-shot` survives, anything else is persistent', () => {
  const oneShot = parseDelegationContext(JSON.stringify({ ...CTX, lifecycle: 'one-shot' }));
  assert.equal(oneShot?.lifecycle, 'one-shot');
  for (const bad of ['forever', '', 7, null, undefined]) {
    const parsed = parseDelegationContext(JSON.stringify({ ...CTX, lifecycle: bad }));
    assert.equal(parsed?.lifecycle, 'persistent', JSON.stringify(bad));
  }
});

test('delegationFromRecord: non-object records are null, not an error', () => {
  for (const bad of [null, undefined, 'x', 7, []]) assert.equal(delegationFromRecord(bad), null);
  assert.deepEqual(delegationFromRecord({ ...CTX }), CTX);
});

test('buildDelegationSection: identity, self pane, and the delivery contract are all present', () => {
  const text = buildDelegationSection(CTX, 'wD:p2');
  assert.match(text, /master pane wD:p1 \(session a1b2c3d4\)/);
  assert.match(text, /Task: refactor auth flow\. Role: reviewer\./);
  assert.match(text, /pane wD:p2 \(agentId "wD:p2"\)/);
  assert.match(text, /state the answer plainly/);
  assert.match(text, /`BLOCKED: <the decision or resource you need>`/);
  assert.doesNotMatch(text, /say exactly what blocks you/);
  // Unknown parent ids degrade to placeholders instead of empty strings.
  const bare = buildDelegationSection({ ...CTX, parentPaneId: '', parentSessionId: '' }, '');
  assert.match(bare, /master pane unknown pane \(session unknown session\)/);
  assert.doesNotMatch(bare, /agentId/);
});

test('foldDelegation: last branch entry wins; foreign/torn entries are skipped', () => {
  const entries = [
    { type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { ...CTX, description: 'first' } },
    { type: 'custom', customType: 'piher.subs', data: { subs: [] } },
    { type: 'user', content: 'hi' },
    { type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { taskId: 't-9', description: 'second', role: 'coder' } },
    { type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { broken: true } },
  ];
  assert.deepEqual(foldDelegation(entries), { parentPaneId: '', parentSessionId: '', taskId: 't-9', description: 'second', role: 'coder', lifecycle: 'persistent' });
  assert.equal(foldDelegation([]), null);
  assert.equal(foldDelegation([{ type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { broken: true } }]), null);
});

test('parseDelegationContext: the env delegationEnv builds roundtrips field for field', () => {
  const env = delegationEnv(CTX);
  assert.deepEqual(parseDelegationContext(env[DELEGATION_ENV]), CTX);
});
