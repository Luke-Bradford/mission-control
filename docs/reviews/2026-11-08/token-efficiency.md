# Token efficiency: smaller context, with evidence before rollout

Research for #1618. The baseline is 8 November 2026; the controller checked the current code,
configuration, API and official Anthropic guidance on 9 November. This extends the
[6 November audit](../2026-11-06/token-audit.md), rather than repeating its investigation.

## The short answer

Developer fix sessions and FLIGHT's starting context offer the largest estimated savings.
Shorter shell output is the clearest bounded change. Review checks should address repeated
findings without weakening independent review. The estimates overlap; do not add them together.

Two fixes already have owners: #1616 removes handled wake signals and #1503 shortens check
output. The current #1616 implementation cut the first wake's JSON bytes by 49.8% on one copied
live database. That is a measured payload saving, not a measured reduction in billed tokens.
Its full tests, independent review, merge and post-deployment measurement remain outstanding.

The audit does not yet provide a true past-hour breakdown by source. Today it selects whole
runs by their start time. A window label alone cannot repair that missing event-time evidence.
The six follow-ups below remain Backlog work, subject to plans, ordinary budgets and approvals.

## Where the tokens went (8 Nov)

The baseline supplied with #1618 came from FLIGHT's 12:45 reading on 8 November. It covers
90 runs and 2,753 calls for the day: 337M source-attributed re-reads. The week covers 844 runs
and 2,786M re-reads. The earlier 12:30 reading used 91 runs and 338M; those are separate
snapshots and are not averaged here.

Here, **re-reads** means the audit's attribution estimate: tokens added by a source, weighted
by the later calls that carry them. Provider cache reads, cache writes and output are separate
counts. A re-read estimate is not an invoice or a subscription allowance measurement.

| Cost source | Week ending 8 Nov | Day ending 8 Nov |
|---|---:|---:|
| GUIDO and INCO | 1,201M (43%) | Role split not retained in the supplied plan |
| FLIGHT | 1,159M (42%) | 180.5M (54%), 33 runs |
| Bash results, across roles | 833M (29.9%) | 76.8M (22.8%), 1,533 events |
| RETRO | 384M (14%), 229 runs | Day role total not retained |
| Start-of-run text, across roles | Day/week role totals overlap this row | 185.7M (55%), 6.3M added |
| Unattributed sources | 8.3–8.8% | Exact numerator not retained |

The first two rows rank by their measured weekly totals. Role rows overlap source rows.
The original plan put FLIGHT first; developer runs have the slightly larger total.

**Current cross-check, 9 November at 08:40 UTC.** The API returned the following counts.
Budget stops and different run counts make these unsuitable as proof of an improvement.

| Window selector | Audited runs | Calls | Attributed re-reads | FLIGHT | Developers | RETRO |
|---|---:|---:|---:|---:|---:|---:|
| `days=1` | 38 | 1,189 | 153.51M | 104.61M | 23.89M | 17.02M |
| `days=7` | 890 | 20,735 | 3,052.81M | 1,272.39M | 1,327.94M | 401.98M |

The day has 94.63M attributed to start-of-run text (61.6%) and 22.04M to Bash (14.4%).
The week has 1,321.71M at start (43.3%) and 919.00M from Bash (30.1%). Global
`readAfterReportShare` is 0.475 for the day and 0.663 for the week. That ratio is not a
developer-only measurement; the fresh-session trial must measure its own developer cohort.

A second HTTP read at 08:49:50 UTC confirmed identical role/source totals. Its day response
is 11,910 bytes; the week response is 27,826 bytes. These are actual response-body sizes. The summaries in
`token-efficiency-evidence/` retain the figures without private transcripts. Controller auditing
is off (`controller: null`); neither table measures this controller session's use.

## Ranked cost sources and fixes

### 1. Developers keep their build session through fixes

The 8 November GUIDO/INCO total is 1,201M weekly re-reads. Runs average 12.4M for GUIDO
and 18.5M for INCO. The global share of cache reads after the first report is 0.65 for the
week and 0.51 for the day; use this as a planning proxy, not a proved developer-only fraction.

Trial ten comparable tickets per arm: normal continuation versus a fresh fix session using the
hub's handoff. Keep the existing branch, ownership, worktree and head-bound check evidence.
A resumed or forked copy of the old history is not a smaller fresh session.

Starting at 30k rather than 150k estimates an 80% reduction in fix-phase context. The upper
bound is `0.65 × 1,201M × 0.8 = 624.5M` weekly. Plan on 300M until the trial measures it.
Compare rework rounds and CI failures as well as tokens. Ticket **T4** owns the trial.

### 2. FLIGHT's first prompt and growing context

FLIGHT accounts for 1,159M weekly re-reads. The existing handover guard requires context
above 150k and growth of 50k from the start. A 157k start therefore reaches about 207k,
consistent with the supplied 210k median peak. It does not hand over immediately at 150k.

