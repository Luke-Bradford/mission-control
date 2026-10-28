# Mission Control HUD: operator workflow and information architecture review

Build: `mc-wt/ui` at `10d5d19e` (feature/677). Preview at :5199 over hub :7431 (DB copy, crew paused, `MC_NO_CREW=1`). Screenshots are in this folder (`home`, `flight*`, `board`, `agent`, `comms*`, `telemetry`, `setup`, `item-*`). Live data: `attention.json`, `flight.json`. Read-only: nothing in the repo was changed.

## Headline findings

1. **There are five Needs-you numbers, and none of them agree.** The header says **13** and claims to open "everything waiting on you (on Comms)". Comms then shows **"Decisions · 1 for you"**. The dock says **"Waiting on you · 5"**. Command's Clear now says **"13 need you · 15 in this list"**. FLIGHT's own message in the dock says **"The only thing waiting on you is still PR 551."** The full list is only at FLIGHT › Plan › Operator actions, a lower-left panel three clicks deep. (`Header.tsx:265-289`, `Decisions.tsx:105`, `conversation.ts:38`, `ControlQueue.tsx:47-53`.) Comms has a `NeedsList` for the old route, but it can no longer be reached: `route()` always gives `/comms` a `view`, so `Comms.tsx:111-128` never renders.
2. **Of the 13 items, about 9 are noise or FLIGHT's to settle.** The noise comes from three mechanical sources: unread agent narration counted as "messages", a duplicate of every seat question, and a regex bug that sends hard-rule flags to the operator even though the repo's setting gives them to FLIGHT. Details are in §2.
3. **Almost nothing FLIGHT does appears anywhere on screen.** The store holds 638 FLIGHT decisions (69 promotes, 52 starts, 16 answers, 130 "For the controller" missing-power requests, settles, unparks and tickets). Record › "Decided without you" shows only `answer` decisions from the last 24 hours (`Decided.tsx:88`, `FLIGHT_VIEW_MS`). The System log leaves out every decision and points to Decided (`WorkingLog.tsx` doc comment). The dock leaves them out too and points to the log (`Dock.tsx:40`). The three comments point at each other, and the real decisions fall through all of them. With FLIGHT quiet for 2.5 days, Record is empty.
4. **The FLIGHT page is a board dashboard with FLIGHT's name on it.** Command is seven metrics, a two-row delivery table and a roll-up. FLIGHT's own voice is one headline that is 61 hours old. The page never says that the crew is paused or that FLIGHT is held. Overview shows "FLIGHT · Held 2d 13h", while `/api/flight` says `live: true, state: idle`.
5. **The requirement that FLIGHT can use all skills and other agents is blocked at the runtime level.** `Task`, `WebFetch` and `WebSearch` are in `DENIED_TOOLS` for every seat, FLIGHT included (`packages/core/src/runtime.ts:387-410`). Repo skills and agents reach a seat only as a list of reference files (`runtime/brief.ts:330-400`). `AGENTS.md` is never read; only `CLAUDE.md` is.
6. **FLIGHT cannot save per-agent standing instructions.** The nearest pieces are a selector-only `focus` (lane, label or ticket), whose API exists but which no UI or FLIGHT tool uses (`focus.ts`, `api.ts:2330`, `data.ts:55`), Notebook prose that seats never see, and `message_seat`, which is gone once sent.

---

## 1. Operator questions: where each is answered today

Times assume the hub is warm. A "click" is a navigation or tab change.

