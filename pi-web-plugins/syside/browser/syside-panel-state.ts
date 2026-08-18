import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { SysideSurveyResponse, SysMlElement, SysMlElementDetail } from "./syside-contract.js";

/** Panel views selectable from the toolbar. */
export type SysidePanelView = "overview" | "check" | "elements";

/**
 * Keep a few recent workspaces' check results so navigating back restores the
 * last outcome instead of re-checking on every visit; heavy models are not
 * held here, so the bound is purely to stop unbounded map growth over long
 * sessions.
 */
export const SYSIDE_WORKSPACE_STATE_LIMIT = 8;

export interface SysideWorkspaceUiState {
  context: WorkspacePanelContext;
  retained: boolean;
  errors: string[] | undefined;
  loading: boolean;
  error: string | undefined;
  checkRequest: Promise<void> | undefined;

  // Active panel view. "overview" is the default: it shows the model overview
  // when the survey has packages and falls back to the check result otherwise.
  // Kept per workspace so re-entering the panel restores the last view. The
  // element list is re-queried on every entry into the element view; only the
  // survey is deduped (loaded once per workspace).
  view: SysidePanelView;
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

export function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

/**
 * Owns the per-workspace UI state map and its LRU retention policy. The map is
 * bounded by `SYSIDE_WORKSPACE_STATE_LIMIT`; eviction dropping the oldest
 * entry so long sessions cannot grow the map without bound. The connected
 * workspace key (the panel's current activity connection) is never evicted,
 * and the dropped state's `retained` flag clears so in-flight request
 * callbacks know not to render into a dead state.
 */
export class SysideWorkspaceStateStore {
  private readonly states = new Map<string, SysideWorkspaceUiState>();
  private connectedWorkspaceKey: string | undefined;

  /**
   * Record which workspace the activity element is currently connected to and
   * return its state (creating it on first connection).
   */
  connectContext(context: WorkspacePanelContext): SysideWorkspaceUiState {
    this.connectedWorkspaceKey = workspaceContextKey(context);
    return this.stateFor(context);
  }

  /** Clear the connected key when the disconnecting context is the connected one. */
  disconnectContext(context: WorkspacePanelContext): void {
    if (this.connectedWorkspaceKey === workspaceContextKey(context)) this.connectedWorkspaceKey = undefined;
  }

  /**
   * The retained state for a context. Fetching an existing entry (re)stores
   * its current context and moves it to the back (most-recent) of the LRU
   * order; a miss evicts the oldest state and creates a fresh default state
   * (unchecked, pristine, `retained: true`).
   */
  stateFor(context: WorkspacePanelContext): SysideWorkspaceUiState {
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
    const created = createDefaultSysideWorkspaceUiState(context);
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
}

/** Default fresh-workspace state: nothing loaded, nothing queried yet. */
function createDefaultSysideWorkspaceUiState(context: WorkspacePanelContext): SysideWorkspaceUiState {
  return {
    context,
    retained: true,
    errors: undefined,
    loading: false,
    error: undefined,
    checkRequest: undefined,
    view: "overview",
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
}