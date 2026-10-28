# Flight deck — the HUD's visual language

Mission Control should read like a flight-operations console, not a BI dashboard: dark, precise,
quiet until something needs attention, and visibly live. These rules apply to every page.

## Surface

- Base is a flat near-black blue (no grid or texture); panels are flat, hairline-bordered, radius 2–3px
  (`--r` 3px, `--r-s` 2px). No drop shadows, glows or corner ornaments on panels.
- Panel headers (`.ph`) are mono, uppercase, letter-spaced, `--fg-2`; a sub-label is `--muted`.
- Density over decoration: 12–13px body, tabular numerals everywhere a number changes.

## Colour

Colour means state, never decoration.

| Token | Meaning |
| --- | --- |
| `--accent` (phosphor cyan) | live, selected, focus, interactive |
| `--ok` | healthy / done |
| `--warn` | waits on the operator — the only amber |
| `--crit` | broken / failing |
| `--think` | FLIGHT's own judgement |

- **Selection is an edge, not a box.** A selected tab is `--fg` text over a flat 2px accent bar
  on its bottom edge — no tint or gradient glow. Selected nav and list rows get a 2px left bar and
  `--accent-soft` tint. A pressed toggle button is a tint plus a hairline accent border. Never a
  full coloured outline.
- **Chips are filled, not outlined.** Repo, label and state chips use a tinted fill
  (`color-mix(in srgb, <colour> 14%, transparent)`) and coloured text, border transparent.
- Message bubbles, cards and tiles use `--line` hairlines. A coloured border is reserved for the
  one thing on screen that needs action.

## Instruments (charts)

Charts are instruments, not reports.

- Always on a scale: faint horizontal gridlines (`--line`, dashed), mono tick labels in `--muted`,
  the unit and window in the panel header.
- Traces are 1.5px lines with a vertical gradient fill fading to transparent. No end-point dots
  on sparklines ("tadpoles"); mark *now* with a thin vertical cursor line instead.
- Bars are thin (≤ 60% of the band), square-ended, with the latest bar in `--accent` and history
  in a muted tone.
- Live series show they are live: a slow sweep or a pulsing "now" cursor, honouring
  `prefers-reduced-motion`.
- Never invent data: empty series say what is absent; a single point is a number, not a chart.

## Motion

- 150ms ease for hover/selection; live pulses ≤ 1 per 2s; nothing moves under `prefers-reduced-motion`.
