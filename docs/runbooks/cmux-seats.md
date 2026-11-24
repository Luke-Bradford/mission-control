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
- **Permission prompts answer themselves.** A tool outside the seat's allowlist opens Claude's
  permission dialog; the hub refuses it at once (Escape), as print mode refused the tool, so no seat
  waits for you on one. The seat carries on with its turn.
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

## Limits

- No per-run dollar cap: `--max-budget-usd` is print mode only. Token counts are still read.
- The seat's context use is read from Claude's own transcript (input, cache read and cache written
  of its last top-level reply), so FLIGHT's fresh session past its context limit still happens. The
  usage control (`get_usage`) is not available.
- Stop, Interrupt and Resume work: Interrupt sends Escape into the workspace.

## After a hub restart

The hub attaches to a run's workspace if its Claude process is still the one it started. Otherwise
it closes the workspace and resumes the run in a new one.
