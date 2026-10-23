# Crew Activity Map — design

Status: draft, 2026-10-23. Built from 17 prototype iterations with the operator on a recorded night of
crew activity, and two reviews by Codex. Ticket: #352. Scheduled after the HUD reaches MVP. Parent
spec: `docs/superpowers/specs/2026-10-18-mission-control-design.md` (binding where this is silent).
Prototype code: `docs/prototype/crew-activity-map/` (§10).

## 1. What this is

A panel on Overview that shows the picked repo as a 3D tree of its files, with the crew working in it,
live. At a glance the operator sees:

- who is where;
- what they are reading and changing, and how much;
- who is stuck;
- what the current review says;
- whether the change has been checked.

It shows what is happening now. History (commits, merges, past runs) stays in each agent's own view.

## 2. Placement and scope

- **Where it lives.** It is a collapsible full-width panel on Overview. It follows the page's repo
  selector: one repo at a time, and when several repos are in progress the selector picks which.
- **Which activity counts.** Only work on the picked repo's checkouts. A seat's reads and edits in
  another repo's checkout do not appear.
- **Loading.** three.js is a new, pinned web dependency, loaded only by this panel. Overview without
  the panel is unchanged.

## 3. What it shows

### 3.1 The repo

- **Layout.** The folder tree is laid out in 3D. Folders are line junctions with no sphere; files are
  spheres; branch length is bounded and grows with size. Imports are faint links.
- **Areas.** Each area (server, web, core, docs) has its own direction from the root, a muted colour
  and a label.
- **Stability.**
  - Positions are computed once per tree and cached.
  - A new file is placed under its folder without moving the rest.
  - The layout's pairwise relaxation is fine up to about 2,000 files. Beyond that, cluster folders.

### 3.2 The colour code

| A file that is | Looks like |
|---|---|
| untouched | its area's muted colour |
| in scope: the ticket's branch read it | the agent's colour, dim |
| modified on the branch | the agent's colour, bright; size steps up a level at 10, 50, 200 and 500 lines changed; a persistent `+n −m` label from the real diff, which pulses on each edit |
| being accessed now (a call in flight) | a white ring |
| recently accessed by an agent that is thinking | a faint white ring |
| modified by one branch and touched by another | a dashed ring |
| modified by two branches (write overlap) | a double ring |
| in a computed merge conflict between branch tips | a conflict marker naming both branches |
| named by the current review | a ▲ pin: red Critical, amber Important, grey Minor |

Agent colours are vivid and well separated; area colours are muted so the agents' colours stand out.
A docked agent drops its reads but keeps its unmerged changes (dimmer, without labels) until the PR
merges.

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
  - `idle 3m`.

  A docked seat shows no ticket.
- **The halo.** Its size is the measured context.
- **Subagents.** No seat uses them today. If one appears, the transcript tags its frames with
  `parent_tool_use_id`, and it is drawn as a small satellite of its parent.

### 3.4 Motion

Every motion is a real call or edit. Nothing loops.

