import { spawn } from "node:child_process";

/**
 * Narrow stdio process abstraction used by the persistent SysIDE Python worker
 * client. The real implementation wraps one `child_process.spawn` result; tests
 * inject a fake so NDJSON framing, correlation, poisoning, and shutdown can be
 * exercised without a Python interpreter.
 */
export interface SysideWorkerProcess {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): boolean;
}

/** Injectable process factory: `spawn("python3", [scriptPath])` by default. */
export type SysideWorkerSpawner = (scriptPath: string) => SysideWorkerProcess;

/** Real spawn wrapper for `python3 <fixed-worker-script>` with three pipes. */
export function spawnSysideWorkerProcess(scriptPath: string): SysideWorkerProcess {
  const child = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => child.on("exit", listener),
    onError: (listener) => child.on("error", listener),
    kill: (signal) => child.kill(signal),
  };
}