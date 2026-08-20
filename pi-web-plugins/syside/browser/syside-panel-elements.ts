import type { HtmlTemplateTag, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  SYSIDE_ELEMENT_TYPES,
  type SysMlElement,
  type SysMlElementDetail,
} from "./syside-contract.js";
import {
  elementDisplayName,
  elementShortName,
  elementTypeLabel,
  qualifiedNameDisplay,
  qualifiedNameKey,
} from "./syside-elements-view.js";
import type { SysideUiController } from "./syside-panel-controller.js";
import type { SysideWorkspaceUiState } from "./syside-panel-state.js";
import { defineSysideActionPaletteElement } from "./syside-panel-palette.js";
import { defineSysideTooltipElement } from "./syside-tooltip.js";

export function renderElementView(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  defineSysideSelectSyncElement();
  defineSysideTooltipElement();
  defineSysideActionPaletteElement();
  return html`
    <section class="syside-elements">
      ${renderElementsSubmenu(html, state, controller, context)}
      <div class="syside-elements-body">
        <div class="syside-elements-list">${renderElementList(html, state, controller, context)}</div>
        <div class="syside-elements-details">${renderElementDetails(html, state, controller, context)}</div>
      </div>
    </section>
  `;
}

function renderElementsSubmenu(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    <div class="syside-elements-submenu">
      <select
        aria-label="Element type"
        .value=${state.typeFilter ?? ""}
        @change=${(event: Event) => {
          if (!(event.target instanceof HTMLSelectElement)) return;
          const value = event.target.value;
          controller.setTypeFilter(context, value === "" ? undefined : value);
        }}
      >
        <option value="">All types</option>
        ${SYSIDE_ELEMENT_TYPES.map((type) => html`<option value=${type}>${elementTypeLabel(type)}</option>`)}
      </select>
      <select
        aria-label="Owning package"
        .value=${packageFilterSelectValue(state)}
        ?disabled=${state.surveyLoading || state.surveyError !== undefined}
        @change=${(event: Event) => {
          if (!(event.target instanceof HTMLSelectElement)) return;
          controller.setPackageFilter(context, packageNameFromSelectValue(event.target.value));
        }}
      >
        ${state.surveyError !== undefined
          ? html`<option value="">Packages unavailable</option>`
          : state.survey === undefined || state.surveyLoading
            ? html`<option value="">Loading packages…</option>`
            : html`
              <option value="">All packages</option>
              ${state.survey.packages.map((pkg) => html`<option value=${JSON.stringify(pkg.qualified_name)}>${pkg.declared_name !== "" ? pkg.declared_name : qualifiedNameDisplay(pkg.qualified_name)}</option>`)}
            `}
      </select>
      <input
        type="search"
        aria-label="Search elements"
        placeholder="Search name…"
        .value=${state.searchText}
        @input=${(event: Event) => {
          if (!(event.target instanceof HTMLInputElement)) return;
          controller.setSearch(context, event.target.value);
        }}
      >
      ${state.surveyError === undefined ? null : html`<span class="syside-submenu-error" role="alert">${state.surveyError}</span>`}
      <!-- Imperatively syncs the filter <select> values below after their
           <option> children commit. Lit binds a <select>'s .value before its
           options exist on the first submenu render (and again when the survey
           resolves later), so a pre-set package/type filter would otherwise be
           dropped. Plugins cannot import lit/directives/ref.js to do this from
           a directive (plugin modules load with no import map, so only
           relative imports resolve), so a scoped custom element owns the
           post-commit fixup instead. -->
      <pi-web-syside-select-sync .state=${state}></pi-web-syside-select-sync>
    </div>
  `;
}

function renderElementList(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  if (state.listLoading && state.elements === undefined) return html`<p class="syside-muted">Loading elements…</p>`;
  if (state.listError !== undefined) return html`<p class="syside-error-message">${state.listError}</p>`;
  if (state.elements === undefined || state.elements.length === 0) return html`<p class="syside-muted">No elements.</p>`;
  const selectedKey = state.selectedQualifiedName === undefined ? undefined : qualifiedNameKey(state.selectedQualifiedName);
    return state.elements.map((element) => {
    const shortName = elementShortName(element);
    const isSelected = selectedKey === qualifiedNameKey(element.qualified_name);
    const rowClass = `${isSelected ? "syside-element-row is-selected" : "syside-element-row"}${shortName ? " has-short" : ""}`;
    return html`
      <button
        type="button"
        class=${rowClass}
        @click=${() => { controller.selectElement(context, element.qualified_name); }}
      >
        <span class="syside-element-type">${elementTypeLabel(element.type)}</span>
        ${shortName ? html`<span class="syside-element-short">&lt;${shortName}&gt;</span>` : null}
        <span class="syside-element-name">${element.declared_name}</span>
        <span class="syside-element-qn">${qualifiedNameDisplay(element.qualified_name)}</span>
      </button>
    `;
  });
}

function renderElementDetails(html: HtmlTemplateTag, state: SysideWorkspaceUiState, controller: SysideUiController, context: WorkspacePanelContext) {
  if (state.selectedQualifiedName === undefined) return html`<p class="syside-muted">Select an element.</p>`;
  if (state.detailsLoading) return html`<p class="syside-muted">Loading details…</p>`;
  if (state.detailsError !== undefined) return html`<p class="syside-error-message">${state.detailsError}</p>`;
  const details = state.details;
  if (details === undefined) return null;
  return html`
    <div class="syside-details-content">
      <header class="syside-details-header">
        <strong>${qualifiedNameDisplay(details.qualified_name)}</strong>
        <span class="syside-muted">${elementTypeLabel(details.type)}</span>
        <small class="syside-details-filepath">${details.filepath}</small>
      </header>
      ${state.diagramMode
        ? html`<div class="syside-diagram-placeholder">Diagram view coming soon</div>`
        : renderTextualDetails(html, details, controller, context)}
    </div>
    <aside class="syside-action-palette">
      <div class="syside-view-toggle" role="group" aria-label="View mode">
        <button
          type="button"
          class=${state.diagramMode ? "syside-view-button" : "syside-view-button is-selected"}
          aria-pressed=${String(!state.diagramMode)}
          @click=${() => { controller.setDiagramMode(context, false); }}
        >Text</button>
        <button
          type="button"
          class=${state.diagramMode ? "syside-view-button is-selected" : "syside-view-button"}
          aria-pressed=${String(state.diagramMode)}
          @click=${() => { controller.setDiagramMode(context, true); }}
        >Diagram</button>
      </div>
      <pi-web-syside-action-palette .qualifiedName=${details.qualified_name} .filepath=${details.filepath} .context=${context}></pi-web-syside-action-palette>
    </aside>
  `;
}

function renderTextualDetails(html: HtmlTemplateTag, details: SysMlElementDetail, controller: SysideUiController, context: WorkspacePanelContext) {
  return html`
    ${renderStringSection(html, "Documentation", details.documentation)}
    ${renderElementListSection(html, "Heritage", details.heritage, controller, context, details.qualified_name)}
    ${renderElementListSection(html, "Subsetting", details.subsetting, controller, context, details.qualified_name)}
    ${renderElementSection(html, "Subject", details.subject, controller, context, details.qualified_name)}
    ${renderElementListSection(html, "Inputs", details.inputs, controller, context, details.qualified_name)}
    ${renderElementListSection(html, "Outputs", details.outputs, controller, context, details.qualified_name)}
  `;
}

function renderStringSection(html: HtmlTemplateTag, label: string, values: string[] | null) {
  return html`
    <section class="syside-details-section">
      <h3>${label}</h3>
      ${values === null || values.length === 0
        ? html`<p class="syside-muted">—</p>`
        : html`${values.map((value) => html`<p>${value}</p>`)}`}
    </section>
  `;
}

function renderElementListSection(html: HtmlTemplateTag, label: string, elements: SysMlElement[] | null, controller: SysideUiController, context: WorkspacePanelContext, from_qn: string[]) {
  return html`
    <section class="syside-details-section">
      <h3>${label}</h3>
      ${elements === null || elements.length === 0
        ? html`<p class="syside-muted">—</p>`
        : html`<ul>${elements.map((element) => renderElementLink(html, element, controller, context, from_qn))}</ul>`}
    </section>
  `;
}

function renderElementSection(html: HtmlTemplateTag, label: string, element: SysMlElement | null, controller: SysideUiController, context: WorkspacePanelContext, from_qn: string[]) {
  return html`
    <section class="syside-details-section">
      <h3>${label}</h3>
      ${element === null
        ? html`<p class="syside-muted">—</p>`
        : html`<ul>${renderElementLink(html, element, controller, context, from_qn)}</ul>`}
    </section>
  `;
}

function renderElementLink(html: HtmlTemplateTag, element: SysMlElement, controller: SysideUiController, context: WorkspacePanelContext, from_qn: string[]) {
  //todo: from_qn is not used, because its not handled by tooltip. 
  return html`
    <li>
      <pi-web-syside-tooltip .qualifiedName=${element.qualified_name} .context=${context} .from_qn=${from_qn}>
        <button
          type="button"
          class="syside-link"
          @click=${() => { controller.selectElement(context, element.qualified_name); }}
        >${elementDisplayName(element)}</button>
      </pi-web-syside-tooltip>
    </li>
  `;
}

function packageFilterSelectValue(state: SysideWorkspaceUiState): string {
  return state.packageFilter === undefined ? "" : JSON.stringify(state.packageFilter);
}

function packageNameFromSelectValue(value: string): string[] | undefined {
  if (value === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((segment) => typeof segment === "string") ? parsed : undefined;
  } catch {
    // Only reachable for values the panel itself did not generate.
    return undefined;
  }
}

const selectSyncElementTag = "pi-web-syside-select-sync";

/**
 * Hidden element rendered at the end of the elements submenu. It owns the
 * imperative post-commit sync of the filter <select> values (see the comment
 * at its render site for why this cannot be a declarative .value/?selected
 * binding or a lit/directives/ref.js directive). Safe to call repeatedly: it
 * registers only once.
 */
export function defineSysideSelectSyncElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(selectSyncElementTag) !== undefined) return;
  class SysideSelectSyncElement extends HTMLElement {
    private stateValue: SysideWorkspaceUiState | undefined;
    private syncScheduled = false;

    // lit-html 3.x re-commits object property parts on every render, so this
    // setter fires even when the state reference is unchanged — that is what
    // makes the sync re-run when a late-resolving survey finally populates the
    // package options after the first render.
    set state(value: SysideWorkspaceUiState | undefined) {
      this.stateValue = value;
      this.scheduleSync();
    }

    connectedCallback(): void {
      this.scheduleSync();
    }

    private scheduleSync(): void {
      if (this.syncScheduled) return;
      this.syncScheduled = true;
      queueMicrotask(() => {
        this.syncScheduled = false;
        const state = this.stateValue;
        if (!this.isConnected || state === undefined) return;
        const submenu = this.closest(".syside-elements-submenu");
        if (submenu === null) return;
        const typeSelect = submenu.querySelector<HTMLSelectElement>("select[aria-label='Element type']");
        if (typeSelect !== null) typeSelect.value = state.typeFilter ?? "";
        const packageSelect = submenu.querySelector<HTMLSelectElement>("select[aria-label='Owning package']");
        if (packageSelect !== null) packageSelect.value = packageFilterSelectValue(state);
      });
    }
  }
  customElements.define(selectSyncElementTag, SysideSelectSyncElement);
}
