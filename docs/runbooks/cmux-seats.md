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
  its hooks. The launcher keeps cmux's shim folder first on PATH, ahead of the hub's node folder
  (which may hold its own `claude`). The hub's own `--settings`, `--mcp-config`, `--strict-mcp-config`, `--restricted`, tool
  lists and role prompt are kept; your own plugins are not loaded.
- On a new worktree Claude first asks whether to trust the folder, with the cursor on "No, exit".
  The hub moves the cursor to "Yes, I trust this folder" and presses Enter only once the screen
  shows it there. If Claude quits before it starts (at that prompt or otherwise), the hub sends no
  more keys, closes the workspace and the start fails with `Claude quit at its folder-trust prompt`
  or `Claude quit before it started`.
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

## Limits

- No per-run dollar cap: `--max-budget-usd` is print mode only. Token counts are still read.
- The seat's context use is read from Claude's own transcript (input, cache read and cache written
  of its last top-level reply), so FLIGHT's fresh session past its context limit still happens. The
  usage control (`get_usage`) is not available.
- Stop, Interrupt and Resume work: Interrupt sends Escape into the workspace.

## After a hub restart

The hub attaches to a run's workspace if its Claude process is still the one it started. Otherwise
it closes the workspace and resumes the run in a new one. If that Claude process is gone and cmux is
down (after a reboot, say), the hub forgets the workspace and resumes the run on the keeper.

## The live check

The unit tests run against a fake cmux, which cannot show what real cmux and real Claude print. Before
any change to `apps/server/src/runtime/cmux*.ts` merges, run on the Mac that runs the hub:

```
cd apps/server && node --experimental-strip-types scripts/cmux-live-check.ts
```

It opens one workspace on a brand-new folder and passes only if the hub answers Claude's folder-trust
prompt, sees the session, gets a turn's result, refuses a permission dialog itself and closes the
workspace. On 24 November 2026 the change had passed nine reviews and failed this four ways: the trust
menu's cursor opens on "No, exit" and its lines have no numbers; real cmux names a session's state
`agent_lifecycle`; and Claude 2.1.331's permission dialog ends in a bare "No".
