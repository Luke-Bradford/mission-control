# Dashboard planning and QA workflow review

3 November 2026. This is a source review and adoption decision, not a production usability sign-off.

## Why the workflow failed

The repository already had composition guidance. PR #1384 nevertheless received a clean recommendation
while its true CSS 3840×2160 dark proposal had large empty regions, oversized Machine plots, duplicate
token history and a detached comparison grid. Fit, label, interaction and artifact checks were treated
as sufficient whole-page review. The controller and author later inspected the exact retained After
image and agreed that the composition fails. This is a judgment and handoff failure, not a lack of images.

Evidence head: `008b362dc7748279ef2eb3129f5eb4b826a3d842`.
Visual source: `0c92ee23dfe9973203167e0299a6d1950c024dbc`.
Rejected After SHA256: `1e40755dd0fa8a7b93db8c451e0ec6c25c64dd56d954fb696dd2889de27ecbe8`.
[Complete failed reassessment](http://127.0.0.1:7420/qa?repo=mission-control&pr=1384&report=1fe40c8e16ae4629b1d5bf5abe9ed501855fca0efc1e859919f20e3244a7a749).
The report preserves two prototype pairs and twelve supplementary images. It does not claim a product fix.

Read-only workflow audit at `cb133e64`, 13:42:50 UTC, identified these integration gaps:

| Gap | Change in this guidance branch | Remaining runtime work |
| --- | --- | --- |
| Planner's Design section applies only to apps/web and does not explicitly carry panel budgets | FAO now records the visual contract for mockups and visible changes | Confirm the emitted plan carries those facts during actual use |
| Reviewer says default theme and narrowest/widest widths, narrower than dashboard guidance | RETRO follows the declared dashboard matrix and inspects whole-page allocation | Review quality still requires seeing and using the artifact |
| Clean artifact/geometry checks mistaken for design approval | Shared visual workflow separates composition, behavior, provenance and CI | No automatic check can judge good composition from image counts |
| Coverage notes are optional; design failure can contradict verdict/findings | Document consistent verdicts and explicit missing evidence | Separate implementation is in progress; this branch does not enforce report validation |
| Capture context is mostly free text | Standard manifest facts and context/focused pair practice | Typed capture metadata/UI could improve later; no new schema claimed here |
| Uncontrolled image outcomes can change focus during tests | Document deterministic assets and semantic readiness | Separate QA image-focus implementation exists; not delivered by this branch |

## Primary design and testing guidance

All links below were inspected on 3 November 2026. These are selected principles written into local
practice, not copied manuals or a replacement for Mission Control's accepted design and data.

| Source | Useful practice | Application here |
| --- | --- | --- |
| [IBM Carbon dashboards](https://www.carbondesignsystem.com/building-blocks/data-visualization/dashboards) | Establish hierarchy; use spacing for grouping; distinguish overview from exploration | Inspect the settled page and its information priorities before crops or bounds |
| [Microsoft dashboard design](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips) | Define audience and decisions; keep monitoring concise; choose appropriate comparisons | Declare essential status and retain an obvious path to complete detail |
| [Grafana dashboard practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) | Give a dashboard a purpose, reduce cognitive load and organize drill-downs | Keep operational overview, detailed investigation and refresh needs deliberate |
| [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots) | Rendering environment affects screenshots; compare and review versioned baselines | Match environment and capture context; do not bless a new baseline to hide a defect |
| [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing) | Automated checks cover only part of accessibility | Combine meaningful automated checks with keyboard and visual inspection |
| [W3C Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html), [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | Enlargement, reflow and visible focus are distinct requirements | Test scaling and overlays separately; DPR2 alone proves none of these |

The W3C links explain specific WCAG criteria. This work does not claim a whole-application conformance
audit. A table's two-dimensional layout exception does not extend to the rest of the page.

## Online skill assessment

Inspected upstream sources, rather than installation counts or marketplace summaries. The revisions
below identify the assessed material; later upstream changes need reassessment. No third-party skill,
binary or dependency is installed by this branch. Local instructions are an original adaptation.

| Candidate and inspected revision | Useful part | Fit and decision |
| --- | --- | --- |
| [Vercel web-design-guidelines](https://github.com/vercel-labs/agent-skills/blob/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/web-design-guidelines/SKILL.md), referencing [interface rules](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md) | Concrete interface checks for semantics, focus, forms, long content and themes | Useful technical supplement. Its code-oriented audit does not replace dashboard composition review. Adopt relevant checks through local rules, not a runtime fetch dependency. |
| [Impeccable critique](https://github.com/pbakaus/impeccable/blob/9fadc41729c38fd47d7ae622b501558653f9d2e9/skill/reference/critique.md) and [surface modes](https://github.com/pbakaus/impeccable/blob/9fadc41729c38fd47d7ae622b501558653f9d2e9/skill/SKILL.src.md) | Separate design critique from detector results; treat operational UI differently from promotional design; preserve critique history | Adapt qualitative-first assessment and task-specific restraint. Its complete launcher, detector, mandatory assessment and question workflow is broader than this repository needs. Do not claim to have executed the upstream skill. |
| [Anthropic frontend-design](https://github.com/anthropics/skills/blob/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design/SKILL.md) | Deliberate layout/typography and self-critique | A local frontend-design skill already exists. Visual direction helps, but alone supplies no exact-head QA or dashboard acceptance contract. |
| [Anthropic webapp-testing](https://github.com/anthropics/skills/blob/ca45fc496a3436251f191354091d557da31c15b5/skills/webapp-testing/SKILL.md) | Inspect rendered state before interacting and retain browser evidence | Keep the existing harness. Its blanket networkidle advice is unsuitable as our readiness rule; [Playwright discourages that wait for testing](https://playwright.dev/docs/api/class-page#page-wait-for-load-state). Assert the actual loaded state. |
| [OpenAI Playwright skill](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/playwright/SKILL.md) | Real-browser exploration, refreshed element references and traces | Available in the curated catalog; useful for ad hoc exploration. It is a CLI workflow, not a substitute for repository regression tests or a design verdict. |
| [UI/UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/713eef51b04efc98d6fa565323b495f7c9c89fd4/.claude/skills/ui-ux-pro-max/SKILL.md) | Searchable component, chart and UX references | Useful optional research. Do not import blanket mobile sizing or palette defaults over accepted dense desktop geometry. A large catalog cannot decide our operational priorities. |

Recommendation: strengthen the existing HUD skill and role handoffs, rather than install several
overlapping design authorities. Use primary guidance for rationale, the application contract for
decisions, real browser evidence for behavior and independent critique for composition.

## What this changes and what it cannot guarantee

The [visual workflow](../runbooks/visual-qa.md) now connects planning, evidence, rendered critique and
the existing report fields. It requires a source-bound account of task, allocation, tables, charts,
responsive behavior, interactions and limits. The HUD entrypoint remains short and routes to details.
FAO, INCO and RETRO receive the same contract through their existing roles.

This is procedural guidance. It does not introduce a CI workflow, a new visual-diff service or a
runtime merge gate. Existing Important findings remain blocking under normal review rules. Report
consistency validation is separate work; an honest failed report must remain retainable. Quality
depends on applying and calibrating the workflow, not on declaring every checklist box complete.

## Local validation and calibration

The skill frontmatter validator passed. The HUD checklist remains 288 words; all thirteen local links
checked at that stage resolve. Existing role-design checks passed 18/18 and repository lint exited zero,
with existing warnings. These checks validate wiring and format, not the quality of a design decision.

A fresh reviewer received only the workflow, raw 1920/4K images, source identities and a short task brief.
They did not receive the earlier findings or this research note. They independently noticed the large
Machine plots, duplicate history, detached grid and blank regions, while preserving the compact Crew
strength and explicitly limiting their conclusions to images. They rated the allocation issues Minor
because essential status remained visible. This is a useful detection result, not agreement with the
controller's Important finding or proof that the workflow reliably blocks this failure.

The calibration brief described required data more clearly than the promised responsive-layout outcome.
The workflow now explicitly requires both in the handoff and distinguishes a whole-breakpoint redesign
failure from isolated polish. Severity needs a cited acceptance criterion and impact, not a count of
empty pixels. Actual operator holds remain authoritative regardless of a reviewer's severity judgment.
This clarification still needs forward validation; no universal visual-quality guarantee is claimed.
