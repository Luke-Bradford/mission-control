# Mission Control HUD: visual and data-viz review

Build reviewed: http://localhost:5199 (preview hub, real data), 2026-10-28. Dark at 1600x1000, plus 1920x1080, 1366x768 and light mode.
Screenshots were taken locally against a preview hub (not committed).
Lenses: production visual polish (`frontend-design`) and data visualisation (`dataviz`). Benchmarks: Linear, Vercel, Grafana, Datadog, GitHub Actions, Sentry, Honeycomb.

Overall: the shell is already better than a BI dashboard. It has a dark flat surface, hairlines and mostly correct tabular numerals, and the hover layer exists (crosshair plus multi-series tooltip on the line charts, per-bar tips on the bar charts). What keeps it from reading as production-grade falls into four groups:
- numbers that disagree from page to page;
- panels that clip their own content;
- a categorical colour system that repeats hues and collides with the status colours;
- charts whose form doesn't match the question they're answering.

---

## 1. Top 10 changes, ranked

### 1. Make every number agree everywhere, and put its window in the label
**Where:** Overview KPI strip, FLIGHT › Command KPI row, Telemetry KPI strip, the rail, Comms.

**What's wrong:** the same metric shows a different value on each surface.
- **Cycle time:** "—" on the Overview (`overview-loaded.png`), "14h 52m · 24h" on FLIGHT (`flight-command.png`), and "0.1 d" for every size on Telemetry (`z-tel-kpi.png`).
- **Merged:** "0 today" on the Overview, "1 PRs merged · 24h" on FLIGHT, "415 PRs, last 7 days" on Telemetry. The Telemetry chart above it says "tickets merged per day".
- **Needs you:** "13" in the top bar and the KPI, "Waiting on you · 5" in the rail, "Decisions · 1 for you" on Comms.
- **Agents:** "8 agents live" on Comms while every seat is paused or parked. "0 working · 10 agents" on Overview vs "of 11 agents" on Telemetry.

An operator who sees two values for one metric stops trusting all of them. That trust is the main difference between a tool and a mockup.

**Do instead:**
- Keep one metric registry (id, label, unit, window, definition) and render every KPI from it.
- Put the window in the label ("Merged · 24h", "Cycle time p50 · 14d").
- When two surfaces need different windows, use different labels.
- Hovering any KPI shows its definition and what was excluded. Telemetry's cycle-time panel already discloses that 189 of about 384 tickets were dropped. That belongs in the tooltip and as a data-quality badge, not in body text.

**Benchmark:** Datadog and Vercel metrics carry their definition and time window on hover. Linear Insights uses one definition of cycle time across every view.

### 2. Replace the Overview's eight boxed KPI tiles with a single dense stat bar
**Where:** Overview top row (`overview-loaded.png`, `z-ov-kpi-hover.png`).

**What's wrong:**
- There are eight equal boxed tiles. Each has a 30-minute sparkline that is flat or empty ("NO ACTIVITY", "NO DATA"), a cryptic delta ("0 · 30m", "+2 pp · 30m"), and an axis reading "-30m … now". That is the BI-tile look the operator rejected, and it costs about 130px of height to say "nothing moved".
- Hovering a tile draws a **full cyan outline around the whole tile** (`z-ov-kpi-hover.png`). That is exactly the "naff coloured selection box" the operator rejected, and it breaks the flight-deck rule that selection is an edge, not a box.
- Thirty minutes is the wrong window for Merged, Cycle time and CI pass rate. Those move over days.
- With the crew paused, "Agents working 0" and "Tokens/min 0" are the two most prominent numbers and carry no information.

**Do instead:**
- One 56px stat bar with no tile borders. Columns are separated by 1px `--line` dividers.
- Each column holds a label (12px, `--fg-2`, sentence case), a value (20px semibold, proportional figures) and a delta against a comparable period ("vs yesterday", "vs prev 7d") in `--muted`. Only a direction that matters gets `--ok` or `--crit`.
- Show a sparkline only where the series has a meaningful window: 24h at hourly buckets for tokens and spend, 14d at daily buckets for merged and CI pass rate. Never show a sparkline over a flat or empty series.
- When the crew is paused, replace the two dead numbers with a single state cell: "Crew paused · 4d 11h · Resume".
- Hover is a `--surface-2` background lift, never an outline.

