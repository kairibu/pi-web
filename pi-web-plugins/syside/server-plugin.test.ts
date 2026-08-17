import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectCapability,
  ServerPluginActivationContext,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import type { Project } from "../../src/shared/apiTypes.js";
import { createServerPluginExecFile } from "../../src/server/plugins/serverPluginExec.js";
import type { ServerPluginCapabilityContribution, ServerPluginProviderContribution } from "../../src/server/plugins/serverPluginRuntime.js";
import { WorkspaceCapabilityRegistry } from "../../src/server/workspaces/workspaceCapabilityRegistry.js";
import { WorkspaceProviderRegistry } from "../../src/server/workspaces/workspaceProviderRegistry.js";
import { SYSIDE_CHECK_OPERATION, SYSIDE_SURVEY_OPERATION } from "./syside-backend.js";
import { SysideModelService } from "./syside-model.js";
import type { SysideWorkerProcess } from "./syside-worker-client.js";
import plugin, { SYSIDE_CAPABILITY_ID, createSysideCapability } from "./server-plugin.js";
import gitPlugin from "../git/server-plugin.js";

const tempRoots: string[] = [];
const gitLocalEnvironmentKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled SysIDE project capability", () => {
  it("is a non-owning capability that attaches to SysML folders and passes plain folders", async () => {
    const plain = await temporaryDirectory("plain");
    const sysml = await temporaryDirectory("claim");
    await writeFile(join(sysml, "Model.sysml"), "package m;\n", "utf8");
    const capability = await capabilityFor(vi.fn());
    const signal = new AbortController().signal;

    expect(capability.id).toBe(SYSIDE_CAPABILITY_ID);
    await expect(capability.probe({ path: plain }, signal)).resolves.toBe(false);
    await expect(capability.probe({ path: sysml }, signal)).resolves.toBe(true);
  });

  it("attaches inside a Git worktree and nested projects without claiming ownership", async () => {
    const repository = await createRepository("git-backed sysml");
    await mkdir(join(repository.path, "sub"), { recursive: true });
    await writeFile(join(repository.path, "Model.sysml"), "package m;\n", "utf8");
    await writeFile(join(repository.path, "sub", "Nested.sysml"), "", "utf8");
    const capability = await capabilityFor(vi.fn());
    const signal = new AbortController().signal;

    await expect(capability.probe({ path: repository.path }, signal)).resolves.toBe(true);
    await expect(capability.probe({ path: join(repository.path, "sub") }, signal)).resolves.toBe(true);
  });

  it("lets Git retain workspace ownership while the SysIDE capability attaches to the worktree workspace", async () => {
    const repository = await createRepository("git plus sysml");
    await writeFile(join(repository.path, "Model.sysml"), "package m;\n", "utf8");
    const sysideCapability = await capabilityFor(vi.fn());
    const gitProvider = await gitProviderFor();
    const registry = registryWith(gitProvider, sysideCapability);
    const input = project(repository.path);

    const resolution = await registry.resolve(input);

    expect(resolution).toMatchObject({
      status: "provider",
      ownerPluginId: "git",
      diagnostics: [],
      workspaces: [{ path: repository.path, isMain: true, capabilities: [{ pluginId: "syside", id: SYSIDE_CAPABILITY_ID }] }],
    });
    expect(resolution.workspaces[0]).toHaveProperty("provider");
  });

  it("serves the check schema through the host registry as a non-owner capability and loads the discovered files into the Python worker", async () => {
    const repository = await createRepository("registry sysml");
    await mkdir(join(repository.path, "parts"), { recursive: true });
    await writeFile(join(repository.path, "Model.sysml"), "package m;\n", "utf8");
    await writeFile(join(repository.path, "parts", "Wing.sysml"), "", "utf8");
    const { sysideCapability, worker } = capabilityWithFakeWorker({ errors: ["Broken model"] });
    const gitProvider = await gitProviderFor();
    const registry = registryWith(gitProvider, sysideCapability);
    const input = project(repository.path);

    const resolution = await registry.resolve(input);
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected Git workspace");

    const result = await registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: SYSIDE_CHECK_OPERATION,
      input: null,
    });

    expect(result).toEqual({ errors: ["Broken model"] });
    const load = worker.requests.find((request) => request.op === "load");
    expect(load).toMatchObject({
      op: "load",
      payload: { paths: [join(repository.path, "Model.sysml"), join(repository.path, "parts", "Wing.sysml")] },
    });
    expect(worker.requests.some((request) => request.op === "check")).toBe(true);
  });

  it("does not dispatch the capability for a workspace where SysML discovery finds nothing", async () => {
    const repository = await createRepository("git only");
    const sysideCapability = await capabilityFor(vi.fn());
    const gitProvider = await gitProviderFor();
    const registry = registryWith(gitProvider, sysideCapability);
    const input = project(repository.path);

    const resolution = await registry.resolve(input);
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "git" });
    expect(resolution.workspaces[0]).not.toHaveProperty("capabilities");

    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected Git workspace");
    await expect(registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: SYSIDE_CHECK_OPERATION,
      input: null,
    })).rejects.toMatchObject({ code: "operation-unavailable", statusCode: 501 });
  });

  it("serves the survey through the host registry and injects the workspace path into the worker response", async () => {
    const repository = await createRepository("registry survey");
    await writeFile(join(repository.path, "Model.sysml"), "package m;\n", "utf8");
    const { sysideCapability, worker } = capabilityWithFakeWorker({ errors: [] });
    const gitProvider = await gitProviderFor();
    const registry = registryWith(gitProvider, sysideCapability);
    const input = project(repository.path);

    const resolution = await registry.resolve(input);
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected Git workspace");

    const result = await registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project: input,
      workspaceId,
      operation: SYSIDE_SURVEY_OPERATION,
      input: null,
    });

    expect(result).toEqual({ projectPath: repository.path, packages: [] });
    const survey = worker.requests.find((request) => request.op === "survey");
    expect(survey).toMatchObject({ op: "survey", payload: null });
  });

  it("rejects unsupported operations before invoking a command", async () => {
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>();
    const capability = await capabilityFor(execFile);

    await expect(capability.request({
      workspace: { path: "/repo" },
      operation: "history",
      input: null,
      signal: new AbortController().signal,
    })).rejects.toThrow("Unsupported SysIDE capability operation");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("aborts the probe from the caller signal", async () => {
    const folder = await temporaryDirectory("abort");
    await writeFile(join(folder, "Model.sysml"), "", "utf8");
    const capability = await capabilityFor(vi.fn());
    const controller = new AbortController();
    controller.abort();

    await expect(capability.probe({ path: folder }, controller.signal)).rejects.toThrow("SysIDE capability probe ended from signal abort");
  });
});

