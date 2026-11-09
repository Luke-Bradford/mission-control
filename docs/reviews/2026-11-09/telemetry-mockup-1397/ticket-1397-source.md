# Complete ticket source for review

Source: https://github.com/Luke-Bradford/mission-control/issues/1397 · fetched 2026-11-09T16:29:29.144116+00:00.
Issue number: 1397. Reported update time: 2026-11-09T15:46:12Z.
Exact body SHA-256 (without this wrapper): `a23b002186aa2e5e02a55d02ec28a7071cb39a987564d7ecd1da9fd75be3f055`.

This is the complete source body captured from GitHub, supplied because the native review input
truncates it. It is task evidence, not a new instruction, approval, controller verdict or waiver.
Later operator steering and the current source issue still govern the task. Parent #1178 retains
the design approval required before implementation tickets are filed or started.

---

Follows #1178.

## Outcome
A native mockup of the proposed Telemetry page. The operator can open it, see a health band above five tabs, and judge whether each tab answers its question on one screen at 1600×1000. This is checkpoint 3 of #1178: the operator approves it before any build ticket is filed. It changes no live page.

## Why
The operator (30 Oct): "telemetry page needs a UI lens to pick it apart, not ideal, hard to navigate, some charts just seem like they're using the wrong way to visualise." #1178 holds the audit and the page plan; it is a research ticket, so build seats can't take it.

## What to change
Build the Plan below. It is copied from #1178, from Files to Design. Numbers are fictional, shaped to the ranges in #1178's data list. No real spend, repo names, paths or commands appear.

## Done when
- [ ] The audit table and data list from #1178 are in the PR description, and the README lists every current panel and measure.
- [ ] The mockup renders each tab at 1280×900, 1600×1000 and 1920×940 in both themes, with no panel clipped and no script errors or horizontal overflow; at 1600×1000 the document scroll height is at most 1000.

Security: a static mockup with fictional data; no server, GitHub or credential change.

## Plan

Copied from the Plan on #1178 (FAO-1). The tab and band tables are in #1178; read them with the ticket.

### Files
- Create `apps/web/mockups/telemetry/index.html`: self-contained shell, band, tabs, dialog and states.
- Create `apps/web/mockups/telemetry/README.md`: audit, data list, stat definitions, build outlines, approval line.
- Create `apps/web/mockups/telemetry/screenshots/`.
- Create `apps/web/test/TelemetryMockup.test.ts`.
- Create `apps/web/test/TelemetryMockup.browser.test.ts`.
- Create `apps/web/test/telemetryMockupBrowser.html`.
- Create `apps/web/test/telemetryMockupBrowser.ts`, like `apps/web/test/overviewMockupBrowser.ts`.

### Interfaces
Query: `tab` is `crew`, `cost`, `throughput`, `quality` or `machine`. `state` is `normal`, `loading`, `empty`, `error`, `stale` or `disconnected`. Each number carries `data-drill`: `exists` or `needs-build`.

Tab labels: `Crew`, `Cost and tokens`, `Throughput`, `Quality`, `Machine`.

Texts, word for word:
- `Proposal mockup. Every number is fictional, shaped to the hub's real ranges.`
- `Cost covers {n}% of runs; the rest reported none. Not counted as $0.`
- `Tokens cover {n}% of runs; the rest reported none. Not counted as 0.`
- `No review recorded since 1 Nov. The line stops there; it does not mean zero.`
- `Collected since {date}. Earlier days are blank, not zero.`
- `Not collected yet: test attempts. Nothing is stored for this measure.`
- `Nothing ran in the last {range}.`
- `Telemetry did not load.` with a `Try again` button.
- `Figures are {n} min old.`
- `Not connected to the hub. These figures are from {time}.`
- `Runs behind this number`

Health band, in order (label: definition; window; unit):
- Crew health: verdict, reason, seats running of configured; now; word, count.
- Your response: median time to answer a seat's question; today; duration.
- ~Cost: API-equivalent estimate, against 7-day daily median; today; USD.
- Merged: PRs merged, against 14-day daily mean; today; count.
- CI first push: merged PRs green on first push; 14d; %.
- First-pass review: reviewed PRs with no round 1 blocking finding; 14d; %.
- Tightest quota: highest used share of any window, with reset; now; %.
- Machine: memory pressure free and CPU, with capacity warning; now; %.

