# Colour and accessibility

Step 5. Colour is the easiest thing to add and the easiest way to wreck a data page.

## Give every colour a role

Decide the roles before picking hues. A colour with no role does not go on the page.

| Role | Use | Guidance |
| --- | --- | --- |
| **Neutral** | Text, axes, gridlines, panel surfaces, context series, previous periods | Most of the page. Several greys of clearly different lightness |
| **Accent** | The main series, the selected item, links | One hue |
| **Category** | Distinguishing unordered groups (products, regions, teams) | Distinct hues of similar weight; about six at most, beyond that group the rest as "Other" or use small multiples |
| **Sequential** | Low to high of one measure (heatmap) | One hue, light to dark; darker means more |
| **Diverging** | Either side of a meaningful midpoint (zero, target) | Two hues meeting at a neutral middle |
| **Status** | Good, warning, problem, unknown | Reserved for status alone, used sparingly, always with a second cue |

Rules:

- **Start in grey, then add colour where it means something.** If a chart reads correctly in greyscale,
  colour is then free to do one job: point at what matters.
- **A colour means one thing across the whole page set.** If the north region is blue in one chart it is
  blue in all of them, and blue is nothing else.
- **Status colours are not chart colours.** A category drawn in red reads as a problem.
- **Quiet when healthy.** A page that is green all over trains the reader to ignore colour; the one red
  item should be the only saturated thing in view.
- **When several things are off target, rank them.** Give the worst one or two the status colour; show
  the others' gaps in plain text with a sign and words. Six red flags of equal weight read the same as
  none. The size of the miss against its threshold decides the rank, not the order on the page.
- **A data colour must not be the loudest thing on a page that has a problem on it.** If a block of
  saturated bars outshouts the one item needing attention, lighten or grey the bars.
- **Emphasise by muting the rest.** To highlight one series, grey out the others.
- **Do not encode magnitude with a rainbow of hues.** Hue has no natural order; use lightness.
- **Do not put a category palette on a single series.** Bars of one measure are one colour.
- **Client brand colours** are for the frame (logo, header, accent). Use them for data only if they pass
  the checks below; brand palettes are rarely built for charts.
- **Standard notation for plan and actual**, useful in finance and management reports: actual solid and
  dark, previous period lighter, plan or budget outlined, forecast hatched; red and green kept for
  variances.

## Palettes worth starting from

Where the project has no palette, start from a published one that was designed for colour-blind readers,
and check it against your background:

- **Categories**: the Okabe–Ito set, with hex values as commonly published (orange `#E69F00`, sky blue `#56B4E9`, bluish green `#009E73`,
  yellow `#F0E442`, blue `#0072B2`, vermilion `#D55E00`, reddish purple `#CC79A7`, black). Its yellow and
  sky blue are too light for thin marks on a white background; skip them or outline them.
- **Sequential and diverging**: ColorBrewer schemes marked colour-blind safe. Use a single-hue scheme
  for sequential data so that darker reads as more.

## Accessibility: the minimum

These are the Web Content Accessibility Guidelines 2.2 as they apply to data pages, at level A and AA
except where a row says otherwise. Treat them as the floor for client work. Criterion numbers are in
[sources](sources.md).

| Requirement | Number | Applies to |
| --- | --- | --- |
| Text contrast | 4.5:1; 3:1 for large text (about 24 px, or 19 px bold) | Labels, values, axis text, text inside coloured cells |
| Non-text contrast | 3:1 against what is next to it | Bars, lines, points, icons, control borders, focus rings |
| Colour is not the only cue | — | Status, series identity, positive and negative change, selection, links in text |
| Text alternative | — | Every chart: a short description of what it shows, plus the data available as a table or download |
| Keyboard | — | Every control, filter, sortable header, tab and any chart interaction that reveals information |
| Visible focus | — | Everything focusable |
| Target size | 24×24 CSS px minimum, or smaller with enough clear space around it; links inside a sentence are exempt | Buttons, toggles, legend items that filter |
| Hover content | Dismissible, hoverable, stays until dismissed | Tooltips |
| Text resize | Text can be enlarged to 200% without losing content or function | Whole page |
| Reflow | No two-way scrolling at 320 CSS px wide, except for data tables and charts that need two dimensions | Whole page |
| Structure | Tables are real tables with header cells; headings are headings | Tables, panel titles |
| Status messages | A change of status is announced to assistive technology without moving focus | Live updates, alerts, "saved" notices |
| Flashing | Nothing flashes more than three times a second | Alerts, live updates |
| Motion (good practice; level AAA) | Respect the reduced-motion setting | Transitions, animated charts |

In practice:

- **Second cues**: for status use icon shape plus a word; for series use direct labels, different line
  styles or markers; for change use a sign or arrow; for selection use a border or weight change.
- **Red and green together** are the commonest failure: roughly one man in twelve cannot reliably tell
  them apart. Blue and orange is a safer opposing pair. If red and green must stay, separate them in
  lightness and add icons.
- **Light tints on white** fail 3:1. Give pale bars or cells a darker edge, or darken the tint.
- **Check contrast in both themes.** A palette tuned for a white page usually needs different values on
  a dark one: lighter, less saturated marks; dark grey rather than pure black surfaces; the same roles.
- **Charts for screen readers**: a title, a one-sentence summary of the pattern, and a real HTML table
  (visible, or behind a "View as table" control). An image of a chart with no alternative is a blank.
- **Live regions**: announce a change of status, not every tick of a counter.
- **Never rely on hover** for information the reader needs to do the job; touch and keyboard users and
  wall displays do not have it.
- **Simulate** colour-vision deficiency and greyscale in browser developer tools before sign-off.
