/**
 * Worker identity marker: the delegation identity (parent terminal/session, task, role) is written
 * beside the session transcript so a `/resume` replay of that exact session keeps learning who
 * delegated it, even when the spawn env is gone. Masters never write a marker; a stale marker for a
 * dead session is inert (it is only consulted when pi boots with that exact session file).
 */
import type { DelegationContext } from './delegation-core.ts';
import { delegationFromRecord } from './delegation-core.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sessionStatePath } from './session-state.ts';

export interface WorkerMarker {
  readonly v: 1;
  readonly ts: number;
  readonly role?: string;
  readonly delegation?: DelegationContext;
}

/** `<sessionDir>/piher/<sessionId>/worker.json` — the per-session state root piher owns. A bare id
 *  (`PI_SESSION_FILE=oneshot-sess-0001`, no transcript directory) has nowhere to sit, so no marker. */
export function workerMarkerPath(sessionFile: string | null | undefined): string | null {
  return sessionStatePath(sessionFile, 'worker.json');
}

export function readWorkerMarker(sessionFile: string | null | undefined): WorkerMarker | null {
  const file = workerMarkerPath(sessionFile);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; ts?: unknown; role?: unknown; delegation?: unknown };
    if (parsed && parsed.v === 1 && typeof parsed.ts === 'number') {
      const delegation = delegationFromRecord(parsed.delegation);
      return {
        v: 1,
        ts: parsed.ts,
        ...(typeof parsed.role === 'string' ? { role: parsed.role } : {}),
        ...(delegation ? { delegation } : {}),
      };
    }
  } catch {
    /* missing or torn write: no marker → boot stays env-driven */
  }
  return null;
}

/** Idempotent; best-effort — a failed write only loses delegation replay on /resume. */
export function writeWorkerMarker(
  sessionFile: string | null | undefined,
  role?: string,
  delegation?: DelegationContext,
): void {
  const file = workerMarkerPath(sessionFile);
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      v: 1,
      ts: Date.now(),
      ...(role ? { role } : {}),
      ...(delegation ? { delegation } : {}),
    })}\n`);
  } catch {
    /* read-only checkout or full disk: the live session is unaffected */
  }
}
