import type { JsonObject } from "@jmfederico/pi-web/plugin-api";

export const SYSIDE_CHECK_OPERATION = "check";
export const SYSIDE_LIST_ELEMENTS_OPERATION = "list-elements";
export const SYSIDE_SURVEY_OPERATION = "survey";
export const SYSIDE_ELEMENT_DETAILS_OPERATION = "element-details";

/**
 * Contract type names of the SysML element kinds the element view supports
 * (``syside.PartUsage``, …), used by backend input validation. The Python
 * worker keeps the same names in its ``SYSIDE_TYPE_BY_NAME`` map.
 */
export const SYSIDE_ELEMENT_TYPES = [
  "syside.PartUsage",
  "syside.PartDefinition",
  "syside.RequirementUsage",
  "syside.RequirementDefinition",
  "syside.ActionUsage",
  "syside.ActionDefinition",
  "syside.PortUsage",
  "syside.PortDefinition",
  "syside.InterfaceUsage",
  "syside.InterfaceDefinition",
] as const;

/** JSON result of a SysIDE check: the error messages reported for the project. */
export interface SysideCheckResponse extends JsonObject {
  errors: string[];
}

/** Filter accepted by the `list-elements` capability operation. */
export interface SysideListElementsFilter extends JsonObject {
  /** Contract type name, e.g. `syside.PartUsage`; omit for all supported types. */
  type?: string;
  /** Qualified name segments of the owning package; omit for the whole model. */
  packageQualifiedName?: string[];
  /** Case-insensitive substring over declared name and declared short name. */
  search?: string;
}

/** One named SysML element of the active model, as returned by list-elements. */
export interface SysMlElement extends JsonObject {
  /** Contract type name such as `syside.PartUsage`. */
  type: string;
  declared_name: string;
  /** Qualified name segments (`package`, `owner`, `element`), empty when none. */
  qualified_name: string[];
  declared_short_name: string | null;
}

/** Full detail of one SysML element of the active model, keyed by qualified name. */
export interface SysMlElementDetail extends SysMlElement {
  /** Documentation comments attached to the element, or null when none. */
  documentation: string[] | null;
  /** Inheritance (specialization) targets, or null when none. */
  heritage: SysMlElement[] | null;
  /** Subsetting targets, or null when none. */
  subsetting: SysMlElement[] | null;
  /** Filesystem path of the source file defining the element. */
  filepath: string;
  /** The element's subject (for requirements and cases), or null. */
  subject: SysMlElement | null;
  /** Input parameters/slots, only for action usages and definitions, or null. */
  inputs: SysMlElement[] | null;
  /** Output parameters/slots, only for action usages and definitions, or null. */
  outputs: SysMlElement[] | null;
  /** Nested port usages (owned ports for definitions), or null when none. */
  nested_ports: SysMlElement[] | null;
  /** Nested action usages (owned actions for definitions), or null when none. */
  nested_actions: SysMlElement[] | null;
  /** Nested flow usages (owned flows for definitions), or null when none. */
  nested_flows: SysMlElement[] | null;
  /** Elements directly owned by the element, or null when none. */
  owned_elements: SysMlElement[] | null;
}

/** Per-package element counts as reported by `survey`. */
export interface PackageSummary extends JsonObject {
  declared_name: string;
  qualified_name: string[];
  /**
   * Counts per contract type name; every supported type key is always present
   * and the parser rejects unknown keys. Counts cover the package's entire
   * ownership subtree (nested packages included), so an element is counted
   * under every ancestor package that owns it, not just the innermost one.
   */
  element_counts: Record<string, number>;
}

export interface SysideSurveyResponse extends JsonObject {
  /** Absolute path of the surveyed workspace; the service injects the real one. */
  projectPath: string;
  packages: PackageSummary[];
}

export function parseSysideCheckResponse(value: unknown): SysideCheckResponse {
  const record = requireRecord(value, "SysIDE check response");
  return { errors: requireStringArray(record["errors"], "errors") };
}

export function parseSysideListElementsResponse(value: unknown): SysMlElement[] {
  if (!Array.isArray(value)) throw new Error("SysIDE list-elements response must be an array");
  return value.map((entry, index) => parseSysMlElement(entry, `list-elements entry ${String(index)}`));
}

