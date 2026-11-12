# Mission Control runbook

## Code-health reads

`GET /api/code-health?repo=<id>&window=30d&tab=overview` requires the operator token.
Windows are `7d`, `30d` and `90d`; tabs are `overview`, `review`, `risk` and `test`.
Each response states its observed dates, source and collection gaps. Rework rates describe
distinct reported PRs. Job observations are not test attempts, and mixed outcomes remain
candidates. Current file sizes have an analysed SHA; historical growth and line churn need
their own collection. Raw command durations with unknown units remain unnormalised.

The response issues repo-scoped evidence references. Read one through
`GET /api/code-health/evidence/<id>?repo=<id>`, passing its returned `cursor` for later pages.
A page holds at most 50 rows; the bounded reader stops after 20,000. A changed source answers
409 and asks for a fresh summary. References lost after restart or bounded-cache eviction
answer 404 with the same recovery. These reads send no GitHub or config writes.

Summary caches follow relevant review, CI, PR and Map writes, including writes from another
SQLite connection. Unrelated settings and machine samples leave them intact. Collection reads
use a consistent deferred SQLite snapshot. Responses redact credentials and bound evidence
text; a failed secret-provider read fails closed. Named-test ingestion retains its explicit
collection state until its dependent service is available.

### Code-health recommendation decisions

Overview shows at most three ranked open proposals. Conservative rules use reported 30-day
review evidence. Dated file touches and ordered test results remain collection proposals until
those sources exist. Refresh materialises derived proposal rows in the local database; it never
changes a decision, starts a seat, files a ticket or applies code or rules. Expired proposals become
inactive, while decisions and accepted metric baselines remain durable. Each proposal carries
its own fixed-30-day query and observed coverage, including category/file or PR filters.
Changing the dashboard window cannot substitute a shorter cohort for that evidence.

Read retained records with `GET /api/code-health/recommendations?repo=<id>&cursor=0`.
Pages hold at most 50 records. Both history and decisions require the operator token.
`POST /api/code-health/recommendations/<id>?repo=<id>` takes `requestId` (UUID), `basis`,
`expectedUpdatedAt` and `change`. Change actions are `accept` (owner, future reviewAt),
`dismiss` (reason), `snooze` (future until), or `assess` (paid-off/no-effect outcome, reason,
comparison, and an issued evidenceId). Assessment waits for the metric review date. It records
an explicit comparison, never an automatic claim of causation. Replaying a request ID returns
its recorded response; conflicting reuse and stale decisions return 409.

Accept leaves linked work pending and records a durable message for the configured repo's
FLIGHT. FLIGHT reads the recommendation, then uses its existing authorised `create_ticket`
path with `recommendationId`. That path retains engine, role, secret, breaker and Away checks.
It records the issue link before project updates, so a project failure cannot create another
issue on retry. The same call finishes a failed board handoff and preserves an existing card
status. A stable body marker recovers an issue whose creation response was lost, even after rephrasing.
The creation attempt is recorded before calling GitHub. If its outcome is uncertain and no
marker is found in the bounded issue list, the handoff stays pending for inspection; the
service does not risk a second issue. Partial recovery writes count toward the runaway breaker. Config/rule
changes still need their existing proposal and approval paths. No recommendation action
applies them directly. An unavailable FLIGHT leaves accepted work visibly pending.

**FLIGHT's own accept.** When `create_ticket` is given a `recommendationId` whose proposal is still
`proposed` and whose rule is in `CODE_HEALTH_FLIGHT_TIER_RULES` (packages/core `flight-model.ts`, a hard rule, so widening it needs operator clearance; today
`repeatedly-changed-large-file`), the hub accepts it for FLIGHT first: owner `FLIGHT (<seat>)`, review
date 30 days on, the call's `basis` as the reason, recorded in the flight decision audit with the
seat as actor. Any other rule is left proposed and the call is refused; the operator's token, typed
owner and date stay the only way to accept it. This is no new GitHub write.

**Unprompted audit work.** Once an hour (and a minute after start) the hub runs `runCodeHealthAudit`.
It records every merged PR in `code_health_merged_reviews`: how it merged (`crew-run`, `ended-run` or
`hand`) and the last review the hub reported for it (`reviewId`, null when none exists; a review that
lands later is linked on the next pass). It also re-measures each accepted proposal whose review date
has passed, once, against its accepted baseline, and stores the result as `remeasure`
(`improved`, `unchanged`, `worse` or `unmeasured`, with the baseline, current value and a note).
Re-measuring never ends the work; `assess` stays a manual, evidence-backed decision.
The recommendation history reply also carries `groups`: one-per-PR proposals (repeated review rounds)
with the same rule and cause (the PR's most common finding category) read as one group listing each PR.

Granted read-only FLIGHT/FAO sessions can call `mc code_health` with tab, optional window,
issued evidence/cursor, or a recommendation ID. The authenticated session repo bounds every
read. Tool responses use the same reader and credential cleaning as HTTP. Stored evidence and
proposal text is untrusted data. Decision actor, basis, response and linked work enter the
existing flight decision audit. The read tool cannot accept, dismiss, snooze or assess.


Mission Control is a local hub that watches the autonomous loops on this Mac. It reads their state
files, transcripts, usage limits and GitHub boards, and shows them in one web app, the HUD. In
phase 1 it **observes only**. Its one write into a loop's files is the TA loop's `PAUSE` sentinel,
which it writes only when you press pause or resume.

- Design: [`docs/superpowers/specs/2026-10-18-mission-control-design.md`](superpowers/specs/2026-10-18-mission-control-design.md)
- The HUD it builds: [`docs/prototype/mission-control-hud.html`](prototype/mission-control-hud.html),
  catalogued in [`docs/prototype/mission-control-hud-catalogue.md`](prototype/mission-control-hud-catalogue.md)

## Install

Requires Node 26 or later and pnpm. Run these from the repo root:

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

A Claude seat (FLIGHT's included) can state its `effort` (`low`, `medium`, `high` or
`max`); the hub passes it as `--effort`, and the Agent page shows it beside the model.
Omit it and the CLI picks its own default, which changes between CLI versions, so set it
for any seat whose cost or quality matters. Pair it with a template's `budget_usd` (see
Template profiles) for a hard per-run dollar cap. Choose `max` only where a comparison
shows a quality gain.

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

A loop can say how it is paused with `paused_by:` under `loops:`, either `{ stop_file: <path> }`
(paused while the file exists) or `{ issue: <repo id>#<number> }` (paused while that issue is open on
the board). The hub only reads it. A paused loop's issues and PRs stay on its card, which shows
"Paused by <repo>#<number>", and never count in Needs you. A TA loop is also paused by its `PAUSE`
file. The live config needs `paused_by: { issue: autonomy-engine#1818 }` on the paused loop (and the
studio loop's own setting, if it has one); without it the hub cannot tell the loop is paused.

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
    budget_usd: 12.50           # optional Claude spend cap per run; omit until you choose one
```

- **Routing.** The first profile with a label the ticket has wins. With none, Size XS or S takes `small-change`; anything else, or no Size, takes `feature`. FLIGHT (`start_seat`) and the planner (`report_plan`) may name another profile with `profile` and `profile_reason`; the choice is kept per ticket with its reason, and the profile keeps every check the routed one required.
- **Snapshot.** Each build or planner start copies the chosen profile, with a sha256 hash, onto its run. Editing the file changes later starts only. The file is read afresh on every start.
- **A file that cannot be loaded** refuses starts (502, or FLIGHT's refusal text) naming the problem; the hub keeps running. Fix the file and the next start works.
- **Limits.** The `tries` and `rounds` of the snapshot replace the defaults (3 and 3). The engine still judges the PR's combined CI; `checks` is briefed, not enforced one by one.
- **Dollar cap.** `budget_usd` is separate from the template's token `budget` and is passed to Claude as `--max-budget-usd`. Omit it to leave Claude uncapped. When Claude reaches it, the run uses the normal budget park and names the dollars used and cap. A working run parks at once; a run whose PR is already pushed keeps moving until the CLI ends. Unlike a token park, Resume refuses a dollar park: the Claude process keeps the cap it started with, so end the run and start the ticket again.
- **Seen.** The crew row's loop carries the profile name and the step for the run's phase.

## Reviews of controller and personal PRs

In a `merge` workspace, an open PR with no live or parked build run enters the existing scratch review
queue after its CI passes. That covers a PR whose build run has ended. The PR must come from the same
repository and target its default branch. Drafts, forks and PRs labelled `skip-review` are excluded.
A branch with a live or parked build run keeps its author-run review path. An `mc/review` status is
respected as another reviewer's when this hub has no review of that head.

The reviewer uses the exact head SHA. Before launch and before publishing, the hub checks the PR
again. A later push needs a new review; a closed, drafted, opted-out or changed PR cannot receive an
old verdict. Paused seats, account stops and capacity limits still govern reviewer starts. Queued
review data includes its PR, head and waiting reason even when the reviewer cannot start.

The hub posts `mc/review` and a report comment containing the SHA, findings and recorded checks and
tests. It links the available before/after screenshot manifest for that head, or states that no pairs
were captured. Web changes require the configured screenshot gate before queueing. Evidence uses
isolated previews and copied data; it never reconstructs a historical approval. Which pages a web change is photographed on comes from the static imports of the PR head's
`apps/web/src`: each file in `pages/` is a page (a lazy `import()` of it is the boundary), what
`main.tsx` and `App.tsx` reach counts for every page, and CSS belongs to the file that imports it.
A file listed with no photographed pages needs no pairs (for example, one reached only by the unphotographed Ticket page). A file the graph does not list, or a graph that cannot be read, falls back to the folder rule. Graph reads use a temporary archive of the fetched head, share one read per head, retry after failure and are cancelled on shutdown. A reviewer run is
recorded, but no developer run is invented for the PR.

A crew review that reports after its author's run has ended (or is gone from this hub) is posted the
same way, and the head is not reviewed a second time. When the hub holds a reported result it does
not post (a draft PR, a branch still owned, a PR it was never asked to review), it logs one line
saying why, once per review.

These PRs do not enter the crew's merge or board-completion path. Their controller still applies CI,
review, acceptance and repository merge rules. A failed review remains failed rather than repeatedly
starting paid retries. A new push creates a new review opportunity.

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

## PR flow API

`GET /api/prs/flow` requires the operator token. It returns every open PR grouped by repository,
with its next owner, current stage, age, waits, dependents and latest actor. FLIGHT reads the same
record at the start of every wake; the HUD panel uses it to explain delays.

The 24-hour and 7-day metrics use immutable merged-PR history. Stage timings total each PR's
recorded intervals in that stage, within the merged cohort; missing stage history stays unknown.
Rework counts blocking review reports, including earlier rounds, rather than CI retries.
Historical timings can lag late backfills by at most 30 seconds; new merges and window boundaries
invalidate them immediately. Live ownership and waits are read fresh on every request.
FLIGHT wakes after five unowned minutes, a stage's seven-day p90, or fifteen minutes waiting for
the controller or operator. Repeated polls do not reset stage clocks or repeat the same wake fact.

## Dependency chains API

`GET /api/dependencies?repoId=<configured repository>` uses the same operator-token check as
PR flow. It returns `DependencyChain[]`; omit `repoId` for all configured repositories.
An unknown repository returns 404 and an invalid query returns 400. This is the approved server
contract for the Dependencies Board, FLIGHT and QA builds. Those web readers ship separately.

The read joins stored ticket dependencies, stacked PRs, active holds, PR ownership and seat queues.
A PR reference continues through its carried ticket's waits. All open waits participate; work
with multiple roots appears under each, with its other roots in `alsoWaitsOn`. Cycles return
`stuck` with their refs. Unread or out-of-repository roots remain `unknown`.
The response retains all dependents; the web applies its five-dependent disclosure.

`waitedMs` and `longestWaitMs` use observed wait, hold or queue-transition times. An older run's
start is not evidence of when it entered a queue. Unknown ages stay null. Sort is longest wait
first, unknown last, then stuck first and ref. `frees` names only dependents whose last direct
wait ends with the root; grandchildren still waiting on intervening work stay in `stillWaiting`.
Ownership comes from PR flow or an active author; operator holds remain visible. A root without
an owner, closed without merging, or past its seven-day stage p90 is stuck.

Page reads never observe waits, change settings, release holds, call GitHub or write decisions.

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

The hub writes these JSON lines to `<data dir>/logs/server.log`, with owner-only file permissions.
Before the next record would exceed 20 MB, or on the first write of a new UTC day, it rotates the
file and keeps seven numbered archives (`server.log.1` is newest). A single record larger than
20 MB is kept whole in its own file. Rotation happens in the hub without a restart and works for
both launchd and manually started hubs. Each preview uses its own database's data directory.
If writing or rotation fails, records go to stderr, with one warning until writing recovers.

The launchd `StandardOutPath` and `StandardErrorPath` remain bootstrap/fallback logs. Existing
files in `~/Library/Logs/mission-control/` are preserved; routine hub logging no longer grows
`server.log` there. If you installed the older newsyslog entry that sends this hub SIGTERM, remove
that entry: the built-in rotation replaces it and does not need a service restart.

When a reported review is held back from GitHub, the hub logs one warning line saying why:
`External QA for <repo>#<pr> is not posted to GitHub: <reason>.` Search `<data dir>/logs/server.log`
for `is not posted` (the launchd files under `~/Library/Logs/mission-control/` do not have it). The reason covers
GitHub's own read of the PR too: closed, draft, labelled skip-review, another head, or a base that
is not the default branch.

External QA comments carry a compact index linking the immutable JSON and Markdown report.
Detailed checklist notes and dispositions stay in that retained report. The generated comment
still passes the secret, notifier and HTML-reference checks before its status is published.
Publication errors log a fixed, non-sensitive reason after `could not complete its queue/status
update`; unexpected exceptions keep their content private and log only the generic failure.

### Waste alarms

The hub spots spend that buys no progress, names the ticket, run or seat, and stops that loop. Pace
alone never slows honest work: the forecast "budget brake" is gone. An account stops only at its real
`stop_at` use. The weekly projection ("N% by reset") stays on the Overview Tokens panel as
information (`weeklyProjection` in `apps/server/src/spend/projection.ts`). An old config that still
sets `brake:` on an account loads; the key does nothing.

The checks are hub code over recorded runs, check runs and reviews (`apps/server/src/spend/waste.ts`).
No agent runs them. The scheduler's minute tick scans, so a restart storm shows within minutes. Every
threshold is in `WASTE_THRESHOLDS` in `packages/core/src/waste.ts`, once.

| Check | Fires when | Then |
| --- | --- | --- |
| Unchanged rerun | The same configured check runs again on the same commit with a clean tree (no file changed), by one run | The hook refuses the rerun and says why (Claude hook and Codex approval); each refusal is recorded. A rerun is refused once the newest result on that commit passed, or the last two both failed with an exit code, so one retry after a failure is allowed. A call killed by the Bash timeout, or a failure with no exit code, is not a result and may run again |
| Retry loop | A ticket has 2 failed attempts (a run that ended failed, or parked as stuck, refused, conflict, no CI or gate), or a run has 3 carry-on resumes and no report | Parks the ticket: no new start of it (the operator's and FLIGHT's start pass) |
| Review rounds | A change goes past 2 review rounds | Queued reviews of that change do not start |
| Restart storm | One agent starts more than 6 times in an hour | That agent's new starts are refused (FLIGHT's seat included) until the hour's count falls back |
| Cost without output | A ticket has cost over 3x the median cost of its size (recorded costs only, 3 merged tickets of the size at least) and has no merge | Alarm to FLIGHT with the runs listed |
| Coordination overhead | FLIGHT's recorded spend passes the developers' over a day (and is at least $10) | Alarm with the split; controller tokens are named, not priced |
| Ticket churn | Tickets opened reach tickets closed in a day (5 opened at least), a ticket reads as a half, slice or follow-up, or a parked ticket starts again | Alarm to FLIGHT naming the tickets |
| Runs per ticket | A ticket takes more than 3 developer runs without a merge | Alarm to FLIGHT with the runs and their blocking review findings |
| Failed review rounds | An open PR has 2 reviews that reported blocking findings or a failed verdict | Alarm to FLIGHT; reviews go on. FLIGHT's state also lists the count on each PR (`prs[].reviewRounds`) |
| Clearance waiting | A run has waited 2 hours on FLIGHT's clearance (a hard-rule PR, `awaitingFlight`) | Alarm to FLIGHT, once, with the hours waited. `GET /api/waste` lists it from 24 hours |

