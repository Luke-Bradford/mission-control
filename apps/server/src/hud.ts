/**
 * The HUD's server-built views: agent views, crew rows and attention items. Kept apart from api.ts
 * so the scheduler can build attention items without importing the API (api.ts imports the
 * scheduler).
 */
import { statSync } from "node:fs";
import {
  type AgentView,
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionOwner,
  agentState,
  type BoardItem,
  type Crew,
  type CrewRow,
  crewHudState,
  type DriverStop,
  driverStopKey,
  type Escalation,
  escalationKind,
  FLIGHT_ANSWER_WAIT_MS,
  hardRulesBySettingKey,
  hudState,
  isCleanupNoteKey,
  isHardRulesFlagKey,
  LOCK_WAITING_TEXT,
  laneOwner,
  lockBlockedText,
  loopText,
  modeOfSeat,
  OWNER_CONTROLLER,
  OWNER_LOOP,
  OWNER_OPERATOR,
  type PullRequestView,
  pathInArea,
  prYouAction,
  questionText,
  type Run,
  type RunDigest,
  type SeatSessionRow,
  STALL_TEXT,
  seatCallSign,
  seatDef,
  stallStart,
  startOfLocalDay,
  strayText,
  type TestLockState,
} from "@mc/core";
import { claudeVersion } from "./cli-version.ts";
import { collectorName, noteCollectorName } from "./collectors/common.ts";
import { isPaused } from "./collectors/ta-loop.ts";
import { agentIds, type CcConfig, type ConfiguredAgent, configuredAgents } from "./config.ts";
import { flightLive, flightOwnSeatIds } from "./flight/state.ts";
import { type PrCache, parseTicket, runPrs, runTicket, runTicketTitle } from "./runview.ts";
import type { AttentionNote, Store } from "./store.ts";
import { lastOutputAt } from "./stream.ts";

/** A crew error's attention key: this, then its row id (an ack of it acks the row). */
export const CREW_ERROR_KEY = "crew-error:";
/** An engine note's Needs-you key: this, then the note's own key. */
export const NOTE_KEY = "note:";

/** Runs read per loop for its view (state, context-window fallback). */
const AGENT_RUNS = 50;
/** No lock: the default for callers that have none (a preview, a test). */
export const NO_LOCK: TestLockState = { holder: null, waiting: [] };

/** A transcript's mtime (whole ms), or null when the run has none or the file is gone. */
function transcriptMtime(path: string): number | null {
  if (path === "") return null;
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

interface LoopView {
  agent: ConfiguredAgent;
  runs: Run[];
  /** The run shown for the agent: the one its seat holds, else the newest. */
  latest: Run | null;
  view: AgentView;
  /** Crew only: the seat's session row (null before it was ever started). */
  seatRow: SeatSessionRow | null;
}

/** The fields an agent view has only for a crew seat; a loop has none of them. */
function crewFields(
  agent: ConfiguredAgent,
): Pick<AgentView, "kind" | "role" | "mode" | "area" | "model" | "sessionId"> {
  if (agent.kind === "loop") {
    return { kind: "loop", role: null, mode: null, area: [], model: null, sessionId: null };
  }
  const { seat } = agent;
  return {
    kind: "crew",
    role: seat.role,
    mode: modeOfSeat(seat),
    area: [...seat.area],
    model: seat.model,
    sessionId: agent.sessionId,
  };
}

/** The driver stop the collector stored, else null (also when the stored text is not a stop). */
function readStop(store: Store, loopId: string): DriverStop | null {
  const raw = store.getSetting(driverStopKey(loopId));
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<DriverStop> | null;
    return v && typeof v.reason === "string" && typeof v.at === "number" ? (v as DriverStop) : null;
  } catch {
    return null;
  }
}

