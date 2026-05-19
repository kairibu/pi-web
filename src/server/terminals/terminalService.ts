import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { TerminalUiEvent } from "../../shared/apiTypes.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";

const MAX_REPLAY_BUFFER = 200_000;

export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
}

interface TerminalRecord extends TerminalInfo {
  pty: pty.IPty;
  buffer: string;
  events: EventEmitter;
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(private readonly events?: SessionEventHub, private readonly workspaceActivity?: Pick<WorkspaceActivityService, "updateTerminal" | "removeTerminal">) {}

  list(cwd: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.cwd === cwd)
      .map(toInfo);
  }

  create(options: { cwd: string; name?: string; cols?: number; rows?: number }): TerminalInfo {
    if (options.cwd === "") throw new Error("cwd is required");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const shell = process.env["SHELL"] ?? "/bin/bash";
    const terminal = pty.spawn(shell, [], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    const requestedName = options.name?.trim();
    const record: TerminalRecord = {
      id,
      cwd: options.cwd,
      name: requestedName !== undefined && requestedName !== "" ? requestedName : `Shell ${String(this.list(options.cwd).length + 1)}`,
      createdAt,
      exited: false,
      pty: terminal,
      buffer: "",
      events: new EventEmitter(),
    };
    terminal.onData((data) => {
      record.buffer = trimReplayBuffer(record.buffer + data);
      record.events.emit("output", data);
    });
    terminal.onExit(({ exitCode }) => {
      record.exited = true;
      record.exitCode = exitCode;
      record.events.emit("exit", exitCode);
      const info = toInfo(record);
      this.workspaceActivity?.updateTerminal(info);
      this.publish({ type: "terminal.exited", terminal: info });
    });
    this.terminals.set(id, record);
    const info = toInfo(record);
    this.workspaceActivity?.updateTerminal(info);
    this.publish({ type: "terminal.created", terminal: info });
    return info;
  }

  get(id: string): TerminalInfo | undefined {
    const terminal = this.terminals.get(id);
    return terminal === undefined ? undefined : toInfo(terminal);
  }

  attach(id: string, handlers: { output: (data: string, replay: boolean) => void; exit: (exitCode: number | undefined) => void }): () => void {
    const terminal = this.require(id);
    if (terminal.buffer !== "") handlers.output(terminal.buffer, true);
    if (terminal.exited) handlers.exit(terminal.exitCode);
    const onOutput = (data: string) => { handlers.output(data, false); };
    const onExit = (exitCode: number | undefined) => { handlers.exit(exitCode); };
    terminal.events.on("output", onOutput);
    terminal.events.on("exit", onExit);
    return () => {
      terminal.events.off("output", onOutput);
      terminal.events.off("exit", onExit);
    };
  }

  write(id: string, data: string): void {
    const terminal = this.require(id);
    if (!terminal.exited) terminal.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.require(id);
    if (!terminal.exited && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      terminal.pty.resize(Math.floor(cols), Math.floor(rows));
    }
  }

  close(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return;
    this.terminals.delete(id);
    terminal.events.removeAllListeners();
    this.workspaceActivity?.removeTerminal(id, terminal.cwd);
    if (!terminal.exited) terminal.pty.kill();
    this.publish({ type: "terminal.closed", terminalId: id, cwd: terminal.cwd });
  }

  dispose(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private require(id: string): TerminalRecord {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) throw new Error("Terminal not found");
    return terminal;
  }

  private publish(event: TerminalUiEvent): void {
    this.events?.publishRealtime(event);
  }
}

function toInfo(record: TerminalRecord): TerminalInfo {
  return {
    id: record.id,
    cwd: record.cwd,
    name: record.name,
    createdAt: record.createdAt,
    exited: record.exited,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
  };
}

function trimReplayBuffer(buffer: string): string {
  if (buffer.length <= MAX_REPLAY_BUFFER) return buffer;
  return buffer.slice(buffer.length - MAX_REPLAY_BUFFER);
}
