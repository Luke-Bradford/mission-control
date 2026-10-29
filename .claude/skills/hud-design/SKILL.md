---
name: hud-design
description: The checklist for any ticket, plan or review that touches apps/web. Use when planning a screen, building one, reviewing a web PR's screenshots, or judging whether a page is production tier.
---

# HUD design checklist

The rules are in `docs/design/system.md`. This is the list you run against a screen. Every item
is a yes or a no; a no is a finding, and for a review it is blocking.

## Before building (planner, developer)

- [ ] **One question.** Write the one operator question this page or panel answers. If it
      answers two, split it or move one.
- [ ] **KPIs defined.** Each figure has a name, a definition, a window and a unit from the metric
      registry (`packages/core/src/metrics.ts`). A figure without a definition is not built.
- [ ] **Useful, not decorative.** For each element: which decision changes if it is wrong or
      missing? None: cut it.
- [ ] **Data shape.** The API returns what the page shows; no filtering, joining or sorting of
      large sets in the browser. Payload budget: 60 KB on open; per-tab data fetched on the tab.
- [ ] **Mockup first** for a new page or a changed layout (`docs/mockups/`), screenshot-checked
      before the build starts. A gap in an existing screen is a ticket, not a mockup.

## While building (developer)

- [ ] Tokens only: spacing 4/8/12/16/24/32/48; type from the six `--fs-*` tokens, nothing under
      12 px; colour by role; one seat palette.
- [ ] No fixed heights that can clip; `grid-auto-rows: auto`; a scrolling list shows a scrollbar.
- [ ] Text per box: at most four lines of running text; longer content links out.
- [ ] Tables: 32/40 px rows, numbers right-aligned and tabular, `—` for unknown, one sorted column,
      wrap to two lines then truncate with a title, header stays while scrolling.
- [ ] Every state has two signals (word plus colour, or shape plus colour).
- [ ] Empty, loading and error states exist and follow §5; none says "No data".
- [ ] Steps, lists and logs show what the operator needs often without a click; at most two
      levels of disclosure; the disclosure control says what it opens.
- [ ] A clock tick re-renders the clock, not the page; nothing runs while the tab is hidden.
- [ ] Keyboard: every control reachable, `:focus-visible` present, targets 24 px, names on
      controls, full path or title as the accessible name.

## Edge cases to render before calling it done

- [ ] Empty (no runs, no PRs, no findings).
- [ ] One item, and many (50+ rows; 20 seats; 400 files).
- [ ] Long text (a 300-character ticket title, a 2,000-character message, a 120-character path).
- [ ] Narrowest width 1366 and widest 1920; light and dark.
- [ ] A held or parked state, a failed state, and a stale one (no update for an hour).

## Reviewing (RETRO, FLIGHT's product pass)

Review the rendered screenshots, not only the diff. For each page the PR touches, at 1366, 1600
and 1920, light and dark:

- [ ] Nothing clipped, overlapped or cut; the page or panel scrolls where content is taller.
- [ ] Spacing and type match the tokens; no ad-hoc px; nothing under 12 px.
- [ ] The first screenful answers the page's question; the most important thing is top left.
- [ ] No over-padding (empty panels, tiles with one number and nothing else, double gutters)
      and no over-density (more than four lines of text in a box, more than one pill per row).
- [ ] The edge cases above render correctly (the PR shows at least empty, long and many).
- [ ] The design pass is recorded as a `design` check on the review, pass or fail, with the
      failing items quoted from this list.

A finding cites the section of `docs/design/system.md` it rests on. "Looks wrong" is not a
finding; "tile labels at 10 px, §3 says nothing under 12 px" is.
