# Mission Control web HUD: speed and readability audit

Date: 2026-10-28. Code: `~/Dev/mc-wt/ui` at `10d5d19e` (a new commit, `ef9addb7`, landed in that worktree partway through the audit; its `dist` is within 20 bytes of the build measured here). Viewport 1600×1000, dark scheme.

## How it was measured

- **Production build**: `pnpm build` in the worktree, plus a sourcemapped copy built to scratch. It was served by my own `vite preview` on :5299, proxied to the preview hub on :7431 (since stopped). I used it for Lighthouse, traces, LCP/CLS, contrast and font scans.
- **Dev build (:5199)**: used for the 60-second live counts. Before navigation, an init script wrapped `fetch` and `EventSource` and installed a React DevTools hook. That hook counted commits and the component fibers that rendered, and a long-task observer ran alongside it. StrictMode and the dev build make the render times about 3–5× worse than production. The counts of commits, fibers and requests are the same in both builds.
- **Preview hub**: the loops are paused (until the 02:00 reset), so the data is mostly static. On the live hub, payloads change more often, so the refetch counts below are a floor.
- **Lighthouse**: the MCP Lighthouse tool does not include the Performance category. Load metrics come from performance traces and PerformanceObserver instead.
- **Artifacts**: the measurement scripts and raw captures were kept locally, not committed.

## 1. Bundle (production)

| Chunk | Raw | Gzip | Loads when |
|---|---|---|---|
| `index` (shell, React DOM 211 kB, app shell) | 367 kB | 118 kB | every route |
| `index.css` | 120 kB | 23 kB | every route |
| `MapScene` (three.js 538 kB + 7 kB of app code) | 550 kB | 137 kB | **only when the Crew Activity Map is expanded** (`map/CrewMap.tsx:12`, gated by `open` at :31). It does not load on first paint for any route. |
| `Setup` | 78 kB | 24 kB | /setup |
| `Overview` | 54 kB | 19 kB | / |
| `Flight` | 39 kB | 12 kB | /flight |
| `Comms` | 39 kB | 13 kB | /comms |
| `Telemetry` | 32 kB | 11 kB | /telemetry |
| `Agent` | 22 kB | 8 kB | /agent |
| `BoardPage` | 21 kB | 8 kB | /board |
| shared (`PrChip` 19 kB, `NeedsList` 9 kB, `StreamPanel` 7 kB, 9 others under 4 kB) | | | as imported |
| fonts: 9 × woff2 | 185 kB | n/a | every route (from `main.tsx:1-9`); the 9 `.woff` fallbacks are never fetched |

JS on first paint, per route (static import closure, raw/gzip):

| Route | Raw | Gzip |
|---|---|---|
| / | 435 kB | 143 kB |
| /flight | 410 kB | 132 kB |
| /board | 386 kB | 126 kB |
| /agent | 409 kB | 134 kB |
| /comms | 414 kB | 136 kB |
| /telemetry | 394 kB | 128 kB |
| /setup | 438 kB | 140 kB |

On every route, the CSS (120 kB) and the 9 fonts (185 kB) load on top of that JS.

How the hub serves these:
- **Assets**: `cache-control: immutable` (good), but **no compression** on assets or on the API (`content-length` is the raw size).
- **Protocol**: HTTP/1.1.
- **Route chunk**: no `modulepreload` for the page's own chunk, so the request chain is document → `index.js` → `Overview.js` → APIs.

## 2. Per-page measurements

### Load: production trace and PerformanceObserver

| Page | FCP | LCP | CLS | API requests on load | Max time a request waited for a connection | Lighthouse a11y / BP |
|---|---|---|---|---|---|---|
| / | ~70 ms | 1,337 ms (trace), 2,092 ms (cold, no cache) | 0.03 | 24–29 | **1,523 ms** | 94 / 100 |
| /flight | 64 ms | 616 ms | 0.037–0.116 | 27–49 | 340 ms | 100 / 100 |
| /board | ~70 ms | 319 ms | **1.37–1.50** | 29 | n/a | 100 / 100 |
| /agent/guido-cx | 68 ms | 1,036 ms | 0.035–0.044 | 29–34 | 1,008 ms | 100 / 96 |
| /comms/crew | 68 ms | 496 ms | 0.02 | **67–68** | 556 ms (last API done 3,382 ms) | 100 / 100 |
| /telemetry | 80 ms | 576 ms | **0.141** | 19 | 317 ms | 100 / 100 |
| /setup | 68 ms | 68 ms | 0 | 27 (dev count) | n/a | 96 / 100 |

