/** Role domain: manifest validation, layered loading, composition, runtime gate and switch planning.
 * Every matrix below names its input, so a regression still points at the exact case that broke. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakePi, fire, withCleanup } from './test-utils.ts';
import { validateRoleManifest } from '../src/role-manifest.ts';
import { RESERVED_ROLE_NAMES, ROLES_DIR, listRoleNames, loadRoleConfig, roleLayers, userRolesDir, workspaceRolesDir, type LayerReader, type RoleLoaderError, type RoleReader } from '../src/role-loader.ts';
import { ManifestError, composeForRole, composeManifest, toRuntimeManifest } from '../src/manifest-compose.ts';
import { initialRoleState, latestRoleManifestRecord, manifestFromRecord, planRoleSwitch, planSwitchActiveTools, roleRecordDiffers, type RoleManifestRecord } from '../src/role-state.ts';
import { parseRuntimeManifest, planActiveTools, planToolGate, type RuntimeRoleManifest } from '../src/tool-gate.ts';
import { CATALOG_MAX_ROLES, catalogEntries, renderRoleCatalog, type CatalogEntry } from '../src/role-catalog.ts';
import { createRoleRuntime } from '../src/index-roles.ts';

/** Known-good manifest literal (independent truth: the finalized probe-role profile). */
const READONLY = {
  role: 'probe-role', version: '1.1.0', description: 'read-only worker role: research and search, no code changes',
  manifest: { tools: ['bash', 'read', 'grep', 'glob', 'web_search', 'sample_tool', 'ask_user_question'], rules: { write: 'deny', edit: 'deny', subagent: 'deny', bash: 'allow', '*': 'allow' } },
} as const;

/* ── role-manifest: file format ────────────────────────────────────── */
test('validateRoleManifest: a good profile passes and keeps every field; omitted or stale fields are tolerated', () => {
  const r = validateRoleManifest(READONLY);
  assert.equal(r.ok, true, JSON.stringify((r as { issues?: string[] }).issues));
  if (!r.ok) return;
  assert.equal(r.value.role, 'probe-role'); assert.equal(r.value.version, '1.1.0');
  assert.equal(r.value.manifest.rules?.bash, 'allow'); assert.equal(r.value.manifest.rules?.write, 'deny');

  const minimal = validateRoleManifest({ role: 'worker-default', version: '1.0.0', manifest: { tools: ['bash', 'read', 'sample_tool', 'ask_user_question'] } });
  assert.equal(minimal.ok, true, JSON.stringify((minimal as { issues?: string[] }).issues));
  for (const stance of ['allow', 'deny'] as const) {
    const s = validateRoleManifest({ ...READONLY, manifest: { ...READONLY.manifest, unknownTools: stance } });
    assert.equal(s.ok, true);
    if (s.ok) assert.equal(s.value.manifest.unknownTools, stance);
  }
  // A retired top-level block is an unknown key, not a silently tolerated one.
  assert.equal(validateRoleManifest({ ...READONLY, services: {} }).ok, false);
});

test('validateRoleManifest: rejects every contract violation with a locatable issue', () => {
  const cases: Array<{ what: string; input: unknown; expect: string }> = [
    { what: 'version not x.y.z', input: { ...READONLY, version: '1.0' }, expect: 'version' },
    { what: 'version is a number', input: { ...READONLY, version: 1 }, expect: 'version' },
    { what: 'removed roleType key', input: { ...READONLY, roleType: 'executor' }, expect: 'roleType' },
    { what: 'removed constraints key', input: { ...READONLY, manifest: { ...READONLY.manifest, constraints: {} } }, expect: 'constraints' },
    { what: 'typo in a top-level key', input: { ...READONLY, rulez: {} }, expect: 'rulez' },
    { what: 'bare model name', input: { ...READONLY, model: 'muse-spark' }, expect: 'model' },
    { what: 'multi-slash model', input: { ...READONLY, model: 'a/b/c' }, expect: 'model' },
    { what: 'non-string model', input: { ...READONLY, model: 42 }, expect: 'model' },
    { what: 'unknownTools outside allow/deny', input: { ...READONLY, manifest: { ...READONLY.manifest, unknownTools: 'maybe' } }, expect: 'unknownTools' },
    { what: 'rules value outside allow/deny', input: { ...READONLY, manifest: { ...READONLY.manifest, rules: { bash: 'maybe' } } }, expect: 'bash' },
    { what: 'rules key that is not a tool name', input: { ...READONLY, manifest: { ...READONLY.manifest, rules: { 'a b': 'allow' } } }, expect: 'a b' },
    { what: 'empty tools array', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: [] } }, expect: 'tools' },
    { what: 'thinking outside the enum', input: { ...READONLY, thinking: 'ultra' }, expect: 'thinking' },
    { what: 'lifecycle outside the enum', input: { ...READONLY, lifecycle: 'forever' }, expect: 'lifecycle' },
    { what: 'non-boolean modelInvocable', input: { ...READONLY, modelInvocable: 'yes' }, expect: 'modelInvocable' },
    { what: 'empty instructions', input: { ...READONLY, instructions: '   ' }, expect: 'instructions' },
    { what: 'duplicate tool', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: [...READONLY.manifest.tools, 'bash'] } }, expect: 'bash' },
    { what: 'non-string tool', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: ['bash', 42, 'sample_tool', 'ask_user_question'] } }, expect: 'tools' },
    { what: 'retired services block', input: { ...READONLY, services: { anything: 1 } }, expect: 'services' },
    { what: 'role name outside [a-z0-9-]+', input: { ...READONLY, role: 'Web Search' }, expect: 'role' },
  ];
  for (const { what, input, expect } of cases) {
    const result = validateRoleManifest(input);
    assert.equal(result.ok, false, `${what}: expected a rejection`);
    const issues = result.ok ? [] : result.issues;
    assert.ok(issues.some((issue) => issue.includes(expect)), `${what}: expected an issue mentioning "${expect}" (got ${issues.join(' | ')})`);
  }
});

