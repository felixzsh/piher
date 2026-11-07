/**
 * piher's per-session state root: `<sessionDir>/piher/<sessionId>/`, the one place the extension owns
 * beside pi's transcript. The worker marker and the session's task view live here, written in place
 * rather than appended to the session, which is an immutable log with no replace.
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
