import type {
  CapabilityRequestContext,
  JsonValue,
  ProviderResponse,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  SYSIDE_CHECK_OPERATION,
  SYSIDE_ELEMENT_TYPES,
  SYSIDE_ELEMENT_DETAILS_OPERATION,
  SYSIDE_LIST_ELEMENTS_OPERATION,
  SYSIDE_SURVEY_OPERATION,
  type SysideCheckResponse,
  type SysideListElementsFilter,
  type SysideSurveyResponse,
  type SysMlElement,
  type SysMlElementDetail,
} from "./browser/syside-contract.js";

export {
  SYSIDE_CHECK_OPERATION,
  SYSIDE_ELEMENT_TYPES,
  SYSIDE_ELEMENT_DETAILS_OPERATION,
  SYSIDE_LIST_ELEMENTS_OPERATION,
  SYSIDE_SURVEY_OPERATION,
} from "./browser/syside-contract.js";
export type {
  SysideCheckResponse,
  SysideListElementsFilter,
  SysideSurveyResponse,
  SysMlElement,
  SysMlElementDetail,
} from "./browser/syside-contract.js";

/**
 * The operation surface the backend needs from the single-model service, so
 * routing tests can substitute a fake without a Python worker.
 */
export interface SysideCapabilityService {
  check(workspacePath: string, signal: AbortSignal): Promise<SysideCheckResponse>;
  survey(workspacePath: string, signal: AbortSignal): Promise<SysideSurveyResponse>;
  listElements(workspacePath: string, filters: SysideListElementsFilter, signal: AbortSignal): Promise<SysMlElement[]>;
  elementDetails(workspacePath: string, qualifiedName: string[], signal: AbortSignal): Promise<SysMlElementDetail>;
}

/**
 * Dispatch the SysIDE capability operations through the single-model service.
 *
 * Public backend operation names use hyphens (`survey`, `list-elements`,
 * `element-details`) because the host validates backend operation names and
 * rejects underscores; they map to the Python worker's `survey`,
 * `list_elements`, and `element_details` operations inside the service.
 */
export async function requestSysideCapability(
  service: SysideCapabilityService,
  request: CapabilityRequestContext,
): Promise<ProviderResponse> {
  switch (request.operation) {
    case SYSIDE_CHECK_OPERATION: {
      requireNullInput(request.input, SYSIDE_CHECK_OPERATION);
      return await service.check(request.workspace.path, request.signal);
    }
    case SYSIDE_SURVEY_OPERATION: {
      requireNullInput(request.input, SYSIDE_SURVEY_OPERATION);
      return await service.survey(request.workspace.path, request.signal);
    }
    case SYSIDE_LIST_ELEMENTS_OPERATION: {
      const filters = requireListElementsInput(request.input);
      return await service.listElements(request.workspace.path, filters, request.signal);
    }
    case SYSIDE_ELEMENT_DETAILS_OPERATION: {
      const qualifiedName = requireElementDetailsInput(request.input);
      return await service.elementDetails(request.workspace.path, qualifiedName, request.signal);
    }
    default:
      throw new Error(`Unsupported SysIDE capability operation: ${request.operation}`);
  }
}

function requireNullInput(input: JsonValue, operation: string): void {
  if (input !== null) throw new Error(`SysIDE ${operation} input must be null`);
}

function requireListElementsInput(input: JsonValue): SysideListElementsFilter {
  if (input === null) return {};
  if (!isRecord(input)) throw new Error("SysIDE list-elements input must be an object or null");
  const filters: SysideListElementsFilter = {};
  const type = input["type"];
  if (type !== undefined) {
    if (typeof type !== "string" || type === "" || !isSupportedElementType(type)) {
      throw new Error(`SysIDE list-elements input type must be one of: ${SYSIDE_ELEMENT_TYPES.join(", ")}`);
    }
    filters.type = type;
  }
  const packageQualifiedName = input["packageQualifiedName"];
  if (packageQualifiedName !== undefined) {
    if (!isNonEmptyStringArray(packageQualifiedName)) {
      throw new Error("SysIDE list-elements input packageQualifiedName must be a non-empty array of non-empty strings");
    }
    filters.packageQualifiedName = packageQualifiedName;
  }
  const search = input["search"];
  if (search !== undefined) {
    if (typeof search !== "string" || search === "") {
      throw new Error("SysIDE list-elements input search must be a non-empty string");
    }
    filters.search = search;
  }
  return filters;
}

function requireElementDetailsInput(input: JsonValue): string[] {
  if (!isRecord(input)) throw new Error("SysIDE element-details input must be an object");
  const qualifiedName = input["qualifiedName"];
  if (!isNonEmptyStringArray(qualifiedName)) {
    throw new Error("SysIDE element-details input qualifiedName must be a non-empty array of non-empty strings");
  }
  return qualifiedName;
}

function isSupportedElementType(type: string): boolean {
  return SYSIDE_ELEMENT_TYPES.some((candidate) => candidate === type);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && entry !== "")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}