test('validateRoleManifest: an ask rule is rejected, naming the value and the missing gate', () => {
  const result = validateRoleManifest({ ...READONLY, manifest: { ...READONLY.manifest, rules: { '*': 'ask' } } });
  assert.equal(result.ok, false, 'ask must never survive validation: nothing could ever grant it');
  if (result.ok) return;
  assert.deepEqual(result.issues, [
    'rules["*"]: "ask" is not a permission — piher ships no human-gate tool, so use "allow" or "deny"',
  ], 'one issue, on the rule that carried it, and it says why');
});

/* ── role-loader: layered lookup ───────────────────────────────────── */
const CUSTOM = {
  role: 'reviewer', version: '2.5.0', description: 'read-only review',
  manifest: { tools: ['read', 'grep', 'web_search', 'sample_tool', 'ask_user_question'], rules: { write: 'deny', edit: 'deny' } },
};

/** Windows-shaped base: layer dirs must be derived through roleLayers, never pasted in by hand. */
const WIN = 'F:\\ws';
const [wsDir, userLayerDir, builtinLayerDir] = roleLayers({ baseDir: WIN }).map((layer) => layer.dir);

/** Legacy single-reader injection (bundled-layer semantics); a string value is raw file text. */
const flatRead = (files: Record<string, unknown>): RoleReader => (name) => {
  if (!(name in files)) throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
  return typeof files[name] === 'string' ? (files[name] as string) : JSON.stringify(files[name]);
};

/** Three-layer in-memory reader, pasted onto workspace → user → bundled. */
const layerRead = (w: Record<string, unknown>, u: Record<string, unknown> = {}, b: Record<string, unknown> = {}): LayerReader => {
  const byDir: Record<string, Record<string, unknown>> = { [wsDir]: w, [userLayerDir]: u, [builtinLayerDir]: b };
  return (dir, name) => {
    const value = byDir[dir]?.[name];
    return value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
  };
};

test('loadRoleConfig: missing file, illegal names and malformed manifests are classified', () => {
  const cases: Array<{ what: string; name: string; code: string; files?: Record<string, unknown>; layers?: [Record<string, unknown>, Record<string, unknown>?, Record<string, unknown>?]; msg?: RegExp[]; issues?: RegExp[] }> = [
    { what: 'missing file', name: 'nope', files: {}, code: 'ROLE_NOT_FOUND' },
    { what: 'malformed JSON', name: 'broken', files: { 'broken.json': '{not json' }, code: 'INVALID_ROLE_CONFIG', msg: [/JSON/] },
    { what: 'contract violations', name: 'bad', files: { 'bad.json': { role: 'bad', version: '1.0', roleType: 'nope', manifest: { tools: [] } } }, code: 'INVALID_ROLE_CONFIG', issues: [/version/, /roleType/, /tools/] },
    { what: 'manifest under a different name', name: 'alpha', files: { 'alpha.json': { ...CUSTOM, role: 'beta' } }, code: 'INVALID_ROLE_CONFIG', msg: [/beta/] },
    // A hit that fails validation must fail loudly instead of falling through to a lower layer's copy.
    { what: 'invalid manifest at the hit layer', name: 'reviewer', layers: [{ 'reviewer.json': { ...CUSTOM, manifest: { tools: [] } } }, {}, { 'reviewer.json': CUSTOM }], code: 'INVALID_ROLE_CONFIG', msg: [/workspace/] },
  ];
  for (const c of cases) {
    const opts = c.layers ? { layerRead: layerRead(...c.layers), baseDir: WIN } : { read: flatRead(c.files ?? {}) };
    assert.throws(() => loadRoleConfig(c.name, opts), (e: unknown) => {
      const err = e as RoleLoaderError;
      return err.code === c.code && (c.msg ?? []).every((n) => n.test(err.message)) && (c.issues ?? []).every((n) => n.test(err.issues.join('\n')));
    }, c.what);
  }

  // An illegal name must be rejected before any disk access.
  let touched = false;
  const spy = (): string => { touched = true; throw new Error('should not read'); };
  for (const bad of ['../secret', 'a/b', 'A_B', '.hidden', '', 'café']) {
    assert.throws(() => loadRoleConfig(bad, { read: spy }), (e: unknown) => (e as RoleLoaderError).code === 'ROLE_NOT_FOUND', bad);
  }
  assert.equal(touched, false, 'an illegal name must never touch disk');
});

