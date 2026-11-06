/**
 * Skill coverage (S70): the three texts that describe `subagent` cannot silently diverge.
 *
 * The schema is the truth, so nothing here restates a name by hand: the action list comes from the
 * `Type.Literal(...)` union of the `action` parameter and the parameter names from the
 * `Type.Object({...})` that registers the tool, both read out of `plugins/subagent.ts` with a
 * brace-and-quote-aware scan. Adding an action or a parameter without documenting it is then a red
 * check instead of a silent omission, and a plugin reshuffle that defeats the scan *throws* — an
 * empty list would make every assertion below vacuously true, which is the one failure mode that
 * would make this gate worthless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN = 'packages/ext/src/plugins/subagent.ts';
const SKILL = 'packages/ext/skills/piher-tools/SKILL.md';
/** The description rides every request, so its length is part of the contract (today ~950 chars). */
const DESCRIPTION_BUDGET = 1100;

const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

const CLOSING: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const QUOTES = new Set(["'", '"']);
const ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0',
};

/** Escape sequence → the character it stands for; anything else (`\\`, `\'`, `\"`) is itself. */
function unescape(raw: string): string {
  const pattern = /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g;
  return raw.replace(pattern, (_all, esc: string) => {
    if (esc.length > 1) return String.fromCodePoint(parseInt(esc.replace(/[ux{}]/g, ''), 16));
    return ESCAPES[esc] ?? esc;
  });
}

/** Index just past the quoted literal at `start`; a shape this scan cannot read is an error. */
function skipString(src: string, start: number, where: string): number {
  const quote = src[start]!;
  if (!QUOTES.has(quote)) throw new Error(`${where}: no template literals, quote at ${start}`);
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') i++;
    else if (ch === quote) return i + 1;
    else if (ch === '\n') break;
  }
  throw new Error(`${where}: unterminated string literal at offset ${start}`);
}

/** Body and end offset of the bracketed expression of `open` that follows `marker`. */
function blockAfter(
  src: string, marker: string, open: '{' | '[' | '(', where: string,
): { body: string; end: number } {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${where}: cannot find \`${marker}\` — did the schema move?`);
  let i = src.indexOf(open, at + marker.length);
  if (i < 0) throw new Error(`${where}: no \`${open}\` after \`${marker}\``);
  const close = CLOSING[open]!;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(src, i, where) - 1;
    } else if (ch === open) {
      depth++;
    } else if (ch === close && --depth === 0) {
      return { body: src.slice(start + 1, i), end: i + 1 };
    }
  }
  throw new Error(`${where}: unbalanced \`${open}\` after \`${marker}\``);
}

/** Property names declared directly in an object body — nested objects and strings are skipped. */
function topLevelKeys(body: string, where: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let prev = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      prev = '\n';
    } else if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`${where}: unterminated comment`);
      i = end + 1;
      prev = ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(body, i, where) - 1;
      prev = 'x';
    } else if ('([{'.includes(ch)) {
      depth++;
      prev = ch;
    } else if (')]}'.includes(ch)) {
      depth--;
      prev = ch;
    } else if (/\s/.test(ch)) {
      continue;
    } else if (depth === 0 && (prev === '' || prev === '{' || prev === ',')) {
      const name = /^[A-Za-z_$][\w$]*/.exec(body.slice(i))?.[0];
      if (name && /^\s*:/.test(body.slice(i + name.length))) {
        keys.push(name);
        i += name.length - 1;
        prev = 'x';
        continue;
      }
      prev = ch;
    } else {
      prev = ch;
    }
  }
  if (depth !== 0) throw new Error(`${where}: unbalanced brackets inside the object body`);
  return keys;
}

/** The text of `const NAME = ['…', '…'].join(' … ')`, joined exactly as the plugin joins it. */
function joinedText(src: string, name: string, where: string): string {
  const block = blockAfter(src, `const ${name} = `, '[', where);
  const join = /^\s*\.join\(\s*'((?:\\.|[^'\\])*)'\s*\)/.exec(src.slice(block.end));
  if (!join) throw new Error(`${where}: \`${name}\` no longer ends in \`.join('…')\``);
  const pieces = [...block.body.matchAll(/'((?:\\.|[^'\\])*)'/g)].map((m) => unescape(m[1]!));
  if (pieces.length === 0) throw new Error(`${where}: no string literals found in \`${name}\``);
  return pieces.join(unescape(join[1]!));
}

