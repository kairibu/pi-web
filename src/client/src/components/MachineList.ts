import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Machine, MachineHealth } from "../api";
import { actionMenuPanelStyle } from "./actionMenu";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

@customElement("machine-list")
export class MachineList extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selected?: Machine;
  @property({ attribute: false }) statuses: Record<string, MachineHealth> = {};
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (machine: Machine) => void;
  @property({ attribute: false }) onRemove?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @state() private openMenuMachineId: string | undefined;
  @state() private menuStyle = "";

  private readonly onDocumentClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this)) return;
    this.openMenuMachineId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("machines") && this.openMenuMachineId !== undefined && !this.machines.some((machine) => machine.id === this.openMenuMachineId)) this.openMenuMachineId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuMachineId = undefined;
  }

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.machines.map((machine) => this.renderMachine(machine))}
          </div>
        `}
      </section>
    `;
  }

  private renderMachine(machine: Machine) {
    const status = this.statuses[machine.id]?.status ?? machine.status ?? "unknown";
    const statusLabel = status === "online" ? "online" : status === "offline" ? "offline" : status === "error" ? "error" : "unknown";
    const hasRemoveAction = canRemoveMachine(machine) && this.onRemove !== undefined;
    return html`
      <div
        class=${`action-row machine-row ${this.selected?.id === machine.id ? "selected" : ""} ${hasRemoveAction ? "" : "no-actions"}`}
        tabindex="0"
        title=${machine.baseUrl ?? machine.name}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(machine)); }}
        @keydown=${(event: KeyboardEvent) => { this.handleMachineKeydown(event, machine); }}
      >
        <div class="action-main">
          <span class="action-name">${machine.name}</span><small>${machine.kind === "local" ? "Local Pi Web" : machine.baseUrl ?? "Remote Pi Web"} · ${statusLabel}</small>
        </div>
        ${hasRemoveAction ? this.renderMachineMenu(machine) : null}
      </div>
    `;
  }

  private renderMachineMenu(machine: Machine) {
    const open = this.openMenuMachineId === machine.id;
    const menuId = machineMenuId(machine.id);
    return html`
      <div class="action-menu">
        <button
          class="action-menu-toggle"
          title="Machine actions"
          aria-label=${`Actions for ${machine.name}`}
          aria-expanded=${String(open)}
          aria-controls=${menuId}
          @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(machine.id, event.currentTarget); }}
        >⋯</button>
        ${open ? html`
          <div class="action-menu-panel machine-menu-panel" id=${menuId} style=${this.menuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            <button class="danger" title=${`Remove ${machine.name}`} @click=${() => { this.removeMachine(machine); }}>Remove</button>
          </div>
        ` : null}
      </div>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return "Machines";
    const selectedSummary = this.selected?.name ?? "No machine selected";
    const selectedTitle = this.selected?.baseUrl ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Machines</span><small class="section-selected" title=${selectedTitle}>${selectedSummary}</small></span><small class="section-count">${this.machines.length}</small></button>`;
  }

  private toggleMenu(machineId: string, target: EventTarget | null): void {
    if (this.openMenuMachineId === machineId) {
      this.openMenuMachineId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target);
    this.openMenuMachineId = machineId;
  }

  private removeMachine(machine: Machine): void {
    this.openMenuMachineId = undefined;
    void this.onRemove?.(machine);
  }

  private handleMachineKeydown(event: KeyboardEvent, machine: Machine): void {
    if (event.key === "Escape" && this.openMenuMachineId === machine.id) {
      event.preventDefault();
      event.stopPropagation();
      this.openMenuMachineId = undefined;
      return;
    }
    activateSelectableRowFromKeyboard(event, () => this.onSelect?.(machine));
  }

  static override styles = [
    listStyles,
    css`
      .machine-row.no-actions .action-main { border-radius: 8px; }
      .machine-menu-panel button.danger { color: var(--pi-danger); }
      .machine-menu-panel button.danger:hover, .machine-menu-panel button.danger:focus { background: color-mix(in srgb, var(--pi-danger) 14%, transparent); }
    `,
  ];
}

export function canRemoveMachine(machine: Machine): boolean {
  return machine.kind === "remote";
}

function machineMenuId(machineId: string): string {
  return `machine-menu-${machineId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