Measure the first prompt's sections. First land #1616's handled-signal reduction. Then aim for
a start under 100k. Move situational procedures out of the 20,516-character FLIGHT role into
on-demand flight-ops references. Append unchanged direction/orders once per session, then
again when their revision changes. Preserve every rule and mid-run instruction update.

With the same 50k growth band, a 100k start suggests 125k mean context instead of 182k:
`1 - 125/182 = 31.3%`, or about 360M weekly and 56M daily. These estimates include
#1616 and the fixed-text changes; they are not separate savings to sum. Moving 2.5k tokens
out of each prompt alone estimates `2.5k × 1,000 calls = 2.5M` daily. Ticket **T1** owns
the measured first-prompt work; #1616 retains its own scope and post-merge measurement.

### 3. Shell output keeps returning as context

Bash is 833M weekly and 76.8M daily re-reads in the original baseline.

| Daily command class | Share of Bash | Attributed re-reads |
|---|---:|---:|
| sed | 34.7% | 26.6M |
| grep | 22.4% | 17.2M |
| python3 | 10.5% | 8.1M |
| pnpm lint | 8.6% | 6.6M, 62 runs |
| cat | 7.4% | 5.7M |
| test:related and vitest | 5.3% | 4.1M |

#1503 owns concise passing checks, with full failures and exit status preserved. Its intended
saving is almost all 6.6M lint re-reads plus half the 4.1M test re-reads: about 8.5M daily.
The code is in PR #1520 and still waits on the cleanup in PR #1615. Neither is counted as
shipped or as a measured token saving here.

Ticket **T3** measures output p90, identifies the large python3 results, and trials a general
shell-result cap with full retained evidence. Use precise searches and bounded file ranges.
The sed/grep/cat total is 49.5M daily; an estimated 20% reduction is 9.9M daily. Confirm the
installed CLI's output setting before rollout and keep the Codex path separately evidenced.

### 4. Repeated review findings

RETRO has 384M weekly re-reads over 229 runs: 1.68M per review. There were 154 merges,
so the baseline is **1.49 reviews per merge**, not three reviews per PR. The windows and
populations differ; this is an improvement indicator, not proof every extra run was avoidable.

Classify actual second-and-later findings. Add checks for repeatable failures that a check can
catch; keep judgement in independent review. The upper bound from 75 extra reviews is
`75 × 1.68M = 126M` weekly. Half, about 63M, is a planning estimate. Ticket **T5** owns
the evidence and selected checks. It does not remove the most-capable final review requirement.

### 5. Fixed prompt text and read inbox history

The supplied baseline measures CLAUDE.md's hub-only YAML at 2,225 characters, about 560
tokens. The runtime can omit that configuration block while preserving operating instructions;
the actual file and the hub's configuration parser stay intact. At 2,753 daily calls the upper
estimate is `560 × 2,753 = 1.54M` daily re-reads. This is part of the starting-context totals.

The planner also received 50 inbox messages, 49 already read, about 3.8k tokens to find one
new message. Default to unread messages plus pins, with explicit history available. Removing
about 3.7k tokens saves `3.7k × remaining calls after each read`, not a fixed daily amount.
Ticket **T6** owns these changes. RETRO's 11,208-character role and plain-talk's 8,895-character
skill are further measurement candidates; their full sizes are not claimed as removable waste.

### 6. Missing windows, attribution and controller visibility

The original unattributed share is 8.3–8.8%; ToolSearch is 1.5% of daily re-reads over 175
events. Neither category has a proved removable saving. The current week response is too
large for the proposed 20k-character agent summary. Reducing it would save the removed
tokens multiplied by later calls, but no daily total is estimated without call frequency.

The standing past-day view is Audit › Tokens, built by #1505. #1567 already owns missing
figures and references. Ticket **T7** follows it: real event-time hour/day windows, named
historical coverage, and an optional compact response with top 15 rows plus a correct other
total. Preserve the existing detailed response for web callers. Do not fake an hourly view by
selecting runs started in the hour or dividing a whole run's totals.

Controller collection exists through #1504 but is off in the current configuration. Enabling it
is not part of this research or a claimed saving. Report that coverage gap alongside crew use.

## Model choice

Direction principle 4 picks the vendor and model by task: Codex to build, a stronger model
to review, and Claude for hard calls, while preserving account stops. Current configuration
uses Sonnet/medium for Claude developers, Opus/high for the planner and Claude reviewer,
and Opus/medium for FLIGHT. Codex developer seats and a separate Codex reviewer are also
configured. Neither review seat currently sets `light_model`.

Keep FLIGHT's model unchanged during these context trials. Keep the required independent
most-capable final review for features, fixes and larger work. Small-review model selection can
be evaluated after budgets permit, with rework and total cost measured. This document does
not change models, provider allocation, stops or effort. Fewer context tokens and lower price
per token are different effects; do not count a model change as fewer re-read tokens.

