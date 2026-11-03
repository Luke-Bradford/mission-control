# #1378 source checkpoint and bounded checks

Product source: `261171462c78640bc339e46d9645a4a90490b678`.
Baseline/dependency: `f205cab3e5b2bb8ab4c26f15ad6bf4ea7215a42f`.
The server dependency is stacked and is not claimed merged. No server production file changes.

## Affected checks

Executed in the implementation worktree, 3 November 2026:

```sh
pnpm exec biome check --write apps/web/src/agent/SideTabs.tsx apps/web/src/data.ts apps/web/src/flight/CrewBoardTab.tsx apps/web/src/flight/Decided.tsx apps/web/src/flight/KnowsTab.tsx apps/web/src/flight/Situation.tsx apps/web/src/flight/conversation.ts apps/web/src/flight/tabs.ts apps/web/src/pages/Agent.tsx apps/web/src/instructions apps/web/test/Flight.test.tsx apps/web/test/api.test.ts apps/web/test/Instructions.test.tsx apps/web/test/Instructions.browser.test.ts apps/web/test/instructionsFixture.ts packages/core/src/standing-instructions.ts
pnpm exec vitest run --project web apps/web/test/Instructions.test.tsx apps/web/test/Flight.test.tsx apps/web/test/Agent.test.tsx apps/web/test/data.test.ts apps/web/test/api.test.ts apps/web/test/flightConversation.test.ts --maxWorkers=3
pnpm --filter @mc/core --filter @mc/web --workspace-concurrency=1 typecheck
```

Formatting: 18 files, one formatted, no diagnostics. Tests: 361 passed, no filtered cases,
6 files, 4.64s (15 instructions, 114 Flight, 148 Agent, 41 data, 31 API, 12 conversation).
Core/web types passed. Logs are `/tmp/mc-1378-checkpoint-{format,regressions,types}.log`.
Console retains the existing test-environment `<search>` warning and Node localstorage warning;
neither was suppressed.

| Log | SHA-256 |
| --- | --- |
| checkpoint-format | `583fa95fc8e421a359cfad86c4678f3dd3d789b66ec24e9b2d58742587401ce1` |
| checkpoint-regressions | `d7f3edeaaee595dc79ab97f97719527094b77b7a7973b1ab178700dd59a72150` |
| checkpoint-types | `7fc3112653bbe3068c43cebe1a512b2969f3333b9f1d374ef846b631460fd46d` |

## Matched actual-App captures

The baseline is a new detached worktree at exact f205, with only the new browser test and its
fictional fixture copied as untracked instrumentation. Baseline production remains unchanged.
Both sides execute the real App entry `test/agentV2Browser.html` with intercepted APIs on the
made-up origin `http://mc.test`. The clock comes from the shared fixture, zoom/DPR are 1, and the
FLIGHT dock is folded. No production DOM is replaced or styled by the capture harness.
The test records product source and harness source separately in every context JSON receipt.

For each phase and viewport, the executed Vitest argv is:

```sh
pnpm exec vitest run --project web apps/web/test/Instructions.browser.test.ts --maxWorkers=1 -t '<viewport>'
```

The Python invocation sets `MC_INSTRUCTION_QA_FULL=1`,
`MC_INSTRUCTION_QA_DIR=/tmp/mc-1378-matched-<before|after>`,
`MC_INSTRUCTION_SOURCE=<f205 full SHA|26117146 full SHA>`,
`MC_INSTRUCTION_HARNESS=261171462c78640bc339e46d9645a4a90490b678`, and
`MC_INSTRUCTION_BEFORE=<1|0>`. Each bounded command runs one phase at a time, one worker.
The selectors are `1280x1000`, `1600x1000`, `1920x1080`, and `1600x700`.
Each phase/size covers orders, Crew and Agent, five datasets and both themes: 30 context scenes.
Before mode records the prior page; after mode also checks all active rows, target sizes,
keyboard Save/Cancel, native End on row 50, and complete long/boundary text with painted last glyph.
The unchanged combined remaining/painted polling budget is 1 second.

| Viewport | Before | After |
| --- | --- | --- |
| 1280 × 1000 | 3 passed / 9 filtered, 16.02s | 3 passed / 9 filtered, 23.18s |
| 1600 × 1000 | 3 passed / 9 filtered, 15.96s | 3 passed / 9 filtered, 24.03s |
| 1920 × 1080 | 3 passed / 9 filtered, 15.87s | 3 passed / 9 filtered, 24.02s |
| 1600 × 700 | 3 passed / 9 filtered, 15.42s | 3 passed / 9 filtered, 23.35s |

Context filenames are `<orders|crew|agent>-<viewport>-<dataset>-<theme>.png` with matching JSON.
The `-initial.png` frame preserves the same starting position before new-feature interaction.
`-editor`, `-last-row`, and `-full-text` frames retain actual focused/painted interaction evidence.
Old-source absent features have no equivalent focused reader; their context frames show the prior
placeholders/default page instead. Captures after native focus may scroll the existing containing
panel or Agent page. The unchanged initial pairs remain available for composition comparison.

## Integrated checks and limits

Executed sequentially in the implementation worktree after the matched matrix:

```sh
pnpm -s lint
pnpm -s typecheck
pnpm -s build
```

All three exited 0. Lint checked 1,119 files, retained 76 warnings and seven infos, applied no fixes,
and found no core cycles (60 modules). The dependency's saved integrated-lint receipt also records
76 warnings/seven infos. Changed source/test files had no diagnostics in the separate check.
Types ran all five workspace projects. Vite built 369 modules in 974ms.

| Log | SHA-256 |
| --- | --- |
| `/tmp/mc-1378-final-lint.log` | `162c257ee564835248054797f4af13beb9ae604e62570ceb9ad5e4602b6e1f6b` |
| `/tmp/mc-1378-final-types.log` | `89914be67d23db9df61fb73ee636003068912275cdfb88337786c08eb9fd206e` |
| `/tmp/mc-1378-final-build.log` | `50c74ba20437bd2393479f6c4b0bab830928b0bf74cb79a045364bc0b67c49d6` |

No full local suite or test:related expansion ran: the controller authorized bounded affected
checks instead, and owns the fresh whole-branch review, QA registration, publication and normal CI.
No test timeout, auth guard, selector comparison, painted bound or server behavior was relaxed.
This is fixture proof of web behavior, not paid-provider or live crew compliance evidence.
All logs and original author red captures are retained; artifact hashes bind source and scene.
