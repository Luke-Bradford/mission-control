# Spike: a seat that keeps working while the hub restarts, and a CLI swap under a running seat

Date: 2026-10-22, against `main` at `5efaaa0`. Claude Code 2.1.308 (Homebrew cask), Node 24.22.1,
Homebrew 7.0.10, macOS 27.0.1. Evidence comes from five sources:

- `claude -p` processes driven the way the hub's session driver drives them (stream-json both ways);
- a throwaway launchd agent;
- a preview hub on a copy of the database with `MC_NO_LOOP_WRITES=1` and `MC_NO_CREW=1`;
- the live hub's log, read only;
- code reading.

No product code changed. This answers #94.

**Decision.** Run each seat through a small detached keeper process that owns the CLI's stdin and
stdout and listens on a Unix socket. The prototype kept a real `claude -p` seat working after its
launchd job's main process had exited. The next hub then replayed the missed lines and carried on.
Three changes go with it:

- the new hub adopts each surviving run's token and test-lock holds;
- the guard hook retries a refused connection for up to 60 s before it fails closed;
- Update stops refusing while a seat is mid-turn.

Running seats need nothing for a CLI swap, because each keeps the binary it started on. A seat must
not be spawned while `brew upgrade` has the `claude` link removed.

## 1. Today's cost

How it works today (code):

- **Update ends seats' turns.** Update ends in `restart()`, and the hub's shutdown handler
  (`apps/server/src/shutdown.ts`) runs `stopAll` (`apps/server/src/runtime/supervisor.ts` 1802).
  That ends each seat's stdin and waits at most `CREW_STOP_WAIT_MS` (5 s, line 115), then the hub
  exits.
- **Seats share the hub's process group.** They are spawned without `detached`
  (`apps/server/src/runtime/session.ts` 123).
- **Update waits for idle seats.** It refuses while any seat is mid-turn (`midTurn`,
  `apps/server/src/update.ts` 57). On 22 Oct the live hub's version check answered
  `canUpdate: false` with "GUIDO-1 is mid-turn", then "FLIGHT-1 is mid-turn", while an update
  waited for a quiet moment.
- **Runs resume on the next start.** `reattach` respawns each active run with `--resume`
  (`supervisor.ts` 1021). The engine reconciles on every supervisor event, so it then sends
  `RESUME_TEXT` ("Carry on with {ref}: Mission Control restarted…", `packages/core/src/loop.ts` 120)
  to a working or reviewing run.

Measured. A probe script ran a stream-json session whose turn was `sleep 20` (or `sleep 1` then
`sleep 20`) through the Bash tool, then did to it what the hub and launchd do:

| What was done | Result |
|---|---|
| stdin ended while the Bash call ran, as `stopAll` does | The CLI finished the turn: `result` success 20.6 s after the end of stdin, exit 0 at 21.1 s |
| A launchd job's main process exits | A child in the job's process group was gone. A child started `detached` (its own session) was still running |
| SIGKILL 2 s into the second Bash call, then `--resume` | The session file held the first call and its result, and the second call's `tool_use`. On resume the CLI added `[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]` and an assistant line "No response requested." Told to carry on, the model said the call "was interrupted" and ran it again |
| SIGKILL 12 ms after the `tool_use` line reached stdout | The call was not in the session file yet. After resume the model said "No Bash call has run yet in this conversation" and ran it from the start |
| Respawn with `--resume`, then the carry-on line | `system/init` 0.27 s and the first assistant event 1.5 s after the respawn |
| Hub restarts in the live log, 22 Oct | 13 restarts (4 SIGTERM, 9 Update). From "shutting down" to "Server listening" took 0.31–3.54 s |

The hub's parts (the 5 s wait, the process group, the engine's carry-on) are read from code, not
measured with a seat. A preview with `MC_CREW=1` was not used: it needs its own crew folder, clone
and Ready ticket, and its mc tools and engine act on the real GitHub. The CLI's behaviour does not
depend on the hub, so it was measured directly.

What a seat loses today when the hub restarts mid-turn:

- **The turn,** unless it ends within 5 s. The CLI is killed with the hub's process group. The
  in-flight tool call's output is lost, and after "Carry on" the call runs again. When the kill lands
  before the CLI has written the call to its session file, the model does not know the call started,
  so a half-done side effect can be repeated blindly.
- **An mc call in flight** (code reading): its HTTP request is cut, and the seat does not know
  whether its effect, such as a commit or a push, happened.
- **Seconds of time:** the respawn and the carry-on, then the redo of the cut call.

The larger cost is the refusal. Update waits until no seat is mid-turn, and a seat's turn can be a
whole implementation.

## 2. Detaching a seat

A throwaway prototype, not committed: a 65-line Node keeper and a stand-in for the hub. The keeper
spawns the seat's command with pipes, appends each stdout line to `transcript.jsonl` and numbers it.
It listens on `seat.sock` in a 0700 folder (the socket 0600) and serves one hub at a time; a new
connection replaces the old one. A hub sends `{"hello": n}` to get every line from `n` on, then
`{"line": …}` for stdin, or `{"close": true}` to end stdin. The hub stand-in's `start` spawns the
keeper with `detached: true`, connects, sends the first line and exits. Its `attach` is the next
hub.

