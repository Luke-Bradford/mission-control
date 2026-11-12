# States and interaction

Step 6. The page with perfect data on a fast connection is one state among many. Design the others on
purpose, panel by panel.

## States every panel needs

| State | What the reader sees | Never |
| --- | --- | --- |
| **Loading (first time)** | The panel's frame with a placeholder in the shape of the content. Layout does not jump when data arrives | A blank page; a spinner over the whole screen; a `0` that later becomes a number |
| **Refreshing** | The previous data stays, with a quiet sign that an update is under way | Wiping the panel on every refresh |
| **Empty, nothing to show yet** | A sentence saying what will appear here and what makes it appear | "No data" |
| **Empty, filters exclude everything** | Says so, names the filters, offers to clear them | The same message as "nothing yet" |
| **Empty, and that is good** | Says so plainly: "No overdue items" | An alarming blank |
| **Error** | What failed, in plain words, whether other panels are affected, and a retry. Other panels keep working | A stack trace; a failed panel showing zeros; one failed call blanking the page |
| **Stale** | The last known data, visibly marked with its age, when it is older than its refresh interval or the connection has dropped | Old data presented as current |
| **Partial** | The data, with a note of what is missing and why ("5 of 6 sites reporting") | A total that silently omits a source |
| **Unfinished period** | Marked as such and compared with the same elapsed part of the previous period | Today's half-day drawn as a collapse |
| **Not permitted** | Says the reader lacks access and who can grant it | A panel that looks empty |

If the page is a static snapshot with its data built in, it has no loading, refreshing or error state.
It still needs the states its data can be in: partial, unfinished period, missing, and the age of the
snapshot.

Also check the extremes of real data: one row, thousands of rows, the longest name, the largest number,
a negative value, all values equal, a single data point on a line chart.

## Live data

- Show when the data was last updated, and whether the page updates itself.
- Update in place. Do not rebuild the page, move panels, lose scroll position or steal focus when new
  data arrives.
- Keep axes steady between refreshes unless the range truly changes; a rescale on every tick makes
  steady data look volatile.
- Refresh as often as the reader can act, no faster. A figure the reader acts on weekly does not tick
  every second.
- If something new needs attention, mark it as new; do not reorder the list under the reader's cursor.

## Filters and time ranges

- Show the current filters and time range at all times, in words, near the title. A filtered page that
  looks unfiltered is a wrong answer waiting to be read.
- One obvious "reset" returns to the default view.
- Sensible defaults: the page is useful before the reader touches anything.
- Time presets cover the common windows (today, 7 days, 30 days, this quarter, custom) and show their
  resolved dates. Comparison options (previous period, same period last year) live with the range.
- Filters apply to everything on the page unless a panel says otherwise.
- Put filter state in the URL so a view can be bookmarked and shared.
- Prefer a few high-value filters to a wall of dropdowns. If a filter is rarely changed, it may be a
  separate page.

## Drill-down and cross-filtering

- The pattern is overview, then filter, then detail: each level answers "why?" for the one above.
- Anything clickable looks clickable, and says what the click does when that is not obvious.
- A drill-down keeps the reader's context (filters, time range) and offers a clear way back.
- Clicking a mark to filter the rest of the page is powerful and easy to overdo. Use it on at most one or
  two charts per page, show the active selection as a visible, removable filter, and consider highlighting
  (dimming the rest) when the reader wants emphasis while keeping context.
- Do not hide the only route to important information behind an interaction the reader has to discover.

## Tooltips

- A tooltip adds precision and definition: the exact value, the date, the comparison, how the figure is
  calculated. It is not the home of anything the reader needs in order to understand the page.
- On a time series, show all series at that point in one tooltip, in the legend's order.
- Reachable by keyboard focus as well as hover; stays while the pointer is over it; dismissible.
- Do not cover the mark being inspected.

## Words on the page

- Titles and labels in the reader's vocabulary. Say what a thing is, with unit and window.
- Short. A label is a noun phrase; an action is a verb ("Export", "View orders").
- Messages say what happened and what to do next, with no blame and no internal terms or codes.
- Abbreviations only if the reader uses them. Define the rest on first use or in a tooltip.
- One term per concept throughout: not "clients" on one panel and "customers" on the next.
