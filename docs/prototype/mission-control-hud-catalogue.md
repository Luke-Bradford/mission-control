# Mission Control HUD: complete catalogue of the mockup

Source: `docs/prototype/mission-control-hud.html` (2206 lines; CSS 1–565, markup 566–757, script 758–2205) and `docs/prototype/mission-control-hud.md` (154-line text outline, which adds nothing beyond the HTML's static text). "L123" means a line number in the HTML file. Quoted text is the mockup's own wording. `{x}` marks a value the script fills in.

Contents:
0. Product framing and cast
1. Global chrome (header, footer, toast, FLIGHT dock, theme/fonts/colours/lamps, keyboard, responsive layout, live simulation)
2. Pages: Overview, FLIGHT, Board (+ Brief modal), Agent, Comms, Telemetry, Setup (6 sub-tabs), Away mode modal, Item panel (Answer / Open / Read the brief / Discuss), Keys and lamps (help) modal
3. Data model implied by the sample data
4. Build-status notes (every chip, verbatim)
5. Behaviour rules (verbatim, with location)
6. Work-specific sample context (flagged)
7. Inconsistencies, dead code and oddities noticed while cataloguing

---

## 0. Product framing and cast

- Title: `Mission Control HUD` (`<title>`); brand text in the header: "Mission Control".
- Layout comment (L11–12): "Layout: ops-room app shell. A top bar with status and six tabs, the work area on the left, FLIGHT's line docked on the right on every page. Colour is for state only: amber waits on you, green is being worked, red is broken. Agent colours identify agents and always sit beside the call sign."
- Help modal closing line: "This is a clickable mockup with invented data."
- Roles (call signs from the Apollo control room, Setup › Roles, L1899–1900):

| Call sign | Apollo position | Here | Mode |
|---|---|---|---|
| CAPCOM | Capsule Communicator, the one voice to the crew | you: decisions, approvals and anything tagged @CAPCOM | — |
| FLIGHT | Flight Director | head agent: assigns, unblocks, brings you decisions | read-only |
| FIDO | Flight Dynamics Officer | architect: plans changes across areas | read-only |
| GUIDO | Guidance Officer | backend developer, test-first in its area | writer |
| INCO | Instrumentation and Communications | frontend developer | writer |
| BOOSTER | Booster Systems Engineer | devops: CI, builds and releases | writer |
| SURGEON | Flight Surgeon | QA: writes and runs tests | writer |
| RETRO | Retrofire Officer | reviewer: findings with file and line | read-only |
| NETWORK | Network Controller | researcher: code, docs, the web and Teams | read-only |
| FAO | Flight Activities Officer | planner: board, priorities and queues | read-only |

- `ROLES` used by the Add-agent form (L1850): backend developer · GUIDO · writer; frontend developer · INCO · writer; devops · BOOSTER · writer; qa · SURGEON · writer; reviewer · RETRO · readonly; researcher · NETWORK · readonly; architect · FIDO · readonly; planner · FAO · readonly. Call sign = console + "-" + (count of existing agents with that prefix + 1), e.g. `GUIDO-4`.
- Panel subtitle in Roles: "roles/*.md · call signs from the Apollo control room; rename any agent".

---

## 1. Global chrome

### 1.1 Header (`<header class="top" role="banner">`, L567–586)

A single flex row that wraps (there is no separate "second row" element; on narrow widths the right-hand controls wrap onto a second line). Order, left to right:

1. **Brand**: crosshair SVG icon (circle, four ticks, accent-coloured centre dot) + "Mission Control" (display font, 18px).
2. **Session selector** `#sess` (aria-label "Session"; max-width 132px): first option "All sessions" (value `all`), then one option per session labelled `s/{id}` (`s/mission-control`, `s/nw-2308`, `s/nw-2315`, `s/nw-2358`). Adding a session in Setup appends `s/{name}`. Changing it sets the global session filter (`inView`) and re-renders; it filters: Overview agent rows and Activity rows, Board cards whose agent is out of view (Done cards always stay), Agent picker, Comms thread list, FLIGHT "Work in flight" rows, Setup › Sessions panels, Setup › Loops "N running" counts, j/k cycling.
3. **Page tabs** `nav#tabs` (aria-label "Pages"): Overview · FLIGHT · Board · Agent · Comms · Telemetry. Hash links `#overview` etc.; the active tab gets `.on`. Tab badges (lamps, never pulsing on tabs):
   - FLIGHT: lamp if any attention item of kind `decision` or `person`.
   - Board: lamp if any attention item tied to a board card (kind `pr`).
   - Comms: lamp if any attention item at all.
   - Lamp is red (`crit`) only if one of the items is kind `error`; its tooltip lists the kinds (KIND_LABEL names joined by ", ").
   - Setup is not a tab: it is reached through the Setup icon button or `g s`.
4. Spacer.
5. **MET clock**: "MET **00:00:00**" (HH:MM:SS, tabular), title "Mission elapsed time: since the first agent started today". Sample start = now − 3 h 12 min 40 s. Updates every second.
6. **Machine button** `#machBtn` (title "Machine and test lock (on Overview)"): three spans "CPU {n}%" · "RAM {n}%" (memory used / 64 GB) · "Lock: {holder call sign | free}{ +queue length}" e.g. "Lock: GUIDO-2 +1". The Lock span's tooltip is "The run holding the lock is stalled" when the holder is stalled, else "Full-suite test lock". Button turns amber (`.hot`) when the lock is blocked (holder stalled AND someone queued). Click: go to Overview and scroll the Machine panel into view.
7. **Needs you button** `#needsBtn` (title "Everything waiting on you (on Comms)"): lamp + "Needs you **{N}**". Lamp pulses if any item is not acknowledged; when N = 0 the lamp is grey (`--line-2`). Amber border when N > 0. aria-label "{N} things need you{, some not yet acknowledged}. Opens Comms." Click: go to Comms. (Sample initial N = 14.)
8. **Away button** `#awayBtn` (title "Away mode: what Mission Control may do while you're away"): text "Away mode" (ghost style) when off; when on, amber/warn style with "Away · {d Mon}" (e.g. "Away · 28 Oct") or "Away · on" if no end date. Click: opens the Away mode modal.
9. **Theme button** `#themeBtn` (icon only): cycles system → light → dark → system. Icon: sun (light), moon (dark), monitor (system). Title/aria: "Theme: {follow the system | light | dark}. Click to change." Toast on change: "Theme: {follows the system | light | dark}." Persisted in localStorage key `mc5:theme` (default `system`). If the host page sets `data-theme`, "system" defers to it.
10. **Setup button** `#setupBtn` (sliders icon; title "Setup: sessions, loops, accounts, guard, access and notifications"; aria "Setup"): go to Setup; highlighted (`.on`) while on Setup.
11. **FLIGHT chat button** `#dockBtn` (title "Show or hide FLIGHT's chat (f)"; aria "FLIGHT chat"): speech-bubble icon + amber badge with the number of unanswered FLIGHT asks (sample 3). Highlighted when the dock is visible. Click toggles the dock.

### 1.2 Footer (`.keys`, L745)

- **Build status toggle** `#bsBtn`: "Show build status" / "Hide build status" (title "Mark every panel with how buildable it is today"). When on: body gets `bs-on`, every `.phase` ("P2") badge is hidden, the legend appears, and chips are appended to panel headers (see section 4). Chips are re-added idempotently after re-renders so tooltips survive live updates.
- **Legend** (hidden until on): chip "Proven" — "tested against the real thing"; chip "Buildable" — "standard work"; chip "P2" — "waits on an engine not built yet"; chip "Check first" — "a small test before relying on it · hover a chip for detail". Chip colours: proven = green, build = grey (fg-2), later = accent blue, check = amber; dashed border; cursor help; note text in the `title` tooltip.
- **Sample data** chip: "Sample data" (title "Everything on this page is invented sample data"), amber dashed.
- **Key hints**: "g then o f b a c t pages" · "f FLIGHT" · "j k next agent" · "/ message agent" · "i interrupt" · "? help". (Footer omits `s`; the help modal includes it.)

### 1.3 Toast

`#toast` (role status), fixed bottom-left, max 480px, accent border; replaced by each new toast; hides after 5.2 s.

### 1.4 FLIGHT dock / fly-out (`aside#dock`, aria-label "FLIGHT", L735–742)

Present on every page.

- **Header** `#dockHead`: FLIGHT tag (grey square + "FLIGHT") · pill "Head agent" (green) · `P2` phase badge · spacer · "Hide" button (title "Hide FLIGHT (f)"). Meta line beneath: "{profile} · {model} · turn {turns} of {maxTurns}, then a fresh session · context {ctx}% · {doing}" → sample "claude-main · opus · turn 23 of 40, then a fresh session · context 38% · Waiting on your decisions · watching the test lock".
- **Waiting on you** `#dockWaiting` (amber band, only when there are unanswered asks): heading "Waiting on you · {n}"; one button per open ask: pill "Decision" (amber) or "Approval" (plain) · title (e.g. "NW #2358: lanes per customer, or one global list?") · suffix "· follow-up" / "· old thread" when the catch-up kind is not "New" · agent tag (who it is for). Click opens the Item panel (section 2.9).
- **Conversation** `#dockMsgs` (auto-scrolls to bottom): each message shows time + sender ("You", "FLIGHT" or "Mission Control" for `sys`). `@CAPCOM` is highlighted amber. Ask messages render as a card: time, "FLIGHT", pill "{Decision|Approval} · for {CALL}" (amber while open, plain once answered), title, and either an "Open" button or "You: **{answer}**". Answered cards are styled `done`.
- **Input** `#dockForm`: placeholder "Ask FLIGHT to assign, reprioritise or report…", "Send". On send: op message appended; after 1 s FLIGHT replies "On it. I'll update the queues and report back here; anything that needs a decision comes to you tagged @CAPCOM."
- **Hide/dock behaviour**:
  - ≥1200px wide: docked right column, 380px; "Hide"/`f`/chat button toggles; state persisted in `mc5:dock` (default shown).
  - <1200px: becomes a drawer from the right edge (max 420px, scrim behind, shadow), closed by default, not persisted; `Esc` closes it. Crossing the 1200px breakpoint closes the drawer.
  - Clicking the FLIGHT row on Overview (`data-dock=""`) opens the dock.

### 1.5 Theme, fonts, colours, lamps

- Fonts (Google Fonts): "Barlow Semi Condensed" 500/600 (display: call signs, brand, big numbers), "IBM Plex Mono" 400/500 (mono: refs, paths, commands), "IBM Plex Sans" 400/500/600 (body). Fallbacks: Segoe UI/system-ui; Cascadia Mono/Consolas; Arial Narrow. Sizes: 13px base, 12px small, 11px xs; radii 8px/6px.
- Dark (default) tokens: bg #0e1116, surface #151a21, surface-2 #1c222b, line #252c37, line-2 #354050, fg #e7eaef, fg-2 #aab2bf, muted #808999, accent #8db0ff, ok #45c486, warn #f2b53a, crit #f06b68, think #b8a8f7. Agent series colours s1–s7: #3987e5, #d95926, #199e70, #c98500, #d55181, #008300, #9085e9. Background glow: faint radial accent at top.
- Light tokens: bg #f3f5f8, surface #fff, surface-2 #eef1f5, line #dfe3ea, line-2 #c6cdd8, fg #121720, fg-2 #4a5465, muted #667083, accent #2456d3, ok #17804e, warn #935f00 (warn-mark #e0a21c), crit #c4302d, think #5b47c4; s1–s7 #2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #6250d6.
- State pills (CSS comment: "state pills: a dot plus a word, never colour alone"): green = running, head, passing, merged, approved, done; amber = stalled, blocked, parked, waiting, you, tag; red = error, failing, changes; grey = everything else (idle, stopped, plain…). `plain` hides the dot.
- State labels: running "Running", stalled "Stalled", blocked "Blocked", parked "Parked", waiting "Waiting", idle "Idle", stopped "Stopped", head "Head agent".
- Agent tag: coloured 9px square + call sign in display font; FLIGHT uses grey; "You" is accent-coloured text.
- `@CAPCOM` and, in people's messages, `@Alex` / `@alex-doe` / leading "Alex," render as amber mention chips.
- **Lamps** (CSS comment: "lamps and pulses: amber waits on you, green is being worked; both breathe slowly"): 8px dot; amber (warn-mark) default; `.crit` red; `.go` green; info lamps on the watch list use accent blue.
  - `.lamp.pulse`: opacity breathes to .25 over 2.4 s.
  - `.pulse-warn` (amber halo box-shadow, 2.6 s) on board cards that need you and on the Machine panel lock box when the holder is stalled.
  - `.pulse-ok` (green halo, 3.2 s) on board cards being worked or reviewed now; also the current step dot in the Agent loop stepper.
  - Reduced motion: no animation; pulsing lamps get a static amber ring instead; the live tick slows from 2 s to 3.2 s and number tweens are skipped.
  - **Acknowledge**: an attention item's lamp stops pulsing once acknowledged ("Ack", "Ack" on an agent banner, or "Acknowledge all"); acknowledged rows fade to 60%. The item still counts until the underlying thing is acted on.
  - Help text: "Amber breathes slowly where something waits on you; green breathes where an agent is working. Acknowledge an item to stop its pulse; it clears when you act. Colour always comes with a word, so nothing depends on colour alone. @CAPCOM marks a message addressed to you."
- Row stripes on Overview: amber left bar on agent rows that need you; green left bar on running rows with no needs.

### 1.6 Keyboard shortcuts (all, from L2082–2094 and help modal)

| Key | Effect |
|---|---|
| `g` then `o` / `f` / `b` / `a` / `c` / `t` / `s` (within 900 ms) | Overview / FLIGHT / Board / Agent / Comms / Telemetry / Setup |
| `f` (alone) | Show or hide FLIGHT's dock (drawer on narrow screens) |
| `j` / `k` | Next / previous agent (within the session filter, wrapping); re-renders |
| `/` | Go to Agent page and focus its message box ("message the selected agent") |
| `i` | Interrupt the selected agent if on the Agent page; elsewhere toast "Open an agent to interrupt it." |
| `?` | Open "Keys and lamps" help modal |
| `Esc` | Close help, Brief modal, Away modal, Item panel, and the dock drawer (narrow only). Inside an input/select/textarea, `Esc` blurs the field; other shortcuts are ignored while typing. |
| `Enter` | On a focused Overview agent row, FLIGHT row, board card or Work-in-flight row: activates it (same as click) |

### 1.7 Responsive layout

- ≥1000px wide and ≥560px tall: app fits the window; panels scroll internally (body overflow hidden).
- <1200px: dock becomes a drawer (above).
- <1000px or <560px tall: page scrolls; lists capped at 460px; kanban 70vh; streams 60vh.
- <1000px: Overview, Agent, Comms, Loops, Telemetry, FLIGHT 3-column grid and Away grid collapse to one column; Asked-of-you cards one column.
- <760px: tables/rows compress (agent rows two columns, header row hidden; activity hides the who column; forms single column, etc.).
- Safe-area insets respected; `meta claude:viewport-fit-sides cover`.

### 1.8 Live simulation (mockup behaviour that implies real-time requirements)

- Every 2 s (`tick`): each running agent's token series moves; tokens, cache, cost, tool counts and current loop-step tokens grow; a random log line from a running agent is pushed to Activity (and to its stream if a tool/think line); occasionally (12%) a high-level step/check/commit from `STEP_POOL`; occasionally (14%) an agent-to-agent message from `A2A_POOL` (delivered or queued). Overview/Agent/Comms/Telemetry re-render only what changed.
- Every 1 s: all `data-since` timers (m:ss) and the MET clock update.
- Activity rows buffer: last 400 kept; last 120 shown.

---

## 2. Pages

Routing: `PAGES = overview, flight, board, agent, comms, telemetry, setup`; hash routing (`#overview`…); unknown hash → Overview. `navigate('agent:{id}')` selects an agent and opens the Agent page; `navigate('page:{p}')` opens a page.

### 2.1 Overview (`#page-overview`)

HTML comment: "OVERVIEW: the crew, what they're doing, the machine and quota; everything waiting on you is one click away on Comms". Two columns: left (Agents, Activity), right (Machine, Account quota).

#### 2.1.1 Needs banner (`#nbanner`, top)

- If away mode is on, first an accent strip: "**Away mode is on {until label}.**" "Safe tickets only; anything else stays a draft, and comments wait for you." [Settings] (opens Away modal). Until label = "until you turn it off" or "until {Wkd d Mon}".
- Empty state: "**All clear**" (green) "Nothing is waiting on you."
- Otherwise a full-width amber button: lamp · **{N}** "things need you" · count bits (only non-zero shown): "{n} asked of you", "{n} decision(s)", "{n} approval(s)" (approvals + questions), "{n} stall(s)" (stalled + lock + error), "{n} message(s)" (tags + unread), "{n} PR waiting on you", "{n} parked", "{n} stray change(s)" · "Open Comms →". Click → Comms.

#### 2.1.2 Agents panel (`#agentsP`)

- Title "Agents"; subtitle "{running} working · {n} agents · FLIGHT not counted"; button "Add agent" (goes to Setup › Sessions with the add-agent form open on the first session, `s/mission-control`).
- Column header row: Agent · State · Ticket and what it's doing · Loop step · Tokens · ~cost · Context · quota.
- **FLIGHT row** (always first; click/Enter opens dock): FLIGHT tag + "head agent"; pill "Head"; doing ("Waiting on your decisions · watching the test lock") + "coordinates the crew and brings you decisions"; "turn 23 of 40"; "600/min"; meters "ctx 38%" and claude-main first window "5h 38%".
- **Agent rows** (sorted: agents with needs first, then by state order error/stalled → blocked/parked → waiting → running → idle → stopped). Columns:
  - Call sign tag + role ("backend developer").
  - State pill.
  - Ticket chip + title (or "No ticket") / `doing` line.
  - Loop step: "{template} › **{node}**" + " · try {attempt} of {max}" when attempt > 1; step bar (one segment per template path step: done / current (green) / held (amber when stalled, parked, blocked or waiting) / todo; tooltip = path joined by " → "); then live tool (shortened to 46 chars) + elapsed m:ss, or for a waiting agent "in line for the test lock · {m:ss}".
  - Tokens: in+out (e.g. "60.1k") + 56×18 sparkline (last 24 samples of the tokens/min series, agent colour) / "{tpm}/min · ~${cost}".
  - Meters: "ctx {n}%" and first quota window of its account (e.g. "5h 38%"); meter turns amber ≥80%, red/full ≥100%.
  - Need line (when the agent has needs), with lamp: "Stalled {m:ss} and holding the test lock; {n} waiting [Stop the run]" OR "Stalled {m:ss} in {tool} [Interrupt]"; "Parked: {reason}{ · n message queued}"; "{Decision|Approval|Question} for you [Answer]"; "Tagged you [Read]" (only if no ask). Joined with " · ".
  - Row is clickable (→ Agent page); selected agent row highlighted.

#### 2.1.3 Activity panel (`#actP`)

- Title "Activity"; subtitle depends on filter: "high-level steps from every agent" / "what agents said to each other" / "every event".
- Segmented control: "Steps" (default; kinds step, check, commit, pr, state, lock, guard) · "Messages" (kind comms) · "Everything". Button "Pause"/"Resume" (stops new simulated rows).
- Row: time HH:MM · glyph (step →, check ✓ (✗ in red if the text contains "fail"), commit ●, pr ⇡, state ◆, lock ⊟, guard ⊘, comms ›, tool/think/file/usage ·) · who (agent tag, or "FROM → TO" for comms) · text (@CAPCOM highlighted) · " · {res}" · ticket chip. Empty: "No events yet." Rows from agents outside the session filter are hidden. aria-live off. Auto-scrolls to bottom.

#### 2.1.4 Machine panel (`#machP`)

- Title "Machine"; subtitle "this PC · every 2 s".
- CPU stacked bar: test run (s7) · agents (fg-2) · other apps (line-2); value "{cpu}% of 16 threads".
- Memory stacked bar, same segments; "{x.x} of 64 GB".
- "Disk C:" bar (used); "412 GB free".
- Legend: "test run" · "agents ({crew+1} processes)" · "other apps".
- Agent slots: "Agents" + 8 slot dots (filled = used) + "{crew} of 8" + "· up to 4 per session" + right side "Room for {n} more agent(s)" (green) or "No room for another agent" (amber; when free slots ≤ 0 or free memory ≤ 2 GB).
- **Test lock box**:
  - Held: heading "Full test suite · one at a time" + pill "No output" (stalled holder) or "Running". Row: holder tag · label ("NW full suite") · cmd chip ("just test") · ticket chip ("NW #2308"). Line: "{m:ss} elapsed · usually about {9} min{ · **over its usual time**}{ · nothing printed for {m:ss}}". Buttons: [Stop the run] (warn) · [Open {CALL}]. Then "Waiting" with queue rows: position · agent tag · label · ticket chip · wait timer (amber); or "Nobody waiting." Box turns amber and pulses when the holder is stalled.
  - Free: heading + pill "Free" + "No full-suite run in progress. The next verify step takes it straight away."
- Machine numbers (sample model): CPU = 2 + 3.5 × running agents + test run (31, or 4 if the holder is stalled) + 6 other; memory = 0.42 GB × (agents + 1) + 3.6 GB test run + 9.2 GB other.

#### 2.1.5 Account quota panel (`#quotaP`)

- Title "Account quota"; subtitle "5-hour and 7-day windows".
- One row per account: name · 5h meter (or "no 5h window") · 7d meter. Hover title: "{account} {window}: {used}% used · {time-to-full | 'not filling at this rate'} · resets {reset}".
- Warnings: "{account} {window} at its limit until {reset}" (red) for windows at 100%; "{account} {window} full in {tt} at this rate (resets {reset})" when tt is "~…h". Sample: "claude-main 5h full in ~3h10 at this rate (resets 14:00)", "claude-second 5h full in ~5h at this rate (resets 15:40)", "codex-second 7d at its limit until Wed 08:00".
- Note: "Codex quota is read live. Claude quota comes from rate-limit events while its agents run (claude-main 2 min ago, claude-second 9 min ago). Hover a bar for its reset time."

### 2.2 FLIGHT page (`#page-flight`)

HTML comment: "FLIGHT: the head agent's picture of the work: what came in, what it's watching, what it decided, what it wants you to send". Order: Situation, Asked of you, Work in flight, then a 3-column grid: Incoming | Watch list | (Drafts for you to send above Decided without you).

#### 2.2.1 Situation (`#sitP`)

- Title "Situation"; subtitle "FLIGHT's read of everything, updated as things change"; badge "P2".
- Paragraph (sample): "Six agents on five tickets. Four people are waiting on a reply from you; I have read each thread and drafted answers. One run is stuck holding the test lock and needs your call; GUIDO-3 is waiting behind it. Three PRs are waiting on people, not on us. A Teams report (Contoso listings missing since Tuesday) may relate to our catalog feed work, and NETWORK-1 is checking. I answered six agent questions myself today; one needs you, with a brief."
- Stats strip: "{n} person/people waiting on you" (amber if >0) · "{n} tickets in progress" (In progress count) · "{n} waiting on other people" (In review without a "you" action + Ready for QA) · "{n} decision(s) for you" (amber if >0) · "{n} routine approvals" (approval + question items) · "{n} answered by FLIGHT today" (decided not overturned) · "{n} drafts to send" (drafts not done) · [Open what needs you] (primary; only if decisions or approvals exist; → Comms).
- **Timeline** (next 240 min): horizontal line, "now" marker, events placed by minutes from now, labels alternate above/below, right-aligned near the end; each "**HH:MM** {label}". Sample: +8 "Board and notifications poll (every 10 min)", +26 "claude-main 5-hour window resets", +52 "NETWORK-1 reports on the Contoso listing gap", +84 "Re-check PR #2368 after the nudge", +190 "Standup brief ready".
- "Later:" line for items beyond 4 h: "**Wed 08:00** codex-second resets; resume INCO-1 · **Mon 09:00** NW #2302: check the migration has run".

#### 2.2.2 Asked of you (`#askP`)

- Title "Asked of you"; subtitle "people waiting on a reply from you, with FLIGHT's take · first, because a person is waiting".
- Two-column grid of amber cards, one per open person-ask:
  - Row: **{who}** · chip "{src} · {where}" · time · urgency pill (amber) if set.
  - Catch-up head line: pill "{New | Follow-up | Old thread}" (New = plain, others amber) + one-line context.
  - Blockquote snippet with mentions highlighted.
  - "FLIGHT'S TAKE" label + take.
  - Related chips (e.g. "NW #2358") · [Open in {src} ↗] · [Read the brief and reply] (primary → Item panel, person variant).
- Empty: "Nobody is waiting on you." Footer when any handled: "Handled today: {who} ({how}) · …" (how = "reply copied for Teams", "replied on GitHub", "marked handled", "with FLIGHT").

#### 2.2.3 Work in flight (`#wifP`)

- Title "Work in flight"; subtitle "every ticket being worked, step by step · ×2 means a step ran twice".
- One row per in-view agent with a current ticket and run records: ticket chip + title · agent tag · state pill · step cells for each template step (done / current green / held amber / todo; cell label = step name; "×N" when that step ran N>1 times; tooltip "{step} · {n} try|tries"). Fix rows count under the preceding step unless the template has its own fix step. Row click/Enter → Agent page. Empty: "Nothing in flight."

#### 2.2.4 Incoming (`#incP`)

- Title "Incoming"; subtitle "what arrived and what FLIGHT did with it". Newest first.
- Row: source chip (GitHub / Teams / Board) · time · outcome pill · text · detail.
- Outcome pill classes: "Asked of you" amber, "Assigned" green, "Raised to you" amber, "Reply drafted" plain, "Queued" plain, "Watching" amber, "No action" plain. (Only Assigned, Asked of you, Queued, No action appear in sample.)

#### 2.2.5 Watch list (`#watchP`)

- Title "Watch list"; subtitle "what FLIGHT is keeping an eye on".
- Row: lamp (warn = amber pulsing; info = accent blue; ok = green) · **title** · detail · catch-up head line · "Next: {next}" + action: [Stop the run] (only shown while the lock is blocked; the whole stop-run item hides otherwise) or [See draft] (scrolls Drafts into view).

#### 2.2.6 Drafts for you to send (`#draftsP`)

- Title "Drafts for you to send"; subtitle "Mission Control never messages people itself".
- Row: "**To {to}**" · chip "{via} · {where}" · status pill when done · context line · draft text · buttons: GitHub drafts [Post on GitHub] (toast "Posted on {where} as you. Clicking Post was your approval."; status "Posted"); Teams drafts [Copy for Teams] (clipboard; toast "Copied. Paste it into Teams." or "Copy was blocked here; select the text and copy it."; status "Copied"); [Edit] (toast "Opens the draft so you can change it first."); [Discard] (status "Discarded"). Done rows fade.

#### 2.2.7 Decided without you (`#decidedP`)

- Title "Decided without you"; subtitle "today · overturn any".
- Row: agent tag · time · [Overturn] (or pill "You overturned it") · question · "**{answer}** · {basis}".
- Overturn: adds op message "Overturning your call on "{q}"" to FLIGHT chat; after 0.8 s FLIGHT: "Understood. I have told {CALL} to hold that point. Tell me what you would prefer, here or in its thread."

### 2.3 Board (`#page-board`)

HTML comment: "BOARD: the delivery board, filtered; Mission Control adds only the agent, PR and CI line".

#### 2.3.1 Toolbar

- Saved views (lanes) `#lanes` (aria "Saved views"): "All mine" · "Catalog lane" · "Price Editor" · "Fulfilment" · "Mission Control". Persisted (`mc5:lane`, default All mine).
- Query: `<code>` showing the lane's GitHub query + [Copy] (title "Copy the GitHub query"; toast "Query copied." / "Copy was blocked here; select the query and copy it.").
- Link "Open in GitHub ↗" (lane URL, new tab).
- "Priority" select: Any / P0 / P1 / P2.
- Toggle "Has an agent" (aria-pressed; card has an agent or is in an agent's queue).
- Toggle "Needs me" (card has a "you" action, or is In progress with an agent that needs you).
- Done range segmented (title "How far back Done goes"): "Done 7d" (default) / "Done 14d" / "Done 30d".
- [Standup brief] (primary) → Brief modal.

#### 2.3.2 Kanban

- Columns in order: Backlog · Refinement · Blocked · Ready · In progress · In review · Ready for QA · Done, each "{Status} {count}". Empty columns render collapsed (tooltip "{Status}: nothing here").
- Sort within column: Priority (P0 first; none last) then days.
- **Card**: lamp (amber if needs you, green if being worked/reviewed now) · ref · priority · size · milestone short name (text before " — ", full in tooltip) / title / up to 3 label chips / when you must act: pill "You: {action}" + "waiting {since}" / overlay lines:
  - Working (In progress with agent): agent tag · state pill · "{tpl} › {node}{ · try n}".
  - Else queued: "Next for {CALL} #{pos} in its queue".
  - Else has agent: "by {CALL}".
  - Else Ready and unassigned: "Unassigned · FLIGHT will offer it to an agent".
  - Reviewer: "Reviewing: {CALL} {state}".
  - PR (not Done): "PR #{n}" + CI pill ("CI passing" / "CI {state}") + review pill (Draft / Review asked / Approved / Merged / Changes asked).
  - PR note (not Done), e.g. "RETRO-1 re-checking after a fix".
  - Done: pill "Merged"/"Closed" + "{today | Nd ago} · PR #{n}".
  - Blocked: "Blocked: {reason}" (amber).
- Card pulse: `pulse-warn` with title "Needs you"; `pulse-ok` with title "Being worked on or looked at now".
- Card click/Enter: In progress with agent → that agent's page; has reviewer → reviewer's page; otherwise toast "Opens {ref} on GitHub."

#### 2.3.3 Brief modal (`#briefModal`)

- Header: "Brief" · segmented "Standup" / "Weekly update" · subtitle "plain text, no call signs, ready for Teams or email" · [Copy] (toast "Copied. Paste it into Teams or an email.") · [Close]. Body: `<pre>` text built from the current lane.
- Standup format: first line "Standup, {Weekday D Month} ({lane name})"; sections (omitted if empty), each line "- {ref}{ (PR #n)}: {title}{ ({extra})}":
  - "Since yesterday": Done within 1 day (extra = outcome) + Ready for QA (extra "merged, with QA").
  - "Today": In progress (extra = current loop step, plus ", held up" if stalled/blocked/parked) + top 2 Ready by priority (extra "up next").
  - "Blocked or waiting on me": Blocked (extra = reason) + any card with a you-action (extra "I need to {action}").
  - "In review": In review without you-action (extra "PR open").
- Weekly format: "Update: {lane name}, last {7|14|30} days"; sections "Done" ("{outcome} today" / "{outcome} N days ago"), "Ready for QA", "In review" ("waiting for me to {action}" / "PR open"), "In progress", "Blocked" (reason), "Coming up next" (Ready by priority; extra = priority).

### 2.4 Agent page (`#page-agent`)

The current Agent page follows `docs/mockups/agent/index.html` (Agent page v2, #1022).
The first screen answers what this agent awaits, why, who moves next, and how the run is doing.
Order: picker, identity and awaiting reason, owner-labelled next move, five run figures, complete build-loop strip,
then original ask/result beside deliverables, related work and prompt context. Activity and side tabs follow.
Previous runs and full attempt history load when their disclosure opens.

#### 2.4.1 Picker `#picker` (aria "Pick an agent")

One button per in-view agent: needs lamp, tag and state pill; selected = `.on`.

#### 2.4.2 Next move

The server selects the current seat's attention, scoped to its current ticket or a repo escalation.
The panel names the owner: you, FLIGHT, controller, loop or lane. A recommendation and conversation link
appear when saved. Acknowledgement does not imply that an unresolved decision is complete.

#### 2.4.3 Header `#ahead` and run figures

Identity includes role, session, account, model, area, branch and ticket. Awaiting text names the reason;
long text folds open. Relative state age ticks in its own child. Crew pause, stop and error take precedence.
The existing author review badge remains visible. Interrupt and Stop keep their existing permissions;
Pop out, Switch account, Rename and Remove live behind More and load settings when opened.

The five figures are run health, tool calls (top three tools and failures), reported tokens, API-equivalent
cost (mean per reported turn), and latest recorded context. Unknown values use a dash; an older run's
context window cannot produce a current percentage. Quota, Speed and the duplicate Now tile are absent.

The full configured loop strip shows all steps, recorded durations, review rounds/cap, CI executions and
failures/cap separately. A profile gate without a recorded verdict says Not recorded.
Original acceptance lines and the agent's reported answers remain separate; a reported pass is not a verified verdict.
Deliverables link saved PRs, exact-head screenshot evidence and changed files in their own repositories.
The related tree identifies reviews, subagents and set-aside runs. Prompt context shows the latest recorded
section costs and compaction count; compactions also have an explicit timeline mark.

#### 2.4.4 Activity (stream) panel `#streamP`

- Title "Activity"; subtitle "messages, thinking, tool calls and checks"; filter: "All" · "Messages" (op, msg, ask, a2a, sys) · "Thinking" · "Tools" · "Guard".
- Live call bar `#liveCall`: running "▶ {tool} {m:ss} elapsed"; stalled (red/stuck) "… no output since {HH:MM} · stall flagged at 10:00"; waiting for lock "⏸ Waiting for the test lock: {label} ({cmd}) {m:ss} behind {holder}".
- Event rows: time · who label (op "you", think "thinking", tool "tool", msg "to you", ask "asks you", a2a "agents", guard "guard", sys "system") · text. Tool events are expandable `<details>`: summary "{call} · {dur} · {result}", body "input: …\nresult: …\nduration: …". Ask events end with [Answer] or "· you answered: {answer}". Tagged a2a events carry @CAPCOM highlight.
- Composer: input (aria "Message this agent"; placeholder "Message {CALL}…") · [Send] · [Interrupt and send] (title "Stop the current turn, then send"; empty input → toast "Type a message first.") · hint:
  - running Claude: "Reaches {CALL} mid-turn, alongside its next tool result. Smaller models can ignore a mid-turn note; use Interrupt and send if it matters."
  - running Codex: "Reaches {CALL} at its next model step (Codex steer); no new turn starts."
  - otherwise: "{CALL} is {state}; your message is queued for its next turn."
- Send semantics: if not running/idle → queued count +1, sys "Queued: {CALL} is {state}; it reads this when its next turn starts.", toast "Queued for {CALL}."; if idle → becomes Running (Activity "Idle → Running (your message)"); toast "Delivered to {CALL}."; after 1.3 s the agent replies (reviewer: "Noted. I'll fold that into the review and report back." others: "Copy. Folding that into the current step; I'll report when its checks pass.") and an unread count is added if you are not viewing it.

#### 2.4.5 Loop panel `#loopP`

- Title "Loop"; subtitle "{template} · {tokens} tokens so far"; segmented "Steps" / "Timeline".
- Budget header: "Tokens **{used}** of {budget}" + bar; "Round **{r}** of {rounds|∞}" + bar.
- **Steps view** (vertical stepper over the template path): dot (✓ done, ● current, ! current-but-held, else step number; gate steps styled differently) · step name + "×N" if run N>1 times · meta "{tokens} · {min}m" · (current) the agent's doing line · "Last failure: {reason}" · "↻ {rule}" (template rule for that step) · attempts list (open when clicked or current): "try N"/"fix" · outcome (red fail/parked/stopped, grey running/waiting, green otherwise) · tokens (or —) · minutes · (current) check list with status icons: "✓ pass", "✗ fail", "◌ running", "· waiting". Step headers toggle open/closed. Footer note = RETRY_NOTE: "Tries 1 and 2 resume the same agent; try 3 starts a fresh agent on a stronger model; after that the ticket parks for you. A retry that makes no progress (same failures, same diff) stops early."
- **Timeline view**: one row per step with bars positioned by cumulative minutes; colours: passed grey, failed red, fix accent, running green, waiting or parked amber; tooltip "{step} try {n} · {outcome} · {tokens} tokens · {min} min"; legend "passed / failed / fix / running / waiting or parked"; note "Time runs left to right across the whole loop ({total} min). A step that ran twice shows two bars on its row."

#### 2.4.6 Side panel `#sideP` (tabs)

Tabs: "Plan {done}/{total}" (default), "Queue", "Subagents {n}" only when populated, "Files" (count after loading), and "Context". Each tab reads its data only while open.
- **Plan**: items with "✓ done" / "◌ doing" / "· to do"; note "The agent's own task list: Claude's task tools or Codex plan updates, replayed from its stream." Empty "No task list yet."
- **Queue**: "Focus {focus} [Change]" (toast "Focus is what FLIGHT assigns from: a lane, labels or a ticket list. Change it here, or tell FLIGHT, e.g. "GUIDO-2: catalog bugs only this week".") · "Now" (▸ ticket + current step, or "Nothing assigned.") · "Next · from Ready, by priority" (numbered; ↑ on items 2+ with title "Ask FLIGHT to move this up"; empty "Empty: FLIGHT fills this from the focus.") · note "Each ticket starts as a fresh run on its own branch, with the ticket, the repo's docs and this lane's notes. Earlier tickets' conversations aren't carried over." · "Done" (✓ list; empty "None yet.").
  - ↑ creates an approval ask: "Move {ref} above {ref} in {CALL}'s queue? That swaps their Priority on the delivery board ({P} ↔ {P})." with options Approve / Deny, and opens the Item panel. Approve → swaps queue order and the two cards' Priority; FLIGHT: "Changed Priority on the board. {CALL} takes {ref} first now." Deny → "Left the order as it is."
- **Subagents**: **{type}** {task} · pill Running/Done · "{tokens} tokens · {n} tool calls · {duration}"; note "Subagents this agent spawned. Their tokens count toward its totals." Empty "No subagents spawned this run."
- **Files**: path · +add −del · commit sha or "uncommitted"; clicking a file shows a diff (`@@ path @@` hunk; the mockup always shows the same stop() snippet with `await Promise.race([run.done, delay(8000)]);`). Empty: "Read-only agent: no file changes." / "No file changes yet."

### 2.5 Comms (`#page-comms`)

HTML comment: "COMMS: what needs you, FLIGHT, and one thread per agent". Left column: Needs you, Threads. Right: conversation.

#### 2.5.1 Needs you (`#cNeedsP`)

- Title "Needs you"; subtitle "{n} · {m} not acknowledged" or "nothing waiting"; [Acknowledge all].
- Rows (the global attention list; sorted by kind order lock, stalled, error, person, decision, approval, question, tag, parked, pr, message, stray): lamp · kind label · agent tag · text (truncated at 170 chars) · actions.
- Kind labels: person "Asked of you", decision "Decision", approval "Approval", question "Question", message "Message", tag "Tagged you", stalled "Stalled", parked "Parked", error "Error", pr "PR", stray "Stray file", lock "Test lock".
- Item sources and texts:
  - Unanswered FLIGHT asks → kind decision/approval, text = ask title.
  - Open people → "{catch-up kind} · {who} ({src}, {where}): "{snippet}"".
  - Unseen @CAPCOM tags in an agent's stream → kind tag, text = last tagged message without the arrow prefix.
  - Unread direct-line replies → "{n} new on your direct line".
  - Agents stalled/parked/error (unless parked by your choice) → stalled: "{m:ss} in {tool}{ · holds the test lock}"; parked: reason.
  - Lock blocked → "{queued agents} waiting for the test lock, held by a stalled run ({holder})".
  - Board cards with a you-action → "{ref} · PR #{n} · {title}: waiting {since} for you to {action}".
  - Stray files → "{file} changed in s/{session} outside every agent's area".
- Actions per item: person → [Read the brief] [Open in {src}]; decision → [Read the brief] [Discuss]; approval/question → [Answer]; lock or stalled lock-holder → [Stop the run]; other stalled → [Interrupt]; channel items (tag/message) → [Read]; agent items → [Open]; PR → [Open PR] (toast "Opens the PR on GitHub. Mission Control never merges or marks ready; the card moves when GitHub reports the change."); stray → [Ask FLIGHT]; unacknowledged → [Ack]. Empty: "Nothing needs you right now."
- **Guard drawer** (`<details>`): summary "Guard: {n} blocked command(s){, m new} (for information)"; rows ⊘ agent tag · text · "{time} · rule: {rule}" · [Ack].
- Ask FLIGHT (stray): op "README.md changed in s/mission-control outside every area. Whose is it?"; after 0.9 s FLIGHT "GUIDO-1 ran a formatter over the repo root at 12:08; README.md got a trailing-newline change. I've asked it to revert that file." (Switches Comms to FLIGHT thread, or opens the dock on other pages.)

#### 2.5.2 Threads (`#cThreadsP`)

- Title "Threads"; subtitle "FLIGHT and each agent"; badge "P2".
- FLIGHT entry: pulsing lamp + pill "{n} for you" when asks are open · pill "Head" · last FLIGHT message.
- Agent entries (in view): needs lamp · tag · pill "Tagged you" (amber row) · state pill · last message (op/msg/a2a/ask) or doing.

#### 2.5.3 Conversation

- FLIGHT selected: head "FLIGHT" + subtitle "decisions and questions come to you here, tagged @CAPCOM"; same messages as dock (ask cards with Open); placeholder "Ask FLIGHT to assign, reprioritise or report…"; reply after 1 s "On it. I'll report back here."
- Agent selected: head "Thread" · tag · state pill · subtitle "everything {CALL} sent or received: you, FLIGHT and other agents" · [See its activity] (→ Agent page). Messages: you → agent (mine), agent → you, "{CALL} asks you, through FLIGHT" + [Answer]/"· you answered", Mission Control (sys), peer a2a "A → B"; tagged messages amber with pill "Tagged you". Opening marks tags seen and clears unread. Placeholder "Message {CALL} (reaches it mid-turn)…" (running) or "Message {CALL} (queued until its next turn)…". Empty "No messages yet."

### 2.6 Telemetry (`#page-telemetry`)

HTML comment: "TELEMETRY: running numbers live, then history".

#### 2.6.1 Toolbar

"Telemetry" · range segmented 1h / 6h (default) / 24h / 7d · "Agent" select (All + each agent) · "Account" select (All + each account) · "Ticket" select (All + tickets with an agent) · note "Token counts come from each provider's usage events. Costs marked ~ are API-equivalent estimates; a subscription isn't billed per token."

#### 2.6.2 KPI tiles (live ones animate on change)

| Label | Value | Detail | Live |
|---|---|---|---|
| Tokens | input+output today | "today, input + output" | yes |
| ~Cost | ~$ | "today, API-equivalent" | yes |
| Tool calls | n | "today · {turns} turns" | yes |
| Commits | n | "today · {lines} lines" | yes |
| Working | running agents | "now, of {n} agents" | yes |
| Merged | n | "PRs, last 7 days" | no |
| Lock wait | "7:30" | "today · 3 runs" | no |
| Your response | "4 min" | "median, today" | no |

#### 2.6.3 Group "Flow of work"

- **Throughput** — "tickets merged per day · last 14 days": vertical bars per day (label = narrow weekday + date, every 2nd labelled), weekends 0, last bar accent; tooltip "{day}: {n} merged".
- **Cycle time** — "Ready to Done, median days by size": rows XS 0.6 d (4 tickets), S 1.4 d (11), M 2.9 d (9), L 5.2 d (3), XL — (0); note "Measured from the board: when a ticket entered Ready to when it reached Done."
- **Quality and review** — "last 14 days": 68% "verify passed first try" · 1.4 "fix rounds per ticket" · 19 h "median wait for a human review" · 0.8 "RETRO findings per PR" · 2 "PRs sent back by reviewers" · 94% "CI green on first push".
- **You as CAPCOM** — "how long work waits on you": 11 "decisions today" · 4 min "median response" · 22 min "slowest 10%" · 2 "runs you stopped or interrupted"; note "Longest wait today: INCO-1's account move, 38 min. Agent time spent waiting on you today: 1 h 12 min."

#### 2.6.4 Group "Agents"

- **Tokens per minute** (wide) — subtitle live: "live · last 2 minutes, by agent · moves every 2 s"; history: "history · last {range}, by agent". Segmented Live / History. Stacked area per agent (agent colours), hover crosshair tooltip listing each agent's value ("{n} s ago" in live; "{n} min/h/days ago" in history); legend; Agent filter applies.
- **Where agent time goes** — "share of today, per agent": stacked bar per agent: working (green) · waiting (lock, reviews) (accent) · blocked, parked or stalled (amber) · idle (grey); value = working %. Sample: GUIDO-1 64/8/6/22, GUIDO-2 51/22/9/18, GUIDO-3 58/14/4/24, NETWORK-1 36/6/31/27, RETRO-1 33/4/2/61, INCO-1 41/3/38/18.
- **Tokens per turn** — subtitle "{CALL} · this run" (filtered agent, else selected agent): stacked bars per turn: input, output, cache read, reasoning (reasoning only for Codex); tooltip "turn N · {kind} {n}".
- **Tool latency** — "p50 and p95 per tool": table Tool · Calls · p50 · p95 · Failed · Slowest: Bash 212, 2.8s, 41s, 6, "just test (11 min, GUIDO-2)"; Edit 340, 0.1s, 0.2s, 1; Read 611, 0.1s, 0.3s, 0; WebFetch 48, 1.3s, 3.9s, 2; Agent (subagent) 9, 38s, 1m 10s, 0, "Explore (1:05, GUIDO-3)"; mc.commit 19, 0.4s, 0.9s, 0.
- **Subagents** — "spawned by the crew today": table Agent · Type · Task · Tokens · Tools · Took (all SUBAGENTS rows).

#### 2.6.5 Group "Capacity"

- **Quota used** — "each account window, 100% is the limit": line per account's first window ("{account} {window}"), y max 110%, dashed red line at 100%; legend "{account} {window} · {used}%"; Account filter applies.
- **Machine load** — "% of capacity · shaded while the test lock is held": CPU and Memory lines with shaded bands labelled "GUIDO-1 suite" and "GUIDO-2 suite"; legend CPU · Memory · test lock held.
- **Test lock** (wide) — "full-suite runs, waits and stops today": table Started · Agent · Run (label + cmd chip) · Waited · Took · Result (amber for failed/stopped, green otherwise), plus the live current holder row (Took = live timer; Result "no output" if stalled else "running"). Stopped runs are appended as "stopped by you".

#### 2.6.6 Group "Cost"

- **Tokens by ticket** — "every agent and step on it": bar rows (ticket chip + title · bar · tokens · ~cost at $0.0000045/token); Ticket filter applies.
- **Tokens by loop step** — "repeats cost more": rows plan/implement/verify/review/fix (feature), reproduce/verify (bugfix), investigate (research).
- **Totals** (wide) — "selected range": table Agent · Account · Model · Input · Output · Cache read · Cache hit · Turns · Tool calls · Lines (+/−) · ~Cost; Agent/Account/Ticket filters apply.

Charts share: grid lines at 0/50/100%, hover crosshair + tooltip, x labels "-{range}" and "now".

### 2.7 Setup (`#page-setup`)

HTML comment: "SETUP: sessions, loops, accounts, roles and guard". Toolbar "Setup" + segmented tabs: **Sessions** · **Loops** · **Accounts** · **Roles, guard and test lock** · **Sources** · **Access and notifications**. With build status on, one chip for the current tab is added to the toolbar (section 4).

#### 2.7.1 Sessions

- Intro note: "One session is one ticket: one branch, one checkout and one PR. When a seat picks up a ticket, Mission Control creates the branch from the repo's base and a checkout for it, and removes the checkout when the PR closes. Several agents can share a session, each in its own folders." + [Add session] (primary).
- **Add session form**: "Repo" (placeholder `C:\code\Some-Repo`) · "Branch" ("an existing branch, e.g. feat/2349-import-retry") · "Checkout" select: "use the repo folder (nothing else on it)" / "make a separate checkout for this branch" · "Name" ("short name, e.g. nw-2349") · [Add session] [Cancel] · note "Mission Control checks it's a git checkout on that branch and lists its top folders for areas. The repo profile adds that repo's guard rules, test commands and which of them count as a full suite." On submit: name defaults to repo folder name, lower-cased and slugged; duplicate → toast "s/{name} already exists."; separate checkout goes to `C:\code\mc-checkouts\{name}` and is marked managed; default branch "feat/new-work"; default folders src, tests, docs, scripts, .github; adds to the session selector; opens the add-agent form; toast "s/{name} added{ with its own checkout}. Now add its first agent."
- **One panel per session** (respects session filter): title "s/{id}"; subtitle "{dir}{ (made by Mission Control)} · {branch}"; [Add agent] [Close].
  - Close: if any non-stopped agents → toast "Stop or remove the {n} agent(s) in s/{id} first."; else "s/{id} closed{; its separate checkout is removed, unless the branch has uncommitted changes or unpushed commits}."
  - Crew: buttons per agent (tag · area or "read-only" · state pill) → Agent page; empty "No agents yet."
  - Folder tiles: owner tag or "free" + "{folder}/"; while adding an agent, free tiles are pickable ("Picked"); stray tiles "Stray change" "{file} · {time}".
  - Note: "Tiles show who owns each folder; areas can't overlap. A stray change is outside every writer's area: it shows in Needs you, and FLIGHT can work out whose it is."
- **Add agent form**: "Role" select (role · call sign · mode) · "Call sign" (auto, updates on role change) · "Account" select · "Focus" (placeholder "a lane, labels or tickets, e.g. label:catalog bugs first") · "Area" (shows picked folders as `folder/**`, or "click free folder tiles below · none picked = whole checkout") · [Add agent] [Cancel] · note "The loop comes from each ticket's labels. FLIGHT drafts the agent's queue from its focus and brings it to you to approve."
  - Refusals: "Refused: all 8 agent slots are in use. Remove an agent or raise the limit in config."; "Refused: a writer with no area owns the whole checkout, which overlaps {CALL}'s {area}. Pick folders."
  - Success: new idle agent ("New · waiting for work from FLIGHT or you"), model sonnet (Claude) or gpt-5.6-sol (Codex), context max 200k/400k; FLIGHT raises an approval: "{CALL} joined s/{session} as {role}. I've drafted its queue: the first three Ready tickets matching "{focus}". Start it?" (Approve / Edit / Deny; Approve → "Started. It picks up the first ticket in its queue." Deny → "Not started."); Activity "{CALL} added to s/{session} ({role})"; toast "{CALL} added to s/{session}. FLIGHT has its draft queue waiting for you." Focus default "not set · FLIGHT will ask you". A new agent's stream starts "Added to s/{session}. Waiting for work from FLIGHT or you."

#### 2.7.2 Loops

- Left panel "Templates" — subtitle "loops/*.yaml" — [New] (toast "New template: name the work type, draw the steps, give each step its checks and a limit, then bind it to a ticket label."). List: template name · trigger · "{n} running · {steps} steps".
- Right panel: title = template name; subtitle "runs for: {trigger}"; metro track (numbered steps, gate dots styled, "↻ {rule}" chips) + footer "Up to {rounds|∞} rounds" · "Token budget {budget}" · RETRY_NOTE; step cards: number · name · pill "gate" · agents currently on that step / role line / checks (kind chip + text) / "↻ rule" / "Up to {max} tries."
- Footer note: "Mission Control decides every move from its own checks; an agent saying it is done can only hold work back, never push it forward. cmd = Mission Control runs it · rule = read from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent = the agent's own evidence."
- Templates (full content in section 3.6).

#### 2.7.3 Accounts

- Panel "Accounts" — "one profile per login · Mission Control never reads credentials" — [Add account] (toast "Add account: choose Claude or Codex and a short name. Each account gets its own folder, so logins never mix."). Table: Account · Provider · Plan · Signed in as · Status (pill "Signed in"/"Not signed in") · Quota ("5h 38% · 7d 61%"; amber ≥80, red ≥100) · [Sign in] (toast "Opens a console with {account}'s config folder set. You sign in there; Mission Control never sees the credentials.") [Check] (toast "{account}: signed in (checked with the provider's own status command).").
- Panel "Auto-approve" — "outward writes wait for you until switched on" — badge P2 — disabled checkboxes: "GitHub comments", "Labels", "Board moves and Priority changes", "Starting and stopping agents", "Switching accounts".

#### 2.7.4 Roles, guard and test lock

- **Roles** table (section 0).
- **Guard** — "hard stops enforced in code · hits this week": Rule · Hits:
  - "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode" — 0
  - "git writes only through the mc commit, push and draft-PR tools" — 3
  - "No GitHub comments, labels, board moves or Priority changes without your approval" — 1
  - "Azure DevOps and Data Factory read-only; no database tools" — 0
  - "Full test suites only through Mission Control (one at a time)" — 2
  - Note: "The guard catches agent mistakes and ordinary spellings, not deliberate evasion."
- **Test lock** — "which commands count as a full suite, per repo profile": Repo profile · Full suite (takes the lock) · Runs freely:
  - northwind: `just test`, `just test-all`, `pytest` with no path · just test-file <path>, pytest <path>
  - mission-control: `npm test` · npx vitest run <file>
  - store-admin: `npm test` · npx vitest run <file>
  - Note: "One full suite at a time across the machine; others wait in line, oldest first. An agent that types a full-suite command directly is told to ask Mission Control instead. Max at once: **1**."

#### 2.7.5 Sources

- **GitHub** — "the record of work · read through your gh login" — pill "Connected": "Board: **delivery** (Status, Priority, Size) and platform-tools issues. PRs, checks and reviews per ticket." / "Notifications: assigned, mentioned, review requested, comments and CI on your work feed **Needs you**." / note "Writes (comments, labels, board moves, Priority) go through approvals; nothing posts on its own."
- **Microsoft Teams** — "read-only · Entra app Claude-Operator" — pill "P5": "Watches the chats and channels you pick for: your name or @mentions, your ticket and PR numbers, and words like "bug", "broken" or "urgent" near your areas." / "Matches become Needs you items or a FLIGHT digest, with a link to the message. FLIGHT can draft a GitHub issue from one for you to approve." / note "Polls on a timer; Graph change notifications need a public HTTPS endpoint, which a local app doesn't have. Mission Control never posts to Teams."
- **Agents** — "what each provider reports": "**Claude** (Agent SDK): messages, tool calls, usage per call, run totals with cost and timing, rate-limit events, context breakdown, subagent progress, task-list updates, hooks." / "**Codex** (app-server): items, token usage with the context window, live rate limits, plan updates, per-turn diffs." / "**This PC**: CPU, memory, disk and per-process memory, read by mc-server."

#### 2.7.6 Access and notifications

- **Devices** (full width) — "Mission Control runs on the Mac; your other devices view it over Tailscale": table Device · Role · Connects by · Notifications · Last seen: "Mac | runs Mission Control and the agents | this machine | On | now"; "Work laptop (Windows) | viewer | https://mission-control.your-tailnet.ts.net | On | 2 min ago". Note: "Tailscale gives the Mac a private HTTPS address that only your own devices can reach; the dashboard still asks for its access token. Install the dashboard as an app in Edge on the laptop and notifications arrive even with no tab open."
- **Notify me about** — "on every signed-in device": checkboxes (default): "People asking me something in Teams or GitHub" ✓, "Decisions waiting for me" ✓, "Stalls and stuck runs" ✓, "PRs waiting on me" ✓, "Anything tagged @CAPCOM" ✓, "The away-mode digest when I come back" ✓, "Quota above 90%" ☐, "Every agent message" ☐. "Quiet hours 19:00 – 08:00 stalls still notify". "Soft chime" ✓. [Send a test notification] (toast "In the real app this pops up on the Mac and the work laptop, with a soft chime. Browser notifications are blocked inside this preview.").
- **What a notification looks like** — three samples, each "Mission Control" + text + actions:
  - "Maya R asked you in Product rollout: per-client lanes before the Contoso pilot?" — "Read the brief · Open in Teams · Later"
  - "Decision for you: lanes per customer, or one global list? (GUIDO-3, NW #2358)" — "Read the brief · Discuss · Later"
  - "GUIDO-2's full-suite run has printed nothing for 11 min and holds the test lock." — "Stop the run · Open"

### 2.8 Away mode modal (`#awayModal`)

- Header "Away mode"; subtitle "Mission Control keeps going while you're away, inside these limits"; [Close].
- Control row: segmented Off / On · "Until" date input (default today + 10 days) · status "Away mode is on {until label}." or "Off: everything waits for you as usual." Choosing On/Off saves (`mc5:away` = {on, until}) and toasts "Away mode on {until label}. Safe tickets can reach ready for review; others stay in draft, and comments wait for you." / "Away mode off. Everything waits for you as usual."
- Column 1 "While I'm away, Mission Control may" (checkboxes, all on by default):
  - "Pick up safe tickets from Ready, one fresh run per ticket on its own branch"
  - "Research new tickets and reports, and draft findings for each ticket (posted when you are back)"
  - "Check GitHub (and Teams, from P5) every 30 min for anything about me or my tickets"
  - "Keep my tickets' Status in line with the work (my tickets only)"
  - "Take a safe PR out of draft, label it safe-to-merge and ask its code owner to review"
  - Locked "Always" rows: "Other tickets may be worked to a draft PR (FLIGHT holds the go/no-go gate) and stay in draft, with a walkthrough brief for your return" · "Comments and nudges are drafted and wait for your return" · "Never merges, never posts to Teams, never changes settings, migrations or another team's code"
- Column 2 "A ticket counts as safe when":
  - "Sized XS or S, and a bug, chore, test or docs ticket (labels or issue types, mapped per repo)"
  - "Bug: a reproducing test fails on the base commit and passes on the branch"
  - "Test: only test files change, and the new tests pass"
  - "Docs: only documentation changes"
  - "Chore: no change in behaviour; the existing tests prove it"
  - "Every type: inside one agent's area; no migrations, settings, CI, infrastructure, dependencies, auth or public API; no existing test edited"
  - "Full suite (on the host, or in CI where the host can't run it) and typecheck green, and RETRO finds nothing (with a browser check if a page changed)"
  - "Limits": "Keep 30% of every weekly quota window in reserve" · "At most 4 agents at once" · "Start nothing new while memory is above 80%" · "Park a ticket after 2 failed verify rounds and leave it for you"
- Column 3 "When you come back": "One digest, most urgent first (sample):" tiles 2 "need you now" · 3 "safe PRs ready for review" · 2 "drafts to walk through" · 1 "failed, with the reason" · 14 "decisions FLIGHT made, with reasons" · 6 "messages drafted for you"; note "Also: mentions of you in Teams and GitHub, summarised, and quota spent against the reserve."

### 2.9 Item panel (fly-out `#discuss`, 540px from the right)

Help: "Answer, Open and Read the brief all open one panel for that item: what is asked, why, what FLIGHT checked, your choices, and a chat about it. Every item FLIGHT brings starts with a catch-up: new or follow-up, the story so far, and what to be aware of."

Opened by: Answer / Open / Read the brief / Discuss (asks), Read the brief / Read the brief and reply (people), dock Waiting items, queue ↑, "Open the related decision". Closed by its Close button or Esc.

#### 2.9.1 Ask variant (decision or approval)

- Head: "Decision" or "Approval" · agent tag (who it is for) · "raised by FLIGHT at {HH:MM}" · [Close].
- Brief (scrollable, max 46vh):
  - **Catch-up block** (`ctx`): label "Catch-up" · pill kind (New plain / Follow-up, Old thread amber) + line · "So far" bullet list (story) · "Be aware" bullet list (aware).
  - **Title** (bold) or "What is being asked"; the ask text.
  - Decision: "Why it came to you" + why; "What FLIGHT checked" list (source chip + finding).
  - Approval: "If you approve" + effect.
- Chat: opening FLIGHT message — decision: "Short version: {why} I lean towards "{recommended option}": {its description}. What would help you decide? I can pull the Teams thread or the code."; approval: "Anything you want to check before you decide? I can show the full text, the ticket or the numbers behind it."
- Choices: decision → option cards (name + description; recommended one marked with pill "FLIGHT recommends"); approval → "Your call:" + buttons (first primary). "Edit" option → toast "Opens the draft so you can change it before approving." After answering: "You chose: **{option}**"; your answer is echoed into FLIGHT chat; after 0.7 s FLIGHT replies with the effect text (section 5).
- Input: placeholder "Ask FLIGHT about this…" (aria "Ask FLIGHT about this"); canned replies after 0.9 s: q4 → "Pulled them. Maya's message is in Product rollout on 14 Oct: "each client wants their own lanes, Contoso first". routing.py keys every rule by customer_id, so per customer fits without new plumbing. The admin mock predates that thread. Per customer still looks right to me."; other asks → "Good question. Here is what I found, and I still lean the same way."

#### 2.9.2 Person variant (Asked of you)

- Head: "Asked of you" · **{who}** · "{src} · {where} · {time}" · [Open in {src} ↗] (toast "In the real app this opens {who}'s message itself in {src}: the message's webUrl from Microsoft Graph" / "the comment's html_url from the notification") · [Close].
- Brief: catch-up block (full) · "Earlier in the thread" (author · time · text) · "The message" (blockquote with mentions) · "FLIGHT's assessment" bullet list · related chips · [Open the related decision] (if linked decision unanswered).
- Chat opener: "Here is what I know. {take} I drafted {n} replies below: send one, edit it first, or tell me what you want to say."
- Choices: "Suggested replies" — card per reply: label, pill "FLIGHT suggests" on the first, text, [Post on GitHub] (GitHub; toast "Posted on {where} as you. Clicking Post was your approval."; done "replied on GitHub") or [Copy for Teams] (Teams; toast "Reply copied. Paste it into Teams; Open in Teams takes you to the message." or "Copy was blocked here; select the reply and copy it."; done "reply copied for Teams"), [Edit first] (toast "Opens the reply so you can change it before sending."). Then [Mark handled] (done "marked handled") and [Let FLIGHT handle it] (done "with FLIGHT"; FLIGHT: "I will handle {who}'s message: I will check what is needed, draft a reply and bring it back to you before anything is sent."). When done: "Handled: **{how}**".
- Canned chat replies: Owen (p4) → "NETWORK-1 has just reported: Contoso's listing count on staging dropped 4% after #2308 loaded new SKUs. I would tell Owen it is found and a fix is in progress, and I can raise a bug ticket for GUIDO-2."; others → "I can make the reply fuller, check the ticket first, or ask the agent working on it. Which would help?"

### 2.10 Keys and lamps modal (`#helpModal`)

Header "Keys and lamps" + [Close]. Body (verbatim):
1. "g then o Overview · f FLIGHT · b Board · a Agent · c Comms · t Telemetry · s Setup"
2. "f show or hide FLIGHT · j k next or previous agent · / message the selected agent · i interrupt it · Esc close"
3. "Amber breathes slowly where something waits on you; green breathes where an agent is working. Acknowledge an item to stop its pulse; it clears when you act. Colour always comes with a word, so nothing depends on colour alone. @CAPCOM marks a message addressed to you."
4. "Answer, Open and Read the brief all open one panel for that item: what is asked, why, what FLIGHT checked, your choices, and a chat about it. Every item FLIGHT brings starts with a catch-up: new or follow-up, the story so far, and what to be aware of. Show build status (bottom left) marks every panel with how buildable it is today. This is a clickable mockup with invented data."

---

## 3. Data model implied by the sample data

### 3.1 Constants

- `STALL_MIN = 10` (minutes without output before Stalled).
- `MET_START` = now − 3:12:40.
- `MACH`: cpuOther 6 (%), memTotal 64 (GB), memOther 9.2, memAgentEach 0.42, memTest 3.6, cpuTest 31, diskTotal 1000 (GB), diskFree 412, slots 8 (max agents), perSession 4.
- `PROJECT_URL` = https://github.com/orgs/Northwind/projects/6; `PT_ISSUES` = https://github.com/Northwind/platform-tools/issues.
- localStorage keys (prefix `mc5:`): theme, dock, lane, away.
- Pseudo-random seeded series (seed 7) drive sparklines/charts.

### 3.2 Session

Fields: `id`, `dir`, `branch`, `managed` (checkout made by Mission Control), `folders` (top-level folders for area tiles).

| id | dir | branch | managed | folders |
|---|---|---|---|---|
| mission-control | C:\code\Mission-Control | feat/12-stop-race | — | packages/server, packages/shared, packages/hud, roles, loops, docs, scripts, examples |
| nw-2308 | C:\code\Northwind | feat/2308-sku-supplier | — | backend/catalog, backend/common, backend/reports, backend/fulfilment, frontend/store-admin, docs, .github |
| nw-2315 | C:\code\mc-checkouts\nw-2315 | feat/2315-admin-filters | true | (same NW folders) |
| nw-2358 | C:\code\mc-checkouts\nw-2358 | feat/2358-lane-intake | true | (same NW folders) |

### 3.3 Account (profile) and quota windows

Fields: `name`, `provider` (claude|codex), `plan`, `who` (signed in as), `logged`, `asOf` (quota freshness), `win[]` = {`w` (5h|7d), `used` %, `reset`, `tt` (time to full: "~3h10", "—", "at limit")}.

| name | provider | plan | who | asOf | windows |
|---|---|---|---|---|---|
| claude-main | claude | team | operator@example | 2 min ago | 5h 38% reset 14:00 tt ~3h10; 7d 61% reset Mon 09:00 tt ~2d |
| claude-second | claude | max | operator+2@example | 9 min ago | 5h 24% reset 15:40 tt ~5h; 7d 31% reset Tue 11:00 tt — |
| codex-main | codex | pro | ChatGPT login | live | 5h 9% reset 15:10 tt —; 7d 44% reset Wed 08:00 tt ~4d |
| codex-second | codex | plus | ChatGPT login | live | 7d 100% reset Wed 08:00 tt at limit (no 5h window) |

### 3.4 Head agent (FLIGHT)

`{ call: 'FLIGHT', profile: 'claude-main', model: 'opus', state: 'head', turns: 23, maxTurns: 40, tpm: 600, ctx: 38, doing: 'Waiting on your decisions · watching the test lock' }`. Session rotates after maxTurns ("then a fresh session").

### 3.5 Agent (seat)

Fields: `id`, `call`, `role`, `mode` (writer|readonly), `provider`, `profile`, `model`, `session`, `area[]` (globs; empty for read-only; `**` = whole checkout), `state` (running|stalled|blocked|parked|waiting|idle|stopped|error), `turn`, `doing`, `reason` (parked), `byChoice` (parked by operator choice → not in Needs you), `queued` (queued message count), `ctx` %, `ctxMax` (k tokens), `cacheHit` %, `edits`, `denials` (guard), `tpm` (tokens/min), `color`, `stepSince`, `stats` {tin, tout, cache, cost (~$ API-equivalent), turns, tools, commits, add, del, ttft, tps, avgTurn, compactions, ctxParts {system, tools, messages, free, buffer} (k tokens)}, `live` {tool, since} | null, `loop` {tpl, node, done[], attempt, round, checks[] (pass|fail|run|wait per check of current node), steps {node: tokens}}, `work` {focus, now (ticket ref), next[], done[]}.

| call | role | mode | provider/account/model | session | area | state | turn | doing | ctx | tpm | stats (tin/tout/cache, ~$, turns, tools, commits, +/−, ttft, tps, avgTurn, compactions) | live | loop | work |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GUIDO-1 | backend developer | writer | claude / claude-main / sonnet | mission-control | packages/server/** | running | 4 | Awaiting the run in stop(), capped at 8 s | 61% of 200k, cache 87% | 2100 | 41.2k/18.9k/612k, 1.84, 4, 31, 1, +58 −9, 1.1s, 64, 2m 40s, 0; ctx system 18 tools 22 messages 82 free 62 buffer 16 | Bash npx vitest run packages/server/test/claude-adapter.test.ts (4 s) | feature › implement, done plan, go/no-go; attempt 1 round 1; checks pass, run | focus "Mission Control server · review fixes"; now PT #12; next PT #14, PT #15; done PT #9, PT #11 |
| GUIDO-2 | backend developer | writer | codex / codex-main / gpt-5.6-sol | nw-2308 | backend/catalog/** | stalled | 2 | Verify: the full test suite has printed nothing for 11 min | 34% of 400k, cache 72% | 0 | 58.3k/22.1k/890k, 2.10, 2, 22, 2, +63 −5, —, 51, 6m 05s, 0; ctx 21/9/106/248/16 | just test (full suite, run by Mission Control) (11:02) | bugfix › verify, done reproduce, fix; attempt 2 round 1; checks run, wait, pass | focus "Catalog lane · label catalog, bugs first"; now NW #2308; next NW #2319, NW #2331; done NW #2271, NW #2262 |
| GUIDO-3 | backend developer | writer | claude / claude-second / sonnet | nw-2358 | backend/fulfilment/** | waiting | 6 | Drafting the PR body while it waits for the test lock | 52% of 200k, cache 83% | 0 | 72k/31k/1.24M, 3.05, 6, 48, 1, +228 −6, 1.4s, 58, 4m 10s, 1; ctx 18/22/64/80/16 | null | feature › verify, done plan, go/no-go, implement; attempt 2 round 2; checks wait, wait, pass, wait | focus "Fulfilment lane · label fulfilment"; now NW #2358 |
| NETWORK-1 | researcher | readonly | claude / claude-main / haiku | mission-control | — | running | 8 | Writing up polling vs notifications (FLIGHT chose chats and channels) | 47% of 200k, cache 91% | 900 | 18k/6.4k/220k, 0.21, 7, 19, 0, 0/0, 0.6s, 88, 1m 20s, 0; ctx 16/20/52/96/16 | WebFetch learn.microsoft.com/graph/api/channel-list-messages | research › write-up, done investigate | focus "Questions from FLIGHT and you"; now PT #21; next PT #22 |
| RETRO-1 | reviewer | readonly | claude / claude-second / sonnet | mission-control | — | running | 3 | Re-checking PR #2370 after GUIDO-2's fix | 29% of 200k, cache 79% | 900 | 12.1k/3.3k/140k, 0.44, 3, 17, 0, 0/0, 0.9s, 71, 1m 50s, 0; ctx 16/20/22/126/16 | Read backend/reports/export/views.py | review › findings, done read PR | focus "Reviews in every session"; now NW #2296; done PT #9, NW #2285 |
| INCO-1 | frontend developer | writer | codex / codex-second / gpt-5.6-sol | nw-2315 | frontend/store-admin/** | parked | 5 | Parked: usage limit on codex-second; reason "usage limit on codex-second · resets Wed 08:00"; queued 1 | 0% of 400k, cache 64% | 0 | 51k/24k/700k, 2.40, 5, 37, 1, +144 −12, —, 47, 5m 30s, 0; ctx 21/9/0/354/16 | null | feature › implement, done plan, go/no-go; checks pass, wait | focus "store-admin · label frontend"; now NW #2315; next NW #2340; done NW #2260, NW #2288 |

Colours: s1..s6 in that order. Note: `turn` (drives the Tokens-per-turn chart bar count) and `stats.turns` (shown on the Agent Work tile) differ for NETWORK-1 (8 vs 7).

### 3.6 Loop templates (`TEMPLATES`, "spec section 11", "drawn on a 300-wide grid"; comment: "Edge: [from, to, outcome label, bend]. path = the steps in order, for progress bars.")

Template fields: `trigger`, `rounds`, `budget`, `rules` {step: retry rule}, `path[]`, `nodes[]` {id, role, gate?, max?, checks[[kind, text]]}. Check kinds: cmd, rule, review, gate, agent.

Shared `REVIEW_CHECKS`: [review] "Spec verdict: does what the ticket asks; every acceptance criterion has evidence"; [review] "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)"; [rule] "Blast radius: callers and shared code listed by Mission Control were checked"; [review] "Pages it touches opened in a real browser, with screenshots".

**feature** — trigger "label type:feature"; rounds 3; budget 400k; path plan → go/no-go → implement → verify → review → draft PR; rules: go/no-go "no-go → back to plan"; verify "fail → fix → back to verify · max 3"; review "Critical or Important findings → fix → verify".
- plan — "FIDO, or the assigned GUIDO" — [review] "Plan lists the acceptance criteria as a checklist verify can prove"; [rule] "Every file in the plan sits inside the agent's area"
- go/no-go (gate) — "FLIGHT polls, you decide" — [gate] "FLIGHT polls every check; you make the call"
- implement — "GUIDO" — [cmd] "New test fails on the base commit (Mission Control re-runs it)"; [cmd] "The same test passes on the branch"
- draft PR — "GUIDO" — [rule] "PR is open as a draft"; [rule] "Body lists the deploy steps"
- review — "RETRO, fresh eyes: sees the ticket, plan, diff and check output, not the author's chat" — REVIEW_CHECKS
- verify (max 3) — "Mission Control runs it" — [cmd] "Full test suite passes (takes the test lock)"; [cmd] "Typecheck exits 0"; [rule] "No existing test weakened, skipped or deleted"; [rule] "Diff stays inside the area; no stray files"
- fix (not on path) — "GUIDO" — [agent] "Each finding has a commit or a written ruling"

**bugfix** — trigger "label bug"; rounds 3; budget 250k; path reproduce → fix → verify → review → draft PR; rules: verify "fail → fix → back to verify · max 3"; review "Critical or Important findings → fix → verify".
- reproduce — GUIDO — [cmd] "A test reproduces the bug: fails on the base commit for the reported reason"
- fix — GUIDO — [cmd] "The reproducing test passes"
- verify (max 3) — "Mission Control runs it" — [cmd] "Full test suite passes (takes the test lock)"; [cmd] "Typecheck exits 0"; [rule] "No stray files"
- draft PR — GUIDO — [rule] "PR is open as a draft"
- review — RETRO, fresh eyes (full wording) — REVIEW_CHECKS

**small-change** — trigger "chore, test or docs ticket"; rounds 2; budget 120k; path implement → verify → review → draft PR; rules: verify "fail → back to implement · max 2"; review "Critical or Important findings → implement → verify".
- implement — "GUIDO or INCO" — [rule] "Only the paths this ticket type allows changed (tests for test, docs for docs)"
- verify (max 2) — "Mission Control runs it" — [cmd] "Full test suite passes (takes the test lock)"; [rule] "No existing test weakened, skipped or deleted"
- review — "RETRO, fresh eyes" — REVIEW_CHECKS
- draft PR — "GUIDO or INCO" — [rule] "PR is open as a draft"

**research** — trigger "label research"; rounds 2; budget 150k; path investigate → write-up → review; rules: review "gaps → write-up again".
- investigate — NETWORK — [agent] "Every claim cites a file, doc, URL or message"
- write-up — NETWORK — [agent] "One-line answer first, then the evidence"
- review — "RETRO (hand-off)" — [review] "A second agent re-checked each citation"

**review** — trigger "PR opened in a lane"; rounds 1; budget 120k; path read PR → findings → propose; no rules.
- read PR — RETRO — [agent] "Diff read against the ticket's intent"
- findings — RETRO — [agent] "Each finding has file:line and a failure scenario"
- propose — RETRO — [gate] "Comments wait for your approval; nothing posts on its own"

**tiger-team** — trigger "FLIGHT or you, for a blocker or a big ticket"; rounds 2; budget 600k; path split → work ×N → verify each → combine → review; rules: work ×N "runs in parallel, one sub-task per agent"; verify each "fail → that sub-task again · max 2"; review "findings → fix the combined branch".
- split — FLIGHT — [rule] "Sub-tasks have areas that don't overlap"
- work ×N — "GUIDO ×N in parallel" — [cmd] "Each sub-task's scoped tests pass"
- verify each (max 2) — RETRO — [review] "A verifier confirms each result"
- combine — GUIDO — [cmd] "Combined branch passes the full suite (takes the test lock)"
- review — "RETRO, fresh eyes" — REVIEW_CHECKS

**watch** — trigger "every 10 min"; rounds 0 (∞); budget —; path poll → triage → assign; rules: assign "then poll again in 10 min".
- poll — "Mission Control" — [rule] "Board reachable; new or changed tickets listed"
- triage — FLIGHT — [agent] "Each ticket matched to a lane and a template"
- assign — FLIGHT — [gate] "Starting an agent waits for you unless auto-approved"

`RETRY_NOTE` (verbatim in 2.4.5).

### 3.7 Loop run records (`RUNS`: [step, try, outcome, tokens, minutes]; "A fix row belongs to the step just before it", unless the template has its own fix step)

- guido-1: plan 1 pass 9800 12m; go/no-go 1 go 600 3m; implement 1 running 30800 30m
- guido-2: reproduce 1 pass 21400 18m; fix 1 pass 38800 42m; verify 1 "fail: test DB locked" 12100 9m; verify 2 running 16100 11m
- guido-3: plan 1 pass 14100 15m; go/no-go 1 go 500 40m; implement 1 pass 61200 95m; verify 1 "fail: 2 tests in test_lane_intake.py" 7200 8m; fix 1 pass 9800 14m; verify 2 "waiting for the test lock" 0 6m
- network-1: investigate 1 pass 23900 160m; write-up 1 running 2100 3m
- retro-1: read PR 1 pass 8100 6m; findings 1 running 4400 3m
- inco-1: plan 1 pass 12100 10m; go/no-go 1 go 400 5m; implement 1 "parked: usage limit" 49200 70m

### 3.8 Agent task lists (`PLANS`; "The agent's own task list (Claude TaskCreate/TaskUpdate tools; Codex plan updates).")

- guido-1: Write a failing test for the stop() race (done); Keep the pump promise on Run (done); Await it in stop(), capped at 8 s (in_progress); Run the adapter tests (pending); Commit and ask for the draft PR (pending)
- guido-2: Reproduce the missing supplier column (done); Add the supplier column to the feed loader (done); Pass verify (full suite) (in_progress); Ask for the draft PR (pending)
- guido-3: Lane table keyed by label (done); Intake on the webhook (done); Admin page to edit lanes (done); Pass verify (full suite) (pending); Draft the PR body (in_progress)
- network-1: List Graph endpoints for chats and channels (done); Check delegated permissions (done); Write up polling vs notifications (in_progress)
- retro-1: Read the diff against the ticket (done); Re-run the export tests (in_progress); Write findings with file and line (pending)
- inco-1: Filter state in the URL (done); Filter chips above the table (in_progress); Tests for clearing filters (pending)

### 3.9 Subagents (`SUBAGENTS`: type, task, status, tokens, tools, dur)

- guido-1: Explore — Find every caller of stop() — completed, 18,400, 14, 0:42
- guido-3: Explore — Map the fulfilment webhook handlers — completed, 22,100, 19, 1:05; general-purpose — Check the admin page against the design notes — completed, 9,800, 6, 0:31
- network-1: general-purpose — Read the Graph permissions reference — completed, 6,200, 4, 0:20
- retro-1: Explore — Find tests that touch the export endpoint — running, 3,100, 5, 0:18

### 3.10 Test lock (`LOCK`)

- `holder`: {agent guido-2, cmd "just test", label "NW full suite", ticket NW #2308, session nw-2308, since now−11:02, typical 9 min, quietSince now−11:00}
- `queue[]`: [{agent guido-3, cmd "just test", label "NW full suite", ticket NW #2358, session nw-2358, since now−6:10}]
- `history[]` {agent, label, cmd, at, dur, wait, outcome}: GUIDO-1 "Mission Control full suite" npm test, 96 min ago, 3:58, wait 0:00, passed; INCO-1 "store-admin full suite" npm test, 88 min ago, 2:31, 0:00, passed; GUIDO-2 "NW full suite" just test, 41 min ago, 9:12, wait 2:40, "failed: test DB locked".
- Derived: `lockBlocked` = holder stalled and queue non-empty.

### 3.11 Guard events (`alerts`: id, agent, rule, text, acked, t)

- 2: GUIDO-1, rule "git push", "git push denied: git writes go through the mc tools", 9 min ago
- 3: GUIDO-2, rule "gh api (non-GET)", "gh api -X POST denied: GitHub writes need your approval", 24 min ago

### 3.12 Stray changes (`STRAYS`)

[{session mission-control, file README.md, since 6 min ago}]

### 3.13 Files changed (`FILES`: path, +, −, sha|uncommitted)

- guido-1: packages/server/src/adapters/claude/adapter.ts +14 −3 uncommitted; packages/server/test/claude-adapter.test.ts +38 −2 a3f19c2; packages/server/src/supervisor/switch.ts +6 −4 uncommitted
- guido-2: backend/catalog/tests/test_sku_supplier.py +41 −0 5d0e2b1; backend/catalog/feeds/sku_loader.py +22 −5 8b1e0f4
- guido-3: backend/fulfilment/intake/lanes.py +96 −4 c71a2d9; backend/fulfilment/tests/test_lane_intake.py +120 −0 c71a2d9; backend/fulfilment/admin.py +12 −2 e02b5a1
- inco-1: frontend/store-admin/src/Filters.test.tsx +56 −0 91c4a07; frontend/store-admin/src/Filters.tsx +88 −12 uncommitted

### 3.14 Stream events (`STREAM`; event = {k, t, at, …}; kinds op, think, tool {dur, res}, msg, ask {ref}, a2a (text "→ CALL: …" / "← CALL: …", optional tag, seen), guard, sys)

- guido-1: op "Fix the stop() race in the Claude adapter so switchProfile can resume. Test first." · think "stop() resolves after close(), but the run stays registered until the iterator ends." · tool "Read packages/server/src/adapters/claude/adapter.ts" 0.1s "172 lines" · msg "Plan: keep the pump promise on Run and await it in stop(), capped at 8 s." · tool "Edit packages/server/test/claude-adapter.test.ts" "+38 −2" · tool "Bash npx vitest run packages/server/test/claude-adapter.test.ts" 3.4s "1 failed (expected): isLive was true after stop()" · sys "Check passed: a new test was run and seen failing." · guard "Bash git push → denied: git writes go through the mc commit and push tools." · tool `mc.commit ["packages/server/test/claude-adapter.test.ts"] "test: stop() waits for the run"` 0.4s a3f19c2 · a2a "→ RETRO-1: Draft PR coming in about 10 min; focus on the stop() race tests." · a2a "← RETRO-1: Ack. I'll run the adapter tests against a slow-close fake."
- guido-2: a2a "← FLIGHT: Assigned NW #2308 (bug): feed SKUs lack a supplier column." · tool Read backend/catalog/models/sku.py "88 lines" · tool Edit backend/catalog/tests/test_sku_supplier.py "+41 −0" · sys "Check passed: the test reproduces the bug and fails for the reported reason." · tool Edit backend/catalog/feeds/sku_loader.py "+22 −5" · a2a "→ RETRO-1: Fixed the null export path you flagged on PR #2370; same branch." · a2a "← RETRO-1: Thanks, re-checking now." · sys "Verify try 1 failed: the full suite hit a locked test database. Try 2 queued for the test lock." · ask (ref q1) "propose_write: comment on NW #2308 "Root cause found: feed SKUs lack a supplier column. Fix and test are on feat/2308-sku-supplier." · waiting for your approval through FLIGHT" · guard "gh api -X POST …/issues/2308/comments → denied: GitHub writes need your approval." · sys "Took the test lock. Mission Control is running: just test" · a2a "← FLIGHT: Report what the run is waiting on. (queued: arrives when the run returns)"
- guido-3: a2a "← FLIGHT: Assigned NW #2358 (feature): lane intake for fulfilment tickets." · msg "Plan: a lane table keyed by label, intake on the webhook, an admin page to edit lanes." · sys "Go: you approved the plan." · tool Edit …/test_lane_intake.py "+120 −0" · tool Edit …/intake/lanes.py "+96 −4" · ask (ref q4) "Lanes per customer, or one global list? The ticket, the code, the design and a Teams thread disagree. FLIGHT sent you a brief." · tool `mc.commit 3 paths "feat: lane intake for fulfilment tickets"` c71a2d9 · sys "Verify needs the NW full suite. In line for the test lock behind GUIDO-2." · a2a (tag) "→ FLIGHT: Waiting on the lock behind GUIDO-2. @CAPCOM could you check GUIDO-2's run? It's well past its usual time." · a2a "← FLIGHT: Flagged to the operator. Draft the PR body while you wait."
- network-1: a2a "← FLIGHT: Find how Mission Control can read Teams chats and channels without an HTTPS endpoint." · tool WebFetch learn.microsoft.com/graph/api/chat-list-messages 1.2s ok · think "Delegated change notifications need a public HTTPS endpoint, so polling with filters is the realistic path." · a2a "→ FLIGHT: Should polling cover channel messages too, or chats only?" · a2a "← FLIGHT: Chats and channels. Admin consent for channel messages was granted on 9 Oct, and PT #21 asks for both." · tool WebFetch …/channel-list-messages 1.0s ok
- retro-1: mirror a2a with GUIDO-1 and GUIDO-2 · tool Read backend/reports/export/views.py "140 lines"
- inco-1: a2a "← FLIGHT: Assigned NW #2315 (feature): filters for the store-admin table." · tool Edit Filters.test.tsx "+56 −0" · sys "Check passed: a new test was run and seen failing." · tool Edit Filters.tsx "+88 −12" · sys "Parked: usage limit reached on codex-second (weekly window)." · a2a "← GUIDO-2: Not until #2308 merges; mock the SKU supplier for now. (queued until INCO-1 resumes)"

### 3.15 FLIGHT conversation and asks (`FLIGHT_MSGS`)

Message kinds: op (you), flight, sys, ask. Ask fields: `id`, `kind` (approval|decision), `about` (agent id), `ctx` {kind (New|Follow-up|Old thread), line, story[], aware[]}, `title`, `t` (text), approval: `effect`, `opts[]`; decision: `why`, `checked[[source, finding]]`, `options[[name, description]]`, `rec` (index); `ans`.

1. op "Morning. What needs me?"
2. flight "@CAPCOM four things. GUIDO-2's full-suite run has printed nothing for 11 minutes and it holds the test lock, so GUIDO-3 is waiting behind it. Stopping that run is your call: the button is on the machine panel. Below: one decision with a brief, and two routine approvals. I answered six agent questions myself; they are on my page if you want to check them."
3. ask **q1** approval about guido-2 — t "GUIDO-2 wants to post on NW #2308: "Root cause found: feed SKUs lack a supplier column. Fix and test are on feat/2308-sku-supplier." Post it?" — ctx New "GUIDO-2's first comment on NW #2308. Owen (who reported it) is waiting for a root cause." aware ["Owen's Contoso question in Asked of you may be the same issue; this comment would answer part of it."] — title "Post GUIDO-2's comment on NW #2308?" — effect "Mission Control posts the comment on NW #2308 as you. Nothing else changes." — opts Approve / Edit / Deny.
4. ask **q4** decision about guido-3 — t "GUIDO-3 needs this before the lane admin page goes to review." — ctx Follow-up "Raised today by GUIDO-3, but the question has been open since Maya first asked on 9 Oct." story ["9 Oct: Maya asked for per-client lanes in Teams; no reply.", "12 Oct: the ticket was written as "configurable lanes".", "Today: GUIDO-3 reached the admin page; Maya asked again."] aware ["Maya is waiting too (Asked of you); one answer covers both.", "The Contoso pilot is on 3 Nov."] — title "NW #2358: lanes per customer, or one global list?" — why "The sources disagree and the choice changes the data model, so it is a product call." — checked: Ticket NW #2358 "asks for "configurable lanes" but not who configures them"; Code "fulfilment routing already keys every rule by customer (backend/fulfilment/routing.py)"; Teams "Maya R in Product rollout, 14 Oct: "each client wants their own lanes""; Design "the admin mock shows one global list" — options: "Per customer" — "matches the routing and Maya's ask; adds a customer picker to the admin page; about half a day more" (recommended); "One global list" — "matches the mock and is simplest; needs rework if clients diverge"; "Global now, per customer later" — "ships the mock as it is and files a follow-up ticket".
5. ask **q3** approval about inco-1 — t "INCO-1 hit the weekly limit on codex-second. Move it to codex-main (56% left this week) and resume turn 5?" — ctx New "INCO-1 parked 62 minutes ago when codex-second hit its weekly limit; that resets Wed 08:00." aware ["codex-main also runs GUIDO-2, so this uses its weekly quota (44% used).", "Waiting costs about a day and a half on NW #2315."] — title "Move INCO-1 to codex-main?" — effect "INCO-1 moves to codex-main, resumes turn 5 and gets its queued message. codex-main has 56% of its week left." — opts Approve / Wait for reset.
6. op "This week: GUIDO-2 stays on the Catalog lane, SKU and supplier bugs first. INCO-1 takes store-admin."
7. flight "Done. GUIDO-2 has #2308 now, then #2319 and #2331 from Ready. INCO-1 has #2315, then #2340. The order follows Priority on the delivery board; I'll ask you before I change any Priority."

Dynamically created asks: `reorder:{agent}:{i}` (queue ↑) and `new:{CALL}` (added agent). Dead branch: `q2` (NETWORK-1 blocked question) has an effect handler but no sample ask.

### 3.16 Ticket (board item, `BOARD`)

Fields: `ref` ("NW #n" / "PT #n"), `title`, `status` (one of STATUSES), `prio` (P0–P2, optional), `size` (XS/S/M/L/XL, optional), `labels[]`, `ms` (milestone), `agent`, `reviewing` (reviewer agent), `pr` {n, ci (passing…), review (draft|requested|approved|merged|changes), note}, `you` (action the operator must take), `since`, `blocked` (reason), `outcome` (merged|closed, for Done), `days` (days since Done).
STATUSES order: Backlog, Refinement, Blocked, Ready, In progress, In review, Ready for QA, Done.

| ref | title | status | prio | size | labels | milestone | agent / extra |
|---|---|---|---|---|---|---|---|
| NW #2308 | Feed SKUs carry their supplier | In progress | P1 | M | catalog, bug, backend | P1 — Quality and product completion | guido-2 |
| NW #2315 | Filters for the store-admin table | In progress | P2 | M | frontend, enhancement | P2 — Next up | inco-1 |
| NW #2358 | Lane intake for fulfilment tickets | In progress | P1 | L | fulfilment, backend | P1 — Quality and product completion | guido-3 |
| PT #12 | Claude stop() waits for the run to end | In progress | — | — | mission-control | — | guido-1 |
| PT #21 | Teams polling options | In progress | — | — | mission-control, research | — | network-1 |
| NW #2319 | Backfill SKU suppliers for existing feeds | Ready | P1 | S | catalog, backend | P1 — Quality and product completion | — |
| NW #2331 | Deduplicate SKUs across catalogues | Ready | P2 | M | catalog, backend | P2 — Next up | — |
| NW #2340 | Export the store-admin table to CSV | Ready | P2 | S | frontend | P2 — Next up | — |
| NW #2346 | Price Editor keeps its filter when a modal closes | Ready | P2 | S | price-editor, frontend, bug | P2 — Next up | — |
| PT #14 | Codex PreToolUse hook for conditional guard rules | Ready | — | — | mission-control | — | — |
| PT #15 | Cap the interrupt wait in stop and shutdown | Ready | — | — | mission-control | — | — |
| PT #22 | Graph delta-query limits | Ready | — | — | mission-control, research | — | — |
| NW #2302 | Remove the old custom-rules command once every environment has migrated | Blocked | P1 | XS | catalog, type:refactor | P1 — Quality and product completion | blocked "waits on the production migration" |
| NW #2361 | Customers link custom pricing rules to brands and categories | Refinement | P1 | L | catalog, backend | M12 Catalog | — |
| NW #2366 | Date presets on the sales analytics page | Refinement | P2 | S | sales-analytics, frontend | P2 — Next up | — |
| NW #2277 | Short display names for product categories | Backlog | P2 | M | catalog, backend | — | — |
| NW #2290 | Price Editor works on a phone | Backlog | P2 | L | price-editor, frontend, bug | — | — |
| NW #2349 | Retry failed fulfilment imports from the admin page | Backlog | — | — | fulfilment | — | — |
| NW #2296 | Reports export endpoint | In review | P1 | M | backend | — | guido-2; reviewing retro-1; PR 2370 CI passing, review requested, note "RETRO-1 re-checking after a fix" |
| NW #2299 | Retry fulfilment webhook deliveries | In review | P2 | S | fulfilment, backend | — | guido-2; PR 2368 passing, requested, "code owner asked 2 days ago" |
| NW #2285 | Barcode loader handles empty files | In review | P2 | XS | catalog, bug | — | guido-2; PR 2363 passing, draft, "draft · RETRO-1 clean"; you "mark the PR ready for review", since 5h |
| NW #2288 | Date filter on the reports page | In review | P2 | S | frontend | — | inco-1; PR 2365 passing, approved, "approved by the code owner"; you "merge it", since 1d |
| NW #2271 | Feed loading order | Ready for QA | P1 | S | catalog | — | guido-2; PR 2355 passing, merged, "on staging · QA to check" |
| NW #2260 | store-admin sort crash | Done | P1 | — | frontend, bug | — | inco-1; merged 1d; PR 2350 |
| NW #2262 | Feed version checker | Done | P2 | — | catalog | — | guido-2; merged 6d; PR 2341 |
| NW #2266 | SKU import retry (superseded by #2308) | Done | — | — | catalog | — | guido-2; closed 1d; PR 2344 |
| PT #9 | Route-based API auth | Done | — | — | mission-control | — | guido-1; merged 1d; PR 7 |
| PT #11 | Commits use literal pathspecs | Done | — | — | mission-control | — | guido-1; merged 0d; PR 8 |
| NW #2231 | Admin pages show where a product sits | Done | P1 | — | catalog, admin | — | guido-2; merged 12d; PR 2302 |

### 3.17 Lanes (saved views, `LANES`: id, name, query, match, url)

- mine "All mine" — `assignee:@me` — matches all — `{PROJECT_URL}?filterQuery=assignee%3A%40me`
- catalog "Catalog lane" — `assignee:@me label:catalog` — label catalog
- price "Price Editor" — `label:price-editor`
- fulfil "Fulfilment" — `label:fulfilment`
- mc "Mission Control" — `repo:Northwind/platform-tools is:issue` — ref starts with PT — `{PT_ISSUES}?q=is%3Aissue`

### 3.18 Folder ownership (areas)

Writer agents own globs (`backend/catalog/**` etc.); a folder tile is owned if an agent area equals it, is `**`, or is a parent. Read-only agents own nothing. Areas cannot overlap; a writer with no picked folders gets `**` (whole checkout) and is refused if another active writer exists in that session.

### 3.19 People / asks of the operator (`PEOPLE`; comment: "People waiting on a reply from the operator: from GitHub notifications (mention, review_requested, comment) and Teams messages that mention them.")

Fields: `id`, `who`, `src` (Teams|GitHub), `where`, `at`, `urgency`, `ctx` {kind, line, story[], aware[]}, `snippet`, `thread[[who, at, text]]`, `take`, `assess[]`, `related[]`, `decision` (linked ask id), `replies[[label, text]]`, `done`.

- **p1 Maya R** — Teams, "Product rollout channel", 44 min ago, urgency "Contoso pilot starts 3 Nov". ctx Follow-up "Second time she has asked. She first raised per-client lanes on 9 Oct in the same channel, and nobody replied." story: "9 Oct: Maya asked for per-client lanes; no reply." / "12 Oct: NW #2358 was written as "configurable lanes", leaving the question open." / "14 Oct: Jon booked the Contoso pilot for 3 Nov." / "Today: GUIDO-3 reached the lane admin page and needs the same answer." aware: "Contoso is the first client on the new lanes, and the pilot date is fixed." / "Answering her also settles the open decision on NW #2358." Snippet "@Alex can we get per-client lanes in before the Contoso pilot? Each client wants their own lanes, Contoso first." Thread: Jon P (51 min) "The Contoso pilot is booked for 3 Nov."; Maya R (46 min) "Their ops team will want to edit lanes themselves." Take "This is the open lanes decision on NW #2358; answering that decision answers her." Assess: "Maya wants lanes per client before the Contoso pilot on 3 Nov." / "That is the open decision on NW #2358, where FLIGHT recommends per customer." / "If you choose per customer, GUIDO-3 can have it in review this week." Related NW #2358; decision q4. Replies: "Yes, per client" — "Yes, we are building lanes per client on #2358, and Contoso's will be ready before the pilot. I will confirm the date once it is in review."; "One list first" — "We are shipping one shared lane list first and per-client lanes straight after, so Contoso can start on the shared list. I will confirm timing this week."; "Ask what differs" — "Which settings differ per client: only the lane names, or the routing rules as well?"
- **p4 Owen T** — Teams, "Support questions (group chat)", 21 min ago, urgency "A client noticed". ctx New "New today. Owen has not raised Contoso listings before; the same chat had a similar Fabrikam report on 22 Sep." story: "22 Sep: Fabrikam listings went missing after a feed change; fixed, then a relist." / "Tue 14 Oct: NW #2308 reached staging and changed how feed SKUs load." / "Today: Owen reports Contoso gaps since Tuesday." aware: "A client noticed, so expect follow-ups from account management." / "The Fabrikam fix needed a relist afterwards; this one may too." Snippet "Alex, are catalog listings missing for Contoso since Tuesday? The client spotted gaps on their dashboard." Thread: Owen T (23 min) "Morning all, quick one on Contoso." Take "Probably the NW #2308 feed change on staging; NETWORK-1 is confirming by 14:30." Assess: "Owen reports missing catalog listings for Contoso since Tuesday, and the client has noticed." / "NW #2308 changed how feed SKUs load and reached staging on Tuesday, so the timing fits." / "NETWORK-1 is comparing listing counts before and after; its report is due at 14:30." Related NW #2308, NW #2271. Replies: "Looking into it" — "Thanks Owen. We are looking into it now and think it is linked to a feed change on staging. Update by 15:00."; "Ask for detail" — "Which listings, and which dashboard? A screenshot would help us trace it quickly."
- **p2 Lena** — GitHub, "PR #2372, review comment", 48 min ago, urgency "Her review is waiting". ctx New "New question on a PR opened yesterday. Lena is the code owner for reports." story: "Yesterday: PR #2372 opened for NW #2296 (reports export)." / "This morning: RETRO-1 found nothing; Lena started her review." aware: "Her review is the last thing before merge; CI is green." / "She also has a QA question waiting on #2271 (in Drafts)." Snippet "@alex-doe is the export meant to include archived listings? The ticket does not say." Thread empty. Take "The ticket is silent; the existing CSV export leaves archived listings out, so matching it is the consistent choice." Assess: "Lena is reviewing PR #2372 and is blocked on whether archived listings belong in the export." / "NW #2296 says nothing about archived listings." / "The existing CSV export leaves them out (backend/reports/export/csv.py)." Related PR #2372, NW #2296. Replies: "Leave them out" — "No, leave archived listings out to match the existing CSV export. I will add that to the ticket."; "Include them" — "Yes, include them, with a column showing they are archived. I will update the ticket."
- **p3 Ravi** — GitHub, "NW #2290", 37 min ago, no urgency. ctx Old thread "An old thread coming back. Ravi first asked on 2 Sep and you replied "next month"; that was six weeks ago." story: "2 Sep: Ravi asked if it was planned; you said next month." / "Since then it has stayed P2 in Backlog." aware: "Your last answer promised next month, and it slipped; say so." / "Ravi is in account management; the request came from a client." Snippet "@alex-doe is this still planned?" Take "P2 in Backlog with no agent; nothing blocks it." Assess: "Ravi asks whether NW #2290 (Price Editor on a phone) is still planned." / "It is P2 in Backlog, not scheduled, with no agent assigned." Related NW #2290. Replies: "Still planned" — "Still planned. It is P2 in the backlog; I will update here when it is picked up."; "Not this quarter" — "Not this quarter. It is in the backlog at P2; I will update here if that changes."

### 3.20 Incoming (`INCOMING`: at, src, text, outcome, detail)

- 52 min, GitHub, "Review requested on PR #2372 by Lena" → Assigned — "RETRO-1 does a first pass; you get its summary."
- 48 min, GitHub, "Lena asked you on PR #2372 about archived listings" → Asked of you — "Her review is waiting on it; it is in Asked of you with FLIGHT's take."
- 44 min, Teams, "Maya R asked you in Product rollout about per-client lanes" → Asked of you — "Linked to the open lanes decision on NW #2358."
- 37 min, GitHub, "Ravi asked you on NW #2290 whether it is still planned" → Asked of you — "It is P2 in Backlog; a reply is drafted."
- 30 min, Board, "New ticket NW #2375 "Export filter presets" (frontend, S)" → Queued — "Matches INCO-1's lane, after #2340. Counts as a safe ticket."
- 21 min, Teams, "Owen T asked you in the support chat about missing Contoso listings" → Asked of you — "May relate to the NW #2308 feeds; NETWORK-1 reports by 14:30."
- 9 min, GitHub, "CI failed on staging after PR #2361 (not ours)" → No action — "Another team's PR; nothing of ours is affected."

### 3.21 Watch items (`WATCH`: lvl warn|info|ok, ctx, title, detail, next, btn stoprun|drafts)

- warn — ctx New "Started 14:02; a full run usually takes about 25 minutes and prints every few seconds." — "GUIDO-2's full-suite run has printed nothing for 11 min" — "It holds the test lock, so GUIDO-3 is waiting." — Next "Now: asked you to stop the run" — [Stop the run]
- warn — Follow-up "Second check. Jon usually reviews ours within a day." — "PR #2368 waiting on its code owner for 2 days" — "Jon P. CI green, RETRO-1 clean." — "Nudge drafted" — [See draft]
- warn — Follow-up "Reached staging on Tue 14 Oct. Lena also has a review question waiting on you (PR #2372)." — "NW #2271 on staging for 2 days, QA not started" — "QA owner: Lena." — "Nudge drafted" — [See draft]
- info — New "Reported today by Owen; it is also in Asked of you." — "Contoso listing gap reported in the support chat" — "Could relate to the NW #2308 feed changes." — "NETWORK-1 reports by 14:30"
- info — New "Spotted this morning when #15 was queued." — "PT #12 and PT #15 both touch adapter.ts" — "Sequenced: #15 starts after #12's PR merges." — "After #12 merges"
- info — Follow-up "Maya reported it on 10 Oct; nobody has asked her for details since." — "NW #2346 has no acceptance criteria" — "In Ready, P2, unassigned." — "Question drafted for the reporter" — [See draft]
- ok — Old thread "Blocked since 9 Oct, waiting on the Monday deploy." — "NW #2302 blocked on the production migration" — "Deploy notes say Monday." — "Re-check Mon 09:00"
- ok — Follow-up "INCO-1 parked when codex-second hit its weekly limit this afternoon." — "codex-second resets Wed 08:00" — "INCO-1 stays parked until then unless you move it." — "Resume Wed 08:00"

### 3.22 Drafts (`DRAFTS`: id, to, via GitHub|Teams, where, ctx, text, done)

- d1 — Jon P — GitHub — PR #2368 — ctx "First nudge. The PR has waited 2 days; Jon usually reviews ours within a day." — "Hi Jon, PR #2368 (retry fulfilment webhook deliveries) has been ready for your review for two days. CI is green and our reviewer found nothing. Could you take a look when you have a moment?"
- d2 — Lena — Teams — direct message — ctx "Lena also has a question for you on PR #2372; answer that first so this is not the only message from you." — "Hi Lena, #2271 (feed loading order) has been on staging since Tuesday. Is QA picking it up this week?"
- d4 — Maya R — GitHub — NW #2346 — ctx "Maya reported #2346 on 10 Oct and has not been asked anything since. She is also waiting on you about lanes." — "Could you add acceptance criteria? For example: which modal, and should the filter survive a page reload?"

### 3.23 Decisions FLIGHT made (`DECIDED`: at, about, q, a, basis, over)

- 16 min, network-1 — "Poll Teams channel messages too, or chats only?" — "Chats and channels" — "Admin consent for channel messages was granted on 9 Oct, and PT #21 asks for both."
- 34 min, guido-1 — "Cap stop() at 8 s or 10 s?" — "8 s" — "Matches the existing interrupt timeout in supervisor/switch.ts."
- 58 min, guido-2 — "Backfill SKU suppliers in a migration or a management command?" — "Management command" — "The repo keeps data backfills as re-runnable commands (docs/backfills.md)."
- 75 min, retro-1 — "Is the empty-export path in scope for #2296?" — "Yes, fix it in this PR" — "Acceptance criterion 3 covers empty results."
- 96 min, inco-1 — "Keep filter state in the URL?" — "Yes" — "Pop-out windows must agree (Lena in Teams, 8 Oct)."
- 140 min, guido-3 — "Retry a flaky fulfilment test, or fail verify?" — "Retry once, then report" — "Known flake, tracked in NW #2201."

### 3.24 FLIGHT's plan for today (`PLAN_TODAY`: [minutes from now, what, when-label for later items])

[8, "Board and notifications poll (every 10 min)"], [26, "claude-main 5-hour window resets"], [52, "NETWORK-1 reports on the Contoso listing gap"], [84, "Re-check PR #2368 after the nudge"], [190, "Standup brief ready"], [later, "codex-second resets; resume INCO-1", "Wed 08:00"], [later, "NW #2302: check the migration has run", "Mon 09:00"].

### 3.25 Situation text (`SITUATION`) — verbatim in 2.2.1.

### 3.26 Activity rows

Row = {t (HH:MM:SS), agent, kind (step|check|commit|pr|state|lock|guard|comms|tool|think|file|msg|usage), text, res, ticket, from/to for comms}. Seeds (`ACT_SEED`, minutes ago): 42 GUIDO-1 step "Started implement on PT #12"; 39 RETRO-1 step "Started re-checking PR #2370"; 32 GUIDO-2 check "Verify try 1 failed: test DB locked"; 29 GUIDO-1 check "Check passed: a new test was seen failing"; 24 GUIDO-2 guard "gh api -X POST denied (GitHub writes need approval)"; 16 NETWORK-1 step "investigate → write-up on PT #21 (FLIGHT answered its question)"; 11 GUIDO-2 lock "Took the test lock: NW full suite"; 9 GUIDO-1 guard "git push denied: use the mc push tool"; 8 GUIDO-1 commit "Committed a3f19c2 "test: stop() waits for the run""; 8 GUIDO-3 commit "Committed c71a2d9 "feat: lane intake for fulfilment tickets""; 7 GUIDO-3 step "implement → verify on NW #2358"; 6 GUIDO-3 lock "In line for the test lock behind GUIDO-2"; 3 RETRO-1 step "read PR → findings on PR #2370"; 1 GUIDO-2 state "Running → Stalled: no output for 10 min".
A2A seeds (`A2A_SEED`): guido-2→flight "Verify try 1 failed on a locked test DB; queued try 2 for the test lock."; flight→guido-2 "Status on verify?"; network-1→flight "Should polling cover channel messages too, or chats only?"; flight→network-1 "Chats and channels: admin consent was granted on 9 Oct."; guido-1→retro-1 "Draft PR coming in about 10 min; focus on the stop() race tests."; retro-1→guido-1 "Ack. I'll run the adapter tests against a slow-close fake."; guido-3→flight "Waiting on the lock behind GUIDO-2. @CAPCOM could you check GUIDO-2's run?"; flight→guido-2 "Report what the run is waiting on."; flight→guido-3 "Flagged to the operator. Draft the PR body while you wait."
Simulation pools: `A2A_POOL` (flight→guido-1 "Status? RETRO-1 is free once your PR is up."; guido-1→flight "Scoped tests pass locally; asking for the draft PR next."; retro-1→guido-2 "One more nit on PR #2370: the export filename should include the date."; guido-2→retro-1 "Will fold it in once verify passes."; guido-1→retro-1 "Pushed the fix for the timer leak; same branch."; guido-3→flight "PR body drafted; deploy steps listed."), `STEP_POOL` (e.g. "Scoped tests pass: claude-adapter.test.ts", "Committed 4be81d0 "fix: wait for the run to end"", "Full suite: 1,204 passed so far, 0 failed", "Export tests pass on the fixed branch", "findings → propose on PR #2370", "Write-up cites every Graph endpoint it names", "Filters.test.tsx passes", "Committed 2c9d4e1 "feat: filter chips""), `LOG_LINES` (tool/think/file lines per agent, e.g. "The fake ends the stream on the same tick, which hides the race.", "Delta queries page through changes since a token.", "The filename fix holds; check the empty-result path next.", "M packages/server/src/adapters/claude/adapter.ts +14 −3").

### 3.27 Attention item (derived)

{key, kind, who, text, ask?, person?, chan?, agent?, lock?, board?, stray?}. `acked` = set of keys. `unread` = {agentId: count}. Kinds and order in 2.5.1.

### 3.28 Telemetry series

- `SERIES`: per agent {name, color, values[60]} tokens/min, base [2100, 1400, 1700, 900, 900, 1200], gaps by state (stalled from 82%, parked from 50%, blocked 73%, idle 25%, waiting 90%).
- Range minutes: 1h 60, 6h 360, 24h 1440, 7d 10080; history 72 points.
- KPI baselines add sample offsets (tokens +1.84M, cost +$21.60, turns +61, tools +512, commits +9, lines +1960, merged +6).
- Throughput per day: [2,3,1,4,3,2,5,1,3,4,2,3,4,3] with weekends 0.
- Cycle time, quality, CAPCOM, utilisation, tool latency: values in 2.6.
- Cost bars use $0.0000045 per token as the ~cost rate.

### 3.29 Away settings

`away` {on: bool, until: 'YYYY-MM-DD' | ''}; checkboxes aw1–aw5 (UI only).

### 3.30 Notifications settings (UI only)

n0–n7 as in 2.7.6, n8 Soft chime, quiet hours 19:00–08:00.

### 3.31 Devices

Mac (runs Mission Control and the agents; this machine); Work laptop (Windows) viewer via `https://mission-control.your-tailnet.ts.net`.

---

## 4. Build-status notes (verbatim)

Status classes in the script: `proven` (chip colour green, legend "Proven — tested against the real thing"), `build` (grey, "Buildable — standard work"), `later` (accent, "P2 — waits on an engine not built yet"), `check` (amber, "Check first — a small test before relying on it"). Script comment (L1135–1136): "How buildable each panel is today. proven = tested against the real thing (spike, P1a tests, or checked on 16 Oct); build = standard work; later = waits on an engine not built yet; check = an unknown to test before relying on it." The chip *label* varies per item (shown below); the note is the hover tooltip. Separately, static `P2` phase badges appear (and hide when build status is on) on: Situation, Threads, Auto-approve, FLIGHT dock header. Sources › Teams carries a static pill "P5"; Away mode mentions "Teams, from P5".

| Page | Panel (selector) | Status class | Chip label | Note (verbatim) |
|---|---|---|---|---|
| Overview | Agents (#agentsP) | proven | Proven | State, live tool and timer, tokens, context and quota come from events P1a already maps (spike and P1a tests). |
| Overview | Agents (#agentsP) | later | Loop step: P2 | The loop-step column needs the loop engine. |
| Overview | Agents (#agentsP) | build | ~cost | Claude cost is the difference between run totals (P1a). Codex sends no cost, so a price table gives an estimate. |
| Overview | Activity (#actP) | proven | Proven | Every row is an event the P1a store already keeps. |
| Overview | Activity (#actP) | later | Steps: P2 | Step, check and lock rows arrive with the loop engine and the test lock. |
| Overview | Machine (#machP) | build | Buildable | CPU, memory and disk from Node (os, fs.statfs); per-process memory from ps on the Mac. |
| Overview | Machine (#machP) | build | Test lock | Mission Control runs full suites itself, one at a time. The guard already blocks test commands (spike); it now points agents at the lock instead. |
| Overview | Account quota (#quotaP) | proven | Proven | Claude rate-limit events and Codex account rate limits are both mapped in P1a. |
| Overview | Account quota (#quotaP) | build | 7-day | The Claude adapter keeps one window per event; it must keep every window for the 7-day one to show. |
| Overview | Account quota (#quotaP) | build | Estimates | "Full in ~3h" is our projection. Claude figures only update while a Claude agent runs; a richer Claude usage report exists but is marked experimental. |
| FLIGHT | Situation (#sitP) | later | P2 | FLIGHT writes the summary from the store whenever something changes. |
| FLIGHT | Situation (#sitP) | build | Timeline | Mission Control schedules each check and shows what is coming. |
| FLIGHT | Asked of you (#askP) | proven | GitHub | Mentions, review requests and comments come from your GitHub notifications (checked 16 Oct); each points at the comment, whose html_url and body give the link and the snippet. |
| FLIGHT | Asked of you (#askP) | check | Teams | A Teams message carries its webUrl and a mentions list. Reading works (9 Oct); unattended polling needs the token check. |
| FLIGHT | Asked of you (#askP) | later | Take: P2 | FLIGHT's assessment and suggested replies need FLIGHT. |
| FLIGHT | Asked of you (#askP) | build | Catch-up | New or follow-up comes from the store and the source's own history (GitHub timeline, Teams thread); the story and what to be aware of are FLIGHT's summary. |
| FLIGHT | Work in flight (#wifP) | later | P2 | Built from loop run records: step, try, outcome, tokens, time. |
| FLIGHT | Incoming (#incP) | proven | GitHub | Your notifications read through gh on 16 Oct: assign, mention, review_requested, comment, ci_activity, state_change. |
| FLIGHT | Incoming (#incP) | check | Teams | Reading chats and channels worked on 9 Oct. Polling unattended needs a refresh token that lasts days; NW's Entra sign-in rules decide that. |
| FLIGHT | Incoming (#incP) | later | Triage: P2 | What FLIGHT did with each item needs FLIGHT. |
| FLIGHT | Watch list (#watchP) | later | P2 | A list FLIGHT keeps, with next-check times Mission Control runs. |
| FLIGHT | Watch list (#watchP) | proven | Signals | Time in a Status (field updatedAt) and PR ready/review/merge times read from GitHub on 16 Oct. |
| FLIGHT | Watch list (#watchP) | build | Judgement | Linking a Teams report to a ticket is FLIGHT's judgement: best effort, improved over time. |
| FLIGHT | Drafts for you to send (#draftsP) | build | Buildable | FLIGHT writes drafts. Post uses gh, with your click as the approval. Teams is copy only: the app has read scopes by design. |
| FLIGHT | Decided without you (#decidedP) | later | P2 | FLIGHT answers ask_flight questions and records its basis; Overturn messages the agent. |
| FLIGHT | Decided without you (#decidedP) | build | Quality | How often FLIGHT gets it right is tuning, not a blocker; the escalation rules and Overturn are the safety net. |
| Board | Toolbar (#page-board .toolbar, chips inline) | proven | Proven | delivery Status, Priority, Size and board order read through GraphQL on 16 Oct. |
| Board | Toolbar | build | Overlay | The agent, PR and CI line comes from Mission Control and gh. |
| Board | Toolbar | check | GitHub link | The filterQuery parameter on the board link is unverified; worst case the link opens the board unfiltered. |
| Agent | Header (#ahead, on the ID row) | proven | Proven | Context %, tokens, cost, time to first token and quota are mapped in P1a. |
| Agent | Header (#ahead) | check | Context split | Claude's getContextUsage is documented but untested here; Codex only reports a total. |
| Agent | Activity stream (#streamP) | proven | Proven | Messages, thinking summaries and tool calls (spike). Messages mid-turn: Claude folds them in, Codex steers; both spiked. Haiku ignored mid-turn notes, hence Interrupt and send. |
| Agent | Loop (#loopP) | later | P2 | Steps, tries, tokens and time come from loop run records. |
| Agent | Side tabs (#sideP) | check | Plan | Claude's task tools need an opt-in on newer models and are untested; Codex plan updates are in its schema but not yet seen. |
| Agent | Side tabs (#sideP) | build | Subagents | The spike saw the task frames, and the SDK types give each a token total; P1a needs to map them. |
| Agent | Side tabs (#sideP) | build | Files | git diff from Mission Control. |
| Agent | Side tabs (#sideP) | later | Queue: P2 | Queues come from FLIGHT and the board. |
| Comms | Needs you (#cNeedsP) | build | Buildable | Built from stored items; decisions and approvals need FLIGHT (P2). |
| Comms | Threads (#cThreadsP) | later | P2 | send_message worked in the spike; threads need the mailbox. @CAPCOM is a prompt convention Mission Control parses. |
| Global | FLIGHT dock (#dock, in .dh header) | later | P2 | FLIGHT itself, with structured decision briefs. |
| Global | Item panel (#discuss, in #dsHead) | later | P2 | FLIGHT's ask_operator call carries the brief: question, why, sources checked, options, recommendation. |
| Away mode | Away modal body (#awayBody) | build | Buildable | Safe-ticket rules, gh pr ready, labels and review requests are standard. |
| Away mode | Away modal body (#awayBody) | check | NW on the Mac | Proving a test fails on the base commit, the full suite and the reviewer's browser check all need the NW stack running on the Mac. |
| Telemetry | Throughput (#tThru) | proven | Proven | Merged PRs from GitHub. |
| Telemetry | Cycle time (#tCycle) | proven | Proven | Each issue's timeline records every Status change with the old and new value (checked 16 Oct). |
| Telemetry | Quality and review (#tQual) | proven | Review wait | Ready-for-review, review and merge events read from GitHub on 16 Oct. |
| Telemetry | Quality and review (#tQual) | later | Verify: P2 | First-pass rate and fix rounds come from loop records. |
| Telemetry | You as CAPCOM (#tCapcom) | build | Buildable | When each ask was raised and answered, from the store. |
| Telemetry | Tokens per minute (#tTok) | proven | Proven | Usage events per agent. |
| Telemetry | Where agent time goes (#tUtil) | build | Buildable | Time in each state, from state events. |
| Telemetry | Tokens per turn (#tTurn) | proven | Proven | Per-turn usage (P1a). |
| Telemetry | Tool latency (#tLat) | proven | Proven | Tool durations (P1a). |
| Telemetry | Subagents (#tSubs) | build | Buildable | Task frames with token totals (spike); not mapped yet. |
| Telemetry | Quota used (#tQuota) | proven | Proven | Quota events are stored. |
| Telemetry | Machine load (#tMach) | build | Buildable | Sampled by mc-server. |
| Telemetry | Test lock (#tLock) | build | Buildable | Lock runs recorded by Mission Control. |
| Telemetry | Tokens by ticket (#tTicketBars) | later | P2/P3 | Usage keyed by ticket and step once loops and the board exist. |
| Telemetry | Tokens by loop step (#tStepBars) | later | P2 | Usage keyed by loop step. |
| Telemetry | Totals (#tTotals) | proven | Proven | Usage totals per agent. |
| Setup | Sessions tab | proven | Proven | Sessions and areas are built in P1a, with tests; making a separate checkout is not built yet. |
| Setup | Loops tab | later | P2 | Loop templates are YAML read by the loop engine. |
| Setup | Accounts tab | proven | Proven | Profiles and logins are P1a. |
| Setup | Roles, guard and test lock tab | proven | Proven | Guard rules are P1a; the test-lock redirect is new but small. |
| Setup | Sources tab | check | Teams token | GitHub is proven; Teams needs the refresh-token check. |
| Setup | Access and notifications tab | check | Tailscale | Needs IT to allow Tailscale on the work laptop; otherwise notifications go to your phone. |

Panels with **no** build chip: Overview needs banner; Board kanban itself (chips sit on the toolbar); Agent picker, need banner; Comms conversation pane; Telemetry KPI tiles; Brief modal; Help modal; individual Setup sub-panels (one chip per tab only).

---

## 5. Behaviour rules (verbatim, with location)

### 5.1 Outward communication and writes

1. "Mission Control never messages people itself" — FLIGHT › Drafts for you to send, subtitle.
2. "FLIGHT writes drafts. Post uses gh, with your click as the approval. Teams is copy only: the app has read scopes by design." — build note, Drafts.
3. "Mission Control never posts to Teams." — Setup › Sources › Microsoft Teams note.
4. "Posted on {where} as you. Clicking Post was your approval." — toast on Post on GitHub (Drafts and person replies).
5. "Reply copied. Paste it into Teams; Open in Teams takes you to the message." — toast on Copy for Teams.
6. "Writes (comments, labels, board moves, Priority) go through approvals; nothing posts on its own." — Setup › Sources › GitHub.
7. "No GitHub comments, labels, board moves or Priority changes without your approval" — Setup › Guard rule.
8. "Comments wait for your approval; nothing posts on its own" — review template, propose step gate check.
9. "Mission Control posts the comment on NW #2308 as you. Nothing else changes." — q1 "If you approve" effect.
10. "propose_write: comment on NW #2308 "…" · waiting for your approval through FLIGHT" — GUIDO-2 stream ask (agents propose writes; operator approves via FLIGHT).
11. "gh api -X POST …/issues/2308/comments → denied: GitHub writes need your approval." — GUIDO-2 stream guard event.
12. "Opens the PR on GitHub. Mission Control never merges or marks ready; the card moves when GitHub reports the change." — toast on Open PR (Needs you).
13. "Auto-approve — outward writes wait for you until switched on" (GitHub comments, Labels, Board moves and Priority changes, Starting and stopping agents, Switching accounts; all disabled, P2) — Setup › Accounts.
14. "I will handle {who}'s message: I will check what is needed, draft a reply and bring it back to you before anything is sent." — Let FLIGHT handle it.
15. "Lena also has a question for you on PR #2372; answer that first so this is not the only message from you." — draft d2 context (FLIGHT sequencing etiquette).
16. "FLIGHT can draft a GitHub issue from one for you to approve." — Sources › Teams.
17. "Matches become Needs you items or a FLIGHT digest, with a link to the message." — Sources › Teams.
18. "Brief — plain text, no call signs, ready for Teams or email" — Brief modal subtitle.

### 5.2 Priority and board

19. "The order follows Priority on the delivery board; I'll ask you before I change any Priority." — FLIGHT chat message 7.
20. "Move {ref} above {ref} in {CALL}'s queue? That swaps their Priority on the delivery board ({P} ↔ {P})." — approval raised by the queue ↑ button (title "Ask FLIGHT to move this up").
21. "Changed Priority on the board. {CALL} takes {ref} first now." / "Left the order as it is." — reorder effects.
22. "BOARD: the delivery board, filtered; Mission Control adds only the agent, PR and CI line" — HTML comment.
23. "Unassigned · FLIGHT will offer it to an agent" — Ready card overlay.
24. "Next · from Ready, by priority" — Agent › Queue.
25. "The filterQuery parameter on the board link is unverified; worst case the link opens the board unfiltered." — build note.

### 5.3 Sessions, areas, seats

26. "One session is one ticket: one branch, one checkout and one PR. When a seat picks up a ticket, Mission Control creates the branch from the repo's base and a checkout for it, and removes the checkout when the PR closes. Several agents can share a session, each in its own folders." — Setup › Sessions intro.
27. "Tiles show who owns each folder; areas can't overlap. A stray change is outside every writer's area: it shows in Needs you, and FLIGHT can work out whose it is." — Setup › Sessions panel note.
28. "Refused: a writer with no area owns the whole checkout, which overlaps {CALL}'s {area}. Pick folders." — Add agent refusal.
29. "Refused: all {8} agent slots are in use. Remove an agent or raise the limit in config." — Add agent refusal.
30. "click free folder tiles below · none picked = whole checkout" — Add agent Area field.
31. "Stop or remove the {n} agent(s) in s/{id} first." / "s/{id} closed; its separate checkout is removed, unless the branch has uncommitted changes or unpushed commits." — Close session.
32. "Mission Control checks it's a git checkout on that branch and lists its top folders for areas. The repo profile adds that repo's guard rules, test commands and which of them count as a full suite." — Add session form note.
33. "{CALL}: stopped. Its area stays reserved until you remove it." — Stop.
34. "{CALL} removed from s/{session}; its area is free." — Remove (only offered when stopped or idle).
35. "up to 4 per session" — Machine panel slots; 8 slots total.
36. "The loop comes from each ticket's labels. FLIGHT drafts the agent's queue from its focus and brings it to you to approve." — Add agent form note.
37. "{CALL} joined s/{session} as {role}. I've drafted its queue: the first three Ready tickets matching "{focus}". Start it?" — FLIGHT approval after adding an agent.
38. "Each ticket starts as a fresh run on its own branch, with the ticket, the repo's docs and this lane's notes. Earlier tickets' conversations aren't carried over." — Agent › Queue note.
39. "Focus is what FLIGHT assigns from: a lane, labels or a ticket list. Change it here, or tell FLIGHT, e.g. "GUIDO-2: catalog bugs only this week"." — Focus Change toast.
40. "Rename {CALL}: call signs default to the role's console plus a number. Any name works." — Rename toast; "rename any agent" — Roles subtitle.
41. "Sequenced: #15 starts after #12's PR merges." (PT #12 and PT #15 both touch adapter.ts) — Watch list (tickets touching the same file are sequenced).
42. "Sub-tasks have areas that don't overlap" — tiger-team split check.
43. "Every file in the plan sits inside the agent's area" / "Diff stays inside the area; no stray files" — feature checks.

### 5.4 Messaging agents, interrupts, queues

44. "Reaches {CALL} mid-turn, alongside its next tool result. Smaller models can ignore a mid-turn note; use Interrupt and send if it matters." — Agent composer hint (running Claude agent).
45. "Reaches {CALL} at its next model step (Codex steer); no new turn starts." — hint (running Codex agent).
46. "{CALL} is {state}; your message is queued for its next turn." — hint (not running).
47. "Messages mid-turn: Claude folds them in, Codex steers; both spiked. Haiku ignored mid-turn notes, hence Interrupt and send." — build note, Agent stream.
48. "Interrupt and send" — title "Stop the current turn, then send".
49. "Interrupted by you after {m:ss} in {tool}. The turn is recorded; queued messages start the next turn." — stream sys on interrupt; toast "{CALL}: turn ended and recorded. It reads its queued messages next."; "{CALL} has no running turn to interrupt." (only running/stalled can be interrupted); interrupting the test-lock holder stops the run instead.
50. "Queued: {CALL} is {state}; it reads this when its next turn starts." — sending to a non-running, non-idle agent. Sending to an idle agent starts it ("Idle → Running (your message)").
51. A2A queuing: messages to an agent that is not running/idle/waiting are marked "(queued)"; examples "(queued: arrives when the run returns)", "(queued until INCO-1 resumes)".
52. "Message {CALL} (reaches it mid-turn)…" / "Message {CALL} (queued until its next turn)…" — Comms placeholders.
53. "@CAPCOM is a prompt convention Mission Control parses." — build note, Threads; "@CAPCOM marks a message addressed to you." — help; FLIGHT thread: "decisions and questions come to you here, tagged @CAPCOM"; FLIGHT: "anything that needs a decision comes to you tagged @CAPCOM."
54. "{CALL} asks you, through FLIGHT" — Comms thread label for agent asks (agents reach the operator via FLIGHT).
55. "Switch account: pick another {provider} account. Mission Control moves the session there and resumes it, or starts fresh with a handoff brief if the resume fails." — Switch account toast.
56. "turn {23} of {40}, then a fresh session" — FLIGHT dock meta (FLIGHT rotates sessions).
57. "In the real HUD this opens {CALL} in its own browser window, live and independent of this one." — Pop out.

### 5.5 Test lock and stalls

58. "One full suite at a time across the machine; others wait in line, oldest first. An agent that types a full-suite command directly is told to ask Mission Control instead. Max at once: 1." — Setup › Test lock.
59. "Full test suites only through Mission Control (one at a time)" — Guard rule.
60. "Mission Control runs full suites itself, one at a time. The guard already blocks test commands (spike); it now points agents at the lock instead." — build note, Machine.
61. "Full test suite · one at a time" — Machine lock box heading; "No full-suite run in progress. The next verify step takes it straight away." — free state.
62. Stop the run: "You stopped the full-suite run after {took}. Verify try {n} failed (stopped). FLIGHT will retry it or send it back to fix." — holder goes Idle ("Stalled → Idle (you stopped the run; test lock released)"), its run is recorded "fail: stopped by you", the lock passes to the first queued agent ("Took the test lock after waiting {m:ss}. Mission Control is running: {cmd}"); toasts "Run stopped. The test lock passed to {CALL}." / "Run stopped. The test lock is free." / "No full-suite run is in progress."; FLIGHT: "You stopped GUIDO-2's run. The lock went to GUIDO-3, which is running the NW full suite now. I'll look at why GUIDO-2's run hung (likely the test DB) before it retries."
63. "Stopping that run is your call: the button is on the machine panel." — FLIGHT chat message 2 (FLIGHT does not stop runs itself).
64. Stall threshold: `STALL_MIN = 10`; "stall flagged at 10:00"; Activity "Running → Stalled: no output for 10 min".
65. Lock blocked = holder stalled and someone waiting → amber machine pill, Needs-you "Test lock" item "{agents} waiting for the test lock, held by a stalled run ({holder})".
66. Test-lock commands per repo profile (Setup table, 2.7.4).

### 5.6 Loops and verification

67. "Mission Control decides every move from its own checks; an agent saying it is done can only hold work back, never push it forward. cmd = Mission Control runs it · rule = read from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent = the agent's own evidence." — Setup › Loops note.
68. "Tries 1 and 2 resume the same agent; try 3 starts a fresh agent on a stronger model; after that the ticket parks for you. A retry that makes no progress (same failures, same diff) stops early." — RETRY_NOTE (Agent loop panel, Loops track footer).
69. "FLIGHT polls every check; you make the call" — go/no-go gate ("FLIGHT polls, you decide").
70. "RETRO, fresh eyes: sees the ticket, plan, diff and check output, not the author's chat" — review step role.
71. "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)" — review check.
72. "New test fails on the base commit (Mission Control re-runs it)" — implement check.
73. "No existing test weakened, skipped or deleted" — verify check.
74. "Starting an agent waits for you unless auto-approved" — watch template assign gate.
75. Template retry rules (2.7.2 / 3.6), e.g. "fail → fix → back to verify · max 3".
76. "A fix row belongs to the step just before it" / "A fix row belongs to the step before it, unless fix is a step of its own in this template (bugfix)." — script comments on run grouping.
77. "Every claim cites a file, doc, URL or message" / "One-line answer first, then the evidence" / "A second agent re-checked each citation" — research template.
78. "Each finding has file:line and a failure scenario" — review template.

### 5.7 Away mode

79. "Mission Control keeps going while you're away, inside these limits" — Away modal subtitle.
80. May list, Always list, safe-ticket definitions and Limits — verbatim in 2.8.
81. "Away mode is on {until}." "Safe tickets only; anything else stays a draft, and comments wait for you." — Overview away strip.
82. "Away mode on {until}. Safe tickets can reach ready for review; others stay in draft, and comments wait for you." / "Away mode off. Everything waits for you as usual." — toasts; "Off: everything waits for you as usual." — modal status.
83. "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode" — Guard rule.
84. "Safe-ticket rules, gh pr ready, labels and review requests are standard." / "Proving a test fails on the base commit, the full suite and the reviewer's browser check all need the NW stack running on the Mac." — build notes.

### 5.8 Accounts and credentials

85. "one profile per login · Mission Control never reads credentials" — Accounts subtitle.
86. "Opens a console with {account}'s config folder set. You sign in there; Mission Control never sees the credentials." — Sign in.
87. "Add account: choose Claude or Codex and a short name. Each account gets its own folder, so logins never mix." — Add account.
88. "{account}: signed in (checked with the provider's own status command)." — Check.
89. "Codex quota is read live. Claude quota comes from rate-limit events while its agents run (…). Hover a bar for its reset time." — Quota note.
90. Parked-by-choice: choosing "Wait for reset" on q3 → "OK. INCO-1 waits for Wednesday's reset and no longer counts in Needs you." (agents parked by your choice drop out of Needs you).

### 5.9 Guard

91. Guard rules table (2.7.4) — "hard stops enforced in code".
92. "The guard catches agent mistakes and ordinary spellings, not deliberate evasion." — Guard note.
93. "git writes only through the mc commit, push and draft-PR tools"; stream "Bash git push → denied: git writes go through the mc commit and push tools."; alert "git push denied: git writes go through the mc tools".
94. "Azure DevOps and Data Factory read-only; no database tools".
95. Guard drawer in Comms is "(for information)" — guard hits are not Needs-you items.

### 5.10 Attention, lamps, notifications

96. Help text on lamps/acknowledge/colour (2.10 item 3).
97. "Colour is for state only: amber waits on you, green is being worked, red is broken. Agent colours identify agents and always sit beside the call sign." — CSS comment.
98. "state pills: a dot plus a word, never colour alone" — CSS comment.
99. "Asked of you … first, because a person is waiting" — FLIGHT page subtitle; attention order puts lock/stall/error first, then person, then decision…
100. "everything waiting on you is one click away on Comms" — Overview HTML comment.
101. "Every item FLIGHT brings starts with a catch-up: new or follow-up, the story so far, and what to be aware of." — help.
102. "Quiet hours 19:00 – 08:00 — stalls still notify" — Access.
103. "Tailscale gives the Mac a private HTTPS address that only your own devices can reach; the dashboard still asks for its access token. Install the dashboard as an app in Edge on the laptop and notifications arrive even with no tab open." — Access › Devices.
104. "Needs IT to allow Tailscale on the work laptop; otherwise notifications go to your phone." — build note.

### 5.11 Data sources and telemetry

105. "Token counts come from each provider's usage events. Costs marked ~ are API-equivalent estimates; a subscription isn't billed per token." — Telemetry toolbar.
106. "Claude cost is the difference between run totals (P1a). Codex sends no cost, so a price table gives an estimate." — build note.
107. "Polls on a timer; Graph change notifications need a public HTTPS endpoint, which a local app doesn't have." — Sources › Teams.
108. "Watches the chats and channels you pick for: your name or @mentions, your ticket and PR numbers, and words like "bug", "broken" or "urgent" near your areas." — Sources › Teams.
109. "Check GitHub (and Teams, from P5) every 30 min" — away mode; "Board and notifications poll (every 10 min)" — timeline; watch template "every 10 min".
110. "Measured from the board: when a ticket entered Ready to when it reached Done." — Cycle time note.
111. "The agent's own task list: Claude's task tools or Codex plan updates, replayed from its stream." — Plan note.
112. "Subagents this agent spawned. Their tokens count toward its totals." — Subagents note.
113. "Codex reports the total, not a breakdown" — Context tile for Codex.
114. "In the real app this opens {who}'s message itself in {src}: the message's webUrl from Microsoft Graph / the comment's html_url from the notification." — Open in source.

---

## 6. Work-specific sample context (flag: sample / work data, not product)

- GitHub org **Northwind**: project board `https://github.com/orgs/Northwind/projects/6` ("delivery" board with Status, Priority, Size); repo **platform-tools** (PT #… tickets are Mission Control's own work tracked in a work repo).
- **NW (Northwind)** tickets NW #2231–#2375, PRs #2302–#2372; labels catalog, price-editor, fulfilment, sales-analytics, frontend, backend, type:refactor; milestones "P1 — Quality and product completion", "P2 — Next up", "M12 Catalog"; product areas Catalog (feeds, SKUs, suppliers, categories), Price Editor, Fulfilment lanes, Reports export, store-admin.
- **Windows paths**: `C:\code\Mission-Control`, `C:\code\Northwind`, `C:\code\mc-checkouts\…`, form placeholders `C:\code\Some-Repo`, `C:\code\New-Repo`; Machine panel "Disk C:"; "Cascadia Mono"/"Segoe UI" font fallbacks.
- NW repo folders: backend/catalog, backend/common, backend/reports, backend/fulfilment, frontend/store-admin; files such as backend/fulfilment/routing.py, backend/reports/export/csv.py, docs/backfills.md; `just test` / `just test-all` / `pytest`; repo profiles northwind, store-admin.
- **Teams**: channel "Product rollout", group chat "Support questions", "support chat"; Entra app "Claude-Operator"; "NW's Entra sign-in rules"; admin consent for channel messages granted 9 Oct.
- **People**: Maya R, Owen T, Lena (reports code owner, QA owner), Ravi (account management), Jon P (code owner); operator mentioned as "@Alex", "@alex-doe", "Alex,"; account `operator@example`, `operator+2@example`.
- **Clients**: Contoso (pilot 3 Nov), Fabrikam (22 Sep incident).
- **Guard rule** "Azure DevOps and Data Factory read-only; no database tools" (work stack).
- **Devices**: "Work laptop (Windows)" viewer, Edge PWA, Tailscale needing IT approval, `mission-control.your-tailnet.ts.net`.
- Dates: 9 Oct, 10 Oct, 12 Oct, 14 Oct, 16 Oct ("checked 16 Oct"), 3 Nov.
- Model names in sample: opus, sonnet, haiku (Claude); gpt-5.6-sol (Codex).

---

## 7. Inconsistencies, dead code and oddities noticed

1. **Mac vs Windows**: Access says "Mission Control runs on the Mac; your other devices view it over Tailscale" and build notes say "per-process memory from ps on the Mac" / "NW stack running on the Mac", yet every session path is `C:\code\…` and the Machine panel shows "Disk C:".
2. **Lock typical time**: the lock box says "usually about 9 min" (LOCK.typical) but the Watch item says "a full run usually takes about 25 minutes"; the history shows a 9:12 NW full-suite run.
3. **Merge/ready contradiction**: "Mission Control never merges or marks ready" (Open PR toast) vs away mode "Take a safe PR out of draft…" and guard "a PR leaves draft only for a safe PR in away mode". The toast states the non-away rule only.
4. **Dead ask `q2`**: `answerEffects` handles `q2` (NETWORK-1 Blocked → Running, "Operator says: … Carry on.") but no q2 ask exists; NETWORK-1's question was answered by FLIGHT (Decided without you).
5. **Hard-coded KPIs**: "Lock wait 7:30 · today · 3 runs" and "Your response 4 min" are constants, not derived.
6. **Footer hints omit `s`** (Setup) though `g s` works and the help modal lists it; `f` means FLIGHT page after `g` but toggles the dock alone.
7. **FLIGHT says "four things"** while Needs you counts 14 items in the sample.
8. **NETWORK-1 turn**: `turn: 8` (Tokens per turn draws 8 bars) while `stats.turns` is 7 (Agent Work tile).
9. **Drafts ids** skip d3; PEOPLE order p1, p4, p2, p3; alerts ids 2, 3 (implies removed items).
10. **Phase labels** in use: P1a (built), P2 (FLIGHT/loop engine), P2/P3, P5 (Teams); the legend only explains P2.
11. **Telemetry Tokens by ticket/step and charts** use random values per render (seeded per range), not sample records.
12. **"Edit" on approvals/drafts/replies** is a toast only; no editor is designed.
13. Session filter on Board hides cards whose agent is out of view but keeps unassigned cards and all Done cards.
14. Template `feature` has a `fix` node that is not on its path (reached via rules); `bugfix` has `fix` on its path.