```sh
launchctl bootstrap gui/$(id -u) job.plist   # the job runs: node hub.mjs start <dir> … (hub 1)
node hub.mjs attach <dir> close                # hub 2, started after hub 1 has exited
launchctl bootout gui/$(id -u)/<label>
```

| Child | Result |
|---|---|
| A dummy seat (each line is a 3 s turn) | Hub 1, a launchd job, sent "turn 1" and exited mid-turn. launchd showed the job "not running" and the keeper still running. Hub 2 replayed line 0, turn 1's result, which was written while no hub was attached. It then sent turn 2, got the result and sent close. The child exited 0, then the keeper exited and removed the socket |
| `claude -p` 2.1.308 in stream-json, turn 1 a `sleep 15` Bash call | Hub 1 exited 0.5 s into the turn. Hub 2 attached about 5 s later and replayed the lines written so far, the tool call among them. It received the rest of turn 1 live, sent turn 2 and got its result. Close ended the CLI with exit 0 |

What broke, or has to be designed:

1. **Tokens.** A run's token lives only in hub memory (`RunTokens`,
   `apps/server/src/mcp/tokens.ts`). The preview hub was given a token it had not issued.
   `/api/guard/check` answered `401`, and the hook then denied with exit 2. `/mcp` answered
   `401 {"error":"unknown run"}`. A surviving seat would be locked out of the new hub. On reattach,
   the hub must adopt the token from the run's 0600 token file, which `sweepRunFiles` already keeps
   for active runs (`supervisor.ts` 754).
2. **Test-lock holds** are hub memory too (`apps/server/src/guard/lock.ts`). A seat running a locked
   suite across the restart would hold nothing in the new hub, so a second suite could start. The
   holds must survive the restart, stored or reported again on reattach.
3. **A run that ends while no hub is attached.** The prototype sent the child's exit only to a
   connected hub, so with none attached it was lost. The keeper must write the exit code, signal and
   time to a file for the next hub.
4. **stderr.** The prototype dropped the child's stderr, but the hub uses the last stderr line as the
   seat's error reason. The keeper must forward stderr as typed lines and keep the last one.
5. **Replay.** The hub keeps, per run, the last line it has acted on, and asks from there. A turn
   that ended during the gap then reaches the hub as its `result`, and the engine reacts as it does
   today. The hub must store that line number in the same write as the effects of the lines it
   covers, or make each effect safe to apply twice. Otherwise a crash between the two repeats or
   loses a turn's end. The keeper, not the hub, writes the transcript file.
6. **Process group.** The keeper must be started `detached`: launchd ends the job's process group,
   not a child in its own session (§1).
7. **Version skew.** A keeper keeps running the code it started with across an Update. Its hello
   must carry a protocol version. A hub that doesn't speak that version may fall back to `--resume`
   only after it has ended the old keeper and its CLI and seen them exit. Two CLIs must never run
   one session, and the supervisor assumes one process per run (`supervisor.ts` 825-837). So the
   keeper records its pid in its folder, where any hub version can find it.
8. **Who may attach.** The socket's folder sits under the hub's data folder. The seat sandbox's
   `denyRead` always holds that folder, and the sandbox sets no `allowUnixSockets`
   (`packages/core/src/runtime.ts` 599, 609), so a seat can neither read the folder nor connect to
   it. Because the newest client wins, a hub must attach only while it holds the crew lock. A
   preview with `MC_CREW=1` can't take that lock while the live hub holds it.
9. **Start order.** The server listens before the supervisor starts (`apps/server/src/main.ts`
   314-316). A surviving seat's hook could reach the new hub before its token is adopted, get a 401
   and be denied, and a 401 is not retried. A suite could also start before another run's hold is
   restored. So tokens and lock holds must be restored before the server listens. Those of a run
   that is then not reattached are dropped.
10. **Attaching is not resuming.** Today a resumed seat is set idle and an `idle` event with
    `resumed: true` goes out (`supervisor.ts` 1087-1095). That makes the engine send "Carry on"
    (`packages/core/src/loop.ts` 773-786). An attached seat takes its turn state from the replay and
    is not marked resumed, so a seat mid-turn is not told to carry on.

## 3. The hub gap

Measured:

| Case | Result |
|---|---|
| The guard hook (`hook-cli.ts`) against a closed port | Deny and exit 2 after 0.08 s: "Mission Control's guard is unreachable; nothing runs until it is back." |
| The hook against the preview hub, with a token the hub did not issue | `401`; the hook denied with exit 2 |
| An HTTP MCP server stopped mid-session | The CLI failed the call at once. The model got `ECONNREFUSED: Unable to connect. Is the computer able to access the url?`, and nothing retried |
| The server started again | The next call in the same session reached the new server, with no respawn |

