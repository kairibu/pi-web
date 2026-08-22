/**
 * Pure prompt builders for the SysIDE details tooltip.
 *
 * The `file` clause is emitted only when a non-empty filepath is available.
 * Relationship elements are plain `SysMlElement` values (no `filepath`), so the
 * caller passes the current detail's filepath as the best available location
 * context; an absent file simply omits the clause while keeping the trailing
 * period intact.
 */
function locationClause(file: string | undefined): string {
  return file !== undefined && file !== "" ? ` The element is located in ${file}` : "";
}

/** Fixed investigation prompt inserted by the lightbulb action. */
export function contextPrompt(file: string | undefined, qualifiedName: string): string {
  return `Investigate ${qualifiedName} and summarise its function interfaces and requirements.${locationClause(file)}`;
}

/** Custom-task prompt inserted when the user submits a task for an element. */
export function editPrompt(file: string | undefined, qualifiedName: string, task: string): string {
  return `Perform task "${task}" for element ${qualifiedName}.${locationClause(file)}`;
}
