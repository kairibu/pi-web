import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginLogger } from "@jmfederico/pi-web/server-plugin-api";
import {
  SysideModelService,
  type SysideWatcherFactory,
  type SysideWorkspaceWatcher,
} from "./syside-model.js";
import type { SysideWorkerProcess } from "./syside-worker-process.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.useRealTimers();
});

/** Mutable behaviour the auto-responding fake worker reads per request. */
interface WorkerBehaviour {
  checkErrors: string[];
  elements: unknown[];
  detail: unknown;
  survey: unknown;
  failLoad: string | undefined;
  failOps: string | undefined;
}

interface FakeWorkerRequest {
  id: number;
  op: string;
  payload: unknown;
}

/**
 * Fake worker that answers every request automatically from the mutable
 * behaviour, mirroring the real worker's NDJSON protocol.
 */
class AutoRespondWorker implements SysideWorkerProcess {
  readonly pid = 7001;
  readonly stdin = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      this.consume(chunkToString(chunk));
      callback();
    },
  });
  readonly stdout = new Readable({ read: () => undefined });
  readonly stderr = new Readable({ read: () => undefined });
  readonly requests: FakeWorkerRequest[] = [];
  readonly killedSignals: NodeJS.Signals[] = [];
  endCalled = false;
  private readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(public readonly behaviour: WorkerBehaviour) {}

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    // Mirror real signal delivery: the process exits asynchronously after a
    // terminating signal.
    queueMicrotask(() => {
      for (const listener of this.exitListeners) listener(0, signal);
    });
    return true;
  }

  /** Crash the worker as if the Python process died. */
  crash(code = 1): void {
    for (const listener of this.exitListeners) listener(code, null);
  }

  private consume(frame: string): void {
    for (const line of frame.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      const request = requireFakeWorkerRequest(JSON.parse(line));
      this.requests.push(request);
      this.respondTo(request);
    }
  }

  private respondTo(request: FakeWorkerRequest): void {
    const behaviour = this.behaviour;
    if (request.op === "load" && behaviour.failLoad !== undefined) {
      this.errorResponse(request.id, behaviour.failLoad);
      return;
    }
    if (request.op !== "load" && behaviour.failOps !== undefined) {
      this.errorResponse(request.id, behaviour.failOps);
      return;
    }
    switch (request.op) {
      case "load": {
        const payload = requireRecord(request.payload, "load payload");
        const paths = payload["paths"];
        const pathList = Array.isArray(paths) ? paths : [];
        this.successResponse(request.id, { files: pathList.length });
        return;
      }
      case "check":
        this.successResponse(request.id, { errors: behaviour.checkErrors });
        return;
      case "survey":
        this.successResponse(request.id, behaviour.survey);
        return;
      case "list_elements":
        this.successResponse(request.id, behaviour.elements);
        return;
      case "element_details":
        this.successResponse(request.id, behaviour.detail);
        return;
      default:
        this.errorResponse(request.id, `unsupported operation: ${request.op}`);
    }
  }

  private successResponse(id: number, result: unknown): void {
    this.stdout.push(`${JSON.stringify({ id, ok: true, result })}\n`);
  }

  private errorResponse(id: number, message: string): void {
    this.stdout.push(`${JSON.stringify({ id, ok: false, error: message })}\n`);
  }
}

interface FakeWatcher extends SysideWorkspaceWatcher {
  closed: boolean;
  trigger(): void;
}

interface ModelFixture {
  service: SysideModelService;
  spawner: ReturnType<typeof vi.fn>;
  watchers: FakeWatcher[];
  behaviour: WorkerBehaviour;
}

