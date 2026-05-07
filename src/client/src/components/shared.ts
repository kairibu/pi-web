import { css } from "lit";

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolName: string; summary: string }
  | { type: "toolResult"; toolName: string; text: string; isError: boolean }
  | { type: "empty" };

export interface ChatLine {
  role: "user" | "assistant" | "tool" | "system" | "bash";
  parts: ChatPart[];
}

export interface CompletionItem {
  kind: "command" | "file";
  replaceFrom: number;
  replaceTo: number;
  insertText: string;
  detail: string;
  description?: string;
}

export const appStyles = css`
  :host { display: block; height: 100vh; color: #e6edf3; background: #0d1117; font: 14px system-ui, sans-serif; }
  .shell { display: grid; grid-template-columns: 340px 1fr; height: 100%; min-height: 0; }
  aside { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #30363d; overflow: hidden; }
  header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid #30363d; }
  project-list, workspace-list { flex: 0 0 auto; max-height: 26%; overflow: auto; border-bottom: 1px solid #21262d; }
  session-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  status-bar { flex: 0 0 auto; }
  chat-view { flex: 1 1 auto; min-height: 0; overflow: auto; }
  prompt-editor, chat-composer { flex: 0 0 auto; }
  button { border: 1px solid #30363d; border-radius: 8px; background: #161b22; color: #e6edf3; padding: 7px 9px; cursor: pointer; }
  .empty { margin: auto; color: #8b949e; }
  .error { padding: 10px 16px; border-bottom: 1px solid #30363d; color: #ff7b72; }
`;

