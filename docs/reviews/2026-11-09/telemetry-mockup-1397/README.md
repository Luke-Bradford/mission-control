# Telemetry proposal: controller review corrections

This is a static, fictional proposal, not the live Telemetry implementation. The complete current ticket source is retained in [ticket-1397-source.md](ticket-1397-source.md), because the native input truncates its final section. The operator's design approval remains outstanding on parent #1178. No tab build tickets are filed or started by this rework.

The carried author work and first controller rework corrected nine of the ten Important findings from review 1055. Fresh independent review 1358 identified that chart readout figures still lacked their promised actions. The current phase corrects that remaining defect. Its remaining CI failure asserted that Table had exactly the chart height. The actual ticket prohibits added page height and permits a shorter Table. The old assertion fails locally at 900 versus 975 px. The corrected check requires no added height, the same grid origin, readable panels and no overflow.

The seven Minor findings are also addressed: table rows follow their marked ascending order; selected-tab and retry focus are retained; blank values cannot open runs; filter selections survive view changes; 4K enlargement respects viewport height; Today spend differs from the 24-hour total; and every stat has a unique accessible definition reference. The full plotted 24-hour cost is $78.10; the observed Today fixture total is $39.10. Figures remain fictional.

The new 4K regression fails on the earlier shell at 3,240 px in a 2,160 px viewport. The corrected shell fits. Actual stress capture also found the 50-ticket list enlarging its grid. A definite work-area track now bounds panels, and the list scrolls inside its allocation. Tests assert every panel remains above the workspace bottom at 1600×1000; hiding overflow under a fixed outer shell cannot satisfy that assertion. At 1600×700, native keyboard End reaches the final panel in the named workspace scroller.

## Rendered evidence

The manifest binds the final product commit and exact HTML hash. There are 31 matched earlier-proposal images, 70 historical pre-readout-correction images, 92 current-proposal images and six current-page comparison images. Before is reconstructed from the exact earlier HTML and remains labelled as an iteration of the proposal. After images are regenerated after the last visible source correction; rejected intermediate images stay private and are not published as final evidence.

The normal matrix covers all five tabs at 1280×900, 1600×1000 and 1920×940 in both themes. Further current captures cover all tabs at 2560×1145, 3840×2160 with actual CSS enlargement, 1600×700, the 50-ticket/300-character-title fixture, and an open FLIGHT drawer at three sizes. Loading, empty, error, stale and disconnected states are captured at 1600×1000. Both proposal phases use the repository browser harness and the self-contained mockup shell. No provider, live database or observed loop is used.

The separate current-page comparison arrives through Overview and Telemetry in the actual App, using the existing fictional test fixture and frozen clock. It is a structural comparison, not a claim that the old and proposed data contracts or numerical values match. The malformed first test-lock fixture is corrected before the retained successful six-image capture. No browser errors remain in the successful phases.

Manual inspection covers Crew at 1280, Cost in both themes at 1600, Throughput at 1920, Machine at 2560, Quality at enlarged 4K, the short workspace, the open drawer and the worst Cost list. The health band remains first, each tab exposes its own summary, all normal 1600 panels are visible, gaps remain hatched, and state shapes remain distinguishable without colour. The long Cost list scrolls inside its panel while the other charts stay on screen. The short viewport deliberately scrolls the work area. This is the controller's source-bound visual check; independent current-head review is still required.

## Validation and limits

All 46 mockup checks pass, including ten real-browser cases. The latest 92-image capture phase also passes. Before the current-main composition, lint reported 77 warnings; current composed-source lint reports 103 existing warnings and seven infos. None is hidden or called warning-free. Workspace typecheck and production build pass. The temporary capture tests are retained as text and removed from the runnable suite.

Fresh full CI and the configured most-capable independent whole-branch review remain required. The old failed design verdict is not waived or relabelled. A passing proposal review does not constitute the operator's approval to implement the redesigned product.

## Automatic preview compatibility