Notes on the load numbers:
- **Overview LCP breakdown**: 87% render delay (1,162 of 1,337 ms), meaning the page waits on data. The critical chain is 3.4 s, and its last link is `/api/activity?since=`.
- **Connection queueing**: on HTTP/1.1 Chrome opens 6 connections per host, and the EventSource holds one. So 24–68 parallel API GETs queue for up to 1.5 s.
- **Proxy caveat**: these timings went through a Vite proxy. The queueing is a property of the browser and applies to the hub directly as well.
- **Lighthouse failures**: Overview has `color-contrast` (2 nodes) and `target-size` (15 nodes). Flight has `label-content-name-mismatch` (2). Comms has `label-content-name-mismatch` (6 graph nodes). Setup has `target-size` (6). Agent has `errors-in-console`: a `409` on `/api/seats/guido-cx/context`.
- **SEO and agentic categories**: the meta-description, robots and llms.txt failures do not matter for a localhost console.

### Live behaviour over 60 s (dev build, preview hub)

The SSE stream carried **29–38 `changed` events per minute**. A raw curl over 60 s showed:
- `agents` 8, `health` 8, `attention` 8, `machine` 5, `limits` 1, `boards` 1.

I sampled `/api/crew`, `/api/attention`, `/api/flight`, `/api/notifications/events`, `/api/agents/guido-cx/stream` and `/api/comms/agents/guido-cx` 6 times over 42 s. Every sample was **byte-identical**: the events fire without a data change. `/api/overview`, `/api/flight/summary` and `/api/health` changed on every sample.

| Page | Requests/min | Bytes/min | Commits/min | Component renders/min | Biggest re-renderers/min | Dev long tasks/min (p50) | DOM nodes |
|---|---|---|---|---|---|---|---|
| / | **161** | **3.47 MB** | 295 | **161,158** (max 1,203 per commit) | AgentTag 17.8k, RepoRef/ExternalLink 17.6k, TicketRef 16.8k, ActivityText/Expandable 16.4k (≈274 activity rows × 60) | **66** (160–350 ms, one every second at :x.303) | 3,083 |
| /flight | 94 (`/api/flight/summary` **16×**) | 1.92 MB | 200 | 22,318 | Pill 2.9k, MarkdownInline 2.4k | 48 (66 ms) | 765 |
| /board | 53 | 1.69 MB | 159 | 5,759 | Tab 600, Pill 600 | 101 (66 ms)\* | **9,310** |
| /agent/guido-cx | 95 (`/api/activity?since` 16×) | 2.70 MB | 202 | 35,562 | **EventRow 15.5k** (≈258 rows × 60), ToolText 4.4k | 28 (69 ms) | 1,136 |
| /comms/crew | **165** | **6.67 MB** | 266 | 10,303 | CountBadges 1.3k, AgentNavRow 1.1k | 3 | 491 |
| /telemetry | 62 | 1.94 MB | 180 | 19,431 | AgentTag 2.1k, HBar 1.5k | 29 (57 ms) | 1,163 |
| /setup | 55 | 1.53 MB | 157 | 4,829 | Tab 600, AccountMeter 456 | 0 | 211 |

\* For Board, a 10 s production idle check showed 0 long tasks. Its dev long tasks are dev-mode overhead.

Production check on Overview:
- At 1× CPU: 237 commits/min, 151,583 component renders/min, a median of **976 components re-rendered per commit**, and 0 long tasks.
- At 4× CPU throttle: 1 long task (51 ms) in 30 s.
- So in production the per-second churn is a steady CPU and battery cost, not visible jank. In dev it is 160–350 ms of main-thread time every second.

