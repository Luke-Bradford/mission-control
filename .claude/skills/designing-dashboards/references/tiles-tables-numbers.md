# Stat tiles, tables and number formatting

Most of a data page is numbers shown as numbers. This covers how.

## Stat tile (KPI card)

A tile answers "what is it, and is that good?" It needs, in reading order:

1. **Label**: the reader's name for the figure, with the window if it is not set page-wide ("On-time
   delivery · last week").
2. **Value**: the largest text on the tile, with its unit.
3. **Comparison**: one of target, previous period or normal range, stated as a signed change or a gap,
   with the baseline named in a word or two ("−2.4 pts vs last week", "3.6 pts below target").
4. **Optional trend**: a sparkline or small bar history, same span on every tile in the row.
5. **Definition and freshness** within one interaction (tooltip, info control, or a footnote).

Rules:

- **Colour the comparison by meaning, not by sign.** For a lower-is-better figure (cost, churn, response
  time, complaints) a rise is bad. For a neutral figure (volume, spend) a change is neither; keep it grey.
- **Pair colour with a second cue**: an arrow or sign, and words. "▲ 0.13 worse" survives greyscale;
  a red number does not.
- **Changes in a percentage are points, not percent.** 93.8% to 91.4% is −2.4 points.
- **Small bases do not get dramatic percentages.** 1 to 2 is "+1", not "+100%". Below a base you choose
  (often about ten), show the absolute change.
- **No target, no verdict.** If there is nothing to judge against, show the change in neutral colour.
- **Missing data shows a dash and a reason**, never `0`, `0%` or `NaN`.
- **A tile is not a container for one number in a sea of padding.** If a figure explains a chart or a
  table, put it in that panel's header. Use a row of tiles when the figures stand on their own; keep the
  row to one line, with equal-height tiles holding similar amounts of content.
- **Order tiles by importance or by the reader's reasoning** (volume, then quality, then cost), and keep
  that order everywhere.
- **If a tile filters or links, make the whole tile the control** and show that it is one.

**Tiles or a table?** Up to about six figures that the reader scans at a glance: a row of tiles. More
than that, or when every figure has a target and the reader compares the gaps: a short table of figure,
value, target, gap and trend. It aligns the comparisons and scales to a dozen figures where tiles do not.

## Tables

Tables are the right form for lookup, for exact values and for many attributes per item. They are
underused on dashboards.

- **Alignment.** Text left. Numbers right, with tabular (fixed-width) figures and the same decimal places
  down a column so digits line up. Headers align with their column's content.
- **One measure per column**, a bare number in each cell, and the unit and window in the header. "12k of
  200k used" in a cell cannot be scanned or sorted.
- **Sort by the column that answers the question**, show which column that is, and let the reader change
  it. Alphabetical is a default only for lookup tables.
- **Width from content.** Identity, status and number columns take what their longest realistic value
  needs. One free-text column takes the remainder up to a readable limit. A table stretched across a wide
  screen separates a row's label from its values.
- **Headers** stay on one or two whole lines. Never let a header break inside a word; shorten it and
  move the unit to a second line.
- **Rules and stripes.** Light horizontal rules or generous row spacing; no vertical rules; no heavy
  header fills. Stripe only very wide tables.
- **Highlight exceptions, not everything.** Mark the cells past a threshold with a small icon or a
  tinted background plus the value. A fully traffic-lit table has no signal.
- **In-row marks.** A thin bar behind or beside a number turns a column into a bar chart. A sparkline
  shows trend per row. Keep one scale per column.
- **Totals and averages** sit in a visually distinct row, labelled as such. Do not total percentages.
- **Long text** truncates with an ellipsis and stays reachable in full by keyboard as well as pointer.
  Numbers, units, statuses and identifiers never truncate.
- **Many rows**: keep the header visible while scrolling; say how many rows there are and how many are
  shown; paginate or virtualise beyond a few hundred.
- **Row height** around 32 to 40 px for dense desktop tables. Density should be a deliberate choice, not
  the framework default.

## Number formatting

| Case | Do | Not |
| --- | --- | --- |
| Precision | As much as the decision needs: `48.2k` on a tile, `48,210` in a table or tooltip | `48,210.00` on a headline |
| Consistency | Same decimals for a figure wherever it appears | `91.4%` on the tile, `91%` on the chart |
| Large numbers | Thousands separators; `k`, `M`, `bn` on tiles and axes, with the convention consistent | `1234567` |
| Small percentages | `<0.1%` | `0.0%` for a non-zero value |
| Currency | Symbol with the number, locale formatting, minor units only where they matter | Mixed currencies in one column without labels |
| Negative | A real minus sign `−`, or the locale's convention; state it once if using brackets | Red alone |
| Change | Signed, with unit: `+1,260`, `−2.4 pts`, `+4.8%` | An unsigned number beside an arrow |
| Ratios | State both sides if the base is small: `3 of 7` | `43%` of seven |
| Missing | `—` with a reason on hover or beside it | `0`, blank, `null`, `N/A` with no reason |
| Estimates | Mark them: `~`, "est.", or a lighter style, and say how they were made | An estimate styled as a measured figure |
| Units | Space or convention per the client's style; one way throughout | `ms` in one panel, `s` in the next |

Use the platform's locale formatter for numbers, currency and dates. Do not hand-build separators.

## Dates and time

- State the window on the page once, prominently, and make every panel obey it. A panel on a different
  window says so in its own title.
- Show when the data was last updated, as an absolute time or a relative one that keeps ticking. If the
  data is older than its refresh interval, say it is stale.
- Use unambiguous dates for mixed audiences: `11 Nov 2026`, not `11/12/26`.
- Relative ranges ("last 7 days") show their resolved dates somewhere.
- Name the time zone when readers or data span more than one.
- Never show raw timestamps, epoch values or internal identifiers to a reader who did not ask for them.
