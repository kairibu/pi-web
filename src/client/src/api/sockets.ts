import type { SessionRef } from "../../../shared/apiTypes";

export function sessionEvents(session: SessionRef, machineId = "local"): WebSocket {
  const query = new URLSearchParams({ cwd: session.cwd }).toString();
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/sessions/${encodeURIComponent(session.id)}/events?${query}`);
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/sessions/events`);
}

export function terminalSocket(projectId: string, workspaceId: string, terminalId: string, initialSize?: { cols: number; rows: number }, machineId = "local"): WebSocket {
  const sizeQuery = initialSize === undefined ? "" : `?cols=${encodeURIComponent(String(initialSize.cols))}&rows=${encodeURIComponent(String(initialSize.rows))}`;
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/socket${sizeQuery}`);
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}${machinePrefix(machineId)}/events`);
}

function machinePrefix(machineId: string): string {
  return `/api/machines/${encodeURIComponent(machineId)}`;
}

function webSocketBaseUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}
