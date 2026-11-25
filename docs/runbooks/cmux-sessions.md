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

One read is shared for 2 s. The actions:

- `POST /api/sessions/:id/focus` selects the workspace and brings cmux to the front.
- `POST /api/sessions/:id/send` with `{ text }` pastes the text and presses Enter. A session
  with a question open answers 409; answer it in cmux first.
- `POST /api/sessions/:id/app` opens the session's app in a browser pane of its own workspace.

Every route needs the operator token. A seat's token gets 403. A hub without cmux answers 503.

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