- `GET /waste` also serves `flight`: 14 rolling 24-hour buckets (oldest first, the last ending now) of
  FLIGHT's wakes, its `wait` decisions, and its tokens against every run's new tokens (`tokenShare`, null
  with no tokens recorded), so the change to activity-only wakes can be read before and after. A bucket
  is counted by when the wake, decision or run started.
- `GET /waste` also serves `counts`: the latest daily retrospective's tickets opened and closed, runs per
  ticket (tickets with runs, mean, busiest), review rounds (reported, failed) and idle seat-hours, over the
  retrospective's 24 hours; null before the first. `budget_unused` is a FLIGHT signal, not an alarm: a free
  build seat idle 30 minutes while its account's 7-day use is under 50% raises one fact per idle spell.
- One alarm per check and subject while the cause stands (`waste_alarms`). It closes when the cause
  ends: the ticket merges or closes, the count falls back, or the day passes.
- FLIGHT is woken once per alarm, through the `waste_alarm` signal, except an unchanged-rerun alarm:
  the hook has already refused that rerun, so Audit records it and FLIGHT is not woken. An alarm is
  not a question: it never reaches Needs you.
- FLIGHT lifts a hold with `resolve_waste_alarm` (alarm id and a basis, recorded in Decided without
  you). The alarm stays closed until its cause grows past the level it had. For a seat's or a
  repo's alarm (restart storm, coordination overhead, ticket churn) that silence lasts one window,
  not for good.
- A held start is not a fault: the engine keeps the card or the review queued and raises no
  question. Reviews of an external PR are never held by the rounds check.
- A hold only refuses or parks the hub's own runs. No GitHub write. A seat's live run is never
  killed by an alarm; the hold bites at the next start, resume of a review, or restart.
- `GET /api/waste` serves what the Audit page shows: for the past day and week, spend per merged
  change and the share spent on building (developer runs); every open alarm; and, per check, its
  threshold, how often it fired in the week and how many of those later saw a merge. A cost is
  `null` where no run recorded one, never zero or an estimate: Codex runs record tokens but not cost,
  so each window lists every vendor's runs, runs with a recorded cost, cost and tokens, and the
  tokens figures (`perMergeTokens`, `buildingShareTokens`; new input, output and cache-write tokens)
  cover both vendors. The dollar figures cover only the runs that recorded a cost.

### FLIGHT runaway breaker

FLIGHT has no hourly, per-run or per-ticket caps on what it does; it makes judgement calls. One
breaker stops it when it loops. It counts every successful FLIGHT write call (the tool and what it
acted on), whether or not the call leaves a row in Decided without you. It trips when FLIGHT makes
more than 200 of them in an hour, or the same tool with the same arguments (a queue reorder: the same ticket) 5 times in 30 minutes. FLIGHT's own bookkeeping (`track`, `untrack`, `log_decision`, `update_brief`, `remember`, `forget`) counts toward the hourly total but never trips the repeat rule; focus reads and a ruling still pending are reads. FLIGHT's Comms messages, a close that is left unconfirmed and `screenshot_hud` count too. While it is tripped every FLIGHT
write is refused with the breaker's text (reads still work), the trip is logged in Decided without
you, and one flag appears in Needs you. Operator holds, budget and account stops, secret
redaction and the git safety rules are not affected by it and stay as they were.

Look at what FLIGHT was repeating in Decided without you, fix the cause, then lift the breaker by
dismissing its flag in Needs you, or with `curl -s -X POST 127.0.0.1:7420/api/flight/runaway/lift -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{}'`. The lift is logged and clears the
flag and starts the count afresh, so the calls that tripped it do not trip it again; it answers 409
when the breaker is not tripped. `flight_state` shows `breaker.tripped`. While it is tripped the hub
sends FLIGHT no wakes (it could only idle), and the wake facts list the breaker.

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

### Ticket history

The response also carries `questions` and `questionsNextBefore`. These are a separate question
page, newest ask first (id breaks timestamp ties). The same `limit` applies; pass the returned
cursor as `questionsBefore` to read older questions. This leaves the existing timeline's `before`
and `nextBefore` unchanged. Question records include run, seat, text, ask/pass/set-aside times,
`closedAt`, and the latest recorded `answer`, `answerAt` and `answerBasis`. A run can close a
question without answering it: the answer fields then stay null. `discussionKey` is the question's
`ask:<id>` key when it has a stored conversation, otherwise null; read that conversation through
`GET /api/attention/<discussionKey>/discussion`. `asideAt` retains the stored set-aside time,
including Not now; it does not itself prove a question has an answer. Each Comms
timeline entry carries its recorded `senderKind`, or null for legacy unknown provenance.

`GET /api/comms/ticket-counts` returns `{ tickets: [{ ticket, count }], unassignedCount }` across
all recorded structured references, without the feed's 100-message or time window. Retention
preserves reference totals transactionally when deleting message bodies, without preserving
their text. Totals survive a database reopen and repeated retention sweeps. Already deleted
messages from before this migration cannot be reconstructed. Tickets with
no attributed messages have no row. Qualified ticket identity takes precedence over a PR/short
reference. Legacy short references use the sender's configured repository, or the single
configured repository; ambiguous multi-repository messages stay in `unassignedCount`. PR
references resolve from stored primary and closing tickets, counting a message once per ticket.
Counts do not infer references from free-form message text or invent missing repository context.

The stored Comms agent and pair reads accept the hub id `MC` and the controller id `CONTROLLER`.
Contact summaries include `hasMessages` from their all-time count. The configured FLIGHT and
controller pair appears even before its first message, with count zero and `hasMessages: false`.
Unknown agent ids still answer 404; existing paging and read cursors are unchanged.

`GET /api/tickets/<repo id>/<number>` returns everything Mission Control knows about one ticket:
its fields (title, outcome, done-when items with their ticked state, size, priority, status,
labels, GitHub URL), every run on it (seat, phase, times, tokens), its PRs with each review round's
findings and how later rounds resolved them, the checks of each head, and one timeline, newest
first, of runs, review rounds, CI results per head, FLIGHT decisions and Comms messages that name
the ticket. The timeline is paged: `limit` (1 to 200, default 50) and `before`, the `nextBefore`
cursor of the previous page; `nextBefore` is null on the last page. The body, outcome and
done-when items are read live from GitHub; if GitHub does not answer, the rest still comes back
with `body: null` and `githubError` saying why. Every lookup uses a ticket index, so a long
history never scans a table. It is read-only and needs the operator token like the other reads.

### Page-load budget

Every HUD page's first load stays under 500 KB gzipped, and no single response is over 300 KB
or takes a second to build. `apps/server/test/response-budget.test.ts` builds each page's
first-load responses from a large fixture and fails above those numbers; run it alone with
`pnpm -s vitest run apps/server/test/response-budget.test.ts` (it prints each response's size and
build time). It also runs with the server suite in CI. The routes, paging parameters and summary
shapes are in `docs/hud-response-budgets.md`.

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
  answers it or briefs it for you, and only a briefed question reaches your Needs you. A seat
  that is blocked outside its area, needs a decision it cannot make or disputes a finding calls
  FLIGHT with `mcp__mc__call_flight { reason, ref }` (below). While FLIGHT
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
  `GET /api/comms/open` lists these items with their text (first 280 characters) and also lists
  each seat's open `ask_flight` question as a question to FLIGHT (id `ask:<n>`). A seat question
  follows FLIGHT's triage window (20 minutes from the later of the ask and FLIGHT going live),
  not the 15 and 45 minute Comms steps; with no FLIGHT seat, or once FLIGHT has passed it to the operator, its `nextStep` is `operator`. A `seen` reaction
  from the addressee closes an item, as a reply does; a `seen` from anyone else does not.
  `GET /api/comms/feed` lists recent messages (id, time, from, to, label, ref, and the first 280 characters of text) newest
  first. `since=comms:<n>` returns only newer ones; `limit` defaults to 100 and is at most 200.
  An overdue crew question stays with FLIGHT. The hub does not write a Proceed/Hold brief or
  answer it for the operator. Only FLIGHT's complete brief makes it an operator question.
  Old hub-written Comms briefs remain in history but are ignored by the attention projection.
  When FLIGHT is down, waiting crew messages count under one FLIGHT-down/not-triaging alert.
  Protected operator approvals, account and budget holds, and the runaway alert keep their own rules.

  The Comms graph also reports 24-hour run-token totals per link and flags a pair
  that exceeds six reciprocal rounds on one ticket, including when FLIGHT stepped in.
- **Short Comms.** Messages are limited to 1,200 characters. Put complete findings, plans and
  evidence in `report_findings`, `report_plan` or `report_evidence`, then send Comms a short
  pointer. `GET /api/comms/metrics` reports each sender's p95 message length over the shared
  24-hour range.
