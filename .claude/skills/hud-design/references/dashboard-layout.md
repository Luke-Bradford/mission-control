# Dashboard composition and responsive fit

Read this for an Overview, operational dashboard, or a substantial panel-layout change. Use the existing HUD tokens and accessibility rules.

Your job is to arrive with one reasoned design, so the operator doesn't have to direct the layout. Published guidance gives principles but no widths, so the defaults below come from this operator's requests and from renders of this app. Depart from a default when you can say why. Counting tests is not a design verdict.

## What this operator asked for

Treat these as the brief. Later operator steering overrides them.

- "I want to get to a point where you or claude is telling me how it should look and its better than I imagined."
- "The page needs to be scrolled to see everything, so not really an overview."
- "does the size of a form allow us to determine how they should fit on the overall dashboard."
- "why is everything the same width for visuals that don't need to be that wide?" and "Forms should be the right size, adequate."
- "Avoiding clutter and truncation of course. But ensuring the important information we should expect to see at a glance is there and we can make decisions from what is visible."
- "surely these are individual columns just showing the numbers as a metric, kpi."
- "I still don't think some of the graphs are detailed enough." Earlier work was also corrected for removing time axes and peak values, and for dropping token capacity and the activity log.
- "looks nice, well formed, good use of space. Interesting to demo."
- "This page should support click throughs to the relevant areas where supported."
- 4K and 1080p must both work in the same view: "needs to ideally accomodate both renders."

**The approved Overview (4 November 2026).** Left: Crew, with a one-hour lane per seat on one clock, over a full Board that flexes. Right, in the operator's order: Needs you, Mac, Tokens, Activity, which flexes. No KPI strip and no Timeline. The operator agreed those drops. Use it as a worked example, not a template.

## Compose in this order

1. **Name the question and the reader.** Overview: what is running, what is stuck, what is limiting us and what should happen next. If the current page is the problem, design from these questions, not from its panels. A fresh agent given only the operator's brief and this skill produced the approved Overview.
2. **Inventory each visual.** List its fields, source, unit, freshness, normal row count, actions and full-detail route. A field existing does not earn it a card, and two cards should not repeat one summary.
3. **Rank every visual: primary, supporting or drill-down.** One primary. Carbon's rule applies: the most important data should "occupy the largest area". Drill-down stays one click away.
4. **Size each panel from its content**, as described below, before styling anything.
5. **Sketch it at the real viewports** with rough real text, not boxes. Reject any shape where a supporting panel outranks the primary.
6. **Render it busy.** Use a normal working crew, real ticket counts, long titles and active charts. An idle render hides crowded columns, and a flexing Board with few cards looks empty.
7. **Look at the whole page first and ask what the operator would still have to explain.** Fix that, then measure.

## Size each panel from its content

Panel size decides the layout, so work out sizes first. For each panel, write down:

1. **Width:** its longest realistic row at real text size, including names, figures and units, plus padding. That is its width. It gets no more unless extra width shows something new.
2. **Height:** its normal row count times its row height, plus its head.
3. **What extra space buys:** if another row or column adds nothing, cap the panel. If it adds something, the panel may flex.

Then build the page from those numbers:

- The supporting column is as wide as its widest panel. The primary takes what remains, usually 60–70% of the canvas.
- Exactly one region per column flexes: the one that gains most from another row. Bottom edges line up.
- Add up each column's heights against the viewport. If a column doesn't fit, condense it or propose moving something. Don't shrink text.

On the approved Overview, one-line rows and 3:1 plots set the right column at 560 px at 1920 wide and 640 px at 2560. Crew's rows have a fixed height, so it doesn't flex. The Board and Activity do.

## Defaults by form

| Form | Default | Why |
| --- | --- | --- |
| Table | Identity, state and number columns get their longest realistic value and no more. One text column takes the rest, up to a readable limit. Past that limit, add the next most useful column | Keeps related values together; a status at the far side of a wide cell reads as a separate column |
| Numbers in a table | Each measure gets its own column with a bare number. A shared label goes in the header | "Used 12k of 200k" in a cell is slow to scan and can't line up |
| Board | One column per stage in workflow order; the head shows the count; each stage scrolls its own cards. Cards show id, title, size, priority and CI. Use the wide column. Flexes | More height shows more cards. A squeezed stage was a review finding, so check the smallest width |
| Log or long list | One-line rows, in whichever column has room. Flexes | It gains from every extra row and fills holes |
| Needs-attention list | One row per item, content height, cap the rows and link to the rest | It must stay above the fold |
| Sparkline | 16–32 px tall inside a row | A trend cue only |
| Labelled plot | 320–720 px wide, roughly 3:1 to 5:1. Labels don't touch the next plot. Past 720 px, add series, not length | Comparison needs readable axes |
| Vendor allowance | One plot per vendor, each on its own scale: burn-up to the reset, then tokens per minute | A shared axis flattens the smaller vendor |
| Stat tiles | Avoid. Put a figure in the head of the panel it explains. Use a strip only if no panel can carry the figure: one row, at most 96 px | Lone numbers lack context |

Don't confuse context capacity, provider allowance and token throughput, and don't repeat them to fill space. Keep real units, denominators, and stale and unknown states.

