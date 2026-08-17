# SysIDE plugin agent notes

This plugin exposes SysML tooling (`check`, `survey`, filtered `list-elements`,
`element-details`) for workspaces containing `*.sysml` files, backed by a
persistent Python worker process. This document explains the architecture,
where every interface is defined, and the exact steps for changing the wire
protocol or adding a new operation.

## Architecture

The stack has seven layers, each with one job. Data flows top to bottom:

```
browser/syside-panel.ts          UI panel (Lit), talks to the host, not Python
  └─ browser/syside-contract.ts  capability operation names + response parsers/types
server-plugin.ts                 capability registration (`workspace.sysml`), lifecycle
  └─ syside-backend.ts           routes capability operations to service methods
    └─ syside-model.ts           SysideModelService: model lifecycle, reload, dirty tracking
      └─ syside-worker-client.ts NDJSON framing, serialization, poisoning, respawn
        └─ worker/syside_worker.py  persistent Python process, one loaded model
```

Key design decisions (do not undo these casually):

- **Non-owning capability.** `workspace.sysml` never claims a workspace; Git
  worktrees and ownerless folders both get the capability (`server-plugin.ts`).
- **Lazy loading.** API v1 has no workspace-selection hook and `probe()` must
  stay cheap and side-effect-free, so the model is loaded on the *first
  capability request* for a workspace, not on probe or selection
  (`syside-model.ts`, `syncModel()`).
- **One model slot.** The worker holds at most one model (`load` replaces it).
  A workspace switch reloads; there is no multi-model cache.
- **`node:child_process` is allowed only in `syside-worker-client.ts`.**
  `pluginPublicApi.test.ts` enforces this with an allowlist keyed by rule id
  (`node-child-process` → this one file). `context.execFile()` remains the
  boundary for every other plugin; a persistent bidirectional stdio worker
  cannot be built with it.
- **Model reload correctness does not depend on the watcher.** The fs watcher
  in `syside-model.ts` only sets a `dirty` flag; every request re-runs
  manifest discovery and compares fingerprints (`syside-discovery.ts`,
  `path:size:mtimeMs:ctimeMs`) as the correctness fallback.

### Worker client semantics (`syside-worker-client.ts`)

- Requests are serialized: one frame in flight, later requests queue.
- A `{ ok: false }` Python response rejects only that request; the
  worker stays healthy.
- Timeout, abort of a dispatched request, malformed frame, unexpected response
  id, worker exit, broken stdin, or stdout closing *poisons* the worker:
  the process is killed, all in-flight/queued requests are rejected, and the
  next request spawns a fresh process.
- The `generation` counter increments on every spawn/discard;
  `SysideModelService` records it at load time to detect that the process
  holding its model is gone (even after an idle death) and to force a reload.
- `operationTimeoutMs` defaults to 9000 ms — deliberately just under the
  host's ~10 s capability request deadline.

### Python worker invariants (`worker/syside_worker.py`)

- Imports `syside` before the request loop.
- Module-level stdout hygiene is mandatory: import-time stdout is captured and
  replayed on stderr, and `main()` dups fd 1 and redirects fd 1 → 2 so *any*
  stray `print`/`os.write` during a request goes to stderr instead of
  corrupting the NDJSON stream. Responses are written on the saved duplicate.
  Do not remove this — a polluted stream poisons the worker and creates a
  silent crash-reload loop.
- Fixed operations only. No `eval`, `exec`, shell execution, or
  caller-provided module names. `load` accepts only absolute file paths.
- A failed `load` clears the active model so a stale partial model is never
  queried.

## Where each interface is defined