function loopViews(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState = NO_LOCK,
): LoopView[] {
  const status = new Map(store.status().map((s) => [s.collector, s]));
  const inLine = new Set(lock.waiting.map((w) => w.runId));
  const escalations = store.escalations();
  return configuredAgents(config).map((agent) => {
    const runs = store.runs(agent.id, AGENT_RUNS);
    const latest = store.seatRun(agent.id);
    const lastOutput = latest
      ? lastOutputAt(
          store.digest(latest.id)?.lastEventAt ?? null,
          transcriptMtime(latest.transcriptPath),
        )
      : null;
    if (agent.kind === "crew") {
      const seatRow = store.seatSession(agent.id);
      const waiting = seatRow?.runId != null && inLine.has(seatRow.runId);
      const hud = crewHudState(seatRow, lastOutput, now, waiting);
      const reason = hud === "waiting" ? LOCK_WAITING_TEXT : (seatRow?.reason ?? null);
      const view: AgentView = {
        id: agent.id,
        repoId: agent.repoId,
        ...crewFields(agent),
        loopKind: "crew",
        accountId: agent.accountId,
        state:
          hud === "error"
            ? "error"
            : hud === "running" || hud === "stalled"
              ? "working"
              : hud === "waiting"
                ? "waiting-agent"
                : "idle",
        stateSince: seatRow?.updatedAt ?? (latest ? (latest.endedAt ?? latest.startedAt) : 0),
        currentRun: latest ?? null,
        paused: false,
        sourceError: hud === "error" ? (reason ?? "seat error") : null,
        // The seat's reason is its doing line, unless it is already the error text.
        note: hud === "error" ? null : reason,
        stop: null,
        lastOutputAt: lastOutput,
      };
      return { agent, runs, latest: latest ?? null, view, seatRow };
    }
    const loop = agent.loop;
    const st = status.get(collectorName(loop.kind, loop.id));
    const sourceError = st && !st.ok ? (st.error ?? "collector failed") : null;
    const paused = loop.kind === "ta-loop" ? isPaused(loop) : false;
    // Only a title marker (`[operator-decision]` / `[loop-blocked]` / `[mvp-ready]`) means the
    // loop waits on the operator; a label-only escalation is listed in Needs you and nothing more.
    const waitingOnOperator = escalations.some(
      (e) => e.repoId === loop.repoId && e.source === "title",
    );
    const note = status.get(noteCollectorName(loop.kind, loop.id))?.error ?? null;
    const stop = loop.kind === "studio-loop" ? readStop(store, loop.id) : null;
    const { state, since } = agentState({ runs, paused, sourceError, waitingOnOperator });
    const view: AgentView = {
      id: loop.id,
      repoId: loop.repoId,
      ...crewFields(agent),
      loopKind: loop.kind,
      accountId: loop.accountId,
      state,
      stateSince: since,
      currentRun: latest ?? null,
      paused,
      sourceError,
      note,
      stop,
      lastOutputAt: lastOutput,
    };
    return { agent, runs, latest: latest ?? null, view, seatRow: null };
  });
}

export function agentViews(config: CcConfig, store: Store, now: number = Date.now()): AgentView[] {
  return loopViews(config, store, now).map((l) => l.view);
}

/**
 * The open PR on the run's branch in the seat's repo (the newest, if several), as the row's review
 * state; null without a branch or an open PR.
 */
function reviewOf(store: Store, repoId: string, branch: string | null): CrewRow["review"] {
  if (branch === null) return null;
  const open = store
    .pullRequests(repoId)
    .filter((p) => p.state === "open" && p.branch === branch)
    .sort((a, b) => b.number - a.number)[0];
  if (!open) return null;
  const state = open.isDraft
    ? "draft"
    : open.review === "changes" || open.review === "approved"
      ? open.review
      : "open";
  return { prNumber: open.number, state };
}

/** A scratch seat's live review: its latest run is active and performs a review. */
function reviewingOf(store: Store, latest: Run | null): CrewRow["reviewing"] {
  if (latest === null || latest.endedAt !== null || latest.reviewId == null) return null;
  const rv = store.review(latest.reviewId);
  return rv === null ? null : { prNumber: rv.prNumber, sha: rv.sha, ref: latest.ticket };
}

