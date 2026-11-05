/**
 * D104 `/piher-config`: probes the configuration planes (real files + process env), renders
 * `show|check|doc|doctor`, and registers the command.
 *
 * Read-only by design: effective values are reported with their provenance and the actual edit goes
 * to the agent under the write-lock + diff-confirmation flow; only the opt-in `doc` report writes a
 * file. Fail-open: every read is wrapped, so a broken plane degrades to a reported issue instead of
 * throwing into pi's command pipeline. All paths are injectable, so tests never touch a real home dir.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { VERSION as piVersion, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  CONFIG_PLANES,
  checkEnvKnobs,
  renderCheck,
  renderIndex,
  renderPlane,
  renderReport,
  resolveEnvKnobs,
  type CheckReport,
  type ConfigPlaneId,
  type ResolvedKnob,
} from './config-catalog-core.ts';
import { RESERVED_ROLE_NAMES, listRoleNames, loadRoleConfig, roleLayers } from './role-loader.ts';
import { formatOptionRows } from './options.ts';
import { formatSwallowedErrors } from './swallow.ts';
import { CORE_VERSION_PINNED } from './core-client.ts';

export const CONFIG_GUIDANCE_PROMPT = [
  '[PIHER-CONFIG] The user wants to inspect or change piher configuration. Follow this workflow strictly:',
  '',
  '1. Ground yourself first: run `/piher-config show all` (or read the files) and use the reported EFFECTIVE VALUE and SOURCE',
  '   (env > default). Only entries whose source is `default` are worth changing.',
  '2. Route by plane:',
  '   - roles: read `docs/sidebar-role-config.md` and `schemas/role-manifest.schema.json`; builtin role names cannot be overridden.',
  '   - env (PIHER_* / PIHER_*): affects new processes only; state that explicitly.',
  '   - pi model, thinking and compaction settings belong to pi itself: send the user to `/settings`, not to a piher file.',
  '3. Explain before changing: 2-3 sentences on what the knob controls, its cost/benefit (tokens, latency, safety, blast radius),',
  '   and 2-3 recommended values for common scenarios. Then ask what the user actually wants to achieve.',
  '4. Before writing: show a precise diff (file path, current -> proposed value) and the activation path',
  '   (hot / needs `/reload` / needs a new session or process restart). Wait for explicit confirmation. Change ONE plane at a time.',
  '5. Apply with the normal `edit`/`write` tools (write locks apply), then run `/piher-config check` and report the result back.',
  '6. If a change cannot take effect in the current process, say so and tell the user exactly what to restart.',
  '',
  'Forbidden: dumping `process.env`; writing secrets or tokens into any config file; editing multiple planes before confirmation;',
  'touching `.piher/` of an untrusted project.',
].join('\n');

export interface ConfigPlaneFile {
  readonly path: string;
  readonly label: string;
  readonly exists: boolean;
  readonly ignored?: boolean;
}

export interface ConfigGuideDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  isProjectTrusted?: boolean;
  /** User-level roles dir override (defaults to ~/.pi/agent/piher/roles). */
  rolesUserDir?: string;
}

export interface ConfigGuideSnapshot {
  readonly entries: readonly ResolvedKnob[];
  readonly reports: readonly CheckReport[];
  readonly files: Readonly<Record<ConfigPlaneId, readonly ConfigPlaneFile[]>>;
  readonly workspaceTrusted: boolean;
  readonly roleSummary: string;
}


