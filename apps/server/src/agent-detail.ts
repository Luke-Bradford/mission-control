import {
  type AgentDetailView,
  type AttentionItem,
  type CrewRow,
  carriedFrom,
  type EvidenceManifest,
  evidenceImageName,
  HUD_STATE_LABEL,
  type PullRequestView,
  type RunLoopView,
  reviewFor,
} from "@mc/core";
import { cleanText } from "./clean.ts";
import type { Store } from "./store.ts";

const safe = (text: string | null | undefined) => (text ? cleanText(text).trim() || null : null);
/** Presentation only. A saved report is not a test verdict, and no control or hold is changed here. */
export function agentDetail({
  row,
  store,
  loop,
  items,
  github,
  manifest,
}: {
  row: CrewRow;
  store: Store;
  loop: RunLoopView | null;
  items: AttentionItem[];
  github: (repoId: string) => string | null;
  manifest?: (pr: PullRequestView) => EvidenceManifest | null;
}): AgentDetailView {
  const run = row.run ? store.run(row.run.id) : null,
    digest = row.digest;
  const subjectRepo = run ? (store.reviewOfRun(run.id)?.repoId ?? row.repoId) : row.repoId;
  const saved = new Map(row.prs.map((pr) => [`${pr.repoId}:${pr.number}`, pr]));
  const prs = [...new Set([subjectRepo, ...row.prs.map((pr) => pr.repoId)])]
    .flatMap((repoId) => store.pullRequests(repoId))
    .filter(
      (pr) =>
        saved.has(`${pr.repoId}:${pr.number}`) ||
        (pr.repoId === subjectRepo &&
          (row.reviewing?.prNumber === pr.number ||
            (run?.loop?.prNumber === pr.number && pr.ticket === run.ticket))),
    );
  const byTool = digest
    ? Object.entries(digest.tools)
        .map(([name, value]) => ({ name, calls: value.calls, failed: value.failed }))
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    : [];
  const failed = digest ? byTool.reduce((n, t) => n + t.failed, 0) : null;
  const reviews = run ? store.reviewsOfRun(run.id) : [];
  const subjectPr = prs.find(
    (pr) =>
      pr.repoId === subjectRepo && pr.number === (run?.loop?.prNumber ?? row.review?.prNumber),
  );
  const head = subjectPr?.headSha ?? store.runPush(run?.id ?? "")?.sha;
  const latest =
    head && run?.loop && subjectPr?.state === "open"
      ? reviewFor(
          reviews.filter(
            (review) => review.repoId === subjectRepo && review.prNumber === subjectPr.number,
          ),
          run.loop.epoch,
          head,
          carriedFrom(run.loop.carry, run.loop.reviewWaivedSha, head),
        )
      : null;
  const blocking =
    run?.loop?.reviewWaivedSha === head
      ? null
      : latest?.state === "reported"
        ? latest.blocking
        : null;
  const evidence = run ? store.latestEvidence(run.id) : null;
  const original = run
    ? store.runDoneWhen(run.id).map((text, index) => ({ line: index + 1, text: safe(text) ?? "" }))
    : [];
  const next = items
    .filter(
      (item) =>
        item.agentId === row.id &&
        (item.escalationId !== null || item.ticket === null || item.ticket === row.ticket),
    )
    .sort(
      (a, b) => (a.owner === "operator" ? 0 : 1) - (b.owner === "operator" ? 0 : 1) || a.at - b.at,
    )[0];
  let label = HUD_STATE_LABEL[row.hudState],
    reason = safe(row.note ?? row.sourceError);
  const stopped = store.seatSession(row.id)?.stop;
  if (row.crewPause) {
    label = "Crew paused";
    reason = safe(row.crewPause.reason);
  } else if (row.hudState === "stopped") {
    label = "Stopped";
    reason = safe(stopped?.reason ?? row.note);
  } else if (row.hudState === "error") {
    label = "Error";
    reason = safe(row.sourceError ?? row.note);
  } else if (row.loop?.phase === "parked") {
    label = "Parked";
    reason = safe(loop?.loop?.parked?.reason ?? row.loop.parked ?? row.note);
    if (loop?.loop?.parked?.kind === "review" && loop.round !== null)
      reason = `Review round ${loop.round}${loop.limits ? ` of ${loop.limits.rounds}` : ""}${reason ? `: ${reason}` : ""}`;
  } else if (row.reviewing) {
    label = "Checking";
    reason = `PR #${row.reviewing.prNumber}`;
  } else if (row.hudState === "waiting") {
    reason = reason ?? "Waiting for the test lock";
  } else if (next?.kind === "question" && run?.endedAt === null) {
    label = "Waiting";
    reason = safe(next.text);
  }
  if (
    !row.crewPause &&
    !["stopped", "error", "blocked", "stalled", "waiting"].includes(row.hudState) &&
    row.loop &&
    row.loop.phase !== "parked" &&
    !row.reviewing
  ) {
    const waits = {
      ci: "Waiting on CI",
      retro: "Waiting on RETRO",
      main: "Waiting for main",
      operator: "Waiting on you",
      lock: "Waiting for the test lock",
      seat: "Waiting for a seat",
    };
    if (row.loop.wait) {
      label = waits[row.loop.wait];
      reason = safe(row.loop.waitText) ?? reason;
    } else if (row.loop.phase === "ci") label = "CI";
    else if (row.loop.phase === "review") label = "Review";
  }
  const usd = row.run?.costEstimateUsd ?? row.run?.costUsd ?? null,
    turns = digest?.turns ?? null;
  const tokens = digest?.contextTokens ?? null,
    window = digest?.contextWindow ?? null;
  const deliverables: AgentDetailView["deliverables"] = [];
  for (const pr of row.prs.filter(
    (pr) => !prs.some((known) => known.repoId === pr.repoId && known.number === pr.number),
  ))
    deliverables.push({
      id: `pr:${pr.repoId}:${pr.number}`,
      kind: "pr",
      label: `PR #${pr.number} · ${safe(pr.title) ?? "Details not cached"}`,
      href: pr.url,
    });
  for (const pr of prs) {
    deliverables.push({
      id: `pr:${pr.repoId}:${pr.number}`,
      kind: "pr",
      label: `PR #${pr.number} · ${safe(pr.title) ?? pr.state}`,
      href: pr.url,
    });
    const shots = manifest?.(pr);
    if (shots)
      for (const pair of shots.pairs)
        for (const kind of ["before", "after"] as const) {
          const name = evidenceImageName(pair.page, pair.scheme, kind);
          deliverables.push({
            id: `shot:${pr.number}:${shots.sha}:${name}`,
            kind: "screenshot",
            label: `${pair.page} · ${pair.scheme} · ${kind}`,
            href: `/api/prs/${pr.number}/evidence/${shots.sha}/${name}?repo=${encodeURIComponent(pr.repoId)}`,
          });
        }
    const slug = github(pr.repoId);
    if (slug && pr.headSha)
      for (const path of store.prFilePaths(pr.repoId, pr.number).slice(0, 500))
        deliverables.push({
          id: `file:${pr.repoId}:${pr.number}:${path}`,
          kind: "file",
          label: safe(path) ?? "File",
          href: `https://github.com/${slug}/blob/${encodeURIComponent(pr.headSha)}/${path.split("/").map(encodeURIComponent).join("/")}`,
        });
  }
  const related: AgentDetailView["related"] = reviews.map((review) => ({
    id: `review:${review.id}`,
    kind: "review",
    title: `${safe(review.seatId) ?? "Review"} · round ${review.round}`,
    status: review.state,
    href:
      review.runId && review.seatId
        ? `/agent/${encodeURIComponent(review.seatId)}?trace=${encodeURIComponent(review.runId)}`
        : null,
    detail:
      review.state === "reported"
        ? `${review.blocking ?? 0} blocking · ${review.minor ?? 0} minor`
        : null,
  }));
  for (const sub of digest?.subagents ?? [])
    related.push({
      id: `sub:${sub.taskId}`,
      kind: "subagent",
      title: `${sub.type} · ${safe(sub.description) ?? sub.taskId}`,
      status: sub.status,
      href: null,
      detail: `${sub.tokens ?? "—"} tokens · ${sub.toolUses ?? "—"} tool calls`,
    });
  for (const aside of row.asideRuns ?? [])
    related.push({
      id: `aside:${aside.runId}`,
      kind: "aside",
      title: safe(aside.ticketTitle ?? aside.ticket ?? aside.runId) ?? "Set-aside run",
      status: "Set aside",
      href: `/agent/${encodeURIComponent(row.id)}?trace=${encodeURIComponent(aside.runId)}`,
      detail: safe(aside.loop.parked),
    });
  for (const file of evidence?.testsAdded ?? [])
    if (!deliverables.some((item) => item.id === `file:${file.file}`))
      deliverables.push({
        id: `file:${file.file}`,
        kind: "file",
        label: safe(file.file) ?? "File",
        href: `/agent/${encodeURIComponent(row.id)}?side=files&path=${encodeURIComponent(file.file)}`,
      });
  const phases = ["working", "ci", "review", "done"];
  const activePhase = row.loop?.phase === "parked" ? loop?.tries.at(-1)?.step : row.loop?.phase;
  const active = activePhase ? phases.indexOf(activePhase) : -1;
  const definitions = row.loop?.steps?.length
    ? row.loop.steps
    : [
        { name: "Build", phase: "working" },
        { name: "Checks", phase: "ci" },
        { name: "Review", phase: "review" },
        { name: "Done", phase: "done" },
      ];
  const steps: AgentDetailView["steps"] = row.loop
    ? definitions.map((step, index) => {
        const attempts = loop?.tries.filter((attempt) => attempt.step === step.phase) ?? [];
        const last = attempts.at(-1);
        const at = step.phase ? phases.indexOf(step.phase) : -1;
        const current = active >= 0 && at === active;
        const done =
          (at >= 0 && (row.loop?.phase === "done" || (active >= 0 && at < active))) ||
          (step.phase === null &&
            ((step.name === "plan" && row.loop?.planned === true) ||
              (step.name === "draft PR" && row.loop?.prNumber !== null)));
        const state = done
          ? "done"
          : current
            ? row.loop?.phase === "parked" ||
              ["stalled", "blocked", "waiting", "stopped"].includes(row.hudState)
              ? "held"
              : "current"
            : at < 0
              ? "unknown"
              : "todo";
        const finished = attempts.filter((attempt) => attempt.endedAt !== null);
        return {
          id: `${index}:${step.name}`,
          label: step.name,
          state,
          tries:
            step.phase === "review"
              ? current
                ? (loop?.round ?? null)
                : attempts.length
                  ? Math.max(...attempts.map((a) => a.n))
                  : null
              : attempts.length
                ? attempts.filter((attempt) => !attempt.fix).length
                : current
                  ? (row.loop?.tries?.runs ?? row.loop?.tries?.n ?? null)
                  : null,
          failures: step.phase === "ci" ? (run?.loop?.ciFails ?? null) : null,
          limit:
            step.phase === "review"
              ? (loop?.limits?.rounds ?? null)
              : step.phase === "ci"
                ? (loop?.limits?.tries ?? null)
                : null,
          durationMs: finished.length
            ? finished.reduce(
                (n, attempt) => n + Math.max(0, (attempt.endedAt as number) - attempt.startedAt),
                0,
              )
            : null,
          since: current ? (last?.startedAt ?? row.stateSince) : null,
          reason: current ? safe(last?.reason ?? reason) : null,
        };
      })
    : [];
  const unique = [...new Map(deliverables.map((item) => [item.id, item])).values()];
  return {
    row,
    awaiting: { label, reason, since: row.stateSince > 0 ? row.stateSince : null },
    health: {
      label:
        row.hudState === "error"
          ? "Error"
          : row.loop?.phase === "parked"
            ? "Held"
            : row.hudState === "stalled"
              ? "Stalled"
              : blocking !== null && blocking > 0
                ? "Review findings"
                : row.run === null
                  ? "Ready for work"
                  : label,
      blocking,
      failedTools: failed,
    },
    tools: {
      total: digest
        ? byTool.length
          ? byTool.reduce((n, tool) => n + tool.calls, 0)
          : digest.toolCalls
        : null,
      failed,
      byTool,
    },
    cost: {
      totalUsd: usd,
      meanPerReportedTurnUsd: usd !== null && turns !== null && turns > 0 ? usd / turns : null,
      turns,
      estimated: row.run?.costEstimateUsd != null,
    },
    context: {
      tokens,
      window,
      percent: tokens !== null && window !== null && window > 0 ? (tokens / window) * 100 : null,
      compactions: digest?.compactions ?? null,
      prompt: run ? store.latestPromptWake(run.id) : null,
    },
    story: {
      title: safe(row.ticketTitle),
      ticketHref:
        row.ticket && /^(.+)#(\d+)$/.test(row.ticket)
          ? `/tickets/${encodeURIComponent(row.ticket.replace(/#\d+$/, ""))}/${row.ticket.split("#").at(-1)}`
          : null,
      original,
      report: safe(evidence?.note ?? row.summary),
      reportedAt: evidence?.at ?? null,
      doneWhen:
        evidence?.doneWhen.map((entry) => ({
          ...entry,
          text: safe(entry.text) ?? "",
          evidence: safe(entry.evidence) ?? "",
        })) ?? [],
      left:
        evidence?.doneWhen
          .filter((item) => item.status === "not_met")
          .map((item) => safe(item.evidence) ?? safe(item.text) ?? "") ?? [],
    },
    nextMove: next
      ? {
          owner: next.owner ?? "operator",
          text: safe(next.text) ?? "Open the current item.",
          recommendation: safe(next.brief?.recommendation),
          label: next.owner === "operator" ? "Open decision" : "Open conversation",
          href: `/comms/${encodeURIComponent(next.key)}`,
        }
      : null,
    deliverables: unique,
    related,
    steps,
  };
}
