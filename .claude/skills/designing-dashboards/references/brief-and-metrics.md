# Brief and figures

Read this before choosing any chart. It covers steps 1 and 2: who the page is for, and what goes on it.

## The brief

Write these down. If the request does not answer one, make the routine call yourself and state it; ask
only where two readings would produce different pages.

| Item | Ask | Why it changes the design |
| --- | --- | --- |
| Reader | Who opens this, and what do they already know? | Sets vocabulary, density and how much definition is on screen |
| Decision | What will they do differently after looking? | Anything that cannot change a decision is a candidate to cut |
| Cadence | Glanced at all day, checked each morning, read monthly? | Sets the time window, refresh rate and how much must fit one screen |
| Setting | Desk monitor, wall screen, laptop in a meeting, phone, print? | Sets viewport, text size, and whether hover and scrolling exist at all |
| Trust | Where do the numbers come from, and who would dispute them? | Sets the need for definitions, sources and timestamps |

Then write **the page's question** in one sentence, in the reader's words: "Did last week go to plan, and
if not, where?" Follow-up questions become supporting panels or separate pages.

## Three kinds of page

Most requests are one of these. Mixing them on one screen is the usual cause of a page that suits nobody.

| Kind | Reader's task | Shape |
| --- | --- | --- |
| **Monitor** (operational) | Notice that something is wrong, now | One screen, no page scrolling, current state, exceptions prominent, short windows, live or near-live |
| **Review** (strategic, scorecard) | Judge progress against goals | A few headline figures against target and trend, longer windows, refreshed daily or slower, definitions close at hand |
| **Analyse** (exploratory) | Find out why | Filters, breakdowns, drill-down, denser charts and tables; scrolling is acceptable |

A common and sound structure is review at the top level, analysis one click down, and the record-level
detail one click below that: overview first, then filter, then detail on request.

## Choosing figures

- **Start from the decision, not from the data that exists.** For each candidate ask: if this moved 20%
  tomorrow, would the reader do something? If not, it is detail, not a headline.
- **Keep headline figures few.** About six on one view is a working ceiling, not a target. Three
  well-chosen figures beat nine.
- **Choose the summary to suit the spread.** Where a few large values pull the average (durations,
  order values, response times), show the median and a high percentile, and say which.
- **Pair outcome with driver.** An outcome figure (revenue, on-time rate) tells the reader what happened;
  a driver (pipeline, vehicles available) tells them what is about to. A page of outcomes only is a
  rear-view mirror.
- **Prefer rates and ratios to raw counts** when the base changes. "37 complaints" means little without
  "per 10,000 orders".
- **Distrust figures that only go up.** Cumulative totals and all-time counts look good and decide
  nothing. Show the rate of change.
- **Balance figures that can be gamed.** If a team is measured on speed, show quality beside it.
- **For services and systems**, start from an established set instead of inventing one: rate, errors and
  duration for each service; utilisation, saturation and errors for each resource; or latency, traffic,
  errors and saturation for anything user-facing. Alert on symptoms the user feels; show causes beneath.

## Define every figure

Fill this in for each figure before building. It is the single most effective guard against a page whose
numbers nobody trusts.

| Field | Example |
| --- | --- |
| Name, as the reader says it | On-time delivery |
| Formula | Parcels delivered inside the promised window ÷ parcels delivered |
| Unit and precision | %, one decimal place |
| Window | Monday to Sunday; current week is partial |
| Source and refresh | Scan events table, every 15 minutes |
| Comparison | Target 95%; previous week |
| Good direction | Higher is better |
| Thresholds | Below 93% needs attention; below 90% is a problem |
| Known gaps | Excludes depots with scanner outages; say so when it applies |

Rules that fall out of this:

- A figure shown in two places uses one definition and one rounding. If finance and operations define
  "revenue" differently, show one and name it precisely.
- Thresholds are numbers agreed in advance, not colours chosen while styling.
- A comparison must be like for like: the same number of days, the same weekdays where the pattern is
  weekly, the same elapsed part of an unfinished period.
- State the time zone when readers are in more than one, and what "today" means.

## Before leaving this step

- [ ] The question is written, and each figure is tied to it.
- [ ] Each figure has a comparison and a good direction.
- [ ] You have a test dataset with known answers that includes the awkward cases: a figure off target, a
      missing value, a very small base, an unfinished period, the longest realistic label.
