> **Historical inventory for rejected 008b362d proposal.** The operator rejected its true-4K composition after publication. The previous target-area clean review below does not override that rejection. See [the corrected design contract](design-contract.md) for the active proposal and new source-bound evidence when available. Production remains paused.

# Overview operational canvas proposal

This is one design proposal from product base `99e8404ea2e78e442dee828092f6b997582ddbe7`.
It changes no production files and reads no API. Open [index.html](index.html).
Values are explicitly fictional but use the existing source shapes and definitions.

## Purpose and retained constraints

The first screen should answer: who needs help, what is running, what just happened,
and which context/provider/machine constraint affects the next decision?

The operator accepted the crew's column spacing. This proposal retains its exact seven-column
allocation: **128 / 80 / flexible Work / 96 / 64 / 178 / 52 px**, 8px gaps and 8px row-side padding,
a 1050px table minimum and 32px normal rows. Text is not reduced to squeeze another panel beside it.
The fictional density case has eleven configured seats plus two read-only observed loops.
This is a deliberate stress case; the private audit's current data had nine configured seats and two loops.

Approved PR #1353 actually places Pipeline **above** Crew. The later operator direction overrides
that placement: this proposal keeps Crew immediately after the compact metrics and Activity directly
below Crew, with Pipeline next. It does not describe the old approval as approving this new arrangement.
The approved prototype's example First-push CI/cost-per-ticket values are also not new data authority;
this proposal keeps the implemented registry definitions.

The private read-only audit measured a 1920×1080 folded canvas of 1800×953 CSS pixels after shell
spacing. Its workspace started near y183. Crew occupied410px with nine rows, Live log280px;
the right Machine panel was795px and Pipeline began near y1816. Expanded FLIGHT left plots in a340px
column. At3840, an unbounded right column grew to2508px. These measurements explain the composition
problem; private machine identities/data/screenshots are not copied into this proposal.

## Viewport and panel budgets

The normal reference is1920×1080 **CSS pixels**, DPR1. Header49px, footer30px, canvas top/bottom24px;
metrics96px and gap12px leave roughly845px for operational regions. DPR2 uses the same CSS layout;
physical3840×2160 output does not automatically mean a3840-CSS-pixel dashboard.

| Visual | Width minimum / preferred / maximum | Height minimum / preferred / maximum | Reason |
| --- | --- | --- | --- |
| Crew | 1050 / 1120–1200 / 1280px | normal rows32px; eleven-row target about460px; exceptional lists bounded390px internally | Preserve accepted fields/actions and useful Work width. All eleven normal seats plus the loop strip fit at1080p. Larger lists have a named scroll region and cue. |
| Activity | 640 / 1050–1200 / 1280px | 192 / 216 / 280px | Six useful recent rows and all filters/routes. No shared Machine height can displace it. |
| Pipeline | 900 / crew width / 1280px | 104 / 112 / 144px | Five aligned lanes; total includes the visible example. Explicit unshown count opens the full Board lane. |
| Provider summary | 500 / 588–700 / 788px | 128 / 144 / 176px | Remaining/reset/freshness for each configured account, explicit unknowns, GitHub points and an obvious complete-table route. Warnings do not depend on opening detail. More accounts require a visible bounded list, not deleting rows. |
| Timeline | 500 / 588–700 / 788px | 216 / 224 / 424px | Four current/selected measured lanes, labelled60-minute time axis, spans versus isolated starts, one next decision. Full13-lane intervals/Map remain explicit. |
| Throughput/history | 500 / 588–700 / 788px | 176 / 184 / 328px | All five existing measures selectable, labels/units/peak and gaps visible. A larger plot and raw30-minute samples are available on request. |
| Machine | 500 / 588–700 / 788px | 240 / 252 / 660px | Three meaningful bounded traces with current values, units, swap, process split, slots and lock status. Raw minute tables are not automatically expanded. |
| Full evidence dialog | 640 / 1040 / 1120px | natural, bounded by viewport | Large plots, raw tables, full reasons and exact identifiers are investigation, not permanently expanded dashboard tiles. Keyboard focus, Escape and native scroll are retained. At smaller CSS widths, the conversation is a keyboard modal: background canvas/header/footer become inert while remaining visible, and Tab stays in FLIGHT. A complete reader dialog can open above it and return focus to its initiating control. |

