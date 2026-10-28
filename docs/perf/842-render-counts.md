# #842 web render counts

React `Profiler` counted commits below the selected page root for 60 fake-timer seconds. The
live scenario emits a stubbed `agents` SSE change every five seconds. Both measurements use the
same route fixtures (idle crew and unchanged API responses), after the initial mount has settled.

| Page | Idle before | Idle after | Live before | Live after |
| --- | ---: | ---: | ---: | ---: |
| Overview | 72 | 72 | 142 | 142 |
| Flight | 72 | 72 | 120 | 122 |
| Board | 72 | 12 | 98 | 40 |
| Agent | 60 | 0 | 86 | 26 |
| Map | 60 | 0 | 86 | 26 |
| Comms | 60 | 0 | 86 | 26 |
| Telemetry | 61 | 61 | 86 | 87 |
| Setup | 72 | 12 | 98 | 38 |

`origin/main` was measured from `10f7da87` in a disposable source archive using the same
Profiler harness. The branch measurement is guarded by
`apps/web/test/pageRenderCounts.test.tsx`; its idle budgets retain intentional local clock commits
for pages that visibly display elapsed or relative time. Pages without one now have zero idle
commits, and Board and Setup retain only their five-second relative-time updates.
