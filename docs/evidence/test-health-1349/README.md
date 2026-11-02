# Test health — before and after

Test health separates CI job snapshots, executed named-test attempts, documented duration samples and original reviewer QA proposals. Its evidence stays at the exact head and preserves explicit retry order. Existing Overview recommendations retain the authenticated decision path.

Before is actual main `15205ba0ff7cb3bbf8bae316ae9f2c5517d66b41` with Audit Overview selected: that source has no Test health tab. After is actual integrated source `2698bb34301fa2e82c3943877f8a75ef32e3321f` with Test health selected. Both use the same frozen fictional API fixture; no prior Test panel is fabricated.

These are production App/CSS renders through request interception, not live repo history or an HTTP/server-auth proof. Browser/fixture clock: `2026-10-17T12:00:00Z`. Actual capture finished `2026-11-02T19:11:38.127000Z`. Source/data/clock/scope, per-image timestamps/hashes, initial settled-case checks and fresh `viewAtCapture` scroll/region geometry are retained in [render-checks.json](render-checks.json). The focused panel pairs use identical physical viewport crops; they do not show a full page or an entire scroll region.

## Scope and review

The approved [plan](../../research/2026-11-01-code-health-plan.md) and [prototype PR #1340](https://github.com/Luke-Bradford/mission-control/pull/1340) define this Test renderer. Backend contracts come from delivered #1348. Shell geometry comes from delivered #1359. This change adds no test schedule, result import workflow, quarantine action or backend write endpoint.

Independent Codex reviewer `/root/review_1349_web` completed the same source/design pass through `2698bb34301fa2e82c3943877f8a75ef32e3321f` at `2026-11-02T19:12:26Z`. The reviewer inspected supplied captures/receipts and the narrow correction; no separate independent rendering run was performed. The metadata Important and narrow-proof gap are resolved; no unresolved Important/Critical source finding remains. The controller agent separately viewed corrected normal/long/narrow/full-environment images. Review covers those supplied scopes; geometry alone is not a blanket design approval.

## Observed findings and resolutions

| Observed in provisional source | Final behavior and evidence |
| --- | --- |
| p50/p95/ms header squeezed; Samples overallocated | Normal-case 12 px headers preserve `ms`, wrap words and pass actual header containment. Fixed 112 px percentile/72 px sample columns give identity/environment the remainder. 120,000 /360,000 ms stays readable and right-aligned in actual wide/narrow captures. |
| 96 px duration viewport cut the first record | 128 px bounded list shows the complete first normal record; actual first-row bounds are checked. Further records remain scrollable. |
| Row headings uppercased paths/heads | Original identity case/tracking is preserved; full values remain in exact-head evidence. |
| Count/classification width squeezed labels; narrow two-panel layout crushed useful text | 144 px data columns leave remaining disruption width to identity. Panels stack below 1000 px available width; scrolled 1280 context/crops retain durations and QA. |
| Fixed section height hid a small footer overflow | Test-only natural page height and 8 px root gaps fit the full normal 1600 work area. Regression checks main scrollHeight/clientHeight and actual footer bounds. Narrow/short work areas scroll. |
| **Important:** long file/environment inherited `th` nowrap and escaped its cell | Explicit metadata wrapping contains actual text fragments. Red reproducer measures text ending at x2157 inside a cell ending x660. Fixed source has zero Range-fragment overflows; keyboard evidence exposes the complete original environment. The finding and fix remain in [red receipt](metadata-red-reproducer.txt). |

What works well: job observations never become named-test denominators; mixed outcomes remain candidates; incomplete percentages remain unknown. Duration units/environments/samples stay explicit. Original reviewer and classification actor remain distinct. Enter/Escape restores visible focus, End scrolls long results, and complete long identities/environments stay readable in evidence.

## Validation and limits

[Actual local receipts](local-checks.json): 34/34 tests in four files at `2698bb34301fa2e82c3943877f8a75ef32e3321f`, zero skips, at most 3 workers, retry 0; four browser cases execute 40 actual renders. Full workspace types pass at that source. Lint/build passed at 0a99c8ab before clean main 19cf integration; the Test/App/HUD/Dock source stayed unchanged, and the capture driver freshly builds the integrated App. No local full suite was run. Remote CI/final readiness are recorded on the PR.

Capture proof: 116 actual screenshots, 32 matched viewport/region pairs, 8 keyboard/full-content receipts, zero escaped metadata fragments, zero unexpected runtime/console errors and zero write requests. **Two expected network-console messages come from intentionally injected 503 collection failures.** Counts/timings shown *inside fixture screens* are illustrative data, not the 34 tests actually executed. Supplied images validate controlled display/interaction states; real history and backend permission coverage remain separate.

Four-line identity previews open complete evidence. The long environment and further rows use bounded scrolling; the normal 1600 first record fits, while arbitrary long content is read through the evidence dialog. 1280 expanded and short-height layouts intentionally use the work-area scroller. After-only evidence/scrolled/error states have no invented before counterpart.

## Matched viewport and focused-region pairs

| View | Before | After | Pixel diff |
| --- | --- | --- | --- |
| 1280×900 · light · FLIGHT collapsed · context | [Before](images/test-health-1280x900-light-collapsed-context-before.png) | [After](images/test-health-1280x900-light-collapsed-context-after.png) | [Diff](images/test-health-1280x900-light-collapsed-context-diff.png) |
| 1280×900 · light · FLIGHT collapsed · panel | [Before](images/test-health-1280x900-light-collapsed-panel-before.png) | [After](images/test-health-1280x900-light-collapsed-panel-after.png) | [Diff](images/test-health-1280x900-light-collapsed-panel-diff.png) |
| 1280×900 · light · FLIGHT expanded · context | [Before](images/test-health-1280x900-light-expanded-context-before.png) | [After](images/test-health-1280x900-light-expanded-context-after.png) | [Diff](images/test-health-1280x900-light-expanded-context-diff.png) |
| 1280×900 · light · FLIGHT expanded · panel | [Before](images/test-health-1280x900-light-expanded-panel-before.png) | [After](images/test-health-1280x900-light-expanded-panel-after.png) | [Diff](images/test-health-1280x900-light-expanded-panel-diff.png) |
| 1600×1000 · light · FLIGHT collapsed · context | [Before](images/test-health-1600x1000-light-collapsed-context-before.png) | [After](images/test-health-1600x1000-light-collapsed-context-after.png) | [Diff](images/test-health-1600x1000-light-collapsed-context-diff.png) |
| 1600×1000 · light · FLIGHT collapsed · panel | [Before](images/test-health-1600x1000-light-collapsed-panel-before.png) | [After](images/test-health-1600x1000-light-collapsed-panel-after.png) | [Diff](images/test-health-1600x1000-light-collapsed-panel-diff.png) |
| 1600×1000 · light · FLIGHT expanded · context | [Before](images/test-health-1600x1000-light-expanded-context-before.png) | [After](images/test-health-1600x1000-light-expanded-context-after.png) | [Diff](images/test-health-1600x1000-light-expanded-context-diff.png) |
| 1600×1000 · light · FLIGHT expanded · panel | [Before](images/test-health-1600x1000-light-expanded-panel-before.png) | [After](images/test-health-1600x1000-light-expanded-panel-after.png) | [Diff](images/test-health-1600x1000-light-expanded-panel-diff.png) |
| 1920×1080 · light · FLIGHT collapsed · context | [Before](images/test-health-1920x1080-light-collapsed-context-before.png) | [After](images/test-health-1920x1080-light-collapsed-context-after.png) | [Diff](images/test-health-1920x1080-light-collapsed-context-diff.png) |
| 1920×1080 · light · FLIGHT collapsed · panel | [Before](images/test-health-1920x1080-light-collapsed-panel-before.png) | [After](images/test-health-1920x1080-light-collapsed-panel-after.png) | [Diff](images/test-health-1920x1080-light-collapsed-panel-diff.png) |
| 1920×1080 · light · FLIGHT expanded · context | [Before](images/test-health-1920x1080-light-expanded-context-before.png) | [After](images/test-health-1920x1080-light-expanded-context-after.png) | [Diff](images/test-health-1920x1080-light-expanded-context-diff.png) |
| 1920×1080 · light · FLIGHT expanded · panel | [Before](images/test-health-1920x1080-light-expanded-panel-before.png) | [After](images/test-health-1920x1080-light-expanded-panel-after.png) | [Diff](images/test-health-1920x1080-light-expanded-panel-diff.png) |
| 1600×700 · light · FLIGHT collapsed · context | [Before](images/test-health-1600x700-light-collapsed-context-before.png) | [After](images/test-health-1600x700-light-collapsed-context-after.png) | [Diff](images/test-health-1600x700-light-collapsed-context-diff.png) |
| 1600×700 · light · FLIGHT collapsed · panel | [Before](images/test-health-1600x700-light-collapsed-panel-before.png) | [After](images/test-health-1600x700-light-collapsed-panel-after.png) | [Diff](images/test-health-1600x700-light-collapsed-panel-diff.png) |
| 1600×700 · light · FLIGHT expanded · context | [Before](images/test-health-1600x700-light-expanded-context-before.png) | [After](images/test-health-1600x700-light-expanded-context-after.png) | [Diff](images/test-health-1600x700-light-expanded-context-diff.png) |
| 1600×700 · light · FLIGHT expanded · panel | [Before](images/test-health-1600x700-light-expanded-panel-before.png) | [After](images/test-health-1600x700-light-expanded-panel-after.png) | [Diff](images/test-health-1600x700-light-expanded-panel-diff.png) |
| 1280×900 · dark · FLIGHT collapsed · context | [Before](images/test-health-1280x900-dark-collapsed-context-before.png) | [After](images/test-health-1280x900-dark-collapsed-context-after.png) | [Diff](images/test-health-1280x900-dark-collapsed-context-diff.png) |
| 1280×900 · dark · FLIGHT collapsed · panel | [Before](images/test-health-1280x900-dark-collapsed-panel-before.png) | [After](images/test-health-1280x900-dark-collapsed-panel-after.png) | [Diff](images/test-health-1280x900-dark-collapsed-panel-diff.png) |
| 1280×900 · dark · FLIGHT expanded · context | [Before](images/test-health-1280x900-dark-expanded-context-before.png) | [After](images/test-health-1280x900-dark-expanded-context-after.png) | [Diff](images/test-health-1280x900-dark-expanded-context-diff.png) |
| 1280×900 · dark · FLIGHT expanded · panel | [Before](images/test-health-1280x900-dark-expanded-panel-before.png) | [After](images/test-health-1280x900-dark-expanded-panel-after.png) | [Diff](images/test-health-1280x900-dark-expanded-panel-diff.png) |
| 1600×1000 · dark · FLIGHT collapsed · context | [Before](images/test-health-1600x1000-dark-collapsed-context-before.png) | [After](images/test-health-1600x1000-dark-collapsed-context-after.png) | [Diff](images/test-health-1600x1000-dark-collapsed-context-diff.png) |
| 1600×1000 · dark · FLIGHT collapsed · panel | [Before](images/test-health-1600x1000-dark-collapsed-panel-before.png) | [After](images/test-health-1600x1000-dark-collapsed-panel-after.png) | [Diff](images/test-health-1600x1000-dark-collapsed-panel-diff.png) |
| 1600×1000 · dark · FLIGHT expanded · context | [Before](images/test-health-1600x1000-dark-expanded-context-before.png) | [After](images/test-health-1600x1000-dark-expanded-context-after.png) | [Diff](images/test-health-1600x1000-dark-expanded-context-diff.png) |
| 1600×1000 · dark · FLIGHT expanded · panel | [Before](images/test-health-1600x1000-dark-expanded-panel-before.png) | [After](images/test-health-1600x1000-dark-expanded-panel-after.png) | [Diff](images/test-health-1600x1000-dark-expanded-panel-diff.png) |
| 1920×1080 · dark · FLIGHT collapsed · context | [Before](images/test-health-1920x1080-dark-collapsed-context-before.png) | [After](images/test-health-1920x1080-dark-collapsed-context-after.png) | [Diff](images/test-health-1920x1080-dark-collapsed-context-diff.png) |
| 1920×1080 · dark · FLIGHT collapsed · panel | [Before](images/test-health-1920x1080-dark-collapsed-panel-before.png) | [After](images/test-health-1920x1080-dark-collapsed-panel-after.png) | [Diff](images/test-health-1920x1080-dark-collapsed-panel-diff.png) |
| 1920×1080 · dark · FLIGHT expanded · context | [Before](images/test-health-1920x1080-dark-expanded-context-before.png) | [After](images/test-health-1920x1080-dark-expanded-context-after.png) | [Diff](images/test-health-1920x1080-dark-expanded-context-diff.png) |
| 1920×1080 · dark · FLIGHT expanded · panel | [Before](images/test-health-1920x1080-dark-expanded-panel-before.png) | [After](images/test-health-1920x1080-dark-expanded-panel-after.png) | [Diff](images/test-health-1920x1080-dark-expanded-panel-diff.png) |
| 1600×700 · dark · FLIGHT collapsed · context | [Before](images/test-health-1600x700-dark-collapsed-context-before.png) | [After](images/test-health-1600x700-dark-collapsed-context-after.png) | [Diff](images/test-health-1600x700-dark-collapsed-context-diff.png) |
| 1600×700 · dark · FLIGHT collapsed · panel | [Before](images/test-health-1600x700-dark-collapsed-panel-before.png) | [After](images/test-health-1600x700-dark-collapsed-panel-after.png) | [Diff](images/test-health-1600x700-dark-collapsed-panel-diff.png) |
| 1600×700 · dark · FLIGHT expanded · context | [Before](images/test-health-1600x700-dark-expanded-context-before.png) | [After](images/test-health-1600x700-dark-expanded-context-after.png) | [Diff](images/test-health-1600x700-dark-expanded-context-diff.png) |
| 1600×700 · dark · FLIGHT expanded · panel | [Before](images/test-health-1600x700-dark-expanded-panel-before.png) | [After](images/test-health-1600x700-dark-expanded-panel-after.png) | [Diff](images/test-health-1600x700-dark-expanded-panel-diff.png) |

## Additional actual after states

| State and frame | Image |
| --- | --- |
| test-health-1280x900-light-expanded-scrolled-tables | [View](images/test-health-1280x900-light-expanded-scrolled-tables-after.png) |
| test-health-1280x900-light-expanded-scrolled-tables-region | [View](images/test-health-1280x900-light-expanded-scrolled-tables-region-after.png) |
| test-health-1600x1000-light-expanded-keyboard-focus | [View](images/test-health-1600x1000-light-expanded-keyboard-focus-after.png) |
| state-long-values-1600x1000-light-context | [View](images/state-long-values-1600x1000-light-context-after.png) |
| state-long-values-1280x900-light-context | [View](images/state-long-values-1280x900-light-context-after.png) |
| state-long-values-1280x900-light-scrolled-tables | [View](images/state-long-values-1280x900-light-scrolled-tables-after.png) |
| state-long-values-1280x900-light-scrolled-tables-region | [View](images/state-long-values-1280x900-light-scrolled-tables-region-after.png) |
| state-attempt-evidence-1600x1000-light-context | [View](images/state-attempt-evidence-1600x1000-light-context-after.png) |
| state-attempt-evidence-1600x1000-light-evidence-region | [View](images/state-attempt-evidence-1600x1000-light-evidence-region-after.png) |
| state-duration-evidence-1600x1000-light-context | [View](images/state-duration-evidence-1600x1000-light-context-after.png) |
| state-duration-evidence-1600x1000-light-evidence-region | [View](images/state-duration-evidence-1600x1000-light-evidence-region-after.png) |
| state-qa-evidence-1600x1000-light-context | [View](images/state-qa-evidence-1600x1000-light-context-after.png) |
| state-qa-evidence-1600x1000-light-evidence-region | [View](images/state-qa-evidence-1600x1000-light-evidence-region-after.png) |
| state-empty-1600x700-light-context | [View](images/state-empty-1600x700-light-context-after.png) |
| state-one-1600x700-light-context | [View](images/state-one-1600x700-light-context-after.png) |
| state-many-1600x700-light-context | [View](images/state-many-1600x700-light-context-after.png) |
| state-many-1600x700-light-keyboard-scroll | [View](images/state-many-1600x700-light-keyboard-scroll-after.png) |
| state-long-1600x700-light-context | [View](images/state-long-1600x700-light-context-after.png) |
| state-long-1600x700-light-full-identity | [View](images/state-long-1600x700-light-full-identity-after.png) |
| state-long-1600x700-light-full-environment | [View](images/state-long-1600x700-light-full-environment-after.png) |
| state-partial-1600x700-light-context | [View](images/state-partial-1600x700-light-context-after.png) |
| state-loading-1600x700-light-context | [View](images/state-loading-1600x700-light-context-after.png) |
| state-error-1600x700-light-context | [View](images/state-error-1600x700-light-context-after.png) |
| state-stale-1600x700-light-context | [View](images/state-stale-1600x700-light-context-after.png) |
| state-disconnected-1600x700-light-context | [View](images/state-disconnected-1600x700-light-context-after.png) |
| state-unsupported-1600x700-light-context | [View](images/state-unsupported-1600x700-light-context-after.png) |
| test-health-1280x900-dark-expanded-scrolled-tables | [View](images/test-health-1280x900-dark-expanded-scrolled-tables-after.png) |
| test-health-1280x900-dark-expanded-scrolled-tables-region | [View](images/test-health-1280x900-dark-expanded-scrolled-tables-region-after.png) |
| test-health-1600x1000-dark-expanded-keyboard-focus | [View](images/test-health-1600x1000-dark-expanded-keyboard-focus-after.png) |
| state-long-values-1600x1000-dark-context | [View](images/state-long-values-1600x1000-dark-context-after.png) |
| state-long-values-1280x900-dark-context | [View](images/state-long-values-1280x900-dark-context-after.png) |
| state-long-values-1280x900-dark-scrolled-tables | [View](images/state-long-values-1280x900-dark-scrolled-tables-after.png) |
| state-long-values-1280x900-dark-scrolled-tables-region | [View](images/state-long-values-1280x900-dark-scrolled-tables-region-after.png) |
| state-attempt-evidence-1600x1000-dark-context | [View](images/state-attempt-evidence-1600x1000-dark-context-after.png) |
| state-attempt-evidence-1600x1000-dark-evidence-region | [View](images/state-attempt-evidence-1600x1000-dark-evidence-region-after.png) |
| state-duration-evidence-1600x1000-dark-context | [View](images/state-duration-evidence-1600x1000-dark-context-after.png) |
| state-duration-evidence-1600x1000-dark-evidence-region | [View](images/state-duration-evidence-1600x1000-dark-evidence-region-after.png) |
| state-qa-evidence-1600x1000-dark-context | [View](images/state-qa-evidence-1600x1000-dark-context-after.png) |
| state-qa-evidence-1600x1000-dark-evidence-region | [View](images/state-qa-evidence-1600x1000-dark-evidence-region-after.png) |
| state-empty-1600x700-dark-context | [View](images/state-empty-1600x700-dark-context-after.png) |
| state-one-1600x700-dark-context | [View](images/state-one-1600x700-dark-context-after.png) |
| state-many-1600x700-dark-context | [View](images/state-many-1600x700-dark-context-after.png) |
| state-many-1600x700-dark-keyboard-scroll | [View](images/state-many-1600x700-dark-keyboard-scroll-after.png) |
| state-long-1600x700-dark-context | [View](images/state-long-1600x700-dark-context-after.png) |
| state-long-1600x700-dark-full-identity | [View](images/state-long-1600x700-dark-full-identity-after.png) |
| state-long-1600x700-dark-full-environment | [View](images/state-long-1600x700-dark-full-environment-after.png) |
| state-partial-1600x700-dark-context | [View](images/state-partial-1600x700-dark-context-after.png) |
| state-loading-1600x700-dark-context | [View](images/state-loading-1600x700-dark-context-after.png) |
| state-error-1600x700-dark-context | [View](images/state-error-1600x700-dark-context-after.png) |
| state-stale-1600x700-dark-context | [View](images/state-stale-1600x700-dark-context-after.png) |
| state-disconnected-1600x700-dark-context | [View](images/state-disconnected-1600x700-dark-context-after.png) |
| state-unsupported-1600x700-dark-context | [View](images/state-unsupported-1600x700-dark-context-after.png) |

All 148 PNG assets are retained with hashes and sizes in the ledger, including 32 actual pixel diffs. No unavailable image is replaced with an invented capture.
