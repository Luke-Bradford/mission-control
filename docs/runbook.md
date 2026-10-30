# Mission Control runbook

Mission Control is a local hub that watches the autonomous loops on this Mac. It reads their state
files, transcripts, usage limits and GitHub boards, and shows them in one web app, the HUD. In
phase 1 it **observes only**. Its one write into a loop's files is the TA loop's `PAUSE` sentinel,
which it writes only when you press pause or resume.

- Design: [`docs/superpowers/specs/2026-10-18-mission-control-design.md`](superpowers/specs/2026-10-18-mission-control-design.md)
- The HUD it builds: [`docs/prototype/mission-control-hud.html`](prototype/mission-control-hud.html),
  catalogued in [`docs/prototype/mission-control-hud-catalogue.md`](prototype/mission-control-hud-catalogue.md)

## Install

Requires Node 25 or later and pnpm. Run these from the repo root:

```sh
pnpm install
pnpm build          # builds apps/web into apps/web/dist; the server serves it
```

The server also needs `gh` logged in with the `project` and `repo` scopes for boards and
escalations, and `codex` on `PATH` for Codex usage. It reads the Claude OAuth token from the
login Keychain, the same way the loops' `claude_usage.py` does.

Codex crew seats need `codex` 0.154.0 or newer and the account's `~/.codex/auth.json`.
Set the seat's `account_id` to its Codex account and `model` to a model advertised by
`model/list` (for example `gpt-6-astra`). After HTTP and the Claude crew start, the hub
reads the catalog in the background. An explicit `effort` must be advertised by
that model, including any `light_model`; omit it to use the model's default.
Until validation succeeds, the seat reports `unavailable: <reason>` and cannot
start or resume. Discovery failures retry every minute, without a hub restart;
Claude seats and HTTP remain available. A successful catalog is cached for config
edits and reloads. Config writes refuse unvalidated Codex models and efforts with
400. Existing Claude model identifiers and effort options keep loading.

`updates.cli` remains Claude-only. It does not update Codex; Codex seats keep the
binary they started on. Update Codex manually between runs. Resuming a run uses
the run's saved model.

### Update

The Setup toolbar reads `Version <sha> · <n> commits behind main · checked <when>`, then
**Check for updates** and **Update**. `<sha>` is the commit the hub started on (the code running),
and the count is from there to `origin/main`. When the count cannot be read the text says
`· could not compare with main` instead. The hub fetches `origin main` at most every 10 minutes on
its own (when Setup opens). **Check for updates** fetches now (at most every 15 s; a press inside
that reuses the last attempt), shares a fetch already running, and never fetches on a preview or a
server with no updater, where it is disabled with the reason as its tooltip. Its toasts:

- `Up to date with main.`: nothing new, and the hub runs the commit it started on.
- `<n> commits behind main.`: Update is enabled unless one of the refusals below applies.
- `No new commits on main.`: nothing behind, but not "up to date": a failed update already pulled
  and Update stays enabled to finish it, or a refusal below applies.
- `Could not compare with main.`: the commits could not be counted.
- `Could not reach origin; last checked 4 min ago.` (or `no earlier check`): the fetch failed, or
  failed on the last attempt inside the 15 s floor (an ISO time before the timezone loads). The
  server answers 502 with `checkedAt` beside its error text, and the toolbar keeps its last
  numbers; the answer is never taken from a stale `origin/main`.

**Update** is enabled when `main` is ahead, or a failed update is waiting to finish (and no
refusal below applies). After you confirm, the hub runs, in its own checkout:

1. `git pull --ff-only origin main`
2. `pnpm install --frozen-lockfile`
3. `pnpm --filter @mc/web build` into `apps/web/dist-next`, beside the live `dist`
4. a swap: `dist` → `dist-prev`, `dist-next` → `dist`, then `dist-prev` is removed

Then it stops its crew and exits; launchd's `KeepAlive` starts it again (within the 30 s
`ThrottleInterval`), crew runs resume, and the HUD reconnects. Each command's output goes to
`update.log` beside the database (mode 0600), rewritten by each update. A failed step answers
`update failed at <step>; see update.log`: the hub keeps running and the old `dist` keeps serving,
and Setup opens the log (credentials redacted; paths and command output shown as they are) so
the failed command's output is on the page. A refusal after the log started (a seat starting, a
change held for a person) adds a `held: <reason>` line and opens the log too. A refusal before
it (another update running, uncommitted changes) only toasts, since the log would be the previous
update's. **Update log** beside the button shows the last update's log at any time.

An update that failed after its pull is not "up to date": pressing Update again skips the pull
(unless `main` has moved on since) and installs, builds, swaps and restarts.

Do not give a scripted Update a short client timeout. The build can take several minutes; leave
the request connected until it answers, then allow the hub to reconnect. If a caller disconnects,
the completed update still restarts the hub.

The button is disabled, with the reason as its tooltip, on a preview server (any port but 7420, or
`MC_NO_LOOP_WRITES=1`), when the checkout is not on `main`, when it has uncommitted changes
(untracked files included), and while a crew seat is mid-turn or starting. With nothing new on
`origin/main` it is disabled with `Up to date with main.`; those refusals take priority. If a
press still finds nothing new, it toasts `Up to date with main.` and restarts nothing.

The first deploy of this version uses the manual commands below: the hub running before it has no
Update button. They are also the fallback whenever the button cannot be used, from the repo root:

```sh
git pull --ff-only origin main
pnpm install        # first: dependencies change
pnpm build
launchctl kickstart -k gui/$(id -u)/com.missioncontrol.server   # if it runs under launchd
```

#### Update fails at install every time

If every Update fails at `install` with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, pnpm wants to
rebuild `node_modules` and can't ask without a terminal. A hub started before #876 (merged 29 Oct
2026) points pnpm at the crew's store and hits this every time, so it can never install the fix.
From a terminal, in the hub's checkout:

