# Watch-seat Queue-link correction

Fresh whole-branch review of `959b4357e8928ccaa8ded0635fc3d90ba7d77988` found no Critical or
Important findings and one Minor: named-seat instruction readers offered Queue focus controls to
watch seats. Queue correctly supports configured writers only. The controller relayed the review
and requested this narrow correction. The original source, full matrix and 912 manifest hashes
remain retained as historical evidence; this record does not relabel those images as corrected.

Corrected production source: `76a00706cced3f5be0471b47d2db5f7382a868f6`.
The production delta is only `apps/web/src/instructions/Instructions.tsx`.
The manager reads the existing loaded ConfigView through hub, then allows Queue links/help only
when the matching configured seat has mode=writer. Active focus-row links use the same capability.
Effective saved focus remains readable; watch seats retain Add/Replace/Revoke text actions.
No server authority, selector grammar, data schema, shared shell, CSS or unrelated layout changed.

## Red and green

The new production-component regression is
`uses configured writer capability for Queue links while watch seats keep text actions` in
`apps/web/test/Instructions.test.tsx`. It starts with configured writer controls, updates configuration
to a read-only watch seat, checks both Queue links/help disappear, and successfully saves an
operator-authenticated text replacement for that watch seat. No assertion or guard was relaxed.

Before the source correction, exact 959 production plus the added regression failed as expected:
1 failed, 15 filtered, 2.01s. The failure is the still-present Queue links after the config change.

```sh
pnpm exec vitest run --project web apps/web/test/Instructions.test.tsx --maxWorkers=1 -t 'uses configured writer capability'
```

After the correction:

```sh
pnpm exec biome check --write apps/web/src/instructions/Instructions.tsx apps/web/test/Instructions.test.tsx
pnpm exec vitest run --project web apps/web/test/Instructions.test.tsx apps/web/test/Flight.test.tsx apps/web/test/Agent.test.tsx apps/web/test/data.test.ts apps/web/test/api.test.ts apps/web/test/flightConversation.test.ts --maxWorkers=3
pnpm -s typecheck
pnpm -s lint
pnpm -s build
```

All commands exited 0. The six-file affected pack passed 362/362 in 4.49s (16 instruction cases).
Changed-file formatting checked two files, formatted the test, and reported no diagnostics.
Workspace types checked five projects. Lint retained 76 warnings/seven infos, no fixes, no core
cycles across 60 modules. Vite built 369 modules in 982ms. No full local suite ran.

| Log | SHA-256 |
| --- | --- |
| `/tmp/mc-1378-watch-capability-red-959b4357.log` | `e7e77dd6d75aa00fa46a586e46210a7ac3048dd18f538b43544f5b1eb43b3acc` |
| `/tmp/mc-1378-watch-correction-format.log` | `32608e0a759e3e8be7ad967b461c233fedf4f6623637f31359d9fc03132256f3` |
| `/tmp/mc-1378-watch-correction-tests.log` | `47e51042b8550bfa38bb7e6ab2b373813009157d00943ed6d3aa0b480d071cd4` |
| `/tmp/mc-1378-watch-correction-types.log` | `89914be67d23db9df61fb73ee636003068912275cdfb88337786c08eb9fd206e` |
| `/tmp/mc-1378-watch-correction-lint.log` | `3d755f95d0b89a7ce979ac9408a68c2bc58eec5977da891986648f504cff993b` |
| `/tmp/mc-1378-watch-correction-build.log` | `c1db14054857f0ab524cb8972a863a304530e34c5199c8c558935949f2c59069` |

## Corrected App evidence

The historical full matrix belongs to source261 and docs959. A separate corrected-source App run
passed 3 cases/9 filtered in 23.24s at 1600x700 across orders, Crew and Agent, five datasets and both
themes (30 contexts). It uses unchanged harness261 and the new artifact directory
`/tmp/mc-1378-watch-correction-app-76a00706`. Every context receipt declares source76 separately
from harness261. This browser pack checks the configured-writer layout and native controls;
watch capability and successful text mutation are proved by the production-component regression.

```sh
MC_INSTRUCTION_QA_FULL=1 MC_INSTRUCTION_QA_DIR=/tmp/mc-1378-watch-correction-app-76a00706 MC_INSTRUCTION_SOURCE=76a00706cced3f5be0471b47d2db5f7382a868f6 MC_INSTRUCTION_HARNESS=261171462c78640bc339e46d9645a4a90490b678 pnpm exec vitest run --project web apps/web/test/Instructions.browser.test.ts --maxWorkers=1 -t '1600x700'
```

Log `/tmp/mc-1378-watch-correction-app-76a00706.log` SHA-256:
`7584ca69c83911decd458a2cb59bdfd0acb21997e83aa648ffa4372feb24562a`.
The corrected-source set contains 84 PNGs and 54 JSON receipts, indexed separately in
[watch-correction-artifacts.json](watch-correction-artifacts.json). All 30 scenes have zero page errors.
The six last-row receipts are painted at remaining=0, all twelve long/boundary full-text readers
are painted at remaining<=2, and six native Save controls are painted. The actual short Crew
last-row frame was inspected: the configured writer retains both Queue controls and its final row.
No timeout, painted bound, final-text or hit assertion changed. The existing historical 912-file
manifest was rechecked and every SHA-256 still matches.

Same-pass narrow independent verification and controller QA/CI remain outstanding. The stack
still depends on f205. No source push, live/provider action or unrelated UI change occurred.
