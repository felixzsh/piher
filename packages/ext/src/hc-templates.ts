/**
 * hc templates generated from role manifests (S75): one contract, two doors.
 *
 * A role manifest is the source of truth — it carries the model, the thinking level, the tool set and
 * the rules a template cannot express. `hc run <role> "task"` needs the same role as a Markdown
 * template, and generating it removes the drift that let `subagent spawn {role:"reviewer"}` and
 * `hc run reviewer` launch different models from the same name.
 *
 * Placement is hc's, not ours: frontmatter carries `name`, `description` and `command`, and the body
 * is delivered as the first message together with the task (see `hc --skill`). The body therefore
 * holds the standing instructions, while the rules that must be enforced (`rules`, `unknownTools`,
 * `lifecycle`) stay in the manifest, where a tool gate applies them.
 */
import { join } from 'node:path';
import { listRoleNames, loadRoleConfig, RESERVED_ROLE_NAMES } from './role-loader.ts';
import type { RoleManifest } from './role-manifest.ts';

/** `~/.config/herdr-core/templates`, where core looks for templates. */
export function hcTemplatesDir(homeDir: string): string {
  return join(homeDir, '.config', 'herdr-core', 'templates');
}

export interface HcTemplatePlan {
  /** Role name, which is also the template name `hc run <name>` resolves. */
  name: string;
  /** File name inside the templates directory. */
  fileName: string;
  /** Template command line: the launch command with model, thinking and tools. */
  command: string;
  /** The frontmatter description line, kept so a merge can restore a missing one. */
  descriptionLine: string;
  /** Full Markdown file: frontmatter plus standing instructions. */
  markdown: string;
}

/** YAML frontmatter values stay on one line: a newline or a stray quote breaks the file. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `pi --model … --thinking … --tools …`: the argv a template launches. */
export function templateCommand(manifest: RoleManifest): string {
  const parts = ['pi'];
  if (manifest.model) parts.push('--model', manifest.model);
  if (manifest.thinking) parts.push('--thinking', manifest.thinking);
  // `*` is a wildcard, not a tool: the manifest already covers unknown tools through `unknownTools`.
  const tools = manifest.manifest.tools.filter((tool) => tool !== '*');
  if (tools.length > 0) parts.push('--tools', tools.join(','));
  return parts.join(' ');
}

/**
 * One template from one manifest, or null when the role is not meant to be launched by name:
 * `master` and `worker-default` are the harness's own roles, and `modelInvocable: false` marks a
 * role that exists but must not appear as a launchable profile.
 */
export function planHcTemplate(manifest: RoleManifest): HcTemplatePlan | null {
  if (manifest.modelInvocable === false) return null;
  if (RESERVED_ROLE_NAMES.includes(manifest.role)) return null;
  const command = templateCommand(manifest);
  const description = oneLine(manifest.description ?? `Role ${manifest.role}`);
  const body: string[] = [`# ${manifest.role}`, ''];
  if (manifest.guidelines && manifest.guidelines.length > 0) {
    body.push('Rules for this role:', '');
    for (const line of manifest.guidelines) body.push(`- ${oneLine(line)}`);
    body.push('');
  }
  if (manifest.instructions) body.push(manifest.instructions.trim(), '');
  body.push(
    'These instructions and the task that follows are one message: do the task under these rules,',
    'not instead of them. Report the result as the last message of your turn.',
  );
  const markdown = [
    '---',
    `name: ${manifest.role}`,
    `description: ${description}`,
    `command: ${command}`,
    '---',
    '',
    ...body,
    '',
  ].join('\n');
  return {
    name: manifest.role,
    fileName: `${manifest.role}.md`,
    command,
    descriptionLine: `description: ${description}`,
    markdown,
  };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Sync a template that already exists: the frontmatter fields this generator owns (`name`,
 * `description`, `command`) are replaced, every other key and **the whole body** stay untouched. A
 * hand-written brief is worth more than a regenerated one, so syncing never clobbers prose.
 */
export function mergeHcTemplate(existing: string, plan: HcTemplatePlan): string {
  const match = FRONTMATTER.exec(existing);
  if (match === null) return plan.markdown;
  const kept = match[1]!
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => !/^(name|description|command)\s*:/.test(line));
  const front = [
    '---',
    `name: ${plan.name}`,
    plan.descriptionLine,
    ...kept,
    `command: ${plan.command}`,
    '---',
    '',
    '',
  ].join('\n');
  return `${front}${existing.slice(match[0].length).replace(/^\n+/, '')}`;
}

/** Every launchable role of the loaded catalog, in name order, as a template plan. */
export function planHcTemplates(opts: { baseDir?: string; userDir?: string } = {}): HcTemplatePlan[] {
  const plans: HcTemplatePlan[] = [];
  for (const name of listRoleNames(opts.baseDir, opts.userDir)) {
    let manifest: RoleManifest;
    try {
      manifest = loadRoleConfig(name, opts);
    } catch {
      // A role that does not validate is reported by the catalog, not by this generator.
      continue;
    }
    const plan = planHcTemplate(manifest);
    if (plan !== null) plans.push(plan);
  }
  return plans.sort((left, right) => left.name.localeCompare(right.name));
}
