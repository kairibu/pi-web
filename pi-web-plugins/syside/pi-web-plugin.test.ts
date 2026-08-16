// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JsonValue,
  PluginRuntimeContext,
  Workspace,
  WorkspaceBackend,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import plugin from "./browser/pi-web-plugin.js";

const projectId = "project-1";
const workspaceId = "workspace-1";

const sysideWorkspace: Workspace = {
  id: workspaceId,
  projectId,
  path: "/model",
  label: "Project",
  isMain: true,
  capabilities: [{ pluginId: "syside", id: "workspace.sysml" }],
};

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe("bundled SysIDE browser plugin", () => {
  it("contributes a view action and a refresh action plus the SysIDE panel", async () => {
    const contributions = activate("syside");
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected SysIDE workspace panel");
    const backend = backendFixture();
    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>(() => panel.onInvalidate?.(panelContext(backend.request)));
    const runtime = runtimeContext({ selectMainView, refreshWorkspacePanels });

    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.syside", "workspace.refresh-syside"]);
    expect(panel.id).toBe("workspace.syside");
    expect(panel.title).toBe("SysIDE");
    expect(panel.order).toBe(30);
    expect(panel.icon).toBeDefined();
    expect(panel.visible?.(panelContext(backend.request))).toBe(true);
    expect(panel.visible?.(panelContext(backend.request, {
      ...sysideWorkspace,
      capabilities: [{ pluginId: "jj", id: "workspace.other" }],
    }))).toBe(false);

    const goTo = contributions.actions?.find((action) => action.id === "view.syside");
    const refresh = contributions.actions?.find((action) => action.id === "workspace.refresh-syside");
    expect(goTo?.shortcut).toBe("mod+5");
    expect(goTo?.enabled?.(runtime)).toBe(true);
    await goTo?.run(runtime);
    expect(selectMainView).toHaveBeenCalledWith("syside:workspace.syside");

    await refresh?.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("syside:workspace.syside");
    expect(backend.request).toHaveBeenCalledWith("check", null);
  });

  it("uses source identity for ownership and runtime identity for the qualified panel", async () => {
    const runtimePluginId = "machine.72656d6f74652d31.syside";
    const contributions = activate("syside", runtimePluginId);
    const panel = requiredPanel(contributions);

    expect(panel.visible?.(panelContext(backendFixture().request))).toBe(true);
    expect(panel.visible?.(panelContext(backendFixture().request, {
      ...sysideWorkspace,
      capabilities: [{ pluginId: runtimePluginId, id: "workspace.sysml" }],
    }))).toBe(false);

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const action = contributions.actions?.find((candidate) => candidate.id === "view.syside");
    await action?.run(runtimeContext({ selectMainView }));
    expect(selectMainView).toHaveBeenCalledWith(`${runtimePluginId}:workspace.syside`);
  });

  it("runs a check on connection and renders only error messages as direct syside-split children", async () => {
    const backend = backendFixture({ errors: ["Unknown reference 'Wing'", "Duplicate name 'Tail'"] });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("check", null);
    expect(container.querySelector(".syside-panel .syside-toolbar-actions")).not.toBeNull();
    const split = container.querySelector(".syside-panel .syside-split");
    if (split === null) throw new Error("Expected syside-split under .syside-panel");
    expect(split.querySelector("div")).toBeNull();
    const messages = [...split.children];
    expect(messages.map((node) => node.tagName)).toEqual(["P", "P"]);
    expect([...split.querySelectorAll("p.syside-error-message")].map((node) => node.textContent)).toEqual([
      "Unknown reference 'Wing'",
      "Duplicate name 'Tail'",
    ]);

    const styleRules = (container.querySelector("style")?.textContent ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("{"));
    expect(styleRules).toContainEqual(expect.stringContaining(".syside-panel .syside-split"));
    expect(styleRules.every((rule) => rule.startsWith(".syside-panel"))).toBe(true);
    render(null, container);
  });

  it("produces an empty syside-split when the check reports no errors", async () => {
    const backend = backendFixture({ errors: [] });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const split = container.querySelector(".syside-panel .syside-split");
    if (split === null) throw new Error("Expected syside-split under .syside-panel");
    expect(split.textContent.trim()).toBe("");
    expect(split.querySelectorAll("p,div")).toHaveLength(0);
    render(null, container);
  });

  it("renders backend failures in a top-level alert and re-runs the check from the toolbar button", async () => {
    const backend = backendFixture();
    backend.state.failures = 1;
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    await settleBackend();

    expect(container.querySelector(".syside-error[role='alert']")?.textContent).toContain("syside check failed");
    // A failed auto-check must not retry on its own (the activity element only
    // connects once); the next render re-commits properties without re-connecting.
    expect(backend.request).toHaveBeenCalledTimes(1);

    backend.state.failures = 0;
    backend.state.errors = ["New error"];
    button(container, "Check").click();
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".syside-error[role='alert']")).toBeNull();
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["New error"]);
    render(null, container);
  });

  it("does not auto-re-run a failed check on a real host re-render (no infinite retry loop)", async () => {
    const backend = backendFixture();
    // Always fail: the reporter's critical defect is specifically the failed-check loop.
    backend.state.failures = Number.POSITIVE_INFINITY;
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    document.body.append(container);

    let renderCount = 0;
    // Simulate the host's re-render loop (PiWebApp wires requestRender to Lit's
    // requestUpdate, which schedules asynchronously and reconciles the panel in
    // place): requestRender re-renders the panel without recreating the activity
    // element. A failed check calls requestRender from its `.finally`, so an
    // unguarded activity element would re-connect and start another failing
    // check, retrying forever. Cap re-renders so a regression fails deterministically
    // (the request count stays > 1) instead of hanging the suite.
    const context = panelContext(backend.request, sysideWorkspace, "local", () => {
      renderCount += 1;
      if (renderCount <= 5 && container.isConnected) queueMicrotask(() => render(panel.render(context), container));
    });

    render(panel.render(context), container);
    await settleBackend();
    await settleBackend();

    expect(container.querySelector(".syside-error[role='alert']")?.textContent).toContain("syside check failed");
    // Only the initial auto-check; the failure-triggered re-renders must not
    // start any further checks.
    expect(backend.request).toHaveBeenCalledTimes(1);

    // The toolbar still drives an explicit re-check.
    button(container, "Check").click();
    await settleBackend();
    expect(backend.request).toHaveBeenCalledTimes(2);
    render(null, container);
  });

  it("scopes cached state by machine and evicts old workspaces", async () => {
    const panel = requiredPanel(activate("syside"));
    const localBackend = backendFixture({ errors: ["local error"] });
    const localContext = panelContext(localBackend.request, sysideWorkspace, "local");
    const remoteBackend = backendFixture({ errors: ["remote error"] });
    const remoteContext = panelContext(remoteBackend.request, sysideWorkspace, "remote-1");
    await panel.onInvalidate?.(localContext);
    await panel.onInvalidate?.(remoteContext);

    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(localContext), container);
    await settleBackend();
    // Machine-scoped keys keep each machine's cached outcome, so reconnecting
    // with a result already present does not re-run the check.
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["local error"]);
    expect(localBackend.request).toHaveBeenCalledTimes(1);
    render(panel.render(remoteContext), container);
    await settleBackend();
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["remote error"]);
    expect(remoteBackend.request).toHaveBeenCalledTimes(1);
    render(null, container);

    // Evict: traverse well beyond the intentionally small workspace-state cache.
    for (let index = 1; index <= 16; index += 1) {
      const backend = backendFixture({ errors: [] });
      await panel.onInvalidate?.(panelContext(backend.request, { ...sysideWorkspace, id: `bounded-${String(index)}` }));
    }

    // The oldest local state was evicted, so reconnecting re-runs the check
    // instead of restoring the cached result.
    render(panel.render(localContext), container);
    await settleBackend();
    await settleBackend();
    expect(localBackend.request).toHaveBeenCalledTimes(2);
    render(null, container);
  });
});

