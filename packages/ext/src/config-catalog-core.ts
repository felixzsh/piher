/**
 * D104 config catalog core (pure).
 *
 * Single source of truth for the two configuration planes this extension has: role profiles
 * (per-file, its schema is the reference) and the runtime policy env, derived from the
 * `OPTION_SPECS` registry so the catalog cannot disagree with the runtime readers.
 * No I/O here (config-command.ts does the reading) and test/config-catalog.test.ts guards the mirror.
 */

import { OPTION_SPECS } from './options.ts';

export type ConfigPlaneId = 'roles' | 'env';

export type ConfigKind = 'boolean' | 'number' | 'string';

export interface ConfigKnob {
  readonly plane: ConfigPlaneId;
  /** Env var name for the `env` plane; a dotted path inside the plane's file otherwise. */
  readonly key: string;
  readonly kind: ConfigKind;
  readonly defaultValue?: string | number | boolean;
  /** Lower bound for numeric knobs (mirrors the runtime validator). */
  readonly min?: number;
  readonly impact: string;
}

export interface ConfigPlane {
  readonly id: ConfigPlaneId;
  readonly title: string;
  /** Human-facing path templates, in precedence order. */
  readonly files: readonly string[];
  readonly editHint: string;
}

export const CONFIG_PLANES: readonly ConfigPlane[] = Object.freeze([
  {
    id: 'roles',
    title: 'Role profiles (D82/D11)',
    files: ['<workspace>/.piher/roles/<name>.json', '~/.pi/agent/piher/roles/<name>.json', 'builtin src/roles/'],
    editHint: 'Add or edit a role JSON; builtin names (master/worker-default) cannot be overridden',
  },
  {
    id: 'env',
    title: 'Runtime policy env (PIHER_*)',
    files: ['process environment (per-process, no file)'],
    editHint: 'Export the variable before starting pi; it applies to new processes only',
  },
] as const);

/** Runtime policy / behaviour env knobs, derived from the `OPTION_SPECS` registry. */
const ENV_KNOBS: readonly ConfigKnob[] = OPTION_SPECS.map((option) => ({
  plane: 'env' as const,
  key: option.name,
  kind: option.min === undefined ? ('string' as const) : ('number' as const),
  defaultValue: option.min === undefined
    ? (option.fallback === '' ? undefined : option.fallback)
    : Number(option.fallback),
  min: option.min,
  impact: option.description,
}));

/** The `PIHER_*` namespace itself (any other prefix is somebody else's environment). */
const KNOB_NAME_RE = /^PIHER_[A-Z0-9_]+$/;

/** Contracts handed to a child at spawn (named in `options.ts`): the code reads them, but they are
 *  not knobs a person sets, so the catalog must not report them as removed. */
const SPAWN_CONTRACT_KEYS: readonly string[] = [
  'PIHER_SUBAGENT', 'PIHER_DELEGATION', 'PIHER_ROLE_MANIFEST', 'PIHER_ROLE_BASE',
];

/** Knobs the code reads directly instead of through `OPTION_SPECS`: neither has a policy field, a
 *  default or a bound, so the registry is not where they live. `PIHER_TUI` picks the spawn's TUI mode
 *  (`subagent-core.ts`), `PIHER_PIPE_TRACE` turns the pipe trace on (`plugins/subagent.ts`). Every
 *  name here is read by the source, and `test/config-catalog.test.ts` fails if this list falls
 *  behind the source or the source grows a read this list does not know. */
const DIRECT_READ_KEYS: readonly string[] = ['PIHER_TUI', 'PIHER_PIPE_TRACE'];

/** Every `PIHER_*` name this build reads: the option registry, the spawn contracts and the direct
 *  reads. Anything else in the environment is a knob nothing reads, which is what the check names. */
export function knownEnvKeys(): readonly string[] {
  return [...ENV_KNOBS.map((knob) => knob.key), ...SPAWN_CONTRACT_KEYS, ...DIRECT_READ_KEYS];
}

/** Every knob the catalog can resolve (roles is a per-file plane: its schema is the reference). */
export const CONFIG_KNOBS: readonly ConfigKnob[] = Object.freeze([...ENV_KNOBS]);

/** Secret-shaped KEY names (not values). Deliberately narrower than a bare `token` match so that
 *  legitimate keys are still shown verbatim. */
const SECRET_LIKE = /(api[_-]?key|apikey|authorization|bearer|access[_-]?token|client[_-]?secret|password|credential)/i;

export function formatValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

export function redactValue(key: string, value: unknown): string {
  if (SECRET_LIKE.test(key) && value !== undefined && value !== '') return '***';
  return formatValue(value);
}

export type ConfigSource = 'env' | 'default';

