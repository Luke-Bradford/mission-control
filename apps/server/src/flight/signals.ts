/** Durable, evidence-backed wake causes. Only successful delivery marks a cause as told. */
import {
  FLIGHT_GITHUB_LOW_FRACTION,
  FLIGHT_IDLE_MS,
  FLIGHT_LOOPS_SETTING,
  FLIGHT_MAIN_SETTING,
  FLIGHT_SIGNAL_KEEP_MS,
  FLIGHT_SIGNALS_SETTING,
  type FlightSignal,
  type FlightState,
  type FlightTriage,
  flakeNoteKey,
  GITHUB_RATE_SETTING,
  type GithubRateState,
  hudColumnOf,
  inLane,
  isFlakeNoteKey,
  noReportExitReason,
  type PullRequestView,
  parkedEventText,
  seatDef,
} from "@mc/core";
import type { CcConfig, CrewSessionConfig } from "../config.ts";
import type { Store } from "../store.ts";

interface RecordState {
  initialized: boolean;
  signals: Record<string, FlightSignal & { toldAt: number | null; lastSeen?: number }>;
  triage: Record<string, FlightTriage & { told: boolean; at: number }>;
  checks: Record<
    string,
    {
      sha: string;
      failedAt: number | null;
      failedAttempt: number | null;
      runId: string | null;
      name: string;
      job?: string;
      observedFailure?: boolean;
      at: number;
    }
  >;
  flakes: Record<string, { key: string; at: number; evidence: string }>;
  dependencies: Record<string, { open: string[]; at: number }>;
}
export interface MainCi {
  sha: string;
  ci: PullRequestView["ci"];
  at: number;
  committedAt?: number;
  checks?: { name: string; url: string | null }[];
  episode?: string | null;
}
interface LoopHeartbeat {
  at: number;
  interval: number;
  completed: boolean;
}

