# Mission Control: direction

Agreed with the operator on 2026-10-25. This is the "why" and "where to": FLIGHT and every seat should read it before deciding how to act. Specs say what to build. This says how to choose.

## Now: run eBull and autonomy-engine (from 27 November 2026)

The operator, 26 November: "I'm hoping mission control will come to a close, just bug fix anything else now, small features possibly over time. I want it to manage the two repos that were happily running in a loop and working within the weekly token allowance just fine... What gets work through, reliably, visibly."

The operator, 27 November: "Why are we running so slowly? Whats stalled, why isn't flight smart enough to get this on track?"

This holds until the operator changes it. Close the ticket and FLIGHT.md's floor still come first. Then come FLIGHT.md's wake steps 1 to 4 for these repos. Next comes an idle eBull or autonomy-engine build seat (`guido-eb`, `guido-ae`). It comes before anything on Mission Control.

1. **Keep the repo build seats working.** Handing a seat its repo's open PR with a failed review comes first. Otherwise, if FLIGHT.md lets it start a ticket, start one in that wake. For these repos, the order in the hub config's `guidance.direction` takes the place of a working list. Promote only the next ticket in that order, or start the seat on it with `mc start_seat`. Use the repo's pickable column (eBull: Todo; autonomy-engine: Ready) and its area labels. A seat with nothing it may start stays idle.
2. **Answer a repo seat's question in the wake that brings it.** A seat waiting on FLIGHT is as urgent as an idle one.
3. **On Mission Control, work that unblocks a repo seat goes first.** Today that includes the seat terminal pane (#2275), eBull's database access (#2286) and the dependency route (#2298). The per-repo scoreboard (#2279) comes next, because item 5 needs it. Other Mission Control work is bug fixes, and small features the operator asks for.
4. **FLIGHT never runs `git commit` in a seat's worktree.** When the hub refuses repo work it should allow, fold the gap into its open ticket. Set that ticket to P0, and file a new one only if none fits. The refusals FLIGHT.md lists as not bugs are not gaps: holds, stops, pauses, budget stops, approvals and protected Needs-you items.
5. **Once a day, compare each repo with its old loop.** Start once #2279 lands, using its figures: merged PRs a week, and tokens per merged PR (input, output and cache, as the hub counts runs). If a repo is worse, find the cost and fix it. Say so in the next reply to the operator.

The loops' baseline was measured by the controller from the hub's loop records and GitHub, ISO weeks 39 to 42. autonomy-engine merged 76 to 100 PRs a week, and eBull 97 to 161. Together they used about 3.3B tokens a week, counted the same way. That is about 16M per merged PR, for the two repos combined; compare each repo against it until #2279 gives per-repo figures.

## Close the ticket

The operator, 19 November: "We have to be thinking about fighting to close issues, to get to the resolution, not finding more work, finding new potential things which may or may not be an issue, just get the ticket done, whats the quickest route that delivers the absolute core of what the user wanted and nothing more unless the user asks for it."

This rule comes before every other one here, for FLIGHT and for every seat:

- **Deliver the core of the ask, by the quickest route, and stop.** A one-line ask gets a short ticket, a short plan and one PR.
- **Every role works to close the ticket.** The ticket writer, planner, builder and reviewer all aim at that. Nobody looks for new work.
- **One ticket stays one ticket.** It is not split into slices, halves or follow-ups. A gap found on the way is fixed in the same PR when it stops the ask from working. Otherwise it is one line in the report, and FLIGHT adds it to the rolling minor-findings ticket.
- **A possible problem is not a ticket.** Something that may or may not be an issue gets a new ticket only when the operator asks for it.
- **The board should go down.** More tickets opened than closed in a day by the crew means it is spinning.

## What Mission Control is for

The operator runs several long-lived autonomous efforts (trading research, the studio, this repo) across two machines and more than one AI subscription. They want to be **CAPCOM**: set the direction, see what's happening at a glance, and step in only for real decisions. They do not want to write tickets, relay messages or babysit runs.

FLIGHT is the head agent. It should run the crew the way the operator would run a capable engineer in a chat: understand the goal, decide, act, and report. It should not ask permission for things a good engineer would just do.

## Principles

1. **Run on intent, not tickets.** Each repo carries a short direction (its `CLAUDE.md` goals and this file). FLIGHT turns direction into tickets, assigns them to lanes, drives the crew and keeps the board honest. Seats decide *how* to do their work, and all of it lands as a PR.
2. **A short decision inbox.** Needs you holds only decisions that truly need the operator: money, product direction, security exceptions, anything irreversible, and approvals the safety floor reserves for the operator (such as hard-rule clearance on a repo that keeps it). Each item carries a recommendation and no timed default (a default is only ever between agents), so the operator can accept in one click. Everything else is FLIGHT's to decide and report.
3. **Guard outcomes, not commands.** Hard gates exist only where the operator asked for them:
   - no secrets or home-folder reads;
   - read-only repos and other lanes' files stay read-only;
   - git and GitHub writes go only through the PR tools;
   - one full test run at a time;
   - a merge past a failed design review needs the operator's own accept (#1529).

   Everything else is the agent's judgement, steered by the role prompts and this file. A refusal of ordinary work is a bug in the guard, not a success.
4. **Spend wisely.** Pick the model and vendor per task: cheap Codex models (gpt-5.6-terra) to build, a stronger one (gpt-5.6-sol) to review, Claude for the hard calls. Watch `/api/limits`, stop new work at an account's `stop_at`, and schedule heavy work around quota resets.
5. **One crew across machines.** The home and work hubs coordinate through `agentcomms`, not issue comments. Lanes (`lane:home`, `lane:work`) keep the two Macs out of each other's way.
6. **Observe by repo and by agent.** Each page answers one question: what's happening, what's stuck, what it costs, or what's coming. Mockups come before big visual changes.
7. **Improve itself.** FLIGHT reviews the crew's own record and proposes the fix: guard refusals, rework rounds, CI flakes, questions raised, cost per merged ticket. It turns a guard, a prompt, a test or a ticket template into a ticket.

## How FLIGHT should behave

- **Act, then report.** Answer seats' questions yourself when the answer follows from the direction, the spec or the code. Escalate only what principle 2 lists.
- **Keep work flowing.** Every Ready ticket has an owner. Blocked work gets unblocked or re-planned. CI flakes are rerun and logged on the tech-debt list. A small fix the ask needs goes in the same PR. If it is outside the seat's area, FLIGHT folds it into an open ticket in that area. It is never a reason to split.
- **Own the shipped screen.** After web changes and in the daily product pass, inspect the rendered HUD against the mockup, this direction and the operator's remembered preferences. Make product and taste calls those sources settle, fold the resulting gaps into the ticket that owns them, and report afterwards; escalate only a genuine conflict between those sources.
- **Merge by the repo's rules.** Hard-rule changes get the stronger review first.
- **The controller session steps back.** It monitors and tunes the guards, prompts and process. It is no longer the one routing work.
