# Reports, slides and static pages

A report is read once, in order, often by someone who was not in the room, and it cannot be hovered,
filtered or refreshed. The seven steps still apply. These are the differences.

## What changes

| On a dashboard | On a report |
| --- | --- |
| The reader finds the story | The author states it |
| Titles describe: "Revenue by month" | Titles conclude: "Revenue fell 8% after the March price change" |
| Tooltips carry detail | Everything needed is printed: labels on the marks, definitions in notes |
| Filters choose the slice | The author chose it, and says which and why |
| Updates continuously | Carries a data date and a period, prominently |
| Neutral until something is wrong | Emphasis is authored: the point of each chart is highlighted |

## Structure

1. **Summary first.** The verdict and the three or four figures behind it, on the first page or screen. A
   reader who stops there should leave with the right conclusion.
2. **One message per chart, one chart per message.** If a chart needs two paragraphs of explanation it is
   two charts.
3. **Order by the reader's reasoning**: what happened, why, what it means, what is recommended. Not in
   the order the analysis was done.
4. **Method, definitions and caveats at the end**, linked from where they matter: sources, period,
   exclusions, how each figure is calculated, what is estimated.

## Charts in a report

- Title states the finding; a subtitle carries the measure, unit and period.
- Label lines and bars directly. Drop the legend where direct labels fit.
- Highlight the series or bar the message is about and mute the rest to grey.
- Annotate the cause on the chart: an arrow and six words at the point where the line turns.
- Show the source and data date under every chart, because charts get copied out of reports.
- Keep one scale for a measure across the whole report where the reader will compare pages.
- Use the same colour for the same thing on every page.

## Tables in a report

- Order rows by the message (largest variance first), not alphabetically.
- Limit to the columns the message needs; the full table goes in an appendix or attachment.
- For plan-against-actual tables, a fixed column order (previous, actual, plan, variance) and a small
  variance bar per row read far faster than coloured numbers.

## Print, PDF and slides

- Design to the page size and orientation that will be used. Check page breaks: no chart split from its
  title, no table header orphaned from its rows; repeat table headers on each page.
- It must survive black-and-white printing and a poor projector: do not lean on colour or thin pale lines.
- No interaction survives export. Anything that was a tooltip, a tab or a collapsed section must be
  visible or removed.
- Minimum text size about 9 pt in print and about 18 pt on a slide shown in a room.
- A slide makes one point. Its headline is that point as a sentence.
- Number the pages and put the report title, period and data date in the footer.

## Emails and snapshots of a dashboard

- A scheduled snapshot should lead with what changed since the last one, then the standing figures.
- Include the time range and data date in the image itself; images are forwarded without their email.
- Link back to the live page with the same filters applied.
