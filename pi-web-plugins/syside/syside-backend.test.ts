import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  SYSIDE_CHECK_OPERATION,
  parseSysideErrors,
  requestSysideCapability,
  sysideCheck,
} from "./syside-backend.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parseSysideErrors", () => {
  it("extracts only error messages across supported diagnostic forms and strips ANSI", () => {
    const stdout = [
      "\u001B[1mModel.sysml:2:5: error: Unknown reference 'Wing'\u001B[0m",
      "Model.sysml:10: error: Duplicate name 'Tail'",
      "error: Missing default package",
      "Model.sysml:3:1: warning: Redundant stereotype",
      "info: parsed 2 files",
      "",
    ].join("\n");

    expect(parseSysideErrors(stdout, "Model.sysml:4:2: error: Bad port type\n")).toEqual([
      "Unknown reference 'Wing'",
      "Duplicate name 'Tail'",
      "Missing default package",
      "Bad port type",
    ]);
  });

  it("returns an empty list when there is no error output", () => {
    expect(parseSysideErrors("check complete\n", "")).toEqual([]);
    expect(parseSysideErrors("", "")).toEqual([]);
  });
});

describe("sysideCheck", () => {
  it("returns an empty error list without running a command when the project has no SysML files", async () => {
    const folder = await temporaryDirectory("no sysml");
    const execFile = vi.fn();
    const context = contextWith(execFile);

    await expect(sysideCheck(context, folder, new AbortController().signal)).resolves.toEqual({ errors: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs syside check over the discovered files and parses error messages", async () => {
    const folder = await temporaryDirectory("with sysml");
    await writeFile(join(folder, "Model.sysml"), "package m;\n", "utf8");
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>(() => Promise.resolve(commandResult({
      stdout: "Model.sysml:1:1: error: Parse failure\n",
    })));

    await expect(sysideCheck(contextWith(execFile), folder, new AbortController().signal))
      .resolves.toEqual({ errors: ["Parse failure"] });

    expect(execFile).toHaveBeenCalledWith(expect.objectContaining({
      file: "syside",
      args: ["check", "--", "Model.sysml"],
      cwd: folder,
      timeoutMs: 30_000,
    }));
  });

  it("separates discovered files from options with `--` so a leading-dash filename is a positional", async () => {
    const folder = await temporaryDirectory("dash path");
    await writeFile(join(folder, "-leading.sysml"), "", "utf8");
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>(() => Promise.resolve(commandResult({})));

    await sysideCheck(contextWith(execFile), folder, new AbortController().signal);
    expect(execFile).toHaveBeenCalledWith(expect.objectContaining({ args: ["check", "--", "-leading.sysml"] }));
  });

  it("treats a non-zero exit with no parseable errors as a transport failure instead of reporting a clean project", async () => {
    const folder = await temporaryDirectory("nonzero");
    await writeFile(join(folder, "Model.sysml"), "", "utf8");
    const execFile = () => Promise.resolve(commandResult({ exitCode: 1, stderr: "panic: missing variant\n" }));

    await expect(sysideCheck(contextWith(execFile), folder, new AbortController().signal))
      .rejects.toThrow(/exited with status 1/);
    await expect(sysideCheck(contextWith(execFile), folder, new AbortController().signal))
      .rejects.toThrow(/panic: missing variant/);
  });

  it("still reports parsed errors when the check exits non-zero (errors printed, not a crash)", async () => {
    const folder = await temporaryDirectory("nonzero errors");
    await writeFile(join(folder, "Model.sysml"), "", "utf8");
    const execFile = () => Promise.resolve(commandResult({
      exitCode: 1,
      stdout: "Model.sysml:2:5: error: Unknown reference 'Wing'\n",
    }));

    await expect(sysideCheck(contextWith(execFile), folder, new AbortController().signal))
      .resolves.toEqual({ errors: ["Unknown reference 'Wing'"] });
  });

  it("propagates a signaled command as a transport failure", async () => {
    const folder = await temporaryDirectory("signal");
    await writeFile(join(folder, "Model.sysml"), "", "utf8");
    const execFile = () => Promise.resolve(commandResult({ exitCode: null, signal: "SIGKILL" }));

    await expect(sysideCheck(contextWith(execFile), folder, new AbortController().signal))
      .rejects.toThrow("ended from signal SIGKILL");
  });

  it("propagates truncated output and command timeout rejections as transport failures", async () => {
    const folder = await temporaryDirectory("transport");
    await writeFile(join(folder, "Model.sysml"), "", "utf8");
    const truncated = () => Promise.resolve(commandResult({ stdout: "error: x", stdoutTruncated: true }));
    await expect(sysideCheck(contextWith(truncated), folder, new AbortController().signal))
      .rejects.toThrow("exceeded the host output limit");

    const timeout = new Error("Server plugin command timed out after 30000ms");
    const timingOut = () => Promise.reject(timeout);
    await expect(sysideCheck(contextWith(timingOut), folder, new AbortController().signal)).rejects.toBe(timeout);
  });
});

describe("requestSysideCapability", () => {
  it("rejects unsupported operations and malformed check input before running a command", async () => {
    const execFile = vi.fn();
    const context = contextWith(execFile);
    const base = {
      workspace: { path: "/repo" },
      signal: new AbortController().signal,
    };

    await expect(requestSysideCapability(context, { ...base, operation: "history", input: null }))
      .rejects.toThrow("Unsupported SysIDE capability operation");
    await expect(requestSysideCapability(context, { ...base, operation: SYSIDE_CHECK_OPERATION, input: {} }))
      .rejects.toThrow("SysIDE check input must be null");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns the parsed check response for the requested operation", async () => {
    const folder = await temporaryDirectory("requested operation");
    await writeFile(join(folder, "Model.sysml"), "package m;\n", "utf8");
    const execFile = vi.fn<ServerPluginActivationContext["execFile"]>(() => Promise.resolve(commandResult({
      stdout: "error: Broken element\n",
    })));

    const result = await requestSysideCapability(contextWith(execFile), {
      workspace: { path: folder },
      operation: SYSIDE_CHECK_OPERATION,
      input: null,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ errors: ["Broken element"] });
    expect(execFile).toHaveBeenCalledWith(expect.objectContaining({
      file: "syside",
      args: ["check", "--", "Model.sysml"],
      cwd: folder,
    }));
  });
});

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-web-syside-backend-${label}-`));
  tempRoots.push(path);
  return path;
}

function contextWith(execFile: ServerPluginActivationContext["execFile"]): ServerPluginActivationContext {
  return {
    apiVersion: 1,
    pluginId: "syside",
    packageRoot: "pi-web-plugins/syside",
    logger: {
      debug() { /* no-op */ },
      info() { /* no-op */ },
      warn() { /* no-op */ },
      error() { /* no-op */ },
    },
    settings: {},
    execFile,
    signal: new AbortController().signal,
  };
}

function commandResult(overrides: Partial<ServerPluginExecFileResult> = {}): ServerPluginExecFileResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}