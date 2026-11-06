/**
 * S71: a spawn may ask for a checkout by name, and piher owns none of it. This module plans that
 * checkout (`<home>/.herdr/worktrees/<repo>/<slug>`, branch `<name>`), keeps creation idempotent
 * and releases what piher created — the worktree, never with `--force`.
 *
 * The app is not involved. Its `Open worktree` button lists `git worktree list`, so a checkout
 * created here appears there by itself; the path convention is shared with its mod so both agree on
 * where a checkout of a given name lives, and that agreement is the whole integration.
 */
import { basename, join } from 'node:path';

/** What a spawn recorded, and the only thing that authorises a later removal (S71). */
export interface WorktreeRecord {
  path: string;
  branch: string;
}

export interface WorktreePlan {
  /** The branch piher creates, exactly as the caller named it. */
  branch: string;
  /** The one directory segment under `~/.herdr/worktrees/<repo>/` — the name, made path-safe. */
  slug: string;
  path: string;
}

/** A persisted checkout record is only trusted when its path and branch are readable (S71). */
export function foldWorktree(raw: unknown): WorktreeRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.path !== 'string' || !rec.path) return undefined;
  if (typeof rec.branch !== 'string' || !rec.branch) return undefined;
  return { path: rec.path, branch: rec.branch };
}

/** Everything outside `[A-Za-z0-9._-]` becomes `-`, and leading/trailing dashes go — the same rule
 *  the machine's `herdr-wt` uses, so both agree on where a checkout of a given name lives. */
