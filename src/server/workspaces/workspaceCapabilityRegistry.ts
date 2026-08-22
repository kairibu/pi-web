import type {
  CapabilityRequestContext,
} from "../../server-plugin-api.js";
import type { JsonValue } from "../../shared/apiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import {
  cloneBoundedPluginBackendJson,
  PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
  PLUGIN_BACKEND_REQUEST_TIMEOUT_MS,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
} from "../../shared/pluginBackendProtocol.js";
import type { ServerPluginCapabilityContribution } from "../plugins/serverPluginRuntime.js";
import {
  WorkspaceProviderRequestError,
  type WorkspaceProviderRequestErrorCode,
} from "./workspaceProviderRegistry.js";

const DEFAULT_PROBE_TIMEOUT_MS = PLUGIN_BACKEND_REQUEST_TIMEOUT_MS;
const DEFAULT_REQUEST_TIMEOUT_MS = PLUGIN_BACKEND_REQUEST_TIMEOUT_MS;
const DEFAULT_PROBE_CACHE_TTL_MS = 5_000;
const DEFAULT_PROBE_CACHE_MAX_ENTRIES = 256;

export interface WorkspaceCapabilityRegistryLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface WorkspaceCapabilityRegistryOptions {
  /** Active capability contributions from one immutable server-plugin runtime snapshot. */
  contributions: readonly ServerPluginCapabilityContribution[];
  logger: WorkspaceCapabilityRegistryLogger;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** End-to-end deadline for capability attachment plus one backend request. */
  dispatchTimeoutMs?: number;
  /**
   * How long a successful path probe is reused before it is run again. Set to
   * `0` to disable caching entirely. A bounded cache prevents every workspace
   * resolution and dispatch from re-walking large trees for unchanged paths;
   * dispatch never serves a capability beyond this window on a path it no
   * longer matches. Defaults to `5000` ms.
   */
  probeCacheTtlMs?: number;
  /** Upper bound on cached probe results; the least-recently-inserted entry is evicted first. */
  probeCacheMaxEntries?: number;
}

/** A capability attached to one resolved workspace path. */
export interface AttachedWorkspaceCapability {
  pluginId: string;
  id: string;
  revision: string;
}

interface ProbeCacheEntry {
  applies: boolean;
  expiresAt: number;
}

export interface WorkspaceCapabilityRequest {
  pluginId: string;
  moduleRevision: string;
  /** Absolute path of the resolved workspace the capability is attached to. */
  workspacePath: string;
  operation: string;
  input: unknown;
}

/**
 * Collects non-owning project capabilities contributed by active server plugins
 * and attaches them to resolved workspace paths. Capabilities never probe
 * ownership and never participate in provider resolution: several plugins can
 * attach to the same workspace regardless of which provider (if any) owns it.
 */
export class WorkspaceCapabilityRegistry {
  private readonly contributions: readonly ServerPluginCapabilityContribution[];
  private readonly probeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly probeCacheTtlMs: number;
  private readonly probeCacheMaxEntries: number;
  private readonly probeCache = new Map<string, ProbeCacheEntry>();

  constructor(private readonly options: WorkspaceCapabilityRegistryOptions) {
    this.contributions = Object.freeze([...options.contributions]
      .sort((left, right) => `${left.pluginId}:${left.capabilityId}`.localeCompare(`${right.pluginId}:${right.capabilityId}`)));
    this.probeTimeoutMs = positiveInteger(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, "probeTimeoutMs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.dispatchTimeoutMs = positiveInteger(options.dispatchTimeoutMs, PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS, "dispatchTimeoutMs");
    this.probeCacheTtlMs = nonNegativeInteger(options.probeCacheTtlMs, DEFAULT_PROBE_CACHE_TTL_MS, "probeCacheTtlMs");
    this.probeCacheMaxEntries = positiveInteger(options.probeCacheMaxEntries, DEFAULT_PROBE_CACHE_MAX_ENTRIES, "probeCacheMaxEntries");
  }

  /** Whether any capability contribution exists for the given plugin id. */
  hasContribution(pluginId: string): boolean {
    return this.contributions.some((contribution) => contribution.pluginId === pluginId);
  }

  /**
   * Compute every capability that applies to one resolved workspace path.
   *
   * Each probe is a bounded walk below the workspace path (up to
   * `probeTimeoutMs`), so attaching can be expensive on large trees. Successful
   * probes are cached per path and plugin capability for `probeCacheTtlMs`, so
   * repeated resolutions of the same path reuse the results instead of walking
   * the tree again. Dispatch shares the same cache, keeping attachment and
   * backend dispatch consistent within the cache window.
   */
  async capabilitiesForPath(path: string, parentSignal?: AbortSignal): Promise<readonly AttachedWorkspaceCapability[]> {
    if (path === "") return Object.freeze([]);
    const attached: AttachedWorkspaceCapability[] = [];
    const workspace = Object.freeze({ path });
    for (const contribution of this.contributions) {
      const applies = await this.probeAttach(contribution, workspace, parentSignal);
      if (applies) {
        attached.push(Object.freeze({
          pluginId: contribution.pluginId,
          id: contribution.capabilityId,
          revision: contribution.moduleRevision,
        }));
      }
    }
    return Object.freeze(attached);
  }

  private async probeAttach(
    contribution: ServerPluginCapabilityContribution,
    workspace: CapabilityRequestContext["workspace"],
    parentSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return await this.probeCached(contribution, workspace, parentSignal);
    } catch (error) {
      if (parentSignal?.aborted === true) throw abortError(parentSignal);
      this.options.logger.warn(
        { err: error, pluginId: contribution.pluginId, capabilityId: contribution.capabilityId, operation: "probe" },
        "workspace capability probe failed",
      );
      return false;
    }
  }