| Question | Where it is answered today | Clicks / time | What's missing or duplicated |
|---|---|---|---|
| **What's in progress?** | Overview: Crew table (10 rows), "In flight 6" KPI, Pipeline (Ready 2 / In progress 2 / In review 4), Live log, Timeline. FLIGHT Command: WIP **2** and a 2-row Delivery board. Board: In progress **15**. Overview crew header: "**0 working**". | 0 (Overview is home), about 10 s to scan. Reconciling the numbers is not possible. | Four different counts (0 / 2 / 6 / 15) with four definitions (live runs, crew runs, In progress plus review, project Status across three repos). The observed loops (ebull-ta, studio-builder) are missing from FLIGHT's Delivery board. "Crew paused" appears on Overview and Setup only, not on FLIGHT. |
| **What is FLIGHT doing, and why?** | The dock's top line (last summary, 3 days old). Dock chat. Command headline ("Synthesised 61h ago · stale · refresh due"). Last contact. Record › Decided (today's answers only). System log (wake lines only, currently 0). Notebook prose. | 1 click to FLIGHT. The "why" is not reachable: the decisions exist (`flight_decisions`, 638 rows) but are never shown. | No action feed, no FLIGHT run state (running, held, paused, next wake), and the 130 missing-power requests to the controller are invisible. The headline is flagged stale, but the page never says why (FLIGHT not woken, crew paused). Overview says "Held" and the FLIGHT API says "live". |
| **How is the board moving?** | Board (kanban, 190 Backlog). Overview Pipeline. Telemetry › Flow of work (14-day throughput, cycle time by size). FLIGHT rail: Throughput 1 and Cycle time 14h 52m. | 1 click (Board or Telemetry), 10–20 s. | No "what changed since I last looked". There is no record of what FLIGHT promoted, started or merged (decisions are hidden). The two cycle-time figures conflict: Telemetry shows ~0.1 d median per size (Ready→Done), FLIGHT shows 14h 52m (Ready→merged, 24 h), and neither says why they differ. |
| **What is each agent doing, and what is it stuck on?** | Agents page (1 click plus picking a chip): Now tile, need banner, activity, loop steps. Overview Crew row: state, work and an inline "Question for you". Comms agent threads. | 2 clicks per agent, 15–30 s each. There is no all-agents "stuck on" view. | State and reason disagree: guido-cx's state is "Review" while its Now tile says "Blocked on a genuine requirement conflict". "1162:46 in this step" prints 19 hours as mm:ss. One seat question appears in six places: Agent banner, Overview row, Needs you twice (`ask:45` and `message:guido-cx:comms:228`), #crew and the Comms agent thread. Nothing shows what FLIGHT last told the agent or what standing instructions it has. |
| **What are agents and FLIGHT saying to each other and to me?** | Comms opens on the FLIGHT↔CAPCOM thread (also shown in the dock). #crew. Per-agent threads. Comms graph. Traffic chart. Item discussions, which are separate threads per item. | 1–2 clicks. | There are three FLIGHT chat surfaces: the dock, Comms › FLIGHT↔CAPCOM, and per-item discussions. In #crew, INCO-CX's blocker (#717) and GUIDO-CX's request (#747) sit unanswered, and nothing says nobody is triaging. The controller's messages render as "You". The hub writes a canned discussion opener in FLIGHT's voice even when FLIGHT is down (`api.ts:3297-3299`). |
| **What needs me, what exactly is asked, and what are the options?** | Header "Needs you 13", which opens Comms (Decisions, 1). The full list is at FLIGHT › Plan › Operator actions. Dock "Waiting on you 5". Command Clear now shows 3 rows. Overview KPI shows 13. Board and Comms tabs carry lamps. Board cards carry "You: decide on the draft". | 3 clicks plus a scroll to reach the full list, then 1 click per item for its brief. | Five counts, as above. Briefs vary in quality. #551 is good (ask, three options with a line each, a recommendation). `ask:45` has no brief: just a 900-character technical question and a reply box. #1818's brief says "Nothing to do now… after Wed 28 Oct 02:00 close #1818", and that condition passed at 02:00 today. 3 of the 5 briefs have no `ask` and no `recommendedOptionId` (legacy shape). The Board's "You:" chip uses its own rule (`board/cards.ts:122-133`), so PR #750 on #747 shows "You: decide on the draft · waiting 19 hours" on the Board while it is not in Needs you. |

---

## 2. Needs-you audit

### 2a. Every source that creates an item

Item assembly is in `apps/server/src/hud.ts` (`attentionItems`, line 599).