export function slugifyWorktree(name: string): string {
  return String(name ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** Derive the checkout from the name: branch `<name>`, directory `<slug>`. Only the shapes that make
 *  it a *path* rather than a name are refused here; whether git accepts the branch name is git's own
 *  question (`ensureCheckout` asks it), so a slash — a perfectly good branch character — passes and
 *  simply becomes a dash in the directory. */
export function planWorktree(opts: { name: string; repoRoot: string; home: string }):
  { kind: 'ok'; plan: WorktreePlan } | { kind: 'error'; text: string } {
  const name = String(opts.name ?? '').trim();
  if (!name) {
    return { kind: 'error', text: 'Error: `worktree` needs a name (for example "probe"), and piher creates the checkout from it.' };
  }
  const looksLikePath = /[\\]/.test(name)
    || name.startsWith('/')
    || name.startsWith('~')
    || name.startsWith('-')
    || name.split('/').some((part) => part === '.' || part === '..')
    || name.includes('@{')
    || /[\u0000-\u001f]/.test(name);
  if (looksLikePath) {
    return {
      kind: 'error',
      text: `Error: \`worktree\` is a name, not a path: "${name}". Pass "probe" or "feat/algo", not "~/.herdr/worktrees/probe".`,
    };
  }
  const slug = slugifyWorktree(name);
  if (!slug || slug === '.' || slug === '..') {
    return {
      kind: 'error',
      text: `Error: \`worktree\` "${name}" has no letters, digits, dot, dash or underscore to name its directory with. Give it an ASCII name.`,
    };
  }
  return {
    kind: 'ok',
    plan: {
      branch: name,
      slug,
      path: join(opts.home, '.herdr', 'worktrees', basename(opts.repoRoot.replace(/[\\/]+$/, '')), slug),
    },
  };
}

/** The name reached git and git said no: one message, whatever rule it tripped. */
export function invalidBranchText(name: string): string {
  return `Error: \`worktree\` "${name}" is not a valid branch name — git refuses it, so there is no branch to create the checkout on. Use a name git accepts, for example "feat/algo".`;
}

/* ── port types ─────────────────────────────────────────────────── */

/** git plumbing for the checkout piher may create or remove. */
export interface CheckoutIo {
  /** `git worktree list --porcelain` in `cwd`'s repository: path → branch it holds (null: detached). */
  worktrees(cwd: string): Promise<Map<string, string | null>>;
  /** `git check-ref-format --branch`: git is the authority on what may name a branch. */
  validBranch(cwd: string, branch: string): Promise<boolean>;
  branchExists(cwd: string, branch: string): Promise<boolean>;
  /** `git worktree add`; `base` omitted means the repository's HEAD. */
  add(cwd: string, opts: { path: string; branch: string; base: string | null }): Promise<void>;
  /** HEAD commit of `cwd`'s checkout; null on an unborn branch. */
  head(cwd: string): Promise<string | null>;
  /** Uncommitted path list of the checkout at `path`; null when it could not be read. */
  dirtyFiles(path: string): Promise<string[] | null>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}



/* ── creation ───────────────────────────────────────────────────── */

const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export type EnsureOutcome =
  | { kind: 'created' }
  | { kind: 'reused' }
  | { kind: 'error'; text: string };

/** Idempotent creation: an existing path on the expected branch is reused and reported, an occupied
 *  one is an error naming the path and the branch it holds (S71). */
export async function ensureCheckout(
  io: CheckoutIo,
  opts: { plan: WorktreePlan; cwd: string },
): Promise<EnsureOutcome> {
  const { plan, cwd } = opts;
  // Never guess the branch rules: a space, `..`, a trailing dot and whatever git adds next are all
  // git's to refuse, and one question covers the whole class.
  if (!(await io.validBranch(cwd, plan.branch))) {
    return { kind: 'error', text: invalidBranchText(plan.branch) };
  }
  let trees: Map<string, string | null>;
  try {
    trees = await io.worktrees(cwd);
  } catch (err) {
    return { kind: 'error', text: `Error: cannot read the worktrees of ${cwd}: ${message(err)}` };
  }
  const held = [...trees.entries()].find(([path]) => samePath(path, plan.path));
  if (held) {
    const branchOnDisk = held[1];
    if (branchOnDisk === plan.branch) return { kind: 'reused' };
    return {
      kind: 'error',
      text: `Error: ${plan.path} is already a worktree of another branch (${branchOnDisk ?? 'detached HEAD'}), so it cannot hold branch ${plan.branch}. Remove that worktree or pick another name.`,
    };
  }
  if (await io.exists(plan.path)) {
    return {
      kind: 'error',
      text: `Error: ${plan.path} exists but is not a worktree of this repository, so piher will not touch it. Remove it, or pick another name.`,
    };
  }
  try {
    const base = (await io.branchExists(cwd, plan.branch)) ? null : await io.head(cwd);
    await io.add(cwd, { path: plan.path, branch: plan.branch, base });
    return { kind: 'created' };
  } catch (err) {
    return { kind: 'error', text: `Error: could not create the checkout ${plan.path} on branch ${plan.branch}: ${message(err)}` };
  }
}

/* ── release ────────────────────────────────────────────────────── */

export type ReleaseOutcome =
  | { ok: true; removed: boolean }
  | { ok: false; text: string };

/** Uncommitted files named in a refusal; enough to act on, never a whole `git status`. */
const DIRTY_LIST_MAX = 8;

export function dirtyCheckoutText(record: Pick<WorktreeRecord, 'path' | 'branch'>, files: readonly string[]): string {
  const shown = files.slice(0, DIRTY_LIST_MAX).join(', ');
  const more = files.length > DIRTY_LIST_MAX ? `, … ${files.length - DIRTY_LIST_MAX} more` : '';
  return [
    `Error: worktree ${record.path} is not removed because it has uncommitted changes:`,
    `${shown}${more}.`,
    `Commit or discard them and close again — the branch ${record.branch} survives, and nothing was removed yet.`,
  ].join(' ');
}

/** Close is terminal for the checkout: the worktree goes, the branch never (S71). Nothing forces a
 *  removal: a dirty checkout is refused, and the removal itself is `git worktree remove` without
 *  `--force`. */
export async function releaseCheckout(
  io: CheckoutIo,
  record: WorktreeRecord,
): Promise<ReleaseOutcome> {
  const present = await io.exists(record.path);
  if (present) {
    const dirty = await io.dirtyFiles(record.path).catch(() => null);
    if (dirty === null) {
      return {
        ok: false,
        text: `Error: ${record.path} exists but its git status could not be read, so piher will not remove it. Check the checkout by hand; the branch ${record.branch} survives.`,
      };
    }
    if (dirty.length > 0) return { ok: false, text: dirtyCheckoutText(record, dirty) };
  }
  if (!present) return { ok: true, removed: false };
  try {
    await io.remove(record.path);
  } catch (err) {
    return {
      ok: false,
      text: `Error: could not remove the worktree ${record.path} (branch ${record.branch} survived): ${message(err)}`,
    };
  }
  return { ok: true, removed: true };
}

/* ── texts ──────────────────────────────────────────────────────── */

export function checkoutAckLine(record: WorktreeRecord, outcome: 'created' | 'reused'): string {
  const how = outcome === 'reused' ? 'reusing the existing worktree' : 'created the worktree';
  return `in worktree ${record.path} (branch ${record.branch}, ${how}; open it with the app's Open worktree)`;
}

export function releasedCheckoutLine(record: WorktreeRecord, removed: boolean): string {
  const parts = [removed ? `worktree ${record.path} removed` : `worktree ${record.path} was already gone`];
  parts.push(`branch ${record.branch} survives`);
  return parts.join('; ');
}

/** `resume` decides by existence, never by a flag (S71). */
export function missingCheckoutText(entry: {
  taskId: string;
  cwd: string;
  worktree?: WorktreeRecord | null;
}): string {
  const where = entry.worktree
    ? `its worktree ${entry.worktree.path} is gone (branch ${entry.worktree.branch} survives — recreate it with \`git worktree add ${entry.worktree.path} ${entry.worktree.branch}\`, then resume again)`
    : `its cwd ${entry.cwd} is gone, so there is nothing to revive`;
  return `Error: task ${entry.taskId} cannot be revived: ${where}.`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
