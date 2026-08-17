import type { SysideListElementsFilter } from "./syside-contract.js";

/**
 * Human-readable labels for the supported SysML element types, keyed by the
 * contract type names used by the backend ("syside.PartUsage", …). Unknown
 * types fall back to their raw contract name rather than an invented label.
 */
export const SYSIDE_ELEMENT_TYPE_LABELS: Record<string, string> = {
  "syside.PartUsage": "Part",
  "syside.PartDefinition": "Part definition",
  "syside.RequirementUsage": "Requirement",
  "syside.RequirementDefinition": "Requirement definition",
  "syside.ActionUsage": "Action",
  "syside.ActionDefinition": "Action definition",
};

/** Display form of a qualified name: segments joined with "::". */
export function qualifiedNameDisplay(segments: string[]): string {
  return segments.join("::");
}

/**
 * Identity form of a qualified name: the segment array itself serialized, so
 * two distinct selections/filters compare by value instead of by reference.
 */
export function qualifiedNameKey(segments: string[]): string {
  return JSON.stringify(segments);
}

/** Preferred display name: the declared short name when present, else the declared name. */
export function elementDisplayName(element: { declared_short_name: string | null; declared_name: string }): string {
  return element.declared_short_name !== null && element.declared_short_name !== ""
    ? element.declared_short_name
    : element.declared_name;
}

/**
 * Column form of the short name for list rows: empty when no short name is
 * declared, so the short-name and name columns stay distinct instead of both
 * showing the declared name.
 */
export function elementShortName(element: { declared_short_name: string | null }): string {
  return element.declared_short_name !== null && element.declared_short_name !== "" ? element.declared_short_name : "";
}

/** Label for a contract element type, with the raw type as fallback. */
export function elementTypeLabel(type: string): string {
  return SYSIDE_ELEMENT_TYPE_LABELS[type] ?? type;
}

/**
 * Build the list-elements filter input from the panel's filter state.
 * The search term is trimmed and dropped when empty; type/package filters are
 * dropped when unset; returns null when no filter survives (the backend
 * accepts null for list-elements).
 */
export function buildListElementsInput(filters: {
  type?: string | undefined;
  packageQualifiedName?: string[] | undefined;
  search?: string | undefined;
}): SysideListElementsFilter | null {
  const input: SysideListElementsFilter = {};
  if (filters.type !== undefined) input.type = filters.type;
  if (filters.packageQualifiedName !== undefined) input.packageQualifiedName = filters.packageQualifiedName;
  const search = filters.search?.trim();
  if (search !== undefined && search !== "") input.search = search;
  return Object.keys(input).length === 0 ? null : input;
}