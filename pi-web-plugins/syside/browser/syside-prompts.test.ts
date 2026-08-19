import { describe, expect, it } from "vitest";
import { contextPrompt, editPrompt } from "./syside-prompts.js";

describe("contextPrompt", () => {
  it("includes the file clause when a file is provided", () => {
    expect(contextPrompt("Aircraft.sysml", "m::Wing")).toBe(
      "Investigate m::Wing and summarise its function interfaces and requirements. The element is located in Aircraft.sysml",
    );
  });

  it("omits the file clause when the file is undefined", () => {
    expect(contextPrompt(undefined, "m::Wing")).toBe(
      "Investigate m::Wing and summarise its function interfaces and requirements.",
    );
  });

  it("omits the file clause when the file is an empty string", () => {
    expect(contextPrompt("", "m::Wing")).toBe(
      "Investigate m::Wing and summarise its function interfaces and requirements.",
    );
  });
});

describe("editPrompt", () => {
  it("includes the file clause when a file is provided", () => {
    expect(editPrompt("Aircraft.sysml", "m::Wing", "add parameter validation")).toBe(
      "Perform task \"add parameter validation\" for element m::Wing. The element is located in Aircraft.sysml",
    );
  });

  it("omits the file clause when the file is undefined", () => {
    expect(editPrompt(undefined, "m::Wing", "refactor")).toBe(
      "Perform task \"refactor\" for element m::Wing.",
    );
  });

  it("omits the file clause when the file is an empty string", () => {
    expect(editPrompt("", "m::Wing", "refactor")).toBe("Perform task \"refactor\" for element m::Wing.");
  });
});
