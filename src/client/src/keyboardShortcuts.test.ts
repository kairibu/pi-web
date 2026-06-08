import { describe, expect, it, vi } from "vitest";
import type { AppAction } from "./actions";
import { KeyboardShortcutDispatcher, type ShortcutKeyEvent } from "./keyboardShortcuts";

function keyEvent(key: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    ...modifiers,
  };
}

function action(shortcut: string, enabled = true) {
  const run = vi.fn();
  const value: AppAction = {
    id: shortcut,
    title: shortcut,
    shortcut,
    enabled,
    run,
  };
  return { value, run };
}

describe("KeyboardShortcutDispatcher", () => {
  it("runs an enabled matching modified shortcut", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+k");

    const handled = dispatcher.handle(keyEvent("k", { metaKey: true }), [value]);

    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores plain letters so normal typing is never captured", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("r");

    const handled = dispatcher.handle(keyEvent("r"), [value]);

    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores disabled matching shortcuts", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+enter", false);

    const handled = dispatcher.handle(keyEvent("Enter", { ctrlKey: true }), [value]);

    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("requires shift for shift shortcuts", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+shift+r");

    expect(dispatcher.handle(keyEvent("r", { ctrlKey: true }), [value])).toBe(false);
    expect(dispatcher.handle(keyEvent("r", { ctrlKey: true, shiftKey: true }), [value])).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a shortcut sequence that starts with a modified key", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const { value, run } = action("mod+g p");

    expect(dispatcher.handle(keyEvent("g", { ctrlKey: true }), [value])).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(dispatcher.handle(keyEvent("p"), [value])).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to a standalone modified shortcut when a pending sequence misses", () => {
    const dispatcher = new KeyboardShortcutDispatcher();
    const sequence = action("mod+g p");
    const standalone = action("mod+k");

    expect(dispatcher.handle(keyEvent("g", { ctrlKey: true }), [sequence.value, standalone.value])).toBe(true);
    expect(dispatcher.handle(keyEvent("k", { ctrlKey: true }), [sequence.value, standalone.value])).toBe(true);
    expect(sequence.run).not.toHaveBeenCalled();
    expect(standalone.run).toHaveBeenCalledTimes(1);
  });
});
