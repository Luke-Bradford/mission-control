# Agents page mockup (GUIDO-1, busy)

A static proposal for the Agents page. It is not product code. Open `index.html`. The default view is GUIDO-1 parked on a refused rework push (the PR is open and review found 5 blocking findings; the rework push was refused). `?state=running` is the same seat re-running its checks on the rework before any push (no Held chip, no pending ruling); `?state=review` is the seat held on review, waiting for the findings to be sent back. Add `?flight=1` for the open FLIGHT dock, `?theme=light` for light, `?plan=empty` for a seat with no plan.

**Render list** (each at 1920x940, 2560x1145 and 2560x1250, FLIGHT folded and open):

1. `index.html` (parked, with a plan)
2. `index.html?state=review` (held on review: the rework composer, a Next move about the findings)
3. `index.html?state=running` (running its checks before the push: Interrupt, the live call bar waiting on the test lock, no Held chip, no Next move panel)
4. `index.html?plan=empty` (no plan)
5. `index.html?theme=light` (parked, light)

Render at 1920x940, 2560x1145 and 2560x1250, FLIGHT folded and open. `apps/web/test/AgentsMockup.browser.test.ts` measures the same sizes and states.

## Data: source-shaped, not a live capture

A seat's stream is not safe to commit, so none of this is copied from a live seat.

- **Real, for GUIDO-1** (from the preview's live page and the #1434 ticket): ticket mission-control#1411 and its title, "test:related can't pass in a seat's sandbox when a change selects most of the suite"; head 117f67b; the role "Backend developer"; PR 1430; the chip "Held · hub"; the next move "Waiting on FLIGHT"; account claude-max; model claude-sonnet-5-5 at medium effort; CLI 2.1.318; area apps/server/**, packages/core/**, docs/**; the branch feature/1411-test-related-can-t-pass-in-a-seat-s; prompt sections of 3,952 (standing orders), 1,398 (role prompt) and 16,299 (tool results); context 73.8k of 200k; cost about $0.71.
- **Real shapes and limits:** each Activity row follows `StreamEvent` and `toolTarget` (target cut at 80 characters, result at 100, first line only), with `ms` for the time. Repeated thinking merges to `thinking ×N` with no summary, because the hub stores no summary.
- **Illustrative (invented here):** the reason wording and the Next move text, the other four prompt sections (1,206 / 642 / 517 / 388), the plan, the changed files, the saved links, the done-when evidence lines, the Left items, all times and counts (events, failed tools, 28 saved links), the Activity rows' content, the previous runs (named by their real branches), the FLIGHT dock text and the seat list in the picker.

## The question

What is this seat doing, is it OK, and what can I do? One screen, no page scroll. Activity is the largest panel and takes the spare height.

## Shell, as measured on the live app

49 px top bar, 30 px footer, 12 px gutters, FLIGHT's rail 48 px folded and 380 px open, nav in the live order (Overview, Board, Agents, Map, Comms, QA, Telemetry, Audit). Stand-ins: the top bar's right-hand controls and the footer keys are shortened.

Vertical budget at 1920x940: 940 − 49 − 30 − 24 = 837 px of main. Identity 68 px, gap 12, columns 757 px. The right column: Next move 60, figures 84, loop 48, prompt sections 118, four 12 px gaps, leaving about 400 px for the tabs. The composer is two lines (input, then the hint), about 68 px, and comes out of Activity, which has the spare height. At 2560 the Plan panel and the tabs share the remainder 3 to 2, so the current plan step stays in view.

## Layout

- **Identity strip.** Seat, role, the state (the only place "Parked" or "Running" appears: the picker lists names only, the age reads "state changed 3m ago", the composer placeholder names no state), review chip, the reason with a details control, seat picker and actions. Second row: ticket, title (first claim on the width, never under 320 px), branch (shrinks), PR, head and age. The role, account, model, effort, CLI and area line moved to the Context tab.
- **Actions.** A running crew seat gets Interrupt, Stop and More; a parked one gets Stop and More; Pause only appears for an observed loop. The composer under Activity keeps today's actions. A seat held on review (`?state=review`) gets "Send rework message" and the hint "This sends RETRO's findings … It does not waive them." Every other state, including a refused push, gets Send and "Interrupt and send". The hint is the mid-turn note while running; for an idle seat it reads "Your message starts GUIDO-1's next turn." (today's hint names the state, "GUIDO-1 is parked; …", which would show the state twice, so the build drops the state word).
- **Activity (left, primary).** Time, kind, tool, target, result, duration. Filters All, Messages, Thinking, Tools, Guard with counts; Follow; link to the full trace. The live call bar shows while a tool runs, or the wait for the test lock with the seat holding it (`?state=running`). It takes all spare height; the rows scroll inside it.
- **Right column (440 to 560 px).** Next move (only when there is one; the running view has none and the tabs take its height), Cost / Context / Tools, one loop row, Prompt sections (all seven), then the detail tabs.
- **Plan at 2560 (changed after the first render).** The current step opens in view, centred in the list. From 2200 px wide, Plan and Queue stand in their own panel above the tabs, and the tabs lose Plan. At 1920, and below 2200, Plan and its queue stay one tab. The reason: at 2560 a single tab left about 390 px empty.
- **A seat with no plan** (`?plan=empty`): no Plan tab or panel. At 2560 the panel shows the queue alone, content-sized, and the tabs take the rest. At 1920 the queue sits at the top of the Runs tab.

