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

**What doesn’t / differs from the ticket:** The range toolbar does not alone explain fixed 14-day flow, today-only utilisation and latest-run turn data. Accuracy cannot be certified from component code or sample charts; each visual needs deterministic data reconciliation. See the complete visual checklist below.

**What should change:** Expose scope and source at panel level, units and denominators on charts, and actual timestamps on stale readings. Use comparable axes; keep unknown utilisation visible and estimates approximate. Retain every existing visual in the eventual build.

**Mockup:** [Telemetry](../../mockups/2026-10/telemetry.html). Approval: pending.

**Proposed build ticket, after approval:** Audit Telemetry calculations and clarify every visual.

**Build acceptance / tests to write first:** Use the checklist below as acceptance tests before replacing any graph. Include empty, null, zero, stale and excluded-record examples; ensure sums agree with source records.

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

## Telemetry · every visual accuracy checklist

This is a source-based inventory and validation plan, not certification of production data. Existing chart groups are real code, unlike the original prototype’s simulated series. All rows below need deterministic source records and screenshot comparison in the build ticket. Global range/agent/account/ticket controls must state any exceptions.

| Visual | Current meaning / scope | Accuracy check and presentation change |
| --- | --- | --- |
| KPI strip | Tokens, ~cost, tools/turns and commits today; working now; merged PRs over 7 days; lock wait and response today; guard hits this week; live test lock | Reconcile each displayed numerator and period with its own resource. Keep unsupported commits/waits distinct from zero; inspect the guard drawer link and live lock holder/queue. |
| Throughput | Tickets merged per day, last 14 days | Count unique merged tickets per local day; confirm boundary/timezone and no duplicate PR count. Use integer axis from zero. |
| Cycle time | Ready → Done median days by size | Recompute median from valid timestamp pairs; show sample count and excluded records. A size with no tickets has no bar, not a zero-day median. |
| Quality and review | Last 14 days | Confirm review rounds, findings, human wait, sent-back count and first-push CI denominators; keep unsupported verify-first-try as Not tracked. |
| You as CAPCOM | Today’s decisions, waits and stopped runs | Check answered count, median, p90, longest wait and summed agent wait against attention events; distinguish missing from no decisions. |
| Tokens per minute | Live minute buckets or history range by agent | Sum each bucket once, keep real timestamp spacing and test interval boundaries. If stacked, give baseline-aware per-agent values on inspection; do not interpret upper band height as absolute series value. |
| Where agent time goes | Share of today per agent | Working/waiting/idle/stalled/unknown durations must reconcile to the observation interval; retain unknown rather than silently normalising known samples to 100%. |
| Tokens per turn | Selected/fallback agent’s latest run | Confirm turn order and token categories; label latest-run scope even when global range differs. |
| Tool latency | p50 and p95 per tool | Confirm measured durations, percentile method and sample count. Do not average percentiles or draw unknown tools at zero. |
| Subagents | Spawned by crew today | Count unique spawns and attribution; do not add subagent tokens to parent-inclusive totals twice. |
| Quota used | Each account window across selected range | Keep window/account identity stable across filters, show reset discontinuities and 100% limit; no interpolation across missing/reset readings. |
| Machine load | Percent capacity across selected range | CPU denominator must match whole-machine capacity; memory units/denominator must match source. Match held-lock bands to start/end timestamps; an open hold ends at now only while live. |
| Test lock | Runs, waits and stops today | Verify queued/start/end ordering, unfinished durations and outcomes; current holder without stored queue time shows — for Waited. Do not imply the global range filters this table. |
| Tokens by ticket | Selected usage scope | Reconcile sums with unique run usage, handle unassigned tickets and retain the actual ticket identity/title. |
| Tokens by loop step | Selected usage scope, repeats included | Attribute retries once each to the correct step; Not tracked differs from an empty result. |
| Totals | Selected range and usage scope | Input/output/cache/turn/tool/line/cost columns must match server totals. Verify displayed ticket/step sums against the same scope, accounting for unassigned or untracked attribution. |

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