interface Truth {
  actions: string[];
  parameters: string[];
  description: string;
  manual: string;
  skill: string;
}

function extract(): Truth {
  const plugin = read(PLUGIN);
  const params = blockAfter(plugin, 'parameters: Type.Object(', '{', PLUGIN);
  const union = blockAfter(params.body, 'Type.Union(', '[', `${PLUGIN} (action)`);
  const actions = [...union.body.matchAll(/Type\.Literal\(\s*'((?:\\.|[^'\\])*)'\s*\)/g)]
    .map((m) => unescape(m[1]!));
  // `action` is the parameter that selects the action; every other key is an argument.
  const parameters = topLevelKeys(params.body, PLUGIN).filter((key) => key !== 'action');
  if (actions.length === 0) throw new Error(`${PLUGIN}: the union has no Type.Literal entries`);
  if (parameters.length === 0) throw new Error(`${PLUGIN}: the object has no property names`);
  return {
    actions,
    parameters,
    description: joinedText(plugin, 'SUBAGENT_DESCRIPTION', PLUGIN),
    manual: joinedText(plugin, 'SUBAGENT_MANUAL', PLUGIN),
    skill: read(SKILL),
  };
}

let cached: Truth | undefined;
/** Extraction is memoized but never swallowed: a shape change throws out of the first test. */
const truth = (): Truth => (cached ??= extract());

/** Does `text` name `word` as a whole word? `role` must not be satisfied by `roles`. */
const names = (text: string, word: string): boolean => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
};

test('schema scan: the plugin still declares an action union and a parameter object', () => {
  const t = truth();
  const duplicate = t.actions.length !== new Set(t.actions).size;
  assert.ok(!duplicate, `duplicate Type.Literal entries: ${t.actions.join(', ')}`);
  const oddAction = t.actions.find((a) => !/^[a-z][a-z-]*$/.test(a));
  assert.equal(oddAction, undefined, `unexpected action name "${oddAction}"`);
  const oddParam = t.parameters.find((p) => !/^[A-Za-z_$][\w$]*$/.test(p));
  assert.equal(oddParam, undefined, `unexpected parameter name "${oddParam}"`);
  assert.ok(t.manual.length > 0 && t.description.length > 0, 'the shipped texts are empty');
  assert.ok(t.skill.length > 0, 'SKILL.md is empty');
});

test('SUBAGENT_DESCRIPTION names every action and stays inside its per-request budget', () => {
  const t = truth();
  const missing = t.actions.filter((a) => !names(t.description, a)).map((a) => `action "${a}"`);
  assert.deepEqual(missing, [], `SUBAGENT_DESCRIPTION does not name ${missing.join(', ')}`);
  const budget = `${DESCRIPTION_BUDGET}-char budget`;
  assert.ok(t.description.length <= DESCRIPTION_BUDGET,
    `SUBAGENT_DESCRIPTION is ${t.description.length} chars, over its ${budget}`);
});

test('SUBAGENT_MANUAL stays inside the inline budget it is read through', () => {
  // An output larger than 4096 B is indexed and replaced by a pointer by the context-mode extension:
  // a help text that big arrives as "ctx_search(...) searches the whole output" and the caller never
  // sees the manual or the role catalog. The catalog costs ~650 B, so the manual keeps 3000.
  const manual = truth().manual as string;
  assert.ok(Buffer.byteLength(manual) <= 3000, `SUBAGENT_MANUAL is ${Buffer.byteLength(manual)} B, over 3000`);
});

test('SUBAGENT_MANUAL names every action and every parameter', () => {
  const t = truth();
  const missing = [
    ...t.actions.filter((a) => !names(t.manual, a)).map((a) => `action "${a}"`),
    ...t.parameters.filter((p) => !names(t.manual, p)).map((p) => `parameter "${p}"`),
  ];
  assert.deepEqual(missing, [], `SUBAGENT_MANUAL does not name ${missing.join(', ')}`);
});

test('piher-tools SKILL.md names every action and every parameter', () => {
  const t = truth();
  const missing = [
    ...t.actions.filter((a) => !names(t.skill, a)).map((a) => `action "${a}"`),
    ...t.parameters.filter((p) => !names(t.skill, p)).map((p) => `parameter "${p}"`),
  ];
  assert.deepEqual(missing, [], `SKILL.md does not name ${missing.join(', ')}`);
});