- **Hub notices.** Every message the hub writes itself is stored with sender kind `hub` and kind
  `notice`. A notice is never unread, and `?notices=hide` on `GET /api/comms/crew`,
  `/api/comms/flight` and `/api/comms/agents/:id` leaves notices out of the page, its counts and, on the agent route, the contact list (a contact
  that only sent notices is dropped).
  The Comms copy of a CI failure is one line with a link, such as "CI failed on 341f108 in job
  web-core. https://github.com/o/mc/commit/<sha>/checks"; the seat still gets the whole log
  excerpt, with the failing test and its error.
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

  Your whole home folder is denied to code a seat runs (#487), and only these paths inside it are
  re-allowed for reads: the seat's worktree and its clone's git dirs, its temp dir and the pnpm
  store, the install folders of the hub's node and of the `node` and `pnpm` on its `PATH`,
  `~/.gitconfig`, git's `~/.config/git/{config,ignore,attributes}` and `crew.allow_read`. The
  credential folders above stay denied even if an entry would cover them. Browser profiles and
  `~/Library/Application Support` are unreadable. A repo whose tools read other files in home (a
  global npm or pip config) lists them under `crew.allow_read`.

  The file tools are confined to the worktree already. What stays readable:
  - outside home: system folders such as `/usr` and `/opt`, and the folders above;
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
- **The guard hook** before every tool call, after each Bash call ends, and when the seat stops:
  `'<crew.node>' --experimental-strip-types '<hub>/apps/server/src/guard/hook-cli.ts' '<token file>' 'http://127.0.0.1:<port>/api/guard/check' || exit 2`.
  `crew.node` defaults to `/opt/homebrew/bin/node`. A start is refused if one of those paths holds
  a `'` or a line break.
  - **A Stop is continued in-process** (#1048). When a Claude seat ends a turn with its report
    missing (`report_evidence`, `report_findings` or `report_plan`, by the run's loop kind), no
    open question, and unfinished items in its live checklist (the run digest's tasks), the hook
    answers `{"decision":"block","reason":"…"}` with those items, and the seat carries on without
    a new hub turn. Only a run whose loop is still working is blocked: one in review, in CI, parked
    (a budget hold included) or done owes the seat no work now. A Stop with no verdict from the hub
    (hub down, a 401 or 500, the hook's deadline) lets the stop stand: its command ends `|| true`
    and the hook prints `{}` and exits 0, because exit 2 from a Stop hook would block the stop for
    as long as the hub is away. At most three Stops per run are blocked, counted from the last report the loop
    took in (a rework round gets its own three); the fourth stands, and the hub's carry-on resume
    and its "stopped after 3 carry-on resumes" park apply as before. The count is in the hub's
    memory, so a hub restart gives a run three more. Codex seats have no Stop hook and keep the
    hub's resume path.
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
  whose bulk never reaches the model. Codex seats are not covered. What bounds a shell result, and the cap decision, are in `docs/runbooks/shell-output.md` (#1642). The 32 KB, 8 KB and 4 KB
  limits are `TOOL_TRIM_OVER`, `TOOL_TRIM_HEAD` and `TOOL_TRIM_TAIL` in `packages/core/src/tool-trim.ts`.
- **A per-run token** for both, in hub memory and in two 0600 files beside the run's transcript:
  `{DB dir}/crew/<run id>.token` and `<run id>.mcp.json`. The sandbox cannot read them, and argv,
  env and settings carry only their paths. When the process exits, for any reason, the token is
  revoked, the run's test-lock hold is freed and both files are removed. A resume gets a new token.
  Files left by a hub that went down, these and any draft PR body file (`pr-<uuid>.md`), are
  removed when the next one takes the crew lock.

## Moving a hub to a new Node

Do this when other software shares the machine's Homebrew Node. `brew upgrade node` changes that Node
for everything on the machine, and a service with a native module (such as `better-sqlite3`) fails on
its next restart. This way changes only the hub and its seats.

1. Unpack the official tarball from nodejs.org in its own folder, and check it against `SHASUMS256.txt`.
   Keep it out of the hub's data directory (by default `~/.local/share/mission-control`): a seat's
   sandbox can't re-allow a folder inside it. `~/.local/mc-node/<version>` works.
2. Boot a preview on it, with a copy of the database and the config (see "Run", using the new `node`
   in that command). It must answer.
3. Keep a copy of the plist. In `~/Library/LaunchAgents/com.missioncontrol.server.plist`, set the first
   `ProgramArguments` entry to the new `node` and put its folder first on `PATH`. In `config.yaml`, set
   `crew.node` to the new `node`. Seats pick up `node` and `pnpm` from that `PATH`. Use `PlistBuddy`, not
   `plutil -replace`, which inserts a new array entry and leaves the old one as the script to run:

   ```sh
   plist=~/Library/LaunchAgents/com.missioncontrol.server.plist
   cp "$plist" "$plist.bak"
   /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 <node>" "$plist"
   /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:PATH <node folder>:<old PATH>" "$plist"
   /usr/libexec/PlistBuddy -c "Print :ProgramArguments" -c "Print :EnvironmentVariables:PATH" "$plist"
   ```

4. Restart the hub when no seat is starting. A seat mid-turn keeps working through the restart and the
   new hub attaches to it (`docs/spikes/2026-10-22-seat-survives-hub-restart.md`); it stays on the old
   Node until its run ends, so keep the old Node installed. A `launchctl kickstart` does not re-read the
   plist, so run `launchctl bootout gui/$(id -u)/com.missioncontrol.server`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.missioncontrol.server.plist`. `bootout`
   can return before the old process has exited. If `bootstrap` answers `Bootstrap failed: 5`, launchd
   is still removing the old job: try again after a second, until it succeeds.
5. Check that the hub answers and `ps` shows the new `node`. Start one seat and run its checks.

To go back, restore the plist copy and the old `crew.node`, then repeat step 4.

## Setting up another machine

These steps take a second Mac from nothing to a hub running crew on a board that another
machine's hub also works. Do them in this order; the sections they name have the detail.

1. **Toolchain.**
   - Node 26 (LTS), the release CI and `engines` match. Node 25 is past end of life (1 June 2026)
     and gets no security fixes. `brew install node` installs the current release at
     `/opt/homebrew/bin/node`; check with `node -v` that it is 26 or later. If other software on the
     machine needs its own Node, keep that one and install 26 beside it instead: step 6 covers the
     hub, and "Moving a hub to a new Node" covers the swap.
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
   is not at `/opt/homebrew/bin/node`, give its path in three places before `launchctl bootstrap`:
   - the plist's first `ProgramArguments` entry. Without it launchd cannot start the hub:
     `launchctl print gui/$(id -u)/com.missioncontrol.server` shows
     `last exit code = 78: EX_CONFIG` and both logs stay empty;
   - its folder at the front of the plist's `PATH`, since
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
- **GitHub:** no `gh` at all; GitHub goes through Mission Control. A seat rewrites its own open
  PR's body with `mc pr_body { body }` (the same text checks as the opened PR; the engine's
  minor-findings section is kept; refused for a PR that is not the run's).
- **Attached work:** no `&`, `setsid`, `coproc`, `nohup … &`, a multiplexer that starts a session
  (`tmux new`, `screen -dm`; listing, attaching and `send-keys` into an existing one are allowed) or
  a scheduler or launcher (`at`, `batch`, `crontab`, `launchctl`, `osascript`, `open`).
- **Full suites:** the repo's `full_suite` commands take the shared test lock, one seat at a time. So do the repo's `mc.checks` commands (lint, typecheck): a check waits its turn like the suite, so the push gate never puts more than one heavy check on the Mac at once. A check that waited is not recorded as failed. The hub keeps, in memory, why it did not count a check call it saw start (a pipe or extra command in the chain, a dirty tree at the start or end, the head moving, the turn ending first, a background call, a call killed at its Bash timeout, an unreadable clone), and `mc push` puts that reason in its refusal; with no reason it says the hub saw no start (it may have restarted). A related-tests run can take most of the suite's time, so a seat runs a check in the foreground with the Bash `timeout` parameter at 2700000 (45 minutes; the seat's `BASH_MAX_TIMEOUT_MS` allows it, and the CLI's own limit without it is 10 minutes): the default is two minutes, and a killed call has no exit code. The wait for the lock is not part of that time. A seat holding the lock is shown as stalled only after 10 minutes of silence since it took the lock; a running Claude check writes a heartbeat every 30 seconds. A seat waiting for the lock is refused after 10 minutes and runs the same check again, unchanged. A passing call that ran longer than two minutes is recorded like any other.
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

- **Report.** A shell response with a session id is a yielded command, not a completed check.
  Poll that session until it supplies a final numeric exit code. `report_evidence` refuses while
  a configured check is still running or its completion receipt is being validated, without
  saving evidence or starting a push. If polling is refused, report the blocker rather than a pass.
  The push gate still requires passing checks on the clean current commit.
  The seat commits, then calls `report_evidence` with a note and one `doneWhen`
  entry for each line of the ticket's `## Done when`: `met` with its evidence (a test name, a file,
  a measurement) or `not_met` with the reason. The hub took those lines from the ticket when the
  run started, and refuses a report that leaves one out, quoting it (a run started before this
  rule has none and owes none; a `Ruling:` note owes none). RETRO's brief carries the latest
  table and starts from it: lines marked met whose evidence does not hold, and lines marked not met
  without an accepted reason. The engine pushes and opens the draft PR (or pushes to the run's PR
  on a later report), then waits for CI.
- **CI.** A failure goes back to the seat as a log excerpt, twice; the third failure parks the
  run. A pass raises "Ready for review" in Needs you. Review fixes go to the seat by message: it
  commits and reports again, and the engine pushes to the same PR.
- **Parked.** Any limit parks the run with a Blocked note (and, in a `merge` repo, the card in
  *Blocked*). Your next message to the seat resumes it; the seat then needs a new commit, or a
  note starting `Ruling:`, before it can report again. A run parked because its PR was closed
  does not resume.
- **Conflict with main.** A PR in CI that conflicts with main sends its seat one line (per pushed
  sha) to call `mc sync_main`, resolve, commit and report; the run goes back to working, not to the
  operator. Only a seat already told for that sha, or with a merge of main under way, parks on the
  conflict. A run parked on a conflict accepts the seat's report of a new commit (a merge of main)
  and goes back to CI by itself once the pushed head shows on a PR that no longer conflicts.
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
   none. *In review* means a review is queued or running: once a review reports blocking findings
   the card goes back to *In progress* with its seat (rework), and to *In review* again on the
   next push or re-review. If the run ends first, the card goes to *Ready*. The pipeline cards
   carry `rework` (round, blockers, seat, whether the seat is running) while the newest review
   of the PR's head is blocking; the PR-following move never puts such a card back In review.
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
- **`repos[].keep_branches`** (default `[]`) lists branches the hub never deletes, on top of the
  default branch and `archive/*`: an exact name, or a prefix ending in `*` (`release/*`). See
  "Branch tidying". A change needs a hub restart.
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
- **`crew.allow_read`** (default `[]`) lists absolute paths (`~` allowed) inside your home folder
  that code a seat runs may still read, such as `~/.config/pip`. An entry that is or holds the home
  folder, or is, holds or lies inside a credential folder, is refused at start-up
  (`crew.allow_read: <path> …`). Applies after a restart; it is read-only and holds for read-only
  seats too.
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
  that changed on disk but only apply after a restart, such as `loops`, `crew.deny_read` and `crew.allow_read`.
- `curl -s 127.0.0.1:7420/api/crew/changes` shows the same picture without reloading.
- Setup › Sessions (#22) will use both from the HUD.

### Before the first crew push

List your own working folders under `crew.deny_read`, then restart the hub. Agent-run code cannot
read your home folder beyond what a seat needs (see "First crew"), but can read other folders
outside it. The secret scan is the only backstop for anything a seat copies into
its branch, and it has limits (below).

### Landing a change to a protected file

The protected files are build, install and CI config: `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `vite.config.*`, `vitest.config.*`, `biome.json`, `tsconfig*.json`,
`.github/`, `.husky/`, `.claude/`, `.npmrc`, `.pnpmfile.cjs`, `.gitattributes` and `.gitmodules`.
Seats cannot change them:
- Edit and Write refuse them;
- a commit that holds one is refused whole;
- the hub won't install from a branch that changes an install input.

When a ticket needs such a change, a seat can make it under a path grant (next section). Otherwise
land it outside the crew, in one of two ways:
- **by hand:** change it in your own checkout and open the PR yourself;
- **a controller PR:** have the head agent, working outside the crew under your eye, open it.

Once it is merged, start the seat's run, or a new one. A run branches from origin's default
branch as it was when the run started.

### A ticket that changes files outside every area: a path grant

A ticket whose change sits outside every seat's area (the root `package.json`, `.gitignore`,
`CLAUDE.md`), or in a protected file, lists the files in a `Paths:` line:

```
Paths: package.json, .gitignore
```

A start of that ticket is refused (422) until FLIGHT has approved the files: `mc start_seat { seat, issue,
paths, basis }` logs a `grant` decision ("Approved mc#7 to write package.json") and then starts the seat.
Every start path checks it, FLIGHT's, the engine's and the operator's.

- The run may write exactly the listed files that sit outside its area or are protected, for that
  run only. Another run on the same seat holds nothing it was not given. The grant is fixed when
  the run starts; editing the ticket later changes nothing.
- It covers the Edit and Write tools, the `mc commit` check, the push's stray check and the Codex
  write floor. Every other protected file and every other file outside the area stays refused.
- Only a file at the repo's top can be granted when a protected-file rule covers it (`package.json`
  yes, `apps/web/package.json` no). `.github/`, `.husky/`, `.claude/`, `.codex/`, `.npmrc`,
  `.pnpmfile.cjs`, `.gitattributes`, `.gitmodules` and `.git` are never granted.
- The merge gates do not change: a hard-rule path in the diff still needs FLIGHT's clearance (or the
  operator's, on a repo that keeps it) before merge, and the hub still won't install from a branch
  that changes an install input.

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
configured review-round cap, optionally adding a short fix list, as many as it judges right (each grant
gives the head one more blocking review before the run parks again). A rework for a run set aside while its seat is
on another run is queued in Comms and delivered when the seat is free, as the message route below does.

This accepts the parked run:
- **A ruling or review-failed park:** the run goes to review.
- **A review or review-ruling park:** the run goes to review, and its findings on that head are waived.

The route answers 409 when the engine is off, or when nothing was lifted. The 409 names the check that refused: the park is gone or ended, the PR is closed or not open, the head moved, the run is held, or a blocking review touches floor-enforcing paths that cannot be accepted past. FLIGHT's `settle_park` refusals name the same reasons. Past that blocking review FLIGHT uses `second_review` (below) or sends it for rework.

### Rework a parked run

To send rework text to a set-aside run that is parked on review findings, use:

```sh
curl -s -X POST localhost:7420/api/runs/<run id>/message -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{"text":"Please address the findings."}'
```

The text waits for that run (it is not sent to a newer run on the same seat). The route resumes only
`review` and `review-ruling` parks into working, without waiving their findings. Other park kinds are
refused; use the explicitly named resume route above only when accepting a review waiver is intended.

### Recover a preserved crew PR

An author at its account stop starts no more work. Its already green, independently reviewed PR
can still receive FLIGHT's clearance and merge without waking the author. Explicit operator Stop,
crew pause, budget parks, operator questions, merge holds and the ordinary QA and CI gates remain.

When the controller has continued a crew PR on its preserved branch, the controller or operator
can adopt its actual published head with
`POST /api/runs/:id/pr-head { "sha": "<full published SHA>" }`. The ordinary operator or controller
credential is required; seat tokens and FLIGHT's operator tool cannot make this recovery. It applies
only to a same-repository, open, non-draft PR in a superuser merge workspace, at the freshly verified
GitHub head and original branch. It refuses an active author, a dirty or unreadable worktree, a
paused or explicitly stopped run, any park and any merge hold. A working run must be preserved aside.

Adoption records the source as the run's push, clears old-head waivers and clearance, and returns the
run to CI. It creates no check receipts, changes no checkout and starts no author. Fresh CI and
independent QA on that head are required; FLIGHT then gives its normal head-bound merge clearance.
An account stop still prevents the author from waking if rework is needed. The controller action
is logged as a sync decision. A repeated request for the same adopted head makes no second adoption.

### Accept or send back a PR at UAT

A repo whose rules set `uat` (labels, paths or both) keeps the engine from merging a matching PR until
you accept it. When the PR's review is clean and CI is green, the run parks as `uat`, "waiting for
your acceptance on <head>" with the label or path that matched. It shows in Needs you, on the Board
card and on the PR chip. If the diff cannot be read, the PR waits too. Look at the work, then:

```sh
curl -s -X POST localhost:7420/api/prs/<repo id>/<pr number>/uat -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{"action":"accept","sha":"<full reviewed head sha>"}'
```

`accept` lets the engine merge on its next pass through the usual gates (hard-rule clearance, holds,
the rest). It is tied to the head you looked at: a later head waits again. `send_back` needs a
`"note"`; the seat gets it as the first line of a new rework round. After its next push passes review
and CI, the PR waits again. FLIGHT cannot clear this wait: `merge_pr` and a plain resume refuse it.
It applies to repos where the engine merges (`merge` workspaces).

### Record a controller check

A ticket with a controller-check heading (`## Controller check`, or a near spelling: another level,
"Checks", a suffix) is never merged by the engine until you pass it. When the run's review is clean
and CI is green, the run parks as `controller-check` with that section's text (cut to a short brief;
the ticket has the rest). FLIGHT does the check, and the park is FLIGHT's to clear. Once a ticket has listed a check, a pass is
needed even if the heading is later removed. If the ticket cannot be read, the run parks the same way
after three tries, saying so. Do the check, then record the verdict for the head you looked at (FLIGHT uses `mc operator`; the operator may use the route):

```sh
curl -s -X POST localhost:7420/api/runs/<run id>/controller-check -H 'content-type: application/json' -H "x-mc-operator: $(cat <data dir>/operator-token)" -d '{"verdict":"pass","sha":"<7 or more characters of the head>"}'
```

`pass` applies at once and lets the engine merge on its next pass. It is tied to that head: it is
refused if the PR head has moved, and a later head, including the engine's own merge of main after a
pass, needs a fresh check. `fail` needs a `"note"`, sends it to the seat as rework and ends the park.
A plain resume or message does not lift this park: only a recorded verdict does, and on a superuser repo FLIGHT's `mc operator` call records it on any path. On a standard repo FLIGHT may not record it for changes to its own runtime or approval rules. A paused seat's verdict is
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

FLIGHT has the same power with `mc hold_pr { runId, action, reason, basis }`, logged
as a decision. FLIGHT may release only its own hold: one set here is released only here. The controller
may replace or release any hold. The route answers 409 when the engine is off, the run has no open work
to hold, or the hold is the controller's and the caller is FLIGHT.

### FLIGHT's wakes: reasons, calls, accountability and pace

The watch checks every 5 minutes (and 20 seconds after a change) and wakes FLIGHT when a reason is new.
Besides the older reasons (questions, items, free or stopped seats, parks FLIGHT may lift, PRs awaiting
it, red main, flaky checks, hub errors), the sweep raises these signals, each told once.

Routine pipeline steps do not wake FLIGHT: a PR's CI turning green, a review queued or finished, a
merge queued or done, a PR ready to merge, a park the engine clears alone, and a review that has waited
under 10 minutes for its seat. They stay in `flight_state` (prs, mergeQueue, seats, reviewQueue) and
wake FLIGHT only when a timed rule below says they have stood still (`old_park`, `merge_stalled`,
`idle_seat`, or idle review seats with a review queued 10 minutes). Nothing re-wakes FLIGHT on a timer: it
wakes only for activity (an operator message or tag, a seat's question or call, a hub check it could not
settle, an error in its own work, a merge or clearance only it can give, a fact it waited on changing, a
`wait_on` deadline passing), plus the daily retrospective. Work that still waits on it, with no fact changed,
stays silent. Each wake stores its reasons (the fact categories, e.g. `q`, `signals`) on the run; `GET /api/flight` returns `wakeHistory`: wakes
by reason and by hour over the last day.

**A free seat with open tickets (#1451).** The hub checks this itself, with no FLIGHT tokens: a free
build seat, open tickets near its area (all open tickets, not only the 30 the digest lists; Backlog, Refinement or Ready; an area label that is the seat's,
or none or several, which need triage), and no `wait_on` on the seat or the ticket. A ticket with no
board status counts as work to triage, and the wake says how many. Each seat is timed on its own. Once a seat has stood 10 minutes the
`idle` wake fact names it, one value for the whole idle spell, so FLIGHT is woken once, at 10 minutes, and not again for
that spell (it is woken again when the seat starts and goes idle again). An empty Ready with a free seat is a reason to promote, not to wait. The hub records when each seat's
spell began in the `flight.idle-seat` setting, and counts the time while FLIGHT is in a turn or rate limited. Each 30-minute period over the first one writes a hub log
line, `flight watch: seat idle: <seat> <N> min with <K> open tickets; why: <reason>`.
The wake text tells FLIGHT to go round a wait on a person, take other work or decide; only money,
direction, irreversible actions and security exceptions go to the operator, parked with a brief.

| Signal | Raised when |
|---|---|
| `idle_seat` | a seat is idle 10 minutes with startable work queued |
| `idle_no_work` | a build seat is idle 5 minutes and Ready holds nothing startable for its area and lane (for example only another lane's tickets); the evidence names the seat and its area, and FLIGHT promotes work for it. At most one per seat per hour |
| `budget_unused` | a free build seat is idle 30 minutes while its account has used under 50% of its 7-day window; the evidence names the account and its weekly use. Once per idle spell |
| `old_park` | a run has been parked for 15 minutes |
| `push_unseen` | a run parked on "the push or PR has not shown up on GitHub" for 30 minutes; before that the engine lifts it alone the pass the stored PR's head is the pushed sha, so it is digest-only and never `old_park` |
| `merge_stalled` | a PR its run reported green and reviewed has not merged for 10 minutes |
| `item_stale` | a Needs-you item for FLIGHT has gone 10 minutes untriaged (a PR ready to merge is `merge_stalled`) |
| `run_no_pr` | a build run ended (crashed or not) with a ticket and no PR, within the last day, and not already a missing report |
| `controller_unanswered` | a FLIGHT decision carrying "For the controller:" has had no Comms message from CAPCOM to FLIGHT for 15 minutes (a brief or wait on the decision's ref handles it too) |
| `wait_over` | a `wait_on` time has passed |
| `seat_call` | a seat called FLIGHT |

**Call FLIGHT.** `mcp__mc__call_flight { reason, ref }` is offered to every writer and read-only seat but FLIGHT (a
review's scratch seat answers with `report_findings` alone; the seats' briefs say when to use it). It only queues a `seat_call` signal and nudges the watch, so FLIGHT wakes
within the debounce, always inside one tick, with the seat's reason in the wake. It writes nothing of
FLIGHT's: FLIGHT decides. The same seat, ref and reason is one call until FLIGHT has been told; a repeat after that is a new call. `ref` defaults to the
seat's ticket.

**Accountability.** The watch keeps the reasons each wake listed. When FLIGHT's turn ends it checks each:
a reason is handled if its fact is no longer true (the question answered, the seat started, the park
lifted), or FLIGHT recorded a decision since the wake that names its target (the ref, seat, run or
question id, or the key such as `ask:12`, in `ref`, `seat`, `about` or `decision`: an act, a brief, a
note or a `wait`). FLIGHT is not woken again for the reasons not handled: the watch raises one operator
item (Needs you, key `flight:left`, the operator's own, never FLIGHT's to triage) listing them. The item clears when
every reason it lists is handled, not when some later audit is clean. The audit lives in the hub's memory: a restart drops it.

**Wait.** For a reason FLIGHT cannot act on yet: `mcp__mc__wait_on { target, on, until, basis }` records a
`wait` decision on the target (handled). The wait silences that fact until its value changes (a new head
SHA, a stage change, a run ending), and wakes FLIGHT at `until` (at most 7 days) with `wait_over`. A `wait_over` signal's id passed back as the target waits on the original target again, so the key
never nests. An ended wait stays in the digest until FLIGHT deals with it: a decision made after it ended that
names the signal key (`wait_over:<target>:<until>`) or has the target as its ref or seat, or a new `wait_on` on
the target. The hub then drops the wait. The same pass clears waits nested before this rule.

**What a free seat or an item wakes.** A free build seat, and the Ready tickets listed with it, wake FLIGHT only when a Ready ticket is in that seat's area (one `area:` label the seat covers, not held by another login). A seat or ticket FLIGHT recorded a `wait_on` for stays out until the wait is due. An item wakes FLIGHT only while it is new to it: once a wake or `flight_state` has shown the item, it wakes FLIGHT again only if its text changes. `GET /api/flight` `wakeHistory.idle` counts the day's wakes with no decision within 4 minutes (`flight_wakes` joined to `flight_decisions`); the target is under 15% of `total`.

**Ledger pointers and wake ids.** A ledger entry can carry `pointers` (`mc track`): each names a `pr` or `ticket` (`repo#n`), a `seat`, `repo`, `person` or `metric`. They live in `flight_pointers`, so a restart keeps them. The hub marks a pointer when its target changes: a stored PR's state, head, CI, review or draft flag, and a card's column or close. No agent runs for that. The wake digest's `moved` lists the pointers marked since FLIGHT last read them, once each; delivering a wake, or a `flight_state` read, stamps their `read_at`. Changes are ordered by a counter (`changed_seq`, `read_seq`), not by clock, so a change the poll stamped before FLIGHT's read still counts as unread. `track` refuses a target the hub could not mark: `<repo id>#<n>` for a pr or ticket, a seat in the session, a configured repo id, a GitHub login, a metric id. The store holds seat, repo, person and metric pointers too, but no hub event feeds them, so `track` accepts only `pr` and `ticket` pointers. The digest lists at most `FLIGHT_MOVED_LISTED` moved pointers (the rest wait, unread, for the next wake) and leaves out a PR pointer whose PR the digest's `prs` already lists and whose change `prs` shows (opened, a state, a new commit); that one is read with the wake. CI, review and draft changes are not in the `prs` entry, so they stay in `moved`. Each wake has an id, `<runId>:<n>` (0 is the start brief), kept on `flight_wakes.wake_id` and on every decision made in it (`flight_decisions.wake_id`).

**Pace.** FLIGHT has no wake on a timer. It wakes for a changed fact, a seat's call or a deadline on one fact (a `wait_on`, a planned entry, a PR-flow time, an idle seat's next period, the end of the batch window), and for the daily retrospective. The next wake time in `/api/flight` is the soonest such deadline, or none.

### FLIGHT adds a controller check to a ticket

Seats have no tool to edit an issue body, so FLIGHT puts a check under a ticket's `## Controller check`
itself: `mc add_controller_check { issue, item, basis }`. It appends `- <item>` under
that heading, creating the section before `## Size`, `## Security` or the end when the ticket has none, and
removes an identical line from `## Done when`. Nothing else in the body changes. The engine then parks the
run's PR until FLIGHT records the check's verdict (`POST /api/runs/:id/controller-check`). It refuses a closed ticket,
a cut body, an `always_ask` or other-lane card, and Away; an item already listed writes nothing. It only
ever adds a hold, and is logged as a `card` decision.

### What a ticket waits on

The hub reads one list of waits per ticket (`ticketWaits` in `packages/core/src/dependencies.ts`) from
three places: GitHub's "blocked by" links, `Depends on #N` and `After PR N` lines in the issue body (the
poll stores them on the board card as `after`), and a PR whose base is another open PR's branch (the poll
stores the base on the PR). A dependency ends its wait only
when it merged: a closed issue counts when a merged PR carries it (or, with no PR row left, its card is in
Done); one closed with its PR unmerged, or an `After PR` that closed unmerged, keeps the wait and shows as
"closed without merging" for FLIGHT to re-plan. A named PR the PR pages left out is read by number on the
board poll; until it is read it counts as a wait.
Every start path applies it: the engine's deal, a hand Start, FLIGHT's `start_seat`, `promote` and the
queue reorder. The refusal names the wait and where its PR is ("waits on mc#1015 (PR 1033 in CI)").

When the last wait of a ticket ends, the engine (each tick, `engine/dependencies.ts`) moves it from Blocked
to Ready if it is otherwise complete (one area label, Done when, Size) and tells each of its open PRs' runs to
merge main, once each. A step that fails or is refused is tried again after five minutes, for a day. FLIGHT's
wake lists the freed tickets ("mc#1015 merged: mc#1139, mc#1142 unblocked"), and `flight_state` and
`GET /api/flight` carry `blocked`: each waiting ticket with its waits, its chain to the root and the minutes
it has waited. A chain that has stood still for 30 minutes raises a `chain_stalled` signal, which wakes FLIGHT once. FLIGHT's `create_ticket` refuses a body that is cut from or builds on an open PR without a
`Depends on` line for that PR's ticket (or `After PR N`). The controller's own filing rule (`roles/FLIGHT.md`) is updated separately to ask for the same line.

### Not now and Drop on Needs you

Two operator-only routes act on a question in Needs you. `GET /api/attention` puts `offers: ["not-now", "drop"]`
on an item that is an unprotected `ask:` or Comms question, owned by the operator, whose ticket is on the
board of the repo FLIGHT's session works (an `autonomy: merge` repo, not closed, not `always_ask`, not of another lane).
Anything else answers 409 and writes nothing. Both are the operator's own click (operator token); FLIGHT has no tool for either.

- `POST /api/attention/:key/not-now` sets a seat question aside (`seat_questions.aside_at`: it stays open,
  leaves Needs you, and the end of its run does not close it). It then creates the `waiting:operator` label once per
  repo, adds it to the issue and moves the card to Backlog; a failure up to here puts the question back in Needs you.
  It then ends the run that waits on it (`recordRunHandoff` and `endRun`, or `endAsideRun` for a run set aside in
  review) and posts one comment holding the question, its options and the date. A Comms question is settled
  instead, and ends the sender's run only when it is a crew seat's own run on that ticket; FLIGHT's own question is
  never offered. If the comment alone fails once the run has ended, the question stays aside and the route answers
  502. A second request for the same key while one is running answers 409. A set-aside question closes when its
  ticket closes. It is read and answered from its ticket, see [Answering a set-aside question](#answering-a-set-aside-question).
- `POST /api/attention/:key/drop` closes the ticket as not planned with one comment, after the same refusals as
  FLIGHT's `close_ticket` (`closeBlocker` in `apps/server/src/flight/ticket-close.ts`: an open PR, open dependants,
  blocked-by cards, open sub-issues). The run that waits on the question ends with the close; it is the only
  live run allowed. The close is confirmed by reading the issue back.

The comment goes through the same text scan as `comment_ticket` (no secret, no mention, no other item's number);
a question whose text fails it answers 422 and nothing is written.

### Answering a set-aside question

- `GET /api/tickets/:repoId/:number/set-aside` lists the ticket's set-aside, unanswered seat questions, oldest first:
  `id`, `text`, `ask` (FLIGHT's briefed ask, or null), `options` (`id`, `label`, `answer`), `asideAt` and `runId`.
- `POST /api/tickets/:repoId/:number/set-aside/:id/answer` with `{ "text": "..." }` (operator token). It scans the text like
  any Comms message (400 on a secret), removes `waiting:operator` from the issue, moves the card from Backlog to Ready
  (left alone when another hand already moved it or a run works the ticket now), sends the text to the asking seat as
  a Comms line to the ended run only (another run of that seat never reads it), and closes the question as answered. The
  answer is stored first as an `answer` decision, so every later run on the ticket starts with it in its brief
  (`answeredQuestionsOn`); a retry after a 502 replaces it. The run's handoff stays open, so the next start of the
  ticket picks it up. A GitHub step that fails answers 502 and changes nothing a retry cannot repeat. An unknown
  question or one on another ticket answers 404; one that is not set aside, or already answered, answers 409.
- `POST /api/seats/:id/message` with a `question` that is set aside, whose run has ended, answers 409 and sends nothing:
  without the refusal the text would reach whatever run holds the seat now.
- After each board poll the hub removes `waiting:operator` from any open card outside the Backlog (someone moved it),
  skipping while a Not now is running and any repo but the one Not now acts on (`autonomy: merge`, FLIGHT's session repo). A preview (`MC_NO_LOOP_WRITES`/no board writes) never does.

### FLIGHT's controller powers

FLIGHT runs the crew with every power the controller has on it. It asks the operator only for money,
product direction, a security exception, an irreversible external action, and a floor approval the
repo reserves (`always_ask`). These are FLIGHT shortcuts; each change is a logged decision. On a superuser
repo `mc merge_pr` clears any PR once review is clean and CI is green, guard rules, hard-rule paths, CI
workflows and the CLAUDE.md block included, with no controller check and no approval row. The hub logs
the clearance as a `merge` decision, with its basis, the run and ticket, and what needed FLIGHT's call (paths
under the guard, `CLAUDE.md` and `.github/**` named first). That decision on the FLIGHT page is the operator's
line for each such merge; the hub sends no Comms message for it.
A standard repo keeps the floor: a controller's approval (see [FLIGHT approvals](#flight-approvals))
is what lifts it.

The crew-pause panel lists active run exceptions, who granted each, its reason and time. A
finished or missing run no longer has an exception, even after a hub restart. The hub event
also names FLIGHT, the seat, the actual run and the reason. Existing full-access operator
actions remain available; this run scope applies to the start/resume shortcuts.

The operator pause API accepts `all` or an explicit seat list; it does not accept seat-wide
`except` entries. A named seat list keeps its recorded scope. Older seat-only exception entries
are retained as labelled audit data, but cannot identify an authorised run or grantor and do
not bypass the pause. The reader never reconstructs seats previously removed from an older
named pause or attributes an unknown grant to FLIGHT.

| Tool | What it does |
|---|---|
| `settle_park` | Lift a stuck park, request a fresh review, accept findings, `rework` (queued for a busy seat), or `second_review` |
| `move_review` | Move one queued review to a named review seat. It keeps the review head, round and model rule. It refuses a target account at its usage stop. |
| `resolve_waste_alarm` | Close an open waste alarm's hold (a parked ticket, stopped reviews, a restart storm) with a recorded basis. See Waste alarms. |
| `start_seat` | Start a seat the operator stopped or a crew pause holds. A pause exception is granted to the actual prepared run, with FLIGHT, its reason and time recorded. The original pause owner and seat coverage remain unchanged; the exception ends with that run. It never lets the engine deal the seat another ticket while the pause holds. A failed start removes only its own grant and preserves newer operator changes |
| `resume_seat` | Resume a seat's unfinished run after a stop, a crew pause, an error or a restart; a build or plan seat in FLIGHT's session and a run in its lane. A stop can be lifted, but a crew-pause exception covers that run only. The original pause keeps its owner and seat coverage. Refused for a held run, a budget-parked run, an account usage stop, an Away quota limit (and a planner during Away), an already live unpaused session, and a machine without headroom. A failed resume removes only its own exception and restores the stop unless the operator changed it |
| `end_run` | End a working, parked or stalled run (a working run must not be held). A run with uncommitted changes is refused before its process is touched, since only the seat can commit them; a seat in a turn is interrupted, then looked at again, and a stalled or idle seat is not interrupted |
| `sync_main` | Merge main into a run's branch |
| `dismiss_item` | Dismiss any attention item it can find except an operator approval, a budget or guard hold, an Update hold, another lane's item, an item FLIGHT briefed for the operator, a person's message, or FLIGHT's own question |
| `promote` | Reads the live card, and refuses when it cannot be read |
| `edit_issue`, `set_fields` | Replace an issue's whole body or title, set status, priority, size, labels and milestone (draft workspaces and closed cards are refused; status moves only to Blocked, everything else is `promote`; only labels being added are judged, and the area label rule applies when the area labels change; a status move is logged as `status`; a lane label changes only with `edit_card`; a ticket with a live run is refused, for both; a partial failure says which fields landed). `always_ask` and other-lane tickets are refused, judged on the card read live from the project (a failed read refuses; the cache is never used); text is scanned for secrets and mentions, and a body is capped at the ticket body limit and sent on stdin. `edit_issue` never drops or changes the `## Controller check` section (use `add_controller_check`) and refuses a ticket it cannot read whole |

Three further tools give FLIGHT the controller's routine actions (#1214). Each landed call is a
FLIGHT decision on the Audit ledger with its route or verb, body and basis, and each is refused during Away:

| Tool | What it does |
|---|---|
| `operator` | `{ method, path, body?, basis }` calls one of the hub's own operator routes in process, with the operator token and authenticated FLIGHT actor added by the hub. `POST` works on a run's `resume`, `end`, `message`, `controller-check` and `merge-hold`; an external PR's `controller-check` and `merge-hold`; a seat's `start`, `message`, `interrupt` and `end`; `settings/crew-pause`, `settings/away`, `update`; and an attention item's `dismiss`, `hold` and `hold/release`. `GET` reads any other `/api` path except the operator bootstrap and stored screenshots. Any other route (accounts, repos, config, `flight/approvals`) is refused, naming the allowed ones. The route's own checks still apply and its answer comes back (a 4xx is an error). Decision kind `operator`. |
| `gh_write` | `{ action, target, number, ... }` runs one `gh` verb on FLIGHT's session repo only: `comment`, `label`, `edit`, `close`, `reopen`, `ready`, or `delete_branch`. Text is scanned for secrets and @mentions as `create_ticket` does; `always_ask` and other-lane tickets are not edited, labelled or closed; a branch is never deleted when it is `main`, `archive/*`, on the repo's keep list, has an open PR or a live run, or when the open PRs could not be read. Merging stays `merge_pr`, board fields `set_fields`. Decision kind `github`. |
| `crew_tidy` | `remove_worktree { runId }` removes the clean worktree an ended run's branch is checked out in (under the crew's worktree folder, with no live run on the branch and no seat holding it) and keeps the branch, so a seat can start the ticket again; a dirty worktree is refused with nothing removed. `prune_branches` drops the seat clones' local branches that are merged or whose remote is gone. Decision kind `tidy`. |

### FLIGHT's full access

FLIGHT's watch run uses the `flight-full` profile. Claude starts without `--restricted` or a Bash
sandbox, and its tools are listed with no path or command limits; its guard hooks stay installed.
The list is required: the credential scrub makes the CLI ignore `bypassPermissions`. It stays
narrower than bypass: in a `-p` run, Edit and Write to protected paths are refused. User, project
and local Claude settings also apply, since `--restricted` is off, so their allow, deny and ask
rules can change what FLIGHT may run. Codex requests and verifies a
`dangerFullAccess` thread while retaining the hub's approval callback. Every other seat keeps its
existing filesystem, network and tool restrictions.

FLIGHT receives `GH_TOKEN`, `MC_HUB` and `MC_OPERATOR_TOKEN` in its process environment. The scrub
removes `MC_OPERATOR_TOKEN` from a Claude FLIGHT's Bash and keeps `GH_TOKEN`, so FLIGHT calls the
operator API through `mc operator`. This hides the token from child processes and environment dumps.
It does not stop a same-user read of the token file.
Credential values pass through the keeper's inherited environment, never its spec file. The keeper
redacts them before saving or replaying stdout and stderr. A credential revision hash makes a
surviving FLIGHT run resume with fresh credentials after a hub restart, and a changed
`FLIGHT_RUNTIME_PROFILE` makes it resume with new launch arguments; other keepers still attach
normally. The `mc` tools remain convenient shortcuts, with role authentication, repo/lane checks,
merge gates and recorded operator holds. Per-repo power tiers do not withhold FLIGHT shortcuts.

The guard checks repository floors: no history writes on main, no force-push, no direct PR merge
that bypasses `merge_pr`, protected GitHub settings, `.github/**`, the Mission Control section in
CLAUDE.md, and edits of known `always_ask` tickets. It reads the actual checkout branch for history
writes, permits ordinary CLAUDE.md edits when that section stays identical, and accepts a matching
recorded controller approval for a rule override. Approval grants and breaker lifts belong to the
controller. Full machine authority means these hooks are guardrails, not an operating-system
security boundary against arbitrary code; the operator accepted that risk in #1214.

Shell writes are recorded after execution with command, cwd and exit code. A missing failure code
or background launch is recorded as unknown, never as a successful completion. Duplicate completion
notifications do not duplicate the audit. Secrets are redacted. Claude uses PostToolUse and
PostToolUseFailure; Codex uses command completion facts. Counted writes feed the existing runaway
breaker; a tripped breaker holds further counted writes until a controller lifts it. Common file
writers and explicit output flags count outside the watch worktree (or when their destinations are
unknown); ordinary edits inside the worktree remain audited without an additional breaker cap.

FLIGHT may move unstarted Ready or Refinement work back to Backlog, hold an item for its named
condition, reverse a mistaken closure with `gh_write`, and retain its own brief without an arbitrary
one-day expiry. None of that lifts an operator instruction or supplies a missing approval.

The controller still checks the widened runtime before merge. After Update, verify the real FLIGHT
provider can perform the authorised actions and is refused a push to main. Keep #1214 open through
its one-day observation of cleared stalls and counted manual controller actions.

### External PR merge and sign-off

`mc merge_pr` also merges controller and personal PRs with no crew author run. It reads fresh
same-repository/default-branch provenance, the complete changed-file list, linked ticket rules,
GitHub reviews and CI, and the independent exact-head QA report. GitHub receives a merge request
with `--match-head-commit`; branch protection stays in force. A branch keeps its normal engine path
while a build run is live or parked on it, while a run is live on the same ticket under another
branch, while a seat has claimed the ticket's handoff and has no run row yet, and for every run of a
configured (observed) loop. Once that run has ended (a controller pushed the head and FLIGHT ended the
run to free the seat), the PR is reviewed and merged like one with no crew author; a
hard-rule PR then needs the same head-bound `merge-floor` approval below on a standard repo; on a
superuser repo FLIGHT's own logged decision is enough. A merge hold on the branch's
latest build run still refuses the merge after that run ends, until the hold is released. An operator's
Stop ends a run and sets no hold, so it does not keep the PR from merging: set a merge hold for that.
This is decided, not an oversight: a hold that outlived the run could be cleared only by starting a
seat. A clean review reads only the pushed head, so uncommitted work the ended run left in its
worktree is not seen by the review or by `merge_pr`; the ticket's open handoff lists it.

An ended run's PR with review findings goes back to a seat with `reassign_ticket`. The seat works on
the PR's own head: when the run opened a PR whose head ref differs from the run's branch, the seat
starts on that ref, and a handed-over branch behind origin's is moved to origin's tip (a diverged one
is refused, and nothing is changed). A stuck run whose newest commit is the PR's head, pushed by hand
after the push gate refused it, is recorded as pushed when FLIGHT lifts the park, so it reaches review.
No build run is invented and no board card is marked Done by this path.

When such a PR is behind main or conflicts, FLIGHT can bring main in itself: `mc sync_main` needs an
unended run, but FLIGHT's shell may merge, resolve and commit on a detached HEAD (`git fetch`, `git
checkout --detach origin/<branch>`, `git merge origin/main`), resolve and commit, then `git switch -c
<name>` and `git push origin <name>:<branch>` to the PR's own branch (the guard refuses a push of
`HEAD:<branch>`, as it needs a named branch on both sides). The guard refuses those git writes on `main` and in a checkout it cannot read, and a push to
`main` stays refused. Or FLIGHT starts a seat on the ticket and sends the conflict to it.

On a standard repo, protected repository rules require the existing head-bound `merge-floor`
controller approval. Ordinary CLAUDE.md prose does not require that approval when its Mission Control
section is unchanged. Changes to FLIGHT's runtime or approval guidance also require a real independent
controller check there, which FLIGHT cannot give itself through `mc operator`.

On a superuser repo only `always_ask` labels and a linked ticket's `## Controller check` hold an
external PR. FLIGHT's own logged decision covers protected paths and names them; a PR that changes them still needs a
hub review row on its head, not only a passing `mc/review` status. For a crew PR awaiting FLIGHT clearance, `mc merge_pr`
clears the head. When the PR's head came from outside the run (a commit from a person or another
worktree) the run cannot await clearance; on a superuser repo `mc merge_pr` then adopts that head as the
run's push (logged as a `sync` decision; any waiver of the old head's review is dropped), so CI and
RETRO check it, and the run waits for FLIGHT's clearance on every later head too. FLIGHT calls it again
when it awaits. A `gate` park (strays or foreign commits
on a superuser repo) is lifted with `settle_park` `lift`.

External PR acceptance and controller checks have head-bound records. A required acceptance
appears in the existing QA queue and uses the existing operator route:

- `POST /api/prs/:repo/:number/uat { action: "accept" | "send_back", sha, note? }`.
- `POST /api/prs/:repo/:number/controller-check { verdict: "pass" | "fail", sha, note? }`.
- `POST /api/prs/:repo/:number/merge-hold { action: "hold" | "release", sha, reason? }`.

A failure or send-back needs its note. Each route rechecks the current head and PR provenance;
an old verdict does not apply after a push. A merge hold remains on the PR across pushes and can
only be changed from the head the caller has checked. Operator acceptance stays with the operator.
FLIGHT may manage its own holds and evidence checks (on a standard repo not those on its own access),
while operator holds remain the operator's. These records do not replace CI or QA,
and they never stand in for #1214's day-long post-Update observation.

#### Which PRs a hub acts on

Several hubs can run on one repo, even under one GitHub login. A hub's automatic GitHub writes (a
card move, a branch delete, the screenshot section of a PR body, a review comment or `mc/review`
status) are limited to work it owns, so a hub with no runs writes nothing:

- A branch is owned when a work run in this hub's store has it, ended or not (a review run does not
  count). A PR is owned when its branch is, or when someone asked this hub to review it.
- A card is owned when a work run here has its ticket, or a run here moved it. A Blocked card with
  no run here is not released by this hub when its wait resolves.
- A PR opened by hand has no run. Ask this hub to review it with
  `POST /api/prs/:repo/:number/review-request { sha }` (FLIGHT: `mc operator`). The ask is kept in
  this hub's store only and binds the head `sha` it was made for: a push needs a new ask, so an
  ask on another hub's PR does not follow that PR's later heads. It starts the QA review, the
  `mc/review` status, the card follow and the screenshot evidence for that head. Asking again for
  the same head changes nothing and writes no Activity line. Take it back with
  `{ sha, action: "withdraw" }` (it needs no GitHub read, so it works on a closed PR).
  Without an ask the PR is read and shown, never written to. A PR whose branch a run in this
  hub's store made, ended or not, needs no ask for its QA review.
- On Update, the hub records an ask once for each external review already in flight, so a review
  that was running is finished and its pending `mc/review` status is not left behind.
- A preview never moves a card: it polls GitHub and shows it (`boardWrites` is off for a preview).
- Hubs still read and show every PR, including another hub's.

### FLIGHT approvals

A controller (the controller session or the operator) lets FLIGHT go past one rule for one scope until a
time. Only the operator token can record one; FLIGHT's `operator` tool cannot reach the route:

```
POST /api/flight/approvals { "rule": "merge-floor" | "repo-rules" | "merge-push",
                             "scope": "...", "until": "<ISO time, within 7 days>", "reason": "..." }
```

- `merge-floor`: a PR that touches `CLAUDE.md` or `.github/**`, on a standard repo or an external PR with `always_ask`; a superuser repo's FLIGHT clears these itself. Scope `pr:<number>@<head sha, at least 7 characters>`. The engine then treats the head as awaiting FLIGHT, `merge_pr` clears it, and the engine merges it. A new head needs a new approval. The approval stays until it expires.
- `repo-rules`, `merge-push`: a call the guard refused. The scope is the exact command, or the exact file path for Edit and Write. It lets that one call through once, then it is used up.

Each grant and each use is a decision of kind `approval` on the Audit ledger. The refusal text names the rule.

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
| `machine` | This Mac: CPU, memory, disk, Claude/Codex processes (`os`, `vm_stat`, `statfs`, `ps`); a sample is kept each minute; the spawned commands run only with a browser or crew work open (see `runbooks/machine-capacity.md`) | 2 s (status rewritten at most once a minute while unchanged) |
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
columns (*In progress*, *In review*, *Blocked*, and *Ready* for an ended run with review findings), through GitHub's `updateProjectV2ItemFieldValue`;
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
- `uat`: `{ labels: [...], paths: [...] }`. A tested PR waits for your acceptance when its ticket
  has one of the labels or its diff touches one of the paths (see "Accept or send back a PR at
  UAT"). Missing or empty means no UAT. A repo block's lists are unioned with user config's.

Commands and protected files already live alongside `rules`, at `repos[].commands` (`writer` and
`review` lists) and `repos[].protected` (extra globs seats may not edit or commit). They do not come
from a repo block. Changes to these repo settings, including `rules`, require a hub restart.

A repo block optionally tightens the rules in the first fenced `yaml` block under
`## Mission Control` in its `CLAUDE.md`, key `mc:`. The hub reads it at `origin/HEAD`, not a seat's
worktree; a change takes effect once merged and fetched. `hard_rules` is unioned with an explicit
user-config list (even `[]`); it replaces the defaults only when user config supplies no list.
`always_ask` and `uat` are unioned, and `hard_rules_by` is `operator` if either source says `operator`.
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
run may use; the engine parks a run that goes over. It is a runaway ceiling, not the expected use:
set it well above what a large ticket needs (the live config uses `1500000`). A run that merely
passes its expected use is not parked; Audit raises a finding for it (see Audit API). A writer run leaves its seat (is set aside) once
its draft PR is open on the pushed sha and the seat is between turns, in CI as well as in review, so
the seat does not idle through CI. Rework on a set-aside run (review findings, a failed controller
check, a CI failure) comes first, oldest first, ahead of any new ticket. If it lands while the seat is
building a new ticket, that ticket is set aside at the seat's next turn end (its worktree, with its commits and any
uncommitted work, is kept as it is; nothing is pushed) and comes back after the rework; the rework's
wait reads "rework waiting on GUIDO-1 (behind #N)" until it starts.
A ticket waiting on a person is parked the same way: when a seat's question has been passed to the
operator and the seat is between turns, the run leaves its seat (worktree and commits kept) and the seat
takes its next ticket. The run does not wake while the question is open. A reply that names the question
(`question` on `POST /api/seats/:id/message`, sent with a Needs-you ask reply) is stored for that run, not the run now on
the seat, and closes only that question; a message with no `question` goes to the run on the seat as before, and leaves the parked question open (the web sends the id once ticket 1474 lands). A question of another seat, or one already closed, is refused too. The run
comes back with one line telling it to read the answer, in any phase it was parked in (working, CI or review). Ending the parked run closes its question. Another run's end or message on the seat leaves the question open.
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
`released_at`), shows in FLIGHT's digest as
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
- **Review previews and screenshots.** When a PR changes web files (paths under the repo's
  `area:web` globs, read from `pr_files`) and the repo is the one the hub previews (its own),
  the review run gets a preview of the PR head: the branch preview (`POST /api/previews`) on a
  copy of the live data with loop writes off. The preview is pinned to the reviewed commit; an operator preview is reused only for that same head. Browser requests are GET-only, and queued calls recheck the running review and preview instance before returning results. It is built in the background when the review run
  starts, so the review does not wait for it, and the brief says it is starting. The hub touches it
  every minute while the run is open, so the 20-minute idle expiry does not close it, and closes it
  when the run ends (a preview the operator started for that PR is used and left running). If the
  preview cannot start (capacity, the two-preview limit, a failed build), `preview_browser` says
  so and RETRO notes the live-data check was not run. RETRO's
  `preview_browser` tool waits up to 40 s for a building preview, then answers "still building" so RETRO calls again (Codex ends a tool call at 60 s); once it is up the tool opens a page, sets the width (320..3840) and theme, and runs up to
  20 steps (click, type, read, measure, screenshot). Chrome runs behind a proxy that reaches only
  the preview's `host:port`; every other request, the operator-token bootstrap and the live
  stream included, is refused. Each call starts on a fresh page. A screenshot is kept in
  `review-screenshots/` beside the database for 90 days (`QA_RETENTION_DAYS`) and listed under its
  review round in `GET /api/qa/findings` (`reviews[].screenshots`: `id`, `label`, `width`,
  `theme`, `at`). `GET /api/qa/review-shots/:id` serves one PNG, with the operator token.
