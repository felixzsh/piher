/**
 * Closed set of cordis services this process provides on the root.
 *
 * `ctx.get`/`ctx.provide` also accept an arbitrary string and return `any`, so a raw call plus `as`
 * neither rejects a mistyped key nor a dropped bag field (fe99252). Mounts and plugins go through
 * the helpers below. Instances stay on the root: a plugin-fiber Service would unload them on HMR.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DisposeLedger } from './ledger.ts';
import type { PiSurface } from './pi-surface.ts';
import type { BgJobDeps } from './plugins/bg-job.ts';
import type { SubagentDeps } from './plugins/subagent.ts';

export interface PiherCordisServices {
  'piher.ledger': DisposeLedger;
  'piher.surface': PiSurface<object>;
  'piher.bg-job-deps': BgJobDeps;
  'piher.subagent-deps': SubagentDeps;
}

declare module '@deepseek-ai/cordis' {
  interface Context extends PiherCordisServices {}
}

export function cordisProvide<K extends keyof PiherCordisServices>(
  ctx: Context,
  key: K,
  value: PiherCordisServices[K],
): void {
  ctx.provide(key, value);
}

/** Throws when the root has not provided `key`. `ctx.get` itself returns `T | undefined`. */
export function cordisGet<K extends keyof PiherCordisServices>(ctx: Context, key: K): PiherCordisServices[K] {
  const value = ctx.get(key) as PiherCordisServices[K] | undefined;
  if (value === undefined) throw new Error(`[piher] cordis service missing: ${key}`);
  return value;
}
