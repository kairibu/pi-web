import type { FastifyInstance } from "fastify";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { PiSessionRef, PiSessionService } from "./piSessionService.js";

interface SessionQuery {
  cwd?: string;
}

interface MessageQuery extends SessionQuery {
  before?: string;
  limit?: string;
}

class SessionRouteValidationError extends Error {}

export function registerSessionRoutes(app: FastifyInstance, sessions: PiSessionService, eventHub: SessionEventHub, prefix = ""): void {
  app.get<{ Querystring: SessionQuery }>(`${prefix}/sessions`, async (request, reply) => {
    if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
    return sessions.list(request.query.cwd);
  });

  app.post<{ Body: { cwd: string } }>(`${prefix}/sessions`, async (request, reply) => {
    try {
      return await sessions.start(request.body.cwd);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: MessageQuery }>(`${prefix}/sessions/:sessionId/messages`, async (request, reply) => {
    try {
      const page = { ...optionalField("before", optionalNumber(request.query.before)), ...optionalField("limit", optionalNumber(request.query.limit)) };
      return await sessions.messages(sessionRefFromQuery(request.params.sessionId, request.query), page);
    } catch (error) {
      return reply.code(readErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/status`, async (request, reply) => {
    try {
      return await sessions.status(sessionRefFromQuery(request.params.sessionId, request.query));
    } catch (error) {
      return reply.code(readErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/models`, async (request, reply) => {
    try {
      return { models: await sessions.availableModels(sessionRefFromQuery(request.params.sessionId, request.query)) };
    } catch (error) {
      return reply.code(readErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; provider?: unknown; modelId?: unknown } }>(`${prefix}/sessions/:sessionId/model`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.setModel(sessionRefFromBody(request.params.sessionId, body), requireString(body, "provider"), requireString(body, "modelId"));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; direction?: "forward" | "backward" } }>(`${prefix}/sessions/:sessionId/model/cycle`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const direction = body["direction"];
      if (direction !== undefined && direction !== "forward" && direction !== "backward") throw new Error("direction must be forward or backward");
      return await sessions.cycleModel(sessionRefFromBody(request.params.sessionId, body), direction ?? "forward");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/thinking-levels`, async (request, reply) => {
    try {
      return { levels: await sessions.availableThinkingLevels(sessionRefFromQuery(request.params.sessionId, request.query)) };
    } catch (error) {
      return reply.code(readErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; level?: unknown } }>(`${prefix}/sessions/:sessionId/thinking-level`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.setThinkingLevel(sessionRefFromBody(request.params.sessionId, body), requireThinkingLevel(body["level"]));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/thinking-level/cycle`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.cycleThinkingLevel(sessionRefFromBody(request.params.sessionId, body));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/commands`, async (request, reply) => {
    try {
      return await sessions.commands(sessionRefFromQuery(request.params.sessionId, request.query));
    } catch (error) {
      return reply.code(readErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; text?: unknown; streamingBehavior?: "steer" | "followUp" } }>(`${prefix}/sessions/:sessionId/prompt`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const streamingBehavior = body["streamingBehavior"];
      if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") throw new Error("streamingBehavior must be steer or followUp");
      await sessions.prompt(sessionRefFromBody(request.params.sessionId, body), requireString(body, "text"), streamingBehavior);
      return { accepted: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; text?: unknown } }>(`${prefix}/sessions/:sessionId/shell`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      await sessions.shell(sessionRefFromBody(request.params.sessionId, body), requireString(body, "text"));
      return { accepted: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; text?: unknown } }>(`${prefix}/sessions/:sessionId/commands/run`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.runCommand(sessionRefFromBody(request.params.sessionId, body), requireString(body, "text"));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; requestId?: unknown; value?: unknown } }>(`${prefix}/sessions/:sessionId/commands/respond`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.respondToCommand(sessionRefFromBody(request.params.sessionId, body), requireString(body, "requestId"), requireString(body, "value"));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/abort`, async (request, reply) => {
    try {
      await sessions.abort(sessionRefFromBody(request.params.sessionId, requireRecord(request.body)));
      return { aborted: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/stop`, (request, reply) => {
    try {
      sessions.stop(sessionRefFromBody(request.params.sessionId, requireRecord(request.body)));
      return { stopped: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/archive`, async (request, reply) => {
    try {
      await sessions.archive(sessionRefFromBody(request.params.sessionId, requireRecord(request.body)));
      return { archived: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/archive-tree`, async (request, reply) => {
    try {
      return await sessions.archiveTree(sessionRefFromBody(request.params.sessionId, requireRecord(request.body)));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/restore`, async (request, reply) => {
    try {
      await sessions.restore(sessionRefFromBody(request.params.sessionId, requireRecord(request.body)));
      return { restored: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } }>(`${prefix}/sessions/:sessionId/detach-parent`, async (request, reply) => {
    try {
      await sessions.detachParent(sessionRefFromBody(request.params.sessionId, requireRecord(request.body)));
      return { detached: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/events`, { websocket: true }, (socket, request) => {
    try {
      const ref = sessionRefFromQuery(request.params.sessionId, request.query);
      eventHub.add(ref.id, socket);
    } catch {
      socket.close();
    }
  });

  app.get(`${prefix}/sessions/events`, { websocket: true }, (socket) => {
    eventHub.addGlobal(socket);
  });

  app.get(`${prefix}/events`, { websocket: true }, (socket) => {
    eventHub.addGlobal(socket);
  });
}

function sessionRefFromQuery(id: string, query: SessionQuery): PiSessionRef {
  const cwd = query.cwd;
  if (cwd === undefined || cwd === "") throw new SessionRouteValidationError("cwd query parameter is required");
  return { id, cwd };
}

function sessionRefFromBody(id: string, body: Record<string, unknown>): PiSessionRef {
  const cwd = body["cwd"];
  if (typeof cwd !== "string" || cwd === "") throw new Error("cwd field is required");
  return { id, cwd };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("request body must be an object");
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} field must be a string`);
  return value;
}

function requireThinkingLevel(value: unknown): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  throw new Error("level field is invalid");
}

function optionalField<T>(key: string, value: T | undefined): Record<string, T> | object {
  return value === undefined ? {} : { [key]: value };
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readErrorStatus(error: unknown): 400 | 404 {
  return error instanceof SessionRouteValidationError ? 400 : 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
