import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonValue } from "@jmfederico/pi-web/server-plugin-api";

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

export interface SysideWorkerClientOptions {
  /** Absolute path of the fixed NDJSON worker script. */
  scriptPath: string;
  spawner?: SysideWorkerSpawner;
  /**
   * Per-operation deadline. The host bounds capability requests to roughly 10
   * seconds, so this default deliberately fails (and restarts the worker) just
   * before the host deadline instead of letting the host abort first.
   */
  operationTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL during stop/poison. */
  stopGracePeriodMs?: number;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 9_000;
const DEFAULT_STOP_GRACE_PERIOD_MS = 1_000;
const STDERR_TAIL_LIMIT = 4_096;

interface WorkerRequest {
  id: number;
  operation: string;
  payload: JsonValue;
  signal: AbortSignal;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  /** True once the frame has been handed to the worker process. */
  dispatched: boolean;
  /** True once the request has settled; guards the abort listener against double handling. */
  settled: boolean;
  timer: NodeJS.Timeout | undefined;
  onAbort: () => void;
}

type WorkerResponse =
  | { id: number; ok: true; result: JsonValue }
  | { id: number; ok: false; error: string };

/**
 * Framing client for one persistent `python3 <fixed-worker-script>` process.
 *
 * Requests are serialized: at most one frame is in flight and later requests
 * queue behind it. A request whose abort signal fires before dispatch is
 * rejected without touching the healthy worker; an abort, timeout, malformed
 * frame, unexpected response id, worker exit, or broken pipe while a request is
 * active poisons the worker, rejects the current and queued requests, clears
 * client state, and lets the next request spawn a fresh process. A normal
 * `{ ok: false }` worker error response rejects only that request and keeps the
 * worker.
 */
export class SysideWorkerClient {
  private readonly scriptPath: string;
  private readonly spawner: SysideWorkerSpawner;
  private readonly operationTimeoutMs: number;
  private readonly stopGracePeriodMs: number;
  private process: SysideWorkerProcess | undefined;
  private readonly stderrTails = new Map<SysideWorkerProcess, string>();
  private active: WorkerRequest | undefined;
  private readonly queue: WorkerRequest[] = [];
  private nextId = 1;
  private stopping = false;
  private stopResult: Promise<void> | undefined;
  private generationValue = 0;

  constructor(options: SysideWorkerClientOptions) {
    this.scriptPath = options.scriptPath;
    this.spawner = options.spawner ?? spawnSysideWorkerProcess;
    this.operationTimeoutMs = positiveInteger(options.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, "operationTimeoutMs");
    this.stopGracePeriodMs = positiveInteger(options.stopGracePeriodMs, DEFAULT_STOP_GRACE_PERIOD_MS, "stopGracePeriodMs");
  }

  /**
   * Monotonic worker generation. It changes whenever the current process is
   * spawned or discarded (exit, spawn error, poison, stop), so a caller that
   * recorded the generation at model-load time can detect that the process
   * holding its model is gone — even when the worker died while idle — and
   * reload before dispatching.
   */
  get generation(): number {
    return this.generationValue;
  }