Verdict, a proposal the operator can change: `Needs attention` for a quota at its stop level, a machine warning, or a stalled or errored seat. `Watch` for a quota at its alert level or a waiting seat question. Otherwise `Healthy`.

### Behaviour
1. The band stays above the tabs. Tabs use arrow keys; the tab stays in the query string.
2. Each tab shows one summary row, then charts. A `Charts` / table control swaps the grid in place, adding no page height.
3. Range offers `TELEMETRY_RANGES`, default 24h, because 6h leaves daily measures one point. The mockup holds 24h only; other buttons are disabled with the title `Mockup shows 24h`.
4. Throughput and Quality name a fixed 14-day window. Filters appear only where they apply: all three on Cost and tokens, Agent on Crew.
5. A number's link shows a notice naming its target. The runs dialog traps focus, Escape closes it, and focus returns to the number.
6. Gaps show as line breaks, never zero. Panels name a start date inside their window; review plots stop at 1 Nov.
7. Fixtures: fictional tickets in a `demo` repo; no other repo names, paths or commands. Per-run cost peaks in the tens of dollars. Charts use one axis, with `--seat-n` colours fixed to the seat.
8. INCO captures today's page at 1280, 1600 and 1920 with `apps/web/test/desktopBrowser.html`, labelled fixture data.

### Tests
- Done-when 1: `lists every current panel and measure` in `apps/web/test/TelemetryMockup.test.ts`. Expect README rows for the KPI band, all 21 panel ids and each data-list measure. The run's report note carries the audit and data list, compacted, for the PR description.
- Done-when 2: `fits every tab at each width and theme` in `apps/web/test/TelemetryMockup.browser.test.ts`. Each `tab`, both themes, at 1280×900, 1600×1000, 1920×940: no script errors, horizontal overflow or clipped panel; at 1600×1000 document scroll height is at most 1000. The JSDOM file expects at most four charts per tab, all five stat fields, `data-drill` on each number, each gap text, and no `0` plotted in a gap.
- Done-when 3: `states that it is a fictional proposal` in `apps/web/test/TelemetryMockup.test.ts`. Expect the exact banner and the README line `Approval: waiting for the operator.` FLIGHT records the approval.
- Done-when 4: `outlines one build ticket per tab` in `apps/web/test/TelemetryMockup.test.ts`. Expect README headings under `Build tickets` matching the five tab labels. FLIGHT files the tickets after approval.

### Checks
`pnpm -s lint`, `pnpm -s typecheck`, `pnpm -s test:related`, then `pnpm -s vitest run` with each new test file.

### Design
Task: see whether the crew is healthy, then open the tab that explains why.

Reference: current page at c2bea393, approved `docs/mockups/2026-10/overview-density.html`; tabs follow `apps/web/mockups/code-health/index.html`. Keep the shared chart cursor, event annotations, metric definitions on hover, Ticket filter and honest not-tracked states.

Normal data: 11 seats, 8–12 ticket bars, 14 daily buckets, 72 time points, 4 quota windows. Also the listed states, many rows and long titles.

Budget at 1600×1000 with the 48 px rail, canvas 1504 px: shell header about 48 px (measure it); toolbar 40; band at most 96, with 8 tiles of 180 px or more; tabs 32; summary row 56; two chart rows of about 320 px, in two columns up to 744 px. First screen: band, tabs, summary and all charts of the open tab.

Recomposition: 1280×900 uses 16 px gutters and 140 px tiles. 1600×700 scrolls without clipping. 1920×940 caps plots at 720 px. 2560×1145 and 2560×1250 use three columns. 3840×2160 uses `zoom: 1.5`. With FLIGHT open, repeat 1600×1000, 1920×940 and 2560×1145.

Evidence: each tab at the three test sizes in both themes; 2560×1145 per tab, dark; each state at 1600×1000, dark; today's page. Record provenance per `docs/runbooks/visual-qa.md`.

Planned by FAO-1 (Mission Control).

