/**
 * TUI renderers for piher's own session custom entries and reminder messages: raw JSON rows bury the
 * one line that matters. Pure string builders plus an ANSI-aware truncator, so no pi-tui import is
 * needed and older pi builds degrade to "no renderer".
 */
import { SUBS_CUSTOM_TYPE, type SubsRegistry } from './subagent-core.ts';
import { DELEGATION_CUSTOM_TYPE } from './delegation-core.ts';
import { TERMINALS_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE, type TerminalsRegistry } from './terminal-core.ts';
import { SETTLEMENT_CUSTOM_TYPE, formatElapsed, type SettlementCard } from './settlement-card.ts';

// Width handling lives in ansi-text.ts so the transcript cards need no pi-tui import.
import { truncateStyled } from './ansi-text.ts';

/** Role manifest entry is written by index-roles.ts; keep the literal here to avoid an import cycle. */
export const ROLE_MANIFEST_CUSTOM_TYPE = 'piher.role-manifest';

/** Structural subset of pi's Theme actually used here. */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

type Renderer = (payload: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent | undefined;

export interface RendererApi {
  registerEntryRenderer?(customType: string, renderer: Renderer): void;
  registerMessageRenderer?(customType: string, renderer: Renderer): void;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function card(lines: readonly string[]): RenderComponent {
  return {
    render: (width: number) => lines.map((line) => truncateStyled(line, width)),
    invalidate() { /* No cached state. */ },
  };
}

/** Registry card, shared by the subagent and terminal registries: a titled count line plus one row
 *  per entry when expanded; an empty or malformed registry renders one dim placeholder. */
function registryLines<T>(
  items: readonly T[] | undefined,
  theme: RenderTheme,
  expanded: boolean,
  card: { label: string; unit: string; badge?: string; row: (item: T) => string },
): string[] {
  if (!items || items.length === 0) return [theme.fg('dim', `${card.label} · none`)];
  const head = `${theme.fg('accent', theme.bold(card.label))} ${theme.fg('dim', `· ${items.length} ${card.unit}`)}${card.badge ? ` ${theme.fg('success', card.badge)}` : ''}`;
  if (!expanded) return [head];
  return [head, ...items.map((item) => theme.fg('dim', card.row(item)))];
}

/** The registry entry is a record, not a transcript card (S73): one line while workers run, so the
 *  master can see it is delegated, and nothing at all once every worker has settled. */
function subsLines(data: unknown, theme: RenderTheme): string[] {
  const subs = (data as SubsRegistry | undefined)?.subs;
  const running = Array.isArray(subs) ? subs.filter((sub) => sub.status === 'running').length : 0;
  if (running === 0) return [];
  const head = `${theme.fg('accent', theme.bold('subagents'))} ${theme.fg('dim', `· ${running} running`)}`;
  return [head];
}

/** First-frame delegation card in the worker's own transcript (RFC rfc-delegation-identity §2.3). */
function delegationLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const rec = (data ?? {}) as {
    parentPaneId?: unknown;
    parentSessionId?: unknown;
    taskId?: unknown;
    description?: unknown;
    role?: unknown;
  };
  const parent = typeof rec.parentPaneId === 'string' && rec.parentPaneId ? rec.parentPaneId : '?';
  const head = `${theme.fg('accent', '⟵ delegated')} ${theme.fg('dim', `by master ${parent} · ${clip(String(rec.description ?? ''), 60)}`)}`;
  if (!expanded) return [head];
  const session = typeof rec.parentSessionId === 'string' && rec.parentSessionId ? rec.parentSessionId : '?';
  const role = typeof rec.role === 'string' && rec.role ? rec.role : '?';
  return [
    head,
    theme.fg('dim', `  task ${typeof rec.taskId === 'string' ? rec.taskId : '?'} · role ${role} · parent session ${session}`),
  ];
}

function terminalsLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const terminals = (data as TerminalsRegistry | undefined)?.terminals;
  return registryLines(Array.isArray(terminals) ? terminals : undefined, theme, expanded, {
    label: 'terminals',
    unit: 'open',
    row: (t) => `  ${t.paneId} · ${clip(String(t.label ?? t.cwd ?? ''), 70)}`,
  });
}

