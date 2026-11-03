# Current-main integration for #1378

Integration source: `cdd8930bed697299fc023175e98666a407ae6239`.
Its actual Git parents are reviewed UI `2470a46d40cde4f5909e050e660be241529dcd3e` and
merged main `b94125aa917954f456c10c4608355e4c7d6b6e0c`. `git merge --no-edit origin/main`
completed without conflicts. No production code was copied manually or corrected during integration.
Backend PR #1381 is merged at b941; the controller reports exact-head CI 41656708250 green
(12,751 passed/26 skipped, all seven jobs) and the normal Update deployed b941. This UI record
makes no provider-compliance claim from that deployment or from fictional web fixtures.

## Scope and review binding

Relative to b941, the feature remains only the reviewed Knows/status/Agent/Crew instruction UI,
resource/actions, Queue provenance, decision links, shared read DTOs, tests and its supporting evidence.
No server, role, workflow, CLAUDE, shared-shell or Overview source differs from merged main.
All owned UI production files, instruction tests/fixture and core DTO file are byte-identical to
reviewed 247/76. The imported main changes are QA report behavior/tests, browser-harness controlled
image responses, server review/handoff guidance and documentation. The merge did not alter selector,
auth, pause, provider or runtime authority. Publication and CI remain separate from merge/deployment.

The controller described the original whole/narrow UI reviews as clean before this integration.
The whole review of 959 found one Minor Queue-link capability issue, corrected at 76 and retained
in [watch-correction.md](watch-correction.md). Current integration still needs its narrow independent
review and fresh exact-head CI; no historical passing report is presented as current CI approval.

## Evidence phases

| Phase | Actual production source | Scope |
| --- | --- | --- |
| Original baseline | f205cab3 | Reconstructed later with shared harness261; full 120-context before set |
| Original implementation | 26117146 | Full four-size, five-dataset, two-theme matrix, 120 contexts |
| Watch-seat correction | 76a00706 | Thirty short-height contexts and writer/watch action regression |
| Current merged baseline | b94125aa | New detached worktree; thirty newly captured short-height contexts |
| Current integration | cdd8930b | Thirty newly captured short-height contexts; owned UI unchanged from76 |

Earlier images and logs retain their original source identities. They were not rerun or relabelled
as cdd executions. Current captures use new b941/cdd directories, exact source metadata and a separate
[integration-artifacts.json](integration-artifacts.json) ledger. The actual source needs no wider
layout revalidation from this merge: the affected UI/CSS is byte-identical, and imported QA-page
behavior does not appear on the rendered FLIGHT/Agent routes. The current short-height recheck
covers integration risk; the four-size matrix remains historical evidence, an explicit coverage limit.

## Current checks

Executed in the implementation worktree, sequentially, with at most three unit workers:

```sh
pnpm exec vitest run --project web apps/web/test/Instructions.test.tsx apps/web/test/Flight.test.tsx apps/web/test/Agent.test.tsx apps/web/test/data.test.ts apps/web/test/api.test.ts apps/web/test/flightConversation.test.ts apps/web/test/QaReport.test.tsx --maxWorkers=3
pnpm -s typecheck
pnpm -s lint
pnpm -s build
```

All exited 0. Tests: 375 passed, no filtered cases, seven files, 4.84s: 16 instructions, 114 Flight,
148 Agent, 41 data, 31 API, 12 conversation and 13 QA-report cases. Workspace types checked five projects.
Lint checked 1,119 files with 76 warnings/seven infos, no fixes; core cycles checked 60 modules and passed.
Vite built 369 modules in 979ms. Existing test-environment search/localstorage warnings remain visible.
No full local suite or test:related expansion ran; the controller authorized bounded affected checks.

The new detached b941 baseline installed dependencies with
`pnpm install --offline --ignore-scripts --frozen-lockfile` (exit 0). Only the unchanged instruction
browser test and fictional fixture were copied as untracked baseline instrumentation. Its tracked
production tree remains exact b941; this was not a manual production integration.

Current before/after command, one browser worker per phase:

```sh
pnpm exec vitest run --project web apps/web/test/Instructions.browser.test.ts --maxWorkers=1 -t '1600x700'
```

The actual Python invoker sets `MC_INSTRUCTION_QA_FULL=1`,
`MC_INSTRUCTION_QA_DIR=/tmp/mc-1378-integration-<before|after>-<b94125aa|cdd8930b>`,
`MC_INSTRUCTION_SOURCE=<full corresponding product SHA>`,
`MC_INSTRUCTION_HARNESS=cdd8930bed697299fc023175e98666a407ae6239`, and
`MC_INSTRUCTION_BEFORE=<1|0>`. It runs baseline then integration, sequentially.
The exact argv, source, start/finish times and log hashes are in the ledger.

