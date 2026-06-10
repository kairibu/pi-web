import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway } from "./piSessionService.js";

export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

type SessionDirSource = "env" | "settings" | "pi-default";

export interface SessionDirResolution {
  source: SessionDirSource;
  sessionDir: string;
  usesConfiguredSessionDir: boolean;
}

export interface SessionDirResolverOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class SessionDirResolver {
  private readonly agentDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: SessionDirResolverOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.env = options.env ?? process.env;
  }

  resolve(cwd: string): SessionDirResolution {
    const envSessionDir = this.env[PI_SESSION_DIR_ENV];
    if (envSessionDir !== undefined && envSessionDir !== "") {
      return { source: "env", sessionDir: resolveConfiguredPath(envSessionDir, cwd), usesConfiguredSessionDir: true };
    }

    const settingsSessionDir = SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
      return { source: "settings", sessionDir: resolveConfiguredPath(settingsSessionDir, cwd), usesConfiguredSessionDir: true };
    }

    return { source: "pi-default", sessionDir: defaultPiSessionDir(cwd, this.agentDir), usesConfiguredSessionDir: false };
  }
}

export type PiSessionManagerGatewayOptions = SessionDirResolverOptions;

export function createPiSessionManagerGateway(options: PiSessionManagerGatewayOptions = {}): PiSessionManagerGateway {
  return new SettingsAwarePiSessionManagerGateway(new SessionDirResolver(options));
}

class SettingsAwarePiSessionManagerGateway implements PiSessionManagerGateway {
  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    return filterSessionsForCwd(await listSessionsInDir(resolution.sessionDir), cwd);
  }

  create(cwd: string): PiSessionManager {
    const resolution = this.resolver.resolve(cwd);
    return SessionManager.create(cwd, resolution.sessionDir);
  }

  open(path: string): PiSessionManager {
    return SessionManager.open(path, dirname(path));
  }
}

export async function listSessionsInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  return SessionManager.list("", sessionDir);
}

export function filterSessionsForCwd(sessions: readonly PiSessionListEntry[], cwd: string): PiSessionListEntry[] {
  return sessions.filter((session) => session.cwd === cwd);
}

export function defaultPiSessionsRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "sessions");
}

export function defaultPiSessionDir(cwd: string, agentDir = getAgentDir()): string {
  return sessionDirInDefaultPiStore(defaultPiSessionsRoot(agentDir), cwd);
}

export function sessionDirInDefaultPiStore(storeRoot: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(storeRoot, safePath);
}

export function resolveConfiguredPath(path: string, cwd: string): string {
  const expanded = expandTildePath(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

