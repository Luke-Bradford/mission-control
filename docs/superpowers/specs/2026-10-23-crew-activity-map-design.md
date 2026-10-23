# Crew Activity Map — design

Status: draft, 2026-10-23. Built from 17 prototype iterations with the operator on a recorded night of
crew activity, and two reviews by Codex. Ticket: #352. Scheduled after the HUD reaches MVP. Parent
spec: `docs/superpowers/specs/2026-10-18-mission-control-design.md` (binding where this is silent).
Prototype code: `docs/prototype/crew-activity-map/` (§10).

## 1. What this is

A panel on Overview that shows one repo as a 3D tree of its files, with the crew working in it, live.
At a glance the operator sees:

- who is where;
- what they are reading and changing, and how much;
- who is stuck (§3.5);
- what the current review says;
- whether the change has been checked.

It shows what is happening now. History (commits, merges, past runs) stays in each agent's own view.

## 2. Placement and scope

- **An addition to the mockup.** The HUD catalogue's Overview (§2.1) has no map. This spec adds one
  surface to it: a collapsible, full-width panel below Overview's two columns. Everything else on
  Overview is unchanged.
- **Which repo.** Overview has the global session selector, not a repo selector, so the panel has its
  own repo picker:
  - a selected session (`s/{id}`) sets it to that session's repo;
  - "All sessions" defaults it to the repo with the most running crew seats, ties going to the repo
    whose seat started most recently; with no crew seat running, it keeps the last picked repo, or
    else the first configured one;
  - several sessions on one repo show together.
- **Which activity counts.**
  - Only crew seats' work on the picked repo's checkouts. A seat's reads and edits in another repo's
    checkout do not appear.
  - Observed loops (sessions Mission Control watches but does not run) are out of scope for the
    first version.
  - FLIGHT has no ticket or checkout. Its orb appears while it reads or writes the picked repo's
    files; its scope is the turn in progress, and otherwise it is docked.
- **Loading.**
  - three.js is a new web dependency: an exact pinned version in `apps/web/package.json`, bundled into
    a lazily loaded chunk, never from a CDN.
  - Fonts stay the app's self-hosted `@fontsource` packages.
  - Overview without the panel open is unchanged.

## 3. What it shows

### 3.1 The repo

- **Layout.** The folder tree at `origin/HEAD` is laid out in 3D. Folders are line junctions with no
  sphere; files are spheres; branch length is bounded and grows with size. Imports are faint links.
- **Areas.** Each top-level area has its own direction from the root, a muted colour and a label.
- **Stability.** Positions are computed once per tree and cached. A file new on a branch is placed
  under its folder without moving the rest.
- **Large repos.** The first version handles up to 2,000 files. Above that, files collapse into their
  folders: folders become spheres sized by file count, and the colour code applies per folder.

### 3.2 The colour code

| A file that is | Looks like |
|---|---|
| untouched | its area's muted colour |
| in scope: the ticket's branch read it | the agent's colour, dim |
| modified on the branch | the agent's colour, bright; size steps up a level at 10, 50, 200 and 500 lines changed; a persistent `+n −m` label that pulses on each edit |
| being accessed now (a call in flight) | a white ring |
| recently accessed by an agent that is thinking | a faint white ring |
| modified by one branch and touched by another | a dashed ring |
| modified by two branches (write overlap) | a double ring |
| in a computed merge conflict between two open PRs' head commits | a conflict marker naming both branches |
| named by the current review | a ▲ pin in the HUD's crit, warn or muted colour for Critical, Important and Minor |

**Where `+n −m` comes from.** It is the branch's real diff once slice 3 lands. Before that, it is edit
churn counted from the seat's Edit and Write calls, labelled "edit churn" on the label's tooltip and
the file drawer (§4).

**Colours.**
- Agent colours are the HUD's series tokens s1–s7, assigned by seat order, so they match every other
  page.
