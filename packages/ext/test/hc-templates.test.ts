/** hc-templates: the role manifest is the source of truth, the template is the derived artifact. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hcTemplatesDir, mergeHcTemplate, planHcTemplate, planHcTemplates, templateCommand } from '../src/hc-templates.ts';
import type { RoleManifest } from '../src/role-manifest.ts';

function manifest(overrides: Partial<RoleManifest> = {}): RoleManifest {
  return {
    role: 'reviewer',
    version: '1.0.0',
    description: 'Static reviewer of a bounded change',
    model: 'acme/fast-model',
    thinking: 'high',
    manifest: { tools: ['read', 'bash', 'ffgrep'], rules: { subagent: 'deny' }, unknownTools: 'deny' },
    guidelines: ['Judge the change against its criteria.', 'Do not edit.'],
    ...overrides,
  };
}

test('the templates directory is where core looks for templates', () => {
  assert.equal(hcTemplatesDir('/home/x'), '/home/x/.config/herdr-core/templates');
});

test('the command carries the model, the thinking level and the tool set', () => {
  assert.equal(templateCommand(manifest()), 'pi --model acme/fast-model --thinking high --tools read,bash,ffgrep');
  // A wildcard is not a tool name: the manifest covers unknown tools through `unknownTools`.
  assert.equal(
    templateCommand(manifest({ thinking: undefined, manifest: { tools: ['read', '*'] } })),
    'pi --model acme/fast-model --tools read',
  );
});

test('a template is frontmatter plus the standing instructions', () => {
  const plan = planHcTemplate(manifest());
  assert.ok(plan);
  assert.equal(plan.name, 'reviewer');
  assert.equal(plan.fileName, 'reviewer.md');
  assert.match(plan.markdown, /^---\nname: reviewer\ndescription: Static reviewer of a bounded change\ncommand: pi --model acme\/fast-model --thinking high --tools read,bash,ffgrep\n---\n/);
  assert.match(plan.markdown, /# reviewer/);
  assert.match(plan.markdown, /- Judge the change against its criteria\./);
  assert.match(plan.markdown, /- Do not edit\./);
});

test('instructions are carried verbatim, after the guidelines', () => {
  const plan = planHcTemplate(manifest({ instructions: 'Read these skills first:\n- /a/SKILL.md' }));
  assert.ok(plan);
  const guidelines = plan.markdown.indexOf('- Judge the change');
  const instructions = plan.markdown.indexOf('Read these skills first:');
  assert.ok(guidelines > 0 && instructions > guidelines);
});

test('a one-line description survives a multi-line one', () => {
  const plan = planHcTemplate(manifest({ description: 'Two\nlines   here' }));
  assert.ok(plan);
  assert.match(plan.markdown, /^description: Two lines here$/m);
});

test('the harness roles and hidden roles are not launched by name', () => {
  assert.equal(planHcTemplate(manifest({ role: 'master' })), null);
  assert.equal(planHcTemplate(manifest({ role: 'worker-default' })), null);
  assert.equal(planHcTemplate(manifest({ modelInvocable: false })), null);
});

test('every launchable role of the catalog yields exactly one plan, in name order', () => {
  // The catalog is the layers under the caller's `baseDir`/`userDir`, never this machine's
  // `~/.pi/agent/piher/roles/`: a test that reads the home directory is green only where roles were
  // installed by hand and red on a fresh checkout (CI).
  const root = mkdtempSync(join(tmpdir(), 'piher-hc-catalog-'));
  const workspace = join(root, 'repo');
  const userDir = join(root, 'user');
  mkdirSync(join(workspace, '.piher', 'roles'), { recursive: true });
  mkdirSync(userDir, { recursive: true });
  const write = (dir: string, name: string, overrides: Partial<RoleManifest> = {}): void => {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ ...manifest(), role: name, ...overrides }));
  };
  write(join(workspace, '.piher', 'roles'), 'reviewer');
  write(userDir, 'builder');
  write(userDir, 'hidden-helper', { modelInvocable: false });
  try {
    const plans = planHcTemplates({ baseDir: workspace, userDir });
    assert.deepEqual(plans.map((plan) => plan.name), ['builder', 'reviewer']);
    for (const plan of plans) {
      assert.ok(!['master', 'worker-default'].includes(plan.name));
      assert.equal(plan.fileName, `${plan.name}.md`);
      assert.match(plan.markdown, /^---\nname: /);
      assert.ok(plan.command.startsWith('pi'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty catalog yields no plans instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'piher-hc-empty-'));
  try {
    // What a machine with no workspace and no user roles has: only the bundled `master` and
    // `worker-default`, which are the harness's own and are not launched by name.
    assert.deepEqual(planHcTemplates({ baseDir: root, userDir: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncing an existing template rewrites what the manifest owns and keeps the brief', () => {
  const plan = planHcTemplate(manifest());
  assert.ok(plan);
  const existing = [
    '---',
    'name: reviewer',
    'description: an older description',
    'command: pi --model some/OTHER-model --thinking low',
    '---',
    '',
    '# Reviewer brief',
    '',
    'Read these skills first: /a/SKILL.md',
    '',
  ].join('\n');
  const merged = mergeHcTemplate(existing, plan);
  assert.match(merged, /^---\nname: reviewer\ndescription: Static reviewer of a bounded change\ncommand: pi --model acme\/fast-model/);
  // The hand-written body survives, and it is not duplicated with the generated one.
  assert.match(merged, /# Reviewer brief\n\nRead these skills first: \/a\/SKILL\.md/);
  assert.ok(!merged.includes('# reviewer\n\nRules for this role'), 'the generated body never replaces a brief');
  assert.equal(merged.match(/^command:/gm)?.length, 1, 'exactly one command line');
});

test('a file without frontmatter is treated as a template to write whole', () => {
  const plan = planHcTemplate(manifest());
  assert.ok(plan);
  assert.equal(mergeHcTemplate('just prose', plan), plan.markdown);
});
