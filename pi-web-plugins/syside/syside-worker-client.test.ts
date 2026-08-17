import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { SysideWorkerClient, type SysideWorkerProcess } from "./syside-worker-client.js";

interface FakeWorkerRequest {
  id: number;
  op: string;
  payload: unknown;
}

/** Writable that records frames synchronously and flags `end()` calls. */
class RecordingWritable extends Writable {
  readonly frames: string[] = [];
  endCalled = false;
  private readonly onFrame: (frame: string) => void;

  constructor(onFrame: (frame: string) => void) {
    super();
    this.onFrame = onFrame;
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const frame = chunkToString(chunk);
    this.frames.push(frame);
    this.onFrame(frame);
    callback();
  }

  override end(): this {
    this.endCalled = true;
    return super.end();
  }
}

/**
 * Deterministic fake for the spawned `python3` process: captures the NDJSON
 * frames the client writes to stdin, lets the test push response frames and
 * lifecycle events, and records kill signals.
 */
class FakeWorkerProcess implements SysideWorkerProcess {
  readonly pid = 4242;
  readonly stdin = new RecordingWritable((frame) => { this.consumeFrame(frame); });
  readonly stdout = new Readable({ read: () => undefined });
  readonly stderr = new Readable({ read: () => undefined });
  readonly requests: FakeWorkerRequest[] = [];
  readonly killedSignals: NodeJS.Signals[] = [];
  private exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;
  private consumed = 0;
  private readonly pendingChecks: (() => void)[] = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  /**
   * Resolve with the next unseen request frame. The frame may already have
   * arrived (stream data can be delivered synchronously during the client's
   * write) or may still be pending; either order resolves.
   */
  nextRequest(): Promise<FakeWorkerRequest> {
    const target = this.consumed;
    return new Promise<FakeWorkerRequest>((resolve) => {
      const attempt = (): void => {
        const request = this.requests[target];
        if (request !== undefined) {
          this.consumed = target + 1;
          resolve(request);
        } else {
          this.pendingChecks.push(attempt);
        }
      };
      attempt();
    });
  }

  /** Push one structured success response frame. */
  respond(result: JsonValue, id: number): void {
    this.stdout.push(`${JSON.stringify({ id, ok: true, result })}\n`);
  }

  /** Push one structured Python error response frame. */
  respondError(message: string, id: number): void {
    this.stdout.push(`${JSON.stringify({ id, ok: false, error: message })}\n`);
  }

  /** Push one malformed or raw output frame (newline appended). */
  emitLine(line: string): void {
    this.stdout.push(`${line}\n`);
  }

  /** Emit the process exit event. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitListener?.(code, signal);
  }

  /** Emit the spawn error event. */
  spawnError(error: Error): void {
    this.errorListener?.(error);
  }

  /** Emit an error on the stdin stream (e.g. EPIPE after the child died). */
  stdinError(error: Error): void {
    this.stdin.emit("error", error);
  }

  /** Close stdout (EOF) without an exit event. */
  endStdout(): void {
    this.stdout.push(null);
  }

  private consumeFrame(frame: string): void {
    for (const line of frame.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      this.requests.push(requireFakeWorkerRequest(JSON.parse(line)));
    }
    const checks = this.pendingChecks.splice(0);
    for (const check of checks) check();
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  return chunk instanceof Uint8Array ? chunk.toString() : String(chunk);
}

interface WorkerFixture {
  client: SysideWorkerClient;
  spawner: ReturnType<typeof vi.fn>;
  /** The most recently spawned fake process. */
  process: FakeWorkerProcess;
}

function workerFixture(scriptPath = "/unused/syside_worker.py"): WorkerFixture {
  const processes: FakeWorkerProcess[] = [];
  const spawner = vi.fn(() => {
    const process = new FakeWorkerProcess();
    processes.push(process);
    return process;
  });
  const client = new SysideWorkerClient({ scriptPath, spawner, operationTimeoutMs: 9_000, stopGracePeriodMs: 1_000 });
  return {
    client,
    spawner,
    get process(): FakeWorkerProcess {
      const process = processes[processes.length - 1];
      if (process === undefined) throw new Error("no SysIDE worker process was spawned");
      return process;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SysideWorkerClient", () => {
  it("frames NDJSON requests and correlates responses by id", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const signal = new AbortController().signal;

    const first = client.request("check", null, signal);
    const request = await fixture.process.nextRequest();
    expect(request).toEqual({ id: 1, op: "check", payload: null });
    fixture.process.respond({ errors: ["boom"] }, request.id);
    await expect(first).resolves.toEqual({ errors: ["boom"] });

    const second = client.request("list_elements", null, signal);
    const request2 = await fixture.process.nextRequest();
    expect(request2.id).toBe(2);
    fixture.process.respond([{ id: "e1", name: "Wing", qualifiedName: "Sample::Wing", kind: "PartDefinition" }], request2.id);
    await expect(second).resolves.toEqual([{ id: "e1", name: "Wing", qualifiedName: "Sample::Wing", kind: "PartDefinition" }]);
  });

  it("serializes calls: the next frame is only written after the previous response", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const signal = new AbortController().signal;

    const first = client.request("check", null, signal);
    const request = await fixture.process.nextRequest();
    const second = client.request("check", null, signal);
    // The second request is queued: the worker has not seen it yet.
    await Promise.resolve();
    expect(fixture.process.requests).toHaveLength(1);
    fixture.process.respond({ errors: [] }, request.id);
    await expect(first).resolves.toEqual({ errors: [] });

    const request2 = await fixture.process.nextRequest();
    expect(request2.id).toBe(2);
    fixture.process.respond({ errors: [] }, request2.id);
    await expect(second).resolves.toEqual({ errors: [] });
  });

  it("rejects an already-aborted request before dispatch without touching the worker", async () => {
    const { client, spawner } = workerFixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(client.request("check", null, controller.signal)).rejects.toThrow("cancelled");
    expect(spawner).not.toHaveBeenCalled();
  });

  it("rejects a queued request whose signal aborts before dispatch and keeps the worker healthy", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = client.request("check", null, firstController.signal);
    const request = await fixture.process.nextRequest();
    const second = client.request("check", null, secondController.signal);

    secondController.abort(new Error("cancelled second"));
    await expect(second).rejects.toThrow("cancelled second");
    expect(fixture.process.killedSignals).toEqual([]);

    fixture.process.respond({ errors: [] }, request.id);
    await expect(first).resolves.toEqual({ errors: [] });
  });