| # | Source | Code | Default owner |
|---|---|---|---|
| S1 | Unread `@CAPCOM` tags in agent threads (`tag`) | `hud.ts:615-646`, `comms.ts:203` | operator |
| S2 | Unread "direct line" messages (`message`): **any transcript text a crew seat writes after the operator's last prompt to it**, FLIGHT's own wake summaries included | `hud.ts:615-646`, `comms.ts:204-227` | operator |
| S3 | GitHub escalations: `[operator-decision]`, `[loop-blocked]` or `[mvp-ready]` titles, needs-you labels | `hud.ts:649-666`; kinds `core/hud.ts:509-520`; markers `core/collectors.ts:9` | operator, or loop for `[loop-blocked]` |
| S4 | Crew rows stalled (`stalled`) or in error (`error`) | `hud.ts:669-703` | operator |
| S5 | PRs on a board ticket with no running agent, unchanged for 60 min (`pr`: decide on the draft, review or merge) | `hud.ts:716-745`; `core/hud.ts:417-432` | operator, or `lane:<login>` for another login's draft |
| S6 | GitHub notification threads (`person`) | `hud.ts:748-764` | operator |
| S7 | Stray files outside a seat's area (`stray`) | `hud.ts:924-949` | operator |
| S8 | Seat `ask_operator` questions (`question`) | `hud.ts:951-963`; raised at `mcp/tools.ts:1699-1720`, which **also** writes a comms line to CAPCOM and so produces S2 as well | operator |
| S9 | Engine notes (`blocked / flag / ready / review / ratelimit / question`) | listed in `hud.ts:966-988`; owner from `noteOwner` `hud.ts:865-895` | mostly operator |
| S9a | Loop notes: flake flag, parked→blocked, head moved, ready (5 variants), review, hard-rules flag, rate limit, no-sha delete | `core/loop.ts:667, 953-1056` | |
| S9b | Evidence missing after a reminder (flag) | `engine/engine.ts:479` | |
| S9c | Hard rules unset (blocked) | `engine/engine.ts:545` | |
| S9d | Minor-issue filing failed (flag) | `engine/engine.ts:1230` | |
| S9e | Local branch not deleted (blocked) | `engine/engine.ts:1282` | controller |
| S9f | Ticket with two area labels; take failed; foreign branch; take stuck (question) | `engine/queue.ts:204, 547, 603, 627` | |
| S9g | Worktree not removed (blocked) | `runtime/supervisor.ts:1860, 3513` | controller |
| S9h | Run ended without a report (flag) | `runtime/no-report.ts:55` | controller |
| S9i | claude CLI smoke test or upgrade failed (blocked) | `scheduler.ts:833, 851` | |
| S9j | Hub update held (blocked) | `update.ts:116` | |
| S9k | FLIGHT could not be kept running (blocked) | `flight/watch.ts:193` | |
| S10 | Crew errors (`error`) | `hud.ts:990-1001` | operator |
| S11 | Test lock held by a stalled run with seats waiting (`lock`) | `hud.ts:1003-1018` | operator |
| S12 | Triage routing: operator items become FLIGHT's for 20 minutes while FLIGHT is live, then "missed" and back to the operator | `hud.ts:768-806`; `FLIGHT_TRIAGE_WAIT_MS` `core/flight.ts:916` | |

There is also a hidden lane. FLIGHT's `log_decision` "For the controller:" notes have been used **130 times**. They wait on a human-run controller session and are not shown on any page.

History in the preview DB: 793 engine notes raised in total (602 flags, 113 blocked, 58 ready, 16 review, 4 question). 45 seat questions, of which FLIGHT answered 44 and passed 2.

### 2b. Live in the preview (15 items; 13 counted as Needs you)