test('bundled manifests: loadable for both built-ins, and worker mirrors master minus the excluded families', () => {
  for (const name of ['worker-default', 'master']) {
    const role = loadRoleConfig(name);
    assert.equal(role.role, name); assert.match(role.version, /^\d+\.\d+\.\d+$/, name);
    assert.equal(role.model, undefined, `${name} leaves model routing to the process default`);
  }
  // D83 inheritance: worker-default.tools ≡ master.tools − subagent − bg-job, pinned against drift.
  const EXCLUDED = ['subagent', 'bg-job'];
  const master = loadRoleConfig('master');
  const worker = loadRoleConfig('worker-default');
  assert.deepEqual(
    [...new Set(worker.manifest.tools)].sort(),
    [...new Set(master.manifest.tools.filter((t) => !EXCLUDED.includes(t)))].sort(),
  );
  for (const family of EXCLUDED) assert.equal(worker.manifest.rules?.[family], 'deny', `${family} stays denied under unknownTools=allow`);
  // Placement of the tool families the bundled master really carries (never a fixture-only name):
  // the two herdr families, pwsh and web search must not drift out of the bundled file.
  for (const need of ['subagent', 'bg-job', 'pwsh', 'web_search']) {
    assert.ok(master.manifest.tools.includes(need), `tool placement: ${need}`);
  }
  assert.equal(master.manifest.unknownTools, 'allow'); assert.equal(worker.manifest.unknownTools, 'allow');
});

test('layers: workspace wins over user, user over absent, and a miss lists every layer tried', () => {
  const read = layerRead({ 'reviewer.json': { ...CUSTOM, description: 'from ws' } }, { 'reviewer.json': { ...CUSTOM, description: 'from user' }, 'auditor.json': { ...CUSTOM, role: 'auditor' } });
  const hit = loadRoleConfig('reviewer', { layerRead: read, baseDir: WIN });
  assert.equal(hit.description, 'from ws');
  // A hit is returned validated and verbatim: the `*`-allow default is added by composeForRole, not here.
  assert.deepEqual(hit.manifest.tools, CUSTOM.manifest.tools); assert.deepEqual(hit.manifest.rules, CUSTOM.manifest.rules);
  assert.equal(loadRoleConfig('auditor', { layerRead: read, baseDir: WIN }).description, 'read-only review');

  assert.throws(() => loadRoleConfig('ghost', { layerRead: layerRead({}), baseDir: WIN }), (e: unknown) => {
    const message = (e as Error).message;
    return (e as RoleLoaderError).code === 'ROLE_NOT_FOUND' && /workspace/.test(message) && /user/.test(message) && /builtin/.test(message);
  });

  // Layer layout: workspace → user → bundled, with the workspace one derived from the base dir.
  const WS = process.platform === 'win32' ? 'F:\\ws' : '/ws';
  assert.equal(workspaceRolesDir(WS), join(WS, '.piher', 'roles')); assert.equal(workspaceRolesDir(), join(process.cwd(), '.piher', 'roles'));
  assert.match(userRolesDir().replace(/\\/g, '/'), /\/\.pi\/agent\/piher\/roles$/);
  const layers = roleLayers({ baseDir: WS });
  assert.equal(layers.length, 3); assert.match(layers[0]!.dir.replace(/\\/g, '/'), /\.piher\/roles$/);
  assert.match(layers[2]!.dir.replace(/\\/g, '/'), /src\/roles$/);
});

test('layers: a reserved built-in name may not be overridden, and builtinDirect ignores the bait', () => {
  const read = layerRead({ 'master.json': { ...CUSTOM, role: 'master' } }, { 'worker-default.json': { ...CUSTOM, role: 'worker-default' } });
  for (const name of RESERVED_ROLE_NAMES) {
    assert.throws(() => loadRoleConfig(name, { layerRead: read, baseDir: WIN }),
      (e: unknown) => (e as RoleLoaderError).code === 'ROLE_RESERVED' && (e as Error).message.includes(name), name);
  }

  // builtinDirect is the master's self-application path: skipping the user layers keeps a workspace
  // master.json from making self-application fail open.
  const bundled: LayerReader = (dir, fileName) =>
    dir === ROLES_DIR ? (existsSync(join(dir, fileName)) ? readFileSync(join(dir, fileName), 'utf8') : null) : read(dir, fileName);
  const role = loadRoleConfig('master', { layerRead: bundled, baseDir: WIN, builtinDirect: true });
  assert.notEqual(role.version, CUSTOM.version); assert.ok(role.manifest.tools.includes('subagent'));
});

test('listRoleNames: the workspace and user layers, deduped and sorted, built-ins excluded', withCleanup(async (cleanup) => {
  const ws = cleanup.tempDir('roles-ws').path;
  const user = cleanup.tempDir('roles-user').path;
  await mkdir(join(ws, '.piher', 'roles'), { recursive: true });
  for (const name of ['reviewer', 'auditor']) await writeFile(join(ws, '.piher', 'roles', `${name}.json`), '{}');
  await writeFile(join(ws, '.piher', 'roles', 'notes.txt'), 'ignored');
  for (const name of ['auditor', 'builder']) await writeFile(join(user, `${name}.json`), '{}');
  // `auditor` appears in both layers, so it is listed once.
  assert.deepEqual(listRoleNames(ws, user), ['auditor', 'builder', 'reviewer']);
  // Missing directories contribute nothing instead of throwing.
  assert.deepEqual(listRoleNames(join(ws, 'absent'), join(user, 'absent')), []);
}));

