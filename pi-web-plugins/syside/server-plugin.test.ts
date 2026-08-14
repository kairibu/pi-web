import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderWorkspace,
  ServerPluginActivationContext,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import type { Project } from "../../src/shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../../src/server/plugins/serverPluginRuntime.js";
import { WorkspaceProviderRegistry } from "../../src/server/workspaces/workspaceProviderRegistry.js";
import { SYSIDE_CHECK_OPERATION } from "./syside-backend.js";
import plugin from "./server-plugin.js";
import gitPlugin from "../git/server-plugin.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled SysIDE workspace provider", () => {
  it("is a fallback provider that claims SysML folders", async () => {
    const folder = await temporaryDirectory("claim");
    await writeFile(join(folder, "Model.sysml"), "package m;\n", "utf8");
    const workspaceProvider = await providerFor(vi.fn());

    expect(workspaceProvider.fallback).toBe(true);
    await expect(workspaceProvider.probe(project(folder), new AbortController().signal)).resolves.toBe("claim");
  });

  it("passes plain folders and claims SysML folders even inside a Git worktree, including nested projects", async () => {
    const plain = await temporaryDirectory("plain");
    const gitBacked = await temporaryDirectory("git-backed");
    await mkdir(join(gitBacked, ".git"));
    await mkdir(join(gitBacked, "sub"), { recursive: true });
    await writeFile(join(gitBacked, "Model.sysml"), "package m;\n", "utf8");
    await writeFile(join(gitBacked, "sub", "Nested.sysml"), "", "utf8");
    const workspaceProvider = await providerFor(vi.fn());

    await expect(workspaceProvider.probe(project(plain), new AbortController().signal)).resolves.toBe("pass");
    await expect(workspaceProvider.probe(project(gitBacked), new AbortController().signal)).resolves.toBe("claim");
    await expect(workspaceProvider.probe(project(join(gitBacked, "sub")), new AbortController().signal)).resolves.toBe("claim");
  });

  it("lists exactly one root workspace", async () => {
    const folder = await temporaryDirectory("list");
    await writeFile(join(folder, "Model.sysml"), "", "utf8");
    const workspaceProvider = await providerFor(vi.fn());
    const input = project(folder);

    await expect(workspaceProvider.list(input, new AbortController().signal)).resolves.toEqual([
      { key: folder, path: folder, label: "Project", isMain: true },
    ]);
  });

  it("degrades a Git+SysML folder to a claim conflict instead of picking an owner", async () => {
    // Both bundled Git and SysIDE are fallback providers and both claim this
    // folder (Git with a real worktree probe, SysIDE from the .sysml file), so
    // the registry must report a claim conflict rather than silently choosing
    // one of them. The panel/session outcome is the kernel folder workspace
    // with no provider, matching what docs/plugins.md promises.
    const folder = await temporaryDirectory("conflict");
    await writeFile(join(folder, "Model.sysml"), "package m;\n", "utf8");
    const sysideProvider = await providerFor(vi.fn());
    const gitProvider = await gitProviderFor();
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("syside", sysideProvider), contribution("git", gitProvider)],
      logger: { warn: vi.fn() },
    });

    const resolution = await registry.resolve(project(folder));

    expect(resolution).toMatchObject({
      status: "degraded",
      workspaces: [{ path: folder, isMain: true }],
      diagnostics: [{ code: "claim-conflict", tier: "fallback", pluginIds: ["git", "syside"] }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
  });

  it("serves the check schema through the host registry and passes the discovered files to syside", async () => {
    const folder = await temporaryDirectory("registry");
    await mkdir(join(folder, "parts"), { recursive: true });
    await writeFile(join(folder, "Model.sysml"), "package m;\n", "utf8");
    await writeFile(join(folder, "parts", "Wing.sysml"), "", "utf8");
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>(() => Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: "Model.sysml:1:1: error: Broken model\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const workspaceProvider = await providerFor(execFile);
    const registry = new WorkspaceProviderRegistry({
      contributions: [contribution("syside", workspaceProvider)],
      logger: { warn: vi.fn() },
    });
    const input = project(folder);

    const resolution = await registry.resolve(input);
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected SysIDE workspace backend");

    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "syside" });
    const result = await registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: SYSIDE_CHECK_OPERATION,
      input: null,
    });

    expect(result).toEqual({ errors: ["Broken model"] });
    expect(execFile).toHaveBeenCalledWith(expect.objectContaining({
      file: "syside",
      args: ["check", "--", "Model.sysml", "parts/Wing.sysml"],
      cwd: folder,
    }));
  });

  it("rejects unsupported operations before invoking a command", async () => {
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>();
    const workspaceProvider = await providerFor(execFile);
    const request = workspaceProvider.request?.bind(workspaceProvider);
    if (request === undefined) throw new Error("Expected SysIDE workspace backend");

    await expect(request({
      project: project("/repo"),
      workspace: providerWorkspace("root", "/repo"),
      operation: "history",
      input: null,
      signal: new AbortController().signal,
    })).rejects.toThrow("Unsupported SysIDE workspace backend operation");
    expect(execFile).not.toHaveBeenCalled();
  });
});

async function providerFor(execFile: ServerPluginActivationContext["execFile"]): Promise<WorkspaceProvider> {
  const activation = await plugin.activate({
    apiVersion: 1,
    pluginId: "syside",
    packageRoot: resolve("pi-web-plugins/syside"),
    logger: {
      debug() { /* no-op */ },
      info() { /* no-op */ },
      warn() { /* no-op */ },
      error() { /* no-op */ },
    },
    settings: {},
    execFile,
    signal: new AbortController().signal,
  });
  const workspaceProvider = activation.workspaceProvider;
  if (workspaceProvider === undefined) throw new Error("Bundled SysIDE did not activate its workspace provider");
  return workspaceProvider;
}

async function gitProviderFor(): Promise<WorkspaceProvider> {
  const execFile = vi.fn<ServerPluginActivationContext["execFile"]>(() => Promise.resolve({
    exitCode: 0,
    signal: null,
    stdout: "true\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  }));
  const activation = await gitPlugin.activate({
    apiVersion: 1,
    pluginId: "git",
    packageRoot: resolve("pi-web-plugins/git"),
    logger: {
      debug() { /* no-op */ },
      info() { /* no-op */ },
      warn() { /* no-op */ },
      error() { /* no-op */ },
    },
    settings: {},
    execFile,
    signal: new AbortController().signal,
  });
  const workspaceProvider = activation.workspaceProvider;
  if (workspaceProvider === undefined) throw new Error("Bundled Git did not activate its workspace provider");
  return workspaceProvider;
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-web-syside-provider-${label}-`));
  tempRoots.push(path);
  return path;
}

function project(path: string): Project {
  return { id: "project-1", name: "Project", path, createdAt: "2026-07-27T00:00:00.000Z" };
}

function contribution(pluginId: string, workspaceProvider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider: workspaceProvider,
  };
}

function providerWorkspace(key: string, path: string): ProviderWorkspace {
  return { key, path, label: key, isMain: true };
}
