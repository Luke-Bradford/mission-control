# QA image error and retry focus

Source review clean; final artifact review and exact-head CI are separate gates. No merge or deployment is claimed here. Refs #925 and #656; this fix does not close their wider outcomes.

When a focused QA preview failed, its anchor disappeared and keyboard focus fell to BODY. The reader now moves to the equivalent source/retry control. A retry returns to its preview when it finishes, while an operator who has moved elsewhere keeps their focus. Permanent provenance links cannot consume a pending preview restoration.

## Before and after

Both sides use the real App at 1600×700, the same fictional API report, clock and controlled image outcomes. These images depict a **fixture report**; counts printed inside that report are illustrative, not this PR's results.

| Theme | Original error state: focus lost | Corrected error state: source focused | Retry preview focused |
| --- | --- | --- | --- |
| Light | [before](images/qa-error-light-before.png) | [after](images/qa-error-light-after.png) | [retry](images/qa-retry-light-after.png) |
| Dark | [before](images/qa-error-dark-before.png) | [after](images/qa-error-dark-after.png) | [retry](images/qa-retry-dark-after.png) |

Before is a later reconstruction at `fc0b2ba4294a820fec6d9e7d4ad62afd9fd4165b`: original production component from `cb133e64`, with the exact controlled test harness used after. After source is `c478ef728f9ba405dd8073d93f478b79ed16e7e4`; its tested workingtree was frozen unchanged after capture. The two trees differ only in the production QA report component. Actual capture times, file hashes and log provenance are in [manifest.json](manifest.json). A later before-capture is not backdated as an earlier sign-off.

## Actual checks

| Stage | Result and scope |
| --- | --- |
| New linked-focus unit on original production | 1 failed, 1 passed, 9 filtered. Failure was focus loss, not setup. |
| Shared App capture on original production | 2 failed, 3 filtered, 3.19s. Both themes fail `focused:false` after saving the baseline frames. |
| Corrected component file | 13 passed, 1.07s. Includes retained asset+sourceUrl asynchronous retry, no-steal, original evidence/error/security checks. |
| Corrected production App | 3 passed, 7 filtered, 8.54s. Two linked-error/retry theme cases plus the unchanged eight-combination Current/saved QA navigation case with controlled decoded images. |
| Web types and changed-file formatting | Passed; retained command receipts below. |

These are stages, not a combined unique test total. Browser checks use controlled linked images; asynchronous retained-image behavior is unit-covered. No full local suite or actual live data/provider behavior is claimed. Full CI remains required.

The helper's raw image responses are opt-in. The static navigation test no longer depends on reserved-domain DNS/error timing and retains every identity, visibility, width and navigation assertion. The separately reviewed Agent settling patch also retains all final predicates, tolerances and the one-second budget; its original Linux cause remains unproven.

## Independent review

Whole-branch source `d58ca330` had one Important finding: a retained retry could focus the permanent Git provenance link. Corrected `c478ef72` uses explicit primary image-control markers; both retained unit scenarios include sourceUrl. Same-pass source/render correction review is clean at 13:18 UTC on 3 November. The reviewer inspected supplied actual frames and receipts; they did not rerun these browser cases. Original findings and failure evidence remain retained.

## Reproduce

```sh
pnpm exec vitest run --project web apps/web/test/QaReport.test.tsx --maxWorkers=1
MC_QA_IMAGE_FOCUS_SHOTS=/tmp/qa-image-focus pnpm exec vitest run --project web apps/web/test/QaReport.browser.test.ts apps/web/test/QaHistory.browser.test.ts -t 'keeps image-error|keeps Current and filled saved reports' --maxWorkers=1
```

[Baseline unit red](logs/mc-925-qa-focus-red.log) · [baseline App red](logs/mc-925-qa-focus-browser-baseline-red.log) · [corrected units](logs/mc-925-qa-focus-green3.log) · [corrected App](logs/mc-925-qa-focus-browser1.log) · [types](logs/mc-925-qa-focus-types2.log) · [format](logs/mc-925-qa-focus-format3.log).

Security: existing evidence URL validation, authenticated retained-PNG reads and blob cleanup remain intact. No new production request, actor scope or write action. The browser fixture intercepts only explicitly supplied test URLs. No workflow, config or observed-loop change.
