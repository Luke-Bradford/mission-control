# Site review and redesign · operator review, 25 October 2026

Ticket #677. **Status: research and static proposals ready for review; screenshots and operator approval pending.** No application code, new routes, enforcement changes, runtime dependencies or build tickets are included.

## Evidence and limits

Reviewed the [HUD catalogue](../../prototype/mission-control-hud-catalogue.md) §§1–2.10 and [HUD prototype](../../prototype/mission-control-hud.html), plus current router, page compositions and named components below. The [research](../../research/2026-10-multi-agent-dashboards.md) compares public primary documentation. Each finding distinguishes source evidence from the operator’s visual report. No hub database or configuration was opened, and no server or browser was started.

The requested approved Overview v2 file could not be identified in this checkout: no file explicitly named as that approved reference was found. These proposals use the named HUD prototype’s dark tokens, panel/control styles, compact typography and colour rules. **Controller/operator must supply or identify the approved reference and compare density before approving Overview or its dependent pages.** These files are not represented as already approved.

Current navigation is six operational pages plus Setup with seven tabs. This review covers all of them, plus Guards as a proposed split of the current Roles/guard/test-lock tab and Activity map as an existing planned Overview surface. There is no current Activity map or Guards route. Setup’s landing view is Sessions; its shared shell is shown in every Setup mockup. Item detail, brief/help/away overlays, FLIGHT dock and popout are cross-cutting surfaces covered below, not invented routes.

## Screenshots of today · required controller capture

**No current screenshots are attached.** The task explicitly prohibits starting a browser or server. Static HTML proposals are not screenshots of the existing product. To complete the audit’s visual evidence, the controller should capture the current hub with synthetic/redacted data at 1440×1000, 1024×900 and 390×844. Capture every row below, plus long labels, stale/error/empty states, expanded dock and relevant overlays. Link the resulting images into each page’s screenshot slot; use no real names, emails or machine paths. No placeholder image is passed off as evidence.

## Review queue

Every mockup is self-contained and offline: inline CSS/SVG, no scripts, remote fonts or data. The HUD font family declarations use local fallbacks if unavailable. Action buttons are disabled intentionally; links and native disclosure controls permit review. Samples are synthetic, never live values. A static filter or editor illustrates a proposal rather than claiming functional backend support. The FLIGHT dock is collapsed in each file so the page receives the available width.

All rows await operator approval. For each, record a decision (approve/revise), date and exact file revision; review desktop/narrow layout, content hierarchy, density against approved Overview v2 and the acceptance criteria. A silent review is not approval. Proposed build tickets below are local descriptions only; do not file until approved. The Activity map UI tickets already exist according to #677 and should be reconciled rather than duplicated.

| Page | Static proposal | Screenshot of today | Approval |
| --- | --- | --- | --- |
| Overview | [overview.html](../../mockups/2026-10/overview.html) | Pending controller capture | Pending |
| FLIGHT | [flight.html](../../mockups/2026-10/flight.html) | Pending controller capture | Pending |
| Board | [board.html](../../mockups/2026-10/board.html) | Pending controller capture | Pending |
| Agent | [agent.html](../../mockups/2026-10/agent.html) | Pending controller capture | Pending |
| Comms | [comms.html](../../mockups/2026-10/comms.html) | Pending controller capture | Pending |
| Telemetry | [telemetry.html](../../mockups/2026-10/telemetry.html) | Pending controller capture | Pending |
| Activity map | [activity-map.html](../../mockups/2026-10/activity-map.html) | Pending controller capture | Pending |
| Setup · Sessions | [sessions.html](../../mockups/2026-10/sessions.html) | Pending controller capture | Pending |
| Setup · Repos | [repos.html](../../mockups/2026-10/repos.html) | Pending controller capture | Pending |
| Setup · Loops | [loops.html](../../mockups/2026-10/loops.html) | Pending controller capture | Pending |
| Setup · Accounts | [accounts.html](../../mockups/2026-10/accounts.html) | Pending controller capture | Pending |
| Setup · Roles | [roles.html](../../mockups/2026-10/roles.html) | Pending controller capture | Pending |
| Setup · Guards and test lock | [guards.html](../../mockups/2026-10/guards.html) | Pending controller capture | Pending |
| Setup · Sources | [sources.html](../../mockups/2026-10/sources.html) | Pending controller capture | Pending |
| Setup · Access and notifications | [access.html](../../mockups/2026-10/access.html) | Pending controller capture | Pending |