- **PR readiness: Comms, rework and try-it.** `GET /api/qa/uat/:repoId/:number` carries, for one
  PR: `comms`, the newest 20 messages whose ref or ticket is the PR or its ticket (sender, time,
  text; newest first); `rounds`, each reported review round newest first with its blocking findings
  as `file:line summary`, the author seat's newest message before the next round (`reply`), the
  first branch commit before the next round (`fixSha`) and a `result` (`clean`, `resolved` or
  `open`); and `tryIt`, the branch name as the run pushed it, `git fetch origin <branch> && git
  switch <branch>` plus the repo's `run_command` from `config.yaml` when it sets one. `previewUrl`
  is the URL of the PR's running branch preview (see Branch previews), else null. `uat` says whether the PR's open run is parked for the
  operator's acceptance (`waiting`), when it parked (`since`) and the note the operator last sent it
  back with (`note`); a PR with no such run answers `{ waiting: false, since: null, note: null }`.
- **Workflow figures.** `GET /api/qa/flow?days=` (1..90, default 30) serves four figures from one
  window, each defined once in the metric registry (`QA_FLOW_METRICS`) and returned as `metrics`:
  - `escapedDefects`: issues labelled `bug`, filed after a PR merged, whose body names the PR (`#N`
    or its URL), one of its commits (7+ hex characters: its merge commit, head, or a commit the
    hub made for its branch), or a file that exactly one PR merged in the 90 days before the bug
    changed (a file two PRs changed is left out). Each carries the originating `seat` and `model`
    (the branch's author run) and shows on the PR as `escapedDefects`. The link is kept after the
    card leaves the board.
  - `reviewTimings`: per reported review (one per head), `reviewWaitMs` (queued to started) and
    `reviewMs` (started to reported), with median and p85. A review that never started is left out.
  - `rework`: reported rounds with a blocking finding over all reported rounds, per author seat
    and per model; under 3 rounds is marked `enough: false`.
  - `testsPerPr`: test files (`*.test.*`, `*.spec.*`, or under `test/`, `tests/`, `__tests__/`) each
    merged PR added or changed, from the first 100 files of its diff (`pr_files`). Deleted tests are
    not counted.

  Escaped defects and diff files are kept 90 days.

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

Operator briefs require complete decision context and typed, source-bound options. Genuine operator
decisions wait for an explicit operator choice. A validated reversible action within FLIGHT's existing
authority can receive a server-owned forty-minute FYI deadline. Its dispatch rechecks the current actor,
exact target and existing holds; grants, approvals, review waivers and hold releases never default.
Ordinary guidance follows its run across commits, while head-specific actions retain exact-head checks.
An answer to a passed question set aside on that exact question is stored for its preserved run.
Confirmed refusals release their choice claim for a new request. Uncertain outcomes retain their receipt
and never replay automatically, including partial queue writes or a stored answer whose wake failed.

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

FLIGHT's `screenshot_hud` tool renders one HUD page at 1600×1000 in the
system Chrome. The render runs in an owned helper process in its own process group with a minimal
environment (no tokens); when the render ends, is stopped or its 30 s deadline passes, the hub sends SIGTERM to
the helper's group. Chrome runs in a group of its own, so the helper must close it: it exits half a
second later, and Playwright's exit handler kills Chrome and removes its profile folder. The hub
sends SIGKILL to the helper's group after one second as a backstop for a stuck helper, and the call
settles only after that, so the helper and, unless the helper was stuck, its Chrome are gone when a call returns. A render that times out names the selector it was
waiting for. Chrome is started with `launch()` (a private pipe, no control
socket) and every request it makes, loopback included, goes through a loopback-only proxy that
connects to the hub's own host and port and refuses everything else, on top of the Playwright
routes (GET only, no bootstrap, no event stream, no WebSockets, no service workers, popups closed).
The shot is taken after the shell is ready, the lazy page's `Loading…` placeholder has gone and the
page's requests have been quiet for 400 ms. Renders are one at a time per host.

Each screenshot is kept under `hud-screenshots/` in the data dir (directory `0700`, files `0600`,
an opaque 128-bit id), at most 50 files and one week. The tool's answer ends with `Reference:
hud-shot:<id>`, which FLIGHT cites in a ticket. The operator reads one at `GET
/api/hud-screenshots/<id>` with the `x-mc-operator` token header (404 for an unknown or expired id).

Not built: rendering a PR preview. The hub does not serve PR branches, so there is nothing for the
tool to point at; FLIGHT reviews merged work on the running hub.

## Slow pace

The operator can set how hard the crew runs, for a weekend or a holiday. With no setting the crew
runs at normal pace and nothing slows it by itself. `POST /api/settings/pace` takes `on`, `until`
(an end time, epoch ms, in the future), `labels` (a ticket starts only if it carries all of them;
none means any), `maxStarts` (how many tickets may start while it is on) and `note` (the operator's
word for it, such as "weekend"). The server stamps `since` when it is switched on; only tickets that
first started a build or plan run from then count against `maxStarts`: a review does not, a ticket
started twice counts once, a ticket started before the pace and handed on later does not, and an
observed loop's runs do not. Seats starting at the same moment are counted from the starts under
way, so the limit holds. The setting stays apart from Away on purpose: FLIGHT may write Away
settings but not this one, so only the operator can slow the crew. Away limits what kind of work may
start and what may be written; slow pace limits how much. Both hold at once, and the Overview
shows them side by side.

While it is on, the queue, FLIGHT's `start_seat` and a seat start all refuse a ticket that does not
match or that arrives after the starts are used, naming the pace and the ticket. A start the
operator makes by hand from the HUD is not held, but the same route called by FLIGHT through
`mc operator` is. FLIGHT's state carries `pace`, and FLIGHT's wake facts leave out the tickets the
pace refuses and the idle-seat fact, so held seats do not wake it all weekend. At the end time it stops applying without anyone
turning it off. An unreadable row counts as normal pace. `GET /api/overview` carries
`pace` (`note`, `until`, `labels`, `maxStarts`, `startsLeft`) while it is on and `null` otherwise,
for the Overview to show.

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

Every Claude crew CLI receives `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Claude strips recognized credentials
from Bash, hooks and MCP subprocess environments. The parent CLI retains its authentication.
The flag also forces the CLI's permission mode to `default`, so every seat's tools must be listed
with `--allowedTools`.
The supervisor also starts every seat with a minimal inherited environment, excluding operator
provider and GitHub tokens. The real-CLI floor suite checks fake provider credentials against a
local fake Messages API; it makes no paid provider calls. See the
[upstream scrub reference](https://code.claude.com/docs/en/env-vars#what-the-subprocess-environment-scrub-removes)
for recognized names and exceptions. The flag alone leaves GitHub tokens and proxy settings in place.

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

For a LAN relay, with Node 26 and `packages/agentcomms/bin` on `PATH`:

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

Use Node 26 and a checkout with workspace dependencies installed on both machines. Deploy the
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
machine (`command -v node` must resolve to Node 26). launchd does not expand `~` or `$HOME`.
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

## Branch tidying

GitHub's delete-on-merge removes a branch only when its PR merges, so the hub removes the rest. It
runs wherever the engine runs (not in a preview, not with `MC_NO_LOOP_WRITES=1`). It tidies only a
repo with a crew session and no observed loop; a repo that only lists an observed loop is never
touched.

- **No push after a merge.** `mc push` asks GitHub for the state of the PR the run records. A merged
  or closed PR refuses the push, naming the PR; a run with no PR of its own yet is refused when the
  last PR on its branch merged; nothing is sent, so a merged branch is not
  recreated. If GitHub cannot say, the push is refused as a transient failure and tried again.
- **Only its own branches.** The sweep deletes only a branch that one of this hub's work runs worked
  on (a review run does not count). A run that adopted a branch already on origin counts, and that
  branch's tip must still be merged. A second hub on the same repo has runs this hub cannot see, so a
  branch with no run in this hub's store is left alone; a hub with no runs of its own deletes nothing.
  FLIGHT's `delete_branch` is a separate, explicit action with its own checks.
- **A closed PR deletes nothing.** The hub does not remove the branch of a PR that closed without
  merging; the agents decide what to do with it. A closed PR is no signal for any hub write: it
  moves no card either.
- **Daily sweep.** Once a day (first run 10 minutes after the hub starts) the hub deletes a remote
  branch with no open PR, no live run, no commit for 24 hours, and a tip that a merged PR carried as
  its head, so unmerged commits are never swept. A branch that is the base of an open PR stays. Any
  unended run holds its branch, a run parked on a closed PR included. Each deletion is a hub event on
  the Activity page.
- **Never touched:** the default branch, `archive/*`, and `repos[].keep_branches`. If any read of
  branches or PRs fails, nothing is deleted for that repo.
- **Local.** Every 10 minutes the hub fetches each seat clone with `--prune` and drops the local
  branches that are merged into the default branch or whose remote is gone. A branch checked out in
  a worktree, or held by a live run, stays. The operator's own checkout is not touched.
- The only GitHub write is `DELETE /repos/{repo}/git/refs/heads/{branch}`, over `gh`.

## Branch previews

The live hub can start an open PR as a loopback-only preview with `POST /api/previews {"pr":123}`.
`GET /api/previews` lists the active preview URLs and `DELETE /api/previews/123` ends one. The
operator token is required for starting and ending previews.

Each preview uses a SQLite `VACUUM INTO` snapshot in the live hub's private data directory, a
temporary detached worktree, a spare port from 7431–7439, and `MC_NO_LOOP_WRITES=1` with crew
off. It receives a newly generated operator token; the live token is never passed to it. At most
two previews run. A capacity hold refuses new previews with its measured reason. The parent stops
a preview after 20 minutes without a browser request, and removes its worktree and database on
expiry, explicit close, or live-hub shutdown. Preparation has a five-minute deadline, and an
operator close cancels preparation as well as a running child. Previews only run branches from the
repository checked out by the hub; PR numbers in another configured repository are not eligible.

### PR screenshot evidence

A PR that changes the HUD carries screenshots of the pages it affects before it leaves draft. This
applies only to the repository whose checkout runs the hub, and only on the live hub.

**What is captured.** The files the PR changes (the first 100 the GitHub poll stores) are mapped to
pages: a page's own directory under `apps/web/src/` or its `pages/` file affects that page;
`hud.css`, `shell/`, `components/` and any file that cannot be placed affect every page in the nav
catalogue; test files and paths outside `apps/web` affect none. For each page the hub renders
1600×1000 in the light and in the dark scheme, on main and on the PR head. Both sides are
hubs started as `MC_NO_LOOP_WRITES=1` previews on a free loopback port, each from its own copy of
one `VACUUM INTO` snapshot of the live database, so they show the same data. Each side is a
detached worktree with `pnpm install --offline --frozen-lockfile` and a web build, torn down when
its pages are done. Captures run one at a time; a failed capture is tried again after ten minutes.

**What is stored.** Under `pr-evidence/<repo>/<pr>/<head sha>/` in the data dir (directories
`0700`, files `0600`): `<page>-<light|dark>-<before|after|diff>.png` and `manifest.json`, which
lists each pair's changed pixels, changed percent and changed regions (bounding boxes, largest
first). A pixel counts as changed when its colour differs by more than 24 across the three
channels; regions group changes on a 16 px grid. The three newest heads of a PR are kept. The
manifest is written last, so a head with no manifest was never captured. Nothing is uploaded.

**Where it is read.** `GET /api/prs/<n>/evidence` answers the newest head's manifest (`?sha=` for
one head, `?repo=` when two repos have the number) and `GET /api/prs/<n>/evidence/<sha>/<name>.png`
an image. Neither needs the operator token, like the other read routes. The PR body gets a
`## Screenshot evidence` section with one line per pair and links to its three images; it is
rewritten for each new head and kept when RETRO's Minor findings are posted. RETRO's brief lists
the pairs and the images are copied into its scratch copy under `.mc-review/evidence/`.

