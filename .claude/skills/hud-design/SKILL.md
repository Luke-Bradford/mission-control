---
name: hud-design
description: The checklist for any ticket, plan or review that touches apps/web. Use when planning a screen, building one, reviewing a web PR, or judging whether a page is production tier.
---

# HUD design checklist

Rules: `docs/design/system.md` (§ below). Each item is yes or no. For a reviewer, a no on an
**[I]** item is an Important finding; any other no is Minor.

## Plan

- [ ] The page's one question, and each panel's one purpose (§1).
- [ ] Each figure has a label, definition, window and unit (§5–7).
- [ ] The API returns what the page shows; a tab fetches when opened (§8–9).
- [ ] A new page or changed layout has a mockup first.

## Build

- [ ] **[I]** Tokens only: spacing 4/8/12/16/24/32/48, type from the scale, no text under 12 px
      except 11 px mono labels (§2–4).
- [ ] **[I]** Nothing clips; lists scroll visibly; no fixed height that hides rows (§5–7).
- [ ] **[I]** Every state has a word or shape as well as colour (§2–4).
- [ ] **[I]** Empty, loading, error, stale and disconnected states exist; never "No data" (§5–7).
- [ ] **[I]** Keyboard reachable, named, focus-visible, 24×24 px targets (§8–9).
- [ ] At most four lines of text per box; tables follow §5–7.
- [ ] A clock tick does not re-render the page (§8–9).

## Check before reporting

- [ ] 1280, 1600 and 1920 wide, 1600×700, light and dark (§8–9).
- [ ] Empty, one, many (50 rows) and long text (300-character title).

## Review

Record the `design` check (pass, fail or n-a) with the failing items quoted. Cite `hud-shot:<id>`
references when screenshots exist. It is recorded, not a merge gate, until PR heads can be
rendered. A finding cites its section; "looks wrong" is not a finding.
