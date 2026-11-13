/**
 * Subagent domain: launch lines, liveness notices, tab/worktree planning, task-id
 * resolution, and the outbound port types. Pure: planners decide, adapters do I/O.
 *
 * The row itself lives in task-row.ts; the documents in task-store.ts.
 */
import { normalizeEntryKind, taskRef } from './task-row.ts';
import { CORE_REQUIRED } from './core-client.ts';
import type { WorkerWidgetRow } from './tree-view.ts';
import { Type } from 'typebox';

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export interface SubagentSpec {
  description: string;
  prompt: string;
}

/** POSIX single-quote escape; win32 PowerShell doubles the quote instead. */
export function buildLaunchLine(parts: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  const quoted = parts.map((s) => (win
    ? `'${String(s).replace(/'/g, "''")}'`
    : `'${String(s).replace(/'/g, `'\\''`)}'`));
  return (win ? '& ' : '') + quoted.join(' ');
}

/** Tab name of the master's own tab: a worker placed there joins the master terminal's tab. */
export const MAIN_TAB_NAME = 'main';

/** App tab addresses must be stable across spawns (a named tab is joined, not recreated) and ASCII. */
function tabIdFor(name: string): string {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (slug) return `tbpiher-${slug}`;
  // Non-ASCII task names (CJK descriptions) sanitize to nothing: the hash keeps the id stable.
  let hash = 0x811c9dc5;
  for (const ch of String(name)) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `tbpiher-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * pi ≥ 0.99 outputSchema for the subagent tool: the `details` each action already produces, stamped
 * with the normalized action. Codemode scripts (and any structured consumer) read this instead of
 * parsing the prose reply; the text content stays authoritative for the transcript. Hard failures
 * throw (toolError), so every returned value is a success and always carries structuredContent.
 */
export const SUBAGENT_OUTPUT_SCHEMA = Type.Object({
  action: Type.Union([
    Type.Literal('spawn'), Type.Literal('resume'), Type.Literal('list'),
    Type.Literal('send'), Type.Literal('interrupt'), Type.Literal('output'), Type.Literal('reports'), Type.Literal('inbox'), Type.Literal('close'), Type.Literal('help'),
  ]),
  paneId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  alreadyRunning: Type.Optional(Type.Boolean()),
  alreadyClosed: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export function attachSubagentStructuredContent(action: string, result: unknown): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const details = record.details !== null && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  return { ...record, structuredContent: { action, ...details } };
}

/** Caps how many children are being CREATED at once (SUBAGENT_CONCURRENCY); see withAdmission. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private readonly cap: number;

  constructor(cap: number) {
    if (cap < 1) throw new Error('semaphore cap must be >= 1');
    this.cap = cap;
  }

  get activeCount(): number {
    return this.active;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.cap) {
      this.active++;
      return Promise.resolve(this.release.bind(this));
    }
    const { promise, resolve } = Promise.withResolvers<() => void>();
    this.queue.push(() => {
      this.active++;
      resolve(this.release.bind(this));
    });
    return promise;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Hold one admission slot for a `create` call and nothing else (S50). The cap bounds how many
 *  children are being created at once, never how long a tool call waits: a call that then waits for
 *  its pane to report ready (up to PIHER_READY_TIMEOUT_MS) must not occupy a slot, or four slow
 *  boots in `resume` would starve a `spawn` for as long as they take. */
export async function withAdmission<T>(sem: Semaphore, create: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await create();
  } finally {
    release();
  }
}

/** A spawn that never started: no pane, no ledger row, nothing running. */
export function formatSpawnFailure(description: string, message: string): string {
  return `Error: failed to spawn subagent "${description}": ${message}`;
}

export interface AliveProbe {
  paneExists: boolean;
  agentStatus: string | null;
  lastActivityMs: number | null;
}

/**
 * A subagent outlives its "no output" result: a working/blocked agent is alive regardless of session
 * age, otherwise recent session writes decide. `paneExists: false` is death — an unavailable probe is
 * the caller's to report, not guessed here.
 */
export function isAlive(probe: AliveProbe, nowMs: number, staleAfterMs = 120_000): boolean {
  if (!probe.paneExists) return false;
  if (probe.agentStatus === 'working' || probe.agentStatus === 'blocked') return true;
  return probe.lastActivityMs != null && nowMs - probe.lastActivityMs < staleAfterMs;
}

export function agoText(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** A failing subagent call must not read as a dead worker: the pane is alive and will settle. */
export function buildAliveNotice(
  opts: { paneId: string; description: string; probe: AliveProbe },
  nowMs: number,
): string {
  const { paneId, description, probe } = opts;
  const status = probe.agentStatus ?? 'unknown';
  const activity = probe.lastActivityMs != null ? `, last session activity ${agoText(probe.lastActivityMs, nowMs)}` : '';
  return [
    `The subagent "${description}" is ALIVE in pane ${paneId} (agent_status=${status}${activity}) — the failing call did not kill it, and this result is NOT the task's outcome.`,
    'Do NOT redo its work: when it settles, its result arrives as a settlement notice at your next turn boundary.',
    'Use subagent(action: "list") to check its live state.',
  ].join(' ');
}

/** A pane blocked on a human decision keeps running: the master must not take the work over. */
export function buildBlockedGateNotice(opts: { paneId: string; description: string; question: string | null }): string {
  const { paneId, description, question } = opts;
  const q = question ? ` (question: "${question}")` : '';
  return [
    `Subagent "${description}" is BLOCKED waiting for a HUMAN decision in pane ${paneId}${q}.`,
    'It keeps running in background; once the human answers it resumes, and you will be notified when it settles.',
    'Do NOT take over its work and do NOT answer on the human\'s behalf.',
    'Tell the user to open that terminal in the Herdr app and answer directly.',
    'Only if the user explicitly authorizes you: relay their decision to the subagent via subagent(action: "send") — do not redo the work yourself.',
  ].join(' ');
}

/** Identity of a final report across the output action and the settlement notice: its tail. */
export function reportFingerprint(report: string): string {
  return report.slice(-64);
}

/** Shorter sleeps are ordinary polling of builds/logs; from a minute up, they were waits on workers. */
const SLEEP_NOTE_MIN_SECONDS = 60;

/**
 * Note for a master bash call that sleeps ≥ SLEEP_NOTE_MIN_SECONDS while background workers run:
 * masters slept 660-840 s per worker although the settlement notice arrives on its own. Worded so a
 * sleep that waits on something else (a load test, a build) is left alone.
 */
export function sleepWhileSubsRunningNote(
  command: string,
  running: ReadonlyArray<{ paneId: string; slug?: string }>,
): string | null {
  if (running.length === 0) return null;
  const longest = Math.max(0, ...[...command.matchAll(/\bsleep\s+(\d+)s?\b/g)].map((m) => Number(m[1])));
  if (longest < SLEEP_NOTE_MIN_SECONDS) return null;
  return `[piher] ${running.length} background subagent(s) running (${running.map(taskRef).join(', ')}): their settlement `
    + 'notice arrives automatically at your next tool boundary, so do not sleep to wait for them — keep working or end '
    + 'your turn. Sleeping is only needed for other work (builds, logs).';
}



/** Latest row per taskId; newest createdAt wins. */
export function newestPerTaskId<T extends { taskId: string; createdAt: number }>(
  entries: Iterable<T>,
): Map<string, T> {
  const byTask = new Map<string, T>();
  for (const sub of entries) {
    const prev = byTask.get(sub.taskId);
    if (!prev || sub.createdAt >= prev.createdAt) byTask.set(sub.taskId, sub);
  }
  return byTask;
}

/** Split `provider/model` on the first '/' only: model ids such as `moonshotai/kimi-k2` carry their own. */
export function splitRoleModel(roleModel: string): { provider: string | null; model: string } {
  const slash = roleModel.indexOf('/');
  if (slash <= 0 || slash === roleModel.length - 1) return { provider: null, model: roleModel };
  return { provider: roleModel.slice(0, slash), model: roleModel.slice(slash + 1) };
}

/**
 * Models sometimes wrap fields in a `parameters` object (JSON-schema habit). Top-level wins;
 * only missing keys are filled from the nested bag so a real field is never overwritten.
 */
export function flattenToolParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params) return params;
  const nested = params.parameters;
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return params;
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
    if (key === 'parameters') continue;
    const current = out[key];
    if (current == null || current === '') out[key] = value;
  }
  return out;
}

export function idParam(params: Record<string, unknown> | undefined, ...keys: string[]): string {
  const flat = flattenToolParams(params);
  for (const key of keys) {
    const v = flat?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function ambiguousIdError(label: 'task id' | 'subagent id', query: string, candidates: readonly string[]): string {
  const head = candidates.slice(0, 5).join(', ');
  const more = candidates.length > 5 ? `, ... (+${candidates.length - 5} more)` : '';
  return `Error: ambiguous ${label} "${query}" matches ${candidates.length} tasks: ${head}${more}`;
}

export const TAB_NAME_MAX = 20;

export function tabNameForTask(description: string): string {
  const cleaned = String(description ?? '').replace(/\s+/g, ' ').trim();
  const truncated = cleaned.slice(0, TAB_NAME_MAX).trim();
  return truncated || 'task';
}

/** A worker placed in its own app space carries no tab label of the master's (the app makes one). */
export function withoutPlacement(labels: Readonly<Record<string, string>>): Record<string, string> {
  const out = { ...labels };
  delete out['herdr.space'];
  delete out['herdr.tab'];
  return out;
}

export interface TabPlacementPlan {
  /** Display name of the task tab; `main` when the worker shares the master's tab. */
  tabName: string;
  /** Address for the `herdr.tab` label; null = join the master terminal's tab. */
  tabId: string | null;
}

/** Case/slash-insensitive containment; `/repo-x` is NOT under `/repo`. */
export function isPathUnder(cwd: string, wt: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = n(cwd);
  const b = n(wt);
  return a === b || a.startsWith(`${b}/`);
}

export interface WorktreeZone {
  zone: 'main' | 'worktree';
  tabName: string | null;
}

/** D86: subagents working in the master's checkout share its tab; another worktree gets its own. */
export function classifyWorktreeZone(opts: {
  cwd: string;
  masterCwd: string;
  worktrees: readonly string[];
}): WorktreeZone {
  for (const wt of opts.worktrees) {
    if (!isPathUnder(opts.cwd, wt)) continue;
    if (isPathUnder(opts.masterCwd, wt)) return { zone: 'main', tabName: null };
    const base = wt.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'worktree';
    return { zone: 'worktree', tabName: base };
  }
  return { zone: 'main', tabName: null };
}

/** Explicit `tab` and a worktree zone get their own app tab (the id is stable per name, so repeat
 *  spawns join instead of piling up tabs); a worker in the master's checkout joins the master tab. */
export function planTabPlacement(opts: {
  desiredTab?: string | null;
  description: string;
  zone?: WorktreeZone;
}): TabPlacementPlan {
  const desired = opts.desiredTab != null ? String(opts.desiredTab).replace(/\s+/g, ' ').trim() : '';
  if (desired) return placementFor(tabNameForTask(desired));
  const zone = opts.zone;
  if (zone?.zone === 'worktree' && zone.tabName) return placementFor(tabNameForTask(zone.tabName));
  if (zone?.zone === 'main') return { tabName: MAIN_TAB_NAME, tabId: null };
  return placementFor(tabNameForTask(opts.description));
}

function placementFor(tabName: string): TabPlacementPlan {
  if (tabName.toLowerCase() === MAIN_TAB_NAME) return { tabName: MAIN_TAB_NAME, tabId: null };
  return { tabName, tabId: tabIdFor(tabName) };
}

/** D97: fullscreen is what makes the pane a static frame the master can read. */
/**
 * The script argument to relaunch pi with, or '' when there is none. A compiled bun binary reports
 * `argv[1]` as an embedded `/$bunfs/root/pi` that no filesystem has, and passing it makes it the
 * child's first prompt — the worker greeted "/$bunfs/root/pi" before its real task. A script that is
 * not on disk is not a script; an interpreter's real file is. The caller supplies `exists` so this
 * stays a decision, not I/O.
 */
/** bun's embedded filesystem root: a compiled binary reports it as `argv[1]` (Windows: `B:\~BUN\`). */
export function isEmbeddedEntrypoint(path: string): boolean {
  return /^\/(?:\$bunfs|bunfs)\//.test(path) || /^[A-Za-z]:\\~BUN\\/i.test(path);
}

export function entryScript(argv1: string | undefined, exists: (path: string) => boolean): string {
  const path = argv1 ?? '';
  // The embedded root is rejected before the filesystem is consulted, because bun answers `exists` for
  // its own virtual paths: `existsSync('/$bunfs/root/pi')` is true inside the binary and false in any
  // shell. Only a real path makes existence the right question.
  if (path === '' || isEmbeddedEntrypoint(path)) return '';
  return exists(path) ? path : '';
}

export function buildLaunchParts(
  runtime: { nodePath: string; cliPath: string; extPath: string },
  opts: { resumeFile?: string | null; roleModel?: string | null; roleThinking?: string | null; approve?: boolean } = {},
  env: { PIHER_TUI?: string | undefined } = process.env,
): string[] {
  // A compiled binary is its own entrypoint: `execPath` and `argv[1]` are the same file, and passing
  // both makes the second one the child's first prompt. `entryScript` already dropped an `argv[1]`
  // that is not on disk; this covers the case where it genuinely is the binary again.
  const parts = runtime.cliPath === '' || runtime.cliPath === runtime.nodePath
    ? [runtime.nodePath]
    : [runtime.nodePath, runtime.cliPath];
  if (opts.approve) parts.push('-a');
  parts.push('-e', runtime.extPath);
  if (env.PIHER_TUI !== 'regular') parts.push('--tui-mode', 'fullscreen');
  if (opts.roleModel) {
    const { provider, model } = splitRoleModel(opts.roleModel);
    if (provider) parts.push('--provider', provider);
    parts.push('--model', model);
  }
  if (opts.roleThinking) parts.push('--thinking', opts.roleThinking);
  if (opts.resumeFile) parts.push('--session', opts.resumeFile);
  return parts;
}

/**
 * The role profiles a master can actually launch here, as `help` prints them. Discovery belongs to the
 * tool: without this a master hunts the filesystem (workspace, user dir, find, then the whole manifest)
 * to answer "which agents do I have", which is what it did before every review spawn.
 */
export function formatRoleCatalog(
  profiles: readonly {
    name: string;
    description?: string | null;
    tools?: readonly string[];
    lifecycle?: 'one-shot' | 'persistent';
    invalid?: string | null;
  }[],
): string {
  if (profiles.length === 0) {
    return 'role profiles — none in this workspace or user directory; pass no `role` for the builtin worker-default.';
  }
  const lines = profiles.map((profile) => {
    if (profile.invalid) return `  - ${profile.name} — INVALID: ${profile.invalid}`;
    const facts = [
      profile.lifecycle === 'one-shot' ? 'one-shot' : 'persistent',
      profile.tools?.length ? `tools: ${profile.tools.join(', ')}` : 'tools: none declared',
    ].join(' · ');
    const described = profile.description?.trim() ?? '';
    // One line each: a long description must not push `help` over the inline budget (4096 B on a
    // context-mode host, which replaces larger outputs with a pointer — silently losing the catalog).
    const what = described === '' ? 'no description' : described.length > 120 ? `${described.slice(0, 117)}…` : described;
    return `  - ${profile.name} — ${what} (${facts})`;
  });
  return [
    'role profiles available here (`role` accepts these; omit it for the builtin worker-default):',
    ...lines,
  ].join('\n');
}

/* ── execute planners ───────────────────────────────────────────── */

type LaunchValidation =
  | { kind: 'error'; text: string }
  | {
    kind: 'ok';
    spec: SubagentSpec;
    cwdParam: string | null;
    worktreeParam: string | null;
    roleKind: string;
    suggested: string[];
    manifestRole: string | null;
    tab: string | null;
  };

/** Validate spawn parameters. `role` doubles as the pane label and (when it names a profile) the
 *  manifest to compose; unknown names stay labels. */
export function planLaunchValidation(
  params: {
    description?: unknown;
    prompt?: unknown;
    cwd?: unknown;
    worktree?: unknown;
    role?: unknown;
    allowed_tools?: unknown;
    tab?: unknown;
  } | null | undefined,
  available: boolean,
): LaunchValidation {
  if (!available) {
    return { kind: 'error', text: `Error: subagent: ${CORE_REQUIRED}.` };
  }
  const spec: SubagentSpec = {
    description: String(params?.description ?? 'subagent'),
    prompt: String(params?.prompt ?? ''),
  };
  if (!spec.prompt.trim()) {
    // The schema cannot catch this (`prompt` is optional), so the refusal restates the real constraint
    // where the mistake happens: only the prompt reaches the worker.
    return {
      kind: 'error',
      text: 'Error: `prompt` is required and must be a non-empty string: the worker does not see this conversation, so `prompt` must be the complete, self-contained task (paths, acceptance criteria, the command to run, what to report back).',
    };
  }
  const cwdParam = typeof params?.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : null;
  const worktreeParam = typeof params?.worktree === 'string' && params.worktree.trim() ? params.worktree.trim() : null;
  if (cwdParam && worktreeParam) {
    // Both describe where the worker runs, so one of them has to be dropped: `cwd` for a checkout the
    // caller made, `worktree` for one piher makes (S71).
    return {
      kind: 'error',
      text: 'Error: `cwd` and `worktree` are mutually exclusive — `cwd` runs the worker in a checkout you already have, `worktree` asks piher to create one. Drop one of them: pass `worktree: "<name>"` and no `cwd`, or `cwd` and no `worktree`.',
    };
  }
  const role = typeof params?.role === 'string' ? params.role.trim() : undefined;
  return {
    kind: 'ok',
    spec,
    cwdParam,
    worktreeParam,
    roleKind: normalizeEntryKind(role),
    suggested: Array.isArray(params?.allowed_tools)
      ? params.allowed_tools.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [],
    manifestRole: role || 'worker-default',
    tab: typeof params?.tab === 'string' ? params.tab : null,
  };
}

/* ── task-id resolution ─────────────────────────────────────────── */

export type TaskIdResolutionResult =
  | { kind: 'resolved'; taskId: string }
  | { kind: 'ambiguous'; query: string; candidates: string[] }
  | { kind: 'too_short'; query: string }
  | { kind: 'not_found'; query: string };

/** Resolve a full or short task ID: exact matches at any length, prefix matches need four characters. */
export function resolveTaskIdPrefix(
  query: string,
  candidates: Iterable<string>,
): TaskIdResolutionResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: 'not_found', query: trimmed };

  const unique = Array.from(new Set(candidates));
  const exact = unique.find((candidate) => candidate === trimmed);
  if (exact) return { kind: 'resolved', taskId: exact };

  if (trimmed.length < 4) return { kind: 'too_short', query: trimmed };

  const lower = trimmed.toLowerCase();
  const matches = unique.filter((candidate) => candidate.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { kind: 'resolved', taskId: matches[0]! };
  if (matches.length > 1) {
    matches.sort();
    return { kind: 'ambiguous', query: trimmed, candidates: matches };
  }
  return { kind: 'not_found', query: trimmed };
}

/** Error text for a non-resolved `resolveTaskIdPrefix` outcome; null for `resolved` (each caller owns
 * its success path) and `not_found` (each caller words its own unknown-id hint). `rawQuery` keeps
 * the caller's original string in the message even though matching works on the trimmed form. */
export function taskIdResolutionError(
  res: TaskIdResolutionResult,
  label: 'task id' | 'subagent id',
  rawQuery: string,
): string | null {
  if (res.kind === 'too_short') return `Error: ${label} prefix "${rawQuery}" is too short (minimum 4 characters).`;
  if (res.kind === 'ambiguous') return ambiguousIdError(label, rawQuery, res.candidates);
  return null;
}

/* ── outbound port (composition root → plugin) ──────────────────── */

/** Bound atomically at session_start: consumers read `current` and must tolerate null. */
export interface SubagentPort {
  /** The (paneId, slug, state, elapsed) rows the master's widget shows: one per worker still awaiting
   *  a report. */
  listRunningSubs(): WorkerWidgetRow[];
  /** Open one settlement-delivery batch: the notice buffer (index.ts) hands a whole collapsed message
   *  to pi, and the ledger that records the delivery lives in the plugin, so the batch's single cursor
   *  step is opened through here. `end` closes it and writes the cursor once. */
  openDeliveryBatch?(): { end(): void } | null;
}

export interface SubagentPortBox {
  current: SubagentPort | null;
}

export function emptySubagentPortBox(): SubagentPortBox {
  return { current: null };
}