## What the Anthropic guidance says

These primary sources were read on 9 November. They describe supported product behavior,
not proof that a particular setting is active in this hub.

- [API prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  reuses an unchanged prefix and offers five-minute and one-hour lifetimes with different write
  prices. The original plan's blanket cache-price ratio should not be used for every model.
- [Claude Code caching](https://code.claude.com/docs/en/prompt-caching) distinguishes main
  conversations from helper requests. A subscription main conversation can use an hour;
  other requests commonly use five minutes. Actual defaults depend on billing and version.
  Append revised guidance rather than rewriting an established prefix. Resume retains history.
- [Skills](https://code.claude.com/docs/en/skills) load their bodies when used. Move situational
  procedures into referenced files, keeping essential rules in the always-present guidance.
- [Cost and context management](https://code.claude.com/docs/en/costs) documents both
  auto-compaction and `/compact`. The original plan's claim that CLI seats cannot compact
  without an Agent SDK is incorrect. A hub integration still needs to verify command delivery,
  preserved instructions, recovery and useful token savings before relying on that path.
- [Subagents](https://code.claude.com/docs/en/sub-agents) have separate context and still
  consume the account's allowance. Delegation can reduce parent context but is not free.
  No subagents were started for this research; current session rules and budget stops apply.
- [CLI operation](https://code.claude.com/docs/en/cli-reference) supports non-interactive runs,
  continue and resume. [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
  persist conversation history; a fork copies it. T4 needs a fresh bounded handoff, not a
  new session identifier attached to the full old history.
- [Environment variables](https://code.claude.com/docs/en/env-vars) documents
  `BASH_MAX_OUTPUT_LENGTH`, overridden by `bashOutputMaxChars` when set. Trial a cap and
  verify the full-output retrieval behavior before adopting it. Do not confuse this with a
  model response-token limit or change a global setting during this research.

The latest recorded Claude runs use CLI 2.1.318. That is version evidence, not an invocation
to test a held account. No Claude CLI calls, crew starts or setting changes were made for this research.

## Tickets

The mapping below gives the filed issue numbers. Post-merge measurement for #1616 and
#1503 is folded into the unstarted Audit parent #1431, without changing their started bodies. T1 and T3–T7 have separate measured outcomes and sizes. Each
body retains the 8 November baseline and ends its acceptance checks with a re-measure step.

| Plan key | Owner | Size | Expected result |
|---|---|---|---|
| T1 | #1641 | M | First FLIGHT prompt below 100k; re-reads/run at most 4M |
| Existing digest | #1616 | S | Handled signals counted, new work retained; measure actual post-merge start size |
| Existing check output | #1503, PR #1520 | S | Passing checks concise; daily lint re-reads below 0.5M |
| T3 | #1642 | S | Bounded retained shell results; weekly Bash share at most 22% |
| T4 | #1643 | L trial | Twenty completed tickets; post-report share at most 0.35, no more rework |
| T5 | #1644 | S | Repeated findings checked; reviews/merge at most 1.25 |
| T6 | #1645 | S | At least 500 fewer start tokens per non-FLIGHT run, rules retained |
| T7 | #1646 | M | True hour/day coverage and summaries below 20k characters; follows #1567 |

T7 is M rather than the original S estimate: correct event-window attribution needs data that
the current per-call table does not store. All six follow-ups remain Backlog until appropriately
planned and eligible. #1431 remains the Audit improvement-loop parent; #1632 keeps its
separate scope of bounded `flight_state` and attention reads.

## How this was measured

1. Preserve the supplied 8 November 12:45 plan and its denominators. Missing raw baseline
   sections are named instead of reconstructed from later data.
2. Save complete current `GET /api/audit/tokens?days=1` and `?days=7` responses locally.
   Retain only aggregate summaries in this review. Their selectors currently filter on
   `runs.started_at`, as `Store.runTokenAudits` and `tokenAuditView` show.
3. Check the last hour's stored audit cohort: no audited runs started in that hour. This does
   **not** prove no calls occurred, no controller tokens were used, or zero source costs.
   The route rejects fractional days and does not implement an hour selector.
4. Read the configured role/model/effort choices and the sizes of current role/rule files.
   No configuration, budget or observed loop was changed.
5. For #1616, compare the old and candidate first-wake functions on the same copied SQLite
   state: 215 signals, 195 handled, 20 unhandled. Other digest fields and the full state match.
   The retained receipt is `docs/reviews/2026-11-09/flight-signals-1616/digest-size.json` on
   #1616's branch. Its independent change owns that evidence; this document does not copy it.
6. Re-measure each fix seven days after merge, recording window semantics, coverage, run
   count, task mix, model, budget stops and baseline. A lower total caused by stopped seats
   is not an improvement. A trial without its required actual seat receipts is unfinished.

No implementation saving is counted as shipped by this research. There is no unit-test
impact from this document; review checks the arithmetic, references and filed acceptance work.
