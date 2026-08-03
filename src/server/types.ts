import type { Workspace } from "../shared/apiTypes.js";

export type {
  Project,
  Workspace,
  WorkspaceEffectiveConfig,
  SessionRef as ClientSessionRef,
  SessionInfo as ClientSession,
  ArchiveSessionsResponse as ClientArchiveSessionsResponse,
  SessionCleanupRequest as ClientSessionCleanupRequest,
  SessionCleanupThresholds as ClientSessionCleanupThresholds,
  SessionCleanupPreviewResponse as ClientSessionCleanupPreviewResponse,
  SessionCleanupExecuteResponse as ClientSessionCleanupExecuteResponse,
  MessagePage as ClientMessagePage,
  SessionStreamSnapshot,
  SessionStatus as ClientSessionStatus,
  SessionModel as ClientSessionModel,
  ThinkingLevel as ClientThinkingLevel,
  SlashCommand as ClientCommand,
  FileSuggestion as ClientFileSuggestion,
  CommandOption as ClientCommandOption,
  CommandResult as ClientCommandResult,
  SessionTreeSnapshot as ClientSessionTreeSnapshot,
  SessionTreeNavigateRequest as ClientSessionTreeNavigateRequest,
  SessionTreeNavigateResult as ClientSessionTreeNavigateResult,
  SessionActivity as ClientSessionActivity,
  SessionUiEvent,
  GlobalSessionEvent,
} from "../shared/apiTypes.js";

/** Workspace as listed by the workspace service, before the route layer attaches the wire-required effectiveConfig. */
export type WorkspaceListing = Omit<Workspace, "effectiveConfig">;
