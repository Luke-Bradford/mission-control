---
name: hud-design
description: The checklist for any ticket, plan or review that touches apps/web. Use when planning a screen, building one, reviewing a web PR, or judging whether a page is production tier.
---

# HUD design checklist

Use `docs/design/system.md` (sections cited below). A failed **[I]** item is Important; other failures are Minor.

## Plan

- [ ] One question per page; one purpose per panel (§1).
- [ ] Dashboards: apply [composition and responsive fit](references/dashboard-layout.md); record the reference CSS viewport/zoom/rail, essential fields and normal row count; declare the first-screen data and panel width/height budget before implementation.
- [ ] Stats: label, value, definition, window, unit (§5–7).
- [ ] Page-shaped APIs; tabs fetch on opening (§8–9).
- [ ] Mockups precede new pages/big visual changes (direction principle 6).

## Build

- [ ] **[I]** Tokens: spacing 4/8/12/16/24/32/48; text minimum 12 px, except 11 px mono labels (§2–4).
- [ ] **[I]** Nothing clips; lists scroll visibly (§5–7).
- [ ] **[I]** States have words/shapes alongside colour (§2–4).
- [ ] **[I]** Empty/loading/error/stale/disconnected states; never "No data" (§5–7).
- [ ] **[I]** Controls: keyboard reachable, named, focus-visible, minimum 24×24 px (§8–9).
- [ ] Maximum four text lines per box (§5–7).
- [ ] Tables: 40 px rows (32 compact), right-aligned tabular numbers, visible sort, unknown `—` (§5–7).
- [ ] Content-aware columns; aligned headers/body; useful padding/density without wasted space.
- [ ] **[I]** Readable headers/units/values/actions; indicated truncation with keyboard access to full content.
- [ ] Clock ticks do not rebuild pages (§8–9).

## Check

- [ ] Empty, one, 50 rows, long content.
- [ ] Browser: 1280/1600/1920 widths, 1600×700, light/dark (§8–9).
- [ ] [Table QA](../../../docs/runbooks/table-qa.md): inspect settled application context and focused details.

## Review

- [ ] Build items hold in diff and rendered page.
- [ ] **[I]** First screenful answers the page’s declared primary question at its normal reference viewport (§1). For dashboards, verify the operational content budget; eventual scroll reachability alone does not pass this check.
- [ ] No empty panels/lone-number tiles (§5–7).
- [ ] Record per-table observations, images, findings and limits; geometry alone is insufficient.

Record `design`: pass (every [I] passes on rendered page), n-a (no visible change or unable to render; explain in note and summary), fail (quote failures). It does not hold merges; Important findings do. Judge rendered items on your render. Only live-data checks are a "Controller check".
