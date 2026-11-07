# Dependencies mockup

Approval: waiting for the operator.

Open `index.html` directly in a desktop browser. No install or server is needed. It is a static proposal: links go nowhere, and every name, age and chain is a labelled replay of 30 October (PR 1033, PR 1189) plus two fictional `demo` chains. The banner on every view says so.

Query string: `view` is `board`, `flight` or `qa`. `state` is `normal`, `many`, `long`, `loading`, `empty`, `error`, `stale` or `disconnected`. `theme` is `light` or `dark`. Two extras: `rail=open` shows the FLIGHT rail (360 px), and on `qa`, `pr` is `1033`, `1034` or `demo-21`.

This is checkpoint 3 of "Dependencies are visible at a glance". The operator approved the research and plan on 4 November 2026. No build ticket is filed until the operator approves this mockup.

## Answer

Show a dependency as a chip on Board cards, an indented list grouped by the stuck work on FLIGHT's Crew & board tab, and a "Merging this frees" line on QA. There is no graph. The chains need one new read-only server route, because today's chain field cannot draw them.

## Research

The planner had no network and neither did the author of this mockup, so the table comes from memory. No page was opened. Every URL is unconfirmed until someone opens it; an asterisk means the exact page is still to find.

| Tool and source | How it shows dependencies | At 100 items | Take | Checked |
|---|---|---|---|---|
| Linear, https://linear.app/docs/issue-relations | Blocked and blocking relations, a flag on the row on both sides | Readable; no chain view | The row mark, both sides | Unconfirmed: not opened |
| GitHub, https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies | Blocked-by links, a blocked icon on lists and boards; sub-issues show progress | Readable; one hop only | The hub already reads these | Unconfirmed: not opened |
| Jira, https://support.atlassian.com/jira-software-cloud/* | Issue links; plan timelines draw lines | Links fine; lines tangle | No lines in the first view | Unconfirmed: not opened |
| Shortcut, https://help.shortcut.com/* | Story links: blocks, relates, duplicates | Readable as a badge | Same as Linear | Unconfirmed: not opened |
| Gantt critical path, https://support.microsoft.com/* | Longest path through dated tasks | Needs a large 2D chart | Reject: the hub has no dates | Unconfirmed: not opened |

Finding: views readable at 100 items put one mark on each row and leave structure to a detail view.

## Where each view lives

| Where | What it shows | Why there |
|---|---|---|
| Board card, replacing the `Blocked:` line in `apps/web/src/board/Card.tsx` | `Waits on` chip; `Unblocks` chip on the root's card | One mark per row, both sides |
| FLIGHT, Crew & board tab, under Seats | `Blocked chains` panel, longest wait first | Seats say who is held; chains say by what |
| QA detail, `apps/web/src/pages/QaReadiness.tsx` | `Merging this frees` line; `unblocks {n}` on queue rows | The accept decision is made here |

A chain is an indented list. Real chains are wide and shallow: PR 1033 has 3 dependents, PR 1189 has 2. A list sorts by wait, keeps keyboard order and holds stable positions as data changes.

"Frees" counts only dependents whose last wait this merge ends. The Board's `Unblocks {n}`, FLIGHT's Merge frees column and QA's `unblocks {n}` all use that same number. A dependent with another open wait is counted separately, as `{m} more also wait on other work`.

Drill-throughs: a ticket ref goes to `ticketPath`, a PR to the QA page's repo and PR query, a seat to `agentPath`, and a chip's `+{n}` to a new `chainsP` panel on the FLIGHT page.

### What the views keep, and what gives way