export interface ResolvedKnob {
  readonly knob: ConfigKnob;
  readonly value: string;
  readonly source: ConfigSource;
}

/** Resolves the env plane: only catalog keys are ever read. */
export function resolveEnvKnobs(env: Record<string, string | undefined> = {}): ResolvedKnob[] {
  return ENV_KNOBS.map((knob) => {
    // Same rule as optionValue(): an empty value counts as unset.
    const raw = env[knob.key];
    if (raw === undefined || raw === '') {
      return { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default' as const };
    }
    return { knob, value: redactValue(knob.key, raw), source: 'env' as const };
  });
}

export interface CheckReport {
  readonly plane: ConfigPlaneId;
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function checkEnvKnobs(env: Record<string, string | undefined> = {}): string[] {
  const issues: string[] = [];
  for (const knob of ENV_KNOBS) {
    if (knob.kind !== 'number') continue;
    const raw = env[knob.key];
    if (raw === undefined || raw === '') continue;
    const parsed = Number.parseInt(raw, 10);
    const min = knob.min ?? 0;
    if (!Number.isFinite(parsed) || parsed < min) {
      issues.push(`${knob.key}="${raw}" is not a valid integer >= ${min} (runtime falls back to ${formatValue(knob.defaultValue)})`);
    }
  }
  // A removed knob is the one setting the runtime cannot tell you about: nothing reads it, so the
  // value silently does nothing. Name it instead of leaving the export in place to be believed — and
  // never name a knob the code does read: the list below is the whole set (registry, spawn contracts,
  // direct reads), or this check would tell a user to unset something that works.
  const known = new Set(knownEnvKeys());
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || raw === '') continue;
    if (!KNOB_NAME_RE.test(key)) continue;
    if (known.has(key)) continue;
    issues.push(`${key}="${raw}" is set but no code reads it (a removed knob): unset it, or run \`piher config\` for the current names`);
  }
  return issues;
}

function sourceLabel(entry: ResolvedKnob): string {
  return entry.source;
}

export function summarizePlane(entries: readonly ResolvedKnob[]): string {
  const changed = entries.filter((e) => e.source !== 'default');
  if (changed.length === 0) return 'all defaults';
  const bySource = new Map<ConfigSource, number>();
  for (const e of changed) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  return `${changed.length} set (${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ')})`;
}

export function renderIndex(lines: {
  env: readonly ResolvedKnob[];
  roleSummary: string;
}): string[] {
  return [
    'piher config — 2 planes, env > default (roles are per-file)',
    `  roles       ${lines.roleSummary}`,
    `  env         ${summarizePlane(lines.env)}`,
    '  show: /piher-config show <roles|env|all>   check: /piher-config check   report: /piher-config doc',
  ];
}

export function renderPlane(entries: readonly ResolvedKnob[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const { knob } = entry;
    out.push(`  ${knob.key} = ${entry.value}  [${sourceLabel(entry)}]`);
    out.push(`      ${knob.impact}`);
  }
  return out;
}

export function renderCheck(reports: readonly CheckReport[]): string[] {
  const out: string[] = [];
  for (const report of reports) {
    out.push(`  ${report.ok ? 'ok  ' : 'FAIL'} ${report.plane}`);
    for (const issue of report.issues) out.push(`      - ${issue}`);
  }
  return out;
}

export interface ReportMeta {
  readonly generatedAt: string;
  readonly cwd: string;
  readonly workspaceTrusted: boolean;
  readonly piVersion?: string;
}

export function renderReport(entries: readonly ResolvedKnob[], meta: ReportMeta): string {
  const lines = [
    '# piher config report',
    '',
    `- generated: ${meta.generatedAt}`,
    `- cwd: ${meta.cwd}`,
    `- workspace trusted: ${meta.workspaceTrusted}`,
    ...(meta.piVersion ? [`- pi: ${meta.piVersion}`] : []),
    '',
    'Precedence: env > default.',
    '',
  ];
  const escape = (text: string): string => text.replace(/\|/g, '\\|');
  for (const plane of CONFIG_PLANES) {
    const planeEntries = entries.filter((e) => e.knob.plane === plane.id);
    lines.push(`## ${plane.id} — ${plane.title}`, '', `Files: ${plane.files.map((f) => `\`${f}\``).join(' , ')}`, '', `> ${plane.editHint}`, '');
    if (planeEntries.length === 0) {
      lines.push('(no value-carrying knobs; per-file plane)', '');
      continue;
    }
    lines.push('| key | value | source | impact |', '|---|---|---|---|');
    for (const entry of planeEntries) {
      lines.push(`| \`${entry.knob.key}\` | ${escape(entry.value)} | ${sourceLabel(entry)} | ${escape(entry.knob.impact)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
