# Size collection checks — 2 November 2026

A copied database/config supplied the configured local checkout. Its git-log cache was already populated; the new size tables began empty. No network listener, fetch, crew action, observed-worktree write or live-hub change occurred during measurement.

| Measurement | Result |
| --- | ---: |
| New size collection | 127.3 ms |
| Whole cycle with the git-log cache already populated | 171.2 ms |
| Unchanged-head cycle | 34.2 ms |
| Captured regular text files after exclusions | 1,195 |
| Worst cold HTTP read across 12 tab/window combinations | 50.6 ms |
| Worst cached HTTP read across those combinations | 11.6 ms |
| Largest full HTTP response | 938,819 bytes |
| Largest bounded tool summary | 63,758 bytes |

Each combination received 20 cached reads. The full bounded table remains available over HTTP; the tool states omitted rows and histories. Evidence pages stay within 50 rows. An initial observation has no measured earlier baseline, so it cannot establish growth.

Focused fixtures verify exclusions before ranking, empty/final-line/CRLF counts, binary and symlink handling, unchanged index state, actual capture dates, retained first-capture time, history paging, scope isolation, renamed paths, stale/failed states and incomplete rows. A rotating-checkout fixture confirms bounded daily retention. Additional regressions reject object access after a failed no-lazy-fetch probe and keep long-path histories within the tool budget.

No page layout changed. File recommendations and scoped planner context remain in #1346.
