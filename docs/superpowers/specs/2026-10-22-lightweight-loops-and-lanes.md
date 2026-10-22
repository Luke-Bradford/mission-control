# Lightweight loops, and two lanes on one board

Status: agreed by the operator on 2026-10-22, after a review by Codex. This note replaces the build-loop spec's "generic runner" plans, and it guides how both machines work the backlog.

## Principle

A thin fixed core in code. Everything else is prompts and config that live outside the target repo.

**Fixed in code** (it must hold whatever a model does):
- the seat sandbox: its worktree, no network for Bash, no git or hub state;
- which tools each role may call, and the commands seats may run;
- only the hub writes to GitHub, under the operator's account;
- the merge gate: the head sha only, never on a hard-rule touch, never in a draft workspace;
- the existing engine and reconciler.

**Prompts and config**, in user config (`~/.config/mission-control/`), never in the target repo:
- role prompts;
- template profiles: the steps shown, a checklist for the brief, whether a plan is required, the reviewer role and depth, the required checks, the limits;
- the label-to-profile map;
- hard-rule paths, areas, seat commands and protected files;
- accounts and models.

A repo's own `## Mission Control` block becomes an optional override. Agents use the target repo's own `CLAUDE.md`, `.claude/skills` and `.claude/agents` as reference material. FLIGHT checks what a repo or a new seat is missing, and drafts the user-config change for the operator to approve.

**Not built now:** a generic workflow runner, or a template language. Profiles feed the engine that exists. A richer runner is reconsidered only if measurements show we need it.

## Two lanes on one board

Each Ready card carries exactly one lane label, and only that lane's machine starts it.

- **`lane:work`, the work Mac: the HUD stream.** Everything the operator sees and uses: the web screens, plus the server endpoints that only they need, built together. It also stays the planning lane, which refines Backlog into Ready and keeps tickets in the shape `CONTRIBUTING.md` sets out.
- **`lane:home`, the home machine: the engine and crew stream.**
  - start rules;
  - when seats are freed;
  - template profiles;
  - review;
  - CI tracking;
  - attempt history and audit;
  - user-config rules;
  - FLIGHT onboarding and wakes;
  - Needs you (#155–#158).

**Until #163 enforces lanes in code:**
- When the work Mac moves a `lane:work` card to Ready, it assigns `ap-lukebradford` at the same time.
- The home hub already skips cards assigned to another login.
- A Ready card with no lane label is treated as home.

**Rules for both lanes:**
- **Choosing a lane:** the work that decides it. A server ticket that only feeds a new HUD screen goes with that screen in `lane:work`.
- **Crossing lanes:** a ticket that needs both lanes is split into one ticket per lane, with a `Depends on #N` line.
- **Merging:** each lane merges its own crew's PRs once RETRO is clean and CI is green. On this repo, hard-rule PRs are merged by that lane's controller after a check of the hard-rule hunks.

## Review depth

As changed in `CLAUDE.md` on 2026-10-22:
- **Small changes** (Size XS or S, or `chore`, `test` or `docs`) get one review pass on a capable model.
- **Features, bug fixes and anything M or larger** keep the final review on the most capable model.
- **Periodic tech sweeps** catch what light reviews miss.

## Plan, in order

| # | Lane | Outcome |
|---|---|---|
| 1 | home | #163: one start check for every path, and the lane filter. |
| 2 | work | #164: the Agent page's Loop panel from today's data. #165: Overview's loop column and set-aside runs with their wait reasons. #166: hand-offs recorded as messages, then the web Messages view. |
| 2 | home | #155–#158: Needs you with an owner per item, FLIGHT's brief, actionable cards, and the cleanup bug. |
| 3 | home | #167: a writer is freed once its PR is open and its turn has ended, with a cap on its unfinished runs. |
| 4 | home | #168: template profiles from user config. #169: RETRO's instructions settled, and review depth by size. #170: CI by named check. |
| 5 | home | #171: attempt history. Then #172: the AUDIT nightly report. |
| 6 | home | #173: repo rules from user config. #174: seats use the repo's skills. #175: FLIGHT onboarding. #176: FLIGHT wakes on new triage. |
| 7 | both | Measure (time to merge, rework wait, CI and review cycles per PR), then pick the next bottleneck. |

## What Codex corrected, and why the plan looks like this

- **Running the tests in the hub before push** would run branch-controlled code with the hub's privileges. CI stays the verification gate. A local verifier would need its own sandboxed worker.
- **Freeing a seat at push** breaks draft-PR creation, which needs the seat to hold the run. So a seat is freed once its PR is open and its turn has ended.
- **A repo-scoped token is not a sandbox alternative**, because `contents: write` can merge. The sandbox and the hub-mediated writes stay.
- **The mockup's templates are display data,** not an executable language, so the plan uses profiles rather than a runner.
- **Show the operator progress first,** using the data that already exists.
- **The two-machine assignee claim isn't atomic,** which is why the lane labels exist.
- **The automatic queue checks less than FLIGHT does,** which is why there is one shared eligibility check.

## Backlog under this plan

- **In flight:** #155, #156, #157, #158, #141 (home).
- **Kept as regression cases:** #115 and #132 become tests in #163 and #167. Close them when those tests pass.
- **Kept, separate:**
  - #91: RETRO reviews every PR.
  - #80: a merged PR's minor findings become one ticket. This is not the audit.
  - #61 and #63: other repos.
  - The restart chain, in `lane:work`: #97 depends on #146 and #147, and #96 is in progress on the work Mac.
  - #60: research, for when local service tests are needed.
- **Small debt,** labelled by lane: #32, #102, #105, #108, #111, #119, #124, #127, #129, #133, #134, #142, #148, #153, #162.
- **#1–#14:** the planning lane checks each one's actual failure scenario. Each is then refreshed into the ticket shape, or closed with its reason. None is closed only because the HUD doesn't show it.
- **Closed:** #18, the RETRO tracker, now covered by #169 and #91.
