---
name: plain-talk
description: How to write text a person will read. Use before any Comms message, a message to FLIGHT, a Needs-you brief, a ticket, a PR description, a review finding or a run report.
---

# Plain talk

The operator reads a message on its own, often hours later, without the context you have.
Write so the message makes sense by itself.

## The six rules

1. **Main thing first.** The first sentence says what happened. Detail comes after, if needed.
2. **One point per message.** One question per message. One topic per paragraph. At most four
   sentences in a paragraph.
3. **Short sentences, plain words.** Keep a sentence under 20 words. Prefer the shorter word:
   "stop", not "terminate"; "turn on", not "enable"; "ask", not "escalate". Name an id the first
   time you use it: "#1027 (the check-lock ticket)", "GUIDO-1 (a server developer seat)".
4. **Facts, not feelings.** No "I think", "it seems", "unfortunately", "great news". No
   exclamation marks. No "just", "simply", "easy", "quick". Apologise once, only for your own
   mistake.
5. **A question works on its own.** Name the thing, the choice, and what happens with no answer:
   "PR 975 (the FLIGHT page) passed review and CI. Merge now, or wait for the mockup? Default:
   hold until Monday 3 November." A default is allowed only for a choice within the writer's own
   authority. An operator approval has no default.
6. **An error says what failed and what to do.** "Push of 73f0d3d refused: `pnpm -s test` was
   not run on this commit. Commit or delete any changed files, run it, then push again." Not the
   log, not the rule text.

## One message, one shape

- **Comms message (to a seat or to FLIGHT).** Order: what happened, what you did, what you need.
  Two to four sentences. Put long content (findings, a plan, evidence) in its structured tool and
  point at it. The hub allows 1,200 characters (#995); aim for 600.
- **Question to the operator.** Only FLIGHT writes these, as a brief (`brief_item`). The fields
  come from `roles/FLIGHT.md`:
  - the question, in one sentence;
  - why it is the operator's: money, direction, security, irreversible, or a floor approval;
  - an assessment in two or three sentences, and what FLIGHT did;
  - two to four options as a list, each with its cost in time or money;
  - the recommendation and its basis. No default on an approval.
- **Ticket.** Sections, in order:
  - Outcome: what is true when the work is done, measurable;
  - Why: the evidence;
  - what to change;
  - Done when: a checklist;
  - Controller check, when only the controller can produce the evidence;
  - Size; Security.
- **Review finding (RETRO, through `report_findings`).** Severity and category as `roles/RETRO.md`
  defines them, the file and line, what fails and how, the fix. One finding per entry.
- **PR description (the hub writes it from the run's report).** What (two sentences); Why (one
  paragraph); what was left out and why; Checks; Security (one line when nothing changed).
- **Run report (`report_evidence`).** Three lines: done, not done, next. Then the evidence.

Seats do not post comments on GitHub and do not message the operator; both go through FLIGHT.

## Words

| Use | Instead of |
|---|---|
| stop, end, cancel | kill, abort, terminate |
| ask, tell | escalate, surface, flag |
| turn on, turn off | enable, disable |
| might | may (when you mean "possibly") |
| to | in order to |
| lets you | allows you to |
| the hub refused the push | the push errored out |
| the test `name` failed | the suite exhibited a failure |
| Monday 3 November, 14:00 UK | tomorrow, currently, later |

More rules for words:
- Say "you" to the reader. Name yourself by your seat name ("GUIDO-1"), not "I".
- Use one name for one thing. The roles say "seat" and "developer"; do not add "builder".
- No hub state names in text for the operator ("parked", "aside", "controller check").
  Say what the state means: "waiting for a review".
- No @mentions. No links to other repositories.
- Present tense for state: "Review done", not "Review has been completed".
- Say who did what: "RETRO-CX found two problems", not "two problems were found".
- A list for options or steps; prose for one idea.

## Between agents

A message from one seat to another, or to FLIGHT, is read by a model, not a person. Use the
same rules with one change: shorter. Drop every pleasantry, every hedge and every filler word.
Keep full sentences, exact names, exact error text and the order of steps. Do not drop articles
or joining words; that can change which step comes first. Pattern: what happened, what you did,
what you need.

**Before:** "Hi FLIGHT, just wanted to let you know that I think the tests might be failing
because of the lock, could you possibly take a look when you get a chance?"
**After:** "Tests on 80001f8 wait for the test lock held by GUIDO-CX. Nothing needed; reporting
in 20 minutes."

## Before sending, check

- [ ] The first sentence says what happened.
- [ ] Someone who sees only this message can act on it.
- [ ] At most one question, and its default if a default is allowed.
- [ ] No sentence of 20 words or more. Count every word; ignore code, shas and ids.
- [ ] No paragraph over four sentences.
- [ ] No hedge, hype, exclamation mark or second apology.
- [ ] Every id is named the first time it appears.

## For a reviewer

A finding against this skill is Minor. It never holds a clean PR. Raise it to Important only when
the reader could not act on the message. That means: the main thing is missing, the question has
no choice, or an error has no next step. Quote the sentence and the rule.

## Examples from this crew

**Before (a hub message):** "the push or PR for 73f0d3d has not shown up on GitHub after 10
minutes (Not pushed: the repo's checks have not all passed on this exact commit in the seat's
clone. Commit 73f0d3d: - not run: pnpm -s test. Run each command exactly as written, alone or
joined with && (no pipe, ||, ; or extra lines), with no uncommitted or untracked files (commit
or delete scratch files), at this commit, then push again.): no push is recorded for the run"

**After:** "Push of 73f0d3d refused: `pnpm -s test` was not run on this commit. Commit or delete
any changed files. Run `pnpm -s test` on its own, with no pipe or `&&`. Then push again."

**Before (FLIGHT to the operator):** "I've answered FAO-1's questions on #1028 (verify queue),
and it's writing the plan now. The three builders are still held up by the push gate, and I'm
waiting on the controller to check the test records and push. Nothing new since my last update,
and nothing needs a decision from you."

**After:** "No decision needed. FAO-1 (the planner) is writing the plan for #1028, the verify
queue. Three developer seats cannot push until the controller checks their test records."

**Before (a question):** "Would you like to merge PR 975 now?"

**After:** "PR 975 (the FLIGHT page) passed review and CI. Merge now, or wait for the mockup?
Default: hold until Monday 3 November."

## Sources

Google's People + AI Guidebook; Google's conversation design guidance; the Google developer
documentation style guide; Material Design's writing and notification rules. Collected 29
October 2026. Google allows 26 words a sentence; this crew uses 20 because a card shows less.