/** Settings can be missing or left malformed by an interrupted/older write. */
function stored<T>(store: Store, key: string, fallback: T): T {
  try {
    return JSON.parse(store.getSetting(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function read(store: Store, repo: string, now: number): RecordState {
  const state = {
    initialized: false,
    signals: {},
    triage: {},
    checks: {},
    flakes: {},
    dependencies: {},
    ...stored<Partial<RecordState>>(store, `${FLIGHT_SIGNALS_SETTING}:${repo}`, {}),
  } as RecordState;
  const cutoff = now - FLIGHT_SIGNAL_KEEP_MS;
  for (const [key, entry] of Object.entries(state.signals)) {
    const main =
      entry.kind === "main_red"
        ? stored<MainCi | null>(store, `${FLIGHT_MAIN_SETTING}:${repo}`, null)
        : null;
    if (main?.ci === "failing" && (main.episode ?? main.sha) === entry.key) continue;
    if ((entry.lastSeen ?? entry.toldAt ?? entry.since) < cutoff) delete state.signals[key];
  }
  for (const entries of [state.triage, state.checks, state.flakes, state.dependencies]) {
    for (const [key, entry] of Object.entries(entries)) if (entry.at < cutoff) delete entries[key];
  }
  return state;
}
function save(store: Store, repo: string, state: RecordState): void {
  const key = `${FLIGHT_SIGNALS_SETTING}:${repo}`;
  const value = JSON.stringify(state);
  if (store.getSetting(key) !== value) store.setSetting(key, value);
}
const signalId = (s: Pick<FlightSignal, "kind" | "key">): string => `${s.kind}:${s.key}`;
const triageId = (t: Pick<FlightTriage, "ref" | "cause">): string => `${t.ref}:${t.cause}`;

function raiseSignal(state: RecordState, signal: FlightSignal, now: number): void {
  const id = signalId(signal);
  const previous = state.signals[id];
  state.signals[id] = {
    ...signal,
    since: previous?.since ?? signal.since,
    toldAt: previous?.toldAt ?? null,
    lastSeen: now,
  };
}

function mainEvidence(store: Store, repo: string, main: MainCi): string {
  const prs = store.pullRequests(repo);
  const firstSha = main.episode ?? main.sha;
  const matched =
    prs.find((pr) => pr.mergeCommitSha === firstSha) ??
    prs.find((pr) => pr.mergeCommitSha === main.sha);
  const merged =
    matched ??
    prs
      .filter(
        (pr) =>
          pr.mergedAt !== null &&
          main.committedAt !== undefined &&
          pr.mergedAt <= main.committedAt + 5_000,
      )
      .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))[0];
  return `${repo} default branch: first red SHA ${firstSha}; latest SHA ${main.sha}: ${main.ci}; ${(main.checks ?? []).map((c) => `${c.name}${c.url ? ` ${c.url}` : ""}`).join("; ")}${merged ? `; ${matched ? "episode merge" : "last PR merged by commit time (5s tolerance)"}: #${merged.number} ${merged.url}` : ""}`;
}

/** Retain an episode's first red SHA until a passing reading resets it. */
export function observeFlightMain(store: Store, repo: string, main: MainCi): void {
  const key = `${FLIGHT_MAIN_SETTING}:${repo}`;
  const previous = stored<MainCi | null>(store, key, null);
  if (previous && previous.at > main.at) return;
  const episode =
    main.ci === "passing"
      ? null
      : (previous?.episode ??
        (previous?.ci === "failing" ? previous.sha : null) ??
        (main.ci === "failing" ? main.sha : null));
  store.setSetting(key, JSON.stringify({ ...main, episode }));
  if (main.ci !== "failing" || !episode) return;
  const state = read(store, repo, main.at);
  // A green reading ended the earlier episode, even if the same SHA fails again.
  if (previous?.episode === null || previous?.ci === "passing")
    delete state.signals[`main_red:${episode}`];
  raiseSignal(
    state,
    {
      kind: "main_red",
      key: episode,
      since: main.at,
      evidence: mainEvidence(store, repo, { ...main, episode }),
      checks: (main.checks ?? []).map((c) => c.name),
    },
    main.at,
  );
  save(store, repo, state);
}

/** Record fail/pass transitions at collection time, even while FLIGHT is in a long turn. */
export function observeFlightChecks(
  store: Store,
  repo: string,
  prs: PullRequestView[],
  now: number,
): void {
  const state = read(store, repo, now);
  for (const pr of prs) {
    if (!pr.headSha || pr.state !== "open") continue;
    for (const check of pr.checks ?? []) {
      if (check.kind !== "check") continue;
      const key = `${repo}:${check.workflow ?? check.name}/${check.name}`;
      const id = `${pr.number}:${check.url?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1] ?? "check"}:${check.name}`;
      const previous = state.checks[id];
      if (previous && previous.at > now) continue;
      const failedAt = previous?.sha === pr.headSha ? previous.failedAt : null;
      const failedAttempt = previous?.sha === pr.headSha ? previous.failedAttempt : null;
      if (
        check.state === "passing" &&
        failedAt != null &&
        failedAttempt != null &&
        check.attempt != null &&
        check.attempt > failedAttempt
      ) {
        delete state.flakes[`${key}:${pr.headSha}:note`];
        state.flakes[`${key}:${pr.headSha}:${check.attempt ?? failedAt}`] = {
          key,
          at: now,
          evidence: `PR #${pr.number}, ${pr.headSha}, ${check.name}: failed then passed on the same head${check.attempt === null ? "" : ` (attempt ${check.attempt})`}${check.url ? `; ${check.url}` : ""}`,
        };
      }
      state.checks[id] = {
        sha: pr.headSha,
        name: check.workflow ?? check.name,
        job: check.name,
        observedFailure:
          check.state === "failing" ||
          (previous?.sha === pr.headSha &&
            (previous.observedFailure === true || previous.failedAt !== null)),
        runId: check.url?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1] ?? null,
        failedAttempt:
          check.state === "passing"
            ? null
            : check.state === "failing"
              ? check.attempt
              : failedAttempt,
        failedAt:
          check.state === "passing" ? null : (failedAt ?? (check.state === "failing" ? now : null)),
        at: now,
      };
    }
  }
  save(store, repo, state);
}

// Keep fast-loop completions fresh in memory while limiting durable writes per source.
const heartbeatCache = new WeakMap<
  Store,
  { raw: string | null; loops: Record<string, LoopHeartbeat>; written: Record<string, number> }
>();
function heartbeats(store: Store) {
  const raw = store.getSetting(FLIGHT_LOOPS_SETTING);
  let cache = heartbeatCache.get(store);
  if (!cache || cache.raw !== raw) {
    const loops = stored<Record<string, LoopHeartbeat>>(store, FLIGHT_LOOPS_SETTING, {});
    cache = {
      raw,
      loops,
      written: Object.fromEntries(Object.entries(loops).map(([source, loop]) => [source, loop.at])),
    };
    heartbeatCache.set(store, cache);
  }
  return cache;
}

/** A scheduled hub loop's first due time or last completion, and its interval. */
export function flightLoopHeartbeat(
  store: Store,
  source: string,
  at: number,
  interval: number,
  completed = true,
): void {
  const cache = heartbeats(store);
  cache.loops[source] = { at, interval, completed };
  const writtenAt = cache.written[source];
  if (writtenAt !== undefined && at - writtenAt < 60_000) return;
  const persisted = stored<Record<string, LoopHeartbeat>>(store, FLIGHT_LOOPS_SETTING, {});
  persisted[source] = cache.loops[source];
  const raw = JSON.stringify(persisted);
  store.setSetting(FLIGHT_LOOPS_SETTING, raw);
  cache.raw = raw;
  cache.written[source] = at;
}

export function flightSignals(i: {
  config: CcConfig;
  store: Store;
  session: CrewSessionConfig;
  seats: FlightState["seats"];
  now: number;
}): Pick<FlightState, "signals" | "triage"> {
  const { config, store, session, seats, now } = i;
  const repo = session.repoId;
  const state = read(store, repo, now);
  const cutoff = now - FLIGHT_SIGNAL_KEEP_MS;
  const active = new Set<string>();
  const raise = (
    kind: FlightSignal["kind"],
    key: string,
    since: number,
    evidence: string,
    checks?: string[],
  ) => {
    active.add(`${kind}:${key}`);
    raiseSignal(state, { kind, key, since, evidence, ...(checks ? { checks } : {}) }, now);
  };
  const triage = (ref: string, cause: FlightTriage["cause"], since: number, evidence: string) => {
    if (since < cutoff) return;
    const entry = { ref, cause, since, evidence };
    const id = triageId(entry);
    state.triage[id] = { ...entry, told: state.triage[id]?.told ?? false, at: now };
  };
  const board = store.board(repo);
  const onBoard = new Set(
    board
      .filter(
        (card) =>
          !card.closed && inLane(card.labels, config.crew?.lane, config.crew?.laneDefault ?? false),
      )
      .map((card) => `${repo}#${card.issueNumber}`),
  );
  for (const [key, entry] of Object.entries(state.triage))
    if (!onBoard.has(entry.ref)) delete state.triage[key];
  for (const card of board) {
    if (card.closed || !inLane(card.labels, config.crew?.lane, config.crew?.laneDefault ?? false))
      continue;
    const ref = `${repo}#${card.issueNumber}`;
    const column = hudColumnOf(card);
    if (column === "Backlog" || column === "Refinement") {
      triage(ref, "new", now, `${ref} arrived in ${column}: ${card.title}`);
    }
    const open = card.blockedBy.filter((d) => !d.closed).map((d) => d.ref);
    const previous = state.dependencies[ref];
    const resolved =
      previous?.open.filter((dep) => card.blockedBy.some((d) => d.ref === dep && d.closed)) ?? [];
    if (resolved.length > 0)
      triage(ref, "dependency", now, `${ref}: dependencies resolved: ${resolved.join(", ")}`);
    state.dependencies[ref] = { open, at: now };
  }

  const parks = new Map<string, { at: number; evidence: string }[]>();
  const parkPrefix = parkedEventText("");
  for (const event of store.loopEvents(cutoff, repo)) {
    const planned = event.key === `${event.runId}:plan`;
    const parked = event.text.startsWith(parkPrefix);
    if (!planned && !parked) continue;
    const run = store.run(event.runId);
    if (!run?.ticket || !onBoard.has(run.ticket)) continue;
    if (planned) triage(run.ticket, "plan", event.at, event.text);
    if (parked) {
      const reason = event.text.slice(parkPrefix.length).replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
      const key = `${run.ticket}:${reason}`;
      const entries = parks.get(key) ?? [];
      entries.push({
        at: event.at,
        evidence: `${run.id}: ${parkPrefix}${reason} at ${new Date(event.at).toISOString()}`,
      });
      parks.set(key, entries);
    }
  }
  for (const [key, entries] of parks) {
    if (entries.length >= 2) {
      const pair = entries.slice(-2);
      raise("repeat_park", key, pair[1]?.at ?? now, pair.map((e) => e.evidence).join("; "));
    }
  }

  for (const note of store.notes()) {
    if (note.repoId !== repo || !isFlakeNoteKey(note.key) || note.at < cutoff) continue;
    if (!note.runId) continue;
    const sha = note.key.slice(flakeNoteKey(note.runId, "").length);
    const rerun = store.run(note.runId)?.loop?.rerun;
    const noteRuns =
      rerun?.sha === sha
        ? rerun.runs.map((r) => ({ name: r.name, id: String(r.id) }))
        : [
            ...(note.text.split("(a flake): ")[1] ?? "").matchAll(
              /(?:^|, )(.+?) run (\d+)(?=, |$)/g,
            ),
          ].map((m) => ({ name: m[1] as string, id: m[2] as string }));
    const names = noteRuns.flatMap((r) => {
      return Object.values(state.checks)
        .filter(
          (c) =>
            c.runId === r.id &&
            c.sha === sha &&
            c.job &&
            (c.observedFailure || c.failedAt !== null),
        )
        .map((c) => `${c.name}/${c.job}`);
    });
    for (const name of new Set(names)) {
      const key = `${repo}:${name}`;
      const prefix = `${key}:${sha}:`;
      if (!Object.keys(state.flakes).some((id) => id.startsWith(prefix))) {
        state.flakes[`${prefix}note`] = { key, at: note.at, evidence: note.text };
      }
    }
  }
  const flakes = new Map<string, (typeof state.flakes)[string][]>();
  for (const entry of Object.values(state.flakes)) {
    const entries = flakes.get(entry.key) ?? [];
    entries.push(entry);
    flakes.set(entry.key, entries);
  }
  for (const [key, entries] of flakes) {
    entries.sort((a, b) => a.at - b.at);
    if (entries.length >= 2)
      raise(
        "flaky_test",
        key,
        entries[1]?.at ?? now,
        entries
          .slice(0, 2)
          .map((e) => e.evidence)
          .join("; "),
      );
  }

  const main = stored<MainCi | null>(store, `${FLIGHT_MAIN_SETTING}:${repo}`, null);
  if (main?.ci === "failing") {
    raise(
      "main_red",
      main.episode ?? main.sha,
      main.at,
      mainEvidence(store, repo, main),
      (main.checks ?? []).map((c) => c.name),
    );
  }
  const rate = stored<GithubRateState | null>(store, GITHUB_RATE_SETTING, null);
  for (const reading of Object.values(rate?.queries ?? {})) {
    if (
      reading.resetAt <= now ||
      reading.limit <= 0 ||
      reading.remaining / reading.limit >= FLIGHT_GITHUB_LOW_FRACTION
    )
      continue;
    raise(
      "github_budget",
      String(reading.resetAt),
      reading.at,
      `GitHub: ${reading.remaining}/${reading.limit} points remain; reset ${new Date(reading.resetAt).toISOString()}`,
    );
  }

  for (const seat of seats) {
    const row = store.seatSession(seat.id);
    const since = row ? Math.max(row.updatedAt, row.lastTurnEndedAt ?? row.updatedAt) : undefined;
    // Queue entries have passed eligibleToStart, including the body and the repo's rules.
    const work = store
      .queue(seat.id)
      .find(
        (q) =>
          q.repoId === repo &&
          q.takenAt === null &&
          board.some(
            (b) => b.issueNumber === q.issue && !b.closed && !b.blockedBy.some((d) => !d.closed),
          ),
      );
    if (
      seat.free &&
      row?.state === "idle" &&
      !seat.atStop &&
      since !== undefined &&
      now - since >= FLIGHT_IDLE_MS &&
      work
    ) {
      raise(
        "idle_seat",
        `${seat.id}:${since}`,
        since,
        `${seat.id} idle since ${new Date(since).toISOString()}; eligibleToStart queued ${work.repoId}#${work.issue}`,
      );
    }
  }
  for (const seat of session.seats) {
    const row = store.seatSession(seat.id);
    if (seatDef(seat).loop === "watch" && row?.state === "error" && row.reason) {
      const errorSince = row.errorSince ?? row.updatedAt;
      raise("hub_error", `watch:${seat.id}:${errorSince}`, errorSince, `${seat.id}: ${row.reason}`);
    }
  }
  for (const run of store.runsOverlapping(cutoff, now + 1)) {
    if (run.repoId !== repo || run.endedBy === "operator") continue;
    const seat = session.seats.find((s) => s.id === run.agentId);
    if (!seat) continue;
    const loop = seatDef(seat).loop;
    const review = run.reviewId == null ? null : store.review(run.reviewId);
    if (review?.state === "superseded") continue;
    if (
      !run.noReport &&
      loop === "review" &&
      (!review || !["queued", "starting", "running"].includes(review.state))
    )
      continue;
    const stoppedWithoutReport = /stopped.*without reporting/i.test(run.loop?.parked?.reason ?? "");
    if (run.endedAt === null && !stoppedWithoutReport) continue;
    const missing =
      run.noReport != null ||
      stoppedWithoutReport ||
      (loop === "build"
        ? run.loop != null &&
          run.ticket != null &&
          (!store.latestEvidence(run.id) ||
            (run.loop.phase === "working" &&
              (store.latestEvidence(run.id)?.id ?? 0) <= run.loop.reportedEvidenceId))
        : loop === "plan"
          ? !store.planLanded(run)
          : loop === "review");
    if (missing)
      raise(
        "hub_error",
        `report:${run.id}`,
        run.endedAt ?? store.seatSession(run.agentId)?.updatedAt ?? now,
        `${run.agentId} ${loop} run ${run.id} (${run.ticket ?? "no ticket"}) ${run.endedAt === null ? "stopped" : "ended"} without its report${run.noReport ? `: ${noReportExitReason(run.noReport)}` : ""}`,
      );
  }
  const loops = heartbeats(store).loops;
  for (const [source, loop] of Object.entries(loops)) {
    if (
      now - loop.at >= 2 * loop.interval &&
      Object.entries(loops).some(
        ([other, heartbeat]) =>
          other !== source && heartbeat.completed && heartbeat.at > loop.at + 2 * loop.interval,
      )
    ) {
      raise(
        "hub_error",
        `loop:${source}:${loop.at}`,
        loop.at,
        `${source} ${loop.completed ? "last completed" : "first due"} ${new Date(loop.at).toISOString()}; silent for twice its ${loop.interval} ms interval`,
      );
    }
  }
  if (!state.initialized) {
    for (const signal of Object.values(state.signals))
      if (
        signal.kind === "repeat_park" ||
        signal.kind === "flaky_test" ||
        (signal.kind === "hub_error" && signal.key.startsWith("report:"))
      )
        signal.toldAt = now;
    for (const entry of Object.values(state.triage)) entry.told = true;
    state.initialized = true;
  }
  save(store, repo, state);
  return {
    signals: Object.values(state.signals)
      .filter(
        (s) =>
          (s.kind !== "repeat_park" || onBoard.has(s.key.split(":")[0] ?? "")) &&
          (s.toldAt === null || active.has(signalId(s))),
      )
      .map(({ toldAt, lastSeen: _lastSeen, ...s }) => ({ ...s, told: toldAt !== null })),
    triage: Object.values(state.triage)
      .filter((t) => !t.told)
      .map(({ told: _told, at: _at, ...t }) => t),
  };
}

export function markFlightSignalsShown(store: Store, state: FlightState, now: number): void {
  const saved = read(store, state.repo, now);
  for (const signal of state.signals) {
    const entry = saved.signals[signalId(signal)];
    if (entry) entry.toldAt = now;
  }
  for (const triage of state.triage) {
    const entry = saved.triage[triageId(triage)];
    if (entry) entry.told = true;
  }
  save(store, state.repo, saved);
}

/** Includes delivered and resolved causes retained for the daily retrospective. */
export function flightSignalHistory(
  store: Store,
  repo: string,
  now: number,
): (FlightSignal & { lastSeen: number })[] {
  return Object.values(read(store, repo, now).signals).map(({ toldAt, ...signal }) => ({
    ...signal,
    lastSeen: signal.lastSeen ?? signal.since,
    told: toldAt !== null,
  }));
}
