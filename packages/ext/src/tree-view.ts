/**
 * Unified TUI status surface (RFC rfc-unified-widget.md, D113): the resident widget shows one line
 * per running subagent, and the full delegation tree with its settled nodes lives behind
 * /piher-tree. Pure builders only.
 */

/** One running worker row as the widget and the tree consume it. */
export interface WorkerWidgetRow {
  paneId: string;
  slug?: string;
  /** Role name the worker was launched with; `task` when it was spawned without one. */
  role?: string;
  /** Registry state. The widget is handed running workers only. */
  state?: string;
  /** Spawn time, for the elapsed field on a widget row. */
  startedAt?: number;
  /** Pane label for `list` and the settle notice. A widget row never shows it. */
  description?: string;
}

/** A settled (delivered) worker row for the tree view only — never in the resident widget. */
export interface SettledWidgetRow {
  paneId: string;
  slug?: string;
  description: string;
  /** Absent when the row survived a resume without its timestamp. */
  settledAt?: number | null;
}

/** `<60s → Ns`; `<60m → Nm`; `<48h → Nh` (floor); otherwise `Nd`. */
function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * One widget row: `↳ <slug> (<paneId>) · <role> · <state> · <elapsed>`. The pane id rides beside the
 * name because it is the address the app and `send`/`output` take; a row without a slug is the pane
 * id alone, since `↳ p9 (p9)` would spend the width on a duplicate. A label or a description is still
 * not a field — those would cost the line the fold budget pays for.
 */
export function workerLine(row: WorkerWidgetRow, now = Date.now()): string {
  const elapsed = row.startedAt != null ? formatAge(Math.max(now - row.startedAt, 0)) : undefined;
  const handle = row.slug ? `${row.slug} (${row.paneId})` : row.paneId;
  const fields = [handle, row.role, row.state, elapsed]
    .filter((field): field is string => typeof field === 'string' && field.length > 0);
  return `↳ ${fields.join(' · ')}`;
}

/**
 * The whole widget budget, fold tail included: pi wraps a string-array widget in
 * `content.slice(0, 10)` and appends its own `... (widget truncated)` line when given more, so a
 * tenth row plus a tail would cost the tail — the one line that says where the rest went.
 */
export const WIDGET_MAX_LINES = 10;

/** One widget line per running worker; overflow folds into a tail that still fits the budget. */
export function widgetLines(workers: readonly WorkerWidgetRow[], now = Date.now()): string[] {
  if (workers.length === 0) return [];
  const rows = workers.map((worker) => workerLine(worker, now));
  // Reserve the tail line before slicing, so the rendered widget never exceeds the budget.
  const overflow = rows.length > WIDGET_MAX_LINES;
  const shown = rows.slice(0, overflow ? WIDGET_MAX_LINES - 1 : WIDGET_MAX_LINES);
  const hidden = rows.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`…+${hidden} more subagents · /piher-tree`] : [])];
}

/** Full delegation tree for /piher-tree: every running worker plus the settled nodes that are still
 *  revivable, hung off the master node. */
export function formatDelegationTree(opts: {
  workers: readonly WorkerWidgetRow[];
  settled?: readonly SettledWidgetRow[];
  now?: number;
}): string[] {
  const now = opts.now ?? Date.now();
  const settled = opts.settled ?? [];
  const children = opts.workers.length + settled.length;
  const lines: string[] = [
    `Delegation tree · ${opts.workers.length} running · ${settled.length} settled`,
    '',
    '● master (this pane)',
  ];
  if (children > 0) lines.push('│');

  let index = 0;
  for (const w of opts.workers) {
    const last = ++index === children;
    const meta = [w.paneId, w.state ?? 'running', ...(w.role && w.role !== 'task' ? [w.role] : [])].join(' · ');
    lines.push(`${last ? '└' : '├'}─ ↳ ${w.slug ?? w.paneId} (${meta})`);
    if (!last) lines.push('│');
  }
  for (const s of settled) {
    const last = ++index === children;
    const age = s.settledAt ? ` · settled ${formatAge(Math.max(now - s.settledAt, 0))} ago` : ' · settled';
    lines.push(`${last ? '└' : '├'}─ ✓ ${s.slug ?? s.paneId} (${s.paneId}${age})  result delivered`);
    if (!last) lines.push('│');
  }
  lines.push('', 'subagent list → workers');
  return lines;
}