export const listStyles = css`
  :host { display: block; color: #e6edf3; font: 14px system-ui, sans-serif; }
  section { padding: 10px; }
  h2 { display: flex; justify-content: space-between; align-items: center; margin: 0 0 8px; color: #8b949e; font-size: 12px; text-transform: uppercase; }
  button { border: 1px solid #30363d; border-radius: 8px; background: #161b22; color: #e6edf3; padding: 7px 9px; cursor: pointer; }
  section > button { display: block; width: 100%; text-align: left; margin: 6px 0; }
  button.selected { border-color: #58a6ff; background: #0d2847; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  small { display: block; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export const chatStyles = css`
  :host { display: block; min-height: 0; color: #e6edf3; font: 14px system-ui, sans-serif; }
  .chat { height: 100%; overflow: auto; padding: 16px; box-sizing: border-box; }
  .msg { margin: 0 0 14px; padding: 12px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; }
  .msg.user { border-color: #2f81f7; background: #0d2847; }
  .msg.tool { border-color: #6e5200; background: #1f1a10; color: #d29922; }
  .msg.system { color: #ff7b72; }
  .msg.bash { border-color: #3fb950; background: #0f1b12; }
  .msg.event-group { padding: 0; border-color: #30363d; background: #0d1117; color: #8b949e; }
  .msg.event-group > summary { display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: #8b949e; }
  .msg.event-group > summary .label { margin: 0; }
  .group-body { padding: 0 12px 12px; }
  .group-msg { padding: 10px 0; border-top: 1px solid #21262d; color: #e6edf3; }
  .group-msg.tool { color: #d29922; }
  .group-msg.system { color: #ff7b72; }
  .group-msg.bash { color: #3fb950; }
  .label { display: block; margin-bottom: 8px; color: #8b949e; font-size: 12px; text-transform: uppercase; }
  formatted-text.part { display: block; }
  .part + .part { margin-top: 10px; }
  .tool-line { color: #d29922; }
  .summary { color: #8b949e; margin-left: 6px; }
  .part:is(details) { border-top: 1px solid #30363d; padding-top: 8px; }
  summary { cursor: pointer; color: #8b949e; }
  pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  .shell-output { color: #e6edf3; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
`;

export const formattedTextStyles = css`
  :host { display: block; }
  .formatted { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
  p, ul, ol, pre, blockquote, table { margin: 0 0 10px; }
  :is(p, ul, ol, pre, blockquote, table):last-child { margin-bottom: 0; }
  ul, ol { padding-left: 22px; }
  li + li { margin-top: 3px; }
  code { border: 1px solid #30363d; border-radius: 4px; background: #0d1117; padding: 1px 4px; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { border: 1px solid #30363d; border-radius: 8px; background: #0d1117; padding: 10px; overflow: auto; }
  pre code { border: 0; padding: 0; background: transparent; }
  blockquote { border-left: 3px solid #30363d; padding-left: 10px; color: #8b949e; }
  a { color: #58a6ff; }
  h1, h2, h3, h4 { margin: 14px 0 8px; line-height: 1.2; }
  h1:first-child, h2:first-child, h3:first-child, h4:first-child { margin-top: 0; }
  h1 { font-size: 20px; }
  h2 { font-size: 17px; }
  h3 { font-size: 15px; }
  h4 { font-size: 14px; }
  table { border-collapse: collapse; display: block; overflow: auto; }
  th, td { border: 1px solid #30363d; padding: 4px 8px; }
  th { background: #161b22; }
`;

export const statusBarStyles = css`
  :host { display: block; color: #8b949e; font: 12px system-ui, sans-serif; }
  .bar { display: flex; gap: 12px; align-items: center; min-width: 0; padding: 7px 12px; border-bottom: 1px solid #30363d; background: #0d1117; white-space: nowrap; overflow: hidden; }
  span { overflow: hidden; text-overflow: ellipsis; }
  .bar > span:first-child { flex: 1 1 auto; min-width: 80px; }
  .activity { display: inline-flex; align-items: center; gap: 6px; color: #8b949e; }
  .activity.active { color: #3fb950; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .muted { color: #6e7681; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
`;

export const autocompleteStyles = css`
  :host { display: block; }
  .menu { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); max-height: 260px; overflow: auto; border: 1px solid #30363d; border-radius: 8px; background: #161b22; box-shadow: 0 10px 30px #0008; }
  button { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 4px 10px; width: 100%; border: 0; border-bottom: 1px solid #30363d; border-radius: 0; background: transparent; color: #e6edf3; padding: 8px 10px; text-align: left; cursor: pointer; }
  button:last-child { border-bottom: 0; }
  button.selected, button:hover { background: #0d2847; }
  span { color: #8b949e; font-size: 12px; }
  small { grid-column: 1 / -1; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export const commandPickerStyles = css`
  :host { position: fixed; inset: 0; z-index: 10; color: #e6edf3; font: 14px system-ui, sans-serif; }
  .backdrop { display: grid; place-items: center; width: 100%; height: 100%; background: #0008; }
  section { width: min(720px, calc(100vw - 40px)); max-height: min(640px, calc(100vh - 40px)); display: flex; flex-direction: column; border: 1px solid #30363d; border-radius: 12px; background: #0d1117; box-shadow: 0 20px 60px #000b; overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid #30363d; }
  .options { min-height: 0; overflow: auto; outline: none; }
  button { border: 0; background: transparent; color: #e6edf3; cursor: pointer; }
  header button { font-size: 20px; color: #8b949e; }
  .options button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid #21262d; text-align: left; }
  .options button.selected, .options button:hover { background: #0d2847; }
  small { display: block; margin-top: 4px; color: #8b949e; }
`;

export const promptEditorStyles = css`
  :host { display: block; color: #e6edf3; font: 14px system-ui, sans-serif; }
  footer { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; padding: 12px; border-top: 1px solid #30363d; }
  footer.shell-mode { border-top-color: #3fb950; background: #0f1b12; }
  .editor-wrap { position: relative; min-width: 0; }
  textarea { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow-y: auto; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; padding: 8px; }
  .shell-mode textarea { border-color: #3fb950; box-shadow: 0 0 0 1px #3fb95055; }
  .mode-hint { position: absolute; right: 8px; bottom: 8px; max-width: calc(100% - 16px); border: 1px solid #238636; border-radius: 999px; background: #0f2a16; color: #3fb950; padding: 2px 8px; font-size: 12px; pointer-events: none; }
  button { border: 1px solid #30363d; border-radius: 8px; background: #161b22; color: #e6edf3; padding: 7px 9px; cursor: pointer; }
  button:disabled, textarea:disabled { opacity: .5; cursor: not-allowed; }
`;

export const composerStyles = promptEditorStyles;
