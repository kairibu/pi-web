import type { JsonValue } from "@jmfederico/pi-web/server-plugin-api";

/**
 * One parsed NDJSON response frame from the persistent Python worker:
 * `{id, ok: true, result}` on success, `{id, ok: false, error}` on a
 * structured Python error. Parsed from the raw stdout line by
 * `parseWorkerResponse`; the client correlates `id` against the active
 * request and poisons the worker on any malformed frame.
 */
export type WorkerResponse =
  | { id: number; ok: true; result: JsonValue }
  | { id: number; ok: false; error: string };

/**
 * Parse one raw NDJSON response line into a `WorkerResponse`, rejecting any
 * envelope shape the client cannot trust: malformed JSON, a non-object frame,
 * a non-integer id, a non-boolean ok, a success frame whose result is not a
 * JSON value, or an error frame without an error string.
 */
export function parseWorkerResponse(line: string): WorkerResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("SysIDE Python worker returned malformed JSON");
  }
  if (!isRecord(parsed)) throw new Error("SysIDE Python worker response must be a JSON object");
  const id = parsed["id"];
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("SysIDE Python worker response id must be an integer");
  const ok = parsed["ok"];
  if (ok === true) {
    return { id, ok, result: requireJsonValue(parsed["result"], "SysIDE Python worker response result") };
  }
  if (ok === false) {
    const error = parsed["error"];
    if (typeof error !== "string") throw new Error("SysIDE Python worker error response must include an error string");
    return { id, ok, error };
  }
  throw new Error("SysIDE Python worker response ok must be a boolean");
}

/**
 * Validate an arbitrary JSON-parsed value recursively, returning it narrowed
 * to `JsonValue` or throwing for anything JSON cannot represent (functions,
 * symbols, non-finite numbers, deep-nested unknowns).
 */
export function requireJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const entry of value) output.push(requireJsonValue(entry, label));
    return output;
  }
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) output[key] = requireJsonValue(child, label);
    return output;
  }
  throw new Error(`${label} must contain only JSON values`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}