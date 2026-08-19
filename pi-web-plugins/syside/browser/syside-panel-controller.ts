import type { JsonValue, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  SYSIDE_CHECK_OPERATION,
  SYSIDE_ELEMENT_DETAILS_OPERATION,
  SYSIDE_LIST_ELEMENTS_OPERATION,
  SYSIDE_SURVEY_OPERATION,
  parseSysideCheckResponse,
  parseSysideElementDetailsResponse,
  parseSysideListElementsResponse,
  parseSysideSurveyResponse,
} from "./syside-contract.js";
import { buildListElementsInput, qualifiedNameKey } from "./syside-elements-view.js";
import {
  SysideWorkspaceStateStore,
  type SysidePanelView,
  type SysideWorkspaceUiState,
} from "./syside-panel-state.js";

// Trailing-edge debounce for search-driven list refreshes: a keystroke burst
// issues one list-elements request after the keys stop, not one per key (each
// request serializes behind the worker's single in-flight frame server-side).
export const SYSIDE_SEARCH_DEBOUNCE_MS = 250;

/**
 * Orchestrates the panel's request lifecycles against the backend through the
 * injected per-workspace state store: check, survey, element list (with
 * debounced search and sequence guards) and element details. Request outcomes
 * apply only while their state is retained (see SysideWorkspaceStateStore) and
 * only when their sequence counter is still current, so stale responses cannot
 * clobber fresher data or render into an evicted workspace.
 */
export class SysideUiController {
  constructor(
    private readonly sourcePluginId: string,
    private readonly store: SysideWorkspaceStateStore,
  ) {}

  isSysideWorkspace(workspace: Workspace | undefined): boolean {
    return workspace?.capabilities?.some((capability) => capability.pluginId === this.sourcePluginId) === true;
  }

  state(context: WorkspacePanelContext): SysideWorkspaceUiState {
    return this.store.stateFor(context);
  }

  connect(context: WorkspacePanelContext): void {
    const state = this.store.connectContext(context);
    // Auto-check only once per connection/workspace: when a previous result (or
    // a pending request) exists there is nothing new to fetch. Importantly, a
    // *failed* check leaves `errors` undefined, so without the activity element
    // change-guards (see defineSysidePanelActivityElement) a re-render would
    // re-enter connect() and re-run the failing check forever.
    if (state.errors === undefined && state.checkRequest === undefined) void this.check(context);
    // Load the overview data once per workspace under the same exactly-once
    // guarantee: connect() runs only when the activity element actually
    // (re)connects, never from the render path, so a failed survey behaves
    // like a failed check. Do not trigger the survey from the render path.
    if (state.survey === undefined && state.surveyRequest === undefined) void this.loadSurvey(context);
  }

  disconnect(context: WorkspacePanelContext): void {
    this.store.disconnectContext(context);
  }

  invalidate(context: WorkspacePanelContext): Promise<void> {
    if (!this.isSysideWorkspace(context.workspace)) return Promise.resolve();
    return this.check(context);
  }

  check(context: WorkspacePanelContext): Promise<void> {
    const state = this.store.stateFor(context);
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
   * Selects the panel view. Like the check/error rendering, switching is only
   * triggered from user interaction (the toolbar buttons), never from the
   * activity element connect() or the render path, so a failing backend can
   * never re-enter here as an infinite retry loop.
   */
  setView(context: WorkspacePanelContext, view: SysidePanelView): void {
    const state = this.store.stateFor(context);
    if (state.view === view) return;
    // Leaving the element view: drop any pending search debounce so a delayed
    // request cannot render into a view that is no longer visible.
    if (state.view === "elements" && state.searchTimer !== undefined) {
      clearTimeout(state.searchTimer);
      state.searchTimer = undefined;
    }
    state.view = view;
    // Entering the element view re-queries the list. The survey is reused from
    // the overview's initial load when already cached; a previously failed
    // survey is retried here (same behavior as the old openElementView).
    if (view === "elements") {
      if (state.survey === undefined && state.surveyRequest === undefined) void this.loadSurvey(context);
      this.refreshList(context);
    }
    this.requestRender(state);
  }

  loadSurvey(context: WorkspacePanelContext): Promise<void> {
    const state = this.store.stateFor(context);
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
    const state = this.store.stateFor(context);
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
    const state = this.store.stateFor(context);
    state.typeFilter = value;
    this.refreshList(context);
  }

  setPackageFilter(context: WorkspacePanelContext, value: string[] | undefined): void {
    const state = this.store.stateFor(context);
    state.packageFilter = value;
    this.refreshList(context);
  }

  /**
   * Opens the elements view filtered to a package — and optionally a type —
   * from the overview's package/count links. This is deliberately a single
   * method instead of composing setPackageFilter/setTypeFilter + setView:
   * each of those refreshes the list on its own, so composing them from the
   * overview view would issue multiple list-elements requests (the first
   * while still on the overview). The one refresh after the view and filters
   * change issues exactly the single request the new view needs.
   *
   * The `type` parameter doubles as the reset: a plain package-name click
   * passes `undefined` and therefore clears any stale type filter ("show all
   * elements of this package"), while a type-count click passes its type.
   * This deliberately differs from the "Owning package" <select>, which only
   * changes one filter dimension; the click intent is a fresh scoped list.
   * searchText is preserved (not cleared) to stay consistent with the
   * existing filter <select>/search semantics, so a previous elements-view
   * search still applies to the newly filtered list.
   */
  openPackage(context: WorkspacePanelContext, qualifiedName: string[], type?: string): void {
    const state = this.store.stateFor(context);
    state.packageFilter = qualifiedName;
    state.typeFilter = type;
    state.view = "elements";
    if (state.survey === undefined && state.surveyRequest === undefined) void this.loadSurvey(context);
    this.refreshList(context);
    this.requestRender(state);
  }

  /**
   * Applies the search term to state immediately (so the input keeps its live
   * text) but debounces the query: a keystroke burst issues one trailing list
   * request after ~250 ms instead of queuing one model query per key. The
   * sequence guard still applies once the debounced refresh runs.
   */
  setSearch(context: WorkspacePanelContext, value: string): void {
    const state = this.store.stateFor(context);
    state.searchText = value;
    if (state.searchTimer !== undefined) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchTimer = undefined;
      if (!state.retained || state.view !== "elements") return;
      this.refreshList(context);
    }, SYSIDE_SEARCH_DEBOUNCE_MS);
  }

  selectElement(context: WorkspacePanelContext, qualifiedName: string[]): void {
    const state = this.store.stateFor(context);
    state.selectedQualifiedName = qualifiedName;
    void this.loadDetails(context, qualifiedName);
  }

  loadDetails(context: WorkspacePanelContext, qualifiedName: string[]): Promise<void> {
    const state = this.store.stateFor(context);
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
    const state = this.store.stateFor(context);
    if (state.diagramMode === mode) return;
    state.diagramMode = mode;
    this.requestRender(state);
  }

  private requestRender(state: SysideWorkspaceUiState): void {
    if (state.retained) state.context.host.requestRender();
  }
}

function requestSysideBackend(context: WorkspacePanelContext, operation: string, input: JsonValue): Promise<JsonValue> {
  if (context.backend === undefined) {
    return Promise.reject(new Error("SysIDE workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser."));
  }
  return context.backend.request(operation, input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}