**The hold.** The engine does not request RETRO's review, mark a web PR ready, or merge it until
the pairs for its current head exist, so the reviewer always has them and a PR already out of
draft cannot merge on a new head without them. Each pass that is held records a loop event naming
the pages still missing; the run is not parked, and moves on at the next pass once the capture
lands. A capture that fails (or runs past its 15-minute deadline) is retried after ten minutes and
the hold then says `capture failed: <reason>`, and a failed render names its page, colour scheme and side (main or head) first, as in `board page, dark scheme, head side: <reason>`. A capture stopped by a hub shutdown says so and names no page. The review is held at that point too, not let through: the engine asks for no review, marks nothing ready and merges nothing until the pairs exist, so a capture that keeps failing stops the PR visibly, with that reason in the loop event, instead of reaching RETRO without pictures. A push makes a
new head, which needs its own pairs.

**After a restart.** A hub that stops in the middle of a capture leaves database copies in `capture-*` folders and side checkouts (with their git worktree registrations) under `pr-evidence-work/` in the data dir. At start the live hub deletes both, runs `git worktree prune` on its checkout, and logs what it removed; nothing else uses that folder. To see what a capture would store without a PR, run `node --experimental-strip-types apps/server/src/pr-evidence/probe.ts http://127.0.0.1:<port> [out dir]` against a preview hub: it saves `<page>-<scheme>.png` for every page.