**Baseline cost of the shell on every page**: the header, dock, item panel and notifications refetch these on each `agents`/`attention` event:
- `/api/crew` (139 kB): **1.1–1.5 MB/min on its own**
- `/api/flight`
- `/api/attention` (14 kB)
- `/api/notifications`
- `/api/notifications/events` (35 kB)
- `/api/agents/flight-1/stream` (23 kB)

Together that is about 1.5 MB/min per open tab, even on /setup. None of this pauses when the tab is hidden: only `map/` checks `document.hidden`.

**Duplicate fetches on load**:
- 5–6 shell resources are fetched 2× on every page.
- Flight: `/api/flight/summary` 5×, and 10 resources 3×.
- Comms: 17 resources 3× each, including every agent's full comms history.
- Cause: SSE events arrive while the first responses are still queued, and `refetchTopic` re-queues them.

### Interaction (INP-relevant, production)

Keyboard Enter on a header tab:
- Overview → Board: 104 ms (37 ms processing). Board is 9,316 nodes, rendered synchronously.
- Board → Overview: 64 ms.
- First visit to Board: 16 ms (the render is deferred to data arrival).

All of these are under the 200 ms INP threshold. The Board figure is the one to watch as the Done column grows.

### Payload findings

- **`/api/crew`** is 138,761 B. Of that:
  - `digest` is 131 kB, and `digest.attemptUsage` is **101,857 B**, which the web never reads (grep: only server files use it).
  - `turnUsage` (12 kB) is also unread by the web.
  - One seat, `guido-cx`, is 65.8 kB on its own (226 `attemptUsage` entries).
  - Gzipped the payload is 27.7 kB, but nothing is compressed today.
- **`/api/repos/<repo>/prs?linked=1`** is 395 kB for mission-control, 639 kB for eBull and 406 kB for autonomy-engine. Of mission-control's 337 PRs, **324 are merged**, and `checks` is 192 kB of the payload.
  - Every page fetches the mission-control one (via `useReviewPrs`, `data.ts:557`) just to title the one PR a seat waits on.
  - Board fetches all three: **1.44 MB per Board load**.
- **`/api/comms/agents/<id>`** is 224 kB for guido-cx and 214 kB for inco-cx. Comms fetches all 8 agents' full histories (`comms/CommsNav.tsx:31`) just to count 24 h messages and unread, and refetches all of them on every `agents` event: 5.1 MB/min.
- **`/api/away/digest`** (109 kB) is fetched on every page load (`shell/AwayDigest.tsx:24`). It is shown only after an away period.
- **`/api/notifications/events`** (35 kB, 69 events) is fetched as the full list on every `attention` event (`browserNotifications.ts:99`).

## 3. Accessibility and legibility (production, dark)

### Lighthouse and the contrast scan

I computed WCAG ratios for every visible text node, using a canvas to resolve the colours and composing backgrounds and opacity:
- **Dark mode**: one real failure. Seat colour `--s6 #008300` on `#0c1117` is **3.83:1**, used for the agent name on Overview (14 px) and the timeline lane label (12 px).
- **Hover-only actions**: Comms has 21 "Reply" and "React" buttons at `opacity: 0` until hover. They reveal on `:focus-within` (`hud.css:3447`), so keyboard users are fine. Mouse users see nothing until hover.
- **Light mode**: 18 failures, all seat colours. `--s1 #2a78d6` and `--s2 #eb6834` fall as low as **2.17:1**; `.dock-unread` is 2.76:1.

### Names, roles, headings and focus

- **Missing names**: none. Every button, link, input and tab had an accessible name on all 7 pages.
- **Label/name mismatch**:
  - Flight pulse buttons: the visible text is "14h 52m CYCLE TIME 24 H"; the aria-label is "Cycle time: 14h 52m median…".
  - Comms graph nodes: the visible text is "GUIDO-CX 9"; the aria-label is "Open guido-cx, 9 messages in 24h".
  - Voice-control users say the visible text, so these should start with it.
