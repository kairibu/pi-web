// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ProjectDialog } from "./ProjectDialog";
import { deepActiveElement, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("project-dialog modal surface", () => {
  it("focuses the project path input when opened", async () => {
    const dialog = await mountDialog();

    expect(deepActiveElement()).toBe(pathInput(dialog));
  });

  // Regression proof for the pre-surface latent bug: the keydown listener lived
  // on the path input, so Escape with any other control focused did nothing.
  it("cancels on Escape from a control other than the path input", async () => {
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog({ onCancel });
    const checkbox = createCheckbox(dialog);
    checkbox.focus();

    pressKey(checkbox, "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("submits the typed path on Enter in the path input", async () => {
    const onSubmit = vi.fn<(path: string, create: boolean) => void>();
    const dialog = await mountDialog({ onSubmit });
    const input = pathInput(dialog);
    input.value = "/work/new-project";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await settleRenderedDialog(dialog);

    pressKey(input, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("/work/new-project", true);
  });
});

interface ProjectDialogProps {
  onSubmit?: (path: string, create: boolean) => void;
  onCancel?: () => void;
}

async function mountDialog(props: ProjectDialogProps = {}): Promise<ProjectDialog> {
  vi.spyOn(api, "projectDirectories").mockResolvedValue([]);
  const dialog = new ProjectDialog();
  if (props.onSubmit !== undefined) dialog.onSubmit = props.onSubmit;
  if (props.onCancel !== undefined) dialog.onCancel = props.onCancel;
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}

function pathInput(dialog: ProjectDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("label input"), "project-dialog path input");
}

function createCheckbox(dialog: ProjectDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[type='checkbox']"), "project-dialog create checkbox");
}
