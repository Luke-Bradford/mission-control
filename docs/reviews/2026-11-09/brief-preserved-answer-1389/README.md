# Preserved-run answer binding: review 1335, finding 3512

An exact answer to a passed question now remains bound to its preserved run after replacement work starts on that seat. The delivery-only source projection omits the automatic replacement occupant and keeps the original question and run. Explicit action targets remain part of the projection. The preserved run's status, hold, approval and controller/UAT facts, configured seat, instructions, global pause and stopped state remain binding.

The regression first binds the operator choice, sets that run aside on the exact question, and creates a replacement run. It failed on the reviewed source: the API returned 409 instead of 200. The correction stores the answer only in the preserved-run inbox and reconciles only that run. It sends no message to the replacement, leaves that run unchanged and preserves its seat occupancy. The original no-replacement case still passes.

Two guard regressions verify that a new hold on the preserved run or a seat Stop still refuses the old choice with 409, stores no answer and performs no reconciliation. The complete focused action API, brief-choice and legacy choice suites pass 69 cases. Fresh lint, typecheck and build pass. No additional full local-suite pass is claimed for this update to the existing crew PR; full pushed-head CI and fresh independent whole-branch review remain required.
