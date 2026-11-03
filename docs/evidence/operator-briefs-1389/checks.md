# Complete operator briefs #1389: retained checks and limits

Corrected source: **c7b33e77e01b28256fd8ffb22fa3bad97d09099a**. Base:
`d192dd83d42299dfe52aedccf2791c4ab91b0169`. Parent [#759](https://github.com/Luke-Bradford/mission-control/issues/759),
server [#1389](https://github.com/Luke-Bradford/mission-control/issues/1389), dependent web
[#1390](https://github.com/Luke-Bradford/mission-control/issues/1390). The [published contracts and
original audit](../../superpowers/plans/2026-11-03-complete-briefs-759/README.md) remain retained.

**Independent narrow correction recheck clean at c7b33e77; publication and CI remain pending.** The
first independent whole review found three Important defects at34d52951. Its [original report](review/whole-branch-34d52951.md),
unchanged probes and actual red logs are retained. Both failed candidates34d52951 and3ed780bf remain
immutable commits. Source/test correction c7b33e77 follows them; evidence-only successors do not
change production. No push, PR publication, merge or deployment was performed by this author.

No paid/live provider, live crew, observed loop, real GitHub operation, live breaker or hub restart
was run. Provider boundaries use the repository's actual keeper/fake CLI with temporary repositories;
API boundaries use isolated Stores and stubbed external transport. **Visual N/A:** this child changes
server/core/runtime and contracts, with no served web source/layout change. Web #1390 remains
responsible for the dependent UI outcome. No underlying model identifier was supplied or inferred.

## Independent findings and focused correction

| Finding | Corrected behavior | Permanent boundary |
| --- | --- | --- |
| I1: escalation question edits left the brief current | Canonical freshness uses an indexed retained escalation lookup, including its full AutonomyQuestion/kind/source. Changed question facts refuse the old choice and refresh into a new epoch. | Actual Store/API changes10→10000 with the same title/key/time; old choice409; refreshed revision/epoch differ; no default invented. |
| I2: record-only action hid an unanswered passed seat question | Shared preparation refuses a recording-only `ask:` action; actual exact-run answer delivery remains the resolver. No brief/pass/ack is written by the refusal. | Intake rejects before writes; question stays unanswered, visible and unacked. Existing generic external recording and exact-answer cases remain. |
| I3: controller/UAT send-back missed final provider queue checks | Supervisor.send captures the private guard and checks before line claim and immediately before provider input. Shared sendBack and verdict writes recheck after awaits. Bound line identities include the decision epoch; normal direct-call keys/behavior remain. | Actual keeper/fake CLI refuses the obsolete second input; distinct bound intent keys do not falsely deduplicate; controller/UAT post-await source changes keep the canonical holds. |

The private context ends when the explicit effect commits or its request finishes. Normal subsequent
engine work uses its existing current guards; a completed choice's old source guard cannot leak into
a later background callback. No request header/producer payload can install that context or identity.

The original I2 probe assumes the invalid record-only intake succeeds before testing the POST. The
correction deliberately refuses earlier at intake400, so that old helper assumption is obsolete.
The original file is unchanged and is **not** relabelled as an unchanged green execution. Its
permanent regression explicitly expects the earlier refusal and checks zero answer/ack/brief writes.
I1/I3 original probes passed unchanged in the independent current-source recheck. The [correction report](review/correction-c7b33e77.md) separately records the adapted early-refusal I2 case.

## Actual execution stages

Stages overlap. Do not sum these rows as unique passing tests or relabel a failed full pack as green.
All raw outputs, byte counts and SHA256 values are in [log-manifest.json](log-manifest.json).
Runner logs use lossless gzip with both compressed and raw hashes; `gzip -dc <path.log.gz>` reads the original bytes.

| Stage | Actual result | Scope/limit |
| --- | --- | --- |
| New boundaries against unchanged d192 production | 2fail/1pass/694filtered,1.84s at16:09:49UTC | Incomplete operator content and unbound default authority reproduced. The new test working tree was not separately snapshotted; the original raw red is retained. |
| Initial boundary implementation | 3pass/694filtered,1.82s at16:28:28UTC | Only three boundaries. Later complete fixtures explicitly omit decision to keep that boundary; not claimed as the exact original test snapshot. |
| Initial types/collection failures | Core pass; server6diagnostics, then3diagnostics; first choice pack3collection failures/no executed tests | Narrowing/acked input and a real runtime schema-import cycle were corrected. Original failed logs remain. |
| Second choice pack | 11pass/694filtered,2.45s | Eight new Store cases plus initial three. Core/server types passed. |
| First family pack | 84pass/11fail/660filtered,7.97s | Old incomplete fixtures/admission fixtures corrected; server types had3fixture diagnostics. |
| Second family pack | 88pass/3fail/687filtered,9.47s | Person draft-ID proof and generated queue source mismatches corrected afterwards; types0. First safe formatter found1implicit-any error. |
| Tranche5 full family files | 119pass/1fail,4.27s at18:04:56UTC | Exact source [manifest](source-stage5-manifest.json); missing external attention fixture source failed before a choice. No chained checks. |
| Corrected external file | 14pass,1.87s | Fixture now uses actual linked configured-board ticket + existing PR_WAIT_MS quiet time, not a fabricated attention item or verdict. |
| Intake/engine/Store selection | 57pass/1288filtered,4.52s | Other cases not run in this selection. |
| Initial actual fake-CLI guards | 3pass,3.13s | Exact-run/source/pause queued-message checks. No real provider. |
| Initial validation | Core/server types0; formatter0 | Workspace lint later found one remaining pure formatting error; retained, then fixed. |
| Full affected server pack at immutable34d | **1864pass/2fail**,11files,54.74s at18:12:22UTC | API inventory lacked new route; full legacy payload equality lacked new rowID/state. No full repository suite. No chained checks after failure. |
| Narrow API contract update | 17pass/384filtered,2.39s | Added actual route to exhaustive auth inventory with strict409 valid-unbound placeholder; retained all old long-content assertions plus unknown legacy metadata/no binding/no deadline. |
| 3ed workspace checks | Types0; initial lint formatting failure retained; corrected lint0/build0 | No semantic production change from34d; two review projections folded as formatter requested. These checks did not resolve the independent defects. |
| Independent review at34d | Three Important findings; no Critical/separate Minor | First setup attempt executed zero cases. Actual final send diagnostic awaited the second fake-provider input; earlier count-only observation was not sufficient delivery proof. See original report. |
| Correction focused cases | **25pass**,3files,6.17s at20:33:51UTC | API18/private context2/actual fake-CLI5. Tests ran before final safe formatting; no functional edit followed. |
| Correction engine group | **26pass/426filtered**,3.84s at20:34:04UTC | Existing controller/UAT/hold cases plus post-await regressions; no full452-case engine rerun. |
| Correction workspace validation | **types0/lint0/build0** | Final formatted bytes committed as c7b33e77. Lint78warnings/7infos/0errors; core62modules/no cycles. No final CI claimed. |
| Independent correction at c7 | **5pass/16skipped**,3files,3.18s at20:41:39UTC | Original I1/I3 semantics, I2 adapted only to assert the earlier refusal, plus two unchanged private-context tests. All three Important findings closed; no new finding. [Exact independent command and limits](review/correction-c7b33e77.md). |

## Executed command receipts

Initial red and first green:

```sh
pnpm exec vitest run --project server apps/server/test/flight-tools.test.ts apps/server/test/decision-defaults.test.ts --maxWorkers=1 -t '1389'
```

Failed full affected pack at34d:

```sh
pnpm exec vitest run --project server apps/server/test/api.test.ts apps/server/test/engine.test.ts apps/server/test/store.test.ts apps/server/test/flight-tools.test.ts apps/server/test/brief-choices.test.ts apps/server/test/brief-action-api.test.ts apps/server/test/decision-defaults.test.ts apps/server/test/comms-decisions.test.ts apps/server/test/queue-reorder.test.ts apps/server/test/person-replies.test.ts apps/server/test/external-merge.test.ts --maxWorkers=3
```

Narrow API integration correction:

```sh
pnpm exec vitest run --project server apps/server/test/api.test.ts --maxWorkers=1 -t 'local access|GET /api/attention includes'
```

Focused three-finding correction:

```sh
pnpm exec vitest run --project server --project server-process apps/server/test/brief-action-api.test.ts apps/server/test/brief-dispatch-context.test.ts apps/server/test/supervisor-brief-choice.test.ts --maxWorkers=3
pnpm exec vitest run --project server apps/server/test/engine.test.ts --maxWorkers=1 -t '1389|controller check|acceptance|merge hold|un-parks a parked run|FLIGHT.s un-park'
pnpm typecheck
pnpm lint
pnpm build
```

Changed-file formatter argv is printed at the start of its raw log. No unsafe fix flag, test timeout,
assertion threshold, dependency, workflow or configuration change was used. The private source
snapshot for tranche5 remains at `/controller/1389-tranche5-unverified-source`; it is not a claim that
all later executions used those exact bytes. The independent correction report identifies its actual source and scope; future CI must identify its own
actual tested head. The original failed whole review and probes remain retained.