- **Headings**:
  - There is **no `<h1>` on 6 of 7 pages**.
  - Setup has `H2 "Setup"` before `H1 "Accounts"`.
  - **Board has 0 headings**: the column titles are not headings, so a screen reader cannot jump between columns.
- **Landmarks**: main, nav, header, footer and aside are present. Live regions: `#actList`, `#dockMsgs`, `#toast`.
- **Focus**:
  - A global `:focus-visible` gives a 2 px outline (`hud.css:307`). Tab order starts at the header tabs.
  - **There is no skip link**. Board has **1,618 tab stops**, so getting past the board to the dock takes over 1,600 presses.
- **Modals**:
  - The Help modal (`?`) has `role=dialog aria-modal=true`. Focus goes to Close and stays trapped (Tab and Shift+Tab stay inside), and Escape closes it.
  - The Item panel (Answer → `aside.flyout`) moves focus to Close. Escape closes it and **returns focus to the opener**.
  - There are no keyboard traps.
- **Target size** (WCAG 2.2, 24 px):
  - Overview: Agents rows are 15.5 px tall; the "Answer" button is 43×14 px; timeline lanes are 21.5 px.
  - Setup: the account action buttons are 21.6 px.

### Text legibility at 1600×1000

Most HUD text is 11 px (`--fs-xs`, `hud.css:62`). The share of visible text elements at each size:

| Page | ≤10.5 px | 11 px | ≥12 px |
|---|---|---|---|
| / | 40 (3%) | 660 (54%) | 519 (43%) |
| /flight | 30 (14%) | 84 (41%) | 93 |
| /board | **1,243 (24%)** | 3,136 (62%) | 700 |
| /agent | 10 | 482 (69%) | 209 |
| /comms | **56 (35%)** | 56 | 48 |
| /telemetry | 42 (11%) | 151 | 179 |
| /setup | 9 | 36 | 51 |

Sub-11 px declarations that carry information the operator must read:

| Size | Where (`hud.css` unless noted) | What it shows |
|---|---|---|
| 10 px | `.lb`, :2420 | Board card labels. **1,242 instances** on Board. |
| 10 px | `#agentsList .agent-model`, :1709 | Model and effort per seat. |
| 10 px | `#agentsList .need button`, :1676 | The "Answer" and "End the run" action buttons; also 14 px tall. |
| 10 px | `#quotaP .meter .num`, :2130 | "5h 19% · 4m ago" |
| 10 px | `.overview-kpi .lbl`, :7102 | KPI labels |
| 10 px | `.overview-axis`, :1305 | Timeline axis |
| 10 px | `.overview-legend`, :1436 | Timeline legend |
| 10 px | `.ct`, :4024 | All chart axis text: 31 instances on Telemetry. |
| 10 px | `.accounts-table th`, :4200 | Setup column headers |
| 10 px | `.comms-message-meta > span:first-child`, :3422 | Message timestamps |
| 10 px | `.comms-actions button`, :3457 | Comms action buttons |
| 10 px | `.comms-nav` unread/mention counts, :3122 | Comms unread and mention counts |
| 10 px | `CommsGraph.css` :34, 61, 131, 215, 310, 333, 356, 411, 491, 512, 586 | Graph labels, readout and traffic stats |
| 9 px | `.kpi-peak` / `.kpi-quiet`, :7141 | KPI peak/quiet |
| 9 px | `.kpi-axis`, :7152 | KPI axis |
| 9 px | `#wifP .wstep .titer`, :5237 | Retry count ("× 9") |
| 9 px | `CommsGraph.css:544` | Comms chart ticks |
| 10.5 px uppercase | `.lbl`, :399 | Tile labels |
| 10.5 px uppercase | `.flight-*` heads, :4820–5753 (14 rules) | Flight "Clear now", "Next up", pulse labels, "Owner" headers, "Open comms" links |
| 10.5 px uppercase | `.dwait .dwh`, :3852 | Dock "Waiting on you · N" |
| 10.5 px uppercase | `.bsec` :4614, `.bs` :5903 | |
| 0.6 em | `.flight-unit`, :5022 | Units |
| 0.92 em | `.md code`, :6531 | Inline code in markdown (≈10.1 px) |

