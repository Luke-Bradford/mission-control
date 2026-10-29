# HUD design system

The rules every screen in Mission Control is built and reviewed to. Written 29 October 2026 from
the operator's brief ("corporate, production tier; good flow and screen use; not over-padded; not
too much text for a box") and the published guidance of GitHub Primer, IBM Carbon, Atlassian,
Vercel Geist, Grafana, Nielsen Norman Group and Stephen Few.

**Precedence.** The mockup catalogue (`docs/prototype/mission-control-hud-catalogue.md`) and the
mockups under `docs/mockups/` say what each page shows; this document says how to build and
judge it; `docs/design/flight-deck.md` adds the FLIGHT page's specifics. The catalogue is not
frozen: the per-page review (#677) compares each page with what the best operator consoles do
(the 29 Oct research into Claude-Code-Agent-Monitor, claude-mem, agents-ui and the design
systems above) and, where theirs answers the operator's question better, the review updates the
catalogue by PR with a mockup, and the page follows. Until such a PR lands, a seat builds what
the catalogue shows. The seat checklist is `.claude/skills/hud-design/SKILL.md`; a reviewer may
cite any section here, not only the checklist's items.

## 1. What a page is for

- **One question per page.** Each page answers one operator question (direction principle 6);
  the page title names it. A panel has one purpose. Content answering a different question lives
  on the page where that question is asked, linked, not copied.
- **See, focus, drill.** Few's three steps. The first screenful gives the whole picture; what
  needs attention stands out; one click reaches the detail. A page's first question fits one
  screen at 1600×1000; detail may scroll.
- **The top left is the most important place.** The figure or state the operator checks first
  sits there, largest and highest contrast. When everything is prominent, nothing is.
- **Only data that changes a decision.** A figure stays because some decision depends on it.
  Decoration, numbers shown twice, and "nice to know" tiles come out.
- **Refresh at the rate the data changes.** A value that changes hourly is not redrawn every
  second; a live state (a seat's step) changes when it changes, not on a timer tick.

## 2. Layout and spacing

- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48 px. Small (4–8) inside compact pieces (pills, table
  cells, stat rows); medium (12–24) between pieces in a panel; large (32–48) between panels and
  page regions. Existing 2/5/6/7/10/14/20 px values move to the scale as files are touched
  (#1020); a new file uses the scale only.
- **Gutters:** page edge 24 px at 1600 wide and above, 16 px below; panel padding 16 px; side
  pane padding 16 px. Text and labels in a panel share one left edge; numbers right-align within
  their column.
- **Grid:** panels size to their content (`grid-auto-rows: auto`). A fixed height is allowed only
  on a list that scrolls inside a visible scrollbar. **Nothing may clip.** A panel that cannot fit
  its content at the smallest checked size scrolls or wraps; it never hides rows.
- **Sizes checked:** 1280, 1600 and 1920 wide at 1000 tall, and 1600×700 for a short window,
  light and dark. Desktop only; below 1280 is out of scope. A two-pane page stacks its side pane
  below the main pane when the main pane would fall under 900 px with the FLIGHT dock open.
- **Line length:** running text wraps at about 80 characters. A box that would hold more than
  four lines of running text links to the full text (a message, a plan, a finding) instead.
  Conversation views (Comms, the FLIGHT dock, a seat's activity) are the exception: they show
  the whole message, wrapped.

## 3. Type

- **Faces:** IBM Plex Sans for text; IBM Plex Mono for identifiers, shas, paths, commands, micro-
  labels and tabular numbers; Barlow Semi Condensed for the wordmark, call signs and big numbers
  (catalogue §1.5).
- **Scale (size/line height):** page title 20/28; panel title 14/20; body 13/20 (`--fs`);
  secondary 12/16 (`--fs-s`); mono micro-label 11/16 (`--fs-xs`), uppercase, letter-spaced, used
  for panel labels and column heads only; metric 24/28 and 16/20. **Floor: 12 px for any word
  a person reads as text; 11 px only for the mono micro-labels.** Weights 400, 500 and 600.
  The title and metric tokens do not exist yet; #1020 adds them and retires ad-hoc sizes (138
  sub-12 px uses today). Until then a new rule uses the nearest existing token.
- **Numbers:** `font-variant-numeric: tabular-nums` wherever numbers sit in a column or change
  live; right-aligned in columns; thousands separated. Round to what the decision needs: tokens
  as `1.3k` / `2.4M`; cost `$3.51` under $10 and `$12` from $10; durations as seconds under a
  minute (`48s`), then `3m 20s` under an hour, then `2h 14m`, then `3d 4h`; a cycle time in
  hours, never a fraction of a day. Timestamps `HH:MM` local, with the date when not today, and a
  relative age beside a time when the age matters (`14:02 · 3h ago`).
- **Case:** sentence case for titles, labels and buttons; uppercase only for the mono micro-
  labels above.

## 4. Colour

- **Roles, not hues.** The tokens are `--accent` (links, selection, focus), `--ok` (running,
  passed, merged, healthy), `--warn` (waiting on something: stalled, parked, held, blocked by a
  gate, needs review; the only amber), `--crit` (failed, error, overdue, refused), `--think`
  (FLIGHT's own judgement, the FLIGHT page only), and neutral for draft, idle and not started.
  Queued and reviewing use neutral text with the state word, not a colour. One hue per role; no
  second hue for the same role.
- **Seats** use one palette, `--s1`–`--s7`, identically on every page; repos use `--r1`–`--r8`.
  A seat colour is never a status colour. The map's `--seat-*` copies go (#1009). `--s2` and
  `--s4` sit close to `--crit` and `--warn`; #1020 moves them.
- **Subdued by default.** Surfaces, borders and text are neutral; colour marks state. Seat and
  repo chips are identity, not state, and do not count toward the limit: when nothing is
  changing, at most three state-coloured elements are on screen.
- **Two signals.** A state is never colour alone: a pill carries its word, a lamp carries a label
  or shape, a trend carries a sign or arrow.
- **Contrast:** text 4.5:1, large text and status marks 3:1, in both themes. Dark is the default
  theme; light is a full theme, not an inversion.
- **Borders, radius, elevation:** 1 px borders, radius 8 px on panels and 6 px on controls and
  pills (catalogue §1.5); no shadows except on overlays (dock, modal, menu).

## 5. Components

- **Panel:** a mono micro-label or a 14/20 title, optional one-line description, body. One level
  of nesting. No data shows an empty state (below), never a blank or a bare dash.
- **Pill:** the status element. One or two words, sentence case, max 200 px then truncated with
  a title and a full accessible name. One status pill per row; identity chips (seat, repo, role,
  model, account) are mono chips, not pills. Not clickable.
- **Stat:** one number, a short label (one to three words), and context: a trend with sign or
  arrow, a target, or a window. Definition, window and unit show on hover and in the accessible
  name; a figure shown on more than one page comes from the metric registry
  (`packages/core/src/metrics.ts`); a single-page figure states its definition in its component.
  A number with no context is a table cell, not a stat.
- **Table:** rows 40 px (default, text may wrap to two lines then truncate) or 32 px (compact,
  one line, truncate); header 32 px, stays while scrolling; zebra over ten rows; first column a
  human-readable name; numbers right-aligned and tabular; one sorted column by default and only
  it shows a sort mark; unknown value `—`; row actions in the last column, at most one visible
  plus a menu; 20 rows per page, paginated; a continuous list over 100 rows is virtualised. No
  inputs in cells.
- **Description list:** key/value metadata as `<dl>`, not a two-column table; short keys; ids
  and timestamps verbatim with a relative age beside.
- **Timeline / activity log:** one row per event, a mark with an `aria-label`, time on the left
  in mono, text on the right, 4 px between rows; filters above, never inside.
- **Tabs:** two to six per panel, one or two words, one row; never to compare across tabs (use
  sections). The selected tab has two marks (underline and weight). The app's top nav is
  navigation, not a tab component.
- **Progressive disclosure:** what the operator needs often is open by default; at most two
  levels; the control says what it opens ("Show 12 passed steps", not "More").
- **Buttons:** one primary per view; destructive or operator-approval actions (direction
  principle 2) confirm with the consequence stated; labels are verbs.
- **Empty state:** an affirmative title ("No reviews yet"), one line of why, and one next action
  when there is one. Never "No data". Errors say what failed and what to do; never "Something
  went wrong".
- **Loading:** under 1 s nothing; 1–3 s an indeterminate mark; over 3 s a determinate one.
  Skeletons only in containers (tables, tiles), the same height as the content they replace.
  Structure first, data as it arrives; a figure that failed to load shows its own error line
  (the registry's `from`), not a blank.
- **Stale and disconnected:** a figure older than its refresh window shows its age; a lost
  stream shows one banner with the last-received time. The page keeps the last data visible.
- **Notifications:** inline, near the thing, two lines, one action whose label is two words or
  fewer; one banner at a time; nothing the operator must act on dismisses on a timer.
- **Overlays:** the FLIGHT dock (every page), modals and menus. An overlay never hides the page's
  first question at 1600 wide; a modal has one primary action and closes on Escape.
- **Icons:** status marks and nav only; a word beats an icon.

## 6. Charts

- Bars, lines, scatter; bullet charts for a value against a target; sparklines beside a stat
  when the trend matters. No pies, donuts, radial gauges or 3D. The ctx and quota meters are
  linear bars, allowed.
- Bars start at zero; a line chart's y-axis may start above zero. A missing value breaks the
  line; it is never drawn as zero and never interpolated. Tick spacing is chosen for the scale,
  not for the data points present.
- Direct labels where they fit, legends only when they do not; no gridlines where labels exist;
  no gradients or shadows. A series keeps the same colour on every chart; at most eight series,
  then group. One shared time range per page; a panel with its own window says so in its label.
  Event annotations (pause, Update, reset) are thin marks.
- Thresholds (`stop_at`, `alert_at`) are lines; state colour comes from §4.

## 7. A detail page (an agent, a run, a ticket)

- **Context bar:** the path back (page › entity) and identity chips (call sign, role, account,
  model, area), each a mono chip.
- **Title bar:** name, one-line state ("Working · #1015 · 11 min in step"), primary actions on
  the right (at most three visible; the rest in a menu).
- **Key stats row:** four to six stats per §5; the first answers "is it alright".
- **Main pane:** the activity (timeline or stream) with filters above it.
- **Side pane:** the entity's structure: the loop with every step (passed, current, to come),
  the plan, files, queue. All steps are shown; the current one is open, the others one line
  each. Metadata as a description list.
- A state names its step, its time in step and what is next; never only "working".

## 8. Accessibility (the floor)

- Targets 24×24 px minimum; focus visible (`:focus-visible`), never removed; every control has a
  name; a truncated item's accessible name is its full text, not its `title` alone.
- Colour is never the only carrier (§4); every pointer gesture has a keyboard route; the
  catalogue's shortcuts (§1.6) keep working.
- **Motion:** 150 ms ease on hover and selection, the live lamp pulse, and nothing else; reduced
  motion turns all of it off.

## 9. Performance (what a screen may cost)

- The API shapes the payload for the page; the page does not filter, join or sort large sets.
  A page opens with under 60 KB transferred (gzipped) and renders its first question in under
  100 ms on the hub's Mac, measured by the HUD screenshot harness.
- A page subscribes to the topics it shows and refetches only what changed; a clock tick
  re-renders the clock, not the page; nothing runs while the tab is hidden.
- Lists over 100 rows are virtualised or paginated; data a tab needs is fetched when the tab
  opens.

## 10. Changing this document

A rule changes by PR with a screenshot of a page that shows why. `apps/web/src/hud.css` and
`theme.ts` carry the values; this document carries the rules; where they differ, the rule is
fixed first, then the token. A review finding that cites §2–§5, §8 or §9 is Important
(blocking) for a web PR; a finding on taste alone is Minor and never holds a clean PR.
