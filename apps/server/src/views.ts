/**
 * Read-only aggregates for the Activity and Config pages (`/api/activity`, `/api/config`),
 * computed from the store on each request. `overview` and `metrics` have no route now.
 */
import {
  ACTIVITY_LIMIT,
  ACTIVITY_WINDOW_MS,
  type ActivityRow,
  type AgentId,
  type AgentNumbers,
  BOARD_DONE_MS,
  type BoardItem,
  BUILTIN_ROLES,
  CHECK_EVENT,
  COMMS_PREVIEW_MAX,
  type ConfigView,
  type CrewEvent,
  cutAtWord,
  type Metrics,
  type MetricsDay,
  modeOfSeat,
  type Overview,
  type Run,
  seatDef,
  TICKET_STATES,
  type TicketState,
  tokenTotal,
} from "@mc/core";
import { type LiveSession, sessionForLoop } from "./collectors/sessions.ts";
import { agentIds, type CcConfig, configuredAgents, seatUnavailable } from "./config.ts";
import { type PrCache, runPrs, runTicket } from "./runview.ts";
import type { Store } from "./store.ts";

const MINUTE_MS = 60e3;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const METRICS_DAYS = 14;
/** The `who` of an Activity row the hub itself wrote (an automatic update). */
export const HUB_EVENT_WHO = "hub";
const FORTNIGHT_MS = METRICS_DAYS * DAY_MS;

/** Sum of the reported costs; null when no run reported one. */
const costOf = (runs: Run[]): number | null => {
  const known = runs.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

/**
 * When a run's wall time ends: its end, or now while it is running. A run with no end that is not
 * running (`unknown`: its loop died mid-run) has no known duration, so it ends where it started
 * rather than accruing busy time until someone looks.
 */
export const endOf = (r: Run, now: number): number =>
  r.endedAt ?? (r.status === "running" ? now : r.startedAt);

/** A run overlaps [since, now) when it started before now and was still going at `since`. */
const overlaps = (r: Run, since: number, now: number): boolean =>
  r.startedAt < now && Math.max(endOf(r, now), r.startedAt + 1) > since;

/** Wall time of a run inside [since, now), in ms. */
export const clippedMs = (r: Run, since: number, now: number): number =>
  Math.max(0, Math.min(endOf(r, now), now) - Math.max(r.startedAt, since));

/** `YYYY-MM-DD` in `timeZone` (the en-CA locale formats dates that way). */
export const dayFormatter = (timeZone: string): ((ms: number) => string) => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ms) => fmt.format(ms);
};