| Key | Kind | What it is | FLIGHT could resolve under direction.md? |
|---|---|---|---|
| `esc:autonomy-engine#1818` | decision | The operator's own "studio loop paused until Wed 28 Oct 02:00" sentinel | **Not a decision.** It is the operator's own timer, and it fell due at 02:00 today. It should be a hold that comes back at its condition with a fresh brief ("resume now?"). The current brief still says "nothing to do now". |
| `esc:autonomy-engine#410` | question | Studio cutover, operator-gated | Operator (product direction). FLIGHT recommends "leave it parked until the MVP is proven", so it should be **held**, not an open ask. |
| `esc:autonomy-engine#450` | question | utcNow() handshake design (observed loop) | Operator, because the loop is observed and read-only. A good brief: it recommends G. It has no default or deadline. |
| `ask:45` | question | GUIDO-CX: test lock against broad Bash | **FLIGHT.** direction.md principle 3 ("guard outcomes, not commands… a refusal of ordinary work is a bug") and the ticket's own outcome (#698 "guard by outcome") answer it: accept literal-command detection for this ticket and file the OS-launcher follow-up. Untriaged ("missed") because FLIGHT was not woken. |
| `message:guido-cx:comms:228` | message | **Duplicate of `ask:45`** (ask_operator writes a comms line too) | Noise |
| `note:blocked:inco-cx:…` | blocked | #717 parked: "stopped after 3 carry-on resumes without reporting". INCO-CX's #crew post says it needs a server API first | **FLIGHT**: re-plan the dependency, then `end_run`, `settle_park` or file the server half. |
| `note:flag:guido-cx:…:hard-rules` ×2 | flag | #698 and #747 touch hard-rule files | **FLIGHT**: the repo setting is `hard_rules_by:mission-control = flight`. It reaches the operator only because of a bug (below). |
| `pr:eBull#3756` | pr | A 12-day-old draft in the observed TA loop's repo | **Not actionable now.** FLIGHT admits it hasn't seen the diff. It belongs in a weekly "stale drafts" digest. |
| `pr:mission-control#551` | pr | #487 draft, green CI, hard-rule files | **Arguably FLIGHT.** Taking a draft to review is reversible and within the operator's standing go-ahead (CLAUDE.local.md). FLIGHT has no "ready for review" power, so this is a missing-power ask (`merge_pr` covers only `awaiting-flight`). |
| `message:guido-2` ("4 new on your direct line") | message | A paused seat's narration | Noise |
| `message:inco-cx` ("12 new…") | message | Seat narration | Noise |
| `message:flight-1` | message | **FLIGHT's wake summary saying "nothing needs you", counted as a Needs-you item** | Noise |
| `pr:mission-control#700`, `#701` | pr | `lane:ap-lukebradford` | Correctly excluded from the count, but they still appear in Clear now's "15 in this list" |