export function crew(
  config: CcConfig,
  store: Store,
  now: number,
  /** The test lock: a seat in line for it is waiting, not stalled. */
  lock: TestLockState = NO_LOCK,
  /** The CLI version; tests pass a stub. */
  cliVersion: () => string | null = claudeVersion,
): Crew {
  const boards = new Map<string, BoardItem[]>();
  const boardOf = (repoId: string): BoardItem[] => {
    let b = boards.get(repoId);
    if (!b) {
      b = config.repos.some((r) => r.id === repoId) ? store.board(repoId) : [];
      boards.set(repoId, b);
    }
    return b;
  };
  const ticketTitle = (ticket: string | null): string | null => {
    const t = ticket === null ? null : parseTicket(ticket);
    if (!t) return null;
    return boardOf(t.repoId).find((i) => i.issueNumber === t.number)?.title ?? null;
  };

  let version: string | null | undefined;
  const cliVersionOnce = (): string | null => {
    if (version === undefined) version = cliVersion();
    return version;
  };

  const prCache: PrCache = new Map();
  const rows = loopViews(config, store, now, lock).map(
    ({ agent, runs, latest, view, seatRow }, index): CrewRow => {
      const digests: Map<string, RunDigest> = store.digests(runs.map((r) => r.id));
      const digest = latest ? (digests.get(latest.id) ?? null) : null;
      let contextWindow: number | null = null;
      for (const r of runs) {
        const w = digests.get(r.id)?.contextWindow ?? null;
        if (w !== null) {
          contextWindow = w;
          break;
        }
      }
      const prs = latest ? runPrs(config, store, latest, prCache) : [];
      const ticket = latest ? runTicket(latest, prs) : null;
      const backgroundInFlight = (digest?.background.length ?? 0) > 0;
      const state =
        agent.kind === "crew"
          ? crewHudState(
              seatRow,
              view.lastOutputAt,
              now,
              seatRow?.runId != null && lock.waiting.some((w) => w.runId === seatRow.runId),
            )
          : hudState({
              state: view.state,
              paused: view.paused,
              stopped: view.stop !== null,
              lastOutputAt: view.lastOutputAt,
              now,
              backgroundInFlight,
            });
      // A stalled agent has been in that state since the silence reached the threshold, not
      // since its run began. A seat that wrote nothing counts from its row's last change. Never
      // before the view's own stateSince (the run start): output older than the run is no stall of it.
      const silentSince = view.lastOutputAt ?? seatRow?.updatedAt ?? null;
      const stateSince =
        state === "stalled" && silentSince !== null
          ? Math.max(
              stallStart(silentSince, agent.kind === "loop" && backgroundInFlight),
              view.stateSince,
            )
          : view.stateSince;
      return {
        id: agent.id,
        repoId: agent.repoId,
        index,
        hudState: state,
        stateSince,
        accountId: agent.accountId,
        kind: view.kind,
        loopKind: view.loopKind,
        role: view.role,
        mode: view.mode,
        area: view.area,
        model: view.model,
        sessionId: view.sessionId,
        cli:
          agent.kind === "crew"
            ? { version: cliVersionOnce(), effort: agent.seat.effort ?? null }
            : { version: null, effort: null },
        review:
          agent.kind === "crew" ? reviewOf(store, agent.repoId, latest?.branch ?? null) : null,
        reviewing: reviewingOf(store, latest),
        paused: view.paused,
        note: view.note,
        stop: view.stop,
        sourceError: view.sourceError,
        ticket,
        ticketTitle: latest ? runTicketTitle(latest, ticket, ticketTitle(ticket)) : null,
        loop:
          agent.kind === "crew" && latest?.loop
            ? {
                phase: latest.loop.phase,
                text: loopText(ticket, latest.loop),
                prNumber: latest.loop.prNumber,
                parked:
                  latest.loop.phase === "parked" ? (latest.loop.parked?.reason ?? null) : null,
              }
            : null,
        run: latest
          ? {
              id: latest.id,
              seq: latest.seq,
              startedAt: latest.startedAt,
              endedAt: latest.endedAt,
              status: latest.status,
              model: latest.model,
              branch: latest.branch,
              tokens: latest.tokens,
              costUsd: latest.costUsd,
            }
          : null,
        prs,
        summary: latest?.summary ?? null,
        digest,
        contextWindow,
        lastOutputAt: view.lastOutputAt,
      };
    },
  );

  const dayStart = startOfLocalDay(now, config.operator.timezone);
  const agents = new Set(agentIds(config));
  let firstRunToday: number | null = null;
  for (const r of store.runsOverlapping(dayStart, now + 1)) {
    if (!agents.has(r.agentId) || r.startedAt < dayStart) continue;
    if (firstRunToday === null || r.startedAt < firstRunToday) firstRunToday = r.startedAt;
  }
  return { rows, firstRunToday };
}