export function parseSysideElementDetailsResponse(value: unknown): SysMlElementDetail {
  const record = requireRecord(value, "SysIDE element-details response");
  const base = parseSysMlElement(record, "element-details response");
  return {
    ...base,
    documentation: requireStringArrayOrNull(record["documentation"], "documentation"),
    heritage: requireSysMlElementArrayOrNull(record["heritage"], "heritage"),
    subsetting: requireSysMlElementArrayOrNull(record["subsetting"], "subsetting"),
    filepath: requireString(record["filepath"], "filepath"),
    subject: requireSysMlElementOrNull(record["subject"], "subject"),
    inputs: requireSysMlElementArrayOrNull(record["inputs"], "inputs"),
    outputs: requireSysMlElementArrayOrNull(record["outputs"], "outputs"),
    nested_ports: requireSysMlElementArrayOrNull(record["nested_ports"], "nested_ports"),
    nested_actions: requireSysMlElementArrayOrNull(record["nested_actions"], "nested_actions"),
    nested_flows: requireSysMlElementArrayOrNull(record["nested_flows"], "nested_flows"),
    owned_elements: requireSysMlElementArrayOrNull(record["owned_elements"], "owned_elements"),
  };
}

export function parseSysideSurveyResponse(value: unknown): SysideSurveyResponse {
  const record = requireRecord(value, "SysIDE survey response");
  const projectPath = record["projectPath"];
  // The worker returns "" and the service overwrites it with the workspace
  // path, so an empty string is a valid intermediate value here.
  if (typeof projectPath !== "string") throw new Error("Expected string field: projectPath");
  const packages = record["packages"];
  if (!Array.isArray(packages)) throw new Error("Expected array field: packages");
  return {
    projectPath,
    packages: packages.map((entry, index) => parsePackageSummary(entry, `packages entry ${String(index)}`)),
  };
}

function parsePackageSummary(value: unknown, label: string): PackageSummary {
  const record = requireRecord(value, `SysIDE ${label}`);
  const declared_name = record["declared_name"];
  if (typeof declared_name !== "string") throw new Error(`Expected string field: ${label} declared_name`);
  const qualified_name = requireStringArray(record["qualified_name"], `${label} qualified_name`);
  const element_counts = record["element_counts"];
  if (!isRecord(element_counts)) throw new Error(`Expected object field: ${label} element_counts`);
  const counts: Record<string, number> = {};
  for (const [type, count] of Object.entries(element_counts)) {
    if (!isSupportedElementType(type)) {
      throw new Error(`Unexpected element type ${type} in ${label} element_counts`);
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error(`Expected non-negative integer count for element type ${type} in ${label}`);
    }
    counts[type] = count;
  }
  for (const type of SYSIDE_ELEMENT_TYPES) {
    if (counts[type] === undefined) {
      throw new Error(`Missing count for element type ${type} in ${label}`);
    }
  }
  return { declared_name, qualified_name, element_counts: counts };
}

function isSupportedElementType(type: string): boolean {
  return SYSIDE_ELEMENT_TYPES.some((supported) => supported === type);
}

function parseSysMlElement(value: unknown, label: string): SysMlElement {
  const record = requireRecord(value, `SysIDE ${label}`);
  const type = record["type"];
  if (typeof type !== "string" || type === "") throw new Error(`Expected non-empty string field: ${label} type`);
  const declared_name = record["declared_name"];
  if (typeof declared_name !== "string") throw new Error(`Expected string field: ${label} declared_name`);
  const qualified_name = requireStringArray(record["qualified_name"], `${label} qualified_name`);
  const declared_short_name = requireStringOrNull(record["declared_short_name"], `${label} declared_short_name`);
  return { type, declared_name, qualified_name, declared_short_name };
}

function requireSysMlElementOrNull(value: unknown, key: string): SysMlElement | null {
  if (value === null) return null;
  return parseSysMlElement(value, key);
}

function requireSysMlElementArrayOrNull(value: unknown, key: string): SysMlElement[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error(`Expected array or null field: ${key}`);
  return value.map((entry, index) => parseSysMlElement(entry, `${key} entry ${String(index)}`));
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function requireStringOrNull(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Expected string or null field: ${key}`);
  return value;
}

function requireStringArrayOrNull(value: unknown, key: string): string[] | null {
  if (value === null) return null;
  if (!isStringArray(value)) throw new Error(`Expected string array or null field: ${key}`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!isStringArray(value)) throw new Error(`Expected string array field: ${key}`);
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}