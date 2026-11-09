# Choosing a form

Step 3. Decide what the reader needs to see in the data, then pick the form that shows it most accurately.

## First: does it need a chart?

| The reader needs | Use |
| --- | --- |
| One value, now | A number with its comparison ([tiles-tables-numbers](tiles-tables-numbers.md)) |
| Exact values, or to look up a row | A table |
| A shape: trend, gap, ranking, outlier, spread | A chart |
| Many values for many items, to scan for the odd one | A table with a small in-row mark, or a heatmap |

A chart of two numbers is a sentence. Write the sentence.

## How accurately people read each encoding

From most to least accurate, per the perception research in [sources](sources.md):

1. Position on a shared scale (dot plot, line chart, aligned bars)
2. Position on separate but identical scales (small multiples)
3. Length (bars)
4. Angle and slope (pie, slope chart)
5. Area (bubbles, treemap)
6. Colour intensity (heatmap, choropleth)

Use the highest one that fits. Go lower only when it buys something specific, such as a heatmap showing a
whole grid at once, and accept that readers will see pattern, not values.

## What do you want to show?

| Relationship | Good defaults | Avoid |
| --- | --- | --- |
| **Change over time** | Line; columns for a few discrete periods; area only for a single total | More than about five lines on one plot; stacked areas where the layers matter |
| **Comparison between items** | Horizontal bars, sorted; dot plot when zero is not meaningful | Unsorted bars; vertical bars with long labels |
| **Ranking** | Sorted horizontal bars; a ranked table with in-row bars | Pie or donut |
| **Part of a whole** | One stacked bar; sorted bars with share labelled; pie or donut for two or three parts only | Pies with many slices; several pies side by side |
| **Against a target** | Bullet graph; bar with a target mark; number with gap to target | Gauges and dials |
| **Deviation from a reference** | Diverging bars from a zero line; line with a reference band | Two separate charts the reader must subtract |
| **Distribution** | Histogram; box plot or strip plot for groups; percentiles as lines over time | An average alone when the spread is the story |
| **Relationship between two measures** | Scatter plot, with a trend line if useful | Dual-axis line charts |
| **Many series, same measure** | Small multiples on identical axes | A tangle of lines with a twelve-item legend |
| **Two-way grid** (hour by weekday, cohort by month) | Heatmap with one hue | Rainbow scales |
| **Flow between stages** | Funnel as sorted bars with conversion labelled; Sankey only for real many-to-many flow | Decorative funnel shapes whose area means nothing |
| **Place** | A map only when geography is the question; otherwise bars by region | Choropleth of raw counts (it shows population) |

## Rules by form

**Bars.** Start at zero, always; the length is the value. Sort by value unless the categories have their
own order (time, age band, stage). Horizontal when labels are words. Label values directly when there are
few bars. Gap between bars about half a bar width. In a stacked bar only the bottom segment and the total
can be compared accurately, so stack only when the total is the point, and put the series that matters at
the bottom.

**Lines.** Time runs left to right at even intervals. The scale need not start at zero, but say so with
visible axis labels, and never crop it to make a small change look dramatic. Mark an unfinished period
differently (dashed, or a hollow last point) or leave it out. Show a gap for missing data; do not draw a
line through it or drop to zero. Label lines at their ends in place of a legend where there is room.
Compare with a previous period by drawing it as a thin grey line behind.

**Sparklines.** A word-sized line with no axes, for trend direction beside a number. End on a dot for the
current value. Give every sparkline in a column the same time span. Say in the column header or tile what
span it covers.

**Bullet graph.** One bar for the value, a short cross-line for the target, and optionally two or three
background bands (poor, fair, good) in shades of one neutral. It replaces a gauge in a fraction of the
space and stacks well in a list.

**Pies and donuts.** Only for parts of one whole, two or three slices, where the message is roughly "a
third" or "most". Start at twelve o'clock, largest first, label slices directly. A donut may carry the
total in the centre. Never use one to compare across categories or over time.

**Heatmaps.** One hue from light to dark for magnitude; two hues meeting at a neutral midpoint only when
there is a meaningful middle (zero, target). Print the number in the cell if the grid is small. Give a
legend with the scale.

**Scatter plots.** Label axes with units. Use transparency when points overlap. Annotate the outliers the
reader will ask about.

**Small multiples.** Same axes, same scale, same order in every panel, unless the panels have such
different magnitudes that a shared scale flattens the small ones; then use separate scales and say so.

**Tables as charts.** A table with a bar or sparkline in each row is often the best "chart" for ten to
fifty items. See [tiles-tables-numbers](tiles-tables-numbers.md).

## Axes, labels and legends

- Every chart has a title saying what it shows, with unit and window: "On-time delivery, % by day, last
  14 days". On a report, the title may state the finding instead ([reports](reports.md)).
- Four to six gridlines at round steps, drawn faint. No chart border, no tick marks that add nothing.
- Axis labels are horizontal. If they do not fit, flip the chart or shorten the labels; do not rotate.
- Put units in the title or axis once, not on every tick.
- Prefer direct labels to a legend. If a legend is needed, put it in the order the series appear.
- Reference lines (target, average, threshold) are labelled on the line.
- Annotate the events that explain a jump: "price change", "outage". One note saves a meeting.

## Scales

- One measure per axis. Two different measures on left and right axes invite a false reading of where
  the lines cross; use two aligned charts sharing the time axis.
- Do not use a logarithmic scale for a general audience without saying so plainly.
- Keep the scale fixed when the reader compares the same chart over time or across filters, so a change
  in the picture means a change in the data. Let it adapt when magnitude varies too much to share.
- Choose the chart's proportions so the typical slope of a line is neither flat nor steep. Wide and
  short (around 3:1 to 5:1) suits a time series; near-square suits a scatter plot.

## Forms to avoid, and what to use

| Avoid | Why | Use |
| --- | --- | --- |
| Gauge, dial, speedometer | Large area for one value; hard to compare several | Number with target, or bullet graph |
| 3D of any kind | Distorts length and hides marks | The flat version |
| Dual-axis lines | The crossing point is an artefact of scaling | Two stacked charts on one time axis, or index both to 100 |
| Donut with many slices | Angles and areas compare poorly | Sorted bars |
| Stacked area with many layers | Only the bottom layer has a flat baseline | Small multiples, or lines |
| Radar or spider chart | Shape depends on axis order; areas mislead | Grouped bars or a table |
| Bubble for a single measure | Area is read poorly | Bars |
| Word cloud | Size reflects word length as much as count | Sorted bars of top terms |
| Truncated bar axis | Exaggerates differences | Zero baseline, or a dot plot |
| Traffic-light cell fills everywhere | Everything shouts; fails without colour vision | Neutral cells; mark exceptions only, with an icon or text |