const kindRank = (k: AttentionItem["kind"]): number => ATTENTION_KINDS.indexOf(k);

/** An attention item before its ack is read; the server always knows its owner. */
type OwnedItem = Omit<AttentionItem, "acked" | "owner"> & { owner: AttentionOwner };

/** Escalation kinds that name the operator; any other is a loop's own. */
const OPERATOR_ESCALATIONS: readonly Escalation["kind"][] = [
  "operator-decision",
  "mvp-ready",
  "autonomy-question",
];

/** The login a draft PR belongs to when it is not the hub's: its author, else an assignee. */
function otherLogin(
  pr: Pick<PullRequestView, "author" | "assignees">,
  hubLogin: string | null,
): string | null {
  if (hubLogin === null) return null;
  const logins = [pr.author ?? null, ...(pr.assignees ?? [])];
  return logins.find((l): l is string => l !== null && l !== hubLogin) ?? null;
}

/**
 * Needs-you items: every escalation, every stalled loop (keyed by run and last output, so a new
 * stall, on a new run or later in the same one, pulses again) and every loop in error (keyed by
 * its last success, so a failure after a recovery pulses again); the crew's strays, open
 * questions and unacked errors; and the test lock when its holder has stalled with seats in line.
 * Sorted by ATTENTION_KINDS order, then time; `acked` from the acks table.
 */
export function attentionItems(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState = NO_LOCK,
  /** The crew rows at `now` (built with `lock`), when the caller has already built them. */
  rows: CrewRow[] = crew(config, store, now, lock).rows,
  /** The hub's own `gh` login, to tell another login's draft PRs from its own; null when unread. */
  hubLogin: string | null = null,
): AttentionItem[] {
  const acks = store.acks();
  const briefs = store.briefs();
  const status = new Map(store.status().map((s) => [s.collector, s]));
  const items: OwnedItem[] = [];

  for (const e of store.escalations()) {
    // an escalation whose issue the board has since seen closed no longer holds
    if (store.board(e.repoId).some((b) => b.issueNumber === e.issueNumber && b.closed)) continue;
    items.push({
      // a needs-you label asks the operator whatever the kind; only a [loop-blocked] title is the loop's
      owner:
        e.source === "label" || OPERATOR_ESCALATIONS.includes(e.kind) ? OWNER_OPERATOR : OWNER_LOOP,
      key: `esc:${e.id}`,
      kind: escalationKind(e),
      agentId: config.loops.find((l) => l.repoId === e.repoId)?.id ?? null,
      repoId: e.repoId,
      text: e.title,
      tool: null,
      at: e.openedAt,
      url: e.url,
      escalationId: e.id,
      ticket: e.id,
    });
  }

  for (const row of rows) {
    if (row.hudState === "stalled" && row.run && row.lastOutputAt !== null) {
      items.push({
        owner: OWNER_OPERATOR,
        key: `stall:${row.id}:${row.run.id}:${row.lastOutputAt}`,
        kind: "stalled",
        agentId: row.id,
        repoId: row.repoId,
        text: STALL_TEXT,
        tool: row.digest?.liveTool?.name ?? null,
        at: row.lastOutputAt,
        url: null,
        escalationId: null,
        ticket: null,
      });
    } else if (row.hudState === "error" && row.sourceError !== null) {
      // Every error row has a sourceError: loopViews gives a failing collector "collector failed"
      // when it stored no text, and a seat "seat error".
      // A loop's error is keyed by its collector's last success; a seat's by its last state change.
      const st =
        row.loopKind === "crew" ? undefined : status.get(collectorName(row.loopKind, row.id));
      items.push({
        owner: OWNER_OPERATOR,
        key:
          row.kind === "crew"
            ? `error:${row.id}:${row.stateSince}`
            : `error:${row.id}:${st?.lastOkAt ?? "never"}`,
        kind: "error",
        agentId: row.id,
        repoId: row.repoId,
        text: row.sourceError,
        tool: null,
        at: row.kind === "crew" ? row.stateSince : (st?.lastOkAt ?? st?.at ?? now),
        url: null,
        escalationId: null,
        ticket: null,
      });
    }
  }

  // A PR waits on you when it is linked to a ticket on a configured board and no agent is running
  // on that ticket (the loops merge their own PRs; see PR_WAIT_MS). A ticket whose run is still
  // open is the crew's, whether or not a seat is running on it (set aside, queued, held).
  const working = new Set(
    rows.filter((r) => r.run?.status === "running" && r.ticket !== null).map((r) => r.ticket),
  );
  for (const ticket of store.activeTickets()) working.add(ticket);
  for (const repo of config.repos) {
    const onBoard = new Set(store.board(repo.id).map((b) => `${repo.id}#${b.issueNumber}`));
    for (const pr of store.pullRequests(repo.id)) {
      if (pr.ticket === null || !onBoard.has(pr.ticket)) continue;
      const action = prYouAction(pr, working.has(pr.ticket), now);
      if (action === null) continue;
      // a draft another login's run opened is that lane's to decide
      const lane = pr.isDraft ? otherLogin(pr, hubLogin) : null;
      items.push({
        owner: lane === null ? OWNER_OPERATOR : laneOwner(lane),
        key: `pr:${pr.repoId}#${pr.number}:${pr.updatedAt}`,
        kind: "pr",
        agentId: null,
        repoId: pr.repoId,
        text: `PR #${pr.number} · You: ${action}`,
        tool: null,
        at: pr.updatedAt,
        url: pr.url,
        escalationId: null,
        ticket: pr.ticket,
      });
    }
  }

  items.push(...crewItems(config, store, now, lock, rows));

  return items
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.at - b.at)
    .map((i) => {
      const brief = briefs.get(i.key);
      return { ...i, ...(brief === undefined ? {} : { brief }), acked: acks.has(i.key) };
    });
}

