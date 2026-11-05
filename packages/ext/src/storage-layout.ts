/**
 * Storage path layout (delegation ledger, session dirs, role dirs) — the single owner of the
 * session-dir encoding, so session-tail / role-loader cannot drift apart.
 *
 * Reads try pi core's own directory name first, then piher's collision-resistant encoding
 * (`a/b` ≠ `a-b`), because both spellings can exist on disk.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** One shape for every per-session id carved out of a transcript path (worker marker, session dir). */
const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function isValidSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && SAFE_SESSION_ID_RE.test(id);
}

/** Collision-resistant name: `%` is escaped first so `/` `\` `:` round-trip (`a/b` → `--a%2Fb--`). */
export function sessionDirName(cwd: string): string {
  const encoded = cwd
    .replace(/%/g, '%25')
    .replace(/\\/g, '%5C')
    .replace(/\//g, '%2F')
    .replace(/:/g, '%3A');
  return `--${encoded}--`;
}

/**
 * pi core's own session-directory encoding, byte-for-byte: strip ONE leading separator, then flatten
 * `/` `\` `:` — it does NOT escape `%` like `sessionDirName`. `<agentDir>/sessions/` is pi core's
 * directory, so reading pi sessions must match it exactly.
 */
export function piCoreSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * pi core's exact name first, then piher's own encoding. Read-only: writes to
 * `<agentDir>/sessions/` are pi core's business.
 */
export function piSessionDirCandidates(cwd: string): readonly string[] {
  return [...new Set([piCoreSessionDirName(cwd), sessionDirName(cwd)])];
}

/**
 * Main worktree root of the repository containing `cwd`, or null when `cwd` is not in a working
 * tree. Mirrors the first entry of `git worktree list --porcelain` without spawning git, because the
 * ledger is written on a synchronous path: a main checkout has a `.git` directory, a linked
 * worktree has a `.git` file whose `commondir` points back at the main checkout's `.git`.
 */
export function mainWorktreeRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null; // a collected checkout (deleted worktree) has no repository to write into
  }
  for (;;) {
    const dotGit = join(dir, '.git');
    let isDir: boolean | null = null;
    try {
      isDir = statSync(dotGit).isDirectory();
    } catch {
      isDir = null;
    }
    if (isDir === true) return dir;
    if (isDir === false) {
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
        if (!m) return null;
        const gitdir = resolve(dir, m[1]!.trim());
        // A linked worktree records the shared git dir in `commondir` (`../..` from its own gitdir).
        // A submodule or a bare redirect has no commondir and owns no working tree here.
        return dirname(resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()));
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Delegation ledger of the repository containing `cwd`: one file per repository inside the main
 * checkout, so a worker in a linked worktree records into the repository, never into the worktree.
 * Outside a git repository there is no ledger and no fallback location. `.piher/history/` must be
 * git-ignored (never the parent `.piher/`, whose `roles/` are meant to be committed).
 */
export function ledgerFile(cwd: string): string | null {
  const root = mainWorktreeRoot(cwd);
  return root === null ? null : join(root, '.piher', 'history', 'history.jsonl');
}

export function userRolesDir(): string {
  return join(homedir(), '.pi', 'agent', 'piher', 'roles');
}

export function workspaceRolesDir(baseDir: string): string {
  return join(baseDir, '.piher', 'roles');
}
