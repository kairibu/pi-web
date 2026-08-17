import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSysmlFiles, discoverSysmlManifest } from "./syside-discovery.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("discoverSysmlFiles", () => {
  it("finds nested SysML files, skips .git and node_modules, and sorts the result", async () => {
    const root = await temporaryDirectory("discovery");
    await mkdir(join(root, "parts", "Nested"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "lib"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "Model.sysml"), "", "utf8"),
      writeFile(join(root, "parts", "Wing.sysml"), "", "utf8"),
      writeFile(join(root, "parts", "Nested", "Tail.sysml"), "", "utf8"),
      writeFile(join(root, "parts", "notes.txt"), "", "utf8"),
      writeFile(join(root, "parts", "Wing.sysml.bak"), "", "utf8"),
      writeFile(join(root, ".git", "ignored.sysml"), "", "utf8"),
      writeFile(join(root, "node_modules", "lib", "lib.sysml"), "", "utf8"),
    ]);

    await expect(discoverSysmlFiles(root)).resolves.toEqual([
      "Model.sysml",
      "parts/Nested/Tail.sysml",
      "parts/Wing.sysml",
    ]);
  });

  it("returns an empty list for a project without SysML files or a missing root", async () => {
    const empty = await temporaryDirectory("empty");
    await expect(discoverSysmlFiles(empty)).resolves.toEqual([]);
    await expect(discoverSysmlFiles(join(empty, "missing"))).resolves.toEqual([]);
  });

  it("honours an aborted signal and rejects instead of walking the tree", async () => {
    const root = await temporaryDirectory("abort");
    await mkdir(join(root, "parts"), { recursive: true });
    await writeFile(join(root, "parts", "Wing.sysml"), "", "utf8");

    // An already-aborted signal rejects immediately instead of walking the
    // tree, so a caller whose deadline won the race does not leave the scan
    // running in the background. The signal's own AbortError is surfaced, the
    // same convention the provider registry uses for aborted probe/list calls.
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(discoverSysmlFiles(root, preAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(discoverSysmlFiles(join(root, "parts"), preAborted.signal)).rejects.toMatchObject({ name: "AbortError" });

    // A live signal walks normally.
    await expect(discoverSysmlFiles(root, new AbortController().signal)).resolves.toEqual(["parts/Wing.sysml"]);
  });

  it.skipIf(process.platform === "win32")("does not include a SysML file reached through a symlink that escapes the project", async () => {
    const base = await temporaryDirectory("symlink escape");
    const project = join(base, "project");
    const outside = join(base, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.sysml"), "", "utf8");
    await symlink(join(outside, "secret.sysml"), join(project, "linked.sysml"));

    await expect(discoverSysmlFiles(project)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("includes a SysML file whose symlink target stays inside the project", async () => {
    const base = await temporaryDirectory("symlink inside");
    const project = join(base, "project");
    await mkdir(join(project, "parts"), { recursive: true });
    await writeFile(join(project, "parts", "Real.sysml"), "", "utf8");
    await symlink(join(project, "parts", "Real.sysml"), join(project, "alias.sysml"));

    await expect(discoverSysmlFiles(project)).resolves.toEqual(["alias.sysml", "parts/Real.sysml"]);
  });

  it("finds SysML files inside a Git worktree while skipping the .git subtree", async () => {
    const root = await temporaryDirectory("git repo");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "parts"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "Model.sysml"), "package m;\n", "utf8"),
      writeFile(join(root, "parts", "Wing.sysml"), "", "utf8"),
      writeFile(join(root, ".git", "ignored.sysml"), "", "utf8"),
    ]);

    await expect(discoverSysmlFiles(root)).resolves.toEqual([
      "Model.sysml",
      "parts/Wing.sysml",
    ]);
  });

  it("does not follow a symlinked directory", async () => {
    const base = await temporaryDirectory("dir symlink");
    const project = join(base, "project");
    const outside = join(base, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "inside.sysml"), "", "utf8");
    await symlink(outside, join(project, "linked-dir"));

    await expect(discoverSysmlFiles(project)).resolves.toEqual([]);
  });
});

describe("discoverSysmlManifest", () => {
  it("returns sorted relative and absolute files with a stable fingerprint", async () => {
    const root = await temporaryDirectory("manifest");
    await mkdir(join(root, "parts"), { recursive: true });
    await writeFile(join(root, "Model.sysml"), "package m;\n", "utf8");
    await writeFile(join(root, "parts", "Wing.sysml"), "package w;\n", "utf8");

    const manifest = await discoverSysmlManifest(root);
    expect(manifest.files).toEqual(["Model.sysml", "parts/Wing.sysml"]);
    expect(manifest.absoluteFiles).toEqual([join(root, "Model.sysml"), join(root, "parts", "Wing.sysml")]);
    expect(manifest.fingerprint.split("\n")).toHaveLength(2);
    expect(manifest.fingerprint).toContain("Model.sysml:");
    expect(manifest.fingerprint).toContain("parts/Wing.sysml:");
    await expect(discoverSysmlManifest(root)).resolves.toEqual(manifest);
  });

  it("produces a stable fingerprint for an empty workspace", async () => {
    const root = await temporaryDirectory("manifest empty");
    const manifest = await discoverSysmlManifest(root);
    expect(manifest).toEqual({ files: [], absoluteFiles: [], fingerprint: "" });
  });

  it("changes the fingerprint when a source file's content changes", async () => {
    const root = await temporaryDirectory("manifest content");
    await writeFile(join(root, "Model.sysml"), "package m;\n", "utf8");
    const before = await discoverSysmlManifest(root);
    await writeFile(join(root, "Model.sysml"), "package m { part def Wing; }\n", "utf8");
    const after = await discoverSysmlManifest(root);

    expect(after.files).toEqual(before.files);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("reuses the safe discovery rules: skips .git and node_modules and does not escape via symlinks", async () => {
    const base = await temporaryDirectory("manifest rules");
    const root = join(base, "project");
    const outside = join(base, "outside");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await Promise.all([
      writeFile(join(root, "Model.sysml"), "package m;\n", "utf8"),
      writeFile(join(root, ".git", "ignored.sysml"), "", "utf8"),
      writeFile(join(root, "node_modules", "lib.sysml"), "", "utf8"),
      writeFile(join(outside, "secret.sysml"), "", "utf8"),
    ]);
    await symlink(join(outside, "secret.sysml"), join(root, "linked.sysml"));

    const manifest = await discoverSysmlManifest(root);
    expect(manifest.files).toEqual(["Model.sysml"]);
    expect(manifest.absoluteFiles).toEqual([join(root, "Model.sysml")]);
  });

  it("honours an aborted signal", async () => {
    const root = await temporaryDirectory("manifest abort");
    await writeFile(join(root, "Model.sysml"), "", "utf8");
    const preAborted = new AbortController();
    preAborted.abort();

    await expect(discoverSysmlManifest(root, preAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(discoverSysmlManifest(root, new AbortController().signal)).resolves.toMatchObject({ files: ["Model.sysml"] });
  });
});

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-web-syside-discovery-${label}-`));
  tempRoots.push(path);
  return path;
}
