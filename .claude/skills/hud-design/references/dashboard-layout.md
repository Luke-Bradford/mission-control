# Dashboard composition and responsive fit

Read this for an Overview, operational dashboard, or a substantial panel-layout change. Use the existing HUD tokens and accessibility rules.

Your job is to arrive with one reasoned design, so the operator doesn't have to direct the layout. Published guidance gives principles but no widths. The defaults below come from this operator's requests and from renders of this app. Depart from a default when you can say why. Counting tests is not a design verdict.

## What this operator asked for

Treat these as the brief. Later operator steering overrides them.

- "I want to get to a point where you or claude is telling me how it should look and its better than I imagined."
- "The page needs to be scrolled to see everything, so not really an overview."
- "does the size of a form allow us to determine how they should fit on the overall dashboard."
- "why is everything the same width for visuals that don't need to be that wide?" and "Forms should be the right size, adequate."
- "Avoiding clutter and truncation of course. But ensuring the important information we should expect to see at a glance is there and we can make decisions from what is visible."
- "surely these are individual columns just showing the numbers as a metric, kpi."
- "we don't have to drop content, we just need to make it fit better, which needs a redesign."
- "I still don't think some of the graphs are detailed enough." Earlier work was also corrected for removing time axes and peak values, and for dropping token capacity and the activity log.
- "looks nice, well formed, good use of space. Interesting to demo."
- "This page should support click throughs to the relevant areas where supported."
- 4K and 1080p must both work in the same view: "needs to ideally accomodate both renders."

**The approved Overview (4 November 2026).** Left: Crew, with a one-hour activity lane per seat on one clock, over a full Board. Right, in the operator's order: Needs you, Mac, Tokens, Activity. The Board and Activity take the spare height. There is no KPI strip or Timeline, and the operator agreed those drops. Use it as a worked example, not a template.

## Compose in this order

1. **Name the question and the reader.** Overview: what is running, what is stuck, what is limiting us and what should happen next. If the current page is the problem, design from these questions, not from its panels.
2. **Inventory each visual.** List its fields, source, unit, freshness, normal row count, actions and full-detail route. A field existing does not earn it a card, and two cards should not repeat one summary.
3. **Rank every visual: primary, supporting or drill-down.** One primary. Carbon's rule applies: the most important data should "occupy the largest area". Drill-down stays one click away.
4. **Size each panel from its content**, as described below, before styling anything.
5. **Sketch it at the real viewports** with rough real text, not boxes. Reject any shape where a supporting panel outranks the primary.
6. **Render it busy.** Use a normal working crew, real ticket counts, long titles and active charts. An idle render hides crowded columns, and a tall Board with few cards looks empty.
7. **Look at the whole page first and ask what the operator would still have to explain.** Fix that, then measure.

## Size each panel from its content

Panel size decides the layout, so work out sizes first. Text and row sizes come from `docs/design/system.md`: 13 px body text, 40 px table rows (32 compact), 16 px panel padding. For each panel, write down:

1. **Width.** Render its longest realistic row, using the schema's limits for names, figures and units, and measure it. That row plus padding is its preferred width. Also note its minimum, where it still reads, and its maximum, where more width shows nothing new.
2. **Height.** Its normal row count times its row height, plus its title row.
3. **What extra space buys.** If another row or column adds nothing, cap the panel. If it adds something, the panel may take spare space.

Then build the page from those numbers:

- Stack each column in rank order. Use the fewest columns that keep the primary and next action on the first screen.
- The supporting column is as wide as its widest panel. The primary takes what remains, usually 60–75% of the canvas.
- If the supporting column leaves the primary below its minimum, shorten that panel's content or move the panel. Don't squeeze both.
- Exactly one region per column takes spare height, or the column leaves a hole on tall screens. Choose the one with the most rows that don't fit. Both columns end level.
- A short column shouldn't wait for the tallest panel in the other column to show its next panel.

Then write the vertical budget at each viewport: header + gutters + panels + gaps. Name the panels and normal rows that must be on the first screen. If a column doesn't fit, tighten padding, merge duplicates and shorten labels. Propose moving something only after that, and don't shrink text.

Record the reference CSS viewport, browser zoom, OS scaling, FLIGHT rail state and app chrome before building. If the operator's exact setup is unknown, state your assumption first. Don't choose a convenient reference after rendering, and don't swap in a different height for a named viewport.

**Worked example.** On the approved Overview at 1920 wide, Crew's fixed columns add up to 660 px before gaps: state 88, seat 168, step 104, lane 168, then 44, 40 and 48 for numbers. Work takes the rest. From 1440 px of Crew width, as at 2560, the lane grows to 224 and more number columns appear, so the fixed columns reach 888 px. Beside it, one-line rows and 3:1 plots set the right column at 560 px at 1920 wide and 640 px at 2560. Crew's 40 px rows don't gain from spare height, so it stays content height and its row list scrolls past 60% of the viewport height.

## Defaults by form

