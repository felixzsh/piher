/**
 * Tail parsing for pi session JSONL (pure): child-agent results come from the child session file,
 * not pane text. Depends only on the pi session format:
 *   line = {type, id, parentId, message:{role, content:[{type:'text',text}...], timestamp, stopReason}}
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { piSessionDirCandidates, sessionDirName, isValidSessionId } from './storage-layout.ts';

export { sessionDirName };

export interface SessionMessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: string } | unknown> | unknown;
  timestamp?: number;
  stopReason?: string;
}

export interface SessionEntryLike {
  type?: string;
  message?: SessionMessageLike | unknown;
  [k: string]: unknown;
}
export function parseSessionEntries(text: string): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') entries.push(obj as SessionEntryLike);
    } catch {
    }
  }
  return entries;
}

function messageOf(entry: SessionEntryLike): SessionMessageLike | null {
  if (entry.type !== 'message') return null;
  const m = entry.message;
  if (typeof m !== 'object' || m === null) return null;
  return m as SessionMessageLike;
}

function textOf(m: SessionMessageLike): string {
  const content = m.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text') {
        return (c as { text?: string }).text ?? '';
      }
      return '';
    })
    .join('\n')
    .trim();
}
/** Latest finalized assistant text (`stopReason === 'stop'`), excluding toolUse intermediates;
 * `sinceTs` filters out messages predating the injection point. */
export function lastAssistantText(
  entries: readonly SessionEntryLike[],
  opts: { sinceTs?: number } = {},
): { text: string; timestamp: number } | null {
  let best: { text: string; timestamp: number } | null = null;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m || m.role !== 'assistant') continue;
    if (m.stopReason !== 'stop') continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (opts.sinceTs !== undefined && ts < opts.sinceTs) continue;
    if (!best || ts >= best.timestamp) best = { text: textOf(m), timestamp: ts };
  }
  return best;
}
/**
 * Newest assistant text after `sinceTs` with no stopReason filter: a turn can end by hitting the token
 * cap or by an abort, and those words are still the report the master should receive instead of
 * "left no closing message".
 */
export function lastAssistantAnyText(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): string | null {
  let best: { text: string; timestamp: number } | null = null;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m || m.role !== 'assistant') continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    const text = textOf(m).trim();
    if (!text) continue;
    if (!best || ts >= best.timestamp) best = { text, timestamp: ts };
  }
  return best?.text ?? null;
}

/** Return whether any assistant message occurs after the injection point, regardless of stopReason. */
export function hasAssistantAfter(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): boolean {
  return entries.some((e) => {
    const m = messageOf(e);
    return !!m && m.role === 'assistant' && (typeof m.timestamp === 'number' ? m.timestamp : 0) >= sinceTs;
  });
}
/**
 * Whether the NEWEST assistant message after `sinceTs` ended its turn: a worker between tool calls
 * has "an assistant message" but has NOT finished, so announcing it settled loses supervision of
 * live work. `stopReason === 'toolUse'` means tools were requested; a non-string stopReason (still
 * streaming / older shapes) counts as "not ended" on purpose.
 */
export function lastAssistantTurnEnded(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): boolean {
  let newest: { ts: number; stopReason: unknown } | null = null;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m || m.role !== 'assistant') continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    if (!newest || ts >= newest.ts) newest = { ts, stopReason: m.stopReason };
  }
  if (!newest) return false;
  const sr = newest.stopReason;
  return typeof sr === 'string' && sr !== 'toolUse' && sr !== 'pending';
}
/** Whether an initiated toolCall still lacks a result after injection (a task waiting on the tool's
 * own completion), meaning settlement has not completed. */
export function hasPendingToolCall(entries: readonly SessionEntryLike[], sinceTs: number): boolean {
  let depth = 0;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    if (m.role === 'assistant') {
      const content = m.content;
      if (Array.isArray(content)) {
        depth += content.filter((c) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'toolCall').length;
      }
    }
    if (m.role === 'toolResult') depth -= 1;
  }
  return depth > 0;
}

/** Derived settlement state of one child session, from the inject point onward. */
export interface SubSessionState {
  text: string | null;
  pendingTool: boolean;
  activity: boolean;
  turnEnded: boolean;
}

/** Closing text is terminal by construction (lastAssistantText requires stopReason 'stop'); an
 * assistant message alone is not a settlement — the turn must have ENDED. */
export function deriveSubSessionState(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): SubSessionState {
  const r = lastAssistantText(entries, { sinceTs });
  if (r?.text) return { text: r.text, pendingTool: false, activity: true, turnEnded: true };
  if (hasPendingToolCall(entries, sinceTs)) return { text: null, pendingTool: true, activity: true, turnEnded: false };
  if (hasAssistantAfter(entries, sinceTs)) {
    const turnEnded = lastAssistantTurnEnded(entries, sinceTs);
    // An ended turn always has words to deliver, even when they did not come from a clean 'stop'
    // (token cap, abort). Without this the poller saw "turn ended, no text" and announced
    // "It left no closing message" for a worker that had answered.
    const any = turnEnded ? lastAssistantAnyText(entries, sinceTs) : null;
    if (any) return { text: any, pendingTool: false, activity: true, turnEnded: true };
    return { text: null, pendingTool: false, activity: true, turnEnded };
  }
  return { text: null, pendingTool: false, activity: false, turnEnded: false };
}

/** Newest `limit` session files under cwd's session dir (pi core's name first, then piher's old encodings). */
export function listSessionFiles(cwd: string, agentDir: string, limit = 4): string[] {
  const files: Array<{ file: string; mtime: number }> = [];
  for (const name of piSessionDirCandidates(cwd)) {
    const dir = path.join(agentDir, name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (!fileName.endsWith('.jsonl')) continue;
      const full = path.join(dir, fileName);
      try {
        files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => f.file);
}

/** Locate a session file by id (`<ts>_<id>.jsonl`): pi core's directory name first, then piher's
 * legacy flattened dirs. */
export function sessionFileById(cwd: string, agentDir: string, id: string): string | null {
  const suffix = `_${id}.jsonl`;
  for (const name of piSessionDirCandidates(cwd)) {
    const dir = path.join(agentDir, name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (fileName.endsWith(suffix)) return path.join(dir, fileName);
    }
  }
  return null;
}

/**
 * Normalize a session path or id to the bare id used across piher state (`<timestamp>_<uuid>.jsonl`
 * → `<uuid>`; `sub-session.jsonl` stays whole). Only pi's real transcript prefix is stripped, so
 * arbitrary ids like PI_SESSION_FILE=sess_idx_prune survive untouched. Same-normalization comparisons
 * (own session vs candidate paths) must go through here.
 */
export function bareSessionId(raw: string): string {
  const base = raw.replaceAll('\\', '/').split('/').pop()!.replace(/\.jsonl$/, '');
  const stripped = base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, '');
  return isValidSessionId(stripped) ? stripped : base;
}

/** Herdr reports session ids and paths interchangeably: accept a `.jsonl` path as-is, else map the id. */
export function resolveSessionFileValue(cwd: string, agentDir: string, value: string | null | undefined): string | null {
  if (!value) return null;
  return /\.jsonl$/i.test(value) ? value : sessionFileById(cwd, agentDir, value);
}

export function readSessionFile(file: string): SessionEntryLike[] | null {
  try {
    return parseSessionEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
