import type { AppAction } from "./actions";

const sequenceTimeoutMs = 1200;

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  target: EventTarget | null;
}

export class KeyboardShortcutDispatcher {
  private pendingTokens: string[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  handle(event: ShortcutKeyEvent, actions: AppAction[]): boolean {
    const token = eventToken(event);
    if (token === undefined) return false;

    const shortcuts = actions
      .filter((action) => action.shortcut !== undefined && action.enabled !== false)
      .map((action) => ({ action, tokens: normalizeShortcut(action.shortcut ?? "") }))
      .filter((entry) => entry.tokens.length > 0);

    if (this.pendingTokens.length > 0) {
      const handledPending = this.handleSequence([...this.pendingTokens, token], shortcuts);
      if (handledPending) return true;
      this.clearPending();
      if (!isModifiedShortcut(token)) return false;
    } else if (!isModifiedShortcut(token)) return false;

    return this.handleSequence([token], shortcuts);
  }

  reset(): void {
    this.clearPending();
  }

  private handleSequence(sequence: string[], shortcuts: { action: AppAction; tokens: string[] }[]): boolean {
    const exact = shortcuts.find((entry) => sameTokens(entry.tokens, sequence));
    if (exact !== undefined) {
      this.clearPending();
      void exact.action.run();
      return true;
    }

    const hasPrefix = shortcuts.some((entry) => startsWithTokens(entry.tokens, sequence));
    if (hasPrefix) {
      this.setPending(sequence);
      return true;
    }

    return false;
  }

  private setPending(tokens: string[]): void {
    this.clearPending();
    this.pendingTokens = tokens;
    this.pendingTimer = globalThis.setTimeout(() => {
      this.pendingTokens = [];
      this.pendingTimer = undefined;
    }, sequenceTimeoutMs);
  }

  private clearPending(): void {
    this.pendingTokens = [];
    if (this.pendingTimer !== undefined) {
      globalThis.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }
}

export function formatShortcut(shortcut: string): string {
  return normalizeShortcut(shortcut)
    .map((token) => token
      .split("+")
      .map((part) => {
        if (part === "mod") return isMac() ? "⌘" : "Ctrl";
        if (part === "shift") return "Shift";
        if (part === "alt") return isMac() ? "⌥" : "Alt";
        if (part === "ctrl") return "Ctrl";
        if (part === "enter") return "Enter";
        if (part === "escape") return "Esc";
        if (part === ".") return ".";
        return part.length === 1 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      })
      .join("+"))
    .join(" ");
}

function eventToken(event: ShortcutKeyEvent): string | undefined {
  if (event.isComposing) return undefined;
  const key = normalizeKey(event.key);
  if (key === undefined) return undefined;
  const modifiers: string[] = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("mod");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  modifiers.push(key);
  return modifiers.join("+");
}

function normalizeShortcut(shortcut: string): string[] {
  return shortcut
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token !== "")
    .map((token) => token.split("+").filter((part) => part !== "").join("+"));
}

function normalizeKey(key: string): string | undefined {
  if (key === " ") return "space";
  if (key.length === 1) return key.toLowerCase();
  const normalized = key.toLowerCase();
  if (["enter", "escape", "tab", "arrowup", "arrowdown", "arrowleft", "arrowright", "backspace", "delete"].includes(normalized)) return normalized;
  return undefined;
}

function sameTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && startsWithTokens(left, right);
}

function startsWithTokens(tokens: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function isModifiedShortcut(token: string): boolean {
  return token.includes("+");
}

function isMac(): boolean {
  return navigator.userAgent.toLowerCase().includes("mac");
}
