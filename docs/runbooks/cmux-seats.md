# Claude seats in cmux

Every Claude seat's run is a cmux workspace on the run's worktree. You can see it, type into it and
clear it; cmux rings when the seat finishes a turn or needs you. The hub still deals the tickets,
reads the results and moves the PRs. Codex seats are unchanged: they keep their keeper.

## The one setting

cmux must let Mission Control control it. In `~/.config/cmux/cmux.json` (this Mac only):

```json
{ "automation": { "socketControlMode": "automation" } }
```

Without it every Claude start is refused with: `cmux refuses Mission Control: set "automation":
{ "socketControlMode": "automation" } in ~/.config/cmux/cmux.json`. If cmux is not running, the hub
opens it (in the background) and waits up to 10 s; if it still is not up the start says
`cmux is not running and could not be started`. FLIGHT is a Claude seat, so with cmux down no Claude
seat starts, FLIGHT included.

## What each run is

- One workspace per run, named `<seat> · <ticket>` (`PR n` for a review, the role for FLIGHT), opened
  on the run's worktree.
- It runs `claude` by name from a launcher script in the run's folder, so cmux's shim wraps it with
  its hooks. The hub's own `--settings`, `--mcp-config`, `--strict-mcp-config`, `--restricted`, tool
  lists and role prompt are kept; your own plugins are not loaded.
- The hub sends the first brief and later messages as text. A long one is written to a file under
  the seat's temp root and the seat is told to read it.

## What you can do in a workspace

- **Read it** and **type into it.** What you type is a turn of its own; the seat shows Running, then
  Idle. The run stays open.
- **`/clear` it.** The run keeps going on the new session id. The seat is not re-briefed.
- **Answer it.** When the seat asks a question or a permission, the Agents page shows Waiting with
  "Needs your input in cmux" and cmux rings. A tool outside the seat's allowlist now asks you
  instead of being refused.
- **Close it.** Ends the process; the hub treats it like any other exit.

Do not restart the agent from cmux's own restore: a restored agent has no hub settings, so the hub
closes it and resumes the run with its own command.

## Seat state

| cmux | Agents page |
| --- | --- |
| `running` | Running |
| `needsInput` | Waiting, "Needs your input in cmux" |
| `idle` | Idle |

## Limits

- No per-run dollar cap: `--max-budget-usd` is print mode only. Token counts are still read.
- Context usage and the usage control are not available; the seat's context figure stays unknown.
- Stop, Interrupt and Resume work: Interrupt sends Escape into the workspace.

## After a hub restart

The hub attaches to a run's workspace if its Claude process is still the one it started. Otherwise
it closes the workspace and resumes the run in a new one.