function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export function collectConfigSnapshot(deps: ConfigGuideDeps = {}): ConfigGuideSnapshot {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const workspaceTrusted = deps.isProjectTrusted ?? false;

  const reports: CheckReport[] = [];
  const files: Record<ConfigPlaneId, ConfigPlaneFile[]> = { roles: [], env: [] };

  const envIssues = checkEnvKnobs(env);
  files.env.push({ path: '(process environment)', label: 'env', exists: true });

  /* roles: every layer's JSON must load; builtin names are intentionally shadow-proof */
  const roleIssues: string[] = [];
  const roleNames = new Set<string>();
  const layerCounts: string[] = [];
  for (const layer of roleLayers({ baseDir: cwd, userDir: deps.rolesUserDir })) {
    const names = listJsonFiles(layer.dir);
    const label: ConfigPlaneFile['label'] = layer.label.startsWith('workspace')
      ? 'workspace'
      : layer.label.startsWith('user') ? 'user' : 'builtin';
    files.roles.push({ path: layer.dir, label, exists: names.length > 0 });
    layerCounts.push(`${label} ${names.length}`);
    for (const file of names) roleNames.add(file.replace(/\.json$/, ''));
  }
  for (const name of [...roleNames].sort()) {
    try {
      loadRoleConfig(name, { baseDir: cwd });
    } catch (err) {
      const issues = (err as { issues?: readonly string[] }).issues ?? [];
      roleIssues.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}${issues.length ? ` — ${issues.join('; ')}` : ''}`);
    }
  }
  const shadowed = listRoleNames(cwd, deps.rolesUserDir).filter((name) => RESERVED_ROLE_NAMES.includes(name));
  if (shadowed.length > 0) {
    roleIssues.push(`reserved role name(s) shadowed in a custom layer (ignored for built-ins): ${shadowed.join(', ')}`);
  }
  const roleSummary = `${roleNames.size} role(s): ${layerCounts.join(' / ')}`;


  reports.push(
    { plane: 'roles', ok: roleIssues.length === 0, issues: roleIssues },
    { plane: 'env', ok: envIssues.length === 0, issues: envIssues },
  );
  return { entries: resolveEnvKnobs(env), reports, files, workspaceTrusted, roleSummary };
}


export type GuideView = 'index' | 'check' | ConfigPlaneId | 'all';

/** Renders one `/piher-config` view: the plane index, one/all plane listings, or the check report. */
export function renderGuide(snapshot: ConfigGuideSnapshot, view: GuideView): string[] {
  if (view === 'index') {
    const plane = (id: ConfigPlaneId): readonly ResolvedKnob[] => snapshot.entries.filter((e) => e.knob.plane === id);
    return renderIndex({
      env: plane('env'),
      roleSummary: snapshot.roleSummary,
    });
  }
  if (view === 'check') {
    const anyFail = snapshot.reports.some((r) => !r.ok);
    return [
      ...renderCheck(snapshot.reports),
      anyFail ? '  → fix the FAIL planes above (values are still shown by `show`)' : '  → all planes look consistent',
    ];
  }

  const out: string[] = [];
  for (const meta of CONFIG_PLANES) {
    if (view !== 'all' && meta.id !== view) continue;
    out.push(`${meta.id} — ${meta.title}`);
    for (const file of snapshot.files[meta.id]) {
      const status = file.exists ? (file.ignored ? 'present (IGNORED: untrusted project)' : 'present') : 'absent';
      out.push(`  file [${file.label}] ${file.path} — ${status}`);
    }
    out.push(`  hint: ${meta.editHint}`);
    const entries = snapshot.entries.filter((e) => e.knob.plane === meta.id);
    if (entries.length > 0) {
      out.push(...renderPlane(entries));
    } else {
      const report = snapshot.reports.find((r) => r.plane === meta.id);
      out.push(`  (per-file plane: ${!report ? 'no data' : report.ok ? 'no issues' : `${report.issues.length} issue(s) — see /piher-config check`})`);
    }
    out.push('');
  }
  return out;
}

export function guideReportMarkdown(
  snapshot: ConfigGuideSnapshot,
  meta: { generatedAt: string; cwd: string; piVersion?: string },
): string {
  const body = renderReport(snapshot.entries, {
    generatedAt: meta.generatedAt,
    cwd: meta.cwd,
    workspaceTrusted: snapshot.workspaceTrusted,
    piVersion: meta.piVersion,
  });
  const filesSection = ['', '## Files observed', ''];
  for (const plane of CONFIG_PLANES) {
    for (const file of snapshot.files[plane.id]) {
      const status = file.exists ? (file.ignored ? 'present, ignored (untrusted project)' : 'present') : 'absent';
      filesSection.push(`- [${plane.id}] ${file.label}: \`${file.path}\` — ${status}`);
    }
  }
  const checkSection = ['', '## Checks', '', ...renderGuide(snapshot, 'check').map((l) => `- ${l.trim()}`)];
  return `${body}\n${filesSection.join('\n')}\n${checkSection.join('\n')}\n`;
}

export interface ConfigCommandDeps {
  pi: ExtensionAPI;
  /** Injectable for tests; defaults to collectConfigSnapshot. */
  collect?: (deps: ConfigGuideDeps) => ConfigGuideSnapshot;
  /** Overridable so tests can pin the report destination. */
  reportDir?: (cwd: string) => string;
}

const PLANE_IDS: readonly ConfigPlaneId[] = CONFIG_PLANES.map((p) => p.id);
const SUBCOMMANDS = ['show', 'check', 'doc', 'doctor'] as const;

