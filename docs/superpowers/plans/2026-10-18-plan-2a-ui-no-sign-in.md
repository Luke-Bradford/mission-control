# Plan 2a — Agents-first UI and no sign-in

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Plan 1's six-tab hub with the v2 agents-first screen (needs-you and agent detail beside the list), a quiet two-theme design system with status lights, and no sign-in.

**Architecture:** Same Fastify server and React app. The server drops sessions/login/setup but keeps its Host (DNS-rebinding) and JSON-POST checks and adds a same-origin check on POST. The web app gets theme tokens for dark and light, two small primitives (`Light`, `Help`), and a split layout: grouped agent list on the left, detail pane on the right, chosen by URL. Data comes from the existing endpoints; nothing in this plan needs the runtime, the CTO or the PM.

**Tech Stack:** Node ≥ 25 (strip-types), TypeScript, Fastify 5, React 18, Vite, Tailwind (base only), Vitest + Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-10-18-control-centre-v2-design.md` (§6.2 screens, §6.2a UI rules, §6.4 no sign-in). Mockups: `.superpowers/brainstorm/2311-1792287227/content/main-screen.html` (option B), `needs-you-detail.html`, `agent-detail.html`.

## Global Constraints

- Server binds `127.0.0.1` only; no login, no session cookie, no password anywhere (spec §6.4).
- Keep: Host must be `localhost`/`127.0.0.1` (421 otherwise); POST must be `application/json` (415 otherwise). Add: a POST with an `Origin` header whose host is not `localhost`/`127.0.0.1` is 403.
- Quiet pages: no sentence describing what a page shows. Words only where they are content. Explanations go behind a `Help` icon tooltip (§6.2a).
- Status lights: amber = needs you (reserved), green = going well, red = blocked/failed, grey = idle. A light is never the only signal: it always pairs with a shape and an accessible label (§6.2a).
- Dark and light themes, following `prefers-color-scheme`, with a manual switch remembered per browser; every text/background token pair ≥ 4.5:1 contrast (WCAG AA), large figures ≥ 3:1.
- No horizontal page scroll at 390px width.
- Runs are shown by **ticket and time**, never by the loop's iteration counter `seq` (spec §6.2).
- Cost is API-equivalent: label `≈$`, tooltip `API_COST_TITLE` (existing, `apps/web/src/format.ts`).
- Engineering: branch + PR; `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` green before done; parameterised SQL; no magic strings with a typed counterpart.

## Review Focus

1. **A cross-site page tries to drive the hub** (now there is no login): a form or fetch from another origin to `POST /api/agents/x/pause` must be refused (415 for non-JSON, 403 for foreign `Origin`), and a rebinding hostname still gets 421. → tests in Task 1.
2. **Nothing needs you and nothing is blocked**: the list must show the working/idle agents without empty group headers or filler text. → test in Task 4.
3. **An escalation with no SD-32 question block** (plain `[operator-decision]` title only): the needs-you detail must still render title, repo, age and the GitHub link, and simply omit Assessments/Choice. → test in Task 5.
4. **An agent with no runs yet / a collector error**: agent detail renders the header and the error line, empty sections are omitted, not shown as "—" tables. → test in Task 6.
5. **Theme switch on a phone width**: switching to light at 390px keeps every status light distinguishable and no horizontal scroll. → covered by Task 3's contrast test and Task 8's browser pass.

---

### Task 1: Remove sign-in; keep cross-site defences

**Files:**
- Modify: `apps/server/src/api.ts` (delete `/login`, `/logout`, `/auth/state`, `/setup` and the `/api` session hook; add Origin check), `apps/server/src/main.ts` (no setup token), `apps/server/src/auth.ts` (keep only `LOCAL_HOSTS`; delete hashing, sessions, throttle, cookies, setup token — move `LOCAL_HOSTS` into `api.ts` if nothing else remains and delete the file), `apps/server/src/config.ts` (`operator.password_hash` becomes an ignored legacy key: still accepted by the schema so existing configs load, never used; drop `passwordHash` from `CcConfig`), `apps/server/src/store.ts` (drop `passwordHash()`/`setPasswordHash()`; leave the `settings` table), `package.json` (remove `cc:hash-password`), delete `apps/server/src/hash-password.ts`, `packages/core/src/auth.ts` (delete; remove from `index.ts`), `config.example.yaml`, `docs/runbook.md` (Password section → one line: no sign-in, loopback only).
- Web: delete `apps/web/src/pages/Login.tsx`, `Setup.tsx`; `apps/web/src/api.ts` (drop `login`, `logout`, `setup`, `passwordSet`, `LOGIN_MESSAGES`, `SETUP_MESSAGES`, and the 401 redirect); `apps/web/src/router.ts` (drop `LOGIN_PATH`, `SETUP_PATH`); `apps/web/src/App.tsx` (no login/setup routes, no log-out button).
- Tests: delete `apps/server/test/auth.test.ts`, `apps/web/test/Login.test.tsx`, `apps/web/test/Setup.test.tsx`; rewrite the authentication block and the first-run setup block in `apps/server/test/api.test.ts`.

**Interfaces:**
- Produces: `buildApp(deps)` without `sessions`, `throttle`, `setupToken` in `AppDeps`. Every `/api/*` route answers without a cookie.

- [ ] **Step 1: Write the failing tests** in `apps/server/test/api.test.ts`, replacing the `authentication` and `first-run setup` describes with `describe("local access")`:
  - `it("serves /api without any cookie")` — `GET /api/agents` → 200.
  - `it("has no login, logout, setup or auth-state routes")` — `POST /login`, `POST /logout`, `POST /setup`, `GET /auth/state` (JSON where POST) → each 404 (or the SPA for GET when `webRoot` is set — use an app without `webRoot`).
  - `it("refuses a non-JSON POST (415)")` — form-encoded `POST /api/agents/shop-app-ta/pause` → 415.
  - `it("refuses a POST from a foreign Origin (403)")` — JSON POST with `origin: https://evil.example` → 403; with `origin: http://127.0.0.1:7420` → not 403; with no Origin header → not 403.
  - `it("refuses an unexpected Host (421)")` — keep the existing rebinding test.
  - Keep `LOG_REDACT` test.
- [ ] **Step 2: Run** `pnpm -s vitest run apps/server/test/api.test.ts` — expect failures (routes still exist, cookie required, no Origin check).
- [ ] **Step 3: Implement** the deletions above and an `onRequest` hook in `buildApp`: for `POST`, if `req.headers.origin` is present and `new URL(origin).hostname` (lower-cased) is not in `LOCAL_HOSTS`, reply 403 `{ error: "cross-origin request refused" }`; an unparsable Origin is also 403.
- [ ] **Step 4: Run** `pnpm -s typecheck && pnpm -s vitest run` — all green (fix every test that logged in: they now call routes without a cookie).
- [ ] **Step 5: Commit** `feat!: no sign-in on the loopback-only hub; refuse cross-origin POSTs`.

### Task 2: Navigation and page set

**Files:**
- Modify: `apps/web/src/App.tsx` (routes and header), `apps/web/src/router.ts`.
- Delete pages and their tests/components no longer reachable: `pages/Loops.tsx`+`.css`, `pages/Cto.tsx`+`.css`, `pages/Metrics.tsx`+`.css`, `pages/NeedsYou.tsx` (its `NeedsYouList` item rendering is superseded by Task 5), `components/loops/`, `components/cto/`, `components/metrics/`, `components/AgentsSummary.tsx`, and tests `Loops.test.tsx`, `Cto.test.tsx`, `Metrics.test.tsx`, `NeedsYou.test.tsx`, `AgentsOverview.test.tsx`. Keep `pages/Config.tsx` as Settings.
- Test: `apps/web/test/App.test.tsx` (new).

**Interfaces:**
- Produces: `route(path: string): Route | null` with
  `type Route = { page: "agents"; sel: Selection | null } | { page: "board"; repoId: string | null } | { page: "settings" }` and
  `type Selection = { kind: "agent"; id: string } | { kind: "need"; id: string }`.
  Paths: `/` → agents, no selection; `/agents/:id` → agents + agent selection; `/needs/:escalationId` → agents + need selection; `/board`, `/board/:repoId`; `/settings`. Old paths redirect with `navigate(..., { replace: true })`: `/needs-you`, `/cto` → `/`; `/boards[/:id]` → `/board[/:id]`; `/config` → `/settings`; `/loops[/:id]` → `/agents/:id` or `/`; `/metrics` → `/`.
- Header: brand, tabs **Agents · Board · Settings**, limits strip (existing `LimitsHeader`), needs-you pill (count, amber; grey "0" state is just the light, no sentence), theme switch (Task 3). No legend bar (its content moves into `Help` icons).

- [ ] **Step 1: Write failing tests** in `App.test.tsx`: `route()` table for every path above (incl. percent-encoded ids and invalid encoding → null); `it("redirects old paths")` for `/needs-you`, `/cto`, `/boards/shop-app`, `/config`, `/loops/shop-app-ta`, `/metrics`; `it("shows three tabs")`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**; remove the legend and Plan 1's CTO/Loops/Metrics routes.
- [ ] **Step 4: Run** `pnpm -s vitest run apps/web && pnpm --filter @cc/web -s typecheck` — green.
- [ ] **Step 5: Commit** `feat(web): three destinations — Agents, Board, Settings`.

### Task 3: Design system — themes, status lights, help icons

**Files:**
- Modify: `apps/web/src/theme.css` (tokens per theme), `apps/web/index.html` (no flash: set `data-theme` before paint from storage).
- Create: `apps/web/src/theme.ts`, `apps/web/src/components/Light.tsx`, `apps/web/src/components/Help.tsx`, `apps/web/src/components/ThemeSwitch.tsx`.
- Test: `apps/web/test/theme.test.ts`, `apps/web/test/Light.test.tsx`.

**Interfaces:**
- Produces:
  - `type LightKind = "ok" | "attention" | "blocked" | "idle" | "working"`; `<Light kind={LightKind} label={string} />` renders a span with class `light light-<kind>` and `role="img"` + `aria-label={label}`; shapes: ok/working = filled circle (working pulses slowly unless `prefers-reduced-motion`), attention = diamond, blocked = square, idle = ring.
  - `lightFor(state: AgentState, hasError: boolean): LightKind` — error or `hasError` → blocked; waiting-you → attention; working → working; waiting-agent → idle; idle → idle.
  - `<Help text={string} />` — a small "?" button with `aria-label="help"`; tooltip on hover and focus, dismiss on Escape; text in a `role="tooltip"` element linked by `aria-describedby`.
  - `theme.ts`: `type ThemeChoice = "system" | "light" | "dark"`; `getTheme(): ThemeChoice`, `setTheme(c: ThemeChoice): void` (writes `localStorage["cc-theme"]` inside try/catch, sets `document.documentElement.dataset.theme` to `light`/`dark` or removes it for system).
  - `THEME_TOKENS: Record<"dark" | "light", Record<TokenName, string>>` exported from `theme.ts` as the single source; `theme.css` mirrors them (a test asserts the CSS file contains each value).
- Token names (both themes): `--bg --bg2 --p --p2 --sel --ln --ln2 --tx --dim --ft --bl --gr --am --rd --pu`. Dark keeps today's values. Light values are the builder's, chosen to pass the contrast test.
- Spacing scale used by tiles and panels: 4/8/12/16 px; stat tiles get 12px padding and tabular numerals (`font-variant-numeric: tabular-nums`).

- [ ] **Step 1: Write failing tests**:
  - `theme.test.ts`: `it("meets AA contrast in both themes")` — for each theme, contrast(`--tx`,`--bg`), (`--tx`,`--p`), (`--dim`,`--bg`), (`--dim`,`--p`), (`--ft`,`--bg`), (`--ft`,`--p`) ≥ 4.5; status colours `--gr --am --rd --bl` against `--p` ≥ 3.0. Compute WCAG relative luminance from hex in the test.
  - `it("theme.css carries every token value")`.
  - `it("setTheme writes storage and the data attribute; system removes it; storage failure is tolerated")`.
  - `Light.test.tsx`: each kind renders its class and accessible label; `lightFor` table for all five states and the error override.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**; `:root` = dark, `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {…light…} }`, `[data-theme="light"] {…}`, `[data-theme="dark"] {…}`.
- [ ] **Step 4: Run** — green.
- [ ] **Step 5: Commit** `feat(web): dark and light themes at AA contrast, status lights, help icons`.

### Task 4: Agents-first main screen

**Files:**
- Rewrite: `apps/web/src/pages/Agents.tsx` (split layout; list left, detail right).
- Create: `apps/web/src/components/AgentList.tsx`, `apps/web/src/components/OvernightStrip.tsx`, `apps/web/src/groups.ts`.
- Remove: `components/AgentCard.tsx` (keep `TicketLine` by moving it to `components/TicketLine.tsx`), `components/ActivityFeed.tsx` stays (used by Task 6).
- Test: `apps/web/test/groups.test.ts`, rewrite `apps/web/test/Agents.test.tsx`.

**Interfaces:**
- Consumes: `RESOURCES.agents` (`AgentView[]`), `RESOURCES.escalations` (`Escalation[]`), `RESOURCES.activity` (`ActivityEvent[]`), `RESOURCES.overview` (`Overview`), `Light`, `lightFor`, `Selection`, `TicketLine`.
- Produces: `groupRows(agents: AgentView[], escalations: Escalation[], activity: ActivityEvent[], now: number): Group[]` in `groups.ts`, where
  `type Group = { key: "needs" | "blocked" | "working" | "idle" | "done"; rows: Row[] }` and
  `type Row = { kind: "need"; escalation: Escalation } | { kind: "agent"; agent: AgentView } | { kind: "done"; event: ActivityEvent }`.
  Rules: needs = every escalation, oldest first; blocked = agents with `sourceError` or state `error`, or whose current run status is `blocked`/`failed`; working = state `working`; idle = `idle` or `waiting-agent`; done = `run-end` events with status `ok` in the last 24h, newest first. Groups with no rows are omitted.
- Row (one line): light, name (agent id, or escalation title for a need), ticket ref + board title (via `TicketLine`), time in state (`dur`), and for agents the account·model in `--ft`. A need row shows the repo#number and age. Clicking navigates to `/agents/:id` or `/needs/:id`; the selected row is highlighted (`--sel`). Keyboard: rows are links.
- Overnight strip: one line above the list — counts from activity in the last 12h: runs ok, runs failed, escalations opened, collector failures — each as `Light` + number; expands (button) to the full activity list (`ActivityFeed`, limit 50). No sentence of description; a `Help` icon explains the window.
- Group headers: short label + count only ("needs you 2", "blocked 1", "working 2", "idle 0" is omitted, "done · 24h 14" collapsed to 5 rows with "show all").

- [ ] **Step 1: Write failing tests**: `groups.test.ts` covers each rule above, omission of empty groups, ordering; `Agents.test.tsx`: renders groups from a fixture, a need row links to `/needs/<id>`, an agent row to `/agents/<id>`, selected row highlighted, overnight counts, and **Review Focus 2**: `it("shows only working and idle groups when nothing needs you or is blocked")` — no "needs you"/"blocked" headers, no filler text.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**. With no selection on a wide screen the right pane shows the first need, else nothing (no placeholder text). At ≤ 760px the detail replaces the list with a back button.
- [ ] **Step 4: Run** — green.
- [ ] **Step 5: Commit** `feat(web): agents-first list grouped by what needs attention`.

### Task 5: Needs-you detail

**Files:**
- Create: `apps/web/src/components/NeedDetail.tsx`.
- Test: `apps/web/test/NeedDetail.test.tsx`.

**Interfaces:**
- Consumes: `Escalation` (with `question: AutonomyQuestion | null`), `githubHref`, `dur`, `dayTime`.
- Produces: `<NeedDetail escalation={Escalation} now={number} />`.
- Sections (omit a section whose data is absent): header (kind tag, title, `repo#n`, raised when, waiting `dur`); **Up to speed** = `question.question` when present; **Assessments** = `question.recommendation`, `question.reasoning_quote`, `question.effort_sunk` as labelled lines; **Your choice** = `question.answers` as option cards, the one equal to (or starting with) `question.recommendation`'s first answer marked "recommended"; `question.default_if_ignored` under the options; **Links**: issue on GitHub. Answering happens on GitHub in this plan: each option card has "answer on GitHub ↗" linking to the issue (answering in the hub arrives with the CTO plan).

- [ ] **Step 1: Write failing tests**: full SD-32 escalation renders all sections and marks the recommended option; **Review Focus 3** `it("renders a title-only escalation without assessments or choices")`; a non-GitHub url renders no link (existing `githubHref` rule); text is escaped (no HTML injection — reuse the `xss.test.tsx` pattern).
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** — green.
- [ ] **Step 5: Commit** `feat(web): needs-you detail — up to speed, assessments, choices`.

### Task 6: Agent detail

**Files:**
- Create: `apps/web/src/components/AgentDetail.tsx`, `apps/web/src/tickets.ts`.
- Remove: `components/RunDrawer.tsx` and its test (superseded).
- Test: `apps/web/test/tickets.test.ts`, `apps/web/test/AgentDetail.test.tsx`.

**Interfaces:**
- Consumes: `AgentView`, `RESOURCES.runs(id)` (`Run[]`), `RESOURCES.activity`, `RESOURCES.overview` (`AgentNumbers` incl. `session`), existing pause/resume `ACTIONS` and `STUDIO_PAUSE_TOOLTIP`.
- Produces: `ticketHistory(runs: Run[]): TicketRow[]` in `tickets.ts`, `type TicketRow = { ticket: string | null; lastAt: number; tries: number; outcome: RunStatus; minutes: number; costUsd: number | null; tokens: number }` — runs grouped by `ticket` (null tickets grouped per contiguous stretch, labelled "no ticket"), newest first, `outcome` = the latest run's status, cost null when no run reported one. `seq` is never displayed.
- Layout: header (light + state + time in state, kind, repo, account·model, live session id short + busy/idle) with controls **pause / resume** (existing behaviour and errors); **Now** — current run's ticket + title, status light, elapsed; **Live** — this agent's activity events (`ActivityFeed`, filter `who === id`, limit 10); **Recent tickets** — table from `ticketHistory` (ticket, outcome light, tries, time, `≈$`, tokens), 15 rows then "show all"; numbers row (runs 24h, ok/failed 14d, tokens 24h, `≈$` 24h) as padded stat tiles. Step bar is not shown in this plan (real steps arrive with the runtime plan).

- [ ] **Step 1: Write failing tests**: `ticketHistory` groups, orders, counts tries, null-cost and null-ticket cases, never exposes `seq`; `AgentDetail` renders header, pause button behaviour (reuse existing 503/409 tests), recent tickets; **Review Focus 4** `it("renders an agent with no runs and a collector error without empty tables")`.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** — green.
- [ ] **Step 5: Commit** `feat(web): agent detail — now, live, recent tickets by ticket not run number`.

### Task 7: Board and Settings in the new style

**Files:**
- Modify: `apps/web/src/pages/Boards.tsx` → rename `pages/Board.tsx`, `components/BoardColumn.tsx`, `pages/Config.tsx` → `pages/Settings.tsx` (+ its components), their tests.

**Interfaces:**
- Board keeps its data and columns (the GitHub-native columns are the next plan) but adopts the design system: cards get a `Light` for blocked/in-progress/done states, counts in column headers, no descriptive sub-headings; repo switcher as a segmented control; `Help` icon for the 7-day done window.
- Settings: theme switch (`ThemeSwitch`) at the top, then the read-only config view and glossary from Plan 1 (glossary entries become the source for `Help` texts where useful; the long intro sentences are removed).

- [ ] **Step 1: Update tests** for the renamed components and the absence of descriptive sentences (assert the old sub-heading strings are gone).
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** — green.
- [ ] **Step 5: Commit** `feat(web): board and settings in the quiet style`.

### Task 8: Design and accessibility pass on the real screens

**Files:** whatever the findings touch; the runbook screenshots (kept outside the repo; recaptured: agents, need detail, agent detail, board, settings — dark and light, 1600px and 390px).

- [ ] **Step 1:** Run the server against a copy of the live database (`sqlite3 <db> ".backup <copy>"`, `CC_DB=<copy>`; stop the launchd job first and restart it after — see runbook) and open every screen in a browser at 1600px and 390px, dark and light.
- [ ] **Step 2:** Run an accessibility audit (the `chrome-devtools-mcp:a11y-debugging` skill or Lighthouse accessibility) on each screen; fix every contrast, focus-visible, keyboard-order, label and tap-target (≥ 24px) finding.
- [ ] **Step 3:** Have a fresh design reviewer (subagent with the `frontend-design` skill) review the screenshots against spec §6.2a and the mockups; fix findings (padding, alignment, wordiness, light semantics).
- [ ] **Step 4:** `pnpm -s lint && pnpm -s typecheck && pnpm -s test && pnpm -s build` — green. Recapture screenshots (no secrets in them).
- [ ] **Step 5: Commit** `fix(web): design and accessibility pass; recapture screenshots`.
