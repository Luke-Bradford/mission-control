# Standing instructions: implementation check record

Source baseline: f7ee4e26. Reviewed refinement: 9637e6fe; carried locally as a0740d12 and d872a196.
This is a backend-only implementation. No screenshot or actual-provider compliance evidence is claimed.
The web child is #1378. Overview and production deployment remain separate.

## Runs retained from 2 November 2026

- Offline setup: `pnpm install --offline --ignore-scripts --frozen-lockfile` passed, 911 ms, no downloads.
- First bounded `pnpm --filter @mc/core --filter @mc/server --workspace-concurrency=1 typecheck`:
  core passed; server failed with two TS1294 diagnostics for constructor parameter properties in
  standing-instructions.ts. Replaced them with erasable field declarations.
- Second typecheck: core passed; server reported missing crewGit/cloneGitDir imports and an unknown
  Fastify fixture payload type. Added the imports and serialized the fixture payload.
- First focused new-unit run:
  `pnpm exec vitest run apps/server/test/standing-instructions.test.ts apps/server/test/standing-instructions-api.test.ts --maxWorkers=3`.
  13 passed, 2 failed in 1.38 seconds. Ordering looked up the precedence sentence instead of saved JSON;
  the notice assertion used the broadcast reader instead of the recipient inbox. Corrected both lookups.
- Next core/server typecheck passed.
- Next bounded run added apps/server/test/supervisor-instructions.test.ts to those two files.
  16 passed, 3 failed in 9.50 seconds. All 15 store/API tests passed, plus the real fake-CLI seat-snapshot test.
  The three process-fixture failures were retained, not reported as product passes:
  - rotation passed a seat ID to endRunByEngine, which takes a run ID;
  - the resume fixture expected an automatic turn, contrary to existing watch behavior;
  - git rm removed the empty docs directory before the symlink fixture was created.
  Fixes use the run ID, wait for the existing resumed state and explicitly send a post-reattachment message,
  and recreate the fixture directory. The first process run reached initial/repeated/operator-message assertions;
  it did not prove rotation or resume passed.

## Pre-review source validation — 3 November 2026

Validated source head: `a4fb1f7890e8c7a73c6020e2ed642dfb310a3d79`.
The initial evidence-only freeze was 84de9b5a; its application/test sources matched that validated tree.
Independent review subsequently found the focus lifecycle issue documented below.

| Command/run | Actual result |
| --- | --- |
| `pnpm -s lint` | Passed: 1,094 files checked; 45 warnings and 7 infos retained; no errors. Core import graph: 60 modules, no cycles. |
| `pnpm -s typecheck` | Passed for all workspace projects, sequentially. |
| `pnpm -s build` | Passed; existing web application production bundle built. This is compatibility validation, not a new UI delivery. |
| Final bounded affected run, below | 421 tests passed across 9 files, 15.61 seconds. |
| Earlier filtered integration run, below | 28 passed, 1,518 skipped explicitly, 2.37 seconds. Tested tool/grant/wake/API paths retain the same source in the final head. |

Final affected run:

```sh
pnpm exec vitest run apps/server/test/queue.test.ts apps/server/test/queue-reorder.test.ts apps/server/test/config-write.test.ts apps/server/test/hud.test.ts apps/server/test/views.test.ts apps/server/test/prompt-cost.test.ts apps/server/test/standing-instructions.test.ts apps/server/test/standing-instructions-api.test.ts apps/server/test/supervisor-instructions.test.ts --maxWorkers=3
```

Results: queue 112; queue-reorder 33; config-write 79; HUD 150; views 16; prompt-cost 7;
standing-instructions 8; standing-instructions-api 8; supervisor-instructions 8. Total 421.