/* ── manifest-compose ──────────────────────────────────────────────── */
test('composeManifest: union of baseline and suggestion, deterministic order, deny wins', () => {
  const union = composeManifest({ roleBaseline: ['bash', 'edit', 'write', 'sample_tool'], modelSuggested: ['read', 'grep', 'bash'], rulePermissions: { '*': 'allow' } });
  assert.deepEqual(union.tools, ['bash', 'edit', 'grep', 'read', 'sample_tool', 'write']);

  const denied = composeManifest({ roleBaseline: ['bash', 'edit', 'read', 'sample_tool'], modelSuggested: ['write', 'bash'], rulePermissions: { write: 'deny', edit: 'deny', '*': 'allow' } });
  assert.deepEqual(denied.tools, ['bash', 'read', 'sample_tool']);
  assert.deepEqual(denied.permissions, { write: 'deny', edit: 'deny', bash: 'allow', read: 'allow', sample_tool: 'allow' });

  // Rule mix (websearch shape): deny excludes, allow keeps, both stay visible in permissions.
  const mixed = composeManifest({ roleBaseline: ['bash', 'read', 'grep', 'web_search', 'sample_tool'], modelSuggested: ['bash', 'write'], rulePermissions: { bash: 'allow', write: 'deny', edit: 'deny', '*': 'allow' } });
  assert.deepEqual(mixed.tools, ['bash', 'grep', 'read', 'sample_tool', 'web_search']); assert.equal(mixed.permissions.bash, 'allow');
  assert.equal(mixed.permissions.write, 'deny');
});

test('composeManifest: `*` supplies the default, explicit rules win, deny rules survive outside the tool set', () => {
  const explicit = composeManifest({ roleBaseline: ['read', 'sample_tool'], modelSuggested: [], rulePermissions: { '*': 'allow', read: 'deny' } });
  assert.deepEqual(explicit.permissions, { read: 'deny', sample_tool: 'allow' });
  assert.deepEqual(explicit.tools, ['sample_tool']);

  const noStar = composeManifest({ roleBaseline: ['read', 'sample_tool'], modelSuggested: [], rulePermissions: { write: 'deny' } });
  assert.deepEqual(noStar.permissions, { write: 'deny', read: 'allow', sample_tool: 'allow' });

  const stance = composeManifest({ roleBaseline: ['bash', 'read', 'sample_tool'], modelSuggested: [], rulePermissions: { subagent: 'deny', terminal: 'deny', '*': 'allow' }, unknownTools: 'allow' });
  assert.equal(stance.unknownTools, 'allow'); assert.equal(stance.permissions.subagent, 'deny');
  assert.ok(!stance.tools.includes('subagent'));
});

test('composeManifest: empty result and empty baseline are loud, non-string tools are dropped', () => {
  assert.throws(() => composeManifest({ roleBaseline: ['bash'], modelSuggested: ['read'], rulePermissions: { bash: 'deny', read: 'deny', '*': 'deny' } }),
    (e: unknown) => e instanceof ManifestError && e.code === 'EMPTY_MANIFEST' && /bash/.test(e.message) && /read/.test(e.message));
  assert.throws(() => composeManifest({ roleBaseline: [], modelSuggested: ['bash'], rulePermissions: { '*': 'allow' } }),
    (e: unknown) => e instanceof ManifestError && e.code === 'INVALID_ROLE_CONFIG' && /baseline tools/.test(e.message));

  const dirty = { roleBaseline: ['read', 'sample_tool', 42 as never], modelSuggested: [], rulePermissions: {} };
  assert.deepEqual(composeManifest(dirty).tools, ['read', 'sample_tool']);
  assert.deepEqual(composeManifest(dirty), composeManifest(dirty), 'composition is deterministic');
});

test('toRuntimeManifest: one projection from a composed profile to the runtime shape', () => {
  const composed = composeForRole('master', [], { loadRoleOpts: { builtinDirect: true } });
  const runtime = toRuntimeManifest(composed);
  assert.equal(runtime.role, 'master'); assert.equal(runtime.version, composed.role.version);
  assert.deepEqual(runtime.tools, composed.manifest.tools); assert.deepEqual(runtime.permissions, composed.manifest.permissions);
  assert.equal(runtime.unknownTools, composed.manifest.unknownTools);
  assert.equal(runtime.guidelines, undefined, 'master ships no guidelines');
  assert.equal(runtime.instructions, undefined, 'master ships no instructions');
});

test('role text: guidelines and instructions both reach the runtime shape, and instructions never leaves it', () => {
  const role = {
    role: 'reviewer', version: '1.0.0', model: 'opencode-go/deepseek-v4.1-flash', thinking: 'high',
    guidelines: ['judge the change, do not edit it'],
    instructions: 'You are one-shot: your final message is the verdict.',
    manifest: { tools: ['read', 'bash'], rules: { subagent: 'deny', terminal: 'deny' }, unknownTools: 'deny' },
  };
  const ok = validateRoleManifest(role);
  assert.equal(ok.ok, true, JSON.stringify(ok.ok ? [] : ok.issues));
  const composed = composeForRole('reviewer', [], { loadRole: () => role as never });
  const runtime = toRuntimeManifest(composed);
  assert.deepEqual(runtime.guidelines, role.guidelines);
  assert.equal(runtime.instructions, role.instructions);
  // A narrow baseline with no coordination floor is now legal (P1 relaxes the old constraint).
  assert.deepEqual(runtime.tools, ['bash', 'read']);
  assert.deepEqual(parseRuntimeManifest(JSON.stringify({ ...runtime, instructions: '   ' }))?.instructions, undefined);
});

