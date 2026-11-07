# FLIGHT page mockup

A static proposal for the FLIGHT page. It is not product code, and all of its data is fictional (names, times, costs, counts and PR numbers are illustration only). Open `index.html`.

The default view is FLIGHT running with three blockers. `?state=running` is FLIGHT running with nothing blocking it; `?state=stopped` is FLIGHT stopped. The "Show" switch on the page changes between the three without a reload. Add `?theme=light` for light and `?flight=1` for the open FLIGHT rail.

## The question

Is FLIGHT working, what is it doing, and what blocks it, and who owns each blocker? One screen, no page scroll, at 1920x940 and 2560x1200.

## What the page holds

1. **Status band** (top left): FLIGHT running or stopped, with Start FLIGHT when stopped; cost per hour; sessions per hour; context size.
2. **Doing now**: three to five plain lines.
3. **Blockers**: one row each with the blocker, its owner (Operator, a seat, CI, GitHub or the hub), how long it has waited, and what FLIGHT is doing about it. Longest wait first. With nothing blocking, the panel says so.
4. **Recent decisions**: the last eight, one line each, newest first.

## What each number is computed from

| Number | Computed from | Window | Unit |
| --- | --- | --- | --- |
| FLIGHT status | The hub's FLIGHT run state (running or stopped) and when it last changed | now | word, plus "since HH:MM" |
| Cost per hour | The sum of the API-equivalent cost of FLIGHT's sessions that ran in the window. It is not a bill | last 60 minutes | dollars per hour |
| Sessions per hour | The count of FLIGHT sessions that started in the window. A handover starts a new one | last 60 minutes | sessions |
| Context size | Tokens in the current session's latest reading, against the 200k limit | the current session | tokens, with percent of the limit. Shows `—` when no session is open |

A stopped FLIGHT reads $0.00 and 0 sessions when it has been stopped for the whole window, and context `—`.

## What moved off the page

- **PR flow** (the 23-row PR table) moves to the **Board**. The page keeps one link to the Board and no table.
- The four tabs and their panels are gone. Anything the operator must act on shows as a blocker with its owner.
- The small red "Down" is replaced by the Stopped state in the status band, with Start FLIGHT beside it.

## Limits

- Not rendered by its author, whose sandbox cannot start Chrome. CI renders it: `apps/web/test/FlightPageMockup.browser.test.ts` checks no vertical or sideways scroll, no list scrolling inside its panel, controls of at least 24 px, and the three states, at 1920x940 and 2560x1200 in dark and light.
- Spare height at 2560x1200 goes to row height (capped), so a panel can have some room under its last row.