  /**
   * Dispatch one bounded capability backend operation for an attached resolved
   * workspace path, re-probing the capability so it is never served for a path
   * it no longer matches. This is a non-owner dispatch: the contributing plugin
   * does not need to own the workspace.
   */
  async request(request: WorkspaceCapabilityRequest, parentSignal?: AbortSignal): Promise<JsonValue> {
    try {
      return await runBoundedCapabilityOperation(
        request.pluginId,
        "dispatch",
        this.dispatchTimeoutMs,
        (signal) => this.dispatchRequest(request, signal),
        parentSignal,
      );
    } catch (error) {
      if (error instanceof WorkspaceCapabilityTimeoutError) {
        throw capabilityRequestError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      if (error instanceof WorkspaceProviderRequestError) throw error;
      throw error;
    }
  }

  private async dispatchRequest(request: WorkspaceCapabilityRequest, dispatchSignal: AbortSignal): Promise<JsonValue> {
    if (!isPiWebPluginId(request.pluginId)) {
      throw capabilityRequestError("inactive-plugin", 409, `Server plugin is not active: ${request.pluginId}`);
    }
    const operation = parseRequestOperation(request.operation);
    const moduleRevision = parseRequestRevision(request.moduleRevision, operation);
    const active = this.contributions.filter((contribution) => contribution.pluginId === request.pluginId);
    if (active.length === 0) {
      throw capabilityRequestError(
        "inactive-plugin",
        409,
        `Server plugin ${request.pluginId} is not active for capability operation ${operation}`,
      );
    }
    if (request.workspacePath === "") {
      throw capabilityRequestError(
        "workspace-not-found",
        404,
        `Workspace not found for server plugin ${request.pluginId} capability operation ${operation}`,
      );
    }

    let input: JsonValue;
    try {
      input = cloneBoundedPluginBackendJson(request.input, `Server plugin ${request.pluginId} capability operation ${operation} input`);
    } catch (error) {
      throw capabilityRequestError("invalid-input", 400, boundedErrorMessage(error), error);
    }

    const workspace = Object.freeze({ path: request.workspacePath });
    // Capability ids own their operation namespaces: within one plugin, each
    // operation must be served by exactly one capability. Dispatch therefore
    // probes capabilities in id order and serves the first match; a capability
    // that probes true but then rejects the operation fails the dispatch rather
    // than falling through to a sibling capability.
    for (const contribution of active) {
      const applies = await this.probeApplied(contribution, workspace, operation, dispatchSignal);
      if (!applies) continue;
      if (contribution.moduleRevision !== moduleRevision) {
        throw capabilityRequestError(
          "stale-plugin-revision",
          409,
          `Server plugin ${request.pluginId} capability backend revision is stale for operation ${operation}; reload after the session daemon restarts`,
        );
      }

      const context: CapabilityRequestContext = Object.freeze({ workspace, operation, input, signal: dispatchSignal });
      let result: unknown;
      try {
        result = await runBoundedCapabilityOperation(
          request.pluginId,
          "request",
          this.requestTimeoutMs,
          (signal) => contribution.capability.request(Object.freeze({ ...context, signal })),
          dispatchSignal,
        );
      } catch (error) {
        if (error instanceof WorkspaceCapabilityTimeoutError) {
          throw capabilityRequestError("request-timeout", 504, boundedErrorMessage(error), error);
        }
        throw capabilityRequestError(
          "request-failed",
          502,
          `Server plugin ${request.pluginId} capability operation ${operation} failed: ${boundedErrorMessage(error)}`,
          error,
        );
      }

      try {
        return cloneBoundedPluginBackendJson(
          result,
          `Server plugin ${request.pluginId} capability operation ${operation} result`,
          PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
        );
      } catch (error) {
        throw capabilityRequestError("invalid-result", 502, boundedErrorMessage(error), error);
      }
    }

    throw capabilityRequestError(
      "operation-unavailable",
      501,
      `Server plugin ${request.pluginId} capability ${operation} is not applicable to this workspace`,
    );
  }

  private async probeApplied(
    contribution: ServerPluginCapabilityContribution,
    workspace: CapabilityRequestContext["workspace"],
    operation: string,
    dispatchSignal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await this.probeCached(contribution, workspace, dispatchSignal);
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      if (error instanceof WorkspaceCapabilityTimeoutError) {
        throw capabilityRequestError("resolution-timeout", 504, boundedErrorMessage(error), error);
      }
      throw capabilityRequestError(
        "resolution-failed",
        502,
        `Server plugin ${contribution.pluginId} capability ${operation} resolution failed: ${boundedErrorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Probe one capability for one workspace path, reusing a fresh cached result
   * when available. Only successful probes are cached; failures and aborts are
   * never cached so a transient problem does not suppress the capability for
   * the whole cache window.
   */
  private async probeCached(
    contribution: ServerPluginCapabilityContribution,
    workspace: CapabilityRequestContext["workspace"],
    parentSignal?: AbortSignal,
  ): Promise<boolean> {
    const key = probeCacheKey(contribution.pluginId, contribution.capabilityId, workspace.path);
    const cached = this.probeCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.applies;

    const applies = await runBoundedCapabilityOperation(
      contribution.pluginId,
      "probe",
      this.probeTimeoutMs,
      (signal) => contribution.capability.probe(workspace, signal),
      parentSignal,
    );
    if (this.probeCacheTtlMs > 0) {
      this.probeCache.set(key, { applies, expiresAt: Date.now() + this.probeCacheTtlMs });
      if (this.probeCache.size > this.probeCacheMaxEntries) {
        const oldest = this.probeCache.keys().next().value;
        if (oldest !== undefined) this.probeCache.delete(oldest);
      }
    }
    return applies;
  }
}

/** Keep only active capability contributions whose bounded health is not unhealthy. */
export function eligibleCapabilityContributions(
  contributions: readonly ServerPluginCapabilityContribution[],
  inspections: readonly { pluginId: string; health: { status: "healthy" | "degraded" | "unhealthy" } }[],
): readonly ServerPluginCapabilityContribution[] {
  const healthByPluginId = new Map(inspections.map(({ pluginId, health }) => [pluginId, health.status]));
  return Object.freeze(contributions.filter(({ pluginId }) => {
    const status = healthByPluginId.get(pluginId);
    return status === "healthy" || status === "degraded";
  }));
}

async function runBoundedCapabilityOperation<T>(
  pluginId: string,
  operation: "probe" | "request" | "dispatch",
  timeoutMs: number,
  callback: (signal: AbortSignal) => T | Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    if (parentSignal !== undefined) controller.abort(abortError(parentSignal));
  };
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeoutError = new WorkspaceCapabilityTimeoutError(`Workspace capability ${pluginId} ${operation} timed out after ${String(timeoutMs)}ms`);
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  const deadline = controller.signal.aborted
    ? Promise.reject(abortError(controller.signal))
    : new Promise<never>((_resolve, rejectPromise) => {
        controller.signal.addEventListener("abort", () => { rejectPromise(abortError(controller.signal)); }, { once: true });
      });
  const result = controller.signal.aborted
    ? new Promise<T>(() => { /* parent deadline already won */ })
    : Promise.resolve().then(() => callback(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (!controller.signal.aborted) controller.abort(new DOMException("Workspace capability operation completed", "AbortError"));
  }
}

function parseRequestOperation(value: string): string {
  try {
    return requirePluginBackendOperation(value);
  } catch (error) {
    throw capabilityRequestError("invalid-operation", 400, boundedErrorMessage(error), error);
  }
}

function parseRequestRevision(value: string, operation: string): string {
  try {
    return requirePluginBackendRevision(value);
  } catch (error) {
    throw capabilityRequestError(
      "stale-plugin-revision",
      409,
      `Plugin capability backend revision is unavailable for operation ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
}

function capabilityRequestError(
  code: WorkspaceProviderRequestErrorCode,
  statusCode: number,
  message: string,
  cause?: unknown,
): WorkspaceProviderRequestError {
  return new WorkspaceProviderRequestError(code, statusCode, message, cause === undefined ? {} : { cause });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Workspace capability operation aborted", { cause: reason });
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${key} must be a non-negative integer`);
  return resolved;
}

function probeCacheKey(pluginId: string, capabilityId: string, path: string): string {
  return `${path}\n${pluginId}\n${capabilityId}`;
}

class WorkspaceCapabilityTimeoutError extends Error {
  override name = "TimeoutError";
}
