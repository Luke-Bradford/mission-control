# Visual planning and QA

Use this workflow for visible changes: pages, dashboards, tables, shared styles and native mockups.
It complements [HUD design](../../.claude/skills/hud-design/SKILL.md),
[dashboard composition](../../.claude/skills/hud-design/references/dashboard-layout.md)
and [table QA](table-qa.md). Scale the work to the affected surface. A small form correction
does not need a new whole-site design exercise.

## Plan a reviewable change

The planner records a compact design contract in the ticket's Design section. A developer without
a separate plan records it before a substantial layout change. Include:

- The operator's task and the decisions the first view must support.
- The current page and accepted reference, with source commits. Name strengths and fields to preserve.
- Normal data, field limits and exceptional states. A fifty-row stress case does not replace normal data.
- Essential first-screen content, secondary detail and its visible route. Explain movement or disclosure.
- A panel budget: meaningful columns/rows, minimum/preferred/maximum widths, useful height and why.
- Supported CSS viewport, height, theme, rail and scaling cases; expected recomposition at each breakpoint. Use the height the page really gets after browser toolbars, as listed in the [composition reference](../../.claude/skills/hud-design/references/dashboard-layout.md#viewports-use-the-real-ones).

Include the promised layout outcome as well as required data. “All metrics remain visible” is weaker
than “adapt the Overview coherently across 1080p and 4K while preserving accepted seat geometry”.
The review handoff must carry both; otherwise the reviewer cannot judge the actual acceptance scope.

For example, a seat table needs room for identity, state, work, rate, cost, context and actions.
Its width comes from readable columns. A history plot needs room to compare values and read axes.
Neither gets an arbitrary share of leftover space. Reuse existing tokens and accepted compact density.
For substantial redesigns, show the design first as the real app on a branch (see [Show it on a branch](#show-it-on-a-branch)), before the rest of the build.

| Surface | Decision / fields | Normal rows | Size budget and reason | Full detail / retained behavior |
| --- | --- | --- | --- | --- |
| Name each affected visual | What someone can determine or do | Actual representative count | Width range, height and responsive change | Route, keyboard access and preserved actions |

Treat an approved reference as a baseline, not permanent authority. Later operator steering and
demonstrated defects can supersede it. Record the reason; preserve the old reference as history.

## Show it on a branch

New pages and big visual changes are shown as the real app on the ticket's branch, with Demo data, so
the operator sees the fonts, styles and padding the page would ship with. A static mockup file is not
served and a design does not merge to main by itself: after approval the build continues on the same
branch.

1. Build the design in `apps/web` on the ticket's branch. Add any new page's data to the Demo seed, so
   the page is full when it opens.
2. Merge main (`mc sync_main`), commit, and run `pnpm -s build` in your worktree. The build stays in your
   sandbox; the hub never runs a branch's code.
3. Call `mc publish_preview`. The hub copies the built files from `apps/web/dist` and answers with the
   URL, `http://127.0.0.1:7440/`. It refuses a dirty tree, a build with a link or a file type it does
   not serve (it serves `.html .js .mjs .css .svg .png .ico .woff .woff2 .webmanifest`), and a build
   over 64 MB or 2,000 files.
4. Send FLIGHT the URL in a handoff. Never send a `file://` link: the operator cannot open it.

What the hub does with it: one preview runs at a time (`POST /api/design-previews/:ticket/open`
replaces the running one; a publish takes the slot only when it is empty). A preview stops after an hour
unused; its files go when its PR closes or merges, or after 7 days. Five builds are kept; a sixth
deletes the oldest that is not running. A restart keeps the builds with nothing running.

The preview is on its own origin (port 7440, loopback only) with no operator token and no proxy to the
hub. Its security headers let the page talk to itself only, and the hub refuses any `/api/` request
marked `same-site`, so the branch's script cannot read or change anything in the hub. If port 7440 is
taken, the hub logs that and starts without previews.

## Build stable evidence

Use the repository's browser harness and real application shell. Label a static proposal or isolated
component as such. Keep the existing test stack; these practices do not require another framework.

- Wait for meaningful populated content, loaded fonts and decoded images. Control fixture clocks,
  data and asset success/error responses. Avoid third-party DNS and arbitrary sleeps as readiness checks.
- Use bounded assertions for actual visible content, focus, hit targets and scroll endpoints.
  Reaching `scrollTop` or finding an accessible name alone does not prove painted, readable content.
- Keep browser, OS, fonts and rendering settings consistent for pixel comparisons. Record differences
  rather than treating platform noise as a product defect. A pixel diff detects change, not design quality.
- Exercise the affected empty, one, normal, many, long, loading, error, stale and disconnected cases.
  Use the schema's actual long-content limits. Add interaction cases where the change introduces risk.
- For dashboard layout changes, use the viewport matrix in the composition reference, plus smaller/short
  supported views. For local changes, choose affected cases and state the remaining limits explicitly.
  Device scale 2 is not a substitute for browser zoom or a true wider CSS viewport.
- Test keyboard navigation, detail/reader return and overlays. Where scaling changes, verify real text
  enlargement/reflow separately. A dense table's two-dimensional needs do not excuse a broken page shell.

Use fixture data for public evidence. Keep actual operational captures private under the existing rules.
Do not start providers, mutate observed loops or restart the live hub to create proof.

## Inspect the page before the measurements

The reviewer first views the settled full viewport and attempts the declared operator task.
Record an initial judgment before using the author's pass summary or geometry to justify it.
Then inspect focused panels and exercise affected interactions. Source review and artifact validation
are different evidence from seeing and using the result.

| Review dimension | What the reviewer must explain |
| --- | --- |
| Task and hierarchy | Can someone identify active/held work, constraints and the next action? Is the most useful content prominent? |
| Composition and screen use | Do columns align and related regions group together? Do blank regions clarify grouping or delay useful information? Does the largest panel deserve that space? |
| Tables and text | Are column proportions, padding, density, alignment and permitted truncation useful? Can the complete value and last action be reached visibly? |
| Charts and meaning | Is this chart appropriate? Are units, time, scale, denominator, missing data and freshness clear? Is its aspect ratio useful? Is information repeated? |
| Responsive behavior | Does the layout recompose across the declared viewports without squeezing important content, enlarging empty plots or losing accepted strengths? |
| Interaction and states | Do keyboard focus, error/retry, forms, filters, readers and overlays work in the real shell? |

Write a concrete observation and an image or interaction receipt for each applicable dimension.
“No overflow”, “all tests pass” and an image count are insufficient design observations.
Do not impose a target percentage of filled pixels. Bounded widths and whitespace can be correct;
they need to support the task, readable comparisons and coherent grouping.

An Important finding includes missing essential status, unreadable content or a material failure of
the ticket's promised layout outcome. It can exist when every panel fits and all metrics are present.
For a responsive redesign, a whole-breakpoint composition that needs recomposition is different from
an isolated cosmetic alignment issue. Explain the violated acceptance criterion and impact; whitespace
alone is not a severity threshold. Minor polish stays Minor. Do not average an Important defect into a passing score.
Give a reproduction, affected source and image, impact and concrete correction outcome.

Independent rendering is preferred for final application QA. If the reviewer only inspects supplied
images, say so. That can assess visible composition, but cannot establish unperformed interactions.
If the required render cannot run, record the missing coverage and reason; do not claim a rendered pass.

## Retain context and detail

For each changed layout, retain a matched **viewport** before/after pair. For a local form or table,
add a focused pair. Preserve the original context images when cropping. A full-page image and optional
diff supplement these; a tall full-page capture cannot establish what fits on one screen.

Use one retained manifest or equivalent explicit provenance with these facts:

| Identity | Rendering context | Capture scope |
| --- | --- | --- |
| PR, published head, actual rendered source, baseline, capture time, image hashes | CSS width/height, DPR, zoom, theme, rail, browser/OS, data fixture, clock, scroll | Viewport / full-page / crop, crop region, source image, interaction state |

State unknown values. If Before is reconstructed later, name its original production source and the
shared capture harness; do not backdate it. Label prototype iterations separately from product changes.
After corrections, refresh affected evidence and bind it to the new source. Earlier images may remain
as explicitly historical phases; do not relabel them as executions on the current head.

## Publish an accountable report

Use the existing saved QA report, not a second unlinked review document. A supporting manifest may
live in Git; the immutable report permalink belongs in the PR, relevant ticket and rework handoff.

| Existing field | Required account |
| --- | --- |
| Summary / verdict | Exact change, assessed phase and outcome; distinguish proposal, implementation and live verification. |
| Coverage notes | Browser cases and the observations above. Say who rendered and who inspected supplied evidence. |
| Tests and CI | Commands, actual outcomes/counts, exit and log receipts; fresh CI head/checkout and jobs. Do not count filtered tests as executed or sum overlapping runs as unique coverage. |
| Visual evidence | Matched context/focused pairs, source identities, manifest and labels. Explain genuine nonvisual applicability. |
| Findings / resolutions | Severity, reproduction, evidence, impact, correction and source-bound recheck. Preserve rejected phases. |
| Works well | Specific strengths that should survive rework. |
| Limitations / follow-ups | Untested cases and remaining work, with disposition, owner or named ticket and reason. |

Use checklist statuses with observations, rather than ticks alone. Fold defects in the promised outcome
into the current PR. Put genuinely separate work in a named ticket; do not defer a blocking defect to
make the current review green. Missing evidence remains missing. A complete failed report is useful;
“complete” describes its account, not deployment readiness.

At handoff, state the reviewed source, current published head, CI result, immutable report link,
unresolved findings and active holds. Historical passing reports never override a later failed review.
If a head changes, reconcile the changed scope and CI before treating the earlier evidence as current.
Name explicit operator holds even when the reviewer otherwise finds only Minor issues. A clean review
does not override a rejected reference or authorize a different design direction.

## Calibrate the workflow

For substantial workflow revisions, try an independent reviewer on a known defective artifact without
supplying its expected verdict. Check the actual observations and missed defects, not checklist presence.
Use findings to improve the workflow. One successful calibration does not prove future review quality.

Research, source versions and adoption decisions: [dashboard QA review](../research/2026-11-03-dashboard-qa-workflow.md).
