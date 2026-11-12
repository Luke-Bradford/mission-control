# Token audit: where the crew's tokens go, and what Mission Control needs

**Date:** 6 November 2026. **Written by:** the controller, at the operator's request. **Status:**
findings and proposals. Nothing here is built. Estimates are marked as estimates.

The operator asked what is using the tokens and how to fix it at the root. The aim is more agents,
running for longer.

**Terms.** The CLI is Claude Code's command-line tool, which runs each agent. The cache holds a
session's earlier context. A model call re-reads it at a tenth of the price of new text.
Audit is the hub page that lists things to improve.

## The short answer

- **Almost all spend is agents re-reading their own context.** Every step a model takes, it reads
  everything already in its session. Writing output is a tenth to just over a quarter of the cost.
- **Sessions only grow.** No run's context dropped by more than 5,000 tokens in the transcripts
  measured.
- **Four things account for most of it.** Developer runs keep one session through build, fixes
  and rework. FLIGHT starts every session at 106,000 tokens. The reviewer starts from nothing on
  every round. Controller sessions run for days.
- **Some of it is pure waste** and can go today with no loss. The rest needs a trial with a
  measure, because it changes how agents work.

## How spend works

One rule explains every finding below:

> cost = the sum, over every model call, of the context size at that call, at that model's price.

So there are three levers: fewer calls, a smaller context at each call, and a cheaper model for
the call. A token added early in a run is paid for again at every later step.

## Where it goes

**The crew, seven days to 6 November, from the hub's own figures.** 189 pull requests merged.

| Role | Model | Runs | Cost | Share |
|---|---|---|---|---|
| FLIGHT (head agent) | Opus | 111 | $415 | 38% |
| Reviewer (RETRO-1) | Opus | 278 | $317 | 29% |
| Three developers | Sonnet | 117 | $330 | 30% |
| Planner (FAO-1) | Opus | 11 | $41 | 4% |
| **Crew total** | | | **$1,103** | $5.84 a merged PR |

**Controller sessions are outside that table.** The controller is a Claude Code session on this
Mac that helps run the repo. This report came from one. Counted by message time over the
same seven days, each message once:

| | Model calls | Context re-read |
|---|---|---|
| Controller: 7 main sessions and 67 helper sessions | 4,692 | 1,467 million tokens |
| The whole crew (hub figure) | | 2,706 million tokens |

So controller sessions re-read about half as much as the crew. One session made 904 million of
it, at up to 967,000 tokens of context. The hub does not record controller use, so no page shows
it.

