---
name: hud-design
description: Plan, build and review visible interfaces, including dashboard layouts, native mockups and shared styles. Check rendered composition, usability and accountable visual evidence alongside technical correctness.
---

# HUD design checklist

Use `docs/design/system.md` (sections cited). A failed **[I]** item is Important; other failures are Minor.
Mockups count. [Visual QA](../../../docs/runbooks/visual-qa.md) covers planning, evidence and sign-off.

## Plan

- [ ] One question per page; one purpose per panel (§1).
- [ ] Content: the reader, and which items belong (§1).
- [ ] Dashboards: rank and size panels per [composition](references/dashboard-layout.md): real viewport, first-screen fields, normal rows, budgets.
- [ ] Stats: label, value, definition, window, unit (§5–7).
- [ ] Page-shaped APIs; tabs fetch on opening (§8–9).
- [ ] Mockups precede new pages and big changes.

## Build

- [ ] **[I]** Tokens: spacing 4/8/12/16/24/32/48; text minimum 12 px, except 11 px mono labels (§2–4).
- [ ] **[I]** Nothing clips without an ellipsis; lists scroll visibly (§5–7).
- [ ] **[I]** States have words/shapes alongside colour (§2–4).
- [ ] **[I]** Empty/loading/error/stale/disconnected states; never "No data" (§5–7).
- [ ] **[I]** Controls: keyboard reachable, named, focus-visible, minimum 24×24 px (§8–9).
- [ ] Maximum four text lines per box (§5–7).
- [ ] Tables: 40 px rows (32 compact), right-aligned tabular numbers, visible sort, unknown `—` (§5–7).
- [ ] Content-aware columns, aligned headers, useful density.
- [ ] **[I]** Readable labels/units/actions; only free text truncates, keyboard reaches full text.
- [ ] Clock ticks do not rebuild pages (§8–9).

## Check

- [ ] Empty, one, 50 rows, long content.
- [ ] Browser: 1280/1600/1920 widths, 1600×700, light/dark (§8–9), [dashboards](references/dashboard-layout.md#viewports-use-the-real-ones); also arrive from Overview by the nav.
- [ ] [Table QA](../../../docs/runbooks/table-qa.md): settled context, then details.

## Review

- [ ] Build items hold in diff and render.
- [ ] **[I]** First screen answers the declared question (§1) at real viewports with busy data: clear hierarchy, content-sized panels. Fit or scroll reachability alone cannot pass.
- [ ] No empty panels/lone-number tiles (§5–7).
- [ ] **[I]** Every item is for the page's reader; no raw ids or internal notes.
- [ ] Record observations, images, findings, limits; geometry alone is insufficient.

Record `design`: pass (every [I] passes on your render), n-a (no visible change), fail (quote failures; also a visible change nobody rendered). A fail holds the merge; the round cap never waives it. Only live-data checks are a "Controller check".
