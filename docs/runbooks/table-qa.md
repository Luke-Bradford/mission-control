# Table QA

Use this check when a PR changes a table, report grid or its available page space.
The [design system](../design/system.md) remains the source for dimensions and severity.
Check whether someone can read, compare and act on the content of the settled page.
Automatic overflow checks support that judgement; they do not replace it.

## Inspect the rendered page

Use the real application shell with its navigation, footer and applicable rail states.
Wait for populated content before measuring. An isolated component capture has narrower coverage;
label it as such and record any missing application-level check.

At the design system's widths, short height and themes, inspect representative populated rows,
one row, empty states, 50 rows and long allowed content. Include the loading/error states that
the PR affects. Check these points for each changed table:

| Check | Observation to record |
| --- | --- |
| Column allocation | Identity, description and environment columns have useful room. Counts and status columns fit their content without squeezing other columns. Inspect both ordinary and long values. |
| Headings and units | Labels, sort indicators, units and values remain legible. A clipped unit or ambiguous header is a finding. |
| Alignment | Header and body tracks line up. Numbers use tabular figures and align right. Text, wrapped rows and actions retain a clear relationship. |
| Padding and density | Cell padding and row heights follow the approved density. Avoid wasted space that squeezes adjacent content or needlessly reduces visible rows. Keep text and control minimums. |
| Full content | Permitted truncation is indicated. Reach the complete value using the keyboard and the rendered detail or expansion. A hover title or accessible name alone does not prove visible full-content access. |
| Scrolling and actions | Reach the last row and every action using the keyboard. Confirm focus is visible, scroll regions are discoverable and the footer is reachable. Check the outer page as well as the table bounds. |
| Comparison | Read several adjacent rows with realistic values. Confirm the layout makes identities, differences, missing values and states clear. |

Do not fix squeezed content by shrinking fonts or controls below the design rules.
Stack panels, adjust columns, wrap appropriate text or provide a bounded accessible scroll region
according to the approved layout. Do not require every table to have equal column widths.

## Keep reviewable evidence

Retain a viewport pair showing page context and a matching focused pair for the changed table.
If a larger layout changes, capture enough page context to show its effect. A full-page capture
can supplement the viewport; it cannot prove what fits in a screenful.

Use the same viewport, theme, data, clock and scroll position on both sides where applicable.
Name the baseline and rendered source commits, fixture or live-data scope, and capture region.
If a new table has no prior equivalent, show the actual prior page and explain the difference.
Keep original context images when cropping. A diff image supplements the before/after pair.
Regenerate evidence after layout corrections and bind it to the corrected source.

## Record the result

Use the existing QA report fields; this check adds no report schema or automated merge gate.
In the `design` note, identify each inspected table, viewport/theme/rail cases and concrete
observations about allocation, alignment, padding and full-content access. Link the retained
image pairs and check receipts through the report's evidence fields.

Put failures in `findings`, with the affected surface, reproduction, screenshot and concrete fix.
Fold a correction into the current PR when it belongs to that outcome. Otherwise use a named
ticket or the existing minor-findings list, with a reason and disposition in `followUps`.
Record fixes and their rechecks; do not silently remove the earlier failure.

Use `limitations` for untested surfaces, states and data. Say whether a reviewer rendered the
page independently or inspected supplied images. Do not generalise a component or fixture
check into an assertion that the whole site passed. Keep the immutable report permalink in
the PR, ticket handoff and rework message so later readers can see what was covered.
