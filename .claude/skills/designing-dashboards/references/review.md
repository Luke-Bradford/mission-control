# Render and review

Step 7, and the method for critiquing someone else's page. Reading the code is not a review of a visual
thing. Render it, look at it, then measure.

## Before looking: set up a fair render

- **Data**: the test dataset from the brief, with known answers and the awkward cases (a figure off
  target, a missing value, a tiny base, an unfinished period, the longest label, a busy day). A page
  rendered with tidy sample data or an idle system hides most layout and honesty problems.
- **Viewport**: the reader's real one, written down in advance ([layout](layout.md)), plus one narrower
  and one wider. Scrollbars visible.
- **Themes**: each one the product supports.
- **Arrival**: reach the page the way the reader does, through the app's navigation, not only by its
  direct address. Styles left over from the previous page are a real class of bug.
- **Settled**: wait for data and fonts to load before capturing.

Take a whole-page screenshot first and look at it before any crops.

If you have no means of rendering, say so in your report, list the checks below that you could not run,
and do not describe the page as reviewed or finished. Label collisions, wrapped headers and panels cut by
the fold are found on screen and almost never on paper.

## The checks, in order

### 1. Truth

- [ ] Every figure on the page matches the known answer from source, at the stated rounding.
- [ ] A figure that appears twice (tile and chart, chart and table) agrees with itself.
- [ ] Totals equal the sum of their parts, or the page says why not.
- [ ] Bars start at zero. No axis is cropped to dramatise. Any non-zero or log scale is labelled.
- [ ] Comparisons are like for like; unfinished periods are marked.
- [ ] Changes on small bases are shown as absolute numbers.
- [ ] Missing, zero, stale and estimated are each distinguishable.
- [ ] The good direction is right for every figure, including the lower-is-better ones.

### 2. Purpose and attention

- [ ] **Five-second test.** Look for five seconds, look away, and write what the page said. It should be
      the answer to the page's question.
- [ ] **Squint test.** Blur your eyes or the screenshot. What stands out should be the primary item and
      whatever needs attention; no decoration, heading or healthy figure should compete.
- [ ] **So-what test.** For each panel: what would the reader do differently because of it? No answer,
      no panel.
- [ ] The first screen answers the question at the real viewport without scrolling or clicking.
- [ ] If something is wrong in the data, it is visible on the first screen and the next step is beside it.
- [ ] If nothing is wrong, the page is calm.

### 3. Form

- [ ] Each figure's form suits its job ([chart-selection](chart-selection.md)); no gauges, 3D, crowded
      pies or dual axes.
- [ ] Every chart has a title with unit and window, readable axes and direct labels or an ordered legend.
- [ ] No labels overlap each other, the axes or the marks, at any tested width.
- [ ] Every headline figure has a comparison and a definition within one interaction.

### 4. Composition

- [ ] Size and position follow rank. The primary is the largest and is where reading starts.
- [ ] Panels are sized to their content: none stretched, none half empty, none crushed.
- [ ] Related things are grouped; edges align; spacing comes from one scale.
- [ ] Tables: numbers right-aligned in tabular figures, one measure per column, labels close to values.
- [ ] Nothing clips. Free text that truncates has an ellipsis and a way to read it in full. Numbers,
      units, statuses and identifiers are never truncated.
- [ ] The narrow and wide renders recompose sensibly, with no holes and nothing lost.

### 5. States, access and interaction

- [ ] Each panel seen loading, empty, in error, stale and partial ([states-and-interaction](states-and-interaction.md)).
- [ ] Text contrast 4.5:1, marks and controls 3:1, in every theme ([colour-and-accessibility](colour-and-accessibility.md)).
- [ ] Still correct in greyscale and under a red-green deficiency simulation.
- [ ] Every control reachable and operable by keyboard, with visible focus.
- [ ] Each chart has a text alternative or table view.
- [ ] Current filters and time range are visible; reset works; the view survives a reload.
- [ ] Live updates do not move the layout, lose scroll position or steal focus.

If the reader acts on the page or it shows live things, add the checks at the end of
[operational-consoles](operational-consoles.md).

### 6. Polish

- [ ] One term per concept; labels in the reader's words; no internal names, codes or raw timestamps.
- [ ] Consistent number formats, date formats and capitalisation.
- [ ] No leftover placeholder text, debug output or sample values.

## Symptom to fix

| What you see | Likely cause | Fix |
| --- | --- | --- |
| A wall of equal-sized cards | No ranking was done | Rank items; enlarge the primary; fold lone figures into the panels they explain |
| A big number with nothing beside it | No comparison chosen | Add target, previous period or range; if none exists, question why it is a headline |
| Red and green everywhere | Status colour used as decoration | Neutral by default; colour only what crosses a threshold; add a second cue |
| Everything flagged the same | No severity | Order by size of miss; give the worst the strongest treatment and the rest a quieter one |
| The eye goes to the logo, a header bar or a gradient | Chrome is louder than data | Mute the chrome; remove fills and shadows |
| A chart nobody can summarise in a sentence | Built from available data, not from a question | Write the question; choose the form again or delete the chart |
| A legend with ten entries | Too many series | Small multiples, the largest few plus "Other", or highlight one and grey the rest |
| Rotated or overlapping axis labels | Wrong orientation or too many ticks | Horizontal bars; fewer ticks; shorter date formats |
| A label far from its value in a wide table | Table stretched to fill the screen | Size columns to content; cap the table; give spare width to another panel |
| Two measures in one cell ("19 / 8") | Columns saved at the reader's expense | One column per measure, or value plus a signed change |
| A panel that is mostly padding | Template grid, not content sizing | Size from content; merge with a neighbour |
| The first screen ends mid-table and the answer is below | Vertical budget never worked out | Budget the first screen; tighten, merge or move detail down |
| A sudden drop at the right-hand end of a line | Unfinished period plotted as complete | Dash it, hollow the point, or leave it off; compare like for like |
| A dramatic +100% | Tiny base | Show the absolute change |
| `0`, `NaN`, `null` or blanks | Missing data not handled | Dash plus reason; exclude from averages and say so |
| The same figure with two values | Two definitions or two roundings | One definition, one formatter, one source |
| A spinner over the whole page | States not designed per panel | Per-panel placeholders; keep old data while refreshing |
| Looks fine in the code review, wrong on screen | Nobody rendered it | Render at the real viewport with real data before sign-off |

## Writing up a review

- Lead with a one-line verdict.
- Say what works, specifically, so it is kept.
- List findings in the order above. Each one says which part of the page, the problem as a reader meets
  it, why it matters and what to do. Report everything you found; then mark each as blocking, should fix
  or minor.
- Where you can, put the page in front of someone like its reader, say nothing, and ask what it tells
  them. One such look outweighs most of this list.
- Attach the screenshots you judged from, with viewport, theme and dataset noted. Keep evidence small
  enough that someone will read it.
- State what you did not check.
- Passing measurements (no overflow, tests green) do not make a design pass. A page that hides its answer
  below the first screen fails however far it scrolls.
