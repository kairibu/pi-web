import { api, type Project, type Workspace } from "../api";
import { mergeCachedNewSessions } from "../cachedNewSessions";
import type { GetState, RouteTarget, SetState, UpdateUrl } from "./types";
import type { SessionController } from "./sessionController";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, type WorkspaceSelectionMemory } from "./workspaceSelection";

export class WorkspaceController {
  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessions: SessionController,
    private readonly workspaceSelection: WorkspaceSelectionMemory = new InMemoryWorkspaceSelectionMemory(),
  ) {}

  clearSelection(options?: { updateUrl?: boolean | undefined }) {
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: undefined, selectedWorkspace: undefined, sessions: [], workspaces: [], fileTree: [], expandedDirs: {}, selectedFilePath: undefined, selectedFileContent: undefined, fileTreeStale: false, gitStatus: undefined, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined, gitStale: false, error: "" });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  forgetProject(projectId: string): void {
    this.workspaceSelection.forgetProject(projectId);
    const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([candidate]) => candidate !== projectId));
    this.setState({ workspacesByProjectId });
  }

  async selectProject(project: Project, target?: RouteTarget) {
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: project, selectedWorkspace: undefined, sessions: [], workspaces: [], fileTree: [], expandedDirs: {}, selectedFilePath: undefined, selectedFileContent: undefined, fileTreeStale: false, gitStatus: undefined, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined, gitStale: false, error: "" });
    try {
      const workspaces = await api.workspaces(project.id);
      this.setState({ workspaces, workspacesByProjectId: { ...this.getState().workspacesByProjectId, [project.id]: workspaces } });
      const workspace = selectPreferredWorkspace(workspaces, { targetWorkspaceId: target?.workspaceId, latestWorkspaceId: this.workspaceSelection.latestWorkspaceId(project.id) });
      if (workspace) await this.selectWorkspace(workspace, { sessionId: target?.sessionId, updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectWorkspace(workspace: Workspace, target?: { sessionId?: string | undefined; updateUrl?: boolean | undefined }) {
    this.workspaceSelection.rememberWorkspace(workspace);
    this.sessions.clearActiveSession();
    this.setState({ selectedWorkspace: workspace, sessions: [], fileTree: [], expandedDirs: {}, selectedFilePath: undefined, selectedFileContent: undefined, fileTreeStale: false, gitStatus: undefined, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined, gitStale: false, error: "" });
    try {
      const sessions = mergeCachedNewSessions(workspace.path, await api.sessions(workspace.path));
      this.setState({ sessions });
      const session = this.sessions.preferredSession(workspace.path, sessions, target?.sessionId);
      if (session) await this.sessions.selectSession(session, { updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }
}
