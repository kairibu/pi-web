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
//import { SYSIDE_ELEMENT_TYPES } from "./browser/syside-contract.js";
//import { elementTypeLabel } from "./browser/syside-elements-view.js";
import plugin from "./browser/pi-web-plugin.js";
import { SYSIDE_SEARCH_DEBOUNCE_MS } from "./browser/syside-panel-controller.js";
import type { SysideActionPaletteElement } from "./browser/syside-panel-palette.js";
import type { SysideTooltipElement } from "./browser/syside-tooltip.js";

declare global {
  interface HTMLElementTagNameMap {
    "pi-web-syside-tooltip": SysideTooltipElement;
    "pi-web-syside-action-palette": SysideActionPaletteElement;
  }
}

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
  vi.useRealTimers();
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
    // The connect also loads the model overview survey, hence two calls.
    expect(backend.request).toHaveBeenCalledTimes(2);

    backend.state.failures = 0;
    backend.state.errors = ["New error"];
    button(container, "Check").click();
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledTimes(3);
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
    // start any further checks. The connect also loads the model overview
    // survey, hence two calls.
    expect(backend.request).toHaveBeenCalledTimes(2);

    // The toolbar still drives an explicit re-check.
    button(container, "Check").click();
    await settleBackend();
    expect(backend.request).toHaveBeenCalledTimes(3);
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
    // with a result already present does not re-run the check (only the fresh
    // connect loads the model overview survey, hence two calls).
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["local error"]);
    expect(localBackend.request).toHaveBeenCalledTimes(2);
    render(panel.render(remoteContext), container);
    await settleBackend();
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["remote error"]);
    expect(remoteBackend.request).toHaveBeenCalledTimes(2);
    render(null, container);

    // Evict: traverse well beyond the intentionally small workspace-state cache.
    for (let index = 1; index <= 16; index += 1) {
      const backend = backendFixture({ errors: [] });
      await panel.onInvalidate?.(panelContext(backend.request, { ...sysideWorkspace, id: `bounded-${String(index)}` }));
    }

    // The oldest local state was evicted, so reconnecting re-runs the check
    // and reloads the overview survey instead of restoring the cached result.
    render(panel.render(localContext), container);
    await settleBackend();
    await settleBackend();
    expect(localBackend.request).toHaveBeenCalledTimes(4);
    render(null, container);
  });

  it("opens the element view from the toolbar and returns to the overview/check content", async () => {
    const backend = backendFixture();
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["Unknown reference 'Wing'"]);

    button(container, "Elements").click();
    // Survey and the first unfiltered list request are issued immediately.
    expect(backend.request).toHaveBeenCalledWith("survey", null);
    expect(backend.request).toHaveBeenCalledWith("list-elements", null);
    await settleBackend();
    render(panel.render(context), container);

    const submenu = container.querySelector(".syside-panel .syside-split .syside-elements-submenu");
    if (submenu === null) throw new Error("Expected the element-view submenu inside .syside-split");
    expect(submenu.querySelector("select[aria-label='Element type']")).not.toBeNull();
    expect(submenu.querySelector("select[aria-label='Owning package']")).not.toBeNull();
    expect(submenu.querySelector("input[type='search']")).not.toBeNull();

    // Overview returns to the overview/check split; the cached check result
    // is restored unchanged (it is only hidden, never cleared).
    button(container, "Overview").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-panel .syside-split .syside-elements-submenu")).toBeNull();
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["Unknown reference 'Wing'"]);
    render(null, container);
  });

  it("renders the model overview as a compact package summary list on initial connect", async () => {
    const backend = backendFixture({ errors: [], survey: [packageFixture("m", ["m"]), packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const packages = [...container.querySelectorAll(".syside-panel .syside-package-item")];
    expect(packages).toHaveLength(2);
    const firstPackageLink = packages[0]?.querySelector<HTMLButtonElement>(".syside-package-link");
    expect(firstPackageLink?.textContent).toBe("m");
    const secondPackageLink = packages[1]?.querySelector<HTMLButtonElement>(".syside-package-link");
    expect(secondPackageLink?.textContent).toBe("Cabin");
    expect(secondPackageLink?.getAttribute("title")).toBe("m::Cabin");
    expect(packages[0]?.querySelector(".syside-package-summary")?.textContent).toBe("parts: 1");
    expect(packages[1]?.querySelector(".syside-package-summary")?.textContent).toBe("parts: 1");
    expect(container.querySelectorAll(".syside-package-item .syside-count-value")).toHaveLength(0);
    expect(button(container, "Overview").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "Check").getAttribute("aria-pressed")).toBe("false");
    expect(button(container, "Elements").getAttribute("aria-pressed")).toBe("false");
    render(null, container);
  });

  it("opens the elements view filtered to a package from the overview link", async () => {
    const backend = backendFixture({ errors: [], survey: [packageFixture("m", ["m"]), packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    button(container, "Cabin").click();
    // The package link issues exactly one list request with the package filter
    // and no type key: a plain package click clears any stale type filter.
    expect(backend.request).toHaveBeenCalledWith("list-elements", { packageQualifiedName: ["m", "Cabin"] });
    expect(backend.request.mock.calls.filter(([operation]) => operation === "list-elements")).toHaveLength(1);
    await settleBackend();
    render(panel.render(context), container);

    const submenu = container.querySelector(".syside-panel .syside-split .syside-elements-submenu");
    if (submenu === null) throw new Error("Expected the element-view submenu inside .syside-split");
    expect(button(container, "Elements").getAttribute("aria-pressed")).toBe("true");
    // The <pi-web-syside-select-sync> element schedules a microtask on render
    // to set the filter <select> values after their <option> children commit
    // (Lit binds .value before options exist on the first submenu render).
    await settleBackend();
    const packageSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Owning package']");
    if (packageSelect === null) throw new Error("Expected an owning-package select");
    expect(packageSelect.value).toBe(JSON.stringify(["m", "Cabin"]));
    const typeSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Element type']");
    if (typeSelect === null) throw new Error("Expected an element-type select");
    expect(typeSelect.value).toBe("");
    render(null, container);
  });

  it("opens the elements view filtered to a package and type from a type-count link", async () => {
    const backend = backendFixture({ errors: [], survey: [packageFixture("m", ["m"]), packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const cabinRow = [...container.querySelectorAll(".syside-package-item")].find(
      (row) => row.querySelector(".syside-package-link")?.textContent === "Cabin",
    );
    if (cabinRow === undefined) throw new Error("Expected a Cabin package row");
    const countLink = cabinRow.querySelector<HTMLButtonElement>(".syside-type-count-link");
    if (countLink === null) throw new Error("Expected a type-count link in the Cabin package row");
    countLink.click();

    expect(backend.request).toHaveBeenCalledWith("list-elements", { packageQualifiedName: ["m", "Cabin"], type: "syside.PartUsage" });
    expect(backend.request.mock.calls.filter(([operation]) => operation === "list-elements")).toHaveLength(1);
    await settleBackend();
    render(panel.render(context), container);

    // The <pi-web-syside-select-sync> element schedules a microtask on render
    // to set the filter <select> values after their <option> children commit
    // (see the package-link test).
    await settleBackend();
    const packageSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Owning package']");
    if (packageSelect === null) throw new Error("Expected an owning-package select");
    expect(packageSelect.value).toBe(JSON.stringify(["m", "Cabin"]));
    const typeSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Element type']");
    if (typeSelect === null) throw new Error("Expected an element-type select");
    expect(typeSelect.value).toBe("syside.PartUsage");
    render(null, container);
  });

  it("shows no counted elements when a surveyed package has no non-zero element counts", async () => {
    const backend = backendFixture({
      errors: [],
      survey: [{
        declared_name: "Empty",
        qualified_name: ["Empty"],
        element_counts: {
          "syside.PartUsage": 0,
          "syside.PartDefinition": 0,
          "syside.RequirementUsage": 0,
          "syside.RequirementDefinition": 0,
          "syside.ActionUsage": 0,
          "syside.ActionDefinition": 0,
        },
      }],
    });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const summary = container.querySelector(".syside-package-summary")?.textContent;
    expect(summary).toBe("no counted elements");
    render(null, container);
  });

  it("shows the overview loading state until the survey resolves", async () => {
    let resolveSurvey: ((value: JsonValue) => void) | undefined;
    const surveyPromise = new Promise<JsonValue>((resolve) => { resolveSurvey = resolve; });
    const request = vi.fn((operation: string): Promise<JsonValue> => {
      if (operation === "check") return Promise.resolve({ errors: [] });
      if (operation === "survey") return surveyPromise;
      return Promise.reject(new Error(`Unexpected operation: ${operation}`));
    });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-muted")?.textContent).toContain("Loading overview");

    resolveSurvey?.({ projectPath: "/model", packages: [packageFixture("Cabin", ["m", "Cabin"])] });
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-package-item")).not.toBeNull();
    render(null, container);
  });

  it("falls back to the check result when the survey fails", async () => {
    const backend = backendFixture({ errors: ["Unknown reference 'Wing'"], surveyFailures: 1 });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["Unknown reference 'Wing'"]);
    expect(container.querySelector(".syside-package")).toBeNull();
    expect(container.querySelector(".syside-overview")).toBeNull();
    render(null, container);
  });

  it("returns to the overview from the element view", async () => {
    const backend = backendFixture({ errors: [], survey: [packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    const context = await mountAndOpenElements(panel, backend, container);
    button(container, "Overview").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-elements-submenu")).toBeNull();
    expect(container.querySelector(".syside-package-item")?.textContent).toContain("Cabin");
    render(null, container);
  });

  it("re-runs the check from the toolbar even when the overview has packages", async () => {
    const backend = backendFixture({ errors: ["Unknown reference 'Wing'"], survey: [packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-package-item")).not.toBeNull();

    button(container, "Check").click();
    await settleBackend();
    render(panel.render(context), container);
    expect([...container.querySelectorAll(".syside-error-message")].map((node) => node.textContent)).toEqual(["Unknown reference 'Wing'"]);
    expect(button(container, "Check").getAttribute("aria-pressed")).toBe("true");
    render(null, container);
  });

  it("lists surveyed packages in the owning-package dropdown", async () => {
    const backend = backendFixture({ errors: [], survey: [packageFixture("m", ["m"]), packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    await mountAndOpenElements(panel, backend, container);

    const packageSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Owning package']");
    if (packageSelect === null) throw new Error("Expected an owning-package select");
    expect([...packageSelect.options].map((option) => ({ label: option.textContent, value: option.value }))).toEqual([
      { label: "All packages", value: "" },
      { label: "m", value: '["m"]' },
      { label: "Cabin", value: '["m","Cabin"]' },
    ]);
    render(null, container);
  });

  it("offers a packages-unavailable option when the survey request fails", async () => {
    const backend = backendFixture({ errors: [], surveyFailures: 2 });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    await mountAndOpenElements(panel, backend, container);

    const packageSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Owning package']");
    if (packageSelect === null) throw new Error("Expected an owning-package select");
    expect([...packageSelect.options].map((option) => option.textContent)).toEqual(["Packages unavailable"]);
    expect(packageSelect.disabled).toBe(true);
    expect(container.querySelector(".syside-submenu-error")?.textContent).toContain("syside survey failed");
    render(null, container);
  });

  it("filters by element type through the type dropdown", async () => {
    const backend = backendFixture({ errors: [] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    const context = await mountAndOpenElements(panel, backend, container);

    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Element type']");
    if (select === null) throw new Error("Expected an element-type select");
    select.value = "syside.PartUsage";
    select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("list-elements", { type: "syside.PartUsage" });
    expect(backend.state.lastListInput).toEqual({ type: "syside.PartUsage" });
    // The .value property binding keeps the selection across re-renders.
    expect(select.value).toBe("syside.PartUsage");
    render(null, container);
  });
  it("sends trimmed search text and drops whitespace-only searches", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const backend = backendFixture({ errors: [] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    await mountAndOpenElements(panel, backend, container);

    const input = container.querySelector<HTMLInputElement>("input[type='search']");
    if (input === null) throw new Error("Expected a search input");
    input.value = "  Wing  ";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    // Search refreshes are debounced; advance past the trailing edge.
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS + 1);
    expect(backend.request).toHaveBeenCalledWith("list-elements", { search: "Wing" });

    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS + 1);
    expect(backend.request).toHaveBeenCalledWith("list-elements", null);
    render(null, container);
  });

  it("debounces a keystroke burst into a single trailing list request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const backend = backendFixture({ errors: [] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    await mountAndOpenElements(panel, backend, container);

    const listCalls = () => backend.request.mock.calls.filter(([operation]) => operation === "list-elements").length;
    const before = listCalls();
    const input = container.querySelector<HTMLInputElement>("input[type='search']");
    if (input === null) throw new Error("Expected a search input");
    for (const fragment of ["W", "Wi", "Win", "Wing"]) {
      input.value = fragment;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    // Nothing was issued for the burst itself; only the open's initial request exists.
    expect(listCalls()).toBe(before);
    // The trailing debounce fires exactly one request for the final value.
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS - 1);
    expect(listCalls()).toBe(before);
    await vi.advanceTimersByTimeAsync(2);
    expect(listCalls()).toBe(before + 1);
    expect(backend.request).toHaveBeenLastCalledWith("list-elements", { search: "Wing" });
    render(null, container);
  });

  it("cancels a pending search debounce when leaving the element view", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const backend = backendFixture({ errors: [], survey: [packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    await mountAndOpenElements(panel, backend, container);

    const input = container.querySelector<HTMLInputElement>("input[type='search']");
    if (input === null) throw new Error("Expected a search input");
    input.value = "Wing";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    // Leave the element view before the trailing edge. setView clears the
    // pending debounce so no stale list request can fire for a hidden view
    // (the timer callback has the same guard, so this pins the behavior
    // contract: leaving with a pending search issues nothing extra).
    button(container, "Overview").click();
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS + 1);

    // Only the open's initial unfiltered list request was ever issued.
    expect(backend.request.mock.calls.filter(([operation]) => operation === "list-elements")).toHaveLength(1);
    render(null, container);
  });

  it("composes type, package and search filters into one list request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const backend = backendFixture({ errors: [], survey: [packageFixture("m", ["m"]), packageFixture("Cabin", ["m", "Cabin"])] });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    await mountAndOpenElements(panel, backend, container);

    const packageSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Owning package']");
    if (packageSelect === null) throw new Error("Expected an owning-package select");
    packageSelect.value = JSON.stringify(["m", "Cabin"]);
    packageSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await settleBackend();
    expect(backend.request).toHaveBeenCalledWith("list-elements", { packageQualifiedName: ["m", "Cabin"] });

    const typeSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Element type']");
    if (typeSelect === null) throw new Error("Expected an element-type select");
    typeSelect.value = "syside.PartUsage";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const searchInput = container.querySelector<HTMLInputElement>("input[type='search']");
    if (searchInput === null) throw new Error("Expected a search input");
    searchInput.value = "  Wing  ";
    searchInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    // The type change refreshes immediately; the debounced search trails it
    // with the final trimmed value.
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS + 1);

    expect(backend.state.lastListInput).toEqual({
      type: "syside.PartUsage",
      packageQualifiedName: ["m", "Cabin"],
      search: "Wing",
    });
    render(null, container);
  });

  it("loads and renders details for a selected list row", async () => {
    const backend = backendFixture({
      errors: [],
      elements: [
        elementFixture("syside.PartUsage", "Wing", ["m", "Wing"], null),
        elementFixture("syside.PartDefinition", "Tail", ["m", "Tail"], null),
      ],
    });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    const context = await mountAndOpenElements(panel, backend, container);

    expect([...container.querySelectorAll(".syside-element-row")]).toHaveLength(2);
    button(container, "Wing").click();
    expect(backend.request).toHaveBeenCalledWith("element-details", { qualifiedName: ["m", "Wing"] });
    await settleBackend();
    render(panel.render(context), container);

    expect(container.querySelector(".syside-details-header strong")?.textContent).toBe("m::Wing");
    expect(container.querySelector(".syside-details-filepath")?.textContent).toBe("/model/Model.sysml");
    expect(container.querySelector(".syside-element-row.is-selected")).not.toBeNull();
    // The detail view is split: content on top, the action palette below, with
    // the view toggle inside the palette aside and the header no longer
    // wrapped in the relationship-link tooltip.
    const split = container.querySelector(".syside-elements-details");
    const content = container.querySelector(".syside-details-content");
    const aside = container.querySelector(".syside-action-palette");
    if (split === null || content === null || aside === null) throw new Error("Expected details-content and action-palette split");
    expect(content.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const header = container.querySelector(".syside-details-header");
    if (header === null) throw new Error("Expected a details header");
    expect(header.closest("pi-web-syside-tooltip")).toBeNull();
    expect(aside.querySelector(".syside-view-toggle")).not.toBeNull();
    const palette = container.querySelector<HTMLElementTagNameMap["pi-web-syside-action-palette"]>("pi-web-syside-action-palette");
    if (palette === null) throw new Error("Expected an action palette in the details view");
    expect(palette.qualifiedName).toEqual(["m", "Wing"]);
    expect(palette.filepath).toBe("/model/Model.sysml");
    render(null, container);
  });

  it("inserts investigate and task prompts from the action palette", async () => {
    const backend = backendFixture({
      errors: [],
      elements: [elementFixture("syside.PartUsage", "Wing", ["m", "Wing"], null)],
    });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    const insertText = vi.fn();
    const context = panelContext(backend.request, sysideWorkspace, "local", () => undefined, insertText);
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "Elements").click();
    await settleBackend();
    render(panel.render(context), container);
    button(container, "Wing").click();
    await settleBackend();
    render(panel.render(context), container);

    const palette = container.querySelector<HTMLElementTagNameMap["pi-web-syside-action-palette"]>("pi-web-syside-action-palette");
    if (palette === null) throw new Error("Expected an action palette");
    const investigate = palette.shadowRoot?.querySelector<HTMLButtonElement>(".palette-investigate");
    if (investigate === undefined || investigate === null) throw new Error("Expected an Investigate button in the palette");
    investigate.click();
    expect(insertText).toHaveBeenCalledWith(
      "Investigate m::Wing and summarise its function interfaces and requirements. The element is located in /model/Model.sysml",
    );

    const task = palette.shadowRoot?.querySelector<HTMLButtonElement>(".palette-task");
    if (task === undefined || task === null) throw new Error("Expected a Task button in the palette");
    task.click();
    const input = palette.shadowRoot?.querySelector<HTMLInputElement>(".palette-input");
    if (input === undefined || input === null) throw new Error("Expected a task input in the palette");
    input.value = "Add validation";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(insertText).toHaveBeenLastCalledWith(
      "Perform task \"Add validation\" for element m::Wing. The element is located in /model/Model.sysml",
    );
    render(null, container);
  });

  it("jumps to a related element's details via a heritage link", async () => {
    const linkTarget: JsonValue = {
      type: "syside.PartDefinition",
      declared_name: "Tail",
      qualified_name: ["m", "Tail"],
      declared_short_name: null,
      documentation: ["Tail docs."],
      heritage: null,
      subsetting: null,
      filepath: "/model/Model.sysml",
      subject: null,
      inputs: null,
      outputs: null,
    };
    const wingDetail: JsonValue = {
      type: "syside.PartDefinition",
      declared_name: "Wing",
      qualified_name: ["m", "Wing"],
      declared_short_name: null,
      documentation: ["The wing."],
      heritage: [elementFixture("syside.PartDefinition", "Tail", ["m", "Tail"], null)],
      subsetting: null,
      filepath: "/model/Model.sysml",
      subject: null,
      inputs: null,
      outputs: null,
    };
    const backend = backendFixture({
      errors: [],
      elements: [elementFixture("syside.PartDefinition", "Wing", ["m", "Wing"], null)],
      details: {
        [JSON.stringify(["m", "Wing"])]: wingDetail,
        [JSON.stringify(["m", "Tail"])]: linkTarget,
      },
    });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    const context = await mountAndOpenElements(panel, backend, container);

    button(container, "Wing").click();
    await settleBackend();
    render(panel.render(context), container);
    const link = container.querySelector<HTMLButtonElement>(".syside-link");
    if (link === null) throw new Error("Expected a relationship link in the heritage section");
    // The link is wrapped in a tooltip that carries its qualified name (the
    // plain `title` attribute was removed in favor of the tooltip).

    link.click();
    expect(backend.request).toHaveBeenCalledWith("element-details", { qualifiedName: ["m", "Tail"] });
    await settleBackend();
    render(panel.render(context), container);

    expect(container.querySelector(".syside-details-header strong")?.textContent).toBe("m::Tail");
    expect(container.textContent).toContain("Tail docs.");
    render(null, container);
  });

  it("switches between the textual and the diagram placeholder view", async () => {
    const backend = backendFixture({
      errors: [],
      elements: [elementFixture("syside.PartUsage", "Wing", ["m", "Wing"], null)],
    });
    const panel = requiredPanel(activate("syside"));
    const container = document.createElement("div");
    const context = await mountAndOpenElements(panel, backend, container);
    button(container, "Wing").click();
    await settleBackend();
    render(panel.render(context), container);

    expect(container.querySelector(".syside-details-section")).not.toBeNull();
    expect(container.querySelector(".syside-diagram-placeholder")).toBeNull();
    const diagramButton = button(container, "Diagram");
    expect(diagramButton.getAttribute("aria-pressed")).toBe("false");
    diagramButton.click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-diagram-placeholder")?.textContent).toBe("Diagram view coming soon");
    expect(container.querySelector(".syside-details-section")).toBeNull();
    expect(button(container, "Diagram").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "Text").getAttribute("aria-pressed")).toBe("false");

    button(container, "Text").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-diagram-placeholder")).toBeNull();
    expect(container.querySelector(".syside-details-section")).not.toBeNull();
    expect(button(container, "Diagram").getAttribute("aria-pressed")).toBe("false");

    // Clicking the already-active segment must be a no-op (segmented-control
    // semantics): the active Text button stays in text mode…
    button(container, "Text").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-details-section")).not.toBeNull();
    expect(container.querySelector(".syside-diagram-placeholder")).toBeNull();
    expect(button(container, "Text").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "Diagram").getAttribute("aria-pressed")).toBe("false");

    // …and the active Diagram button stays in diagram mode.
    button(container, "Diagram").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-diagram-placeholder")).not.toBeNull();
    expect(container.querySelector(".syside-details-section")).toBeNull();
    expect(button(container, "Diagram").getAttribute("aria-pressed")).toBe("true");
    button(container, "Diagram").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.querySelector(".syside-diagram-placeholder")).not.toBeNull();
    expect(button(container, "Diagram").getAttribute("aria-pressed")).toBe("true");
    render(null, container);
  });

  it("keeps the latest list response when earlier requests resolve later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const panel = requiredPanel(activate("syside"));
    const pending = new Map<string, (value: JsonValue) => void>();
    const request = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
      if (operation === "check") return Promise.resolve({ errors: [] });
      if (operation === "survey") return Promise.resolve({ projectPath: "/model", packages: [] });
      if (operation === "list-elements") {
        const search = isRecord(input) && typeof input["search"] === "string" ? input["search"] : "";
        return new Promise((resolve) => { pending.set(search, resolve); });
      }
      return Promise.reject(new Error(`Unexpected operation: ${operation}`));
    });
    const context = panelContext(request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "Elements").click();
    await settleBackend();
    render(panel.render(context), container);

    const searchInput = container.querySelector<HTMLInputElement>("input[type='search']");
    if (searchInput === null) throw new Error("Expected a search input");
    searchInput.value = "A";
    searchInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS + 1);
    searchInput.value = "AB";
    searchInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(SYSIDE_SEARCH_DEBOUNCE_MS + 1);

    const resolveA = pending.get("A");
    const resolveAB = pending.get("AB");
    if (resolveA === undefined || resolveAB === undefined) throw new Error("Expected two pending list requests");
    // The newer request settles first; the earlier one only resolves afterwards.
    resolveAB([elementFixture("syside.PartUsage", "Wing-AB", ["m", "Wing-AB"], null)]);
    await settleBackend();
    render(panel.render(context), container);
    expect([...container.querySelectorAll(".syside-element-name")].map((node) => node.textContent)).toEqual(["Wing-AB"]);

    resolveA([elementFixture("syside.PartUsage", "Wing-A", ["m", "Wing-A"], null)]);
    await settleBackend();
    render(panel.render(context), container);
    // The stale response must not clobber the list for the latest filter.
    expect([...container.querySelectorAll(".syside-element-name")].map((node) => node.textContent)).toEqual(["Wing-AB"]);
    // With no short name declared the short column stays empty so it does not
    // duplicate the name column.
    expect([...container.querySelectorAll(".syside-element-short")].map((node) => node.textContent)).toEqual([]);
    expect(request).toHaveBeenLastCalledWith("list-elements", { search: "AB" });
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

/** Mutable state shared by the fake backend and the assertions. */
interface BackendFixtureState {
  errors: string[];
  failures: number;
  surveyFailures: number;
  lastListInput: JsonValue | undefined;
}

interface BackendFixtureSeed {
  errors?: string[];
  failures?: number;
  surveyFailures?: number;
  survey?: JsonValue[];
  elements?: JsonValue[];
  details?: Record<string, JsonValue>;
}

// The element-details fallback: a full valid detail fixture the fake returns
// for any qualified name the test did not seed explicitly.
const defaultDetailFixture: JsonValue = {
  type: "syside.PartUsage",
  declared_name: "Wing",
  qualified_name: ["m", "Wing"],
  declared_short_name: null,
  documentation: ["Syside default detail."],
  heritage: null,
  subsetting: null,
  filepath: "/model/Model.sysml",
  subject: null,
  inputs: null,
  outputs: null,
};

function backendFixture(seed: BackendFixtureSeed = {}) {
  const state: BackendFixtureState = {
    errors: seed.errors ?? ["Unknown reference 'Wing'"],
    failures: seed.failures ?? 0,
    surveyFailures: seed.surveyFailures ?? 0,
    lastListInput: undefined,
  };
  const request = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
    switch (operation) {
      case "check":
        if (state.failures > 0) {
          state.failures -= 1;
          return Promise.reject(new Error("syside check failed"));
        }
        return Promise.resolve({ errors: [...state.errors] });
      case "survey":
        if (state.surveyFailures > 0) {
          state.surveyFailures -= 1;
          return Promise.reject(new Error("syside survey failed"));
        }
        return Promise.resolve({ projectPath: "/model", packages: seed.survey ?? [] });
      case "list-elements":
        state.lastListInput = input;
        return Promise.resolve(seed.elements ?? []);
      case "element-details": {
        const qualifiedName = isRecord(input) ? input["qualifiedName"] : undefined;
        if (Array.isArray(qualifiedName)) {
          const found = seed.details?.[JSON.stringify(qualifiedName)];
          if (found !== undefined) return Promise.resolve(found);
        }
        return Promise.resolve(defaultDetailFixture);
      }
      default:
        return Promise.reject(new Error(`Unexpected operation: ${operation}`));
    }
  });
  return { request, state };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elementFixture(type: string, declared_name: string, qualified_name: string[], declared_short_name: string | null): JsonValue {
  return { type, declared_name, qualified_name, declared_short_name };
}

function packageFixture(declared_name: string, qualified_name: string[]): JsonValue {
  return {
    declared_name,
    qualified_name,
    element_counts: {
      "syside.PartUsage": 1,
      "syside.PartDefinition": 0,
      "syside.RequirementUsage": 0,
      "syside.RequirementDefinition": 0,
      "syside.ActionUsage": 0,
      "syside.ActionDefinition": 0,
    },
  };
}

async function mountAndOpenElements(
  panel: ReturnType<typeof requiredPanel>,
  backend: ReturnType<typeof backendFixture>,
  container: HTMLElement,
): Promise<WorkspacePanelContext> {
  // Connect (auto-check + overview survey load) + render the initial
  // check/overview result, then open the element view through the toolbar
  // button and render the settled element view.
  const context = panelContext(backend.request);
  document.body.append(container);
  render(panel.render(context), container);
  await settleBackend();
  render(panel.render(context), container);
  button(container, "Elements").click();
  await settleBackend();
  render(panel.render(context), container);
  return context;
}

function panelContext(request: WorkspaceBackend["request"] | undefined, workspace = sysideWorkspace, machineId = "local", hostRequestRender: () => void = () => undefined, insertText: (text: string) => void = () => undefined): WorkspacePanelContext {
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
    prompt: { insertText, getText: () => "", getSelection: () => null },
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