import type {
  HtmlTemplateTag,
  JsonValue,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  Workspace,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import {
  SYSIDE_CHECK_OPERATION,
  parseSysideCheckResponse,
} from "./syside-contract.js";

const SYSIDE_PANEL_LOCAL_ID = "workspace.syside";
// Keep a few recent workspaces' check results so navigating back restores the
// last outcome instead of re-checking on every visit; heavy models are not
// held here, so the bound is purely to stop unbounded map growth over long
// sessions.
const SYSIDE_WORKSPACE_STATE_LIMIT = 8;
const activityElementTag = "pi-web-syside-panel-activity";

interface SysideWorkspaceUiState {
  context: WorkspacePanelContext;
  retained: boolean;
  errors: string[] | undefined;
  loading: boolean;
  error: string | undefined;
  checkRequest: Promise<void> | undefined;
}

export function createSysideBrowserContributions(
  sourcePluginId: string,
  runtimePluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${runtimePluginId}:${SYSIDE_PANEL_LOCAL_ID}`;
  const controller = new SysideUiController(sourcePluginId);
  defineSysidePanelActivityElement();
  return {
    actions: createSysideActions(panelId, controller),
    workspacePanels: [createSysidePanel(html, svg, controller)],
  };
}

class SysideUiController {
  private readonly states = new Map<string, SysideWorkspaceUiState>();
  private connectedWorkspaceKey: string | undefined;

  constructor(private readonly sourcePluginId: string) {}

  isOwnedWorkspace(workspace: Workspace | undefined): boolean {
    return workspace?.provider?.pluginId === this.sourcePluginId;
  }

  state(context: WorkspacePanelContext): SysideWorkspaceUiState {
    return this.stateFor(context);
  }

  connect(context: WorkspacePanelContext): void {
    this.connectedWorkspaceKey = workspaceContextKey(context);
    const state = this.stateFor(context);
    // Auto-check only once per connection/workspace: when a previous result (or
    // a pending request) exists there is nothing new to fetch. Importantly, a
    // *failed* check leaves `errors` undefined, so without the activity element
    // change-guards (see defineSysidePanelActivityElement) a re-render would
    // re-enter connect() and re-run the failing check forever.
    if (state.errors === undefined && state.checkRequest === undefined) void this.check(context);
  }

  disconnect(context: WorkspacePanelContext): void {
    if (this.connectedWorkspaceKey === workspaceContextKey(context)) this.connectedWorkspaceKey = undefined;
  }

  invalidate(context: WorkspacePanelContext): Promise<void> {
    if (!this.isOwnedWorkspace(context.workspace)) return Promise.resolve();
    return this.check(context);
  }

  check(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    if (state.checkRequest !== undefined) return state.checkRequest;
    state.loading = true;
    state.error = undefined;
    this.requestRender(state);

    const request = requestSysideBackend(context, SYSIDE_CHECK_OPERATION, null)
      .then(parseSysideCheckResponse)
      .then((response) => {
        if (!state.retained) return;
        state.errors = response.errors;
        state.error = undefined;
      })
      .catch((error: unknown) => {
        if (state.retained) state.error = errorMessage(error);
      })
      .finally(() => {
        if (state.checkRequest !== request) return;
        state.checkRequest = undefined;
        state.loading = false;
        this.requestRender(state);
      });
    state.checkRequest = request;
    return request;
  }

  private stateFor(context: WorkspacePanelContext): SysideWorkspaceUiState {
    const key = workspaceContextKey(context);
    const existing = this.states.get(key);
    if (existing !== undefined) {
      existing.context = context;
      // Move the touched entry to the back (most-recent) for LRU eviction.
      this.states.delete(key);
      this.states.set(key, existing);
      return existing;
    }
    this.evictOldestState();
    const created: SysideWorkspaceUiState = {
      context,
      retained: true,
      errors: undefined,
      loading: false,
      error: undefined,
      checkRequest: undefined,
    };
    this.states.set(key, created);
    return created;
  }

  private evictOldestState(): void {
    if (this.states.size < SYSIDE_WORKSPACE_STATE_LIMIT) return;
    const key = [...this.states.keys()].find((candidate) => candidate !== this.connectedWorkspaceKey) ?? this.states.keys().next().value;
    if (key === undefined) return;
    const state = this.states.get(key);
    if (state !== undefined) state.retained = false;
    this.states.delete(key);
  }

  private requestRender(state: SysideWorkspaceUiState): void {
    if (state.retained) state.context.host.requestRender();
  }
}

function createSysideActions(panelId: string, controller: SysideUiController): PluginAction[] {
  const hasSysideWorkspace = (context: PluginRuntimeContext): boolean => controller.isOwnedWorkspace(context.state.selectedWorkspace);
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
    visible: (context) => controller.isOwnedWorkspace(context.workspace),
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderSysidePanel(html, controller, context),
  };
}

function requestSysideBackend(context: WorkspacePanelContext, operation: string, input: JsonValue): Promise<JsonValue> {
  if (context.backend === undefined || context.workspace.provider?.capabilities.request === false) {
    return Promise.reject(new Error("SysIDE workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser."));
  }
  return context.backend.request(operation, input);
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
          <button type="button" ?disabled=${state.loading} @click=${() => { void controller.check(context); }}>Check</button>
        </div>
      </section>
      ${state.error === undefined ? null : html`<div class="syside-error" role="alert">${state.error}</div>`}
      <section class="syside-split">
        ${renderSysideSplit(html, state)}
      </section>
    </section>
  `;
}

function renderSysideSplit(html: HtmlTemplateTag, state: SysideWorkspaceUiState) {
  if (state.errors !== undefined) {
    // Only error messages, each a direct child of the split; an empty error
    // list renders an empty split.
    return state.errors.map((message) => html`<p class="syside-error-message">${message}</p>`);
  }
  if (state.error !== undefined) return null;
  return html`<p class="syside-muted">${state.loading ? "Running SysIDE check…" : "Run SysIDE check."}</p>`;
}

function defineSysidePanelActivityElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined" || customElements.get(activityElementTag) !== undefined) return;
  class SysidePanelActivityElement extends HTMLElement {
    private controllerValue: SysideUiController | undefined;
    private contextValue: WorkspacePanelContext | undefined;

    // lit-html 3.x re-commits object property parts on every render, so these
    // setters fire even when their value is unchanged. Guard both so an
    // unchanged `controller` / `context` (same workspace) does not call
    // connect() again; otherwise a failed check's requestRender would re-enter
    // connect() -> check() -> failure -> requestRender as an infinite retry.
    set controller(value: SysideUiController | undefined) {
      if (this.controllerValue === value) return;
      this.controllerValue = value;
      this.connect();
    }

    set context(value: WorkspacePanelContext | undefined) {
      const previousKey = this.contextValue === undefined ? undefined : workspaceContextKey(this.contextValue);
      this.contextValue = value;
      if (previousKey !== (value === undefined ? undefined : workspaceContextKey(value))) this.connect();
    }

    connectedCallback(): void {
      this.connect();
    }

    disconnectedCallback(): void {
      if (this.controllerValue !== undefined && this.contextValue !== undefined) {
        this.controllerValue.disconnect(this.contextValue);
      }
    }

    private connect(): void {
      if (!this.isConnected || this.controllerValue === undefined || this.contextValue === undefined) return;
      this.controllerValue.connect(this.contextValue);
    }
  }
  customElements.define(activityElementTag, SysidePanelActivityElement);
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sysidePanelStyles = `
  .syside-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  .syside-panel ${activityElementTag} { display: none; }
  .syside-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
  .syside-panel button:disabled { cursor: wait; opacity: .65; }
  .syside-panel .syside-muted { color: var(--pi-muted); }
  .syside-panel p { margin: 10px; }
  .syside-panel .syside-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .syside-panel .syside-toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .syside-panel .syside-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; }
  .syside-panel .syside-split { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0; }
  .syside-panel .syside-error-message { margin: 4px 10px; padding: 6px 8px; border-left: 3px solid var(--pi-danger); color: var(--pi-text); white-space: pre-wrap; }
`;
