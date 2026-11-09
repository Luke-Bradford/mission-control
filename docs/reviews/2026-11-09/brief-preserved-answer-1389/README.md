# Preserved-run answer binding: review 1335, finding 3512

An exact answer to a passed question now remains bound to its preserved run after replacement work starts on that seat. The delivery-only source projection omits the automatic replacement occupant and keeps the original question and run. Explicit action targets remain part of the projection. The preserved run's status, hold, approval and controller/UAT facts, configured seat, instructions, global pause and stopped state remain binding.

The regression first binds the operator choice, sets that run aside on the exact question, and creates a replacement run. It failed on the reviewed source: the API returned 409 instead of 200. The correction stores the answer only in the preserved-run inbox and reconciles only that run. It sends no message to the replacement, leaves that run unchanged and preserves its seat occupancy. The original no-replacement case still passes.

Two guard regressions verify that a new hold on the preserved run or a seat Stop still refuses the old choice with 409, stores no answer and performs no reconciliation. The complete focused action API, brief-choice and legacy choice suites pass 69 cases. Fresh lint, typecheck and build pass. No additional full local-suite pass is claimed for this update to the existing crew PR; full pushed-head CI and fresh independent whole-branch review remain required.

## CI timing correction

The pushed-head process shard exposed an existing race in the decision-epoch deduplication test: it observed the previous idle state before the newly accepted fake-provider turn completed, so a legitimate busy refusal arrived before the deduplication check. The test now deliberately holds that turn with the existing fake CLI's QUIET control, verifies that the old completion timestamp has not advanced, releases the turn, and waits for its actual newer completion receipt plus idle state. It still requires duplicate for the same exact epoch, no extra provider line, and sent for a different epoch. Production busy and deduplication behavior are unchanged.

The focused five tests pass. The actual failed CI shard command, `pnpm exec vitest run --project server-process --shard=1/2`, now passes all 237 tests across ten files locally. The earlier CI failure remains part of this change's history; fresh CI and independent review are required on the new pushed head.
