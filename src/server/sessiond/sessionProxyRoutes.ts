import type { FastifyInstance, FastifyReply } from "fastify";
import { WebSocket, type RawData } from "ws";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

export function registerSessionProxyRoutes(app: FastifyInstance, daemon = new SessionDaemonClient()): void {
  const proxy = async (request: { method: string; url: string; body?: unknown }, reply: FastifyReply) => {
    try {
      const upstream = await daemon.request(request.method, stripApiPrefix(request.url), request.body);
      reply.code(upstream.statusCode);
      const contentType = upstream.headers["content-type"];
      if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
      return upstream.body !== "" ? parseJson(upstream.body) : undefined;
    } catch (error) {
      requestFailed(reply, error);
      return undefined;
    }
  };

  app.get("/api/sessiond/health", (_request, reply) => proxy({ method: "GET", url: "/api/health" }, reply));

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/events", { websocket: true }, (socket, request) => {
    bridgeSockets(socket, daemon.connectWebSocket(`/sessions/${request.params.sessionId}/events`));
  });

  app.get("/api/sessions/events", { websocket: true }, (socket) => {
    bridgeSockets(socket, daemon.connectWebSocket("/sessions/events"));
  });

  app.get("/api/events", { websocket: true }, (socket) => {
    bridgeSockets(socket, daemon.connectWebSocket("/events"));
  });

  app.all("/api/activity", (request, reply) => proxy(request, reply));
  app.all("/api/auth", (request, reply) => proxy(request, reply));
  app.all("/api/auth/*", (request, reply) => proxy(request, reply));
  app.all("/api/sessions", (request, reply) => proxy(request, reply));
  app.all("/api/sessions/*", (request, reply) => proxy(request, reply));
}

function stripApiPrefix(url: string): string {
  const stripped = url.startsWith("/api") ? url.slice(4) : url;
  return stripped === "" ? "/" : stripped;
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function requestFailed(reply: FastifyReply, error: unknown): void {
  reply.code(502).send({ error: `Session daemon unavailable: ${error instanceof Error ? error.message : String(error)}` });
}

function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data) => { sendIfOpen(upstream, data); });
  upstream.on("message", (data) => { sendIfOpen(client, data); });
  client.on("close", () => { upstream.close(); });
  upstream.on("close", () => { client.close(); });
  upstream.on("error", () => { client.close(); });
  client.on("error", () => { upstream.close(); });
}

function sendIfOpen(socket: WebSocket, data: RawData): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}
