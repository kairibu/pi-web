import { textMessage } from "./chatMessages";
import type { ChatLine } from "./components/shared";
import type { SessionUiEvent } from "./sessionSocket";

export function shellStartMessage(command: string, excludeFromContext?: boolean): ChatLine {
  return textMessage("bash", `${excludeFromContext ? "excluded from context\n\n" : ""}$ ${command}`);
}

export function appendShellChunk(messages: ChatLine[], chunk: string): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role !== "bash" || lastPart?.type !== "text") return [...messages, textMessage("bash", chunk)];
  const separator = hasShellOutput(lastPart.text) ? "" : "\n\n";
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + separator + chunk }] }];
}

export function finalizeShellMessage(messages: ChatLine[], event: Extract<SessionUiEvent, { type: "shell.end" }>): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role !== "bash" || lastPart?.type !== "text") return messages;
  const notes: string[] = [];
  if (!lastPart.text.includes("\n\n") && !event.output) notes.push("(no output)");
  if (event.isError) notes.push(event.output ?? "Bash command failed");
  if (event.exitCode != null) notes.push(`exit ${event.exitCode}`);
  if (event.cancelled) notes.push("cancelled");
  if (event.truncated) notes.push("output truncated");
  if (event.fullOutputPath) notes.push(`full output: ${event.fullOutputPath}`);
  if (!notes.length) return messages;
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: `${lastPart.text}\n\n${notes.join("\n")}` }] }];
}

function hasShellOutput(text: string): boolean {
  const outputStart = text.lastIndexOf("\n\n");
  const promptStart = text.lastIndexOf("$ ");
  return outputStart > promptStart;
}
