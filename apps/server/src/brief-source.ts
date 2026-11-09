import { createHash } from "node:crypto";
import {
  type AttentionBrief,
  type AttentionItem,
  AWAY_SETTING,
  type BriefAction,
  type BriefReadState,
  CREW_PAUSE_SETTING,
  hudColumnOf,
} from "@mc/core";
import { pendingRunApproval } from "./attention-subjects.ts";
import type { CcConfig } from "./config.ts";
import { externalMergeHold, externalPrControl } from "./external-pr-control.ts";
import type { Store } from "./store.ts";

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
export const briefHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

const settingFact = (store: Store, key: string): unknown => {
  const raw = store.getSetting(key);
  try {
    return JSON.parse(raw ?? "null");
  } catch {
    return { unreadable: raw };
  }
};

/** Decision facts only: no brief, read bit, clock, poll timestamp, usage or cost counter. */
export function briefSourceRevision(
  config: CcConfig,
  store: Store,
  item: AttentionItem,
  actions: readonly BriefAction[],
): string {
  const runIds = new Set<string>();
  const seatIds = new Set<string>();
  const prs = new Set<string>();
  const queueKeys = new Set<string>();
  if (item.agentId) seatIds.add(item.agentId);
  const escalationId =
    item.escalationId ?? (item.key.startsWith("esc:") ? item.key.slice(4) : null);
  const escalation = escalationId ? store.escalation(escalationId) : null;
  const questionId = /^ask:(\d+)$/.exec(item.key)?.[1];
  const question = questionId ? store.question(Number(questionId)) : null;
  if (question) {
    runIds.add(question.runId);
    seatIds.add(question.agentId);
  }
  const note = item.key.startsWith("note:")
    ? store.notes().find((n) => `note:${n.key}` === item.key)
    : null;
  if (note?.runId) runIds.add(note.runId);
  if (item.key.startsWith("note:queue-reorder:")) queueKeys.add(item.key.slice(5));
  const pr = /^pr:([^#]+)#(\d+):/.exec(item.key);
  if (pr) prs.add(`${pr[1]}#${pr[2]}`);
  for (const action of actions) {
    if ("seatId" in action) seatIds.add(action.seatId);
    if ("runId" in action) runIds.add(action.runId);
    if ("target" in action) {
      if (action.target.kind === "run") runIds.add(action.target.runId);
      else prs.add(`${action.target.repoId}#${action.target.number}`);
    }
    if (action.kind === "uat") prs.add(`${action.repoId}#${action.number}`);
    if (action.kind === "queue-proposal") queueKeys.add(action.key.replace(/^note:/, ""));
  }
  for (const runId of runIds) {
    const run = store.run(runId);
    if (run) seatIds.add(run.agentId);
  }
  for (const key of queueKeys) {
    try {
      const proposal = JSON.parse(store.getSetting(key) ?? "null") as { seat?: string } | null;
      if (proposal?.seat) seatIds.add(proposal.seat);
    } catch {
      /* The unreadable original proposal still participates in the fingerprint below. */
    }
  }
  // Run delivery follows the same run through ordinary commits and an exact-question set-aside.
  // Head-targeting actions keep the complete head/review/gate fingerprint below.
  const deliveryOnly =
    actions.every((action) =>
      ["answer", "ordinary-run-guidance", "attention-hold", "record-decision"].includes(
        action.kind,
      ),
    ) &&
    actions.some((action) => action.kind === "answer" || action.kind === "ordinary-run-guidance");
  const questionRun = question ? store.run(question.runId) : null;
  const exactQuestionAside = (seatId: string): boolean =>
    question !== null &&
    question.agentId === seatId &&
    questionRun?.endedAt === null &&
    questionRun.loop?.aside?.ask === question.id;
  for (const seatId of seatIds) {
    // An exact answer remains bound to its preserved run, not replacement work on the seat.
    if (deliveryOnly && exactQuestionAside(seatId)) continue;
    const run = store.seatRun(seatId);
    if (run) runIds.add(run.id);
  }
  const runs = [...runIds].sort().map((id) => {
    const run = store.run(id);
    if (run && deliveryOnly)
      return {
        id: run.id,
        agentId: run.agentId,
        repoId: run.repoId,
        ticket: run.ticket,
        status: run.status,
        endedAt: run.endedAt,
        parked: run.loop?.parked ?? null,
        mergeHold: run.loop?.mergeHold ?? null,
        controllerCheckRequired: run.loop?.controllerCheckRequired ?? false,
        controllerCheck: run.loop?.controllerCheck ?? null,
        uat: run.loop?.uat ?? null,
        approvalPending: pendingRunApproval(store, run),
      };
    return run
      ? {
          id: run.id,
          agentId: run.agentId,
          repoId: run.repoId,
          ticket: run.ticket,
          branch: run.branch,
          status: run.status,
          endedAt: run.endedAt,
          loop: run.loop
            ? {
                phase: run.loop.phase,
                epoch: run.loop.epoch,
                parked: run.loop.parked,
                prNumber: run.loop.prNumber,
                touches: run.loop.touches,
                gate: run.loop.gate,
                controllerCheckRequired: run.loop.controllerCheckRequired,
                controllerCheck: run.loop.controllerCheck,
                uat: run.loop.uat,
                mergeHold: run.loop.mergeHold,
                reviewWaivedSha: run.loop.reviewWaivedSha,
                reviewReplyTo: run.loop.reviewReplyTo,
                reportedEvidenceId: run.loop.reportedEvidenceId,
                awaitingFlight: run.loop.awaitingFlight,
                flightClearedSha: run.loop.flightClearedSha,
                flightSecondReview: run.loop.flightSecondReview,
                flightReworks: run.loop.flightReworks,
                awayBugDecision: run.loop.awayBugDecision,
                aside: run.loop.aside,
                merging: run.loop.merging,
                mainMerge: run.loop.mainMerge,
              }
            : null,
          head: store.newestRunCommit(id)?.sha ?? null,
          reviews: store.reviewsOfRun(id).map((review) => ({
            id: review.id,
            sha: review.sha,
            state: review.state,
            blocking: review.blocking,
          })),
        }
      : { id, missing: true };
  });
  const seats = [...seatIds].sort().map((id) => {
    const session = config.crew?.sessions.find((session) =>
      session.seats.some((seat) => seat.id === id),
    );
    const configured = session?.seats.find((seat) => seat.id === id);
    const row = store.seatSession(id);
    return {
      id,
      configured,
      current: row
        ? {
            runId: deliveryOnly && exactQuestionAside(id) ? question?.runId : row.runId,
            stopped: row.state === "stopped",
          }
        : null,
      instructions: store.instructions.active(id),
      queue: actions.some(
        (action) =>
          action.kind === "direct-queue-priority-swap" || action.kind === "queue-proposal",
      )
        ? store
            .queue(id)
            .map((entry) => ({ repoId: entry.repoId, issue: entry.issue, takenAt: entry.takenAt }))
        : undefined,
      board: actions.some(
        (action) =>
          action.kind === "direct-queue-priority-swap" || action.kind === "queue-proposal",
      )
        ? config.repos
            .filter((repo) => repo.id === session?.repoId)
            .flatMap((repo) =>
              store.board(repo.id).map((card) => ({
                repoId: repo.id,
                issue: card.issueNumber,
                priority: card.priority,
                labels: [...card.labels].sort(),
                column: hudColumnOf(card),
                size: card.size,
                closed: card.closed,
              })),
            )
        : undefined,
    };
  });
  let hold: unknown = null;
  try {
    hold = JSON.parse(store.getSetting("attention-holds") ?? "{}")[item.key] ?? null;
  } catch {
    hold = "unreadable";
  }
  const person = /^person:(\d+):(\d+)$/.exec(item.key);
  const notification = person ? store.notification(person[1] ?? "") : null;
  const sourceComms = item.key.startsWith("comms-open:")
    ? store.commsMessage(item.key.slice("comms-open:".length))
    : null;
  return briefHash({
    item: {
      key: item.key,
      kind: item.kind,
      agentId: item.agentId,
      repoId: item.repoId,
      text: item.text,
      at: item.at,
      ticket: item.ticket,
      escalationId: item.escalationId,
    },
    escalation,
    question: question
      ? {
          id: question.id,
          runId: question.runId,
          agentId: question.agentId,
          text: question.text,
          at: question.at,
          passedAt: question.passedAt,
          answeredAt: question.answeredAt,
        }
      : null,
    note: note
      ? { key: note.key, kind: note.kind, runId: note.runId, text: note.text, at: note.at }
      : null,
    person: notification
      ? {
          updatedAt: notification.updatedAt,
          message: notification.message,
          handledThrough: notification.handledThrough,
        }
      : null,
    sourceComms: sourceComms
      ? {
          id: sourceComms.id,
          at: sourceComms.at,
          from: sourceComms.from,
          to: sourceComms.to,
          text: sourceComms.text,
          ticket: sourceComms.ticket,
          label: sourceComms.label,
          replyTo: sourceComms.replyTo,
        }
      : null,
    queueProposals: [...queueKeys].sort().map((key) => {
      const raw = store.getSetting(key);
      try {
        const { state: _dispatchState, ...facts } = JSON.parse(raw ?? "{}");
        return [key, facts];
      } catch {
        return [key, raw];
      }
    }),
    prs: [...prs].sort().map((ref) => {
      const [repo, number] = ref.split("#");
      const row = store.pullRequest(repo ?? "", Number(number));
      return row
        ? {
            ref,
            head: row.headSha,
            state: row.state,
            branch: row.branch,
            ticket: row.ticket,
            title: row.title,
            ci: row.ci,
            review: row.review,
            isDraft: row.isDraft,
            control: row.headSha
              ? externalPrControl(store, repo ?? "", Number(number), row.headSha)
              : null,
            mergeHold: externalMergeHold(store, repo ?? "", Number(number)),
            reviews: store.reviewsOfPr(repo ?? "", Number(number)).map((review) => ({
              id: review.id,
              sha: review.sha,
              state: review.state,
              blocking: review.blocking,
            })),
          }
        : { ref, missing: true };
    }),
    runs,
    runQuestions: store
      .openQuestions()
      .filter((question) => runIds.has(question.runId))
      .map((question) => ({
        id: question.id,
        runId: question.runId,
        text: question.text,
        at: question.at,
        passedAt: question.passedAt,
      })),
    seats,
    hold,
    repo: config.repos.find((repo) => repo.id === item.repoId),
    globalInstructions: store.instructions.active(null),
    flightAuthority: actions.some(
      (action) =>
        action.kind === "ordinary-run-guidance" || action.kind === "direct-queue-priority-swap",
    )
      ? config.crew?.sessions
          .filter((session) => session.seats.some((seat) => seatIds.has(seat.id)))
          .flatMap((session) =>
            session.seats
              .filter((seat) => seat.role === "FLIGHT")
              .map((seat) => ({
                configured: seat,
                instructions: store.instructions.active(seat.id),
              })),
          )
      : undefined,
    pause: settingFact(store, CREW_PAUSE_SETTING),
    away: settingFact(store, AWAY_SETTING),
  });
}

export function briefReadState(
  config: CcConfig,
  store: Store,
  item: AttentionItem,
  brief: AttentionBrief,
): BriefReadState {
  if (brief.for === "flight")
    return {
      completeness: "complete",
      freshness: "unknown",
      reason: "FLIGHT triage only; no operator choice or default authority is bound.",
    };
  const binding = brief.binding;
  if (!binding || !brief.id || !brief.decision)
    return {
      completeness: "incomplete",
      freshness: "unknown",
      reason: "Needs a refreshed brief: historical source/action binding is unknown.",
    };
  const current = briefSourceRevision(
    config,
    store,
    item,
    binding.actions.map((entry) => entry.action),
  );
  return current === binding.sourceRevision
    ? {
        completeness: "complete",
        freshness: "current",
        reason: "Bound to retained source facts; authorization is rechecked before action.",
        checkedAt: binding.preparedAt,
      }
    : {
        completeness: "complete",
        freshness: "stale",
        reason: "The decision source, target, scope or hold changed after this brief.",
        checkedAt: binding.preparedAt,
      };
}
