/** One read model for the open-PR panel, FLIGHT's digest and its timed wake signals. */
import {
  carriedFrom,
  clockHm,
  type FlightPrFlow,
  type FlightPrFlowRow,
  type PullRequestView,
  prCarries,
  type ReviewRow,
  type Run,
  type RunLoop,
  reviewFor,
  ticketWaits,
} from "@mc/core";
import type { Store } from "./store.ts";

type Stage = FlightPrFlowRow["stage"];
type Owner = NonNullable<FlightPrFlowRow["ownerKind"]>;
type Attempt = ReturnType<Store["runAttempts"]>[number];
const STAGES: Stage[] = [
  "building",
  "CI",
  "review",
  "rework",
  "sync",
  "clearance",
  "controller check",
  "merge",
];
const WEEK = 7 * 24 * 60 * 60_000;
const UNOWNED_MS = 5 * 60_000;
const HUMAN_MS = 15 * 60_000;
const percentile = (values: number[], p: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
};

// Historical cohorts may be backfilled after merge. Bound reuse to 30s, and expire at exact
// window boundaries or whenever the immutable merge set changes. Live rows never use this cache.
const metricCache = new WeakMap<
  Store,
  Map<string, { key: string; at: number; until: number; metrics: FlightPrFlow["metrics"] }>
>();

interface Position {
  stage: Stage;
  owner: Owner;
  reason?: string;
}
interface Point {
  at: number;
  position: Position;
}
interface Action {
  at: number;
  text: string;
  actor: string | null;
}

/** Passed gates stay on the loop as audit evidence; only unresolved gates own the next step. */
function position(
  loop: RunLoop | null,
  sha: string | null,
  review: Partial<ReviewRow> | null,
  fixing: boolean,
): Position {
  if (loop?.controllerCheck && !loop.controllerCheck.pass)
    return {
      stage: "controller check",
      owner: "controller",
      reason:
        loop.controllerCheck.sha === sha
          ? "controller check"
          : "controller check for an older head; recheck required",
    };
  if (loop?.uat && !loop.uat.accepted)
    return {
      stage: "clearance",
      owner: "operator",
      reason:
        loop.uat.sha === sha
          ? "waiting for your acceptance"
          : "acceptance for an older head; recheck required",
    };
  if (loop?.mergeHold)
    return {
      stage: "clearance",
      owner: loop.mergeHold.by === "CAPCOM" ? "operator" : "FLIGHT",
      reason: loop.mergeHold.reason,
    };
  if (loop?.awaitingFlight)
    return { stage: "clearance", owner: "FLIGHT", reason: "FLIGHT clearance" };
  if (loop?.mainMerge) return { stage: "sync", owner: "seat", reason: "main to sync" };
  if (loop?.parked) return { stage: "clearance", owner: "FLIGHT", reason: loop.parked.reason };
  if (loop?.merging || loop?.phase === "done") return { stage: "merge", owner: "hub" };
  if (fixing) return { stage: "rework", owner: "seat", reason: "fixing blocking review findings" };
  if (loop?.phase === "ci") return { stage: "CI", owner: "CI" };
  if (loop?.phase === "working") return { stage: "building", owner: "seat" };
  if (
    review &&
    (loop == null || review.epoch === loop.epoch) &&
    (review.sha === sha ||
      (sha !== null &&
        review.sha === carriedFrom(loop?.carry, loop?.reviewWaivedSha, sha) &&
        review.state === "reported" &&
        review.blocking === 0)) &&
    review.state !== "superseded"
  ) {
    if (review.state === "reported" && review.blocking === 0)
      return { stage: "merge", owner: "hub" };
    if (review.state === "reported" && (review.blocking ?? 0) > 0)
      return {
        stage: "review",
        owner: "hub",
        reason: "blocking findings await delivery to the author",
      };
    return { stage: "review", owner: "review" };
  }
  return loop?.phase === "review"
    ? { stage: "review", owner: "review" }
    : { stage: "building", owner: "seat" };
}

