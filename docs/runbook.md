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
`update failed at <step>; see update.log`: the hub keeps running and the old `dist` keeps serving.
An update that failed after its pull is not "up to date": pressing Update again skips the pull
(unless `main` has moved on since) and installs, builds, swaps and restarts.

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
| Config backups | `config.yaml.bak-<UTC time>` beside `config.yaml`: one written on every add from Setup › Repos, the newest 10 kept, mode 0600 |
| Database (SQLite, WAL) | `~/.local/share/mission-control/mc.sqlite` (override with `MC_DB`; its directory is created 0700) |
| Web build | `apps/web/dist` (run `pnpm install` then `pnpm build` again after web changes, then restart the server); Update builds into `apps/web/dist-next` and swaps it in |
| Update log | `update.log` beside the database: the last update's commands and output, mode 0600 |
| launchd logs | `~/Library/Logs/mission-control/server.log`, `server.err.log` |

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
   (`crew.deny_read: <path> holds the crew's own folders`), so list the folders beside
   `~/code/mc-crew`, not `~/code` itself.

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
  opens the draft PR (below). Any seat may ask you a question with `mcp__mc__ask_operator`. A
  read-only seat (RETRO) has the question tool and `report_evidence`, which refuses it (read-only
  runs have no loop).
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
  - the per-seat pnpm stores (`/tmp/claude-<uid>/mc-pnpm-store/<seat>`). They sit in the sandbox
    temp root, which every seat can read and write, so they keep pnpm's store out of the worktree
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

## Crew pushes and PRs

The seat-tool path (a seat calling push and draft PR) was checked end to end on the real CLI on
2026-10-21, through a preview hub, with a fake gh and a local origin; the record is in
[`docs/spikes/2026-10-21-mc-tools-guard.md`](spikes/2026-10-21-mc-tools-guard.md), under "End to
end on the real CLI". Since Plan 7a Task 7 the engine makes those calls instead, through the same
`pushRun` and `openDraftPr`; previews run no engine, so that path is covered by the engine's tests
and its first live runs, not by a preview.

### What a seat can do

A writer seat can do these things and nothing else:
- edit files in its area with Edit and Write (never the protected files, below);
- run `pnpm -s lint`, `typecheck`, `test`, `build` and `vitest` (with any arguments);
- read with `git status`, `diff`, `log` and `show`;
- call the mc tools: `commit`, `report_evidence` and `ask_operator` (the engine pushes and opens the
  draft PR after a report).

A read-only seat (RETRO) reads, runs `pnpm -s vitest`, and asks questions (its `report_evidence`
refuses: read-only runs have no loop).

A seat cannot run `git push`, `git commit` or any other git write itself, and its allowlist has no
`gh` at all. The guard refuses a typed git or gh write by name and records a hit
(`/api/guard/hits`, Comms › Guard). Code a seat runs fails too: its sandbox cannot write the
clone's git dirs.

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

### Reloading the config

Seat and role changes in `config.yaml` apply without a restart.

- `curl -s -XPOST -H 'content-type: application/json' -d '{}' 127.0.0.1:7420/api/config/reload` re-reads the file the hub started with. A
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

## What it observes

| Collector | Source | Cadence |
|---|---|---|
| `ta-loop:<id>` | `var/autonomy/loop.log`, `status.md`, `iteration-*.log` (stream-json) | 15 s |
| `studio-loop:<id>` | `logs/driver.log`, `logs/fire.*.log` | 15 s |
| `sessions` | `~/.claude/sessions/*.json` (live Claude sessions) | 15 s |
| `github:<repo>` | Project v2 board items, plus open escalation issues (read-only GraphQL via the `gh` token) | `poll.github_seconds` |
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

**Per-repo board rules.** Each repo can state how the build loop treats its board in a
`## Mission Control` section of its `CLAUDE.md`: prose for people and seats, plus the first fenced
`yaml` block under that heading, key `mc:`. The hub reads it at the repo's `origin/HEAD` (not a
seat's worktree), once per commit, so a change takes effect once it is merged and the crew clone
has fetched. Keys:
`pick_from` (statuses seats take tickets from; default `[Ready]`), `promote_backlog` (default
`false`), `areas` (area label → the globs it covers; a seat's focus is the labels inside its area),
`hard_rules` (paths that never auto-merge or auto-Update; absent or `null` means the built-in list,
`[]` means none) and `always_ask`; `needs`, `templates` and `ci` are accepted unchecked, for later
parts. An unknown key, or a wrong type in one of the keys above, is refused with the key named. A
repo with no `## Mission Control` heading gets the defaults; a heading with no yaml block (none
before the next `## ` heading, an unclosed or empty fence, or no `mc:` mapping) is refused, not
defaulted. `pick_from: []` and an area with no globs are refused, and an area glob must be
repo-relative with `**` only as a trailing `/**`. Nothing uses the rules yet (the build loop will,
and a refused block stops new tickets for that repo). This repo's own block is at the end of its
`CLAUDE.md`. `crew.run_token_budget` (default `400000`) is the input + output tokens one build-loop
run may use; the engine parks a run that goes over.

**FLIGHT holds.** With `promote_backlog` on, FLIGHT's `promote` can hold a Ready or Refinement card
that has no run: `to: "Backlog"` with `waits_on` set to an open PR in the session's repo (so it need
not have moved the card itself). The hold is a row in the `holds` table (ref, the PR, basis, time,
`released_at`), counts as a move under the hourly cap, and shows in FLIGHT's digest as
`holds: [{ ref, waitsOn, ageMin, prState }]`. When the PR merges or closes, the watch wakes FLIGHT
(`n hold(s) to release`); a closed-unmerged PR leaves the hold in place for FLIGHT to decide. FLIGHT
promotes the card to Ready again through `promote` with the usual checks, and that move releases the hold.

