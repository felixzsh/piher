/**
 * Delegation identity (RFC docs/rfc-delegation-identity.md Phase 1): a worker pane knows who
 * delegated it, and for what task, on every surface it already touches — the system prompt section
 * and the session custom entry (first-frame card).
 * Pure builders only; the composition root owns the side effects.
 */

import type { Lifecycle } from './role-manifest.ts';

/** Contract env handed to the worker process by the master (PIHER_ prefix per naming rule). */
export const DELEGATION_ENV = 'PIHER_DELEGATION';
/** Worker-session custom entry written once at first boot; replayed on resume. */
export const DELEGATION_CUSTOM_TYPE = 'piher.delegation';

export interface DelegationContext {
  /** Master pane that spawned this worker; '' when the master pane is unknown (tests, RPC). */
  readonly parentPaneId: string;
  /** Master pi session id (cross-locate the parent transcript via /resume). */
  readonly parentSessionId: string;
  /** TaskRow.taskId — stable across revives. */
  readonly taskId: string;
  /** Task short label (TaskRow.description). */
  readonly description: string;
  /** Role manifest name active at spawn. */
  readonly role: string;
  /** Role-declared lifetime (S9/S54): `one-shot` settles, reports and then exits; default `persistent`. */
  readonly lifecycle: Lifecycle;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Validate a parsed delegation record (env JSON, marker JSON or custom-entry data); null when malformed. */
export function delegationFromRecord(parsed: unknown): DelegationContext | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>; // shape-checked field by field below
  const taskId = str(rec.taskId);
  const description = str(rec.description);
  if (!taskId || !description) return null;
  return {
    parentPaneId: str(rec.parentPaneId) ?? '',
    parentSessionId: str(rec.parentSessionId) ?? '',
    taskId,
    description,
    role: str(rec.role) ?? 'worker-default',
    lifecycle: rec.lifecycle === 'one-shot' ? 'one-shot' : 'persistent',
  };
}

/** Parse the spawn env; null when absent or structurally invalid (taskId/description mandatory). */
export function parseDelegationContext(raw: string | undefined | null): DelegationContext | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return delegationFromRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** env map for spawnPaneInTaskTab/createTab; JSON like the role manifest next to it. */
export function delegationEnv(ctx: DelegationContext): Record<string, string> {
  return { [DELEGATION_ENV]: JSON.stringify(ctx) };
}

/** Fold `piher.delegation` branch entries (last one wins) — the /resume replay source. */
export function foldDelegation(
  entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): DelegationContext | null {
  let found: DelegationContext | null = null;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== DELEGATION_CUSTOM_TYPE) continue;
    const next = delegationFromRecord(entry.data);
    if (next) found = next;
  }
  return found;
}

/**
 * System-prompt section text: identity + delivery contract in one stable wording, so the master
 * model does not have to restate it in every spawn prompt (pi-subagent-manager idea A+F).
 */
export function buildDelegationSection(ctx: DelegationContext, ownPaneId: string): string {
  const parent = ctx.parentPaneId || 'unknown pane';
  const session = ctx.parentSessionId || 'unknown session';
  const self = ownPaneId ? ` You are pane ${ownPaneId} (agentId "${ownPaneId}") — cite it when asking questions or reporting errors.`
    : '';
  return [
    `You are a delegated subagent of the master pane ${parent} (session ${session}); you were not started by a human.`,
    `Task: ${ctx.description}. Role: ${ctx.role}.${self}`,
    'Contract: the master collects your answer from this pane\'s settlement, so end the turn in one of two ways — state the answer plainly, or, if you cannot finish, stop and make the first line `BLOCKED: <the decision or resource you need>`. Do not ask who requested the work and do not guess silently.',
  ].join('\n');
}

