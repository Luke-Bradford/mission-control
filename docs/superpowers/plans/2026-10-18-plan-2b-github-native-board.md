# Plan 2b — GitHub-native board

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Board the real GitHub Project — Needs detail → Ready → In flight → Blocked → Done, with who acts next, sub-issue progress, blockers, the repo's goal, and a ticket detail on click — without disturbing the fields the live loops depend on.

**Architecture:** The GitHub collector reads more of each project item (two new custom fields, parent, sub-issue counts, "blocked by" links, milestone) and each repo's open milestones; a pure `columnOf()` maps an item to a board column. Two **new** single-select project fields carry the PM's information — `Stage` (Needs detail / Ready) and `Owner` (PM / CTO / Agent / Operator) — created only when the operator presses a one-time setup button; the existing Status field and its options are never modified (shop-app's `board.sh` moves cards by Status name). Ticket detail is fetched on demand.

**Tech Stack:** as Plan 2a (Fastify, React, SQLite via `node:sqlite`, Vitest, Biome); GitHub GraphQL via the existing `makeGql` (token from `gh auth token`, scopes include `project`, `repo` — verified 2026-10-18).

**Spec:** `docs/superpowers/specs/2026-10-18-control-centre-v2-design.md` §6.2 (Board), §6.3 (GitHub as the source of truth), §6.2a (UI rules). Mockup: `.superpowers/brainstorm/2311-1792287227/content/board.html`.

## Global Constraints

- GitHub is the source of truth; the hub reads and (only via the setup action) writes the Project. Agents and the hub act under the operator's own account (spec §6.3, decided).
- **Never modify the existing Status field or its options**, and never change any item's Status in this plan. New information lives in two new single-select fields: `Stage` with options exactly `Needs detail`, `Ready`; `Owner` with options exactly `PM`, `CTO`, `Agent`, `Operator`.
- Field creation happens **only** from `POST /api/boards/:repoId/setup`, triggered by a button; it is idempotent (creates only what is missing) and never runs from a collector.
- Existing tickets with no Stage count as **Ready** (spec §8, decided); only an explicit `Stage = Needs detail` puts a ticket in Needs detail.
- Board columns, in order: `needs detail`, `ready`, `in flight`, `blocked`, `done`. `in flight` = Status mapped to `in progress` or `review` (review shown as a tag). `done` keeps the existing 7-day window (`BOARD_DONE_DAYS`).
- Plan 2a's rules hold: quiet pages, status lights paired with shape + label, AA contrast in both themes, no horizontal scroll at 390px, POSTs JSON + same-origin only.
- Parameterised SQL; no magic strings where a typed constant exists (`STAGE_FIELD`, `OWNER_FIELD`, option names exported once from `@cc/core`).

## Review Focus

1. **A project that has no Stage/Owner fields yet** (today's state): the board must work exactly as before with every non-done, non-in-flight, non-blocked ticket in Ready, and show the setup panel; no error. → Task 2 and Task 4 tests.
2. **Setup pressed twice, or while another browser tab presses it**: the second call must create nothing and return `{ created: [] }`; a field that exists with a different option set is left alone and reported, not rewritten. → Task 3 tests.
3. **A "blocked by" issue in another repo or a closed blocker**: Blocked groups by `repo#number`; a closed blocker still shows (GitHub keeps the link) and is labelled closed. → Task 2 test.
4. **Issue body with HTML/script or a huge body**: ticket detail renders it as text (no HTML), truncated at 20 000 characters with a link to GitHub. → Task 5 test.
5. **GitHub unavailable during ticket detail or setup**: the pane shows the error line and keeps the card data already on the board; setup reports the failure without partial writes being claimed as success. → Tasks 3 and 5 tests.

---

### Task 1: Board model in core

**Files:**
- Modify: `packages/core/src/types.ts` (`BoardItem` fields), `packages/core/src/index.ts`.
- Create: `packages/core/src/board.ts` additions (already holds `BOARD_DONE_*`).
- Test: `packages/core/test/board.test.ts`.

**Interfaces:**
- Produces in `board.ts`:
  - `export const STAGE_FIELD = "Stage"`, `export const STAGES = ["Needs detail", "Ready"] as const`, `export type Stage = (typeof STAGES)[number]`.
  - `export const OWNER_FIELD = "Owner"`, `export const OWNERS = ["PM", "CTO", "Agent", "Operator"] as const`, `export type Owner = (typeof OWNERS)[number]`.
  - `export const BOARD_COLUMNS = ["needs detail", "ready", "in flight", "blocked", "done"] as const`, `export type BoardColumnKey = (typeof BOARD_COLUMNS)[number]`.
  - `export function columnOf(item: Pick<BoardItem, "state" | "stage">): BoardColumnKey` — `planned` → `needs detail` if `stage === "Needs detail"`, else `ready`; `in progress`/`review` → `in flight`; `blocked` → `blocked`; `done` → `done`.
- `BoardItem` gains: `stage: Stage | null`, `owner: Owner | null`, `parent: number | null` (parent issue number in the same repo, else null), `subIssues: { done: number; total: number } | null` (null when total is 0), `blockedBy: { ref: string; closed: boolean }[]` (`ref` = `repo#number`), `milestone: string | null`.
- Add `export interface RepoGoal { repoId: RepoId; title: string; dueOn: number | null; open: number; closed: number }` to `types.ts` (exported via `export type *`).

- [ ] **Step 1: Write failing tests** `board.test.ts`: `columnOf` table for every state × stage (null, "Needs detail", "Ready"); constants contain exactly the option names above.
- [ ] **Step 2: Run** `pnpm -s vitest run packages/core` — fail.
- [ ] **Step 3: Implement.** Update every `BoardItem` literal in tests/fixtures across the repo with the new fields (`null`/`[]`) so typecheck passes.
- [ ] **Step 4: Run** `pnpm -s typecheck && pnpm -s vitest run` — green.
- [ ] **Step 5: Commit** `feat(core): board columns, Stage and Owner fields, goal type`.

### Task 2: Collector reads the new board data and goals

**Files:**
- Modify: `apps/server/src/collectors/github.ts` (`BOARD_QUERY`, item mapping, a `MILESTONES_QUERY`), `apps/server/src/store.ts` (board columns + `goals` table), `apps/server/src/api.ts` (`GET /api/repos/:repoId/goal`).
- Test: `apps/server/test/github.test.ts`, `apps/server/test/store.test.ts`, `apps/server/test/api.test.ts`.

**Interfaces:**
- Consumes: Task 1 types and constants.
- `BOARD_QUERY` item adds: `stage: fieldValueByName(name: "Stage") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`, `owner: fieldValueByName(name: "Owner") {…}` (built from `STAGE_FIELD`/`OWNER_FIELD`), and on `Issue`: `parent { number repository { name } }`, `subIssuesSummary { total completed }`, `blockedBy(first: 10) { nodes { number state repository { name } } }`, `milestone { title }`. An option name not in `STAGES`/`OWNERS` maps to null.
- `MILESTONES_QUERY` per repo: `repository(owner,name){ milestones(first: 10, states: OPEN, orderBy: {field: DUE_DATE, direction: ASC}) { nodes { title dueOn openIssues: issues(states: OPEN){totalCount} closedIssues: issues(states: CLOSED){totalCount} } } }`. The repo's goal = the first open milestone with a due date, else the open milestone with the most issues, else none.
- Store: `board_items` gains columns `stage TEXT, owner TEXT, parent INTEGER, sub_done INTEGER, sub_total INTEGER, blocked_by TEXT NOT NULL DEFAULT '[]', milestone TEXT` (migration in `migrate()`, same pattern as existing ones); new table `goals (repo_id TEXT PRIMARY KEY, title TEXT NOT NULL, due_on INTEGER, open INTEGER NOT NULL, closed INTEGER NOT NULL)`; `replaceGoal(repoId: RepoId, goal: RepoGoal | null): void`, `goal(repoId: RepoId): RepoGoal | null`.
- API: `GET /api/repos/:repoId/goal` → `RepoGoal | null` (404 for an unknown repo).

- [ ] **Step 1: Write failing tests**: github.test — an item with Stage/Owner/parent/sub-issues/blockers/milestone maps to the new fields; **Review Focus 1**: a project with no Stage/Owner fields (GitHub returns null for `fieldValueByName`) maps to `stage: null, owner: null` and `columnOf` → ready; **Review Focus 3**: a cross-repo blocker maps to `ref: "otherRepo#12"`, a closed one to `closed: true`; unknown option names → null; goal selection rules (due date first, else most issues, else none). store.test — migration on an old DB adds the columns with defaults; goals round-trip. api.test — `/api/repos/shop-app/goal` returns the stored goal; unknown repo 404; route-table test updated.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** full gates — green.
- [ ] **Step 5: Commit** `feat(server): board reads Stage, Owner, sub-issues, blockers, milestones`.

### Task 3: One-time setup of the Stage and Owner fields

**Files:**
- Create: `apps/server/src/github-setup.ts`.
- Modify: `apps/server/src/api.ts` (`GET /api/boards/:repoId/setup` status, `POST /api/boards/:repoId/setup`).
- Test: `apps/server/test/github-setup.test.ts`, `apps/server/test/api.test.ts`.

**Interfaces:**
- Produces: `setupStatus(gql: Gql, owner: string, project: number): Promise<SetupStatus>` and `ensureFields(gql: Gql, owner: string, project: number): Promise<SetupResult>`, where `type SetupStatus = { projectId: string; missing: ("Stage" | "Owner")[]; mismatched: { field: string; options: string[] }[] }` and `type SetupResult = { created: ("Stage" | "Owner")[]; mismatched: SetupStatus["mismatched"] }`.
  - Reads project fields (`projectV2 { id fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { name options { name } } } } }`).
  - For each of Stage/Owner: absent → `createProjectV2Field(input: { projectId, dataType: SINGLE_SELECT, name, singleSelectOptions: [{ name, color, description }] })` with the exact options from Task 1 (colors: Needs detail `YELLOW`, Ready `GREEN`; PM `PURPLE`, CTO `BLUE`, Agent `GRAY`, Operator `ORANGE`; description `""`); present with the same options → nothing; present with different options → reported in `mismatched`, **never modified**.
  - Never calls any mutation other than `createProjectV2Field`.
- API: `GET /api/boards/:repoId/setup` → `SetupStatus` minus `projectId`; `POST /api/boards/:repoId/setup` (JSON body `{}`) → `SetupResult`; GitHub failure → 502 `{ error }` (fixed text + GitHub's message, never the token); unknown repo → 404. After a successful POST, trigger the GitHub collector's next poll (or mark board topic changed) so the board refreshes.

- [ ] **Step 1: Write failing tests** (fake `gql` recording calls): missing both → two `createProjectV2Field` calls with exact names/options; **Review Focus 2**: second call after creation → `created: []`, zero mutations; a pre-existing `Stage` with options `["Todo","Done"]` → reported mismatched, no mutation for it; no mutation name other than `createProjectV2Field` ever appears; **Review Focus 5**: gql throws mid-way → POST returns 502 and the response does not claim the failed field as created. api.test: POST requires JSON + same-origin (415/403 from Plan 2a hooks), unknown repo 404, route table updated.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** full gates — green.
- [ ] **Step 5: Commit** `feat(server): one-time setup of Stage and Owner fields on a project`.

### Task 4: Board page — native columns, owners, blockers, goal, setup panel

**Files:**
- Modify: `apps/web/src/pages/Board.tsx`, `apps/web/src/components/BoardColumn.tsx`, `apps/web/src/data.ts` (`RESOURCES.goal(repoId)`, `RESOURCES.boardSetup(repoId)`), theme.css.
- Create: `apps/web/src/components/GoalBar.tsx`, `apps/web/src/components/BoardSetup.tsx`.
- Test: `apps/web/test/Board.test.tsx`, `apps/web/test/BoardColumn.test.tsx`, `apps/web/test/GoalBar.test.tsx`.

**Interfaces:**
- Consumes: `BOARD_COLUMNS`, `columnOf`, `BoardItem` new fields, `RepoGoal`, setup endpoints, `Light`, `Help`.
- Columns in `BOARD_COLUMNS` order with counts in headers. Cards: title, `#number`, priority, owner tag (`PM`/`CTO`/`Agent`/`Operator`, PM in `--pu`), sub-issue progress `done/total`, review tag for in-flight items in review, the agent working on it if any agent's `currentRun.ticket === repo#number` (agent id + working light). Blocked column groups cards under their first blocker (`repo#number`, "closed" when closed), largest group first; cards with no recorded blocker go last under "no blocker recorded".
- `GoalBar`: milestone title, `closed/(open+closed)` as a bar + numbers, due date when present; omitted when no goal.
- `BoardSetup`: shown when `GET …/setup` reports `missing` non-empty: a compact panel with one button "Add Stage and Owner fields" and a `Help` icon explaining (adds two fields to the GitHub project; Status is not changed). Shows `mismatched` fields as a warning line. On success it disappears and the board refetches.
- Phone (≤ 760px): one column at a time with a segmented column picker (counts in each segment) instead of stacking all columns (closes the matching #12 item).
- Card click navigates to `/board/:repoId/:number` (Task 5 renders the detail; until then the route renders the board with the card highlighted).

- [ ] **Step 1: Write failing tests**: columns and counts from fixtures incl. **Review Focus 1** (no stage → Ready, setup panel shown, no error); owner tag and sub-issue progress; blocked grouping order incl. a closed cross-repo blocker; agent-on-ticket line; GoalBar numbers and omission; setup button POSTs `{}` and hides on `created`; phone picker shows one column (set `window.innerWidth`/matchMedia in the test).
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** full gates — green.
- [ ] **Step 5: Commit** `feat(web): GitHub-native board with owners, blockers, goal and setup`.

### Task 5: Ticket detail

**Files:**
- Modify: `apps/server/src/api.ts` (`GET /api/boards/:repoId/items/:number`), `apps/server/src/collectors/github.ts` (an `ISSUE_QUERY`), `apps/web/src/router.ts` (`/board/:repoId/:number`), `apps/web/src/pages/Board.tsx`.
- Create: `apps/web/src/components/TicketDetail.tsx`.
- Test: `apps/server/test/api.test.ts`, `apps/web/test/TicketDetail.test.tsx`, `apps/web/test/App.test.tsx`.

**Interfaces:**
- Produces: `GET /api/boards/:repoId/items/:number` → `TicketView = { number: number; title: string; url: string; state: "open" | "closed"; body: string; bodyTruncated: boolean; labels: string[]; milestone: string | null; subIssues: { number: number; title: string; state: "open" | "closed" }[]; pullRequests: { number: number; title: string; url: string; state: "open" | "closed" | "merged" }[] }` (add `TicketView` to core `views.ts`). `ISSUE_QUERY`: issue by number with `body`, `subIssues(first: 50)`, `closedByPullRequestsReferences(first: 10)` (or timeline cross-references if that field is unavailable — verify against the schema first). Body truncated at 20 000 characters. 404 for unknown repo or issue; 502 on GitHub failure.
- Route `/board/:repoId/:number` → `{ page: "board"; repoId: string; ticket: number }`; `Route` board variant gains `ticket: number | null`.
- `TicketDetail`: beside the board (replaces it on a phone, with back), sections omitted when empty: header (title, `repo#n`, state light, stage, owner, milestone), the agent on it (if any) linking to `/agents/:id`, description as **plain text** with line breaks preserved (no Markdown/HTML rendering), sub-issues with state lights, PRs with state, GitHub link.

- [ ] **Step 1: Write failing tests**: API returns the view; **Review Focus 4**: a body containing `<img src=x onerror=…>` and `<script>` renders as text; a 25 000-char body is truncated with `bodyTruncated: true` and the pane shows "continue on GitHub"; **Review Focus 5**: GitHub failure → pane shows the error line and the board stays; route table cases for `/board/shop-app/3227` and invalid numbers.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** full gates — green.
- [ ] **Step 5: Commit** `feat: ticket detail from the board`.

### Task 6: Browser and accessibility pass

**Files:** whatever the findings touch; the runbook's board screenshots and new ticket ones (kept outside the repo; 1600 dark + light, 390 one theme each); `docs/runbook.md` (Board section: columns, the setup button, Stage/Owner fields).

- [ ] **Step 1:** Run a preview with `CC_PORT=7431` against a copy of the live DB (as Plan 2a Task 8; never touch the live hub on 7420). Do **not** press the setup button against the operator's real projects; exercise it against a stubbed GitHub (unit tests) only.
- [ ] **Step 2:** Lighthouse accessibility on the board and ticket detail, both themes, 1600 and 390; fix every finding.
- [ ] **Step 3:** Review the screenshots against spec §6.2a and `board.html` (frontend-design skill, yourself); fix findings.
- [ ] **Step 4:** Full gates green; recapture screenshots (no secrets).
- [ ] **Step 5: Commit** `fix(web): board design and accessibility pass; screenshots`.
