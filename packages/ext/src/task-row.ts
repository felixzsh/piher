/**
 * Task rows: the one row type behind delegation state (spec S1-S12, `docs/spec/domain.md`).
 *
 * A task is one delegation unit — a spawned subagent, never a tool call (S1). Every later
 * action sends, closes, retries or resumes the same task; only the generation (pane, tab,
 * transcript) is replaced on revive (S3). The durable facts are exactly the row below (S10);
 * liveness is an observation from core and lives in memory only (S11).
 */
import { foldWorktree, type WorktreeRecord } from './worktree.ts';
import type { Lifecycle } from './role-manifest.ts';

/** One observation of a task's liveness, read from core when a surface needs it (S11). It feeds
 *  only the state text a surface prints; an action never reads it to decide (S26). A stale
 *  observation can mislabel a row — never revive, close or steer the wrong one. */
export interface TaskObservation {
  paneExists: boolean;
  agentStatus: string | null;
  lastActivityMs: number | null;
  at: number;
}

/** The state text `list` and the widget print (contracts): the three predicates plus what core
 *  last said. Without an observation the durable facts alone decide: a delivered report reads
 *  `idle`, anything else `running` — the zero-observation base a fresh spawn shares. */
export type TaskStateText = 'running' | 'idle' | 'no report' | 'no pane';

export function describeTaskState(
  row: Pick<TaskRow, 'gen'>,
  obs?: Pick<TaskObservation, 'paneExists' | 'agentStatus'> | null,
): TaskStateText {
  if (obs) {
    if (!obs.paneExists) return 'no pane';
    if (obs.agentStatus === 'working' || obs.agentStatus === 'blocked') return 'running';
  }
  return row.gen.consumedAt !== null ? 'idle' : obs ? 'no report' : 'running';
}

/** One generation: the pane, tab and transcript a revive replaces wholesale (S3). Earlier
 *  generations leave no durable trace. */
export interface TaskGeneration {
  paneId: string;
  slug: string;
  tabId: string;
  tabName: string;
  /** The worker's transcript: resume needs it to exist. */
  sessionFile: string | null;
  launchCommand: string[];
  startedAt: number;
  /** The report reached the master (S10). */
  consumedAt: number | null;
  reportDelivered: { fingerprint: string; at: number } | null;
}

export interface TaskRow {
  /** Minted at spawn; the task's identity across revives (S1). */
  taskId: string;
  description: string;
  /** Role profile the worker was launched with. */
  kind: string;
  lifecycle: 'one-shot' | 'persistent';
  cwd: string;
  /** The checkout the spawn created, if any. */
  worktree?: WorktreeRecord;
  createdAt: number;
  /** The master's final word (S9). */
  closedAt: number | null;
  gen: TaskGeneration;
}

/** A task resident in memory: the durable row plus transient control state. The transient
 *  fields are stripped at the document seam (`toTaskRow`) and never reach disk. Liveness is
 *  not among them: it is observed from core per surface, never stored (S11, S12). */
export interface TaskEntry extends TaskRow {
  /** Settle window start (poller state): settlement waits until the transcript settles. */
  settleWindowStartedAt?: number | null;
  /** The closing text already announced for this pane (fingerprint + time). Two pollers can
   *  settle the same transcript — a recovery re-arm and a live request carry different ids —
   *  and the claim is per request, so this is what stops the master from reading one
   *  settlement twice. */
  noticeAnnounced?: { fingerprint: string; at: number } | null;
}

/** The durable row alone: what a record file holds. */
export function toTaskRow(entry: TaskEntry): TaskRow {
  const { settleWindowStartedAt: _w, noticeAnnounced: _n, ...row } = entry;
  void _w;
  void _n;
  const fingerprint = row.gen.reportDelivered ? { ...row.gen.reportDelivered } : null;
  const delivered = fingerprint ? { reportDelivered: fingerprint } : {};
  return {
    ...row,
    gen: { ...row.gen, ...delivered },
    ...(row.worktree ? { worktree: { ...row.worktree } } : {}),
  };
}

/* ── predicates (S12) ─────────────────────────────────────────── */

export function isClosed(row: Pick<TaskRow, 'closedAt'>): boolean {
  return row.closedAt !== null;
}

export function isSpent(row: Pick<TaskRow, 'lifecycle' | 'gen'>): boolean {
  return row.lifecycle === 'one-shot' && row.gen.consumedAt !== null;
}

export function isActionable(row: Pick<TaskRow, 'closedAt' | 'lifecycle' | 'gen'>): boolean {
  return !isClosed(row) && !isSpent(row);
}

/* ── tolerant parsing ─────────────────────────────────────────── */

/** Legacy short/resident/missing kinds normalize to task; role names pass through. */
export function normalizeEntryKind(kind: string | null | undefined): string {
  if (!kind || kind === 'short' || kind === 'resident') return 'task';
  return kind;
}

