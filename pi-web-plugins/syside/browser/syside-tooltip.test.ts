// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  defineSysideTooltipElement,
  tooltipElementTag,
  type SysideTooltipElement,
} from "./syside-tooltip.js";

declare global {
  interface HTMLElementTagNameMap {
    "pi-web-syside-tooltip": SysideTooltipElement;
  }
}

function makeContext(insertText?: (text: string) => void): WorkspacePanelContext {
  return {
    machine: { id: "m1", name: "test", kind: "local" },
    workspace: {
      projectId: "p1",
      id: "ws1",
      path: "/home/test/proj",
      label: "Test",
      isMain: true,
    },
    prompt: {
      insertText: insertText ?? vi.fn(),
      getText() {
        return "";
      },
      getSelection() {
        return null;
      },
    },
    terminal: {
      open: vi.fn(),
      runCommand: vi.fn(),
    },
    files: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      moveFile: vi.fn(),
      listFiles: vi.fn(),
    },
    host: {
      requestRender: vi.fn(),
    },
  };
}

function mountTooltip(
  qualifiedName: string[],
  filepath: string | undefined,
  context: WorkspacePanelContext,
): SysideTooltipElement {
  defineSysideTooltipElement();
  const el = document.createElement(tooltipElementTag);
  el.qualifiedName = qualifiedName;
  el.filepath = filepath;
  el.context = context;
  document.body.appendChild(el);
  return el;
}

function taskInput(el: SysideTooltipElement): HTMLInputElement {
  const input = el.shadowRoot?.querySelector<HTMLInputElement>(".tooltip-task-input");
  if (input === null || input === undefined) throw new Error("No task input in shadow root");
  return input;
}

function toolbarButton(el: SysideTooltipElement, className: string): HTMLButtonElement {
  const button = el.shadowRoot?.querySelector<HTMLButtonElement>(`.${className}`);
  if (button === null || button === undefined) throw new Error(`No ${className} button in shadow root`);
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SysideTooltip", () => {
  it("inserts the fixed investigation prompt on lightbulb click", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));

    toolbarButton(el, "tooltip-lightbulb").click();

    expect(insertText).toHaveBeenCalledWith(
      "Investigate m::Wing and summarise its function interfaces and requirements. The element is located in Aircraft.sysml",
    );
  });

  it("reveals the task input on pen click without inserting", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));

    toolbarButton(el, "tooltip-pen").click();

    expect(insertText).not.toHaveBeenCalled();
    expect(taskInput(el).classList.contains("is-visible")).toBe(true);
  });

  it("Enter inserts the edit prompt and hides the input", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));
    toolbarButton(el, "tooltip-pen").click();

    const input = taskInput(el);
    input.value = "Add validation";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(insertText).toHaveBeenCalledWith(
      "Perform task \"Add validation\" for element m::Wing. The element is located in Aircraft.sysml",
    );
    expect(input.classList.contains("is-visible")).toBe(false);
  });

  it("does not insert for an empty or whitespace task on Enter", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));
    toolbarButton(el, "tooltip-pen").click();

    const input = taskInput(el);
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(insertText).not.toHaveBeenCalled();
    expect(input.classList.contains("is-visible")).toBe(true);
  });

  it("Escape hides the input without inserting", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));
    toolbarButton(el, "tooltip-pen").click();

    const input = taskInput(el);
    input.value = "Discard me";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(insertText).not.toHaveBeenCalled();
    expect(input.classList.contains("is-visible")).toBe(false);
  });

  it("blur hides the input without inserting", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));
    toolbarButton(el, "tooltip-pen").click();

    const input = taskInput(el);
    input.value = "Discard me";
    input.dispatchEvent(new FocusEvent("blur"));

    expect(insertText).not.toHaveBeenCalled();
    expect(input.classList.contains("is-visible")).toBe(false);
  });

  it("keeps the input open when focus moves to the lightbulb and inserts on click", () => {
    const insertText = vi.fn();
    const el = mountTooltip(["m", "Wing"], "Aircraft.sysml", makeContext(insertText));
    toolbarButton(el, "tooltip-pen").click();

    const input = taskInput(el);
    const lightbulb = toolbarButton(el, "tooltip-lightbulb");
    // Focus moving to the sibling lightbulb button (inside the shadow root)
    // must not blur-close the open input — the blur handler returns early when
    // the new focus target is still contained by the shadow root, so the user
    // can open the input with the pen and still use the lightbulb.
    input.dispatchEvent(new FocusEvent("blur", { relatedTarget: lightbulb }));

    expect(input.classList.contains("is-visible")).toBe(true);
    lightbulb.click();
    expect(insertText).toHaveBeenCalledTimes(1);
    expect(input.classList.contains("is-visible")).toBe(true);
  });
});
