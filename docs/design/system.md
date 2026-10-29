# HUD design system

The rules every screen in Mission Control is built and reviewed to. Written 29 October 2026 from
the operator's brief ("corporate, production tier; good flow and screen use; not over-padded; not
too much text for a box") and the published guidance of GitHub Primer, IBM Carbon, Atlassian,
Vercel Geist, Grafana and Nielsen Norman Group, with Stephen Few on dashboards. Where those sources
differ, the choice here is final for this repo. The seat checklist that applies these rules is
`.claude/skills/hud-design/SKILL.md`; the mockup catalogue says what each page shows; this says how.

## 1. What a page is for

- **One question per page.** Each page answers one operator question (direction principle 6).
  Its title bar says which. Content that answers a different question belongs on the page where
  that question is asked, linked, not duplicated.
- **Monitor, then focus, then drill.** Few's three steps. The first screenful gives the big
  picture; what needs attention stands out; one click reaches the detail. A page fits one screen
  at 1600×1000 for its first question; detail may scroll.
- **Prime real estate is top left.** The most important figure or state sits there, largest and
  highest contrast. When everything is prominent, nothing is.
- **Show only relevant data.** A figure earns its place by changing a decision. Decoration,
  duplicated numbers and "nice to know" tiles come out.
- **Refresh at the rate the data changes.** A value that changes hourly is not redrawn every
  second; a live state (a seat's step) updates when it changes, not on a timer tick.

## 2. Layout and spacing

- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48 px. Nothing in between. Small (4–8) inside compact
  pieces (pills, table cells, stat rows); medium (12–24) between pieces inside a panel; large
  (32–48) between panels and page regions.
- **Gutters:** page edge 24 px at 1600 and above, 16 px below; panel padding 16 px; pane (side
  column) padding 16 px. Every element inside a panel aligns to the same left edge.
- **Grid:** panels size to their content (`grid-auto-rows: auto`); a fixed height is allowed
  only on a scrolling list whose container shows a scrollbar. Nothing may clip. A panel that
  cannot fit its content at 1366×768 scrolls or wraps; it never hides rows.
- **Widths:** designed and checked at 1366, 1600 and 1920 wide, light and dark. Below 1366 is
  out of scope (desktop only). A two-pane page stacks its side pane below the main pane when
  the main pane would fall under 900 px.
- **Line length:** text blocks wrap at about 80 characters; a box that would hold more than
  four lines of running text is the wrong element (link to the full text instead).

## 3. Type

- **Faces:** IBM Plex Sans for text, IBM Plex Mono for identifiers, shas, paths, commands and
  tabular numbers. Barlow Semi Condensed for the wordmark and page titles only.
- **Scale (size/line height):** page title 20/28 semibold; panel title 14/20 semibold; body 13/20;
  secondary 12/16; caption and mono label 12/16; metric 24/28 and 16/20 semibold. **Nothing
  smaller than 12 px.** Six sizes in total; the tokens are `--fs-title`, `--fs-h`, `--fs-body`,
  `--fs-s`, `--fs-metric`, `--fs-metric-s`.
- **Weights:** 400 and 600 only. Emphasis is weight or colour, never both on the same word.
- **Numbers:** `font-variant-numeric: tabular-nums` wherever numbers sit in a column or change
  live. Right-align numeric columns. Round to what the decision needs: tokens in k, cost to two
  decimals under $10 and whole dollars above, durations as `3m 20s` / `2h 14m` / `3d`, never
  seconds past a minute, never a fraction of a day for a cycle time (use hours).
- **Case:** sentence case for labels, titles and buttons. Title Case only for proper names.
  Never all caps for words; small caps are not used.

## 4. Colour

- **Roles, not hues.** `neutral` (draft, idle, not started), `info` (in progress, reviewing,
  queued), `success` (done, passed, merged), `warning` (at risk, parked, held, needs review),
  `danger` (failed, blocked, overdue, error), `accent` (links, selection, focus). Six roles,
  one hue each; no second hue for the same role.
- **Seats** have one palette of eight hues, `--seat-1` to `--seat-8`, used identically on every
  page. A seat colour is never a status colour and never overlaps amber or red.
- **Subdued by default.** Surfaces, borders and text are neutral; colour marks state. A page
  with more than three coloured things on screen at rest has too many.
- **Two signals.** A state is never colour alone: a pill carries its word, a dot carries a
  shape or a label, a trend carries an arrow or sign.
- **Contrast:** text 4.5:1, large text and status marks 3:1, in both themes. Dark mode is a
  first-class theme, not an inversion.

## 5. Components

- **Panel:** title (14/20 semibold, sentence case), optional one-line description, body. One
  level of panel nesting. A panel with no data shows an empty state (below), not a blank.
- **Pill:** the one status element. One or two words, sentence case, max width 200 px then
  truncated with a title. One pill per row. Not clickable.
- **Stat (KPI):** one number, a one-word label, and context: a trend with sign or arrow, a
  target, or a comparison window. The definition, window and unit come from the metric
  registry and show on hover. A number without context is not a stat; it is a table cell.
- **Table:** header row 32 px, rows 32 px (compact) or 40 px (default); zebra on tables over
  ten rows; the first column is a human-readable name, not an id; numbers right-aligned and
  tabular; one sorted column by default and only that column shows the sort icon; wrap to two
  lines then truncate with a title; unknown value is `—`; row actions in the last column, at
  most one visible plus a menu; 20 rows then paginate or virtualise; the header stays while
  scrolling. No inputs inside cells.
- **Description list:** key/value metadata (`<dl>`), not a two-column table. Short keys, one
  value each, ids and timestamps verbatim with a relative time beside them.
- **Timeline / activity log:** one row per event, a badge with an `aria-label`, time on the
  left in mono, text on the right, condensed spacing; filters above, never inside.
- **Tabs:** two to six, one or two words each, one row, never as navigation, never when the
  reader must compare across tabs (use sections). The selected tab has two marks (underline
  and weight).
- **Progressive disclosure:** what the operator needs often is open by default; at most two
  levels; the control says what it opens ("Show 12 passed steps", not "More").
- **Empty state:** a positive title ("No reviews yet"), one line of why, and the one next action
  if there is one. Never "No data", never a dash in place of a panel. Errors say what failed and
  what to do, with specifics, never "Something went wrong".
- **Loading:** under 1 s nothing; 1–3 s an indeterminate mark; over 3 s a determinate one.
  Skeletons only in containers (tables, tiles), the same height as the content they replace, so
  nothing jumps. Show structure first, data as it arrives.
- **Notifications:** inline, near the thing, two lines, one action of two words or fewer; one
  banner at a time; a timed dismissal is never used for anything the operator must act on.

## 6. Charts

- Bars, lines, scatter; no pies, donuts, gauges or 3D. Bullet charts for a value against a
  target. Sparklines beside a stat only when the trend matters.
- Bars start at zero; lines may crop. A missing value breaks the line; it is never drawn as zero
  and never interpolated. Axis ticks never change to suit the data.
- Direct labels over legends; no gridlines where labels exist; no gradients or shadows. The same
  series keeps the same colour on every chart. One shared time range per page; event
  annotations (pause, Update, reset) as thin marks, not bands.
- Thresholds (`stop_at`, `alert_at`) are drawn as lines; state colour comes from the role in §4.

## 7. A detail page (an agent, a run, a ticket)

- **Context bar:** the path back (page › entity) and the entity's identity (call sign, role,
  account, model), each a short mono or pill, never a sentence.
