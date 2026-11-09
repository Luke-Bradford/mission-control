---
name: designing-dashboards
description: Use when planning, building, redesigning or reviewing a dashboard, report, scorecard, status board, KPI or metrics page, or any screen or document whose job is to show figures; and for an admin panel, ops console, queue or control-room page where the reader watches live things and acts on them. Also use when choosing a chart, laying out stat tiles, picking chart colours, or asked whether a data page is any good.
---

# Designing dashboards and data pages

A data page exists so that one kind of reader can make one kind of decision faster. Every choice here
follows from that: what goes on the page, what form each figure takes, where it sits and how loud it is.

This skill is stack-neutral and client-neutral. Three things outrank it, in this order: what the reader
has asked for, the project's own design system or UI skill (tokens, components, viewports), and only then
the defaults below. If the project has such a system, load it as well and say where you departed from it.
If a charting skill is available (colour formulas, mark specifications), use it for chart internals.

## The work, in order

Each step has an output. Write the outputs down in the plan, ticket or PR; they are what a reviewer checks.

| Step | Output | Reference |
| --- | --- | --- |
| 1. Brief | Reader, decision, cadence, device, page type, and the page's question in one sentence | [brief-and-metrics](references/brief-and-metrics.md) |
| 2. Figures | A definition for each figure: formula, unit, window, source, comparison, which direction is good, threshold | [brief-and-metrics](references/brief-and-metrics.md) |
| 3. Form | One form per figure (number, table, chart type) with a one-line reason | [chart-selection](references/chart-selection.md), [tiles-tables-numbers](references/tiles-tables-numbers.md) |
| 4. Composition | Each item ranked primary, supporting or detail; sizes taken from content; a sketch at the reader's real viewport | [layout](references/layout.md) |
| 5. Colour and type | A role for every colour; text and marks that pass contrast; nothing carried by colour alone | [colour-and-accessibility](references/colour-and-accessibility.md) |
| 6. States and interaction | Loading, empty, error, stale and partial for every panel; filters, drill-down and tooltips | [states-and-interaction](references/states-and-interaction.md) |
| 7. Render and review | Screenshots with awkward, realistic data; figures reconciled to source; the review list run | [review](references/review.md) |

A report, slide or PDF follows the same steps with the differences in [reports](references/reports.md).

If the reader acts on the page, or it shows things with a life of their own (jobs, agents, orders,
machines, tickets), also read [operational-consoles](references/operational-consoles.md): status and
liveness, the attention queue, actions, timelines and logs, noise.

Do not start at step 3. Most weak dashboards are a set of charts chosen before anyone wrote down the
question, and no amount of styling repairs that.

## Rules that hold on every data page

1. **One question per page.** If you cannot write it in a sentence, the page is two pages.
2. **Every headline figure is compared with something**: a target, the previous period, a normal range
   or its own history. A lone number tells the reader nothing about whether to act. Rows in a lookup
   table or a record's detail are exempt.
3. **Every figure is defined**: label, value, unit, time window and, within one interaction, how it is
   calculated and when it was last updated.
4. **The same figure is the same number everywhere** it appears, to the same rounding.
5. **Size follows importance.** The thing the reader came for is the largest and is placed where reading
   starts. Equal-sized panels say everything matters equally.
6. **Position and length carry quantity.** Use bars, lines and dots before area, angle or colour
   intensity. Bars start at zero.
7. **Colour is for meaning.** Neutral by default; colour for state, category or emphasis; never the only
   signal. Alarm colours appear only when something needs attention.
8. **What needs attention is visible without interaction**, with the route to act on it beside it.
9. **Missing is not zero.** Unknown, not applicable, still loading and stale each look different from a
   real `0`.
10. **Nothing is decoration.** No 3D, gradients, shadows or icons that carry no information. If removing
    it loses nothing, remove it.
11. **Judge the render, not the code.** Look at it at the reader's real viewport with busy, awkward data
    before saying it is done.
12. **Never drop content silently.** If something has to move or go, list it and say where it went.

## Reviewing or critiquing a data page

Look at the rendered page first. Work through these six in order. A page that is wrong about its numbers
or its purpose is not rescued by good spacing, so later sections matter less until earlier ones pass.

1. **Truth**: figures that disagree, misleading scales, deltas on tiny bases, estimates shown as facts.
2. **Purpose and attention**: can you state the page's question, does the first screen answer it, and
   is the most prominent thing the one that needs action?
3. **Form**: is each figure in a form that suits it?
4. **Composition**: hierarchy, grouping, panel sizes, wasted or crushed space.
5. **States, access and interaction**: empty, error, stale; contrast, keyboard, non-colour cues.
6. **Polish**: alignment, spacing, wording.

Write each finding so the builder can act without asking: which part of the page, the problem as a
reader meets it, and what to do. Report everything you find, then give each a severity. The checks and
a symptom-to-fix table are in [review](references/review.md).

## Fallback look

For when neither the reader nor the project has a visual direction. Calm and plain: a neutral background,
flat panels separated by space or a hairline, one text family with tabular figures, dark grey text, a
single accent colour, and the status colours kept for status. Dense enough to compare without scrolling,
loose enough that groups are obvious. It should look like a tool someone uses every day, not a poster.

## Sources

The rules above are the common ground of the published literature and the major design systems. What each
source supports, with links, is in [sources](references/sources.md). Cite it when a client asks why.
