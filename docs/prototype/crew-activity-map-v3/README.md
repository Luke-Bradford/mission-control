# Crew Activity Map v3 mockup

Approved by the operator on 28 Oct 2026. `map-v3.html` is self-contained (D3 from cdnjs); open it in a
desktop browser. Hash params pick the view:

- `lens` (`changes`, `impact`, `history`, `ownership`, `review`, `conflicts`) and `focus=<repo path>`, e.g.
  `#lens=history&focus=packages/core/src/flight.ts`; unknown values are ignored.
- `theme=light|dark` (default follows the OS), `diff=<path>` opens a file's diff, `read=<seat>` opens a
  seat's reads, `win=<from>,<to>` (minutes ago) sets the time window, `play=<seat>&step=<n>` replays.

Screenshots: `map-v3-impact.png` (Impact lens), `map-v3-impact-focus.png` (Impact focused on
`packages/core/src/runtime.ts`), `map-v3-history.png` (History lens).

Lenses: Changes, Impact, History, Ownership, Review, Conflicts. Impact and History are the new ones:

- **Impact**: what each seat's changes reach through imports. Changed files with how many files import them and depend
  on them and the tests that reach them; overlap between seats with the import chain; changed files no test
  imports; import cycles. Clicking a file focuses it: its importers, the tests that reach it, what it imports.
- **History**: every PR merged since 22 Oct. Hotspots (PR count), files fixed most often (bug-labelled
  ticket or `fix/` branch), and files that change together with no import between them (hidden coupling).

The map API supplies this as a compact `hist` payload, calculated from first-parent merges on the
default branch and cached for that branch tree. The production window is 90 days; coupling ignores
PRs touching more than 25 files and is capped at 600 qualifying pairs.

The header comment in `map-v3.html` lists the data sources and which parts are synthesised.
