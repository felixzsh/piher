/**
 * Adapters for the checkout piher may create (S71): `git worktree` plumbing, and the `herdr-app` space
 * that shows it. Both are injectable so the spawn paths stay testable without a real window.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runtimePolicy } from './runtime-policy.ts';
import type { CheckoutIo, SpaceIo, WorktreeIo } from './worktree.ts';

const execFile = promisify(nodeExecFile);
const MAX_BUFFER = 8 * 1024 * 1024;
/** The app is a UI: a window that does not answer must not hold a spawn for long. */
const APP_TIMEOUT_MS = 5000;

type Exec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export class NodeCheckoutIo implements CheckoutIo {
  private readonly timeoutMs: number;
  private readonly git: string;
  private readonly exec: Exec;

  constructor(git = 'git', timeoutMs: number = runtimePolicy.gitTimeoutMs, exec: Exec = execFile as unknown as Exec) {
    this.git = git;
    this.timeoutMs = timeoutMs;
    this.exec = exec;
  }

  private async run(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await this.exec(this.git, ['-C', cwd, ...args], {
      timeout: this.timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  }

  async worktrees(cwd: string): Promise<Map<string, string | null>> {
    return parsePorcelain(await this.run(cwd, ['worktree', 'list', '--porcelain']));
  }

  /** Non-zero means git refused the name; its wording is not needed, only the verdict. */
  async validBranch(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.run(cwd, ['check-ref-format', '--branch', branch]);
      return true;
    } catch {
      return false;
    }
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async add(cwd: string, opts: { path: string; branch: string; base: string | null }): Promise<void> {
    const args = opts.base
      ? ['worktree', 'add', '-b', opts.branch, opts.path, opts.base]
      : ['worktree', 'add', opts.path, opts.branch];
    await this.run(cwd, args);
  }

  async head(cwd: string): Promise<string | null> {
    try {
      const out = (await this.run(cwd, ['rev-parse', 'HEAD'])).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  async dirtyFiles(path: string): Promise<string[] | null> {
    try {
      const out = await this.run(path, ['status', '--short']);
      return out.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return null;
    }
  }

  /** `git worktree remove` from inside the checkout itself — never `--force`, never by branch prefix
   *  (S71). A dirty checkout is refused before this runs, by `dirtyFiles`. */
  async remove(path: string): Promise<void> {
    await this.run(path, ['worktree', 'remove', path]);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }
}

/** `git worktree list --porcelain` → path → branch (`refs/heads/` stripped), null when detached. */
export function parsePorcelain(out: string): Map<string, string | null> {
  const trees = new Map<string, string | null>();
  let curPath: string | null = null;
  for (const line of out.replace(/\r/g, '').split('\n')) {
    const at = /^worktree (.+)$/.exec(line.trim());
    if (at) {
      curPath = at[1]!;
      trees.set(curPath, null);
      continue;
    }
    const branch = /^branch (.+)$/.exec(line.trim());
    if (branch && curPath) trees.set(curPath, branch[1]!.replace(/^refs\/heads\//, ''));
  }
  return trees;
}

/** What the app said, or why it never spoke: the body is the answer even when the exit is non-zero. */
type AppReply =
  | { kind: 'reply'; body: Record<string, unknown> }
  /** No body at all: `reason` names what stopped the app, so the report says what happened. */
  | { kind: 'silent'; reason: string };

/** A JSON object, or null when the text is empty or not one: the app's answers are all objects. */
function jsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** `herdr-app` answers a close for a space that is already gone with exit 1 and this on stdout. */
const GONE_SPACE = /^no space\b/i;

/** Silence has three causes; naming the one that happened is what makes a report actionable (S72). */
function silenceReason(err: unknown, timeoutMs: number): string {
  const e = (err ?? {}) as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (e.code === 'ENOENT' || /ENOENT/.test(message)) return 'is not installed — no `herdr-app` on PATH';
  if (e.killed === true || (typeof e.signal === 'string' && e.signal !== '')) {
    return `did not answer within ${timeoutMs} ms`;
  }
  if (typeof e.code === 'number') return `exited ${e.code} without answering`;
  return `failed before answering: ${message}`;
}

/**
 * The app's spaces. Nothing here may throw: an unreachable window costs a spawn its space, and a
 * close its space, but never the work (S71).
 */
export class HerdrAppSpaceIo implements SpaceIo {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly exec: Exec;
  private readonly home: string;

  constructor(bin = 'herdr-app', timeoutMs = APP_TIMEOUT_MS, exec: Exec = execFile as unknown as Exec, home = homedir()) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.exec = exec;
    this.home = home;
  }

  private async call(args: readonly string[]): Promise<AppReply> {
    try {
      const { stdout } = await this.exec(this.bin, args, {
        timeout: this.timeoutMs,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
      });
      return { kind: 'reply', body: jsonObject(stdout) ?? {} };
    } catch (err) {
      // A non-zero exit is not silence: `execFile` rejects but still carries what was written, and
      // an answer piher must read (`no space …`) comes exactly that way.
      const body = jsonObject((err as { stdout?: unknown } | null)?.stdout);
      if (body !== null) return { kind: 'reply', body };
      return { kind: 'silent', reason: silenceReason(err, this.timeoutMs) };
    }
  }

  /** `~/.herdr/space-ids/.active` names the space the person was looking at, when anything wrote it;
   *  there is no `space.list`, and a missing file means there is nowhere to return to. */
  private activeSpace(): string | null {
    try {
      const id = readFileSync(join(this.home, '.herdr', 'space-ids', '.active'), 'utf8').trim();
      return id || null;
    } catch {
      return null;
    }
  }

  async create(name: string, folder: string): Promise<{ spaceId: string } | null> {
    const before = this.activeSpace();
    const reply = await this.call(['do', 'space.new', '--folder', folder, '--name', name]);
    // `space.new` activates the space it makes, and the person did not ask to be moved: put them back.
    const raw = reply.kind === 'reply' ? reply.body['space'] : undefined;
    const spaceId = typeof raw === 'string' && raw ? raw : null;
    if (reply.kind === 'reply' && before && before !== spaceId) {
      await this.call(['do', 'space.select', '--id', before]);
    }
    return spaceId ? { spaceId } : null;
  }

  async close(spaceId: string): Promise<string | null> {
    const reply = await this.call(['do', 'space.close', '--id', spaceId, '--confirmed', 'true']);
    if (reply.kind === 'silent') return `herdr-app ${reply.reason}`;
    const error = reply.body['error'];
    if (typeof error !== 'string' || !error) return null;
    // Nothing left to close is a success, not an alarm: read as a failure, a space that is already
    // gone would be re-reported by every start, forever.
    if (GONE_SPACE.test(error.trim())) return null;
    return error;
  }
}

export function createWorktreeIo(): WorktreeIo {
  return { checkout: new NodeCheckoutIo(), space: new HerdrAppSpaceIo() };
}
