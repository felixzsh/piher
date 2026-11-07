/**
 * The subagent registry on disk: one JSON document per session, rewritten in place.
 *
 * It replaces the `piher.subs` branch entries as the durable copy. A session is an append-only log
 * (`pi.appendEntry` has no replace or delete), so every snapshot used to cost a full copy and the
 * restore had to be bounded to keep the log from growing (S73) — and a bounded restore is what dropped
 * a worker the master still had to close. A file the extension owns is rewritten instead of appended:
 * constant size, every row kept, and a fork can be seeded by copying it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { foldSubsRegistry, SUBS_CUSTOM_TYPE, type SubsRegistry } from './subagent-core.ts';
import { swallow } from './swallow.ts';

export const REGISTRY_FILE_NAME = 'registry.json';

/** Parse a document; a missing, torn or foreign file is "no registry", so a caller can fall back. */
export function readRegistryFile(file: string | null): SubsRegistry | null {
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // Same tolerant normalization the branch fold uses (v1 rows, unknown statuses), so one file format
    // and one reader cannot drift apart.
    const folded = foldSubsRegistry([{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: parsed }]);
    return folded.subs.length > 0 ? folded : null;
  } catch {
    return null;
  }
}

/** Replace the document atomically (tmp + rename): a crash mid-write must not leave half a registry. */
export function writeRegistryFile(file: string, registry: SubsRegistry): void {
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(registry)}\n`);
  renameSync(tmp, file);
}

/** A fork gets the state it branched from: pi names the previous transcript, we copy its document once. */
export function seedRegistryFile(to: string | null, from: string | null): boolean {
  if (!to || !from || to === from) return false;
  try {
    if (existsSync(to) || !existsSync(from)) return false;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    return true;
  } catch (err) {
    swallow('subagent.seed-registry', err);
    return false;
  }
}