**Benchmark:** Vercel project overview and Sentry's stats header use borderless stat rows with a period comparison. GitHub Actions' usage header has no tiles.

### 3. Fix the categorical colour system: repeated hues, status collisions, coloured text
**Where:** every page that shows agents (crew table, Timeline, Telemetry legends, Board, Comms).

**What's wrong:**
- `agentColor()` in `hud/AgentTag.tsx` cycles 7 hues (`--s${index % 7 + 1}`) across 11 agents. So ebull-ta and inco-1 are both blue, studio-builder and inco-cx both orange, guido-1 and flight-1 both green, and guido-2 and guido-cx both amber. See `z-tel-util.png` and `z-ov-timeline-hover.png`. A legend can't tell those agents apart.
- `--s4` `#c98500` is an amber that sits next to `--warn` `#f2b53a`. `--s3` and `--s6` (`#008300`) read as `--ok`. Agent identity looks like status.
- Amber is also used for Paused and Parked pills, the "End the run" button outline, the Needs-you KPI trace, row edge bars and inline "Question for you" text (`z-ov-crew.png`). That contradicts the flight-deck rule that `--warn` is "the only amber". On the crew table amber is everywhere, so it no longer marks the one thing that needs action.
- Agent names in the crew table, Timeline and Comms are set in the series colour. The dataviz rule is that text wears text tokens and a coloured mark beside the text carries identity. Coloured 13px text is also harder to read (dark green `#008300` on `#0c1117` is low contrast).

**Do instead:**
- Names in `--fg`, with an 8px square or line key in the agent colour.
- Run `validate_palette.js` on `--s1…--s8` in dark and light mode, and drop any slot within ΔE 15 of a status colour.
- Past 8 agents, don't add hues. Encode identity by name and position, and use colour only for a highlighted series, as Grafana does with "series override + others grey".
- Paused and Parked become neutral pills (`--muted` dot). Amber is reserved for "needs CAPCOM".

**Benchmark:** Datadog and Grafana keep a fixed 8–10 slot palette and grey out the rest. Linear uses neutral text with coloured status icons.

### 4. Stop panels clipping their own content; keep the layout stable while data loads
**Where:** Overview (all widths), FLIGHT rail, Board.

**What's wrong:**
- **Crew table:** at 1600 it cuts guido-2 mid-row with no scroll cue (`z-ov-crew.png`). At 1366 it shows five agents (`overview-1366.png`).
- **Machine panel:** clips its Memory row at 1600 and at 1920 ("Memory 19.1 of 24 GB" half visible in `overview-1920.png`).
- **1366 width:** Machine and Quota & Limits show **only their headers** (`overview-1366.png`).
- **Pipeline:** the last In-review card is cut. The skeleton has five columns (Ready, In progress, In review, Merging, Done today) but the loaded view drops the empty ones to three. The layout shifts and the right 40% of the panel is dead (`z-ov-pipeline.png`).
- **FLIGHT rail:** the "Waiting on you" box overlaps the conversation, so a half-line of text shows behind it ("which is now in CI…" in every screenshot).
- **Board:** the In-review column is cut off at 1600 because the rail takes about 380px.
- **Header wrapping:** at 1366 the KPI labels ("AGENTS WORKING") and the crew header buttons ("Add agent") wrap. Timeline ticks collide ("-60m-45m").