At1920 folded, the primary target is Crew≈460 + Activity216 + Pipeline112 +24px gaps ≈812px.
The independent analytical stack is Provider144 + Timeline224 + Throughput184 + Machine252 +36px
gaps =840px. These are hypotheses to check in actual renders, not reasons to hide overflow.

When content width reaches2074px, a third useful column separates Machine/context/evidence access
from Timeline/history. Widths remain purposeful rather than stretching a single chart across spare
space. Canvas maximum2880px centers the operational grouping on a4K CSS viewport; the surrounding
space frames it rather than becoming empty card interiors. No important panel is pushed down by
an equally tall grid row.

At1920, opening FLIGHT **overlays** the analytical side instead of recomputing it into340px plots.
This is an explicit temporary conversation mode; the underlying analytical stack is partially
obscured until dismissed, so this is not claimed as simultaneous full visibility. Crew and Live log
remain uncovered, and the global constraint status stays visible in the top bar. Close/Escape restores
the monitoring canvas, focus and retained draft. At2560/3840, FLIGHT can sit alongside adequate
columns. At1920 the visible crew/log are monitoring context while the conversation is modal; they are temporarily noninteractive until Close/Escape. This is an explicit interaction tradeoff, not simultaneous active use. An implementation must preserve the existing mounted conversation/draft and its focus
semantics; this prototype demonstrates the composition, not server action permissions.

At content widths of at least1280px, the eight-cell96px KPI strip remains; only smaller actual content widths use two rows. Below1700px viewport width, Crew remains full width; analytical panels recompose below rather than compressing
the accepted columns. At1600×700 the crew region visibly scrolls, with its actual total stated.
The full normal dashboard cannot fit in a700px height; that limitation is explicit, not a no-overflow pass.

## Every field and route

| Content / actual source | Default monitoring view | Complete access / retained meaning |
| --- | --- | --- |
| CrewRow id/displayCallSign, role, kind, hudState/stateSince | All eleven configured rows: identity/role, worded state and age; observed loops retain their separate read-only strip | Seat name and work/reason controls open complete context; Agent/selection and Add/Setup routes remain implementation requirements. No stopped/idle seat is filtered away. |
| CrewRow current/last work, ticket/PR, need/queue reason, loop state | Ticket identifier always visible, title receives flexible width, current held/queued reason and its named action are apparent | Long title/reason opens full text, exact supplied queued/reviewing SHA and evidence. No fabricated writer head or eager PR join. |
| Activity rate, run cost, contextTokens/contextWindow | Last30m-average tokens/min; cost explicitly this run; used/window/remaining/used% per seat | Unknown is `—`/unknown, not zero. Context cannot be pooled with account allowance. Additional context summary appears in the third column; core per-seat capacity never leaves the table. |
| Header/settings/model/account/CLI effort and budget | Existing identity/actions, not an added dense table column | Full seat context shows only supplied model/effort/budget; unset values are omitted. All existing action permissions/forms remain unchanged in any future build. |
| Existing activity resource, filters/pause/links | Six newest events in216px, distinct event/review/step labels and full-history control | Named keyboard reader retains120-row fictional stress history; existing product pagination and exact links are preserved, not replaced by synthetic history. |
| OverviewSummary pipeline stage/count/cards | Five aligned lanes, example ticket/assignee, total and unshown count | Board lane opens complete data. Empty lane says observed empty; missing/loading is not zero. |
| Metrics registry / OverviewSummary KPIs | All eight implemented values, units, definitions, denominators/windows, retained history cues | Definitions and full histories are accessible. CI means completed runs, cycle p50 means14d tickets with exclusions; no copy of unsupported prototype metrics. |
| LimitRow used/window/reset/sample age, collector errors, GitHub budget | Provider remaining/reset/freshness, unknown account, stale low allowance and GitHub points | Complete account×window table includes used/remaining/reset/forecast/source age/collection/retry; GitHub limit/used/poll cost separate. Reuse cached resources; no new collection or duplicate poll in a future build. |
| Timeline observed intervals and event starts; attention items | Four active/selected lanes with labelled time and duration, isolated tool-start marker, top next action | All agent lanes and exact measured interval rows/Map; all three operator items with evidence. A start event is never turned into an invented interval. |
| Existing30m token/cost/in-progress/CI/Needs series | Selected labelled plot, real latest/peak, missing-minute gaps | All30 raw samples and larger plot for the same selected series, no new request. Small counts preserve fractional axis positions; sub-cent costs retain decimals. |
| MachineView latest and OverviewSummary machine histories | CPU total-host%, RAM% with GiB denominator, disk **free** GiB, swap, process memory, slots and test-lock owner/queue | Larger labelled CPU/RAM/disk plots and exact raw samples; process versus other apps, configured max/largest session and memory headroom. No pressure extrapolation or provider allowance inference. |
| Source errors / stale / disconnected | Current stale low-account warning is always visible in header and provider panel; unknown values retain words | Product must preserve existing named loading/error/stale/disconnected/retry content. This standalone prototype does not prove those application transitions or live transport. |

