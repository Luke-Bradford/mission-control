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
| Dead loop runs | A loop run left open for over a day (`ACTIVE_RUN_WINDOW_MS`) no longer counts as work in progress, so it cannot keep ticks from going quiet. The row is not changed. FLIGHT's copy had five such rows (two paused loops, July to October). |
| Offsets | `setOffset` writes only when the offset moved, so reading an unchanged file does not move the store version. |
| Seats and loops in a clock-driven state | A running, stalled or waiting agent with unchanged inputs makes a loop tick read the crew at most once a minute (`TIMED_COAST_MS`); stall and wait thresholds turn by the minute. The tick also logs, under `MC_DEBUG=1`, why it read the crew (`loop tick reads the crew: <reason>`). |
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

### Bytes (measured, 12 Nov)

Same synthetic fixture (1,500 cards, 6,000 moves, 3,000 runs with digests, 7 days of samples, a ta
loop), at `origin/main` before this branch and at this head, same seed and clock:

| Measure | Before | After |
| --- | --- | --- |
| `/api/overview` body | 3,577 bytes (sha256 prefix `0676ec6867ff`) | 3,577 bytes (`0676ec6867ff`) |
| SSE events over 5 idle minutes, one stream, collectors stubbed, not counting `machine` | 12 events, 1,770 bytes with `machine` pings (30 at most, 10 s apart) | 12 events, 1,770 bytes |
| Same, by topic | `limits` 6, `attention` 6 (+ `machine` 31 emits) | `limits` 6, `attention` 6 (+ `machine` 31 emits) |
| Test run time for the same 5 minutes plus seeding | 6.2 s | 3.8 s |

Equal bytes and an identical body hash are the result: the work moved, not the payload. The SSE
window is small because the scheduler's collectors were stubbed; it shows the gate sends no
event it did not before, not what a live hub sends.

The fixture now also carries two such dead loop runs; the tick-pair figures above (2.2 ms with no
browser, 3.1 ms with one) include them.

Status (11 Nov): copied-data samples of 4cb561a, d66eab0 and 643a5c2 measured 3.91%, 3.69% and 3.69%
mean CPU, above the under 2% target. The last head's sample is FLIGHT's to record; if it misses,
the next source to cut comes from its profile.
