import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  insertInvestigatePrompt,
  insertTaskPrompt,
  investigateIconSvg,
  taskIconSvg,
} from "./syside-panel-actions.js";

export const actionPaletteElementTag = "pi-web-syside-action-palette";

/**
 * Public property surface of the action palette custom element. Host code and
 * tests use this type for property bindings and typed DOM lookups.
 */
export interface SysideActionPaletteElement extends HTMLElement {
  qualifiedName: string[];
  filepath: string | undefined;
  context: WorkspacePanelContext | undefined;
}

const PALETTE_STYLES = `
  :host {
    display: block;
  }

  .palette {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .palette button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--pi-surface-hover);
    border: 1px solid var(--pi-border);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    color: var(--pi-text-secondary);
  }

  .palette button:hover {
    background: var(--pi-selection-bg);
  }

  .palette-input {
    background: var(--pi-surface);
    border: 1px solid var(--pi-border);
    border-radius: 4px;
    color: var(--pi-text);
    font-size: 12px;
    padding: 4px 6px;
    min-width: 200px;
    outline: 2px solid var(--pi-accent-border);
    display: none;
  }

  .palette-input.is-visible {
    display: block;
  }

  .palette-input::placeholder {
    color: var(--pi-dim);
  }
`;

/**
 * Vanilla custom element providing horizontal Investigate and Task controls
 * plus a conditional inline task input, for the selected element in the
 * SysIDE detail view. The Investigate button inserts a fixed investigation
 * prompt; the Task button opens an inline input whose submitted text is
 * inserted as a custom prompt. Purely imperative (no Lit), because plugin
 * modules load without an import map and a shadow root is cheap to build by
 * hand.
 *
 * Interaction semantics mirror the relationship-link tooltip: a trimmed
 * non-empty Enter submits, Escape or blur closes without inserting, and
 * reselecting Task while the input is open clears and refocuses it.
 *
 * Safe to call more than once on the same page: it re-registers only when the
 * custom element is not defined yet.
 */
export function defineSysideActionPaletteElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(actionPaletteElementTag) !== undefined) return;
  class SysideActionPaletteElement extends HTMLElement {
    private qualifiedNameValue: string[] = [];
    private filepathValue: string | undefined;
    private contextValue: WorkspacePanelContext | undefined;
    private editing = false;
    private shadow: ShadowRoot | undefined;
    private input: HTMLInputElement | undefined;

    // lit-html 3.x re-commits object property parts on every render, so these
    // setters fire even when their value is unchanged. They must stay cheap,
    // storing the value for the click/keydown handlers below.
    //
    // The host reuses the same palette DOM node across element selections, so
    // a genuinely changed element identity must close an open task input:
    // otherwise the stale typed text would be submitted against the new
    // element's qualified name. Reference equality is the right cheap check —
    // the qualified_name array is stable for the loaded details, and any
    // replacement (new element or details reload) is a new reference. The
    // same guard on filepath covers identity changes that the qualified name
    // misses.
    set qualifiedName(value: string[]) {
      if (value !== this.qualifiedNameValue) {
        this.qualifiedNameValue = value;
        this.closeInput();
      }
    }

    get qualifiedName(): string[] {
      return this.qualifiedNameValue;
    }

    set filepath(value: string | undefined) {
      if (value !== this.filepathValue) {
        this.filepathValue = value;
        this.closeInput();
      }
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

    connectedCallback(): void {
      if (this.shadow !== undefined) return;
      const shadow = this.attachShadow({ mode: "open" });
      this.shadow = shadow;
      shadow.innerHTML = `
        <style>${PALETTE_STYLES}</style>
        <div class="palette" role="group" aria-label="Element actions">
          <button type="button" class="palette-investigate" aria-label="Investigate element">${investigateIconSvg}<span>Investigate</span></button>
          <button type="button" class="palette-task" aria-label="Custom task for element">${taskIconSvg}<span>Task</span></button>
          <input type="text" class="palette-input" aria-label="Task for element" placeholder="Task for element" />
        </div>
      `;

      const input = shadow.querySelector<HTMLInputElement>(".palette-input");
      this.input = input ?? undefined;

      shadow.querySelector<HTMLButtonElement>(".palette-investigate")?.addEventListener("click", () => {
        insertInvestigatePrompt(this.contextValue?.prompt, this.filepathValue, this.qualifiedNameValue);
      });

      shadow.querySelector<HTMLButtonElement>(".palette-task")?.addEventListener("click", () => {
        if (this.editing) {
          // Reselection with the input already open: refocus and clear so the
          // user can start a new task.
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
  customElements.define(actionPaletteElementTag, SysideActionPaletteElement);
}