/** The `n` calendar days ending with `today` (`YYYY-MM-DD`), oldest first; DST-safe date math. */
export const lastDays = (today: string, n: number): string[] => {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(base - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
};

const boardItems = (config: CcConfig, store: Store): BoardItem[] =>
  config.repos.flatMap((r) => store.board(r.id));

/** Closed on GitHub, or in a Done Status. */
const isDone = (i: BoardItem): boolean => i.closed || i.state === "done";

const closedIn = (items: BoardItem[], since: number, now: number): number =>
  items.filter((i) => isDone(i) && i.updatedAt > since && i.updatedAt <= now).length;

/**
 * Per-agent numbers over the last 24h and 14d. A run counts in a window when it overlaps it;
 * busy time is clipped to the window. ok14d = status "ok", failed14d = status "failed" only:
 * "blocked" (the loop stopped for the operator) is an outcome in neither, like running/unknown.
 * `liveSessions` null (the registry could not be read) gives every agent a null session.
 */
export function overview(
  config: CcConfig,
  store: Store,
  liveSessions: LiveSession[] | null,
  now: number,
): Overview {
  const since24h = now - DAY_MS;
  const since14d = now - FORTNIGHT_MS;
  const runs14d = store.runsOverlapping(since14d, now);
  const agents = configuredAgents(config).map((agent): AgentNumbers => {
    const mine = runs14d.filter((r) => r.agentId === agent.id);
    const mine24h = mine.filter((r) => overlaps(r, since24h, now));
    // The registry lists the loops' own sessions; a crew seat's session is Mission Control's.
    const live =
      liveSessions && agent.kind === "loop" ? sessionForLoop(liveSessions, agent.loop) : null;
    return {
      agentId: agent.id,
      runs24h: mine24h.length,
      runs14d: mine.length,
      ok14d: mine.filter((r) => r.status === "ok").length,
      failed14d: mine.filter((r) => r.status === "failed").length,
      tokens24h: mine24h.reduce((n, r) => n + tokenTotal(r.tokens), 0),
      tokens14d: mine.reduce((n, r) => n + tokenTotal(r.tokens), 0),
      costUsd24h: costOf(mine24h),
      costUsd14d: costOf(mine),
      busyMinutes14d: mine.reduce((n, r) => n + clippedMs(r, since14d, now), 0) / MINUTE_MS,
      session: live ? { id: live.sessionId, startedAt: live.startedAt, status: live.status } : null,
    };
  });

  const items = boardItems(config, store);
  const tickets = Object.fromEntries(TICKET_STATES.map((s) => [s, 0])) as Record<
    TicketState,
    number
  >;
  // Storage keeps done items 30 days; the overview's done count stays a 7-day one.
  // A closed issue is done whatever its Status says; work in progress counts open items only.
  for (const i of items) {
    const state = i.closed ? "done" : i.state;
    if (isDone(i) && now - i.updatedAt > BOARD_DONE_MS) continue;
    tickets[state] += 1;
  }

  const runs24h = runs14d.filter(
    (r) => overlaps(r, since24h, now) && agents.some((a) => a.agentId === r.agentId),
  );
  return {
    agents,
    tickets,
    closed24h: closedIn(items, since24h, now),
    closed14d: closedIn(items, since14d, now),
    tokens24h: agents.reduce((n, a) => n + a.tokens24h, 0),
    costUsd24h: costOf(runs24h),
  };
}

/**
 * What a test-lock holder or waiter is called: "{repoId} full suite" when `command` is one of its
 * seat's repo's full_suite entries, else the command itself.
 */
export function lockLabel(config: CcConfig, seatId: string, command: string): string {
  const session = config.crew?.sessions.find((s) => s.seats.some((seat) => seat.id === seatId));
  const repo = config.repos.find((r) => r.id === session?.repoId);
  return repo?.fullSuite?.includes(command) ? `${repo.id} full suite` : command;
}

/**
 * The last 24h as events, newest first, at most ACTIVITY_LIMIT: run starts and ends of the
 * configured agents, escalations opened, collectors currently failing (at their latest status),
 * board Status moves that finished, CI checks, commits, test-lock turns and guard denials.
 * Test-lock turns only include holds started in the window, even if an older hold ended in it.
 */
export function activity(
  config: CcConfig,
  store: Store,
  now: number,
  options: { since?: number; limit?: number } = {},
): ActivityRow[] {
  const since = now - ACTIVITY_WINDOW_MS;
  const known = new Set<AgentId>(agentIds(config));
  const events: ActivityRow[] = [];
  const cache: PrCache = new Map();
  const plain = { ref: null, url: null, status: null, prs: [], summary: null };
  for (const r of store.runsOverlapping(since, now)) {
    if (!known.has(r.agentId)) continue;
    const prs = runPrs(config, store, r, cache);
    const ticket = runTicket(r, prs);
    const base = {
      who: r.agentId,
      ref: ticket,
      url: null,
      status: r.status,
      prs,
      summary: r.summary,
    };
    if (r.startedAt >= since) {
      const on = ticket ? ` on ${ticket}` : "";
      events.push({
        ...base,
        at: r.startedAt,
        kind: "run-start",
        text: `started${on}`,
      });
    }
    if (r.endedAt !== null && r.endedAt >= since) {
      const tail = ticket ? ` · ${ticket}` : "";
      const cost = r.costUsd === null ? "" : ` · ≈$${r.costUsd.toFixed(2)}`;
      const what = r.summary ? ` · ${r.summary}` : "";
      events.push({
        ...base,
        at: r.endedAt,
        kind: "run-end",
        text: `${r.status}${tail}${cost}${what}`,
      });
    }
  }
  for (const e of store.escalations()) {
    if (e.openedAt < since) continue;
    events.push({
      at: e.openedAt,
      who: e.repoId,
      kind: "escalation",
      text: e.title,
      ref: `${e.repoId}#${e.issueNumber}`,
      url: e.url,
      status: null,
      prs: [],
      summary: null,
    });
  }
  for (const s of store.status()) {
    if (s.ok || s.at < since) continue;
    events.push({
      at: s.at,
      who: s.collector,
      kind: "collector",
      text: `failing: ${s.error ?? "collector failed"}`,
      ref: null,
      url: null,
      status: null,
      prs: [],
      summary: null,
    });
  }
  for (const e of store.agentEvents(since)) {
    if (!known.has(e.agentId)) continue;
    events.push({ ...plain, at: e.at, who: e.agentId, kind: "state", text: e.text });
  }
  for (const m of store.boardMoves(since)) {
    const ref = `${m.repoId}#${m.issue}`;
    const failed = m.state === "failed" ? ` failed: ${m.detail ?? "unknown"}` : "";
    events.push({
      ...plain,
      at: m.at,
      who: store.run(m.runId)?.agentId ?? m.repoId,
      kind: "board",
      text: `${ref} → ${m.column}${failed}`,
      ref,
    });
  }
  for (const e of store.loopEvents(since)) {
    const run = store.run(e.runId);
    events.push({
      ...plain,
      at: e.at,
      who: run?.agentId ?? e.runId,
      kind: CHECK_EVENT.test(e.text) ? "check" : "loop",
      text: e.text,
      ref: run?.ticket ?? null,
    });
  }
  for (const c of store.runCommitsSince(since)) {
    if (!known.has(c.agentId)) continue;
    events.push({
      ...plain,
      at: c.at,
      who: c.agentId,
      kind: "commit",
      text: `Committed ${c.sha.slice(0, 7)}`,
      ref: c.ticket,
    });
  }
  for (const l of store.lockRuns(since)) {
    if (!known.has(l.seatId)) continue;
    const label = lockLabel(config, l.seatId, l.command);
    const row = { ...plain, who: l.seatId, kind: "lock" as const, ref: l.ticket };
    if (l.queuedAt < l.startedAt && l.queuedAt >= since) {
      events.push({ ...row, at: l.queuedAt, text: `In line for the test lock: ${label}` });
    }
    if (l.startedAt >= since)
      events.push({ ...row, at: l.startedAt, text: `Took the test lock: ${label}` });
    if (l.endedAt !== null && l.endedAt >= since) {
      const text = l.outcome === "done" ? "Done with the test lock" : "Test lock freed";
      events.push({ ...row, at: l.endedAt, text: `${text}: ${label}` });
    }
  }
  const ticketOf = new Map<string, string | null>();
  const hitTicket = (runId: string): string | null => {
    if (!ticketOf.has(runId)) ticketOf.set(runId, store.run(runId)?.ticket ?? null);
    return ticketOf.get(runId) ?? null;
  };
  for (const h of store.guardHits(since, ACTIVITY_LIMIT)) {
    if (!known.has(h.agentId)) continue;
    events.push({
      ...plain,
      at: h.at,
      who: h.agentId,
      kind: "guard",
      text: `Denied: ${h.text}`,
      ref: h.runId === null ? null : hitTicket(h.runId),
    });
  }
  for (const e of store.hubEvents(since)) {
    events.push({ ...plain, at: e.at, who: HUB_EVENT_WHO, kind: "state", text: e.text });
  }
  // CAPCOM and MC are not agents, so comms rows are not filtered by `known`.
  for (const c of store.comms(since)) {
    events.push({
      ...plain,
      at: c.at,
      who: c.from,
      to: c.to,
      kind: "comms",
      text: cutAtWord(c.text.replace(/\s+/g, " ").trim(), COMMS_PREVIEW_MAX),
      ref: c.ticket,
    });
  }
  // A PR is the work of the agent whose run published it, else of its repo.
  const publisher = new Map<string, AgentId>();
  for (const r of store.runsOverlapping(since - ACTIVITY_WINDOW_MS, now)) {
    if (!known.has(r.agentId)) continue;
    for (const p of runPrs(config, store, r, cache)) {
      publisher.set(`${p.repoId}#${p.number}`, r.agentId);
    }
  }
  for (const repo of config.repos) {
    for (const p of store.pullRequests(repo.id)) {
      const who = publisher.get(`${p.repoId}#${p.number}`) ?? p.repoId;
      const row = { ...plain, who, ref: p.ticket, url: p.url };
      if (p.createdAt >= since) {
        events.push({
          ...row,
          at: p.createdAt,
          kind: "pr-opened",
          text: `PR #${p.number} opened: ${p.title}`,
        });
      }
      if (p.mergedAt !== null && p.mergedAt >= since) {
        events.push({
          ...row,
          at: p.mergedAt,
          kind: "pr-merged",
          text: `PR #${p.number} merged: ${p.title}`,
        });
      }
    }
  }
  return events
    .filter((e) => options.since === undefined || e.at > options.since)
    .sort((a, b) => b.at - a.at)
    .slice(0, options.limit ?? (options.since === undefined ? ACTIVITY_LIMIT : undefined));
}

/**
 * The last METRICS_DAYS calendar days in the operator's timezone, oldest first. A run counts on the
 * day it started (its whole busy time too, even past midnight); only days with runs get a row.
 * A board item counts as closed on the day of its last update while it is done.
 */
export function metrics(config: CcConfig, store: Store, now: number): Metrics {
  const dayOf = dayFormatter(config.operator.timezone);
  const days = lastDays(dayOf(now), METRICS_DAYS);
  const inRange = new Set(days);
  const agents = agentIds(config);

  // One day more than the range covers its first local day whatever the offset or DST change.
  const rows = new Map<string, MetricsDay>();
  for (const r of store.runsOverlapping(now - FORTNIGHT_MS - DAY_MS, now)) {
    const day = dayOf(r.startedAt);
    if (!inRange.has(day) || !agents.includes(r.agentId)) continue;
    const key = `${day}\n${r.agentId}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        day,
        agentId: r.agentId,
        runs: 0,
        ok: 0,
        failed: 0,
        tokens: 0,
        costUsd: null,
        busyMinutes: 0,
      };
      rows.set(key, row);
    }
    row.runs += 1;
    if (r.status === "ok") row.ok += 1;
    if (r.status === "failed") row.failed += 1; // "blocked" is in neither, as on the overview
    row.tokens += tokenTotal(r.tokens);
    if (r.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + r.costUsd;
    row.busyMinutes += (endOf(r, now) - r.startedAt) / MINUTE_MS;
  }
  const perAgentDay = [...rows.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || agents.indexOf(a.agentId) - agents.indexOf(b.agentId),
  );

  const closed = new Map<string, { day: string; repoId: string; count: number }>();
  for (const repo of config.repos) {
    for (const i of store.board(repo.id)) {
      if (!isDone(i)) continue;
      const day = dayOf(i.updatedAt);
      if (!inRange.has(day)) continue;
      const key = `${day}\n${repo.id}`;
      const row = closed.get(key) ?? { day, repoId: repo.id, count: 0 };
      row.count += 1;
      closed.set(key, row);
    }
  }
  const repoIds = config.repos.map((r) => r.id);
  const closedPerDay = [...closed.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || repoIds.indexOf(a.repoId) - repoIds.indexOf(b.repoId),
  );

  return { days, agents, perAgentDay, closedPerDay };
}

/** The loaded config, field by field: only the fields the Settings page shows are copied. */
export function configView(
  config: CcConfig,
  profiles?: ConfigView["profiles"],
  githubLogin: string | null = null,
): ConfigView {
  return {
    operator: { id: config.operator.id, timezone: config.operator.timezone },
    githubLogin,
    accounts: config.accounts.map((a) => ({
      id: a.id,
      vendor: a.vendor,
      binding: "machine",
      canCheck: true,
      signInHint: `Sign in with the ${a.vendor === "claude" ? "Claude" : "Codex"} CLI on this machine.`,
      alertAt: a.alertAt,
      stopAt: a.stopAt,
    })),
    repos: config.repos.map((r) => ({
      id: r.id,
      github: r.github,
      project: r.project,
      statusMap: { ...r.statusMap },
      needsYouLabels: r.needsYouLabels ?? null,
      fullSuite: [...(r.fullSuite ?? [])],
    })),
    loops: config.loops.map((l) => ({
      id: l.id,
      repoId: l.repoId,
      kind: l.kind,
      accountId: l.accountId,
      stateDir: l.stateDir,
      logsDir: l.logsDir ?? null,
      worktree: l.worktree,
      launchdLabel: l.launchdLabel,
    })),
    poll: { usageMinutes: config.poll.usageMinutes, githubSeconds: config.poll.githubSeconds },
    crew: config.crew
      ? {
          worktrees: config.crew.worktrees,
          roles: Object.entries(config.crew.roles ?? BUILTIN_ROLES)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([name, r]) => ({
              name,
              prompt: r.prompt,
              model: r.model,
              mode: r.mode,
              loop: r.loop,
              tools: [...r.tools],
              here: r.here,
            })),
          sessions: config.crew.sessions.map((x) => ({
            id: x.id,
            repoId: x.repoId,
            checkout: x.checkout,
            ...(x.branch === undefined ? {} : { branch: x.branch }),
            managedCheckout: x.managedCheckout !== undefined,
            seats: x.seats.map((seat) => ({
              id: seat.id,
              role: seat.role,
              mode: modeOfSeat(seat),
              loop: seatDef(seat).loop,
              accountId: seat.accountId,
              model: seat.model,
              area: [...seat.area],
              ...(seat.retiring ? { retiring: true } : {}),
              ...(seatUnavailable(seat) ? { unavailable: seatUnavailable(seat) as string } : {}),
            })),
          })),
        }
      : null,
    ...(profiles === undefined ? {} : { profiles }),
  };
}

/** Fetch and group the whole-hub evidence once for all crew rows and set-aside runs. */
export function runEventsIndex(store: Store, now: number) {
  const since = now - 2 * 60 * 60_000;
  const group = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
    const index = new Map<string, T[]>();
    for (const row of rows) {
      const id = key(row);
      const bucket = index.get(id);
      if (bucket) bucket.push(row);
      else index.set(id, [row]);
    }
    return index;
  };
  return {
    commits: group(store.runCommitsSince(since), (c) => c.runId),
    locks: group(store.lockRuns(since), (l) => l.runId),
    comms: group(store.commsEvidence(since), (m) => m.from),
  };
}

/** Progress for a run, using recorded evidence rather than token activity. */
export function runEvents(
  store: Store,
  run: Run,
  now: number,
  index: ReturnType<typeof runEventsIndex>,
): CrewEvent[] {
  const since = now - 2 * 60 * 60_000;
  const events: CrewEvent[] = [];
  for (const e of store.loopEventsOfRun(run.id)) {
    const kind = CHECK_EVENT.test(e.text)
      ? "test"
      : /^PR #\d+ opened/.test(e.text)
        ? "pr-opened"
        : /^pushed /i.test(e.text)
          ? "push"
          : /:parked:/.test(e.key) || /^Parked:/i.test(e.text)
            ? "park"
            : null;
    if (kind) events.push({ kind, at: e.at });
  }
  for (const c of index.commits.get(run.id) ?? []) {
    events.push({ kind: "commit", at: c.at });
  }
  const push = store.runPush(run.id);
  if (push && !events.some((e) => e.kind === "push" && e.at === push.at))
    events.push({ kind: "push", at: push.at });
  const reviews = [...store.reviewsOfRun(run.id)];
  const performed = store.reviewOfRun(run.id);
  if (performed) reviews.push(performed);
  for (const review of reviews) {
    if (review.state === "reported" && review.endedAt !== null)
      events.push({ kind: "review", at: review.endedAt });
  }
  for (const test of index.locks.get(run.id) ?? []) {
    events.push({ kind: "test", at: test.startedAt });
  }
  for (const msg of index.comms.get(run.agentId) ?? []) {
    if (
      msg.at >= run.startedAt &&
      (run.endedAt === null || msg.at <= run.endedAt) &&
      (msg.ticket === null || msg.ticket === run.ticket)
    )
      events.push({ kind: "message", at: msg.at });
  }
  return events.filter((e) => e.at >= since && e.at <= now).sort((a, b) => a.at - b.at);
}
