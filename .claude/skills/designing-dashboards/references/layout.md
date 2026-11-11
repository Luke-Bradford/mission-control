# Composition and layout

Step 4. Decide what leads, how big each thing is, and where it sits, before styling anything.

## Rank, then size, then place

1. **Rank every item**: primary (answers the page's question), supporting (explains or qualifies it), or
   detail (reached by one click or by scrolling). There is one primary. If everything is primary, go back
   to the brief.
2. **Size each panel from its content**, not from a grid template:
   - Width: lay out its longest realistic row or label and measure. That plus padding is its preferred
     width. Note the minimum at which it still reads and the maximum beyond which extra width shows
     nothing new.
   - Height: its normal number of rows times row height, plus its header; or the chart's sensible
     proportions at that width.
   - Ask what extra space would buy. A log or a long table gains from every extra row. A row of six
     tiles gains nothing; cap it.
3. **Place by rank and reading order.** In left-to-right languages attention starts top-left and thins
   towards bottom-right. Put the primary there, the next action near it, and detail lower or deeper.
4. **Sketch with real text at the real viewport** before building. Boxes labelled "chart" hide every
   problem this step exists to catch.

## A structure that usually works

```text
Header: title · time window · filters · last updated
Headline figures (one row)
Primary view (the answer; the largest panel)        | Supporting panels
Breakdowns (by segment, by cause, by place)         | (what needs attention, capacity, notes)
Detail table or log
```

Treat it as a starting point. A monitoring wall may be nothing but a status grid. A review page may be a
single table of figures against target. Do not add a headline row because dashboards have one.

## Grouping and spacing

- Things that belong together sit together, share alignment and have less space between them than the
  space separating them from the next group. Space does the grouping; boxes are a fallback.
- Use one spacing scale (for example 4, 8, 12, 16, 24, 32, 48 px) and one grid. Align panel edges; a
  ragged edge reads as carelessness.
- Fewer containers. A card inside a card inside a panel spends the page on borders and padding.
- Panels in one row hold comparable amounts of content, so none is half empty.
- In a column, exactly one region takes the spare height (the one with the most rows that do not fit).
  Otherwise tall screens leave holes.
- Charts that share a time axis share its position and width, stacked, so the eye can run down a date.
- White space is good where it separates groups and bad where it is a panel nobody filled.

## One screen, or scrolling?

- A **monitor** page fits the reader's screen with no page scrolling. A long list may scroll inside its
  own panel, visibly. If it does not fit: tighten padding, merge duplicates, shorten labels, move detail
  one click down. Shrinking text below the minimum is not on the list.
- A **review** page puts the verdict and headline figures on the first screen; supporting breakdowns may
  follow below.
- An **analysis** page scrolls freely, with filters that stay in view.
- On any page, the first screen must answer the question without the reader doing anything. A page that
  can be scrolled to the answer has not passed.

**Write the vertical budget** before building, for each reference viewport: page header + headline row +
each panel's header and content height + the gaps between them, against the viewport height. Do the same
for widths across each row. Name the panels that must be whole on the first screen. A panel cut off by the fold
is worse than one placed clearly below it, so when the sum does not fit, decide which panel moves down.
Caveats, method notes and definitions rank as detail: they go below the panels that carry data, or behind
a control.

## Viewports: measure the real one

- The viewport is what the page actually gets after browser tabs, toolbars, bookmarks bar, the operating
  system's task bar and any app chrome. A 1920×1080 monitor gives a page roughly 1920×940. Design and test
  at that, not at the monitor's resolution.
- Operating-system scaling changes it again: a 4K monitor at 150% offers 2560 CSS pixels of width; at
  200%, 1920. Monitor resolution alone tells you little. Ask the reader for their browser's inner width
  and height, or read it from a screenshot, and write down what you assumed.
- Record the reference viewports in the plan before building, and do not swap in a kinder one afterwards.
- Check with scrollbars visible; headless browsers often hide them along with the overflow they reveal.

## Wide, narrow and small screens

- **Wider screen**: first let the primary and the lists that gain from space take it; then add columns;
  cap text and table widths at a readable measure. Content stranded in the middle of unused
  screen and a table stretched to 3000 px are both failures. On very large, low-scaling displays, scale the whole
  page up before adding more content.
- **Narrower screen**: recompose (supporting column moves below, tiles wrap to two rows) before
  shrinking anything. Keep the primary and the items needing attention on the first screen.
- **Phone**: only if the brief says a phone is used. Then it is its own design: single column, headline
  figures first, charts simplified, tables turned into lists of the two or three columns that matter,
  touch targets large, no reliance on hover.
- **Wall display**: viewed from metres away and never touched. Much larger text, far fewer items, no
  interaction, no tooltips, high contrast, and a visible clock or heartbeat showing it is live.

## Density and type

- Default body text 13 to 14 px on desktop tools; never below 12 px for anything the reader must read.
  Headline numbers two to three steps larger. Labels smaller and lighter than values.
- Few sizes and weights: about four sizes, two weights. Hierarchy comes from size, weight and position
  before colour.
- Tabular figures wherever numbers align or change in place.
- Sentence case for titles and labels. Write labels in the reader's vocabulary, with no internal field
  names.
- Aim for density a daily user appreciates: enough on screen to compare without scrolling, with clear
  grouping. Sparse, oversized tiles suit a landing page, not a working tool.

## Navigation and controls

- Page-wide controls (time window, main filter) live in the header and visibly apply to everything.
  A control that affects one panel lives in that panel.
- Keep navigation between pages consistent, show where the reader is, and give every drill-down a clear
  way back that preserves filters.
- Names lead somewhere: an item in a list opens that item. Where no route exists, render plain text, not
  something that looks clickable.
- Repeated controls are noise. If six tiles each carry a "View" link, make each tile the link.