The automatic evidence preview of the old branch exits with an unrecognized `accounts[].brake` config key. A controller-owned preview reproduces that exact startup refusal without touching the live hub or loops. Current main is merged to bring its existing configuration parser. No live account setting or guard is removed. The exact self-contained mockup HTML hash remains identical, so the retained proposal images keep their actual capture-source identities and timestamps. New full CI and independent review are required on the composed head.

The corrected private preview boots on the composed source, reports the exact commit, confirms crew disabled and exits normally when its own observation ends. All 43 mockup cases pass again after composition. Lint, workspace types and build pass; existing lint warnings remain reported.


## Review 1358: readout controls

The independent reviewer found a genuine remaining Important defect: `.readout .vl` figures were
plain text. The extended all-tab regression fails first on `crew: 9 now` before the correction.
Every non-blank readout now uses the existing drill-button renderer with explicit target and label
metadata. Existing readers are named honestly; missing filtered readers keep the `needs-build` mark.
Blank legend keys remain keys rather than empty controls.

The chart cursor updates the existing button, its accessible name and the value used by the dialog.
It does not replace the button or lose focus. A missing sample disables the button while showing
`—`; leaving the chart restores the latest value and action. A focused test exercises the sample,
gap, restored value and drill-dialog contents. The real browser checks native Tab/Enter activation,
24 px targets and Escape/focus return on all five tabs.

The original 80-image readout phase, preserved by its archived manifest and immutable commit `8ef531b11f09b1c03a5fe03a984aa1cfa58840df`, is captured from product source
`650315a4c9ffeeb380befdd3e7c1617e3b4cd4fb`, with its exact HTML hash in the manifest. Its 80 images
repeat the full 70-image matrix and add focused and activated readout states on all five tabs.
The older `after/` phase remains explicitly historical and does not establish current design approval.
Manual inspection of the new Cost, light Crew, 4K Machine and open Cost target images shows readable
button values, visible action marks and a legible named dialog, while preserving the earlier panel
composition. The 45-case check and full capture phase pass without browser errors. Fresh current-head
CI and independent review remain required; review 1358's failed design is retained and is not waived.


## Review 1359: unavailable values preserve focus

Review 1359 verifies that the readout actions are fixed, but finds a new Important focus defect:
setting native `disabled` while a focused value crosses a gap makes Chromium blur the button.
A new real-browser regression moves the actual pointer over the missing Tokens-per-minute sample
and first fails with focus lost. The correction uses `aria-disabled` while preserving the same
focused button, blocks both Enter and assistive click activation for `—`, and restores the latest
value/action without moving focus when the pointer leaves. A visible unavailable value keeps its
focus outline and loses its action underline. Nothing programmatically restores or steals focus.

All 46 focused cases now pass, including ten real-browser cases. The native-pointer test proves
focus through the gap, no unavailable action, and a working restored action. Lint, workspace types
and build pass; existing diagnostics remain reported. Current-source visual evidence and fresh
exact-head CI/independent review are recorded separately. Review 1359's failed verdict is retained.
The full source ticket snapshot supplies the section the reviewer could not obtain from FLIGHT;
it supplies no operator approval or waiver.


## Current gap-focus evidence

The current `readout-after/` matrix is freshly rendered from
`bbbcb87249c0471d458f90ef156a62f2caeecf12`, with the exact HTML hash and per-image capture times.
All 80 earlier matrix images were regenerated and match their earlier pixel hashes. Their earlier
manifest remains under `history/`; these are actual new executions, not renamed old evidence.
Twelve additional images show the valid focused sample, unavailable focus, blocked Enter,
blocked assistive click, returned value/focus and restored activation in light and dark themes.
All 92 cases pass, without script errors or viewport spills. The tree holds 199 PNG paths:
31 earlier-proposal, 70 older corrected-proposal, 92 current-proposal and six current-page images.

Manual inspection of the dark gap, light blocked Enter and restored target dialog shows the
unavailable dash with a visible focus indicator, no action underline, no unsolicited dialog, and
a named restored value. The full page composition and original viewport matrix remain unchanged.
The temporary capture helper is retained as text and removed from the runnable suite. Fresh
current-head CI and independent review are still required. Parent #1178 still owns design approval;
the complete ticket snapshot and these controller checks supply no such approval.
