# Same-pass independent correction review — #1389

**Clean at `c7b33e77e01b28256fd8ffb22fa3bad97d09099a`, 2026-11-03 20:41:39 UTC.** All three Important findings from the original whole-branch review are closed. No remaining Important/Critical or separate Minor finding in this correction. Design/visual N/A for this backend/core/runtime child. Exact final-head CI and the author's final evidence package are separate pending steps.

Original whole review: `$CONTROLLER/review-1389-34d52951.md`, source34d529515cc9719c042e9d969e159fa89b5c8eb6 againstd192dd83d42299dfe52aedccf2791c4ab91b0169. The3ed successor changed only API expectations/source formatting. This review read the complete11-file correction delta3ed→c7 (source and tests), the existing relevant service callers, and retained author correction receipts. This is the continuation of that whole review, not a replacement whole pass or a claimed full-suite rerun.

## I1 closed — Canonical escalation/question freshness

The source reader now includes the indexed retained escalation object, including its question/recommendation/options and source facts. Store's indexed lookup shares the unchanged row decoder. GET only reads retained data. The original independent real-Store probe changes the fictional escalation question with title/key/openedAt unchanged; it now reports stale. The permanent added API case also rejects the old choice409 with no ack/audit effect and proves a refreshed source revision/epoch, without adding an approval default. No new inferred authority or remote preparation was introduced.

## I2 closed — Recording-only question refusal

Shared preparation now rejects record-decision for ask:<id> with400 before brief/choice/ack/answer writes. Ordinary typed answer remains the real exact-question resolver. The original independent test's successful-intake assumption is obsolete: the correction intentionally refuses earlier. I adapted only that test to expect the400 and assert no saved brief, no ack, answeredAt still null and visible unacked source. It passes. The original34d red helper and receipt are untouched and are not relabelled green.

## I3 closed — Final queued provider and post-await verdict guards

Supervisor.send captures the private internal guard and exact decision epoch before queueing, checks the guard before the line claim and again in writeLine before provider input, drops a refused line claim and propagates the guarded error. Direct sends retain their existing behavior. Delivery keys include the semantic epoch so a different freshly inspected intent is not falsely reported as an old duplicate. The choice route supplies only the server binding epoch; clients cannot install the guard/identity.

Engine sendBack checks the binding before pending/direct delivery and after awaiting provider delivery; controller/UAT and operator-resume transitions recheck before committing captured loop state. The explicit effect commits before withoutBriefDispatch ends its completed context, so subsequent ordinary engine work uses current normal guards. Private async context lifetime is bounded and does not leak the obsolete binding into later background callbacks. Read the two new context cases and controller/UAT post-send source-change cases, including their no-loop-transition/no-Comms outcomes.

The unchanged original independent final-send probe now observes `result: Error: Bound source changed, checks:2, lines:1`. The old actual fake-CLI stale second input is prevented. No new authorization, actor fallback or approval-floor bypass was found in this delta.

## Independent execution and exact limits

Root granted one bounded one-worker slot. Executed from isolated detached `$CONTROLLER/review-1389-c7b33e77`, production unchanged at exactc7; existing dependency directories linked. No candidate edits, browser, full suite, live/provider/GitHub/loop operation or push.

```sh
pnpm exec vitest run --project server --project server-process apps/server/test/review-1389-boundaries.test.ts apps/server/test/supervisor-review-1389.test.ts apps/server/test/brief-dispatch-context.test.ts --maxWorkers=1 -t 'REVIEW1389|does not leak a completed|ends the old choice'
```

Actual **5passed/16skipped,3files,exit0,3.18s**. Log `/tmp/mc-1389-review-c7b33e77-correction.log`, SHA256 `d72db3b45ed7389f1ce26939dbba5a004882e81a3ca53ae8dea69c88dffd87ff`. Independent I1 and I3 probes retain their original semantics; I2 changed only to assert the earlier correct refusal. The two private-context tests are unchanged author regression cases executed independently. The full typed-family/durability review carries from34d; no repeated1866-case local suite is claimed.

Probe SHA256:
- adapted `apps/server/test/review-1389-boundaries.test.ts`: `0a29e29bc57c9292f3358008dc2977ca7fc176410410d0bdc2e467766e5a6f2c`.
- unchanged final diagnostic `apps/server/test/supervisor-review-1389.test.ts`: `21a1d3c2b4625568db961d68ff1c2e16467f543089abb8f56bc3920d9c279b82`.

Author receipts read separately:25API/context/fakeCLI corrections,26selected engine cases/426filtered, core/server/workspace checks as retained in `/tmp/mc-1389-review-fixes-{first,engine,types,lint,build,format}.log`. They are author evidence, not an invented single independent full run. Final artifact provenance and future exact-head CI remain required before delivery.

Reviewer: Codex sub-agent `/root/review_1347`, independent of backend author. No specific underlying model identifier was provided; none inferred. Heavy lane released immediately on command exit. Original failed34d review and red logs remain immutable historical evidence.
