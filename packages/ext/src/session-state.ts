/**
 * piher's per-session state root: `<sessionDir>/piher/<sessionId>/`, the one place the extension owns
 * beside pi's transcript. The worker marker and the subagent registry live here, both written in place
 * rather than appended to the session, which is an immutable log: `appendEntry` has no replace, and a
 * growing tail of full copies is exactly what made a reload restore a truncated registry (S73).
 */
import { dirname, join } from 'node:path';
import { bareSessionId } from './session-tail.ts';
import { isValidSessionId } from './storage-layout.ts';

/** `<sessionDir>/piher/<sessionId>/<name>`; a bare id (`PI_SESSION_FILE=oneshot-sess-0001`, no transcript
 *  directory) has nowhere to sit, so no state file — callers must then fall back to what they have. */
export function sessionStatePath(sessionFile: string | null | undefined, name: string): string | null {
  if (!sessionFile || typeof sessionFile !== 'string') return null;
  const dir = dirname(sessionFile);
  if (dir === '' || dir === '.') return null;
  const id = bareSessionId(sessionFile);
  if (!isValidSessionId(id)) return null;
  return join(dir, 'piher', id, name);
}
