import type {
  CapabilityRequestContext,
  CapabilityWorkspace,
  PiWebServerPlugin,
  ProjectCapability,
  ServerPluginActivationContext,
} from "@jmfederico/pi-web/server-plugin-api";
import { requestSysideCapability } from "./syside-backend.js";
import { discoverSysmlFiles } from "./syside-discovery.js";

/**
 * The host reserves a deterministic local capability id namespace per server
 * plugin. Keep this id stable: it is what the host repeats back on the
 * workspace wire and what the browser panel matches on.
 */
export const SYSIDE_CAPABILITY_ID = "workspace.sysml";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "SysIDE",
  activate(context) {
    return { capabilities: [createSysideCapability(context)] };
  },
};

export default plugin;

/**
 * SysIDE is a non-owning project capability, not a workspace provider. It never
 * participates in workspace ownership and never claims a project, so Git keeps
 * owning Git+SysML repositories while both integrations are exposed on the same
 * workspace with no claim conflict and no degraded workspace.
 */
export function createSysideCapability(context: ServerPluginActivationContext): ProjectCapability {
  return Object.freeze({
    id: SYSIDE_CAPABILITY_ID,
    async probe(workspace: CapabilityWorkspace, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) throw new Error("SysIDE capability probe ended from signal abort");
      // The capability is enabled whenever recursive *.sysml discovery finds a
      // file below the resolved workspace path (the walk skips .git and
      // node_modules and never follows directory symlinks out of the project),
      // so it attaches to Git worktrees and ownerless folders alike.
      return (await discoverSysmlFiles(workspace.path, signal)).length > 0;
    },
    request: (request: CapabilityRequestContext) => requestSysideCapability(context, request),
  });
}
