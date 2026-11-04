# Dashboard composition and responsive fit

Read this for an Overview, operational dashboard, or a substantial panel-layout change. Use the existing HUD tokens and accessibility rules.

Your job is to arrive with one reasoned design, so the operator doesn't have to direct the layout. Published guidance gives principles but no widths, so the defaults below come from this operator's requests and from renders of this app. Use them to fill in the panel budget described below, and depart from a default when you can say why. Counting tests is not a design verdict.

## What this operator asked for

Treat these as the brief. Later operator steering overrides them.

- "I want to get to a point where you or claude is telling me how it should look and its better than I imagined."
- "The page needs to be scrolled to see everything, so not really an overview."
- "we don't have to drop content, we just need to make it fit better, which needs a redesign."
- "I still don't think some of the graphs are detailed enough." Earlier work was also corrected for removing time axes and peak values, and for dropping token capacity and the activity log.
- "the seat should be about 2/3 of the page width" and "We should have more info in the seats than the forms on the right."
- "why is everything the same width for visuals that don't need to be that wide?" and "Forms should be the right size, adequate."
- 4K and 1080p must both work in the same view: "needs to ideally accomodate both renders."
- The seats' column spacing is accepted. Don't trade it away for a layout template.

## Compose in this order

1. **Name the question and the reader.** Overview: what is running, what is stuck, what is limiting us and what should happen next.
2. **Rank every visual: primary, supporting or drill-down.** One primary. Carbon's rule applies: the most important data should "occupy the largest area". Drill-down stays one click away.
3. **Allocate space by rank**, using the defaults below, before styling anything.
4. **Sketch it at the real viewports** with rough real text, not boxes. Reject any shape where a supporting panel outranks the primary.
5. **Render it busy.** Use a normal working crew, long ticket titles and active charts. An idle render hides both crowded columns and columns that stay empty.
6. **Look at the whole page first and ask what the operator would still have to explain.** Fix that, then measure.

## Allocation defaults

| Region | Default | Why |
| --- | --- | --- |
| Primary table | 60–70% of the canvas width | It carries the most fields and answers the page's main question |
| Supporting column | The rest, one column; panels sized to their content | Compact status doesn't improve by getting wider |
| Summary strip | One row, at most 96 px | It should be scanned in one pass; shrink the tiles before adding a second row |
| Log or long list | The one region that flexes vertically, showing as many one-line rows as fit | It gains from every extra row, and it prevents a hole at the bottom of the page |
| Everything else | Height set by content | Stretched panels create empty boxes and flat charts |

**Fit by condensing, not removing.** Moving a figure or chart detail off the page counts as dropping it unless the operator has agreed. Merge duplicates, shorten labels and tighten panels first. If something still has to move, propose it and say why.

One region in each column absorbs leftover height: the log or long list in the primary column, and in the supporting column whichever panel gains most from more rows. Without one, the column leaves a hole on tall screens. Align both columns' bottom edges.

**Tables.** Give identity, state and number columns their longest realistic value and no more. One text column takes the remaining width, up to a readable limit. When the table is wider than that, add the next most useful column instead of widening the text. Keep related values next to each other: a status at the far side of a wide cell reads as a separate column.

**Charts.** A sparkline is 16–32 px tall inside a row. A labelled plot needs 320–720 px of width at roughly 3:1 to 5:1, with labels that don't touch the neighbouring plot. Past 720 px, show more series or comparisons rather than a longer line.

**Repeated controls.** If six tiles each say "History →", make each tile the link. Repeated words are the first thing to remove when a page feels crowded.

## Viewports: use the real ones

A viewport is what the page actually gets, after browser toolbars, tabs and the taskbar. A 1080p monitor gives roughly 1920×940, less with a bookmarks bar, so rendering "1920×1080" tests a window nobody has. On 4 November 2026 a build that fitted 1920×1080 scrolled by 137 px at 1920×940, the likely reason the operator kept having to scroll after checks passed.

| Case | CSS viewport | Must hold |
| --- | --- | --- |
| Operator's usual desktop (4K at 150%, measured from their screenshots) | 2560×1145 to 2560×1250 | All primary and supporting panels without page scrolling |
| 1080p monitor | 1920×940 | Primary, next action and capacity without page scrolling |
| True 4K at 100% | 3840×2160 | Scale up first, see below |
| FLIGHT open | Each of the above less the rail | Recompose; a drawer is acceptable if panels would be crushed |

"Without page scrolling" is about the page: a named list may still scroll inside its panel. Test both ends of a range. Keep the ticket's smaller and short views too. Ask the operator for `innerWidth` and `innerHeight` if these look out of date.

**Above about 3200 CSS px, scale before adding.** At 100% on a 4K monitor, 13 px text is very small and the panels fill only part of the page. Prefer scaling the interface so the page composes like its 2560 layout, and add panels only if they answer a further question. On 4 November `zoom: 1.5` on the root reproduced the 2560 composition, but the lower panels overflowed and clipped, so fix heights that depend on the viewport as part of the scaling. Re-render whichever method you use.

## What has already failed here

