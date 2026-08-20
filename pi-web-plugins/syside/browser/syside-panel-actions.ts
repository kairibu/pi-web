import type { PluginPromptEditor } from "@jmfederico/pi-web/plugin-api";
import { qualifiedNameDisplay } from "./syside-elements-view.js";
import { contextPrompt, editPrompt } from "./syside-prompts.js";

/**
 * Toolbar icon for the fixed "Investigate" action (lightbulb).
 *
 * Shared by the detail-view action palette and the relationship-link tooltip
 * so both present the same action affordance. Rendered as a static SVG string
 * (no import map for plugin modules, so no template literal) with
 * `aria-hidden` because each use is paired with a real `aria-label` button.
 */
export const investigateIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;

/**
 * Toolbar icon for the custom "Task" action (pencil with sparkles).
 * Same sharing rationale and accessibility contract as `investigateIconSvg`.
 */
export const taskIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3H8"/><path d="m15.007 5.008 3.987 3.986"/><path d="M20 15v4"/><path d="M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="M22 17h-4"/><path d="M4 5v4"/><path d="M6 7H2"/><path d="M9 2v2"/></svg>`;

/**
 * Insert the fixed investigation prompt for an element into the given prompt
 * editor. `filepath` is optional (relationship elements may have no source
 * file); an absent/empty file simply omits the location clause of the prompt.
 */
export function insertInvestigatePrompt(
  prompt: PluginPromptEditor | undefined,
  filepath: string | undefined,
  qualifiedName: string[],
): void {
  prompt?.insertText(contextPrompt(filepath, qualifiedNameDisplay(qualifiedName)));
}

/**
 * Insert a custom-task prompt for an element into the given prompt editor.
 * `task` is expected to be already trimmed and non-empty (the callers gate
 * submission on that before calling); `filepath` is optional as above.
 */
export function insertTaskPrompt(
  prompt: PluginPromptEditor | undefined,
  filepath: string | undefined,
  qualifiedName: string[],
  task: string,
): void {
  prompt?.insertText(editPrompt(filepath, qualifiedNameDisplay(qualifiedName), task));
}
