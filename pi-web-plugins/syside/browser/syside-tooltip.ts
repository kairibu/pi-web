import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  insertInvestigatePrompt,
  insertTaskPrompt,
  investigateIconSvg,
  taskIconSvg,
} from "./syside-panel-actions.js";

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
          <button type="button" class="tooltip-lightbulb" aria-label="Investigate element">${investigateIconSvg}</button>
          <button type="button" class="tooltip-pen" aria-label="Custom task for element">${taskIconSvg}</button>
          <input type="text" class="tooltip-task-input" aria-label="Task for element" placeholder="Task for element" />
        </div>
      `;

      const input = shadow.querySelector<HTMLInputElement>(".tooltip-task-input");
      this.input = input ?? undefined;

      shadow.querySelector<HTMLButtonElement>(".tooltip-lightbulb")?.addEventListener("click", () => {
        insertInvestigatePrompt(this.contextValue?.prompt, this.filepathValue, this.qualifiedNameValue);
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
          insertTaskPrompt(this.contextValue?.prompt, this.filepathValue, this.qualifiedNameValue, task);
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
