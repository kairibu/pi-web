import { describe, expect, it } from "vitest";
import {
  isRecord,
  parseWorkerResponse,
  requireJsonValue,
  type WorkerResponse,
} from "./syside-worker-protocol.js";

describe("parseWorkerResponse", () => {
  it("parses a structured success frame with a JSON result", () => {
    const response = parseWorkerResponse(JSON.stringify({ id: 7, ok: true, result: { errors: ["boom"] } }));
    expect(response).toEqual({ id: 7, ok: true, result: { errors: ["boom"] } });
  });

  it("parses a structured Python error frame with an error string", () => {
    const response = parseWorkerResponse(JSON.stringify({ id: 7, ok: false, error: "No model" }));
    expect(response).toEqual({ id: 7, ok: false, error: "No model" });
  });

  it("rejects malformed JSON", () => {
    expect(() => parseWorkerResponse("this is not json")).toThrow("malformed JSON");
  });

  it("rejects a frame that is not a JSON object", () => {
    expect(() => parseWorkerResponse(JSON.stringify([1, 2]))).toThrow("must be a JSON object");
    expect(() => parseWorkerResponse("null")).toThrow("must be a JSON object");
    expect(() => parseWorkerResponse("42")).toThrow("must be a JSON object");
  });

  it("rejects a frame whose id is not an integer", () => {
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1.5, ok: true, result: null }))).toThrow("id must be an integer");
    expect(() => parseWorkerResponse(JSON.stringify({ id: "1", ok: true, result: null }))).toThrow("id must be an integer");
    expect(() => parseWorkerResponse(JSON.stringify({ id: null, ok: true, result: null }))).toThrow("id must be an integer");
  });

  it("rejects a success frame whose result is not a JSON value", () => {
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1, ok: true }))).toThrow("result must contain only JSON values");
  });

  it("rejects an error frame without an error string", () => {
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1, ok: false }))).toThrow("must include an error string");
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1, ok: false, error: 42 }))).toThrow("must include an error string");
  });

  it("rejects a frame whose ok is not a boolean", () => {
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1, ok: "maybe" }))).toThrow("ok must be a boolean");
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1, ok: 1 }))).toThrow("ok must be a boolean");
    expect(() => parseWorkerResponse(JSON.stringify({ id: 1, ok: null }))).toThrow("ok must be a boolean");
  });

  it("accepts a fully-populated success payload (round trip)", () => {
    const line = JSON.stringify({
      id: 3,
      ok: true,
      result: {
        projectPath: "/model",
        packages: [{ declared_name: "m", qualified_name: ["m"], element_counts: { "syside.PartUsage": 1 } }],
      },
    });
    const parsed = parseWorkerResponse(line);
    const response: WorkerResponse = parsed;
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        projectPath: "/model",
        packages: [{ declared_name: "m", qualified_name: ["m"], element_counts: { "syside.PartUsage": 1 } }],
      });
    }
  });
});

describe("requireJsonValue", () => {
  it("accepts primitives and returns them narrowed", () => {
    expect(requireJsonValue(null, "frame")).toBeNull();
    expect(requireJsonValue("text", "frame")).toBe("text");
    expect(requireJsonValue(true, "frame")).toBe(true);
    expect(requireJsonValue(3.5, "frame")).toBe(3.5);
  });

  it("rejects non-finite numbers", () => {
    expect(() => requireJsonValue(Number.NaN, "frame")).toThrow("finite JSON numbers");
    expect(() => requireJsonValue(Number.POSITIVE_INFINITY, "frame")).toThrow("finite JSON numbers");
  });

  it("rewrites arrays recursively", () => {
    expect(requireJsonValue([1, "a", null, [true, 2]], "frame")).toEqual([1, "a", null, [true, 2]]);
    expect(() => requireJsonValue([1, () => undefined], "frame")).toThrow("only JSON values");
  });

  it("rewrites objects recursively", () => {
    expect(requireJsonValue({ a: { b: ["x"] } }, "frame")).toEqual({ a: { b: ["x"] } });
    expect(() => requireJsonValue({ a: { b: Symbol("x") } }, "frame")).toThrow("only JSON values");
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => requireJsonValue(undefined, "frame")).toThrow("only JSON values");
    expect(() => requireJsonValue(() => undefined, "frame")).toThrow("only JSON values");
  });
});

describe("isRecord", () => {
  it("identifies plain JSON objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});