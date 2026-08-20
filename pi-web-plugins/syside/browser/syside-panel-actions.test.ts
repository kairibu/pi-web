import { describe, expect, it, vi } from "vitest";
import type { PluginPromptEditor } from "@jmfederico/pi-web/plugin-api";
import {
  insertInvestigatePrompt,
  insertTaskPrompt,
  investigateIconSvg,
  taskIconSvg,
} from "./syside-panel-actions.js";

function makePrompt(): { prompt: PluginPromptEditor; insertText: ReturnType<typeof vi.fn> } {
  const insertText = vi.fn();
  const prompt: PluginPromptEditor = {
    insertText,
    getText: () => "",
    getSelection: () => null,
  };
  return { prompt, insertText };
}

describe("insertInvestigatePrompt", () => {
  it("inserts the fixed investigation prompt with a location clause when a file is given", () => {
    const { prompt, insertText } = makePrompt();
    insertInvestigatePrompt(prompt, "Aircraft.sysml", ["m", "Wing"]);
    expect(insertText).toHaveBeenCalledWith(
      "Investigate m::Wing and summarise its function interfaces and requirements. The element is located in Aircraft.sysml",
    );
  });

  it("omits the location clause when the file is undefined or empty", () => {
    const { prompt, insertText } = makePrompt();
    insertInvestigatePrompt(prompt, undefined, ["m", "Wing"]);
    expect(insertText).toHaveBeenCalledWith(
      "Investigate m::Wing and summarise its function interfaces and requirements.",
    );
    insertText.mockClear();
    insertInvestigatePrompt(prompt, "", ["m", "Cabin"]);
    expect(insertText).toHaveBeenCalledWith(
      "Investigate m::Cabin and summarise its function interfaces and requirements.",
    );
  });

  it("is a no-op when no prompt editor is provided", () => {
    expect(() => { insertInvestigatePrompt(undefined, "Aircraft.sysml", ["m", "Wing"]); }).not.toThrow();
  });
});

describe("insertTaskPrompt", () => {
  it("inserts the custom task prompt with a location clause when a file is given", () => {
    const { prompt, insertText } = makePrompt();
    insertTaskPrompt(prompt, "Aircraft.sysml", ["m", "Wing"], "add parameter validation");
    expect(insertText).toHaveBeenCalledWith(
      "Perform task \"add parameter validation\" for element m::Wing. The element is located in Aircraft.sysml",
    );
  });

  it("omits the location clause when the file is undefined", () => {
    const { prompt, insertText } = makePrompt();
    insertTaskPrompt(prompt, undefined, ["m", "Wing"], "refactor");
    expect(insertText).toHaveBeenCalledWith("Perform task \"refactor\" for element m::Wing.");
  });

  it("is a no-op when no prompt editor is provided", () => {
    expect(() => { insertTaskPrompt(undefined, "Aircraft.sysml", ["m", "Wing"], "refactor"); }).not.toThrow();
  });
});

describe("shared icons", () => {
  it("exposes distinct non-empty SVG labels", () => {
    expect(investigateIconSvg).toContain("<svg");
    expect(taskIconSvg).toContain("<svg");
    expect(investigateIconSvg).not.toBe(taskIconSvg);
  });
});