The final fake-CLI file proves initial/repeated/operator/rotated delivery, keeper loss followed by an explicit
post-resume turn, seat prompt placement and revoked snapshots, unsafe/oversized direction refusal, changed
orders while an actual delivery queue waits on an interrupt, rebuilding missing direction on keeper reattachment,
failed immediate notice delivery followed by exactly one persisted inbox notice on the next ordinary turn,
and actionable direction errors through the real supervisor startWatch failure path before any fixture session launches.

Earlier filtered integration run (not a full-suite pass):

```sh
pnpm exec vitest run apps/server/test/flight-tools.test.ts apps/server/test/flight-watch.test.ts apps/server/test/api.test.ts packages/core/test/runtime.test.ts --maxWorkers=3 -t 'standing instructions and linked re-plans|reads and changes focus|wakes once for a new or revoked order|local access|every registered /api route|mc tool grants|crew constants'
```

Results: flight-watch 1; flight-tools 3; API 16; core runtime 8. Total 28.
The selected checks prove typed retained re-plan references, protected seat tools and idempotent revocation,
legacy focus writes/reads, changed-order wake/retry without an unchanged-order loop, no fabricated accountability
requirement for a guidance-only wake, route inventory and authentication, and the minimal FLIGHT tool grant changes.

## Acceptance evidence map

| Contract | Implementation | Automated evidence |
| --- | --- | --- |
| Durable immutable entries, retained history, bounded full active lists | core standing-instructions.ts; server standing-instructions.ts; Store.instructions | 8 store/envelope tests, including restart, transactional refusal, capacity, pagination and focus precedence |
| Operator-only orders, protected operator seat entries, declared provenance through actor completion | standing-instructions-api.ts; common api.ts hooks | 8 focused API/notice tests, plus selected existing API access/inventory tests |
| FLIGHT seat tools, visible audit and typed re-plan links | flight/tools.ts; core mcp.ts/runtime.ts/flight.ts; store decision mapper | Selected flight-tools and core runtime tests |
| Short durable notices and accurate per-mutation delivery status | instruction-notices.ts and persistent notice receipts | Failed immediate notification and concurrent-recipient API fixtures; actual fake-CLI next-turn inbox test |
| Verified direction and every-turn current guidance | runtime/instruction-context.ts; runtime/supervisor.ts; runtime/brief.ts | 8 fake-CLI supervisor tests; 2 store-envelope placement/order tests; prompt-cost regressions |
| Order-change wake, failed-send retry, no fabricated or endless decisions | flight/state.ts and delivered revision bookkeeping | Selected flight-watch regression; actual failed-send/retry fake-CLI test |
| Existing selector grammar/clear, config import, queue/start/reorder and HUD readers | canonical focus resolver; engine/queue.ts; queue-reorder.ts; hud.ts; API/tools adapters | Store/API focus tests; 112 queue, 33 reorder, 79 config-write and 150 HUD regressions |

## Limits and review state

No full local suite or broad `test:related` run was performed under the controller's bounded-check instruction.
The pre-review checks above did not establish a CI or independent-review pass. Subsequent failed review, correction and CI results are retained below. No final QA approval is claimed here.
No actual model compliance, provider result, UI implementation, screenshot acceptance, merge or deployment is claimed.
Visual evidence is not applicable: this child changes server/core/runtime and role guidance, with no apps/web source changes.
The build validates compatibility of the existing application; web standing-order controls remain #1378.
Instructions guide planning and preserve existing selector behavior; they do not build a natural-language scheduler
or replace repository safety floors. Full same-user FLIGHT access retains the accepted #1214 workflow boundary.

The implementation agent performed no paid-provider, live crew, observed-loop, live breaker or production-database action, and made no source push or PR. The controller owns PR 1381 and its remote revisions. Fixture process tests use only the repository's fake CLI and temporary
Git repositories. Shared heavy-job slots were released between bounded runs.

## Integration scope

