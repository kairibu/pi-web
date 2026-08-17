import { opendir, realpath, stat } from "node:fs/promises";
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

/**
 * A snapshot of the SysML sources below one workspace: sorted project-relative
 * paths plus a content-aware fingerprint (per-file size, mtime, and ctime). The
 * model service compares fingerprints at request time so source edits reload
 * the active model even when a filesystem watcher missed or coalesced an event.
 *
 * The timestamp components have the granularity of the underlying filesystem:
 * on coarse-timestamp filesystems (FAT, some network mounts) two same-size
 * edits within one mtime tick can be missed. That is accepted - the watcher is
 * the primary dirty signal and this fingerprint is only the request-time
 * correctness fallback - so if "edit didn't reload" reports ever appear, this
 * fingerprint is the first thing to revisit.
 */
export interface SysideSourceManifest {
  /** Sorted project-relative `*.sysml` paths below the workspace. */
  readonly files: readonly string[];
  /** Absolute paths for the Python worker's `load` operation. */
  readonly absoluteFiles: readonly string[];
  /** Stable fingerprint of `path:size:mtimeMs:ctimeMs` over the sorted files. */
  readonly fingerprint: string;
}

/**
 * Discover the current SysML source manifest below `root` using the same safe
 * traversal rules as {@link discoverSysmlFiles}: skip `.git` and `node_modules`,
 * never follow directory symlinks, only accept files canonically inside the
 * workspace, and honour an abort signal between directory visits.
 */
export async function discoverSysmlManifest(root: string, signal?: AbortSignal): Promise<SysideSourceManifest> {
  const files = await discoverSysmlFiles(root, signal);
  const absoluteFiles = files.map((file) => join(root, file));
  const entries: string[] = [];
  for (const file of files) {
    // A discovered file may vanish between discovery and stat; treat it as an
    // empty 0-byte entry so the fingerprint still changes on the next request.
    const absolute = join(root, file);
    const info = await stat(absolute).catch(() => undefined);
    entries.push(`${file}:${String(info?.size ?? 0)}:${String(info?.mtimeMs ?? 0)}:${String(info?.ctimeMs ?? 0)}`);
  }
  return {
    files,
    absoluteFiles,
    fingerprint: entries.join("\n"),
  };
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
