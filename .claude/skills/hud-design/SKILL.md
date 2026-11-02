---
name: hud-design
description: The checklist for any ticket, plan or review that touches apps/web. Use when planning a screen, building one, reviewing a web PR, or judging whether a page is production tier.
---

# HUD design checklist

The rules are in `docs/design/system.md`; each item cites its section. A no on an **[I]** item
is an Important finding; any other no is Minor.

## Plan

- [ ] The page's one question; each panel's one purpose (§1).
- [ ] Each stat has a label, value, definition, window and unit (§5–7).
- [ ] The API returns what the page shows; a tab fetches when opened (§8–9).
- [ ] A new page or big visual change has a mockup first (direction principle 6).

## Build

- [ ] **[I]** Tokens only: spacing 4/8/12/16/24/32/48; no text under 12 px except 11 px mono
      labels (§2–4).
- [ ] **[I]** Nothing clips; lists scroll visibly (§5–7).
- [ ] **[I]** Every state has a word or shape as well as colour (§2–4).
- [ ] **[I]** Empty, loading, error, stale and disconnected states exist; never "No data" (§5–7).
- [ ] **[I]** Every control is keyboard reachable, named, focus-visible and 24×24 px (§8–9).
- [ ] At most four lines of text per box (§5–7).
- [ ] Tables: 40 px rows (32 compact), right-aligned tabular numbers, a visible sort,
      `—` for unknown (§5–7).
- [ ] Table widths suit their content: identifiers have useful space; numeric columns fit
      their headings, units and values without taking space needed elsewhere.
- [ ] **[I]** Headers, units, values and actions remain readable and reachable. Any permitted
      truncation has a visible indication and keyboard access to the full content.
- [ ] Header and body alignment, cell padding and row spacing support scanning and comparison.
      Avoid empty space that squeezes useful content or hides useful rows.
- [ ] A clock tick does not re-render the page (§8–9).

## Check

- [ ] Tests cover empty, one, many (50 rows) and long text.
- [ ] 1280, 1600, 1920 wide, 1600×700, light, dark (§8–9), rendered in a browser test.
- [ ] For changed tables, run [the table QA check](../../../docs/runbooks/table-qa.md).
      Check the settled page with navigation and rail present, not only an isolated component.

## Review

- [ ] The Build items hold in the diff and on the rendered page.
- [ ] The first screenful answers the question, key item top left (§1).
- [ ] No empty panels or lone-number tiles (§5–7).
- [ ] Record per-table observations, image references and remaining findings in the QA report.
      Passing geometry checks alone does not establish that columns use space well.

Record the `design` check: pass (every [I] item is yes on the rendered page), n-a (nothing
visible changes, or you could not render it: say why in its note and your summary) or fail
(quote the items). It does not hold the merge; Important findings do. Judge rendered-page items
on the page you render. Only a check against live data is a "Controller check: …".