- **Reads.** When a read, search or command returns, particles flow from its files into the agent.
  Their size and count follow the tokens it carried: result length at about four characters a token,
  in bands below 100, 1k and 4k, and above.
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
- **Rendering.** At most 30 fps. The panel stops rendering when nothing moves and when the tab is
  hidden. On return it catches up silently and says what it skipped ("While this tab was hidden:
  12 calls, 2 messages").

### 3.5 Agent cards

Cards sit beside the map. Each shows:

- the ticket title, the folder the agent works in, its state, and counts (in scope, modified,
  accessing now);
- a context bar against the window the run reports;
- badges, each with its age:
  - questions awaiting a reply;
  - calls refused or failed in the last 10 minutes, with the latest reason. "Refused" means the
    CLI's permissions or the hub's guard said no. "Failed" means the call ran and errored. A call cut
    off because the hub stopped the run is excluded.
  - the review round and its finding counts;
  - the last local test result, and "edited since" when the branch changed after it;
  - CI at the head SHA;
  - the waiting reason: test lock, hold or question.

A docked seat's card shrinks to one line.

### 3.6 Interactions

- **Selecting an agent.** Click a card or an orb to highlight that agent and dim the rest. The camera
  does not move. ⌖ on a card zooms to the agent, and Home resets the view.
- **Selecting a file.** Click a file to open a drawer beside the map: who read or wrote it, its diff,
  its review findings with their fixes, and its imports highlighted. ⌖ in the drawer zooms to the file.
- **Badges and arcs.** A card badge, a message arc's label or a message row opens the drawer on:
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
- **Findings.** Show the latest review of the ticket only. Never sum reviews; the hub has no
  "fixed" state for a finding.
- **Tests.** A tool error is not a test failure: a failing Vitest run piped through `head` returns
  success. Test results come from parsed runner output, tied to their time, with "edited since".
- **Overlap.** Overlap is not conflict. "Conflict" is used only for a computed merge conflict.
- **Context.** Context is shown against the window each run reports.
- **Productivity.** Activity is not productivity: no rates, rankings or leaderboards.

## 5. Data

| Signal | Source | Today |
|---|---|---|
| Seat state | the supervisor's turns | exists |
| Call in flight: tool, `command`, `file_path`, id | guard hook `PreToolUse` (matcher `*`) | sent to the hub, not kept: **new per-seat ring** |
| Call result: end time, `is_error`, reason text, size | transcript tail (`stream.ts`, `streamjson.ts`) | parsed; **add size and reason** |
| Refused calls | transcript `permission_denied`, guard decisions | exists |
| Local test results | Bash result text (Vitest summary line) | **new parse** |
| Edits `+n −m` as they happen | transcript Edit/Write inputs | exists |
| The branch's real diff | `git diff --numstat` against the base, per worktree | **new collector**, shared with #351 |
| Merge conflicts between branches | `git merge-tree` on branch tips, cached by SHA pair | **new** |
| Review findings | `review_findings` and the latest `reviews` row for the ticket | exists |
| CI | `pull_requests.checks` at the head SHA | exists |
| Waiting | `/api/test-lock`, `holds`, `seat_questions` | exists |
| Context | `/api/seats/:id/context` | exists |
| Messages | `comms`, `seat_questions` | exists |
| Tree and imports | `git ls-tree` at `origin/HEAD`, import lines parsed | **new, cheap** |

## 6. Hub API

- `GET /api/repos/:id/map` returns a snapshot:
  - the tree (paths and line counts), the imports, and the folder tree's layout seed;
  - per agent: state and since, ticket and title, calls in flight (tool, detail, files, since), scope
    (read files, modified files with `+n −m`), recently accessed files, and badge data;
  - the current findings and computed conflicts.

  The snapshot stays under 300 KB for 500 files.
- `/api/stream` gains a topic `map:<repo>`. Its deltas are:
  - `call.start` {seat, tool, files, tok};
  - `call.end` {seat, files, tok, error, refused, why, tests};
  - `edit` {seat, file, add, rem};
  - `state` {seat, state, since};
  - `message`, `review`, `diff` {seat, file, add, rem}.
- The ring keeps each seat's last 15 minutes of calls in memory. Nothing new is persisted.
- Every route carries its `// Reader:` comment, as `routes.test.ts` requires.

## 7. Performance

- Instanced meshes and one points buffer, with at most about 200 particles.
- The layout is computed once per tree.
- A 30 fps cap, with no rendering when settled.
- Overview with the panel open and the crew idle costs under 5% CPU.

## 8. Security

- **Read-only.** No GitHub writes.
- **What the collectors read.** The crew's local worktrees and the hub's own data.
- **`git merge-tree` writes git objects.** It runs against a scratch object directory (alternates),
  never in a crew clone or the live checkout.
- **Untrusted text.** Transcript text, commands and reasons are rendered as inert text. Home-directory
  prefixes are stripped from commands before they reach the page.

## 9. Slices and estimate

| # | Slice | Area | Size | Depends on |
|---|---|---|---|---|
| 1 | Server: per-seat ring of live calls (guard hook plus transcript tail), and `map:<repo>` deltas on `/api/stream` | server | M | — |
| 2 | Server: `GET /api/repos/:id/map` snapshot (tree, imports, scope, badge data, findings, context) | server | M | 1 |
| 3 | Server: worktree diff collector (numstat against the base, cached; shared with #351) | server | M | — |
| 4 | Web: the map: layout, colour code, orbs, flows, sparks, levels and interactions, as an Overview panel following the repo selector | web | L | 2 (builds on fixtures until then) |
| 5 | Web: cards, badges and drawers (lane, refusals, findings, file) | web | M | 2 |
| 6 | Server: branch conflict check (`git merge-tree`, cached, isolated) | server | M | 3; can come last |

**Estimate, from the crew's own record** (merged tickets on this repo):

| Size | Median seat-hours per ticket (plan, build and review) | Median first start to merge |
|---|---|---|
| S | 1.2 | 3.6 h |
| M | 1.3 | 7.8 h |
| L | 1.9 | 26 h |

The six slices come to about 8–10 seat-hours. GUIDO takes the server slices and INCO the web ones, in
parallel. That is about 1.5–2 days of crew time if prioritised, or 2–3 days with normal queueing.
Operator time: reviewing the result.

## 10. Prototype

`docs/prototype/crew-activity-map/` holds the prototype's code (`app.js`, `head.html`, `body.html`). The
recorded data is not committed: it was built on the operator's machine from crew transcripts and the
hub's database. The prototype read one JSON snapshot with the same fields §6 describes, and replayed it
at real speed. Its debug hook and `?skip=` parameter are for previews only.

## 11. Calls made while writing

- The panel is full width and collapsible, below the loop column on Overview.
- There is no multi-repo view. The repo selector picks one repo.
- The `+n −m` labels use the real diff (slice 3). Until that lands, edit churn from the transcript is
  shown and labelled as such.
