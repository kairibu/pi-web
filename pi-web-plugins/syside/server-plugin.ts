import type {
  PiWebServerPlugin,
  ProjectInput,
  ProviderClaim,
  ProviderRequestContext,
  ProviderWorkspace,
  ServerPluginActivationContext,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import { requestSysideBackend } from "./syside-backend.js";
import { discoverSysmlFiles } from "./syside-discovery.js";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "SysIDE",
  activate(context) {
    return { workspaceProvider: createSysideWorkspaceProvider(context) };
  },
};

export default plugin;

export function createSysideWorkspaceProvider(context: ServerPluginActivationContext): WorkspaceProvider {
  return Object.freeze({
    fallback: true,
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      if (signal.aborted) throw new Error("SysIDE probe ended from signal abort");
      // SysIDE claims every project with SysML files below the folder, including
      // Git repositories (the recursive discovery skips .git subtrees). Because
      // Git also claims such folders, a Git+SysML project resolves to a provider
      // conflict that degrades to a folder workspace unless one of them is disabled.
      return (await discoverSysmlFiles(project.path, signal)).length === 0 ? "pass" : "claim";
    },
    list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
      if (signal.aborted) throw new Error("SysIDE list ended from signal abort");
      return Promise.resolve([{ key: project.path, path: project.path, label: project.name, isMain: true }]);
    },
    request: (request: ProviderRequestContext) => requestSysideBackend(context, request),
  });
}
