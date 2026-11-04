# Idle recomputation (#933)

What an idle hub spends CPU on, what changed, and the figures. All figures here are for a
**synthetic seeded fixture**, not a copy of the live data (seats cannot read it). The hub-level
before and after profiles on a copy of the live database are FLIGHT's and go in the PR.

## Before (FLIGHT, c2bea393, DB copy, `MC_NO_LOOP_WRITES=1`, `MC_NO_CREW=1`, 301 s profile)

After the first 120 s the hub was busy 2.84% of 181 s. Largest inclusive shares: memoised views
2.5%, `attentionItems` 1.66%, `crew` 1.40%, `afterLoopTick` 1.11%, `scheduleTriage` and
`flushEmits` 0.97%, `reconcileNotifications` 0.51%.

## The fixture

One repo, 1,500 board cards (1,200 closed), 6,000 settled board moves, 3,000 ended runs with
30-minute token digests over 40 days, 7 days of one-per-minute machine samples, one crew session
with one seat (that seat has an open run, as the copied data does), a ta loop and a studio loop. Reads go through `buildApp` / `createScheduler`
with the real store; collectors are stubbed.

## What changed

| Source | Change |
| --- | --- |
| Overview (`/api/overview`) | The per-minute in-flight series scanned every board move for every card, 30 times. Moves and cards are indexed once, the moves read are only those in the 30-minute window plus each card's last one before it (`board_moves_card` index), the board is read once and kept frozen until it changes (`Store.boardView`), and the needs history is written only when it changed. |
| Loop tick (`afterLoopTick`) | A quiet tick (nothing written, no date hold due, under `SWEEP_REPEAT_MS`) no longer re-runs the ack and hold sweep. |
| Topic gate (`flushEmits`) | `agents` and `attention` are rebuilt for hashing at most once per `GATE_CLOCK_MS`, or when the store changed, not on every tick. |
| Triage and notifications | `scheduleTriage` and the notification reconcile look again only when the store, lock or login changed (or config or FLIGHT was signalled), or a minute passed; the look is not repeated on every bus topic. |
| Open crew-seat run | An open run of a crew seat no longer keeps every loop tick reading the crew; only an open run of a loop does (a seat's state turns with its session row or the clock). |
| Store version | A collector status rewritten with the same result (only its time moved) no longer moves `readVersion`, so memoised views and cached responses survive an idle tick. The stored time is still written. |

## After (same fixture, warm)

| Measure | Before | After |
| --- | --- | --- |
| `/api/overview` | 21 ms (72 ms in-process, no HTTP) | 12 ms (9 ms in-process) |
| Loop tick pair (ta + studio), no browser | 17.3 ms CPU, 1.1 crew builds | 2.6 ms, 0.1 |
| Loop tick pair, a browser connected | 39.0 ms CPU, 2.0 crew builds | 4.4 ms, 0.1 |
| Same, with an open seat run, no browser (head 4cb561a to now) | 28.7 ms, 1.1 builds | 3.2 ms, 0.1 |
| Same, with an open seat run, a browser connected (4cb561a to now) | 44.3 ms, 1.9 builds | 2.9 ms, 0.1 |

FLIGHT's copied-data profile of 4cb561a showed 3.10% busy (against 2.84% before), with the open
runs keeping ticks from being quiet; the last two rows are the answer to that.

Payload bytes of `/api/overview` and the SSE stream are unchanged (no field was added or
removed; the overview differs only in the time-dependent figures).