/* ── tool-gate: runtime gate and visibility ────────────────────────── */
const WORKER: RuntimeRoleManifest = { role: 'worker-readonly', version: '1.1.0', tools: ['bash', 'read', 'grep', 'web_search', 'sample_tool', 'ask_user_question'], permissions: { bash: 'deny', write: 'deny', '*': 'allow' } };
const STANCE: RuntimeRoleManifest = { role: 'worker-default', version: '1.3.0', tools: ['bash', 'read', 'sample_tool'], permissions: { subagent: 'deny', terminal: 'deny', '*': 'allow' }, unknownTools: 'allow' };

test('planToolGate: no manifest stays open; allow/deny follow the manifest and the stance', () => {
  const cases: Array<{ what: string; tool: string; manifest: RuntimeRoleManifest | null; kind: string; reason?: RegExp[] }> = [
    { what: 'no manifest stays open', tool: 'bash', manifest: null, kind: 'open' },
    { what: 'listed tool', tool: 'read', manifest: WORKER, kind: 'allow' },
    { what: 'permission deny on a listed tool', tool: 'bash', manifest: WORKER, kind: 'deny', reason: [/worker-readonly/, /bash/] },
    { what: 'permission deny on a tool pruned out of tools', tool: 'write', manifest: WORKER, kind: 'deny', reason: [/worker-readonly/, /write/] },
    { what: 'explicit deny outside the tool set', tool: 'subagent', manifest: WORKER, kind: 'deny' },
    { what: 'unknown tool under allow stance (D82)', tool: 'muse_deep_think', manifest: STANCE, kind: 'allow' },
    { what: 'listed tool under allow stance', tool: 'bash', manifest: STANCE, kind: 'allow' },
    { what: 'unknown tool under deny stance', tool: 'muse_deep_think', manifest: { ...WORKER, unknownTools: 'deny' }, kind: 'deny' },
  ];
  for (const c of cases) {
    const plan = planToolGate(c.tool, c.manifest);
    assert.equal(plan.kind, c.kind, `${c.what}: ${JSON.stringify(plan)}`);
    for (const needle of c.reason ?? []) assert.match((plan as { reason: string }).reason, needle, c.what);
  }
});

test('planActiveTools: intersects with the manifest, never clears the set, reports no-op as unchanged', () => {
  const cases: Array<{ what: string; tools: string[]; active: string[]; opts?: Parameters<typeof planActiveTools>[2]; expect: { next: string[]; changed: boolean } | null }> = [
    // A plugin that registers four web tools but is granted only web_search loses the other three.
    { what: 'prunes to the manifest', tools: ['bash', 'read', 'grep', 'web_search', 'sample_tool'], active: ['read', 'bash', 'web_search', 'source_check', 'fetch_content', 'get_search_content', 'sample_tool'], expect: { next: ['read', 'bash', 'web_search', 'sample_tool'], changed: true } },
    { what: 'no-op reports unchanged', tools: ['read', 'bash', 'sample_tool', 'grep'], active: ['read', 'bash', 'sample_tool'], expect: { next: ['read', 'bash', 'sample_tool'], changed: false } },
    { what: 'nothing would remain', tools: ['web_search'], active: ['read', 'bash', 'edit'], expect: null },
    { what: 'empty manifest tools', tools: [], active: ['read', 'bash'], expect: null },
    { what: 'empty active set', tools: ['read'], active: [], expect: null },
    // Allow stance hides only the explicit denies.
    { what: 'allow stance keeps unknown tools', tools: STANCE.tools, active: ['read', 'bash', 'subagent', 'terminal', 'muse_deep_think', 'sample_tool'], opts: { unknownTools: STANCE.unknownTools, permissions: STANCE.permissions }, expect: { next: ['read', 'bash', 'muse_deep_think', 'sample_tool'], changed: true } },
    { what: 'allow stance already satisfied', tools: ['read', 'bash'], active: ['read', 'bash', 'muse_deep_think'], opts: { unknownTools: 'allow', permissions: { '*': 'allow' } }, expect: { next: ['read', 'bash', 'muse_deep_think'], changed: false } },
    { what: 'all denied fails open', tools: ['bash'], active: ['subagent', 'terminal'], opts: { unknownTools: 'allow', permissions: { subagent: 'deny', terminal: 'deny' } }, expect: null },
  ];
  for (const c of cases) assert.deepEqual(planActiveTools(c.tools, c.active, c.opts), c.expect, c.what);
});

