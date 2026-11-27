# cmux sessions

The hub lists every cmux workspace on this Mac: the operator's own and the crew's. It reads them
from cmux, with no agent and no tokens. It can bring one to the front and write to one. It never
closes one.

## The Sessions page

The page reads `GET /api/sessions`. Each row is one workspace:

- **Session:** its name. "Crew" when the name starts with a configured seat id and ` · `;
  otherwise "Yours".
- **Folder and repo:** the agent's folder, else the workspace's. The repo is the nearest `.git`
  above it; a worktree names its main checkout. No git command runs.
- **State:** from `cmux sessions --agent claude`: running is Working, idle is Idle, needsInput
  is Waiting on you, no record is No agent.
- **For:** how long this hub has seen it in that state. On first sight, the transcript's last
  change; for a shell, the moment the hub first saw it.
- **Last line:** the agent's last words from its transcript (only `.jsonl` files under
  `~/.claude/projects/`), else the screen's last line. Cut to 300 characters.
- **Status:** any `cmux set-status <key> <text>` other than `app`.
- **App:** `cmux set-status app <url>`. The hub checks only `localhost`, `127.0.0.1` and
  `[::1]`: one GET, 2 s timeout, no redirects. Any HTTP answer counts. Other hosts are never
  requested.
- **Inbox:** unread `cmux agent inbox` messages and the newest one.
- **Checks:** the session's latest repo check (see [Repo checks](#repo-checks)): Queued,
  Running, Passed, Failed, Timed out or Stopped. Its title is the command and the time.

One read is shared for 2 s. The actions:

- `POST /api/sessions/:id/focus` selects the workspace and brings cmux to the front.
- `POST /api/sessions/:id/send` with `{ text }` pastes the text and presses Enter. A session
  with a question open answers 409; answer it in cmux first.
- `POST /api/sessions/:id/app` opens the session's app in a browser pane of its own workspace.

Every route needs the operator token. A seat's token gets 403. A hub without cmux answers 503.

## Crew app panes

Each live crew seat runs its configured development app in terminal panes of its own cmux workspace,
from that seat's worktree. `app_commands` names one command per pane. The hub reserves a distinct
loopback port block for each running seat, passes `PORT` and repository-specific variables such as
`BACKEND_PORT`, and sets the first URL as the workspace `app` status. It never starts eBull's
launchd-owned jobs process.

A writer seat uses `app_start`, `app_restart` and `app_status` to start its panes, restart after a
code change, and read the last lines from every app pane. `terminal_run` runs a one-off terminal
command from that same worktree. The Sessions page lists each seat app, its address and its current
loopback reachability, and provides Start and Stop.

The hub probes app URLs each minute. A stopped app restarts no more than once every five minutes;
the restart is logged. It stops and closes every app pane when the seat's run ends, then releases
that seat's port block. Preview hubs never start or restart crew apps.

## Opening a session

The New session button reads `GET /api/sessions/roles`: `{ roles, folders }`, the `roles/*.md`
files but the README, and the open sessions' distinct folders. It opens one with
`POST /api/sessions` and `{ folder, worktree, role, message, name? }`, which answers 201
`{ id, name }`. FLIGHT's `cmux_open` takes the same input, in on-call mode only and with
`asked_by` naming the operator's message. What the session runs, its name and its worktree are in
the main runbook (`docs/runbook.md`, FLIGHT mode, "Opening a session").

## Repo checks

The hub runs a repo's checks when an operator session there finishes a piece of work. No agent
runs them and no tokens are spent.

- **Switch:** one per repo, in the Repo checks list under the table. Only a repo with a session
  of the operator's open is listed. A repo that is not switched on never runs a check by itself.
  Each switch adds a hub event: `Checks turned on for repo "<name>" by operator` (or `off`).
  `POST /api/sessions/checks` with `{ repo, on?, commands? }` sets it. `repo` is the main
  checkout's path; an unknown one gets 404.
