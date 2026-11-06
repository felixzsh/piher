/**
 * Adapter for the checkout piher may create (S71): `git worktree` plumbing, injectable so the spawn
 * paths stay testable without a real repository.
 *
 * There is no app adapter. The app's `Open worktree` lists `git worktree list`, so a checkout made
 * here shows up there by itself, and a space is the person's to open — piher never talks to the app.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { runtimePolicy } from './runtime-policy.ts';
import type { CheckoutIo } from './worktree.ts';

const execFile = promisify(nodeExecFile);
const MAX_BUFFER = 8 * 1024 * 1024;

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

export function createCheckoutIo(): CheckoutIo {
  return new NodeCheckoutIo();
}