- Area colours are desaturated from the surface tokens, so the agents' colours stand out.

**Docked agents.** A docked agent drops its reads but keeps its unmerged changes (dimmer, without
labels) until the PR merges.

### 3.3 Agents

- **The orb.** Each seat is an orb. It sits over the middle of the files of its calls in flight, with
  a line to each (up to 12, the rest counted as "+N more").
  - Agents often issue several calls at once: 29% of tool-calling messages did on the recorded night,
    up to 16.
  - With no call in flight, the orb floats over the files it touched last.
  - Idle for a minute, it moves to a dock beside the map.
- **The label.** It reads `ID · #ticket · state`, where state is one of:
  - `running pnpm -s vitest run 42s` or `editing api.ts 0s`, from the call in flight;
  - `thinking 12s`, a running turn with no call in flight;
  - `stalled 6m`, when the hub marks the run stalled, as Overview's agent rows do;
  - `idle 3m`.

  A docked seat shows no ticket.
- **The halo.** Its size is the measured context.
- **Subagents.** No seat uses them today. They are not built: `stream.ts` drops subagent frames (those
  with a `parent_tool_use_id`). Showing them as satellites of the parent needs a parser change, and is
  left for when seats use them.

### 3.4 Motion

Every motion is a real call or edit. Nothing loops.

- **Reads.** When a read, search or command returns, particles flow from its files into the agent.
  Their size and count follow the tokens the result carried: result length at about four characters
  a token, in bands below 100, 1k and 4k, and above.
- **Writes.** As a write starts, particles flow from the agent into the file, sized by what was written.
- **Hub calls.** Calls to the hub's `mc` tools flow to and from a HUB marker beside CAPCOM.
- **Edits.** Green sparks fly into the file, one per 8 lines added and at most 5; red sparks fly out
  the same way for lines removed.
- **Levels.** When a file's change crosses a level, it bursts white and pops `▲ +n −m`.
- **Messages.** Messages between seats, FLIGHT, HUB and CAPCOM arc between them for 4 s, labelled with
  their kind (`assigned`, `review`, `question` and so on). A burst between one pair shows as `×N`.
- **Timing.** Touched files glow and settle over about 6 s, so calls a few seconds apart overlap on
  screen. Real crew activity at the busiest point of the recorded night averaged 3.5 seats running and
  one call every 2–3 s.
- **Rendering.** At most 30 fps. An idle panel renders no frames: no clock or label animates in the
  canvas. Rendering also stops when the tab is hidden. On return the panel catches up silently and
  says what it skipped ("While this tab was hidden: 12 calls, 2 messages").

### 3.5 Agent cards

Cards sit beside the map. Each shows:

- the ticket title, the folder the agent works in, its state, and counts (in scope, modified,
  accessing now);
- a context bar against the window the run reports;
- badges, each with its age:
  - **Questions:** questions awaiting a reply.
  - **Refused or failed calls in the last 10 minutes,** with the latest reason. "Refused" means the
    CLI's permissions or the hub's guard said no. "Failed" means the call ran and errored. A call cut
    off because the hub stopped the run is excluded.
  - **Review:** the review round and its finding counts.
  - **Local tests:** the last result, with "edited since" when the branch changed after it.
  - **CI** at the head SHA.
  - **Waiting:** in the test-lock queue, or parked with the hub's park reason.

**"Stuck"** is any of these:
- the run is stalled;
- a call is still running after 10 minutes;
- three or more refusals or failures in the last 10 minutes;
- a waiting badge older than 15 minutes.

A stuck card's state shows in the warn colour.

A docked seat's card shrinks to one line.

### 3.6 Interactions

- **Selecting an agent.** Click a card or an orb to highlight that agent and dim the rest. The camera
  does not move. ⌖ on a card zooms to the agent, and Home resets the view.
- **Selecting a file.** Click a file to open a drawer beside the map: who read or wrote it, its diff,
  its review findings with their fixes, and its imports highlighted. ⌖ in the drawer zooms to the file.
