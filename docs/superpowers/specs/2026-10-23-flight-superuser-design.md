# FLIGHT as the crew's superuser

**Status:** design, 2026-10-23.

This changes four earlier texts, as set out below:
- §8.1 of `2026-10-20-build-loop-flight-design.md` (what FLIGHT never does);
- §8.2 and §8.5 of the same spec (its tools and its asks);
- the "no merge tool" and "For the controller" steps in `roles/FLIGHT.md`;
- the hard-rule merge line in `CLAUDE.md`.

§8b.1 of that spec (crew isolation from the operator's environment) still stands. Where this design and older text differ, this design wins.

## Why

The operator's words:
- **2026-10-22:** "FLIGHT must be able to do anything needed to keep everything moving, as the controller does."
- **2026-10-23:** "flight needs to be a super user"
- **Also 2026-10-23:** "it's the head, the main agent, should be elevated and override anything, help out and do anything … If it needs to merge things, it should make that judgement. If it needs better research, skills, tools, it should get those. It has its own page, to use for recording its notes … taking some ownership of progress and steering work … Being able to respond to questions from me or any agent."

The evidence from 22–23 Oct:
- **FLIGHT handed most of its work to the controller.** In the 24 hours to 20:00 on 23 Oct it logged 220 notes, and 114 of them begin "For the controller:". Counted by keyword across all 220 notes, where one note can match several keywords: merge (98, many of them hard-rule merges), CI or checks (92), review (62), labels and lanes (15).
- **Its memory doesn't accumulate.** The brief has nine sections, at most 4,000 characters each, and was rewritten about 150 times a day. So known faults keep being found again.
- **PRs chased main.** The `main` ruleset required branches to be up to date, and the engine updated every PR that fell behind. On 23 Oct the operator turned the ruleset's strict check off, and #449 stops the engine bringing main in except on a conflict.

## The principle

FLIGHT acts with the operator's authority and its own judgement on the repos it is raised on.
- **Its judgement covers everything its tools reach,** including merges (hard-rule PRs and changes to its own powers too), accepting a ruling or a review, board fields and clearing items.
- **Its powers are hub tools, not a general shell.** Each tool covers a whole kind of work FLIGHT has needed, is pinned to a repo FLIGHT is raised on, and logs a basis. The hub enforces a short **floor**. FLIGHT's Bash keeps its sandbox: no network, no credentials, no writes. A general instrument, such as raw `gh`, any HUD route, or the operator's skills, can't be fenced reliably, so FLIGHT doesn't get one.
- **When FLIGHT lacks a power, it names it.** A "For the controller" note now means a missing power. The retrospective counts these notes and files each gap as a ticket for a new tool.
- **Code is written by the crew.** FLIGHT gets code changed by filing a ticket and starting a writer seat. It doesn't write code itself.
- **Questions reach FLIGHT through what exists.** The operator uses the dock. Seats use seat questions (`answer_question`). Loops' escalations reach FLIGHT as Needs-you items it briefs.

Elevation is set per repo, in the user config only:

```yaml
# ~/.config/mission-control/config.yaml
repos:
  - id: mission-control
    autonomy: merge
    flight_powers: superuser   # standard | superuser; default standard
```

- **Where it can be set.** No repo's `mc:` block can raise it, and `POST /api/repos` doesn't accept it.
- **When a change applies.** It reloads live, without a restart. FLIGHT's seat restarts when the value changes, and the guard checks it on every tool call.
- **Where it is raised.** It is set to `superuser` on `mission-control` only, and only once the merge ticket (#457) has landed, so hard-rule PRs are never stranded. The observed loops' repos stay `standard`.

## The floor

The hub enforces these even for a `superuser` FLIGHT. They are a recommendation; the operator can strike any line.
1. **The default branch.** No force-push, history rewrite or direct push to it. No deleting a repo, or a branch that hasn't been merged.
2. **The safety net.** No changes to branch protection, rulesets, secrets, collaborators, keys, repo settings or the CI workflow. That means FLIGHT doesn't merge a PR that touches `.github/**`; it gives the operator its recommendation instead.
3. **Untrusted code.** No merging a PR from a fork whose author isn't a collaborator, and no approving a fork's workflow runs.
4. **The operator's decisions.** An operator's pause, stop, hold or answer wins. So do money budgets and account stops. Each tool names the record it checks: seat state `stopped` versus `error`, budget parks, account usage stops, and open operator questions. Away mode joins this list with #340.
5. **Its own powers.** FLIGHT can't change `flight_powers`, the user config, or anything the operator approves. The one exception is #402's priority approval on `superuser` repos (#458).
6. **Going live.**
   - **Auto-Update is an allowlist.** It applies only ranges whose every path is under `apps/web/src/**`, `apps/web/public/**`, `apps/web/index.html` or `docs/**`.
   - **Everything else waits:** server, packages, roles, any `package.json`, lockfiles, workspace and npm config, and build config. The operator, or the controller session on this repo, runs that Update after reading the held range, never FLIGHT. While a range is held, later web-only commits wait behind it.
   - **The check runs inside `update()` after its own fetch,** and it pulls exactly the SHA it checked.
7. **The repo's own rules.** On a `superuser` repo, FLIGHT never clears a PR that changes the `## Mission Control` section in `CLAUDE.md` (heading through the next section) or `.github/**`. That block is read live at `origin/HEAD`, so a merge alone would change the rules. The engine enforces this at its merge step, from a fixed list in code. The effective hard-rule list there is the repo's list plus `DEFAULT_HARD_RULES`.

**Tradeoff, stated plainly.** FLIGHT can merge changes to its own guard and tools. By mistake, or through text injected into a ticket or PR, it could widen what it may do. That change only goes live when the operator or the controller session runs Update, and FLIGHT can't clear a change to the repo's rules or CI. Protection, the history of `main`, CI and the config stay out of its reach.

## Slices

Each slice is one ticket. Order:
1. #262 and #198 start first.
2. #449 has no dependency.
3. #457 (merges and settles) depends on #198 and #449.
4. #458 (board) depends on #198.
5. #459 (research) depends on #198 and on #203's home-read build tickets.
6. #176 depends on #198.
7. #450 depends on #176.

### #262: evidence in the digest (S; in progress)

- **For each PR in review,** the digest carries RETRO's verdict, the blocking-finding count, the head and the failing check names.
- **A ruling park** carries the seat's report.

### #198: the powers foundation (M)

- **The `flight_powers` key.**
  - It comes with a `requirePowers` helper.
  - It reloads live: `settle()` in `crew-apply.ts` copies each repo's value.
  - FLIGHT's seat restarts when the value changes.
  - A `flightPowers` field on the guard context is checked on every call.
- **The auto-Update allowlist (floor 6).**
  - The check runs inside `update()`, after its own fetch, behind `{ auto: true }`.
  - It pulls exactly the SHA it checked (`merge --ff-only <sha>`), and refuses if `origin/main` moved after the check.
  - A held range raises a Needs-you item that lists the held commits and their paths.
  - A manual Update is unaffected.
- **Floor 7 at the engine's merge step.** A fixed list in code. The effective hard-rule list is the repo's list plus `DEFAULT_HARD_RULES`. `update.ts`, `config.ts` and `crew-apply.ts` are added to `DEFAULT_HARD_RULES` and to `CLAUDE.md`'s block.
- **The role rewrite** covers only what has landed: the principle, the floor, code written by the crew, and naming missing powers. Each tool ticket adds its own lines.

### #449: merge without bringing main in (S; no dependency)

This replaces the merge queue that this design first planned. The operator turned off the ruleset's up-to-date check, so no queue is needed.

- **What the gate needs.** `gateView.passes` no longer needs the branch to contain `main`. It does need GitHub not to report the PR as conflicting.
- **When main is merged in.** Only a conflict brings `main` into a branch.
- **Notes.** No hold note is raised for a PR that is only behind `main`. A hard-rule PR gets its ready note straight away.
- **Order.** Order comes from FLIGHT's Priority.
- **A red main.** CI on `main` after a merge catches one, and #176 raises it to FLIGHT.

### #457: FLIGHT merges and settles (M; depends on #198 and #449)

- **The hard-rule join.**
  - On a `superuser` repo, a hard-rule run PR that passes every other gate waits `awaiting-flight`, which is a wake fact for FLIGHT, until FLIGHT clears it.
  - `hard_rules_by` resolves to FLIGHT.
  - `CLAUDE.md`'s hard-rule merge line changes in this PR.
  - `mission-control` is raised to `superuser` only after this merges.
- **`merge_pr { pr, basis }`.**
  - It clears an `awaiting-flight` run PR in FLIGHT's lane.
  - The clearance carries across a conflict merge of main when the PR's own diff is unchanged.
  - It refuses floors 2, 3, 4 and 7. Floor 4 is checked against seat state `stopped` versus `error`, park kinds and operator holds.
  - The hub checks the basis with `scanSecrets` and the notifier check, clears the head, then posts the basis.
- **`settle_park { runId, action, note?, basis }`.** Uses the same lane check as `merge_pr`. The actions are:
  - `lift`: only a stuck park whose head descends from the push, with no per-run limit;
  - `rereview`: a fresh RETRO review, with no per-head limit; the only action for a `review-failed` park;
  - `accept`: only `review` and `review-ruling` parks, through the existing waiver path (`reviewWaivedSha`; `mc/review` is set to "waived"). CI must pass before merging. A head touching `FLIGHT_FLOOR_ENFORCING_PATHS` needs a reported, unblocked RETRO review on that head. CI `ruling` parks use `accept_ruling` (re-run, then accept);
  - `rework`: sends the findings to the seat, followed by the optional short `note`. On a review park, FLIGHT may grant as many rework rounds as it judges right; each grant gives the head one more blocking review before the run parks again.
- **`rerun_ci { pr, basis }`.** Re-runs a run PR's failed jobs, with no hourly or per-head limit. FLIGHT's writes have one limit, the runaway breaker (docs/runbook.md, FLIGHT runaway breaker).
- **Untrusted authors.** `read_ticket` and the digest mark text written by people who aren't collaborators, from a cached `GET collaborators/{login}/permission`. Only `write`, `maintain` and `admin` are trusted; results last 24 hours, entries older than 7 days are pruned, and cached authors need no GitHub call on wake. The role doesn't act on that text without the operator.

### #458: FLIGHT runs the board and Needs you (M; depends on #198)

- **`edit_card { issue, size?, priority?, lane?, assignees?, labels?, basis }`.**
  - Assignees are limited to configured logins.
  - It refuses `always_ask` cards, and cards in another lane except to settle a lane conflict.
  - On a `superuser` repo, priority changes skip #402's approval.
  - Status moves stay with `promote`.
- **`dismiss_item { key, basis }`.**
  - It clears items that aren't operator-owned or `lane:<login>`-owned, plus items whose subject has resolved.
  - It never clears guard acks, budget or account items, approvals, or the auto-Update hold.

### #459: FLIGHT reads GitHub and the web (M; depends on #198, and on #203's home-read build tickets or #203's recorded "accepted" decision)

- **`gh_read { path }`.**
  - GET only, on fixed path templates, for the repo FLIGHT is raised on.
  - It runs from an empty folder, with its own `GH_CONFIG_DIR` and `GH_TOKEN` from the hub's `gh auth token` (in the environment only).
  - It always passes `--method GET`, and refuses `-f`, `-F`, `--input` and `graphql`.
  - Output goes through `scanSecrets`, capped at 20,000 characters.
- **WebFetch and WebSearch** for a `superuser` FLIGHT seat.
  - The URL is normalised first (`127.1`, `0x7f000001`, `2130706433`). Then these are denied: loopback, `localhost`, `[::1]`, `::ffff:127.0.0.1`, private ranges, `169.254/16` and `fc00::/7`.
  - Only http and https are allowed. The host is resolved, and the fetch is denied if any address is private.
  - Whether WebFetch follows redirects to another host is checked by experiment.
  - Each case has a test.
  - The CLI's subagent tool name is checked by experiment before it is granted, with a test.

### #176: ops signals and triage (M; depends on #198)

- **The signals:** `flaky_test`, `repeat_park`, `main_red` (CI failing on main after a merge), `idle_seat`, `github_budget` and `hub_error`. Each wakes FLIGHT once per key.
- **Triage wakes:** new Backlog tickets, finished plans and resolved dependencies.
- **No wake on a phase change.**
- **The role:** fix it with your tools, or file a ticket.

### #450: memory and the retrospective (M; depends on #176)

- **The memory store:** a store per repo of lessons, the repo profile, the crew and playbooks.
  - Notes are evidence, never authority.
  - The operator can edit and delete them.
- **The retrospective.** The hub raises a retrospective wake fact at 03:00 local, so it runs even when nothing else wakes FLIGHT. FLIGHT files a ticket for each missing-power gap, and writes lessons, files tickets or acts with its tools on up to three other items.
- **The FLIGHT page panel** is a follow-on web ticket.

### Later

- **#460: an operator token on the hub's mutating loopback routes.** Today the HUD bundle and anything on the machine can call them. This comes before any power is widened further.
- **Repo skills as a readable index** (#174). The operator's own skills and plugins never reach the crew (§8b.1).
- **Ownership across repos** (#175).
- **Away mode overriding these tools** (#340).

## Security model

- **New GitHub writes,** all under the operator's account, only on `superuser` repos, and only through typed hub tools that log a basis:
  - merges of run PRs in FLIGHT's lane;
  - the engine's worktree merges of main (already made today, now in order);
  - CI re-runs;
  - `mc/review` set to "waived" by `settle_park accept`;
  - PR comments carrying FLIGHT's basis, after secret and notifier checks;
  - project fields, labels and configured-login assignees.
- **New reads:**
  - `gh_read` (GET only, fixed templates, one repo, output capped at 20,000 characters);
  - a cached collaborator-permission lookup;
  - WebFetch and WebSearch for FLIGHT's seat, with private ranges denied.
- **No general instruments.** FLIGHT's Bash keeps its sandbox. FLIGHT has no raw `gh`, no general HUD-route tool, none of the operator's skills or plugins, and no code writing.
- **The floor** is enforced in the hub's tools, the guard and the engine's merge step.
  - **Floor 6:** a merged change to the hub's code doesn't go live without the operator or the controller session.
  - **Floor 7:** FLIGHT can't change the repo's rules or CI.
- **Audit.** Every elevated call is logged with its basis. Lowering `flight_powers` takes effect at the next call and restarts FLIGHT's seat.

## Done when (measured once these slices have merged)

- FLIGHT's "For the controller" notes fall to near zero, and the retrospective reports the count.
- Crew PRs on `mission-control`, hard-rule ones included, merge without a person-side controller. Hub-code Updates are still run by the operator or the controller session.
- No PR is brought up to date with main unless it conflicts.
- A flaky check seen twice becomes a ticket with evidence, or gets fixed, before a person notices it.
- FLIGHT's memory holds the week's lessons, and its wakes cite them.
