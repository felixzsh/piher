/**
 * Every field is fed by the `OPTION_SPECS` registry, so the numbers cannot drift from
 * `/piher-config doctor`; an out-of-range value warns and falls back to the registry default.
 */
import { OPTION_SPECS, optionValue, type PolicyField } from './options.ts';

export interface RuntimePolicy {
  readonly subagentTimeoutMs: number
  readonly gcTickMs: number
  readonly sessionTtlSeconds: number
  readonly gitTimeoutMs: number
  /** Subagent pane pipe readiness wait */
  readonly readinessTimeoutMs: number
  /** How long `send` waits for the worker to read the steering command it wrote (spec S15) */
  readonly commandPickupMs: number
}

function policyValue(field: PolicyField): number {
  const spec = OPTION_SPECS.find((o) => o.policy === field);
  if (!spec) throw new Error(`no OPTION_SPECS entry feeds RuntimePolicy.${field}`);
  const fallback = Number(spec.fallback);
  const raw = optionValue(spec.name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < (spec.min ?? 0)) {
    console.warn(`Invalid ${spec.name}="${raw}", using default ${spec.fallback}`);
    return fallback;
  }
  return parsed;
}

export function createRuntimePolicy(overrides?: Partial<RuntimePolicy>): RuntimePolicy {
  const policy = {} as { -readonly [K in keyof RuntimePolicy]: number };
  for (const spec of OPTION_SPECS) {
    if (spec.policy) policy[spec.policy] = policyValue(spec.policy);
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'number') policy[key as keyof RuntimePolicy] = value;
  }
  return policy;
}

/** Singleton for production; tests inject via createRuntimePolicy(). */
export const runtimePolicy = createRuntimePolicy()
