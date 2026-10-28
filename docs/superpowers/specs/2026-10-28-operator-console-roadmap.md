# Operator console roadmap

**Date:** 2026-10-28. **Status:** the operator's direction, restated 28 Oct; tickets below carry the work. The FLIGHT page layout (#766) is checked against screenshots before it merges.

This ties the operator's standing requirements (restated 28 Oct, see "The bar") to `docs/direction.md` and to four reviews run the same day against the restyled HUD (#751): a visual/charts review, an operator-workflow review, a speed/accessibility review, and a data map for the Audit and QA boards. Their reports are kept in `docs/reviews/2026-10-28/` and the figures below come from them. This doc decides what to build and in what order; each item is a ticket that states its outcome.

Some references live on #751 (HUD restyle) until it merges: `docs/design/flight-deck.md` and the central-mind spec `docs/superpowers/specs/2026-10-27-flight-central-mind-design.md`.

## The bar

The operator's words, condensed:

- Looks like a production developer tool — something kept open beside Linear, Vercel, Grafana or GitHub. Fast and easy to read. Graphs have real detail and interact well. Desktop browser only.
- The operator runs fast with many agents working through a board. **FLIGHT** watches them, helps where it can, uses every skill and agent available to answer seats or the operator, and escalates only what it cannot answer well itself.
- **Needs you is rare.** When something does need the operator, opening it gives a clear brief: what exactly is needed, the options, and a way to discuss it.
- The operator steps through tabs to see what's in progress, what FLIGHT is doing and how it runs the board, what it knows, board and agent progress, and the conversations. **Nothing should pull the operator back into the Board.**
- **Seats run free.** Their limits come from the repo's `CLAUDE.md`/`AGENTS.md` and from FLIGHT's instructions, saved per agent. The safety floor stays in hub code (#698).
- New: an **Audit board** (what to improve: PR sizes, prompt changes, model changes, things to check) and a **QA board** fed by the QA agents (what reviews check, test health, success rates, milestones, project success).

## What the reviews found

1. **The numbers disagree.** Needs you read 13, 5 and 1 on three surfaces; cycle time "—", "14h 52m" and "0.1 d"; merged 0, 1 and 415 under different unlabelled windows; "8 agents live" while every seat was paused. When every number needs reconciling, the operator checks every page — the opposite of the bar.
2. **Needs you is mostly noise** (operator-workflow review). Of 13 live items, about 2 needed the operator. The rest were FLIGHT's to settle, unread messages (including FLIGHT's own "nothing needs you"), seat questions counted twice, a stale 12-day draft, and every hard-rule flag — because a regex never matched real run ids (#754, fix in PR #755; 602 flags raised so far).
3. **FLIGHT's work is invisible.** 638 recorded decisions, none shown; 130 "for the controller" requests for powers FLIGHT lacks, unseen. The page doesn't say FLIGHT is held or the crew paused.
4. **FLIGHT can't consult.** `Task`, web tools and repo skills are denied to every seat; there's no per-agent instruction store, so FLIGHT re-messages seats each run.
5. **Visual:** the KPI row still reads as BI tiles; agent colours repeat and collide with status amber; panels clip content at 1366–1600; 13 font sizes; bare "—" empty states; the FLIGHT dock duplicates the FLIGHT page.
6. **Charts:** the timeline shows parked agents as busy; quota draws a data gap as a drop to zero; cycle time rounds everything to 0.1 d; tokens-per-turn is 99.99% cache read so nothing else shows; no shared time range, thresholds or annotations.
7. **Data for the new boards:** Audit is mostly answerable today (runs, run attempts, reviews, guard hits, questions, cost per ticket/model/step). QA needs small server captures first (suite pass/fail is received and discarded; PR size isn't fetched; findings have no category or resolution and are pruned at 30 days; milestones aren't read) and then structured output from RETRO and a QA seat.

## Decisions

- **One Needs-you set, one home.** Needs you is the operator's whole inbox (the session filter never hides it), de-duplicated by key, counted the same everywhere, and its home is FLIGHT › Needs you.
- **Only FLIGHT asks the operator.** Seats ask FLIGHT. An operator item exists only with a valid brief; when FLIGHT is down or late, one item says so instead of N raw questions.
- **A brief is enforced by the hub**, not the prompt: the question; why it needs the operator (money, product direction, security exception, irreversible — direction.md principle 2 — or an approval the safety floor requires, such as hard-rule clearance on a repo that reserves it; this PR adds that fifth reason to direction.md); context and who FLIGHT consulted; 2–4 options each with consequence and reversibility; a recommendation; a default and deadline, or a hold condition; cost of delay; freshness.
- **Defer means hold; defaults act.** "Nothing now" becomes a hold with a condition that resurfaces with a refreshed brief. Reversible choices inside FLIGHT's standing authority — what direction.md, the operator's standing orders and per-seat instructions already let it do — become an FYI countdown FLIGHT executes. Executing a default at its deadline is #741; until it lands, the default and deadline fields are shown but nothing acts on them.
- **One metric registry.** Every figure has one definition, a stated window and unit, and the same value wherever it appears. The registry (#762) owns definitions such as cycle time's p50/p85 in hours; charts (#768) only draw them.
- **Per-agent standing instructions** are first-class: operator- or FLIGHT-authored, injected into the seat prompt after `CLAUDE.md`/`AGENTS.md`, visible and revocable.
- **The FLIGHT page answers the operator's questions, not FLIGHT's stores:** a status strip, then *Needs you*, *What FLIGHT did*, *Crew & board*, *What FLIGHT knows*. **This supersedes** the central-mind spec's Command/Plan/Notebook/Record tabs and its source-of-truth table; #766 updates that spec in the same PR. Where its content goes:
  - Command's briefing and flow rail (WIP, blocked, oldest, throughput) → the status strip and *Crew & board*; Review/CI and cycle time → Telemetry via the registry.
  - Command's delivery board and Plan's horizon table → *Crew & board* (one row per seat, then FLIGHT's queue).
  - Plan's operator actions and drafts → *Needs you*; arrivals and revisit triggers → *What FLIGHT did* and *Crew & board* respectively.
  - Notebook → *What FLIGHT knows*; Record's outcomes, decisions and system log → *What FLIGHT did*.
- Desktop only; flat tab selection; no corner ornaments (docs/design/flight-deck.md).

## Plan

Ordered so each phase makes the next one trustworthy; the tickets table lists each item's hard dependencies.

### Phase 1 — trust the inbox and the numbers
1. Hard-rule flags reach their configured owner (#754 — PR #755).
2. One Needs-you set, one home; header opens FLIGHT › Needs you; Board lamp and "You:" chips only from canonical items. The Board's own Needs-me filter selects cards that carry a canonical item and still respects the Board's session view — it narrows the Board, not the inbox.
3. Messages are not needs; no double-counted seat questions; FLIGHT's own summaries never count.
4. Seats ask FLIGHT; only FLIGHT's briefs create operator items; a single "FLIGHT is not triaging" item (with #705, #706).
5. The hub enforces the brief (fields above) and shows it whole; Accept recommendation is one click (with #741).
6. Defer means hold, with conditions that resurface the item and refresh its brief.
7. Notifications only for briefed asks and "FLIGHT is down".
8. One metric registry across Overview, FLIGHT, Telemetry and Comms.

### Phase 2 — FLIGHT's powers
9. Per-seat standing instructions (store, prompt injection, `instruct_seat`/`revoke_instruction`, UI on Agent and FLIGHT).
10. FLIGHT consults skills and other agents, shown as "consulted" chips on answers and briefs. The first step is a spike: do CLI subagents inherit the seat's deny-list and sandbox? If yes, FLIGHT gets `Task` and invocable skills (size M); if no, a hub-run `consult` tool that starts a short read-only seat — #764 is re-sized before that branch is built.
11. Missing powers made visible and ticketed; starting with marking a draft PR ready for review.

### Phase 3 — the FLIGHT page
12. Status strip plus the four question-named tabs; the dock collapses and is hidden on /flight.

### Phase 4 — look and charts
13. Visual system v2: a borderless stat bar instead of tiles; an 8-slot agent palette distinct from status colours; two type families and six sizes; one empty-state and skeleton component; themed native controls; no clipped panels at 1366–1920.
14. Instrument charts v2: crew state timeline (truthful idle/parked), quota bullets with stop/alert lines, reset annotations and burn projection, cycle-time control chart (p50/p85, hours), cumulative flow, quality small multiples, cost per merged ticket; one shared time range and an event-annotation layer (crew paused, hub Update, quota resets); a missing value breaks a line, never draws zero.
15. Speed: findings from the speed/accessibility review (bundle splitting for the 3D map, duplicate fetches, re-render cost on live events, small text).

### Phase 5 — Audit board
16. Server captures: PR size, run account/effort/prompt hash, kept PR history and retrospectives, longer guard/chatter windows, an `/api/audit` aggregation.
17. Audit page: improvements to consider (long runners, death loops, rework, refusals, cost per merged ticket), PR sizes, prompt and model changes with their effect, things to check; SURGEON's reports feed it (#718; #717's Telemetry audit view folds in).

### Phase 6 — QA board
18. Server captures: full-suite pass/fail from the hook event already received, `ci_runs` from polled checks, milestones with due dates, finding category and resolution with longer retention.
19. RETRO reports structured output: checks run, tests run with counts, finding categories, resolutions of earlier findings (related: #91, RETRO on every PR).
20. A QA seat's periodic test-health sweep (`report_qa`): slow and flaky tests, stale tests, coverage when available.
21. QA page: what the reviewer is checking now, review success rates, test health and flakes, tests needing updates, milestones and project success.

## Tickets

Each ticket states its outcome, done-when, size and security note.

| # | Item | Ticket | Depends on |
|---|---|---|---|
| 1 | Hard-rule flags reach their configured owner | #754 | — |
| 2 | One Needs-you inbox, one home | #756 | #751 |
| 3 | Messages are not Needs you | #757 | — |
| 4 | Seats ask FLIGHT; stalled FLIGHT is one item | #758 | — |
| 5 | Hub-enforced brief, one-click Accept | #759 | #741 for defaults to act |
| 6 | Defer means hold | #760 | #759 |
| 7 | Notifications only for briefed asks and FLIGHT down | #761 | #759 |
| 8 | Metric registry | #762 | — |
| 9 | Per-seat standing instructions | #763 | — |
| 10 | FLIGHT consults skills and agents | #764 | — |
| 11 | Missing powers visible; ready-for-review | #765 | — |
| 12 | FLIGHT page v2 | #766 | #756, #759, #763, #765, #762 |
| 13 | Visual system v2 | #767 | #751 |
| 14 | Instrument charts v2 | #768 | #762 |
| 15 | Speed and accessibility fixes | after the speed review | — |
| 16 | Audit data on the server | #769 | — |
| 17 | Audit board | #770 | #769, #768 |
| 18 | QA data on the server | #771 | — |
| 19 | RETRO structured output | #772 | #771 |
| 20 | QA seat test-health sweep | #773 | #771 |
| 21 | QA board | #774 | #771, #772, #773, #768 |

Related, already open: #741 (defaults apply at the deadline), #705 (seat inbox), #706 (escalation), #718 (SURGEON), #717 (Telemetry audit view, folds into #770), #91 (RETRO on every PR), #752 (Codex seats ignore a repo's committed `.codex` config — a seat-freedom safety item found while finishing #698).
