# Setup › Roles & guards proposal mockup

Open `index.html` directly in a desktop browser. No install or server is needed. Repos, rules and counts are fictional (`demo-app`, `demo-site`). Nothing here changes a live page. Fonts are embedded as in `docs/mockups/2026-10/setup-sessions-density.html` (licences in `docs/mockups/2026-10/density-font-licenses.txt`).

Query: `?repo=demo-app|demo-site` (`demo-app` has a repo-file rules block, `demo-site` has none), `&state=normal|loading|empty|long|error|stale|disconnected|conflict`, `&theme=dark|light`. Every Save button carries `data-write="needs-build"`: no route writes these keys yet, so Save shows the saved text and writes nothing.

Approval: waiting for the operator.

## The question

What may the crew do in each repo, and which of those rules can I change here? The reader is the operator, setting up a repo or after a guard refusal. The review of 25 October called this page "a page of text, not configurable". Editable rules take the first screen and the widest column; fixed stops sit beside them; prompts change least, so they come last.

Reference: today's `apps/web/src/setup/Roles.tsx` (guard texts, note, lock lines and role table are kept word for word) and `docs/mockups/2026-10/setup-sessions-density.html` (labels above fields, 16 and 24 px groups, 640 px editors, 32 px rows). The nav label `Roles & guards` replaces `Roles`; the tab id `roles` stays.

## Sources

Settings come from `apps/server/src/config.ts` and `apps/server/src/engine/rule-config.ts`; sources follow `apps/server/src/engine/rules.ts` (the repo file's block tightens the rules and fills keys left out). Each rule row carries one badge:

| Badge | Meaning | Edit here |
| --- | --- | --- |
| `Set here` | Saved in config.yaml | Yes |
| `Repo file` | Set in the repo's CLAUDE.md; `Repo file wins` where it overrides a user value | No: change it with a reviewed PR |
| `Default` | Mission Control's default | Yes: edit it to set your own |
| `Built in` | Part of Mission Control's code | No |

## Stats

| Stat | Definition | Window | Unit |
| --- | --- | --- | --- |
| Refusals | Guard refusals recorded for that rule | Last 7 days | Count; `—` when the hub is not reachable |
| Seats | Configured seats with that role | Now | Count |

## Setting inventory

| Group | Key | Plain label | Kind |
| --- | --- | --- | --- |
| Work the crew picks | `pick_from` | Statuses the crew picks from | List, at least one |
| Work the crew picks | `needs` | A ticket must have | List: `done_when`, `size` |
| Work the crew picks | `areas` | Labels that name an area | Label to globs |
| Work the crew picks | `promote_backlog` | FLIGHT may promote Backlog tickets | On or off |
| Protected files | `protected` | Files a seat may not change | Globs |
| Protected files | `hard_rules` | Files that never auto-merge | Globs; the repo file may set it |
| Protected files | `hard_rules_by` | Who may override them | `operator` or `controller` |
| Checks | `commands.writer` | Commands a writer runs | Plain commands |
| Checks | `commands.review` | Commands a reviewer runs | Plain commands |
| Checks | `full_suite` | Commands that take the test lock | Must be writer commands |
| Checks | `required_checks` | CI checks a PR must pass | Names, not `mc/review` |
| Checks | `checks` | Exact commands a PR must show run | One plain command each: no `&&`, `\|` or `;` |
| Your approval | `uat.labels` | Labels that wait for you | Names |
| Your approval | `uat.paths` | Paths that wait for you | Globs, `**` only as a trailing `/**` |
| Your approval | `always_ask` | Decisions always brought to you | Names |
| Authority | `autonomy` | What the hub may do alone | Read-only here |
| Authority | `flight_powers` | What FLIGHT may do | Read-only here |

That is 17 keys in 5 groups. The test-lock lines stay read-only under Checks, as `LockLines` shows them today. The Built-in guard panel shows the 13 `GUARD_RULES` and `GUARD_NOTE` from `packages/core`. The Roles panel shows the five roles with prompt files (FLIGHT, FAO, GUIDO, INCO, RETRO); planned roles sit behind a `Planned roles` disclosure. `Read prompt` opens a read-only drawer of the role file's headings.

## The operator's one choice

Should Authority stay read-only on this page?

1. Read-only (recommended). `autonomy` and `flight_powers` show the reason: `Only config.yaml sets this. A change restarts FLIGHT.` Both widen what the crew may do, so they stay a deliberate edit of the file.
2. Editable here. The same save path as the other keys, with a confirm step. Faster, but one misclick can widen the crew's authority.

## Build tickets

FLIGHT files these after the operator approves the mockup.

### Server: write repo rules

A protected route that writes these keys through `apps/server/src/config-write.ts`. It keeps a backup of config.yaml, checks the base for conflicts and makes no GitHub writes. It cannot set `autonomy` or `flight_powers`.

- Done when: each key above except Authority saves through the route with the schema's messages; a changed config.yaml answers with the conflict text; a backup is kept; a test shows no GitHub call.
- Size: M

### Web: Roles & guards page

`apps/web/src/setup/Roles.tsx` rebuilt to this design. It depends on the server ticket.

- Done when: Repo rules, Built-in guard and Roles render as the mockup does at 1280, 1600, 1920 and 2560 px in both themes; Edit, Save and the conflict text work; the prompt drawer traps focus.
- Size: M
