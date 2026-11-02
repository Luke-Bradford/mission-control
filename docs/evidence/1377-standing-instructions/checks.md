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

## Current checkpoint limits

The latest integration edits still need their bounded reruns. No final all-green claim applies yet.
Remaining checks include corrected fake-CLI cases, changed-order wake/retry/no-loop behavior, the new tools/re-plan
cases, queue/config/HUD focus readers, the API route inventory, relevant runtime/core regressions, lint,
workspace typecheck and build. No full local suite was run. Normal CI remains required.

No paid provider, live crew action, observed-loop mutation, live breaker, production database operation,
source push or PR creation occurred. Fixture process tests use only the repository's fake CLI and temporary
Git repositories. Shared heavy-job slots were released between bounded runs.

## Integration scope

The minimal packages/core/src/runtime.ts FLIGHT_TOOLS addition was confirmed by the controller as necessary.
It adds only instruct_seat and revoke_instruction; global-order mutations remain excluded.
Raw config focus stays an import source. Queue eligibility, queue reorder, HUD rows, the focus API and
message_seat reads use the resolved durable value. Existing raw config serialization stays raw for the
session editor's optimistic comparison.