| Form | Default | Why |
| --- | --- | --- |
| Table | Identity, state and number columns get their longest realistic value and no more. One text column takes the rest, up to a readable limit. Past that limit, add the next most useful column | Keeps related values together; a status at the far side of a wide cell reads as a separate column |
| Numbers in a table | Each measure gets its own column with a bare number. The header carries the label, unit and window | "Used 12k of 200k" in a cell is slow to scan and can't line up |
| Board | One column per workflow stage, in order; the title row shows the count; each stage scrolls its own cards. Cards show id, title, size, priority and CI. Use the wide column and give it spare height | More height shows more cards. A squeezed stage has been a review finding here, so check the smallest width |
| Log or long list | One-line rows, in whichever column has room. Give it spare height | It gains from every extra row and fills holes |
| Needs-attention list | One row per item, content height, cap the rows and link to the rest | It must stay above the fold |
| Sparkline | 16–32 px tall inside a row | A trend cue only |
| Labelled plot | 320–720 px wide, roughly 3:1 to 5:1. Labels don't touch the next plot. Past 720 px, add series, not length | Comparison needs readable axes |
| Vendor allowance | One plot per vendor, each on its own scale: allowance used so far against the weekly reset, then tokens per minute | A shared axis flattens the smaller vendor |
| Stat tiles | Avoid. Put a figure in the head of the panel it explains. Use a strip only if no panel can carry the figure: one row, at most 96 px | Lone numbers lack context |

Three token measures differ and need their own labels: context capacity (one seat's working memory), provider allowance (the vendor's limit) and throughput (tokens per minute). Don't repeat them to fill space. Keep real units, denominators, and stale and unknown states. Don't fabricate a series or silently change a unit.

**Truncation.** Numbers, units, states, identifiers and actions never truncate. Free text such as a ticket title or log line may end in an ellipsis. Its full text must be reachable by keyboard. In a table cell, wrap to at most two lines before the ellipsis. Nothing clips without an ellipsis, and a critical warning stays visible.

**Removing things.** Condense first. A redesign may then move or remove figures, axes and panels, but the operator agrees first. Put a "dropped or moved" list in the proposal, saying where each item goes. A build never drops one quietly.

**Accepted parts.** Keep what the operator has accepted until they replace it. Don't trade it for a layout template.

**Repeated controls.** If six tiles each say "History →", make each tile the link. Repeated words are the first thing to remove when a page feels crowded.

## What looks good here

- **One clock, one grid.** Rows in a table share columns. Time-based marks share one axis, so the eye can compare seats without reading labels.
- **Quiet surfaces.** Flat panels, hairline rules and tight padding. No glows, shadows or panel-sized colour fills.
- **Colour carries meaning.** Use it for state and seat identity. Everything else stays neutral, so a warning stands out.
- **Figures sit where they explain something.** A count in a panel's title row beats a tile across the page.
- **The page visibly lives.** Ages and lanes keep moving when the crew is quiet. Clock ticks must not rebuild the page.
- **Names lead somewhere.** A seat opens its agent, a ticket opens its form, a log line opens what it refers to. Where no route exists, use plain text.
- **It holds attention.** Show it busy. If nothing on the page rewards a second look, say so.

Whitespace groups information. Check for wasted interior space and for crowding. Prefer fewer containers and captions over reducing every gap.

## Viewports: use the real ones

A viewport is what the page actually gets, after browser toolbars, tabs and the taskbar. A 1080p monitor gives roughly 1920×940, less with a bookmarks bar, so rendering "1920×1080" tests a window nobody has. On 4 November 2026 a build that fitted 1920×1080 scrolled by 137 px at 1920×940.

For a dashboard, this table comes first. The general widths in the [checklist](../SKILL.md) still apply as smaller views.

| Case | CSS viewport | Must hold |
| --- | --- | --- |
| Operator's usual desktop (4K at 150%, measured from their screenshots) | 2560×1145 to 2560×1250 | All primary and supporting panels without page scrolling |
| 1080p monitor | 1920×940 | Primary, next action and capacity without page scrolling |
| True 4K at 100% | 3840×2160 | Scale up first, see below |
| FLIGHT open | Each of the above less the rail | Recompose; a drawer is acceptable if panels would be crushed, and it keeps drafts and focus |

"Without page scrolling" is about the page: a named list may still scroll inside its panel. Test both ends of a range, with FLIGHT folded and open.

Also check 1920×1080, 2560×1440, 1280 and 1600 wide, 1600×700, a 1920×1080 viewport at device scale 2, light and dark, and the ticket's own views. These extras don't replace a row. Device scale changes raster density, not layout width. A 4K display can expose 1920 CSS px at 200% OS scale, so monitor resolution alone tells you little. Ask the operator for `innerWidth` and `innerHeight` if these look out of date.

**Show scrollbars in renders.** Playwright's headless Chromium hides them, which hides the width they take and any overflow. Launch with `ignoreDefaultArgs: ["--hide-scrollbars"]`.

**From 3300 CSS px, scale before adding.** At 100% on a 4K monitor, 13 px text is very small and the panels fill only part of the page. The app sets `zoom: 1.5` on the root, so at 3840 wide the page composes like its 2560 layout. Add panels only if they answer a further question. Check outside margins and holes between regions; more rows and cards are options, not proof of useful adaptation.

Zoom multiplies viewport units, so size with `--vh` and `--dvh`, which divide by the zoom. `getBoundingClientRect` returns zoomed pixels, so code that measures and then writes pixels must use client sizes.

**Narrower screens.** Recompose the grid before shrinking text or moving essential status below the page. The Overview's right column drops to 480 px below 1700 wide, and the columns stack below 1500. Avoid a fixed-width primary beside an unlimited `1fr` stack.

## Review the operator's task, not only geometry

Inspect settled full-page screenshots before crops. Use one source-shaped dataset for before and after, and label fictional versus copied data. Ask whether the operator can find active and held work, remaining capacity, system constraints and the next useful action without page scrolling.

Record panel bounds and the first visible content, plus a verdict on hierarchy, column allocation, chart shape, padding and useful information per region. A dashboard that loses its primary information from the first screen fails, however far it can be scrolled. That is an Important finding. More screenshots or hashes don't repair that.

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
