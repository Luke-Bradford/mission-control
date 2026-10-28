# Crew Activity Map v3 mockup

Approved by the operator on 28 Oct 2026. `map-v3.html` is self-contained (D3 from cdnjs); open it in a
desktop browser. Hash params pick the view: `#lens=impact`, `#lens=history&focus=packages/core/src/flight.ts`.

Lenses: Changes, Impact, History, Ownership, Review, Conflicts. Impact and History are the new ones:

- **Impact**: what each seat's changes reach through imports. Changed files with "N import it · M depend on
  it" and the tests that reach them; overlap between seats with the import chain; changed files no test
  imports; import cycles. Clicking a file focuses it: its importers, the tests that reach it, what it imports.
- **History**: every PR merged since 22 Oct. Hotspots (PR count), files fixed most often (bug-labelled
  ticket or `fix/` branch), and files that change together with no import between them (hidden coupling).

The header comment in `map-v3.html` lists the data sources and which parts are synthesised.
