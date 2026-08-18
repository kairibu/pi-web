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
  SYSIDE_ELEMENT_DETAILS_OPERATION,
  SYSIDE_ELEMENT_TYPES,
  SYSIDE_LIST_ELEMENTS_OPERATION,
  SYSIDE_SURVEY_OPERATION,
  parseSysideCheckResponse,
  parseSysideElementDetailsResponse,
  parseSysideListElementsResponse,
  parseSysideSurveyResponse,
  type SysideSurveyResponse,
  type SysMlElement,
  type SysMlElementDetail,
} from "./syside-contract.js";
import {
  buildListElementsInput,
  elementDisplayName,
  elementShortName,
  elementTypeLabel,
  qualifiedNameDisplay,
  qualifiedNameKey,
} from "./syside-elements-view.js";

const SYSIDE_PANEL_LOCAL_ID = "workspace.syside";
// Keep a few recent workspaces' check results so navigating back restores the
// last outcome instead of re-checking on every visit; heavy models are not
// held here, so the bound is purely to stop unbounded map growth over long
// sessions.
const SYSIDE_WORKSPACE_STATE_LIMIT = 8;
// Trailing-edge debounce for search-driven list refreshes: a keystroke burst
// issues one list-elements request after the keys stop, not one per key (each
// request serializes behind the worker's single in-flight frame server-side).
export const SYSIDE_SEARCH_DEBOUNCE_MS = 250;
const activityElementTag = "pi-web-syside-panel-activity";

interface SysideWorkspaceUiState {
  context: WorkspacePanelContext;
  retained: boolean;
  errors: string[] | undefined;
  loading: boolean;
  error: string | undefined;
  checkRequest: Promise<void> | undefined;

  // Element view state. Kept per workspace like the check result, so leaving
  // and re-entering the panel restores the open view's filters, selection and
  // view mode. The element list is re-queried on every open; only the survey
  // is deduped (loaded once per workspace).
  elementViewActive: boolean;
  survey: SysideSurveyResponse | undefined;
  surveyLoading: boolean;
  surveyError: string | undefined;
  /** In-flight survey request (dedupe: load once per workspace). */
  surveyRequest: Promise<void> | undefined;
  /** One of SYSIDE_ELEMENT_TYPES; undefined = all types. */
  typeFilter: string | undefined;
  /** Selected package's qualified_name; undefined = all packages. */
  packageFilter: string[] | undefined;
  searchText: string;
  /** Pending trailing-edge debounce timer for search-driven list refreshes. */
  searchTimer: ReturnType<typeof setTimeout> | undefined;
  elements: SysMlElement[] | undefined;
  listLoading: boolean;
  listError: string | undefined;
  /** Bumped per list request; responses apply only when still current. */
  listRequestSequence: number;
  selectedQualifiedName: string[] | undefined;
  details: SysMlElementDetail | undefined;
  detailsLoading: boolean;
  detailsError: string | undefined;
  /** Bumped per details request; responses apply only when still current. */
  detailsRequestSequence: number;
  diagramMode: boolean;
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

