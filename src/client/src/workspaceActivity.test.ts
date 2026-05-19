import { describe, expect, it } from "vitest";
import type { Project, Workspace, WorkspaceActivity } from "./api";
import { projectActivityIndicator, workspaceActivityFor, workspaceActivityIndicator } from "./workspaceActivity";

function project(id = "p1", path = "/repo"): Project {
  return { id, name: id, path, createdAt: "now" };
}

function workspace(projectId: string, path: string): Workspace {
  return { id: path, projectId, path, label: path, isMain: path === "/repo", isGitRepo: true, isGitWorktree: true };
}

function activity(cwd: string, patch: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return { cwd, hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "now", ...patch };
}

describe("workspace activity aggregation", () => {
  it("matches activity to workspace paths", () => {
    const ws = workspace("p1", "/repo");
    expect(workspaceActivityFor(ws, { "/repo": activity("/repo") })?.hasSessionActivity).toBe(true);
  });

  it("uses a terminal indicator only when there is no session activity", () => {
    expect(workspaceActivityIndicator(activity("/repo", { hasSessionActivity: false, hasTerminalActivity: true }))).toBe("terminal");
    expect(workspaceActivityIndicator(activity("/repo", { hasSessionActivity: true, hasTerminalActivity: true }))).toBe("session");
    expect(workspaceActivityIndicator(activity("/repo", { hasSessionActivity: false, hasTerminalActivity: false }))).toBeUndefined();
  });

  it("aggregates project activity from known workspaces, including external worktrees", () => {
    expect(projectActivityIndicator(
      project("p1", "/repo"),
      [workspace("p1", "/repo"), workspace("p1", "/tmp/worktree")],
      { "/tmp/worktree": activity("/tmp/worktree") },
    )).toBe("session");
  });

  it("returns a project terminal indicator only when matched workspaces have no session activity", () => {
    expect(projectActivityIndicator(project("p1", "/repo"), [], { "/repo": activity("/repo", { hasSessionActivity: false, hasTerminalActivity: true }) })).toBe("terminal");
    expect(projectActivityIndicator(project("p1", "/repo"), [], { "/repo": activity("/repo", { hasSessionActivity: true, hasTerminalActivity: true }) })).toBe("session");
  });

  it("falls back to project path matching before workspaces have been loaded", () => {
    expect(projectActivityIndicator(project("p1", "/repo"), [], { "/repo/packages/app": activity("/repo/packages/app") })).toBe("session");
    expect(projectActivityIndicator(project("p1", "/repo"), [], { "/other": activity("/other") })).toBeUndefined();
  });
});
