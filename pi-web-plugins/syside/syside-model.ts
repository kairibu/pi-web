import { watch } from "node:fs";
import { access } from "node:fs/promises";
import type { JsonValue, ServerPluginLogger } from "@jmfederico/pi-web/server-plugin-api";
import {
  parseSysideCheckResponse,
  parseSysideElementDetailsResponse,
  parseSysideListElementsResponse,
  parseSysideSurveyResponse,
  type SysideCheckResponse,
  type SysideListElementsFilter,
  type SysideSurveyResponse,
  type SysMlElement,
  type SysMlElementDetail,
} from "./browser/syside-contract.js";
import { discoverSysmlManifest, type SysideSourceManifest } from "./syside-discovery.js";
import {
  SysideWorkerClient,
  type SysideWorkerClientOptions,
  type SysideWorkerSpawner,
} from "./syside-worker-client.js";

/** One active model slot: the workspace path, manifest, and worker generation it was loaded into. */
interface ActiveModel {
  workspacePath: string;
  manifest: SysideSourceManifest;
  /** Client worker generation at load time; a mismatch means the worker process was replaced. */
  generation: number;
}

/** Narrow watcher seam so tests can drive dirty signals deterministically. */
export interface SysideWorkspaceWatcher {
  close(): void;
}

export type SysideWatcherFactory = (workspacePath: string, onChange: () => void) => SysideWorkspaceWatcher;

export type SysideManifestDiscovery = (root: string, signal?: AbortSignal) => Promise<SysideSourceManifest>;

export interface SysideModelServiceOptions {
  /** Absolute path of the bundled NDJSON worker script. */
  workerScriptPath: string;
  logger: ServerPluginLogger;
  /** Injectable Python process factory (see SysideWorkerClient). */
  spawner?: SysideWorkerSpawner;
  /** Injectable worker client factory for tests. */
  clientFactory?: (options: SysideWorkerClientOptions) => SysideWorkerClient;
  /** Injectable watcher factory; the default watches the workspace recursively. */
  watcherFactory?: SysideWatcherFactory;
  /** Injectable manifest discovery; the default reuses the safe SysML walk. */
  discovery?: SysideManifestDiscovery;
}

/**
 * Single-model SysIDE backend service.
 *
 * Owns one persistent Python worker (through the worker client), the active
 * workspace path, the active source manifest, a dirty flag fed by a watcher for
 * the currently active workspace, and a mutex that serializes the whole
 * discover-compare-load-dispatch flow.
 *
 * The model is loaded lazily: API v1 has no workspace-selection lifecycle hook
 * and `probe()` must stay side-effect-free, so the first capability request for
 * a workspace is what loads (or switches) the model. A workspace switch
 * replaces the active model; it never keeps a second warm model. The Python
 * interpreter stays warm across loads because SysIDE replaces its model in
 * place; on worker failure the service clears its active state so the next
 * request loads a fresh model into a fresh worker.
 */
