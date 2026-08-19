import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { qualifiedNameDisplay } from "./syside-elements-view.js";
import { contextPrompt, editPrompt } from "./syside-prompts.js";

export const tooltipElementTag = "pi-web-syside-tooltip";

/**
 * Public property surface of the tooltip custom element. Host code and tests
 * use this type for property bindings and typed DOM lookups; it backs the
 * `HTMLElementTagNameMap` entry for the tag in both test files.
 */
export interface SysideTooltipElement extends HTMLElement {
  qualifiedName: string[];
  filepath: string | undefined;
  context: WorkspacePanelContext | undefined;
}

const TOOLTIP_STYLES = `
  :host {
    display: inline-block;
    position: relative;
  }

  .tooltip-overlay {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 6px;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 120ms ease, visibility 120ms ease;
    background: var(--pi-bg-overlay);
    border: 1px solid var(--pi-border);
    border-radius: 6px;
    padding: 4px;
    box-shadow: 0 4px 12px var(--pi-shadow);
  }

  :host(:hover) .tooltip-overlay,
  :host(:focus-within) .tooltip-overlay {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }

  .tooltip-overlay button {
    background: var(--pi-surface-hover);
    border: 1px solid var(--pi-border);
    border-radius: 4px;
    padding: 3px 5px;
    cursor: pointer;
    color: var(--pi-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tooltip-overlay button:hover {
    background: var(--pi-selection-bg);
  }

  .tooltip-task-input {
    background: var(--pi-surface);
    border: 1px solid var(--pi-border);
    border-radius: 4px;
    color: var(--pi-text);
    font-size: 12px;
    padding: 3px 6px;
    min-width: 220px;
    outline: 2px solid var(--pi-accent-border);
    display: none;
  }

  .tooltip-task-input.is-visible {
    display: block;
  }

  .tooltip-task-input::placeholder {
    color: var(--pi-dim);
  }
`;

const LIGHTBULB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;

const PENCIL_SPARKLES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3H8"/><path d="m15.007 5.008 3.987 3.986"/><path d="M20 15v4"/><path d="M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="M22 17h-4"/><path d="M4 5v4"/><path d="M6 7H2"/><path d="M9 2v2"/></svg>`;

/**
 * Vanilla custom element wrapping an element name or relationship link in the
 * SysIDE details view. On hover it reveals a lightbulb action that inserts a
 * fixed investigation prompt and a pen action that opens an inline task input
 * whose submitted text is inserted as a custom prompt. Purely imperative (no
 * Lit), because plugin modules load without an import map and a shadow root is
 * cheap to build by hand.
 *
 * Safe to call more than once on the same page: it re-registers only when the
 * custom element is not defined yet.
 */
export function defineSysideTooltipElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(tooltipElementTag) !== undefined) return;
  class SysideTooltipElement extends HTMLElement {
    private qualifiedNameValue: string[] = [];
    private filepathValue: string | undefined;
    private contextValue: WorkspacePanelContext | undefined;
    private from_qnValue : string[] | undefined;
    private editing = false;
    private shadow: ShadowRoot | undefined;
    private input: HTMLInputElement | undefined;

    // lit-html 3.x re-commits object property parts on every render, so these
    // setters fire even when their value is unchanged. They must stay cheap and
    // side-effect-free, storing the value for the click/keydown handlers below.
    set qualifiedName(value: string[]) {
      this.qualifiedNameValue = value;
    }

    get qualifiedName(): string[] {
      return this.qualifiedNameValue;
    }

    set filepath(value: string | undefined) {
      this.filepathValue = value;
    }

    get filepath(): string | undefined {
      return this.filepathValue;
    }

    set context(value: WorkspacePanelContext | undefined) {
      this.contextValue = value;
    }

    get context(): WorkspacePanelContext | undefined {
      return this.contextValue;
    }

    set from_qn(value: string[] | undefined) {
      this.from_qnValue = value;
    }

    get from_qn(): string[] | undefined {
      return this.from_qnValue;
    }
    
    connectedCallback(): void {
      if (this.shadow !== undefined) return;
      const shadow = this.attachShadow({ mode: "open" });
      this.shadow = shadow;
      shadow.innerHTML = `
        <style>${TOOLTIP_STYLES}</style>
        <slot></slot>
        <div class="tooltip-overlay" role="group">
          <button type="button" class="tooltip-lightbulb" aria-label="Investigate element">${LIGHTBULB_SVG}</button>
          <button type="button" class="tooltip-pen" aria-label="Custom task for element">${PENCIL_SPARKLES_SVG}</button>
          <input type="text" class="tooltip-task-input" aria-label="Task for element" placeholder="Task for element" />
        </div>
      `;

      const input = shadow.querySelector<HTMLInputElement>(".tooltip-task-input");
      this.input = input ?? undefined;

      shadow.querySelector<HTMLButtonElement>(".tooltip-lightbulb")?.addEventListener("click", () => {
        this.contextValue?.prompt.insertText(
          contextPrompt(this.filepathValue, qualifiedNameDisplay(this.qualifiedNameValue)),
        );
      });

      shadow.querySelector<HTMLButtonElement>(".tooltip-pen")?.addEventListener("click", () => {
        if (this.editing) {
          // Already open: refocus and clear so the user can start a new task.
          if (this.input !== undefined) {
            this.input.value = "";
            this.input.focus();
          }
          return;
        }
        this.openInput();
      });

      input?.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          const task = input.value.trim();
          if (task === "") return;
          this.contextValue?.prompt.insertText(
            editPrompt(this.filepathValue, qualifiedNameDisplay(this.qualifiedNameValue), task),
          );
          this.closeInput();
        } else if (e.key === "Escape") {
          this.closeInput();
        }
      });

      input?.addEventListener("blur", (e: FocusEvent) => {
        const related = e.relatedTarget;
        if (related instanceof Node && (this.shadow?.contains(related) ?? false)) return;
        this.closeInput();
      });
    }

    private openInput(): void {
      if (this.input === undefined) return;
      this.editing = true;
      this.input.value = "";
      this.input.classList.add("is-visible");
      this.input.focus();
    }

    private closeInput(): void {
      if (this.input === undefined) return;
      this.editing = false;
      this.input.value = "";
      this.input.classList.remove("is-visible");
    }
  }
  customElements.define(tooltipElementTag, SysideTooltipElement);
}
