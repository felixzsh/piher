/**
 * `swallow(tag, err)` keeps catch-site cleanup behaviour, but records the event in a bounded ring
 * buffer, so `/piher-config` can show the recent ones and a bug report can quote them. Stays
 * silent: cleanup paths must never add noise to the transcript.
 */

export interface SwallowedError {
  /** Stable site label, e.g. 'role.persist-switch'. */
  readonly tag: string;
  readonly message: string;
  /** Epoch ms. */
  readonly at: number;
}

export const SWALLOW_BUFFER_MAX = 50;

const buffer: SwallowedError[] = [];

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return code !== undefined ? `${err.name}: ${err.message} (code ${String(code)})` : `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Record a caught error that is being intentionally ignored; call sites keep their cleanup and stay
 * `} catch (err) { swallow('tag', err); }`.
 */
export function swallow(tag: string, err: unknown): void {
  const entry: SwallowedError = { tag, message: describe(err), at: Date.now() };
  buffer.push(entry);
  if (buffer.length > SWALLOW_BUFFER_MAX) buffer.splice(0, buffer.length - SWALLOW_BUFFER_MAX);
}

/** Recent swallowed errors, oldest first (diagnostics only; never persisted). */
export function swallowedErrors(): readonly SwallowedError[] {
  return [...buffer];
}

export function resetSwallowedErrors(): void {
  buffer.length = 0;
}

/** Render for `/piher-config`; the section is never ambiguous even with no entries. */
export function formatSwallowedErrors(entries: readonly SwallowedError[] = swallowedErrors()): string {
  if (entries.length === 0) return 'swallowed errors: none this session';
  const lines = entries.slice(-10).map((e) => {
    const hhmmss = new Date(e.at).toISOString().slice(11, 19);
    return `${hhmmss} ${e.tag}: ${e.message}`;
  });
  return [`swallowed errors: ${entries.length} this session (last 10)`, ...lines].join('\n');
}