Before: 3 passed/9 filtered, 16.16s. After: 3 passed/9 filtered, 23.94s. Each phase renders 30 contexts:
orders, Crew and Agent; empty/one/50/long/4,000-UTF-16-unit data; light/dark at 1600x700.
Zero page errors. After receipts show six last rows painted at remaining 0, 12 full-text readers
painted at remaining <=2, and six native Save controls painted. Final text/rect/hit predicates and
their existing one-second budgets remain unchanged. These overlap prior coverage; they are not
additional unique test cases to sum with earlier stages.

## Rendered observations and durable pairs

The author inspected the actual settled App context and native focused frames. The one-row Knows
pair shows saved IDs, target, author/date, text and actions replacing placeholders. The named status
count is present without taking over the page. Memory remains a distinct panel beneath orders.
The two existing columns keep readable spacing; the right-hand seat index uses a closed disclosure
until requested. There is no chart or dashboard recomposition in this change.

Crew keeps the default Seats table and offers the instruction body through its existing segmented
header. Its bounded pane can scroll when the selected target is long. Native End reaches the final
explicit-clear row visibly; the long reader shows the final glyph within its focus outline. Agent
keeps its existing context hierarchy and message area; its new disclosure/form can scroll in that
existing page. The current editor frame shows the label, target, full-width input within its useful
width, counter and grouped Save/Cancel controls, with native focus visible on Save. Capability for
watch text actions is proved by the production-component regression, not by these writer fixtures.

These are real viewport captures on fictional intercepted APIs, not live data or isolated mockups.
The shared fixture clock is 2026-10-17T12:00Z; CSS 1600x700, default zoom/DPR 1, folded dock, macOS 27.0.1
arm64. The precise browser version was not queried; the unchanged repository selector and same
installed headless browser served both phases. Fonts were ready before capture. Full-text interaction
frames may scroll existing containers; matching initial frames remain in the complete ledger.
Before has no equivalent instruction form/reader, so its prior placeholder/default panel is shown
instead of inventing an older focused form. Original viewport images are retained without cropping.

| Surface | Before light | After light | Before dark | After dark |
| --- | --- | --- | --- | --- |
| orders | [before](integration-images/before-orders-1600x700-one-light.png) | [after](integration-images/after-orders-1600x700-one-light.png) | [before](integration-images/before-orders-1600x700-one-dark.png) | [after](integration-images/after-orders-1600x700-one-dark.png) |
| crew | [before](integration-images/before-crew-1600x700-one-light.png) | [after](integration-images/after-crew-1600x700-one-light.png) | [before](integration-images/before-crew-1600x700-one-dark.png) | [after](integration-images/after-crew-1600x700-one-dark.png) |
| agent | [before](integration-images/before-agent-1600x700-one-light.png) | [after](integration-images/after-agent-1600x700-one-light.png) | [before](integration-images/before-agent-1600x700-one-dark.png) | [after](integration-images/after-agent-1600x700-one-dark.png) |

Focused interaction evidence: [Crew complete boundary reader](integration-images/after-crew-1600x700-boundary-dark-full-text.png)
and [Agent native Save focus](integration-images/after-agent-1600x700-one-light-editor.png).
The committed curated set contains 14 unchanged PNGs (1,480,985 bytes); the complete new before/after
set and JSON endpoints remain indexed with capture timestamps and SHA-256 hashes in the ledger.

## Receipts and handoff

| Log | SHA-256 |
| --- | --- |
| `/tmp/mc-1378-integration-after-cdd8930b-app.log` | `c6105c7ec687eb25772184c6cdffc8bc576b1259a752c86e84d3b2e5c77b9c9c` |
| `/tmp/mc-1378-integration-before-b94125aa-app.log` | `9b51b3374b912167dae2d4be328e2a4b7882ec4b45f83e49155b29e40f4d8331` |
| `/tmp/mc-1378-integration-cdd8930b-before-offline-link.log` | `e495d03282c6b4b16dc3e44c53a5db3312387ac4a1e1c160ccbcfe89f5383c0b` |
| `/tmp/mc-1378-integration-cdd8930b-build.log` | `eb1a8431df7a0d05a883abc79cdbeb6abd397b72af350f5d2f2f141c8c9150c8` |
| `/tmp/mc-1378-integration-cdd8930b-lint.log` | `0373b7c3c9d71f5d71c0d2f4945e70d8fc17be6db6e3fa1d6265356f96c0f8bc` |
| `/tmp/mc-1378-integration-cdd8930b-types.log` | `89914be67d23db9df61fb73ee636003068912275cdfb88337786c08eb9fd206e` |
| `/tmp/mc-1378-integration-cdd8930b-units.log` | `4c3374aec4a0f03f548f3794c1d685c5512696214f975831f30599f9bb9e6f5a` |

No source push, draft PR publication, merge, provider/crew/observed-loop action or live breaker
operation occurred during this integration stage. Narrow independent review, draft publication,
controller saved QA report and fresh CI remain the next steps. Parent #993 remains open until both
children are delivered. The controller owns merge/deployment; this task does not authorize them.