## Overview

Catalogue: §2.1. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/Overview.tsx; overview/TimelinePanel.tsx, PipelinePanel.tsx, MachinePanel.tsx, AgentsPanel.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** The page already combines KPI strip, Agents, Timeline, Pipeline, Activity, Machine and quota. Timeline has clipped duration spans, a 60-minute axis and a legend; Pipeline already has lanes and ticket drill-through.

**What doesn’t / differs from the ticket:** The ticket is asking to simplify existing components, not create them. Pipeline cards also show PR references, age and CI dots. Timeline span labels are hover titles and the tracks are hidden from assistive technology. The operator reports poor geometry and alignment; this is not independently reproduced.

**What should change:** Keep ticket number, optional short title and assignee in Pipeline. Use the Board for checks and PR detail. Give Timeline rectangular spans, common vertical gridlines and a readable selected interval. Align machine label, plot and current value in fixed columns. Keep short state words and a separate reason. Add an explicit Activity map entry below the operational panels.

**Mockup:** [Overview](../../mockups/2026-10/overview.html). Approval: pending.

**Proposed build ticket, after approval:** Simplify Overview timeline, machine alignment and Pipeline.

**Build acceptance / tests to write first:** Verify common timeline coordinates at both ends of the window, clipped/open spans, stale data, empty lanes and keyboard access to interval evidence. Pipeline must reach the correct Board ticket/stage. State words are 5–10 characters where possible; preserve recognisable existing short terms such as Idle rather than padding them.

## FLIGHT

Catalogue: §2.2. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/Flight.tsx; flight/AskedOfYou.tsx, Brief.tsx, WorkInFlight.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Asked of you, Work in flight, Incoming, Watch list, Drafts and Decided without you already have separate components; draft wording explicitly keeps sending with the operator.

**What doesn’t / differs from the ticket:** The current component order puts Situation, Brief and Memory before Asked of you. That can delay the most actionable content. Visual density and the visibility of evidence still need screenshot review.

**What should change:** Move the immediate decision to the top. Keep catch-up, recommendation and basis together; retain the living brief, memory, incoming, drafts and working log below. Distinguish a proposal from a completed action.

**Mockup:** [FLIGHT](../../mockups/2026-10/flight.html). Approval: pending.

**Proposed build ticket, after approval:** Prioritise decisions and evidence on FLIGHT.

**Build acceptance / tests to write first:** A decision opens its actual brief, discussion and answer flow; no draft is sent automatically. Empty decisions, stale brief and failed source reads remain distinct.

## Board

