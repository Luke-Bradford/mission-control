---
name: plain-talk
description: How to write anything a person will read: a Comms message, a message to FLIGHT or CAPCOM, a Needs-you brief, a PR description or comment, a ticket, a report. Use before sending or writing any of those.
---

# Plain talk

The operator reads this on its own, often hours later, often on a phone-sized card, without
the context you have. Write so it makes sense by itself.

## The six rules

1. **Say the main thing first.** First sentence: what happened or what you need. Reasons and
   detail come after, if at all.
2. **One message, one point.** One question per message. One topic per paragraph. A paragraph is
   at most four sentences.
3. **Short sentences, everyday words.** Under 20 words a sentence. If a simpler word says the same
   thing, use it: "stop", not "terminate"; "turn on", not "enable"; "ask", not "escalate".
   Define a code word or number the first time you use it ("#1027, the check-lock ticket").
4. **Facts, not feelings.** No "I think", "it seems", "unfortunately", "great news". No
   exclamation marks. No "just", "simply", "easy", "quick". No apology unless you made the
   mistake, and then once. Say what is true and what you will do.
5. **A question stands alone.** It names the thing, the choice, and what happens if nobody
   answers: "PR 975 is clean. Merge it now, or hold it until the FLIGHT page mockup is approved?
   If no answer by Friday, I merge." The reader should not need to open anything to answer.
6. **An error says what failed and what next.** "The push of 73f0d3d was refused: the test suite
   was not run on it. Run `pnpm -s test`, then push again." Not the whole log, not the rule's
   wording, not a dozen ways to fix it.

## Shape by kind

- **Comms message (to a seat, FLIGHT, CAPCOM):** 1–4 sentences. Main thing first. One ask at the
  end if there is one. Under 600 characters. Long content (findings, a plan, evidence) goes to its
  structured tool; the message points at it: "RETRO found 3 blocking issues on PR 984; see the
  findings."
- **Question to the operator (Needs-you brief):** the question in one sentence; why it is theirs
  (money, direction, security, irreversible); two to four options with what each costs; your
  recommendation; the default and when it applies. Nothing else.
- **PR description:** What (two sentences), Why (one paragraph), what you did not do and why,
  Checks, Security (one line when nothing changed). A reader with no context can decide to merge.
- **PR or review comment:** the finding, the file and line, the fix. One per comment.
- **Ticket:** Outcome (what is true when it is done, measurable), Why (the evidence), Done when
  (a checklist), Size, Security. No mechanism unless the mechanism is the point.
- **Report at the end of a run:** three lines: done, not done, next. Then evidence links.

## Words

| Write | Not |
|---|---|
| stop, end, cancel | kill, abort, terminate |
| ask, tell | escalate, surface, flag up |
| turn on, turn off | enable, disable |
| might (possibility) | may (permission) |
| to | in order to |
| lets you | allows you to |
| the hub refused | the hub threw an error |
| the test failed: `name` | the suite exhibited a failure |
| now, today, Thursday | currently, at this time, tomorrow (which day?) |

Use "you" for the reader and name yourself by call sign, not "I think". Present tense for
state: "Review done", not "Review has been completed". Active voice: say who did what.

## Before sending, check

- [ ] First sentence carries the point.
- [ ] A reader who sees only this message understands it.
- [ ] One question at most, with its default.
- [ ] No sentence over 20 words; no paragraph over four sentences.
- [ ] No hedging, hype, apology loop or exclamation mark.
- [ ] Every id (#, PR, sha, seat) is named with what it is the first time.

## Examples from this crew

**Before:** "the push or PR for 73f0d3d has not shown up on GitHub after 10 minutes (Not pushed:
the repo's checks have not all passed on this exact commit in the seat's clone. Commit 73f0d3d:
- not run: pnpm -s test. Run each command exactly as written, alone or joined with && (no pipe,
||, ; or extra lines), with no uncommitted or untracked files (commit or delete scratch files),
at this commit, then push again.): no push is recorded for the run"
**After:** "Push of 73f0d3d refused: `pnpm -s test` was not run on it. Run it on a clean tree,
then push again."

**Before:** "I've answered FAO-1's questions on #1028 (verify queue), and it's writing the plan
now. The three builders are still held up by the push gate, and I'm waiting on the controller
to check the test records and push. Nothing new since my last update, and nothing needs a
decision from you."
**After:** "Nothing needs you. FAO-1 is writing the #1028 plan. Three builders wait on the push
gate; the controller is on it."

**Before:** "Would you like to merge PR 975 now?"
**After:** "PR 975 (FLIGHT page v2) is clean. Merge now, or wait for the design mockup? Default:
merge Friday."

## Where this comes from

Google's People + AI Guidebook (explainability, errors, mental models), Google's conversation
design guidance (one question at a time, no apology loops, front-load key information), the
Google developer documentation style guide (most important first, under 26 words a sentence,
plain words, the word list), Material Design writing guidance (neutral consequences, no
exclamation marks, present tense, scannable segments) and Material's notification rules (the
reader may see it a day later; name the day). Collected 29 October 2026.
