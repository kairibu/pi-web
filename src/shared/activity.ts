import type { SessionActivity, SessionStatus, WorkspaceActivity } from "./apiTypes.js";

export function isSessionActive(status?: SessionStatus, activity?: SessionActivity): boolean {
  return activity?.phase === "active"
    || status?.isStreaming === true
    || status?.isBashRunning === true
    || status?.isCompacting === true
    || (status?.pendingMessageCount ?? 0) > 0;
}

export function sessionActivityLabel(status?: SessionStatus, activity?: SessionActivity): string | undefined {
  if (activity?.phase === "active") return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
  if (status === undefined) return undefined;
  if (status.isCompacting) return "compacting";
  if (status.isBashRunning) return "bash";
  if (status.isStreaming) return "streaming";
  if (status.pendingMessageCount > 0) return `${String(status.pendingMessageCount)} pending`;
  return undefined;
}

export function isWorkspaceActivityActive(activity: WorkspaceActivity | undefined): boolean {
  return activity !== undefined && (activity.hasSessionActivity || activity.hasTerminalActivity);
}
