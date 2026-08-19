# Plan: Package/type-count links in the overview list → open elements view filtered

Feature: in the SysIDE panel overview (check) view, make each package in the
package list a clickable link. Clicking a package switches the panel to the
elements view and applies that package as the `packageQualifiedName` filter
(issuing exactly one `list-elements` request). Additionally, each per-type
element count ("parts: 3", "requirements: 2", …) becomes its own clickable
link that opens the elements view filtered by *both* the package and that
type (`packageQualifiedName` + `type`).

Scope: browser layer only — no backend, contract, or worker protocol changes.
The `packageQualifiedName`/`type` list-elements path already exists
end-to-end (`buildListElementsInput({ type, packageQualifiedName, search })`
in `syside-panel-controller.ts:167`).

## Steps

1. **Add a single orchestration method
   `openPackage(context, qualifiedName: string[], type?: string)`**
   to `SysideUiController` in `browser/syside-panel-controller.ts`
   (place it right after `setPackageFilter`, around lines 208–212). It must:
   - `state.packageFilter = qualifiedName;`
   - `state.typeFilter = type;` — the `type` parameter doubles as the reset:
     a plain package-name click passes `undefined` and therefore *clears*
     any stale type filter (intent: "show all elements of this package"),
     while a type-count click passes that type. This is a deliberate
     difference from the "Owning package" `<select>`, which only changes one
     filter dimension.
   - `state.view = "elements";`
   - `if (state.survey === undefined && state.surveyRequest === undefined) void this.loadSurvey(context);`
     (same guard `setView` uses)
   - `this.refreshList(context);` (this already clears any pending
     `searchTimer` and bumps `listRequestSequence`)
   - `this.requestRender(state);` (needed for the immediate view switch;
     `refreshList` only re-renders on resolution)
   - Add a JSDoc comment explaining why it does one refresh instead of
     composing `setPackageFilter`/`setTypeFilter` + `setView` (which would
     refresh multiple times) and documenting the `type` reset semantics.
   - Do **not** clear `searchText` — preserve it to stay consistent with the
     existing filter `<select>`/search semantics.

2. **Thread `controller`/`context` into the overview renderer** in
   `browser/syside-panel-overview.ts`:
   - Change `renderOverview(html, state)` →
     `renderOverview(html, state, controller, context)` and pass both through
     to `renderOverviewContent`.
   - Change `renderOverviewContent(html, state)` →
     `renderOverviewContent(html, state, controller, context)`.
   - Add imports:
     `import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";`
     and
     `import type { SysideUiController } from "./syside-panel-controller.js";`
     (type-only imports avoid any runtime cycle; this is the same pattern
     `syside-panel-elements.ts` uses).

3. **Convert the package name span and the per-type counts to link buttons**
   in `renderOverviewContent` (`browser/syside-panel-overview.ts`,
   line ~51).

   Package name — replace:

   ```html
   <span class="syside-package-name">${pkg.declared_name !== "" ? pkg.declared_name : qualifiedNameDisplay(pkg.qualified_name)}</span>
   ```

   with:

   ```html
   <button
     type="button"
     class="syside-link syside-package-link"
     title=${qualifiedNameDisplay(pkg.qualified_name)}
     @click=${() => { controller.openPackage(context, pkg.qualified_name); }}
   >${pkg.declared_name !== "" ? pkg.declared_name : qualifiedNameDisplay(pkg.qualified_name)}</button>
   ```

   Per-type counts — replace the single joined-string summary produced by
   `summarizePackageCounts(pkg)` with per-type entry buttons. Rework
   `summarizePackageCounts` into a helper that returns the non-zero entries
   (e.g. `packageCountEntries(pkg): Array<{ type: string; count: number }>`
   using `SYSIDE_ELEMENT_TYPES` as before), and render them in the summary
   span:

   ```html
   <span class="syside-package-summary">
     ${entries.map((entry, index) => html`
       ${index > 0 ? ", " : null}
       <button
         type="button"
         class="syside-link syside-type-count-link"
         @click=${() => { controller.openPackage(context, pkg.qualified_name, entry.type); }}
       >${compactElementTypeLabel(entry.type)}: ${entry.count}</button>
     `)}
   </span>
   ```

   Keep the "no counted elements" fallback as plain muted text. The two
   extra classes (`syside-package-link`, `syside-type-count-link`) give the
   tests stable selectors now that each package row contains multiple
   `.syside-link` buttons; styling comes from the existing `.syside-link`
   rule (accent color, underline, no border, `cursor: pointer`).

4. **Update the dispatch call site** in `browser/syside-panel.ts`,
   `renderSysideSplit` (line ~107):

   ```ts
   return renderOverview(html, state);
   ```

   →

   ```ts
   return renderOverview(html, state, controller, context);
   ```

5. **Clean up dead CSS** in `browser/syside-panel-styles.ts`: remove the
   now-unused `.syside-panel .syside-package-name { … }` rule (line 54). Keep
   `.syside-package-summary`. No new CSS is required for the buttons —
   `.syside-link` already provides the link look; optionally add a small
   `padding-left`/`margin` rule for `.syside-type-count-link` only if visual
   spacing between the comma-separated buttons turns out to be too tight.