| Boundary | Defined in |
| --- | --- |
| Capability id (`workspace.sysml`) | `server-plugin.ts` (`SYSIDE_CAPABILITY_ID`, keep stable — the browser panel matches on it) |
| Public capability operation names (hyphenated: `survey`, `list-elements`, `element-details`, …) | `browser/syside-contract.ts` (`SYSIDE_*_OPERATION` constants) |
| Supported element type names (`SYSIDE_ELEMENT_TYPES`) | `browser/syside-contract.ts` (mirrored in the worker's `SYSIDE_TYPE_BY_NAME`) |
| Response shapes/types + runtime parsers shared by browser and server | `browser/syside-contract.ts` |
| Capability → service routing | `syside-backend.ts` (`requestSysideCapability`) |
| Service API (model lifecycle, reload policy) | `syside-model.ts` (`SysideModelService`, injectable `spawner`/`clientFactory`/`watcherFactory`/`discovery`) |
| NDJSON wire protocol (frame shape, poison rules, timeouts) | `syside-worker-client.ts` |
| Python-side wire protocol + operations | `worker/syside_worker.py` (`ALLOWED_OPERATIONS`, `dispatch`, `respond`) |
| SysML file discovery + fingerprint | `syside-discovery.ts` |
| `node:child_process` allowlist | `pi-web-plugins/pluginPublicApi.test.ts` |

Note the naming split: public capability operations use hyphens (the host
rejects underscores in backend operation names); the Python worker uses
snake_case (`list_elements`, `element_details`). `syside-model.ts` maps between
them.

## How to change the wire protocol

The NDJSON protocol is `{id, op, payload}` in, `{id, ok, result|error}` out,
defined independently on both ends:

- Python side: `dispatch()` / `respond()` in `worker/syside_worker.py`.
- TypeScript side: `WorkerResponse` type and `parseWorkerResponse()` in
  `syside-worker-client.ts`.

Both ends must change together; the client poisons the worker on any
malformed response, so a mismatch fails loudly (worker restart loop), not
silently. Changing the frame envelope (`id`, `ok`, error shape) also affects
`parseWorkerResponse()` validation and the framing tests in
`syside-worker-client.test.ts`. Additive payload fields are the low-risk path;
renames or removals need both ends plus the contract parsers updated in one
change.

## How to add a new operation

Checklist, in dependency order — one commit, all steps:

1. **Python handler** (`worker/syside_worker.py`): add a `handle_<op>`
   function, add the snake_case name to `ALLOWED_OPERATIONS`, and route it in
   `dispatch()`. Keep it read-only against the active model (only `load`
   mutates state). Cover it in the worker's framing behavior via the client
   tests or a real-subprocess smoke test.
2. **Model service** (`syside-model.ts`): add a method mirroring
   `elementDetails()` — `serialize()` → `syncModel()` → `clientDispatch()` with
   a parser. If the operation should not require a loaded model, branch on
   `manifest.files.length` like `check()` does.
3. **Contract** (`browser/syside-contract.ts`): add a hyphenated
   `SYSIDE_<OP>_OPERATION` constant and a response type plus
   `parseSyside<Op>Response` validator, so browser and server share one shape.
4. **Routing** (`syside-backend.ts`): extend `SysideCapabilityService` with
   the new method and add a case in `requestSysideCapability()` with input
   validation (`requireNullInput` / a new `require…Input` helper).
5. **UI** (`browser/syside-panel.ts`): consume the new operation through the
   host capability request path only.
6. **Tests**: `server-plugin.test.ts` / `syside-backend.test.ts` for routing,
   `syside-model.test.ts` for service behavior (use the injectable
   `clientFactory`/`spawner` fakes — no Python needed), and
   `syside-worker-client.test.ts` if new framing/poison behavior is involved.

## Build, run, verify

- The `.py` worker is shipped verbatim: `npm run build:plugins` copies
  non-TypeScript files to `dist/pi-web-plugins/syside/worker/`. There is no
  Python build step; verify with `python3 -m py_compile`.
- The plugin is `machineSpecific: true` and requires `python3` with the
  `syside` package on the machine running the server.
- The `syside` package is commercial and requires a license. Notify the user
  in case you encounter a license error. 
- Relevant checks: `npm run typecheck`, eslint on `pi-web-plugins/syside`,
  `npm run build:plugins`, and the test suites listed above. Real-subprocess
  smoke tests against the installed `syside` package are the only way to
  verify the Python adapter calls (`try_load_model`, `Element`,
  `user_docs`, `element_id`, …) — those calls were verified against the
  installed package API, so re-verify after any `syside` package upgrade.