**Result: about 2 of the 13 truly need the operator (#450, and #1818 as "resume?"). One is a deferral that should be held (#410), one would disappear with a missing power (#551), 4 are FLIGHT's (ask:45, #717, the two flags) and 5 are noise (4 message items and the stale eBull draft).**

**Bug: the hard-rule flag regex.** `isHardRulesFlagKey = /^flag:[^:]+:hard-rules:/` (`packages/core/src/loop.ts:190`). Real run ids contain a colon (`guido-cx:20261026T214858Z`), so `flag:guido-cx:20261026T214858Z:hard-rules:…` never matches. I checked this with node: `false` for the real key, `true` for `flag:run1:hard-rules:…`. As a result, `noteOwner` (`hud.ts:865-895`) never routes a hard-rule flag to FLIGHT or the controller, whatever `hard_rules_by` says. Every hard-rule PR becomes an operator item, and 602 flags have been raised historically.

### 2c. What a good escalation brief must contain

`AttentionBrief` (`packages/core/src/types.ts:1003-1019`) already has `ask`, `assessment`, `did`, `checked`, `options{label,answer,description?}`, `recommendedOptionId`, `recommendation` and `basis`. It needs these additions:

1. **Ask**: one question, required for any operator item (enforced by the hub, not the prompt).
2. **Why you**: the direction.md category (money, product, security exception, irreversible, floor or approval). If FLIGHT can't name one, the hub refuses `for: "operator"`.
3. **Context**: 2–3 sentences, plus what FLIGHT checked and **whom it consulted** (seat, skill, subagent), as structured refs.
4. **Options**: 2–4, each with its **consequence**, whether it is **reversible**, and **cost or effort**. `description` is optional today; make consequence required.
5. **Recommendation**: an option id and one line of why.
6. **Default and deadline**: "If you don't answer by T, I will do X", or "nothing happens; it stays held until Y". This is not in the type. The Comms decision card has a countdown, but it shows the triage window, not a decision default.
7. **Cost of delay**: what stalls while it waits (seats or tickets blocked).
8. **Discuss**: the per-item discussion (exists). Mark hub-written openers as hub text, not FLIGHT's.
9. **Freshness**: the brief's age compared with the item's last change. Flag the brief stale when the item or its condition has changed since (as #1818 shows, that case is real).

### 2d. Proposed rule set that minimises Needs you

1. **One channel up.** Seats ask FLIGHT, not the operator. The spec (§5, mc tools) says "ask the operator (FLIGHT only; carries the structured brief)"; the code gives `ask_operator` to writer and read-only seats (`core/runtime.ts:83-102`). Rename it `ask_flight` for seats. Only FLIGHT's `brief_item {for: operator}` creates an operator item.
2. **No brief, no item.** An operator-owned item is counted only once it carries a valid brief (2c). Untriaged items live in a **"FLIGHT backlog"** state. If FLIGHT is down or misses the window, show **one** item: "FLIGHT is not triaging: N items waiting since T. [Start FLIGHT] [Show them]". That replaces N raw items.
3. **Messages are not needs.** Drop `message` from Needs you entirely; unread counts belong on Comms threads. Keep `tag` only when the text is a question addressed to `@CAPCOM` from FLIGHT. Never count FLIGHT's own summaries. Remove the `ask` and comms duplication.
4. **Ownership from config, not from code defaults.** Hard-rule flags and ready notes go to `hard_rules_by` (fix the regex). Stalls, parks, blocked runs, take failures, two-area tickets, no-report and evidence flags go to FLIGHT. Housekeeping (worktree, branch, CLI, hub-update held) goes to the controller, or becomes one aggregated "machine health" line. PRs from crew runs go to FLIGHT. The operator keeps escalations from observed loops, approvals and floor decisions.
5. **Defer means hold.** A brief whose recommendation is "nothing now" must be filed as a hold with a condition (the hold mechanism exists: `attention-holds.ts`, `/attention/:key/hold`). Time-conditioned items (#1818) come back automatically at their condition with a refreshed brief.
6. **Defaults act.** For reversible choices within standing authority, FLIGHT posts "I will do X at T unless you object". It appears in Needs you as an **FYI with a countdown**, not counted as an ask, and FLIGHT executes at T. Irreversible, money, product and security asks never default to action.
7. **Batch the slow ones.** Items with no cost of delay (stale drafts, cutover decisions) go to a daily digest card, not live Needs you or notifications.
8. **Notifications follow ownership.** `local-notifications.ts:63-90` notifies stalls, PRs and blocked runs to the operator by default. Notify only briefed operator asks, plus "FLIGHT is down".

Under these rules the 13 live items would be **2 asks** (#450, #1818 resume) plus **1 FYI** (#551, if FLIGHT gets a ready-for-review power, or an ask if not), with #410 held.

---

## 3. FLIGHT page: a redesign proposal

### What's wrong, from the operator's seat

- The tab names (Command, Plan, Notebook, Record) follow FLIGHT's internal stores, not the operator's questions. The operator asked to "see what FLIGHT is doing and how it's managing the board, things it's aware of".
- On Command, the screen's strongest element is a 61-hour-old headline. Nothing says FLIGHT is held or the crew is paused. Nothing shows what FLIGHT did. The 7-metric rail repeats Overview and Telemetry.
- On Plan, the operator's asks sit in a lower-left panel beside empty Drafts, a 4-day-old Arrivals entry and empty Revisit triggers. The planning board has 2 rows.
- The Notebook is prose FLIGHT wrote for itself ("STANDING (10-24 ~01:15)…", tool lists), 4–5 days old. Durable knowledge defaults to the **eBull** repo, which has no notes, while FLIGHT's session is mission-control.
- On Record, "Decided without you" means "answers today". Everything else FLIGHT did is unreachable.
- The dock repeats the page on the page itself: the dock chat, "Waiting on you · 5" and the headline are all shown next to Command's own headline and Last contact.

### Proposed structure: four tabs named for the operator's questions, under a fixed status strip

**Status strip (always visible, one line, replaces the Situation panel):**
`FLIGHT ● running | held since 25 Oct 22:09 (crew paused by you) | down: <reason>` · `last wake 22:09 — woke on: question from INCO-CX` · `next: on event / 03:00 retrospective` · `Needs you 2 · FLIGHT handling 4 · decided 24h 31` · headline with its age (stale over 60 min). The three counters link to tabs 1, 2 and 3.

**1. Needs you** (the default when the count is above 0; replaces Plan › Operator actions, Comms › Decisions and the dock's "Waiting on you")
- The single canonical list. The header's Needs-you button opens this tab, not Comms.
- One full brief card per ask, open without a click: question, why you, context, options with consequences, recommendation, **Accept recommendation** as the primary button, default and deadline countdown, Discuss inline (the item discussion, which already exists), Hold with a condition.
- Below the asks: "**FLIGHT will do unless you object**" (FYI countdowns), "**FLIGHT is handling**" (items and assessments, collapsed), "**Held**" (with conditions) and "**Waiting on others**" (controller, lane, loop). The others are shown so the operator can see why something isn't theirs.
- Draft replies appear here only when a draft exists.

**2. What FLIGHT did** (replaces Record, Arrivals and the System log; this is the "doing and why" tab)
- A feed grouped by wake: "22:09 · woke on: INCO-CX question, CI red on #689", then each action as one line with an icon by kind (answered, started, promoted, merged, settled, filed, messaged, set instruction, consulted), refs, a one-line basis and **Overturn** where it applies.
- Filters: kind, seat, ticket, 24h / 7d / all. Paging works over the whole `flight_decisions` table, not a 24-hour window.
- A pinned section "**Needs a power FLIGHT lacks**" lists the open "For the controller:" requests (130 so far). These are FLIGHT's real blockers and today they are invisible.
- Outcomes (closed ledger) become rows in the same feed, not a separate panel.

**3. Crew and board** ("how it's managing the board"; replaces the Delivery board, Planning board and Revisit triggers)
- One row per seat, observed loops included: ticket and stage, **stuck on / waiting on** (FLIGHT, you, CI, review, lock, dependency) and since when, FLIGHT's next action and checkpoint, the last thing FLIGHT told it, and a **standing instructions** chip (see below).
- Under it, FLIGHT's **queue**: the ordered next tickets per lane and seat, holds and watches (today's ledger `next`, `watch` and `planned` merged into one list with a horizon column).
- A small flow line (WIP / blocked / oldest / throughput 24h), in one place. The Review/CI and cycle-time tiles move to Telemetry.

**4. What FLIGHT knows** (replaces the Notebook)
- **Standing orders from you**: an operator-authored list (for example "Codex builds are the controller's to pick", "#352 stays in Backlog"). It is extracted from today's "The Operator" prose into discrete, dated, revocable entries. FLIGHT can't edit them; the operator can.
- **Per-agent instructions**: see below.
- **Repo memory**: defaults to the session's repo, not the first repo in config.
- **Working context**: FLIGHT's notes, collapsed by default, with a stale badge past N days.

**Cut from the page:** the seven-tile rail (Overview and Telemetry already carry it), Last contact (the dock is the conversation), Arrivals as a separate panel, the empty-state panels (Drafts, Revisit triggers) that fill most of Plan today, and the dock's "Waiting on you" block **on the FLIGHT page** (keep it on other pages, but count the same canonical set).

### Per-agent standing instructions: what to build and where it shows

- **Model:** `seat_instructions(seatId, text, author: operator|flight, basis, createdAt, expiresAt?, revokedAt?)`. Text is free, at most a few hundred characters per entry.
- **Delivery:** the hub appends active entries to the seat's prompt at run start under "Standing instructions (from FLIGHT / from the operator)", after the repo's `CLAUDE.md` and `AGENTS.md`. On a change it sends one `message_seat`. This matches the requirement that "restrictions should come from the project rules in the CLAUDE or AGENTS files, or from instruction from FLIGHT which may be saved per agent". Read `AGENTS.md` alongside `CLAUDE.md` in `readRepoClaudeMd`.
- **FLIGHT tool:** `instruct_seat { seat, text, basis, expiresAt? }` and `revoke_instruction`. Each call is a decision row in tab 2.
- **Surfaces:** an Agent page header line "Standing: 2 instructions (1 from FLIGHT)" that expands to edit or revoke. A Crew-tab chip on each seat row. A list in the Knowledge tab. Operator-authored entries outrank FLIGHT's, and FLIGHT cannot revoke them (the same rule as operator memory notes).
- Today's `focus` selector (`focus.ts`) becomes one structured kind of standing instruction (lane, label or ticket scope) and gets the UI it lacks.

### FLIGHT using skills and other agents: what to build and how it shows

- **Runtime:** FLIGHT holds `Task` and the repo's `.claude/skills` / `.claude/agents` as invocable, instead of a reference list. `DENIED_TOOLS` is shared by all modes, so FLIGHT needs its own list. **To verify before relying on it:** whether Claude Code subagents inherit the parent's permission deny-list and sandbox. If they don't, a hub-mediated `consult { role: retro|network|fido, question, refs }` tool, which starts a short read-only seat and returns its answer, is the safer path and fits the model-agnostic design (gate in hub code).
- **Surface:** every answer, brief and decision carries `consulted: [{kind: seat|subagent|skill, name, summary}]`. It renders as chips ("consulted RETRO-CX · skill: test-strategy · read CI log") on the tab 2 feed row and in the brief's Context. The operator can then see that FLIGHT did the legwork before escalating, which is the requirement that FLIGHT only "break down complex asks to the operator when they also are unable to provide a solid answer".
- Brief rule: an operator ask on a technical question must list at least one consult or check, or say why none was possible.

---

## 4. What pulls the operator back into the Board or into babysitting

| Pull | Where | Fix |
|---|---|---|
| The Board tab lamp lights for any PR or escalation item | `Header.tsx:38-42` | Remove it. Needs you is the one lamp. |
| Board cards carry "You: decide on the draft · waiting N" from their own rule, which disagrees with Needs you (#750) | `board/cards.ts:122-133`, `Card.tsx:189` | Render the chip only from the canonical attention item for that ticket, and link it to the brief. |
| The Board has a "Needs me" filter and a "Standup brief" | Board toolbar | Keep the filter, but drive it from the canonical set. Move the stand-up brief to FLIGHT tab 2 or 3. |
| Five disagreeing counts make the operator open every surface to reconcile them | §1 | One `needsYouItems` set everywhere (dock, Comms, Command), and the header opens FLIGHT › Needs you. |
| Unread narration from seats and FLIGHT becomes Needs you and notifications (`agentMessages` is off by default, but the items still count) | `comms.ts:204-227`, `hud.ts:615-646` | Rule 3 above. |
| Raw seat questions reach the operator when FLIGHT misses triage, with no brief | `hud.ts:768-806` | Rule 2: a single "FLIGHT not triaging" item. |
| Stalls, PRs and blocked runs notify the operator by default | `local-notifications.ts:48-90` | Notify briefed asks only, plus FLIGHT down. |
| FLIGHT's real blockers (missing powers) go to a controller only through `log_decision` text that nobody sees | 130 rows in `flight_decisions` | Tab 2's pinned "Needs a power FLIGHT lacks", plus a ticket per power (the retrospective already asks FLIGHT to file them). |
| The Overview crew table puts "Answer" and "End the run" buttons on rows | `home.png` | Move them into the canonical brief. Rows say "waiting on FLIGHT" or "waiting on you (1 ask)". |
| The Agent page banner says "guido-cx needs you · Answer · Ack" for a question FLIGHT should own | `agent/NeedBanner.tsx` | Show "Waiting on FLIGHT (triage due in 12 min)" while FLIGHT owns it. |
| The FLIGHT page doesn't say that the crew is paused or that FLIGHT is held, so the operator goes to Overview or Setup to find out | `Situation.tsx` | Status strip (§3). |
| The `#1818` brief is stale and the item has no automatic resurfacing, so the operator has to remember to resume the loop | escalation and brief | Rule 5: a hold with a time condition. |

---

## 5. Ranked IA and workflow changes

1. **One canonical Needs-you set, with one home.** The header, dock, Comms, Command and Board all count `needsYouItems`, and the header opens FLIGHT › Needs you. *Why:* five disagreeing numbers destroy trust in every number, and the operator's main question has no single answer today. Cheap: it is mostly routing and filter changes.
2. **Fix `isHardRulesFlagKey` for run ids that contain colons** (`core/loop.ts:190`, for example `/^flag:.+:hard-rules:/`, or parse from the right). *Why:* it is a real ownership bug that has put every hard-rule PR in front of the operator despite `hard_rules_by=flight`. A one-line fix with a large effect.
3. **Take `message` items, and the ask/comms duplicate, out of Needs you.** *Why:* 4 of the 13 live items. FLIGHT's own "nothing needs you" summary is itself a Needs-you item.
4. **Show FLIGHT's decisions: a "What FLIGHT did" feed over all of `flight_decisions`, with filters and Overturn.** *Why:* "what is FLIGHT doing and why" is a core operator question, and today 638 decisions are recorded with zero shown, because three components each point to another. This tab is what makes the operator trust FLIGHT enough to stop checking the Board.
5. **No brief, no ask; and a single "FLIGHT not triaging" item when FLIGHT is down or late.** *Why:* it turns N raw technical questions into one actionable state, and it makes FLIGHT's health visible instead of flooding the inbox.
6. **Add default, deadline, why-you and per-option consequence to the brief, and enforce them in the hub for `for: operator`.** *Why:* this is the operator's stated requirement ("specifically what is needed and its options"). It also makes "Accept recommendation" safe as one click, and the model-agnostic memo says rules belong in hub code.
7. **A FLIGHT status strip (run state, crew paused or held, last and next wake, headline age, three counters) in place of the metric rail.** *Why:* the operator can't tell whether FLIGHT is working, and Overview and the FLIGHT API disagree ("Held" against "live").
8. **Seats ask FLIGHT, not the operator (`ask_operator` becomes `ask_flight` for seats), as the spec already says.** *Why:* it removes the largest source of raw asks, and FLIGHT answered 44 of 45 historical questions anyway.
9. **Per-seat standing instructions (store, prompt injection, an `instruct_seat` tool, UI on Agent and Crew), plus reading `AGENTS.md`.** *Why:* this is the operator's restriction model ("from the project rules… or from instruction from FLIGHT which may be saved per agent"). Without it, FLIGHT re-messages seats every run and its notebook prose never reaches them.
10. **Let FLIGHT consult (Task or a hub `consult` tool, repo skills and agents), with "consulted" chips on answers and briefs.** *Why:* it is an explicit requirement, it raises answer quality so fewer asks escalate, and it shows the operator FLIGHT's legwork. It needs a security note and a check of how the deny-list carries to subagents.
11. **Defer means hold; defaults act.** Time and condition holds, FYI countdowns for reversible choices within standing authority. *Why:* #410 and #1818 are the live examples. It cuts open asks to the ones that truly need a decision now.
12. **A Crew-and-board tab with one row per seat (observed loops included), showing stuck-on and waiting-on, FLIGHT's next action and its last instruction.** *Why:* it answers "what is each agent doing or stuck on" for every agent at once, and replaces two-row Delivery and Planning tables that repeat Overview.
13. **A Board chip and lamp driven only by canonical items, and no Board lamp in the nav.** *Why:* it stops the Board pulling the operator back, and removes a second definition of "You:".
14. **Missing powers made visible and ticketed** (130 "For the controller" requests). *Why:* each is a recurring human hop. Surfacing them shows which FLIGHT powers would retire the most asks, starting with ready-for-review on drafts (#551).
15. **A single definition of "in progress" across Overview, Pipeline, FLIGHT and Board, each label stating its denominator.** *Why:* 0 / 2 / 6 / 15 for the same question.
16. **Comms is for agent↔agent and agent↔operator threads; FLIGHT↔CAPCOM chat is the dock everywhere.** Drop it as Comms' default view, or make Comms open on #crew with unread counts. *Why:* there are three FLIGHT chat surfaces today. The "communications between agents" question is better served by #crew and threads, with a visible "unanswered for N h" marker on seat posts no one has replied to (INCO-CX's #717 blocker, GUIDO-CX's #747 request).
17. **Notebook as an operator view.** Discrete standing orders from the operator, memory defaulting to the session's repo, working context collapsed and marked stale. *Why:* today it is FLIGHT's scratch prose, 4–5 days old, and the memory panel opens on the wrong repo.
18. **Notifications only for briefed asks and FLIGHT down.** *Why:* stalls, PRs and blocked runs are FLIGHT's first. Notifying the operator immediately teaches them to babysit.
19. **Small fixes:** "1162:46 in this step" should read as hours. The guido-cx state ("Review") contradicts its Now tile ("Blocked…"). The hub's discussion opener speaks as FLIGHT when FLIGHT is down and mentions a "Teams thread" at home. The controller's messages render as "You" in Comms. The two cycle-time figures (Telemetry and FLIGHT) need labels that explain their different definitions. The Comms "Decisions" panel and Record's "Decided without you" use "decision" for two different things; rename the first "Asks".
