# Handled signals in the wake digest

A copy of the live database, taken at 08:36 UTC on 9 November, supplied one identical full state to both implementations. The baseline was main at 03ef6b52. The candidate was the implementation on this branch. Both generated a first wake without a per-session delivery snapshot.

The first wake fell from 129,406 to 64,965 JSON bytes (49.8%). Its signal list fell from 215 entries to 20, with 195 handled entries counted instead of repeated. Signal JSON fell from 70,182 to 5,741 bytes. All other digest fields were identical. The full state was unchanged and retained all 215 signals.

These are JSON bytes, not measured provider tokens or billed savings. The copied database and its private signal text are not included. `digest-size.json` retains the counts, measurement time and comparison results.

Checks cover 400 handled signals plus a new failure, new episodes, a reason made actionable again, wait expiry at the 24-hour boundary, full-state retention, removal tracking and a renewed wait. The existing full-state reader still returns the original state; only the wake digest suppresses handled and stale wait entries. Episode identities retain the existing producer rules: changing age counters and polling evidence on a handled episode does not make new work.