Catalogue: §2.3. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/BoardPage.tsx; board/Kanban.tsx, Toolbar.tsx, cards.ts`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Already supports repo and lane scope, layouts, Done ranges, ticket details, and brief generation. Reuses the Pipeline stage vocabulary.

**What doesn’t / differs from the ticket:** Overview should not duplicate its detail. Scope controls and counts need a visual pass for long titles, many lanes and no matching work; no rendering defect is asserted from source alone.

**What should change:** Retain Board as the detailed record: lane counts, priority, assignment and evidence in a selected ticket inspector. Keep filter scope persistent and obvious; do not discard existing layouts or brief tools in the build.

**Mockup:** [Board](../../mockups/2026-10/board.html). Approval: pending.

**Proposed build ticket, after approval:** Refine Board scope and selected-ticket detail.

**Build acceptance / tests to write first:** Pipeline links land on the intended ticket or stage; filtered counts match rendered cards. Check long titles, no repos, no matches and Done ranges; preserve existing layout and brief behaviour.

## Agent

Catalogue: §2.4. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/Agent.tsx; agent/Header.tsx, Tiles.tsx, StreamPanel.tsx, RunsPanel.tsx, SideTabs.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Picker, need banner, run-aware transcript, Runs and side tabs exist. Explicit missing-agent and no-agent states exist. Observed loops cannot be interrupted by the page shortcut.

**What doesn’t / differs from the ticket:** The ticket asks for shorter state wording on this page as well as Overview. Current operational detail competes in header tiles and the transcript. Preserve provider differences and observed-loop restrictions.

**What should change:** A stable short state sits beside the call sign; the current reason has its own line. Keep the message/tool transcript readable with expandable tool detail; put attempts, plan, queue, subagents and files beside it.

**Mockup:** [Agent](../../mockups/2026-10/agent.html). Approval: pending.

**Proposed build ticket, after approval:** Clarify Agent state, reason and run detail.

**Build acceptance / tests to write first:** Test long reasons independently from short states, queued versus delivered messages, no selected agent, stale transcript and provider-specific context. Preserve observed-loop control restrictions.

## Comms

Catalogue: §2.5. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/Comms.tsx; comms/NeedsList.tsx, Threads.tsx, Conversation.tsx; agent/StreamPanel.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Needs you and per-agent conversation selection exist; a Needs you item may explicitly reach outside session scope. Narrow layouts scroll the conversation into view. Agent transcript already merges local agent-comms activity.

**What doesn’t / differs from the ticket:** Current Comms composes NeedsList, Threads and Conversation, with no room or graph component in this page. The earlier design explicitly selected layout A. This is a missing UI surface, not evidence that no agent messages exist server-side.

**What should change:** Use Needs you, rooms and direct chats in the left rail, chatter in the main column, identity/evidence in context. Keep the directed graph independent of the selected thread, with stable nodes and an adjacent edge table. Retain the informational guard drawer and its acknowledgement behaviour. Preserve current operator-to-agent conversations.

**Mockup:** [Comms](../../mockups/2026-10/comms.html). Approval: pending.

**Proposed build ticket, after approval:** Build Comms layout A with chatter and selection-safe graph.

**Build acceptance / tests to write first:** For every roster agent, FLIGHT, all agents, stopped/removed agents and an empty selection: show matching incoming/outgoing edges or an honest empty state without crashing. Session, room and time filters apply consistently. Queued is never labelled delivered. Include missing identity, long message, stale room and keyboard navigation cases.

## Telemetry

Catalogue: §2.6. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/Telemetry.tsx; telemetry/Kpis.tsx, FlowOfWork.tsx, AgentsGroup.tsx, CapacityGroup.tsx, CostGroup.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Already organised as Flow of work, Agents, Capacity and Cost. It keeps the last response while fetching; usage is scoped by agent/account/ticket and code documents exceptions. Costs are already labelled API-equivalent. Several unavailable values explicitly say Not tracked.

**What doesn’t / differs from the ticket:** The range toolbar does not alone explain fixed 14-day flow, today-only utilisation and latest-run turn data. The completed source reconciliation below identifies label, scope and interpolation mismatches. Existing deterministic tests substantiate the calculations; production readings and rendered geometry remain unverified without controller captures.

**What should change:** Expose scope and source at panel level, units and denominators on charts, and actual timestamps on stale readings. Use comparable axes; keep unknown utilisation visible and estimates approximate. Retain every existing visual in the eventual build.

**Mockup:** [Telemetry](../../mockups/2026-10/telemetry.html). Approval: pending.

**Proposed build ticket, after approval:** Correct the Telemetry mismatches recorded below and clarify every visual.

**Build acceptance / tests to write first:** Turn the findings below into acceptance tests before replacing any graph. Include empty, null, zero, stale and excluded-record examples; ensure sums agree with source records.

## Activity map

Catalogue: §2.1 plus the Activity map spec. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/pages/Overview.tsx; docs/superpowers/specs/2026-10-23-crew-activity-map-design.md; docs/prototype/crew-activity-map/`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** An extensive map specification and prototype already exist. The map is specified as an expandable full-width Overview panel with its own repo picker.

**What doesn’t / differs from the ticket:** No Activity map component is composed in Overview and there is no separate route in router.ts. The ticket says server slices #662–#667 are done; that completion is ticket-supplied context, not independently verified here.

**What should change:** Expose the map from Overview. The separate HTML is a static projection for review, not a replacement for the existing 3D spec. Retain file inspection, review markers, overlap/conflict distinctions and scope rules.

**Mockup:** [Activity map](../../mockups/2026-10/activity-map.html). Approval: pending.

**Proposed build ticket, after approval:** Integrate the already-filed Activity map UI slices.

**Build acceptance / tests to write first:** Coordinate with the existing UI tickets rather than duplicate them. Check selected repo, multiple sessions on one repo, no crew, stale snapshots, folder collapse, reduced motion and a textual file list. Preserve the spec’s distinction between diff and edit churn.

