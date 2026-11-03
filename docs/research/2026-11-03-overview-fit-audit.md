# Overview: responsive fit and design audit

Status: measured problem and proposed design budget, 3 November 2026. Product changes are on hold while a native proposal is rendered and reviewed. Current live/main source is `99e8404ea2e78e442dee828092f6b997582ddbe7`. This document does not claim a new layout has passed or shipped.

## What the Overview must answer

Who is working or needs intervention? Can work continue within context, provider and machine capacity? What is happening now, what changed, and what comes next?

Retain the accepted seat-column spacing and ordering near the top. Live activity must remain primary. Retain numeric context used/window/remaining, provider windows and reset/freshness, machine constraints, readable graphs and useful Pipeline access. The goal is a composition that works at 1080p and 4K, not content deletion or uniformly smaller text.

## Measured regression

Read-only captures of the actual application use the same live source and no writes. Full captures and measurement JSON are private because they contain actual operational identities and data. The controller stores them under `overview-layout-audit-2026-11-03`; no private image is committed here. Heights and coordinates below are CSS pixels. Visibility uses intersection with the actual clipped application content region, not the entire browser viewport. The initial probe’s viewport-only fraction overcounted the bottom chrome; this table corrects it. Live data has nine configured seats and two observed loops; the normal test fixture has eleven seat rows and a separate two-loop strip.

| CSS viewport / FLIGHT | Crew / secondary widths | Machine bounds | Pipeline starts | Result |
| --- | --- | --- | --- | --- |
| 1920×1080 / folded | 1200 / 588 | y=1009, h=795 | y=1816 | Machine ~2% visible within the actual content clip; Pipeline absent |
| 1920×1080 / open | 1116 / 340 | y=1101, h=851 | y=1964 | Machine and Pipeline absent |
| 2560×1440 / folded | 1200 / 1228 | y=1003, h=787 | y=1802 | Machine ~49% visible within the actual content clip; Pipeline absent |
| 3840×2160 / folded | 1200 / 2508 | y=1003, h=787 | y=1802 | All eventually fit, but secondary plots/status stretch excessively |
| 1920×1080 / DPR 2 / folded | 1200 / 588 | y=1009, h=795 | y=1816 | Same CSS capacity as 1080p at DPR 1 |

Device scale matters: a physical 3840×2160 output can expose a 1920×1080 CSS viewport. This audit does not assume the operator's actual OS scale. The source's larger-width row rule increases compact 32px rows to 40px without adding information; the measured nine-seat block grows by 88px.

The central grid uses `minmax(1050px, 1200px) minmax(340px, 1fr)`. It caps the accepted primary roster and gives all additional width to the secondary stack. Three vertically stacked Machine histories create a roughly 800px panel. Pipeline follows that tall workspace. Padding is already 8px/12px in relevant panels; reducing it alone cannot correct this allocation.

## Compare the approval honestly

The approved PR #1353 `overview-density-1920x1080-light.png` puts Pipeline above Crew and begins Activity near the bottom of the viewport. It is not proof of a complete one-screen operational overview. The later content inventory's claim that this approved image put Crew immediately after stats is incorrect. Preserve that inventory as historical evidence; this audit records the correction.

The operator's later explicit priorities supersede that prototype: seats near the top, activity retained, context capacity visible, Pipeline secondary. Do not blindly restore the approved image or treat an image approval as approval for every subsequent visual regression.

## Proposed first-screen budget

This is a sizing hypothesis for a rendered native proposal, not a passing measurement. At 1920×1080 with FLIGHT folded, the measured application leaves approximately 843px below the KPI strip for the operational canvas. Headers, normal content, controls and interior spacing must all fit within each panel budget.

| Primary stack | Target height | Immediate content |
| --- | ---: | --- |
| Crew and Loops | ≤460px | All eleven normal fixture seat rows plus a separate two-loop strip, accepted columns, known/unknown context, actual state/action words and loop status |
| Live activity | 216px | Several recent events, filters, recorded times, visible scroll/count and full-text access |
| Pipeline | 112px | Aligned lane counts, useful examples/assignee/CI, Board route |
| Gaps | 24px | Two 12px gaps |
| Total | ≤812px | Leaves room for measured chrome variation |

