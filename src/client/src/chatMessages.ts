import type { ChatLine, ChatPart } from "./components/shared";

export function normalizeMessages(messages: any[]): ChatLine[] {
  return messages.flatMap(normalizeMessage).filter((message) => message.parts.length > 0);
}

export function textMessage(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

export function appendText(messages: ChatLine[], role: ChatLine["role"], text: string): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === role && lastPart?.type === "text") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + text }] },
    ];
  }
  return [...messages, textMessage(role, text)];
}

function normalizeMessage(message: any): ChatLine[] {
  if (message?.role === "bashExecution") return [normalizeBashExecution(message)];
  const role = normalizeRole(message?.role);
  const parts = normalizeContent(message?.content, message);
  if (role === "tool") return [{ role, parts }];

  const visible = parts.filter((part) => part.type !== "empty");
  return visible.length ? [{ role, parts: visible }] : [];
}

function normalizeBashExecution(message: any): ChatLine {
  const lines = message.excludeFromContext ? ["excluded from context", "", `$ ${message.command ?? ""}`] : [`$ ${message.command ?? ""}`];
  if (message.output) lines.push("", String(message.output));
  if (message.exitCode != null) lines.push("", `exit ${message.exitCode}`);
  if (message.cancelled) lines.push("", "cancelled");
  if (message.truncated) lines.push("", "output truncated");
  if (message.fullOutputPath) lines.push("", `full output: ${message.fullOutputPath}`);
  return { role: "bash", parts: [{ type: "text", text: lines.join("\n") }] };
}

function normalizeRole(role: unknown): ChatLine["role"] {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  return "system";
}

function normalizeContent(content: unknown, message: any): ChatPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return objectFallback(content);

  return content.flatMap((part: any): ChatPart[] => {
    if (part?.type === "text") return part.text ? [{ type: "text", text: part.text }] : [];
    if (part?.type === "thinking") return part.thinking || part.text ? [{ type: "thinking", text: part.thinking ?? part.text }] : [];
    if (part?.type === "toolCall") return [{ type: "toolCall", toolName: part.name ?? "tool", summary: summarizeArgs(part.arguments) }];
    if (part?.type === "image") return [{ type: "text", text: "[image]" }];
    return objectFallback(part);
  }).map((part) => part.type === "text" && message?.role === "toolResult"
    ? { type: "toolResult", toolName: message.toolName ?? "tool", text: part.text, isError: !!message.isError }
    : part);
}

function objectFallback(value: unknown): ChatPart[] {
  if (value == null) return [];
  if (typeof value === "object") return [{ type: "text", text: summarizeArgs(value) }];
  return [{ type: "text", text: String(value) }];
}

function summarizeArgs(args: any): string {
  if (!args || typeof args !== "object") return args == null ? "" : String(args);
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.oldText === "string" && typeof args.newText === "string") return "edit text replacement";
  if (Array.isArray(args.edits)) return `${args.edits.length} edit${args.edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortValue(value)}`).join(" · ");
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value) return "object";
  return "";
}
