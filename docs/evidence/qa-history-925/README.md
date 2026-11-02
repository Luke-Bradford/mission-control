# QA History · before and after

Runtime source: [`8fdb9028`](https://github.com/Luke-Bradford/mission-control/commit/8fdb9028b9946f2cea92b978c3d81892b0c4f46f). Baseline: [`606fb0b4`](https://github.com/Luke-Bradford/mission-control/commit/606fb0b4018fe03aab5bae4dda58c215affc0fed).

**These are controlled fictional data and production App/CSS renders. They are not live QA history, original native screenshots or production approval.**

The actual baseline has Current QA and no History index. Paired frames show that available Current page against the added History page. No earlier History table was invented. Both versions use the same viewport, theme, shell, fixture dataset and frozen clock (`2026-10-17T12:00:00Z`). The sample reports have explicit fictional calendar timestamps; no relative review-age claim is made.

32 matched viewport/visible-region pairs, 112 actual screenshots, 14 keyboard receipts and 144 retained PNGs (19,996,332 bytes). Diff images supplement the pairs. Region pairs use the same physical viewport crop; they are not full-page or full-table captures. Fresh metrics, scroll positions, request paths and per-image source/hash are in [render-checks.json](render-checks.json).

## Observed table behavior

- PR identity receives the remaining width; reviewer/time uses 22%, verdict 156 px, evidence 204 px and record actions 96 px. Normal 1600 expanded views keep labels, exact dates, state words and actions readable. Headers and body share HTML table tracks; timestamp/count digits are tabular.
- Normal three-record History follows the heading and filters without stretched blank grid space. Refresh aligns with the repository select. Padding follows8/12 px cell tokens; rows grow with metadata instead of squeezing text.
- The narrow open-rail table has an intentional horizontal scroll region (minimum 850 px), separate from document overflow. The named region is keyboard focusable, has sticky headings, and End reaches the last rows. Preview truncation is indicated; Full identity expands repo, PR, title, complete commit, reviewer and recorded time.
- Long stress fixtures exceed ordinary labels. Actual text Range checks keep expanded content within its cell. ArrowDown brings the complete long reviewer and exact commit into view; a tall requested expansion scrolls within the table. It can leave blank adjacent cells while expanded; this is not normal collapsed-row density.
- Native failed attempts keep no invented verdict/review time. Saved/controller and native states remain distinct. Legacy hub records preserve unknown process exit, counts and source-cleanliness limits; they are separate from reviewer-reported counts. History never grants current acceptance.

## Findings and corrections

1. **Stretched History layout:** the initial `5a95d43c` render inherited100% section height, spreading filters and table down the viewport. History now uses natural height/start alignment. The retained [red reproducer](spacing-red-reproducer.txt) fails at 873 px. It combines CSS from `5a95d43c` with corrected fixtures and the new regression; it is not a pure old-source run. Corrected normal-flow and short-height cases pass.
2. **Toolbar alignment:** Refresh centered against a stacked label instead of its select. The final bottom alignment is checked within 1 px in both themes. The image count also uses singular “1 pair”.
3. **Fixture identity mismatch:** early extra rows reused the first report URL despite distinct PR/head labels. Factories now produce corresponding record metadata and links; keyboard navigation verifies the selected exact commit. This was a fixture defect, not a production API identity failure.
4. **Fixture image failure:** the early baseline capture reached intentionally fake external image URLs inside nested report arrays. [Its failed receipt](early-capture-fixture-failure.txt) is retained. Final captures adapt those images to explicit controlled one-pixel PNGs; no actual original-image availability is inferred.
5. **Keyboard timing:** the first End assertion read scrollTop before paint. [The failed run](early-keyboard-failure.txt) and [intermediate paint settle](early-keyboard-paint-settle.txt) remain. The final test waits for the bounded bottom condition within 1.5 seconds and retains the original overall timeout and meaningful scroll assertion.
6. **Available legacy evidence omitted:** source inventory found existing hub command records separate from reported counts, plus stored original resolutions. Native detail now shows both without generating reports or fresh CI. Tests retain lock-only unknown outcomes/exits and reject another commit’s check receipt.

## Checks actually run

These counts describe local commands, not sample counts drawn inside reports. [Structured receipts](local-checks.json) retain case names/statuses and original JSON hashes.

| Run | Actual result | Source | Receipt |
| --- | --- | --- | --- |
| Complete focused History pack (3 files) |20 passed, 0 failed, 0 skipped |7f61 |[log](full-history-pack.txt) |
| Toolbar reader units |8 passed |623f |[log](toolbar-reader.txt) |
| Toolbar browser subset,2themes |1 passed, 4 filtered |623f |[log](toolbar-browser.txt) |
| Final native API +reader units |17 passed (8 API, 9 reader) |8fdb |[log](final-native-units.txt) |
| Final native/version browser subset |1 passed, 4 filtered |8fdb |[log](final-native-browser.txt) |
| Workspace types/lint/build |passed |8fdb (final formatting only afterward) |[types](typecheck.txt),[lint](lint.txt),[build](build.txt) |

The full pack covers 16 width/theme/rail matrix renders,8 Current/saved-report short-height contexts,2 normal density themes,5 empty/one/loading/error/disconnected states and1 version/native navigation context. The final native subset additionally checks visible unknown hub records, original resolutions and authenticated on-demand fixture PNG decode. No local full suite or model/seat/provider turn ran.

## Independent review scope

The first independent whole-branch review is clean on runtime source `8fdb9028` at **2026-11-02 21:04:23 UTC**. The Codex reviewer independently reran **17 API/reader unit cases** ([retained receipt](independent-api-reader.txt)) and inspected the supplied final images. No unresolved Important or Critical finding remained. This was source review and supplied-image inspection, not an independent browser render. The exact runtime model identifier is not available; none is invented here. Final CI and the immutable report permalink are recorded on the PR after its evidence-only head is checked.

## Limits and provenance

- Saved reports are immutable snapshots. Legacy rows are original retained records, not reconstructed snapshots; findings can show later retained resolution state. Existing retention may remove old rows, command records or image bytes. Already pruned evidence cannot be restored by this view.
- Legacy links bind the complete original row identity; a pruned/reused row cannot silently open another review. Configured-repository bounds and paginated discovery were checked against an isolated actual database copy. That private copy and its operational contents are not committed here.
- The fixture index loads no report body, current queue or screenshot. Explicit legacy image load uses the existing authenticated reader and a controlled one-pixel PNG here; expired-byte behavior is tested separately. This does not independently prove live stored PNG bytes or their original capture provenance.
- Synthetic 503 responses exercise the error state. Final frames have zero unexpected runtime/console errors and write requests; this harness generated no network-console 503 messages.
- Browser captures exercise the actual App shell, both rail states and both schemes. Each state is a controlled scenario; the gallery is not a whole-site or real operational approval. Private copied-DB proof covers metadata reads, not images or historical CI reconstruction.
- Existing saved-reader header density and repeated CI wording were observed in the actual baseline. This change preserves that reader and adds discoverability; it does not claim to redesign or independently approve all prior reader formatting.
- Independent review status and final CI receipts belong to the PR’s durable QA sign-off. This gallery itself makes no independent-review or deployment-readiness assertion.

## Matched context and visible-region pairs

| Case | Scope | Before | After | Diff |
| --- | --- | --- | --- | --- |
|history-1280x900-light-collapsed|context|[before](images/history-1280x900-light-collapsed-context-before.png)|[after](images/history-1280x900-light-collapsed-context-after.png)|[diff](images/history-1280x900-light-collapsed-context-diff.png)|
|history-1280x900-light-collapsed|table-region|[before](images/history-1280x900-light-collapsed-table-region-before.png)|[after](images/history-1280x900-light-collapsed-table-region-after.png)|[diff](images/history-1280x900-light-collapsed-table-region-diff.png)|
|history-1280x900-light-expanded|context|[before](images/history-1280x900-light-expanded-context-before.png)|[after](images/history-1280x900-light-expanded-context-after.png)|[diff](images/history-1280x900-light-expanded-context-diff.png)|
|history-1280x900-light-expanded|table-region|[before](images/history-1280x900-light-expanded-table-region-before.png)|[after](images/history-1280x900-light-expanded-table-region-after.png)|[diff](images/history-1280x900-light-expanded-table-region-diff.png)|
|history-1600x1000-light-collapsed|context|[before](images/history-1600x1000-light-collapsed-context-before.png)|[after](images/history-1600x1000-light-collapsed-context-after.png)|[diff](images/history-1600x1000-light-collapsed-context-diff.png)|
|history-1600x1000-light-collapsed|table-region|[before](images/history-1600x1000-light-collapsed-table-region-before.png)|[after](images/history-1600x1000-light-collapsed-table-region-after.png)|[diff](images/history-1600x1000-light-collapsed-table-region-diff.png)|
|history-1600x1000-light-expanded|context|[before](images/history-1600x1000-light-expanded-context-before.png)|[after](images/history-1600x1000-light-expanded-context-after.png)|[diff](images/history-1600x1000-light-expanded-context-diff.png)|
|history-1600x1000-light-expanded|table-region|[before](images/history-1600x1000-light-expanded-table-region-before.png)|[after](images/history-1600x1000-light-expanded-table-region-after.png)|[diff](images/history-1600x1000-light-expanded-table-region-diff.png)|
|history-1920x1080-light-collapsed|context|[before](images/history-1920x1080-light-collapsed-context-before.png)|[after](images/history-1920x1080-light-collapsed-context-after.png)|[diff](images/history-1920x1080-light-collapsed-context-diff.png)|
|history-1920x1080-light-collapsed|table-region|[before](images/history-1920x1080-light-collapsed-table-region-before.png)|[after](images/history-1920x1080-light-collapsed-table-region-after.png)|[diff](images/history-1920x1080-light-collapsed-table-region-diff.png)|
|history-1920x1080-light-expanded|context|[before](images/history-1920x1080-light-expanded-context-before.png)|[after](images/history-1920x1080-light-expanded-context-after.png)|[diff](images/history-1920x1080-light-expanded-context-diff.png)|
|history-1920x1080-light-expanded|table-region|[before](images/history-1920x1080-light-expanded-table-region-before.png)|[after](images/history-1920x1080-light-expanded-table-region-after.png)|[diff](images/history-1920x1080-light-expanded-table-region-diff.png)|
|history-1600x700-light-collapsed|context|[before](images/history-1600x700-light-collapsed-context-before.png)|[after](images/history-1600x700-light-collapsed-context-after.png)|[diff](images/history-1600x700-light-collapsed-context-diff.png)|
|history-1600x700-light-collapsed|table-region|[before](images/history-1600x700-light-collapsed-table-region-before.png)|[after](images/history-1600x700-light-collapsed-table-region-after.png)|[diff](images/history-1600x700-light-collapsed-table-region-diff.png)|
|history-1600x700-light-expanded|context|[before](images/history-1600x700-light-expanded-context-before.png)|[after](images/history-1600x700-light-expanded-context-after.png)|[diff](images/history-1600x700-light-expanded-context-diff.png)|
|history-1600x700-light-expanded|table-region|[before](images/history-1600x700-light-expanded-table-region-before.png)|[after](images/history-1600x700-light-expanded-table-region-after.png)|[diff](images/history-1600x700-light-expanded-table-region-diff.png)|
|history-1280x900-dark-collapsed|context|[before](images/history-1280x900-dark-collapsed-context-before.png)|[after](images/history-1280x900-dark-collapsed-context-after.png)|[diff](images/history-1280x900-dark-collapsed-context-diff.png)|
|history-1280x900-dark-collapsed|table-region|[before](images/history-1280x900-dark-collapsed-table-region-before.png)|[after](images/history-1280x900-dark-collapsed-table-region-after.png)|[diff](images/history-1280x900-dark-collapsed-table-region-diff.png)|
|history-1280x900-dark-expanded|context|[before](images/history-1280x900-dark-expanded-context-before.png)|[after](images/history-1280x900-dark-expanded-context-after.png)|[diff](images/history-1280x900-dark-expanded-context-diff.png)|
|history-1280x900-dark-expanded|table-region|[before](images/history-1280x900-dark-expanded-table-region-before.png)|[after](images/history-1280x900-dark-expanded-table-region-after.png)|[diff](images/history-1280x900-dark-expanded-table-region-diff.png)|
|history-1600x1000-dark-collapsed|context|[before](images/history-1600x1000-dark-collapsed-context-before.png)|[after](images/history-1600x1000-dark-collapsed-context-after.png)|[diff](images/history-1600x1000-dark-collapsed-context-diff.png)|
|history-1600x1000-dark-collapsed|table-region|[before](images/history-1600x1000-dark-collapsed-table-region-before.png)|[after](images/history-1600x1000-dark-collapsed-table-region-after.png)|[diff](images/history-1600x1000-dark-collapsed-table-region-diff.png)|
|history-1600x1000-dark-expanded|context|[before](images/history-1600x1000-dark-expanded-context-before.png)|[after](images/history-1600x1000-dark-expanded-context-after.png)|[diff](images/history-1600x1000-dark-expanded-context-diff.png)|
|history-1600x1000-dark-expanded|table-region|[before](images/history-1600x1000-dark-expanded-table-region-before.png)|[after](images/history-1600x1000-dark-expanded-table-region-after.png)|[diff](images/history-1600x1000-dark-expanded-table-region-diff.png)|
|history-1920x1080-dark-collapsed|context|[before](images/history-1920x1080-dark-collapsed-context-before.png)|[after](images/history-1920x1080-dark-collapsed-context-after.png)|[diff](images/history-1920x1080-dark-collapsed-context-diff.png)|
|history-1920x1080-dark-collapsed|table-region|[before](images/history-1920x1080-dark-collapsed-table-region-before.png)|[after](images/history-1920x1080-dark-collapsed-table-region-after.png)|[diff](images/history-1920x1080-dark-collapsed-table-region-diff.png)|
|history-1920x1080-dark-expanded|context|[before](images/history-1920x1080-dark-expanded-context-before.png)|[after](images/history-1920x1080-dark-expanded-context-after.png)|[diff](images/history-1920x1080-dark-expanded-context-diff.png)|
|history-1920x1080-dark-expanded|table-region|[before](images/history-1920x1080-dark-expanded-table-region-before.png)|[after](images/history-1920x1080-dark-expanded-table-region-after.png)|[diff](images/history-1920x1080-dark-expanded-table-region-diff.png)|
|history-1600x700-dark-collapsed|context|[before](images/history-1600x700-dark-collapsed-context-before.png)|[after](images/history-1600x700-dark-collapsed-context-after.png)|[diff](images/history-1600x700-dark-collapsed-context-diff.png)|
|history-1600x700-dark-collapsed|table-region|[before](images/history-1600x700-dark-collapsed-table-region-before.png)|[after](images/history-1600x700-dark-collapsed-table-region-after.png)|[diff](images/history-1600x700-dark-collapsed-table-region-diff.png)|
|history-1600x700-dark-expanded|context|[before](images/history-1600x700-dark-expanded-context-before.png)|[after](images/history-1600x700-dark-expanded-context-after.png)|[diff](images/history-1600x700-dark-expanded-context-diff.png)|
|history-1600x700-dark-expanded|table-region|[before](images/history-1600x700-dark-expanded-table-region-before.png)|[after](images/history-1600x700-dark-expanded-table-region-after.png)|[diff](images/history-1600x700-dark-expanded-table-region-diff.png)|

## Additional state and keyboard views

These after-only views have no fabricated baseline counterpart. Fresh metrics in the ledger describe the actual scroll position; the opened legacy receipt context is intentionally scrolled to that record.

- [history-empty-1600x700-light-context-after.png](images/history-empty-1600x700-light-context-after.png)
- [history-one-1600x700-light-context-after.png](images/history-one-1600x700-light-context-after.png)
- [history-many-1600x700-light-context-after.png](images/history-many-1600x700-light-context-after.png)
- [history-many-1600x700-light-full-identity-after.png](images/history-many-1600x700-light-full-identity-after.png)
- [history-many-1600x700-light-last-rows-after.png](images/history-many-1600x700-light-last-rows-after.png)
- [history-long-1600x700-light-context-after.png](images/history-long-1600x700-light-context-after.png)
- [history-long-1600x700-light-full-identity-after.png](images/history-long-1600x700-light-full-identity-after.png)
- [history-long-1600x700-light-full-reviewer-after.png](images/history-long-1600x700-light-full-reviewer-after.png)
- [history-long-1600x700-light-last-rows-after.png](images/history-long-1600x700-light-last-rows-after.png)
- [history-loading-1600x700-light-context-after.png](images/history-loading-1600x700-light-context-after.png)
- [history-error-1600x700-light-context-after.png](images/history-error-1600x700-light-context-after.png)
- [history-disconnected-1600x700-light-context-after.png](images/history-disconnected-1600x700-light-context-after.png)
- [history-native-1600x700-light-context-after.png](images/history-native-1600x700-light-context-after.png)
- [history-native-1600x700-light-requested-fixture-image-after.png](images/history-native-1600x700-light-requested-fixture-image-after.png)
- [history-native-receipts-1600x700-light-context-after.png](images/history-native-receipts-1600x700-light-context-after.png)
- [history-native-receipts-1600x700-light-requested-fixture-image-after.png](images/history-native-receipts-1600x700-light-requested-fixture-image-after.png)
- [history-saved-report-1600x700-light-context-after.png](images/history-saved-report-1600x700-light-context-after.png)
- [history-saved-report-1600x700-light-keyboard-bottom-after.png](images/history-saved-report-1600x700-light-keyboard-bottom-after.png)
- [history-current-1600x700-light-context-after.png](images/history-current-1600x700-light-context-after.png)
- [history-current-1600x700-light-keyboard-bottom-after.png](images/history-current-1600x700-light-keyboard-bottom-after.png)
- [history-current-1600x700-light-collapsed-context-after.png](images/history-current-1600x700-light-collapsed-context-after.png)
- [history-current-1600x700-light-collapsed-keyboard-bottom-after.png](images/history-current-1600x700-light-collapsed-keyboard-bottom-after.png)
- [history-saved-report-1600x700-light-collapsed-context-after.png](images/history-saved-report-1600x700-light-collapsed-context-after.png)
- [history-saved-report-1600x700-light-collapsed-keyboard-bottom-after.png](images/history-saved-report-1600x700-light-collapsed-keyboard-bottom-after.png)
- [history-empty-1600x700-dark-context-after.png](images/history-empty-1600x700-dark-context-after.png)
- [history-one-1600x700-dark-context-after.png](images/history-one-1600x700-dark-context-after.png)
- [history-many-1600x700-dark-context-after.png](images/history-many-1600x700-dark-context-after.png)
- [history-many-1600x700-dark-full-identity-after.png](images/history-many-1600x700-dark-full-identity-after.png)
- [history-many-1600x700-dark-last-rows-after.png](images/history-many-1600x700-dark-last-rows-after.png)
- [history-long-1600x700-dark-context-after.png](images/history-long-1600x700-dark-context-after.png)
- [history-long-1600x700-dark-full-identity-after.png](images/history-long-1600x700-dark-full-identity-after.png)
- [history-long-1600x700-dark-full-reviewer-after.png](images/history-long-1600x700-dark-full-reviewer-after.png)
- [history-long-1600x700-dark-last-rows-after.png](images/history-long-1600x700-dark-last-rows-after.png)
- [history-loading-1600x700-dark-context-after.png](images/history-loading-1600x700-dark-context-after.png)
- [history-error-1600x700-dark-context-after.png](images/history-error-1600x700-dark-context-after.png)
- [history-disconnected-1600x700-dark-context-after.png](images/history-disconnected-1600x700-dark-context-after.png)
- [history-native-1600x700-dark-context-after.png](images/history-native-1600x700-dark-context-after.png)
- [history-native-1600x700-dark-requested-fixture-image-after.png](images/history-native-1600x700-dark-requested-fixture-image-after.png)
- [history-native-receipts-1600x700-dark-context-after.png](images/history-native-receipts-1600x700-dark-context-after.png)
- [history-native-receipts-1600x700-dark-requested-fixture-image-after.png](images/history-native-receipts-1600x700-dark-requested-fixture-image-after.png)
- [history-saved-report-1600x700-dark-context-after.png](images/history-saved-report-1600x700-dark-context-after.png)
- [history-saved-report-1600x700-dark-keyboard-bottom-after.png](images/history-saved-report-1600x700-dark-keyboard-bottom-after.png)
- [history-current-1600x700-dark-context-after.png](images/history-current-1600x700-dark-context-after.png)
- [history-current-1600x700-dark-keyboard-bottom-after.png](images/history-current-1600x700-dark-keyboard-bottom-after.png)
- [history-current-1600x700-dark-collapsed-context-after.png](images/history-current-1600x700-dark-collapsed-context-after.png)
- [history-current-1600x700-dark-collapsed-keyboard-bottom-after.png](images/history-current-1600x700-dark-collapsed-keyboard-bottom-after.png)
- [history-saved-report-1600x700-dark-collapsed-context-after.png](images/history-saved-report-1600x700-dark-collapsed-context-after.png)
- [history-saved-report-1600x700-dark-collapsed-keyboard-bottom-after.png](images/history-saved-report-1600x700-dark-collapsed-keyboard-bottom-after.png)