function modelFixture(workerScriptPath = "/unused/syside_worker.py"): ModelFixture {
  const behaviour: WorkerBehaviour = {
    checkErrors: [],
    elements: [],
    detail: {},
    survey: { projectPath: "", packages: [] },
    failLoad: undefined,
    failOps: undefined,
  };
  const spawner = vi.fn(() => new AutoRespondWorker(behaviour));
  const watchers: FakeWatcher[] = [];
  const watcherFactory: SysideWatcherFactory = vi.fn((_workspacePath: string, onChange: () => void) => {
    const watcher: FakeWatcher = {
      closed: false,
      close() {
        this.closed = true;
      },
      trigger() {
        onChange();
      },
    };
    watchers.push(watcher);
    return watcher;
  });
  const service = new SysideModelService({
    workerScriptPath,
    logger: noopLogger,
    spawner,
    watcherFactory,
  });
  return { service, spawner, watchers, behaviour };
}

describe("SysideModelService", () => {
  it("start() validates the bundled worker script exists without starting it", async () => {
    const fixture = modelFixture(join(await temporaryDirectory("start"), "missing.py"));
    await expect(fixture.service.start()).rejects.toThrow("worker script is missing");
    expect(fixture.spawner).not.toHaveBeenCalled();

    const existing = modelFixture("pi-web-plugins/syside/worker/syside_worker.py");
    await expect(existing.service.start()).resolves.toBeUndefined();
    expect(existing.spawner).not.toHaveBeenCalled();
  });

  it("loads the model on the first request for a workspace", async () => {
    const folder = await sysmlWorkspace("first", "package m;");
    const fixture = modelFixture();
    fixture.behaviour.checkErrors = ["Broken model"];

    await expect(fixture.service.check(folder, signal())).resolves.toEqual({ errors: ["Broken model"] });

    const loadRequests = requestsOf(fixture, "load");
    expect(loadRequests).toHaveLength(1);
    const paths = requestPaths(requestAt(loadRequests, 0));
    expect(paths).toEqual([join(folder, "Model.sysml")]);
    expect(fixture.spawner).toHaveBeenCalledTimes(1);
  });

  it("reuses the active model for an unchanged workspace", async () => {
    const folder = await sysmlWorkspace("reuse", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    await fixture.service.check(folder, signal());

    expect(requestsOf(fixture, "load")).toHaveLength(1);
    expect(fixture.spawner).toHaveBeenCalledTimes(1);
  });

  it("replaces the active model when the workspace changes, without a second process", async () => {
    const folderA = await sysmlWorkspace("workspace a", "package a;");
    const folderB = await sysmlWorkspace("workspace b", "package b;");
    const fixture = modelFixture();

    await fixture.service.check(folderA, signal());
    await fixture.service.check(folderB, signal());

    const loads = requestsOf(fixture, "load");
    expect(loads).toHaveLength(2);
    expect(requestPaths(requestAt(loads, 0))).toEqual([join(folderA, "Model.sysml")]);
    expect(requestPaths(requestAt(loads, 1))).toEqual([join(folderB, "Model.sysml")]);
    expect(fixture.spawner).toHaveBeenCalledTimes(1);
  });

  it("reloads from a watcher-dirty signal even when the manifest is unchanged", async () => {
    const folder = await sysmlWorkspace("dirty", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    const watcher = fixture.watchers[0];
    if (watcher === undefined) throw new Error("expected a watcher for the workspace");
    watcher.trigger();
    await fixture.service.check(folder, signal());

    expect(requestsOf(fixture, "load")).toHaveLength(2);
  });

  it("reloads on a manifest change even without a watcher signal", async () => {
    const folder = await sysmlWorkspace("manifest change", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    await writeFile(join(folder, "parts", "Wing.sysml"), "package w;", "utf8");
    await fixture.service.check(folder, signal());

    const loads = requestsOf(fixture, "load");
    expect(loads).toHaveLength(2);
    expect(requestPaths(requestAt(loads, 1))).toEqual([join(folder, "Model.sysml"), join(folder, "parts", "Wing.sysml")]);
  });

  it("reloads when a source file's content changes even without a watcher signal", async () => {
    const folder = await sysmlWorkspace("content change", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    await writeFile(join(folder, "Model.sysml"), "package m { part def Wing; }", "utf8");
    await fixture.service.check(folder, signal());

    expect(requestsOf(fixture, "load")).toHaveLength(2);
  });

  it("serves empty results without starting Python for a workspace without SysML files", async () => {
    const folder = await temporaryDirectory("empty workspace");
    const fixture = modelFixture();

    await expect(fixture.service.check(folder, signal())).resolves.toEqual({ errors: [] });
    await expect(fixture.service.survey(folder, signal())).resolves.toEqual({ projectPath: folder, packages: [] });
    await expect(fixture.service.listElements(folder, {}, signal())).resolves.toEqual([]);
    await expect(fixture.service.elementDetails(folder, ["any", "id"], signal()))
      .rejects.toThrow("No SysML files are loaded for this workspace; any::id cannot be resolved");
    expect(fixture.spawner).not.toHaveBeenCalled();
  });

  it("loads a model once the workspace gains SysML files", async () => {
    const folder = await temporaryDirectory("gains sysml");
    const fixture = modelFixture();

    await expect(fixture.service.check(folder, signal())).resolves.toEqual({ errors: [] });
    await writeFile(join(folder, "Model.sysml"), "package m;", "utf8");
    await fixture.service.check(folder, signal());

    expect(requestsOf(fixture, "load")).toHaveLength(1);
    expect(fixture.spawner).toHaveBeenCalledTimes(1);
  });

  it("retires the active model when the worker dies while idle and reloads on the next request", async () => {
    const folder = await sysmlWorkspace("idle crash", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    const firstWorker = requireFakeWorker(fixture.spawner);
    firstWorker.crash(1);

    await fixture.service.check(folder, signal());
    expect(fixture.spawner).toHaveBeenCalledTimes(2);
    expect(requestsOf(fixture, "load")).toHaveLength(2);
  });

  it("clears the active model when a worker request fails and reloads on the next request", async () => {
    const folder = await sysmlWorkspace("worker failure", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    fixture.behaviour.failOps = "worker exploded";
    await expect(fixture.service.check(folder, signal())).rejects.toThrow("worker exploded");

    fixture.behaviour.failOps = undefined;
    await expect(fixture.service.check(folder, signal())).resolves.toEqual({ errors: [] });
    expect(requestsOf(fixture, "load")).toHaveLength(2);
  });

  it("clears the active model when a load fails and retries the load on the next request", async () => {
    const folder = await sysmlWorkspace("load failure", "package m;");
    const fixture = modelFixture();

    fixture.behaviour.failLoad = "files do not exist";
    await expect(fixture.service.check(folder, signal())).rejects.toThrow("files do not exist");

    fixture.behaviour.failLoad = undefined;
    await expect(fixture.service.check(folder, signal())).resolves.toEqual({ errors: [] });
    expect(requestsOf(fixture, "load")).toHaveLength(2);
  });

  it("routes survey, list-elements, and element-details through the worker and validates result shapes", async () => {
    const folder = await sysmlWorkspace("routing", "package m { part def Wing; }");
    const fixture = modelFixture();
    fixture.behaviour.survey = {
      projectPath: "",
      packages: [
        {
          declared_name: "m",
          qualified_name: ["m"],
          element_counts: {
            "syside.PartUsage": 0,
            "syside.PartDefinition": 1,
            "syside.RequirementUsage": 0,
            "syside.RequirementDefinition": 0,
            "syside.ActionUsage": 0,
            "syside.ActionDefinition": 0,
            "syside.PortUsage": 0,
            "syside.PortDefinition": 0,
            "syside.InterfaceUsage": 0,
            "syside.InterfaceDefinition": 0,
          },
        },
      ],
    };
    fixture.behaviour.elements = [{
      type: "syside.PartDefinition",
      declared_name: "Wing",
      qualified_name: ["m", "Wing"],
      declared_short_name: null,
    }];
    fixture.behaviour.detail = {
      type: "syside.PartDefinition",
      declared_name: "Wing",
      qualified_name: ["m", "Wing"],
      declared_short_name: null,
      documentation: null,
      heritage: null,
      subsetting: null,
      filepath: join(folder, "Model.sysml"),
      subject: null,
      inputs: null,
      outputs: null,
      nested_ports: null,
      nested_actions: null,
      nested_flows: null,
      owned_elements: null,
    };

    await expect(fixture.service.survey(folder, signal())).resolves.toEqual({
      projectPath: folder,
      packages: [
        {
          declared_name: "m",
          qualified_name: ["m"],
          element_counts: {
            "syside.PartUsage": 0,
            "syside.PartDefinition": 1,
            "syside.RequirementUsage": 0,
            "syside.RequirementDefinition": 0,
            "syside.ActionUsage": 0,
            "syside.ActionDefinition": 0,
            "syside.PortUsage": 0,
            "syside.PortDefinition": 0,
            "syside.InterfaceUsage": 0,
            "syside.InterfaceDefinition": 0,
          },
        },
      ],
    });
    await expect(fixture.service.listElements(folder, {}, signal()))
      .resolves.toEqual([{
        type: "syside.PartDefinition",
        declared_name: "Wing",
        qualified_name: ["m", "Wing"],
        declared_short_name: null,
      }]);
    await expect(fixture.service.elementDetails(folder, ["m", "Wing"], signal())).resolves.toMatchObject({
      type: "syside.PartDefinition",
      declared_name: "Wing",
    });

    expect(requestsOf(fixture, "load")).toHaveLength(1);
    expect(requestsOf(fixture, "survey")).toHaveLength(1);
    expect(requestsOf(fixture, "list_elements")).toHaveLength(1);
    expect(requestsOf(fixture, "element_details")).toHaveLength(1);
    const survey = requestAt(requestsOf(fixture, "survey"), 0);
    expect(survey.payload).toBeNull();
    const detail = requestAt(requestsOf(fixture, "element_details"), 0);
    expect(requireRecord(detail.payload, "element_details payload")).toEqual({ qualifiedName: ["m", "Wing"] });
  });

  it("forwards the complete list-elements filter payload to the worker verbatim", async () => {
    const folder = await sysmlWorkspace("filter forwarding", "package m;");
    const fixture = modelFixture();

    await fixture.service.listElements(
      folder,
      { type: "syside.PartUsage", packageQualifiedName: ["m"], search: "win" },
      signal(),
    );

    const request = requestAt(requestsOf(fixture, "list_elements"), 0);
    expect(requireRecord(request.payload, "list_elements payload")).toEqual({
      type: "syside.PartUsage",
      packageQualifiedName: ["m"],
      search: "win",
    });
  });

  it("sends only the defined filter fields to the worker", async () => {
    const folder = await sysmlWorkspace("partial filters", "package m;");
    const fixture = modelFixture();

    await fixture.service.listElements(folder, { search: "wing" }, signal());

    const request = requestAt(requestsOf(fixture, "list_elements"), 0);
    expect(requireRecord(request.payload, "list_elements payload")).toEqual({ search: "wing" });
  });

  it("injects the workspace path into the survey response", async () => {
    const folder = await sysmlWorkspace("survey path", "package m;");
    const fixture = modelFixture();
    fixture.behaviour.survey = { projectPath: "", packages: [] };

    await expect(fixture.service.survey(folder, signal())).resolves.toEqual({ projectPath: folder, packages: [] });
  });

  it("rejects malformed worker results instead of returning them", async () => {
    const folder = await sysmlWorkspace("malformed", "package m;");
    const fixture = modelFixture();
    fixture.behaviour.elements = [{ type: 7, declared_name: "Wing" }];

    await expect(fixture.service.listElements(folder, {}, signal())).rejects.toThrow("type");
  });

  it("rejects malformed survey results instead of returning them", async () => {
    const folder = await sysmlWorkspace("malformed survey", "package m;");
    const fixture = modelFixture();
    fixture.behaviour.survey = { projectPath: "", packages: [{ declared_name: 7 }] };

    await expect(fixture.service.survey(folder, signal())).rejects.toThrow("declared_name");
  });

  it("rejects malformed element-details results instead of returning them", async () => {
    const folder = await sysmlWorkspace("malformed detail", "package m;");
    const fixture = modelFixture();
    fixture.behaviour.detail = {
      type: "syside.PartDefinition",
      declared_name: "Wing",
      qualified_name: ["m", "Wing"],
      declared_short_name: null,
      documentation: "text",
    };

    await expect(fixture.service.elementDetails(folder, ["m", "Wing"], signal())).rejects.toThrow("documentation");
  });

  it("stop() closes the watcher and stops the worker", async () => {
    const folder = await sysmlWorkspace("stop", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    const watcher = fixture.watchers[0];
    if (watcher === undefined) throw new Error("expected a watcher for the workspace");

    await fixture.service.stop();
    expect(watcher.closed).toBe(true);
    const firstWorker = requireFakeWorker(fixture.spawner);
    expect(firstWorker.killedSignals).toContain("SIGTERM");
  });

  it("stop() is safe when no model is active", async () => {
    const fixture = modelFixture();
    await expect(fixture.service.stop()).resolves.toBeUndefined();
  });

  it("rejects requests after stop() instead of respawning Python", async () => {
    const folder = await sysmlWorkspace("stopped", "package m;");
    const fixture = modelFixture();

    await fixture.service.check(folder, signal());
    const workersBeforeStop = fixture.spawner.mock.calls.length;
    expect(workersBeforeStop).toBe(1);

    await fixture.service.stop();
    await expect(fixture.service.check(folder, signal())).rejects.toThrow("stopped");
    await expect(fixture.service.listElements(folder, {}, signal())).rejects.toThrow("stopped");
    expect(fixture.spawner.mock.calls.length).toBe(workersBeforeStop);
  });
});

function requireFakeWorker(spawner: ReturnType<typeof vi.fn>): AutoRespondWorker {
  const value: unknown = spawner.mock.results[0]?.value;
  if (!(value instanceof AutoRespondWorker)) throw new Error("expected the fake worker");
  return value;
}

function requestsOf(fixture: ModelFixture, op: string): FakeWorkerRequest[] {
  const requests: FakeWorkerRequest[] = [];
  for (const result of fixture.spawner.mock.results) {
    const value: unknown = result.value;
    if (value instanceof AutoRespondWorker) {
      requests.push(...value.requests.filter((request) => request.op === op));
    }
  }
  return requests;
}

function requestPaths(request: FakeWorkerRequest): string[] {
  const payload = requireRecord(request.payload, "load payload");
  const paths = payload["paths"];
  if (!Array.isArray(paths)) throw new Error("load payload paths must be an array");
  return paths.filter((path): path is string => typeof path === "string");
}

function requestAt(requests: FakeWorkerRequest[], index: number): FakeWorkerRequest {
  const request = requests[index];
  if (request === undefined) throw new Error(`expected request at index ${String(index)}`);
  return request;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFakeWorkerRequest(value: unknown): FakeWorkerRequest {
  if (!isRecord(value)) throw new Error("worker request must be an object");
  const id = value["id"];
  const op = value["op"];
  const payload = value["payload"];
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("worker request id must be an integer");
  if (typeof op !== "string") throw new Error("worker request op must be a string");
  return { id, op, payload };
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  return chunk instanceof Uint8Array ? chunk.toString() : String(chunk);
}

async function sysmlWorkspace(label: string, content: string): Promise<string> {
  const root = await temporaryDirectory(label);
  await mkdir(join(root, "parts"), { recursive: true });
  await writeFile(join(root, "Model.sysml"), content, "utf8");
  return root;
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-web-syside-model-${label.replaceAll(" ", "-")}-`));
  tempRoots.push(path);
  return path;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const noopLogger: ServerPluginLogger = {
  debug() { /* no-op */ },
  info() { /* no-op */ },
  warn() { /* no-op */ },
  error() { /* no-op */ },
};
