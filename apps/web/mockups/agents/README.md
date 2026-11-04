# Agents page mockup (GUIDO-1, busy)

Static proposal for the Agents page. It is not product code. `index.html` uses fictional but realistic data for a seat on a rework (GUIDO-1, ticket 1403). Add `?flight=1` to open the FLIGHT rail and `?theme=light` for light.

Render at 1920x940, 2560x1145 and 2560x1250, FLIGHT folded and open.

## The question

What is this seat doing, is it OK, and what can I do? The answer sits on one screen with no page scroll. Activity is the largest panel and takes all spare height.

## Layout

- Identity strip, across the top: seat, role, state (the only place "Running" appears), how long, ticket, title, branch, PR and screenshots, seat picker and actions.
- Left, primary: Activity. Time, kind, tool, what it did, result, duration. It scrolls inside the panel and ends level with the right column.
- Right, supporting (440 to 560 px): Next move (only when there is one), Cost / Context / Tools, one loop line, Prompt sections, then a tabbed panel that takes the spare height: Plan, Queue, Files, Report, Runs, Context.

## Dropped or moved

| Item today | Where it goes |
| --- | --- |
| "What is happening now?" panel | Dropped. State is in the identity strip. Its extra lines (checking PR, queued review, source error) show in Next move or a banner only when they apply. |
| Run health stat | Dropped while it says Running. It shows as a banner when not OK. |
| Header badge, seat chip, "Running" in four places | One state pill in the identity strip. |
| Build loop panel and Steps list | One loop line (chips with tries and limits). Later steps are dim chips with no "Not recorded" text. The step reasons are on the chip's title and in the Report tab. |
| "Tokens this run" and "tokens so far" | Dropped: they leave out cached reads. Context now (of the window) and Cost stay as the honest figures. |
| Tools this run | Kept as Tools in the figure row, with failed count. The per-tool breakdown moves to the Activity filters. |
| Reported result, acceptance checks | Report tab, labelled "Previous run · round 1 · 2h ago" while a rework is running. |
| Ask → result → next | The ask is the title in the identity strip. The result is in the Report tab. Next move stays in the right column. |
| Deliverables | PR and screenshot links in the identity strip; the full list is in the Report tab. |
| Related work (reviews, subagents, set-aside runs) | Runs tab. |
| Attempts and previous runs (collapsed bar at the bottom) | Runs tab. Opens lazily, as today. |
| Seat chips row | Dropped. Crew shows it. A seat picker sits in the identity strip. |
| Plan 0/0, Queue, Files, Context tabs | Tabs beside Activity, on the first screen. An empty Plan says what it is waiting for. |
| Prompt sections bar | Kept, with the largest section called out (standing orders 3,952 against role prompt 1,398). |
| Instructions disclosure | Context tab. |
| Handoff panel | Shown in Next move when a handoff is open. |
| Repeated "thinking" rows | Merged into one row with a count. |
| Working directory in tool rows | Stripped. The row reads the command. The full text is in the row's title. |

## Limits of this proposal

States not drawn here: quiet seat with no run, stopped, error, observed loop, empty Activity. They keep the same grid; the panels that have nothing to say (Next move, loop line) drop out and Activity or the tabs take the room.