1. Stop the hub: `launchctl bootout gui/$(id -u)/com.missioncontrol.server` (with it running,
   launchd's `KeepAlive` restarts it during the install).
2. `git pull --ff-only origin main`
3. `pnpm install --frozen-lockfile`, and answer yes when pnpm asks to remove `node_modules`.
4. `pnpm --filter @mc/web build`
5. Start the hub: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.missioncontrol.server.plist`.

Check `/api/version` shows the new sha.

## Configure

```sh
mkdir -p -m 0700 ~/.config/mission-control
cp config.example.yaml ~/.config/mission-control/config.yaml
chmod 0600 ~/.config/mission-control/config.yaml
```

### Sign-in

There is none: the hub listens on loopback only. A `password_hash` left in an old config is
ignored.

`state_dir` and `logs_dir` under `loops:` must exist. A missing one shows as a `source missing`
error in health, not as a crash. A missing `worktree` is not an error: the in-flight run's
branch (and so its ticket) is just null. For the studio loop it also means no live session can
match, so an open fire shows as `unknown` (see "Loop liveness" below).

The config is rejected at start-up if an id repeats within `accounts`, `repos` or `loops`, or if
two accounts share a vendor: the usage readers use this Mac's single Claude login (Keychain
OAuth) and single Codex login, so a second account would report the first one's usage.

## Template profiles

A profile is one template (feature, bugfix, small-change, research, review) kept in your user config, not in the repo. Each sets the steps shown, a checklist that goes into the brief, whether a plan is required at Size M or larger, the reviewer role and depth, the CI checks to name, and the CI try and review round limits. With no `profiles.yaml` the five built-ins apply. A file replaces them whole (no merge), and must keep profiles named `small-change` and `feature`, the Size fallbacks.

```yaml
profiles:
  - name: small-change          # lowercase, up to 32 letters, digits and -
    labels: [chore, test, docs] # card labels that pick it; the first profile in file order wins
    steps:                      # shown on the run; phase ties a step to working, ci or review
      - { name: implement, phase: working }
      - { name: verify, phase: ci }
      - { name: review, phase: review }
    checklist: |                # briefed as "Before you report, check:" (at most 4000 characters)
      - Only the paths this ticket type allows changed
    plan_required: false
    reviewer: { role: RETRO, depth: light }   # full runs the review on opus
    checks: []                  # CI checks named in the brief
    tries: 2                    # CI failures before the run parks (1 to 10)
    rounds: 2                   # blocking reviews before the run parks (1 to 10)
```

- **Routing.** The first profile with a label the ticket has wins. With none, Size XS or S takes `small-change`; anything else, or no Size, takes `feature`. FLIGHT (`start_seat`) and the planner (`report_plan`) may name another profile with `profile` and `profile_reason`; the choice is kept per ticket with its reason, and the profile keeps every check the routed one required.
- **Snapshot.** Each build or planner start copies the chosen profile, with a sha256 hash, onto its run. Editing the file changes later starts only. The file is read afresh on every start.
- **A file that cannot be loaded** refuses starts (502, or FLIGHT's refusal text) naming the problem; the hub keeps running. Fix the file and the next start works.
- **Limits.** The `tries` and `rounds` of the snapshot replace the defaults (3 and 3). The engine still judges the PR's combined CI; `checks` is briefed, not enforced one by one.
- **Seen.** The crew row's loop carries the profile name and the step for the run's phase.

## Moving from Control Centre

The project was renamed Mission Control on 2026-10-18. An install made under the old name moves
across once; the loops are not affected.

```sh
launchctl bootout gui/$(id -u)/com.controlcentre.server
mv ~/.config/control-centre ~/.config/mission-control
mv ~/.local/share/control-centre ~/.local/share/mission-control
mv ~/.local/share/mission-control/cc.sqlite ~/.local/share/mission-control/mc.sqlite
for f in cc.sqlite-wal cc.sqlite-shm; do
  [ -f ~/.local/share/mission-control/$f ] && mv ~/.local/share/mission-control/$f ~/.local/share/mission-control/mc${f#cc}
done
mv ~/Library/Logs/control-centre ~/Library/Logs/mission-control
rm ~/Library/LaunchAgents/com.controlcentre.server.plist
```

Then install the LaunchAgent from `ops/com.missioncontrol.server.plist.tmpl` as below. Environment
variables are now `MC_CONFIG`, `MC_DB` and `MC_PORT` (plus `MC_NO_LOOP_WRITES` for previews).

## Where things live

| What | Path |
|---|---|
| Config | `~/.config/mission-control/config.yaml` (override with `MC_CONFIG`) |
| Config backups | `config.yaml.bak-<UTC time>` beside `config.yaml`: one written on every write the server makes to `config.yaml` (a repo added from Setup › Repos, or a session's seats replaced), the newest 10 kept, mode 0600 |
| Template profiles | `profiles.yaml` beside `config.yaml` (optional; you create it, the hub never writes it); see [Template profiles](#template-profiles) |
| Database (SQLite, WAL) | `~/.local/share/mission-control/mc.sqlite` (override with `MC_DB`; its directory is created 0700) |
| Web build | `apps/web/dist` (run `pnpm install` then `pnpm build` again after web changes, then restart the server); Update builds into `apps/web/dist-next` and swaps it in |
| Update log | `update.log` beside the database: the last update's commands and output, mode 0600; Setup → **Update log** shows its end |
| launchd logs | `~/Library/Logs/mission-control/server.log`, `server.err.log` |

The server never writes a `config.yaml` that is a symbolic link: it refuses the write and says so, so keep the real file at the config path (`~/.config/mission-control/config.yaml`, or `MC_CONFIG`), not a link to it.

## Run

```sh
pnpm --filter @mc/server start      # http://127.0.0.1:7420/
```

The server binds `127.0.0.1` only, on port 7420; `MC_PORT` (1024–65535) runs a second one beside
it, e.g. a preview of a branch on a copy of the database and the config. From the branch's checkout:

```sh
sqlite3 ~/.local/share/mission-control/mc.sqlite ".backup /tmp/mc-preview.sqlite"
cp ~/.config/mission-control/config.yaml /tmp/mc-preview-config.yaml
pnpm build
MC_PORT=7431 MC_DB=/tmp/mc-preview.sqlite MC_CONFIG=/tmp/mc-preview-config.yaml MC_NO_LOOP_WRITES=1 \
  MC_NO_CREW=1 node --experimental-strip-types apps/server/src/main.ts      # http://127.0.0.1:7431/
```

`MC_NO_LOOP_WRITES=1` makes Pause/Resume answer 409 before touching any loop file, so a preview
never writes into a live loop. A preview (any port but 7420, or `MC_NO_LOOP_WRITES=1`) runs no
crew: it starts and resumes no crew run (its database copy holds the live hub's runs), and crew
actions answer 409 `crew is disabled on this server`. `MC_NO_CREW=1` in the command says so
again, and turns crew off on any server; only `MC_CREW=1` lets a preview run crew (it still needs
the crew lock). A preview also refuses Update. Acknowledgements and Away settings it saves go into
the copy, not the live database, and a repo added from Setup › Repos goes into the config copy
(with its backups beside it), not your `config.yaml`. Never stop or restart the live hub to test
something. Requests with any other `Host` are refused. `SIGINT` and `SIGTERM` shut it down
cleanly; if that takes over 10 seconds it logs a warning and exits anyway. For
web development, start a preview server as above, then run `pnpm --filter @mc/web dev`: its proxy
forwards `/api` to `http://127.0.0.1:$MC_PORT` (default 7431, the preview port) and refuses to
start with `MC_PORT=7420`, so the dev server can never post acks, away settings or a PAUSE into
the live hub's data.

The API is under `/api/*`. A POST must be `application/json` (415 otherwise) and, if it carries an
`Origin`, one on `localhost` or `127.0.0.1` (403 otherwise).

### As a launchd job (optional; nothing loads it for you)

`ops/com.missioncontrol.server.plist.tmpl` runs
`/opt/homebrew/bin/node --experimental-strip-types <repo>/apps/server/src/main.ts` directly (no
pnpm wrapper, so launchd's SIGTERM reaches the server and it shuts down cleanly), with
`KeepAlive`, logging to `~/Library/Logs/mission-control/`, with the repo as its working
directory. If node lives elsewhere, edit the first `ProgramArguments` entry and put its folder
first on the plist's `PATH` (see "Setting up another machine"). Update relies on
`KeepAlive` to start the hub again after it exits. Never set `CI` in the hub's launchd
environment: under CI, pnpm purges a mismatched `node_modules` without asking. The hub runs its
installs with `CI=false` and no other CI markers, but nothing else it starts should see `CI`
either.

```sh
mkdir -p ~/Library/Logs/mission-control
sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" ops/com.missioncontrol.server.plist.tmpl \
  > ~/Library/LaunchAgents/com.missioncontrol.server.plist
plutil -lint ~/Library/LaunchAgents/com.missioncontrol.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.missioncontrol.server.plist
# stop: launchctl bootout gui/$(id -u)/com.missioncontrol.server
```

### Log rotation and retention

Routine requests produce no request log lines. Responses with status 4xx or 5xx and requests
taking over one second produce a summary carrying the method and URL path (never the query
string; the operator token travels as a header). Every 5xx includes its error message and stack
through the existing redacting logger. Other hub warnings remain logged.

For a launchd hub, add this entry to `/etc/newsyslog.d/mission-control.conf`, replacing
`<home>` with the home directory and `<user>:<group>` with the hub's account and group.
Use absolute paths (newsyslog does not expand `~`). If `MC_DB` is set, the pid file is
`server.pid` beside that database instead.

```text
# logfilename                                  owner:group     mode count size when flags pid_file                                                signal
<home>/Library/Logs/mission-control/server.log  <user>:<group>  600  7     20480 @T00 B     <home>/.local/share/mission-control/server.pid           15
```

The system's newsyslog job rotates at 20 MB (the size column is in KB) or daily at midnight,
whichever comes first, and keeps seven archives. The
`B` flag avoids inserting plain text into the JSON log. Signal 15 requests the hub's existing
graceful shutdown; launchd's `KeepAlive` starts it again and reopens the new log. Rotation
therefore includes a hub restart and the crew's normal shutdown and resume. This entry requires
the launchd job; do not install it for a manually started hub. Check the expanded entry with
`sudo newsyslog -n -v` before enabling it. No rotation configuration is installed by the app.

### Map payload cache and polling

`/api/repos/:repoId/map` is built once and reused until something it shows changes: the default
branch's commit, the call ring's revision (deltas, aged-out calls, branch diff reads), the seats
(crew rows and test-lock state), the repo's PRs and board, or its rules or FLIGHT powers. Fields that age on their own
(context usage, ages) are refreshed at most every 15 seconds. The call ring polls only seats with a
live run (a finished run is read once more, then left), every second while a map client is
connected and every five seconds otherwise. After a hub restart each transcript is read from the
byte offset that covers the last `MAP_RECENT_MS` (15 minutes, scanning back at most 16 MB), not
from the start, so the first map request after an Update no longer re-reads whole transcripts.

The payload also carries what the Ownership and Conflicts lenses read: each seat's configured
`area` globs (empty when it has none), `prs` on each conflict (the open PR number of each branch,
in the order of `branches`, null when unknown), and `rules.hardRules` as the effective list the
engine enforces (on a `superuser` repo the repo's own list plus the defaults and FLIGHT floor).

The hourly maintenance sweep retains seat lines for seven days after their run ends, and
loop events and run evidence for 30 days after their run ends. Findings stay for 90 days
after both their review and author run end; test-lock holds and CI runs stay 90 days too
(see [QA board data](#qa-board-data)). Unfinished reviews, open runs, parked and
set-aside runs, unanswered questions, pending drafts and open attention notes protect
their associated rows. Deletions use transactions of at most 500 rows, yield between
batches and stop after 5,000 rows per sweep; later sweeps drain any backlog.
Rows exactly at the cutoff stay. Settled attention notes and episodes, board moves, guard hits,
hub events, answered questions, completed drafts, acknowledged crew errors and superseded briefs
also expire after 90 days. Runs, reviews and their child evidence, commits, pushes, attempts and
merged-PR history remain available to Activity and Telemetry for one year. Reported reviews and
unresolved findings remain while their PR snapshot is open. Deletion makes SQLite
pages reusable; it does not shrink the database file on disk.

## First crew

Mission Control runs its own Claude agents ("seats") only in a clone of its own, never in your
working checkout or a loop's. To set up the first one, a GUIDO seat on this repo:

1. Configure the repo first: Setup › Repos, with its GitHub Project (create one for
   `mission-control` or reuse one). A crew session's `repo_id` must be a configured repo, or the
   config is refused at start-up.
2. Clone it for the crew:

   ```sh
   git clone https://github.com/<your-login>/mission-control.git ~/code/mc-crew/mission-control
   ```

3. Give the clone its git identity, your GitHub noreply address. Seats cannot commit or run
   `git config` themselves; the mc commit tool makes each commit and sets its author and
   committer name to `<CALL> (Mission Control)`, e.g. `GUIDO-1 (Mission Control)`:

   ```sh
   git -C ~/code/mc-crew/mission-control config user.name "Your Name"
   git -C ~/code/mc-crew/mission-control config user.email "<your-id>+<your-login>@users.noreply.github.com"
   ```

4. Add a `crew` section to `config.yaml` (see `config.example.yaml`). `worktrees` and every
   `checkout` must lie outside the hub's checkout and every loop's paths:

   ```yaml
   crew:
     worktrees: ~/code/mc-crew/worktrees
     max_seats: 8
     sessions:
       - id: mission-control
         repo_id: mission-control
         checkout: ~/code/mc-crew/mission-control
         seats:
           - { id: guido-1, role: GUIDO, account_id: claude-main, model: sonnet }
   ```

   `account_id` is one of your `accounts`. With no `area`, the seat may write anywhere in the clone.

   List your own working folders under `crew.deny_read`, so code a seat runs cannot read them:

   ```yaml
   crew:
     deny_read: [~/code/work, ~/Documents]
   ```

   Absolute paths (`~` allowed). An entry that is or holds `crew.worktrees`, a session checkout or
   a temp dir (the hub's, or `/tmp`) is refused at start-up
   (`crew.deny_read: <path> holds the crew's own folders`), and so is one inside `crew.worktrees`
   or a session checkout (`… is inside the crew's own folders`). Letter case is ignored, and the
   folders need not exist yet. List the folders beside `~/code/mc-crew`, not `~/code` itself.
   A loop repo whose main working tree holds a crew folder stays readable to seats; the hub logs
   `crew: loop <id>'s repo <repo> stays readable to seats` at crew start.

5. Restart the hub: it reads the config, the `crew` section included, only at startup, and Update
   restarts it only when `main` has moved.

   ```sh
   launchctl kickstart -k gui/$(id -u)/com.missioncontrol.server
   ```

6. From a small Ready ticket's panel, start GUIDO-1.

Only one server runs crew: the supervisor holds `<crew.worktrees>/.mc-crew.lock`, and a second
server finds it held and stays off (`crew lock held by pid <n>`).

What each seat's process starts with:

- **No git writes.** Its sandbox denies every write into the clone's `.git` and the worktree's git
  dir, and `git add` / `git commit` are refused by name. A writer seat commits only through the mc commit
  tool (`mcp__mc__commit`), which the hub runs in its own clone. When the work is done and
  committed it reports with `mcp__mc__report_evidence`, and the hub's engine pushes the branch and
  opens the draft PR (below). A seat asks FLIGHT, never you, with `mcp__mc__ask_flight`; FLIGHT
  answers it or briefs it for you, and only a briefed question reaches your Needs you. While FLIGHT
  is not triaging, one "FLIGHT is not triaging" item counts what waits on it. A read-only seat
  (RETRO) has the question tool and `report_evidence`, which refuses it (read-only runs have no
  loop).
- **Unanswered Comms.** A labelled direct `question` or `blocker` shows its elapsed wait in Comms.
  After 15 minutes without the addressee replying or reacting, it becomes one FLIGHT triage item.
  FLIGHT may settle only a stale or already-resolved `comms-open:` item it sent, recording its
  required reason; a seat's or the operator's item stays protected. A linked PR that merges or
  closes, or a ticket that reaches Done, removes its Comms item on the next attention build.
  Messages from before the feature's rollout boundary do not enter the escalation, preventing a
  rollout backlog.
  If FLIGHT has not settled it 30 minutes later (45 in all), the hub raises one decision for you
  on that key, once: it carries FLIGHT's recommendation when FLIGHT briefed the item for itself,
  and the options Proceed (recommended) and Hold. Proceed is the default and applies through the
  decision-default sweep 40 minutes later unless you answer, delivered to the sending seat. A
  message to CAPCOM, one before the rollout boundary, and one whose sender's run is held
  (budget park, stopped seat, account at its stop) never get a decision. The Comms graph also reports 24-hour run-token totals per link and flags a pair
  that exceeds six reciprocal rounds on one ticket, including when FLIGHT stepped in.
- **Push and draft PR, made by the engine.** The push sends the run's own branch
  (`feature/<issue>-…`, never the default branch or another live run's) as a plain fast-forward: no force, no lease, no tags. It sends only
  commits the commit tool recorded for that branch, none of them a merge or a root commit, and only
  after `git fsck` passes and a secret scan of every added line and every commit message finds
  nothing (GitHub-, Anthropic-, AWS-, Slack-shaped tokens, private keys, and your `gh` token
  verbatim; the token read is given 10 s, then the scan goes on by pattern and the log says so). A
  commit message may not name anything on GitHub but the run's own issue: a closing keyword before
  any issue (`Fixes #n`, `Fixes GH-n`, `Fixes <link>`), another issue's `#n`, `GH-n` or link, an
  `owner/repo#n`, or an `@mention`, team mentions included (`@mc/core`, so a `fix(@mc/core):` scope
  too), HTML character references decoded first (`&#64;`, `&commat;`, `&#35;`), or a github.com
  URL with a `%` or a port. A named reference other than `&amp;`, `&lt;`, `&gt;`, `&quot;`,
  `&apos;`, `&nbsp;`, `&commat;`, `&num;` and `&grave;` (`&sol;`, `&period;`, with or without its
  `;`) is refused too, in commit messages, report notes and PR text alike: the seat writes the
  character. A
  refusal names a decoded match with its written form (`@octo (written as &#64;octo)`). The commit
  tool refuses such a message before committing, and the seat rewords it: package names without the
  `@` (`mc/core`), other issues described in words. The push checks again as a backstop for older
  commits; since a seat cannot rewrite a commit, that refusal parks the run with a Blocked note in
  Needs you. See "When a push is refused for a commit already made" for what to do. A push cut off
  by a restart is retried by the engine and answers `Already on origin`. A push that fails for a
  passing reason (the network, GitHub) is retried once a minute and parks after three failed
  tries, or as stuck when nothing shows on GitHub after 10 minutes. A commit the commit tool didn't
  make, or a failed `fsck`, parks the run too.

  The engine opens one draft PR per run, once the pushed sha is the branch's tip, and writes its
  title and body itself: title `#<issue> <ticket title>` (just `#<issue>` if the ticket title
  would be refused), body `#<issue> — <ticket title>`, `## What changed`, the seat's report note,
  `Closes #<issue>.`, `Opened by <SEAT> (Mission Control).` The seat's only text in it is the
  report note. `report_evidence` checks that note as plain text (HTML character references decoded
  once; backticks, code blocks, HTML and links hide nothing) and refuses it, telling the seat why,
  for any mention (team ones too, and after any non-word character, so `a/@user`), any `#n`,
  `GH-n`, `owner/repo#n` or issue/PR link but the run's own issue, a closing keyword for any other
  issue (`Fixes:#9` and `fixes **#9**` included), a github.com URL with a `%` or a port, the
  named references above, or an unclosed code block or HTML comment: the seat writes package names
  without the `@` (`mc/core`, not `@mc/core`) and describes other issues without `#`. The PR is
  checked again when it is opened; a refusal there parks the run. An open PR on the branch from
  before the run started also parks it ("an earlier PR is open on this branch"); a later pass of
  the same run finds its own PR rather than opening a second. Previews run no engine, so nothing
  in a preview pushes or opens a PR.
- **Confined reads.** Code a seat runs (its Bash, a test it wrote) cannot read these as files:
  - your credential folders (`~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.claude`, the login keychain
    file under `~/Library/Keychains`, and the rest of `SANDBOX_DENY_READ_HOME`);
  - the hub's data dir and checkout, and the hub's git dir;
  - every loop's worktree, `state_dir` and `logs_dir`, and each loop worktree's git common dir
    (`~/code/shop-app/.git` for a loop worktree of `~/code/shop-app`);
  - when that common dir is `<repo>/.git`, the repo's main working tree `<repo>` itself (so
    `~/code/shop-app` and `~/code/site-builder`, their source and untracked files), unless that
    folder is or holds `crew.worktrees`, a session checkout or a temp dir;
  - the other sessions' checkouts;
  - anything under `crew.deny_read`.

  Nothing else of yours is denied by default: your other working folders, such as `~/code/mc-work`
  (the hub's other worktrees) or any repo no loop runs in, stay readable until you list them under
  `crew.deny_read`.

  The file tools are confined to the worktree already. What stays readable:
  - the rest of your home, including other apps' data under `~/Library` (browser profiles,
    Application Support);
  - the other seats' worktrees, this session's and other sessions', since they all live in
    `crew.worktrees`, which no seat may deny;
  - the keychains as a service: the rule blocks only the keychain *file*. Security-framework
    queries go through `securityd`, and a probe showed that the data-protection keychain answers
    sandboxed code (#31; typed `security` is refused by name);
  - the hub-owned pnpm store (`<crew.worktrees>/.mc-pnpm-store/shared`). The hub installs from it;
    every Claude and Codex seat can read it but its sandbox explicitly denies writes, so one seat
    cannot poison dependencies used by another seat or by the hub.
    but are not an isolation boundary: one seat's code can change another seat's store.

  The sandbox has no network, and the secret scan at push time is the backstop for anything a seat
  copies into its branch.
- **The repo's CLAUDE.md from the base.** The prompt file takes `CLAUDE.md` from origin's default
  branch as the run started, read from hash-verified objects, never from the worktree the seat
  writes. A resume keeps the run's prompt file; if it is gone, the resume rebuilds it from the role
  brief alone and logs `<seat>: prompt file missing on resume; …`.
- **The mc tools** over `--mcp-config`, at `http://127.0.0.1:<port>/mcp`.
- **The guard hook** before every tool call, and after each Bash call ends:
  `'<crew.node>' --experimental-strip-types '<hub>/apps/server/src/guard/hook-cli.ts' '<token file>' 'http://127.0.0.1:<port>/api/guard/check' || exit 2`.
  `crew.node` defaults to `/opt/homebrew/bin/node`. A start is refused if one of those paths holds
  a `'` or a line break.
- **The trim hook** (#1045) after every tool call (`PostToolUse`, matcher `*`), for Claude seats:
  `'<crew.node>' --experimental-strip-types '<hub>/apps/server/src/guard/trim-cli.ts' '<run temp root>/tool-output'`.
  A result over 32 KB is answered as `updatedToolOutput` with its first 8 KB, its last 4 KB and a
  line `[mc: N bytes cut; the full output is at <path>]`; a Bash result keeps its shape (only the
  long strings are cut) and its tail starts at the last `FAIL` or `error` line when there is one.
  The full output is `<run temp root>/tool-output/<tool_use_id>.txt` (0600), removed with the
  run's temp root. The hub makes that folder before the seat starts and the sandbox denies the
  seat writes to it; the hook, which runs outside the sandbox, refuses a folder that is a link or
  not ours and creates each file exclusively without following a link. Unlike the guard hook it never blocks: any failure, or a full output that cannot
  be written, leaves the result whole. So does a built-in tool's result that cannot be cut in its
  own shape (the CLI rejects a plain text there), and Edit, Write, MultiEdit and NotebookEdit,
  whose bulk never reaches the model. Codex seats are not covered. The 32 KB, 8 KB and 4 KB
  limits are `TOOL_TRIM_OVER`, `TOOL_TRIM_HEAD` and `TOOL_TRIM_TAIL` in `packages/core/src/tool-trim.ts`.
- **A per-run token** for both, in hub memory and in two 0600 files beside the run's transcript:
  `{DB dir}/crew/<run id>.token` and `<run id>.mcp.json`. The sandbox cannot read them, and argv,
  env and settings carry only their paths. When the process exits, for any reason, the token is
  revoked, the run's test-lock hold is freed and both files are removed. A resume gets a new token.
  Files left by a hub that went down, these and any draft PR body file (`pr-<uuid>.md`), are
  removed when the next one takes the crew lock.

## Setting up another machine

These steps take a second Mac from nothing to a hub running crew on a board that another
machine's hub also works. Do them in this order; the sections they name have the detail.

1. **Toolchain.**
   - Node: `brew install node` gives the current release at `/opt/homebrew/bin/node`, which CI
     (25) and `engines` match, and needs none of step 6's node edits. The full suite also passes
     on 24, with a pnpm `Unsupported engine` warning on each command; Homebrew's `node@24` is
     keg-only, so it is neither at `/opt/homebrew/bin/node` nor on `PATH`. If you use it, put it
     on your shell's `PATH` (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` in
     `~/.zprofile`); step 6 covers the hub.
   - pnpm 11, the version CI uses. Homebrew offers pnpm 12, so install 11 with npm:
     `npm install -g pnpm@11`.
   - The `claude` CLI on `PATH`, for the seats. The copy bundled with the VS Code extension is
     not on `PATH`; install the CLI on its own (`brew install --cask claude-code`), check
     `claude --version`, then run `claude` once and sign in when it asks.
   - `gh`, logged in with the `repo` and `project` scopes: `gh auth login -s project`, or
     `gh auth refresh -s project` on an existing login (`gh auth status` lists them).
   - `codex`, only if the config keeps a Codex account.
2. **Access.** The account this machine's `gh` uses must be a collaborator on the repo, and that
   alone does not let it see a user-owned Project: the Project's owner adds the account under
   Project → Settings → Manage access, with Write. git must also push over HTTPS as that account
   without a prompt, since the hub's git never prompts: run `gh auth setup-git`, or use a
   credential manager that already holds the account.
3. **Folders.** Keep the hub's and the crew's folders apart from your own working checkout of
   this repo, so switching branches there never changes the running hub:

   ```text
   ~/code/mc-hub/mission-control    the hub's own clone: always on main; launchd runs it, Update keeps it current
   ~/code/mc-crew/mission-control   the crew's clone
   ~/code/mc-crew/worktrees         crew.worktrees
   ```

   Clone the repo from its owner's account (not this machine's) into both clone folders, and give
   the crew's clone its git identity ("First crew", step 3). Never branch in the hub's clone:
   Update refuses while it is off `main` or has changes.
4. **Install** in the hub's clone: `pnpm install`, then `pnpm build`.
5. **Configure** as in "Configure", then edit `config.yaml`:
   - Remove the example's sample loops and repos, and any account you don't use. Keep the key as
     `loops: []`: it is required.
   - Copy the repo's entry from the other machine's `config.yaml`. Its `status_map` must name
     every Status on the board: a card whose Status isn't in it is skipped, so it has no panel to
     start a seat from. Set `autonomy: draft` (step 7).
   - Edit the example's `crew` section rather than adding a second one: `worktrees` and the
     session's `checkout` are the folders from step 3, the session's `repo_id` is the copied
     entry's `id`, and no seat is FLIGHT. Add `node` if node is not at `/opt/homebrew/bin/node`
     (step 6).
   - Under `crew.deny_read`, list every folder that holds other work or data, and your own
     checkout of this repo, which is not denied by default. An entry may not be or hold the
     crew's folders, so keep `mc-crew` outside every folder you list.
6. **Start** the hub with the launchd job, as in "As a launchd job", from the hub's clone. If node
   is not at `/opt/homebrew/bin/node`, give its path (for `node@24`, the stable link
   `/opt/homebrew/opt/node@24/bin/node`) in three places before `launchctl bootstrap`:
   - the plist's first `ProgramArguments` entry. Without it launchd cannot start the hub:
     `launchctl print gui/$(id -u)/com.missioncontrol.server` shows
     `last exit code = 78: EX_CONFIG` and both logs stay empty;
   - its folder (`/opt/homebrew/opt/node@24/bin`) at the front of the plist's `PATH`, since
     pnpm starts with `#!/usr/bin/env node`: the hub runs pnpm itself (worktree installs,
     Update), and the seats inherit that `PATH`;
   - `crew.node` in `config.yaml` (see "Config"). Without it crew stays off with
     `crew.node: /opt/homebrew/bin/node is not an executable file` in `server.err.log`.

   To change a plist that is already loaded, load it again (`kickstart` keeps the old
   definition). Then check that every collector reads `"ok": true`, and that crew status reads
   `"enabled": true` (health doesn't show crew; when crew is off, `note` says why):

   ```sh
   launchctl bootout gui/$(id -u)/com.missioncontrol.server
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.missioncontrol.server.plist
   curl -s http://127.0.0.1:7420/api/health
   curl -s http://127.0.0.1:7420/api/crew/status
   ```

7. **Take a ticket.** Each hub keeps its runs in its own database, so neither sees the other's
   runs, and both would use the same branch for a ticket. That is why this machine's repo is
   `autonomy: draft` with no FLIGHT seat: in a draft repo the engine deals no cards, and a FLIGHT
   seat would start Ready tickets on its own. To take one:
   1. Move its card to In progress and assign this machine's account.
   2. Wait one of the other hub's GitHub polls (its `poll.github_seconds`; 60 in the example
      config), so it sees the card has left Ready.
   3. Check that no branch or PR exists for it:
      `git ls-remote --heads origin 'feature/<issue>' 'feature/<issue>-*'` and the repo's open
      PRs. If one does, the other hub started it first: unassign this machine's account and
      leave the card to that hub.
   4. Start a seat from the ticket's panel, which offers Start in any column. Pick the seat whose
      `area` matches the ticket's `area:` label; the panel offers the first free seat.

   The branch check in 3 above sees a run the other hub started only once that run has pushed. If it
   could have started the ticket in the minute before you moved the card, ask whoever runs it.

8. **The controller session.** The Claude Code session you run the crew from (the controller).
   `REPO` below is the folder you open Claude Code in (here, `~/Dev/mission-control`); start the
   session at the repo root.
   - **From the repo, nothing to do:** `.claude/settings.json` allows `Edit(/CLAUDE.md)`, so the
     controller can fix or revert its own crew-block changes without being refused as
     self-modification (operator-approved 2026-10-29; the rule itself is in `CLAUDE.md`). The
     leading `/` means the repo root on any machine. Claude Code applies a committed allow rule
     only after you accept the workspace trust prompt for `REPO`.
   - **Copy across by hand:** the rest lives on the machine.
   - **Your auto-mode allowances**, the `autoMode` block in `~/.claude/settings.json`. Claude Code
     reads `autoMode` only from user or managed settings, never from a repo's `.claude/` files,
     so copy that block from the other Mac's `~/.claude/settings.json`.
   - **`REPO/CLAUDE.local.md`** (git-ignored): this machine's live loops, the hub's launchd job
     and port, and the preview port. Copy the other machine's and edit the names; never list the
     other machine's loops as this one's.
   - **The controller's memory**, `~/.claude/projects/<REPO with / as ->/memory/`: the operator's
     standing preferences and lessons (desktop only, no phone, machine headroom first, FLIGHT
     unrestricted, the delegated change set, the design system, and the rest). Copy the folder
     across once, then keep the two in step by hand or by a sync folder:

     ```sh
     SRC=~/.claude/projects/-Users-<you>-Dev-mission-control/memory
     rsync -a "$SRC/" work-mac:"$SRC/"   # or copy the folder by any means; adjust both paths if REPO differs
     ```

     `~/.claude/CLAUDE.md` (your global engineering standards) is per-machine too; copy it the
     same way.

## Crew pushes and PRs

The seat-tool path (a seat calling push and draft PR) was checked end to end on the real CLI on
2026-10-21, through a preview hub, with a fake gh and a local origin; the record is in
[`docs/spikes/2026-10-21-mc-tools-guard.md`](spikes/2026-10-21-mc-tools-guard.md), under "End to
end on the real CLI". Since Plan 7a Task 7 the engine makes those calls instead, through the same
`pushRun` and `openDraftPr`; previews run no engine, so that path is covered by the engine's tests
and its first live runs, not by a preview.

### What a seat can do

Seats run ordinary local commands inside their OS sandbox; the repo's configured commands are its
validation commands, named in the brief, not an allowlist. What holds a seat is a short list of
hard gates (spec: [`2026-10-26-outcome-based-seat-guards.md`](superpowers/specs/2026-10-26-outcome-based-seat-guards.md)):

- **Sandbox:** no secrets, no home folder and no other seat's worktree (OS sandbox for Claude, the
  permission profile for Codex), and no network.
- **Area:** a writer's Edit and Write stay in its area and off the protected files, and `mc commit`
  refuses changes outside it; shell commands can touch other files in the worktree, so the seat
  reverts those before committing. FLIGHT and a read-only RETRO cannot write their checkout; a
  scratch reviewer edits a throwaway copy.
- **Git:** no git writes; a seat commits with `mc commit` and brings main in with `mc sync_main`,
  and the engine pushes and opens the draft PR after a report. Its sandbox cannot write the
  clone's git dirs either.
- **GitHub:** no `gh` at all; GitHub goes through Mission Control.
- **Attached work:** no `&`, `setsid`, `coproc`, `nohup … &`, a multiplexer that starts a session
  (`tmux new`, `screen -dm`; listing, attaching and `send-keys` into an existing one are allowed) or
  a scheduler or launcher (`at`, `batch`, `crontab`, `launchctl`, `osascript`, `open`).
- **Full suites:** the repo's `full_suite` commands take the shared test lock, one seat at a time. So do the repo's `mc.checks` commands (lint, typecheck): a check waits its turn like the suite, so the push gate never puts more than one heavy check on the Mac at once. A check that waited is not recorded as failed.
  This covers the commands the guard sees; a process a seat starts some other way is not covered.
- **Unreadable lines:** a command line the guard cannot read to the end is refused.

Each refusal is recorded as a guard hit (`/api/guard/hits`, Comms › Guard).

**Re-reads.** A second whole-file read (a `Read` with no `offset`, `limit` or `pages`, a lone `cat FILE` or
`sed -n p FILE`) of a file of 32 KB or more that the run already read whole, with the same size and
mtime and no compaction since, by the same agent (a subagent has its own context, so its reads are
kept apart), is answered with the earlier read's tool call instead of the file.
A range, a smaller file, a changed file and another run's read all pass. This is not a guard hit: it
is counted in `run_rereads` and shows as `digest.rereads` (`count`, `tokensSaved` at about 4 bytes a
token) on the run's digest. The ledger is `run_reads`; both tables go with the run.

### A looped run, step by step

Every writer run started while the engine is on (not a preview, `MC_NO_LOOP_WRITES` unset, this
hub holding the crew lock) carries a loop. A writer run started without one cannot publish: its
`report_evidence` answers that Mission Control is not driving the run.

- **Report.** The seat commits, then calls `report_evidence` with a note. The engine pushes and
  opens the draft PR (or pushes to the run's PR on a later report), then waits for CI.
- **CI.** A failure goes back to the seat as a log excerpt, twice; the third failure parks the
  run. A pass raises "Ready for review" in Needs you. Review fixes go to the seat by message: it
  commits and reports again, and the engine pushes to the same PR.
- **Parked.** Any limit parks the run with a Blocked note (and, in a `merge` repo, the card in
  *Blocked*). Your next message to the seat resumes it; the seat then needs a new commit, or a
  note starting `Ruling:`, before it can report again. A run parked because its PR was closed
  does not resume.
- **Silent.** A seat that stops without reporting is nudged once, then parked.
- **Merged.** The engine ends the run itself and the seat goes idle; in a `merge` repo it then
  takes its next Ready ticket.
- **Stop.** Stopping a looped run before its PR merges parks it as "run ended" with a Blocked
  note, which clears once the PR is merged or closed. Stop keeps the run's worktree (under
  `crew.worktrees`) and its local branch on purpose: a later run on the same ticket resumes in
  them. When the engine ends a run after its PR merges, it removes the worktree; the local branch
  stays until the merge step tidies it. To clear a stopped run's leftovers by hand, from the crew's
  clone: `git worktree remove --force <worktree>` then `git branch -D <branch>`.

When an Update first brings Plan 7a Task 7 in, a seat run started before it loses `mc push` and
`mc draft_pr` on resume and cannot publish: merge its PR first, or end it and push by hand.

### The exact GitHub writes

These are the only writes Mission Control makes for a seat's run, and it makes them from its own
clone under your account:

1. **The push:** `git push --porcelain --no-follow-tags --no-recurse-submodules origin <sha>:refs/heads/<run branch>`.
   - It sends the run's own `feature/<issue>-…` branch, as a plain fast-forward.
   - It sends only commits the commit tool made, after `git fsck` and the secret and reference
     scans described under "First crew".
2. **The draft PR:** `gh pr create --repo=<owner/name> --draft --head=<run branch> --base=<default branch> --title=<title> --body-file=<0600 file>`.
   - It is made once per run, after `gh pr list` (a read) finds none open for the branch since the
     run started.
   - Title and body are the engine's (above); the seat's report note is the "What changed"
     section.
3. **Board moves, in a `merge` repo only:** the run's own card to *In progress*, *In review* or
   *Blocked*, through `updateProjectV2ItemFieldValue` (see `autonomy` below). A `draft` repo gets
   none.
4. **The run's own PR body:** `gh pr edit <number> --repo=<owner/name> --body-file=<0600 file>`,
   after the same text checks as the draft PR, when the engine adds RETRO's minor findings.
5. **The review status:** `gh api repos/<owner/name>/statuses/<sha> -f state=… -f context=mc/review -f description=…`,
   on the run's own pushed sha while its PR is open: pending while RETRO's review is queued or
   running, then success or failure from the review, and success when you waive it. Only crew
   runs get it, so leave `mc/review` out of the required checks while PRs from people or
   `docs/*` branches must merge.
7. **Minor findings, after a merge:** `gh issue create --repo=<owner/name> --title=<fixed> --label=<area>,chore --body-file=<0600 file>`,
   one tech-debt issue per merged PR that lists minor findings, in a `merge` repo, for the hub's own runs only.
6. **The plan, from a planner (FAO) run:** `gh issue edit <issue> --repo=<owner/name> --body-file=<0600 file>`,
   appending one `## Plan` section to the ticket's body. FAO refuses where a plan already exists.

Two side effects follow on GitHub, both expected:
- **CI runs on the draft PR.** Opening it triggers the repo's workflows, which run the seat's code
  and tests on GitHub's runners, with network. Today `ci.yml` grants only `contents: read`, sets
  `persist-credentials: false` and uses no secrets, and `.github/` is a protected path seats cannot
  change. Weigh any CI change (secrets, write permissions, a new trigger) against this.
- **A commit message naming the run's own `#<issue>`** (allowed) adds a cross-reference to that
  issue when the push lands.

There are no comments, labels, ready-for-review or merges. Those wait for later phases.
Setup's board action also creates the board's fields and the repo's type labels, on your click
(see "Project fields").

### Config

- **`repos[].required_checks`** (default `[]`) names the checks that decide CI on a PR's head, by
  check run name or status context, e.g. `["check"]`.
  - Unset, every check decides except `mc/review`, Mission Control's own review status (it is
    refused in this list). A listed check the PR does not report counts as missing, so CI reads
    pending.
  - The merge gate still waits for `mc/review` to pass on GitHub, apart from CI.
  - A CI failure or a long pending names the checks in the Activity line and the park note. Only
    the first 50 checks of a head are read. A change needs a hub restart.
- **`repos[].full_suite`** (default `[]`) lists the commands that run a repo's whole suite, as
  prefixes, e.g. `["pnpm -s test"]`.
  - A seat's Bash call is a full suite when it starts with an entry's words, unless a later word
    looks like a test path (it holds a `/`, or ends `.ts`, `.tsx`, `.js`, `.mjs` and the like). A
    `--` anywhere after the entry keeps it a full suite.
  - Full suites run one at a time across every seat. The next one waits on its own (the seat
    doesn't see it, its call just takes longer) for up to 10 minutes.
  - After 10 minutes the seat is told who holds the lock, and to run the command with a test file
    path instead.
  - A full suite in the background is refused.
  - Each entry must be a command seats may run, or the config is refused at start-up.
  - The lock box on Overview and the header's `Lock:` show who holds the lock and who waits.
- **`crew.deny_read`** (default `[]`) lists absolute folders that code a seat runs may not read.
  See "First crew".
- **`crew.node`** (default `/opt/homebrew/bin/node`) is the node the guard hook runs under.
  - It must be an executable file reporting Node 22.6 or later. Give a stable path, not a
    `Cellar` one, which an upgrade removes.
  - If it is missing, not executable, too old or doesn't report a version within 5 s, crew stays
    off with a note naming the reason (`crew.node: <path> is not an executable file`), shown where
    a crew action is refused and in the hub's log. The hub itself, loop observation included,
    runs on. Fix the path and restart the hub.
  - A start is refused if the path holds a `'` or a line break.

### Adding and closing sessions

Session add and close use POST /api/crew/sessions and
POST /api/crew/sessions/:id/close. Adding applies live only when other sessions
have no active seats; otherwise crew.sessions remains restart-pending.
Close requires stopped seats with no unended or aside review runs.
The close response includes retainedPath and an outcome explaining unproven
removal or removal that failed partway.

Separate session clones are cloned on the selected branch without source-local tags, then fetch every branch of origin.
Close retains dirty, untracked or ignored files (except .DS_Store), stashes,
unpushed commits on other branches or in reflogs, clones without upstream evidence,
registered seat worktrees, and clones whose ownership cannot be proven.
A failed removal may leave a partial clone. Recover retained data manually;
re-creating the same session refuses an existing destination and names its path.

Moving crew.worktrees or its sibling -sessions folder breaks managed sessions'
confined paths and ownership checks. Restore the original paths, or close sessions
before moving and re-create them afterward. Recover any retained clones first.

### Reloading the config

Seat and role changes in `config.yaml` apply without a restart.

- `curl -s -XPOST -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{}' 127.0.0.1:7420/api/config/reload` re-reads the file the hub started with. A
  file that doesn't load changes nothing, and the call answers with its error.
- The reload answers with what it applied (`applied`), the seats as now loaded, any seat
  changes still waiting (`pending`, each with its reason), and `restartNeeded`: keys
  that changed on disk but only apply after a restart, such as `loops` and `crew.deny_read`.
- `curl -s 127.0.0.1:7420/api/crew/changes` shows the same picture without reloading.
- Setup › Sessions (#22) will use both from the HUD.

### Before the first crew push

List your own working folders under `crew.deny_read`, then restart the hub. Agent-run code can
read the rest of your home. The secret scan is the only backstop for anything a seat copies into
its branch, and it has limits (below).

### Landing a change to a protected file

The protected files are build, install and CI config: `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `vite.config.*`, `vitest.config.*`, `biome.json`, `tsconfig*.json`,
`.github/`, `.husky/`, `.claude/`, `.npmrc`, `.pnpmfile.cjs`, `.gitattributes` and `.gitmodules`.
Seats cannot change them:
- Edit and Write refuse them;
- a commit that holds one is refused whole;
- the hub won't install from a branch that changes an install input.

When a ticket needs such a change, land it outside the crew, in one of two ways:
- **by hand:** change it in your own checkout and open the PR yourself;
- **a controller PR:** have the head agent, working outside the crew under your eye, open it.

Once it is merged, start the seat's run, or a new one. A run branches from origin's default
branch as it was when the run started.

### Python dependencies in crew worktrees

When a new worktree has `uv.lock`, the hub runs `uv sync --no-config --no-python-downloads
--frozen --no-build --no-install-workspace --no-install-local --link-mode=copy` before starting
the seat. Install uv on the hub's `PATH` and install the required Python interpreters by hand;
a missing uv or interpreter fails the install. No Python downloads are allowed. Settings in
`.python-version`, `uv.toml` and uv configuration in the project or its parents are ignored;
the project's sources, workspace and lockfile still apply. As an additional check,
`.python-version` may contain only plain versions (optionally prefixed by `cpython-`, `pypy-`
or `graalpy-`), blank lines and comment lines. Interpreter paths are refused.

The install always targets the worktree's `.venv`. Any ancestor directory containing
`pyproject.toml` or `uv.toml` causes a refusal, preventing a parent workspace from taking over.
Lockfile registry sources must use HTTPS. The registry check accepts single-line strings as
generated by uv and refuses multiline strings or unsupported string escapes. Installs strip
inherited `UV_*`, `PIP_*`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `PYTHONHOME`, `PYTHONPATH` and
`PYTHONSTARTUP`, then set
`UV_PROJECT_ENVIRONMENT` to the worktree's `.venv`. Stripping `UV_INDEX_*` also removes
private-index credentials; repositories that require those credentials cannot rely on the
hub's inherited environment for authentication.

After a sync changes uv inputs, a reused worktree reports “dependencies changed; uv reinstall
is not supported in a reused worktree”. Start with a fresh worktree to install the new
dependencies. Seats use uv offline without syncing. Python caches and `COVERAGE_FILE` point
into the seat's temporary cache; commits exclude Python environments, caches, coverage output,
egg metadata and notebook checkpoints even when the repository does not ignore them.

### The secret scan's limits

The push and PR scans look at every added line, every commit message, and the PR title and body.
They find two things:
- **Known formats only:** GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`),
  Anthropic keys (`sk-ant-`), AWS access keys (`AKIA…`), Slack tokens and private-key blocks.
- **One credential of yours word for word:** your `gh` token (`gh auth token`, given 10 s).

They miss these:
- **Your other credentials, word for word.** The Claude OAuth token is caught only by its
  `sk-ant-` shape. Matching it exactly waits on you.
- **Encoded secrets:** base64, hex, a token split across lines or strings, or reversed.

The commit tool runs the same scan on the staged changes and the message before it commits, and
refuses with the file (or `commit message`), line and kind, so the seat takes the value out and
commits again. The push's scan is the backstop for a commit made before this check, or one made
while your `gh` token could not be read. A refused commit or push records a `secret` guard hit,
and a refused push parks the run with a Blocked note in Needs you. Neither shows the matched
text.

### When a push is refused for a commit already made

A push refused for a secret or a reference in a commit the seat already made cannot be fixed by
the seat or by Mission Control: push that ticket by hand. Rewriting the branch yourself does not
make it pushable by Mission Control, because a commit you re-make is not one the commit tool recorded
(`run_commits`), so the engine's push refuses it as foreign and parks the run. Starting a new run
on the ticket does not help either: it reuses the same local branch and worktree, bad commit
included. Take the branch out of the crew: stop the parked run (a message to the seat would resume
it, and the push would be refused again), fetch the branch from the session checkout
(`git fetch <session checkout> <branch>:<branch>`), fix its history in your own checkout, push it and open
the PR yourself.

### The mention and reference filter

Commit messages, report notes and PR text may not mention anyone or point at anything on GitHub but the run's
own issue:
- **Team mentions are refused** (`@org/team`), like any other `@mention`. So seats write package
  names without the `@` (`mc/core`, not `@mc/core`), in commit messages, report notes and PR text
  alike. A
  scope like `fix(@mc/core):` is refused too.
- **Unlisted named references are refused**, with or without their `;`. That includes an
  `R&D`-style ampersand, which reads as the reference `&D`. A seat writes `R and D`, or `R & D`
  with spaces.
- **Other issues** are described in words, without `#` or links.

The commit tool refuses such a message before it commits, so the seat can reword it.

### Resume a parked run

A run can stay parked after its seat has moved on. This happens when it was set aside at CI or review, and then parked on a ruling or a review. A message to the seat doesn't reach it, because the seat no longer holds the run. Resume it directly:

```sh
curl -s -X POST localhost:7420/api/runs/<run id>/resume -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{}'
```

On a run parked on review findings, this is the explicit **review waiver**: it accepts the findings
and lets the run go on to merge. It is deliberately different from FLIGHT's `settle_park` `rework`
action, which sends the findings back to the author. FLIGHT may grant further rework rounds after the
configured review-round cap, optionally adding a short fix list: up to 3 per head and 9 per run (the
cap is raised, not removed; past either, the park stays). A rework for a run set aside while its seat is
on another run is queued in Comms and delivered when the seat is free, as the message route below does.

This accepts the parked run:
- **A ruling or review-failed park:** the run goes to review.
- **A review or review-ruling park:** the run goes to review, and its findings on that head are waived.

The route answers 409 when the engine is off, or when nothing was lifted. The 409 names the check that refused: the park is gone or ended, the PR is closed or not open, the head moved, the run is held, or a blocking review touches floor-enforcing paths that only the controller can merge past. FLIGHT's `settle_park` refusals name the same reasons.

### Rework a parked run

To send rework text to a set-aside run that is parked on review findings, use:

```sh
curl -s -X POST localhost:7420/api/runs/<run id>/message -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{"text":"Please address the findings."}'
```

The text waits for that run (it is not sent to a newer run on the same seat). The route resumes only
`review` and `review-ruling` parks into working, without waiving their findings. Other park kinds are
refused; use the explicitly named resume route above only when accepting a review waiver is intended.

### Record a controller check

A ticket with a controller-check heading (`## Controller check`, or a near spelling: another level,
"Checks", a suffix) is never merged by the engine until you pass it. When the run's review is clean
and CI is green, the run parks as `controller-check` with that section's text (cut to a short brief;
the ticket has the rest), and it shows in Needs you. Once a ticket has listed a check, a pass is
needed even if the heading is later removed. If the ticket cannot be read, the run parks the same way
after three tries, saying so. Do the check, then record the verdict for the head you looked at:

```sh
curl -s -X POST localhost:7420/api/runs/<run id>/controller-check -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{"verdict":"pass","sha":"<7 or more characters of the head>"}'
```

`pass` applies at once and lets the engine merge on its next pass. It is tied to that head: it is
refused if the PR head has moved, and a later head, including the engine's own merge of main after a
pass, needs a fresh check. `fail` needs a `"note"`, sends it to the seat as rework and ends the park.
A plain resume or message does not lift this park, and neither does FLIGHT: only the controller's verdict does. A paused seat's verdict is
still recorded. While the park waits, the seat is free; a `fail` on a run that was set aside stores
the note and the engine wakes the run when its seat is free.

### Hold a run from merging

To stop the engine merging a run's PR whatever its review and CI say (an unapproved design, a
product call, a security question), put a hold on the run while it is in CI or review:

```sh
curl -s -X POST localhost:7420/api/runs/<run id>/merge-hold -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{"action":"hold","reason":"design not approved"}'
```

The hold and its reason show on the run and on its PR (`hold`). When the run would otherwise merge, it
parks as `merge-hold` ("merge held by CAPCOM: ..."), and shows in Needs you; it merges only after
`{"action":"release"}` on the same route, which returns it to the phase it left. A plain resume or
message does not lift this park. A new push keeps the hold.

FLIGHT has the same power on a superuser repo with `mc hold_pr { runId, action, reason, basis }`, logged
as a decision. FLIGHT may release only its own hold: one set here is released only here. The controller
may replace or release any hold. The route answers 409 when the engine is off, the run has no open work
to hold, or the hold is the controller's and the caller is FLIGHT.

### FLIGHT adds a controller check to a ticket

Seats have no tool to edit an issue body, so FLIGHT puts a check under a ticket's `## Controller check`
itself (superuser repos): `mc add_controller_check { issue, item, basis }`. It appends `- <item>` under
that heading, creating the section before `## Size`, `## Security` or the end when the ticket has none, and
removes an identical line from `## Done when`. Nothing else in the body changes. The engine then parks the
run's PR for the controller's verdict (`POST /api/runs/:id/controller-check`). It refuses a closed ticket,
a cut body, an `always_ask` or other-lane card, and Away; an item already listed writes nothing. It only
ever adds a hold, and is logged as a `card` decision.

### FLIGHT's controller powers

FLIGHT runs the crew with every power the controller has on it. It asks the operator only for money,
product direction, a security exception, an irreversible external action, and a floor approval the
repo reserves (`always_ask`, CI workflows, the CLAUDE.md crew block). These are tools of a `superuser`
repo's FLIGHT; each change is a logged decision, and none moves the safety floor:
guard, sandbox, hard-rule paths, `always_ask`, CI workflows and the CLAUDE.md block still need the
operator.

| Tool | What it does |
|---|---|
| `settle_park` | Lift a stuck park, request a fresh review, accept findings, `rework` (capped, queued for a busy seat) |
| `start_seat` | Start a seat the operator stopped or a crew pause holds; the decision says why and only that seat is let out of the pause (the record stays the setter's; an all-seats pause gains an exception). A start that fails puts the stop and the pause back |
| `resume_seat` | Resume a stopped or paused seat's unfinished run (superuser repo). Refused for a held run, a budget-parked run, an account usage stop, an Away quota limit, a busy or already-live seat and a machine without headroom. It counts a resume only when the seat is running afterwards; the decision names the stop and the pause it lifted, and a resume that does not go live puts them back unless the operator changed them meanwhile |
| `end_run` | End a working, parked or stalled run (a working one needs a superuser repo and a run that is not held). A run with uncommitted changes is refused before its process is touched, since only the seat can commit them; a seat in a turn is interrupted, then looked at again, and a stalled or idle seat is not interrupted |
| `sync_main` | Merge main into a run's branch |
| `dismiss_item` | Dismiss any attention item it can find except an operator approval, a budget or guard hold, an Update hold, another lane's item, an item FLIGHT briefed for the operator, a person's message, or FLIGHT's own question |
| `promote` | Reads the live card, and refuses when it cannot be read |
| `edit_issue`, `set_fields` | Replace an issue's whole body or title, set status, priority, size, labels and milestone (draft workspaces and closed cards are refused; status moves only to Blocked, everything else is `promote`; only labels being added are judged, and the area label rule applies when the area labels change; a status move is logged as `status` and counts with promote's against the hourly cap; a lane label changes only with `edit_card`; a ticket with a live run is refused, for both; a partial failure says which fields landed). `always_ask` and other-lane tickets are refused, judged on the card read live from the project (a failed read refuses; the cache is never used); text is scanned for secrets and mentions, and a body is capped at the ticket body limit and sent on stdin. `edit_issue` never drops or changes the `## Controller check` section (use `add_controller_check`) and refuses a ticket it cannot read whole |

A FLIGHT run keeps the tool set it started with. When the set grows (a hub update adds a tool), the
watch rotates the run at its next idle wake, so the fresh run has every tool without a restart. A run
started before the set was recorded rotates on its wake count as before.

## What it observes

| Collector | Source | Cadence |
|---|---|---|
| `ta-loop:<id>` | `var/autonomy/loop.log`, `status.md`, `iteration-*.log` (stream-json) | 15 s |
| `studio-loop:<id>` | `logs/driver.log`, `logs/fire.*.log` | 15 s |
| `sessions` | `~/.claude/sessions/*.json` (live Claude sessions) | 15 s |
| `github:<repo>` | Project v2 board items, plus open escalation issues (read-only GraphQL via the `gh` token) | boards and escalations every `poll.board_minutes` (default 15), and at once (within a few seconds, at most every 30 s) when a seat frees up, after the hub changes GitHub, or on `POST /api/github/refresh`; PRs the engine waits on (CI, a merge) every `poll.github_seconds` |
| `usage:<account>` | Claude: OAuth usage endpoint, then the newest transcript `rate_limit_event`. Codex: `codex app-server`, then the newest rollout. | `poll.usage_minutes` |
| `github:<repo>:prs` | The repo's recent pull requests with their CI state and review decision (read-only GraphQL) | hourly, first 5 min after start |
| `flow:<repo>` | Flow history: cycle time and first-push CI over the last 14 days (read-only GraphQL) | hourly, first 7 min after start (after the first PR sweep) |
| `machine` | This Mac: CPU, memory, disk, Claude/Codex processes (`os`, `vm_stat`, `statfs`, `ps`); a sample is kept each minute | 2 s (status rewritten at most once a minute while unchanged) |
| `maintenance` | No source and no status row: deletes run digests of runs started over 30 days ago | hourly |

Pages are described under "The HUD" below. Run cost is shown as `~$2.47`: it is the
API-equivalent price of the run's tokens, not a bill.

### Agent state rules

- **Stalled**: the latest run is working and its transcript has not grown (the later of its newest
  event and the file's mtime, so `tool_progress` heartbeats count) for 10 minutes; for 60 minutes
  while a background task of the run's own is in flight (a `task_started` with no
  `task_notification` or final `task_updated` yet), during which the card reads
  `run #N · background: <task>`. Each stall is its own Needs-you item (keyed by run and last
  output), so a second stall in the same run asks again after an acknowledgement.
- **Blocked** (waiting on you) comes only from an open issue on the loop's repo whose title starts with
  `[operator-decision]`, `[loop-blocked]` or `[mvp-ready]` (an escalation with
  `source: "title"`), or from the loop's latest run being `blocked`. An issue that is an
  escalation only because of a needs-you label (default `needs-design`), including one with an
  SD-32 block, is listed in Needs you but never changes an agent's state.
- The studio loop's latest non-signal `STOP:` line in `driver.log` (e.g. `stopped: 7-day quota
  utilization 81% >= 80%`) is shown on its card as a plain note. It does not change the state.

### Project fields

**Fields and labels.** Mission Control keeps its own information in four single-select fields on
the Project: **Stage** (*Needs detail*, *Ready*), **Owner** (*PM*, *CTO*, *Agent*, *Operator*),
**Priority** (*P0*, *P1*, *P2*) and **Size** (*XS*, *S*, *M*, *L*, *XL*). The existing **Status**
field and its options are never changed, so scripts that move cards by Status name keep working.
The server's `POST /api/boards/<repo>/setup` creates only the missing fields, with exactly those
options, on that repo's project, and the missing type labels on the repo (`type:feature`, `type:bug`,
`type:chore`, `type:test`, `type:docs`, `type:research`; it reads the repo's labels first and creates only those
absent). It changes no item and no other field, and calling it again creates nothing; it answers
`{ created, mismatched, labelsCreated }`. A field that already exists under that name with other
options is left alone and named in a warning instead. Setup › Repos runs it after a confirm. An existing board's fourth Owner option (formerly a person's name) can be renamed *Operator* in GitHub; until it is,
the setup action names the Owner field in its warning. Area labels (`area:server` …) come from the repo's own rules (below).

**Status moves (`autonomy`).** Each repo in the config has `autonomy: draft` (the default) or
`autonomy: merge`. Only in a `merge` repo may Mission Control move a run's own card between Status
columns (*In progress*, *In review*, *Blocked*), through GitHub's `updateProjectV2ItemFieldValue`;
`merge` needs a crew session for that repo (without one the config fails to load). In a `draft`
repo it makes no call at all. The engine moves only a looped run's own card. Every move attempt that changes a card, or fails to, is recorded and shown in
Activity (`{repo}#{issue} → {column}`, or `… failed: {reason}`); a card already in place makes no
write and no row.

**Per-repo board rules.** Set `repos[].rules` on the matching repo in
`~/.config/mission-control/config.yaml` (or the file selected by `MC_CONFIG`). The target repo
needs no Mission Control file, heading or block. `config.example.yaml` shows the shape. Keys:

- `pick_from`: statuses seats take tickets from; default `[Ready]`.
- `promote_backlog`: default `false`.
- `needs`: promotion/start requirements; default `[done_when, size]`.
- `templates`: label → template profile name (profiles live beside the config).
- `areas`: area label → globs; a seat's focus is the labels inside its area.
- `hard_rules`: paths held from ordinary auto-merge and auto-Update. Omitted or `null` inherits
  the built-in list; `[]` explicitly sets no hard-rule paths. On a standard repo it removes
  hard-rule path holds, but area strays and `PROTECTED_FILES` remain enforced, and Mission Control
  block changes hold auto-merge for the operator to merge by hand (Needs you). It does not bypass review, CI or other merge gates.
  Superuser floors still apply.
- `hard_rules_by`: `operator` (default) or `controller`; superuser FLIGHT powers remain a separate
  user-config setting.
- `always_ask`: labels that require the operator.

Commands and protected files already live alongside `rules`, at `repos[].commands` (`writer` and
`review` lists) and `repos[].protected` (extra globs seats may not edit or commit). They do not come
from a repo block. Changes to these repo settings, including `rules`, require a hub restart.

A repo block optionally tightens the rules in the first fenced `yaml` block under
`## Mission Control` in its `CLAUDE.md`, key `mc:`. The hub reads it at `origin/HEAD`, not a seat's
worktree; a change takes effect once merged and fetched. `hard_rules` is unioned with an explicit
user-config list (even `[]`); it replaces the defaults only when user config supplies no list.
`always_ask` is unioned, and `hard_rules_by` is `operator` if either source says `operator`.
The default counts as `operator`, so a block cannot set `controller` unless user config sets it.
User-config `templates`, `promote_backlog` and `needs` win whenever supplied, including empty maps,
empty lists and `false`; the block may fill omitted keys. The block may replace `pick_from` and
`areas`. Omitted fields inherit user config, then built-in defaults; `hard_rules: null` also
inherits. An explicit hard-rule list in either source,
including `[]`, sets `hardRulesSet`. Without a list in either source the hub never auto-merges and
posts a Needs you note pointing to `repos[].rules.hard_rules` in user config.

Set `tech_debt_issue` to an open issue number to collect merged PR minor findings as one headed
comment per PR. Without it, the hub uses the one open issue whose title starts `Tech debt: the
rolling list`; when neither is available, it files the existing per-PR Backlog issue instead.

An unknown key or invalid value is refused with the key named. `pick_from: []` and an area with no
globs are refused, and area globs must be repo-relative with `**` only as a trailing `/**`. No
`CLAUDE.md` or no Mission Control heading is fine. A heading with a missing, unclosed or empty yaml
block, or no `mc:` mapping, is still refused and stops new tickets and merges for that repo.
Hard-rule globs use the same validation as protected globs: repo-relative, with no leading `/` or
`./`, trailing `/`, empty or dot segments. A malformed legacy block `templates` value is logged
and ignored when user templates exist; otherwise it retains the legacy empty map.
The legacy repo-only `ci` key remains ignored; configure CI through `repos[].required_checks`.

**Migrating this repo (operator step).** In your home config's `mission-control` repo entry, copy
the mapping beneath this repo's `CLAUDE.md` `mc:` key into `rules:`. Keep its template map, areas,
full hard-rule list, pick/promote/needs settings and `always_ask`; omit the unused `ci` key. Apply
the config through the normal operator update/restart process. The repo block may remain as an
optional override that tightens the rules; removing it is a separate operator change after the home config is in place.
This code change does not edit `CLAUDE.md` or your home config.

`crew.run_token_budget` (default `400000`) is the input + output tokens one build-loop
run may use; the engine parks a run that goes over. A writer run leaves its seat (is set aside) once
its draft PR is open on the pushed sha and the seat is between turns, in CI as well as in review, so
the seat does not idle through CI. A CI failure brings the run back first, ahead of any new ticket.
An account's `review_token_budget` (optional) is the input + output tokens one review run on it may
use; the review fails when it goes over. Unset, a `claude` account gets `120000` and a `codex` account
`300000`, because Codex counts more tokens for the same PR (7 of 142 Codex reviews went over `120000`;
no Claude review did). When a review fails on its budget, the author's next attempt goes to another
free reviewer of the session, not the same seat, and only a single reviewer retries on itself.
`crew.max_open_runs_per_seat` (default `2`) is how many set-aside runs that are not done a seat may
hold before it takes no new ticket; it applies live, and starts by hand are not capped.

**FLIGHT holds.** With `promote_backlog` on, FLIGHT's `promote` can hold a Ready or Refinement card
that has no run: `to: "Backlog"` with `waits_on` set to an open PR in the session's repo (so it need
not have moved the card itself). The hold is a row in the `holds` table (ref, the PR, basis, time,
`released_at`), counts as a move under the hourly cap, and shows in FLIGHT's digest as
`holds: [{ ref, waitsOn, ageMin, prState, told }]` (`told` once FLIGHT has been woken for the PR's merge or close). When the PR merges or closes, the watch wakes FLIGHT
(`n hold(s) to release`); a closed-unmerged PR leaves the hold in place for FLIGHT to decide. FLIGHT
promotes the card to Ready again through `promote` with the usual checks, and that move releases the hold.

### Loop liveness

A loop that is killed mid-run never writes its end line, so its run would look `running` for
ever. Mission Control checks:

- **TA:** the `status.md` IN FLIGHT iteration is `running` only while its `pid` (the
  `ta_loop.sh` process) is alive (`kill -0`).
- **Studio:** liveness comes from the loop's launchd job, read with `launchctl print`. The latest
  fire with no `exited` line is `running` while the job has a process (`state = running`). With
  the job loaded but no process it is `unknown` and the collector reports
  `loop process not running (launchd job <label> has no process)`, even with a Claude session
  open in the worktree. Only when launchctl's answer cannot be read does the old check apply: a
  live Claude session in `~/.claude/sessions/` with the loop's `worktree` as its cwd (the
  sessions collector's 15 s read, with 60 s of grace for a young fire), else
  `loop process not running (no live Claude session in its worktree)`. Between fires a job with no
  process is normal after a `STOP:` line in `driver.log`; with no `STOP:` since the last fire the
  collector reports `studio driver not running (no STOP logged)`. Only the `state` and `pid` lines
  of the `launchctl print` output are read; the rest (which can hold the job's environment) is
  discarded.

Otherwise the run is shown as `unknown` and the loop's collector reports
`loop process not running (pid N)` (TA) or one of the studio errors above, so the card shows
an error. If the session registry cannot be read, the session check is skipped (the `sessions`
row in health says why).

### Staleness

When a GitHub poll fails, the last good board and escalation rows stay on screen. Setup › Sources
then shows GitHub as **Failing** with each failing collector's error and each repo's last good
poll (the collector's `lastOkAt` in `/api/health`). A loop whose own collector fails shows as
**Error** with the reason, and as an error item in Needs you; a failure after a recovery pulses
again.

Telemetry's quota series retains raw usage observations and also sends range-aligned burn buckets:
positive percentage-point changes in each throughput interval. Its projected exhaustion time uses
the selected range's total burn pace and latest observed usage; with no spend it is null. A reset
is never counted as spend.

### Known limits

- **TA escalations are visible only via a label or an SD-32 block.** The TA loop escalates in
  ticket comments and has no `[operator-decision]`-style title marker. Mission Control sees
  its escalations only on issues that carry a configured needs-you label (default `needs-design`) or
  an SD-32 block, and such label-only escalations never make the TA agent Blocked.
  Plan 2 standardises this.
- **Studio pause arrives with cutover.** Only the TA loop has a `PAUSE` sentinel. The studio
  agent's page has no Pause, and the API returns 409.
- Board items with no Status, or a Status missing from `status_map`, are not shown (skipped).
  Health names how many were skipped, e.g. "skipped 53 board item(s) with unmapped status".
- The codex app-server, which is the codex usage source, creates its own SQLite sidecar files
  (`*-shm`, `*-wal`) in `~/.codex` when it starts. That is codex's runtime behaviour, not a
  Mission Control write.
- When an earlier usage source fails and a later one succeeds, the account stays `ok` and the
  earlier failure's message is kept as a note in the collector's `error` field.

## QA board data

The hub records what the QA board needs as it goes; nothing here writes to GitHub. Test-lock holds,
CI runs and review findings are kept 90 days (`QA_RETENTION_DAYS`).

- **Full-suite pass/fail.** The guard hook's `PostToolUse` / `PostToolUseFailure` event ends a hold
  of the test lock. `GET /api/test-lock/history?days=` (1..90, default 7) lists holds with `outcome`:
  `pass`, `fail` (any call of the hold failed), `freed` (the run ended before the event) or `done`
  (holds recorded before this was captured). Single-file runs do not take the lock, so they are not
  counted.
- **CI runs.** Every check run read on a PR's head commit is kept in `ci_runs`, one row per
  (repo, sha, name, attempt), updated in place as it concludes; `firstSeenAt` and `at` bracket the
  polls that saw it. `GET /api/qa/ci-runs?days=` (1..90, default 7), newest first. A re-run is a new
  attempt, so a flaky check shows as a failing attempt followed by a passing one.
- **Milestones.** Each GitHub read also reads the repo's 50 newest milestones (read-only): title, due
  date, state, open and closed issue counts. `GET /api/qa/milestones`. Milestones the repo does not
  use give an empty list.
- **Findings and review rounds.** `GET /api/qa/findings?days=` (1..90, default 30) lists review
  findings with their RETRO `category` and `resolution` (`fixed`, `reply-accepted`, `held` or
  `waived`; null while unresolved), plus completed `reviews` with each round's head SHA, verdict,
  blocking and minor counts, and end time. Resolved findings and closed PRs use the requested
  window. Unresolved findings and completed rounds for a currently open PR remain available beyond
  it. RETRO sets the resolution of the findings it names when it reports round 2 or later; when a
  round reports nothing to fix, the engine marks the earlier blocking findings it left unnamed
  `fixed`. Minor findings are logged, not resolved.

## The HUD

One window: a header, the page, and FLIGHT's dock on the right. Numbers that today's data cannot
produce show `—` with a tooltip naming the phase that brings them; panels whose content FLIGHT or
the engine will write say "FLIGHT is not running yet. It arrives in phase 3." or "Arrives with the
engine (phase 2).". Amber breathes where something waits on you, green where an agent is working,
red is broken; every colour comes with a word or a shape.

**Header.** Session filter (one repo, or all), the seven pages, MET (time since the first run
today, in `operator.timezone`), the machine strip, **Needs you** (count; opens Comms), Away mode,
theme, Setup, and the dock toggle.

| Page | What it shows |
|---|---|
| **Overview** (`/`) | What needs you; the crew, FLIGHT first, then each loop with its state, ticket, what it is doing, tokens and ~cost, context and 5h quota (the call sign opens the Agent page; Answer/Open open the Item panel); recent activity; this Mac's CPU, memory and disk; each account's 5h and 7d quota with the projection. |
| **FLIGHT** (`/flight`) | The situation strip (tickets in progress, waiting on others, decisions, approvals, stalls), the next four hours (polls and quota resets; a `Next:` line lists them on narrow screens or when labels would collide) and `Later:`; FLIGHT's panels wait for phase 3. |
| **Board** (`/board`, `/board/<repo>/<n>`) | One lane per repo plus All repos, with its GitHub query to copy; columns Backlog, Refinement, Blocked, Ready, In progress, In review, Ready for QA, Done (Status by name, else by `status_map`); filters Priority, Has an agent, Needs me, Done 7/14/30 days; the standup brief; a card opens its ticket beside the board (read live from GitHub) or the agent working it. |
| **Agent** (`/agent/<id>`) | The agent's header and tiles (now, context, tokens, ~cost, work, quota), its activity stream (filters Messages, Thinking, Tools, Guard; the live call bar), its recent runs, and subagents and changed files. Pause/Resume only for a TA loop. |
| **Comms** (`/comms`) | Needs you (acknowledge stops the pulse; it clears when you act) and one thread per agent; threads arrive with the mailbox (phase 2). |
| **Telemetry** (`/telemetry`) | KPIs, flow of work (throughput, cycle time, quality, you as CAPCOM), agents (tokens per minute, per turn, time), capacity and cost, for 1h/6h/24h/7d, by agent or account. Its read-only payload also carries bounded raw chart series: observed crew-state spans (open spans stop at their last observation), quota samples with configured alert/stop lines and reset causes, open and completed ticket Ready/start/merge/Done facts, timestamped range-bounded throughput, daily quality points (null means no evidence), and crew-pause, hub-Update and quota-reset annotations. Ticket cost retains both range-prorated cost and all-run cost for tickets merged in range. Charts take focus: ←/→ step the crosshair, Home/End jump. |
| **Setup** (`/setup/<tab>`) | Read-only: sessions, loops, accounts, roles/guard/test lock, sources (each collector's last poll) with the glossary, access and notifications. |

For a reversible operator decision, FLIGHT may brief a recommended option with a stored deadline.
When that deadline passes, the hub records and delivers that recommendation once. Update holds,
approvals, budget/account parks, guard acknowledgements, hard-rule flags, protected dismissal rows,
observed-loop escalations, and briefs written before deadlines were stored are never defaulted.

**Overlays.** FLIGHT's dock is a column at 1200 px and wider, and a drawer with a scrim below
that. The Item panel flies out from the right for one item; Away mode and Keys and lamps (`?`) are
modals. `Esc` closes the topmost; focus goes back to where it was.

**Keys.** `g` then `o` `f` `b` `a` `c` `t` `s` go to a page; `f` shows or hides FLIGHT; `j`/`k`
step through agents; `/` opens the selected agent (its composer is off for an observed loop) and
`i` says an observed loop is not interrupted; `?` help.

**Layout.** At 1000×560 and up the app fits the window and panels scroll inside (where even the
smallest panels do not fit, the work area scrolls); below that the page scrolls; at 390 px nothing
scrolls sideways. Reduced motion stops every pulse and leaves a still ring.

### HUD screenshots

FLIGHT's `screenshot_hud` tool (superuser repos only) renders one HUD page at 1600×1000 in the
system Chrome. The render runs in an owned helper process in its own process group with a minimal
environment (no tokens); the hub kills the whole group when the render ends or its 30 s deadline
passes, so no Chrome outlives a call. Chrome is started with `launch()` (a private pipe, no control
socket) and every request it makes, loopback included, goes through a loopback-only proxy that
connects to the hub's own host and port and refuses everything else, on top of the Playwright
routes (GET only, no bootstrap, no event stream, no WebSockets, no service workers, popups closed).
The shot is taken after the shell is ready, the lazy page's `Loading…` placeholder has gone and the
page's requests have been quiet for 400 ms. Renders are one at a time per host, capped per FLIGHT
per hour, and the repo's powers are rechecked just before launch.

Each screenshot is kept under `hud-screenshots/` in the data dir (directory `0700`, files `0600`,
an opaque 128-bit id), at most 50 files and one week. The tool's answer ends with `Reference:
hud-shot:<id>`, which FLIGHT cites in a ticket. The operator reads one at `GET
/api/hud-screenshots/<id>` with the `x-mc-operator` token header (404 for an unknown or expired id).

Not built: rendering a PR preview. The hub does not serve PR branches, so there is nothing for the
tool to point at; FLIGHT reviews merged work on the running hub.

## Away mode

The server reads the settings saved by `POST /api/settings/away` before starting work or marking
PRs ready. An end date includes that whole day in the operator's configured timezone. Turning
away off, or passing that date, restores the repo's usual behaviour.

Automatic starts require **Pick up safe tickets**, Size XS or S, and a bug, chore, test or docs
label mapped through the repo's `mc.templates` (the built-in profile labels when absent).
`bugfix` maps to bug; `small-change` maps to test or docs for those labels, otherwise chore.
FLIGHT can explicitly start other work, which stays draft. Existing seat, memory and verify
limits still apply. New automatic and FLIGHT ticket starts require current readings for both
quota windows and weekly usage below 70%; missing accounts, missing readings and readings at or
past reset hold those starts. The reserve does not stop resumes, RETRO reviews or FLIGHT's watch;
the account's configured stop still applies to those. The operator can start a ticket manually
from the HUD while away, including a planner. That planner cannot report its plan until away
is off: `report_plan` refuses to edit an issue. FLIGHT cannot start planners while away.

**Take a safe PR out of draft** applies only to `autonomy: merge` repos with explicit hard rules
(`hard_rules: []` counts). Draft repos always stay draft. Pick up must also be on; work started
by FLIGHT with Pick up off stays draft while away. Readiness requires safe metadata, green CI, a clean RETRO review with
no Minor findings or waiver, and an allowed diff inside the seat's area. Test tickets add only
test files; docs tickets change only documentation. Existing tests, hard-rule files, migrations,
settings, CI, infrastructure, dependencies, auth and API paths hold the PR in draft. Dependency
manifests, deployment and test configuration, install scripts, CODEOWNERS and this repo's
GitHub-write wiring are held whole. Documentation is identified by its extension or README
filename; a `docs/` directory alone does not qualify. For bugs, the diff must add a reproducing
test file; fixture files do not count. FLIGHT records a `log_decision` with that test's results
on the base and branch. `flight_state` supplies the expected `awayBugDecision.about` key and
eligible `testPaths` for a waiting PR; the basis must name one of those added test paths. A head
SHA alone is insufficient. The hub checks the head again after marking ready and restores draft if it moved, including
on later passes.
Away mode blocks merging in every repo and FLIGHT's external posting and settings changes.
`draft_reply` remains available; comments wait for approval in the existing drafts list.

Read `GET /api/away/digest` (for example, open `http://127.0.0.1:7420/api/away/digest` on the hub).
It returns `active` and six ordered `groups`: `needYouNow`, `safePrsReady`,
`draftsToWalkThrough`, `failures`, `flightDecisions`, and `messagesDrafted`. Each has `items`.
Only PRs with a recorded ready step for their current head count as safe. Ended runs and ended
parks are omitted from failures; acknowledged attention is omitted. Decision history accepts
`?since=<epoch milliseconds>` and defaults to the away start, or seven days when none is known,
with at most 200 entries. `AWAY_STARTED_SETTING` (`awayStartedAt`) is stored to bound the digest.
Repeated reads acknowledge nothing and pending messages remain drafts.

`may.research` is not acted on yet; research drafting is a follow-up. `may.check` means
"Check GitHub (and Teams) every 30 min for anything about me or my tickets" and is also a
follow-up. The "label safe-to-merge and ask its code owner" step remains a follow-up.
Existing verification and review behaviour continues in the meantime.

When the server ticket goes Ready, file the **lane:work** web follow-up: replace the Away modal's
"phase 4" text and show this single digest when away switches off or its end date passes.
The follow-up should use the configured timezone and preserve the six groups' urgency order.

## Verification

The record of the first real run against the live loops (2026-10-17) is kept outside the repo.

Screenshots are not kept in the repo, because they would show a real board. Run a preview on a
copy of your own database (`MC_PORT=<port>`, `MC_DB=<copy>`, `MC_NO_LOOP_WRITES=1`) to see the HUD.

### Checking the write floors

The floors (what a Codex or Claude seat can write) are otherwise tested by reading generated config.
`apps/server/test/seat-floors.test.ts` launches the installed `codex` and `claude` CLIs through the
production config (`codexSeatConfig`, `crewSandboxSettings`) with a temp HOME and fake auth, runs a
write probe inside each, and checks the disk. For a writer and a read-only seat it covers the pnpm
store (Codex: read-only to both modes; Claude's store is the seat's own temp root, writable and
nowhere else), the worktree itself (writable for a writer, refused for a read-only seat), the
worktree's `.git` pointer, the clone's git dir, the worktree's git dir, `.codex` and the hub's data
dir. Claude runs against a local fake Messages API, so no login or network is used. Codex runs the
profile with `codex sandbox`, not the app-server.

It runs only on macOS with `sandbox-exec` that can apply a profile (not from inside another
sandbox) and the `codex` / `claude` CLI on PATH; elsewhere, including Linux CI, it skips. Before
merging any change to a floor (`codex-floor.ts`, `crewSandboxSettings`, the pnpm store paths), run
`pnpm -s vitest run apps/server/test/seat-floors.test.ts` on a Mac outside a sandbox and confirm
the tests ran rather than skipped.

## Agent comms relay

The relay stores signed ciphertext, public membership records and wrapped key grants. It never
receives the room key or a plaintext message body. History keeps the last 5000 messages per room;
clients resume by relay sequence, not sender time. If retention has passed a client's cursor,
the relay sends a `gap` range before the retained messages; `comms_rooms` reports the missing
sequence range in its `gaps` field, separately from connection errors. Overlapping or adjacent
ranges are merged; at most the 20 highest ranges are kept. The relay cannot recover messages
already trimmed. Back up the Node relay's data directory if you need to preserve rooms across machines.

A cursor ahead of the relay (for example after restoring an older backup) produces
`{t:"reset",relaySeq}` and closes the connection. The daemon reports `relay-reset` in `rooms()` /
`comms_rooms` with the relay sequence, local cursor and recovery instructions. It pauses sending,
answering and reconnecting for that room, preserving the inbox and cursor. The pause persists
across daemon restarts. New messages can reuse sequence numbers already in the inbox: these are
new messages, not duplicates, so merely waiting for the relay counter to catch up loses messages.
The daemon never rewinds automatically.

For **relay-reset recovery**, stop the daemon and back up its entire agentcomms home, including
`inbox.sqlite` and any SQLite sidecars. Have the owner create a replacement room with a new room
name, invite the members and approve them again. Remove the affected room's entry from the local
`config.json` rooms list, then restart the daemon with the replacement room configured. Keep the
old inbox, trust records and keys as an archive; do not clear its cursor or delete old rows to
resume the old room. Other members must migrate too. Messages lost in the relay restore need to
be recovered from members' local archives or resent into the replacement room.

Redeploy the relay before updating clients, then update clients promptly after the relay;
clients more than one page behind get no live delivery until updated because old clients reject
`more`.

Deploy the Cloudflare relay from your own account, by hand:

```sh
# From the repository root, install before the relay build.
pnpm install
cd apps/relay
npx wrangler@4 login
npx wrangler@4 secret put AGENTCOMMS_CREATE_SECRET
npx wrangler@4 deploy
```

Wrangler binds `ROOMS` to the SQLite-backed `RoomDO` Durable Object, one object per room. The build
extracts WASM from the already installed libsodium package into ignored `dist/` files for
static loading on Workers. No credentials are ever committed to the repo or CI. Wrangler is an
operator tool, not a project dependency. The Durable Object stores each ciphertext entry in its
own SQL row, reads replay in pages of 100, and stores membership, grants and tokens in separate
rows. Existing chunked snapshots migrate transactionally on first use; failures are logged and
initialization retries on the next event. Presence does not write room rows. Heartbeats run every
30 seconds with a 24-second throttle to allow jitter. Presence status and timestamps, socket
authentication and replay cursors survive hibernation through WebSocket attachments.

For a LAN relay, with Node 25 and `packages/agentcomms/bin` on `PATH`:

```sh
# Set a strong operator secret in the environment (do not commit it).
export AGENTCOMMS_CREATE_SECRET='REPLACE-WITH-A-RANDOM-OPERATOR-SECRET'
agentcomms relay --port 7480 --data "$HOME/.local/share/agentcomms/relay"
```

Room creation fails closed when `AGENTCOMMS_CREATE_SECRET` is unset. Set the same secret on
the creating operator's CLI, or pass `--create-secret <secret>` to `relay` and `room create`.
The secret authorizes room creation only; joining and ordinary daemon operation do not need it.
Use the environment to keep it out of command history. The Worker uses a Wrangler secret,
not a committed `wrangler.toml` value.

The Node relay listens on all interfaces; use the host's LAN address from the other machine.
The returned URL uses loopback for local clients. Internet clients use the deployed Worker URL
with `wss:`. WebSockets connect at `/rooms/<URL-encoded room>` on either transport.

The transport bootstrap API supplies the CLI's room and invite operations:

- `PUT /rooms/:room` requires `Authorization: Bearer <AGENTCOMMS_CREATE_SECRET>` and JSON
  `{owner, directory, grants, sig}`. The owner signs the complete creation payload with the
  `agentcomms/create/v1|` domain. The directory and each epoch-0 grant are separately signed.
  An existing room returns 409 and is never overwritten.
- `POST /rooms/:room/tokens` takes `{memberId, nonce, at, sig}`, owner-signed in the
  `agentcomms/token/v1|` domain. Requests expire after 120 seconds. Nonces are stored with the signed request timestamp and
  pruned once older than twice the clock-skew window, preventing replay while requests are valid.
  Returned join tokens contain 32 random bytes in base64url, can be used once, and expire after
  24 hours. Used and unused expired tokens are pruned on issuance, joining and room load.
  Legacy tokens without an expiry must be reissued. A signed token request outside the time
  window reports clock skew; synchronize the client clock and retry. WebSocket authentication
  uses a challenge, not the client clock; its timeout means no valid hello arrived in time.
- Every socket receives a random `{t:"challenge", challenge}`. A member or agent signs
  `agentcomms/hello/v1|room|id|challenge` and sends `{t:"hello", room, memberId, challenge, sig}`.
  Challenges are single-use and socket-specific. Sockets without hello close after 10 seconds.
- A joining socket sends `{t:"join", token, member}` with its self-signed member record.
  `{t:"grants",grants:[]}` acknowledges the pending request; it grants no access to history.
- Authenticated clients receive the owner-signed active directory, grants addressed to their
  identity and presence. Clients verify the directory against the owner id pinned from the
  invite and persist the highest verified version and epoch. Relay claims cannot lower either.
- Each grant signs `agentcomms/grant/v1|room|recipientId|epoch|sha256(wrapped)`;
  each directory signs `agentcomms/directory/v1|room|epoch|version|sha256(canonical members)`.
  Digests use unpadded base64url. Members sign their own records, including labels and box keys;
  agent delegations bind their box keys too. The owner uses locally pinned, verified records
  for approval and rotation. Clients never overwrite a cached key with a conflicting relay key.
- The owner's `approve` and `remove` payloads are signed, including their grants and next
  directory version. Removal increments the epoch and wraps a new key to remaining members
  and agents. Receivers quarantine messages from removed senders and earlier epochs once
  they verify the rotation. The relay sends the signed directory before refusing a removed
  peer, including on reconnect. A communicator stops a room iff some owner-verified directory
  stored on disk listed its member id in `activeMemberIds` and the newest stored directory omits
  it. It checks this history at startup and whenever it accepts a directory, so removal survives
  restart. Without that evidence, `refused: removed` is temporary and triggers normal reconnect
  backoff, including for first connections and pending members receiving pre-approval directories.
- Posts include a message `id`; refusals echo it so an unrelated refusal cannot reject the
  pending send or alter room status. While a post is pending, an id-less `invalid-message`
  refusal from an older relay also fails that post. The client checks the complete sealed frame against `FRAME_MAX` (256000 bytes)
  before sending; a body within 32000 bytes can still exceed the frame limit after JSON escaping,
  metadata and encryption. The relay also checks the outgoing `msg` frame using the largest
  safe sequence number and refuses oversized posts with `too-large` and the post id. Daemon
  receive limits reserve an extra 1024 bytes of headroom.
- Clients send `{t:"since",seq:lastStoredSequence}` before live delivery. Each request returns
  at most 100 messages. If history remains, `{t:"more",seq:lastPageSequence}` follows the page;
  clients store the page and send another `since` with their last stored sequence until no
  `more` remains. Live delivery starts only after the replay cursor catches up. Signed messages that
  cannot be delivered become quarantined rows with a reason and advance the cursor. Inbox
  uniqueness is `(room, msg_id)`; replaying a message at another sequence cannot run the hook
  twice. A quarantined row has `msg: null` and must never be treated as an agent instruction.

The relay accepts agent-signed connections under approved delegations, so a communicator never
needs the human's private key. Only a human owner connection can approve or remove members.

## Agent comms: home and work

**Phase 1's home side is a standalone communicator.** `FLIGHT-comms` is its delegated agent
name; it is not the running FLIGHT session. FLIGHT and HUD integration come later, in phases 2
and 3. The daemon keeps the relay connection and inbox alive; a Claude session uses MCP to
read and send. Automatic answers require an explicit `--answer` hook. The daemon starts even
when rooms are pending or offline; `comms_rooms` and `GET /rooms` report each room's status.
Each room retries independently with increasing backoff after short connections.

The answer hook runs one process at a time, with at most five queued inputs and ten admitted
inputs per minute per room. Backlog predating daemon startup, closed threads and duplicate
messages do not run it. Mentions match the complete agent name. On POSIX systems the hook
runs in its own process group, which is killed after 30 seconds. Windows uses `taskkill /T /F`
to terminate the hook process tree. `comms_read` accepts `limit`
(default 50, maximum 500), and returns undeliverable rows alongside delivered messages.

Use Node 25 and a checkout with workspace dependencies installed on both machines. Deploy the
Worker using [Agent comms relay](#agent-comms-relay) above, then use its base URL, for example
`wss://agentcomms-relay.YOUR-SUBDOMAIN.workers.dev`. Do not append `/rooms/...`; the CLI does that.
For a LAN test use `ws://RELAY-LAN-IP:7480`. The relay must be reachable from both machines.

On the home Mac, from the repo root:

```sh
export PATH="$PWD/packages/agentcomms/bin:$PATH"
export AGENTCOMMS_HOME="$HOME/.local/share/agentcomms"
agentcomms init --member 'Luke home'
agentcomms agent add FLIGHT-comms --subscription 'Claude · home'
# Set this to the operator secret configured on the relay.
export AGENTCOMMS_CREATE_SECRET='REPLACE-WITH-THE-RELAY-OPERATOR-SECRET'
agentcomms room create wss://agentcomms-relay.YOUR-SUBDOMAIN.workers.dev home-work
agentcomms invite home-work
```

`init` prints the member id (`--github <handle>` is optional metadata). `agent add` prints the
agent id. Add all agents before creating or joining any room: phase 1 cannot update registered
agents after that. `invite` prints a single-use `ac1.` code containing the relay, room, token and
owner member id (the Ed25519 public key), never the room key. Transfer the entire invite over
an authenticated person-to-person channel and confirm the owner id with its issuer. `join`
pins that owner id locally; a relay-supplied replacement is never trusted. Old invites without
an owner id and unsigned phase-1 state are incompatible: recreate the room and exchange fresh
invites. Do not reset local trust files to accept a relay's older state.

On a Windows work PC, use PowerShell and the CLI's TypeScript entry point directly (the `bin`
shim requires a POSIX shell). Replace these example installation paths with your own:

```powershell
$env:AGENTCOMMS_HOME = "$env:USERPROFILE\.local\share\agentcomms"
function agentcomms {
  & 'C:\Program Files\nodejs\node.exe' --experimental-strip-types 'C:\src\mission-control\packages\agentcomms\src\cli.ts' @args
}
agentcomms init --member 'Luke work'
agentcomms agent add work-comms --subscription 'Claude · work'
agentcomms join 'ac1.PASTE-THE-INVITE-HERE'
```

In a POSIX work environment, put `packages/agentcomms/bin` on `PATH` as on the Mac and run the
same `init`, `agent add` and `join` commands. `join` prints the work member id and leaves it
pending. Confirm that id with the work operator and approve it from the home terminal:

```sh
agentcomms approve home-work WORK_MEMBER_ID
```

Approval does not rotate the room key: a newly approved member can read retained history from
the current epoch, including messages sent before approval. It does not receive earlier epochs.
Approval wraps the room key to the work member's X25519 key **and each approved agent's**
X25519 key. Each daemon authenticates as its own agent, gets the public directory, unwraps its
own grants and follows key rotations without loading a member key. Only the human-run setup
commands `init`, `agent add`, `room create`, `invite`, `approve` and `remove` may use the member
key. `join`, `daemon`, the loopback API and `mcp` do not load it.

Local files live under `~/.local/share/agentcomms` by default, or the exact directory set in
`AGENTCOMMS_HOME`. Use the same directory for setup, daemon and MCP on a given machine, with
one daemon per home:

| File | Contents |
|---|---|
| `config.json` | Self-signed member and agent records, delegations, optional GitHub handle and joined relay/room/token/ownerId records. |
| `trust/<sha256-of-room-name>/<version>.json` | Immutable owner-signed directories; the highest verified version sets the epoch, mode `0600`. |
| `member-<member-id>.json` | Owner’s locally pinned self-signed approval record, mode `0600`. |
| `keys/<identity-id>.json` | Private signing and box keys for a member or agent, mode `0600`. |
| `keys/room-<sha256-of-room-name>-<epoch>.json` | Immutable cached room keys by epoch, mode `0600`. |
| `inbox.sqlite` (and SQLite sidecars) | Local decrypted messages, quarantined ciphertext/reasons, thread state, resume cursors and persistent relay-reset pauses. |
| `api-url`, `api-token` | Daemon's loopback URL and bearer token, mode `0600`; rewritten when it starts. |
| `relay/` | Default Node relay data directory; `relay --data <dir>` overrides it. |

The member private key is a **plaintext `0600` file**, readable by the user's own processes,
including agent shells running as that user. It is not passphrase-wrapped or stored in the OS
keychain. The operator accepted this risk for MVP; separate CLI and daemon signing paths do not
prevent same-user shell access to the key.

On Windows, POSIX mode `0600` does not enforce a private ACL. Restrict the entire
`AGENTCOMMS_HOME` directory and its inherited child ACLs to the setup/service account (plus
SYSTEM and administrators as required by local policy), remove broad Users/Everyone access,
and verify the effective permissions with `icacls`. Do this before creating keys. The scheduled
daemon must run as that same account; other processes under it can still read the plaintext key.

Private keys stay in `keys/`, outside the repo and config. The API listens on `127.0.0.1` at a
random port; there is no daemon `--port` setting. MCP reads `api-url` and `api-token`, so do not
hard-code a port or copy these files between machines. Protect the local inbox as plaintext.

For the first test, save this fixed-response hook as
`$AGENTCOMMS_HOME/first-answer.sh` on the Mac:

```sh
#!/bin/sh
cat >/dev/null
printf '%s\n' '{"body":"I cannot confirm ownership from the shared notes.","knowledge":{"kind":"cannot-confirm"}}'
```

The daemon passes the incoming message JSON on stdin. A hook may print plain text or a JSON
object `{ "body": "...", "knowledge": { "kind": "cannot-confirm" } }`. `knowledge` may also be
`{"kind":"checked","source":"...","asOf":"..."}` or `{"kind":"from-notes","asOf":"..."}`.
Omitting it defaults to `cannot-confirm`. Empty output means no answer; JSON objects that do not
match this schema are not sent. The fixed hook is only a connectivity test, not a live FLIGHT or Claude integration.
The hook runs for a peer's non-automatic `question` or `request` naming the agent, or in a room
with two active members. Replies keep the thread and `inReplyTo`, and are always automatic.
They pass the same body size, secret scan and rate guards as manual sends.

On the Mac, save the following as `~/Library/LaunchAgents/com.agentcomms.home.plist`.
Replace `/Users/YOU`, the checkout path and `/opt/homebrew/bin/node` with absolute paths on your
machine (`command -v node` must resolve to Node 25). launchd does not expand `~` or `$HOME`.
Create the home directory's `logs/` subdirectory before loading it.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentcomms.home</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--experimental-strip-types</string>
    <string>/Users/YOU/src/mission-control/packages/agentcomms/src/cli.ts</string>
    <string>daemon</string>
    <string>--answer</string>
    <string>/bin/sh '/Users/YOU/.local/share/agentcomms/first-answer.sh'</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTCOMMS_HOME</key><string>/Users/YOU/.local/share/agentcomms</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/YOU/.local/share/agentcomms/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.local/share/agentcomms/logs/daemon.err</string>
</dict>
</plist>
```

```sh
mkdir -p "$AGENTCOMMS_HOME/logs" "$HOME/Library/LaunchAgents"
plutil -lint "$HOME/Library/LaunchAgents/com.agentcomms.home.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agentcomms.home.plist"
```

This LaunchAgent starts at login and restarts after exit while the user session is active; the
Mac must remain awake for continuous service. Stop it before switching to a foreground daemon:
`launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agentcomms.home.plist"`.
Without launchd, the equivalent is `agentcomms daemon --answer '/bin/sh /absolute/path/first-answer.sh'`.
With more than one registered agent, add `--agent <id>` (the id printed by `agent add`, not its
name) to the daemon arguments. With exactly one, selection is automatic.

On Windows, first check `agentcomms daemon` in the setup terminal, then stop it with Ctrl-C.
For background operation, use Task Scheduler under the **same Windows account** as setup.
Save `%USERPROFILE%\.local\share\agentcomms\run-daemon.ps1` with absolute paths:

```powershell
$env:AGENTCOMMS_HOME = 'C:\Users\YOU\.local\share\agentcomms'
& 'C:\Program Files\nodejs\node.exe' --experimental-strip-types 'C:\src\mission-control\packages\agentcomms\src\cli.ts' daemon
exit $LASTEXITCODE
```

Create a task triggered at that user's logon, with program `powershell.exe` and arguments
`-NoProfile -NonInteractive -File "C:\Users\YOU\.local\share\agentcomms\run-daemon.ps1"`.
Configure restart on failure, no execution time limit and no second instance while running;
allow battery operation if needed. Use “Run whether user is logged on or not” if background
operation after logout is required, subject to the work PC's account policy. This runs the
foreground daemon under Task Scheduler, not as a native Windows Service. Keep the PC awake;
sleep interrupts its connection. The work daemon needs no answer hook to send via MCP.

Add an `agentcomms` stdio server entry to the Claude session's MCP configuration, merging it
with existing entries. For a Claude Code project config (`.mcp.json`), the Mac entry is:

```json
{
  "mcpServers": {
    "agentcomms": {
      "command": "/opt/homebrew/bin/node",
      "args": ["--experimental-strip-types", "/Users/YOU/src/mission-control/packages/agentcomms/src/cli.ts", "mcp"],
      "env": { "AGENTCOMMS_HOME": "/Users/YOU/.local/share/agentcomms" }
    }
  }
}
```

On Windows use this entry instead:

```json
{
  "mcpServers": {
    "agentcomms": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["--experimental-strip-types", "C:\\src\\mission-control\\packages\\agentcomms\\src\\cli.ts", "mcp"],
      "env": { "AGENTCOMMS_HOME": "C:\\Users\\YOU\\.local\\share\\agentcomms" }
    }
  }
}
```

These invoke `agentcomms mcp` directly through Node. A POSIX session with the shim on its `PATH`
can instead use `"command": "agentcomms", "args": ["mcp"]`. Start the daemon before using MCP
tools, then reload the session's MCP servers. MCP is a separate stdio process; it does not start
the daemon or load identity keys.

From the work Claude session, make this first exchange:

1. Call `comms_rooms {}` and confirm `home-work`. `comms_presence {"room":"home-work"}` should
   show both agent ids online.
2. Call `comms_send {"room":"home-work","kind":"request","body":"FLIGHT-comms, take #506"}`.
   It must return the tool error `a request needs a reason`, with no message sent. Requests
   need a non-blank `reason`; `requestedBy` is attribution claimed by the sender, not verified
   identity or human approval.
3. Call `comms_send {"room":"home-work","kind":"question","body":"FLIGHT-comms, is #506 yours?","thread":"first-test"}`.
4. Call `comms_read {"room":"home-work","since":0}` until the question and one answer appear.
   Check the answer body, `knowledge.kind: "cannot-confirm"`, `auto: true`, matching thread
   and `inReplyTo`. Its `sender.delegation` names `FLIGHT-comms`, `Claude · home` and the home
   member id; `sender.member.label` is `Luke home`. Member labels come from the authenticated
   public directory, not the answer hook. Previously stored inbox entries may lack this label.
5. Read again: there should be no automatic reply to the automatic answer. Use `comms_threads`
   with the room to inspect the thread. Sequence numbers, not sender clocks, determine order.

`Held:` means nothing was sent (for example a possible secret or rate limit); `Merged:` names
an existing open question's thread. Bodies over 32,000 UTF-8 bytes are refused whole. For later
reads, pass the last seen sequence as `since`. The daemon resumes from its persisted inbox after
reconnect. To remove work access, the home owner runs `agentcomms remove home-work WORK_MEMBER_ID`;
this rotates the key and distributes grants to all remaining members and agents, including
those that reconnect later. Removed members retain earlier history but cannot read new messages.
A removed member's communicator stops sending, answering and reconnecting for that room;
`comms_rooms` reports `removed` with an explanation. Other configured rooms keep running.
If the owner later approves the same member again, the removed daemon stays halted (it never
connects, so it never sees the newer directory): re-run `agentcomms join <code>` with a fresh invite
on that machine, then restart the daemon.

Run the automated local equivalent from the repo root on a machine that permits sockets:

```sh
npx vitest run packages/agentcomms/test/two-sides.test.ts --maxWorkers=2
```

It uses temporary homes and a local Node relay, runs CLI setup and two daemons, then calls work's
MCP server over stdio. It needs no Cloudflare credentials. A sandbox that forbids listening
sockets cannot run it (`listen EPERM`); run it outside that sandbox.

## Codex crew seats

Add a Codex seat in **Setup › Sessions**, or in `config.yaml`: choose an account whose vendor is `codex`, a model from that account's discovered model list, and an advertised effort for that model. The seat's state is shown alongside the other crew seats in the hub.

If a Codex seat says `unavailable: …`, it is waiting for Codex model discovery or validation. The hub still boots and Claude seats continue to run. No intervention is required: the state clears itself when discovery succeeds.

Each Codex run has its own `CODEX_HOME` and a permission profile, with reads, writes, and network enforced by the OS. Remote plugins are off for seats, so Codex does not download its shared plugin catalog into each isolated home. The hub approves every command and edit, and checks the confinement at start, resume, and reattach before allowing the seat to work.

Known limits: pipelines such as `a | b` are declined for now. `unified_exec = false` is not proven on Codex CLI 0.154. A Codex seat keeps the CLI binary it started with; `updates.cli` applies only to Claude seats.

## Audit API

`GET /api/audit?range=7d|30d|90d|365d` returns the `AuditView` type from mc/core, every panel bounded by the range. Besides long runners, death loops, rework, refusals, questions, cost per merged ticket and the model and prompt timeline, it serves:

- `prSizes`: each merged PR's additions, deletions and changed files (PRs merged before size capture are left out) and the outliers at or above `AUDIT_PR_OUTLIER_LINES`.
- `agentId` and `runId` on long runners, death loops, rework, `refusals` and `spendOutliers` (runs costing at least twice the range's median run).
- `chatter` (seat pairs with a long back-and-forth on one ticket), `refusalSpikes` (a seat with `AUDIT_REFUSAL_SPIKE` refusals in a UTC day) and `flakes` (checks that failed, then passed on the same head). Flakes come from FLIGHT's signal state, which keeps seven days, so a longer range shows at most the last seven.
- `changes`: each seat's first run on a new prompt hash or model, with crew-wide merged count, review fail rate, median cost per merged ticket and rework rounds over equal windows before and after (up to seven days each; the window shrinks when the change is recent).
- `surgeonProposals`: always empty until SURGEON proposals are stored.

The route only reads data the hub already stores.