## Setup · Sessions

Catalogue: §2.7.1. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Sessions.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Add, edit and remove agents are already implemented, including one open form, validation and a change-application flow. Current text defines a session as one repo and its crew, unlike the original catalogue’s one-ticket description.

**What doesn’t / differs from the ticket:** The ticket’s CRUD outcome is already functional. This is a clutter and hierarchy redesign. Existing deferred application matters: a working agent keeps settings until its run ends and a removed agent finishes its run first.

**What should change:** Use a compact roster plus one selected editor and change preview. Keep account/model/role/area validation close to fields; separate session lifecycle controls from routine crew edits.

**Mockup:** [Setup · Sessions](../../mockups/2026-10/sessions.html). Approval: pending.

**Proposed build ticket, after approval:** Simplify Sessions roster and agent editor.

**Build acceptance / tests to write first:** Preserve add/edit/remove and delayed-apply tests. Verify overlapping writer areas, unavailable accounts, pending changes, failed saves, empty sessions and focus return after cancel/removal.

## Setup · Repos

Catalogue: §2.7 (Repos is a later code addition). Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Repos.tsx; setup/BoardSetup.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Already previews GitHub data before adding, explains priority source and polling cost, and exposes board setup. This tab is absent from the original six-tab catalogue.

**What doesn’t / differs from the ticket:** No removal control is rendered by Repos. Its add form centres on repo/project and board mapping; labels, explicit priority order, assignee and milestone selection are not the complete front-and-centre work-selection flow requested.

**What should change:** Retain source preview, column mapping and polling estimate. Add a clearly grouped work-selection step and matching/excluded ticket preview. Show removal dependencies before confirmation.

**Mockup:** [Setup · Repos](../../mockups/2026-10/repos.html). Approval: pending.

**Proposed build ticket, after approval:** Add Repos work selection and safe removal UI.

**Build acceptance / tests to write first:** Preview uses the same selection semantics as work collection; test labels, priority fallback/order, assignee and milestone separately and in combination. Check empty match, unknown values, active sessions and removal error. Backend persistence or removal support must be confirmed in that future ticket.

## Setup · Loops

Catalogue: §2.7.2. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Loops.tsx; setup/TemplateEditor.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Template selection, New/editor, a numbered path, step cards, checks, limits and observed loops already exist. Not just static prose.

**What doesn’t / differs from the ticket:** The path does not spatially express all branches and return edges. A generic new diagram must not misrepresent actual profile execution.

**What should change:** Draw small versus larger fix, verify and review pass/fail edges and bounded return-to-fix paths. A selected node reveals checks, role, limits and affected running work. Keep observed loops separate.

**Mockup:** [Setup · Loops](../../mockups/2026-10/loops.html). Approval: pending.

**Proposed build ticket, after approval:** Draw Loops branches and bounded re-loop paths.

**Build acceptance / tests to write first:** Graph must derive from selected profile rules, including off-path nodes, retries, no-progress stop and parking. Validate graph/text equivalence, keyboard inspection, long step names and missing profiles; do not change engine semantics.

## Setup · Accounts

Catalogue: §2.7.3. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Accounts.tsx; overview/QuotaMeter.tsx; hud/Meter.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Already shows account status, provider plan, thresholds, checks and two quota meters inside a wide table. Retains stale last readings on failed checks.

**What doesn’t / differs from the ticket:** The operator reports bars crossing columns. The shared Meter already clamps percentages to 0–100, so the likely review target is cell/track layout rather than missing numeric clamping. Source review alone cannot establish which widths reproduce it; the table/meter boundary is a specific visual check.

**What should change:** Use a bounded track per window inside its own column, with numeric percentage, reset and freshness beside it. Unknown is not zero; values above 100% retain their numeric text while track width clamps. Keep credentials outside the hub.

**Mockup:** [Setup · Accounts](../../mockups/2026-10/accounts.html). Approval: pending.

**Proposed build ticket, after approval:** Contain Accounts quota tracks and clarify freshness.

**Build acceptance / tests to write first:** At 0, 84, 100, 125 and unknown percent, bars stay in the cell at 1440, 1024 and 390px. Verify long account labels, both windows and failed checks. No sign-in or credential form.

## Setup · Roles

Catalogue: §2.7.4. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Roles.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** The role table gives call sign, position, purpose and mode using shared role definitions.

