/**
 * Environment options. `PIHER_*` is the one namespace for *piher options* (timeouts,
 * windows, toggles), and this file is their single registry.
 *
 * `PIHER_SUBAGENT`, `PIHER_DELEGATION`, `PIHER_ROLE_MANIFEST` and `PIHER_ROLE_BASE` are not
 * listed here: they are *contracts* handed to the child process at spawn, not knobs a user sets.
 *
 * `optionValue()` is the single reader; this registry is also the single source of the numeric
 * bounds/defaults behind `runtimePolicy` (runtime-policy.ts) and the `/piher-config` catalog
 * (config-catalog-core.ts), so a knob cannot mean three different things.
 */

/** RuntimePolicy field fed by an integer option (see runtime-policy.ts). */
export type PolicyField =
  | 'subagentTimeoutMs'
  | 'gcTickMs'
  | 'pollIntervalMs'
  | 'settleWindowMs'
  | 'sessionTtlSeconds'
  | 'gitTimeoutMs'
  | 'readinessTimeoutMs';

export interface OptionSpec {
  readonly name: string;
  /** Default when the variable is unset (or empty). */
  readonly fallback: string;
  readonly description: string;
  /** Integer option: smallest value the readers accept (omitted for string/enum options). */
  readonly min?: number;
  /** Integer option read into `RuntimePolicy`. */
  readonly policy?: PolicyField;
}

/** Every option, with its default and bounds. */
export const OPTION_SPECS: readonly OptionSpec[] = [
  { name: 'PIHER_GIT_TIMEOUT_MS', fallback: '10000', min: 1, policy: 'gitTimeoutMs', description: 'git command timeout (worktree list and status probes)' },
  { name: 'PIHER_SUBAGENT_TIMEOUT_MS', fallback: '300000', min: 1000, policy: 'subagentTimeoutMs', description: 'how long a subagent may stay silent before the master is told it never reported' },
  { name: 'PIHER_READY_TIMEOUT_MS', fallback: '90000', min: 1000, policy: 'readinessTimeoutMs', description: 'how long to wait for a spawned pane to open its pipe (a dead pane fails fast)' },
  { name: 'PIHER_SETTLE_WINDOW_MS', fallback: '4000', min: 0, policy: 'settleWindowMs', description: 'debounce after a subagent turn ends before it is called settled (a new turn cancels it)' },
  { name: 'PIHER_POLL_INTERVAL_MS', fallback: '30000', min: 1000, policy: 'pollIntervalMs', description: 'safety re-check of a subagent when no core event arrives (events drive settlement)' },
  { name: 'PIHER_GC_TICK_MS', fallback: '30000', min: 1000, policy: 'gcTickMs', description: 'idle GC sweep cadence (panes)' },
  { name: 'PIHER_SESSION_TTL_SECONDS', fallback: '600', min: 0, policy: 'sessionTtlSeconds', description: 'session retention after a subagent exits, before GC' },
  { name: 'PIHER_WRITE_LOCK', fallback: '', description: '1 makes a conflicting write/edit block instead of warn (read by the lock layer)' },
  { name: 'PIHER_JOBS_DIR', fallback: '(system temp)/piher-jobs', description: 'directory receiving one log file per background job' },
  { name: 'PIHER_HMR', fallback: '', description: 'dev: enable the cordis HMR boundary (requires --expose-internals)' },
];

/** A knob's effective value, or undefined when it is unset (an empty string counts as unset). */
export function optionValue(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

export function optionRows(env: NodeJS.ProcessEnv = process.env): Array<{
  name: string;
  value: string;
  source: 'env' | 'default';
  description: string;
}> {
  return OPTION_SPECS.map((spec) => {
    const value = optionValue(spec.name, env);
    return {
      name: spec.name,
      value: value ?? spec.fallback,
      source: value === undefined ? 'default' : 'env',
      description: spec.description,
    } as const;
  });
}

/** `/piher-config doctor` table, one line per option: `NAME = value (source) — description`. */
export function formatOptionRows(env: NodeJS.ProcessEnv = process.env): string[] {
  return optionRows(env).map((row) =>
    `  ${row.name} = ${row.value}  (${row.source})  — ${row.description}`);
}