- **Badges and arcs.** A card badge or a message arc's label opens the drawer on:
  - the conversation lane between two agents, with a ticket filter (an answer that came from another
    lane joins its question);
  - the list of refused and failed calls;
  - the review's findings.
- **Search.** Type a file name to find it and zoom to it.
- **Camera.** Drag to orbit and scroll to zoom. Rotation is opt-in. Reduced motion is respected.

## 4. Honesty rules

- **Tokens.** Tokens shown are a call's own payload: what came back, or what was written. They are
  never a message's usage split across files.
- **Thinking.** "Thinking" means only that a turn is running with no call in flight. The map never
  claims which files an agent is thinking about.
- **Findings.** Show the latest review of the ticket only. Never sum reviews; the hub has no "fixed"
  state for a finding.
- **Tests.** A tool error is not a test failure: a failing Vitest run piped through `head` returns
  success.
  - Test results come from parsed runner output, tied to their time, with "edited since".
  - The first version parses Vitest's summary line. Other runners show "tests: unknown".
- **Changes.** `+n −m` is the real diff, or is labelled edit churn until the diff collector exists.
- **Overlap.** Overlap is not conflict. "Conflict" is used only for a computed merge conflict.
- **Context.** Context is shown against the window each run reports.
- **Productivity.** Activity is not productivity: no rates, rankings or leaderboards.

## 5. Data

| Signal | Source | Today |
|---|---|---|
| Seat state, stalled, parked and its reason | the supervisor and the crew row Overview reads | exists |
| Calls: tool, input, start, end, `is_error`, result text | a new tail of each crew run's `transcriptPath`, read with `readNewLines` (`tail.ts`) every 1 s. The ring parses each line itself from the raw JSON: `tool_use` inputs and `tool_result` content length are taken before any `cleanText`, which truncates and redacts, and `cleanText` is used only for strings sent to the page. `stream.ts`'s `itemsOf` (not exported, and it truncates) is a pattern to copy, not code to reuse | **new** (slice 1a): the tail, plus the files per tool, result size, failure reason and the Vitest summary |
| A call's files | the transcript `tool_use` input: `file_path` (Read, Edit, Write), `notebook_path`, `path`/`pattern` (Grep, Glob), and path-like tokens in a Bash `command` (best effort: a path counts only if it exists in the tree) | **new**, in the ring (slice 1a) |
| Refused calls (CLI side) | transcript `system/permission_denied` | **new parse** (slice 1a); `stream.ts` does not read it today |
| Refused calls (hub guard) | `guard_hits` | exists |
| Edit churn `+n −m` | Edit/Write/MultiEdit inputs: `old_string`/`new_string`, `content` | **new count** (slice 1a); `streamjson.ts` reads these only for a one-line detail |
| The branch's real diff | `git diff --numstat` against the base, per worktree | builds on `apps/server/src/files.ts`, which #343 (PR #350) extends for crew seats (slice 3) |
| Merge conflicts between branches | `git merge-tree` on branch-tip SHAs | **new** (slice 6) |
| Review findings | `review_findings` and the latest `reviews` row for the ticket | exists |
| CI | `pull_requests.checks` at the head SHA | exists |
| Test lock queue | `/api/test-lock` | exists |
| Context | `/api/seats/:id/context` | exists |
| Messages | `comms`, `seat_questions` | exists |
| Tree and imports | `git ls-tree` at `origin/HEAD`, import lines parsed | **new, cheap** (slice 2) |

Calls come from the transcript only, not the guard hook, and the ring lives in a new
`apps/server/src/map/ring.ts`, outside `runtime/**`: it does not touch the supervisor's own transcript
fold. The hook forwards only `command`,
`file_path` and `run_in_background`, and widening it touches hard-rule files. The transcript carries
every call's full input, reaching the ring within about 2 s, which is enough here.

## 6. Contract and hub API