**By kind of token** (recent crew transcripts, the CLI's own counts, usual price ratios):

| Role | Re-reading context | Writing context to cache | Output |
|---|---|---|---|
| Developers | 68% | 19% | 13% |
| FLIGHT | 57% | 33% | 10% |
| Reviewer | 43% | 29% | 28% |

## The holes, roughly by size

### 1. Controller sessions run for days at up to a million tokens

- **Evidence:** above. One session made 1,682 calls in the seven days, at up to 967,000 tokens
  each. That one session re-read more than any crew seat: the largest, FLIGHT, re-read 836 million in
  the same seven days.
- **Why:** one session is kept open across many tasks, so every tool result stays in it.
- **Fix:** a new session per task, started from the saved notes. The hub does not run the
  controller, so its own instructions set the cap. It hands over at about 150,000 tokens, as
  FLIGHT does. Gathering goes to short-lived helpers whose context is thrown away. #1504 lets the hub
  record controller use, off by default.
- **Information risk:** none, if the handover notes are written.

### 2. A developer keeps one session from first line to merge

- **Evidence:** 98 developer runs. Median 80 model calls a run. Context at each call: median
  121,000 tokens, and 317,000 at the 90th percentile. The last third of a run is 48% of its
  re-reading.
- **62% of the context a developer reads or writes to cache comes after its first report.** By then the run
  is fixing CI, reworking or waiting. A run reports a median of 4 times, and 9 at the 90th percentile. Each fix is made on a
  context already full from the build.
- **Fix:** work in phases, each in a fresh session: build, then each fix. The hub already writes a
  handoff (goal, done, left, next). A fix would start at about 30,000 tokens, not 120,000 or more.
- **Information risk:** real. A fresh session must find its place again. So this is a trial: ten
  tickets each way, comparing tokens, rework rounds and CI failures.
- **Size, as an estimate:** a quarter to a third of developer spend.

### 3. What developers carry is mostly shell output

Of everything developers re-read, split by character share among the results that arrived
between two calls: shell output 56%, the start of the run 17%, their own earlier
output 10%, file reads 4%. Inside shell output:

| Command | Calls | Share of shell re-reading | Average tokens added |
|---|---|---|---|
| `sed` (reading parts of files) | 1,801 | 33% | 1,820 |
| `grep` | 1,627 | 20% | 1,193 |
| `python3` one-liners | 1,474 | 14% | 928 |
| `cat` | 334 | 9% | 2,507 |
| `pnpm lint` | 464 | 9% | 2,800 to 5,500 |
| Tests | 625 | 6% | 730 to 3,550 |

- **Lint is pure waste.** In two days, 299 lint calls printed a median of 16,196 characters. 257
  had no error. On main today it prints 20,671 characters: 68 standing warnings and 7 notes. The
  table counts more lint calls because it includes every seat and chained commands.
- **Fix for lint:** clear the 68 warnings once, or print errors only. A pass then prints one line.
- **Fix for checks in general:** the hub runs a check and returns "passed", or only the failures,
  with the full log by id on request.
- **Fix for reading:** the planner's plan names the files and line ranges, so the developer reads
  less. A cheaper reader can do the search and hand back a short map (see "A scout").
- **Information risk:** none for lint and passing checks. Low for the rest, because the full text
  stays one call away.

### 4. FLIGHT starts every session at 106,000 tokens

- **Evidence:** 251 wakes and 59 sessions in 24 hours, so 4.3 wakes a session. The first call of
  a session is about 117,000 tokens. FLIGHT moves to a fresh session past 150,000 tokens, after 40 wakes, or when its tools
  change. By the hub's run table, its sessions rose from 5 a day on 29 October to 39 on
  5 November. The 59 above counts the 24 hours to midday on 6 November. The cause is not yet known.
- **So FLIGHT has about 44,000 tokens of working room**, and pays to write about 95,000 tokens to
  cache 59 times a day, on Opus. Every call re-reads at least 106,000.
- **The hub's own figure agrees.** Since 22 October, starting sessions cost $357 of FLIGHT's $701,
  which is 51%.
- **FLIGHT's wakes are not idle.** The hub counts a wake as idle when no decision follows within
  four minutes. That was 14 of 251. So the cost is in how a session starts, not in needless wakes.
- **What the 106,000 is:** the hub's opening brief is 46,000 (a digest of 27,600, the role, orders,
  the repo's direction text and lessons). The other 60,000 is fixed set-up: the system prompt, the definitions of
  FLIGHT's tools, and the repo's instructions. That part was not measured piece by piece.
- **Each later wake adds about 10,700 tokens.** About 1,000 of that is the repo's direction text
  (`docs/direction.md`), the same every time.
- **Fix:** FLIGHT's state lives in the hub, not in its context. Each wake gets a brief built for
  that wake's reason: what changed, and what it needs to decide. The standing text is sent once.
  The tool list is cut to what the wake needs.
- **Information risk:** real, and the main design question. FLIGHT must be able to fetch what the
  brief leaves out. A trial compares its decisions against today's on the same wakes.
- **Size, as an estimate:** half of FLIGHT's spend or more, if the floor falls to about 30,000.

### 5. The reviewer starts from nothing on every round

- **Evidence:** 278 review runs on 105 tickets in seven days, so 2.6 a ticket. Each is a fresh
  Opus run. The hub records about 94,000 tokens of tool results in a review run.
- **Fix:** a second round reviews what changed since the reviewed commit, plus the open findings.
  A cheaper model or hub code gathers the diff, the test run and the files, and hands Opus a
  digest.
- **Information risk:** a change outside the diff could be missed. The first round stays a full
  review. Trial as for hole 2, comparing findings and bugs that escape.
- **Size, as an estimate:** about 40% of reviewer spend.

### 6. Waiting past the cache's life rewrites the whole session

- **Evidence:** 64 times, a call wrote more than 20,000 tokens while reading under half of its
  context from cache. 13.5 million tokens were rewritten, 28% of all cache writes.
- **Why:** a pause long enough for the cache to expire, such as waiting for CI or the test lock.
  The next step pays to write the session again.
- **Fix:** a seat that must wait ends its run and starts fresh from the handoff. This is hole 2's
  fix, so they are one piece of work.
- **Information risk:** none beyond hole 2.

### 7. The hub undercounts output, so Audit cannot see it

- **Evidence:** three runs checked. The hub recorded 983, 3,825 and 263 output tokens. The CLI
  reported 5,430, 59,308 and 19,066.
- **Why:** the hub sums a figure that is not final when it reads it.
- **Fix:** take output from the CLI's end-of-turn record.

### 8. Smaller items, all measured

| Item | Evidence | Fix |
|---|---|---|
| `comms_read` | 318,000 characters a day returned; the crew sent 83,000 | Read by ticket, one line a message (#1506) |
| Reviewer's report | 811,000 characters a day written, 10,000 a call | The operator decides what the QA page needs |
| Developer's report | 39% of the Done-when text repeats the report before | Send only what changed |
| Hub notices in Comms | A third of all Comms text | One line (rule 8 of the Comms design, PR 1500) |
| A seat's inbox | The hub attaches the newest 40 inbox messages, read or not, to the run's start and to each line it delivers between turns, up to 8,000 characters. Found by reading `apps/server/src/comms/index.ts:123`; not measured | Send each message once |

## Can the waste go without losing what agents need?

Yes, in two groups.

**No loss, do now:**
- lint noise and passing-check output (hole 3, #1503);
- the repeated direction text (#1469);
- `comms_read` by ticket, and notice text (#1506);
- repeated report text;
- controller session length;
- the output count (#1504).

**Needs a trial first,** because it changes how an agent works:
- fresh sessions per phase, which also covers hole 6;
- a small FLIGHT context;
- a second review round that reads only the change;
- a scout.

A trial is ten tickets each way. It compares tokens, rework rounds, CI failures, review findings,
and bugs found after merge. The operator sees the figures and decides.

## What Mission Control needs

These are the root fixes. Each one closes several holes above.

**1. A token ledger, shown in Audit.** For every run and step: the context size, what was added
and by which tool or command, how often it was re-read, and each cache rewrite. The hub already
records what it puts in each prompt. The scripts beside this report do the rest and can become
hub code. Without this, each hole comes back unseen.

**2. Context budgets the hub enforces.** A start budget for each role. A cap on any one tool
result, short first and full by id. A cap on a run's context, which ends the run with a handoff
and starts a fresh one.

**3. State in the hub, not in a session.** A session holds what one step needs. The ticket's
record, FLIGHT's memory and the handoff live in the database and are fetched by need. This is
what lets a session be short.

**4. A scout.** A short job on a small model, or plain hub code where that is enough, that
gathers and condenses before a large model reads. Three places to try it, each with its own trial:

- before a review: the diff, the test result and the files touched;
- on a CI failure: the failing test and its error;
- before a build: the files and line ranges the ticket touches.

A scout before a FLIGHT wake is not on the list. Only 14 of 251 wakes had nothing to decide.

**5. Relays in hub code.** A step with one right answer is a rule or a timed job, not a wake.
FLIGHT woke 251 times in a day, and 237 of those had a decision within four minutes. The saving is in making each
wake cheap (hole 4), more than in having fewer.

**6. Small tickets and short prompts.** A ticket sized S or M with a plan that names its files. A
role prompt that holds only what the seat cannot work out. The start of a run is 17% of what a
developer re-reads, so every line in it is paid for about 80 times.

## What Audit should check, every day

Each is a row, with the figure, the trend and the run or ticket it came from.

- Context at each call, by role: median and 90th percentile, against the budget.
- Runs whose context passed the cap.
- The ten largest sources of re-reading: tool, command or prompt section.
- Any command whose passing output is over 1,000 characters.
- Prompt text sent again unchanged.
- Cache rewrites, with the wait that caused each.
- Model calls a run, and the share after the first report.
- Review runs a ticket.
- FLIGHT: wakes, wakes with no action, context at wake, sessions a day, and the cost of starts.
- Cost for each merged PR, by role.
- Controller sessions: calls, peak context, tokens.

## Order

1. The no-loss fixes, as small tickets. Lint first: it is one change.
2. The ledger and the Audit rows, so that every later step is measured.
3. The trials, largest first: phases for developers, FLIGHT's context, the reviewer's second
   round, then the scout.
4. Budgets in hub code, set from what the trials show.

## How this was measured, and its limits

- **Cost by role:** the hub's `runs` table, seven days by run start.
- **Seat transcripts:** the hub zips them after 24 hours, and the scripts read only unzipped ones.
  So the crew figures from transcripts cover about the last 24 to 48 hours: 237 transcripts and
  11,967 model calls. Seven-day crew figures come from the hub.
- **Controller sessions:** the Claude Code session files for this repo, seven days by message
  time, each message counted once across files.
- **Context added by a source:** the growth in context between two calls, split across the
  results that arrived between them by their share of characters. **Re-reading:** that growth
  times the calls left in the run. Characters become tokens at four to one.
- **Price ratios for the split by kind:** cache read 0.1, cache write 1.25, output 5, against
  fresh input. Output comes from the CLI's end-of-turn records. Dollar figures come from the hub.
- **Not measured:** the Codex seats; hidden reasoning text; the split of FLIGHT's fixed 60,000.
- **The scripts** are in `token-audit-scripts/`. None writes, deletes or sends anything.
  `token_audit.py`, `token_growth.py`, `true_output.py` and `controller_sessions.py` take a folder
  and a number of days. The others take a folder and use the window written at their top.
  `lint_sample.py` and `evidence_repeat.py` print a short sample of transcript text.