## 4. Ranked fixes

Ranked by expected effect on what the operator feels (CPU, latency, readability), then by effort. Fixes 1–4 together remove most of the measured churn.

1. **Stop re-rendering the whole app every second**: `apps/web/src/App.tsx:190`.
   - **Cause**: `useShellKeys` calls `useSecond()` only to stash `now` in a ref that is read on keypress (:200–213). App therefore re-renders every second, and so does every page under it (no `memo` on `PageView` or pages).
   - **Fix**: read `Date.now()` inside the key handler instead.
   - **Expected effect**: Overview drops from about 976 components per commit to only the clock consumers. The ~274 ActivityText rows stop re-rendering every second (`ActivityPanel` itself only needs the 5 s `useNow`). This removes the 66 per-minute dev long tasks seen at :x.303. It is a one-line change.

2. **Stop emitting `agents`/`health` (and therefore `attention`) when nothing changed**: `apps/server/src/scheduler.ts:688`, `:708`, `:799`.
   - **Cause**: these emit after every ta/studio/github tick unconditionally. `scheduler.ts:401` then adds `attention` to every `agents` emit, and `api.ts:853-857` clears the response cache on each emit.
   - **Fix**: emit only when the collector reports a change, as the github tick already does for boards and escalations at :796-797.
   - **Expected effect**: 24 of the ~30 events per minute vanish on a quiet hub, and with them roughly 80% of every page's refetches (1.5–6.7 MB/min per tab). The server also stops rebuilding `/api/crew` (50 ms) and `/api/overview` (147 ms) for every tab on every tick.

3. **Do not publish an unchanged snapshot**: `apps/web/src/data.ts:371` and `:444-452`.
   - **Cause 1**: `fetch()` notifies every listener with `{loading: true}` before each request (:371). That doubles the commits per refetch, and no consumer is known to need it while data is already shown.
   - **Cause 2**: :452 always sets a new object.
   - **Fix**: skip the loading notification when `data !== undefined`. Compare the response text (or an ETag) with the previous one and keep the old snapshot when identical.
   - **Expected effect**: the measured byte-identical payloads (`/api/crew`, `/api/attention`, `/api/flight`, the streams and the comms histories) cause 0 re-renders instead of 2 commits each. This is a backstop for (2) and for live data that changes rarely.

4. **Strip `attemptUsage` (and `turnUsage`) from `/api/crew`**: `apps/server/src/hud.ts:553`.
   - **Cause**: it already strips `toolStarts`, but the web never reads `attemptUsage`.
   - **Fix**: strip these too.
   - **Expected effect**: 139 kB → about 25 kB per fetch (−82%). This is the largest per-request saving on every page, since every page subscribes to crew.

5. **Make linked-PR fetches proportional**: `apps/web/src/data.ts:133-136`, `:557-558`; `BoardPage.tsx:80`; `agent/RunsPanel.tsx:138`.
   - **Cause**: `/api/repos/<id>/prs?linked=1` returns every PR ever linked (324 of 337 merged) with full `checks`.
   - **Fix**: add `state=open` (or ticket filters) for `useReviewPrs`, and drop `checks` for merged PRs.
   - **Expected effect**: Overview, Flight and Agent stop loading 395 kB to title one PR. Board load drops from 1.44 MB to probably under 100 kB.

6. **Comms nav counts from a summary endpoint**: `apps/web/src/comms/CommsNav.tsx:31`.
   - **Cause**: one full `/api/comms/agents/<id>` (up to 224 kB) is fetched per agent row, to compute a 24 h count and `unread`.
   - **Fix**: serve `{ id, recent24h, unread }` for all agents in one call. Fetch a full history only for the open conversation.
   - **Expected effect**: Comms drops from 165 requests and 6.67 MB per minute to about 30 requests and well under 0.5 MB per minute. Load drops from 67 requests to about 25.