6. **Update and add tests** in `pi-web-plugin.test.ts`:
   - In "renders the model overview as a compact package summary list on
     initial connect" (lines ~286–289): change the two `.syside-package-name`
     `querySelector` assertions to `.syside-package-link`; optionally assert
     the name button's `title` is the qualified-name display (e.g.
     `m::Cabin`). The `.syside-package-summary` assertions remain valid —
     the summary's `textContent` still reads `"parts: 1"` (button text plus
     separators, unchanged as a string).
   - Add a test (e.g. "opens the elements view filtered to a package from the
     overview link") that:
     - uses
       `backendFixture({ errors: [], survey: [packageFixture("m", ["m"]), packageFixture("Cabin", ["m", "Cabin"])] })`
     - renders + `await settleBackend()` + re-renders to reach the overview
     - clicks `button(container, "Cabin")`
     - asserts `backend.request` was called with
       `("list-elements", { packageQualifiedName: ["m", "Cabin"] })`
       (no `type` key — the plain package click must clear the type filter)
     - asserts exactly one `list-elements` call
       (`backend.request.mock.calls.filter(([operation]) => operation === "list-elements")`
       has length 1), pinning the no-double-refresh behavior
     - `await settleBackend()` + `render(panel.render(context), container)`
     - asserts `.syside-elements-submenu` exists,
       `select[aria-label='Owning package']` has
       `.value === JSON.stringify(["m", "Cabin"])`,
       `select[aria-label='Element type']` has `.value === ""`, and the
       "Elements" toolbar button has `aria-pressed === "true"`
     - ends with `render(null, container)`
   - Add a second test (e.g. "opens the elements view filtered to a package
     and type from a type-count link") that:
     - uses a survey fixture where a package has a non-zero count for at
       least one type (the existing `packageFixture` already yields
       `"parts: 1"`)
     - renders + `await settleBackend()` + re-renders to reach the overview
     - clicks the count button via a stable selector, e.g. the
       `.syside-type-count-link` button inside the "Cabin" package row
       (`button(container, "parts: 1")` also works if the helper matches on
       `textContent` and no other button collides)
     - asserts `backend.request` was called with
       `("list-elements", { packageQualifiedName: ["m", "Cabin"], type: "syside.PartUsage" })`
     - asserts exactly one `list-elements` call
     - `await settleBackend()` + re-render
     - asserts `select[aria-label='Owning package']` has
       `.value === JSON.stringify(["m", "Cabin"])` and
       `select[aria-label='Element type']` has
       `.value === "syside.PartUsage"`
     - ends with `render(null, container)`
   - If a test covers a stale type filter being cleared by a plain package
     click, drive it via `controller` state or a prior elements-view
     interaction; otherwise the "no `type` key" assertion above already
     covers the reset for the common path.

## Files to modify

- `browser/syside-panel-controller.ts` — add `openPackage()` method (sets
  package filter + optional type filter + view, one `refreshList`).
- `browser/syside-panel-overview.ts` — extend
  `renderOverview`/`renderOverviewContent` signatures; convert the name
  `<span>` and the per-type count entries to `.syside-link` `<button>`s
  wired to `openPackage`; rework `summarizePackageCounts` into an
  entries helper.
- `browser/syside-panel.ts` — pass `controller`/`context` to
  `renderOverview` in `renderSysideSplit`.
- `browser/syside-panel-styles.ts` — remove the now-unused
  `.syside-package-name` rule.
- `pi-web-plugin.test.ts` — update overview selectors and add the two
  click-through tests (package link, type-count link).

## New files

None.

## Risks

- **Double refresh**: composing `setPackageFilter`/`setTypeFilter` +
  `setView` would fire multiple `list-elements` requests (the first while
  still on the overview view). The single `openPackage` method avoids this;
  both new tests' "exactly one list-elements call" assertion guards against
  regression.
- **Color override**: do not keep the `syside-package-name` class on the
  buttons alongside `syside-link` — its `color: var(--pi-text)` rule sits
  later in the stylesheet and would defeat the accent "link" look. Remove the
  rule.
- **Type-filter reset semantics**: a plain package-name click now *clears*
  the type filter (via `state.typeFilter = type` with `type === undefined`).
  This differs from the package `<select>` (which leaves the type filter
  alone) but matches the click intent ("everything in this package");
  document it in the `openPackage` JSDoc and pin it with the "no `type` key"
  test assertion.
- **Search carry-over**: `searchText` from a previous elements-view session
  persists into the filtered list (same as the existing filter semantics).
  This is intentional for consistency, but a stale search could yield an
  empty list; verify the composed-filter test still passes unchanged.
- **Selector stability**: the `button(container, …)` test helper matches on
  `textContent`, and each package row now contains several `.syside-link`
  buttons (name + one per non-zero type count). Prefer the dedicated
  `.syside-package-link` / `.syside-type-count-link` classes in tests, and
  keep the summary separators (`, `) as text nodes *between* buttons rather
  than inside them, so `textContent` matching on the summary still yields
  `"parts: 1"` and button-text collisions stay unlikely.
- **No backend/contract/protocol changes** are needed — the
  `packageQualifiedName` + `type` list-elements path already exists
  end-to-end; this change stays entirely in the browser layer.

## Verification

- `npm test -- --run pi-web-plugin.test.ts`
- `npm run typecheck`
- `npx eslint browser/syside-panel-controller.ts browser/syside-panel-overview.ts browser/syside-panel.ts browser/syside-panel-styles.ts pi-web-plugin.test.ts`

(all from the repo root)