**Audit tabs.** The Readiness and Hotspots shots click the page's own controls, found by the labels in `mc/core` (`QA_VIEW_LABEL`, `QA_DISCLOSURE_LABEL`, `QA_TAB_LABELS`). `apps/server/test/qa-labels.test.ts` reads the web source and fails when either side renames one. Once the tab has loaded, the shot scrolls the section that holds the QA control to the top of the viewport (the control itself on an older baseline), so the tab's content is not cropped by the 1600×1000 viewport.

**Limits.** Anything on a page that depends on the clock (relative times, live counts) differs
between the two renders and shows as a changed region; read the regions against the diff. A PR
with more than 100 changed files is judged on the first 100 the poll stores. A capture needs a
system Chrome, `playwright-core` and the repo's pnpm store offline, as the FLIGHT screenshots and
branch previews do.

## Audit API

`GET /api/audit?range=7d|30d|90d|365d` returns the `AuditView` type from mc/core, every panel bounded by the range. Besides long runners, death loops, rework, refusals, questions, cost per merged ticket and the model and prompt timeline, it serves:

- `prSizes`: each merged PR's additions, deletions and changed files (PRs merged before size capture are left out) and the outliers at or above `AUDIT_PR_OUTLIER_LINES`.
- `agentId` and `runId` on long runners, death loops, rework, `refusals` and `spendOutliers` (runs costing at least twice the range's median run).
- `chatter` (seat pairs with a long back-and-forth on one ticket), `refusalSpikes` (a seat with `AUDIT_REFUSAL_SPIKE` refusals in a UTC day) and `flakes` (checks that failed, then passed on the same head). Flakes come from FLIGHT's signal state, which keeps seven days, so a longer range shows at most the last seven.
- `changes`: each seat's first run on a new prompt hash or model, with crew-wide merged count, review fail rate, median cost per merged ticket and rework rounds over equal windows before and after (up to seven days each; the window shrinks when the change is recent).
- `tokenOveruse`: one finding per run started in range whose input + output tokens pass its ticket size's expected use. Expected use is 1.5 times the median of that size's build runs (only runs of build seats; watch, plan and review seats and observed loops are left out, as are runs of agents no longer configured) of the last `AUDIT_BASELINE_DAYS` (14) days, and `AUDIT_EXPECTED_TOKENS_DEFAULT` (400000) for a size with fewer than `AUDIT_BASELINE_MIN_RUNS` (5) of them or none. A finding carries review rounds, blocking findings by category, turns, uncached input, output, cache read and create, the expected use and a likely cause: `plan-gap` (scope or spec findings), `flaky-test-loop` (wrong or stale test findings), `rework-churn` (4 or more rounds, or 10 or more blocking findings), `wide-ticket` (Size L or XL with little rework) or `unexplained`. `groups` collects causes that repeat across two or more findings with a prevention to propose (`lesson`, `plan-rule` or `split-rule`); the proposal is text for the delegated path to take, nothing applies it. A finding never stops a run; only the `crew.run_token_budget` ceiling does.
- `reviewRounds`: `prs` counts the PRs reviewed in range by their highest review round, and `late` counts, per reviewer seat and model, the blocking findings (Critical and Important) reported in range and how many were late. A finding is late when it comes in round 2 or later on a file the author left unchanged since the previous review (the hub compares the files of `since-last-review.diff`; a finding the reviewer holds from the last round, by a `held` resolution, is carried and not late; a review with no earlier round, or whose changed files are unknown, tags none). The tag is also on each stored finding.
- `items`: stored Audit items in range, each with a `tier` that says who may act on it: `auto` (the hub does, and logs it), `flight`, `acknowledge` or `go-ahead`. The tier is fixed per item kind in `AUDIT_KIND_TIERS` (mc/core `audit.ts`) and stored with the item; a kind not listed is `go-ahead`, never `auto`. The kinds: `cli-update` auto, `cli-update-failed` flight, `cli-update-major` go-ahead, `flake` and `pr-size-outlier` flight, `audit-finding` and `code-health-proposal` acknowledge.
- `improvements`: Audit's list of things to improve, worked out by hub code from its own records (no agent reads messages). Each row has a `kind`, a `subject`, the `ticket` and `pr` it links to, one plain `detail` line and a time. The four `tool-usage` rows come first and are always there: `report_findings`, `report_evidence`, `read_ticket` and `preview_browser`, with `calls` and `chars` (characters sent plus returned) for calls made in the 24 hours before the range end, recorded in `mcp_tool_calls` as each call finishes, so a long run and a run still open count by when the call happened (calls from before this table existed are not there). The message rows exist only while their condition holds:
  - `question-asked-back`: the operator's first message in a question's discussion ends with a question mark.
  - `question-waited`: a question that waited more than the wait, counted when it is answered or closed in the range (operator choices, operator closures, seats' `ask_flight` questions) or while still open at the range end, whenever it began.
  - `delivered-after-run-ended`: a message with a target run delivered after that run ended.
  - `chatter`: a pair past `COMMS_CHATTER_ROUNDS` on one ticket.
  - `repeat-message`: a message the exact-repeat guard turned away at least once.
  - `repeat-notice`: the same hub notice sent `notice_repeats` times on one PR.
  - `controller-request-waited`: a message to the controller with no reply, `done` or settlement from it within the wait; counted when closed in the range or still open at its end.
  - `ticket-message-volume`: a ticket whose message text is at least `ticket_text_factor` times the median ticket's and over 5,000 characters.

  A message row links to its message's ticket or PR, else its sending run's ticket, else its reference; a row that cannot be linked to either is left out.

  Thresholds are in `config.yaml` under `audit:`, with these defaults: `question_wait_minutes` 120, `controller_wait_minutes` 240, `ticket_text_factor` 3, `notice_repeats` 3.
- `surgeonProposals`: always empty until SURGEON proposals are stored.

The route only reads data the hub already stores.

**Token audit.** `GET /api/audit/tokens?days=N` (a whole number from 1 to 365, default 7; anything else answers 400) says where the crew's tokens went, for runs started in the last N days. It returns `TokenAuditView` from mc/core: totals (`runs`, `calls`, `output`, `cacheRead`, `cacheWrite`, `reread`, `rewrites`), `byRole`, `bySource` and `byCommand` (each with tokens added to a context and `reread`, which is tokens added times the calls left in the run), `topRuns` (the ten with the most re-reading), `hubSections` (what the hub itself sent, from the `prompt_sections` rows), `flightStart` (FLIGHT's cost of starting sessions, the `start` reason of `wakeCost`) `controller` and `figures`. `figures` holds the figures the Tokens tab lists: `contextByRole` (90th-percentile context per model call by role, against `TOKEN_CONTEXT_BUDGET`, one budget for every role until roles get their own), `overBudget` (runs whose peak context passed it), `reviewRunsPerTicket`, `flight` (wakes, wakes with no decision, context at wake, sessions a day, start cost) and `costPerMergedPr` (by role). Each is `{ recorded: true, days, unit, value }` or `{ recorded: false, reason }`; `longPassingCommands`, `repeatedPrompt` and `rewriteWait` are always the second, because the hub stores no command results or prompt text, and does not yet work out the pause before a rewrite from call times. `topRuns` rows carry `ticket`; `bySource`, `byCommand` and `hubSections` rows carry `topRun`, the run that put most into the row (`runId`, `agentId`, `ticket`, `value`).

**Token audit by the hour.** `GET /api/audit/tokens?hours=N` (1 to 24; not with `days`) counts the model calls made in the last N hours, by role, source and command, whichever run made them: an old run's new call counts, a call exactly N hours back does not (the window is `(now - N hours, now]`). Each stored call (`run_token_calls.at`) carries the time of its first frame in the transcript; tokens added to the context belong to the call that took them in. In the window, `calls`, `output`, `cacheRead` and `cacheWrite` are sums over those calls, `added` is what arrived at them, and `reread` is added tokens times the run's later calls that are also in the window. Run totals are never divided by time. The answer is the same `TokenAuditView` with `hours`, `basis` (`events`; `days` answers `runs`) and `coverage`. `readAfterReportShare` is null in an hours window. `coverage.status` is `complete` (every run overlapping the window is read and timed, so zero calls is a true zero), `partial` (named gaps, some data) or `unavailable` (named gaps and no timed call). The gaps are `pendingRuns` (no audit stored yet: still running or not read yet), `untimedRuns` (audited before call times were kept, and the transcript could not give them) and `unreadRuns` (Codex, observed loops, missing transcript: their calls are unknown). Any of the three makes the window `partial` or `unavailable`. Ended runs are read every 10 minutes (the `tokenAudit` scheduler job), so a run that ended a few minutes ago shows as pending for at most that long. The audit pass back-fills times for older audits once from retained transcripts (`run_token_audit.timestamps_checked`); one that cannot give times stays untimed. `?shape=summary` (with `days` or `hours`) is the compact read for agents: totals, every role, the top 15 sources and top 15 commands each followed by an `other` row (so the list adds up to the full read), five runs, `coverage` and `links` (the full read, and each listed run's agent run list, `GET /api/agents/:id/runs`). It stays under 20,000 characters; the plain route keeps the detail.
- **How it is filled.** The `transcripts` job (every 6 hours, first run a minute after start) first reads each ended run's transcript once and stores a `run_token_audit` row plus one `run_token_calls` row per model call, then gzips or deletes old transcripts as before, so a transcript is read before it can be removed. Only a transcript in the hub's own `crew/` folder is read; an observed loop's run, a Codex run or a missing file is stored with no calls and is not retried. A pass stops starting new runs after 20 seconds and carries on at the next one. Nothing is parsed on a request.
- **What a call is.** One assistant message id from the run's own frames (a subagent's frames are left out). Context is input plus cache read plus cache write. What was added since the previous call is split between the agent's own earlier output, each tool result (by tool name; for Bash by the command's first word, or `pnpm <script>`), hub or operator lines (`hub line`) and, for the first call, `start of run`. A context that shrank adds nothing (compaction or a fresh session). The split uses each item's size in characters, so it is an estimate; the context sizes are the CLI's own.
- **Cache rewrite.** A call that writes more than 20,000 tokens to the cache while reading less than half the previous call's context.
- **After the report.** `readAfterReportShare` is the share of a run's cache reads on calls after its first `report_evidence` (null if it never ran one).
- **Output.** A run's output tokens are the sum of its `result` events' `usage.output_tokens`, the CLI's own figure; the streamed figure of an assistant message is only a part of it. Per-call output in the audit is still the streamed figure. Runs folded before this change keep the old output count until their transcript is folded again.
- **Controller sessions (off by default).** `audit: { controller_sessions: true }` in `config.yaml` makes the same job read the Claude Code session files of the controller from `~/.claude/projects/<checkout path with every non-alphanumeric character as a dash>/`. The checkout is the hub's own (where the controller works), or `audit.controller_checkout` when set; the crew's clones and worktrees are not read. Session files and each session's `subagents/*.jsonl` are read once each, after the file has been idle for an hour (again if it grew). Only usage numbers are stored, per assistant message id in `controller_messages`; a message id that appears in several files (a resumed session copies its history) counts once, and the figures are summed by message time. No message text is kept. With the switch off, nothing outside the hub's data folder is listed or read, and `controller` is null. The operator turns it on; no seat can.

