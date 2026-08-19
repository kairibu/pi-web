import type {
  HtmlTemplateTag,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import {
  SysideWorkspaceStateStore,
  type SysideWorkspaceUiState,
} from "./syside-panel-state.js";
import { SysideUiController } from "./syside-panel-controller.js";
import { defineSysidePanelActivityElement } from "./syside-panel-activity.js";
import { sysidePanelStyles } from "./syside-panel-styles.js";
import { renderCheckResult, renderOverview } from "./syside-panel-overview.js";
import { renderElementView } from "./syside-panel-elements.js";

const SYSIDE_PANEL_LOCAL_ID = "workspace.syside";

export function createSysideBrowserContributions(
  sourcePluginId: string,
  runtimePluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${runtimePluginId}:${SYSIDE_PANEL_LOCAL_ID}`;
  const controller = new SysideUiController(sourcePluginId, new SysideWorkspaceStateStore());
  defineSysidePanelActivityElement();
  return {
    actions: createSysideActions(panelId, controller),
    workspacePanels: [createSysidePanel(html, svg, controller)],
  };
}

function createSysideActions(panelId: string, controller: SysideUiController): PluginAction[] {
  const hasSysideWorkspace = (context: PluginRuntimeContext): boolean => controller.isSysideWorkspace(context.state.selectedWorkspace);
  return [
    {
      id: "view.syside",
      title: "Go to SysIDE",
      shortcut: "mod+5",
      group: "Navigation",
      enabled: hasSysideWorkspace,
      run: (context) => { context.selectMainView(panelId); },
    },
    {
      id: "workspace.refresh-syside",
      title: "Refresh SysIDE",
      shortcut: "mod+shift+y",
      group: "Workspace",
      enabled: hasSysideWorkspace,
      run: (context) => context.refreshWorkspacePanels(panelId),
    },
  ];
}

function createSysidePanel(
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
  controller: SysideUiController,
): WorkspacePanelContribution {
  return {
    id: SYSIDE_PANEL_LOCAL_ID,
    title: "SysIDE",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="4" width="16" height="6" rx="1"></rect>
        <rect x="4" y="14" width="16" height="6" rx="1"></rect>
        <path d="M9 10v4"></path>
        <path d="M15 10v4"></path>
      </svg>
    `,
    order: 30,
    visible: (context) => controller.isSysideWorkspace(context.workspace),
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderSysidePanel(html, controller, context),
  };
}

function renderSysidePanel(html: HtmlTemplateTag, controller: SysideUiController, context: WorkspacePanelContext) {
  const state = controller.state(context);
  return html`
    <section class="syside-panel">
      <style .textContent=${sysidePanelStyles}></style>
      <pi-web-syside-panel-activity .controller=${controller} .context=${context}></pi-web-syside-panel-activity>
      <section class="syside-toolbar">
        <strong>SysIDE</strong>
        <div class="syside-toolbar-actions">
          <button type="button" aria-pressed=${String(state.view === "overview")} @click=${() => { controller.setView(context, "overview"); }}>Overview</button>
          <button type="button" aria-pressed=${String(state.view === "check")} ?disabled=${state.loading} @click=${() => { controller.setView(context, "check"); void controller.check(context); }}>Check</button>
          <button type="button" aria-pressed=${String(state.view === "elements")} @click=${() => { controller.setView(context, "elements"); }}>Elements</button>
        </div>
      </section>
      ${state.error === undefined ? null : html`<div class="syside-error" role="alert">${state.error}</div>`}
      <section class="syside-split">
        ${renderSysideSplit(html, state, controller, context)}
      </section>
    </section>
  `;
}

function renderSysideSplit(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  if (state.view === "elements") return renderElementView(html, state, controller, context);
  if (state.view === "check") return renderCheckResult(html, state);
  return renderOverview(html, state, controller, context);
}
