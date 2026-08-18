import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { SysideUiController } from "./syside-panel-controller.js";
import { workspaceContextKey } from "./syside-panel-state.js";

export const activityElementTag = "pi-web-syside-panel-activity";

/**
 * Define the hidden `<pi-web-syside-panel-activity>` element that connects the
 * panel to the workspace. It renders nothing and triggers (and later
 * disconnects) the controller's load-once flow from real lifecycle callbacks,
 * never from the render path — a failed check/survey therefore cannot re-enter
 * itself through a re-render as an infinite retry loop.
 *
 * Safe to call more than once on the same page: it re-registers only when the
 * custom element is not defined yet.
 */
export function defineSysidePanelActivityElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined" || customElements.get(activityElementTag) !== undefined) return;
  class SysidePanelActivityElement extends HTMLElement {
    private controllerValue: SysideUiController | undefined;
    private contextValue: WorkspacePanelContext | undefined;

    // lit-html 3.x re-commits object property parts on every render, so these
    // setters fire even when their value is unchanged. Guard both so an
    // unchanged `controller` / `context` (same workspace) does not call
    // connect() again; otherwise a failed check's requestRender would re-enter
    // connect() -> check() -> failure -> requestRender as an infinite retry.
    set controller(value: SysideUiController | undefined) {
      if (this.controllerValue === value) return;
      this.controllerValue = value;
      this.connect();
    }

    set context(value: WorkspacePanelContext | undefined) {
      const previousKey = this.contextValue === undefined ? undefined : workspaceContextKey(this.contextValue);
      this.contextValue = value;
      if (previousKey !== (value === undefined ? undefined : workspaceContextKey(value))) this.connect();
    }

    connectedCallback(): void {
      this.connect();
    }

    disconnectedCallback(): void {
      if (this.controllerValue !== undefined && this.contextValue !== undefined) {
        this.controllerValue.disconnect(this.contextValue);
      }
    }

    private connect(): void {
      if (!this.isConnected || this.controllerValue === undefined || this.contextValue === undefined) return;
      this.controllerValue.connect(this.contextValue);
    }
  }
  customElements.define(activityElementTag, SysidePanelActivityElement);
}