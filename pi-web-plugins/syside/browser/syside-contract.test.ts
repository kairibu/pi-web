import { describe, expect, it } from "vitest";
import {
  SYSIDE_CHECK_OPERATION,
  SYSIDE_ELEMENT_DETAILS_OPERATION,
  SYSIDE_ELEMENT_TYPES,
  SYSIDE_LIST_ELEMENTS_OPERATION,
  SYSIDE_SURVEY_OPERATION,
  parseSysideCheckResponse,
  parseSysideElementDetailsResponse,
  parseSysideListElementsResponse,
  parseSysideSurveyResponse,
} from "./syside-contract.js";

describe("SysIDE operation constants", () => {
  it("uses hyphenated backend operation names the host validates", () => {
    expect(SYSIDE_CHECK_OPERATION).toBe("check");
    expect(SYSIDE_LIST_ELEMENTS_OPERATION).toBe("list-elements");
    expect(SYSIDE_SURVEY_OPERATION).toBe("survey");
    expect(SYSIDE_ELEMENT_DETAILS_OPERATION).toBe("element-details");
  });

  it("pins the supported element type names the Python worker mirrors", () => {
    expect(SYSIDE_ELEMENT_TYPES).toEqual([
      "syside.PartUsage",
      "syside.PartDefinition",
      "syside.RequirementUsage",
      "syside.RequirementDefinition",
      "syside.ActionUsage",
      "syside.ActionDefinition",
    ]);
  });
});

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

describe("parseSysideListElementsResponse", () => {
  it("parses a valid element list", () => {
    const value = [
      { type: "syside.PartUsage", declared_name: "Wing", qualified_name: ["m", "Wing"], declared_short_name: null },
      { type: "syside.PartDefinition", declared_name: "Car", qualified_name: ["m", "Car"], declared_short_name: "C" },
    ];

    expect(parseSysideListElementsResponse(value)).toEqual(value);
  });

  it("accepts an empty list", () => {
    expect(parseSysideListElementsResponse([])).toEqual([]);
  });

  it("rejects non-arrays and malformed elements", () => {
    expect(() => parseSysideListElementsResponse(null)).toThrow("must be an array");
    expect(() => parseSysideListElementsResponse(["Wing"])).toThrow("must be an object");
    expect(() => parseSysideListElementsResponse([{}])).toThrow("Expected non-empty string field: list-elements entry 0 type");
    expect(() => parseSysideListElementsResponse([{ type: "syside.PartUsage" }]))
      .toThrow("Expected string field: list-elements entry 0 declared_name");
    expect(() => parseSysideListElementsResponse([{ type: "syside.PartUsage", declared_name: "Wing" }]))
      .toThrow("Expected string array field: list-elements entry 0 qualified_name");
    expect(() => parseSysideListElementsResponse([{ type: "syside.PartUsage", declared_name: "Wing", qualified_name: [] }]))
      .toThrow("Expected string or null field: list-elements entry 0 declared_short_name");
    expect(() => parseSysideListElementsResponse([{ type: "", declared_name: "Wing", qualified_name: [], declared_short_name: null }]))
      .toThrow("Expected non-empty string field: list-elements entry 0 type");
  });
});