function roleManifestLines(data: unknown, theme: RenderTheme): string[] {
  const rec = (data ?? {}) as {
    role?: unknown;
    manifestVersion?: unknown;
    tools?: unknown;
    permissions?: unknown;
    origin?: unknown;
    switchedBy?: unknown;
  };
  const role = typeof rec.role === 'string' ? rec.role : '?';
  const version = typeof rec.manifestVersion === 'string' || typeof rec.manifestVersion === 'number' ? String(rec.manifestVersion) : '?';
  const tools = Array.isArray(rec.tools) ? rec.tools.length : 0;
  const gates = Object.values((rec.permissions ?? {}) as Record<string, unknown>)
    .filter((v) => v === 'deny').length;
  const tail = gates > 0 ? theme.fg('warning', ` · ${gates} gated`) : '';
  // P0: switch provenance — origin 'switch' marks a mid-session swap (vs the session_start anchor).
  const switched =
    rec.origin === 'switch'
      ? theme.fg('accent', ` ⇄ ${typeof rec.switchedBy === 'string' && rec.switchedBy ? rec.switchedBy : '?'}`)
      : '';
  return [`${theme.fg('accent', theme.bold('role'))} ${role} ${theme.fg('dim', `v${version} · ${tools} tools`)}${tail}${switched}`];
}

/**
 * Settlement card (S57): the header is what the transcript shows — name, role, outcome, elapsed —
 * and the notice text it carries is never rewritten. Missing fields degrade to the plain content.
 */
function settlementLines(message: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const rec = (message ?? {}) as { content?: unknown; details?: unknown };
  const details = (rec.details ?? {}) as Partial<SettlementCard>;
  const content = typeof rec.content === 'string' ? rec.content : '';
  if (typeof details.name !== 'string' || details.name === '') {
    return reminderLines(message, theme, 'subagent settled', expanded);
  }
  const outcome = details.outcome === 'failed' || details.outcome === 'closed' ? details.outcome : 'settled';
  const tone = outcome === 'failed' ? 'error' : outcome === 'closed' ? 'warning' : 'success';
  const fields = [
    details.role ?? 'task',
    outcome,
    typeof details.elapsedMs === 'number' ? formatElapsed(details.elapsedMs) : null,
  ].filter((field): field is string => typeof field === 'string');
  const head = `${theme.fg(tone, theme.bold('subagent'))} ${theme.bold(details.name)} ${theme.fg('dim', `· ${fields.join(' · ')}`)}`;
  if (!expanded) return [head];
  return [head, ...content.split('\n').map((line) => theme.fg('dim', line))];
}

/** Reminder custom messages carry the full injected text; restyle without altering it. */
function reminderLines(message: unknown, theme: RenderTheme, label: string, expanded: boolean): string[] {
  const content = typeof (message as { content?: unknown } | undefined)?.content === 'string'
    ? String((message as { content: string }).content)
    : '';
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? label;
  const head = `${theme.fg('warning', `↻ ${label}`)}`;
  if (!expanded) return [head, theme.fg('dim', `  ${clip(firstLine, 110)}`)];
  return [head, ...content.split('\n').map((line) => theme.fg('dim', line))];
}

type LineBuilder = (data: unknown, theme: RenderTheme, expanded: boolean) => string[];

/** Register piher's transcript renderers and return the custom types actually registered, so the
 *  caller can log coverage and tests can assert the degrade path. Each registration is individually
 *  guarded: a pi build without the API must never break tool registration. */
export function installRenderers(pi: unknown): string[] {
  const api = pi as RendererApi;
  const registered: string[] = [];
  const entry = (type: string, build: LineBuilder): void => {
    if (typeof api.registerEntryRenderer !== 'function') return;
    try {
      api.registerEntryRenderer(type, (entryData, options, theme) =>
        card(build((entryData as { data?: unknown } | undefined)?.data, theme, options.expanded)));
      registered.push(type);
    } catch {
      /* Older pi or a conflicting renderer: keep the default rendering. */
    }
  };
  const message = (type: string, build: LineBuilder): void => {
    if (typeof api.registerMessageRenderer !== 'function') return;
    try {
      api.registerMessageRenderer(type, (msg, options, theme) => card(build(msg, theme, options.expanded)));
      registered.push(type);
    } catch {
      /* A throwing renderer must not break message registration. */
    }
  };

  entry(SUBS_CUSTOM_TYPE, subsLines);
  entry(TERMINALS_CUSTOM_TYPE, terminalsLines);
  entry(DELEGATION_CUSTOM_TYPE, delegationLines);
  entry(ROLE_MANIFEST_CUSTOM_TYPE, (data, theme) => roleManifestLines(data, theme));
  message(SETTLEMENT_CUSTOM_TYPE, (msg, theme, expanded) => settlementLines(msg, theme, expanded));
  message(TERM_REMINDER_CUSTOM_TYPE, (msg, theme, expanded) => reminderLines(msg, theme, 'terminal nudge', expanded));
  return registered;
}
