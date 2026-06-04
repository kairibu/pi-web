import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { sanitizedGitEnv } from "../git/gitEnv.js";
import type { ClientFileSuggestion } from "../types.js";

const execFileAsync = promisify(execFile);
const commandMaxBuffer = 1024 * 1024 * 8;
const maxFilesystemFallbackPaths = 20_000;

interface ExecFileOptions {
  cwd: string;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
}

export type FileSuggestionScope = "tracked" | "all";

export interface FileSuggestionOptions {
  kind?: ClientFileSuggestion["kind"] | undefined;
  scope?: FileSuggestionScope | undefined;
}

export interface FileSuggestionDependencies {
  execFile?: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>;
}

export async function listFileSuggestions(cwd: string, query = "", options: FileSuggestionOptions = {}, deps: FileSuggestionDependencies = {}): Promise<ClientFileSuggestion[]> {
  const normalizedQuery = normalizeFileQuery(query);
  const exec = deps.execFile ?? execFileAsync;
  const files = await listFilesForScope(cwd, options.scope, exec);
  return files
    .filter((file) => options.kind === undefined || file.kind === options.kind)
    .filter((file) => normalizedQuery === "" || file.path.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => Number(!a.path.endsWith("/")) - Number(!b.path.endsWith("/")) || a.path.localeCompare(b.path))
    .slice(0, 80);
}

export async function listPathSuggestions(cwd: string, prefix = ""): Promise<ClientFileSuggestion[]> {
  const normalizedPrefix = prefix.replace(/^@/, "").replace(/\\/g, "/");
  const directoryPrefix = normalizedPrefix.endsWith("/") ? normalizedPrefix : dirname(normalizedPrefix) === "." ? "" : `${dirname(normalizedPrefix)}/`;
  const searchPrefix = normalizedPrefix.endsWith("/") ? "" : basename(normalizedPrefix);
  const entries = await readdir(join(cwd, directoryPrefix), { withFileTypes: true });
  const suggestions: ClientFileSuggestion[] = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await stat(join(cwd, directoryPrefix, entry.name))).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    suggestions.push({ path: `${directoryPrefix}${entry.name}${isDirectory ? "/" : ""}`, kind: "other" });
  }
  return suggestions
    .sort((a, b) => Number(!a.path.endsWith("/")) - Number(!b.path.endsWith("/")) || a.path.localeCompare(b.path))
    .slice(0, 80);
}

async function listFilesForScope(cwd: string, scope: FileSuggestionScope | undefined, exec: NonNullable<FileSuggestionDependencies["execFile"]>): Promise<ClientFileSuggestion[]> {
  if (scope === "all") return listPlainFiles(cwd, exec, true);
  if (scope === "tracked") return listTrackedFiles(cwd, exec).catch(() => listPlainFiles(cwd, exec, true));
  return listGitFiles(cwd, exec).catch(() => listPlainFiles(cwd, exec, false));
}

async function listTrackedFiles(cwd: string, exec: NonNullable<FileSuggestionDependencies["execFile"]>): Promise<ClientFileSuggestion[]> {
  return withDirectories(lines(await git(cwd, ["ls-files"], exec)), "tracked");
}

async function listGitFiles(cwd: string, exec: NonNullable<FileSuggestionDependencies["execFile"]>): Promise<ClientFileSuggestion[]> {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["ls-files"], exec),
    git(cwd, ["ls-files", "--others", "--exclude-standard"], exec),
  ]);
  return [
    ...withDirectories(lines(tracked), "tracked"),
    ...withDirectories(lines(untracked), "untracked"),
  ];
}

async function listPlainFiles(cwd: string, exec: NonNullable<FileSuggestionDependencies["execFile"]>, includeIgnored: boolean): Promise<ClientFileSuggestion[]> {
  try {
    const args = includeIgnored ? ["--files", "--hidden", "--no-ignore"] : ["--files"];
    const { stdout } = await exec("rg", args, { cwd, maxBuffer: commandMaxBuffer });
    return withDirectories(lines(stdout), "other");
  } catch {
    return withDirectories(await filesystemFiles(cwd), "other");
  }
}

async function filesystemFiles(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  await collectFilesystemFiles(cwd, "", paths, false);
  return paths;
}

async function collectFilesystemFiles(cwd: string, relativeDirectory: string, paths: string[], optionalDirectory: boolean): Promise<void> {
  if (paths.length >= maxFilesystemFallbackPaths) return;
  const absoluteDirectory = relativeDirectory === "" ? cwd : join(cwd, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (optionalDirectory) return;
    throw error;
  }

  entries.sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (paths.length >= maxFilesystemFallbackPaths) return;
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFilesystemFiles(cwd, relativePath, paths, true);
      continue;
    }
    if (entry.isFile() || await isSymlinkedFile(cwd, relativePath, entry.isSymbolicLink())) paths.push(relativePath);
  }
}

async function isSymlinkedFile(cwd: string, relativePath: string, symbolicLink: boolean): Promise<boolean> {
  if (!symbolicLink) return false;
  try {
    return (await stat(join(cwd, relativePath))).isFile();
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[], exec: NonNullable<FileSuggestionDependencies["execFile"]>): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: sanitizedGitEnv(), maxBuffer: commandMaxBuffer });
  return stdout;
}

function normalizeFileQuery(query: string): string {
  return query.replace(/^!@/, "").replace(/^@\s?/, "").toLowerCase();
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function withDirectories(paths: string[], kind: ClientFileSuggestion["kind"]): ClientFileSuggestion[] {
  const seen = new Set<string>();
  const suggestions: ClientFileSuggestion[] = [];
  for (const path of paths) {
    for (const directory of parentDirectories(path)) add(`${directory}/`);
    add(path);
  }
  return suggestions;

  function add(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    suggestions.push({ path, kind });
  }
}

function parentDirectories(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index++) {
    directories.push(parts.slice(0, index).join("/"));
  }
  return directories;
}