  it("poisons the worker and rejects current and queued requests when the active request aborts", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = client.request("check", null, firstController.signal);
    await fixture.process.nextRequest();
    const second = client.request("check", null, secondController.signal);

    firstController.abort(new Error("cancelled active"));
    await expect(first).rejects.toThrow("cancelled active");
    await expect(second).rejects.toThrow("cancelled active");
    expect(fixture.process.killedSignals).toContain("SIGTERM");
  });

  it("poisons the worker and rejects the request on its own operation timeout", async () => {
    vi.useFakeTimers();
    const fixture = workerFixture();
    const client = fixture.client;
    const signal = new AbortController().signal;

    const requestPromise = client.request("check", null, signal);
    await fixture.process.nextRequest();
    // Attach the rejection handler before the fake timer fires so the expected
    // rejection is never reported as unhandled.
    const rejection = requestPromise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(9_000);
    const error = await rejection;
    expect(errorMessage(error)).toContain("timed out after 9000ms");
    expect(fixture.process.killedSignals).toContain("SIGTERM");
  });

  it("rejects a structured Python error response but keeps the worker healthy", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const spawner = fixture.spawner;
    const signal = new AbortController().signal;

    const failing = client.request("check", null, signal);
    const request = await fixture.process.nextRequest();
    fixture.process.respondError("No model is loaded for this workspace", request.id);
    await expect(failing).rejects.toThrow("No model is loaded for this workspace");
    expect(fixture.process.killedSignals).toEqual([]);

    const next = client.request("check", null, signal);
    const request2 = await fixture.process.nextRequest();
    expect(request2.id).toBe(2);
    fixture.process.respond({ errors: [] }, request2.id);
    await expect(next).resolves.toEqual({ errors: [] });
    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it("poisons on a malformed response frame and recovers with a fresh process", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const first = fixture.client.request("check", null, signal);
    await fixture.process.nextRequest();
    fixture.process.emitLine("this is not json");
    await expect(first).rejects.toThrow("malformed JSON");
    expect(fixture.process.killedSignals).toContain("SIGTERM");

    const second = fixture.client.request("check", null, signal);
    expect(fixture.spawner).toHaveBeenCalledTimes(2);
    const request2 = await fixture.process.nextRequest();
    expect(request2.id).toBe(2);
    fixture.process.respond({ errors: [] }, request2.id);
    await expect(second).resolves.toEqual({ errors: [] });
  });

  it("rejects the active request when the worker crashes and respawns on the next request", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const first = fixture.client.request("check", null, signal);
    await fixture.process.nextRequest();
    fixture.process.exit(1, null);
    await expect(first).rejects.toThrow("exited with code 1");

    const second = fixture.client.request("check", null, signal);
    expect(fixture.spawner).toHaveBeenCalledTimes(2);
    const request2 = await fixture.process.nextRequest();
    fixture.process.respond({ errors: [] }, request2.id);
    await expect(second).resolves.toEqual({ errors: [] });
  });

  it("rejects the active request on a spawn error with a dependency hint", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const request = fixture.client.request("check", null, signal);
    await fixture.process.nextRequest();
    fixture.process.spawnError(new Error("spawn python3 ENOENT"));
    await expect(request).rejects.toThrow(/Python 3 with the syside package/);
  });

  it("rejects the active request when stdout closes (EOF) and respawns on the next request", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const first = fixture.client.request("check", null, signal);
    await fixture.process.nextRequest();
    fixture.process.endStdout();
    await expect(first).rejects.toThrow("closed its output stream");

    const second = fixture.client.request("check", null, signal);
    expect(fixture.spawner).toHaveBeenCalledTimes(2);
    const request2 = await fixture.process.nextRequest();
    fixture.process.respond({ errors: [] }, request2.id);
    await expect(second).resolves.toEqual({ errors: [] });
  });

  it("discards a worker whose stdout closes while idle and respawns on the next request", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const first = fixture.client.request("check", null, signal);
    const request = await fixture.process.nextRequest();
    fixture.process.respond({ errors: [] }, request.id);
    await expect(first).resolves.toEqual({ errors: [] });

    // stdout EOF while no request is active: the worker is unresponsive and
    // must be discarded so the next request spawns a fresh process instead of
    // stalling on the operation timeout. The readline 'close' fires on a later
    // tick, so let the poison land before the next request dispatches.
    fixture.process.endStdout();
    await new Promise((resolve) => setImmediate(resolve));

    const second = fixture.client.request("check", null, signal);
    expect(fixture.spawner).toHaveBeenCalledTimes(2);
    const request2 = await fixture.process.nextRequest();
    fixture.process.respond({ errors: [] }, request2.id);
    await expect(second).resolves.toEqual({ errors: [] });
  });

  it("poisons immediately when a stdin write fails instead of waiting for the operation timeout", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const first = fixture.client.request("check", null, signal);
    await fixture.process.nextRequest();
    fixture.process.stdinError(new Error("write EPIPE"));
    await expect(first).rejects.toThrow("stdin failed");
    expect(fixture.process.killedSignals).toContain("SIGTERM");
  });

  it("includes the captured stderr tail in the exit error for diagnostics", async () => {
    const fixture = workerFixture();
    const signal = new AbortController().signal;

    const first = fixture.client.request("check", null, signal);
    await fixture.process.nextRequest();
    fixture.process.stderr.push("Traceback (most recent call last):\n");
    fixture.process.stderr.push('  File "syside_worker.py", line 12, in <module>\n');
    // 'data' events are delivered on a later tick; let them land before exit.
    await new Promise((resolve) => setImmediate(resolve));
    fixture.process.exit(1, null);
    await expect(first).rejects.toThrow("Traceback (most recent call last):");
  });

  it("rejects a response with an unexpected id and poisons the worker", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const signal = new AbortController().signal;

    const first = client.request("check", null, signal);
    const request = await fixture.process.nextRequest();
    fixture.process.respond({ errors: [] }, request.id + 1);
    await expect(first).rejects.toThrow("unexpected response id");
    expect(fixture.process.killedSignals).toContain("SIGTERM");
  });

  it("rejects malformed response envelopes and poisons the worker", async () => {
    const fixture = workerFixture();
    const client = fixture.client;
    const signal = new AbortController().signal;

    const first = client.request("check", null, signal);
    const request = await fixture.process.nextRequest();
    fixture.process.emitLine(JSON.stringify({ id: request.id, ok: "maybe" }));
    await expect(first).rejects.toThrow("ok must be a boolean");
    expect(fixture.process.killedSignals).toContain("SIGTERM");
  });

  it("stops idempotently: closes stdin, SIGTERM, then SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    const fixture = workerFixture();
    const client = fixture.client;
    const signal = new AbortController().signal;
    const pending = client.request("check", null, signal);
    await fixture.process.nextRequest();

    const stop = client.stop();
    await expect(pending).rejects.toThrow("SysIDE Python worker stopped");
    expect(fixture.process.stdin.endCalled).toBe(true);
    expect(fixture.process.killedSignals).toContain("SIGTERM");

    const secondStop = client.stop();
    expect(secondStop).toBe(stop);

    // The worker never exits on SIGTERM, so the grace-period SIGKILL fires.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.process.killedSignals).toContain("SIGKILL");

    fixture.process.exit(0, null);
    await expect(stop).resolves.toBeUndefined();
  });

  it("stops immediately when no worker is running", async () => {
    const { client } = workerFixture();
    await expect(client.stop()).resolves.toBeUndefined();
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("rejects requests after stop", async () => {
    const client = workerFixture().client;
    await client.stop();
    await expect(client.request("check", null, new AbortController().signal)).rejects.toThrow("stopped");
  });
});

function requireFakeWorkerRequest(value: unknown): FakeWorkerRequest {
  if (!isRecord(value)) throw new Error("worker request must be an object");
  const id = value["id"];
  const op = value["op"];
  const payload = value["payload"];
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("worker request id must be an integer");
  if (typeof op !== "string") throw new Error("worker request op must be a string");
  return { id, op, payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
