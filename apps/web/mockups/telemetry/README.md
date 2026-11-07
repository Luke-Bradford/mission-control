# Telemetry proposal mockup

Open `index.html` directly in a desktop browser. No install or server is needed. Every number is fictional, shaped to the ranges in the data list below. Nothing here changes a live page.

Query: `?tab=crew|cost|throughput|quality|machine`, `&state=normal|loading|empty|error|stale|disconnected`, `&view=charts|table`, `&theme=dark|light`, `&flight=open` (FLIGHT's 380 px dock beside the page, as in the real shell), `&data=worst` (a stopped quota so the verdict reads Needs attention with its cause, a 300-character ticket title, and 50 tickets and many rows in the tables).

The shell follows the real one: page links on top, FLIGHT's 48 px rail on the right, key hints below. The layout reacts to the width of the work area, not the window, so opening the dock recomposes it.

Approval: waiting for the operator.

Checkpoint 3 of #1178. The operator approves this before any build ticket is filed. FLIGHT records the approval and files the tickets.

## Page question

Is the crew healthy right now? Overview says what is running. Telemetry says whether levels look normal, and why. The health band answers the first half at a glance; the five tabs answer the second.

## Audit of the current page

Source: `apps/web/src/pages/Telemetry.tsx`, `apps/web/src/telemetry/`, `telemetry()` in `apps/server/src/telemetry.ts`. Fit says whether the form answers the question. Windows differ across the page (now, today, Range, 14 days, latest run), and the Agent, Account and Ticket filters reach only some panels.

| Panel | Question | Data | Form | Fit | Proposal |
| --- | --- | --- | --- | --- | --- |
| KPI band | How is today? | today, capcom | 10 tiles: `Tokens`, `~Cost`, `Tool calls`, `Commits`, `Agents working`, `Merged`, `Lock wait`, `Your response`, `Guard`, `Test lock` | Partly: mixed windows, no comparison, one link | Replaced by the 8-tile health band; the rest move to tab summary rows |
| `tThru` | Merges per day? | throughput | bars | Yes | Throughput: Merged per day |
| `tCycle` | Cycle time by size? | cycleTime | bars | Yes; p85 is text only | Throughput: Cycle time by size, p50 to p85 range |
| `tQual` | Review quality? | quality | 6 stats | Partly: one permanent "not tracked" | Quality summary row; the not-tracked stat becomes a stated gap |
| `tCapcom` | Operator waits? | capcom | stats | Yes | Crew summary row |
| `tCrewState` | Seat states? | stateSpans | lanes | Yes | Crew: Crew state lanes |
| `tFlow` | Flow of work? | series.tickets | 2 lines | No: not cumulative flow; a level and a running total share one axis | Replaced by Throughput: Tickets in progress, step line |
| `tCycleControl` | Is cycle time stable? | series.tickets | 2 lines | No: running percentile, no control limits | Replaced by Throughput: Cycle time per ticket, dots with p50 and p85 lines |
| `tQualityTrend` | Quality trend? | series.quality | 3 plots | Form fits; the default 6h gives one point | Quality: CI green first push, First-pass review, Rounds per PR, on a fixed 14-day window |
| `tCostMerged` | Cost per ticket? | totalCostUsd | line | No: joins unrelated tickets as a trend | Merged into Cost and tokens: Cost by ticket, ranked bars (and a Cost by ticket table with the full titles) |
| `tForecast` | Forecast? | series.throughput | line | No: no forecast exists; repeats `tThru` | Dropped; Merged per day replaces it |
| `tTok` | Token rate by seat? | tokensPerMinute | stacked area | Weak: history spreads a run's total evenly over its wall time; 11 stacks | Cost and tokens: Tokens per minute, total, top 3 seats and Other |
| `tUtil` | Seat time? | utilisation | 100% bars | Yes | Crew: Where agent time goes |
| `tTurn` | Tokens per turn? | turnUsage | stacked bars | Wrong page: one run of one seat | Proposal for the operator: move to the seat's Agent page |
| `tLat` | Exact tool latency? | toolLatency | table | Yes | Crew, Table view |
| `tSubs` | Subagents? | subagents | table | Yes | Crew, Table view |
| `tQuota` | How close to limits? | series.quota | lines | No: axis runs to the reset, squeezing history into a sliver | Cost and tokens: Quota used, a meter per window with history ending now |
| `tMach` | Machine load? | machine | 2 lines | Yes; swap, disk, pressure unplotted | Machine: CPU and memory with lock bands; Memory pressure and swap |
| `tLock` | Lock runs? | lock history | table | Yes | Machine, Table view |
| `tTicketBars` | Tokens by ticket? | tokensByTicket | bars | Yes | Cost and tokens: Cost by ticket |
| `tStepBars` | Tokens by loop step? | tokensByStep | bars | Yes | Cost and tokens: Spend per hour, by step |
| `tTotals` | Exact usage rows? | totals | table | Yes | Cost and tokens, Table view (Totals) |

No pie charts are proposed. Charts share one cursor, mark events with dashed lines, and show gaps as line breaks, never zero.

## Data list

From a one-off inventory of a backup copy of the hub's database (rows, span, grain). The mockup's values are fictional and stay inside these ranges.

- `runs`: 4456, 13 Jul to 4 Nov, per run. Cost on 2433, tokens on 2979; 7 models, 11 seats; ok 3260, failed 927, blocked 259.
- `reviews`: 1049, 21 Oct to 1 Nov, per round, up to round 4. Findings 2277 (Critical 59, Important 1244, Minor 974; 9 categories).
- `ci_runs`: 11274, 29 Oct to 4 Nov, per check; 17 names, attempts up to 20.
- `machine_samples`: 10228, 28 Oct to 4 Nov, about 60 s; CPU 4.5 to 100%, memory 53 to 100%.
- `usage_samples`: 4937, 17 Oct to 4 Nov; 5h 493, 7d 4444.
- `prompt_sections`: 1958, from 31 Oct. `flow_prs`: 734; `flow_issues`: 731 (674 done, 4 sizes), from 21 to 22 Oct.
- `guard_hits`: 558, 9 rules. `escaped_defects`: 54. `test_lock_runs`: 2132. Test-attempt tables: empty.

Gaps that follow from the list: cost is on 2433 of 4456 runs and tokens on 2979, so cost and token panels state their coverage; reviews stop at 1 Nov; CI starts 29 Oct; test attempts are not collected.

## Stat definitions

Every stat has a label, value, unit, window and definition. The definition shows on hover or keyboard focus. Every number is a button with `data-drill`: `exists` opens a page that exists today and the mockup names it in a notice; `needs-build` names a target that does not exist yet and opens the "Runs behind this number" dialog.

### Health band

| Label | Definition | Window | Unit |
| --- | --- | --- | --- |
| Crew health | Verdict, reason, seats running of configured | now | word, count |
| Your response | Median time to answer a seat's question | today | duration |
| ~Cost | API-equivalent estimate, against the 7-day daily median | today | USD |
| Merged | PRs merged, against the 14-day daily mean | today | count |
| CI first push | Merged PRs green on first push | 14d | % |
| First-pass review | Reviewed PRs with no round 1 blocking finding | 14d | % |
| Tightest quota | Highest used share of any window, with reset | now | % |
| Machine | Memory pressure free and CPU, with capacity warning | now | % |

Verdict, a proposal the operator can change: Needs attention for a quota at its stop level, a machine warning, or a stalled or errored seat. Watch for a quota at its alert level or a waiting seat question. Otherwise Healthy.

### Measures per tab

| Measure | Tab | Window | Unit |
| --- | --- | --- | --- |
| Seats running | Crew | now | seats |
| Seats waiting on you | Crew | now | questions |
| Median response | Crew | today | minutes |
| Slowest 10% response | Crew | today | minutes |
| Runs stopped | Crew | today | runs |
| Crew state | Crew | 24h | lanes |
| Agent time by state | Crew | today | % of day |
| Tool latency | Crew table | today | ms, s |
| Subagents | Crew table | today | rows |
| Tool calls | Crew | today | calls |
| ~Cost | Cost and tokens | today | USD |
| Tokens | Cost and tokens | today | tokens in plus out |
| Cache hit | Cost and tokens | today | % of input |
| Spend by step | Cost and tokens | 24h | USD per hour |
| Cost by ticket | Cost and tokens | 24h | USD |
| Tokens per minute | Cost and tokens | 24h | thousands |
| Quota used | Cost and tokens | now, 24h history | % |
| Cost coverage | Cost and tokens | 24h | % of runs |
| Tokens coverage | Cost and tokens | 24h | % of runs |
| PRs merged | Throughput | today, 14d | PRs |
| Cycle time | Throughput | 14d | hours |
| Tickets in progress | Throughput | now, 14d | tickets |
| Commits per run | Throughput | 14d | commits |
| CI first push | Quality | 14d | % |
| First-pass review | Quality | 14d | % |
| Review rounds per PR | Quality | 14d | rounds |
| RETRO findings per PR | Quality | 14d | findings |
| Human review wait | Quality | 14d | minutes, median |
| PRs sent back | Quality | 14d | PRs |
| Guard blocks | Quality | 14d | blocks |
| Escaped defects | Quality table | all | rows |
| Test attempts | Quality | none | Not collected yet |
| CPU | Machine | now, 24h | % |
| Memory free | Machine | now, 24h | % |
| Memory pressure | Machine | 24h | % |
| Swap used | Machine | now, 24h | % |
| Agent and test-run memory | Machine | 24h | GB |
| Test lock | Machine | now | seat or Free |
| Lock wait | Machine | today | minutes |

Findings link to Audit's review tab. Existing routes a number can open: `agentPath`, `tracePath`, `ticketPath`, `boardPath` with a stage, QA with repo and PR, `NEEDS_YOU_PATH`, `GUARD_DRAWER_HREF`. No crew-wide filtered runs list exists: the agent runs route in `apps/server/src/api.ts` serves one seat. The dialog shows what such a list would hold and is marked as needing a new route.

## Build tickets

Filed by FLIGHT after approval. Each builds one tab and its table view on the existing page shell, fetches when opened, and ships with its states.

### Crew

Crew state lanes, Where agent time goes, the Crew summary row (with `tCapcom`), and the Tool latency and Subagents tables. Agent filter. `tTurn` moves to the seat's Agent page if approved.

### Cost and tokens

Spend per hour by step, Cost by ticket, Tokens per minute, Quota used, and the Totals and Cost by ticket tables. Agent, Account and Ticket filters. Coverage text states what is missing.

### Throughput

Merged per day, Cycle time per ticket, Cycle time by size, Tickets in progress and the Tickets table. Fixed 14-day window. Needs a per-day series for tickets in progress.

### Quality

CI green first push, First-pass review, Rounds per PR, Guard blocks by rule and the Escaped defects table. Fixed 14-day window. Review plots stop where reviews stop; test attempts stay a stated gap until collected.

### Machine

CPU and memory with lock bands, Memory pressure and swap, Agent and test-run memory, and the Test lock table. Needs swap and per-run memory series.

Shared by all five: the health band, its verdict rule, the tab query string, the Charts and Table control, and the runs dialog route.

## Evidence

`screenshots/manifest.md` records what was captured and what was not. The seat that built this mockup could not start a browser (the sandbox refuses Chrome's profile and socket directories), so no image was captured and the layout was not seen rendered by the author. `apps/web/test/TelemetryMockup.browser.test.ts` renders every tab at 1280x900, 1600x1000 and 1920x940 in both themes and runs in CI. The captures listed in the manifest are still to be taken by a seat with a browser.
