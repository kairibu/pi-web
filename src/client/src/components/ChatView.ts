import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { groupChatMessages, summarizeChatGroup } from "../chatGroups";
import type { ChatLine, ChatPart } from "./shared";
import { chatStyles } from "./shared";
import "./FormattedText";

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @query(".chat") private chat?: HTMLDivElement;
  @state() private pinnedToBottom = true;
  @state() private openGroupKeys = new Set<string>();
  private suppressScrollSave = false;
  private saveScrollTimer?: number;

  disconnectedCallback(): void {
    window.clearTimeout(this.saveScrollTimer);
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) this.openGroupKeys = this.readOpenGroupKeys();
    this.pinnedToBottom = this.isNearBottom();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) return;
    if (changed.has("messages") && this.pinnedToBottom) this.scrollToBottom();
  }

  render() {
    return html`
      <div class="chat" @scroll=${this.onScroll}>
        ${groupChatMessages(this.messages).map((group) => group.kind === "message"
          ? this.renderMessage(group.message, group.index)
          : this.renderMessageGroup(group.messages, group.startIndex))}
      </div>
    `;
  }

  private renderMessage(message: ChatLine, index: number) {
    return html`
      <article class="msg ${message.role}" data-index=${index}>
        <b class="label">${message.role}</b>
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private renderMessageGroup(messages: ChatLine[], startIndex: number) {
    const key = this.groupKey(startIndex);
    return html`
      <details class="msg event-group" data-index=${startIndex} ?open=${this.openGroupKeys.has(key)} @toggle=${(event: Event) => this.onGroupToggle(key, event)}>
        <summary>
          <b class="label">events</b>
          <span>${summarizeChatGroup(messages)}</span>
        </summary>
        <div class="group-body">
          ${messages.map((message) => html`
            <section class="group-msg ${message.role}">
              <b class="label">${message.role}</b>
              ${message.parts.map((part) => this.renderPart(part, message))}
            </section>
          `)}
        </div>
      </details>
    `;
  }

  private renderPart(part: ChatPart, message?: ChatLine) {
    if (part.type === "text" && message?.role === "bash") return html`<pre class="part shell-output">${part.text}</pre>`;
    if (part.type === "text") return html`<formatted-text class="part" .text=${part.text}></formatted-text>`;
    if (part.type === "thinking") return html`<details class="part"><summary>thinking</summary><formatted-text .text=${part.text}></formatted-text></details>`;
    if (part.type === "toolCall") return html`<div class="part tool-line">▶ ${part.toolName}<span class="summary">${part.summary}</span></div>`;
    if (part.type === "toolResult") return html`
      <details class="part" ?open=${part.isError}>
        <summary>${part.isError ? "✖" : "✓"} ${part.toolName} result</summary>
        <formatted-text .text=${part.text}></formatted-text>
      </details>
    `;
    return null;
  }

  private onGroupToggle(key: string, event: Event) {
    const details = event.currentTarget as HTMLDetailsElement;
    const openGroupKeys = new Set(this.openGroupKeys);
    if (details.open) openGroupKeys.add(key);
    else openGroupKeys.delete(key);
    this.openGroupKeys = openGroupKeys;
    this.saveOpenGroupKeys();
  }

  private onScroll() {
    this.pinnedToBottom = this.isNearBottom();
    if (!this.suppressScrollSave) this.scheduleScrollPositionSave();
  }

  private isNearBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const chat = this.chat;
      if (!chat) return;
      this.withSuppressedScrollSave(() => {
        chat.scrollTop = chat.scrollHeight;
      });
    });
  }

  restoreScrollPosition() {
    requestAnimationFrame(() => {
      const chat = this.chat;
      const stored = this.readStoredScrollPosition();
      if (!chat || !stored) {
        this.withSuppressedScrollSave(() => {
          if (chat) chat.scrollTop = chat.scrollHeight;
        });
        return;
      }

      const article = this.articleAt(stored.index);
      if (!article) {
        this.withSuppressedScrollSave(() => {
          chat.scrollTop = chat.scrollHeight;
        });
        return;
      }
      this.withSuppressedScrollSave(() => {
        const chatTop = chat.getBoundingClientRect().top;
        const currentOffset = article.getBoundingClientRect().top - chatTop;
        chat.scrollTop += currentOffset - stored.offset;
      });
    });
  }

  saveScrollPosition(sessionId = this.sessionId) {
    const chat = this.chat;
    if (!chat || !sessionId) return;
    try {
      if (this.isNearBottom()) {
        localStorage.removeItem(this.storageKey(sessionId));
        return;
      }
      const firstVisible = this.firstVisibleArticle();
      if (!firstVisible) {
        localStorage.removeItem(this.storageKey(sessionId));
        return;
      }
      const chatTop = chat.getBoundingClientRect().top;
      const position = {
        index: Number(firstVisible.dataset.index ?? 0),
        offset: firstVisible.getBoundingClientRect().top - chatTop,
      };
      localStorage.setItem(this.storageKey(sessionId), JSON.stringify(position));
    } catch {
      // Ignore storage failures; scrolling should keep working without persistence.
    }
  }

  private scheduleScrollPositionSave() {
    window.clearTimeout(this.saveScrollTimer);
    this.saveScrollTimer = window.setTimeout(() => this.saveScrollPosition(), 180);
  }

  private readStoredScrollPosition(): { index: number; offset: number } | undefined {
    if (!this.sessionId) return undefined;
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return undefined;
      const value = JSON.parse(raw);
      if (typeof value?.index !== "number" || typeof value?.offset !== "number") return undefined;
      return { index: value.index, offset: value.offset };
    } catch {
      return undefined;
    }
  }

  private firstVisibleArticle(): HTMLElement | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    const chatRect = chat.getBoundingClientRect();
    return this.articles().find((article) => {
      const rect = article.getBoundingClientRect();
      return rect.bottom >= chatRect.top && rect.top <= chatRect.bottom;
    });
  }

  private articleAt(index: number): HTMLElement | undefined {
    return this.articles().find((article) => Number(article.dataset.index) === index);
  }

  private articles(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg, details.msg"));
  }

  private withSuppressedScrollSave(callback: () => void) {
    this.suppressScrollSave = true;
    callback();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.suppressScrollSave = false;
      });
    });
  }

  private storageKey(sessionId = this.sessionId): string {
    return `pi-web:chat-scroll:${sessionId}`;
  }

  private groupStorageKey(sessionId = this.sessionId): string {
    return `pi-web:chat-groups:${sessionId}`;
  }

  private groupKey(startIndex: number): string {
    return `${this.sessionId}:${startIndex}`;
  }

  private readOpenGroupKeys(): Set<string> {
    if (!this.sessionId) return new Set();
    try {
      const raw = localStorage.getItem(this.groupStorageKey());
      const value = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    } catch {
      return new Set();
    }
  }

  private saveOpenGroupKeys(): void {
    if (!this.sessionId) return;
    try {
      localStorage.setItem(this.groupStorageKey(), JSON.stringify([...this.openGroupKeys]));
    } catch {
      // Ignore storage failures; group expansion should still work for this render.
    }
  }

  static styles = chatStyles;
}