## Dropped or moved

| Item today | Where it goes |
| --- | --- |
| "What is happening now?" panel | Dropped. State is in the identity strip. Its extra lines (checking a PR, a queued review, a source error) show as the chip beside the state, as a banner, or in Next move, only when they apply. |
| Run health stat ("Held", "5 blocking review findings", "Current PR head") | A chip beside the state: "5 blocking findings · current head", with the live count; its full wording shows on hover or focus. The state word is the pill. When the review verdict is not recorded the chip is left out. |
| Header badge, seat chip, "Running" in four places | One state pill in the identity strip. |
| Reason text and its details route | Kept in the identity strip, with a details control that shows the whole text. |
| Review check chip beside the state | Kept, beside the state. |
| Interrupt, Stop, More (Pop out, switch account, seat settings) | Interrupt (when running), Stop and More stay in the identity strip. Pause stays for observed loops. |
| Effort and CLI version, account, model, area, role | Context tab, "Seat". |
| Seat chips row | Dropped. Crew shows it. A seat picker sits in the identity strip. |
| Build loop panel and Steps list | One loop row: a "done" chip, the current step, and "later". Each chip's tries, limit, durations and reason show in full on hover or focus. |
| "Not recorded" for steps that have not happened | Dropped. |
| "Tokens this run" and "tokens so far" | Dropped: they leave out cached reads. Context now and Cost stay. |
| Tools this run, with the per-tool breakdown | Tools count and failures stay in the figure row. Per-tool counts are in the Context tab, "Tools this run". |
| Ask → result → next | The ask is the ticket title in the identity strip. The result is in the Report tab. Next move stays in the right column. |
| "Left: …" (what remains) | Report tab, "Left". |
| Evidence text under each acceptance check | Report tab, a second line under each "Done when" row. |
| "Waiting for the test lock" line | The live call bar under Activity, with the seat that holds the lock. |
| PR and FILE labels on deliverables | Report tab, "Saved links": each link carries its kind (PR, FILE, SHOT), and the PR link is first. |
| "State changed … ago" | Identity strip, second row, without the state word. |
| Reported result, acceptance checks | Report tab, labelled "Previous run" while a rework runs. The checks are listed under "Done when". |
| FLIGHT recommends | Next move's full text (the "Read full" control). |
| Deliverables | Report tab, "Saved links", with a "Show all" link past the first screen of them. |
| Related work (reviews, subagents, set-aside runs) | Runs tab, "Related work". |
| Attempts and previous runs | Runs tab, "Attempts and previous runs". Opens lazily, as today. |
| Subagents tab | Runs tab, "Related work"; the tab returns in the build when a seat has more subagents than fit. |
| Plan 0/0, Queue tabs | Plan (with Focus and the Next rows) is a tab below 2200 px and a panel above. A seat with no plan shows no Plan tab. |
| Files tab, file diff and the commit column | Files tab. Each row is a button (path with the folder cut and the file name kept, +added −removed, commit or "uncommitted"); the pressed row opens its diff under the list, as today, with a Close control. |
| Prompt tab | Context tab, "Prompt", with an "Open prompt" link; "Open prompt" also stays in the Prompt sections panel. |
| Tool row detail (full input, full result, duration) | Each tool row is one disclosure (one keyboard stop). Opening it shows the input, the whole result and the duration; the failed test:related row is drawn open. |
| The held chip's own Reason control | Merged into the identity strip's reason and its "details" control. |
| Cost per reported turn | Context tab, "Cost" ("$0.71 est. · $0.04 per reported turn"). |
| The loop's profile | The loop row's caption: "Loop · feature". |
| Queue: Focus with Change | Top of the Plan panel (and the Plan tab, or the Runs tab for a seat with no plan below 2200 px): "Focus", its text and a Change control. |
| Queue: "Now" | The identity strip (the ticket, title, branch and PR) and the loop row; no separate list. |
| Queue: "Next · from Ready, by priority" and the ↑ move-up | Under the plan: each queued ticket with its priority, and ↑ ("Ask FLIGHT to move this up") on a row that sits below a higher priority. |
| Queue: "Done" | Runs tab, "Attempts and previous runs" (finished tickets are the ✓ rows). |
| The note that each ticket starts a fresh run | Dropped. Say if you want it back. |
| Prompt sections bar | Kept with all seven sections; standing orders stand out against the role prompt. |
| Instructions disclosure | Context tab, "Standing orders", with "Open instructions". |
| Handoff panel | Shown in Next move when a handoff is open. |
| Repeated "thinking" rows | One row with a count. |
| Working directory in tool rows | Stripped; the full text shows on hover or focus. |

## Limits of this proposal

- Result strings are the first line the hub records, cut at 100 characters. The mockup invents no counts, such as "+9 −1" or "80 lines".
- Stopped, error and observed-loop states keep this grid; the panels with nothing to say (Next move, the loop row) drop out.
- Not rendered by its author, who cannot start Chrome. FLIGHT renders it. The browser test is written but has not run here.
- Ticket titles in the queue and runs are the real ones where this fixture knows them (1411, 1434) or shortened from the real branch name (1409) or taken from FLIGHT's description of the ticket (1433); the rest is illustrative.
- Every link, button, select and input is at least 24 px each way; a link in a list row fills the 32 px row.
