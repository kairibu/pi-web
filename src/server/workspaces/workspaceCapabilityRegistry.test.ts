import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityRequestContext, JsonValue, ProjectCapability, ProviderRequestContext, WorkspaceProvider } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import type { ServerPluginCapabilityContribution, ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import {
  eligibleCapabilityContributions,
  WorkspaceCapabilityRegistry,
} from "./workspaceCapabilityRegistry.js";
import { WorkspaceProviderRegistry } from "./workspaceProviderRegistry.js";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: hostPath("/repo"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

function hostPath(path: string): string {
  return resolve(path);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceCapabilityRegistry", () => {
  it("attaches every capability that applies to a workspace path and skips the rest", async () => {
    const sysml = capabilityContribution("syside", capability("workspace.sysml", () => true));
    const other = capabilityContribution("linter", capability("workspace.lint", (path) => path === hostPath("/repo")));
    const registry = new WorkspaceCapabilityRegistry({ contributions: [sysml, other], logger: { warn: vi.fn() } });

    await expect(registry.capabilitiesForPath(hostPath("/repo"))).resolves.toEqual([
      { pluginId: "linter", id: "workspace.lint", revision: "1" },
      { pluginId: "syside", id: "workspace.sysml", revision: "1" },
    ]);
    await expect(registry.capabilitiesForPath(hostPath("/elsewhere"))).resolves.toEqual([
      { pluginId: "syside", id: "workspace.sysml", revision: "1" },
    ]);
    await expect(registry.capabilitiesForPath("")).resolves.toEqual([]);
  });

  it("tolerates failing probes by skipping the capability and warning", async () => {
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [
        capabilityContribution("broken", capability("workspace.broken", () => Promise.reject(new Error("probe blew up")))),
        capabilityContribution("fine", capability("workspace.fine", () => Promise.resolve(true))),
      ],
      logger: { warn: vi.fn() },
    });

    await expect(registry.capabilitiesForPath(hostPath("/repo"))).resolves.toEqual([
      { pluginId: "fine", id: "workspace.fine", revision: "1" },
    ]);
  });

  it("dispatches a non-owner capability request for an attached workspace path", async () => {
    const request = vi.fn(() => Promise.resolve({ errors: ["Broken model"] }));
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), request))],
      logger: { warn: vi.fn() },
    });

    const result = await registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: null,
    });

    expect(result).toEqual({ errors: ["Broken model"] });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      workspace: { path: hostPath("/repo") },
      operation: "check",
      input: null,
    }));
  });

  it("rejects capability requests that no longer apply to the workspace", async () => {
    const request = vi.fn();
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(false), request))],
      logger: { warn: vi.fn() },
    });

    await expect(registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: null,
    })).rejects.toMatchObject({ code: "operation-unavailable", statusCode: 501 });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects inactive plugins, stale revisions, malformed operations, and invalid input before dispatch", async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), request), "revision-a")],
      logger: { warn: vi.fn() },
    });

    await expect(registry.request({
      pluginId: "missing",
      moduleRevision: "1",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: null,
    })).rejects.toMatchObject({ code: "inactive-plugin", statusCode: 409 });

    await expect(registry.request({
      pluginId: "syside",
      moduleRevision: "stale",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: null,
    })).rejects.toMatchObject({ code: "stale-plugin-revision", statusCode: 409 });

    await expect(registry.request({
      pluginId: "syside",
      moduleRevision: "revision-a",
      workspacePath: hostPath("/repo"),
      operation: "Check!",
      input: null,
    })).rejects.toMatchObject({ code: "invalid-operation", statusCode: 400 });

    await expect(registry.request({
      pluginId: "syside",
      moduleRevision: "revision-a",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: { bad: 1n },
    })).rejects.toMatchObject({ code: "invalid-input", statusCode: 400 });

    expect(request).not.toHaveBeenCalled();
  });

  it("attributes capability handler failures and timeouts", async () => {
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), () => Promise.reject(new Error("check crashed"))))],
      logger: { warn: vi.fn() },
    });

    await expect(registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: null,
    })).rejects.toMatchObject({
      code: "request-failed",
      statusCode: 502,
      message: "Server plugin syside capability operation check failed: check crashed",
    });
  });

  it("bounds hanging capability handlers and aborts their cooperative signal", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), ({ signal }) => new Promise((_resolve, rejectPromise) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          rejectPromise(reason instanceof Error ? reason : new Error("Fixture capability aborted", { cause: reason }));
        }, { once: true });
      })))],
      logger: { warn: vi.fn() },
      requestTimeoutMs: 25,
    });

    const pending = registry.request({
      pluginId: "syside",
      moduleRevision: "1",
      workspacePath: hostPath("/repo"),
      operation: "check",
      input: null,
    });
    const expectation = expect(pending).rejects.toMatchObject({ code: "request-timeout", statusCode: 504 });
    await vi.advanceTimersByTimeAsync(25);
    await expectation;

    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps only healthy and degraded capability contributors", () => {
    const syside = capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true)));
    const linter = capabilityContribution("linter", capability("workspace.lint", () => Promise.resolve(true)));
    const inspections = [
      { pluginId: "syside", health: { status: "degraded" as const } },
      { pluginId: "linter", health: { status: "unhealthy" as const } },
    ];

    expect(eligibleCapabilityContributions([syside, linter], inspections).map(({ pluginId }) => pluginId)).toEqual(["syside"]);
  });
});