test('parseRuntimeManifest: malformed env is null (fail-open), garbage stance degrades to deny', () => {
  for (const raw of [undefined, '', 'not-json', 'null', '[]', '{"tools":["bash"]}', '{"role":"w"}', '{"role":1,"tools":["bash"]}', '{"role":"w","tools":"bash"}']) {
    assert.equal(parseRuntimeManifest(raw), null, JSON.stringify(raw));
  }
  const ok = parseRuntimeManifest(JSON.stringify({ role: 'worker-readonly', tools: ['bash', 'read'], permissions: { '*': 'allow' }, unknownTools: 'allow' }));
  assert.equal(ok?.role, 'worker-readonly'); assert.deepEqual(ok?.tools, ['bash', 'read']);
  assert.equal(ok?.unknownTools, 'allow');

  const garbage = parseRuntimeManifest(JSON.stringify({ role: 'w', tools: ['bash'], permissions: {}, unknownTools: 'maybe' }));
  assert.equal(garbage?.unknownTools, 'deny'); assert.equal(planToolGate('muse_deep_think', garbage).kind, 'deny');
  assert.deepEqual(parseRuntimeManifest(JSON.stringify({ role: 'w', tools: [], guidelines: [' ok ', 7, ''] }))?.guidelines, [' ok ']);
});

/* ── role-state: replay, change-only writes, switch planning ───────── */
const WORKER_STATE_MANIFEST: RuntimeRoleManifest = { role: 'worker-default', version: '1.0.0', tools: ['read', 'bash', 'grep', 'sample_tool', 'ask_user_question'], permissions: { '*': 'allow' }, unknownTools: 'deny' };

test('replay: takes the last well-formed entry and skips junk without losing the rest', () => {
  const entries = [
    { type: 'custom', customType: 'piher.role-manifest', data: { version: 1, role: 'worker-default', tools: ['read'], permissions: {}, unknownTools: 'deny' } },
    { type: 'message', role: 'user' },
    { type: 'custom', customType: 'piher.subs', data: { version: 2, subs: [] } },
    { type: 'custom', customType: 'piher.role-manifest', data: { role: 42 } }, // malformed: role is not a string
    { type: 'custom', customType: 'piher.role-manifest', data: { version: 1, role: 'reviewer', tools: ['read', 'grep'], permissions: { write: 'deny' }, unknownTools: 'allow', guidelines: ['bash is only for running tests'], origin: 'switch', switchedBy: 'p-master', ts: 123 } },
  ];
  const rec = latestRoleManifestRecord(entries);
  assert.equal(rec?.role, 'reviewer'); assert.equal(rec?.origin, 'switch');
  assert.equal(rec?.switchedBy, 'p-master'); assert.equal(rec?.ts, 123);
  assert.deepEqual(rec?.guidelines, ['bash is only for running tests']); assert.equal(latestRoleManifestRecord([entries[3], { type: 'custom', customType: 'x', data: null }]), null);
});

test('replay: malformed fields fall back to defaults and feed manifestFromRecord', () => {
  const rec = latestRoleManifestRecord([{ type: 'custom', customType: 'piher.role-manifest', data: { role: 'r', tools: ['read'], permissions: 'not-an-object', guidelines: ['ok', 7, null], unknownTools: 'weird' } }]);
  assert.ok(rec); assert.deepEqual(rec.guidelines, ['ok']);
  assert.deepEqual(rec.permissions, {}); assert.equal(rec.unknownTools, 'deny');
  const manifest = manifestFromRecord(rec);
  assert.equal(manifest.role, 'r'); assert.equal(manifest.version, undefined);
  assert.deepEqual(manifest.tools, ['read']); assert.deepEqual(manifest.guidelines, ['ok']);

  const empty = latestRoleManifestRecord([{ type: 'custom', customType: 'piher.role-manifest', data: { role: 'r', tools: ['read'], guidelines: [] } }]);
  assert.ok(empty); assert.equal(empty.guidelines, undefined);
  assert.equal(manifestFromRecord(empty).guidelines, undefined);
});

test('roleRecordDiffers: writes the anchor once, then only when role or tools changed', () => {
  const state = initialRoleState(WORKER_STATE_MANIFEST);
  const record = (over: Partial<RoleManifestRecord> = {}): RoleManifestRecord => ({ version: 1 as const, role: 'worker-default', tools: [...WORKER_STATE_MANIFEST.tools], permissions: {}, unknownTools: 'deny' as const, ...over });
  const cases: Array<[string, RoleManifestRecord | null, boolean]> = [
    ['first start must write the anchor', null, true],
    ['resume without a switch is a no-op', record(), false],
    ['role changed', record({ role: 'reviewer', tools: ['read'] }), true],
    ['a manifest evolution rewrites', record({ tools: ['read'] }), true],
  ];
  for (const [what, rec, expect] of cases) assert.equal(roleRecordDiffers(rec, state), expect, what);
  assert.equal(roleRecordDiffers(record(), initialRoleState(null)), false, 'unarmed sessions never write');
});

test('planRoleSwitch: widening is "the target adds a tool", diffs are both directions', () => {
  const cases: Array<[string, string[], string[], { widening: boolean; added: string[]; removed: string[] }]> = [
    ['widening', ['read', 'grep'], ['read', 'grep', 'bash'], { widening: true, added: ['bash'], removed: [] }],
    ['narrowing', ['read', 'bash', 'edit'], ['read', 'bash'], { widening: false, added: [], removed: ['edit'] }],
  ];
  for (const [what, from, to, expect] of cases) assert.deepEqual(planRoleSwitch(from, to), expect, what);
});