### Loop liveness

A loop that is killed mid-run never writes its end line, so its run would look `running` for
ever. Mission Control checks:

- **TA:** the `status.md` IN FLIGHT iteration is `running` only while its `pid` (the
  `ta_loop.sh` process) is alive (`kill -0`).
- **Studio:** the latest fire with no `exited` line is `running` only while a live Claude
  session in `~/.claude/sessions/` has the loop's `worktree` as its cwd. The sessions collector's
  15 s read is reused, and a fire younger than 60 s is given grace while its CLI registers.

Otherwise the run is shown as `unknown` and the loop's collector reports
`loop process not running (pid N)` (TA) or
`loop process not running (no live Claude session in its worktree)` (studio), so the card shows
an error. If the session registry cannot be read, the studio check is skipped (the `sessions`
row in health says why). A driver that dies *between* fires is not detected yet.

### Staleness

When a GitHub poll fails, the last good board and escalation rows stay on screen. Setup › Sources
then shows GitHub as **Failing** with each failing collector's error and each repo's last good
poll (the collector's `lastOkAt` in `/api/health`). A loop whose own collector fails shows as
**Error** with the reason, and as an error item in Needs you; a failure after a recovery pulses
again.

The 7-day projection uses the pace over the last 24 h of the current window's samples, or over
the hours the samples cover when that is less. Under 3 h of samples (just after a reset) there
is no projection: the Quota panel shows used % with no "full in … at this rate" line.

### Known limits

- **TA escalations are visible only via a label or an SD-32 block.** The TA loop escalates in
  ticket comments and has no `[operator-decision]`-style title marker. Mission Control sees
  its escalations only on issues that carry a configured needs-you label (default `needs-design`) or
  an SD-32 block, and such label-only escalations never make the TA agent Blocked.
  Plan 2 standardises this.
- **Studio pause arrives with cutover.** Only the TA loop has a `PAUSE` sentinel. The studio
  agent's page has no Pause, and the API returns 409.
- **The 5h windows have no projection.** Projection and stop forecast apply to 7-day windows.
  5h rows show only usage and reset time.
- Board items with no Status, or a Status missing from `status_map`, are not shown (skipped).
  Health names how many were skipped, e.g. "skipped 53 board item(s) with unmapped status".
- The codex app-server, which is the codex usage source, creates its own SQLite sidecar files
  (`*-shm`, `*-wal`) in `~/.codex` when it starts. That is codex's runtime behaviour, not a
  Mission Control write.
- When an earlier usage source fails and a later one succeeds, the account stays `ok` and the
  earlier failure's message is kept as a note in the collector's `error` field.

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
| **Telemetry** (`/telemetry`) | KPIs, flow of work (throughput, cycle time, quality, you as CAPCOM), agents (tokens per minute, per turn, time), capacity and cost, for 1h/6h/24h/7d, by agent or account. Charts take focus: ←/→ step the crosshair, Home/End jump. |
| **Setup** (`/setup/<tab>`) | Read-only: sessions, loops, accounts, roles/guard/test lock, sources (each collector's last poll) with the glossary, access and notifications. |

**Overlays.** FLIGHT's dock is a column at 1200 px and wider, and a drawer with a scrim below
that. The Item panel flies out from the right for one item; Away mode and Keys and lamps (`?`) are
modals. `Esc` closes the topmost; focus goes back to where it was.

**Keys.** `g` then `o` `f` `b` `a` `c` `t` `s` go to a page; `f` shows or hides FLIGHT; `j`/`k`
step through agents; `/` opens the selected agent (its composer is off for an observed loop) and
`i` says an observed loop is not interrupted; `?` help.

**Layout.** At 1000×560 and up the app fits the window and panels scroll inside (where even the
smallest panels do not fit, the work area scrolls); below that the page scrolls; at 390 px nothing
scrolls sideways. Reduced motion stops every pulse and leaves a still ring.

## Verification

The record of the first real run against the live loops (2026-10-17) is kept outside the repo.

Screenshots are not kept in the repo, because they would show a real board. Run a preview on a
copy of your own database (`MC_PORT=<port>`, `MC_DB=<copy>`, `MC_NO_LOOP_WRITES=1`) to see the HUD.
