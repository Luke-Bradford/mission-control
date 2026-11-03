# QA design-report consistency

A report declaring design failure could still provide passing verdicts and no blocking finding. Both native and controller paths now reject that contradiction before report I/O. They require the reviewer to supply the actual finding; the server does not invent one.

For required visual evidence, absent or unperformed browser/design coverage and absent design observations remain saveable as explicitly incomplete. Honest failed reports, immutable history, retained images and genuine nonvisual exclusions remain supported. This change does not infer visual quality or introduce a new merge/approval reader.

Source is `e8c4398d0a1c9760cdee46d64cc84ed07b73ebe7`, against `cb133e64e36c45f53ce841354e1290ecf0931a92`. Subsequent evidence-only commits do not change source or tests. All original and retained log hashes and the sole path normalization are in [manifest.json](manifest.json).

| Stage | Actual result | Receipt |
| --- | --- | --- |
| New regressions with baseline production | 9 failed, 3 passed, 407 filtered; exit 1, 2.44s | [Red](logs/mc-qa-consistency-red.log) |
| Author implementation pack | 63 passed, 358 filtered; exit 0, 7.25s | [Green](logs/mc-qa-consistency-green.log) |
| Test-only fixture-guard cleanup | 9 passed, 32 filtered; exit 0, 1.63s | [Cleanup](logs/mc-qa-consistency-final-visual.log) |
| Server types after cleanup | Exit 0 | [Types](logs/mc-qa-consistency-final-types.log) |
| Fresh independent exact-source pack | 63 passed, 358 filtered; exit 0, 7.12s | [Independent](logs/mc-qa-report-consistency-independent-e8.log) |

These are overlapping executions, not a sum of unique tests. The 63-case packs include the entire 41-case QA report file and 22 native report_findings cases. Native/API boundaries, failure atomicity, completeness, valid failed/nonvisual controls and existing asset/auth/history/CI cases are retained. The independent reviewer inspected all three changed files and relevant callers at 14:03:39 UTC on 3 November 2026 and found no Critical, Important or Minor issues.

Changed-file formatting and whitespace passed; formatting retains three existing warnings and one info. No full local suite, browser, provider, crew, observed-loop, config or deployment action was performed. Exact-head CI remains a separate gate. Before/after pictures are not applicable: this changes server report validation, not the visual product.
