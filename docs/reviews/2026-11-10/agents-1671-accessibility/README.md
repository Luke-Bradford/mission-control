# Agents prototype accessibility rework

The existing Agents proposal keeps its roster, selected-seat identity, instruments, activity and side column. It now uses actual-size text and controls at narrower and shorter viewports, working keyboard activity filters, and full-title details for ticket and run rows. This updates the existing prototype PR; it builds no application page.

## Current proposal

[1920×940 dark](agents-after-1920x940-dark.png) · [1280×940 dark](agents-after-1280x940-dark.png) · [1600×700 light](agents-after-1600x700-light.png) · [Run details](agents-run-details-1280x940-dark.png) · [Long title](agents-long-title-1280x940-dark.png) · [Idle activity](agents-idle-1280x940-dark.png).

## Findings addressed

- **Whole-page scaling:** removed the transform and resize scaling script. The page fills its CSS viewport. At 1280 the instruments recompose into two rows; the roster keeps readable call signs. Activity, roster and side lists scroll within the fixed page shell. Required body text stays at least 12px, mono micro-labels at least 11px, and visible controls at least 24×24px. Light preference has its own palette.
- **Inert activity filters:** All, Messages, Thinking, Tools and Guard are native buttons with selected-state semantics, visible focus and a controlled feed. Space selects a category; All restores the complete retained activity. Filtering an idle snapshot preserves its written empty state.
- **Unreadable full titles:** waiting-ticket titles and recent-run rows are native buttons. Focus reveals the complete free text; activation opens a modal with the full title and retained record details. Escape closes it and returns focus. A 300-character unbroken title wraps visibly inside the dialog.

## Evidence and observations

The controller authored the rework, rendered it with Playwright Chromium and inspected the settled 1920×940 dark, 1280×940 dark, 1600×700 light and long-title views. The first render exposed cramped roster names and figure controls at 1280; those were corrected before this packet. That earlier phase remains retained privately and is not the current evidence.

The selected identity and current work remain prominent. The instruments retain context, loop, plan and figures. At 1280 the figures move below context/loop, while the roster remains wide enough to identify each seat. The short view still shows the activity, message box, waiting context and plan, with independent scrolling for longer content. The modal makes the complete title visible without widening the page.

Sixteen viewport images form eight before/after pairs: 1280×940, 1600×940, 1920×940 and 1600×700, with both colour preferences. Before was reconstructed from `686252d31138e3c445d24391e3fe29053498cd20` during this capture. Before is dark-only, so its light-preference cases remain dark; After respects that preference. The same exported dataset and local, repository-locked font files are used for both phases. Only the font stylesheet URL is replaced by the harness to avoid a network-dependent font fallback. No font size is overridden by the harness.

The [receipt](receipt.json) retains capture times, source/font hashes, loaded font weights, transform, page bounds, control/text minima and 46 observations. The latter include native keyboard filters, full-title access, focus return, reaching the last roster seat, idle and filtered-empty activity, and the long-title dialog. No browser errors occurred. Inline scripts parse and `git diff --check` passes. These are targeted prototype checks, not a rerun of the application suite.

The nine-seat dataset, original summaries and placeholder context/activity/plan data are unchanged. The Comms HTML and PNG are byte-for-byte unchanged from the reviewed baseline. The refreshed primary Agents PNG is the retained 1920×940 dark After image.

## Limits and handoff

This is an author render of a static export, not independent QA or live application proof. It has no production API, real agent controls, live activity or full run transcript. The new row dialog shows the retained title and metadata. Other prototype controls retain their existing illustrative behavior. A future application implementation still needs its own acceptance checks and review.

The previous independent report on 686252d failed design with three Important findings. These changes request one fresh review of the new published head; they do not overwrite that report or waive its findings. Application approval is separate from merging reference files. No new operator approval is inferred here.

[capture.mjs](capture.mjs) is the exact controller harness. It reads local paths recorded in the source; reproduce by pointing its worktree and evidence paths at this branch and installing the repository's locked Playwright/font dependencies with Node 26. It serves only the two static HTML phases and fonts on its own port, closes the browser and server after capture, and never contacts the hub.
