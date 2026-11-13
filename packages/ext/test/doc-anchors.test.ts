/**
 * Guards the shipped docs against rot: `docs/decisions.md` anchors must still land on an existing
 * line (`path:line` survives renames, module merges and file shrinks), no doc may name a `PIHER_*`
 * env knob the source no longer reads, and every relative link must resolve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ANCHOR = /`([^`\n]+?):(\d+)`/g;
const ENV_KNOB = /\b(PIHER_[A-Z0-9_]+)\b/g;
const LINK = /\]\(([^)\s]+)\)/g;

/** Lines of content: a trailing newline does not add one, a missing one does not remove the last. */
const countLines = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

/** Every `.md` under `dir`, recursively (paths relative to the repo root). */
function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...markdownUnder(path));
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

/** What a user reads: the README pair, `docs/`, and the shipped skill. The design records under
 *  `docs/spec/` are excluded on purpose: they quote knobs historically (a spec that says a knob was
 *  deleted names it, and that is the opposite of rot). */
function shippedDocs(): string[] {
  return [
    'README.md',
    'packages/ext/README.md',
    ...markdownUnder('docs').filter((path) => !path.startsWith('docs/spec/')),
    ...markdownUnder('packages/ext/skills'),
  ];
}

/** Every source file under `dir`, recursively, concatenated — a knob is live if the code names it. */
function sourceText(): string {
  return sourceFiles('packages/ext/src').join('\n');}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mjs|js|json)$/.test(entry.name)) out.push(read(path));
  }
  return out;
}

test('decisions.md: every `path:line` anchor names an existing file with that many lines', () => {
  const doc = read('docs/decisions.md');
  const anchors = [...doc.matchAll(ANCHOR)].map((m) => ({ path: m[1]!, line: Number(m[2]) }));
  assert.ok(anchors.length > 0, 'no `path:line` anchors found — did the index format change?');
  const broken: string[] = [];
  for (const { path, line } of anchors) {
    let lines: number;
    try {
      lines = countLines(read(path));
    } catch {
      broken.push(`\`${path}:${line}\` — file does not exist`);
      continue;
    }
    if (line > lines) broken.push(`\`${path}:${line}\` — file has only ${lines} lines`);
  }
  assert.deepEqual(broken, [], `stale decision anchors:\n${broken.join('\n')}`);
});

test('docs: every `PIHER_*` knob a doc names is still read by the code', () => {
  const source = sourceText();
  const dead: string[] = [];
  for (const doc of shippedDocs()) {
    for (const [, knob] of read(doc).matchAll(ENV_KNOB)) {
      if (!source.includes(knob!)) dead.push(`${doc}: \`${knob}\``);
    }
  }
  assert.deepEqual([...new Set(dead)], [], `docs name env knobs no code reads:\n${dead.join('\n')}`);
});

test('docs: every relative link resolves', () => {
  const broken: string[] = [];
  for (const doc of shippedDocs()) {
    for (const [, target] of read(doc).matchAll(LINK)) {
      if (/^(?:[a-z]+:|#)/.test(target!)) continue;
      const path = resolve(repoRoot, dirname(doc), decodeURI(target!.split('#')[0]!));
      try {
        readFileSync(path);
      } catch {
        broken.push(`${doc}: \`${target}\``);
      }
    }
  }
  assert.deepEqual(broken, [], `docs link to missing files:\n${broken.join('\n')}`);
});