function activate(pluginId: string, runtimePluginId = pluginId) {
  return plugin.activate({ apiVersion: 2, pluginId, runtimePluginId, html, svg }).contributions;
}

function requiredPanel(contributions: ReturnType<typeof activate>) {
  const panel = contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected SysIDE workspace panel");
  return panel;
}

function backendFixture(seed: { errors?: string[] } = {}) {
  const state = {
    errors: seed.errors ?? ["Unknown reference 'Wing'"],
    failures: 0,
  };
  const request = vi.fn((operation: string): Promise<JsonValue> => {
    if (operation !== "check") return Promise.reject(new Error(`Unexpected operation: ${operation}`));
    if (state.failures > 0) {
      state.failures -= 1;
      return Promise.reject(new Error("syside check failed"));
    }
    return Promise.resolve({ errors: [...state.errors] });
  });
  return { request, state };
}

function panelContext(request: WorkspaceBackend["request"] | undefined, workspace = sysideWorkspace, machineId = "local", hostRequestRender: () => void = () => undefined): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "syside:workspace.syside", mainView: "syside:workspace.syside" },
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    ...(request === undefined ? {} : { backend: { request } }),
    host: { requestRender: hostRequestRender },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
}

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: { selectedWorkspace: sysideWorkspace, workspaceTool: "syside:workspace.syside", mainView: "syside:workspace.syside" },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim().includes(text));
  if (found === undefined) throw new Error(`Expected button ${text}; rendered text: ${container.textContent ?? ""}`);
  return found;
}

async function settleBackend(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}