test('planSwitchActiveTools: the universe is every registered tool, so a switch can re-admit tools', () => {
  const REGISTERED = ['read', 'bash', 'edit', 'write', 'grep', 'sample_tool', 'ask_user_question', 'subagent'];
  const cases: Array<{ what: string; tools: string[]; registered: string[]; opts?: Parameters<typeof planSwitchActiveTools>[2]; expect: string[] }> = [
    // worker-default (no edit/write) pruned the active set; switching to a role that allows edit must
    // re-admit it, which intersection with the CURRENT active set could not do.
    { what: 're-admits pruned tools', tools: ['read', 'bash', 'edit', 'sample_tool', 'ask_user_question'], registered: REGISTERED, expect: ['read', 'bash', 'edit', 'sample_tool', 'ask_user_question'] },
    // Allow stance: keep every registered tool but the explicit denies.
    { what: 'allow stance keeps registered tools', tools: ['read', 'bash'], registered: ['read', 'bash', 'web_search', 'subagent', 'sample_tool'], opts: { unknownTools: 'allow', permissions: { subagent: 'deny' } }, expect: ['read', 'bash', 'web_search', 'sample_tool'] },
    // Unregistered manifest entries are ignored; an empty result is a legitimate shrink, not a no-op.
    { what: 'unregistered entries are ignored', tools: ['read', 'ghost_tool'], registered: ['read', 'bash'], expect: ['read'] },
    { what: 'all tools unknown', tools: ['nope'], registered: ['read', 'bash'], expect: [] },
  ];
  for (const c of cases) assert.deepEqual(planSwitchActiveTools(c.tools, c.registered, c.opts), c.expect, c.what);
});

test('initialRoleState: env origin with no switch trace; a bare pi session carries no manifest', () => {
  const state = initialRoleState(WORKER_STATE_MANIFEST);
  assert.equal(state.manifest?.role, 'worker-default'); assert.equal(state.origin, 'env');
  assert.equal(state.switchedBy, null); assert.equal(state.switchedAt, null);
  assert.equal(initialRoleState(null).manifest, null);
});

/* ── role catalog (S20): the spawn menu is derived from the manifests ── */
test('renderRoleCatalog: layer then name, deduped by layer, reserved and non-invocable roles absent', () => {
  const entries: CatalogEntry[] = [
    { name: 'worker', description: 'general worker', layer: 1 },
    { name: 'reviewer', description: 'user reviewer', layer: 1 },
    { name: 'reviewer', description: 'ws reviewer', layer: 0 },
    { name: 'recon', description: 'read-only scout', layer: 1 },
    { name: 'secret', description: 'internal probe', modelInvocable: false, layer: 1 },
    // Reserved names can never be spawn targets the catalog advertises (master is the caller).
    { name: 'master', description: 'the caller', layer: 0 },
    { name: 'worker-default', description: 'the default', layer: 1 },
  ];
  const lines = renderRoleCatalog(entries).split('\n');
  assert.equal(lines[0], 'Roles a `subagent` spawn can name (`role` parameter):');
  assert.deepEqual(lines.slice(1, 4), [
    '- reviewer — ws reviewer',
    '- recon — read-only scout',
    '- worker — general worker',
  ]);
  assert.equal(lines[4], '- (default) — `worker-default`, used when `role` is omitted');
  assert.equal(lines.length, 5, 'no hidden line while the catalog fits');
  const text = lines.join('\n');
  assert.doesNotMatch(text, /master/, 'reserved names never reach the menu');
  assert.doesNotMatch(text, /secret/, 'modelInvocable: false stays out of the menu');
  assert.doesNotMatch(text, /worker-default —/, 'the default appears only as the closing line');
  // A multi-line description is collapsed: the cap speaks in lines, so each role is one.
  assert.match(renderRoleCatalog([{ name: 'x', description: 'one\n  two', layer: 0 }]), /^- x — one two$/m);
  // No entries at all still teaches the default.
  assert.equal(renderRoleCatalog([]), `${lines[0]}\n${lines[4]}`);
});

test('renderRoleCatalog: past the cap it says how many roles are hidden and where to look', () => {
  const entries: CatalogEntry[] = Array.from({ length: CATALOG_MAX_ROLES + 3 }, (_, i) => ({
    name: `role-${String(i).padStart(2, '0')}`, description: `r${i}`, layer: 0,
  }));
  const lines = renderRoleCatalog(entries, { searchDirs: ['/ws/.piher/roles'] }).split('\n');
  const bullets = lines.filter((l) => l.startsWith('- ') && !l.startsWith('- (default)'));
  assert.equal(bullets.length, CATALOG_MAX_ROLES + 1, `${CATALOG_MAX_ROLES} roles plus the one truncation line`);
  assert.match(lines.at(-2)!, /… 3 more not listed here (\(\/ws\/\.piher\/roles\))/);
  assert.match(lines.at(-1)!, /^- \(default\)/);
});

