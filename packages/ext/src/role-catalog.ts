/**
 * The `piher-roles` prompt section: which roles a spawn can name, derived from the role manifests
 * (never from prose). S20 — one line per visible role, ordered by layer then name, deduped by name,
 * closing with the default line; `master` and `modelInvocable: false` roles are absent.
 *
 * A static skill file cannot enumerate roles that appear per workspace, and an action would spend a
 * round trip on text that fits in the prompt for free — so the catalog is prompt-only (S21/S22).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_ROLE_NAMES, roleLayers } from './role-loader.ts';

/** Prompt-budget cap: past this the section says how many roles it left out. */
export const CATALOG_MAX_ROLES = 12;
/** The role piher composes when a spawn omits `role`. */
export const DEFAULT_ROLE_NAME = 'worker-default';

export interface CatalogEntry {
  name: string;
  /** Manifest `description`; absent when the file does not carry one. */
  description?: string;
  /** `false` keeps a role launchable by name but out of the catalog. */
  modelInvocable?: boolean;
  /** Layer index (0 = workspace, 1 = user); ordering and dedupe only — the lower layer wins. */
  layer: number;
}

/**
 * Reads the two spawnable layers (workspace → user). An unreadable or unparseable manifest is
 * skipped: it cannot be spawned either, and the spawn error names it.
 */
export function catalogEntries(opts?: { baseDir?: string; userDir?: string }): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  roleLayers(opts).slice(0, 2).forEach((layer, layerIndex) => {
    let files: string[];
    try {
      files = readdirSync(layer.dir);
    } catch {
      return; // Layer absent (the workspace one commonly is).
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -'.json'.length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(layer.dir, file), 'utf8'));
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rec = parsed as { description?: unknown; modelInvocable?: unknown };
      entries.push({
        name,
        ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
        ...(typeof rec.modelInvocable === 'boolean' ? { modelInvocable: rec.modelInvocable } : {}),
        layer: layerIndex,
      });
    }
  });
  return entries;
}

/** Renders the section body. Deterministic: same entries in, byte-identical text out. */
export function renderRoleCatalog(
  entries: readonly CatalogEntry[],
  opts?: { maxRoles?: number; searchDirs?: readonly string[] },
): string {
  const max = opts?.maxRoles ?? CATALOG_MAX_ROLES;
  const ordered = [...entries].sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const visible: CatalogEntry[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.name)) continue; // Higher layer wins.
    seen.add(entry.name);
    if (RESERVED_ROLE_NAMES.includes(entry.name)) continue; // master is the caller; worker-default is the default line.
    if (entry.modelInvocable === false) continue;
    visible.push(entry);
  }

  const lines = ['Roles a `subagent` spawn can name (`role` parameter):'];
  for (const entry of visible.slice(0, max)) {
    const description = entry.description?.replace(/\s+/g, ' ').trim();
    lines.push(`- ${entry.name} — ${description || '(no description)'}`);
  }
  const hidden = visible.length - max;
  if (hidden > 0) {
    const where = opts?.searchDirs?.length
      ? ` (${opts.searchDirs.join(', ')})`
      : ' (`.piher/roles/`, `~/.pi/agent/piher/roles/`)';
    lines.push(`- … ${hidden} more not listed here${where}; an unknown-role error names them all`);
  }
  lines.push(`- (default) — \`${DEFAULT_ROLE_NAME}\`, used when \`role\` is omitted`);
  return lines.join('\n');
}

/** Every spawn-target directory a truncation notice can point at. */
export function catalogSearchDirs(opts?: { baseDir?: string; userDir?: string }): string[] {
  return roleLayers(opts).slice(0, 2).map((layer) => layer.dir);
}