7. **Fix Board layout shift and DOM size**: `pages/BoardPage.tsx:79-80`, `:131`, `:149`, `:192`.
   - **CLS**: 1.37–1.50, from five shifts between 286 and 516 ms on `.boardsplit`, `.kcol` and `.kcard`. The loading gate (:192) waits only for boards. PRs (:80) and loop views (:131) arrive later and re-flow the cards. (This is inferred from the trace's shift timing plus the code.)
   - **Fix for CLS**: gate on all three, or reserve chip space.
   - **DOM**: 362 Done cards (6,514 of 9,311 nodes) and 190 Backlog cards render eagerly, which makes 1,618 tab stops.
   - **Fix for DOM**: cap Done to the visible range or virtualise the columns.
   - **Expected effect**: CLS below 0.1, DOM about 3k, the tab switch to Board drops from 104 ms to about 40 ms, and keyboard users get a usable tab order.

8. **Agent page per-second render**: `pages/Agent.tsx:27`, `:78`, `:80`.
   - **Cause**: `now` (1 s) is passed into `StreamPanel` and `RunsPanel`, so about 258 `EventRow`s re-render every second (15.5k/min). Only `LiveCall` (`agent/StreamPanel.tsx:158-184`) needs seconds.
   - **Fix**: let `LiveCall` call `useSecond()` itself, and pass `useNow()` or nothing to the rest. Alternatively, `memo(EventRow)`.
   - **Expected effect**: about 95% fewer renders on the Agent page.

9. **Pause refetching in hidden tabs**: `apps/web/src/data.ts:466-509`, `:622-675`.
   - **Cause**: no `visibilitychange` handling outside `map/`, so a background tab keeps pulling 1.5–6.7 MB/min.
   - **Fix**: when `document.hidden`, mark topics dirty instead of fetching, and refetch the dirty ones on `visible`.
   - **Expected effect**: zero background traffic. The pop-out agent windows (`?popout=1`) still need their own policy.

10. **Each tab's EventSource holds one of the browser's 6 HTTP/1.1 connections to the hub**: `apps/web/src/data.ts:636`, plus the hub's HTTP/1.1 listener.
    - **Measured**: with one tab, API requests wait up to 1.5 s for a connection on Overview load. This queueing is the main reason Overview LCP is 1.3–2.1 s while FCP is about 70 ms.
    - **Risk**: Chrome allows 6 connections per host across all tabs. With pop-outs or several HUD tabs, each tab's SSE takes one of those 6, so with 6 tabs open every fetch stalls.
    - **Fix options** (any one helps):
      - share one stream across tabs (BroadcastChannel or a SharedWorker);
      - serve HTTP/2 (needs TLS locally);
      - cut the number of load-time requests with (2), (11) and (12).

11. **Coalesce and deduplicate load-time requests**: `apps/web/src/data.ts:349-351`, `:495-506`.
    - **Cause**: shell resources are fetched 2× and Flight/Comms resources 3× (Flight summary 5×) during load, because events arriving while requests are queued trigger `e.again`. `/api/flight/summary` is refetched 16×/min, from the `attention` + `agents` + `flight` topics (:479-485).
    - **Fix**: debounce `refetchTopic` per entry, for example to 250 ms (it already exists for array-topic entries).
    - **Expected effect**: about 30–50% fewer load requests, and summary refetches halved.

12. **Do not fetch the away digest unless it will show**: `shell/AwayDigest.tsx:24`.
    - **Cause**: 109 kB is fetched on every page load and on `settings` events, but only `startedAt` is used when hidden.
    - **Fix**: a light `?meta=1` call, or fetch only after `away` says a period ended.
    - **Expected effect**: −109 kB and −1 queued request on every load.

13. **Incremental notification events**: `browserNotifications.ts:99`, `data.ts:75`.
    - **Cause**: the full 35 kB list is fetched on every `attention` event.
    - **Fix**: use a `since` cursor, as activity already does.
    - **Expected effect**: −280 kB/min per tab.

14. **Compress API JSON and assets on the hub**: the static server is `apps/server/src/web.ts:103`; the API is the Fastify app.
    - **Expected effect**: `/api/crew` 139 → 28 kB, `index.js` 367 → 118 kB on cold load (assets are already immutable-cached).
    - **Tradeoff**: on localhost, bandwidth is cheap and CPU is not, so this matters less than (2)–(6). Do it only for responses over about 8 kB.

15. **Raise the information-bearing type floor to 11 px, and to 12 px for actionable or critical items.**
    - **Highest value** (most instances, needed for decisions):
      - `.lb` board labels, `hud.css:2422`: 1,242 instances.
      - `#agentsList .agent-model` :1709 and `#agentsList .need button` :1676 (an action button at 10 px and 14 px tall).
      - `#quotaP .meter .num` :2130.
      - `.ct` chart text :4024.
      - Comms timestamps :3422 and action buttons :3457.
      - The 9 px `.kpi-peak` / `.kpi-axis` :7141 / :7152 and `#wifP .wstep .titer` :5237.
    - **Then**: the 14 `.flight-*` 10.5 px uppercase heads (:4820–5753) and `CommsGraph.css`'s eleven 10 px rules.
    - **Expected effect**: on Board, 24% of text moves from 10 px to 11 px or larger; on Comms, 35%. It costs a few pixels of density per row.

16. **Seat colour contrast**: `--s6 #008300` (`hud.css:45`, `:94`, `:135`, `:175`; `theme.ts:92`, `:132`) is 3.83:1 on surface.
    - **Fix (dark)**: lift it to about `#1fa31f` or brighter for ≥4.5:1 on `#0c1117`. Alternatively, keep the swatch colour and render the name in `--fg` with a coloured dot.
    - **Fix (light)**: `--s1` and `--s2` reach 2.17:1. Use darker light-theme seat text tokens, separate from the swatch colours.

17. **Target size**: `#agentsList .need button` (`hud.css:1676`: `min-height: 14px`), the `.rowlink` agent names, the `.overview-lane` rows (21.5 px) and the Setup `button.sm` (21.6 px).
    - **Fix**: a 24 px minimum hit area, through padding or `::after` hit-slop.
    - **Expected effect**: clears Lighthouse `target-size` on Overview and Setup (a11y 94/96 → 100).

18. **Headings and skip link**:
    - Add one `<h1>` per page. It can be visually hidden, as the page name.
    - Make the Board column titles `<h2>`.
    - Fix Setup's H2-before-H1.
    - Add a "Skip to main" link, and ideally a "Skip to FLIGHT dock" link, before the header tabs.
    - **Expected effect**: screen-reader navigation by heading on all pages, and Board's 1,618 tab stops become skippable.

19. **Accessible names should start with the visible text**: the Flight pulse buttons (`label-content-name-mismatch`, 2) and the Comms graph nodes (6).
    - **Fix**: use aria-labels such as "14h 52m cycle time, median Ready → merged, 24 h" and "GUIDO-CX 9, open guido-cx, 9 messages in 24h".
    - **Expected effect**: Flight and Comms clear that audit, and voice-control users can activate the controls by what they see.

20. **Non-composited infinite animations**: `.pulse-warn` animates `box-shadow` (`hud.css:782-795`), `.pulse-ok` (:796) does the same, and border-colour transitions run on cards. All of them repaint every frame on Board cards.
    - **Fix**: animate `opacity` on a pseudo-element instead.
    - **Expected effect**: less paint while idle. Production Board idle showed no long tasks, so this is a low-priority power fix. `prefers-reduced-motion` is already honoured.

21. **Preload the route chunk**: emit `<link rel="modulepreload">` for the current route's page chunk, or import Overview eagerly.
    - **Expected effect**: removes one round trip (about 150–360 ms in the trace) from the index → page → API chain on cold load.

22. **Minor items**:
    - The `409` on `/api/seats/guido-cx/context` logs a console error on every Agent load (Lighthouse best-practices 96). Treat 409 as "not running" without a failed fetch, or have the server answer 200 with a state.
    - The header clock spans change height by 1 px on a tick (a zero-value layout shift on `.top-status`). Set `font-variant-numeric: tabular-nums` and a fixed line-height.
