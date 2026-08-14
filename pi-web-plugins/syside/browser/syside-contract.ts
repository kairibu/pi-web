export const SYSIDE_CHECK_OPERATION = "check";

/** JSON result of a SysIDE check: the error messages reported for the project. */
export interface SysideCheckResponse {
  errors: string[];
}

export function parseSysideCheckResponse(value: unknown): SysideCheckResponse {
  const record = requireRecord(value, "SysIDE check response");
  return { errors: requireStringArray(record["errors"], "errors") };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Expected string array field: ${key}`);
  }
  return value;
}
