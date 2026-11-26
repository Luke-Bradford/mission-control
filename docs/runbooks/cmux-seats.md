# Claude seats in cmux

Every Claude seat's run is a cmux workspace on the run's worktree. You can see it, type into it and
clear it; cmux rings when the seat finishes a turn or needs you. The hub still deals the tickets,
reads the results and moves the PRs. Codex seats are unchanged: they keep their keeper.

## The one setting

cmux must let Mission Control control it. In `~/.config/cmux/cmux.json` (this Mac only):

```json
{ "automation": { "socketControlMode": "automation" } }
```

If cmux is not running, the hub opens it (in the background) and waits up to 10 s. When cmux refuses
the hub (the setting is missing) or will not start, no seat waits on it: the run starts on the old
keeper (`claude -p`) instead, FLIGHT included, and the hub logs why
(`cmux refuses Mission Control: set "automation": { "socketControlMode": "automation" } in
~/.config/cmux/cmux.json`, or `cmux is not running and could not be started`). That run stays on the
keeper until it ends; the next start tries cmux again. A start is refused only when a run's earlier
Claude in cmux still runs and cmux will not answer, so two CLIs never run one session.

The same goes for a start that cmux takes but that never comes up: the workspace cannot be found,
Claude is not up within 60 s, or Claude quits first (at its folder-trust prompt, say). The hub
closes the workspace, stops the Claude its launcher ran (by the pid the launcher wrote: SIGTERM,
then SIGKILL), removes the launcher and FLIGHT's secret environment file (a launcher cmux
runs late then starts nothing), and the run goes on under the keeper with the brief and any message cmux's Claude
never got. If Claude has already written to its session, the keeper resumes it. Only a Claude that
will not stop ends the run instead, so two Claudes never work one worktree.

## What each run is

- One workspace per run, named `<seat> · <ticket>` (`PR n` for a review, the role for FLIGHT), opened
  on the run's worktree.
- It runs `claude` by name from a launcher script in the run's folder, so cmux's shim wraps it with
  its hooks. The launcher keeps cmux's shim folder first on PATH, ahead of the hub's node folder
  (which may hold its own `claude`). The hub's own `--settings`, `--mcp-config`, `--strict-mcp-config`, `--restricted`, tool
  lists and role prompt are kept; your own plugins are not loaded.
- On a new worktree Claude first asks whether to trust the folder, with the cursor on "No, exit".
  The hub moves the cursor to "Yes, I trust this folder" and presses Enter only once the screen
  shows it there. If Claude quits before it starts (at that prompt or otherwise), the hub sends no
  more keys, closes the workspace and the start fails with `Claude quit at its folder-trust prompt`
  or `Claude quit before it started`.
- The hub takes Claude as up when cmux has a record of its session, or, with no record, when the
  process the launcher started is alive and its screen shows Claude's prompt (or Claude has written
  its transcript since the start). cmux keeps no record of some sessions, and nobody has found why
  (25 November: some seat starts had one, some did not), so the hub never waits on one.
- The hub sends the first brief and later messages as text. A long one is written to a file under
  the seat's temp root and the seat is told to read it.

## What you can do in a workspace

- **Read it** and **type into it.** What you type is a turn of its own; the seat shows Running, then
  Idle. The run stays open.
- **`/clear` it.** The run keeps going on the new session id. The seat is not re-briefed.
- **Permission prompts answer themselves.** A tool outside the seat's allowlist opens Claude's
  permission dialog; the hub refuses it at once (Escape), so no seat waits for you on one. Escape
  makes Claude stop and wait, so the hub then tells the seat that the tool was refused and to carry
  on without it or report that it is blocked.
- **Answer it.** Any other dialog (a question for you) shows on the Agents page as Waiting with
  "Needs your input in cmux", and cmux rings.
- **Close it.** Ends the process; the hub treats it like any other exit.

Do not restart the agent from cmux's own restore: a restored agent has no hub settings, so the hub
closes it and resumes the run with its own command.

## Seat state

| cmux | Agents page |
| --- | --- |
| `running` | Running |
| `needsInput` | Waiting, "Needs your input in cmux" |
| `idle` | Idle |

With no cmux record, the hub reads the state itself, each second: a dialog with numbered options
and "Esc to cancel" is Waiting; Claude's spinner ("esc to interrupt") is Running, as is a message
sent or a turn Claude's transcript left open in the last 10 s; anything else is Idle. The run ends
when Claude's process ends or the workspace closes. An operator's `/clear` with no record is found
by its new transcript: in the same project folder as the session being read, begun since the start,
and whose own lines name this worktree and the new session. The hub reads it from its start and the
run and the seat take the new session id.

## Limits

- No per-run dollar cap in cmux: `--max-budget-usd` is print mode only. Token counts are still
  read. A run that falls back to the keeper has its cap again.
- The seat's context use is read from Claude's own transcript (input, cache read and cache written
  of its last top-level reply), so FLIGHT's fresh session past its context limit still happens. The
  usage control (`get_usage`) is not available.
- Stop, Interrupt and Resume work: Interrupt sends Escape into the workspace.

## After a hub restart

The hub attaches to a run's workspace if its Claude process is still the one it started, and the
workspace is still open (by cmux's record, or by cmux's list of workspaces when it keeps none). Otherwise
it closes the workspace and resumes the run in a new one. If that Claude process is gone and cmux is
down (after a reboot, say), the hub forgets the workspace and resumes the run on the keeper.

## The live checks

The unit tests run against a fake cmux and screens typed into the tests, which cannot show what real
cmux and real Claude print. Before any change to `apps/server/src/runtime/cmux*.ts` merges, run both
on the Mac that runs the hub, with the hub's own node (the launcher puts that node's folder on PATH,
so the `claude` beside it is the one checked):

```
cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-seat-live-check.ts
cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-live-check.ts
```

`cmux-seat-live-check.ts` starts Claude as the hub starts a build seat: its arguments come from
`crewCliArgs`, with the seat's sandbox, settings, tool lists and `--restricted`. (On 25 November a
check that started Claude without them passed while every real seat start failed.) No hub runs
there, so the guard hook is a stand-in that allows every tool, and the MCP config names no server.
It passes only if the hub sees Claude up, a turn's reply reaches the run's transcript, a tool outside
the seat's allowlist does not run and the seat never shows as waiting on a person, and the workspace
closes. It also says whether cmux kept a record of the session. `cmux-live-check.ts` checks the cmux
wrapper alone. No seat can run either: its sandbox has no cmux. Whoever merges a cmux change runs
them, and then starts one real seat from the hub and watches it.