- **Which checks:** the first that names any. The repo's own Mission Control block at
  `origin/HEAD`, never the working copy. Else the hub config's `rules.checks` for the repo whose
  `github` matches its origin. Else the list set on the page: at most 10 commands of at most 200
  characters, each one plain command (no `&&`, `|`, `;` or line break). The list is read again
  after 60 s.
- **When:** the hub reads cmux every 3 s while a repo is on or a check is live. A session that
  goes from working to idle with changed files since its last check queues one. Changed means
  HEAD, `git status` or a changed file's size or time differs. A session that starts working
  again stops its check, with no message. Crew seats never run here: their push gate runs checks.
  Neither does a checkout inside the crew's worktrees, its session checkouts or the hub's data
  folder.
- **How:** one check at a time on the Mac, in its checkout, at low priority
  (`/usr/sbin/taskpolicy -b` on macOS, `nice -n 19` elsewhere). A check waits while the 1-minute
  load is at or above the core count. Commands run in order and stop at the first failure.
  Each is stopped after 15 minutes. The environment has no `MC_*` variable.
- **A failure:** the session gets one `cmux agent message` from "Mission Control" with the
  command, its exit code and its last 40 lines. The operator gets one `checks` notice
  (Settings → Access, on by default), and there is a hub event:
  `Checks failed in cmux session "<name>": <command>` (or `Checks timed out in …`).
- **Run checks:** the row's button, `POST /api/sessions/:id/checks` with `{}`. It runs whether or
  not the switch is on and whatever changed. A crew row, or a repo with no checks, answers 400.
- A preview hub (`MC_NO_LOOP_WRITES=1`) never runs a check by itself.

The controller's live check runs a repo's checks the way the hub does and samples the load every
2 s. It exits 1 if the peak reaches the core count. Given a workspace id, it also sends that
session a 40-line message, to show how one arrives:

```sh
~/.local/mc-node/<version>/bin/node --experimental-strip-types apps/server/test/live/cmux-checks-live-check.ts <repo> [<workspace id>] [-- <command>...]
```

Before merge, the controller also runs two cmux sessions in one switched-on repo on the Mac. Both
edit a file and go idle, and their checks run one after the other.

## Who may write

The page writes only when the operator acts. FLIGHT writes with `cmux_send` only when it names
the operator's own Comms message to it from the last 24 hours. Each write adds a hub event:
`Wrote to cmux session "<name>" (<n> characters), asked by <operator | FLIGHT for comms:N>`.
The text itself is never logged. Screen text FLIGHT reads with `cmux_sessions` goes to its
model provider; the hub sends nothing else off this Mac.

## The cmux sidebar

The hub follows `cmux events` as well as its three-second read, so workspace opens and closes
refresh Sessions without waiting for the next poll. It reads a workspace branch directly from
`.git/HEAD`, then shows an open pull request, CI and review state when it can identify one.

The Sessions switch `Write to cmux` controls all hub-owned sidebar fields and notifications. When
on, the hub writes only `mc-ci`, `mc-review`, `mc-cost` and `mc-check`, and links the workspace's
pull request with `cmux pr`. It never changes another status key. Turning the switch off prevents
all sidebar writes and cmux notifications; reading and tracking continue.

## Apps that stop

Every 30 s, and on each page read, the hub reads the sessions. When a session's app stops
answering, the hub sends that session one `cmux agent message` from "Mission Control". It sends
one more when the app answers again. cmux delivers these through the agent's hooks, not by
typing. A preview hub (`MC_NO_LOOP_WRITES=1`) never sends them.

## Live check

No seat can run cmux in its sandbox. Before a change to `apps/server/src/runtime/cmux*.ts`
merges, the operator or the controller runs this on the Mac that runs the hub:

```sh
cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-sessions-live-check.ts
```

It opens a shell workspace, lists it as "Yours" with no agent, writes a marker to it and reads it
back, checks an app on a free port reads as not answering, and closes it with the cmux command.
It prints the raw `list-status`, `list-workspaces`, `sessions` and `agent inbox` output. Compare
that with `apps/server/test/fixtures/fake-cmux.mjs` and fix the fake where they differ.
