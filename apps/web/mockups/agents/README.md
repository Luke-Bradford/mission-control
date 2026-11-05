# Agents page mockup (GUIDO-1, parked, busy)

A static proposal for the Agents page. It is not product code. Open `index.html`; add `?flight=1` for the open FLIGHT dock, `?theme=light` for light, `?plan=empty` for a seat with no plan.

Render at 1920x940, 2560x1145 and 2560x1250, FLIGHT folded and open. `apps/web/test/AgentsMockup.browser.test.ts` measures the same sizes and states.

## Data: source-shaped, not a live capture

A seat's stream is not safe to commit, so none of this is copied from a live seat.

- **Kept real, for GUIDO-1:** ticket mission-control#1411, "test:related can't pass in a seat's sandbox when a change selects most of the suite"; head 117f67b; parked on a refused push; prompt sections of 3,952 (standing orders), 1,398 (role prompt) and 16,299 (tool results); context 73.8k of 200k; cost about $0.71. These come from the #1434 ticket's Why section.
- **Real shapes and limits:** each Activity row follows `StreamEvent` and `toolTarget` (target cut at 80 characters, result at 100, first line only), with `ms` for the time. Repeated thinking merges to `thinking ×N` with no summary, because the hub stores no summary. Guard and agents rows follow the live filters.
- **Illustrative:** the branch name, the other four prompt sections (1,206 / 642 / 517 / 388), the plan, files, saved links, times, the counts of failed tools, and the previous runs (named by their real branches).

## The question

What is this seat doing, is it OK, and what can I do? One screen, no page scroll. Activity is the largest panel and takes the spare height.

## Shell, as measured on the live app

49 px top bar, 30 px footer, 12 px gutters, FLIGHT's rail 48 px folded and 380 px open, nav in the live order (Overview, Board, Agents, Map, Comms, QA, Telemetry, Audit). Stand-ins: the top bar's right-hand controls and the footer keys are shortened.

Vertical budget at 1920x940: 940 − 49 − 30 − 24 = 837 px of main. Identity 68 px, gap 12, columns 757 px. The right column: Next move 60, figures 84, loop 48, prompt sections 118, four 12 px gaps, leaving about 400 px for the tabs.

## Layout

- **Identity strip.** Seat, role, the state (the only place "Parked" or "Running" appears), review chip, the reason with a details control, seat picker, Stop and More. Second row: ticket, title (first claim on the width, never under 320 px), branch (shrinks), head and age. The role, account, model, effort, CLI and area line moved to the Context tab.
- **Actions.** A crew seat gets Interrupt (while running), Stop and More; Pause only appears for an observed loop. Messaging the seat is the composer under Activity, as today.
- **Activity (left, primary).** Time, kind, tool, target, result, duration. Filters All, Messages, Thinking, Tools, Guard with counts; Follow; link to the full trace. The live call bar shows while a tool runs. It takes all spare height; the rows scroll inside it.
- **Right column (440 to 560 px).** Next move (only when there is one), Cost / Context / Tools, one loop row, Prompt sections (all seven), then the detail tabs.
- **Plan at 2560 (changed after the first render).** From 2200 px wide, Plan and Queue stand in their own panel above the tabs, and the tabs lose Plan. At 1920, and below 2200, Plan and its queue stay one tab. The reason: at 2560 a single tab left about 390 px empty.
- **A seat with no plan** (`?plan=empty`): no Plan tab or panel. At 2560 the panel shows the queue alone, content-sized, and the tabs take the rest. At 1920 the queue sits at the top of the Runs tab.

## Dropped or moved

| Item today | Where it goes |
| --- | --- |
| "What is happening now?" panel | Dropped. State is in the identity strip. Its extra lines (checking a PR, a queued review, a source error) show as the chip beside the state, as a banner, or in Next move, only when they apply. |
| Run health stat | Dropped while it is fine. A failing run shows as a chip beside the state. |
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
| Reported result, acceptance checks | Report tab, labelled "Previous run" while a rework runs. The checks are listed under "Done when". |
| FLIGHT recommends | Next move's full text (the "Read full" control). |
| Deliverables | Report tab, "Saved links", with a "Show all" link past the first screen of them. |
| Related work (reviews, subagents, set-aside runs) | Runs tab, "Related work". |
| Attempts and previous runs | Runs tab, "Attempts and previous runs". Opens lazily, as today. |
| Subagents tab | Runs tab, "Related work"; the tab returns in the build when a seat has more subagents than fit. |
| Plan 0/0, Queue tabs | Plan (with its queue) is a tab below 2200 px and a panel above. Queue is part of it. A seat with no plan shows no Plan tab. |
| Files tab and file diff | Files tab. The folder part of a path is cut and the file name stays. |
| Prompt tab | Context tab links to it; "Open prompt" stays in the Prompt sections panel. |
| Prompt sections bar | Kept with all seven sections; standing orders stand out against the role prompt. |
| Instructions disclosure | Context tab, "Standing orders", with "Open instructions". |
| Handoff panel | Shown in Next move when a handoff is open. |
| Repeated "thinking" rows | One row with a count. |
| Working directory in tool rows | Stripped; the full text shows on hover or focus. |

## Limits of this proposal

- Result strings are the first line the hub records, cut at 100 characters. The mockup invents no counts, such as "+9 −1" or "80 lines".
- Stopped, error and observed-loop states keep this grid; the panels with nothing to say (Next move, the loop row) drop out.
- Not rendered by its author, who cannot start Chrome. FLIGHT renders it. The browser test is written but has not run here.