The contract lives in `packages/core` as `MapSnapshot` and `MapDelta`, with a sample fixture (slice 0).
Server and web build against those types.

- **`GET /api/repos/:repoId/map`** returns a `MapSnapshot`:
  - the tree (paths and line counts) and the imports;
  - per seat: state and since, ticket and title, calls in flight (tool, detail, files, since), scope
    (read files, and modified files with `+n −m` and whether it is real diff or churn), recently
    accessed files, and badge data;
  - the current findings and computed conflicts;
  - the sequence number of the last delta it includes.
- **Deltas** are a protocol extension. `/api/stream` today only pings `event: changed` with a topic,
  to every subscriber, with no payload, selection or ordering. The extension:
  - `GET /api/stream?map=<repo>` also sends `event: map` frames, carrying `{seq, …delta}` for that
    repo only, through a per-connection subscription. The existing `changed` pings are unchanged, and
    without the parameter a client sees no change.
  - Delta kinds:
    - `call.start` {seat, tool, detail, files, writeTok}, where `writeTok` is set for writes only;
    - `call.end` {seat, files, resultTok, error, refused, why, tests};
    - `edit` {seat, file, add, rem};
    - `state` {seat, state, since};
    - `message` {from, to, kind, ticket};
    - `review` {seat, ticket, round, counts};
    - `diff` {seat, file, add, rem}.
  - A client that sees a gap in `seq`, or reconnects, refetches the snapshot.
- **The ring.** Each seat's last 15 minutes of calls are kept in memory. Nothing new is persisted.
- **Reader comments.** The web panel reads these routes. Until it lands, each route carries a valid
  `// Reader:` comment naming an existing file, as `routes.test.ts` requires for routes the web does
  not read.

## 7. Performance

- Instanced meshes and one points buffer, with at most about 200 particles.
- The layout is computed once per tree.
- A 30 fps cap, with no rendering when settled.
- **Measured, not assumed:**
  - **CPU.** Overview open with the panel, the crew idle, measured with Chrome's Performance panel over
    60 s on the operator's machine: under 5% CPU.
  - **Snapshot size.** The snapshot for this repo stays under 300 KB.
- **Collectors.**
  - The diff collector runs per seat after its Edit or Write calls (debounced 2 s) and on commit,
    cached on the worktree's HEAD and index mtime.
  - At most 2 `git` processes run at once for the map.

## 8. Security

- **Read-only.** No GitHub writes.
- **What the collectors read.** The crew's local worktrees and the hub's own data.
- **`git merge-tree` writes git objects.** It runs against a scratch object directory (alternates),
  never in a crew clone or the live checkout.
- **Untrusted text.**
  - Transcript text, commands and reasons are rendered as inert text.
  - Home-directory prefixes are stripped from commands before they reach the page.
  - JSON inlined into HTML escapes `</script>`.
- **Supply chain.** three.js is a new dependency at an exact pinned version, bundled; no CDN at runtime.

## 9. Slices and estimate

Each slice is a crew ticket with `size` and `## Done when`.

