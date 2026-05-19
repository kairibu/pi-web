import type { ActivityIndicatorKind } from "./components/activityBadge";
import type { Project, Workspace, WorkspaceActivity } from "./api";

export function workspaceActivityFor(workspace: Workspace, activities: Record<string, WorkspaceActivity>): WorkspaceActivity | undefined {
  return activities[workspace.path];
}

export function workspaceActivityIndicator(activity: WorkspaceActivity | undefined): ActivityIndicatorKind | undefined {
  if (activity?.hasSessionActivity === true) return "session";
  if (activity?.hasTerminalActivity === true) return "terminal";
  return undefined;
}

export function projectActivityIndicator(project: Project, knownWorkspaces: Workspace[], activities: Record<string, WorkspaceActivity>): ActivityIndicatorKind | undefined {
  const matched = matchedProjectActivities(project, knownWorkspaces, activities);
  if (matched.some((activity) => activity.hasSessionActivity)) return "session";
  if (matched.some((activity) => activity.hasTerminalActivity)) return "terminal";
  return undefined;
}

function matchedProjectActivities(project: Project, knownWorkspaces: Workspace[], activities: Record<string, WorkspaceActivity>): WorkspaceActivity[] {
  const knownWorkspacePaths = new Set(knownWorkspaces.filter((workspace) => workspace.projectId === project.id).map((workspace) => workspace.path));
  const matched = new Map<string, WorkspaceActivity>();
  for (const path of knownWorkspacePaths) {
    const activity = activities[path];
    if (activity !== undefined) matched.set(activity.cwd, activity);
  }
  for (const activity of Object.values(activities)) {
    if (activity.cwd === project.path || activity.cwd.startsWith(`${project.path}/`)) matched.set(activity.cwd, activity);
  }
  return [...matched.values()];
}
