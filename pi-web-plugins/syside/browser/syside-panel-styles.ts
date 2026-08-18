import { activityElementTag } from "./syside-panel-activity.js";

/**
 * Panel styles, injected once per panel render through the `<style>` part.
 * Every rule is scoped under `.syside-panel` so the injected stylesheet only
 * affects the panel subtree.
 */
export const sysidePanelStyles = `
  .syside-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  .syside-panel ${activityElementTag} { display: none; }
  .syside-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
  .syside-panel button:disabled { cursor: wait; opacity: .65; }
  .syside-panel .syside-muted { color: var(--pi-muted); }
  .syside-panel p { margin: 10px; }
  .syside-panel .syside-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .syside-panel .syside-toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .syside-panel .syside-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; }
  .syside-panel .syside-split { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; padding: 4px 0; }
  .syside-panel .syside-error-message { margin: 4px 10px; padding: 6px 8px; border-left: 3px solid var(--pi-danger); color: var(--pi-text); white-space: pre-wrap; }
  .syside-panel .syside-elements { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .syside-panel .syside-elements-submenu { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .syside-panel .syside-elements-submenu select, .syside-panel .syside-elements-submenu input { border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 6px; }
  .syside-panel .syside-elements-submenu input { flex-grow: 1; }
  .syside-panel .syside-submenu-error { color: var(--pi-danger); }
  .syside-panel .syside-elements-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(140px, 40%) minmax(0, 1fr); }
  .syside-panel .syside-elements-list { min-height: 0; overflow: auto; border-bottom: 1px solid var(--pi-border-muted); }
  .syside-panel .syside-element-row { display: grid; grid-template-columns: 80px 1fr minmax(0, 1fr); gap: 8px; align-items: baseline; width: 100%; text-align: left; border: 0; border-radius: 0; background: transparent; margin: 0; padding: 5px 8px; }
  .syside-panel .syside-element-row.has-short { grid-template-columns: 80px auto 1fr minmax(0, 1fr); }
  .syside-panel .syside-element-row:hover, .syside-panel .syside-element-row.is-selected { background: var(--pi-selection-bg); }
  .syside-panel .syside-element-short { text-align: center; font-weight: 600; white-space: nowrap; padding-right: 6px; }
  .syside-panel .syside-element-name, .syside-panel .syside-element-qn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
  .syside-panel .syside-element-type { width: 80px; text-align: left; text-transform: uppercase; font-size: 11px; letter-spacing: .03em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; box-sizing: border-box; justify-self: start; color: var(--pi-muted); }
  .syside-panel .syside-element-qn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .syside-panel .syside-elements-details { min-height: 0; overflow: auto; padding: 8px 10px; }
  .syside-panel .syside-details-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .syside-panel .syside-details-filepath { color: var(--pi-muted); }
  .syside-panel .syside-view-toggle { display: inline-flex; margin: 4px 0 10px; }
  .syside-panel .syside-view-button { border-radius: 0; }
  .syside-panel .syside-view-button:first-child { border-top-left-radius: 7px; border-bottom-left-radius: 7px; }
  .syside-panel .syside-view-button:last-child { border-top-right-radius: 7px; border-bottom-right-radius: 7px; }
  .syside-panel .syside-view-button.is-selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .syside-panel .syside-details-section { margin: 8px 0; }
  .syside-panel .syside-details-section h3 { margin: 0 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--pi-muted); }
  .syside-panel .syside-details-section p { margin: 4px 0; }
  .syside-panel .syside-details-section ul { margin: 4px 0; padding-left: 18px; }
  .syside-panel .syside-details-section li { margin: 2px 0; }
  .syside-panel .syside-link { background: none; border: 0; color: var(--pi-accent); padding: 0; text-decoration: underline; cursor: pointer; }
  .syside-panel .syside-diagram-placeholder { margin: 10px 0; padding: 24px 12px; border: 1px dashed var(--pi-border); border-radius: 7px; color: var(--pi-muted); text-align: center; }
  .syside-panel .syside-overview { padding: 4px 10px; }
  .syside-panel .syside-overview-project { margin: 4px 0; font-size: 12px; }
  .syside-panel .syside-package { margin: 10px 0; }
  .syside-panel .syside-package-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .syside-panel .syside-package-qn { font-size: 12px; }
  .syside-panel .syside-package-counts { list-style: none; margin: 4px 0 0; padding: 0 0 0 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 16px; }
  .syside-panel .syside-package-counts li { display: flex; justify-content: space-between; gap: 8px; }
  .syside-panel .syside-count-type { color: var(--pi-muted); }
  .syside-panel .syside-count-value { font-weight: 600; }
`;