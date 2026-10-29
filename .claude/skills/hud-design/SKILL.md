---
name: hud-design
description: The checklist for any ticket, plan or review that touches apps/web. Use when planning a screen, building one, reviewing a web PR's screenshots, or judging whether a page is production tier.
---

# HUD design checklist

The rules and their reasons are in `docs/design/system.md` (sections cited as §n). This is the
list you run against a screen. Each item is a yes or a no. For a reviewer, a no on an item marked
**[I]** is an Important (blocking) finding; a no on any other item is Minor. A reviewer may also
cite a section of the system that this list does not repeat.

## Before building (planner, developer)

- [ ] **One question.** The plan names the one operator question the page answers, and each
      panel's one purpose (§1). Two questions: split or move one.
- [ ] **Figures defined.** Each figure has a label, a definition, a window and a unit. A figure
      shown on more than one page comes from `packages/core/src/metrics.ts`; a single-page figure
      states its definition in the component (§5 Stat).
- [ ] **Useful, not decorative.** For each element: which decision changes if it is wrong or
      missing? None: cut it (§1).
- [ ] **Data shape.** The API returns what the page shows; no filtering, joining or sorting of
      large sets in the browser; under 60 KB gzipped on open; a tab's data fetched when the tab
      opens (§9).
- [ ] **Mockup first** for a new page or a changed layout, in `docs/mockups/`, screenshot-checked
      before the build; a gap in an existing screen is a ticket, not a mockup (direction
      principle 6; FLIGHT.md).

## While building (developer)

- [ ] **[I]** Spacing from the scale 4/8/12/16/24/32/48 in new code (§2).
- [ ] **[I]** Type from the tokens; no word under 12 px except mono micro-labels at 11 px (§3).
- [ ] **[I]** No fixed height that can clip; `grid-auto-rows: auto`; a scrolling list has a
      visible scrollbar (§2).
- [ ] Running text at most four lines per box, longer content linked (conversation views
      excepted) (§2).
- [ ] Tables: 40 px rows (or 32 px compact), numbers right-aligned and tabular, `—` for unknown,
      one sorted column, two-line wrap then truncate with a title and full accessible name,
      header stays while scrolling (§5).
- [ ] **[I]** Every state has two signals: word plus colour, or shape plus colour (§4).
- [ ] **[I]** Empty, loading, error, stale and disconnected states exist and follow §5; none
      says "No data".
- [ ] What the operator needs often is open without a click; at most two disclosure levels; the
      control says what it opens (§5).
- [ ] A clock tick re-renders the clock, not the page; nothing runs while the tab is hidden (§9).
- [ ] **[I]** Keyboard: every control reachable, `:focus-visible` present, targets 24×24 px,
      every control named (§8).

## Edge cases to render before calling it done

- [ ] Empty (no runs, no PRs, no findings).
- [ ] One item, and many (50 rows; all seats; 400 files).
- [ ] Long text (a 300-character ticket title, a 120-character path; a 2,000-character message
      in a conversation view).
- [ ] 1280, 1600 and 1920 wide at 1000 tall, and 1600×700; light and dark (§2).
- [ ] A held or parked state, a failed state, and a stale one (no update for an hour).

## Reviewing (RETRO; FLIGHT's product pass)

Review the rendered pages, not only the diff. Until the hub attaches screenshot pairs to web PRs
(#986), the author attaches screenshots of each touched page at the sizes above and FLIGHT may
use `screenshot_hud`. For each page the PR touches:

- [ ] **[I]** Nothing clipped, overlapped or cut; the page or panel scrolls where content is
      taller (§2).
- [ ] **[I]** Spacing and type on the tokens in the changed code; nothing under the floor (§2, §3).
- [ ] The first screenful answers the page's question; the most important thing is top left (§1).
- [ ] No over-padding (empty panels, a tile with one number and no context, double gutters) and
      no over-density (more than four lines in a box, more than one status pill per row) (§2, §5).
- [ ] **[I]** The edge cases above render correctly; the PR shows at least empty, long and many.
- [ ] The design pass is recorded: as the `design` review check once #1019 adds it, and until
      then as one line in the review summary, "design: pass" or "design: fail" with the failing
      items quoted from this list.

A finding cites the section it rests on. "Looks wrong" is not a finding; "tile labels at 10 px,
§3 floor is 12 px" is. A clean PR is never held for taste (RETRO.md).
