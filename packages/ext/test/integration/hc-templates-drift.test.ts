/**
 * Drift guard (S75): a role lives in one place — its manifest — and its `hc` template is derived.
 * When both exist, the template's `command:` line (model, thinking, tools) must be the manifest's,
 * or `subagent spawn {role:"reviewer"}` and `hc run reviewer "…"` silently launch different workers
 * from the same name. The body is a human's brief and is deliberately not compared.
 *
 * The user's template directory is optional: a machine without it skips this suite, so the test
 * costs nothing where the feature is unused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hcTemplatesDir, planHcTemplates } from '../../src/hc-templates.ts';

const dir = hcTemplatesDir(homedir());
const plans = planHcTemplates();
const present = plans.filter((plan) => existsSync(join(dir, plan.fileName)));

test('role manifests and hc templates launch the same command', { skip: present.length === 0 }, () => {
  const drifted: string[] = [];
  for (const plan of present) {
    const text = readFileSync(join(dir, plan.fileName), 'utf8');
    const found = /^command:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
    if (found !== plan.command) {
      drifted.push(`${plan.fileName}\n  template: ${found}\n  manifest: ${plan.command}`);
    }
  }
  assert.deepEqual(
    drifted,
    [],
    'regenerate the templates from the manifests (they are the source of truth):\n'
      + 'node --input-type=module -e \'import { homedir } from "node:os"; import { join } from "node:path";'
      + ' import { writeFileSync, readFileSync, existsSync } from "node:fs";'
      + ' const m = await import("./packages/ext/src/hc-templates.ts");'
      + ' for (const p of m.planHcTemplates()) {'
      + ' const f = join(m.hcTemplatesDir(homedir()), p.fileName);'
      + ' writeFileSync(f, existsSync(f) ? m.mergeHcTemplate(readFileSync(f, "utf8"), p) : p.markdown); }\'\n'
      + drifted.join('\n'),
  );
});

test('a template only exists for a launchable role', { skip: present.length === 0 }, () => {
  for (const plan of present) {
    assert.ok(!['master', 'worker-default'].includes(plan.name), `${plan.name} is not launched by name`);
    assert.match(plan.command, /^pi( |$)/);
  }
});
