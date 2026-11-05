/** D104 config catalog + `/piher-config` probe: the pure catalog (provenance, rendering, drift guard
 *  against the runtime env readers) and the command-side probe over injected deps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_KNOBS, CONFIG_PLANES, checkEnvKnobs, formatValue, redactValue, renderCheck,
  renderIndex, renderPlane, renderReport, resolveEnvKnobs, summarizePlane,
} from '../../src/config-catalog-core.ts';
import { OPTION_SPECS } from '../../src/options.ts';
import {
  CONFIG_GUIDANCE_PROMPT, collectConfigSnapshot, guideReportMarkdown,
  renderGuide, type ConfigGuideDeps, type ConfigGuideSnapshot,
} from '../../src/config-command.ts';
import { withCleanup, type CleanupContext } from '../test-utils.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const knobsOfPlane = (plane: string): string[] => CONFIG_KNOBS.filter((k) => k.plane === plane).map((k) => k.key);
const planeReport = (snapshot: ConfigGuideSnapshot, plane: string) => snapshot.reports.find((r) => r.plane === plane)!;

/** Effective value + source of one knob, exactly as `show` reports it. */
const knobValue = (snapshot: ConfigGuideSnapshot, plane: string, key: string): string => {
  const entry = snapshot.entries.find((e) => e.knob.plane === plane && e.knob.key === key);
  return entry ? `${entry.value} [${entry.source}]` : '(unset)';
};

/* ── drift guards ───────────────────────────────────────────────────────── */

test('drift guards: the catalog mirrors the planes and every runtime env read is registered', () => {
  // The catalog has exactly the planes the command renders: roles is per-file, env is derived.
  assert.deepEqual(CONFIG_PLANES.map((p) => p.id), ['roles', 'env']);
  assert.deepEqual(knobsOfPlane('roles'), [], 'the roles plane is per-file: its schema is the reference');
  assert.deepEqual(knobsOfPlane('env'), OPTION_SPECS.map((o) => o.name), 'the env plane is the OPTION_SPECS registry');

  // Runtime env reads must be registered as an option.
  const sources = ['src/runtime-policy.ts', 'src/terminal-core.ts', 'src/config-command.ts']
    .map((rel) => readFileSync(join(repoRoot, 'packages', 'ext', rel), 'utf8'))
    .join('\n');
  const found = new Set((sources.match(/\bPI(_HERDR)?_[A-Z0-9_]+\b/g) ?? []).filter((n) => !n.endsWith('_')));
  // Internal/pi-owned names that are not user configuration.
  const allowlist = new Set(['PIHER_ROLE_MANIFEST', 'PIHER_SUBAGENT', 'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_CODING_AGENT_DIR']);
  const registered = new Set(OPTION_SPECS.map((o) => o.name));
  for (const name of found) {
    if (!allowlist.has(name)) assert.equal(registered.has(name), true, `env var ${name} is read by the runtime but missing from the registry`);
  }
});

/* ── pure catalog ───────────────────────────────────────────────────────── */

test('resolveEnvKnobs and checkEnvKnobs only touch registered option keys', () => {
  const env = { PIHER_GC_TICK_MS: '5000', PIHER_TERM_IDLE_MS: '0', PIHER_SESSION_TTL_SECONDS: 'nope', SECRET_TOKEN: 'x' };
  const resolved = resolveEnvKnobs(env);
  assert.equal(resolved.length, OPTION_SPECS.length);
  const idle = resolved.find((r) => r.knob.key === 'PIHER_TERM_IDLE_MS')!;
  assert.equal(idle.value, '0'); assert.equal(idle.source, 'env');
  assert.equal(resolved.find((r) => r.knob.key === 'PIHER_GC_TICK_MS')!.source, 'env');
  assert.equal(resolved.some((r) => r.knob.key === 'SECRET_TOKEN'), false, 'unknown env keys are never reported');
});