/**
 * Whether an ended run's park is past acting on: its PR is merged or closed, or its ticket is
 * closed, gone from its repo's board, or in a repo no longer configured. A repo whose board was
 * never read keeps the note.
 */
function endedParkGone(
  config: CcConfig,
  store: Store,
  run: Run,
  boardOf: (repoId: string) => BoardItem[],
): boolean {
  const loop = run.loop;
  if (loop?.phase !== "parked" || loop.parked?.kind !== "ended") return false;
  const prs = store.pullRequests(run.repoId);
  const pr =
    loop.prNumber !== null
      ? prs.find((p) => p.number === loop.prNumber)
      : run.branch === null
        ? undefined
        : prs
            .filter((p) => p.branch === run.branch && p.createdAt >= run.startedAt)
            .sort((a, b) => b.number - a.number)[0];
  if (pr !== undefined && pr.state !== "open") return true;
  const t = run.ticket === null ? null : parseTicket(run.ticket);
  if (!t) return false;
  if (!config.repos.some((r) => r.id === t.repoId)) return true;
  const board = boardOf(t.repoId);
  if (board.length === 0) return false;
  const item = board.find((b) => b.issueNumber === t.number);
  return item === undefined || item.closed;
}

/**
 * Who an engine note waits on: housekeeping is the controller's; a hard-rule flag is the
 * operator's, unless the repo's rules say the controller merges hard-rule PRs.
 */
function noteOwner(store: Store, n: Pick<AttentionNote, "key" | "repoId">): AttentionOwner {
  if (isCleanupNoteKey(n.key)) return OWNER_CONTROLLER;
  if (
    isHardRulesFlagKey(n.key) &&
    n.repoId !== null &&
    store.getSetting(hardRulesBySettingKey(n.repoId)) === OWNER_CONTROLLER
  ) {
    return OWNER_CONTROLLER;
  }
  return OWNER_OPERATOR;
}

