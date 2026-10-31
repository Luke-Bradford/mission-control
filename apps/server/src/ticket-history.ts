import {
  type CiRunView,
  doneWhenChecklist,
  type Run,
  type TicketEvent,
  type TicketHistory,
  type TicketPrView,
  type TicketReviewRound,
  type TicketView,
  ticketOutcome,
} from "@mc/core";
import type { Store } from "./store.ts";

/** Events on one page: the default and the most a caller may ask for. */
export const TICKET_PAGE_DEFAULT = 50;
export const TICKET_PAGE_MAX = 200;
/** Rows read per source before the merge, so a ticket with a long history stays one bounded read. */
const SOURCE_LIMIT = 1_000;

/** `at~key` of the last event of a page. */
const encodeCursor = (e: { at: number; key: string }): string => `${e.at}~${e.key}`;

/** The cursor a caller passed, or null when it is not one this module made. */
export function decodeCursor(raw: string): { at: number; key: string } | null {
  const m = /^(\d{1,16})~([\w:.-]{1,100})$/.exec(raw);
  return m === null ? null : { at: Number(m[1]), key: m[2] ?? "" };
}

const newestFirst = (a: { at: number; key: string }, b: { at: number; key: string }): number =>
  b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

/** The latest attempt of each named check on one head. */
function latestChecks(runs: CiRunView[]): CiRunView[] {
  const best = new Map<string, CiRunView>();
  for (const r of runs) {
    const have = best.get(r.name);
    if (
      have === undefined ||
      r.attempt > have.attempt ||
      (r.attempt === have.attempt && r.at > have.at)
    )
      best.set(r.name, r);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function prView(
  store: Store,
  repoId: string,
  pr: ReturnType<Store["pullRequestsOnTicket"]>[number],
) {
  const reviews = store.reviewsOfPr(repoId, pr.number);
  const rounds: TicketReviewRound[] = reviews.map((v) => ({
    reviewId: v.id,
    round: v.round,
    sha: v.sha,
    state: v.state,
    verdict: v.verdict,
    summary: v.summary,
    blocking: v.blocking,
    minor: v.minor,
    at: v.endedAt ?? v.createdAt,
    findings: store.findingsOf(v.id).map((f) => ({
      pos: f.pos,
      severity: f.severity,
      file: f.file,
      line: f.line,
      summary: f.summary,
      scenario: f.scenario,
      fix: f.fix,
      state: f.state,
      resolution: f.resolution ?? null,
      resolvedInReviewId: f.resolvedReviewId ?? null,
    })),
  }));
  const bySha = new Map<string, CiRunView[]>();
  for (const r of store.ciRunsOfPr(repoId, pr.number))
    bySha.set(r.sha, [...(bySha.get(r.sha) ?? []), r]);
  const ci = [...bySha.entries()]
    .map(([sha, runs]) => ({
      sha,
      at: Math.max(...runs.map((r) => r.at)),
      checks: latestChecks(runs).map((r) => ({
        name: r.name,
        conclusion: r.conclusion,
        state: r.state,
        url: r.url,
      })),
    }))
    .sort((a, b) => b.at - a.at);
  const view: TicketPrView = {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.branch,
    state: pr.state,
    isDraft: pr.isDraft,
    headSha: pr.headSha,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    rounds,
    ci,
  };
  return view;
}

const runView = (r: Run) => ({
  id: r.id,
  seat: r.agentId,
  status: r.status,
  phase: r.loop?.phase ?? null,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  tokens: r.tokens,
  costUsd: r.costUsd,
});

export interface TicketHistoryInput {
  store: Store;
  repoId: string;
  /** The repo's GitHub slug, for the issue URL when neither the board nor GitHub gave one. */
  github: string;
  number: number;
  /** The issue as GitHub reads it now; null when it was not read. */
  issue: TicketView | null;
  githubError: string | null;
  before: { at: number; key: string } | null;
  limit: number;
}

/**
 * Everything the hub holds on one ticket, or null when it holds nothing: no board card, no issue
 * from GitHub and no run, PR, decision or message that names it.
 */
export function ticketHistory(i: TicketHistoryInput): TicketHistory | null {
  const { store, repoId, number } = i;
  const ref = `${repoId}#${number}`;
  const card = store.boardItem(repoId, number);
  const runs = store
    .runsOnTicket(repoId, ref)
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
  const prs = store.pullRequestsOnTicket(repoId, ref).map((pr) => prView(store, repoId, pr));
  const decisions = store.flightDecisionsOnTicket(
    ref,
    runs.map((r) => r.id),
    SOURCE_LIMIT,
  );
  const comms = store.commsOnTicket(ref, SOURCE_LIMIT);
  if (
    card === null &&
    i.issue === null &&
    runs.length + prs.length + decisions.length + comms.length === 0
  )
    return null;

  const events: TicketEvent[] = [];
  for (const r of runs.slice(0, SOURCE_LIMIT))
    events.push({
      key: `run:${r.id}`,
      at: r.startedAt,
      kind: "run",
      runId: r.id,
      seat: r.agentId,
      status: r.status,
      phase: r.loop?.phase ?? null,
    });
  for (const pr of prs) {
    for (const v of pr.rounds)
      events.push({
        key: `review:${v.reviewId}`,
        at: v.at,
        kind: "review",
        prNumber: pr.number,
        reviewId: v.reviewId,
        round: v.round,
        state: v.state,
        blocking: v.blocking,
        minor: v.minor,
      });
    for (const head of pr.ci)
      events.push({
        key: `ci:${pr.number}:${head.sha}`,
        at: head.at,
        kind: "ci",
        prNumber: pr.number,
        sha: head.sha,
        passing: head.checks.filter((c) => c.state === "passing").length,
        failing: head.checks.filter((c) => c.state === "failing").length,
        pending: head.checks.filter((c) => c.state === "pending").length,
      });
  }
  for (const d of decisions)
    events.push({
      key: `decision:${d.id}`,
      at: d.at,
      kind: "decision",
      id: d.id,
      decisionKind: d.kind,
      about: d.about,
      decision: d.decision,
      basis: d.basis,
    });
  for (const m of comms)
    events.push({
      key: `comms:${m.id}`,
      at: m.at,
      kind: "comms",
      id: m.id,
      from: m.from,
      to: m.to,
      label: m.label,
      text: m.text,
    });
  events.sort(newestFirst);

  const after = i.before;
  const rest = after === null ? events : events.filter((e) => newestFirst(after, e) < 0);
  const timeline = rest.slice(0, i.limit);
  const last = timeline[timeline.length - 1];

  const body = i.issue?.body ?? null;
  return {
    repoId,
    number,
    url: i.issue?.url ?? card?.url ?? `https://github.com/${i.github}/issues/${number}`,
    title: i.issue?.title ?? card?.title ?? runs[0]?.ticketTitle ?? ref,
    state: i.issue?.state ?? (card === null ? "open" : card.closed ? "closed" : "open"),
    status: card?.status ?? null,
    priority: card?.priority ?? null,
    size: card?.size ?? null,
    labels: i.issue?.labels ?? card?.labels ?? [],
    outcome: body === null ? null : ticketOutcome(body),
    doneWhen: body === null ? [] : doneWhenChecklist(body),
    body,
    bodyTruncated: i.issue?.bodyTruncated ?? false,
    githubError: i.githubError,
    runs: runs.map(runView),
    prs,
    timeline,
    nextBefore: rest.length > timeline.length && last !== undefined ? encodeCursor(last) : null,
  };
}
