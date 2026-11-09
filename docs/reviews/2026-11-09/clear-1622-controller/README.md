# Clear and Needs you: review 1336 follow-up

The Clear endpoint accepts a genuinely empty POST, including an empty JSON stream. Its parser exception is confined to this route. Null, arrays, extra properties and malformed JSON remain invalid. Other mutation routes retain their content-type and nonempty-JSON requirements. Operator authentication, actor, origin, cross-site and runaway protections remain enforced.

The actual empty request failed before this correction (415 without a content type; 400 with an empty JSON stream). The focused Clear suite passes 24 cases, including these requests and negative security/parser regressions. The broader API and attention suites pass 465 cases across five files. Lint, typecheck and build pass. This updates the existing PR; fresh pushed-head CI and independent whole-branch QA remain required. No additional full local-suite pass is claimed.

## Matched production App evidence

The before and after folders contain 64 actual Chromium viewport PNGs: four states, four viewports (1280×900, 1600×1000, 1600×700, 1920×940), both themes. The browser arrives from Overview through Needs you navigation, then selects the Update item through browser history. Each capture records the URL, visible content, count, DPR, zoom, scroll, browser version, fixed fixture clock, capture time and SHA-256. The manifest hashes all retained inputs and outputs.

Before uses the exact baseline `03ef6b5212e0fff0193f20e6bff3d226eabca2c7` needs-you-entry source, reconstructed during this capture; the rest of the App web source is unchanged. Fixtures come from the actual baseline Store/server projection. After uses this PR's current Store/server projection and needs-you-entry source, including the empty-body correction. Both fixture servers use isolated in-memory stores with fictional data and no provider or live database. The source hashes and terminal capture results are in capture-receipt.json. The temporary browser harness and generator are retained as text, outside the runnable suite.

The four states show: an internal FLIGHT reminder omitted from the operator list; an answered Update question no longer counted for the operator; the selected Clear item closing with a next-item link; and a newer Update raising a new question at the same key. After counts are respectively 2, 1, 1, 2. Before counts remain 3; baseline Clear returns 415, current Clear returns 200 and records closure. Reraising uses a new valid brief, not a stale answer.

Clear is invoked through the real backend route while building the isolated fixture. These images do not claim a web Clear-button click: ticket #1625 owns that control. The selected-route closed state and re-raised question are actual production App renders. Both final capture phases pass. An earlier capture expected an answered Update to remain counted; that assertion was corrected to the intended FLIGHT-owned projection before the retained final run.

Manual inspection of the short dark viewport confirms readable selected-question content and visible discussion controls. The answered and cleared states retain a visible next-item route. Images cover projection and selected-state behavior, not a redesign of the page.
