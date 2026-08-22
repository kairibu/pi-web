import { describe, expect, it, vi } from "vitest";
import type { CapabilityRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import {
  SYSIDE_CHECK_OPERATION,
  SYSIDE_ELEMENT_DETAILS_OPERATION,
  SYSIDE_LIST_ELEMENTS_OPERATION,
  SYSIDE_SURVEY_OPERATION,
  requestSysideCapability,
  type SysideCapabilityService,
  type SysideListElementsFilter,
} from "./syside-backend.js";

interface ServiceCall {
  operation: string;
  workspacePath: string;
  filters?: SysideListElementsFilter;
  qualifiedName?: string[];
}

/** Fake single-model service recording the routed calls. */
function fakeService(): { service: SysideCapabilityService; calls: ServiceCall[] } {
  const calls: ServiceCall[] = [];
  const emptySurvey = {
    projectPath: "",
    packages: [],
  };
  const service: SysideCapabilityService = {
    check: vi.fn((workspacePath: string) => {
      calls.push({ operation: "check", workspacePath });
      return Promise.resolve({ errors: ["Broken model"] });
    }),
    survey: vi.fn((workspacePath: string) => {
      calls.push({ operation: "survey", workspacePath });
      return Promise.resolve(emptySurvey);
    }),
    listElements: vi.fn((workspacePath: string, filters: SysideListElementsFilter) => {
      calls.push({ operation: "list-elements", workspacePath, filters });
      return Promise.resolve([]);
    }),
    elementDetails: vi.fn((workspacePath: string, qualifiedName: string[]) => {
      calls.push({ operation: "element-details", workspacePath, qualifiedName });
      return Promise.resolve({
        type: "syside.PartDefinition",
        declared_name: "Wing",
        qualified_name: ["m", "Wing"],
        declared_short_name: null,
        documentation: null,
        heritage: null,
        subsetting: null,
        filepath: "/repo/Model.sysml",
        subject: null,
        inputs: null,
        outputs: null,
        nested_ports: null,
        nested_actions: null,
        nested_flows: null,
        owned_elements: null,
      });
    }),
  };
  return { service, calls };
}

function requestFor(overrides: Partial<CapabilityRequestContext>): CapabilityRequestContext {
  return {
    workspace: { path: "/repo" },
    operation: SYSIDE_CHECK_OPERATION,
    input: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("requestSysideCapability", () => {
  it("routes check to the service with a null input and returns the validated response", async () => {
    const { service, calls } = fakeService();

    const result = await requestSysideCapability(service, requestFor({ operation: SYSIDE_CHECK_OPERATION }));

    expect(result).toEqual({ errors: ["Broken model"] });
    expect(calls).toEqual([{ operation: "check", workspacePath: "/repo" }]);
  });

  it("routes survey to the service with a null input", async () => {
    const { service, calls } = fakeService();

    await requestSysideCapability(service, requestFor({ operation: SYSIDE_SURVEY_OPERATION, input: null }));

    expect(calls).toEqual([{ operation: "survey", workspacePath: "/repo" }]);
  });

  it("routes list-elements to the service with empty filters when the input is null", async () => {
    const { service, calls } = fakeService();

    await requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: null }));

    expect(calls).toEqual([{ operation: "list-elements", workspacePath: "/repo", filters: {} }]);
  });

  it("routes list-elements with a validated filter object", async () => {
    const { service, calls } = fakeService();

    await requestSysideCapability(service, requestFor({
      operation: SYSIDE_LIST_ELEMENTS_OPERATION,
      input: { type: "syside.PartUsage", packageQualifiedName: ["m"], search: "win", unknownKey: "ignored" },
    }));

    expect(calls).toEqual([{
      operation: "list-elements",
      workspacePath: "/repo",
      filters: { type: "syside.PartUsage", packageQualifiedName: ["m"], search: "win" },
    }]);
  });

  it("routes element-details to the service with the validated qualified name", async () => {
    const { service, calls } = fakeService();

    const result = await requestSysideCapability(service, requestFor({
      operation: SYSIDE_ELEMENT_DETAILS_OPERATION,
      input: { qualifiedName: ["m", "Wing"] },
    }));

    expect(result).toMatchObject({ type: "syside.PartDefinition", declared_name: "Wing" });
    expect(calls).toEqual([{ operation: "element-details", workspacePath: "/repo", qualifiedName: ["m", "Wing"] }]);
  });

  it("rejects unsupported operations and malformed inputs before touching the service", async () => {
    const { service, calls } = fakeService();

    await expect(requestSysideCapability(service, requestFor({ operation: "history", input: null })))
      .rejects.toThrow("Unsupported SysIDE capability operation: history");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_CHECK_OPERATION, input: {} })))
      .rejects.toThrow("SysIDE check input must be null");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_SURVEY_OPERATION, input: {} })))
      .rejects.toThrow("SysIDE survey input must be null");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: 1 })))
      .rejects.toThrow("SysIDE list-elements input must be an object or null");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: { type: "syside.Part" } })))
      .rejects.toThrow("SysIDE list-elements input type must be one of");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: { type: "" } })))
      .rejects.toThrow("SysIDE list-elements input type must be one of");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: { packageQualifiedName: [] } })))
      .rejects.toThrow("packageQualifiedName must be a non-empty array of non-empty strings");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: { packageQualifiedName: ["m", ""] } })))
      .rejects.toThrow("packageQualifiedName must be a non-empty array of non-empty strings");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_LIST_ELEMENTS_OPERATION, input: { search: "" } })))
      .rejects.toThrow("SysIDE list-elements input search must be a non-empty string");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_ELEMENT_DETAILS_OPERATION, input: null })))
      .rejects.toThrow("SysIDE element-details input must be an object");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_ELEMENT_DETAILS_OPERATION, input: { qualifiedName: [] } })))
      .rejects.toThrow("qualifiedName must be a non-empty array of non-empty strings");
    await expect(requestSysideCapability(service, requestFor({ operation: SYSIDE_ELEMENT_DETAILS_OPERATION, input: { qualifiedName: ["m", 7] } })))
      .rejects.toThrow("qualifiedName must be a non-empty array of non-empty strings");
    expect(calls).toEqual([]);
  });
});