/** Direct PR/branch bindings outrank ticket fallback. Review runs never author a PR. */
function authors(pr: PullRequestView, runs: Run[]): Run[] {
  const direct = runs.filter(
    (r) =>
      r.loop?.prNumber === pr.number ||
      r.prs.some((p) => p.number === pr.number) ||
      r.branch === pr.branch,
  );
  return (
    direct.length
      ? direct
      : runs.filter(
          (r) =>
            pr.ticket !== null &&
            r.ticket === pr.ticket &&
            r.loop?.prNumber == null &&
            r.prs.length === 0,
        )
  ).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

function history(
  store: Store,
  pr: PullRequestView,
  run: Run,
  events: ReturnType<Store["loopEvents"]>,
) {
  const attempts = store.runAttempts(run.id).filter((a) => a.runId === run.id);
  const fixes = events.filter((e) => e.runId === run.id && /:review:\d+:fix$/.test(e.key));
  const ordered: { at: number; id: number; attempt?: Attempt; fix?: true }[] = [
    ...attempts.map((a) => ({ at: a.at, id: a.id, attempt: a })),
    ...fixes.map((e) => ({ at: e.at, id: Number.MAX_SAFE_INTEGER, fix: true as const })),
  ].sort((a, b) => a.at - b.at || a.id - b.id);
  let loop: RunLoop | null = null;
  let sha: string | null = null;
  let review: Partial<ReviewRow> | null = null;
  let fixing = false;
  const points: Point[] = [
    { at: Math.max(pr.createdAt, run.startedAt), position: position(null, null, null, false) },
  ];
  const actions: Action[] = [{ at: run.startedAt, text: "run started", actor: run.agentId }];
  for (const e of ordered) {
    if (e.at < run.startedAt) continue;
    const a = e.attempt;
    if (e.fix) fixing = true;
    if (a?.kind === "loop") {
      if (a.data.epoch !== loop?.epoch) fixing = false;
      loop = a.data.phase ? (a.data as unknown as RunLoop) : null;
      if (loop?.pushFor) sha = loop.pushFor;
      if (loop?.phase === "ci" || loop?.phase === "working") fixing = false;
    } else if (a?.kind === "push") {
      sha = typeof a.data.sha === "string" ? a.data.sha : sha;
      fixing = false;
      actions.push({ at: e.at, text: "head pushed", actor: run.agentId });
    } else if (a?.kind === "review") {
      review = a.data as Partial<ReviewRow>;
      sha ??= review.sha ?? null;
      fixing = false;
      actions.push({
        at: e.at,
        text: `review ${review.state ?? "updated"}`,
        actor: review.seatId ?? "review seat",
      });
    } else if (a?.kind === "ci" && a.data.state != null) {
      actions.push({ at: e.at, text: `CI ${String(a.data.state ?? "updated")}`, actor: "CI" });
    } else if (a?.kind === "merge") {
      actions.push({ at: e.at, text: "PR merged", actor: "hub" });
    }
    const p = position(loop, sha, review, fixing);
    const previous = points.at(-1)?.position;
    if (p.stage !== previous?.stage || p.owner !== previous?.owner) {
      points.push({ at: Math.max(pr.createdAt, e.at), position: p });
      if (a?.kind === "loop")
        actions.push({
          at: e.at,
          text: p.reason ?? `${p.stage} started`,
          actor: p.owner === "seat" ? run.agentId : p.owner,
        });
    }
  }
  // Older runs can predate attempt recording. Their current loop is useful, but has no invented start time.
  const current = position(run.loop ?? null, pr.headSha, review, fixing);
  const last = points.at(-1);
  if (current.stage !== last?.position.stage || current.owner !== last?.position.owner)
    points.push({ at: Math.max(pr.createdAt, run.startedAt, last?.at ?? 0), position: current });
  if (run.endedAt !== null)
    actions.push({ at: run.endedAt, text: "run ended", actor: run.agentId });
  return { points, actions };
}

/** Pure reads: no deals, messages, writes or HTTP/GitHub calls. */
export function prFlow(store: Store, repoId: string, now: number): FlightPrFlow {
  const prs = store.pullRequests(repoId);
  const merged = store.prHistory(repoId, now - WEEK, now);
  let cache = metricCache.get(store);
  if (!cache) {
    cache = new Map();
    metricCache.set(store, cache);
  }
  const key = JSON.stringify(merged.map((p) => [p.number, p.createdAt, p.mergedAt, p.headSha]));
  const previous = cache.get(repoId);
  const cached =
    previous && previous.key === key && now >= previous.at && now < previous.until
      ? previous.metrics
      : null;
  // Complete bindings are independent of metric reuse: an author can finish before the PR opens.
  const runs = store.prFlowRuns(
    repoId,
    cached
      ? prs.filter((p) => p.state === "open")
      : [...prs.filter((p) => p.state === "open"), ...merged],
  );
  const events = runs.flatMap((r) => store.loopEventsOfRun(r.id));
  const board = store.board(repoId);
  const holds = store.activeHolds().filter((h) => h.ref.startsWith(`${repoId}#`));
  const open = prs.filter((p) => p.state === "open");
  const histories = new Map<string, ReturnType<typeof history>>();
  const readHistory = (pr: PullRequestView, run: Run) => {
    const key = `${pr.number}:${run.id}`;
    let h = histories.get(key);
    if (!h) {
      h = history(store, pr, run, events);
      histories.set(key, h);
    }
    return h;
  };
  const dependencies = board
    .filter((c) => !c.closed)
    .map((card) => ({ card, waits: ticketWaits({ repoId, card, board, prs }) }));
  const rows: FlightPrFlowRow[] = open
    .map((pr) => {
      const related = authors(pr, runs);
      const run = related.at(-1) ?? null;
      const active = run?.endedAt === null ? run : null;
      const reviews = store.reviewsOfPr(repoId, pr.number);
      const candidateReviews = run ? reviews.filter((r) => r.authorRunId === run.id) : reviews;
      const fact =
        pr.headSha === null
          ? null
          : reviewFor(
              candidateReviews,
              run?.loop?.epoch ?? candidateReviews.at(-1)?.epoch ?? 0,
              pr.headSha,
              carriedFrom(run?.loop?.carry, run?.loop?.reviewWaivedSha, pr.headSha),
            );
      const currentReview = candidateReviews.find((r) => r.id === fact?.id) ?? null;
      const h = run ? readHistory(pr, run) : null;
      const latestPoint = h?.points.at(-1);
      const fixing = latestPoint?.position.stage === "rework";
      const p = position(run?.loop ?? null, pr.headSha, currentReview ?? null, fixing);
      const liveReview =
        currentReview && ["queued", "starting", "running"].includes(currentReview.state)
          ? currentReview
          : null;
      let ownerKind: Owner = active ? p.owner : liveReview ? "review" : "nobody";
      const stage = liveReview && !active ? "review" : p.stage;
      const stageSince =
        liveReview && !active
          ? (liveReview.startedAt ?? liveReview.createdAt)
          : ([...(h?.points ?? [])]
              .reverse()
              .find(
                (point, i, all) =>
                  point.position.stage === stage && all[i + 1]?.position.stage !== stage,
              )?.at ?? pr.createdAt);
      const ownerSince =
        ownerKind === "nobody"
          ? (run?.endedAt ?? pr.createdAt)
          : (latestPoint?.at ??
            currentReview?.startedAt ??
            currentReview?.createdAt ??
            pr.createdAt);
      const ahead = active?.loop?.aside
        ? runs.find(
            (r) =>
              r.id !== active.id &&
              r.agentId === active.agentId &&
              r.endedAt === null &&
              !r.loop?.aside,
          )
        : null;
      if (ahead && !liveReview && p.owner === "review") ownerKind = "seat";
      const seatId =
        ownerKind === "seat"
          ? (active?.agentId ?? null)
          : ownerKind === "review"
            ? (liveReview?.seatId ?? null)
            : null;
      const owner =
        ownerKind === "seat" && ahead?.loop?.prNumber != null
          ? `${active?.agentId} is on PR ${ahead.loop.prNumber} (2nd in its queue)`
          : (seatId ?? (ownerKind === "review" ? "review seat" : ownerKind));
      const ownDeps = dependencies
        .filter(({ card }) => prCarries(pr, repoId, card.issueNumber))
        .flatMap(({ waits }) => waits.map((w) => w.text));
      // A stacked PR can lack a board card, so read its base directly as well.
      const under = open.find((p) => p.number !== pr.number && p.branch === pr.base);
      if (under) ownDeps.push(`PR ${under.number} to merge`);
      const blocks = new Set<string>();
      for (const { card, waits } of dependencies) {
        if (
          !waits.some(
            (w) =>
              w.ref === `PR ${pr.number}` ||
              (w.ref.startsWith(`${repoId}#`) &&
                prCarries(pr, repoId, Number(w.ref.slice(repoId.length + 1)))),
          )
        )
          continue;
        blocks.add(`${repoId}#${card.issueNumber}`);
        for (const dependent of open.filter((p) => prCarries(p, repoId, card.issueNumber)))
          blocks.add(`PR ${dependent.number}`);
      }
      for (const dependent of open.filter((p) => p.number !== pr.number && p.base === pr.branch))
        blocks.add(`PR ${dependent.number}`);
      for (const hold of holds.filter((v) => v.waitsOn === pr.number)) {
        blocks.add(hold.ref);
        for (const dependent of open.filter((p) => p.ticket === hold.ref))
          blocks.add(`PR ${dependent.number}`);
      }
      const waitsOn = [
        ...new Set([
          ...(ownerKind === "nobody" ? [`no run since ${clockHm(ownerSince, "UTC")}`] : []),
          ...(p.reason ? [p.reason] : []),
          ...(ahead?.loop?.prNumber != null
            ? [`${active?.agentId} is on PR ${ahead.loop.prNumber} (2nd in its queue)`]
            : []),
          ...ownDeps,
          ...holds
            .filter((v) => v.ref === pr.ticket)
            .map((v) => `PR ${v.waitsOn} to merge (${v.ref})`),
        ]),
      ];
      const actions: Action[] = [...(h?.actions ?? [])];
      for (const review of reviews.filter((r) => r.state !== "superseded")) {
        actions.push({
          at: review.endedAt ?? review.startedAt ?? review.createdAt,
          text: `review ${review.state}`,
          actor: review.seatId,
        });
      }
      for (const ci of store.ciRunsOfPr(repoId, pr.number))
        actions.push({ at: ci.firstSeenAt, text: `CI ${ci.name} observed`, actor: "CI" });
      for (const e of events.filter((e) => related.some((r) => r.id === e.runId)))
        actions.push({
          at: e.at,
          text: e.text,
          actor: /:controller-check:/.test(e.key)
            ? "controller"
            : /:uat:.*:(?:accept|send-back)$/.test(e.key)
              ? "operator"
              : /by CAPCOM/.test(e.text)
                ? "operator"
                : /by FLIGHT/.test(e.text)
                  ? "FLIGHT"
                  : "hub",
        });
      const decisions = store.flightDecisionsOnTicket(
        pr.ticket ?? `${repoId}/PR ${pr.number}`,
        related.map((r) => r.id),
        1,
      );
      for (const d of decisions.filter(
        (d) =>
          related.some((r) => r.id === d.targetRunId) ||
          (pr.ticket !== null && d.ref === pr.ticket) ||
          d.ref === `${repoId}/PR ${pr.number}`,
      ))
        actions.push({ at: d.at, text: d.decision, actor: "FLIGHT" });
      for (const hold of holds.filter((v) => v.ref === pr.ticket))
        actions.push({ at: hold.at, text: hold.basis, actor: "FLIGHT" });
      const last = actions
        .filter((a) => a.at <= now)
        .sort((a, b) => a.at - b.at)
        .at(-1);
      return {
        pr: pr.number,
        ticket: pr.ticket,
        title: pr.title,
        owner,
        ownerKind,
        seatId,
        stage,
        stageSince,
        ownerSince,
        openSince: pr.createdAt,
        waitsOn,
        blocks: [...blocks],
        lastAction: last?.text ?? "PR opened",
        lastActor: last?.actor ?? null,
        lastActionAt: last?.at ?? pr.createdAt,
      };
    })
    .sort(
      (a, b) => Number(b.ownerKind === "nobody") - Number(a.ownerKind === "nobody") || a.pr - b.pr,
    );

  const samples = cached
    ? []
    : merged.map((pr) => {
        const byStage = new Map<Stage, number>();
        const related = authors(pr, runs);
        related.forEach((run, index) => {
          const points = readHistory(pr, run).points;
          const end = Math.min(
            pr.mergedAt ?? now,
            run.endedAt ?? now,
            related[index + 1]?.startedAt ?? now,
          );
          points.forEach((point, i) => {
            const duration =
              Math.min(points[i + 1]?.at ?? end, end) - Math.max(point.at, pr.createdAt);
            if (duration > 0)
              byStage.set(
                point.position.stage,
                (byStage.get(point.position.stage) ?? 0) + duration,
              );
          });
        });
        const rounds = store
          .reviewsOfPr(repoId, pr.number)
          .filter((r) => r.blocking > 0 && r.endedAt !== null).length;
        return { pr, byStage, rounds };
      });
  const metrics =
    cached ??
    [24 * 60 * 60_000, WEEK].map((windowMs) => {
      const cohort = samples.filter((s) => (s.pr.mergedAt ?? 0) >= now - windowMs);
      const durations = cohort.map((s) =>
        Math.max(0, (s.pr.mergedAt ?? s.pr.createdAt) - s.pr.createdAt),
      );
      return {
        windowMs,
        merged: cohort.length,
        openToMerge: { p50Ms: percentile(durations, 50), p90Ms: percentile(durations, 90) },
        stageTimes: STAGES.map((stage) => {
          const values = cohort.flatMap((s) =>
            s.byStage.has(stage) ? [s.byStage.get(stage) as number] : [],
          );
          return { stage, p50Ms: percentile(values, 50), p90Ms: percentile(values, 90) };
        }),
        reworkRounds: {
          p50: percentile(
            cohort.map((s) => s.rounds),
            50,
          ),
          p90: percentile(
            cohort.map((s) => s.rounds),
            90,
          ),
        },
      };
    });
  if (!cached) {
    const boundaries = merged
      .flatMap((p) => [24 * 60 * 60_000, WEEK].map((window) => (p.mergedAt ?? 0) + window + 1))
      .filter((at) => at > now);
    cache.set(repoId, { key, at: now, until: Math.min(now + 30_000, ...boundaries), metrics });
  }
  return {
    generatedAt: now,
    rows,
    unowned: rows.filter((r) => r.ownerKind === "nobody").length,
    metrics,
  };
}

function deadlines(flow: FlightPrFlow | undefined) {
  return (
    flow?.rows.flatMap((row) => {
      const out: { at: number; fact: string }[] = [];
      if (row.owner === "nobody" && row.ownerSince !== null)
        out.push({ at: row.ownerSince + UNOWNED_MS, fact: `${row.pr}:unowned:${row.ownerSince}` });
      const p90 = flow.metrics
        .find((m) => m.windowMs === WEEK)
        ?.stageTimes.find((s) => s.stage === row.stage)?.p90Ms;
      if (p90 != null && p90 > 0)
        out.push({
          at: row.stageSince + p90,
          fact: `${row.pr}:stage:${row.stage}:${row.stageSince}`,
        });
      if ((row.owner === "controller" || row.owner === "operator") && row.ownerSince !== null)
        out.push({
          at: row.ownerSince + HUMAN_MS,
          fact: `${row.pr}:waiting:${row.owner}:${row.ownerSince}`,
        });
      return out;
    }) ?? []
  );
}

export const prFlowWakeTimes = (flow: FlightPrFlow | undefined): number[] =>
  deadlines(flow).map((d) => d.at);
export const prFlowFacts = (flow: FlightPrFlow | undefined): string[] =>
  deadlines(flow)
    .filter((d) => d.at <= (flow?.generatedAt ?? 0))
    .map((d) => d.fact)
    .sort();
