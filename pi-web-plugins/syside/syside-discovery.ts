import { opendir, realpath } from "node:fs/promises";
import type { Dir } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/**
 * Recursively discover project-relative `*.sysml` paths below `root`. The walk
 * skips `.git` and `node_modules` subtrees, does not follow directory symlinks,
 * and drops `.git`/`node_modules` entries, so SysIDE can claim Git-hosted
 * projects without inspecting the repository internals.
 *
 * A caller-provided `signal` is honoured between directory visits so a probe or
 * a check scanning a very large tree can be cancelled promptly instead of
 * leaving the walk running in the background after a deadline wins the race.
 */
export async function discoverSysmlFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (canonicalRoot === undefined) return [];
  const files: string[] = [];
  await walk(root, root, canonicalRoot, files, signal);
  files.sort();
  return files;
}

async function walk(
  projectRoot: string,
  dir: string,
  canonicalRoot: string,
  files: string[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let handle: Dir | undefined;
  try {
    handle = await opendir(dir);
  } catch {
    return;
  }
  // The Dir async iterator closes its handle when the loop ends (normally or
  // after an early exit), so no explicit close is required here.
  for await (const entry of handle) {
    throwIfAborted(signal);
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    // Directory symlinks are intentionally not followed, avoiding cycles and
    // accidental escapes; only an actual directory is descended into.
    if (!entry.isSymbolicLink() && entry.isDirectory()) {
      await walk(projectRoot, full, canonicalRoot, files, signal);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".sysml")) continue;
    const resolved = await realpath(full).catch(() => undefined);
    if (resolved === undefined || !isStrictDescendant(canonicalRoot, resolved)) continue;
    files.push(projectRelative(projectRoot, full));
  }
}

function projectRelative(projectRoot: string, full: string): string {
  const rel = relative(projectRoot, full);
  return rel.split(sep).join("/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("SysIDE file discovery aborted", { cause: reason });
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== ""
    && relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}
