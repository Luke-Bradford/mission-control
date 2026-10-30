# HUD design system

The operating rules for every Mission Control screen. Read this first; the page catalogue,
mockups and [FLIGHT details](flight-deck.md) are the deeper reference.

## 1. Purpose

One page answers one operator question. Put its most important answer at top left. Keep only
data that changes a decision; detail is one click away.

## 2–4. Tokens, type and colour

Use `apps/web/src/hud.css` tokens only. Spacing is 4, 8, 12, 16, 24, 32, 48 px; gutters are 24
px (16 below 1600); panel padding is 16. Type is 20/28 page title, 14/20 panel title, 13/20 body,
12/16 secondary. Never use text below 12 px, except 11 px mono micro-labels. Use role colours:
accent, ok, warn, crit, think and neutral. State always has a word or shape as well as colour.

## 5–7. Components, density and detail

Panels have one purpose and no clipping. Lists scroll visibly; never use a fixed height that can
hide content. A stat has a label, value, definition, window and unit. Tables use 40 px rows (32
compact), right-aligned tabular numbers, a visible sort, `—` for unknown, and two-line truncation
with the full accessible name. Use empty, loading, error, stale and disconnected states; never
say “No data”. Keep running text to four lines per box. Use tabs for alternatives and sections for
comparison; show common actions without a click.

## 8–9. Accessibility, performance and review

Controls are keyboard reachable, named, focus-visible and 24×24 px minimum. Shape APIs for the
page; fetch a tab when opened; do not re-render a page for a clock tick. Check 1280, 1600 and
1920 widths, 1600×700, light and dark, and empty, long and many-item states. RETRO records a
`design` check for the QA board. It is not a merge gate until PR-head rendering is available.

## 10. Change control

Change a rule with a PR and screenshot. The catalogue says what a page shows; this document says
how it behaves. A no on an [I] item of the hud-design checklist is an Important finding; any
other no is Minor. Neither is a taste call.