- **Board:** the eight real columns in their real order (Backlog, Refinement, Blocked, Ready, In progress, In review, Ready for QA, Done), 257 px wide, with the Board's sideways scroll. Cards keep their 210 px minimum.
- **FLIGHT, Crew & board:** the FLIGHT status strip, the tabs, and the live Seats columns (Seat, Workstream, Stage, Stuck / waiting on, FLIGHT's next action, Last instruction) with 48 px panel heads. There is no footer line. Seats takes the height of its 11 rows (428 px at 32 px rows, 516 px at 40 px rows) when the window allows, and Blocked chains keeps at least 360 px and takes the rest: about 443 px at 1920×1080, 360 px at 1920×940 (about 7 rows, not the 9 first estimated), about 420 px at 2560×1145 and about 790 px at 2560×1440. When the window is too short Seats gives way first and scrolls inside itself, as the live panel does (361 px at 1920×940). Below 734 px of page height the page scrolls. FLIGHT's queue and Revisit triggers are not redrawn; they stay below.
- **QA:** the queue and the decision controls as they are, with one new line in the decision panel.

## Panel stats

All four are now, not over a window. Hover a stat in the mockup for its definition.

| Stat | Definition | Unit |
|---|---|---|
| Chains | Distinct roots | count |
| Stuck | Chains in that state | count |
| Waiting | Distinct tickets and PRs under a root | count |
| Longest wait | Largest time since a wait was first seen | duration |

## Rules the mockup shows

1. A chain's root is work that waits on nothing else. Dependents nest under it. One with two roots appears under each (demo#31).
2. Chains sort by longest wait, unknown last. Ties go `Stuck` first, then by ref.
3. `Stuck` (a proposal the operator can change): the root has no owner, is past its stage's 7-day p90, is a ticket with no open PR and no running seat, closed without merging, or is in a cycle.
4. `With you`: the next owner is the operator. `Moving`: any other owner. `—`: the root is unread or in an untracked repo.
5. A chain with more than 5 dependents shows 4 and `{n} more` (see `state=many`). The list scrolls inside its panel and follows the session's repo scope.
6. Edge cases: an unread PR says `PR {n} not read yet`. An untracked repo's ref is text with no link. A Done card has no chip. An unowned PR nothing waits on stays on PR flow only (PR 1034 on 30 October).

## Board build outline

A Ready ticket with `Depends on` moves to the Blocked column, as a GitHub blocked-by link already does, because the engine will not deal it. Only `Depends on` moves: a stacked or held ticket stays in Ready, with its `Waits on` chip, until the operator approves widening the rule. The operator approved this on 4 November 2026. The Ready count then falls: in the mockup it drops from 11 to 6, and the note above the Board says so. A card in Blocked shows its reason as a link to the ticket it depends on ("Blocked: depends on #1015"), the operator's request of 4 November 2026: quick and clear, one click to the blocker. The `Waits on` chip beside it names the PR and the wait. While chains have not loaded, every ticket stays where its Status puts it and the note says that too.

## Build tickets

FLIGHT files these after the operator approves the mockup. Web tickets depend on the server read. None touches a hard-rule file.

### Server read

Area: `area:server`, `area:core`.

A graph builder in `packages/core/src/dependencies.ts` and `GET /api/dependencies` in `apps/server/src/api.ts`, with the same token check as `/prs/flow`. It joins PR flow, holds, seat queues and `readWaitRecord`, so a page read writes nothing. Security: read-only, no GitHub writes. The response is the `DependencyChain` shape below.

Done when:
- A chain per root, each dependent under its root, a ticket with two roots under both.
- `longestWaitMs` is null when no wait has a start time; `frees` and `stillWaiting` split a root's dependents by whether another wait remains.
- A request without the token is refused, and a read writes nothing.
- Core tests cover a cycle, an unread PR, an untracked repo and the 5-dependent cap's inputs.

Size: M.

### Board

Area: `area:web`.

Change `apps/web/src/board/Card.tsx`, `apps/web/src/board/cards.ts` and `apps/web/src/board/brief.ts`: the `Waits on` and `Unblocks` chips replace the `Blocked:` line, and a Ready ticket with `Depends on` moves to Blocked, so the Ready count falls.

Done when:
- A card shows `Waits on {ref} · {stage} · {wait}` with ` +{n}` for more, and the root's card shows `Unblocks {n}`.
- A card in Blocked shows `Blocked: depends on {ticket}` with the ticket linked (text if its repo is untracked).
- A Ready ticket with `Depends on` is in Blocked and not counted in Ready; the Board note says how many moved.
- A Done card has no chip; an untracked ref is text; the loading, error, stale and disconnected states are worded.
- Component tests cover each state; a browser test covers 210 px cards without clipping.

Size: S.

### FLIGHT panel

Area: `area:web`.

Create `apps/web/src/flight/BlockedChains.tsx`; change `apps/web/src/flight/CrewBoardTab.tsx` and `apps/web/src/flight/tabs.ts` (the `chainsP` panel).

Done when:
- The panel sits under Seats with the six columns, four stats, and the sort and cap rules above.
- It scrolls inside itself, follows the repo scope, and `+{n}` links land on `chainsP`.
- Every state is worded, including `Try again`.
- Browser tests render it at 1920×940 and 2560×1145 with Seats unchanged and PR 1033's root row visible without page scrolling.

Size: M.

### QA

Area: `area:web`.

Change `apps/web/src/pages/QaReadiness.tsx`: the `Merging this frees {n}` line in the decision panel and `unblocks {n}` on queue rows.

Done when:
- The decision panel lists up to 5 frees with `+{n}`, and `{m} more also wait on other work` when some remain.
- A PR nothing waits on says `No recorded work waits on this PR.`
- The decision controls are unchanged.

Size: S.

## Interfaces

The fixture shape is the server build's starting point. `edge` is null on the root.

```ts
export interface ChainNode {
  ref: string;
  title: string | null;
  edge: "depends" | "stacked" | "held" | "queue" | null;
  waitedMs: number | null;
  alsoWaitsOn: string[];
  children: ChainNode[];
}
export interface DependencyChain {
  repoId: string;
  root: ChainNode;
  state: "stuck" | "with-you" | "moving" | "unknown";
  reason: string;
  owner: string;
  seatId: string | null;
  longestWaitMs: number | null;
  frees: string[];
  stillWaiting: string[];
}
```

Column headers: `Work`, `State`, `What holds it`, `Next owner`, `Waited`, `Merge frees`.

## Evidence and limits

- `test/DependenciesMockup.test.ts` runs the page's script in jsdom for every view and state and checks the wording, order, counts and the Ready fall.
- `test/DependenciesMockup.browser.test.ts` renders each view and theme at the Design viewports, and each state at 1920×940 dark. The author's sandbox cannot start a browser, so those cases skipped there and ran only on CI.
- Screenshots are not committed from the author's seat for the same reason. FLIGHT renders the pushed head from its own shell; each capture should say its viewport, theme and state, and that it came from the static page with fixture data, not live data. "Today's three surfaces" captures come from main the same way.
- Nothing here is a layout judgement made from a rendered image. Review the rendered full composition first.
