# Operational Overview implementation

This implementation follows the reviewed [native proposal](../mockups/2026-11/overview-fit-proposal/index.html) and its [retention inventory](../mockups/2026-11/overview-fit-proposal/inventory.md). The proposal is fictional and demonstrates composition; production values continue to come from existing resources. The earlier 1353 mockup placed Pipeline above Crew. Later operator direction explicitly restores Crew and live Activity ahead of Pipeline.

## Composition and available space

Crew, Activity and Pipeline form the primary natural stack. Provider allowance, measured Timeline and selected history form a second stack. Machine and per-seat context form an independent resource stack. At adequate content width, the same analytical wrappers become three columns; there are no measured panel offsets or shared tall rows.

The production Crew comparison table remains 1050px wide with the accepted 128 / 80 / flexible Work / 96 / 64 / 178 / 52px columns, 8px gaps, and 32px rows. A panel needs 1052px to include its borders. Three useful columns therefore start at 2076px of actual content width, rather than treating invisible borders or scrollbars as free space. Normal rows do not reserve an invisible scrollbar gutter. Larger rosters scroll explicitly, keep their sticky identity and focus reveal, and report actual overflow/visible rows.

The canvas stops growing at 2880 CSS pixels. The widest primary column stops at 1280px; analytical columns remain meaningful comparison widths. Height is a separate input: taller desktops expose the complete allowance table, more Timeline lanes, larger measured plots and five history comparisons. Device pixel ratio does not select a roomier CSS layout.

At smaller content widths Crew remains full width. Analytical panels recompose below it rather than crushing their plots. Short windows expose fewer rows with explicit scrolling, without hiding seats or moving row actions away from their rows.

## Retained content and access

| Existing content | Monitoring | Complete access |
| --- | --- | --- |
| Configured seats, FLIGHT, stopped/idle/blocked/queued states, work identifiers, answers/interrupt/end, rate, cost, context, state age | Existing `AgentsPanel` and accepted columns, unchanged source projection | Existing Agent/Board/PR/selection/Add routes and controls; observed loops remain in the Loops strip |
| Live activity | Existing `ActivityPanel`, all seven filters, Pause/Resume and source errors | Existing message, PR, run, ticket and attention routes; held reading position and 120-event bound remain |
| Pipeline | One actual example per lane with explicit total and not-shown count, after Activity | Existing filtered Board lanes and ticket/assignee links |
| Provider allowance | Tightest recorded supported window per configured/discovered account, remaining/reset/stale status; unknown windows explicitly counted; GitHub budget | Complete existing `QuotaPanel`: every account/window used/remaining/reset, forecasts, source identifiers and ages, collector errors/backoff/next retry, collection cadence and GitHub budget details |
| Context capacity | Per-seat used/window/remaining/used%, independent from throughput and allowance; known/unknown count at roomier widths | Existing complete seat context; no pooled allowance or invented limits |
| Timeline | Existing measured spans and distinct tool-start instants, shared track/time-axis gutter, real lane count and overflow cue | All-lane native reader, complete UTC interval evidence and existing Map route. Short span labels move to companion text when actual text width does not fit; duration units are not silently clipped |
| Selected history | All five original measures, units, true latest/peak/scales, missing intervals and explicit recorded-value expansion | Native larger plot and full minute table for the selected measure; five-way comparison when real width and height permit |
| Machine | Current CPU/RAM/disk free, complete-minute traces, zero baselines/ranges/peaks/endpoints, swap, process counts, slots and test-lock state | Complete existing Machine/LockBox reader: current and historical values, agent/test CPU/RAM split, transcript total/per-seat bytes/files/oldest age, allocation warning, holder/command/elapsed/usual-duration availability, named waiters/tickets, Stop the run and Open routes |
| Next decisions | Existing first recorded next action and count of further actions | Existing evidence/discussion and complete inbox routes; permissions and forms unchanged |
| Connection, refresh failure, stale data and critical constraints | Existing semantic Overview heading and exceptional source-state header; binding quota forecasts/limits, actual allocation hold reason and stalled lock are visible independently of the side column | Existing retry controls and complete source evidence. Healthy operation adds no hero/banner height |

Unknown machine slot capacity stays unknown. An incomplete payload without its history window end uses relative bucket labels and explicitly says the end was not reported; it does not fabricate a clock timestamp or emit NaN keys.

## Conversation and readers

Below the roomy desktop breakpoint, expanding FLIGHT on Overview temporarily covers the analytical side while preserving the monitoring canvas width. Crew/log/global state remain visible; the background header/main/footer are inert during the modal conversation. Collapse/Escape restores the rail and retained draft. Roomier desktops keep the 400px conversation inline beside useful columns. Other pages keep their existing dock composition and session-only fold preference.

The same mounted conversation/composer survives folding, reflow and route changes. Existing attention readers can open above the conversation; its modal announcement is suspended while that reader is active. Complete analytical readers use native dialogs, labelled bounded keyboard regions and focus restoration. Inline allowance detail opens without taking focus on page load.

## Data and rendering boundaries

No server collection, API schema, provider action or polling cadence is added. Existing canonical health/config/limits/GitHub, overview/session, crew, machine and test-lock resources are reused. Complete readers mount lazily and share the already-mounted monitoring subscriptions. Selecting another history reads a different series from the same loaded summary. Map remains its own lazy route.

The page has no clock or ResizeObserver. Its panel stacks flow naturally. Existing row state/age clocks and the new exceptional-status/reader clocks remain local; overflow notes and measured span-label fitting update only their own children. They do not order the roster or invalidate resources.

## Validation status

Implementation is in progress. Early production-App smoke images are diagnostic iterations, not final source-bound evidence. The first frame exposed 122px outer overflow; the next exposed 27px from shared padding overriding compact bodies. Both failures are retained. The third actual App smoke fits the settled 1920×1080 normal fixture without outer scroll, preserves all eleven 32px rows, and uses three useful columns at 2560×1440/open. Subsequent normal-roster no-pan, reader focus, scrolling cues and large-plot refinements still require current-source browser proof.

The first selected unit pack passed 296/326; 29 complete-panel tests needed to enter the new lazy readers, and one CSS guard required the new natural composition instead of measured offsets. Their content/action/freshness assertions were retained. The narrowed recheck passed 157/157, including honest missing history timestamps. Original clock, idle render-budget, App, Header and Dock cases passed in the earlier pack. Final source-bound browser/state coverage, fresh independent whole-branch review and CI remain pending.

The next source-freeze pack passed all 28 affected operational/Timeline/CSS cases, web types, workspace lint, and the web production build. This includes a measured 15-second interval (not zero minutes), omitted machine slot capacity, and the responsive eight-cell KPI threshold. These are staged checks; they are not represented as a single rerun of all 327 cases.