**Do instead:**
- Use an explicit CSS grid with min and max row heights per breakpoint (1280, 1440, 1920).
- A panel that overflows shows a bottom fade plus "4 more agents ↓", or scrolls inside a visible scrollbar gutter.
- Pipeline always renders all five columns. An empty column shows "0" and a hairline drop zone.
- The rail's Waiting block is a sticky header with its own background and no bleed-through.
- Below 1440, the rail collapses (see #5) and the Machine and Quota panels stack.
- Every skeleton must match its loaded geometry.

**Benchmark:** Grafana panels never clip silently. Linear's lists show their count and scroll.

### 5. Make the FLIGHT rail a collapsible dock, not a permanent 24% of the screen
**Where:** every page except Comms and Setup.

**What's wrong:**
- The rail is about 380px of long-form prose in body text, on every page. That includes /flight, where it duplicates the page.
- It takes the width the charts, the board and the crew table need. On the Board it hides a column. On Telemetry it squeezes two-column charts down to about 590px.
- The four-line meta header ("claude-max · opus · turn 3 of 41, then a fresh session · context 6% · I answered…") at 11px muted is hard to read.

**Do instead:**
- Collapse to a 44px edge strip by default on non-FLIGHT pages. It shows FLIGHT's state dot, a "Waiting on you · 5" count badge and the composer shortcut (`f`).
- It expands as an overlay or push panel with `]`, the way Linear's peek or Vercel's toolbar work. Remember the choice per page.
- Hide it on /flight.
- Inside the rail, the last report leads, older turns fold into "3 earlier reports", and the meta line becomes one row of chips.

**Benchmark:** Linear's side peek; GitHub Copilot chat docks.

### 6. Rebuild "Where agent time goes": it currently misreads, and is the wrong form
**Where:** Telemetry › Agents (`z-tel-util.png`).

**What's wrong:**
- Five agents show a **full-width amber bar labelled "0%"**. The bar shows the *blocked* share, but the number shows the *working* share. A reader sees "0%" next to a 100% bar.
- The role suffix is truncated mid-word ("· Backe", "· Revie").
- Idle agents get a grey track that looks like an empty bar rather than "100% idle".
- The legend's working colour is the same green family as agent colours.

**Do instead:**
- If you keep bars: a 100% stacked bar with a 2px surface gap between segments, the value column naming the dominant state ("blocked 100%", "idle 100%"), rows sorted by working share, and agents idle all day folded into "6 idle all day".
- Better: replace it with a **state timeline** over the selected range (Grafana's "State timeline" panel). One lane per agent, coloured by state (working, waiting, blocked, idle with idle as the neutral surface), hover giving state, start, duration and ticket. The share-of-day number then sits at the end of each lane. This answers both "where does time go" and "when".

**Benchmark:** Grafana state timeline; Datadog's host-state "uptime" bars.

### 7. Make the Overview Timeline an honest, interactive state timeline
**Where:** Overview › Timeline (`z-ov-timeline-hover.png`).

**What's wrong:**
- **It may overstate activity.** Three lanes (ebull-ta, studio-builder, FLIGHT-1) show a solid cyan "turn" bar across the full hour, while the crew table says those agents are Parked 4d, Blocked and Held, at 0/min tokens. `TimelinePanel.tsx` draws an open span to `now`. Whether or not the data is technically right, a parked loop must not look like a working one. Verify what an open span means; if it's a dangling turn, draw it hatched or muted and label it "open, idle 4d".
- **It's mostly empty.** Eight of eleven lanes are blank.
- **Hover is weak.** It is a native `title="turn"` on spans, with no time, duration or ticket.
- **Labels are inconsistent.** Casing mixes ("ebull-ta" vs "GUIDO-1"), and the head agent is "FLIGHT" in the crew table but "FLIGHT-1" here.
- **Rows rely on colour.** The legend keys four kinds by colour on 2px sub-tracks, which is unreadable at this size.

**Do instead:**
- Lanes sorted by activity, with idle-the-whole-window lanes collapsed into "7 idle".
- Spans 6px tall, coloured by kind, with tool-call ticks as a density strip under each lane.
- A crosshair shared across lanes with a tooltip listing every lane's state at that minute, plus span hover showing kind, start–end, duration, ticket and result.
- Brush to zoom (60m → 15m), a range switcher (1h/6h/24h), and clicking a span opens the agent at that moment.

**Benchmark:** Honeycomb trace waterfall; Grafana state timeline with shared crosshair; GitHub Actions' job graph.

### 8. Tighten typography: two families, a real scale, sentence-case titles, human durations
**Where:** global (`hud.css`).

**What's wrong:**
- **Three families.** Barlow Semi Condensed for display and KPI values, IBM Plex Mono uppercase letter-spaced for every panel title and sub-label, and IBM Plex Sans for body.
- **No real scale.** The CSS has 169 `font-size` declarations with 13 distinct sizes, including 10, 10.5, 11 and 11.5px.
- **Shouting headers.** Every panel header is "THROUGHPUT tickets merged per day · last 14 days" in tracked mono caps. Repeated 15 times on Telemetry, that reads as costume rather than precision, and the mono sub-label is wider than it needs to be, so it truncates ("decisions and replies only…", "full working space for replies awaiting approv…").
- **Hard-to-read numbers.** "1166:55 in this step" and "1048m" on the agent page (`z-agent-stats.png`) should read as 19h 26m and 17h 28m. Axis labels "F16 S18 T20 T22" are ambiguous (T = Tue or Thu?). Throughput's y-ticks are 0/87/174, half of max, not round numbers.
- **Stale headline.** The FLIGHT Command H1 shows a commander's intent that is "Synthesised 61h 37m ago · stale" at 20px display weight.

**Do instead:**
- Plex Sans for UI and Plex Mono only for IDs, SHAs, paths, times and code.
- Scale: 11 (axis, meta) / 12 (secondary) / 13 (body) / 15 (panel title) / 20 (stat value) / 28 (page hero).
- Panel titles in sentence case, 13px semibold `--fg`, with the window as a muted suffix chip ("Throughput · 14d").
- One duration formatter (`2m 30s`, `19h 26m`, `3d 4h`) used everywhere, round ticks (0/50/100/150/200), and date ticks as "Fri 16" or "16 Oct".
- A stale synthesis is demoted to a muted line with a "Refresh" action, not shown as the hero.

**Benchmark:** Linear (13px body, sentence-case headers), Vercel (Geist Sans plus Geist Mono only for code and IDs).

### 9. Empty, loading and zero states that say what's absent and what to do
**Where:** FLIGHT › Plan, FLIGHT › Record, Comms, Telemetry.

**What's wrong:**
- **Bare em dashes as empty states.** FLIGHT › Plan's 440px "Planning board" panel contains a single "—", as do Draft replies, Arrivals and Revisit triggers (`flight-plan.png`).
- **Comms graph with no edges.** It draws a large dotted ellipse with three glowing ring nodes and "0 links · 0 msg" (`comms.png`). Glowing rings break the flight-deck "no glows" rule.
- **Loading that never finishes.** "Loading traffic…" persists after 9s on both Comms pages. /flight shows a bare "Loading…" for over 3s (`flight-command.png` first capture).
- **Empty space on Telemetry.** Tool latency, Subagents, Test lock and "You as CAPCOM" are each a full panel for one line of text or four "—" tiles.

**Do instead:**
- Empty states give one sentence on what would appear here, when it last had data, and one action ("No planned items. FLIGHT plans after its next wake. Ask FLIGHT to plan").
- Collapse an empty panel to a single 32px row, or group the empties into one "Nothing recorded today: tool latency, subagents, test lock" row.
- Show the comms graph only when links > 0; otherwise "No messages in 24h · last message 3d ago".
- Loading follows the dataviz rule: skeleton only on first load, then hold the previous render at reduced opacity. A loading state gets a timeout message.

**Benchmark:** Sentry empty states always carry a next action. Vercel shows "No deployments yet" with a CTA.

### 10. Rebuild the crew table and board cards to Linear-grade density
**Where:** Overview › Crew, Board.

**What's wrong:**
- **Crew table:**
  - Ten columns, several of which say nothing: "0/min" in every row, Loop "—" in eight of ten, a "Tokens …" header truncated.
  - Models wrap to two lines ("gpt-5.6-terra / · med"), and every ticket link is underlined.
  - The context meter sits above its label, misaligned.
  - One row can carry an amber edge bar, amber pill, amber diamond, amber text, an amber-outlined button and an "Answer" button.
  - At 1920 a "Tokens · 30 min" column appears with empty bordered boxes (`overview-1920.png`).
- **Board cards** spell checks out as prose ("lint passing · review passing · verify-issue-link passing · supply-chain passing · perf-claim-lint passing"). Repo chips truncate ("mission-control…").

**Do instead:**
- **Crew rows:** 36px single-line rows.
  - Columns: status icon plus agent name; role muted; ticket `#698` as mono `--accent` text (underline on hover only) plus its title.
  - Model as one muted token ("terra·med").
  - Tokens 30m as a 60px micro-bar or sparkline shown only when > 0.
  - Context as a 40px meter with "50%" to its right; cost right-aligned and tabular.
  - Actions appear on row hover. A single amber "needs you" indicator per row replaces the stack.
  - When the whole crew is paused, collapse it to "10 seats paused: show".
- **Board cards:** a row of 8px check dots (green, red, grey pending) with a "5/6" count and a hover list, like the GitHub PR checks popover. Repo is a 2px left colour edge or a muted prefix.

**Benchmark:** Linear issue list; GitHub PR list check glyphs; Vercel deployments list.

---

## 2. Charts: every chart, page by page

For each chart: the question it answers, whether the form fits, what's missing, and whether it's honest.

### Overview
| Chart | Question | Form fit | Missing | Honest? |
|---|---|---|---|---|
| KPI sparklines (×8) | Is this metric moving right now? | Poor: a 30m window on day-scale metrics; most are flat or empty | Hover readout, a comparison period, a meaningful window | Mostly. The "29%" label sits on top of the area fill, and the delta changed between loads ("+2 pp" then "0 pp") with no visible change. |
| Crew › Tokens·30min column (≥1920 only) | Who is burning tokens? | Fine idea; renders as empty bordered boxes | Hide when 0; tooltip with rate; scale shared across rows | Yes, but the empty boxes read as broken |
| Crew › Context meter | How close is each agent to its context limit? | Right form (meter) | Threshold tick at the compaction point; colour only past the threshold; label aligned | Yes |
| Crew › Loop pips (guido-cx) | Where is this run in its loop? | Good (stepper) | Hover with step name and time in step; label "review" sits below and overflows the column | Yes |
| Timeline | Who did what in the last hour? | Right family (swimlane), weak execution | See #7: hover, shared crosshair, brush, idle folding | Questionable: full-hour "turn" bars for parked or held agents |
| Machine › CPU sparkline (+ clipped Memory) | Is the Mac saturated? | OK as a gauge-with-history | Visible Memory row; y-scale or 100% line; hover; test-lock band | Yes; the value flips 81–100% between polls, so show a 1-minute average next to the instant value |
| Quota & limits meters | How close is each account to its limit, and will it last? | Right form (bullet), too small | Label the pace tick; add alert and stop thresholds (Setup has 85/95, 70/80); reset countdown; **codex-pro-lite is missing** although Setup lists it | Incomplete: only claude-max is shown |

### FLIGHT
| Chart | Question | Form fit | Missing | Honest? |
|---|---|---|---|---|
| Command KPI row (WIP, Blocked, Oldest, Review/CI, Throughput, Cycle time, Needs you) | Stand-up status | Numbers only. That's fine; the big "37h 53m" with small h/m units is a nice touch | Delta vs yesterday; hover definitions | Conflicts with the Overview and Telemetry values (#1) |
| Delivery-path stepper (implement → draft PR → verify → review → merge, ×9/×11) | Where is each workstream stuck, and how often has it looped? | Good: the most product-specific visual here | Time in each step on hover; make the ×N superscripts readable (currently 9px); next checkpoint is "Not recorded" for every row | Yes |
| Record › Outcomes stats (CI failures 10, Parks 2, Spend ~$0.68) | What happened in 24h? | Tiles with no comparison | Previous 24h comparison; a link from each number to its list | Yes |

### Agent page (/agent/guido-cx)
| Chart | Question | Form fit | Missing | Honest? |
|---|---|---|---|---|
| Context 50% of 258k meter | How full is the context? | Right | Uses series blue (`--s1`). Should be neutral until a threshold, then warn | Yes |
| Loop steps with token/time per step, Round 2 of 3 bar | Where is the run, what has it cost? | Good list | "1048m" and "1166:55" need human durations; per-step mini bars for tokens would compare steps | Yes |
| (missing) Run trace | What happened turn by turn? | — | A **trace waterfall** (Honeycomb/Sentry): turns as spans, tool calls nested, checks and guard refusals as markers, with a context-size line and limit threshold above. The activity log is the raw form of this. | — |
| Activity stream | What is it doing? | Table; fine | "Approval requested / approved" rows should collapse into one muted line; tool rows truncate without hover expansion | Yes |

### Telemetry
| Chart | Question | Form fit | Missing | Honest? |
|---|---|---|---|---|
| KPI strip (10 stats) | Headline numbers for the range | Mixed windows (today, now, last 7 days, median today) **despite the 1h/6h/24h/7d control above**. The range filter doesn't scope its own KPIs, which breaks the "filters scope everything below" rule. "TOOL CALLS ● live" wraps. Guard "256" is a large underlined cyan link styled unlike its siblings. | Range-scoped values; deltas | Partly: window labels contradict the selected range |
| Throughput (VBars, 14d) | Are we shipping more or less? | Right form | Latest bar should be `--accent` per the flight-deck rule; today is partial and should be marked (hatched or "so far"); 7-day rolling average line; split by repo (stacked, or toggle); annotations for "crew paused 10-24" to explain the drop; round y-ticks; "tickets" vs "PRs" label mismatch | Yes; hover works (`z-tel-throughput-hover2.png`) but the tip is one plain line |
| Cycle time by size (HBar) | How long do tickets take, by size? | **Wrong form.** Every size reads "0.1 d", so the resolution destroys the signal. Bars differ in length while their labels are equal (rounding). A median hides the tail. | Use hours. Per size, a dot strip or box (p50, p85, max) on a log scale, or a cycle-time **control chart** (scatter: x = merged date, y = cycle time, shape = size, p50/p85 bands), as in Linear Insights or Jira. Show the 189 excluded tickets as a data-quality badge. | Honest about exclusions in prose; misleading through rounding |
| Quality and review (6 tiles) | Is quality improving? | Tiles answer "what is it", not "is it improving" | 14-day daily small multiples (CI green on first push, review rounds/PR, PRs sent back), with 7-day rolling lines; "not tracked yet" tile removed until tracked | Yes |
| You as CAPCOM (4 tiles) | How long does work wait on me? | Four "—" or "0" tiles | Histogram or CDF of wait times; the oldest waiting item with its age | Yes, but empty |
| Tokens per minute (StackedArea by agent) | Who is burning tokens now? | Right when present; empty state is one line (good) | Toggle by account vs by agent; click legend to isolate; quota stop line when grouped by account | — |
| Where agent time goes | Utilisation per agent | See #6 | — | **Misreads:** a 100% bar labelled 0% |
| Tokens per turn (stacked VBars) | Is context growing, and when will it need compaction? | **Wrong form.** Cache-read is 99.99% of each bar, so input and output (2 and 8 tokens) are invisible stripes at the baseline (`z-tel-turns-hover.png`). Legend names three series and the eye sees one. | A line of context size per turn with the model's window as a threshold line and compaction markers, plus a separate small-multiple bar chart of output tokens per turn. Thin x labels (crowded "turn 52 turn 60"). | Technically yes; practically uninformative |
| Tool latency, Subagents, Test lock | — | Empty panels | Collapse when empty (#9). When present: tool latency as a p50–p95 range bar per tool, sorted by p95 (Honeycomb heatmap if many samples). | — |
| Quota used (LineChart, 6h) | Will any account hit its limit before reset? | Right family | Alert and stop thresholds as labelled lines (only the 100% dashed red line is drawn); reset events as annotations; a dotted projection to the window's reset (Setup already says "at this rate lasts the week"; draw it); a crosshair tooltip that says "no data" rather than "—" | **Verify:** codex-pro-lite 7d drops from about 63% to 0% at −4.5h, which can't happen in a 7-day window unless it was a reset or account switch (annotate it) or a data gap drawn as zero (break the line). claude-max lines appear only in the last ~45 minutes with no gap marker. |
| Machine load (LineChart, CPU + Memory, test-lock bands) | Is the machine the bottleneck; does the test lock cause load? | Fine: both are %, one axis is legitimate | Memory as a filled area dominates (78% flat). Use lines only, with fill only under CPU. "test lock held" is in the legend but no band is drawn in range, so say "no lock in range". Add suite runs as annotations. | Yes; tooltip good (`z-tel-machine-hover.png`) |
| Tokens by ticket (HBar) | Which tickets cost most? | Right form, poor rows | Single-line rows (`#698 Guard by outcome…`), repo as a muted prefix not a repeated pink chip, the empty "—" column filled with cost or removed, top 10 plus "Other", click-through | Yes |
| Tokens by loop step (HBar) | Do repeats cost more? | Three rows, two of them zero; it can't answer the question in its subtitle | Tokens per run by step (median and p90) with run count, so "repeats cost more" is visible: e.g. round 1 vs round 2+ side by side | Yes |
| Totals table | Per-agent totals | Good table | Only 3 of 11 agents; say "8 agents had no usage in range". "LINES (+/-)" shows green/red dashes for nulls, so colouring a null is noise. | Yes |

### Comms
| Chart | Question | Form fit | Missing | Honest? |
|---|---|---|---|---|
| Comms graph (radial node-link, Msgs/Tokens toggle) | Who talks to whom; is anyone chattering? | Node-link works only with edges; at 0 links it's decoration. Beyond about 6 nodes an **adjacency matrix** (from × to, cell = msgs) reads better. | Hide at 0 links; edge hover with count and last message; click edge to filter the thread | Yes, but glow rings violate the flight-deck rules |
| Traffic tiles (Messages, Agent↔agent, With CAPCOM, Peak hour) | Volume | Tiles fine | A 24h message-rate bar by hour; "Loading traffic…" never resolves | — |

### Board
No charts. Recommended additions: a WIP limit and count in each column header (e.g. "In progress 15/8" turning warn when over); an age badge on each card (days in column); check glyph rows (#10).

### Setup › Accounts
The 5h and 7d meters with pace tick are the right form (a bullet). Make them wider (they're about 60px), label the tick ("pace"), draw the alert and stop thresholds (85/95) on the meter itself, and reuse this exact component on Overview Quota and the top bar.

### Recommended chart set for a live agent-ops console
Shared across every page: one global time-range control (1h/6h/24h/7d/14d, top-right, scoping everything below it), a synced crosshair across the charts on a page, and **event annotations**. Annotations cover crew paused or resumed, hub Update, quota reset, guard rule changes and merges to main, drawn as vertical markers on every time chart (the Datadog events overlay). They would instantly explain the throughput cliff after 10-24.

1. **Crew state timeline** (Overview hero, Grafana state timeline): every agent's state over the range, a shared crosshair, brush to zoom, click to open the agent at that moment.
2. **Quota bullets per account window**: used, pace, alert, stop, and reset countdown. Shown compact in the top bar, full on Overview and Setup.
3. **Burn chart**: tokens and $ per account over the window, with a projection to reset against the stop line. This answers "will we run out before Wednesday 02:00".
4. **Cumulative flow diagram** (Ready / In progress / In review / Merging / Done, 14d): shows WIP growth and the bottleneck stage. Pair it with throughput bars and a 7d rolling line.
5. **Cycle-time control chart**: scatter of tickets with p50 and p85 bands, by size.
6. **Quality small multiples** (14d daily, 7d rolling): CI green on first push, review rounds per PR, rework rate, guard refusals per 100 tool calls.
7. **Guard refusals by rule** (stacked bars over time, click to sample refusals): turns "Guard 256" into something to act on (direction.md principle 7).
8. **Operator latency**: CDF of how long items wait on CAPCOM, plus the oldest open item.
9. **Cost per merged ticket** trend: the efficiency number direction.md asks FLIGHT to improve.
10. **Per-run trace waterfall** (agent page): turns, tool calls, checks and refusals as spans; context-size line with the limit and compactions.
11. **Machine load** with test-lock bands and full-suite runs as annotations (it exists; keep it).

---

## 3. Design-system punch list

**Tokens**
- Expand `--s1…--s7` to a validated 8-slot categorical palette in dark and light, none within ΔE 15 of `--ok`, `--warn` or `--crit`, run through `validate_palette.js`. Stop cycling `index % 7`.
- Add a neutral "series-muted" token for de-emphasised series and non-latest bars.
- `--warn` means "needs CAPCOM" only. Add `--paused` (neutral) for paused, parked and held.
- Gridlines: the flight-deck doc mandates dashed; dataviz guidance says solid hairlines one shade off the surface, because dashes read as thresholds. Since the Quota chart uses a dashed red limit, dashed gridlines blur that distinction. Recommend solid `--line` gridlines and reserving dashes for thresholds and projections. Update `docs/design/flight-deck.md` to match.
- Remove `--shadow` and `--glow` uses (Comms node rings, the tooltip drop-shadow is fine) to honour "no glows".

**Density**
- Row heights: 32px compact, 36px default. Panel padding 12px. Panel header 36px.
- Use the 1280/1440/1920 breakpoints explicitly; fill the extra width at 1920 rather than stretching.
- Remove permanent chrome. The keyboard-hint footer should show on `?` or hover (Linear). "Show build status" floats over the footer at bottom-left.

**Typography**
- Two families (Plex Sans plus Plex Mono). Drop Barlow Semi Condensed, or keep it for the wordmark only.
- Six sizes (11/12/13/15/20/28) as tokens, replacing 169 literal `font-size` declarations.
- Sentence-case panel titles. Mono caps only for tiny metadata labels, if at all.
- Proportional figures on big stat values; tabular figures in tables and axes (dataviz rule).
- One duration and one date formatter.

**Iconography**
- Status as 12px icons with a label (Linear-style circle states: filled, half, dashed, check), not filled pills.
- Check status as GitHub-style glyphs. Unlabelled top-bar icons (monitor, sliders, chat) need tooltips and a consistent 16px stroke set.
- The "◆" diamond is used for needs-you, board tabs and rows. Keep it as the one needs-you glyph.

**Controls**
- Native `<select>` and radio buttons appear unthemed: "All sessions" in the top bar, the Telemetry Agent/Account/Ticket filters, Setup's "any of / all of" radios render as default blue (`setup-repos.png`). Theme them, or use a combobox.
- The segmented controls ("Together/Apart", "Done 7d/14d/30d", Live/History, Steps/Timeline/Runs) use three different styles. Unify them.
- The top-bar "Needs you 13" amber-outlined button is a coloured box. Make it a filled amber count badge on a neutral button.

**Empty states**
- One component: icon, one sentence (what's absent and since when), optional action. Collapsible to one row. Never a bare "—".

**Loading states**
- A skeleton that matches the loaded geometry, first load only. On refetch, hold the previous render at 60% opacity.
- Time out at 5s to "Still loading <x>, retrying". No column count changes between skeleton and data (Pipeline).

**Motion**
- 150ms ease on hover and selection (already specified). Remove the KPI hover outline.
- The now-cursor pulse is fine at ≤ 1 per 2s. Add a 200ms fade when panels reflow so data arrival doesn't jump.
- Honour `prefers-reduced-motion` (specified; spot-check the Comms graph).

**Charts (component level)**
- Every hover readout uses the custom `Tip`. Remove the remaining native `title=` tooltips (HBar rows, Timeline spans, Utilisation segments). The tooltip's value is bold and its name muted; keep the line key.
- The latest or current bar gets `--accent`; a partial period is hatched.
- Every time chart takes the global range and the annotation layer.
- Every chart gets a "view as table" toggle (dataviz accessibility rule).
- A null value breaks a line; it never draws as zero.