The minimal packages/core/src/runtime.ts FLIGHT_TOOLS addition was confirmed by the controller as necessary.
It adds only instruct_seat and revoke_instruction; global-order mutations remain excluded.
Raw config focus stays an import source. Queue eligibility, queue reorder, HUD rows, the focus API and
message_seat reads use the resolved durable value. Existing raw config serialization stays raw for the
session editor's optimistic comparison.

Notice failure semantics: `pending` means no durable Comms receipt; `inbox` means a stored unread notice,
including when immediate notification failed or the seat is busy; `notified` records a successful immediate
notification in that flush. A retry does not duplicate stored Comms. Concurrent mutation responses use their
own instruction/action receipt, not another recipient's status. Global order mutations create no seat notice rows.


## Independent failed review and correction — 3 November 2026

The independent whole-branch review of source `a4fb1f78` (frozen as docs successor `84de9b5a`)
found one Important issue and one Minor issue. The Important repro imported label:new after a config
reload, then a live run's final delivery reimported its captured label:old and created another focus entry.
The Minor issue left the instruction-focus:<seat> warning open after import later succeeded.

The failed state is retained on [draft PR 1381's review/rework record](https://github.com/Luke-Bradford/mission-control/pull/1381#issuecomment-6591839676).
Saved failed QA report: `f3d764f1f174341448c7de46b19d25cc18803ab495f108c56afc8d9544b6933e`.
Reader route: `/qa?repo=mission-control&pr=1381&report=f3d764f1f174341448c7de46b19d25cc18803ab495f108c56afc8d9544b6933e`.
The independent scratch repro and its original red log remain unchanged under the controller's retained artifacts.
The original repro failed 1 of 1 tests: expected label:new and ID 2, observed label:old and ID 3.
This failed history is not replaced by the correction's green results.

The controller canceled [initial CI run 41550710419](https://github.com/Luke-Bradford/mission-control/actions/runs/41550710419)
after the Important review finding. That cancellation avoided a full run on a known unmergeable head;
it is not a failed test outcome or a successful CI result. New exact-head CI remains required after correction.

Correction source: `3f50fc559ecd8b52eeb4109a208de8d3b34bc062`, a descendant of the preserved failed freeze.
Final delivery now resolves the current configured seat and refuses a seat removed while delivery waits.
Queue/refill and reorder focus checks resolve current configuration before importing a selector, including
null and omitted focus. The existing config-import callback is extracted for a direct failure/recovery test;
success clears only its matching open warning and emits an attention update. No authority or selector grammar changes.

Correction validation:

- Core/server sequential typecheck passed before the correction regression run.
- `pnpm exec vitest run apps/server/test/supervisor-instructions.test.ts apps/server/test/standing-instructions-api.test.ts apps/server/test/queue.test.ts apps/server/test/queue-reorder.test.ts --maxWorkers=3`:
  170 passed, 4 files, 15.28 seconds. Provider 12; API/notice 9; queue 116; reorder 33.
- Permanent provider regression adapts the independent repro and covers label:new, explicit null,
  omitted focus and removal while delivery is queued. Queue regressions cover the same reload/removal cases.
- The Minor regression creates an actual 64-entry capacity failure, frees capacity, imports successfully,
  and proves only that warning clears. A subsequent successful retry emits no redundant attention change.
- `pnpm -s lint`, all-workspace `pnpm -s typecheck`, and `pnpm -s build` passed on correction source 3f50fc55.
  The test run preceded the source commit with identical source/test content. Raw correction lint/build
  receipts are retained by the controller in its temporary check artifacts; no full local suite was run.

That same-reviewer narrow verification completed clean at 00:17:55 UTC on 3 November. The unchanged
original scratch repro passed 1/1 against source 3f50fc55; selected queue/recovered-warning checks passed
5 with 120 filtered. The controller then pushed docs successor 7b7bb20e (identical application/test sources)
for fresh CI. This was a scoped correction result, not final approval: the later pause finding and actual
CI failures below remain part of the rework record.


## Second failed review, pause correction and actual CI rework — 3 November 2026

Published head: `7b7bb20e491ab79d63d6ab7c55abab251ef19283`. A subsequent independent probe found an
Important pause-boundary issue: the notice flush called raw supervisor.message. Saving a seat instruction
and importing initial legacy focus each started a second fake-provider turn despite the operator pause
remaining set. Both independent probes failed (2/2); their unchanged scratch file and original red log are
retained. No actual paid provider or live crew was used.

Second saved failed QA: `96012616e06b90f95548a62a0e5e9c1a71fc70d0168f429ff24635e417a6ce17`.
Reader: `/qa?repo=mission-control&pr=1381&report=96012616e06b90f95548a62a0e5e9c1a71fc70d0168f429ff24635e417a6ce17`.
[Public pause rework record](https://github.com/Luke-Bradford/mission-control/pull/1381#issuecomment-6600649167).

Source correction `c4e7c1ecf1338f782f3400cf4a719c97ff15acd7` routes notices through the existing
messageUnpausedSeat boundary. Stored notices remain unread and durable during pause, then are delivered
on an explicitly authorized ordinary turn. It preserves the existing run-bound pause exception and queued
recheck. Five permanent fake-process cases cover saved guidance, initial import, pause after admission,
matching run exception and a foreign-run exception. The bounded store/API/process run passed 34/34
(8 store, 9 API/notice, 17 process), 14.19 seconds. Core/server sequential types passed.

[Actual fresh CI run 41551990597](https://github.com/Luke-Bradford/mission-control/actions/runs/41551990597)
failed on 7b. This differs from the earlier intentionally canceled run:

- server (1): 2 failed, 2,838 passed, 10 skipped. HUD memo repeated a batched read; new routes lacked reader declarations.
- server (2): printed 9 failed, 3,689 passed, 16 skipped before its job was canceled by fail-fast. Seven log_decision fixtures selected tools[0], plus literal tool-list and flight_state snapshots needed their new contract fields.
- server-process (1): 1 failed, 256 passed. The old-keeper test expected a raw QUIET line rather than its complete guidance envelope.
- web-core: 1 failed, 5,472 passed. The strict core MCP-name map lacked the two new seat instruction tool names.
- Other shards canceled by fail-fast do not count as passes. The full failed-run log and normalized failure list are retained by the controller.

Final correction source: `0086af6fcef9d48bebce2d82e614d17e1dc41e51`. The actual HUD bug is corrected by
importing current configured focus before memo readVersion is captured; row projection only reads the
resolved value. Existing ten-seat/fifty-run batching and clock checks remain intact. A new regression
proves warm reads do not write bookkeeping and a changed explicit null imports once without breaking
memo reuse. Route-reader inventory now includes the extracted router, with planned #1378 readers labeled
as planned and existing Queue readers named. The orphan-route guard still rejects undocumented routes.
Tool/field snapshots remain exact; log_decision fixtures choose the named tool. Old-keeper replay retains
its exact original QUIET payload, no premature completion, full envelope echo, idle and same-run assertions.

All commands below completed with exit 0 on application/test content frozen as 0086af6f. Filtered counts
are explicit; these are bounded affected checks, not a full local suite:

```sh
pnpm exec vitest run --project server apps/server/test/hud-memo.test.ts apps/server/test/routes.test.ts --maxWorkers=3 > /tmp/mc-1377-ci-hud-routes.log 2>&1
pnpm exec vitest run --project server apps/server/test/flight-tools.test.ts --maxWorkers=3 -t 'log_decision|tool list|answers the crew now' > /tmp/mc-1377-ci-flight-tools.log 2>&1
pnpm exec vitest run --project core packages/core/test/runtime.test.ts --maxWorkers=3 -t 'names the mc tools as the CLI shows them' > /tmp/mc-1377-ci-core-map.log 2>&1
pnpm exec vitest run --project server-process apps/server/test/supervisor-restart.test.ts --maxWorkers=1 -t 'an old keeper.s open turn: a line' > /tmp/mc-1377-ci-keeper-replay.log 2>&1
pnpm -s typecheck > /tmp/mc-1377-final-pause-ci-types.log 2>&1
pnpm -s lint > /tmp/mc-1377-final-pause-ci-lint.log 2>&1
pnpm -s build > /tmp/mc-1377-final-pause-ci-build.log 2>&1
pnpm exec vitest run --project server apps/server/test/hud.test.ts apps/server/test/views.test.ts apps/server/test/hud-memo.test.ts --maxWorkers=3 > /tmp/mc-1377-final-hud-projection.log 2>&1
```

Results in command order: 22/22 (1.98s); 10 passed/674 filtered (1.99s); 1 passed/210 filtered (284ms);
1 passed/92 filtered (1.81s); all workspace types passed; lint passed with 51 warnings, 7 infos, no errors,
60 core modules/no cycles; existing web compatibility build passed (968ms); 180/180 HUD/views/memo (7.93s).
Heavy slots were released immediately after each bounded pack. No automatic full-suite retry occurred.

### Retained raw receipt hashes

Paths are controller-local `/tmp` artifacts, not product routes. Earlier 421/28/170 run receipts remain in
the controller tool history; no standalone raw-log hash is invented for those runs.

| Artifact basename | SHA-256 |
| --- | --- |
| mc-1377-independent-pause-red-7b7bb20e.log | ad4013f8c9662babca8442239c9b1a787c42f407d1a7ea7ad3db965e430549da |
| unchanged supervisor-review1377-pause.test.ts | 3ea27d47a9cd2a9e0f08973d80ad6b4c801d22994fd78600a2dccca1be444b74 |
| mc-1377-pause-types.log | 7fc3112653bbe3068c43cebe1a512b2969f3333b9f1d374ef846b631460fd46d |
| mc-1377-pause-focused.log | 0cc978e3e76d0f65a341455427f61a10ee932769970facad17606663bf0b9ab9 |
| mc-1377-ci-hud-routes.log | 2723a39ac66e3eac6697ec37c748d49f8cc5a24814e700f36eb8059eaace4ad2 |
| mc-1377-ci-flight-tools.log | 6f9ab8fe205f2ea161f7653947ee64a1f63b30130e82e8c9f3a101d4246cf9b8 |
| mc-1377-ci-core-map.log | c3393ac52e84af0818fd5dfb26218db55511aae28bed03c62746f621d17ca138 |
| mc-1377-ci-keeper-replay.log | ed4668111ae432dce4ec8a17ab98b9c1e2a2abd1c663630313a67cb74f0f720b |
| mc-1377-final-pause-ci-types.log | 89914be67d23db9df61fb73ee636003068912275cdfb88337786c08eb9fd206e |
| mc-1377-final-pause-ci-lint.log | f9bf767900cc612921a33c2be3cb4f6c9a48b0dd357a027d670c9a34c7ff0f13 |
| mc-1377-final-pause-ci-build.log | f214bc05b10329d40ae7ffb83f4d836121401e81b2231d77f47d0d191aa91195 |
| mc-1377-final-hud-projection.log | 6025b638aa557b3ea0fea39c48f2e57f672dca280c4fe08fb98b689b50f5a2a7 |

Handoff at 74b9e585: corrected source was frozen locally for the same reviewer's narrow verification, including
the original unchanged two-case pause repro. The controller owns corrected remote composition, new exact-head
CI, QA disposition, merge and Update. This record claims neither a final review/CI pass nor merge/deployment.
Server-only visual N/A reflects no apps/web source or user-visible control implementation in this child;
#1378 remains responsible for that UI. No actual-provider compliance or live paid-crew outcome is claimed.


## Third CI failure and prompt-audit correction — 3 November 2026

The second same-reviewer narrow check was clean on 0086af6f at 10:09:35 UTC: the unchanged original pause
probe passed 2/2 (2.23s), HUD memo/routes passed 22/22 (2.43s), and strict catalog/readers/replay deltas
were clean by static review. Original red evidence was preserved. Final docs head 74b9e585 had identical
application/test sources. This scoped result did not substitute for CI.

[Exact-head CI 41617003617](https://github.com/Luke-Bradford/mission-control/actions/runs/41617003617)
then failed on 74b9e585. server-process (2) reported 3 failed/407 passed, 496.39s; server (1), server (2),
server-process (1), web-core and validate were successful; the aggregate check failed. Two failures were
strict startWatch comparisons still expecting the original BRIEF without its required guidance envelope.
The third was a real Important regression: deferring prompt identity recording until after first send
allowed launch when prompt audit storage failed, then swallowed the first-delivery rejection.

Failed 74b snapshot and all three CI failures remain retained in saved QA
`ed6858a41a16f8cdb8f516d9e25341e5f3c36ed637f0bbae0dfa1a6c039b9678`.
Reader: `/qa?repo=mission-control&pr=1381&report=ed6858a41a16f8cdb8f516d9e25341e5f3c36ed637f0bbae0dfa1a6c039b9678`.
[Public failed-head rework record](https://github.com/Luke-Bradford/mission-control/pull/1381#issuecomment-6602148290).
The earlier canceled 41550710419 and failed 41551990597 runs above retain their distinct actual outcomes.

Correction source: `92ee33998d23db42c116cec9e8c3fe138b092366`. Prompt identity is again recorded before
any token/provider launch, preserving the original unchanged no-spawn test. A pending first delivery retains
that exact prepared hash. Immediately before input, the freshly resolved full envelope replaces only that
hash through a compare-and-swap; the database also refuses replacement after a delivered receipt exists.
Thus guidance may change between preparation and delivery without losing the actual first-envelope identity.
The first sections are recorded only after input succeeds. Any first-delivery failure now rejects the start,
closes the empty session and leaves the run failed instead of returning success. All three initial start
paths use that same failure handling. No provider, daemon or authority policy was changed.

The two startWatch comparisons remain full exact-array comparisons, wrapping the unchanged original BRIEF
and its exact blank-line first payload in the specified envelope. Existing model, detached checkout,
sandbox and hook assertions remain intact. Five new fake-provider cases prove watch/writer current guidance,
actual delivered hash and byte total, rejected replacement after delivery, watch/writer final-audit failure
with zero delivered turns and a failed closed run, and refusal to overwrite an unexpected prepared identity.

An initial selected process run passed 8, with 293 filtered (6.52s), followed by core/server sequential types.
After adding the delivered-receipt guard, the final bounded checks below all completed with exit 0 on content
frozen as source 92ee3399. No broad suite or shard retry was run locally.

```sh
pnpm exec vitest run --project server-process apps/server/test/supervisor-instructions.test.ts --maxWorkers=3 > /tmp/mc-1377-prompt-audit-instructions-final.log 2>&1
pnpm exec vitest run --project server-process apps/server/test/supervisor-review.test.ts apps/server/test/supervisor-start.test.ts --maxWorkers=3 -t 'runs with no ticket and no branch|appends first after a blank line|does not spawn when recording the prompt version fails' > /tmp/mc-1377-prompt-audit-ci-final.log 2>&1
pnpm exec vitest run --project server apps/server/test/prompt-cost.test.ts apps/server/test/store.test.ts --maxWorkers=3 -t 'prompt|section|immutable model' > /tmp/mc-1377-prompt-audit-cost-store.log 2>&1
pnpm -s typecheck > /tmp/mc-1377-prompt-audit-final-types.log 2>&1
pnpm -s lint > /tmp/mc-1377-prompt-audit-final-lint.log 2>&1
pnpm -s build > /tmp/mc-1377-prompt-audit-final-build.log 2>&1
```

Results in command order: 22/22 instruction process tests (17.17s); the exact three CI failures passed,
276 filtered (3.29s); 7 cost/store checks passed, 199 filtered (954ms); all workspace types passed;
lint passed, 51 warnings/7 infos/no errors, 60 core modules/no cycles; compatibility build passed (984ms).
The lane was released immediately after each bounded pack, before inspecting/reporting results.

| Retained `/tmp` artifact basename | SHA-256 |
| --- | --- |
| mc-1377-independent-pause-green-0086af6f.log | 1921ee5c59fab715f0659b81337ded6a405e602979314f992dfcfb20556a62fe |
| mc-1377-independent-hud-routes-0086af6f.log | a9aaa13cfc79bec09ca42aec8f861a070a4a9c763d8e9530dc0da00763d96ea5 |
| mc-1381-74b-ci-failed.log | f83ce5e79badd2271cfe8705a8efa0f742970aa017a4af40eb62123694730438 |
| mc-1377-prompt-audit-focused.log | ca6fa6711e4f17e18edd9f665bf821e07b4040bc5a7fed581a1db165280a0afd |
| mc-1377-prompt-audit-types.log | 7fc3112653bbe3068c43cebe1a512b2969f3333b9f1d374ef846b631460fd46d |
| mc-1377-prompt-audit-instructions-final.log | 8a534877b4d5d80ebe34df238aae2f866da9198edfc54fa693d9cc78b21e551e |
| mc-1377-prompt-audit-ci-final.log | 1d90692921322707baa37a42d71abe5f08f12ab9e03d464514ee37dc5e5c0ac7 |
| mc-1377-prompt-audit-cost-store.log | 2f464926ed9df98530ad4c8ce8997c60a8b84180599461ceaea332a88cba7327 |
| mc-1377-prompt-audit-final-types.log | 89914be67d23db9df61fb73ee636003068912275cdfb88337786c08eb9fd206e |
| mc-1377-prompt-audit-final-lint.log | acdc54472b3ce5e4ec8d3312609f49fe6cd7e318cf38c61ed81560c035cf9d94 |
| mc-1377-prompt-audit-final-build.log | f8b542cf86ed714ace3330348ae52f2a517e96b2d81d9bc29796e09f0a38c687 |

At the 9a72bd6c handoff, source 92ee3399 was frozen for the same reviewer's narrow correction verification. That review and fresh
corrected-head CI were pending; the controller owns remote publication, final QA, merge and Update.
No screenshot acceptance applies to this server/core/runtime correction, no web controls are delivered,
and no actual paid-provider or live-crew compliance is claimed.


## Fourth CI attempt: interrupted-start fixture correction — 3 November 2026

Same-reviewer prompt-audit correction verification completed clean on source 92ee3399 at 11:11:18 UTC:
8 passed/293 filtered, exit 0, 6.48s. The original no-spawn test file was byte-unchanged, and no assertion
weakening was found. Final 9a72bd6c changed only this evidence file. Raw independent receipt:
`/tmp/mc-1377-independent-prompt-audit-92ee3399.log`, SHA-256
`3f5c9b8db56874365c6c8e6182bfb9ddbc3576236a651e587dd0fd7c0b26c37d`.

[Fresh exact-head CI 41625564196](https://github.com/Luke-Bradford/mission-control/actions/runs/41625564196)
failed on 9a72bd6c: server-process (1) reported 1 failed/266 passed (171.98s). server-process (2) was canceled
by fail-fast; server (1), server (2), web-core and validate succeeded. The aggregate check failed. No canceled
shard is counted as a pass. All 22 instruction process tests passed in the failed shard; its one failure was
an older restart fixture expecting startRun success despite a known failed first write. The corrected production
code intentionally rejects that condition immediately. The controller classified this stale fixture as Minor,
retaining the clean independent prompt-audit correction and actual failed CI outcome.

Saved failed 9a QA: `4b8f599dd608ef3bc87dc04a7af42d5820d48d5aa620a8725c3383b742239dff`.
Reader: `/qa?repo=mission-control&pr=1381&report=4b8f599dd608ef3bc87dc04a7af42d5820d48d5aa620a8725c3383b742239dff`.
The terminal job log was retrieved through GitHub's jobs/logs endpoint while the workflow was still running;
`gh run view --job ... --log` correctly refused until workflow completion. Both raw and normalized receipts
are retained, and final workflow status was separately verified.

Test correction: `1e73f2bf9564297c75217dba4392413aaa8c8449`. Only supervisor-harness.ts and
supervisor-restart.test.ts change. Production sources/packages/roles remain byte-identical to 92ee3399/9a.
The existing attach guard still exercises a persisted starting seat with a live keeper and no input, modeling
a historical hub interruption before first delivery. An explicit test-only dropped-input transport creates
that state; it is false by default and reset between cases. Every existing close-gate, concurrent-resume,
error-reason, failed-run and one-CLI assertion remains. The fixture no longer relies on a known send failure
being silently treated as success.

A separate new test exercises that known failure: start rejects with 500; no user turn is delivered; the run
ends failed; neither a delivered receipt nor prompt cost is recorded. A subsequent hub fixture start and explicit
resumeRun on the ended run cause no attach and no second CLI. Ended-run resume is the existing intentional
no-op. The initial author run incorrectly expected it to throw: 1 failed/3 passed/90 filtered (4.10s), retained
in the red receipt below. Correcting that new fixture expectation changed no production behavior and kept all
no-resume outcome checks. The original historical attach case already passed in that red run.

Final bounded commands, all exit 0 on the test content committed as 1e73f2bf:

```sh
pnpm exec vitest run --project server-process apps/server/test/supervisor-restart.test.ts --maxWorkers=1 -t 'a seat that never got its brief|rejects a known failed first write|no keeper falls back|an old keeper.s open turn: a line|an ended watch run is left alone|a killed CLI under an attached hub' > /tmp/mc-1377-restart-crash-final.log 2>&1
pnpm -s typecheck > /tmp/mc-1377-restart-crash-types.log 2>&1
pnpm -s lint > /tmp/mc-1377-restart-crash-lint.log 2>&1
```

Results: 6 passed/88 filtered (5.63s); all workspace types passed; lint passed with 51 warnings, 7 infos,
no errors, 60 core modules/no cycles. No build rerun was needed for this test-only correction: production
source and the previously successful compatibility build remain unchanged. No full local suite was run.
Heavy slots were released immediately, including after the retained red command, before analysis.

| Retained `/tmp` artifact basename | SHA-256 |
| --- | --- |
| mc-1381-9a-ci-process1-failed.log | 12a2d6fd17d1bc0a3f967f903b9343f6e419ba2d75e5d84f9d7e74eca8aa67f6 |
| mc-1381-9a-ci-process1-normalized.log | 199f5bc24e7319e8c146aa3a57859ff64a6cf8c058f60ef1fe1d092c61c69a7f |
| mc-1377-restart-crash-focused.log | 434ba3a8cee997960207a56fd713141ac3816956223105e683455875b0a5b9b8 |
| mc-1377-restart-crash-final.log | 5969e8ee46e9d6d382033e409c8a01e0d2e62ecabf0a92340e3047de305c6efd |
| mc-1377-restart-crash-types.log | 89914be67d23db9df61fb73ee636003068912275cdfb88337786c08eb9fd206e |
| mc-1377-restart-crash-lint.log | ca460b59f2e7fcdd57e8a2cac373f90721bc66205629f5b664c9fd55ada7d8f5 |

Handoff: test correction 1e73f2bf is clean and frozen for same-pass independent verification. The controller
retains failed 9a QA and owns the next remote push, exact-head CI, final QA, merge and Update. No new production
source, screenshot acceptance, paid-provider compliance or live-crew claim is part of this correction.
