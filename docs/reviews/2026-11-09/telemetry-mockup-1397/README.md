# Telemetry proposal: controller review corrections

This is a static, fictional proposal, not the live Telemetry implementation. The operator's design approval remains outstanding on parent #1178. No tab build tickets are filed or started by this rework.

The previous author head already corrected the ten Important findings from review 1055. Its remaining CI failure asserted that Table had exactly the chart height. The actual ticket prohibits added page height and permits a shorter Table. The old assertion fails locally at 900 versus 975 px. The corrected check requires no added height, the same grid origin, readable panels and no overflow.

The seven Minor findings are also addressed: table rows follow their marked ascending order; selected-tab and retry focus are retained; blank values cannot open runs; filter selections survive view changes; 4K enlargement respects viewport height; Today spend differs from the 24-hour total; and every stat has a unique accessible definition reference. The full plotted 24-hour cost is $78.10; the observed Today fixture total is $39.10. Figures remain fictional.

The new 4K regression fails on the earlier shell at 3,240 px in a 2,160 px viewport. The corrected shell fits. Actual stress capture also found the 50-ticket list enlarging its grid. A definite work-area track now bounds panels, and the list scrolls inside its allocation. Tests assert every panel remains above the workspace bottom at 1600×1000; hiding overflow under a fixed outer shell cannot satisfy that assertion. At 1600×700, native keyboard End reaches the final panel in the named workspace scroller.

## Rendered evidence

The manifest binds the final product commit and exact HTML hash. There are 31 matched earlier-proposal images, 70 current-proposal images and six current-page comparison images. Before is reconstructed from the exact earlier HTML and remains labelled as an iteration of the proposal. After images are regenerated after the last visible source correction; rejected intermediate images stay private and are not published as final evidence.

The normal matrix covers all five tabs at 1280×900, 1600×1000 and 1920×940 in both themes. Further current captures cover all tabs at 2560×1145, 3840×2160 with actual CSS enlargement, 1600×700, the 50-ticket/300-character-title fixture, and an open FLIGHT drawer at three sizes. Loading, empty, error, stale and disconnected states are captured at 1600×1000. Both proposal phases use the repository browser harness and the self-contained mockup shell. No provider, live database or observed loop is used.

The separate current-page comparison arrives through Overview and Telemetry in the actual App, using the existing fictional test fixture and frozen clock. It is a structural comparison, not a claim that the old and proposed data contracts or numerical values match. The malformed first test-lock fixture is corrected before the retained successful six-image capture. No browser errors remain in the successful phases.

Manual inspection covers Crew at 1280, Cost in both themes at 1600, Throughput at 1920, Machine at 2560, Quality at enlarged 4K, the short workspace, the open drawer and the worst Cost list. The health band remains first, each tab exposes its own summary, all normal 1600 panels are visible, gaps remain hatched, and state shapes remain distinguishable without colour. The long Cost list scrolls inside its panel while the other charts stay on screen. The short viewport deliberately scrolls the work area. This is the controller's source-bound visual check; independent current-head review is still required.

## Validation and limits

All 43 mockup checks pass, including eight real-browser cases, plus the three completed capture phases. Lint passes with the branch's 77 existing warnings; none is hidden or called warning-free. Workspace typecheck and production build pass. The temporary capture tests are retained as text and removed from the runnable suite.

Fresh full CI and the configured most-capable independent whole-branch review remain required. The old failed design verdict is not waived or relabelled. A passing proposal review does not constitute the operator's approval to implement the redesigned product.

## Automatic preview compatibility

The automatic evidence preview of the old branch exits with an unrecognized `accounts[].brake` config key. A controller-owned preview reproduces that exact startup refusal without touching the live hub or loops. Current main is merged to bring its existing configuration parser. No live account setting or guard is removed. The exact self-contained mockup HTML hash remains identical, so the retained proposal images keep their actual capture-source identities and timestamps. New full CI and independent review are required on the composed head.

The corrected private preview boots on the composed source, reports the exact commit, confirms crew disabled and exits normally when its own observation ends. All 43 mockup cases pass again after composition. Lint, workspace types and build pass; existing lint warnings remain reported.
