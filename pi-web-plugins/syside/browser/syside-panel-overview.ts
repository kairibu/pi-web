import type { HtmlTemplateTag } from "@jmfederico/pi-web/plugin-api";
import { SYSIDE_ELEMENT_TYPES } from "./syside-contract.js";
import { elementTypeLabel, qualifiedNameDisplay } from "./syside-elements-view.js";
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
export function renderOverview(html: HtmlTemplateTag, state: SysideWorkspaceUiState) {
  if (state.surveyError !== undefined) return renderCheckResult(html, state);
  if (state.survey === undefined) {
    if (state.surveyLoading) return html`<p class="syside-muted">Loading overview…</p>`;
    return renderCheckResult(html, state);
  }
  if (state.survey.packages.length === 0) return renderCheckResult(html, state);
  return renderOverviewContent(html, state);
}

/** One package card per surveyed package, with one count row per supported element type. */
function renderOverviewContent(html: HtmlTemplateTag, state: SysideWorkspaceUiState) {
  // Unreachable through renderOverview (the survey is checked before the
  // call): kept only so TypeScript narrows state.survey to non-undefined here.
  const survey = state.survey;
  if (survey === undefined) return null;
  return html`
    <section class="syside-overview">
      <p class="syside-overview-project syside-muted">${survey.projectPath}</p>
      ${survey.packages.map((pkg) => html`
        <section class="syside-package">
          <header class="syside-package-header">
            <strong>${pkg.declared_name !== "" ? pkg.declared_name : qualifiedNameDisplay(pkg.qualified_name)}</strong>
            ${pkg.qualified_name.length === 0 ? null : html`<span class="syside-package-qn syside-muted">${qualifiedNameDisplay(pkg.qualified_name)}</span>`}
          </header>
          <ul class="syside-package-counts">
            ${SYSIDE_ELEMENT_TYPES.map((type) => html`
              <li>
                <span class="syside-count-type">${elementTypeLabel(type)}</span>
                <span class="syside-count-value">${String(pkg.element_counts[type])}</span>
              </li>
            `)}
          </ul>
        </section>
      `)}
    </section>
  `;
}

