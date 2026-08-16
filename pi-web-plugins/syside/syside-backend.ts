import type {
  CapabilityRequestContext,
  JsonValue,
  ProviderResponse,
  ServerPluginActivationContext,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  SYSIDE_CHECK_OPERATION,
  type SysideCheckResponse,
} from "./browser/syside-contract.js";
import { discoverSysmlFiles } from "./syside-discovery.js";

export { SYSIDE_CHECK_OPERATION } from "./browser/syside-contract.js";
export type { SysideCheckResponse } from "./browser/syside-contract.js";

const SYSIDE_COMMAND_TIMEOUT_MS = 30_000;

interface SysideCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Dispatch the SysIDE-owned check schema through the capability's request seam. */
export async function requestSysideCapability(
  activationContext: ServerPluginActivationContext,
  request: CapabilityRequestContext,
): Promise<ProviderResponse> {
  if (request.operation !== SYSIDE_CHECK_OPERATION) {
    throw new Error(`Unsupported SysIDE capability operation: ${request.operation}`);
  }
  requireCheckInput(request.input);
  const response = await sysideCheck(activationContext, request.workspace.path, request.signal);
  return { errors: response.errors };
}

export async function sysideCheck(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<SysideCheckResponse> {
  const files = await discoverSysmlFiles(cwd, signal);
  if (files.length === 0) return { errors: [] };
  // `--` separates the positional file arguments from options so a discovered
  // file whose name begins with `-` cannot be misread as a CLI flag.
  const result = await runSyside(context, cwd, ["check", "--", ...files], signal);
  const errors = parseSysideErrors(result.stdout, result.stderr);
  if (errors.length === 0 && result.exitCode !== 0) {
    // A non-zero exit that produced no parseable diagnostics is not a clean
    // "no errors" result: it is a crash, panic, usage error, or an unexpected
    // diagnostic format. Surface it as a transport failure instead of telling
    // the user the project is clean.
    throw sysideCheckFailure(result);
  }
  return { errors };
}

/**
 * Extract the message text of each `error:` diagnostic from a `syside check`
 * run, then return that list.
 *
 * The parser assumes the tool's human-readable diagnostic line shape, matching
 * any of:
 *
 * - `path:line:col: error: <message>`
 * - `path:line: error: <message>`
 * - `error: <message>`
 *
 * with or without leading ANSI color codes. Warnings, info, and other non-error
 * output are ignored, so an empty list means the project reported no errors
 * (guaranteed only while the tool keeps emitting the shape above; a format
 * drift that changes the `error:` prefix would silently turn real errors into
 * an empty list — sysideCheck guards against the crash/usage case by treating a
 * non-zero exit with zero parsed diagnostics as a transport failure).
 */
export function parseSysideErrors(stdout: string, stderr: string): string[] {
  const errors: string[] = [];
  for (const rawLine of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const line = stripAnsi(rawLine).trim();
    if (line === "") continue;
    const message = extractSysideError(line);
    if (message !== undefined) errors.push(message);
  }
  return errors;
}

function extractSysideError(line: string): string | undefined {
  const withPosition = /^.+?:\d+:\d+:\s*error:\s*(.*)$/u.exec(line);
  if (withPosition !== null) return withPosition[1] ?? "";
  const withLine = /^.+?:\d+:\s*error:\s*(.*)$/u.exec(line);
  if (withLine !== null) return withLine[1] ?? "";
  const bare = /^error:\s*(.*)$/u.exec(line);
  if (bare !== null) return bare[1] ?? "";
  return undefined;
}

function sysideCheckFailure(result: SysideCommandResult): Error {
  const detail = (result.stderr.trim() !== "" ? result.stderr : result.stdout).trim() || "no output";
  return new Error(`syside check exited with status ${String(result.exitCode)} and reported no errors: ${detail}`);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-9;]*m/gu, "");
}

async function runSyside(
  context: ServerPluginActivationContext,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<SysideCommandResult> {
  const result = await context.execFile({
    file: "syside",
    args,
    cwd,
    timeoutMs: SYSIDE_COMMAND_TIMEOUT_MS,
    signal,
  });
  if (result.signal !== null) throw new Error(`syside ${args.join(" ")} ended from signal ${result.signal}`);
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`syside ${args.join(" ")} exceeded the host output limit`);
  }
  if (result.exitCode === null) throw new Error(`syside ${args.join(" ")} ended without an exit code`);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function requireCheckInput(input: JsonValue): void {
  if (input !== null) throw new Error("SysIDE check input must be null");
}