| # | Slice | Labels | Size | Depends on | Done when |
|---|---|---|---|---|---|
| 0 | Core: `MapSnapshot` and `MapDelta` types, and a sample fixture | area:core, type:feature | S | — | The types and fixture are exported from `@mc/core`; a test parses the fixture against them. |
| 1a | Server: per-seat ring of calls in `apps/server/src/map/ring.ts`, tailing each crew run's transcript every 1 s: files per tool, result size, failure reason, CLI refusals, edit churn, Vitest summary | area:server, type:feature | M | 0 | a call appears in the ring within 2 s of its transcript line and closes at its result; each field is tested against a recorded transcript fixture, including an Edit and a result longer than `STREAM_TEXT_MAX`, whose churn and size must be exact. |
| 1b | Server: `map` deltas on `/api/stream?map=<repo>` with sequence numbers | area:server, type:feature | M | 1a | A test client receives ordered `call.start`/`call.end` frames for one repo only; a gap triggers the documented refetch. |
| 2 | Server: `GET /api/repos/:repoId/map` snapshot (tree, imports, scope, badge data, findings, context, last `seq`) | area:server, type:feature | M | 1a | The snapshot for this repo validates against `MapSnapshot` and is under 300 KB. |
| 3 | Server: real `+n −m` per seat, from `files.ts` | area:server, type:feature | M | #343 | Numstat for a fixture worktree matches `git diff --numstat` against its base; a new edit is reflected within 5 s of the ring recording it. |
| 4a | Web: the panel: repo picker, layout, file colour code, levels, search, camera and file drawer | area:web, type:feature | M | 0 | Layout, colour code, level and band logic are pure functions with unit tests; the panel renders the fixture; the three.js scene is a thin shell; the crit and warn pins stay distinguishable from every s1–s7 agent colour. |
| 4b | Web: agents, orbs, flows, sparks, message arcs, and the selection and zoom behaviour | area:web, type:feature | M | 4a | State labels and orb placement are pure functions with unit tests; the panel animates the fixture's deltas. |
| 5 | Web: cards, badges, "stuck" and the drawers (lane, refusals, findings) | area:web, type:feature | M | 0 | Each badge's text and age come from the fixture; each opens its drawer; the stuck rule is unit-tested. |
| 6 | Server: branch conflict check (`git merge-tree` on branch tips, cached by SHA pair, isolated object directory; tips from `pull_requests.head_sha`, so open PRs only) | area:server, type:feature | M | 0 | Two fixture branches with conflicting tips report a conflict naming both; nothing is written to the crew's clones. |

No slice touches a hard-rule file, so all can merge on the normal gate.

**Estimate, from the crew's own record** (indicative). Source: the hub's database, all merged tickets it has recorded for this repo (2026-10-20 to 23). For each ticket: its runs joined to its merged PR, grouped by the board's Size field, taking the first run's start to the merge, and the sum of its runs' durations. `flow_issues` (size, start and done times) gives the lead times directly.

| Size | Sample | Median seat-hours per ticket (plan, build and review) | Median first start to merge |
|---|---|---|---|
| S | 33 | 1.2 | 3.6 h |
| M | 27 | 1.3 | 7.8 h |
| L | 4 | 1.9 | 26 h |

- **Work.** One S and eight Ms come to about 11–12 seat-hours.
- **Critical path.** The longest chains are 0 → 1a → 2, 0 → 1a → 1b and 0 → 4a → 4b: an S and two Ms
  each, about 19 h at median start to merge. Slices 3, 5 and 6 run alongside.
- **Elapsed.** With GUIDO on the server slices and INCO on the web slices, about 2 days of crew time if
  prioritised, or 3 days with normal queueing. Rework rounds would add to that.
- **Operator time.** Reviewing the result.

## 10. Prototype

`docs/prototype/crew-activity-map/` holds the prototype's code (`app.js`, `head.html`, `body.html`).

- **It does not run standalone.** three.js and a recorded data snapshot were injected when it was
  built; that data, from the operator's machine, is not committed.
- **What it was.** It replayed one JSON snapshot with roughly the fields of §6, at real speed.
- **What to port, and what not to.**
  - Its palette predates the s1–s7 rule in §3.2.
  - Its debug hook and `?skip=` parameter are preview-only.
  - Its layout, colour code, flow, spark and level logic are what slices 4a and 4b port, as tested
    pure functions.

## 11. Calls made while writing

- **Placement:** a full-width, collapsible panel below Overview's two columns.
- **Repo:** picked in the panel. The session selector sets it when a session is chosen.
- **No multi-repo view.** Observed loops come later.
- **Calls come from the transcript, not the guard hook,** to keep hard-rule files out of scope.
- **`+n −m` is edit churn, labelled as such,** until slice 3 lands.
