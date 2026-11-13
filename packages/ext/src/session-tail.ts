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
function lastAssistantText(
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
 * cap or by an abort, and those words are still the report it produced instead of
 * "left no closing message".
 */
function lastAssistantAnyText(
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

/**
 * Why a turn ended with nothing to say, in words the master can act on. A refused tool is the case
 * that matters: piher's gate refuses it, the model stops, and the report would otherwise say nothing
 * about why.
 */
function explainSilentEnd(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): string | null {
  let refusal: string | null = null;
  let failed = false;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    if (m.role === 'toolResult') {
      const hit = /role "([^"]+)" does not permit tool "([^"]+)"/.exec(textOf(m));
      if (hit) refusal = `the \`${hit[1]}\` manifest does not permit \`${hit[2]}\``;
    }
    if (m.role === 'assistant' && m.stopReason === 'error') failed = true;
  }
  if (refusal) {
    return `It stopped after a refused tool call: ${refusal}. Fix the role profile or the task, then continue it.`;
  }
  return failed ? 'Its turn ended with an error and no message.' : null;
}

/** The words one turn left behind. */
export interface TurnClosing {
  text: string | null;
  /** Nothing to say, but there is a reason the master can act on: a refused tool, an errored turn. */
  why: string | null;
}

/**
 * What a turn said, read from a transcript the CALLER OWNS: the worker reading its own session for
 * its own report (spec S8), and `output` showing a finished worker's last words.
 *
 * It answers "what did this turn say", never "did the turn end": no caller may settle, fail or
 * supervise a task from it (spec S5 — settlement is the core's `turn` plus the worker's report
 * document). `sinceTs` is the boundary the caller already knows: a turn that has ended.
 */
export function readTurnClosing(entries: readonly SessionEntryLike[], sinceTs: number): TurnClosing {
  const finalized = lastAssistantText(entries, { sinceTs });
  if (finalized?.text) return { text: finalized.text, why: null };
  // A turn can end by hitting the token cap or by an abort, and those words are still its report.
  const any = lastAssistantAnyText(entries, sinceTs);
  if (any) return { text: any, why: null };
  return { text: null, why: explainSilentEnd(entries, sinceTs) };
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