function parseArgs(args: unknown): { sub: (typeof SUBCOMMANDS)[number] | 'index'; rest: string } {
  const raw = typeof args === 'string'
    ? args.split(/\s+/).filter(Boolean)
    : Array.isArray(args) ? args.map(String) : [];
  const [first, ...rest] = raw;
  const sub = (SUBCOMMANDS as readonly string[]).includes(first ?? '')
    ? (first as (typeof SUBCOMMANDS)[number])
    : 'index';
  // `show` accepts an optional plane; an unknown first token is treated as the plane selector for `show`.
  const restJoined = sub === 'index' && first && first !== 'index' ? [first, ...rest].join(' ') : rest.join(' ');
  return { sub, rest: restJoined };
}

/** Registers `/piher-config`. Safe to call once per extension load (pi replaces commands by name). */
export function installConfigCommand(deps: ConfigCommandDeps): void {
  const { pi } = deps;
  const collect = deps.collect ?? collectConfigSnapshot;
  const reportDir = deps.reportDir ?? ((cwd: string) => join(cwd, '.piher'));

  pi.registerCommand('piher-config', {
    description:
      'Show piher configuration (2 planes: roles, env) with effective values and sources; `check` validates them; `doctor` lists option values and swallowed errors; no argument hands a guided change to the agent',
    getArgumentCompletions: (prefix: string) => {
      const tokens = (prefix ?? '').split(/\s+/);
      const head = tokens[0] ?? '';
      if (tokens.length <= 1) {
        return ['show', 'check', 'doc', 'doctor', 'all', ...PLANE_IDS]
          .filter((c) => c.startsWith(head))
          .map((c) => ({ value: c, label: c, description: c === 'doc' ? 'write a config report file' : undefined }));
      }
      if (head === 'show') {
        const last = tokens[tokens.length - 1] ?? '';
        return ['all', ...PLANE_IDS].filter((c) => c.startsWith(last)).map((c) => ({ value: c, label: c }));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;
      const emit = (text: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
        if (ui?.notify) ui.notify(text, level);
        else console.log(text); // print/json and test modes have no UI surface
      };

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const isProjectTrusted =
        typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === 'function'
          ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
          : false;

      let snapshot: ConfigGuideSnapshot;
      try {
        snapshot = collect({ cwd, isProjectTrusted });
      } catch (err) {
        emit(`piher-config: failed to read configuration (${err instanceof Error ? err.message : String(err)})`, 'error');
        return;
      }

      const { sub, rest } = parseArgs(args);

      if (sub === 'check') {
        emit([`piher config check (workspace trusted: ${snapshot.workspaceTrusted})`, ...renderGuide(snapshot, 'check')].join('\n'));
        return;
      }

      if (sub === 'doc') {
        const target = rest ? (isAbsolute(rest) ? rest : resolve(cwd, rest)) : join(reportDir(cwd), 'config-report.md');
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            guideReportMarkdown(snapshot, { generatedAt: new Date().toISOString(), cwd, piVersion }),
            'utf8',
          );
          emit(
            `piher config report written: ${target}`
              + (rest ? '' : '  (add `.piher/config-report.md` to .gitignore if you do not want it tracked)'),
          );
        } catch (err) {
          emit(`piher-config: could not write report (${err instanceof Error ? err.message : String(err)})`, 'error');
        }
        return;
      }

      if (sub === 'doctor') {
        // B9/B10: one place for every piher option (canonical name, effective value, source) and the
        // errors deliberately swallowed this session — otherwise a failing best-effort path stays invisible.
        emit([
          'piher doctor',
          '',
          `wire: herdr-core ${CORE_VERSION_PINNED} (pinned by test/fixtures/hc-contract.json)`,
          '',
          'options (PIHER_*):',
          ...formatOptionRows(),
          '',
          formatSwallowedErrors(),
        ].join('\n'));
        return;
      }

      if (sub === 'show') {
        const plane = rest.trim();
        const selector = plane === '' || plane === 'all' ? 'all' : PLANE_IDS.find((id) => id === plane);
        if (!selector) {
          emit(`piher-config: unknown plane "${plane}" — expected one of ${PLANE_IDS.join(', ')} or all`, 'warning');
          return;
        }
        emit(renderGuide(snapshot, selector).join('\n'));
        return;
      }

      emit([...renderGuide(snapshot, 'index'), '', 'asking the agent to guide the change...'].join('\n'));
      try {
        // Call on the receiver: the ExtensionAPI method must not be detached from `pi`.
        (pi as { sendMessage?: (msg: unknown, opts: unknown) => void }).sendMessage?.(
          { customType: 'piher.config-guide', content: CONFIG_GUIDANCE_PROMPT, display: false },
          { triggerTurn: true },
        );
      } catch (err) {
        emit(`piher-config: could not start the guided flow (${err instanceof Error ? err.message : String(err)})`, 'warning');
      }
    },
  });
}