The MCP server in the probe was a stand-in shaped like the hub's `/mcp`: stateless JSON-RPC over
POST, 405 on GET, no session id (`apps/server/src/mcp/server.ts`). So the reconnect result holds for
the hub too.

From the code:

- **The hook has time to retry.** Its own deadline is 620 s (`HOOK_DEADLINE_MS`,
  `packages/core/src/guard.ts` 82), inside the CLI's 630 s hook timeout. It can retry a refused
  connection for 60 s and still fail closed in time. Retry only on connection errors (refused,
  reset, hang-up), never on an HTTP answer: a 401 stays a deny.
- **A hook waiting for the test lock** holds its request open. A restart cuts that request, which
  today is a deny. With the retry, the hook reconnects to the new hub and waits again, once the lock
  holds survive (§2.2).
- **MCP needs no proxy.** The CLI doesn't retry, and the hub can't change the CLI. The gap is short
  (3.54 s at most in the live log), the error reaches the model, and the next call works. The seat's
  brief tells it what to do: an mc tool that answers `ECONNREFUSED` means Mission Control is
  restarting, so wait 10 s and call again. Update must also let in-flight `/mcp` calls finish before
  the hub exits, within its existing time limit.

## 4. Swapping the CLI under a running seat

Not run against the real cask, which had no newer version and would have swapped the CLI under the
live seats. The test used copies instead:

1. copy `claude` 2.1.308 to A, and link L to A;
2. start a stream-json session through L;
3. mid-turn, copy A to B, point L at B, and delete A.

| Check | Result |
|---|---|
| The running session | Finished its turn on the deleted binary. It then ran a second turn that used the Grep tool, and was still alive |
| The next spawn through L | Ran: `2.1.308 (Claude Code)`, from B, the only file L could reach |

From Homebrew 7.0.10's source (`cask/upgrade.rb`, `cask/installer.rb`), `brew upgrade --cask` works
in this order:

1. removes the old version's artifacts, including the `bin/claude` link;
2. renames `Caskroom/claude-code/<old>` to `<old>.upgrading`;
3. installs and links the new version;
4. deletes the old folder in `finalize_upgrade`.

So the upgrade itself deletes the old binary, not `brew cleanup`. A running seat survives that, as
measured above. Between steps 1 and 3 there is no `claude` on `PATH`. A seat spawned in that window
fails with "could not start the CLI" (`session.ts` 160).

## Design

- **A keeper per seat.** The supervisor starts each seat through a keeper: `crew.node` runs a keeper
  entry from the hub's checkout, spawned `detached`, with a 0700 folder per run under the data
  folder's `crew/`. The keeper spawns `claude` with today's argv, env and working folder. It owns the
  CLI's stdio and writes the transcript, numbering stdout lines. It keeps the last stderr line,
  writes an exit file, and serves the socket.
- **The same session interface.** The session driver talks to the socket instead of the child's
  pipes. `CrewSession` (send, control, close, events) stays the interface. The supervisor changes
  only where attaching differs from resuming (§2.10).
- **Shutdown leaves seats running.** `stopAll` closes the sockets and leaves the keepers running.
  Stop and End still end stdin, through the keeper.
- **Start reattaches.** Before the server listens, the hub adopts each active run's token from the
  run's file and restores the stored lock holds (§2.9). Then, for each active run:
  - when its keeper answers with a known protocol version, the hub attaches, not as a resume, and
    replays from the last line it acted on;
  - when the keeper has exited and left its exit file, the hub records the end;
  - with no keeper (after a reboot, for example), today's `--resume` applies;
  - with a keeper of an unknown version, the hub ends it, waits for its exit, then resumes.

  A run that is not attached loses its adopted token and lock holds.
- **The guard hook waits.** It retries refused connections for 60 s, then denies.
- **Update stops waiting.** It drops the mid-turn refusal, keeps the refusal for a seat that is still
  starting, and lets in-flight `/mcp` calls finish before it exits.
- **The CLI.** Running seats need nothing. Seat spawns wait while the hub's own `brew upgrade` runs.

Rejected: keeping `--resume` and waiting for quiet moments. A turn can be a whole implementation, and
the operator's rule is that updates never wait for an idle crew and never interrupt a run.

## Follow-ups

Each is in `area:server`, and the keeper work touches hard-rule files
(`apps/server/src/runtime/**`, `apps/server/src/guard/**`, `apps/server/src/mcp/**`).

- **#146: the guard hook waits out a hub restart.** It retries a refused or reset connection for up
  to 60 s, then denies as today. Independent; worth having before the keeper, since Update cuts the
  hook today.
- **#147: run tokens and test-lock holds survive a hub restart.** A prerequisite for reattaching.
- **#97, rewritten from this design.** The keeper, reattach on start, and Update never stopping a
  seat. Depends on #146 and #147.
- **#95** (`updates.cli`) needs no follow-up: as merged, it holds new starts and resumes from the
  start of `brew upgrade` until the smoke test passes, which covers the window with no link (§4).
- **#96** is unchanged. Once #97 lands, Update no longer refuses mid-turn, so automatic updates no
  longer wait for a quiet moment.