test('catalogEntries: reads both spawn layers from disk, skips junk, keeps the layer index', withCleanup(async (cleanup) => {
  const ws = cleanup.tempDir('catalog-ws').path;
  const user = cleanup.tempDir('catalog-user').path;
  const wsDir = join(ws, '.piher', 'roles');
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(wsDir, 'reviewer.json'), JSON.stringify({ role: 'reviewer', version: '1.0.0', description: 'ws reviewer', manifest: { tools: ['read'] } }));
  await writeFile(join(wsDir, 'notes.txt'), 'ignored');
  await writeFile(join(wsDir, 'broken.json'), '{not json');
  for (const [name, body] of [['worker', { description: 'general worker' }], ['secret', { description: 'probe', modelInvocable: false }]] as const) {
    await writeFile(join(user, `${name}.json`), JSON.stringify(body));
  }
  const entries = catalogEntries({ baseDir: ws, userDir: user });
  assert.deepEqual(entries, [
    { name: 'reviewer', description: 'ws reviewer', layer: 0 },
    { name: 'secret', description: 'probe', modelInvocable: false, layer: 1 },
    { name: 'worker', description: 'general worker', layer: 1 },
  ]);
  // Absent directories contribute nothing instead of throwing.
  assert.deepEqual(catalogEntries({ baseDir: join(ws, 'absent'), userDir: join(user, 'absent') }), []);
}));

/** Boots the role runtime on a temp workspace+user layer pair (HOME keeps `~/.pi/agent/piher/roles` out). */
async function mountRoleRuntime(opts: { isSubagent: boolean; ws: string }) {
  const pi = fakePi();
  // The menu exists only where spawning does: the master's registered tool set.
  if (!opts.isSubagent) pi.registerTool({ name: 'subagent' } as never);
  const runtime = createRoleRuntime({
    pi: pi as never,
    roleBase: opts.ws,
    // Armed, so /piher-role and the pipe switch have something to switch away from.
    initialManifest: {
      role: 'worker', version: '1.0.0', tools: ['read'], permissions: { '*': 'allow' },
      unknownTools: 'allow',
    },
    isSubagent: opts.isSubagent,
  });
  const sections = async (): Promise<Record<string, string>> => {
    const map: Record<string, string> = {};
    await fire(pi, 'before_agent_start', { systemPromptOptions: { sections: map } });
    return map;
  };
  return { pi, runtime, sections };
}

test('role runtime: piher-roles is the derived menu, byte-identical until a switch recomputes it', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  const home = cleanup.tempDir('catalog-home').path;
  env.set('HOME', home);
  const ws = cleanup.tempDir('catalog-ws').path;
  const wsDir = join(ws, '.piher', 'roles');
  const userDir = join(home, '.pi', 'agent', 'piher', 'roles');
  await mkdir(wsDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  await writeFile(join(wsDir, 'worker.json'), JSON.stringify({ role: 'worker', version: '1.0.0', description: 'worker role', manifest: { tools: ['read'] } }));
  await writeFile(join(userDir, 'reviewer.json'), JSON.stringify({ role: 'reviewer', version: '1.0.0', description: 'static reviewer', manifest: { tools: ['read'] } }));
  await writeFile(join(userDir, 'recon.json'), JSON.stringify({ role: 'recon', version: '1.0.0', description: 'read-only scout', manifest: { tools: ['read'] } }));
  await writeFile(join(userDir, 'probe.json'), JSON.stringify({ role: 'probe', version: '1.0.0', description: 'internal', modelInvocable: false, manifest: { tools: ['read'] } }));

  const { runtime, sections } = await mountRoleRuntime({ isSubagent: false, ws });
  const first = (await sections())['piher-roles'];
  assert.ok(first, 'a spawning session gets the menu');
  assert.match(first, /^- worker — worker role$/m);
  assert.match(first, /^- reviewer — static reviewer$/m);
  assert.match(first, /^- recon — read-only scout$/m);
  assert.match(first, /^- \(default\) — `worker-default`/m);
  assert.doesNotMatch(first, /master|probe/, 'reserved and non-invocable roles stay out');
  for (const line of first.split('\n').slice(1)) assert.ok(line.length > 0);

  // The catalog is computed once per session: a second turn hands pi an identical section (no diff, no churn).
  assert.equal((await sections())['piher-roles'], first, 'byte-identical while the catalog is unchanged');
  assert.equal((await sections())['piher-roles'], first);

  // A role written mid-session appears on the next recompute — a switch, with no skill file edited.
  await writeFile(join(wsDir, 'auditor.json'), JSON.stringify({ role: 'auditor', version: '1.0.0', description: 'audits a branch', manifest: { tools: ['read'] } }));
  assert.equal((await sections())['piher-roles'], first, 'nothing recomputes without a switch');
  const switched = await runtime.applyRoleSwitch('reviewer', 'human');
  assert.equal(switched.ok, true, switched.message);
  const after = (await sections())['piher-roles'];
  assert.match(after, /^- auditor — audits a branch$/m, 'the new workspace role is now advertised');
  assert.match(after, /^- worker — worker role$/m, 'the rest of the catalog survived the recompute');
  assert.notEqual(after, first);
}));

test('role runtime: a session that cannot spawn carries no piher-roles section', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('HOME', cleanup.tempDir('catalog-home-worker').path);
  const ws = cleanup.tempDir('catalog-ws-worker').path;
  const { pi, sections } = await mountRoleRuntime({ isSubagent: true, ws });
  assert.deepEqual(await sections(), {}, 'a worker gets no menu and no invented section');

  // A section under that name from anything else is cleared, never left stale.
  const map: Record<string, string> = { 'piher-roles': 'stale menu' };
  await fire(pi, 'before_agent_start', { systemPromptOptions: { sections: map } });
  assert.equal(map['piher-roles'], undefined, 'a worker never sees a menu it cannot use');
}));