test('checkEnvKnobs flags only unparsable/out-of-range registered values', () => {
  const issues = checkEnvKnobs({ PIHER_GC_TICK_MS: '30000', PIHER_SESSION_TTL_SECONDS: 'nope', PIHER_TERM_IDLE_MS: '0' });
  assert.equal(issues.length, 2, issues.join(' | ')); assert.ok(issues.some((i) => i.includes('PIHER_SESSION_TTL_SECONDS')));
  assert.ok(issues.some((i) => i.includes('PIHER_TERM_IDLE_MS'))); assert.deepEqual(checkEnvKnobs({ PIHER_GC_TICK_MS: '30000' }), []);
});

test('secret-shaped keys are redacted and never rendered verbatim', () => {
  // Deliberately narrower than a bare `token` match, so a key that merely carries token-shaped
  // vocabulary is still shown verbatim.
  assert.equal(redactValue('PIHER_TERM_READ_MAX', 8000), '8000'); assert.equal(redactValue('PIHER_TRACE', '/tmp/x'), '/tmp/x');
  assert.equal(redactValue('PIHER_API_KEY', 'sk-live-123'), '***'); assert.equal(formatValue(undefined), '(unset)');

  const entries = [{ knob: { plane: 'env' as const, key: 'PIHER_API_KEY', kind: 'string' as const, impact: 'api key' }, value: '***', source: 'env' as const }];
  const report = renderReport(entries, { generatedAt: 'now', cwd: '/w', workspaceTrusted: true });
  assert.match(report, /# piher config report/); assert.match(report, /Precedence: env > default\./); assert.ok(!report.includes('sk-live'), 'the key never reaches the report');
});

test('renderers cover the two planes and stay compact', () => {
  const resolved = resolveEnvKnobs({ PIHER_GC_TICK_MS: '5000' });
  const index = renderIndex({ env: resolved, roleSummary: '2 role(s)' });
  assert.match(index[0]!, /2 planes/); assert.ok(index.length <= 6, 'index stays a short summary');
  assert.ok(index.some((l) => l.includes('1 set (env 1)')));

  assert.ok(renderPlane(resolved).some((l) => l.includes('PIHER_GC_TICK_MS = 5000  [env]'))); assert.deepEqual(renderPlane([]), []);
  assert.equal(summarizePlane([]), 'all defaults'); assert.equal(summarizePlane([{ knob: CONFIG_KNOBS[0]!, value: 'true', source: 'env' }]), '1 set (env 1)');

  const check = renderCheck([{ plane: 'env', ok: false, issues: ['bad value'] }, { plane: 'roles', ok: true, issues: [] }]);
  assert.ok(check.some((l) => l.includes('FAIL env'))); assert.ok(check.some((l) => l.includes('- bad value'))); assert.ok(check.some((l) => l.includes('ok   roles')));
});

/* ── command-side probe ─────────────────────────────────────────────────── */

interface Fixture {
  base: string; deps: ConfigGuideDeps;
  paths: { cwd: string; rolesDir: string };
}

function makeFixture(cleanup: CleanupContext, opts: { brokenRole?: boolean; reservedRole?: boolean } = {}): Fixture {
  const base = cleanup.tempDir('cfg-guide').path;
  const cwd = join(base, 'repo');
  const rolesDir = join(cwd, '.piher', 'roles');
  const userRolesDir = join(base, 'user-roles');
  for (const dir of [userRolesDir, rolesDir, join(cwd, '.pi')]) mkdirSync(dir, { recursive: true });

  const role = (name: string, version: string) => JSON.stringify({ role: name, version, manifest: { tools: ['read', 'web_search'], rules: {}, unknownTools: 'allow' } });
  const files: Array<[string, string]> = [
    [join(rolesDir, 'auditor.json'), role('auditor', '1.0.0')],
    ...(opts.brokenRole ? [[join(rolesDir, 'broken.json'), JSON.stringify({ role: 'broken' })]] as Array<[string, string]> : []),
    ...(opts.reservedRole ? [[join(rolesDir, 'master.json'), role('master', '9.9.9')]] as Array<[string, string]> : []),
  ];
  for (const [path, content] of files) writeFileSync(path, content);

  return {
    base,
    paths: { cwd, rolesDir },
    deps: { rolesUserDir: userRolesDir, cwd, env: {} },
  };
}

test('collectConfigSnapshot: reports effective env values, sources and per-plane checks', withCleanup((cleanup) => {
  const fx = makeFixture(cleanup);
  const snapshot = collectConfigSnapshot({ ...fx.deps, env: { PIHER_GC_TICK_MS: '5000' } });

  assert.equal(knobValue(snapshot, 'env', 'PIHER_GC_TICK_MS'), '5000 [env]');
  assert.equal(knobValue(snapshot, 'env', 'PIHER_SUBAGENT_TIMEOUT_MS'), '600000 [default]');
  for (const plane of ['roles', 'env'] as const) assert.equal(planeReport(snapshot, plane).ok, true, planeReport(snapshot, plane).issues.join(' | '));
  assert.equal(snapshot.roleSummary, '3 role(s): workspace 1 / user 0 / builtin 2');

  assert.ok(renderGuide(snapshot, 'index').some((l) => l.includes('/piher-config show')));
  const roleLines = renderGuide(snapshot, 'roles');
  assert.ok(roleLines.some((l) => l.includes(fx.paths.rolesDir) && l.includes('present')), 'the plane names its source file');
  assert.ok(roleLines.some((l) => l.includes('per-file plane')));
  assert.ok(renderGuide(snapshot, 'env').some((l) => l.includes('PIHER_GC_TICK_MS')));
  assert.ok(renderGuide(snapshot, 'check').some((l) => l.includes('all planes look consistent')));

  const report = guideReportMarkdown(snapshot, { generatedAt: '2026-09-13T00:00:00Z', cwd: fx.paths.cwd, piVersion: 'test' });
  assert.match(report, /# piher config report/); assert.match(report, /## Files observed/);
  assert.match(report, new RegExp(fx.paths.rolesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}));

interface ProbeCase {
  name: string; fixture?: { brokenRole?: boolean; reservedRole?: boolean };
  setup?: (fx: Fixture) => void; deps?: (fx: Fixture) => ConfigGuideDeps;
  /** [plane, issue substring, plane stays ok?] */
  expect: Array<[string, string, boolean?]>; extra?: (snapshot: ConfigGuideSnapshot, fx: Fixture) => void;
}

const PROBE_CASES: ProbeCase[] = [
  { name: 'invalid and reserved roles are flagged', fixture: { brokenRole: true, reservedRole: true }, expect: [['roles', 'broken'], ['roles', 'master']] },
  { name: 'an out-of-range env value is reported on the env plane', deps: (fx) => ({ ...fx.deps, env: { PIHER_GC_TICK_MS: 'nope' } }), expect: [['env', 'PIHER_GC_TICK_MS']],
    extra: (s) => assert.ok(renderGuide(s, 'all').length > 3, 'a failing plane must not break rendering') },
];

test('collectConfigSnapshot: every degraded input is reported on its plane', async (t) => {
  for (const c of PROBE_CASES) {
    await t.test(c.name, withCleanup((cleanup) => {
      const fx = makeFixture(cleanup, c.fixture ?? {});
      c.setup?.(fx);
      const snapshot = collectConfigSnapshot(c.deps?.(fx) ?? fx.deps);
      for (const [plane, substring, planeOk] of c.expect) {
        const report = planeReport(snapshot, plane);
        if (planeOk !== true) assert.equal(report.ok, false, `${plane}: ${report.issues.join(' | ')}`);
        assert.ok(report.issues.some((i) => i.includes(substring)), `${plane}: ${substring} (${report.issues.join('; ')})`);
      }
      c.extra?.(snapshot, fx);
    }));
  }
});

test('the guidance prompt stays stable', () => {
  assert.match(CONFIG_GUIDANCE_PROMPT, /^\[PIHER-CONFIG\]/); assert.match(CONFIG_GUIDANCE_PROMPT, /\/piher-config show all/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /Forbidden: dumping `process\.env`/); assert.match(CONFIG_GUIDANCE_PROMPT, /Change ONE plane at a time/);
});
