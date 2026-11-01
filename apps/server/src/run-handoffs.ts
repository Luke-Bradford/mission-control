import { NEW_LOOP, type Run, type RunHandoff, type RunLoop } from "@mc/core";
import { cleanText } from "./clean.ts";
import { handoffCheckoutStatus } from "./runtime/checkouts.ts";
import type { Store } from "./store.ts";

const safe = (s: string) => cleanText(s, 1500);

/** Never claims completion from a stopped process. It records only the evidence that was saved. */
export function recordRunHandoff(
  store: Store,
  run: Run,
  worktree: string | null,
): RunHandoff | null {
  if (
    run.endedAt === null ||
    run.reviewId != null ||
    !run.ticket ||
    !run.branch ||
    run.loop?.phase === "done"
  )
    return null;
  const issue = Number(run.ticket.slice(run.ticket.lastIndexOf("#") + 1));
  if (store.board(run.repoId).some((c) => c.issueNumber === issue && c.closed)) return null;
  if (
    store
      .pullRequestsOnTicket(run.repoId, run.ticket)
      .some((p) => p.branch === run.branch && p.state === "merged")
  )
    return null;
  const have = store.handoff(run.id);
  if (have) return have;
  const inherited = store.receivedHandoff(run.id);
  const review = store.reviewsOfRun(run.id).findLast((r) => r.state === "reported");
  const findings = review
    ? store
        .findingsOf(review.id)
        .filter((f) => f.state === "open" && f.resolution == null)
        .slice(0, 50)
        .map((f) => safe(`${f.severity}: ${f.file}:${f.line} — ${f.summary}; ${f.fix}`))
    : [];
  const evidence = store
    .evidenceNotes(run.id)
    .slice(-4)
    .map((e) => safe(e.note));
  const progress = [
    ...(inherited?.done ?? []),
    ...evidence,
    ...(run.summary ? [safe(run.summary)] : []),
  ].slice(-6);
  const phase = run.loop?.phase ?? "building";
  const left = [
    safe(run.loop?.parked?.reason ?? `Unfinished at ${phase}`),
    ...store
      .runDoneWhen(run.id)
      .slice(0, 8)
      .map((s) => safe(`Verify: ${s}`)),
  ];
  const messages = store
    .commsOnTicket(
      run.ticket,
      `#${issue}`,
      run.loop?.prNumber ? [`PR ${run.loop.prNumber}`] : [],
      20,
    )
    .filter((m) => m.ticket === run.ticket || m.ref === run.ticket)
    .slice(0, 6)
    .reverse()
    .map((m) => ({ from: safe(m.from), at: m.at, text: safe(m.text) }));
  const digest = store.digest(run.id);
  const h: RunHandoff = {
    runId: run.id,
    repoId: run.repoId,
    ticket: run.ticket,
    fromSeat: run.agentId,
    at: run.endedAt,
    goal: safe(run.ticketTitle ?? run.ticket),
    done: progress.length ? progress : digest?.lastText ? [safe(digest.lastText)] : [],
    left,
    next: findings.length
      ? "Resolve the open review findings, then report the updated head."
      : run.loop?.parked
        ? "Resolve the recorded stop reason, then continue the ticket."
        : phase === "ci"
          ? "Check CI for this branch and continue from the result."
          : phase === "review"
            ? "Check the latest review before changing the branch."
            : "Inspect the preserved changes and continue the ticket's remaining work.",
    branch: run.branch,
    worktree,
    gitStatus: [],
    gitState: worktree ? "pending" : "unavailable",
    findings,
    messages,
    acceptedBy: null,
    acceptedRunId: null,
  };
  store.recordHandoff(h);
  return h;
}

export async function enrichHandoff(
  store: Store,
  h: RunHandoff,
  checkout: string,
  root: string,
): Promise<void> {
  if (!h.worktree) return;
  try {
    const status = await handoffCheckoutStatus(checkout, h.worktree, h.branch, root);
    store.handoffGit(h.runId, status.slice(0, 100).map(safe), "ready");
  } catch {
    store.handoffGit(h.runId, [], "unavailable");
  }
}

/** Raw branch/path values remain private execution metadata; views and prompts get redacted copies. */
export function publicHandoff(h: RunHandoff): RunHandoff {
  return { ...h, branch: safe(h.branch), worktree: h.worktree === null ? null : safe(h.worktree) };
}

/** Taking over work grants no clearance or acceptance and cannot release an operator's hold. */
export function inheritedHandoffLoop(
  source: RunLoop | null | undefined,
  next: RunLoop | undefined,
): RunLoop | undefined {
  if (!source) return next;
  const loop = { ...(next ?? NEW_LOOP) };
  return {
    ...loop,
    ...(source.controllerCheckRequired ? { controllerCheckRequired: true } : {}),
    ...(source.controllerCheck && !source.controllerCheck.pass
      ? { controllerCheck: { ...source.controllerCheck, from: loop.phase } }
      : {}),
    ...(source.uat && !source.uat.accepted ? { uat: { ...source.uat, from: loop.phase } } : {}),
    ...(source.mergeHold ? { mergeHold: { ...source.mergeHold, from: loop.phase } } : {}),
    ...(source.awaitingFlight ? { awaitingFlight: source.awaitingFlight } : {}),
  };
}
