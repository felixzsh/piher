/**
 * Tool scope (S1/S10): piher registers exactly two tools and owns no other name.
 *
 * pi keeps one provider per tool name and refuses to load a second one (`Tool "x" conflicts with
 * /tmp/x.ts` is a hard boot failure), so a third name would take a tool away from whoever provides
 * it. This file is the gate: adding one fails here on purpose, instead of widening the surface
 * quietly. A name piher gives up has to be deleted from this list in the same change, so the set
 * cannot drift from the code in either direction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension from '../../src/index.ts';
import { TempHome, fakePi, fire, withCleanup, type CleanupContext, type FakePi } from '../test-utils.ts';

/** The whole tool surface piher registers: the delegation mechanics and nothing else. */
const PIHER_TOOLS = ['subagent', 'bg_job'];

/**
 * The registered set: the delegation pair and nothing else (S10).
 */
const EXPECTED_TOOLS = [...PIHER_TOOLS].sort();

/**
 * Boots the real composition root as a master inside a core terminal — the only mode that mounts the
 * delegation tools — on a throwaway agent dir so nothing lands in the real one. `pi` is passed in
 * when a test pre-populates the host surface before piher loads.
 */
async function withMaster(
  cleanup: CleanupContext,
  paneId: string,
  body: (pi: FakePi) => Promise<void>,
  pi: FakePi = fakePi(),
): Promise<void> {
  const home = new TempHome('tool-scope-');
  let booted = false;
  try {
    const env = cleanup.env();
    for (const key of ['PIHER_SUBAGENT', 'PIHER_ROLE_MANIFEST', 'PI_SESSION_FILE', 'PI_SESSION_ID']) env.delete(key);
    env.set('HC_TERMINAL_SOCKET', '/tmp/piher-tool-scope.sock');
    env.set('HC_TERMINAL_ID', paneId);
    await extension(pi as never);
    booted = true;
    await body(pi);
  } finally {
    // Shut the session down on every path, failures included: a booted piher keeps the subagent GC
    // ticker (`setInterval` in subagent-gc.ts) and the core watch alive until `session_shutdown`
    // disposes the cordis tree, so a body that throws would leave the event loop running and hang
    // the runner instead of reporting the failure.
    if (booted) {
      try {
        await fire(pi, 'session_shutdown');
      } catch {
        // A broken shutdown must not replace the failure the body is reporting.
      }
    }
    home.dispose();
  }
}

test('tool scope: piher registers exactly subagent and bg_job', withCleanup(async (cleanup) => {
  await withMaster(cleanup, 't-tool-scope-set', async (pi) => {
    // Exact set on purpose: any name outside it is surface growth, and this assertion is what
    // fails on the change that adds one (S10).
    assert.deepEqual(
      [...pi.tools.keys()].sort(),
      EXPECTED_TOOLS,
      'piher registers exactly the delegation pair; anything else is surface growth',
    );
  });
}));

/** A tool definition as another extension would register it: same name, different owner. */
const FOREIGN_ASK = {
  name: 'ask_user_question',
  label: 'Ask User',
  description: 'Provided by a separately installed ask-user extension.',
  parameters: {},
  execute: async () => ({ content: [{ type: 'text', text: 'foreign answer' }] }),
};

test('tool scope: a host where another extension owns ask_user_question boots piher with no conflict', withCleanup(async (cleanup) => {
  const pi = fakePi();
  pi.registerTool(FOREIGN_ASK);
  await withMaster(cleanup, 't-tool-scope-foreign', async (host) => {
    // The duplicate check this pins: the fake keeps the last writer, so a replaced definition means
    // piher claimed the name — which real pi rejects as a hard load failure.
    assert.equal(host.tools.get('ask_user_question'), FOREIGN_ASK, 'the other extension keeps its tool');
    assert.deepEqual([...host.tools.keys()].sort(), [...EXPECTED_TOOLS, 'ask_user_question'].sort());
  }, pi);
}));
