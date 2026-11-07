/** The prompt a task was spawned with, kept so a retry costs no tokens: an upstream failure (a
 *  provider outage, a dropped stream) is nobody's fault in the task, and the master should not have to
 *  regenerate a whole brief to try again. One file per task, next to piher's other user state. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function taskPromptsDir(): string {
  // pi's own agent dir wins when set (a test home, a second profile), matching how piher locates
  // sessions and roles elsewhere.
  const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  return join(base, 'piher', 'prompts');
}

function promptPath(taskId: string): string {
  // A task id is a uuid or a kebab slug; anything else cannot address a file here.
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(taskPromptsDir(), `${safe}.md`);
}

/** Best effort by design: a task that cannot be retried is a smaller problem than a spawn that fails
 *  because a state file was unwritable. */
export function saveTaskPrompt(taskId: string, prompt: string): void {
  if (!taskId || prompt === '') return;
  try {
    mkdirSync(taskPromptsDir(), { recursive: true });
    writeFileSync(promptPath(taskId), prompt, 'utf8');
  } catch {
    /* no stored prompt: `retry` reports it and the master sends the task explicitly */
  }
}

export function readTaskPrompt(taskId: string): string | null {
  const file = promptPath(taskId);
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}

export function forgetTaskPrompt(taskId: string): void {
  try {
    rmSync(promptPath(taskId), { force: true });
  } catch {
    /* nothing to forget */
  }
}
