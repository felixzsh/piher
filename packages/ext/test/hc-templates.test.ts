/** hc-templates: the role manifest is the source of truth, the template is the derived artifact. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const plans = planHcTemplates();
  assert.ok(plans.length > 0, 'the builtin catalog has at least one launchable role');
  const names = plans.map((plan) => plan.name);
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)));
  assert.equal(new Set(names).size, names.length, 'one template per role name');
  for (const plan of plans) {
    assert.ok(!['master', 'worker-default'].includes(plan.name));
    assert.equal(plan.fileName, `${plan.name}.md`);
    assert.match(plan.markdown, /^---\nname: /);
    assert.ok(plan.command.startsWith('pi'));
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
