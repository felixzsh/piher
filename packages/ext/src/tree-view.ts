/**
 * The resident widget: one line per running subagent. Pure builders only.
 */

/** One running worker row as the widget consumes it. */
export interface WorkerWidgetRow {
  paneId: string;
  slug?: string;
  /** Role name the worker was launched with; `task` when it was spawned without one. */
  role?: string;
  /** Observed state text. The widget is handed workers still awaiting a report only. */
  state?: string;
  /** Spawn time, for the elapsed field on a widget row. */
  startedAt?: number;
  /** Pane label for `list` and the settle notice. A widget row never shows it. */
  description?: string;
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
  return [...shown, ...(hidden > 0 ? [`…+${hidden} more subagents · subagent list`] : [])];
}