**What doesn’t / differs from the ticket:** The operator is right that this surface is descriptive: Roles renders no role editor. A UI concept cannot make a fixed role definition safely writable on its own.

**What should change:** Roster plus selected defaults editor with exact change preview. Label editable defaults separately from enforced capabilities. Preserve existing defaults and show affected new/existing agents explicitly.

**Mockup:** [Setup · Roles](../../mockups/2026-10/roles.html). Approval: pending.

**Proposed build ticket, after approval:** Design and build configurable role defaults.

**Build acceptance / tests to write first:** First establish supported fields and persistence in a separately scoped ticket. Test validation, failed saves, preview of affected agents and that role defaults cannot relax guards. This mockup does not authorise editing hard-rule role files.

## Setup · Guards and test lock

Catalogue: §2.7.4. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Roles.tsx; components/LockLines.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Guard hit counts and test-lock configuration/queue information already appear with Roles. Current lock wording differs from the older catalogue: full suites queue rather than simply being denied.

**What doesn’t / differs from the ticket:** There is no distinct Guards route/tab or policy editor. Hard stops enforced in code cannot be represented as casually switchable preferences.

**What should change:** Separate locked rules from proposed repo policy fields and show a change preview. Keep guard hits informational and preserve actual test-lock queue semantics. Splitting the current combined tab needs operator approval.

**Mockup:** [Setup · Guards and test lock](../../mockups/2026-10/guards.html). Approval: pending.

**Proposed build ticket, after approval:** Separate Guards inspection from supported policy configuration.

**Build acceptance / tests to write first:** Identify supported policy fields before implementation. Assert locked rules cannot be disabled; validate suite-command classification and max-at-once restrictions. Test no hits, failed hit reads, free/held/queued lock and unavailable history.

## Setup · Sources