| Secondary stack | Target height | Immediate content |
| --- | ---: | --- |
| Provider and GitHub capacity | 128px | Remaining/window/reset, freshness/restrictions and GitHub budget |
| Timeline and next action | 232px | Measured spans/instant ticks, shared axis, legend and actionable next item |
| Throughput | 192px | Labelled history, unit/window, latest/peak and missing intervals |
| Machine | 236px | CPU/RAM/disk trends side by side, current values, admission/test-lock warning |
| Gaps | 36px | Three 12px gaps |
| Total | 824px | Requires real render and qualitative review |

Crew needs roughly 1050–1200px for its accepted tracks. Detailed Timeline generally needs 520–1200px. Three readable Machine plots need about 560px combined width. These are proposals to validate against content, not universal breakpoints. At 2560 and 3840, add a useful third column when actual content width permits instead of stretching a secondary plot to 2508px. Full allowance detail can then sit beside monitoring panels. Preserve compact rows unless more height adds useful information.

The open FLIGHT rail currently leaves 340px for secondary plots at 1080p. Recompose deliberately before that point. A drawer/overlay is a candidate where the operational canvas and assistant cannot coexist at adequate widths; preserve draft and focus. The proposal must show the tradeoff explicitly, not quietly squeeze or hide primary information.

## Data retention and detail access

| Data | Must remain immediately apparent | Full content retained through |
| --- | --- | --- |
| Seats and context | Identity, state and age, work/reference, step/tries, rate, cost, context used/window/remaining, common actions | Existing Agent links and keyboard detail for complete work/reasons/run breakdown |
| Loops | Name, state, step and warning | Read-only Agent detail; no new loop controls |
| Activity | Recent events, times, filters and paused reader status | Visible internal scrolling and full event disclosure |
| Provider limits | Every configured restriction, window/remaining/reset, stale/unknown/backoff | Named full allowance comparison with forecast, source, read age and exact detail |
| GitHub capacity | Remaining/limit/reset and slowed/unknown state | Existing budget/source detail |
| Timeline | Useful measured spans, instant ticks, UTC axis and next action | Full interval table, identities/reasons and existing lazy Map |
| Throughput and KPIs | Every summary's unit/window/denominator; labelled latest/peak/history | Existing history selection and definitions; no invented samples |
| Machine | CPU/RAM/disk current/trend, seat/session admission and test-lock warning | Exact process/test/other, swap, slots, memory, transcript footprint, queue/actions and recorded samples |
| Pipeline | Lane counts, meaningful examples/assignee/CI and hidden-count indicator | Full Board |

Context capacity, provider allowance, machine admission and token throughput are separate quantities. Do not invent raw provider token allotments. Any proposed disclosure must have a visible name, keyboard access and full data; current restrictions and urgent warnings cannot be hidden inside it. Avoid duplicate allowance summaries that consume space without adding a decision.

## Why previous QA was insufficient

The prior reports checked component behavior, overflow, keyboard reachability and numerous screenshots. They did not enforce a page-level budget for the normal first screen. Eventual scroll reachability was accepted even when the operator's high-level operational question could no longer be answered. Screenshot counts, clean CI and accurate chart axes do not establish a useful dashboard composition.

This is a failed page-purpose check and warrants an Important finding. Historical QA stays immutable; a new review must say exactly which previous conclusions are insufficient. Compare settled full-view before/after images first, then focused crops for seat columns, labels, charts and actions. Use matched source-shaped data, light/dark, folded/open FLIGHT, CSS 1920×1080, 2560×1440 and 3840×2160, plus 1920×1080 at DPR 2. Retain required smaller and short viewports. Report bounds and visible content alongside an explicit judgment of hierarchy, chart shape, alignment, density and usability.

## Design guidance

The reusable repository `hud-design` skill is being strengthened with a composition reference and an Important first-screen purpose check. A skill supplies a method and review obligations; the rendered proposal must demonstrate judgment. [Carbon's dashboard guidance](https://www.carbondesignsystem.com/building-blocks/data-visualization/dashboards) supports hierarchy and selecting the appropriate monitoring/detail structure. [Microsoft's dashboard guidance](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips) supports an audience-focused at-a-glance overview and clear routes to detail. The specific content and dimensions above come from this application's audit, not those general references.
