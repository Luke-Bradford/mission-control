# Repeated attention and HUD reads

This is partial work for #933. The ticket remains open: the copied-preview observation still
misses its CPU and memory targets, and there is no post-deployment proof for this source.

## Same data, less read work

Each benchmark uses five alternating-order pairs, separate Store instances, one unchanged
SQLite backup and a fixed clock. Every result returns the same 11 attention items, 13,449 JSON
bytes, with the same SHA-256. Private question content and the database are not published.

| Experiment | Main median | Candidate median | Source |
|---|---:|---:|---|
| Stage one | 126.41 ms | 78.24 ms | 6ce870db |
| Stage two | 196.66 ms | 105.53 ms | 32152993 |

The baseline is main at 03ef6b52. Host load differs between experiments, so the absolute
timings across these rows do not measure the incremental effect of stage two. Each JSON
receipt retains its ten actual paired timings, item counts, byte counts and result hashes.

Stage one avoids unrelated closed-PR history while retaining open PRs and historical PRs
referenced by visible or held runs. It replaces broad PR hydration for branch/ticket lookups.
Stage two uses a covering expression index for actual stored context-window measurements,
with legacy invalid JSON guarded. Per-agent indexed reads bound history before conversion;
they retain held-run exceptions, timestamp/sequence ordering and existing limit semantics.

## Idle observations still miss the target

Each observation starts an isolated preview on a copied database, profiles for 70 seconds,
then records process samples every ten seconds for 30 minutes. Preview crew starts and
observed-loop writes are disabled. The live hub and observed loops are unchanged. The
runner verifies the preview version and stops only its own preview process at completion.

The primary CPU measure is cumulative process CPU-time change divided by elapsed sample
time. The lifetime-averaged `ps` CPU column includes earlier activity and is not the primary
result. The initial profile is excluded from the CPU-time calculation.

| Source | CPU | RSS first → last, KiB | Descriptive RSS slope, KiB/min |
|---|---:|---:|---:|
| Main 03ef6b52 | 7.44% | 195,136 → 282,688 | +510 |
| Stage one 6ce870db | 5.39% | 203,824 → 348,576 | +1,542 |
| Stage two 32152993 | 4.10% | 128,608 → 337,968 | +3,012 |

The latest source still exceeds 2% CPU. Its RSS rises during the observation, so steady
memory is not proved. These are descriptive observations, not a statistical leak verdict.
Database contents and wall-clock periods differ between observations; full controller tests
also ran on the same host. Do not treat the table as a controlled CPU comparison or claim
that this preview reproduces the live workload. `idle-observations.json` retains exact spans,
sample counts, source heads, extrema and method notes.

## Checks and remaining work

807 focused Store, HUD, run-view and API checks passed. Lint, workspace typechecks and
production build passed. The full local run on source 32152993 took 1,075 seconds: 14,392
passed and three failed across 520 files. Two are main's existing FlightPageMockup 36px
decision-gap failures, covered by PR #1586. The daemon's unsigned-removal reconnect case
timed out, then passed a direct named recheck. The full command exited 1.

CI later exposed an existing screenshot-test startup race: another worker could raise the
machine-wide Chrome count before this worker launched its own browser. The same failure
reproduced locally. The two abort-test startup waits now use newly owned descendant PIDs;
the global cleanup assertions remain unchanged. All 14 real-browser cases passed after the
test-only fix. Production source is unchanged since the full run on 32152993. Exact-head CI
and a fresh independent most-capable review are still required. Further profiling and a
passing copied-preview observation remain, followed by actual live verification after an
authorized deployment. No clean full-local test result or completion of #933 is claimed.

## Closed-PR HUD cache regression: review 1343

Two real HUD projections begin with an empty request cache and a run naming a closed PR through differently cased repository text. The second binds the seat to an old run behind 51 newer completed runs, outside the ordinary 50-run window. Both include an unrelated closed PR with deliberately malformed historical checks. They assert that projection succeeds and retains the exact named PR's title, URL, closed state and ticket; the row resolves its ticket from that PR.

Both cases pass. A temporary mutation removing reference collection makes both fail, proving the assertions exercise the actual HUD cache wiring. The production source was restored immediately. The complete Store, HUD and run-view suites pass 383 cases after correcting the new fixture's completed status to the real ok enum. Lint and workspace typecheck pass. This is test-only rework: production source and the earlier performance measurements are unchanged. Fresh pushed-head full CI and independent QA remain required. The parent performance ticket remains open for the unmet CPU, memory and post-deployment targets.