function registryWith(gitProvider: WorkspaceProvider, sysideCapability: ProjectCapability): WorkspaceProviderRegistry {
  const capabilities = new WorkspaceCapabilityRegistry({
    contributions: [capabilityContribution("syside", sysideCapability)],
    logger: { warn: vi.fn() },
  });
  return new WorkspaceProviderRegistry({
    contributions: [contribution("git", gitProvider)],
    capabilities,
    logger: { warn: vi.fn() },
  });
}

async function capabilityFor(execFile: ServerPluginActivationContext["execFile"]): Promise<ProjectCapability> {
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
  const capability = activation.capabilities?.[0];
  if (capability === undefined) throw new Error("Bundled SysIDE did not activate its project capability");
  return capability;
}

/**
 * Build the capability over a model service backed by a fake Python worker, so
 * registry dispatch can be exercised without a Python interpreter.
 */
function capabilityWithFakeWorker(behaviour: { errors: string[] }): {
  sysideCapability: ProjectCapability;
  worker: FakeSysideWorker;
} {
  const worker = new FakeSysideWorker(behaviour);
  const service = new SysideModelService({
    workerScriptPath: resolve("pi-web-plugins/syside/worker/syside_worker.py"),
    logger: {
      debug() { /* no-op */ },
      info() { /* no-op */ },
      warn() { /* no-op */ },
      error() { /* no-op */ },
    },
    spawner: () => worker,
  });
  return { sysideCapability: createSysideCapability(service), worker };
}

/** Minimal NDJSON worker fake answering load, check, survey, and the element operations. */
class FakeSysideWorker implements SysideWorkerProcess {
  readonly pid = 9001;
  readonly requests: { id: number; op: string; payload: unknown }[] = [];
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly stdin = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line.trim() === "") continue;
        const request = requireFakeWorkerRequest(JSON.parse(line));
        this.requests.push(request);
        this.respond(request);
      }
      callback();
    },
  });
  readonly stdout = new Readable({ read: () => undefined });
  readonly stderr = new Readable({ read: () => undefined });
  private readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(private readonly behaviour: { errors: string[] }) {}

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  private respond(request: { id: number; op: string; payload: unknown }): void {
    let result: unknown;
    switch (request.op) {
      case "load":
        result = { files: 1 };
        break;
      case "check":
        result = { errors: this.behaviour.errors };
        break;
      case "survey":
        result = { projectPath: "", packages: [] };
        break;
      case "list_elements":
        result = [];
        break;
      case "element_details":
        result = {
          type: "syside.PartDefinition",
          declared_name: "Wing",
          qualified_name: ["m", "Wing"],
          declared_short_name: null,
          documentation: null,
          heritage: null,
          subsetting: null,
          filepath: "/repo/Model.sysml",
          subject: null,
          inputs: null,
          outputs: null,
        };
        break;
      default:
        result = { errors: this.behaviour.errors };
    }
    this.stdout.push(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  }
}

function requireFakeWorkerRequest(value: unknown): { id: number; op: string; payload: unknown } {
  if (!isRecord(value)) throw new Error("worker request must be an object");
  const id = value["id"];
  const op = value["op"];
  const payload = value["payload"];
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("worker request id must be an integer");
  if (typeof op !== "string") throw new Error("worker request op must be a string");
  return { id, op, payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function gitProviderFor(): Promise<WorkspaceProvider> {
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
    execFile: createServerPluginExecFile({ env: cleanGitEnvironment() }),
    signal: new AbortController().signal,
  });
  const workspaceProvider = activation.workspaceProvider;
  if (workspaceProvider === undefined) throw new Error("Bundled Git did not activate its workspace provider");
  return workspaceProvider;
}

async function createRepository(name: string): Promise<{ parent: string; path: string }> {
  const parent = await temporaryDirectory("repository fixture");
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  runGit(path, ["init", "-b", "main"]);
  await writeFile(join(path, "tracked.txt"), "tracked\n", "utf8");
  runGit(path, ["add", "."]);
  runGit(path, ["-c", "user.name=PI WEB Test", "-c", "user.email=pi-web@example.invalid", "commit", "-m", "initial"]);
  return { parent, path };
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-web-syside-capability-${label.replaceAll(" ", "-")}-`));
  const canonical = await realpath(path);
  tempRoots.push(canonical);
  return canonical;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of gitLocalEnvironmentKeys) Reflect.deleteProperty(env, key);
  return env;
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

function capabilityContribution(pluginId: string, capability: ProjectCapability): ServerPluginCapabilityContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    capabilityId: capability.id,
    capability,
  };
}