  /** Frame one operation through the worker; see the class contract above. */
  request(operation: string, payload: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.stopping) return Promise.reject(new Error("SysIDE Python worker is stopped"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<JsonValue>((resolve, reject) => {
      const request: WorkerRequest = {
        id,
        operation,
        payload,
        signal,
        resolve,
        reject,
        dispatched: false,
        settled: false,
        timer: undefined,
        onAbort: () => undefined,
      };
      request.onAbort = () => {
        if (request.settled) return;
        if (request.dispatched) {
          // The active operation failed from its own abort signal: the worker
          // may be mid-operation, so poison it and reject everything in flight.
          this.poison(abortError(signal));
        } else {
          this.rejectQueued(request, abortError(signal));
        }
      };
      signal.addEventListener("abort", request.onAbort, { once: true });
      // Adding a listener to an already-aborted signal does not invoke it, so
      // re-check after registration to close the registration race.
      if (signal.aborted) request.onAbort();
      if (request.settled) return;
      this.queue.push(request);
      this.dispatchNext();
    });
  }

  /**
   * Stop the worker idempotently: reject in-flight requests, close stdin so the
   * worker's read loop ends, send SIGTERM, then SIGKILL after a short grace
   * period. Resolves once the process has exited (or immediately when none is
   * running).
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopResult ?? Promise.resolve();
    this.stopping = true;
    this.stopResult = this.stopInternal();
    return this.stopResult;
  }

  private async stopInternal(): Promise<void> {
    const process = this.process;
    if (process !== undefined) this.discardProcess();
    this.rejectAll(new Error("SysIDE Python worker stopped"));
    if (process === undefined) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      process.onExit(() => { finish(); });
      try {
        process.stdin.end();
      } catch {
        // The stream is already closed; SIGTERM below still terminates Python.
      }
      process.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          process.kill("SIGKILL");
        } catch {
          // Already gone; the exit listener resolves the stop promise.
        }
      }, this.stopGracePeriodMs);
      killTimer.unref();
    });
  }

  private dispatchNext(): void {
    if (this.active !== undefined || this.stopping) return;
    const request = this.queue.shift();
    if (request === undefined) return;
    if (request.settled) {
      this.dispatchNext();
      return;
    }
    this.active = request;
    request.dispatched = true;
    let process: SysideWorkerProcess;
    try {
      process = this.ensureProcess();
    } catch (error) {
      this.failActive(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const frame = JSON.stringify({ id: request.id, op: request.operation, payload: request.payload });
    // Requests are strictly serialized and the worker replies only after
    // reading a frame, so the pipe has always drained before the next write;
    // a single buffered write cannot be lost even when it reports backpressure.
    try {
      process.stdin.write(`${frame}\n`);
    } catch (error) {
      // The stream was destroyed underneath us (the worker died between ensure
      // and write); poison so the request fails immediately rather than
      // wedging the client's active slot until the operation timeout.
      this.poison(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timer = setTimeout(() => {
      this.poison(new Error(`SysIDE Python worker request timed out after ${String(this.operationTimeoutMs)}ms`));
    }, this.operationTimeoutMs);
    timer.unref();
    request.timer = timer;
  }

  private ensureProcess(): SysideWorkerProcess {
    const existing = this.process;
    if (existing !== undefined) return existing;
    this.generationValue += 1;
    const process = this.spawner(this.scriptPath);
    this.process = process;
    process.onExit((code, signal) => { this.handleProcessExit(process, code, signal); });
    process.onError((error) => { this.handleProcessError(process, error); });
    this.wireStreams(process);
    return process;
  }

  private wireStreams(process: SysideWorkerProcess): void {
    // Python tracebacks and import notices go to stderr; keep a bounded tail
    // for diagnostics and drain the stream so the child never blocks on it.
    // Strings are immutable, so the map entry is re-set on every chunk instead
    // of only once here; the entry is deleted when the process is discarded so
    // a long-lived server never pins dead process objects via their stderr.
    let tail = "";
    process.stderr.on("data", (chunk: unknown) => {
      if (this.process !== process) return;
      if (typeof chunk === "string") tail = `${tail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
      else if (chunk instanceof Uint8Array) tail = `${tail}${chunk.toString()}`.slice(-STDERR_TAIL_LIMIT);
      this.stderrTails.set(process, tail);
    });
    this.stderrTails.set(process, tail);
    const reader = createInterface({ input: process.stdout });
    reader.on("line", (line: string) => { this.handleResponseLine(process, line); });
    reader.on("close", () => { this.handleStdoutClose(process); });
    // A failed stdin write (EPIPE after the child died) raises an async
    // 'error'; forward it to poison so the in-flight request fails immediately
    // instead of stalling until the operation timeout. The identity guard
    // keeps a stale error from a discarded process from poisoning a fresh
    // worker, and the handler also prevents an unhandled stream error from
    // crashing the server process.
    process.stdin.on("error", (error: Error) => {
      if (this.process !== process) return;
      this.poison(new Error(`SysIDE Python worker stdin failed: ${error.message}`));
    });
  }

  private handleProcessExit(process: SysideWorkerProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.process !== process) return;
    // Capture the stderr tail before discard removes the entry.
    const stderrTail = this.stderrTails.get(process)?.trim() ?? "";
    this.discardProcess();
    const exitDetail = signal !== null ? `signal ${signal}` : `code ${code === null ? "unknown" : String(code)}`;
    const suffix = stderrTail === "" ? "" : `: ${stderrTail}`;
    this.failActive(new Error(`SysIDE Python worker exited with ${exitDetail}${suffix}`));
  }

  private handleProcessError(process: SysideWorkerProcess, error: Error): void {
    if (this.process !== process) return;
    this.discardProcess();
    this.failActive(new Error(`Failed to start the SysIDE Python worker: ${error.message} (is Python 3 with the syside package installed?)`));
  }

  private handleStdoutClose(process: SysideWorkerProcess): void {
    if (this.process !== process) return;
    if (this.active === undefined) {
      // stdout ended while idle: the worker has stopped reading or writing and
      // will not serve the next request. Discard it so the next request spawns
      // a fresh process instead of stalling on the operation timeout.
      this.poison(new Error("SysIDE Python worker closed its output stream while idle"));
      return;
    }
    // stdout ended without a response for the active request: broken pipe or a
    // worker that stopped reading. Poison so the next request restarts it.
    this.poison(new Error("SysIDE Python worker closed its output stream"));
  }

  private handleResponseLine(process: SysideWorkerProcess, line: string): void {
    if (this.process !== process) return;
    let response: WorkerResponse;
    try {
      response = parseWorkerResponse(line);
    } catch (error) {
      this.poison(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const active = this.active;
    if (active === undefined) {
      this.poison(new Error("SysIDE Python worker returned a response with no active request"));
      return;
    }
    if (response.id !== active.id) {
      this.poison(new Error(`SysIDE Python worker returned an unexpected response id ${String(response.id)}`));
      return;
    }
    if (response.ok) {
      this.completeActive(response.result);
    } else {
      // A structured worker error is a normal response: the worker stays
      // healthy and keeps serving subsequent requests.
      this.failActive(new Error(response.error));
    }
  }

  private completeActive(result: JsonValue): void {
    const active = this.active;
    if (active === undefined) {
      this.poison(new Error("SysIDE Python worker completed a request that is no longer active"));
      return;
    }
    this.clearActive();
    active.settled = true;
    active.resolve(result);
    this.dispatchNext();
  }

  private failActive(error: Error): void {
    // Only the active request fails; the worker remains healthy (a structured
    // Python error response, or a poisoned worker that rejected everything).
    const active = this.active;
    if (active === undefined) return;
    this.clearActive();
    active.settled = true;
    active.reject(error);
    this.dispatchNext();
  }

  /** Reject the active request and every queued request with the same error. */
  private rejectAll(error: Error): void {
    const active = this.active;
    if (active !== undefined) {
      this.clearActive();
      active.settled = true;
      active.reject(error);
    }
    const queued = this.queue.splice(0);
    for (const request of queued) {
      if (request.settled) continue;
      request.settled = true;
      request.signal.removeEventListener("abort", request.onAbort);
      request.reject(error);
    }
  }

  /** Poison the worker: drop it, kill it in the background, reject everything. */
  private poison(error: Error): void {
    const process = this.process;
    if (process !== undefined) {
      this.discardProcess();
      this.killGracefully(process);
    }
    this.rejectAll(error);
  }

  private discardProcess(): void {
    this.generationValue += 1;
    // Release the captured stderr so a long-lived server never pins dead
    // process objects through their diagnostics tail.
    if (this.process !== undefined) this.stderrTails.delete(this.process);
    this.process = undefined;
  }

  private killGracefully(process: SysideWorkerProcess): void {
    try {
      process.stdin.end();
    } catch {
      // The stream is already closed; the signals below still apply.
    }
    try {
      process.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const killTimer = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, this.stopGracePeriodMs);
    killTimer.unref();
  }

  private rejectQueued(request: WorkerRequest, error: Error): void {
    if (request.settled) return;
    request.settled = true;
    request.signal.removeEventListener("abort", request.onAbort);
    const index = this.queue.indexOf(request);
    if (index !== -1) this.queue.splice(index, 1);
    request.reject(error);
  }

  private clearActive(): void {
    const active = this.active;
    this.active = undefined;
    if (active === undefined) return;
    if (active.timer !== undefined) clearTimeout(active.timer);
    active.signal.removeEventListener("abort", active.onAbort);
  }
}

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

function parseWorkerResponse(line: string): WorkerResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("SysIDE Python worker returned malformed JSON");
  }
  if (!isRecord(parsed)) throw new Error("SysIDE Python worker response must be a JSON object");
  const id = parsed["id"];
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("SysIDE Python worker response id must be an integer");
  const ok = parsed["ok"];
  if (ok === true) {
    return { id, ok, result: requireJsonValue(parsed["result"], "SysIDE Python worker response result") };
  }
  if (ok === false) {
    const error = parsed["error"];
    if (typeof error !== "string") throw new Error("SysIDE Python worker error response must include an error string");
    return { id, ok, error };
  }
  throw new Error("SysIDE Python worker response ok must be a boolean");
}

function requireJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const entry of value) output.push(requireJsonValue(entry, label));
    return output;
  }
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) output[key] = requireJsonValue(child, label);
    return output;
  }
  throw new Error(`${label} must contain only JSON values`);
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("SysIDE Python worker operation aborted", { cause: reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}
