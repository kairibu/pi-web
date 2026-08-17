import { describe, expect, it } from "vitest";
import {
  SYSIDE_ELEMENT_TYPE_LABELS,
  buildListElementsInput,
  elementDisplayName,
  elementShortName,
  elementTypeLabel,
  qualifiedNameDisplay,
  qualifiedNameKey,
} from "./syside-elements-view.js";

describe("qualifiedNameDisplay", () => {
  it("joins segments with '::'", () => {
    expect(qualifiedNameDisplay(["m", "Cabin", "Wing"])).toBe("m::Cabin::Wing");
  });

  it("renders an empty name as an empty string", () => {
    expect(qualifiedNameDisplay([])).toBe("");
  });
});

describe("qualifiedNameKey", () => {
  it("round-trips to the original segments", () => {
    const segments = ["m", "Cabin", "Wing"];
    expect(JSON.parse(qualifiedNameKey(segments))).toEqual(segments);
  });

  it("distinguishes different qualified names and agrees on equal ones", () => {
    expect(qualifiedNameKey(["m", "Wing"])).not.toBe(qualifiedNameKey(["m", "Tail"]));
    expect(qualifiedNameKey(["m", "Cabin"])).toBe(qualifiedNameKey(["m", "Cabin"]));
  });
});

describe("elementDisplayName", () => {
  it("prefers a non-empty declared short name", () => {
    expect(elementDisplayName({ declared_short_name: "R-1", declared_name: "Requirement 1" })).toBe("R-1");
  });

  it("falls back to the declared name for null or empty short names", () => {
    expect(elementDisplayName({ declared_short_name: null, declared_name: "Wing" })).toBe("Wing");
    expect(elementDisplayName({ declared_short_name: "", declared_name: "Wing" })).toBe("Wing");
  });
});

describe("elementShortName", () => {
  it("keeps a declared short name", () => {
    expect(elementShortName({ declared_short_name: "R-1" })).toBe("R-1");
  });

  it("returns an empty cell for null or empty short names so the name column stays distinct", () => {
    expect(elementShortName({ declared_short_name: null })).toBe("");
    expect(elementShortName({ declared_short_name: "" })).toBe("");
  });
});

describe("elementTypeLabel", () => {
  it("maps all six supported contract types to friendly labels", () => {
    expect(elementTypeLabel("syside.PartUsage")).toBe("Part");
    expect(elementTypeLabel("syside.PartDefinition")).toBe("Part definition");
    expect(elementTypeLabel("syside.RequirementUsage")).toBe("Requirement");
    expect(elementTypeLabel("syside.RequirementDefinition")).toBe("Requirement definition");
    expect(elementTypeLabel("syside.ActionUsage")).toBe("Action");
    expect(elementTypeLabel("syside.ActionDefinition")).toBe("Action definition");
  });

  it("pins every supported type to a label and falls back to the raw type", () => {
    for (const type of Object.keys(SYSIDE_ELEMENT_TYPE_LABELS)) {
      expect(SYSIDE_ELEMENT_TYPE_LABELS[type]).toBeTypeOf("string");
    }
    expect(elementTypeLabel("syside.SomethingElse")).toBe("syside.SomethingElse");
  });
});

describe("buildListElementsInput", () => {
  it("returns null when no filter survives", () => {
    expect(buildListElementsInput({})).toBeNull();
    expect(buildListElementsInput({ type: undefined, packageQualifiedName: undefined, search: "" })).toBeNull();
    expect(buildListElementsInput({ search: "   " })).toBeNull();
  });

  it("trims the search term and drops whitespace-only searches", () => {
    expect(buildListElementsInput({ search: "  Wing  " })).toEqual({ search: "Wing" });
  });

  it("includes each filter alone when set", () => {
    expect(buildListElementsInput({ type: "syside.PartUsage" })).toEqual({ type: "syside.PartUsage" });
    expect(buildListElementsInput({ packageQualifiedName: ["m"] })).toEqual({ packageQualifiedName: ["m"] });
  });

  it("combines all three filters in the exact backend shape", () => {
    expect(buildListElementsInput({ type: "syside.PartUsage", packageQualifiedName: ["m", "Cabin"], search: "  Wing  " }))
      .toEqual({ type: "syside.PartUsage", packageQualifiedName: ["m", "Cabin"], search: "Wing" });
  });
});