- Primary capped at 1200 px beside an unbounded secondary column: at 4K the secondary reached 2508 px and Crew 33.8% of the canvas.
- Every panel the same width, whatever it held.
- Machine stacked about 800 px tall, pushing Pipeline off the screen.
- Pipeline promoted above seats without anyone asking.
- Passing on geometry, then the operator rejecting the composition, more than once.
- A branch with 4,147 added lines of product code and 86,450 added lines of evidence. Keep evidence small enough that someone will read it, and spend the effort on the page.

## Start with decisions and data

State the operator questions the initial view must answer. Inventory each visual's actual fields, source, unit, freshness, normal row count, actions and full-detail route. Distinguish essential status from analytical depth. A field's existence does not require a separate card, and two cards should not repeat the same summary.

Preserve explicitly accepted parts. If the operator says the seats' column spacing is right, make that a retained constraint. Do not trade it away to satisfy a new layout template. Explain any proposed movement or progressive disclosure; keep full content and keyboard access. A critical warning, identifier or action must remain apparent.

## Budget the real viewport

Record the reference CSS viewport, browser zoom, OS scaling, dock state and actual application chrome before implementation, together with the essential fields and normal row count. Where the operator’s exact setup is unavailable, state the assumed reference explicitly and retain the supported viewport matrix; do not choose a convenient reference after rendering. Physical monitor resolution alone is insufficient: a 4K display can expose a 1920 CSS-pixel viewport at 200% OS scale. Device scale 2 changes raster density for a given CSS viewport; it does not change that viewport’s layout width or simulate browser zoom.

For the supported views, write a vertical budget: header + gutters + summary strip + main operational regions + gaps + footer. Identify exactly which panels and normal rows belong above the fold. Default operational status should not require searching a long page. Large histories and exceptional fifty-row lists can have named, visible internal scrolling; their availability is not proof that the overview itself fits.

For Mission Control, examine every row of the viewport table above with FLIGHT folded and expanded. Also check 1920×1080, 2560×1440 and a 1920×1080 viewport at device scale 2; these extras don't replace any row. Keep required smaller/short views from the ticket. Do not substitute a different height for a named acceptance viewport.

## Size by purpose

Give each visual an explained minimum, preferred range and maximum width. Derive a table minimum from its meaningful columns, readable values and actions. Give a text log enough line length. Size a chart for comparisons and readable labels, rather than stretching a tiny plot across leftover space. Bound a compact status summary even on a large display.

At wider breakpoints, use additional useful columns, comparisons or rows. Avoid a fixed-width primary table beside an unlimited `1fr` stack. At narrower breakpoints, deliberately recompose the grid before shrinking text, squeezing every panel, or moving essential status below the page. Consider a drawer/overlay when an expanded assistant cannot coexist with the operational canvas at adequate widths; preserve drafts and focus.

Whitespace should group information and establish hierarchy. Check both wasted interior space and crowded content. Prefer fewer competing containers and captions over reducing every gap. Do not force all panels to the same dimensions when they answer different questions.

Plan the relationship between columns as well as each panel. A short side stack should not wait for
the tallest unrelated column before exposing its next useful content. Keep comparison regions aligned
with the main grid. Showing a selected history and repeating it in another grid needs a concrete task
reason; available height alone is insufficient. At true 4K, inspect both outside margins and holes
between regions. More rows, larger charts and more cards are options, not evidence of useful adaptation.

## Separate monitoring from investigation

An overview needs immediately legible status, exceptions, capacity and next actions. Full raw samples, extensive provenance and historical investigation need an obvious route, not automatic expansion into every card. Preserve real units, denominators, stale/unknown states and access to the underlying data.

Use a sparkline for a trend cue, a larger labelled plot for comparison, and a table for exact values. Do not silently change units, fabricate series or confuse context capacity, provider allowance and token throughput. Avoid duplicating these measures merely to fill space.

## Review the operator's task, not only geometry

Inspect settled full-view screenshots before focused crops. Use the same source-shaped dataset for before/after comparisons and label fictional versus copied/live data. Ask whether the operator can find active/held work, remaining capacity, system constraints and the next useful action without page scrolling in the normal reference case.

Record panel bounds and initial visible content, plus an actual qualitative verdict about hierarchy, column allocation, chart shape, padding and useful information per region. An unclipped panel below the fold can still fail the page's purpose. More screenshots or hashes do not repair that failure.

A dashboard that loses its declared primary operational information from the normal first screen fails the purpose check and should receive an Important finding. Do not call it a design pass solely because every item can eventually be scrolled to. Preserve genuine baseline strengths while proposing one reasoned design, rather than making the operator discover each composition problem.

Use the [visual QA workflow](../../../../docs/runbooks/visual-qa.md) to carry this budget into the plan,
rendered review and saved report. A whole-page composition verdict must explain useful allocation,
not merely confirm that panels fit.

Primary references, checked 4 November 2026; these inform judgment rather than replace the local brief. Those we could read give no grid widths or wide-screen rules, and the third-party agent skill we could read in full was tokens and a checklist, so the defaults above are ours:

- [Carbon: Dashboards](https://www.carbondesignsystem.com/building-blocks/data-visualization/dashboards)
- [Microsoft: dashboard design](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips)
- [Grafana: dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/)
- [MDN: `zoom`](https://developer.mozilla.org/en-US/docs/Web/CSS/zoom)
