# File collection checks — 2 November 2026

The git collector ran against configured local committed objects, with a copied database and config. No network listener, crew action, fetch, observed-worktree write or live-hub change occurred during measurement.

| Measurement | Result |
| --- | ---: |
| First background collection | 1,233 ms |
| Unchanged-head check and cached membership linking | 30.6 ms |
| Captured first-parent commits | 655 |
| Captured numstat records | 7,034 |
| Worst cold HTTP read across 12 tab/window combinations | 49.5 ms |
| Worst cached HTTP read across those combinations | 12.3 ms |
| Largest full HTTP response | 882,905 bytes |
| Largest bounded tool summary | 102,300 bytes |

The full risk response retains the bounded coupling table. The tool returns an explicit prefix and omitted counts. Each combination received 20 cached reads; evidence pages remained bounded to 50 rows. Measurements used git 2.54.0. Local source availability and timings can differ elsewhere.

Focused regressions cover actual rename and binary counts, unchanged index/worktree state, blocked external programs, merge-date windows, late metadata linking, repo/checkout isolation, stale/failed collection, malformed records, raw gitlink width, mutable attribute overrides, single-parent uncertainty and damaged-cache omissions.

The broad-PR regression uses four fixture merges. Each changes 24 code paths and two gitlinks. All four remain 26-path diffs and are excluded from coupling. Gitlinks do not enter file touches. An untracked attribute file cannot alter cached-SHA binary counts; local override rules make collection unavailable.

The collector does not establish comparable size history. That and scoped planner context remain in #1346. No visual layout changed in this portion.
