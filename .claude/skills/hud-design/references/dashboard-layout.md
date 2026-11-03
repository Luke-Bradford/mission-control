# Dashboard composition and responsive fit

Read this for an Overview, operational dashboard, or a substantial panel-layout change. Use the existing HUD tokens and accessibility rules. This reference adds composition judgment; counting tests is not a design verdict.

## Start with decisions and data

State the operator questions the initial view must answer. Inventory each visual's actual fields, source, unit, freshness, normal row count, actions and full-detail route. Distinguish essential status from analytical depth. A field's existence does not require a separate card, and two cards should not repeat the same summary.

Preserve explicitly accepted parts. If the operator says the seats' column spacing is right, make that a retained constraint. Do not trade it away to satisfy a new layout template. Explain any proposed movement or progressive disclosure; keep full content and keyboard access. A critical warning, identifier or action must remain apparent.

## Budget the real viewport

Record the reference CSS viewport, browser zoom, OS scaling, dock state and actual application chrome before implementation, together with the essential fields and normal row count. Where the operator’s exact setup is unavailable, state the assumed reference explicitly and retain the supported viewport matrix; do not choose a convenient reference after rendering. Physical monitor resolution alone is insufficient: a 4K display can expose a 1920 CSS-pixel viewport at 200% OS scale. Device scale 2 changes raster density for a given CSS viewport; it does not change that viewport’s layout width or simulate browser zoom.

For the supported views, write a vertical budget: header + gutters + summary strip + main operational regions + gaps + footer. Identify exactly which panels and normal rows belong above the fold. Default operational status should not require searching a long page. Large histories and exceptional fifty-row lists can have named, visible internal scrolling; their availability is not proof that the overview itself fits.

For Mission Control, explicitly examine 1920×1080, 2560×1440 and 3840×2160 CSS viewports, folded/expanded FLIGHT, plus a 1920×1080 viewport at device scale 2. Keep required smaller/short views from the ticket. Do not substitute a different height for a named acceptance viewport.

## Size by purpose

Give each visual an explained minimum, preferred range and maximum width. Derive a table minimum from its meaningful columns, readable values and actions. Give a text log enough line length. Size a chart for comparisons and readable labels, rather than stretching a tiny plot across leftover space. Bound a compact status summary even on a large display.

At wider breakpoints, use additional useful columns, comparisons or rows. Avoid a fixed-width primary table beside an unlimited `1fr` stack. At narrower breakpoints, deliberately recompose the grid before shrinking text, squeezing every panel, or moving essential status below the page. Consider a drawer/overlay when an expanded assistant cannot coexist with the operational canvas at adequate widths; preserve drafts and focus.

Whitespace should group information and establish hierarchy. Check both wasted interior space and crowded content. Prefer fewer competing containers and captions over reducing every gap. Do not force all panels to the same dimensions when they answer different questions.

## Separate monitoring from investigation

An overview needs immediately legible status, exceptions, capacity and next actions. Full raw samples, extensive provenance and historical investigation need an obvious route, not automatic expansion into every card. Preserve real units, denominators, stale/unknown states and access to the underlying data.

Use a sparkline for a trend cue, a larger labelled plot for comparison, and a table for exact values. Do not silently change units, fabricate series or confuse context capacity, provider allowance and token throughput. Avoid duplicating these measures merely to fill space.

## Review the operator's task, not only geometry

Inspect settled full-view screenshots before focused crops. Use the same source-shaped dataset for before/after comparisons and label fictional versus copied/live data. Ask whether the operator can find active/held work, remaining capacity, system constraints and the next useful action without page scrolling in the normal reference case.

Record panel bounds and initial visible content, plus an actual qualitative verdict about hierarchy, column allocation, chart shape, padding and useful information per region. An unclipped panel below the fold can still fail the page's purpose. More screenshots or hashes do not repair that failure.

A dashboard that loses its declared primary operational information from the normal first screen fails the purpose check and should receive an Important finding. Do not call it a design pass solely because every item can eventually be scrolled to. Preserve genuine baseline strengths while proposing one reasoned design, rather than making the operator discover each composition problem.

General references, used as design rationale rather than a substitute for app-specific judgment:

- [Carbon: Dashboards](https://www.carbondesignsystem.com/building-blocks/data-visualization/dashboards)
- [Microsoft: dashboard design](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips)
