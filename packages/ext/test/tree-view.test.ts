/** tree-view: the resident-widget line rules (workerLine/widgetLines) and the /piher-tree renderer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET_MAX_LINES, formatDelegationTree, widgetLines, workerLine, type WorkerWidgetRow } from '../src/tree-view.ts';

const NOW = 1_700_000_000_000;
const worker = (over: Partial<WorkerWidgetRow> = {}): WorkerWidgetRow =>
  ({ paneId: 'p2', slug: 'fix-auth', role: 'worker', state: 'running', startedAt: NOW - 120_000, ...over });

test('workerLine: slug, pane id, role, state, elapsed', () => {
  assert.equal(workerLine(worker(), NOW), '↳ fix-auth (p2) · worker · running · 2m');
  // A worker spawned without a role carries `task`, the ledger's own label for it.
  assert.equal(workerLine(worker({ role: 'task', startedAt: NOW - 5_000 }), NOW), '↳ fix-auth (p2) · task · running · 5s');
  // No slug: the pane id is the handle, so the row never falls back to prose (and never repeats it).
  assert.equal(workerLine({ paneId: 'p9', role: 'reviewer', state: 'running' }, NOW), '↳ p9 · reviewer · running');
  // A label or a description is not a widget field, whatever the row carries.
  assert.equal(workerLine(worker({ description: 'fix the auth bug' }), NOW), '↳ fix-auth (p2) · worker · running · 2m');
});

test('workerLine: elapsed never renders as a negative age', () => {
  assert.equal(workerLine(worker({ startedAt: NOW + 60_000 }), NOW), '↳ fix-auth (p2) · worker · running · 0s');
});

test('widgetLines: one line per running worker, and the fold tail stays inside the budget', () => {
  assert.deepEqual(widgetLines([], NOW), [], 'nothing running renders no widget at all');
  assert.deepEqual(
    widgetLines([worker(), worker({ paneId: 'p3', slug: 'migrate', role: 'reviewer' })], NOW),
    ['↳ fix-auth (p2) · worker · running · 2m', '↳ migrate (p3) · reviewer · running · 2m'],
  );

  // Exactly at the budget: every row fits, so there is nothing to fold and nothing to warn about.
  const exact = Array.from({ length: WIDGET_MAX_LINES }, (_, i) => worker({ paneId: `p${i}`, slug: `w${i}` }));
  assert.equal(widgetLines(exact, NOW).length, WIDGET_MAX_LINES);
  assert.equal(widgetLines(exact, NOW).some((line) => line.includes('more subagents')), false);

  // pi renders `content.slice(0, WIDGET_MAX_LINES)` and appends its own truncation marker beyond
  // that, so a widget wider than the budget loses the tail: every count must stay within it.
  for (let n = 1; n <= WIDGET_MAX_LINES * 2; n++) {
    const rows = Array.from({ length: n }, (_, i) => worker({ paneId: `p${i}`, slug: `w${i}` }));
    const lines = widgetLines(rows, NOW);
    assert.ok(lines.length <= WIDGET_MAX_LINES, `${n} workers render ${lines.length} lines`);
  }

  // One past the budget: the visible rows shrink by one and the tail names the exact remainder.
  const over = widgetLines(Array.from({ length: WIDGET_MAX_LINES + 1 }, (_, i) => worker({ paneId: `p${i}`, slug: `w${i}` })), NOW);
  assert.equal(over.length, WIDGET_MAX_LINES);
  assert.equal(over.at(-1), '…+2 more subagents · /piher-tree');
  assert.equal(
    widgetLines(Array.from({ length: WIDGET_MAX_LINES + 5 }, (_, i) => worker({ paneId: `p${i}`, slug: `w${i}` })), NOW).at(-1),
    '…+6 more subagents · /piher-tree',
  );
});

test('formatDelegationTree: workers and settled nodes hang off master with tree connectors', () => {
  const lines = formatDelegationTree({
    workers: [
      worker({ slug: 'fix-auth', role: 'reviewer' }),
      worker({ paneId: 'p3', slug: 'migration', role: 'task' }),
    ],
    settled: [{ paneId: 'p4', slug: 'run-e2e', description: 'e2e', settledAt: NOW - 120_000 }],
    now: NOW,
  });
  assert.equal(lines[0], 'Delegation tree · 2 running · 1 settled');
  assert.ok(lines.includes('● master (this pane)'));
  assert.ok(lines.includes('├─ ↳ fix-auth (p2 · running · reviewer)'));
  assert.ok(lines.includes('├─ ↳ migration (p3 · running)'), 'a roleless worker shows no role label');
  assert.ok(lines.includes('└─ ✓ run-e2e (p4 · settled 2m ago)  result delivered'), 'last child closes the tree');
});

test('formatDelegationTree: empty state still names the master node without rails', () => {
  const lines = formatDelegationTree({ workers: [], settled: [] });
  assert.ok(lines.includes('● master (this pane)'));
  assert.ok(!lines.some((l) => /[│├└]/.test(l)));
});

test('formatDelegationTree: a settled row without a timestamp still renders', () => {
  const lines = formatDelegationTree({ workers: [], settled: [{ paneId: 'p5', description: 'x', settledAt: null }] });
  assert.ok(lines.includes('└─ ✓ p5 (p5 · settled)  result delivered'));
});