  isSysideWorkspace(workspace: Workspace | undefined): boolean {
    return workspace?.capabilities?.some((capability) => capability.pluginId === this.sourcePluginId) === true;
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
    if (!this.isSysideWorkspace(context.workspace)) return Promise.resolve();
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

  /**
   * Element view entry point. Like the check/error rendering this is only
   * triggered from user interaction (the toolbar button), never from the
   * activity element connect() or the render path, so a failing backend can
   * never re-enter here as an infinite retry loop.
   */
  openElementView(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    state.elementViewActive = true;
    // Survey once per workspace; dedupe with the in-flight request so rapid
    // open/close churn does not re-survey.
    if (state.survey === undefined && state.surveyRequest === undefined) void this.loadSurvey(context);
    this.refreshList(context);
    this.requestRender(state);
  }

  closeElementView(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    // Drop any pending search debounce: a request issued after the view closed
    // would render into nothing and only surface a stale error later.
    if (state.searchTimer !== undefined) {
      clearTimeout(state.searchTimer);
      state.searchTimer = undefined;
    }
    state.elementViewActive = false;
    // Check result state is untouched, so the split reverts to the last
    // check/error rendering unchanged.
    this.requestRender(state);
  }

  loadSurvey(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    if (state.surveyRequest !== undefined) return state.surveyRequest;
    state.surveyLoading = true;
    state.surveyError = undefined;

    const request = requestSysideBackend(context, SYSIDE_SURVEY_OPERATION, null)
      .then(parseSysideSurveyResponse)
      .then((response) => {
        if (!state.retained) return;
        state.survey = response;
        state.surveyError = undefined;
      })
      .catch((error: unknown) => {
        if (state.retained) state.surveyError = errorMessage(error);
      })
      .finally(() => {
        if (state.surveyRequest !== request) return;
        state.surveyRequest = undefined;
        state.surveyLoading = false;
        this.requestRender(state);
      });
    state.surveyRequest = request;
    return request;
  }

  /**
   * Re-query the element list for the current filters. No in-flight dedupe:
   * every filter change issues a fresh request and the sequence counter
   * discards stale responses that resolve out of order.
   */
  refreshList(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    // Direct refreshes (open, type/package filter changes) already include the
    // current search text; drop a pending search debounce so it cannot fire a
    // redundant request afterwards.
    if (state.searchTimer !== undefined) {
      clearTimeout(state.searchTimer);
      state.searchTimer = undefined;
    }
    state.listLoading = true;
    state.listError = undefined;
    const sequence = ++state.listRequestSequence;

    const input = buildListElementsInput({
      type: state.typeFilter,
      packageQualifiedName: state.packageFilter,
      search: state.searchText,
    });
    requestSysideBackend(context, SYSIDE_LIST_ELEMENTS_OPERATION, input)
      .then(parseSysideListElementsResponse)
      .then((response) => {
        if (!state.retained || state.listRequestSequence !== sequence) return;
        state.elements = response;
        state.listError = undefined;
      })
      .catch((error: unknown) => {
        if (state.retained && state.listRequestSequence === sequence) state.listError = errorMessage(error);
      })
      .finally(() => {
        if (state.listRequestSequence !== sequence) return;
        state.listLoading = false;
        this.requestRender(state);
      });
  }

  setTypeFilter(context: WorkspacePanelContext, value: string | undefined): void {
    const state = this.stateFor(context);
    state.typeFilter = value;
    this.refreshList(context);
  }

  setPackageFilter(context: WorkspacePanelContext, value: string[] | undefined): void {
    const state = this.stateFor(context);
    state.packageFilter = value;
    this.refreshList(context);
  }

  /**
   * Applies the search term to state immediately (so the input keeps its live
   * text) but debounces the query: a keystroke burst issues one trailing list
   * request after ~250 ms instead of queuing one model query per key. The
   * sequence guard still applies once the debounced refresh runs.
   */
  setSearch(context: WorkspacePanelContext, value: string): void {
    const state = this.stateFor(context);
    state.searchText = value;
    if (state.searchTimer !== undefined) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchTimer = undefined;
      if (!state.retained || !state.elementViewActive) return;
      this.refreshList(context);
    }, SYSIDE_SEARCH_DEBOUNCE_MS);
  }

  selectElement(context: WorkspacePanelContext, qualifiedName: string[]): void {
    const state = this.stateFor(context);
    state.selectedQualifiedName = qualifiedName;
    void this.loadDetails(context, qualifiedName);
  }

  loadDetails(context: WorkspacePanelContext, qualifiedName: string[]): Promise<void> {
    const state = this.stateFor(context);
    state.detailsLoading = true;
    state.detailsError = undefined;
    const sequence = ++state.detailsRequestSequence;

    // The full qualified-name array is the key; never a joined string.
    const request = requestSysideBackend(context, SYSIDE_ELEMENT_DETAILS_OPERATION, { qualifiedName })
      .then(parseSysideElementDetailsResponse)
      .then((response) => {
        if (!state.retained) return;
        if (state.detailsRequestSequence !== sequence) return;
        // Apply only when the selection still names this element (the list row
        // or a relationship link may have navigated away meanwhile).
        const selectedKey = state.selectedQualifiedName === undefined ? undefined : qualifiedNameKey(state.selectedQualifiedName);
        if (selectedKey !== qualifiedNameKey(qualifiedName)) return;
        state.details = response;
        state.detailsError = undefined;
      })
      .catch((error: unknown) => {
        if (state.retained && state.detailsRequestSequence === sequence) state.detailsError = errorMessage(error);
      })
      .finally(() => {
        if (state.detailsRequestSequence !== sequence) return;
        state.detailsLoading = false;
        this.requestRender(state);
      });
    return request;
  }

  /**
   * Sets the details view mode explicitly so clicking the already-active
   * segment of the segmented Text/Diagram toggle is a no-op (standard segment
   * control semantics).
   */
  setDiagramMode(context: WorkspacePanelContext, mode: boolean): void {
    const state = this.stateFor(context);
    if (state.diagramMode === mode) return;
    state.diagramMode = mode;
    this.requestRender(state);
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
      elementViewActive: false,
      survey: undefined,
      surveyLoading: false,
      surveyError: undefined,
      surveyRequest: undefined,
      typeFilter: undefined,
      packageFilter: undefined,
      searchText: "",
      searchTimer: undefined,
      elements: undefined,
      listLoading: false,
      listError: undefined,
      listRequestSequence: 0,
      selectedQualifiedName: undefined,
      details: undefined,
      detailsLoading: false,
      detailsError: undefined,
      detailsRequestSequence: 0,
      diagramMode: false,
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

function requestSysideBackend(context: WorkspacePanelContext, operation: string, input: JsonValue): Promise<JsonValue> {
  if (context.backend === undefined) {
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
          <button type="button" aria-pressed=${String(state.elementViewActive)} @click=${() => {
            if (state.elementViewActive) controller.closeElementView(context);
            else controller.openElementView(context);
          }}>Elements</button>
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
  // The element view wins over the check-result split content; closing it
  // restores the check/error messages unchanged (they are only hidden).
  if (state.elementViewActive) return renderElementView(html, state, controller, context);
  if (state.errors !== undefined) {
    // Only error messages, each a direct child of the split; an empty error
    // list renders an empty split.
    return state.errors.map((message) => html`<p class="syside-error-message">${message}</p>`);
  }
  if (state.error !== undefined) return null;
  return html`<p class="syside-muted">${state.loading ? "Running SysIDE check…" : "Run SysIDE check."}</p>`;
}

function renderElementView(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    <section class="syside-elements">
      ${renderElementsSubmenu(html, state, controller, context)}
      <div class="syside-elements-body">
        <div class="syside-elements-list">${renderElementList(html, state, controller, context)}</div>
        <div class="syside-elements-details">${renderElementDetails(html, state, controller, context)}</div>
      </div>
    </section>
  `;
}

function renderElementsSubmenu(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    <div class="syside-elements-submenu">
      <select
        aria-label="Element type"
        .value=${state.typeFilter ?? ""}
        @change=${(event: Event) => {
          if (!(event.target instanceof HTMLSelectElement)) return;
          const value = event.target.value;
          controller.setTypeFilter(context, value === "" ? undefined : value);
        }}
      >
        <option value="">All types</option>
        ${SYSIDE_ELEMENT_TYPES.map((type) => html`<option value=${type}>${elementTypeLabel(type)}</option>`)}
      </select>
      <select
        aria-label="Owning package"
        .value=${packageFilterSelectValue(state)}
        ?disabled=${state.surveyLoading || state.surveyError !== undefined}
        @change=${(event: Event) => {
          if (!(event.target instanceof HTMLSelectElement)) return;
          controller.setPackageFilter(context, packageNameFromSelectValue(event.target.value));
        }}
      >
        ${state.surveyError !== undefined
          ? html`<option value="">Packages unavailable</option>`
          : state.survey === undefined || state.surveyLoading
            ? html`<option value="">Loading packages…</option>`
            : html`
              <option value="">All packages</option>
              ${state.survey.packages.map((pkg) => html`<option value=${JSON.stringify(pkg.qualified_name)}>${pkg.declared_name !== "" ? pkg.declared_name : qualifiedNameDisplay(pkg.qualified_name)}</option>`)}
            `}
      </select>
      <input
        type="search"
        aria-label="Search elements"
        placeholder="Search name…"
        .value=${state.searchText}
        @input=${(event: Event) => {
          if (!(event.target instanceof HTMLInputElement)) return;
          controller.setSearch(context, event.target.value);
        }}
      >
      ${state.surveyError === undefined ? null : html`<span class="syside-submenu-error" role="alert">${state.surveyError}</span>`}
    </div>
  `;
}

function renderElementList(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  if (state.listLoading && state.elements === undefined) return html`<p class="syside-muted">Loading elements…</p>`;
  if (state.listError !== undefined) return html`<p class="syside-error-message">${state.listError}</p>`;
  if (state.elements === undefined || state.elements.length === 0) return html`<p class="syside-muted">No elements.</p>`;
  const selectedKey = state.selectedQualifiedName === undefined ? undefined : qualifiedNameKey(state.selectedQualifiedName);
    return state.elements.map((element) => {
    const shortName = elementShortName(element);
    const isSelected = selectedKey === qualifiedNameKey(element.qualified_name);
    const rowClass = `${isSelected ? "syside-element-row is-selected" : "syside-element-row"}${shortName ? " has-short" : ""}`;
    return html`
      <button
        type="button"
        class=${rowClass}
        @click=${() => { controller.selectElement(context, element.qualified_name); }}
      >
        <span class="syside-element-type">${elementTypeLabel(element.type)}</span>
        ${shortName ? html`<span class="syside-element-short">&lt;${shortName}&gt;</span>` : null}
        <span class="syside-element-name">${element.declared_name}</span>
        <span class="syside-element-qn">${qualifiedNameDisplay(element.qualified_name)}</span>
      </button>
    `;
  });
}

function renderElementDetails(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  if (state.selectedQualifiedName === undefined) return html`<p class="syside-muted">Select an element.</p>`;
  if (state.detailsLoading) return html`<p class="syside-muted">Loading details…</p>`;
  if (state.detailsError !== undefined) return html`<p class="syside-error-message">${state.detailsError}</p>`;
  const details = state.details;
  if (details === undefined) return null;
  return html`
    <header class="syside-details-header">
      <strong>${qualifiedNameDisplay(details.qualified_name)}</strong>
      <span class="syside-muted">${elementTypeLabel(details.type)}</span>
      <small class="syside-details-filepath">${details.filepath}</small>
    </header>
    <div class="syside-view-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        class=${state.diagramMode ? "syside-view-button" : "syside-view-button is-selected"}
        aria-pressed=${String(!state.diagramMode)}
        @click=${() => { controller.setDiagramMode(context, false); }}
      >Text</button>
      <button
        type="button"
        class=${state.diagramMode ? "syside-view-button is-selected" : "syside-view-button"}
        aria-pressed=${String(state.diagramMode)}
        @click=${() => { controller.setDiagramMode(context, true); }}
      >Diagram</button>
    </div>
    ${state.diagramMode
      ? html`<div class="syside-diagram-placeholder">Diagram view coming soon</div>`
      : renderTextualDetails(html, details, controller, context)}
  `;
}

function renderTextualDetails(html: HtmlTemplateTag, details: SysMlElementDetail, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    ${renderStringSection(html, "Documentation", details.documentation)}
    ${renderElementListSection(html, "Heritage", details.heritage, controller, context)}
    ${renderElementListSection(html, "Subsetting", details.subsetting, controller, context)}
    ${renderElementSection(html, "Subject", details.subject, controller, context)}
    ${renderElementListSection(html, "Inputs", details.inputs, controller, context)}
    ${renderElementListSection(html, "Outputs", details.outputs, controller, context)}
  `;
}

function renderStringSection(html: HtmlTemplateTag, label: string, values: string[] | null) {
  return html`
    <section class="syside-details-section">
      <h3>${label}</h3>
      ${values === null || values.length === 0
        ? html`<p class="syside-muted">—</p>`
        : html`${values.map((value) => html`<p>${value}</p>`)}`}
    </section>
  `;
}

function renderElementListSection(html: HtmlTemplateTag, label: string, elements: SysMlElement[] | null, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    <section class="syside-details-section">
      <h3>${label}</h3>
      ${elements === null || elements.length === 0
        ? html`<p class="syside-muted">—</p>`
        : html`<ul>${elements.map((element) => renderElementLink(html, element, controller, context))}</ul>`}
    </section>
  `;
}

function renderElementSection(html: HtmlTemplateTag, label: string, element: SysMlElement | null, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    <section class="syside-details-section">
      <h3>${label}</h3>
      ${element === null
        ? html`<p class="syside-muted">—</p>`
        : html`<ul>${renderElementLink(html, element, controller, context)}</ul>`}
    </section>
  `;
}

function renderElementLink(html: HtmlTemplateTag, element: SysMlElement, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    <li>
      <button
        type="button"
        class="syside-link"
        title=${qualifiedNameDisplay(element.qualified_name)}
        @click=${() => { controller.selectElement(context, element.qualified_name); }}
      >${elementDisplayName(element)}</button>
    </li>
  `;
}

function packageFilterSelectValue(state: SysideWorkspaceUiState): string {
  return state.packageFilter === undefined ? "" : JSON.stringify(state.packageFilter);
}

function packageNameFromSelectValue(value: string): string[] | undefined {
  if (value === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((segment) => typeof segment === "string") ? parsed : undefined;
  } catch {
    // Only reachable for values the panel itself did not generate.
    return undefined;
  }
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
  .syside-panel .syside-split { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; padding: 4px 0; }
  .syside-panel .syside-error-message { margin: 4px 10px; padding: 6px 8px; border-left: 3px solid var(--pi-danger); color: var(--pi-text); white-space: pre-wrap; }
  .syside-panel .syside-elements { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .syside-panel .syside-elements-submenu { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .syside-panel .syside-elements-submenu select, .syside-panel .syside-elements-submenu input { border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 6px; }
  .syside-panel .syside-elements-submenu input { flex-grow: 1; }
  .syside-panel .syside-submenu-error { color: var(--pi-danger); }
  .syside-panel .syside-elements-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(140px, 40%) minmax(0, 1fr); }
  .syside-panel .syside-elements-list { min-height: 0; overflow: auto; border-bottom: 1px solid var(--pi-border-muted); }
  .syside-panel .syside-element-row { display: grid; grid-template-columns: 80px 1fr minmax(0, 1fr); gap: 8px; align-items: baseline; width: 100%; text-align: left; border: 0; border-radius: 0; background: transparent; margin: 0; padding: 5px 8px; }
  .syside-panel .syside-element-row.has-short { grid-template-columns: 80px auto 1fr minmax(0, 1fr); }
  .syside-panel .syside-element-row:hover, .syside-panel .syside-element-row.is-selected { background: var(--pi-selection-bg); }
  .syside-panel .syside-element-short { text-align: center; font-weight: 600; white-space: nowrap; padding-right: 6px; }
  .syside-panel .syside-element-name, .syside-panel .syside-element-qn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
  .syside-panel .syside-element-type { width: 80px; text-align: left; text-transform: uppercase; font-size: 11px; letter-spacing: .03em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; box-sizing: border-box; justify-self: start; color: var(--pi-muted); }
  .syside-panel .syside-element-qn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .syside-panel .syside-elements-details { min-height: 0; overflow: auto; padding: 8px 10px; }
  .syside-panel .syside-details-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .syside-panel .syside-details-filepath { color: var(--pi-muted); }
  .syside-panel .syside-view-toggle { display: inline-flex; margin: 4px 0 10px; }
  .syside-panel .syside-view-button { border-radius: 0; }
  .syside-panel .syside-view-button:first-child { border-top-left-radius: 7px; border-bottom-left-radius: 7px; }
  .syside-panel .syside-view-button:last-child { border-top-right-radius: 7px; border-bottom-right-radius: 7px; }
  .syside-panel .syside-view-button.is-selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .syside-panel .syside-details-section { margin: 8px 0; }
  .syside-panel .syside-details-section h3 { margin: 0 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--pi-muted); }
  .syside-panel .syside-details-section p { margin: 4px 0; }
  .syside-panel .syside-details-section ul { margin: 4px 0; padding-left: 18px; }
  .syside-panel .syside-details-section li { margin: 2px 0; }
  .syside-panel .syside-link { background: none; border: 0; color: var(--pi-accent); padding: 0; text-decoration: underline; cursor: pointer; }
  .syside-panel .syside-diagram-placeholder { margin: 10px 0; padding: 24px 12px; border: 1px dashed var(--pi-border); border-radius: 7px; color: var(--pi-muted); text-align: center; }
`;
