# D-RESIDENT-001: Resident Pi sessions that survive Gateway restarts

Status: user-approved direction (kojira: 「最初から常駐化でやってください」, `/pi status` にバージョン表示). Personal use; smallest end-to-end design.

## Goal

- Restarting the Gateway does not stop any channel's Pi. The new Gateway reattaches and delivers everything Pi emitted meanwhile, in order, once.
- Each Pi start reads `PI_BIN` from the config file, so a Pi deploy only rewrites `PI_BIN`. Running Pis keep their version until they end.
- `/pi reload` ends this channel's Pi after its current work; the next message starts the configured `PI_BIN`. `/pi status` shows running/configured Pi version and the Gateway version.

Scope: persistent mode (`PI_RPC_PERSISTENT=true`, the production setting). Request-scoped mode is unchanged (direct stdio child, stopped with the Gateway).

## Process layout

```
launchd ─ Gateway (node dist/cli/index.js start)
          │  unix socket (JSONL)
          ▼
          pi-host (node dist/agent/pi-host.js)   own session (setsid via spawn detached), stdio ignored
          │  stdio pipes (unchanged Pi RPC)
          ▼
          pi --mode rpc --session-dir <channel> --continue …
```

- `pi-host` is a small Node script in this repo. Pi's RPC mode is not changed: Pi still sees pipes and exits on stdin EOF.
- The Gateway spawns `pi-host` with `detached: true` and `unref()`; launchd only kills the Gateway's own process group, so `pi-host` and Pi survive a Gateway stop.
- Socket: `<SESSIONS_DIR>/.pi-hosts/<sha256(sessionDir)[:16]>.sock` (directory 0700). If that path exceeds the 103-byte `sun_path` limit, `<tmpdir>/piscord-<hash>.sock` is used. The chosen path is stored in the record.
- Record: `<channel session dir>/pi-host.json` (atomic write). It holds socket path, host/Pi pid, `PI_BIN`, launch settings, subagents temp root, and the resume snapshot below. Deleted when Pi exits.

## Socket protocol

Client → host, one JSON object per line:

- `{"host":"attach","after":N}` first. A new attach replaces (closes) the previous client. The host replies `0 {"host":"attached",hostPid,piPid,bin,startedAt}` and replays buffered Pi lines with seq > N.
- `{"host":"ack","seq":N}` drops buffered lines ≤ N.
- `{"host":"end-stdin"}` ends Pi's stdin; `{"host":"signal","signal":"SIGTERM"}` signals Pi.
- Any other line is written verbatim to Pi's stdin (normal RPC commands).

Host → client: `<seq> <raw Pi stdout line>\n`, seq from 1, increasing. Host messages use seq 0. When Pi exits the host sends all remaining lines, then `0 {"host":"exit",code,signal}`, removes the socket and exits. If no client is attached when Pi exits, it waits (up to 1 hour) for an attach to deliver the tail first.

The host buffers every line until acknowledged, so nothing Pi emits while no Gateway is attached is lost.

## Gateway side

`invoke.ts` keeps its existing RPC handling; only the transport differs. A `ResidentPiProcess` (socket client) exposes the same surface the code used on the child process (`stdin.write/end`, `stdout` line data, `kill`, `close`). Each delivered line is consumed synchronously, so after it the client's `lastSeq` is exactly the processed position.

Snapshot (resume state) = `lastSeq` + every per-connection/per-request variable `invoke.ts` keeps (`requestRunId`, `currentRunId`, `initialPromptObserved`, `promptSubmitted`, `settled`, `steeringClosed`, delivered-text state, `parked`, `workOutcome`, errors, compaction flag, pending prompt command id, accepted-but-unconsumed steering `{message,rowids}`, `reloadRequested`) + the queue's request context (`rowid`, `content`, delivery tracker). It is written only when no Discord delivery is pending (debounced 200 ms) and on detach; after a write the Gateway acks that seq.

### Gateway shutdown (persistent mode)

`stopProcessingLoop` no longer stops Pis. It calls `detachResidentAgents()`:

1. New requests are refused (`pending`, row stays pending).
2. Wait (bounded by `SHUTDOWN_TIMEOUT_MS`) for steering in flight and pending RPC command responses.
3. Pause reading the socket, wait for queued Discord deliveries/consumption callbacks, write the snapshot, close the socket.
4. The active request resolves as `detached`: the queue leaves its row `processing` and sends nothing. A request whose prompt was not yet submitted resolves `pending` (definitely unsent; row back to pending), as today.

Graceful restart (SIGTERM, launchd stop) is therefore exactly-once. After a hard kill the last snapshot may be up to one delivery behind: events after it are processed again, so a reply in flight at the kill can be sent twice (traces too). Accepted for personal use.

### Gateway startup

`startProcessingLoop` first reads `pi-host.json` of every registered channel. A record whose host pid is alive and socket exists is resumable: its request row and steering rows are excluded from the existing processing→pending recovery. Other records are deleted and their rows follow the existing rule.

For each resumable record the Gateway connects, attaches after the snapshot seq, restores the snapshot, and registers the connection. If the snapshot has a request, the queue re-creates the channel task (channel lock, typing, abort controller for `/pi stop`) with the same delivery callbacks and finishes the row through the same code path as a live request. If attach fails, the row is marked failed with an error message (the prompt may have been accepted; no replay, same as other uncertain persistent input).

## PI_BIN per spawn

`currentPiBin()` re-reads the environment and config file (`PIDG_CONFIG` / default path) at each Pi start, model catalog listing and stats probe. `PI_BIN` is no longer part of the runtime-settings process identity: a changed `PI_BIN` is not an "unapplied setting" on a running Pi, it applies at the next start (or `/pi reload`).

## /pi reload and /pi status

- `/pi reload`: marks the connection. When there is no Gateway request in flight and Pi is not parked waiting for an async child, the Gateway ends Pi's stdin without `clear_queue`/`abort` (Pi finishes its current state and exits normally; session history stays). Queued Discord messages remain pending; the next one starts a new Pi on the configured `PI_BIN`. With no resident Pi it says so.
- `/pi status` adds `Pi version` (running label, configured label, and "reload to upgrade" when they differ) and `Gateway version`. Label: `pi-<commit12>` / `gateway-<commit12>` taken from the deploy artifact path, otherwise the file name / package version.

## Deploy tool (pi-stack-deploy, branch `resident-pi`)

- Pi-only deploy: switch `PI_BIN` in place (lock, backup, atomic write, evidence) without stopping the Gateway or waiting for idle.
- Gateway deploy: idle gate keeps only blockers that are not Pi work (competing controllers/locks, imminent schedules); the work digest no longer includes queue/sessions/child runs/process tree. Resident Pis are not stopped or exit-proven; Gateway shutdown itself drains its delivery state. Queue rows may change during stop (unsent requests return to pending), so the queue-unchanged check is dropped.

## Non-goals / risks

- Hard-kill duplicates (above). No multi-Gateway attach (a new attach replaces the old one).
- `/pi reload` cannot see background subagents except via the parked flag; a child started without parking would be cancelled by Pi's EOF shutdown, as with `/pi stop` today.
- Windows: `pi-host` uses Unix sockets; persistent mode on Windows is not supported by this change.

## Acceptance

1. Kill (SIGTERM) the Gateway mid-turn, start it again: the reply arrives once, the row ends `done` once.
2. Change `PI_BIN` in the config file: the next new Pi uses it without a Gateway restart; a running Pi keeps its binary.
3. `/pi reload` ends the Pi after its current request; the next message starts the configured `PI_BIN`.
4. `/pi status` shows running/configured Pi version and Gateway version.