describe("parseSysideElementDetailsResponse", () => {
  it("parses a valid element detail", () => {
    const value = {
      type: "syside.PartDefinition",
      declared_name: "Car",
      qualified_name: ["m", "Car"],
      declared_short_name: null,
      documentation: ["Car part definition."],
      heritage: [{ type: "syside.PartDefinition", declared_name: "Vehicle", qualified_name: ["m", "Vehicle"], declared_short_name: null }],
      subsetting: null,
      filepath: "/repo/Model.sysml",
      subject: null,
      inputs: null,
      outputs: null,
    };

    expect(parseSysideElementDetailsResponse(value)).toEqual(value);
  });

  it("accepts null lists and a subject element", () => {
    const value = {
      type: "syside.RequirementUsage",
      declared_name: "r",
      qualified_name: ["m", "r"],
      declared_short_name: "R-1",
      documentation: null,
      heritage: null,
      subsetting: null,
      filepath: "file:///repo/Model.sysml",
      subject: { type: "syside.PartDefinition", declared_name: "Vehicle", qualified_name: ["m", "Vehicle"], declared_short_name: null },
      inputs: [{ type: "syside.ReferenceUsage", declared_name: "a", qualified_name: ["m", "go", "a"], declared_short_name: null }],
      outputs: [],
    };

    expect(parseSysideElementDetailsResponse(value)).toEqual(value);
  });

  it("rejects malformed detail fields", () => {
    const base = {
      type: "syside.PartDefinition",
      declared_name: "Car",
      qualified_name: ["m", "Car"],
      declared_short_name: null,
    };
    expect(() => parseSysideElementDetailsResponse({ ...base, documentation: "text" }))
      .toThrow("Expected string array or null field: documentation");
    expect(() => parseSysideElementDetailsResponse({ ...base, documentation: null, heritage: [{}] }))
      .toThrow("Expected non-empty string field: heritage entry 0 type");
    expect(() => parseSysideElementDetailsResponse({ ...base, documentation: null, heritage: null, subsetting: "x" }))
      .toThrow("Expected array or null field: subsetting");
    expect(() => parseSysideElementDetailsResponse({ ...base, documentation: null, heritage: null, subsetting: null, filepath: 5 }))
      .toThrow("Expected string field: filepath");
    expect(() => parseSysideElementDetailsResponse({ ...base, documentation: null, heritage: null, subsetting: null, filepath: "p", subject: 7 }))
      .toThrow("SysIDE subject must be an object");
    expect(() => parseSysideElementDetailsResponse({ ...base, documentation: null, heritage: null, subsetting: null, filepath: "p", subject: null, inputs: "in" }))
      .toThrow("Expected array or null field: inputs");
    expect(() => parseSysideElementDetailsResponse(null)).toThrow("must be an object");
  });
});

describe("parseSysideSurveyResponse", () => {
  it("parses a valid survey with projectPath and package counts", () => {
    const value = {
      projectPath: "",
      packages: [
        {
          declared_name: "m",
          qualified_name: ["m"],
          element_counts: {
            "syside.PartUsage": 1,
            "syside.PartDefinition": 2,
            "syside.RequirementUsage": 0,
            "syside.RequirementDefinition": 0,
            "syside.ActionUsage": 0,
            "syside.ActionDefinition": 0,
          },
        },
      ],
    };

    expect(parseSysideSurveyResponse(value)).toEqual(value);
  });

  it("accepts an empty package list", () => {
    expect(parseSysideSurveyResponse({ projectPath: "/repo", packages: [] }))
      .toEqual({ projectPath: "/repo", packages: [] });
  });

  it("rejects malformed surveys", () => {
    expect(() => parseSysideSurveyResponse(null)).toThrow("SysIDE survey response must be an object");
    expect(() => parseSysideSurveyResponse({ packages: [] })).toThrow("Expected string field: projectPath");
    expect(() => parseSysideSurveyResponse({ projectPath: "/repo", packages: "x" }))
      .toThrow("Expected array field: packages");
    expect(() => parseSysideSurveyResponse({ projectPath: "/repo", packages: [{}] }))
      .toThrow("Expected string field: packages entry 0 declared_name");
    expect(() => parseSysideSurveyResponse({ projectPath: "/repo", packages: [{ declared_name: "m" }] }))
      .toThrow("Expected string array field: packages entry 0 qualified_name");
    expect(() => parseSysideSurveyResponse({ projectPath: "/repo", packages: [{ declared_name: "m", qualified_name: ["m"] }] }))
      .toThrow("Expected object field: packages entry 0 element_counts");
    expect(() => parseSysideSurveyResponse({
      projectPath: "/repo",
      packages: [{ declared_name: "m", qualified_name: ["m"], element_counts: { "syside.PartUsage": -1 } }],
    })).toThrow("Expected non-negative integer count for element type syside.PartUsage in packages entry 0");
    expect(() => parseSysideSurveyResponse({
      projectPath: "/repo",
      packages: [{ declared_name: "m", qualified_name: ["m"], element_counts: { "syside.PartUsage": "1" } }],
    })).toThrow("Expected non-negative integer count for element type syside.PartUsage in packages entry 0");
    expect(() => parseSysideSurveyResponse({
      projectPath: "/repo",
      packages: [{ declared_name: "m", qualified_name: ["m"], element_counts: { "syside.BogusType": 0 } }],
    })).toThrow("Unexpected element type syside.BogusType in packages entry 0 element_counts");
    expect(() => parseSysideSurveyResponse({
      projectPath: "/repo",
      packages: [{ declared_name: "m", qualified_name: ["m"], element_counts: { "syside.PartUsage": 0 } }],
    })).toThrow("Missing count for element type syside.PartDefinition in packages entry 0");
  });
});