- **Title bar:** name, one-line state ("Working · #1015 · 11 min in step"), the primary
  actions on the right (at most three visible; the rest in a menu).
- **Key stats row:** four to six stats per §5, the first the one that answers "is it alright".
- **Main pane:** the activity (timeline or stream) with filters above it.
- **Side pane:** the entity's structure: the loop with every step (passed, current, to come),
  the plan, files, queue. A step list shows all steps; the current one is open, the rest are one
  line each. Metadata as a description list.
- The page never says only "working"; a state names its step, its time in step and what is next.

## 8. Accessibility (the floor, not the aim)

- Targets 24×24 px minimum; focus is visible (`:focus-visible`), never removed; every control has
  a name; a tile's accessible name is its full path or title, not its abbreviation.
- Colour is never the only carrier (§4); every pointer-only gesture has a keyboard route.
- Reduced motion turns off every animation; the live indicator is the one allowed animation.

## 9. Performance (what the screen may cost)

- The API shapes the payload for the page; the page does not filter, join or sort large sets
  in the browser. A page opens in under 60 KB and renders its first question in under 100 ms.
- A page subscribes to the topics it shows and refetches only what changed; a clock tick
  re-renders the clock, not the page. Nothing runs while the tab is hidden.
- Lists over 100 rows are virtualised or paginated; a payload needed by one tab is fetched
  when that tab opens.

## 10. Changing this document

A rule changes by PR with a screenshot of a page that shows why. Tokens in `apps/web/src/hud.css`
follow this document, never the other way round. A review finding that cites a section here is
blocking for a web PR.
