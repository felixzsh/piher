/** Process-level integration: the cordis boot path. These boot a real app tree, so they live in the
 *  integral tier (see AGENTS.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCordisApp, detectExposeInternals } from '../../src/bootstrap.ts';

/* ── boot guards: starting piher outside a dev checkout ───────────────────── */
// Production must not loader.create() .ts files unless HMR is active (Node cannot strip types under
// node_modules; the loader path exists for dev HMR only).
const master = readFileSync(fileURLToPath(new URL('../../src/index-master.ts', import.meta.url)), 'utf8');

test('bootstrap: Loader mounts, hmr stays off, dispose runs the shutdown hook', async () => {
  let disposed = false;
  const app = await createCordisApp({ onDispose: () => { disposed = true; } });
  assert.equal(app.loaderReady, true);
  const withLoader = app.root as unknown as { loader?: { builtins: Record<string, unknown> } };
  assert.ok(withLoader.loader, 'the loader service is on the tree'); assert.ok(withLoader.loader.builtins.group, 'the cordis:group builtin is registered (D80③)');
  assert.equal(app.hmrActive, false, 'no --expose-internals + PIHER_HMR → hmr is not mounted (zero watchers)');
  assert.equal(typeof detectExposeInternals(), 'boolean');
  assert.equal(detectExposeInternals(), process.execArgv.includes('--expose-internals'), 'the flag is read from the current execArgv');
  await app.root.fiber.dispose();
  assert.equal(disposed, true, 'onDispose runs on tree teardown (session_shutdown path)');
});

test('production mount uses loader.create only when HMR is active', () => {
  assert.match(master, /loaderReady && cordisApp\.hmrActive/); assert.match(master, /loadEntry\(sessionRoot, useLoader,/);
});
