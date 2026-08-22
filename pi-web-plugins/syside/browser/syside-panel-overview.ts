import type { HtmlTemplateTag, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { SYSIDE_ELEMENT_TYPES } from "./syside-contract.js";
import { elementTypeLabel, qualifiedNameDisplay } from "./syside-elements-view.js";
import type { SysideUiController } from "./syside-panel-controller.js";
import type { SysideWorkspaceUiState } from "./syside-panel-state.js";

/**
 * The check-result split content: error messages, or the muted idle/loading
 * hint. Error <p>s stay direct children of the split so the fallback keeps
 * the same DOM shape as the original check rendering.
 */
export function renderCheckResult(html: HtmlTemplateTag, state: SysideWorkspaceUiState) {
  if (state.errors !== undefined) {
    // Only error messages, each a direct child of the split; an empty error
    // list renders an empty split.
    return state.errors.map((message) => html`<p class="syside-error-message">${message}</p>`);
  }
  if (state.error !== undefined) return null;
  return html`<p class="syside-muted">${state.loading ? "Running SysIDE check…" : "Run SysIDE check."}</p>`;
}

/**
 * The default overview view: the loaded model's packages and per-type element
 * counts once the survey has packages, otherwise the check-result fallback
 * (survey still loading, survey failed, or no packages to summarize).
 */
export function renderOverview(
  html: HtmlTemplateTag,
  state: SysideWorkspaceUiState,
  controller: SysideUiController,
  context: WorkspacePanelContext,
) {
  if (state.surveyError !== undefined) return renderCheckResult(html, state);
  if (state.survey === undefined) {
    if (state.surveyLoading) return html`<p class="syside-muted">Loading overview…</p>`;
    return renderCheckResult(html, state);
  }
  if (state.survey.packages.length === 0) return renderCheckResult(html, state);
  return renderOverviewContent(html, state, controller, context);
}

/** Compact package summary list: package link plus the non-zero element-count links. */
function renderOverviewContent(
  html: HtmlTemplateTag,
  state: SysideWorkspaceUiState,
  controller: SysideUiController,
  context: WorkspacePanelContext,
) {
  // Unreachable through renderOverview (the survey is checked before the
  // call): kept only so TypeScript narrows state.survey to non-undefined here.
  const survey = state.survey;
  if (survey === undefined) return null;
  return html`
    <section class="syside-overview">
      <header class="syside-package-header">
        <strong>Model Overview</strong>
      </header>
      <p class="syside-overview-project syside-muted">${survey.projectPath}</p>
      <ul class="syside-package-list">
        ${survey.packages.map((pkg) => {
          const entries = packageCountEntries(pkg);
          return html`
            <li class="syside-package-item">
              <button
                type="button"
                class="syside-link syside-package-link"
                title=${qualifiedNameDisplay(pkg.qualified_name)}
                @click=${() => { controller.openPackage(context, pkg.qualified_name); }}
              >${pkg.declared_name !== "" ? pkg.declared_name : qualifiedNameDisplay(pkg.qualified_name)}</button>
              <span class="syside-package-summary">${entries.length === 0
                ? "no counted elements"
                : entries.map((entry, index) => html`${index > 0 ? ", " : null}<button
                    type="button"
                    class="syside-link syside-type-count-link"
                    @click=${() => { controller.openPackage(context, pkg.qualified_name, entry.type); }}
                  >${compactElementTypeLabel(entry.type)}: ${entry.count}</button>`)}</span>
            </li>
          `;
        })}
      </ul>
    </section>
  `;
}

/** Non-zero per-type element counts of a surveyed package, in the canonical type order. */
function packageCountEntries(pkg: { element_counts: Record<string, number> }): { type: string; count: number }[] {
  return SYSIDE_ELEMENT_TYPES.flatMap((type) => {
    const count = pkg.element_counts[type];
    if (count === undefined || count <= 0) return [];
    return [{ type, count }];
  });
}

function compactElementTypeLabel(type: string): string {
  switch (type) {
    case "syside.PartUsage":
      return "parts";
    case "syside.PartDefinition":
      return "part defs";
    case "syside.RequirementUsage":
      return "requirements";
    case "syside.RequirementDefinition":
      return "requirement defs";
    case "syside.ActionUsage":
      return "actions";
    case "syside.ActionDefinition":
      return "action defs";
    default:
      return elementTypeLabel(type);
  }
}