## Resolve the main-branch browser-test conflict

Main now contains the stronger per-render Chrome-profile ownership helper from the merged screenshot PR. It supersedes this branch's earlier descendant-PID startup synchronization. The conflict keeps main's complete test file, including frozen cleanup and concurrent-render isolation. The two new HUD cache regressions remain. All 398 HUD, Store, run-view and real-browser checks pass after the merge, including all15 browser cases. Lint, workspace typecheck and build pass. Performance source is unchanged; the parent CPU/memory and deployment criteria remain unmet. Fresh CI and independent QA are required on the merged head.

## Current continuation: batched thread mentions

The baseline is main at `9be5cf23363368109b22e83b690e766ba2fc1d48`. A new 70-second copied-data
profile finds repeated Comms mention hydration in Needs you: its per-message native SQL
reads account for 284.89 ms of sampled time. This continuation batches mentions for the
existing bounded thread snapshot. It keeps all message fields, stable IDs, sender and delivery
facts, reply links, mention sorting, insertion order, the 500-row limit and read-cursor behavior.
Each call returns fresh arrays; there is no message cache across calls. No guard, quota,
provider, observed-loop setting or GitHub-writing service changes.

The regression first fails on baseline with 500 mention lookups for one full thread. It seeds
520 messages, unrelated ID gaps, both directions, a self-addressed message, multiple/empty
mentions, reply links and sender/item metadata. Complete rows, the newest-500 limit, cursor
filtering and independent returned arrays remain asserted. The initial instrumentation
attempt was discarded because the database proxy bypassed that spy; the retained failing
execution instruments the Store's actual prepared-statement lookup and observes all 500.

The committed executable correction is `fef587386285136eea3ab5a407838d69f66c7b24`. The retained benchmark was
then actually executed on that source. Five alternating-order pairs use separate Store
instances and one frozen copied database. They read all configured agents plus CAPCOM,
with complete history and actual read-cursor variants. Every execution returns the same
7,321 rows and 7,897,714 JSON bytes, SHA-256
`a9d5ce11d7db3d027e6aa8294dfcbce71637afb93e758c96b094ebf6f23b33b1`. Actual mention SELECT executions, including
prepared-statement reuse, fall from 7,321 to 30. Median read time is
45.70 ms before and 22.02 ms after. The host also
runs the preserved native author's affected-test check. These timings do not prove the
whole-app CPU target. `thread-read-pairs.json` retains all ten measured executions.

`thread-read-benchmark.mjs.txt` retains the measured algorithm. It now refuses a missing or
empty copied database before opening Store; the executed missing-copy check exits nonzero
without creating a database or report. Restore an archived database first. Copy the harness
to an `.mjs` file and run with Node 26: `node --experimental-strip-types /tmp/thread-read-benchmark.mjs
<before-checkout> <after-checkout> <copied-db> <output-json> <config-yaml>`. Use a copied
database only: Store initialization may migrate it. The harness saves hashes and aggregate
counts, not private message content.

A following 70-second candidate profile reduces sampled native mention-read time to
14.97 ms; sampled inclusive attention time is 1,658.53 ms before and 1,408.08 ms after.
The observation periods contain different periodic work: the latter also samples 745.53 ms
in the existing quota rollout-directory scan and 335.10 ms in rate-limit bookkeeping SQL.
Both preview processes exit cleanly. These are hotspot diagnostics, not a controlled
whole-process CPU comparison or a 30-minute idle acceptance sample. The profile aggregates
retain their source commits, durations and scope; the raw profiles and database stay private.

All 398 Store, Comms and HUD checks pass. Lint, workspace typecheck and production build
pass; lint still reports 103 existing warnings and seven infos. Full local validation is
still required after the existing native heavy check finishes, followed by exact-head CI
and fresh independent review. This continuation is not published or merged yet.

The required under-2%/steady-memory preview observation and post-Update live verification
remain unmet. The last actual live observation on `73fc96ee` measured 7.51% CPU over
1,807 seconds, with RSS 231,808 to 293,616 KiB and descriptive fitted slope +56.30 KiB/min.
It includes eight samples with native review activity; its no-crew subintervals do not form a
separate 30-minute idle pass. #933 stays open.