**Automatic CLI updates (Auto tier).** With `updates.cli: between_runs`, the `cliAuto` job runs every `CLI_UPDATE_INTERVAL_MS` (`apps/server/src/cli-auto.ts`) for `claude` and `codex`. A tool is managed only when its binary resolves into an npm global prefix (`<prefix>/lib/node_modules/<package>/`, `npmPrefix`); a Homebrew cask or formula, or the native installer, is left to whatever installed it and shows on a `cli-auto:<tool>` health row. The hub installs into that same prefix (`npm --prefix <prefix> install -g pkg@x.y.z`), so the copy seats start is the one that changes. Per tool: read the newest version (`npm view`); if it is newer than the installed one and is a plain `x.y.z`, then
- a new **major** version installs nothing and records one `cli-update-major` (go-ahead) item;
- a version at or below the **held** one (`cli-auto-held:<tool>` setting) is skipped;
- otherwise new runs are held under the owner `cli-auto:<tool>` (no other update path can release it), the begun update is stored (`cli-auto-pending:<tool>`), the exact version is installed (no shell), and the live check runs.
The live check starts the new version the way a real seat does (`checkCli` in `apps/server/src/runtime/supervisor.ts`, which uses the same start path as a run: the seat's account binding, seat config, sandbox, guard hook and MCP config, and for codex the app-server). First `--version` must print that version (and for codex be at or above `CODEX_MIN_VERSION`, the seat floor). Then one build seat of that vendor that holds no run is started in a throwaway detached worktree (`<seat>-cli-check`, removed afterwards; a real worktree is never written) and sent one harmless line: read a file holding a random nonce and reply with it. It passes when the turn ends without error, a tool result carries the nonce and the answer carries it (`judgeCliCheck`). The CLI hold this update keeps does not stop the check's own start. The check run leaves no ticket, inbox line, prompt version or missing-report note, and the seat is idle again after it. A version that breaks only under a seat's settings fails here and is rolled back.
- A seat that has a run, a start under way or a pause is never used. If every seat of the vendor is in that state the check cannot run: nothing is proven, so the update is not rolled back. It stays pending with new runs held, outcome `waiting`, and the scheduler re-checks after `CLI_RETRY_MS`.
- If no build seat of that vendor is configured, no run can break on that tool, and the old bare check applies instead (`claude -p --allowedTools=Read` or `codex exec --sandbox read-only` in an empty temp dir, same nonce read).
A pass keeps the version, clears the pending record and records a `cli-update` item; the next seat run uses it. A failure (install, wrong version or check) puts the previous version back (skipped when the failed install changed nothing), holds the failed version until a newer one appears, records a `cli-update-failed` item and raises one Needs-you note (`cli-auto:<tool>:<version>`). If the previous version is not back, new runs stay held and the update stays pending: the next pass (or the hub after a restart, which re-holds runs at start) re-checks and retries the rollback. Each step writes a server log line starting `cli update <tool>:`. The job never touches the guard, the safety floor, CI workflows or the Mission Control block.

**Batching.** A wake whose only new facts are routine (a free seat, a startable ticket, a hold to release, an idle reviewer, a PR moving through its steps) waits until `FLIGHT_BATCH_MS` (15 minutes) after the last wake and goes out together with whatever else has built up. Settling a question, park or discussion, or FLIGHT reading a message, is not a change and wakes nothing (a breaker lift or a hold lifting still does: it frees work FLIGHT can act on). An operator message sent with interrupt is marked read once its text reaches the seat. An unread plain message from the operator or controller uses a 30-second gap so an idle FLIGHT wakes within a minute. It stays in the `operator` wake fact until FLIGHT reads it, including through an outage longer than six hours. Other non-routine facts keep the 2-minute gap: operator holds in force, discussions, questions, triage, blockers and parks, signals, planned entries, stopped seats, instruction changes and the breaker. The safety floor is never held back.

**Wakes that end in nothing.** `dismiss_item` acks an item and it leaves FLIGHT's triage list. An item FLIGHT has a live `wait_on` for (its full key) raises no `item_stale` signal until the wait ends. A `wait_on` whose target is a reason's whole key (an item's full key, or a `repeat_park` key with spaces) counts as handling that reason, including an `item_stale` signal for the item.

**What FLIGHT costs.** `GET /api/flight` `wakeCost` has the last 14 days: `totalUsd` (FLIGHT), `crewUsd`, `share` (0..1, the whole 14 days) and `weekShare` (the last 7 days only; read this one against the 0.2 target after a week of live work), `byDay`, and `byReason` (a run's cost spread over its messages by tokens, each message given to the latest wake before it, a wake's cost split over its reasons; `start` is the turn before a run's first wake). `wakeWaits` has the median milliseconds an operator message, a blocker to FLIGHT and a seat's `call_flight` waited, per day and overall. A wait ends at the first recorded wake after it or the first message FLIGHT's run produced after it, whichever is earlier; seat calls come from the signal record, which keeps them for the 14 days the figures cover. Compare the days before and after a change to see that decisions did not slow down.

## FLIGHT's operator messages at an account stop

An unread message from the operator or controller asks the watch to start FLIGHT even when its
account is at the configured usage stop. Background starts still wait at that stop. Developer and
reviewer starts keep their existing account and budget checks. The watch uses the normal start
path: an explicit operator Stop, a parked run, unavailable seats and runtime guards still hold.
If that requested start fails, one outage alert says the message is saved; provider error details
stay out of that alert. Waiting crew questions stay with FLIGHT rather than becoming extra
operator questions.

## FLIGHT's fresh session

FLIGHT gets a fresh session when its context passes `FLIGHT_CONTEXT_ROTATE_TOKENS` (150K tokens: input plus cache read plus cache creation of its last turn), or after `FLIGHT_MAX_WAKES` wakes, whichever comes first.

- **Over the limit.** At its next idle point the watch sends one handover wake (not counted as a wake): FLIGHT writes what it is in the middle of, promised and waits on with `track` and `remember` (topic `handover`), then ends its turn. The turn after that ends the run and the next start is a fresh session, not counted against the hourly start cap.
- **The fresh session** reads `flight_state`, its tracked items, plans, memory and the latest `handover` note first; the start brief says so and carries the note. The note stays in memory until FLIGHT replaces it.
- **After a hub restart** the handover wake is not sent twice for one run: a repeat is refused as a duplicate and the run rotates.
- **The guard cools down.** After the handover cap trips (4 handovers in an hour) the hub stops restarting FLIGHT, says so in Needs you, and starts FLIGHT again by itself 30 minutes later (`FLIGHT_GUARD_COOLDOWN_MS`). A trip within an hour of that restart stays stopped until the operator starts FLIGHT. Messages sent while FLIGHT is down are kept and reach it when it starts.
- **Owed answers.** An operator message FLIGHT has read and not answered (no FLIGHT message with `replyTo` naming it) is the `owed` wake fact: it wakes FLIGHT and stays in the wake until FLIGHT replies, for up to 7 days (reacting to it or settling it also clears it). An item reply sent while FLIGHT is down is stored and arrives in the wake when FLIGHT starts; the discussion route no longer answers 503.
- **FLIGHT runs Update.** On a `flight_powers: superuser` repo FLIGHT may call `POST /api/update` through `mc operator` only for an Update the hub holds for a person (the held-Update item is open; otherwise 409), and only once no other crew seat is working (409 names the seat). It is logged as "Updated by FLIGHT". On any other repo it answers 403. The operator's own call is unchanged.
- **The FLIGHT page** gets `seat.context` from `GET /api/flight`: `{ tokens, rotateAt, text }`, where `text` reads "context 142K · fresh session at 150K" (null with no turn yet).

## Repeating a suspected flaky test

Use **Actions → Repeat one test file → Run workflow** on the branch to check. Supply one exact
`.test.ts` or `.test.tsx` path under `apps/` or `packages/`, a count from 1 to 100, and optionally
a Vitest test-name pattern. The job runs that file repeatedly with one worker and keeps going
after a failed repetition, up to its 60-minute job limit. This is a manual diagnostic; it does
not replace the full CI checks required for merging.

Download the `repeated-test-results-<run id>-<attempt>` artifact. Each repetition has a log and
Vitest JSON report. `summary.json` records the checked-out SHA, tracked-file dirty status, input
file and pattern, every outcome, and requested/completed counts. A finished summary has
`finalized: true`; `success: true` requires every requested repetition to execute at least one
test and pass. A missing or invalid report, an unsuccessful process, or a pattern that executes
no tests fails the diagnostic. A cancelled or timed-out job can leave an unfinished summary;
it is not passing evidence. Artifacts are retained for seven days.

For the same diagnostic locally, from the repository root:

```sh
TEST_FILE=apps/server/test/supervisor-events.test.ts TEST_REPETITIONS=10 \
  node --experimental-strip-types scripts/repeat-test.ts
```

Set `TEST_NAME_PATTERN` for a particular test. Local results are written to
`.mc-tmp/repeat-tests/`; copy any evidence you want to retain before the next invocation.
A dirty checkout's result is not proof of an unchanged commit.

## Affected tests before a crew push

This repo requires `pnpm -s lint`, `pnpm -s typecheck` and
`pnpm -s test:related` before `mc push`. The existing hub check recorder counts
a command only when it starts and finishes on the same clean commit in the session clone. A
failed or missing command holds the push and names the check to run. Run checks after committing;
a check on uncommitted edits is not evidence for that commit. Re-run after changing the head.

The wrapper verifies `origin/HEAD`, its commit and the merge base, then passes the immutable
base SHA to Vitest. This prevents a missing-ref comparison from becoming a no-tests success.
Vitest's changed mode selects changed test files and tests importing changed source files against
the merge base with the clone's `origin/HEAD`. Its configured force-rerun triggers still apply.
A documentation-only diff can legitimately select no tests; that is different from a named flaky
test diagnostic, which must execute tests. The full CI suite remains required before merge.
This selection uses the import graph; it cannot discover arbitrary runtime file reads, so authors
still run targeted fixture/role checks for those changes and reviewers verify the coverage.

If `origin/HEAD` cannot be resolved, the check fails; the controller repairs the clone's default
branch ref rather than changing the required command. The hub never executes the seat's check
code in the server process. Its existing exception for engine-only clean merges of main is
unchanged; this check gates seat-authored pushes and does not certify that separate publish path.

### Tests a seat's sandbox cannot run (#1411)

Some tests need what a seat's sandbox denies: `sandbox-exec`, listening on a port, or
`pnpm install` with a store, or starting a crew run (its temp folder, and `ps`). A change to a widely imported file selects them all, and in a seat
they could only fail (the installs run to their timeouts), so `test:related` could never pass.
`apps/server/test/sandbox-gaps.ts` skips such a test only when both hold: the process runs under a
seat's sandbox (`SANDBOX_RUNTIME=1`) and a probe of that capability fails there. CI sets no such
marker and runs every test. Where the sandbox allows the capability, the test runs and a real
failure still fails. Each skip is named on stderr (`sandbox-gaps: skipping ...`). Mark a new test of
this kind with `blockedHere("listen" | "seatbelt" | "install" | "crew-run")`.

The seat is told by `MC_SEAT_SANDBOX=1`, which the hub puts in every crew seat's environment
(Claude and Codex), or by the Claude sandbox's `SANDBOX_RUNTIME=1`. The shared rule and the
`listen`, `seatbelt`, `ps` and `git-hooks` probes are in `packages/core/test/sandbox-gaps.ts` (no
server imports, so agentcomms tests use it too); `install` and `crew-run` are in
`apps/server/test/sandbox-gaps.ts`. Whether Codex's own sandbox passes the variable on to its shell
commands is not verified.

The test-lock row's outcome: `fail` when the hook reports a failed call, `pass` for a plain call
that succeeded, and `done` (never `pass`) for a call that pipes or chains past the check, such as
`pnpm -s test; echo exit=$?` or `... | tail`, because its status is the last step's. That is the
path that fits the 4 Nov report (lock `pass`, the seat saw exit 1, no check record, since a chain
with `;` or `|` is never counted as a check). A Codex command releases as `fail` when it did not
succeed, and as `done` when it succeeded but piped or chained past the check. A Post whose hook
exit code is null (interrupted or background) is unknown: the lock row ends `done` and the check
recorder stores not-ok, so it never counts toward the push gate. A review run's `done` locked call
still shows in the QA report as a hub receipt, with no pass claimed.

Not covered by a test in a seat: the Codex release outcome (`supervisor-checks.test.ts`, which
needs a crew run and so skips in a seat; CI runs it), and whether Codex's own sandbox passes
`MC_SEAT_SANDBOX` on to its shell commands. A Codex seat that shows tests failing on `listen`,
`ps` or `sandbox-exec` instead of skipping is the sign it does not; report it.


### Durable QA reports

Ticket details, including closed tickets, show a **QA reports** section with immutable report
links for associated PRs. The ticket timeline also opens report references in Comms. Missing
reports are stated explicitly; a closed ticket does not establish recorded QA coverage.

Choose visual evidence for the change. Layout changes need page context at the required viewport
sizes; changed forms or components need focused before/after views plus enough context to locate
them. Capture additional states such as validation, expanded controls or keyboard focus when they
are part of the change. Use a full-page capture when content beyond the viewport matters; bounded
scrolling panels need their own relevant states. A full-page image does not prove those states.
Pair labels and provenance must name the page or form, capture scope (viewport, full page or
region), viewport size, theme and state. Match data, clock and state across before/after captures,
and name their source commits. Record the checks performed and untested areas separately.
Existing native captures use viewport screenshots; do not describe them as full-page evidence.

Each new native `report_findings` call saves its findings and immutable QA snapshot in one database
transaction before notifying the engine. The content-addressed JSON report records its exact PR/head,
reviewer and model, review time, registration time, original verdict, checklist, test receipt provenance,
findings/resolutions, works-well observations, limitations and follow-up dispositions. A saved verdict
is historical evidence; it never grants current merge approval or replaces CI, acceptance or repo rules.

`GET /api/qa-reports?repoId=<repo>&prNumber=<number>&headSha=<40-sha>` lists up to 100 saved reports.
The head filter is optional; repo and PR are required. `GET /api/qa-reports/<64-hash>` reads one JSON
report, and `/api/qa-reports/<64-hash>/markdown` exports its Markdown. These reads require a configured
repository and work after merge without an open queue row. The UI permalink is
`/qa?repo=<repo>&pr=<number>&report=<64-hash>`. Native rework/Comms and existing PR-body/review-comment
paths cite that report. The server does not introduce another GitHub write path.

`POST /api/qa-reports/import` requires the actual operator token and refuses seat credentials. The
bounded body names repoId, prNumber, exact headSha, reviewer, nullable reviewedAt, sourceRef (this PR's
GitHub review/comment permalink), verdict and summary. Optional worksWell, coverage, findings,
resolutions, tests, limitations, followUps and visual fields retain gaps honestly. Imports create no
Run or native review. Registration time is current; an unknown original review time remains null.
The server verifies the exact current GitHub PR head, including merged PRs, and observes CI afresh
on that head. The observation time and source stay with the snapshot.

Test counts supplied by a reviewer remain `reviewer-reported`. Hub command completions are
`hub-receipt`, bound to the review run and head. Shared-lock receipts prove a tool invocation, but
keep numeric exit/counts/source cleanliness unknown when those were not recorded. A controller may
register `controller-recorded` receipts with their actual time, exit and retained evidence. Counts
alone never fulfill the execution-receipt requirement. Missing receipts, checklist coverage, original
time or required images make the report incomplete; they are not displayed as a clean sign-off.

The report embeds the native image manifest and copies before/after and browser PNGs into private
content-addressed `qa-report-assets/` storage. `/api/qa-report-assets/<sha256>` serves a referenced
retained PNG independently of the native three-head/age sweep. PNG reads keep the existing
operator-header protection and private/no-store policy; archive metadata does not expose their bytes. Report JSON lives in the private
`qa_reports` table, outside the operational review/run sweep. It is never rewritten. Controller
image links must be same-repository immutable Git commit PNG URLs with capture provenance.
Reconstructed controlled fixtures are labelled as such; they never become live captures or original
approvals. Known web changes require before/after pairs even if a reviewer supplies a nonvisual reason.

Report import and native snapshot secret scans fail closed when known credentials cannot be read.
Raw strings are scanned before JSON escaping, and rejected secrets are neither saved nor echoed.
Only bounded validated report fields and PNG assets enter this archive; no submitted path is read
from the controller's filesystem. Images still need a human check for sensitive visible data.

## QA history

Open **QA → History** to browse saved report versions and older completed native review records.
The index includes configured repositories only, with at most 50 entries per page. Select a repository
or use **Older reviews**. Registration time orders saved reports; native completion time orders original
records, with creation time as an explicit fallback when completion was not retained. Full identity
expands with the keyboard. Opening a row loads its detail; browsing the index loads no images.

Saved reports keep their original PR/head, reviewer, review time (or unknown), CI snapshot and evidence.
They survive native review pruning and open even after a PR closes or leaves the queue. Their historical
verdict never grants acceptance or deployment readiness for another head. Use **Current** for current work.

Original native records include reported, failed and superseded review attempts that have no matching
saved snapshot. They retain their actual seat, exact head, summary, findings, coverage and reported test
counts where available. Original resolutions and retained hub command records are shown separately;
lock-only records keep their unknown exit/outcome and source-cleanliness limitations. Failed attempts without a verdict stay unknown. Reads do not reconstruct reports,
fetch current CI, or change history. Native records still follow existing retention; already pruned records
cannot be recovered here. Legacy screenshot references load only on request with existing operator auth;
the original bytes may have expired. Missing CI, checklist coverage, applicability or images is stated,
not treated as a pass. Finding resolutions on these legacy records reflect the currently retained state.

The read-only API is `GET /api/qa/history?repoId=<configured-id>&limit=50&cursor=<nextCursor>`
(all configured repos when `repoId` is omitted), plus `GET /api/qa/history/native/:id?identity=<full-record-hash>` for original records.
Use the returned native permalink; an identity mismatch or pruned record returns 404, so a reused row
ID cannot silently open another review.
Only page summaries are returned by the index. Existing immutable report and protected image routes
keep their permission checks.

## Crew Comms: what a seat reads and is sent

- **Pushed once.** The hub attaches a seat's unread inbox messages to a run's start and to a line it
  delivers between turns, then marks them read. It does not attach them again. `comms_inbox` still
  lists older ones.
- **`comms_read` is by ticket.** With no arguments a seat gets only the messages on its own run's
  ticket, one line each of at most 200 characters, newest last. `{ id: "comms:N" }` returns one
  message in full. `{ ticket: "repo#n" }` (or `#n`) names another ticket, and `{ channel: "crew" }`
  the team channel. FLIGHT has no ticket: its default is the short form across tickets. A seat sees
  no more than before; only the default is narrower.
- **One ticket form.** A seat's message is stored under `repo#n`: the ticket in its ref, else the
  ticket of the message it replies to, else its run's ticket. Older rows stored `#n`; reads treat
  both as one ticket.
- **Start brief.** A run's first message (a build run's, and a review run's) lists the ticket's answered questions (FLIGHT's recorded
  answer), one line each, ten at most, under "Already decided on this ticket".
- **Exact repeats.** From any sender, the same sender, recipient, text, ticket and label within 60 seconds is stored
  once. The sender is told "Already sent comms:N." (a success), nobody is woken again, and a row in
  `comms_repeats` counts it (`store.commsRepeatCount(since)`), kept 90 days. The operator's routes
  (`POST /api/comms`, `POST /api/seats/:id/message`) answer such a send with 200 and
  `alreadySent: true`, with the first copy's state. Both also return `state` and `deliveredAt`.
- **Stored, then delivered.** Every message has `deliveredAt`, null while only stored. It is set the
  first time the recipient seat takes the message (its inbox is attached to a turn). An operator
  message (either route) wakes the seat it is sent to; a plain message to a seat with no live session stays stored; a working seat takes it at its next turn. `POST /api/comms`
  returns `{ state: "stored" | "delivered", deliveredAt, alreadySent }`; `GET /api/comms/:id/state`
  reads it later.
- **A reply to an ended run.** `GET /api/comms/:id/reply-route` says before sending where the
  operator's reply to a seat's message goes. If the run that wrote it has ended, it goes to the seat
  now on that ticket, else to FLIGHT, and `POST /api/comms` reports `redirectedTo`. The redirected reply keeps the ticket but is not linked to the ended run's message and does not mention or wake its seat. Replies only:
  an answer to a question never takes this route.
- **Waking and closing.** A seat is not woken for a Comms message while it is mid-turn (it takes
  its inbox at the next turn), and FLIGHT is never woken by these routes (the hub wakes it). A
  plain message through `POST /api/seats/:id/message` closes no question; a reply that names a
  question (`question`) closes that one only. A failed wake leaves the message stored and marks it,
  so an identical retry wakes the seat again.
- **Choosing an option.** `POST /api/attention/:key/choose` with `{ optionId, briefAt }` is the one
  way a choice acts; chat text never picks an option. `briefAt` must equal the open brief's time and
  `optionId` must be one of its options. A brief the hub wrote (`by: "hub"`, such as a queue change) is refused with 409: it acts through its own buttons. The brief is claimed before anything is sent, so two picks at once deliver once. The answer goes to the run that asked and wakes it; if
  the answer is worded and stored as the chooser's (the operator, FLIGHT through its operator tool, or the controller; `question_choices.chosen_by`), never as the operator's when FLIGHT or the controller chose. If that run has ended it goes to FLIGHT, to pass to the ticket's next run, never to another run
  directly. FLIGHT's own question goes to FLIGHT, woken. When a seat asked, FLIGHT gets one
  unlabelled line at its next wake (no wake). The question closes, the choice is stored in
  `question_choices` (kept 365 days) and shows in the ticket's timeline as a `choice` decision;
  nothing is written to GitHub. The route returns a receipt (what was chosen, where it went, when
  delivered); choosing the same brief again returns the first receipt. `GET /api/attention/:key/choice`
  reads it later. A non-question item (a note, a crew error, an open Comms item) is closed at its
  source, then acked. `store.isChoiceAnswer(id)` tells a reader the message is a hub-built answer,
  not something the operator owes a reply to with the current delivery time.
- **Stamped by the hub.** A seat's message also stores the run that sent it (`from_run_id`) and
  that run's newest open PR (`pr`); an agent types neither. `comms_read { id }` shows both.
- **Sender kind.** Each message stores who sent it: `operator`, `controller`, `flight`, `seat` or
  `hub` (column `sender_kind`; a Comms read returns it as `senderKind`). The hub sets it from how
  the request was made, never from the text. `operator` is a person using the app (sender
  `CAPCOM`). The controller sends with its own token (`<data dir>/controller-token`, header
  `x-mc-controller`, new each boot), as `CONTROLLER`; it passes where the operator token does and
  grants nothing more, and a `CONTROLLER` line wakes FLIGHT as `CAPCOM` does. FLIGHT's `mc operator`
  sends are FLIGHT's. The hub's own messages are `hub`, sent as `MC`, never `CAPCOM`. Rows stored
  before this have no kind (`senderKind` is null) and keep their old sender.
- **Retention.** Messages and FLIGHT's decision log keep 90 days. Answered seat questions,
  FLIGHT's `answer` and `pass` decisions, question messages (label `question`) and the replies to
  them keep 365.


### Clearing a Needs-you item

`POST /api/attention/:key/clear` with an empty body returns `{ cleared: key }`. The operator or
independent controller can clear an acknowledged item too. A delegated FLIGHT actor is refused
with 403; a missing item returns 404, `That item is no longer waiting.` The runaway flag directs
the operator to Lift and stays in force.

Clear records a `cleared` closure, closes the displayed source and stores its notices atomically.
A waiting seat receives a notice for its exact preserved run. FLIGHT receives one hub line.
Existing approvals, budget stops and run holds remain in force. A new ask can appear again;
refreshing the presentation cannot reopen the cleared ask. A queued legacy default for it stays
undelivered and is excluded from new delivery attempts.

FLIGHT can withdraw its own brief from a protected item. This retains the underlying question,
source and protections; the original brief remains in history. Its unfinished-wake reminder stays
in FLIGHT's wake and is omitted from operator attention. Answered and superseded note briefs
are excluded from the current projection.

## Disk housekeeping

The hub removes its own finished work so its data folder stops growing (#1756). Once an hour (and two minutes after boot) on the live hub, `apps/server/src/disk/sweep.ts` runs one sweep and logs `disk sweep: removed N item(s), B bytes, from the data folder` when it removed anything.

- **Pictures and evidence only while a PR is open.** A PR's `pr-evidence/<repo>/<pr>` folder, its QA report images (`qa-report-assets`) and its review screenshots (`review-screenshots`) are removed once the PR is no longer open and its files have sat untouched for an hour. The QA history keeps its text record; its picture links then stop resolving.
- **Scratch is temporary.** Every folder under the data folder's `controller/` (except `controller/designs`) and under `pr-evidence-work/` that has been untouched for 3 days is removed.
- **Only inside the data folder.** The sweep never follows a symlink and never removes a path that resolves outside the data folder. It does not touch observed loops or their worktrees.
- **What the hub holds.** `GET /api/disk-use` returns bytes by kind: `worktrees` (the crew's worktree folder), `pictures`, `evidence`, `scratch`, `database`, and their `total`. It is measured at most once a minute.

- **One cap.** The hub's budget is 10 GB (`MC_DISK_BUDGET_GB` overrides it), counted over the data folder (worktrees are the tidy's). Over it, the same sweep removes idle scratch (untouched for a day) oldest first, and logs `disk budget: ...` naming what the hub holds by kind. It never removes an open PR's evidence, a QA image or review shot an open PR cites, or scratch touched in the last day (a running preview or capture); when only that is left it logs `only open or in-use work is left` and stops. The disk flag ("Machine headroom is tight") adds `The hub holds: worktrees ..., scratch ..., evidence ..., pictures ..., database ...` when the disk is what is tight.
- **No stalls.** The sweep, the sizes and the deletes use async file calls, and one measurement (cached for a minute) serves `/api/disk-use`, the sweep and the flag.
- **Crew worktrees.** Every 10 minutes (where the engine runs) the crew tidy looks at runs that ended in the last 30 days. If the branch's PR has merged or closed, or the run's ticket is Done on the board (PR or not), the clean worktree is removed (the branch stays). If the work is still open (a set-aside run), only that worktree's `node_modules` is removed, so it stays small; the seat reinstalls when the run resumes. The checks and the removal run under the clone lock, so a run that is resuming (installing into the worktree) is never trimmed. A dirty worktree, a live run's, one a seat still holds and one with a checkout being prepared are left alone. The log line is `worktree tidy: removed N worktree(s), trimmed M node_modules`.

Not built yet: a budget key in `config.yaml`, pictures attached to a Needs-you question (they are removed when that feature lands), and the Mac panel's disk view (it reads `/api/disk-use`).
