/** Read-only join of dependency facts. Presentation strings never create graph edges. */
import {
  type DependencyEdge,
  type DependencyWork,
  dependencyChains,
  type FlightPrFlowRow,
  prCarries,
  type Run,
  ticketWaits,
} from "@mc/core";
import { observedWaitSince, readWaitRecord } from "./dependencies.ts";
import { externalMergeHold, externalPrControl } from "./external-pr-control.ts";
import { prFlow } from "./pr-flow.ts";
import type { Store } from "./store.ts";

const WEEK = 7 * 24 * 60 * 60_000;

/** The last recorded transition into the seat queue; older runs may have no such observation. */
function queuedSince(store: Store, run: Run): number | null {
  let since: number | null = null;
  let queued = false;
  for (const attempt of store.runAttempts(run.id)) {
    if (attempt.runId !== run.id || attempt.kind !== "loop") continue;
    const aside = !!attempt.data.aside;
    if (aside && !queued) since = attempt.at;
    if (!aside) since = null;
    queued = aside;
  }
  return since;
}

export function readDependencyChains(store: Store, repoId: string, now: number) {
  const board = store.board(repoId);
  const prs = store.pullRequests(repoId);
  const flow = prFlow(store, repoId, now);
  const runs = store.prFlowRuns(
    repoId,
    prs.filter((p) => p.state === "open"),
  );
  const active = runs.filter((r) => r.endedAt === null);
  const holds = store.activeHolds().filter((h) => h.ref.startsWith(`${repoId}#`));
  const record = readWaitRecord(store, repoId);
  const work = new Map<string, DependencyWork>();
  const edges: DependencyEdge[] = [];
  const ownIssue = (ref: string | null) => {
    if (!ref?.startsWith(`${repoId}#`)) return null;
    const n = Number(ref.slice(repoId.length + 1));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const prRef = (number: number) => {
    const pr = prs.find((p) => p.number === number);
    const named = pr ? ownIssue(pr.ticket) : null;
    const issue = pr?.closingIssues?.length
      ? named !== null && pr.closingIssues.includes(named)
        ? named
        : pr.closingIssues[0]
      : named;
    return issue ? `${repoId}#${issue}` : `PR ${number}`;
  };
  const canonical = (ref: string) => {
    const match = /^PR (\d+)$/.exec(ref);
    return match ? prRef(Number(match[1])) : ref;
  };
  const ensure = (ref: string) => {
    if (!work.has(ref))
      work.set(ref, {
        ref,
        title: null,
        state: "unknown",
        reason: ref.startsWith("PR ") ? `${ref} not read yet` : "Work not read in this repository",
        owner: "—",
        seatId: null,
      });
  };
  const add = (from: string, to: string, kind: DependencyEdge["kind"], since: number | null) => {
    const source = canonical(from);
    const target = canonical(to);
    ensure(source);
    ensure(target);
    edges.push({ from: source, to: target, kind, since });
  };
  const fromFlow = (row: FlightPrFlowRow): DependencyWork => {
    const hold = externalMergeHold(store, repoId, row.pr);
    const pr = prs.find((p) => p.number === row.pr);
    const control = pr?.headSha ? externalPrControl(store, repoId, row.pr, pr.headSha) : null;
    const controller = control?.controllerRequired && !control.controllerPassed;
    const acceptance = control?.uatRequired && !control.uatAccepted;
    const owner = hold
      ? "operator"
      : controller
        ? "controller"
        : acceptance
          ? "operator"
          : row.owner;
    const p90 = flow.metrics
      .find((m) => m.windowMs === WEEK)
      ?.stageTimes.find((s) => s.stage === row.stage)?.p90Ms;
    const late = p90 != null && now - row.stageSince > p90;
    const nobody =
      !hold && !controller && !acceptance && (row.ownerKind === "nobody" || row.owner === "nobody");
    return {
      ref: prRef(row.pr),
      title: row.title,
      state:
        late || nobody
          ? "stuck"
          : owner === "operator" || owner === "controller"
            ? "with-you"
            : "moving",
      reason:
        hold ??
        (controller || acceptance
          ? (control?.note ??
            (controller ? "Waiting for the controller's check" : "Waiting for your acceptance"))
          : nobody
            ? "No owner for the next step"
            : late
              ? `Past ${row.stage} stage p90`
              : (row.waitsOn[0] ?? row.stage)),
      owner,
      seatId: hold || controller || acceptance ? null : (row.seatId ?? null),
    };
  };
  for (const card of board) {
    const ref = `${repoId}#${card.issueNumber}`;
    const run = active.findLast((r) => r.ticket === ref);
    work.set(ref, {
      ref,
      title: card.title,
      state: card.closed || !run ? "stuck" : "moving",
      reason: card.closed
        ? "Closed without merging"
        : run
          ? "Seat is working"
          : "No open PR or running seat",
      owner: run?.agentId ?? "nobody",
      seatId: run?.agentId ?? null,
    });
  }
  for (const pr of prs) {
    if (pr.state !== "closed") continue;
    const ref = prRef(pr.number);
    ensure(ref);
    work.set(ref, {
      ref,
      title: work.get(ref)?.title ?? pr.title,
      state: "stuck",
      reason: "Closed without merging",
      owner: "nobody",
      seatId: null,
    });
  }
  for (const row of flow.rows) {
    const fact = fromFlow(row);
    work.set(fact.ref, { ...fact, title: work.get(fact.ref)?.title ?? fact.title });
  }
  for (const card of board.filter((c) => !c.closed)) {
    const ref = `${repoId}#${card.issueNumber}`;
    for (const wait of ticketWaits({ repoId, card, board, prs })) {
      const n = /^PR (\d+)$/.exec(wait.ref);
      const stacked =
        n &&
        prs.some(
          (p) =>
            p.state === "open" &&
            prCarries(p, repoId, card.issueNumber) &&
            prs.some(
              (base) =>
                base.number === Number(n[1]) && base.state === "open" && base.branch === p.base,
            ),
        );
      // Each outstanding edge owns its observed start, including waits added to an older set.
      const observed = record.waiting[ref];
      add(ref, wait.ref, stacked ? "stacked" : "depends", observedWaitSince(observed, wait.ref));
    }
  }
  for (const pr of prs.filter((p) => p.state === "open")) {
    const underlying = prs.find(
      (p) => p.state === "open" && p.number !== pr.number && p.branch === pr.base,
    );
    if (underlying) {
      const ref = prRef(pr.number);
      const observed = record.waiting[ref];
      const since = observedWaitSince(observed, `PR ${underlying.number}`);
      add(`PR ${pr.number}`, `PR ${underlying.number}`, "stacked", since);
    }
  }
  for (const hold of holds) {
    if (prs.find((p) => p.number === hold.waitsOn)?.state === "merged") continue;
    add(hold.ref, `PR ${hold.waitsOn}`, "held", hold.at);
  }
  for (const run of active.filter((r) => !!r.loop?.aside)) {
    const ahead = active.find(
      (r) => r.id !== run.id && r.agentId === run.agentId && !r.loop?.aside,
    );
    if (!ahead) continue;
    const refOf = (r: Run) => (r.loop?.prNumber != null ? `PR ${r.loop.prNumber}` : r.ticket);
    const from = refOf(run);
    const to = refOf(ahead);
    if (from && to) add(from, to, "queue", queuedSince(store, run));
  }
  return dependencyChains({ repoId, work: [...work.values()], edges, now });
}
