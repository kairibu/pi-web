import { join } from "node:path";
import type {
  CapabilityRequestContext,
  CapabilityWorkspace,
  PiWebServerPlugin,
  ProjectCapability,
  ServerPluginActivation,
  ServerPluginActivationContext,
} from "@jmfederico/pi-web/server-plugin-api";
import { requestSysideCapability } from "./syside-backend.js";
import { discoverSysmlFiles } from "./syside-discovery.js";
import { SysideModelService } from "./syside-model.js";

/**
 * The host reserves a deterministic local capability id namespace per server
 * plugin. Keep this id stable: it is what the host repeats back on the
 * workspace wire and what the browser panel matches on.
 */
export const SYSIDE_CAPABILITY_ID = "workspace.sysml";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "SysIDE",
  activate: (context) => createSysideServerActivation(context),
};

export default plugin;

/**
 * Activate the SysIDE server entry: create the persistent model service and
 * expose it through the non-owning capability plus the start/stop lifecycle.
 * Activation, start, stop, and request abort signals are scoped to their own
 * invocation and are never retained as plugin-lifetime state.
 */
export function createSysideServerActivation(context: ServerPluginActivationContext): ServerPluginActivation {
  const service = new SysideModelService({
    workerScriptPath: join(context.packageRoot, "worker", "syside_worker.py"),
    logger: context.logger,
  });
  return {
    capabilities: [createSysideCapability(service)],
    start: () => service.start(),
    stop: () => service.stop(),
  };
}

/**
 * SysIDE is a non-owning project capability, not a workspace provider. It never
 * participates in workspace ownership and never claims a project, so Git keeps
 * owning Git+SysML repositories while both integrations are exposed on the same
 * workspace with no claim conflict and no degraded workspace.
 */
export function createSysideCapability(service: SysideModelService): ProjectCapability {
  return Object.freeze({
    id: SYSIDE_CAPABILITY_ID,
    async probe(workspace: CapabilityWorkspace, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) throw new Error("SysIDE capability probe ended from signal abort");
      // The capability is enabled whenever recursive *.sysml discovery finds a
      // file below the resolved workspace path (the walk skips .git and
      // node_modules and never follows directory symlinks out of the project),
      // so it attaches to Git worktrees and ownerless folders alike. Probe is
      // discovery-only: it must stay cheap and side-effect-free because API v1
      // has no workspace-selection hook — the model is loaded on the first
      // capability request for a workspace.
      return (await discoverSysmlFiles(workspace.path, signal)).length > 0;
    },
    request: (request: CapabilityRequestContext) => requestSysideCapability(service, request),
  });
}