/** The crew's own Needs-you items: strays, questions, crew errors and a blocked test lock. */
function crewItems(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState,
  rows: CrewRow[],
): OwnedItem[] {
  const sessions = config.crew?.sessions ?? [];
  const repoOfSeat = (seatId: string) =>
    sessions.find((s) => s.seats.some((x) => x.id === seatId))?.repoId ?? null;
  const item = (
    i: Pick<AttentionItem, "key" | "kind" | "agentId" | "repoId" | "text" | "at"> & {
      owner?: AttentionOwner;
    },
  ): OwnedItem => ({
    ...i,
    owner: i.owner ?? OWNER_OPERATOR,
    tool: null,
    url: null,
    escalationId: null,
    ticket: null,
  });
  const out: OwnedItem[] = [];
  const boards = new Map<string, BoardItem[]>();
  const boardOf = (repoId: string): BoardItem[] => {
    let b = boards.get(repoId);
    if (!b) {
      b = store.board(repoId);
      boards.set(repoId, b);
    }
    return b;
  };

  for (const s of store.strays()) {
    const session = sessions.find((x) => x.id === s.sessionId);
    // the writer whose area holds it, by today's config; none: it reads as outside every area
    const owner =
      s.kind === "other-area"
        ? (session?.seats.find(
            (w) =>
              w.id !== s.agentId &&
              seatDef(w).mode === "writer" &&
              w.area.length > 0 &&
              pathInArea(w.area, s.path),
          ) ?? null)
        : null;
    out.push(
      item({
        key: s.key,
        kind: "stray",
        agentId: s.agentId,
        repoId: session?.repoId ?? null,
        text: strayText(s.path, s.sessionId, owner === null ? null : seatCallSign(owner.id)),
        at: s.at,
      }),
    );
  }

  // While FLIGHT runs, it gets first go at a seat's question; it is the operator's once FLIGHT
  // has passed it, or after FLIGHT_ANSWER_WAIT_MS.
  const flightHolds = flightLive(config, store);
  const flightOwn = flightOwnSeatIds(config);
  for (const q of store.openQuestions()) {
    // Held back, not listed as FLIGHT's, until the web lists only the operator's items.
    if (
      flightHolds &&
      flightOwn.has(q.agentId) &&
      q.passedAt === null &&
      now - q.at < FLIGHT_ANSWER_WAIT_MS
    ) {
      continue;
    }
    out.push(
      item({
        key: `ask:${q.id}`,
        kind: "question",
        agentId: q.agentId,
        repoId: repoOfSeat(q.agentId),
        text: questionText(seatCallSign(q.agentId), q.text),
        at: q.at,
      }),
    );
  }

  // The engine's notes: blocked, ready for review, check before merging, rate-limited. Each
  // goes when the engine clears it.
  for (const n of store.notes()) {
    if (n.dismissedAt !== null) continue;
    const run = n.runId === null ? null : store.run(n.runId);
    if (n.kind === "blocked" && run !== null && endedParkGone(config, store, run, boardOf))
      continue;
    const pr =
      run?.loop?.prNumber === undefined || run.loop.prNumber === null
        ? undefined
        : store.pullRequests(run.repoId).find((p) => p.number === run.loop?.prNumber);
    out.push({
      owner: noteOwner(store, n),
      key: `${NOTE_KEY}${n.key}`,
      kind: n.kind,
      agentId: n.seatId,
      repoId: n.repoId,
      text: n.text,
      tool: null,
      at: n.at,
      url: pr?.url ?? null,
      escalationId: null,
      ticket: run?.ticket ?? null,
    });
  }

  for (const e of store.crewErrors()) {
    out.push(
      item({
        key: `${CREW_ERROR_KEY}${e.id}`,
        kind: "error",
        agentId: e.agentId,
        repoId: repoOfSeat(e.agentId),
        text: e.text,
        at: e.at,
      }),
    );
  }

  const holder = lock.holder;
  const holderRow = holder === null ? undefined : rows.find((r) => r.id === holder.seatId);
  if (holder !== null && holderRow?.hudState === "stalled" && lock.waiting.length > 0) {
    const waiting = [...new Set(lock.waiting.map((w) => seatCallSign(w.seatId)))];
    out.push(
      item({
        key: `lock:${holder.runId}:${holder.since}`,
        kind: "lock",
        agentId: holder.seatId,
        repoId: holderRow.repoId,
        text: lockBlockedText(waiting, seatCallSign(holder.seatId)),
        at: holderRow.lastOutputAt ?? holder.since,
      }),
    );
  }
  return out;
}
