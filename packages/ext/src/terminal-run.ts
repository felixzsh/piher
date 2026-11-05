/**
 * Terminal completion notices (S64): a command the model explicitly runs through `terminal send`
 * finishes with an exit code the model can act on, without a blocking `wait` or a sleep loop. An
 * interactive shell — opened, typed into by a human, or sitting idle — never notifies, because a
 * shell that idles is not a command that finished.
 *
 * Mechanics: the sent line gets a trailing `printf` that prints a per-run marker carrying `$?`.
 * The marker reaches the pane only after the command finishes, and the echoed command text shows
 * the format placeholders instead of the marker, so the watcher cannot match its own echo.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Custom message type of the completion notice; the model reads `content`, the TUI draws the card. */
export const TERMINAL_RUN_CUSTOM_TYPE = 'piher.terminal-exit';

/** Give up on a run after this long: no marker means nothing finished, so no notice is due. */
export const TERMINAL_RUN_TIMEOUT_MS = 600_000;

/** Marker line prefix; the nonce keeps two runs on one shell apart. */
const MARKER = '__PIHER_EXIT_';

/** Shell quoting that would swallow the appended `printf`: the command owns the rest of the line. */
const UNSAFE_TAIL = /(?:[&|\\]|&&|\|\|)\s*$/;

/**
 * Shells that parse `cmd; printf '…' "$?"` as a command followed by a status reporter. Anything else
 * (fish, nushell, csh, a Windows shell, or a shell this host cannot name) is sent untouched: gluing the
 * reporter onto a prompt that does not run it would type garbage into the user's shell.
 */
const RUN_REPORTER_SHELLS: Record<string, true> = {
  sh: true, bash: true, zsh: true, dash: true, ash: true, ksh: true, mksh: true, yash: true,
};

/** `$SHELL` name → is a trailing `; printf "$?"` reliable? Unknown names are treated as unsafe. */
export function shellRunsReporter(shellName: string): boolean {
  const base = shellName.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return RUN_REPORTER_SHELLS[base.replace(/^-/, '').replace(/\.exe$/, '')] === true;
}

export interface TerminalRunPlan {
  /** What actually goes to the pane: the command plus its exit-code reporter. */
  wrapped: string;
  /** The marker line this run must produce, unique per run. */
  marker: string;
}

export function newRunNonce(random: () => number = Math.random): string {
  return Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');
}

/**
 * A comment marker outside quotes: `echo #done; printf …` would comment the reporter out, so such a
 * line is sent untouched and never notifies.
 */
export function hasShellComment(text: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') i += 1;
    else if (ch === '#' && (i === 0 || /[\s;(&|]/.test(text[i - 1]!))) return true;
  }
  return false;
}

/**
 * Plan the run for one send: single line, a shell that runs the reporter, an idle shell prompt, and a
 * line that can take a trailing `; printf`. Anything else (multi-line blocks and heredocs, input for a
 * continuation prompt or a waiting program, a REPL owning the pane, an unknown shell, a trailing
 * `&`/pipe/continuation, an inline comment) is sent unchanged and notifies nothing.
 */
export function planTerminalRun(input: {
  text: string;
  /** Shell from `$SHELL`/`PIHER_TERMINAL_PROMPT`; only a known POSIX shell gets a reporter. */
  shellName: string;
  /** The shell owns the pane, so the line is a shell command rather than another program's input. */
  shellIdle: boolean;
  nonce?: string;
}): TerminalRunPlan | null {
  if (!shellRunsReporter(input.shellName) || !input.shellIdle) return null;
  const body = input.text.replace(/\s+$/, '');
  if (body === '' || body.includes('\n') || body.includes('\r')) return null;
  if (UNSAFE_TAIL.test(body) || hasShellComment(body)) return null;
  const command = body.replace(/;+$/, '');
  if (command === '') return null;
  const nonce = input.nonce ?? newRunNonce();
  const marker = `${MARKER}${nonce}__`;
  // `%s`/`%d` keep the marker itself out of the echoed command: the echo shows the placeholders.
  return { wrapped: `${command}; printf '\\n${MARKER}%s__%d\\n' '${nonce}' "$?"`, marker };
}

function markerPattern(marker: string): RegExp {
  return new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-?\\d+)\\s*$`, 'm');
}

/** `$?` as printed by the run's own reporter; `null` while the command is still running. */
export function runExitCode(text: string, marker: string): number | null {
  const match = markerPattern(marker).exec(text);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

/**
 * The pane text this run produced: everything above the marker line, without the run's own echoed
 * command line. Only the echo of THIS run is dropped (it carries the run's nonce); any other line that
 * merely mentions the marker prefix is real output and stays in the log.
 */
export function runOutput(text: string, marker: string): string {
  const match = markerPattern(marker).exec(text);
  const end = match?.index ?? text.length;
  // `marker` is `<prefix><nonce>__`; the echo of the wrapped line quotes the nonce, not the prefix.
  const nonce = marker.startsWith(MARKER) && marker.endsWith('__')
    ? marker.slice(MARKER.length, -2)
    : marker;
  return text
    .slice(0, end)
    .split('\n')
    .filter((line) => nonce === '' || !line.includes(nonce))
    .join('\n')
    .replace(/\s+$/, '');
}

/** Last `max` lines: enough to judge the outcome without pasting a whole log into the context. */
export function lastLines(text: string, max: number): string {
  const lines = text.split('\n');
  return (lines.length <= max ? lines : lines.slice(-max)).join('\n');
}

/** Run logs live under the OS temp dir: absolute, readable by the model, cleaned up by the system. */
export function terminalRunLogPath(input: { paneId: string; now?: number; stamp?: string }): string {
  const stamp = input.stamp
    ?? new Date(input.now ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  const pane = input.paneId.replace(/[^A-Za-z0-9._-]+/g, '-');
  return join(tmpdir(), 'piher-terminal-runs', `${pane}-${stamp}.log`);
}

export function writeRunLog(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

export function formatTerminalRunNotice(input: {
  terminalId: string;
  label: string | null;
  /** The status core reported; `null` when the run ended without one (a pane that is simply gone). */
  exitCode: number | null;
  /** The shell itself ended, so the run's own reporter never ran; core's terminal status stands in. */
  shellExited?: boolean;
  tail: string;
  logPath: string | null;
}): string {
  const name = input.label ? `${input.terminalId} (${input.label})` : input.terminalId;
  const head = input.shellExited
    ? input.exitCode === null
      ? `terminal ${name} finished: the shell exited before its command could report a status.`
      : `terminal ${name} finished: the shell exited (exit ${input.exitCode}).`
    : input.exitCode === null
      ? `terminal ${name} finished without a status to report.`
      : `terminal ${name} finished: exit ${input.exitCode}.`;
  const where = input.logPath ? `\nFull output: ${input.logPath}` : '';
  return input.tail ? `${head}\nLast lines:\n${input.tail}${where}` : `${head}${where}`;
}