/** Only a .jsonl path is accepted, so an invalid report cannot overwrite a valid one. */
export function applyReportedSessionFile(
  current: string | null,
  reported: string | null | undefined,
): string | null {
  if (typeof reported === 'string' && /\.jsonl$/i.test(reported)) return reported;
  return current;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One row out of an unknown document. Unknown fields are kept off; a row without a taskId
 *  is not a row. Never throws. */
export function parseTaskRow(value: unknown): TaskRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.taskId !== 'string' || rec.taskId.trim() === '') return null;
  const gen = (rec.gen !== null && typeof rec.gen === 'object' && !Array.isArray(rec.gen)
    ? rec.gen as Record<string, unknown>
    : {});
  const delivered = gen.reportDelivered !== null && typeof gen.reportDelivered === 'object'
    && !Array.isArray(gen.reportDelivered)
    && typeof (gen.reportDelivered as Record<string, unknown>).fingerprint === 'string'
    && typeof (gen.reportDelivered as Record<string, unknown>).at === 'number'
    ? {
      fingerprint: (gen.reportDelivered as Record<string, unknown>).fingerprint as string,
      at: (gen.reportDelivered as Record<string, unknown>).at as number,
    }
    : null;
  const worktree = foldWorktree(rec.worktree);
  const lifecycle: Lifecycle = rec.lifecycle === 'one-shot' ? 'one-shot' : 'persistent';
  return {
    taskId: rec.taskId,
    description: asString(rec.description),
    kind: normalizeEntryKind(typeof rec.kind === 'string' ? rec.kind : undefined),
    lifecycle,
    cwd: asString(rec.cwd),
    ...(worktree ? { worktree } : {}),
    createdAt: asTime(rec.createdAt) ?? 0,
    closedAt: asTime(rec.closedAt),
    gen: {
      paneId: asString(gen.paneId),
      slug: asString(gen.slug),
      tabId: asString(gen.tabId),
      tabName: asString(gen.tabName),
      sessionFile: typeof gen.sessionFile === 'string' ? gen.sessionFile : null,
      launchCommand: Array.isArray(gen.launchCommand)
        ? gen.launchCommand.filter((part): part is string => typeof part === 'string')
        : [],
      startedAt: asTime(gen.startedAt) ?? 0,
      consumedAt: asTime(gen.consumedAt),
      reportDelivered: delivered,
    },
  };
}

export interface TaskDocument {
  rows: TaskRow[];
  taskIds: string[];
}

/**
 * The `{version:1, rows:[TaskRow]}` envelope both documents share, read tolerantly: a
 * missing, torn or foreign document parses to empty lists and never raises (S6). The record
 * file holds its row under `rows`, the session view its ids under `taskIds`.
 */
export function parseTaskDocument(value: unknown): TaskDocument {
  const empty: TaskDocument = { rows: [], taskIds: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return empty;
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) return empty;
  const rows = Array.isArray(rec.rows)
    ? rec.rows.map(parseTaskRow).filter((row): row is TaskRow => row !== null)
    : [];
  const isId = (id: unknown): id is string => typeof id === 'string' && id.trim() !== '';
  const taskIds = Array.isArray(rec.taskIds) ? [...new Set(rec.taskIds.filter(isId))] : [];
  return { rows, taskIds };
}

/* ── task slugs ───────────────────────────────────────────────── */

/** Slug cap: short enough for tool args and list rows, long enough to stay distinctive. */
const SLUG_MAX = 24;

/** Kebab-case a task description; non-ASCII (CJK descriptions) sanitizes to '' — the allocator
 * then falls back to a taskId-derived ascii slug, because tool args must stay typeable. */
export function slugifyTask(description: string): string {
  return description
    .toLowerCase()
    .replace(/[''']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

/** Allocate a unique slug among live rows: base, then base-2, base-3, …; a description that
 * sanitizes to nothing (CJK, emoji-only) falls back to `task-<taskId prefix>`. */
export function allocateTaskSlug(
  description: string,
  taskId: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugifyTask(description) || `task-${taskId.slice(0, 6)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/** Stable display/argument form for a task row: `slug@paneId` when a slug exists. */
export function taskRef(task: { paneId: string; slug?: string }): string {
  return task.slug ? `${task.slug}@${task.paneId}` : task.paneId;
}

/* ── memory index ─────────────────────────────────────────────── */

/** Resolve a pane id to its task's entry through the pane→task index. A task outlives its
 *  pane; the pane id is part of the generation, so lookups by pane go through the task. */
export function taskForPane(
  tasks: ReadonlyMap<string, TaskEntry>,
  panes: ReadonlyMap<string, string>,
  paneId: string,
): TaskEntry | undefined {
  const taskId = panes.get(paneId);
  if (!taskId) return undefined;
  return tasks.get(taskId);
}
