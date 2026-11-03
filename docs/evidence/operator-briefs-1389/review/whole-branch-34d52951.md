# Independent whole-branch review: #1389

Conclusion recorded 2026-11-03 18:20:28 UTC. **Changes required: three Important findings.** No Critical or separate Minor finding. Visual/design N/A: backend/core/runtime changes; no claim of automated visual-quality judgment.

Reviewed product/source head `34d529515cc9719c042e9d969e159fa89b5c8eb6` against `d192dd83d42299dfe52aedccf2791c4ab91b0169`. Author worktree `codex-1389-complete-briefs`; isolated reviewer snapshot `review-1389-34d52951`. I did not author this backend implementation. Reviewed published #1389/#759, their retained contracts/private refinement package, repository instructions, full production delta and relevant service callers, storage/default/recovery paths and regression coverage. Also read successor `3ed780bf12f0e79d237df0336b18b62ceb09937e`: only API test expectations plus source formatting; it does not resolve these findings.

## I1 — Escalation question edits leave an obsolete brief current

**Important.** `apps/server/src/brief-source.ts:186` (source reader omits escalation facts; only the projected item title/ID is hashed at181–196). The original source reader in `flight/tools.ts` retains the escalation's full `question` object, but this freshness reader never loads it. Change an existing escalation's question, recommendation, answer options or requested amount while keeping the issue title/key/openedAt: the old brief remains `freshness=current`. Its old choice therefore passes the source check against a materially changed request.

Independent real-Store regression changes a fictional request from 10 to10000 dollars with the same title/key. Expected stale; actual current. Include the retained escalation identity, question payload, kind/source and relevant current status in canonical facts. Missing source must be unknown/stale, never current. Cover choice rejection and refreshed epoch/deadline as appropriate.

## I2 — A recording-only option hides an unanswered passed question

**Important.** `apps/server/src/brief-prepare.ts:396` (`record-decision` source restrictions), combined with unconditional successful-choice ack `brief-choices.ts:322`. A passed `ask:<id>` can bind `record-decision`. Choosing it returns200/applied and marks the attention item acked, but `question.answeredAt` stays null. The human question disappears from Needs-you while it still holds the run. A supported exact question answer service exists, so this is not an external decision with recording as its sole real effect.

Independent actual API/real-Store regression confirms `{status:200,acked:true}` with unansweredAt null. Refuse recording-only actions for question sources requiring the exact answer resolver, or implement the actual bound delivery/resolution. Preserve explicit hold/wait semantics rather than acknowledging unresolved questions as settled.

## I3 — Controller/UAT send-back misses the final queued brief guard

**Important.** `apps/server/src/engine/engine.ts:1231` (shared `sendBack`) and `apps/server/src/runtime/supervisor.ts:4651` (queued `send`, provider write at4661). The new brief guard is checked on engine-chain entry, but controller-fail/UAT-send-back then call `supervisor.send`, whose separate provider queue does not execute that guard. A source/head/hold change after entry but before queued delivery can still send the obsolete rework note. The engine also writes its captured next loop after awaiting that delivery without another bound-source check.

Independent actual keeper/fake-CLI boundary reproduces the missing final guard using the same private `withinBriefDispatch` context: initial check succeeds, source validity is changed before queued send executes, then send returns `sent` and the fake CLI receives the second user input. Observed `{result:sent,checks:1,lines:2}`; expected guard refusal/no second input. This probe tests the actual shared supervisor send boundary; the controller/UAT route-to-sendBack linkage is source-traced, not an additional end-to-end engine execution claim.

Carry the internal bound guard into the queued send and execute immediately before provider input. Also revalidate after awaits before committing the verdict/loop transition, including set-aside/pending-line branches where applicable. Preserve existing direct calls and uncertainty/no-replay semantics.

## Executed independent checks and limits

No full suite/browser/live/provider/GitHub/loop action. Only isolated temporary fake-provider fixtures. No candidate edits. Existing dependency directories were linked into the detached snapshot; production source is unchanged.

1. Initial selected command failed before collection because scratch web dependencies were not linked. Preserved `/tmp/mc-1389-review-34d52951-boundaries.log`; **zero executed cases, no product result**.
2. After linking unchanged web dependencies:
   `pnpm exec vitest run --project server --project server-process apps/server/test/review-1389-boundaries.test.ts apps/server/test/supervisor-review-1389.test.ts --maxWorkers=1 -t REVIEW1389`
   Actual3fail/16skipped,2.81s. `/tmp/mc-1389-review-34d52951-boundaries2.log`. First two failures are conclusive I1/I2. The first queued-send test observed its guard count before the asynchronous keeper had appended the line; that receipt alone did not prove delivery.
3. Refined only that observation; same immutable production:
   `pnpm exec vitest run --project server-process apps/server/test/supervisor-review-1389.test.ts --maxWorkers=1 -t REVIEW1389`
   Actual1fail,1.62s. `/tmp/mc-1389-review-34d52951-send-diagnostic.log`. Awaits the confirmed fake-provider line; conclusive I3 boundary proof above.
4. `git diff --check d192dd83..34d52951` exited0. No broader independent suite claim.

Probe files under the reviewer snapshot:
- `apps/server/test/review-1389-boundaries.test.ts` SHA256 `f406ad6789c8e58cc330b0e189bd2d7be04ff7c943ea9c6d7124616ceb2b408f` (copied existing API test helpers/cases; selection runs only the appended two REVIEW1389 cases).
- `apps/server/test/supervisor-review-1389.test.ts` final diagnostic SHA256 `21a1d3c2b4625568db961d68ff1c2e16467f543089abb8f56bc3920d9c279b82`.
- Boundary log SHA256 `a560063afca9734b1d609c1f29518290bec3a98bbf73a24b2b8c1eb925823ff1`.
- Final send diagnostic log SHA256 `97ef8aa8b6fd94a69c0bc9382afc2c515eb7cef894ec699b3dbdc43d90fa1cc9`.

Static coverage included all registered typed families (answer, review, queue proposal/direct queue, person post/handled, controller, UAT, floor grant, merge hold/release, breaker, wait/dismiss and record-only), source/meaning/epoch boundaries, manual/default contention, explicit actor provenance, durable pending/dispatching/unknown recovery and legacy read-only compatibility. Conditional scoped PR-operation FYI remains explicitly unsupported per the permitted contract disposition. Existing author results were read as author receipts: affected1864pass/2API expectation failures, later17selected APIgreen, workspace types/lint/buildgreen; these do not replace independent findings or constitute exact final CI.

Reviewer role: Codex sub-agent `/root/review_1347`. No specific underlying model identifier was supplied; none inferred. Heavy lane released after every terminal command. Backend author must correct the same branch; same-pass narrow recheck should preserve all original red receipts.