All sample values, histories and durations are fictional. Graphs and labels must agree arithmetically;
raw samples remain available. The normal source-shaped example has eight in-progress tickets
(five building/checks, three review), three operator items, six working configured seats and one
working observed loop. There is no API, paid-provider call, crew/config write or observed-loop mutation.

## Actual render phases and implementation boundary

The [curated gallery](../../../evidence/overview-fit-proposal-2026-11-03/README.md) retains exact phases.
The final candidate source is `0c92ee23dfe9973203167e0299a6d1950c024dbc`. Five actual final contexts
cover both themes at 1920/folded and 2560/open, plus true 3840/dark. Their captions/last-unit glyphs,
Machine endpoint anchors, 24px native targets and absence of outer scrolling were measured.
The prior f79 phase retains the complete 20-view matrix (including DPR 2 and smaller/shorter views)
and actual modal/filter/draft/visibly scrolled reader proofs. Later changes are explicitly limited to
labels/endpoint scope and native crew/log/Pipeline target areas; old photos are never relabelled final.

Timeline labels remain **inside** the shown example bars, using `chk 12m` / `rev 10m` and an explicit
legend. A production implementation must provide external readable companion text for spans too
short for these labels, rather than clipping a duration or its unit. The normal side stack now uses
an analytical wrapper with natural flow, not a manually calculated top offset; it becomes
`display: contents` only to release the same children into three useful columns.

Actual 1920 main scrollHeight/clientHeight are 1001/1001 with scrollTop 0; the analytical stack ends
at 1021. Current Timeline axis anchors and Machine endpoint-to-trace errors are 0px. At 2560/open,
columns are 1050 / 507 / 507px. The actual full reader proof visibly exposes process, transcript and
lock rows/actions, rather than relying on text-presence booleans. Earlier V1/V2 critique, sources,
rejected proof images and their limits remain in the resolution map.

This is a reviewed design proposal, not deployed App verification. Future React implementation must
retain source ownership, route/form/permission behavior, lazy history, clock isolation and persistent
dock draft/focus, without a new collector or duplicate read. A real-App whole-branch review and CI
remain separate requirements. The final target correction was independently reported clean at
11:54:46 UTC on 3 November 2026; no production pass is inferred from that proposal assessment.
