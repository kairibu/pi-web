import { describe, expect, it } from "vitest";
import { parseSysideCheckResponse } from "./syside-contract.js";

describe("parseSysideCheckResponse", () => {
  it("parses a valid error list", () => {
    expect(parseSysideCheckResponse({ errors: ["Unknown reference 'Wing'", ""] }))
      .toEqual({ errors: ["Unknown reference 'Wing'", ""] });
  });

  it("accepts an empty error list", () => {
    expect(parseSysideCheckResponse({ errors: [] })).toEqual({ errors: [] });
  });

  it("rejects non-object responses and malformed error fields", () => {
    expect(() => parseSysideCheckResponse(null)).toThrow("SysIDE check response must be an object");
    expect(() => parseSysideCheckResponse(["errors"])).toThrow("SysIDE check response must be an object");
    expect(() => parseSysideCheckResponse({})).toThrow("Expected string array field: errors");
    expect(() => parseSysideCheckResponse({ errors: "boom" })).toThrow("Expected string array field: errors");
    expect(() => parseSysideCheckResponse({ errors: [1] })).toThrow("Expected string array field: errors");
  });
});
