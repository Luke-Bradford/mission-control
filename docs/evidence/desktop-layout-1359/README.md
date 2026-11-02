# Approved desktop shell — implementation evidence

#1359 implements the shared geometry and FLIGHT rail from the operator-approved [PR #1353 mockups](https://github.com/Luke-Bradford/mission-control/pull/1353) and [density plan](../../research/2026-11-01-hud-density-plan.md). The operator approved implementation on 2 November 2026. Historical [mockup screenshots](../desktop-density-mockups/index.md) remain unchanged.

Baseline: [2b90233fa766a7ce4bfb82b03bb306cd6580c15f](https://github.com/Luke-Bradford/mission-control/commit/2b90233fa766a7ce4bfb82b03bb306cd6580c15f). Rendered implementation: [c88ab1e8c922bd28fa9448ae188c8566a8db31f6](https://github.com/Luke-Bradford/mission-control/commit/c88ab1e8c922bd28fa9448ae188c8566a8db31f6). This evidence-only successor changes no product code.

Every image is an actual 1× browser render of production components using fictional API data and a frozen fixture clock. No live hub, crew, provider or observed loop was used. QA image bytes are synthetic layout fixtures. They establish reader geometry, not image authorization or deployment approval.

The complete private run produced 82 before/after pairs, 164 renders and 82 pixel diffs with zero page errors. The [retained verification ledger](render-checks.json) records every viewport, theme, source hash, image hash, measurement and retention decision. The gallery below keeps all required default/expanded geometry pairs, new site-wide rail examples, filled-QA examples and alternate-state afters.

## Default and expanded FLIGHT

Rows measure 32 px below 2200 CSS px and 40 px at wider sizes. Panel titles remain 14/20, body 13/20, secondary 12/16 and mono labels 11/16. Headers measure 8 px/16 px compact, and shell gutters 16 px below 1600 or 24 px above. FLIGHT defaults to 48 px below 2200 and 380 px above, with an explicit browser-session choice.

| Viewport | Theme | Default | Expanded |
| --- | --- | --- | --- |
| 1280×900 | light | [Before](images/desktop-1280x900-light-default-before.png) · [After](images/desktop-1280x900-light-default-after.png) · [Diff](images/desktop-1280x900-light-default-diff.png) | [Before](images/desktop-1280x900-light-expanded-before.png) · [After](images/desktop-1280x900-light-expanded-after.png) · [Diff](images/desktop-1280x900-light-expanded-diff.png) |
| 1440×900 | light | [Before](images/desktop-1440x900-light-default-before.png) · [After](images/desktop-1440x900-light-default-after.png) · [Diff](images/desktop-1440x900-light-default-diff.png) | [Before](images/desktop-1440x900-light-expanded-before.png) · [After](images/desktop-1440x900-light-expanded-after.png) · [Diff](images/desktop-1440x900-light-expanded-diff.png) |
| 1600×1000 | light | [Before](images/desktop-1600x1000-light-default-before.png) · [After](images/desktop-1600x1000-light-default-after.png) · [Diff](images/desktop-1600x1000-light-default-diff.png) | [Before](images/desktop-1600x1000-light-expanded-before.png) · [After](images/desktop-1600x1000-light-expanded-after.png) · [Diff](images/desktop-1600x1000-light-expanded-diff.png) |
| 1920×1080 | light | [Before](images/desktop-1920x1080-light-default-before.png) · [After](images/desktop-1920x1080-light-default-after.png) · [Diff](images/desktop-1920x1080-light-default-diff.png) | [Before](images/desktop-1920x1080-light-expanded-before.png) · [After](images/desktop-1920x1080-light-expanded-after.png) · [Diff](images/desktop-1920x1080-light-expanded-diff.png) |
| 2560×1440 | light | [Before](images/desktop-2560x1440-light-default-before.png) · [After](images/desktop-2560x1440-light-default-after.png) · [Diff](images/desktop-2560x1440-light-default-diff.png) | [Before](images/desktop-2560x1440-light-expanded-before.png) · [After](images/desktop-2560x1440-light-expanded-after.png) · [Diff](images/desktop-2560x1440-light-expanded-diff.png) |
| 1600×700 | light | [Before](images/desktop-1600x700-light-default-before.png) · [After](images/desktop-1600x700-light-default-after.png) · [Diff](images/desktop-1600x700-light-default-diff.png) | [Before](images/desktop-1600x700-light-expanded-before.png) · [After](images/desktop-1600x700-light-expanded-after.png) · [Diff](images/desktop-1600x700-light-expanded-diff.png) |
| 1280×900 | dark | [Before](images/desktop-1280x900-dark-default-before.png) · [After](images/desktop-1280x900-dark-default-after.png) · [Diff](images/desktop-1280x900-dark-default-diff.png) | [Before](images/desktop-1280x900-dark-expanded-before.png) · [After](images/desktop-1280x900-dark-expanded-after.png) · [Diff](images/desktop-1280x900-dark-expanded-diff.png) |
| 1440×900 | dark | [Before](images/desktop-1440x900-dark-default-before.png) · [After](images/desktop-1440x900-dark-default-after.png) · [Diff](images/desktop-1440x900-dark-default-diff.png) | [Before](images/desktop-1440x900-dark-expanded-before.png) · [After](images/desktop-1440x900-dark-expanded-after.png) · [Diff](images/desktop-1440x900-dark-expanded-diff.png) |
| 1600×1000 | dark | [Before](images/desktop-1600x1000-dark-default-before.png) · [After](images/desktop-1600x1000-dark-default-after.png) · [Diff](images/desktop-1600x1000-dark-default-diff.png) | [Before](images/desktop-1600x1000-dark-expanded-before.png) · [After](images/desktop-1600x1000-dark-expanded-after.png) · [Diff](images/desktop-1600x1000-dark-expanded-diff.png) |
| 1920×1080 | dark | [Before](images/desktop-1920x1080-dark-default-before.png) · [After](images/desktop-1920x1080-dark-default-after.png) · [Diff](images/desktop-1920x1080-dark-default-diff.png) | [Before](images/desktop-1920x1080-dark-expanded-before.png) · [After](images/desktop-1920x1080-dark-expanded-after.png) · [Diff](images/desktop-1920x1080-dark-expanded-diff.png) |
| 2560×1440 | dark | [Before](images/desktop-2560x1440-dark-default-before.png) · [After](images/desktop-2560x1440-dark-default-after.png) · [Diff](images/desktop-2560x1440-dark-default-diff.png) | [Before](images/desktop-2560x1440-dark-expanded-before.png) · [After](images/desktop-2560x1440-dark-expanded-after.png) · [Diff](images/desktop-2560x1440-dark-expanded-diff.png) |
| 1600×700 | dark | [Before](images/desktop-1600x700-dark-default-before.png) · [After](images/desktop-1600x700-dark-default-after.png) · [Diff](images/desktop-1600x700-dark-default-diff.png) | [Before](images/desktop-1600x700-dark-expanded-before.png) · [After](images/desktop-1600x700-dark-expanded-after.png) · [Diff](images/desktop-1600x700-dark-expanded-diff.png) |

## Site-wide and filled-QA examples

Setup, Map and QA now have the same rail. Comms and the full FLIGHT workspace retain their own conversation. Filled current and archived QA reports retain readable receipt sections, keyboard scrollers, reachable links and paired image layout beside the open rail.

| Surface | Viewport | Theme | Comparison |
| --- | --- | --- | --- |
| page-qa-1600x1000 | 1600×1000 | light | [Before](images/page-qa-1600x1000-light-before.png) · [After](images/page-qa-1600x1000-light-after.png) · [Diff](images/page-qa-1600x1000-light-diff.png) |
| page-map-1600x1000 | 1600×1000 | light | [Before](images/page-map-1600x1000-light-before.png) · [After](images/page-map-1600x1000-light-after.png) · [Diff](images/page-map-1600x1000-light-diff.png) |
| page-setup-1600x1000 | 1600×1000 | light | [Before](images/page-setup-1600x1000-light-before.png) · [After](images/page-setup-1600x1000-light-after.png) · [Diff](images/page-setup-1600x1000-light-diff.png) |
| qa-queue-1280x900 | 1280×900 | light | [Before](images/qa-queue-1280x900-light-expanded-before.png) · [After](images/qa-queue-1280x900-light-expanded-after.png) · [Diff](images/qa-queue-1280x900-light-expanded-diff.png) |
| qa-archive-1600x700 | 1600×700 | light | [Before](images/qa-archive-1600x700-light-expanded-before.png) · [After](images/qa-archive-1600x700-light-expanded-after.png) · [Diff](images/qa-archive-1600x700-light-expanded-diff.png) |
| page-qa-1600x1000 | 1600×1000 | dark | [Before](images/page-qa-1600x1000-dark-before.png) · [After](images/page-qa-1600x1000-dark-after.png) · [Diff](images/page-qa-1600x1000-dark-diff.png) |
| page-map-1600x1000 | 1600×1000 | dark | [Before](images/page-map-1600x1000-dark-before.png) · [After](images/page-map-1600x1000-dark-after.png) · [Diff](images/page-map-1600x1000-dark-diff.png) |
| page-setup-1600x1000 | 1600×1000 | dark | [Before](images/page-setup-1600x1000-dark-before.png) · [After](images/page-setup-1600x1000-dark-after.png) · [Diff](images/page-setup-1600x1000-dark-diff.png) |
| qa-queue-1280x900 | 1280×900 | dark | [Before](images/qa-queue-1280x900-dark-expanded-before.png) · [After](images/qa-queue-1280x900-dark-expanded-after.png) · [Diff](images/qa-queue-1280x900-dark-expanded-diff.png) |
| qa-archive-1600x700 | 1600×700 | dark | [Before](images/qa-archive-1600x700-dark-expanded-before.png) · [After](images/qa-archive-1600x700-dark-expanded-after.png) · [Diff](images/qa-archive-1600x700-dark-expanded-diff.png) |

## Alternate summary states

All states below were also captured before the change in the private full archive. The retained after images show the named state, not a successful data refresh.

| State · 1600×700 | Light | Dark |
| --- | --- | --- |
| empty | [After](images/state-empty-1600x700-light-after.png) | [After](images/state-empty-1600x700-dark-after.png) |
| one | [After](images/state-one-1600x700-light-after.png) | [After](images/state-one-1600x700-dark-after.png) |
| many | [After](images/state-many-1600x700-light-after.png) | [After](images/state-many-1600x700-dark-after.png) |
| long | [After](images/state-long-1600x700-light-after.png) | [After](images/state-long-1600x700-dark-after.png) |
| loading | [After](images/state-loading-1600x700-light-after.png) | [After](images/state-loading-1600x700-dark-after.png) |
| error | [After](images/state-error-1600x700-light-after.png) | [After](images/state-error-1600x700-dark-after.png) |
| stale | [After](images/state-stale-1600x700-light-after.png) | [After](images/state-stale-1600x700-dark-after.png) |
| disconnected | [After](images/state-disconnected-1600x700-light-after.png) | [After](images/state-disconnected-1600x700-dark-after.png) |

## Interaction and regression checks

The clean-source browser block passes six cases covering twelve required geometry/theme views, sixteen state views, eighteen production-page views and twenty-four filled-QA rail views. Real keyboard Enter/Tab moves focus into the dock and back to the rail with a visible outline. The draft, failed-send text and selected context survive collapse/reconnection; the session choice survives real viewport changes and reload. A twenty-message log follows the latest message when opened and preserves a 100 px reading position across collapse. Short windows expose a scrollable summary with a reachable next action.

At the rendered source, the nine-file focused unit block passed 173 tests and the browser block passed six cases. Existing long-crew-row browser regressions passed four cases. Repository lint, workspace types and production build passed after the final correction. The [local check receipts](local-checks.json) retain the clean-commit unit/browser commands, timestamps and outcomes without private machine paths. Full CI remains required on the PR. The independent whole-branch reviewer found no unresolved Important/Critical finding at the rendered source.

## Comparison with the approved prototype and remaining work

The shared 32 px/40 px geometry, named 48 px rail, 380 px expansion, headline/top-three/next-action summary and session/focus/draft behavior follow the approved prototype. Existing full conversation and send behavior remain. Overview KPI/lane/timeline allocation, Agent details and grouped forms remain in #1360, #1361 and #1362.

At 1280 with FLIGHT expanded, the existing Overview Work cell clips the End action on both baseline and implementation. The approved gutters leave slightly less width. This known Overview limitation remains with #1360; this gallery does not claim it is fixed. Saved-QA image authentication was verified separately for #1367; the synthetic images here verify layout only.