Catalogue: §2.7.5. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Sources.tsx; setup/TeamsSources.tsx`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Already separates source/provider explanations and the glossary; Teams has its own setup component.

**What doesn’t / differs from the ticket:** A prose capability list does not alone tell the operator which reader failed or how old the data is. An unavailable future source must not appear connected in a sample-driven implementation.

**What should change:** Source health table with scope, state, last successful read and error/retry context; keep capability notes and glossary underneath.

**Mockup:** [Setup · Sources](../../mockups/2026-10/sources.html). Approval: pending.

**Proposed build ticket, after approval:** Clarify Sources health and scope.

**Build acceptance / tests to write first:** Reconcile each status with an existing reader/resource; missing timestamps say unavailable. Test stale success, failures, no configured source and provider-specific missing capabilities without adding new readers.

## Setup · Access and notifications

Catalogue: §2.7.6. Source paths relative to `apps/web/src/` unless fully qualified: `apps/web/src/setup/Access.tsx; browserNotifications.ts`.

**Screenshot of today:** pending controller capture; visual claims below are operator-reported until captured.

**What works:** Access and notification settings already have a dedicated tab. Catalogue includes preference categories, quiet hours, examples and device context.

**What doesn’t / differs from the ticket:** Device reachability and notification permission are different concerns. The operator needs a readable statement of what will alert them and what a notification means; current layout requires screenshot verification.

**What should change:** Preferences and quiet hours beside a concrete sample alert; devices remain an informational section. Preserve existing access controls and avoid introducing sign-in.

**Mockup:** [Setup · Access and notifications](../../mockups/2026-10/access.html). Approval: pending.

**Proposed build ticket, after approval:** Refine Access and notification preference layout.

**Build acceptance / tests to write first:** Check granted/denied/unsupported notifications, quiet hours, urgent exceptions and test-notification feedback. Assert no new auth, device discovery or credential flow.

## Telemetry · every visual accuracy findings

Completed source review, 25 October. **Verified** means the calculation and display agree within the stated source contract; **Mismatch** means a concrete wording, scope or rendering discrepancy; **Qualified** means the value is an estimate or has a documented coverage limitation. These are findings about the current code, not certification of live data. No production database, server or browser was used. Screenshot geometry and actual provider completeness remain controller checks; the calculation review is completed here rather than deferred to a build ticket.

Evidence paths below are relative to the repository root. All aggregate calculations are in `apps/server/src/telemetry.ts`; UI groups are in `apps/web/src/telemetry/`. Store queries are in `apps/server/src/store.ts`. Catalogue §§2.6.1–2.6.6 and prototype charts describe the intended vocabulary, but their simulated samples cannot validate these calculations.

| Visual | Result — current calculation and display | Evidence and required redesign response |
| --- | --- | --- |
| KPI strip | Qualified — Tokens/cache/tools/turns today use the run overlap fraction, not timestamped events; commits deduplicate repo+SHA. Working is current scoped running agents; Merged counts crew-wide PRs over seven days. Cost today uses attempt-aware `runSpend`, whereas range totals use wall-time proration. Response is today's median; Guard and live lock use independent resources. | `Kpis.tsx`, `telemetry.ts` today block, `apps/server/src/spend.ts`, `guardCopy.ts`. Keep API-equivalent wording and distinguish estimates from measured counts; these tiles cannot all reconcile with the selected-range totals. Lock wait comes from history, not the telemetry range. Guard detail says this week; it is not a usage filter. |
| Throughput | Mismatch — counts PRs, not unique tickets: every stored PR's `mergedAt` adds one to a local-day bucket, even if two PRs refer to one ticket. The subtitle says tickets. Fourteen local dates include real weekend merges; weekends are not forced to zero as in the illustrative catalogue. | `telemetry.ts` merged/perDay, `FlowOfWork.tsx` tThru; server test “throughput: 14 local days oldest first, PRs by mergedAt, zeros kept”. Choose ticket deduplication or an explicit PR label before building; retain zero days. |
| Cycle time | Verified — median of (Done−Ready)/24 hours per size, over stored issues done in the trailing fourteen days; missing Ready and reversed timestamps are excluded and counted. Zero-ticket rows do not set the bar scale and show —. This is a rolling duration window, unlike Throughput's local-date buckets. | `telemetry.ts` bySize, `store.ts` flowIssues, `FlowOfWork.tsx` median/longest; server tests “cycle time” and web test “a row with 0 tickets draws no bar”. Retain sample and exclusion counts and explain window boundaries. |
| Quality and review | Qualified — review rounds average each reviewed merged PR's maximum round; findings sum blocking+minor across reports per reviewed PR; sent-back counts PRs with any blocking report. CI divides passing by non-null first-push CI (pending counts as known, not green). Human wait is a median of cleared ready/review notes, a different population. Verify-first-try is explicitly not tracked. | `telemetry.ts` quality, `store.ts` flowPrs/noteWaits, `FlowOfWork.tsx` tQual; server tests “CI green on first push ignores PRs with unknown CI” and “quality: review rounds and first-pass rate per merged PR, commits per run”. Show separate denominators; do not describe these as fix rounds per ticket. |
| You as CAPCOM | Qualified — answered questions today supply count, median, nearest-rank p90 and longest answered wait; stopped runs use operator stop records. Agent wait sums per-agent unions of question intervals today, including unanswered questions, so it is not the sum of response durations. It is crew-wide regardless of usage filters. | `telemetry.ts` answers/capcom/agentWaitMs, `FlowOfWork.tsx` tCapcom; server test “reports every CAPCOM figure today, including pre-midnight questions and open wait time”. Label answered versus open waits and p90 rather than implying an average of the slowest tenth. |
| Tokens per minute | Qualified — Live sums digest minute-token buckets over 60 minutes; History is a wall-time estimate distributing each run's input+output uniformly into 72 buckets and dividing by bucket minutes. History can flatten bursts and is not a measured event-rate trace. Agent/account filter displayed series; Ticket does not. | `telemetry.ts` tokensPerMinute/liveMinutes, `AgentsGroup.tsx` TokensPerMinute; server tests “spreads a 10-minute 1000-token run evenly” and “live minutes”. Label estimated history and the current partial minute; catalogue's two-minute live sample is not the current contract. |
| Where agent time goes | Qualified — disjoint intervals partition elapsed local today into working/waiting/blocked/idle/unknown; carried running evidence expires at last activity plus the stall threshold. It is inferred state coverage, not stopwatch-level activity. UI preserves unknown width but omits unknown from the legend. Ticket does not scope it. | `telemetry.ts` utilisation boundaries/category, `AgentsGroup.tsx` UTIL; server tests “clips midnight and separates overlapping waits, stalled, parked and idle” and “expires recovered running evidence”; web test “preserves unknown time”. Add unknown legend and coverage wording; do not normalise it away. |
| Tokens per turn | Verified — renders input/output/cache-read for the latest run, finished or not, of the selected agent in view or first fallback agent. It does not obey range or Ticket and does not draw a reasoning segment. Latest-run subtitle is already correct, unlike the older catalogue's this-run wording. | `telemetry.ts` latestRuns/turnUsage, `AgentsGroup.tsx` TokensPerTurn/TURN_KINDS; server test “turn usage of each agent's latest run” and corresponding web test. Keep latest-run scope and do not invent unavailable categories. |
| Tool latency | Qualified — nearest-rank p50/p95 over measured digest durations, calls and failures summed separately; slowest measured call retains its owning agent. Includes matching runs started in range, not every run overlapping it. Calls may exceed timed duration samples for legacy digests. | `telemetry.ts` tools/percentile, `AgentsGroup.tsx` ToolLatency; server tests “tool latency: nearest-rank p50/p95” and “aggregates the maximum timed call”. Show timed sample coverage and run-start scope; missing timing stays —. |
| Subagents | Qualified — flattens digest subagents from scoped runs overlapping today, ordered by parent start/sequence; it does not filter by the spawn's own timestamp. Thus a parent spanning midnight can include a prior-day spawn under spawned today. These rows are detail, not additional parent usage to add to totals. | `telemetry.ts` subagents/inToday, `AgentsGroup.tsx` Subagents; server test “turn usage of each agent's latest run, and subagents of runs overlapping today”. Clarify parent-run scope or filter actual spawn timestamps when available. |
| Quota used | Mismatch — account/window identities and timestamp x positions are preserved, y clamps at 110 with a 100% limit. However, non-null readings are connected across resets and arbitrarily long missing intervals; no reset/gap marker exists. Tooltip uses nearest non-null reading independently for each series, which may be from a different time than the crosshair. | `CapacityGroup.tsx` quotaLines, `apps/web/src/hud/charts/LineChart.tsx` path/nearest; server test “quota points per account window in range” and web quota test verify series/axis, not gap honesty. Break missing/reset spans and display the actual reading timestamp. |
| Machine load | Qualified — CPU is busy tick delta divided by total tick delta across all cores, not summed process CPU; memory is used/total bytes. SQL averages each metric separately into at most 72 timestamp buckets, preserving null-only buckets. Collector CPU failure can carry a previous value with a new sample timestamp; vm_stat failure uses total−free fallback. Lines break explicit nulls, but tooltips can pick another series' older non-null value. | `apps/server/src/collectors/machine.ts` cpuPercent/sampleMachine, `store.ts` memPct/machineBuckets, `CapacityGroup.tsx` machineLines; server tests “machine points keep null” and bucket averaging. Label averages/fallback freshness. Lock bands clip to the plot but any historical open hold extends to now, even without confirming the live holder. |
| Test lock | Qualified — stored wait is start−queued; elapsed hold is end−start or now−start. Synthesised live rows correctly show — for unknown wait. Today includes every open hold plus holds started today, excluding a completed hold started yesterday even if it ended today. Unmatched historical open holds can remain shown as running. | `CapacityGroup.tsx` holds/today/result, `Kpis.tsx` lock history; web test “shows the live holder and queue without history, with a ticking elapsed time”. Explain start-day scope and reconcile open history against live state; selected range and usage filters do not apply. |
| Tokens by ticket | Qualified — resolved run ticket receives rounded input+output prorated by wall-time overlap in selected range, with Agent/Account/Ticket intersection. Runs without resolved tickets are omitted; title joins use repo+issue and missing titles retain identity. Consequently bars need not sum to totals including unassigned usage. | `telemetry.ts` byTicket/runTicket, `CostGroup.tsx` tickets/titles; server tests “tokens by ticket and totals over runs in range” and “counts a run without a ticket of its own toward its PR's ticket”; web twelve-ticket/title tests. Label estimated attribution and show unassigned coverage. |
| Tokens by loop step | Mismatch — ignores Agent/Account/Ticket: accumulation happens before `matches(r)` and includes crew only. Steps are plan/build/review, inferred from crew definition or reviewId, not actual feature/bugfix execution steps in the catalogue. Retries count as separate runs. These bars therefore cannot be compared directly with filtered totals. | `telemetry.ts` tokensByStep/stepRow, `CostGroup.tsx` tStepBars; server test “counts scoped commits and crew-wide loop steps pro rata, excluding observed and other loops”. Label crew-wide role attribution or implement actual scoped step attribution in the future build. |
| Totals | Qualified — groups matching overlapping runs by agent+model; input/output/cache/turns/tools and cost are wall-time prorated and rounded per row. Cache hit is cacheRead/(input+cacheRead+cacheCreate). Commit lines deduplicate repo+SHA and preserve unknown counts. Account is current configured attribution, not a historical account ledger; tiny rows rounding entirely to zero are dropped. | `telemetry.ts` totals/seenCommits/totalRows, `CostGroup.tsx` tTotals; server tests “tokens by ticket and totals”, “a run straddling the start”, “counts committed lines once across retries” and “drops a row whose figures all round to zero”. Keep ~cost and estimate wording; do not promise exact reconciliation with attempt-aware today cost or independently rounded ticket bars. |

### Reconciliation result and remaining visual checks

The existing deterministic Telemetry suites exercise source arithmetic and UI contracts listed above; they are rerun for this review. They do not establish live provider completeness, reset handling or pixel accuracy. Concrete defects are now recorded rather than left as questions: PR/ticket naming, estimated history presented under a blanket usage-events note, unknown legend omission, parent-run spawn-day scope, quota gap/reset interpolation, cross-series stale tooltip samples, historical open holds and crew-wide role-step attribution. No application fixes are authorised by this research-only ticket.

For controller captures, compare every row above with its rendered visual, including null-only machine buckets, quota resets/gaps, partial-minute rates, long labels, open historical holds and selected usage filters. In particular verify bounded axes, alignment and hover timestamps. These rendered observations remain pending under the no-browser instruction; source-level findings do not depend on them. The static Telemetry proposal illustrates scope labels rather than asserting its synthetic numbers reconcile to production.

## Site-wide and overlay review

- **Global chrome (§1):** works: consistent navigation, session scope and FLIGHT access. Improve: keep current scope and stale connection state visible; review long session names and crowded narrow headers. Do not add another navigation system or duplicate needs counts. Short state plus reason applies everywhere; 5–10 characters is the target, not an excuse to rename familiar Idle or Error ambiguously.
- **FLIGHT dock (§1.4):** keep the same waiting items and conversation across pages. Controller should compare shown/hidden and narrow drawer states, keyboard dismissal and available page width. Mockups show the collapsed state; expanded dock is a visual review gap.
- **Away mode (§2.8):** keep existing allowed/held actions and limits; make the active-until summary readable. No proposed redesign here grants additional autonomy. Capture the dialog and active banner together.
- **Item panel and Board brief (§§2.3, 2.9):** retain catch-up, evidence, source links, answer/discuss distinction and draft editing affordances. Capture long content, absent source, resolved item and keyboard close/focus return. The mockups show selected content inline for static review, not a new routing decision.
- **Keys and lamps (§2.10):** keep labels alongside colour; maintain keyboard help, visible focus, reduced motion and non-pulsing alternatives. Screenshot visual contrast and verify the eventual graphs have a table/text equivalent; SVG labels alone do not establish accessible interaction.
- **Loading/error/empty:** do not turn missing readings into zero, successful writes or healthy state. Long titles wrap or truncate with accessible full text; numeric columns use tabular figures. Controller should check scroll containment and that actions remain reachable at narrow widths and zoom.
- **Identity and safety:** use fictional data for review captures. Comms must label HUMAN/AGENT, owner/account where available and delivery state. No peer message grants approval, no mockup collects credentials, and no guard defaults are weakened by a design approval.

## Completion and handoff

1. Research and 15 static mockups are authored; artifact checks cover existence, audit links, embedded theme, review/sample labels and absence of scripts/remote resources.
2. Controller captures current screenshots and links them above; verifies mockup layouts, chart bounds and SVG readability without interpreting the samples as measured data.
3. Operator identifies approved Overview v2, reviews each mockup and records approval or requested revisions. All are pending now.
4. After approval, create one separately scoped build ticket per page/view above; reconcile Activity map work already filed. Roles/Guards and Repos may need backend support, which must be explicitly scoped before a web-only implementation proceeds.
5. Merge and operator review are external completion conditions. This worktree does not claim either has happened. No build tickets were opened and no product code was built.