describe("WorkspaceProviderRegistry capability attachment and non-owner dispatch", () => {
  it("attaches capabilities to provider workspaces and folder workspaces without changing ownership", async () => {
    const providerRegistry = registryWithCapabilities();
    const resolution = await providerRegistry.resolve(project);
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "owner" });
    expect(resolution.workspaces[0]).toMatchObject({
      path: hostPath("/repo"),
      provider: { pluginId: "owner" },
      capabilities: [{ pluginId: "syside", id: "workspace.sysml" }],
    });

    const folderProject: Project = { ...project, id: "project-2", path: hostPath("/plain") };
    const folderResolution = await providerRegistry.resolve(folderProject);
    expect(folderResolution).toMatchObject({ status: "folder", workspaces: [{ path: hostPath("/plain"), isMain: true }] });
    expect(folderResolution.workspaces[0]).toMatchObject({
      capabilities: [{ pluginId: "syside", id: "workspace.sysml" }],
    });
  });

  it("dispatches capability backend operations for a workspace the plugin does not own", async () => {
    const sysideRequest = vi.fn(() => Promise.resolve({ errors: [] }));
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), sysideRequest))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [contribution("owner", ownerProvider())],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });
    const workspaceId = (await providerRegistry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected owner workspace");

    const result = await providerRegistry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "check",
      input: null,
    });

    expect(result).toEqual({ errors: [] });
    expect(sysideRequest).toHaveBeenCalledWith(expect.objectContaining({ workspace: { path: hostPath("/repo") } }));
  });

  it("keeps owner-only dispatch for the owning plugin and owner-mismatch for non-capability plugins", async () => {
    const ownerRequest = vi.fn(() => Promise.resolve({ ok: true }));
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), () => Promise.resolve({ errors: [] })))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [contribution("owner", ownerProvider(ownerRequest))],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });
    const workspaceId = (await providerRegistry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected owner workspace");

    await expect(providerRegistry.request({
      pluginId: "owner",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "cards.summary",
      input: null,
    })).resolves.toEqual({ ok: true });
    expect(ownerRequest).toHaveBeenCalledTimes(1);

    await expect(providerRegistry.request({
      pluginId: "ghost",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "cards.summary",
      input: null,
    })).rejects.toMatchObject({ code: "inactive-plugin", statusCode: 409 });
  });
});

