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

## Final source validation — 3 November 2026

Validated source head: `a4fb1f7890e8c7a73c6020e2ed642dfb310a3d79`.
The final evidence commit changes only this Markdown file; application/test sources stay at that validated tree.

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
Normal CI and a fresh independent whole-branch review remain pending. No QA approval is claimed here.
No actual model compliance, provider result, UI implementation, screenshot acceptance, merge or deployment is claimed.
Visual evidence is not applicable: this child changes server/core/runtime and role guidance, with no apps/web source changes.
The build validates compatibility of the existing application; web standing-order controls remain #1378.
Instructions guide planning and preserve existing selector behavior; they do not build a natural-language scheduler
or replace repository safety floors. Full same-user FLIGHT access retains the accepted #1214 workflow boundary.

No paid provider, live crew action, observed-loop mutation, live breaker, production database operation,
source push or PR creation occurred. Fixture process tests use only the repository's fake CLI and temporary
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
