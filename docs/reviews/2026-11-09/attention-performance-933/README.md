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