describe("WorkspaceCapabilityRegistry probe cache", () => {
  it("reuses a successful probe within the cache window and re-probes after expiry", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => Promise.resolve(true));
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", probe))],
      logger: { warn: vi.fn() },
      probeCacheTtlMs: 1_000,
    });

    await registry.capabilitiesForPath(hostPath("/repo"));
    await registry.capabilitiesForPath(hostPath("/repo"));
    expect(probe).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1_001);
    await registry.capabilitiesForPath(hostPath("/repo"));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps failed probes uncached so a later probe retries", async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error("probe blew up"))
      .mockResolvedValueOnce(true);
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", probe))],
      logger: { warn: vi.fn() },
    });

    await expect(registry.capabilitiesForPath(hostPath("/repo"))).resolves.toEqual([]);
    await expect(registry.capabilitiesForPath(hostPath("/repo"))).resolves.toEqual([
      { pluginId: "syside", id: "workspace.sysml", revision: "1" },
    ]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("bounds the probe cache by evicting the oldest inserted entry", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const registry = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", probe))],
      logger: { warn: vi.fn() },
      probeCacheMaxEntries: 2,
    });

    await registry.capabilitiesForPath(hostPath("/a"));
    await registry.capabilitiesForPath(hostPath("/b"));
    await registry.capabilitiesForPath(hostPath("/c"));
    expect(probe).toHaveBeenCalledTimes(3);

    await registry.capabilitiesForPath(hostPath("/a"));
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe("WorkspaceProviderRegistry capability dispatch on ownerless and degraded workspaces", () => {
  it("dispatches a non-owner capability operation against an ownerless folder workspace", async () => {
    const sysideRequest = vi.fn(() => Promise.resolve({ errors: [] }));
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), sysideRequest))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [contribution("passing", { probe: () => Promise.resolve("pass"), list: () => Promise.resolve([]) })],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });

    const resolution = await providerRegistry.resolve(project);
    expect(resolution).toMatchObject({ status: "folder" });
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");

    await expect(providerRegistry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "check",
      input: null,
    })).resolves.toEqual({ errors: [] });
    expect(sysideRequest).toHaveBeenCalledWith(expect.objectContaining({ workspace: { path: hostPath("/repo") } }));
  });

  it("dispatches a non-owner capability against the folder workspace when ownership is a claim conflict", async () => {
    const sysideRequest = vi.fn(() => Promise.resolve({ errors: ["Conflict still checked"] }));
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), sysideRequest))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [
        contribution("one", ownerProvider()),
        contribution("two", ownerProvider()),
      ],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });

    const resolution = await providerRegistry.resolve(project);
    expect(resolution).toMatchObject({ status: "degraded", diagnostics: [{ code: "claim-conflict", pluginIds: ["one", "two"] }] });
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected degraded folder workspace");

    await expect(providerRegistry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "check",
      input: null,
    })).resolves.toEqual({ errors: ["Conflict still checked"] });
  });

  it("still rejects an owner-intent operation when ownership is a claim conflict", async () => {
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true)))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [
        contribution("one", ownerProvider()),
        contribution("two", ownerProvider()),
      ],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });

    const workspaceId = (await providerRegistry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected degraded folder workspace");
    await expect(providerRegistry.request({
      pluginId: "one",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "cards.summary",
      input: null,
    })).rejects.toMatchObject({ code: "owner-conflict", statusCode: 409 });
  });

  it("dispatches a non-owner capability against the folder workspace when the owner's listing fails", async () => {
    const sysideRequest = vi.fn(() => Promise.resolve({ errors: ["Degraded owner"] }));
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true), sysideRequest))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [contribution("owner", {
        probe: () => Promise.resolve("claim"),
        list: () => Promise.reject(new Error("listing broke")),
      })],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });

    const resolution = await providerRegistry.resolve(project);
    expect(resolution).toMatchObject({ status: "degraded", diagnostics: [{ code: "list-failed", pluginId: "owner", message: "listing broke" }] });
    const workspaceId = resolution.workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected degraded folder workspace");

    await expect(providerRegistry.request({
      pluginId: "syside",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "check",
      input: null,
    })).resolves.toEqual({ errors: ["Degraded owner"] });
  });

  it("keeps an owner list failure fatal for the owning plugin", async () => {
    const capabilities = new WorkspaceCapabilityRegistry({
      contributions: [capabilityContribution("syside", capability("workspace.sysml", () => Promise.resolve(true)))],
      logger: { warn: vi.fn() },
    });
    const providerRegistry = new WorkspaceProviderRegistry({
      contributions: [contribution("owner", {
        probe: () => Promise.resolve("claim"),
        list: () => Promise.reject(new Error("listing broke")),
      })],
      capabilities,
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });

    const workspaceId = (await providerRegistry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected degraded folder workspace");
    await expect(providerRegistry.request({
      pluginId: "owner",
      moduleRevision: "1",
      project,
      workspaceId,
      operation: "cards.summary",
      input: null,
    })).rejects.toMatchObject({ code: "resolution-failed", statusCode: 502 });
  });
});

function registryWithCapabilities(): WorkspaceProviderRegistry {
  const capabilities = new WorkspaceCapabilityRegistry({
    contributions: [capabilityContribution("syside", capability("workspace.sysml", (path) => Promise.resolve(path === hostPath("/repo") || path === hostPath("/plain"))))],
    logger: { warn: vi.fn() },
  });
  return new WorkspaceProviderRegistry({
    contributions: [contribution("owner", ownerProvider())],
    capabilities,
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function ownerProvider(request: (context: ProviderRequestContext) => Promise<JsonValue> = () => Promise.resolve({ ok: true })): WorkspaceProvider {
  return {
    probe: (project) => Promise.resolve(project.path === hostPath("/repo") ? "claim" : "pass"),
    list: () => Promise.resolve([{ key: "root", path: hostPath("/repo"), label: "root", isMain: true }]),
    request,
  };
}

function capability(
  id: string,
  probe: (path: string) => boolean | Promise<boolean>,
  request?: (context: CapabilityRequestContext) => Promise<JsonValue>,
): ProjectCapability {
  return {
    id,
    probe: (workspace) => Promise.resolve(probe(workspace.path)),
    request: (context) => {
      if (request === undefined) return Promise.reject(new Error(`Unexpected capability operation: ${context.operation}`));
      return request(context);
    },
  };
}

function capabilityContribution(pluginId: string, projectCapability: ProjectCapability, moduleRevision = "1"): ServerPluginCapabilityContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision,
    capabilityId: projectCapability.id,
    capability: projectCapability,
  };
}

function contribution(pluginId: string, workspaceProvider: WorkspaceProvider, moduleRevision = "1"): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision,
    provider: workspaceProvider,
  };
}