**Truncation.** Numbers, units, states, identifiers and actions never truncate. Free text such as a ticket title or log line may end in an ellipsis if its full text is reachable by keyboard. Nothing clips without an ellipsis.

**Removing things.** A redesign may move or remove figures, axes and panels, but the operator agrees first. Put a "dropped or moved" list in the proposal, saying where each item goes. A build never drops one quietly. Condense first: merge duplicates, shorten labels and tighten panels.

**Accepted parts.** Keep what the operator has accepted until they replace it. Don't trade it for a layout template.

**Repeated controls.** If six tiles each say "History →", make each tile the link. Repeated words are the first thing to remove when a page feels crowded.

## What looks good here

- **One clock, one grid.** Rows in a table share columns. Time-based marks share one axis, so the eye can compare seats without reading labels.
- **Quiet surfaces.** Flat panels, hairline rules and tight padding. No glows, shadows or panel-sized colour fills.
- **Colour carries meaning.** Use it for state and seat identity. Everything else stays neutral, so a warning stands out.
- **Figures sit where they explain something.** A count in a panel head beats a tile across the page.
- **The page visibly lives.** Ages and lanes keep moving when the crew is quiet. Clock ticks must not rebuild the page.
- **Names lead somewhere.** A seat opens its agent, a ticket opens its form, a log line opens what it refers to. Where no route exists, use plain text.
- **It holds attention.** Show it busy. If nothing on the page rewards a second look, say so.

Whitespace groups information. Check for wasted interior space and for crowding. Prefer fewer containers and captions over reducing every gap.

## Viewports: use the real ones

A viewport is what the page actually gets, after browser toolbars, tabs and the taskbar. A 1080p monitor gives roughly 1920×940, less with a bookmarks bar, so rendering "1920×1080" tests a window nobody has. On 4 November 2026 a build that fitted 1920×1080 scrolled by 137 px at 1920×940.

For a dashboard, this table replaces the general widths in the [checklist](../SKILL.md).

| Case | CSS viewport | Must hold |
| --- | --- | --- |
| Operator's usual desktop (4K at 150%, measured from their screenshots) | 2560×1145 to 2560×1250 | All primary and supporting panels without page scrolling |
| 1080p monitor | 1920×940 | Primary, next action and capacity without page scrolling |
| True 4K at 100% | 3840×2160 | Scale up first, see below |
| FLIGHT open | Each of the above less the rail | Recompose; a drawer is acceptable if panels would be crushed |

"Without page scrolling" is about the page: a named list may still scroll inside its panel. Test both ends of a range, with FLIGHT folded and open. Also check 1920×1080, 2560×1440, a 1920×1080 viewport at device scale 2, light and dark, and the ticket's smaller and short views. These extras don't replace a row. Device scale changes raster density, not layout width. Ask the operator for `innerWidth` and `innerHeight` if these look out of date.

**Show scrollbars in renders.** Playwright's headless Chromium hides them, which hides the width they take and any overflow. Launch with `ignoreDefaultArgs: ["--hide-scrollbars"]`.

**Above about 3200 CSS px, scale before adding.** At 100% on a 4K monitor, 13 px text is very small and the panels fill only part of the page. Scale the interface so the page composes like its 2560 layout, and add panels only if they answer a further question. `zoom: 1.5` on the root works. It multiplies viewport units, so divide them by the zoom through `--vh` and `--dvh`. `getBoundingClientRect` then returns zoomed pixels, so code that measures and then writes pixels must use client sizes.

**Narrower screens.** Recompose the grid before shrinking text or moving essential status below the page. Avoid a fixed-width primary beside an unlimited `1fr` stack.

## Review the operator's task, not only geometry

Inspect settled full-page screenshots before crops. Use one source-shaped dataset for before and after, and label fictional versus copied data. Ask whether the operator can find active and held work, remaining capacity, system constraints and the next useful action without page scrolling.

Record panel bounds and the first visible content, plus a verdict on hierarchy, column allocation, chart shape, padding and useful information per region. A dashboard that loses its primary information from the first screen fails, and that is an Important finding, however far it can be scrolled. More screenshots or hashes don't repair that.

Use the [visual QA workflow](../../../../docs/runbooks/visual-qa.md) to carry this budget into the plan, rendered review and saved report.

## What has already failed here

- Primary capped at 1200 px beside an unbounded secondary column: at 4K the secondary reached 2508 px and Crew 33.8% of the canvas.
- Every panel the same width, whatever it held.
- Machine stacked about 800 px tall, pushing the Board off the screen.
- Board promoted above seats without anyone asking.
- Passing on geometry, then the operator rejecting the composition, more than once.
- Fixing the seats' share of the page first and fitting the rest around it, when the operator's complaint was forms on the right wider than their content.
- A branch with 4,147 added lines of product code and 86,450 added lines of evidence. Keep evidence small enough that someone will read it, and spend the effort on the page.

## References

Checked 4 November 2026. These inform judgment and don't replace the brief. Those we could read give no grid widths or wide-screen rules, so the defaults above are ours.

- [Carbon: Dashboards](https://www.carbondesignsystem.com/building-blocks/data-visualization/dashboards)
- [Microsoft: dashboard design](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips)
- [Grafana: dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/)
- [MDN: `zoom`](https://developer.mozilla.org/en-US/docs/Web/CSS/zoom)
