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
- [ ] Tables: 40 px rows, right-aligned numbers, a visible sort, `—` for unknown (§5–7).
- [ ] A clock tick does not re-render the page (§8–9).

## Check

- [ ] Tests cover empty, one, many (50 rows) and long text.
- [ ] 1280, 1600, 1920 wide, 1600×700, light, dark (§8–9); if you cannot render them,
      report a "Controller check: …".

## Review

- [ ] The Build items hold in the diff.
- [ ] The first screenful answers the question, key item top left (§1).
- [ ] No empty panels or lone-number tiles (§5–7).

Record the `design` check: pass (every [I] item the diff shows is yes; list the rest as
Controller checks), n-a (nothing visible changes) or fail (quote the items). It does not hold the merge; Important findings do. A rendered-page item is a
"Controller check: …", not a finding.
