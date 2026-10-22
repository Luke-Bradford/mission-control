# Contributing

Work is planned on the GitHub project board. A crew of agent seats runs from it, so people and
agents share one queue.

## Taking a ticket

- Seats take tickets from **Ready** by rule, oldest first, matching the seat's area label
  (`area:server`, `area:web` or `area:core`). When the board has a Priority field, P0, P1 and P2
  cards go first.
- To take a ticket yourself, move its card to **In progress** and assign yourself before you
  start. Seats only take Ready cards. The engine also moves its own runs' cards to In progress, so
  the assignee shows who has it.
- Work on one ticket at a time, and keep PRs small. Tickets say the outcome and when they are done.
  If one is unclear or too big, say so on the ticket rather than guessing.

## Ticket shape

A seat sees only the ticket body: it has no network and cannot open links. So a Ready ticket carries
everything needed to build it.

- **Title:** the outcome, said as what someone can see or measure afterwards, not the method.
- **One area label:** `area:server`, `area:web` or `area:core`. A card with two area labels is
  not dealt to any seat, so split work that spans areas into one ticket per area.
- **Body sections:**
  - `## Outcome`: what is true when it is done.
  - `## Why`: the reason, in a sentence or two.
  - `## What to change`: files and functions, with exact texts, names and limits wherever they matter.
  - `## Done when`: the tests or checks that show the outcome holds.
- **Self-contained:** paste the text you mean instead of linking to it. That covers spec sections,
  another ticket's decisions and earlier review findings. Keep the body under 20,000 characters,
  which is what a seat's brief carries.
- **Dependencies:** say so in the body, and leave the card in Backlog or Refinement until the
  ticket it depends on has merged.
- **Plan:** a `## Plan` section, written by the FAO planner seat or by a person, may be added below
  the body. It is the step-by-step build that a dev seat follows.

## Making the change

1. Branch from `main`: `feature/<issue>-short-name`, `fix/<issue>-short-name`, `docs/<name>` or
   `chore/<name>`.
2. Before you open the PR, run `pnpm -s lint && pnpm -s typecheck && pnpm -s test && pnpm -s build`.
   CI runs lint, typecheck and test, but not build.
3. Open a PR with `Closes #<issue>`. The description says what changed and why, and it carries a
   security note whenever the change touches auth, the seats' tool grants or anything that writes to
   GitHub.

## Merging

- `main` takes changes only through a PR, with the `check` CI job passing. There is no bypass, for
  admins either, and no force-push.
- Every PR gets a review: RETRO (the QA seat) or a fresh reviewer, agent or person. GitHub requires
  no approvals, so this is a working rule, not a setting. Critical and Important findings are fixed
  on the branch before merge. Minor ones are fixed or filed as a ticket.
- Hard-rule files, the ones that confine or drive the crew, are merged by a maintainer, never
  automatically. They are the guard, MCP, runtime and engine code (`apps/server/src/{guard,mcp,runtime,engine}/**`,
  `packages/core/src/guard.ts`, `packages/core/src/runtime.ts`), `loops/**`, `roles/**`,
  `CLAUDE.md`, `.github/**` and `config.example.yaml`. The list is `DEFAULT_HARD_RULES` in
  `packages/core/src/repo-rules.ts`, and a repo can set its own in the `## Mission Control` block of
  CLAUDE.md.

## Data

Keep personal, employer and machine-specific data out of the repo: names, emails, home paths, real
tickets from other projects, keys. Machine specifics belong in `~/.config/mission-control/config.yaml`
or the environment. Use fictional sample data in tests and docs. Commit with your GitHub noreply
address.