export class SysideModelService {
  private readonly workerScriptPath: string;
  private readonly logger: ServerPluginLogger;
  private readonly client: SysideWorkerClient;
  private readonly watcherFactory: SysideWatcherFactory;
  private readonly discovery: SysideManifestDiscovery;
  private active: ActiveModel | undefined;
  private watcher: SysideWorkspaceWatcher | undefined;
  private dirty = false;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: SysideModelServiceOptions) {
    this.workerScriptPath = options.workerScriptPath;
    this.logger = options.logger;
    const clientFactory = options.clientFactory ?? ((clientOptions) => new SysideWorkerClient(clientOptions));
    this.client = clientFactory({
      scriptPath: options.workerScriptPath,
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
    });
    this.watcherFactory = options.watcherFactory ?? createDefaultWatcher;
    this.discovery = options.discovery ?? discoverSysmlManifest;
  }

  /** Validate that the bundled Python worker script exists; does not start it. */
  async start(): Promise<void> {
    try {
      await access(this.workerScriptPath);
    } catch {
      throw new Error(`SysIDE Python worker script is missing: ${this.workerScriptPath}`);
    }
  }

  /** Close the workspace watcher and stop the Python worker. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.closeWatcher();
    this.active = undefined;
    await this.client.stop();
  }

  /** Run the `check` capability operation for one workspace. */
  async check(workspacePath: string, signal: AbortSignal): Promise<SysideCheckResponse> {
    return await this.serialize(async (requestSignal) => {
      const manifest = await this.syncModel(workspacePath, requestSignal);
      if (manifest.files.length === 0) return { errors: [] };
      return await this.clientDispatch("check", null, requestSignal, parseSysideCheckResponse);
    }, signal);
  }

  /** Run the `survey` capability operation for one workspace. */
  async survey(workspacePath: string, signal: AbortSignal): Promise<SysideSurveyResponse> {
    return await this.serialize(async (requestSignal) => {
      const manifest = await this.syncModel(workspacePath, requestSignal);
      if (manifest.files.length === 0) return { projectPath: workspacePath, packages: [] };
      const response = await this.clientDispatch("survey", null, requestSignal, parseSysideSurveyResponse);
      // The worker cannot know the canonical workspace path; the service owns it.
      return { ...response, projectPath: workspacePath };
    }, signal);
  }

  /** Run the filtered `list-elements` capability operation for one workspace. */
  async listElements(workspacePath: string, filters: SysideListElementsFilter, signal: AbortSignal): Promise<SysMlElement[]> {
    return await this.serialize(async (requestSignal) => {
      const manifest = await this.syncModel(workspacePath, requestSignal);
      if (manifest.files.length === 0) return [];
      // Build the frame payload with only the defined filter fields: the
      // optional properties of `filters` are not JsonValue-assignable as a
      // whole object (undefined is not JSON).
      const payload: Record<string, JsonValue> = {};
      if (filters.type !== undefined) payload["type"] = filters.type;
      if (filters.packageQualifiedName !== undefined) payload["packageQualifiedName"] = filters.packageQualifiedName;
      if (filters.search !== undefined) payload["search"] = filters.search;
      return await this.clientDispatch("list_elements", payload, requestSignal, parseSysideListElementsResponse);
    }, signal);
  }

  /** Run the `element-details` capability operation for one workspace. */
  async elementDetails(workspacePath: string, qualifiedName: string[], signal: AbortSignal): Promise<SysMlElementDetail> {
    return await this.serialize(async (requestSignal) => {
      const manifest = await this.syncModel(workspacePath, requestSignal);
      if (manifest.files.length === 0) {
        throw new Error(`No SysML files are loaded for this workspace; ${qualifiedName.join("::")} cannot be resolved`);
      }
      const payload: Record<string, JsonValue> = { qualifiedName };
      return await this.clientDispatch("element_details", payload, requestSignal, parseSysideElementDetailsResponse);
    }, signal);
  }

  /**
   * Serialize the whole discover-compare-load-dispatch flow so concurrent
   * capability requests for different workspaces cannot interleave a load with
   * a dispatch. The operation runs only after the previous one settles; an
   * already-aborted request is rejected before it does any work.
   */
  private serialize<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (this.stopped) throw new Error("SysIDE model service is stopped");
    if (signal.aborted) throw abortError(signal);
    const run = this.tail.then(() => {
      if (this.stopped) throw new Error("SysIDE model service is stopped");
      if (signal.aborted) throw abortError(signal);
      return operation(signal);
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Ensure the worker's active model matches the workspace's current SysML
   * manifest, then return that manifest. The request-time manifest comparison
   * is the correctness fallback for missed or coalesced watcher events; the
   * watcher only accelerates reloads for the common editing case.
   */
  private async syncModel(workspacePath: string, signal: AbortSignal): Promise<SysideSourceManifest> {
    const manifest = await this.discovery(workspacePath, signal);
    const active = this.active;
    const changed = this.dirty || active === undefined || !this.modelMatches(active, workspacePath, manifest);
    if (!changed) return manifest;

    if (manifest.files.length === 0) {
      // Empty workspace: no Python model to load. Retire any previous active
      // model so the worker's stale model is never dispatched for this
      // workspace; the worker keeps its previous slot until the next load.
      this.active = { workspacePath, manifest, generation: this.client.generation };
      this.dirty = false;
      this.recreateWatcher(workspacePath);
      return manifest;
    }

    await this.clientLoad(manifest, signal);
    this.active = { workspacePath, manifest, generation: this.client.generation };
    this.dirty = false;
    this.recreateWatcher(workspacePath);
    return manifest;
  }

  /**
   * Issue a Python `load`. Any failure retires the active model: a load error
   * leaves the worker without a model (SysIDE clears its slot on failure) or
   * with a fresh process that has none, so the next request must reload.
   */
  private async clientLoad(manifest: SysideSourceManifest, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.client.request("load", { paths: manifest.absoluteFiles }, signal);
      requireLoadResult(result);
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }

  /**
   * Dispatch one Python operation and validate its result shape. Any failure
   * retires the active model conservatively: the worker may have been poisoned
   * (crash, timeout, abort) or the request may have failed mid-flight, so the
   * next request starts from a fresh manifest comparison.
   */
  private async clientDispatch<T>(
    operation: "check" | "list_elements" | "survey" | "element_details",
    payload: JsonValue,
    signal: AbortSignal,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      return parse(await this.client.request(operation, payload, signal));
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }

  /**
   * Whether the active model was loaded for the same workspace, into the same
   * worker generation, from the same source manifest.
   */
  private modelMatches(active: ActiveModel, workspacePath: string, manifest: SysideSourceManifest): boolean {
    return active.workspacePath === workspacePath
      && active.generation === this.client.generation
      && active.manifest.fingerprint === manifest.fingerprint;
  }

  private recreateWatcher(workspacePath: string): void {
    this.closeWatcher();
    try {
      this.watcher = this.watcherFactory(workspacePath, () => {
        this.dirty = true;
      });
    } catch {
      // The workspace may have vanished between discovery and watching;
      // request-time manifest comparison remains the correctness fallback.
      this.logger.debug("SysIDE could not watch the workspace directory; request-time manifest comparison remains active", { workspacePath });
    }
  }

  private closeWatcher(): void {
    if (this.watcher === undefined) return;
    this.watcher.close();
    this.watcher = undefined;
  }
}

/** Validate the worker's `load` result: a JSON object with an integer `files`. */
function requireLoadResult(value: unknown): void {
  if (!isRecord(value)) throw new Error("SysIDE worker load result must be an object");
  const files = value["files"];
  if (typeof files !== "number" || !Number.isInteger(files)) {
    throw new Error("SysIDE worker load result must include an integer files field");
  }
}

function createDefaultWatcher(workspacePath: string, onChange: () => void): SysideWorkspaceWatcher {
  // Recursive watching is the fast dirty signal for the common editing case;
  // request-time manifest comparison covers any event that is missed.
  const watcher = watch(workspacePath, { recursive: true }, () => { onChange(); });
  watcher.on("error", () => undefined);
  return { close: () => { watcher.close(); } };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("SysIDE model operation aborted", { cause: reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
