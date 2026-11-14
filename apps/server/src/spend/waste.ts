/**
 * Waste alarms: hub code over recorded runs, check runs and reviews. Each check is scoped to one
 * ticket, run or seat. An alarm never becomes a Needs-you item: FLIGHT is woken once per alarm
 * (the `waste_alarm` signal), and Audit shows it.
 */
import {
  FLIGHT_ACTIVITY_DAYS,
  type FlightDay,
  type Run,
  seatCallSign,
  seatDef,
  unchangedRerunText,
  WASTE_ACTIONS,
  WASTE_CHECK_TITLES,
  WASTE_CHECKS,
  WASTE_FAILED_PARK_KINDS,
  WASTE_SPLIT_TITLE,
  WASTE_THRESHOLDS,
  WASTE_WINDOW_MS,
  WASTE_WINDOWS,
  type WasteAlarm,
  type WasteCheck,
  type WasteCheckRow,
  type WasteCounts,
  type WasteFinding,
  type WasteReport,
  type WasteSpend,
  type WasteWindow,
  wasteResolveHoldMs,
  wasteThresholdText,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";

const HOUR_MS = 3_600_000;
/** How far back the scan reads runs, for ticket and cost totals. */
const SCAN_DAYS = 7;
/** Tickets named in an alarm's evidence, before "and N more". */
const NAMED = 10;

interface AgentInfo {
  loop: string;
  vendor: string;
}

/** Each agent's loop kind and vendor, from the config; an agent it does not list is `other`. */
function agentInfo(config: CcConfig): Map<string, AgentInfo> {
  const out = new Map<string, AgentInfo>();
  const vendorOf = (accountId: string): string =>
    config.accounts.find((a) => a.id === accountId)?.vendor ?? "unknown";
  for (const session of config.crew?.sessions ?? []) {
    for (const seat of session.seats) {
      out.set(seat.id, {
        loop: seatDef(seat).loop,
        vendor: seat.modelVendor ?? vendorOf(seat.accountId),
      });
    }
  }
  for (const loop of config.loops) {
    if (!out.has(loop.id)) out.set(loop.id, { loop: "observed", vendor: vendorOf(loop.accountId) });
  }
  return out;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const named = (xs: readonly string[]): string =>
  xs.length <= NAMED
    ? xs.join(", ")
    : `${xs.slice(0, NAMED).join(", ")} and ${xs.length - NAMED} more`;
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** A run's new tokens: input, output and cache writes (cache reads are the same context read again). */
const runTokens = (r: Run): number =>
  r.tokens === null ? 0 : r.tokens.input + r.tokens.output + r.tokens.cacheCreate;

/** Every alarm the recorded facts raise now. Pure: nothing is written. */
export function wasteScan(config: CcConfig, store: Store, now: number): WasteFinding[] {
  const q = store.waste;
  const t = WASTE_THRESHOLDS;
  const agents = agentInfo(config);
  const out: WasteFinding[] = [];
  const runs = q.runsSince(now - SCAN_DAYS * 24 * HOUR_MS);
  const merged = q.mergedTickets();
  const closed = q.closedTickets();
  const done = (ticket: string): boolean => merged.has(ticket) || closed.has(ticket);

  // Restart storm: one agent started again and again.
  const starts = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.startedAt < now - t.restartStormWindowMs) continue;
    starts.set(r.agentId, [...(starts.get(r.agentId) ?? []), r]);
  }
  for (const [agentId, list] of starts) {
    if (list.length <= t.restartStormStarts) continue;
    out.push({
      check: "restart-storm",
      subject: agentId,
      repoId: list[0]?.repoId ?? null,
      ticket: null,
      seatId: agentId,
      runId: null,
      level: list.length,
      evidence: `${seatCallSign(agentId)} started ${list.length} times in the last hour (the limit is ${t.restartStormStarts}).`,
    });
  }

  // Retry loop: two failed attempts on a ticket, or three carry-on resumes without a report.
  const byTicket = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.ticket === null) continue;
    byTicket.set(r.ticket, [...(byTicket.get(r.ticket) ?? []), r]);
  }
  const failedAttempt = (r: Run): boolean =>
    r.status === "failed" ||
    (r.loop?.parked != null && WASTE_FAILED_PARK_KINDS.includes(r.loop.parked.kind));
  const developer = (r: Run): boolean =>
    r.reviewId === null && agents.get(r.agentId)?.loop === "build";
  const retry = new Map<string, { failed: Run[]; resumed: { runId: string; n: number }[] }>();
  for (const [ticket, list] of byTicket) {
    if (done(ticket)) continue;
    const failed = list.filter((r) => developer(r) && failedAttempt(r));
    if (failed.length >= t.retryFailedAttempts) retry.set(ticket, { failed, resumed: [] });
  }
  for (const r of q.unreportedResumes(now - SCAN_DAYS * 24 * HOUR_MS, t.retryResumes)) {
    if (r.ticket === null || done(r.ticket)) continue;
    const found = retry.get(r.ticket) ?? { failed: [], resumed: [] };
    found.resumed.push({ runId: r.runId, n: r.n });
    retry.set(r.ticket, found);
  }
  for (const [ticket, { failed, resumed }] of retry) {
    const parts = [
      ...(failed.length >= t.retryFailedAttempts
        ? [`${failed.length} failed attempts (${named(failed.map((r) => r.id))})`]
        : []),
      ...resumed.map((x) => `run ${x.runId} resumed ${x.n} times without a report`),
    ];
    out.push({
      check: "retry-loop",
      subject: ticket,
      repoId: ticket.slice(0, ticket.lastIndexOf("#")),
      ticket,
      seatId: null,
      runId: null,
      level: failed.length + resumed.reduce((n, x) => n + x.n, 0),
      evidence: `${ticket} is parked: ${parts.join("; ")}. FLIGHT takes the next ticket.`,
    });
  }

  // Unchanged rerun: the same check on the same commit with no file changed.
  const reruns = new Map<string, WasteFinding>();
  const rerunSince = now - t.eventOpenMs;
  const note = (
    r: {
      runId: string;
      command: string;
      sha: string;
      n: number;
      ticket: string | null;
      repoId: string;
      agentId: string;
    },
    extra: number,
  ) => {
    const subject = `${r.runId}:${r.command}:${r.sha.slice(0, 7)}`;
    const had = reruns.get(subject);
    const level = (had?.level ?? 0) + extra;
    reruns.set(subject, {
      check: "unchanged-rerun",
      subject,
      repoId: r.repoId,
      ticket: r.ticket,
      seatId: r.agentId,
      runId: r.runId,
      level,
      evidence: `${r.command} ran again ${level} time${level === 1 ? "" : "s"} on commit ${r.sha.slice(0, 7)} in run ${r.runId} with no file changed.`,
    });
  };
  for (const r of q.repeatedChecks(rerunSince)) note(r, r.n - 1);
  for (const r of q.refusedReruns(rerunSince)) note(r, r.n);
  out.push(...reruns.values());

  // Review rounds: a change past two rounds.
  for (const r of q.reviewRounds(now - SCAN_DAYS * 24 * HOUR_MS)) {
    // the PR's own state decides; a sibling slice's merge must not hide this change's rounds
    if (r.rounds <= t.reviewRounds) continue;
    if (r.prState === null && r.ticket !== null && done(r.ticket)) continue;
    out.push({
      check: "review-rounds",
      subject: r.runId,
      repoId: r.repoId,
      ticket: r.ticket,
      seatId: r.agentId,
      runId: r.runId,
      level: r.rounds,
      evidence: `PR ${r.pr} (${r.ticket ?? r.runId}) is on review round ${r.rounds}; the limit is ${t.reviewRounds}. Reviews stop until FLIGHT decides: fix or park.`,
    });
  }

  // Failed review rounds: an open PR whose reviews failed twice. Only an alarm: its reviews go on.
  for (const r of q.failedReviewRounds()) {
    if (r.rounds < t.failedReviewRounds) continue;
    const ref = store.pullRequests(r.repoId).find((p) => p.number === r.pr)?.ticket ?? null;
    out.push({
      check: "failed-review-rounds",
      subject: `${r.repoId}#${r.pr}`,
      repoId: r.repoId,
      ticket: ref,
      seatId: null,
      runId: r.runId,
      level: r.rounds,
      evidence: `PR ${r.pr}${ref === null ? "" : ` (${ref})`} has failed ${r.rounds} review rounds (the limit is ${t.failedReviewRounds}).`,
    });
  }

  // Clearance waiting: a hard-rule PR held for FLIGHT's clearance.
  for (const w of q.clearanceWaits()) {
    if (w.since === null || now - w.since < t.clearanceAlarmMs) continue;
    const hours = Math.floor((now - w.since) / HOUR_MS);
    out.push({
      check: "clearance-waiting",
      // per head: resolving one head's alarm must not hold back the next head's
      subject: `${w.runId}@${w.head}`,
      repoId: w.repoId,
      ticket: w.ticket,
      seatId: w.agentId,
      runId: w.runId,
      level: hours,
      evidence: `${w.pr === null ? `Run ${w.runId}` : `PR ${w.pr}`}${w.ticket === null ? "" : ` (${w.ticket})`} has waited ${hours} hours on FLIGHT's clearance.`,
    });
  }

  // Cost without output: a ticket past 3x the median cost of its size, with no merge.
  const sizeCosts = new Map<string, number[]>();
  for (const m of q.mergedTicketCosts(merged)) {
    sizeCosts.set(m.size, [...(sizeCosts.get(m.size) ?? []), m.costUsd]);
  }
  for (const [ticket, list] of byTicket) {
    if (done(ticket)) continue;
    const priced = list.filter((r) => r.costUsd !== null);
    const total = priced.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    const size = q.ticketSize(ticket);
    const samples = size === null ? undefined : sizeCosts.get(size);
    if (size === null || samples === undefined || samples.length < t.costMinSizeSamples) continue;
    const med = median(samples);
    if (med <= 0 || total <= t.costFactor * med) continue;
    out.push({
      check: "cost-without-output",
      subject: ticket,
      repoId: ticket.slice(0, ticket.lastIndexOf("#")),
      ticket,
      seatId: null,
      runId: null,
      level: Math.floor(total / med),
      evidence: `${ticket} (size ${size}) has cost ${usd(total)}, over ${t.costFactor}x the median ${usd(med)} of its size, with no merge. Runs: ${named(priced.map((r) => `${r.id} ${usd(r.costUsd ?? 0)}`))}.`,
    });
  }

  // Runs per ticket: more than three developer runs without a merge.
  for (const [ticket, list] of byTicket) {
    const own = list.filter(developer);
    if (done(ticket) || own.length <= t.runsPerTicket) continue;
    const blocking = q.blockingByRun(own.map((r) => r.id));
    out.push({
      check: "runs-per-ticket",
      subject: ticket,
      repoId: ticket.slice(0, ticket.lastIndexOf("#")),
      ticket,
      seatId: null,
      runId: null,
      level: own.length,
      evidence: `${ticket} has taken ${own.length} runs without a merge (the limit is ${t.runsPerTicket}). Runs and their blocking review findings: ${named(own.map((r) => `${r.id} (${blocking.get(r.id) ?? 0})`))}.`,
    });
  }

  // Coordination overhead: FLIGHT's spend passes the developers' over a day.
  const dayAgo = now - t.coordinationWindowMs;
  let flightUsd = 0;
  let devUsd = 0;
  let flightSeat: string | null = null;
  let flightRepo: string | null = null;
  for (const r of runs) {
    if (r.startedAt < dayAgo || r.costUsd === null) continue;
    const loop = agents.get(r.agentId)?.loop;
    if (loop === "watch") {
      flightUsd += r.costUsd;
      flightSeat = r.agentId;
      flightRepo = r.repoId;
    } else if (loop === "build" && r.reviewId === null) devUsd += r.costUsd;
  }
  if (flightSeat !== null && flightUsd > devUsd && flightUsd >= t.coordinationMinUsd) {
    const controller = q.controllerTokens(dayAgo);
    out.push({
      check: "coordination-overhead",
      subject: flightSeat,
      repoId: flightRepo,
      ticket: null,
      seatId: flightSeat,
      runId: null,
      level: Math.floor(flightUsd),
      evidence: `In the last day ${seatCallSign(flightSeat)} spent ${usd(flightUsd)} and the developers ${usd(devUsd)}.${controller > 0 ? ` The controller used ${controller} tokens (its cost is not recorded, so it is not in the split).` : ""}`,
    });
  }

  // Ticket churn: opened keeps pace with closed, a ticket split into pieces, a parked ticket starts.
  const opened = q.ticketsOpened(now - t.churnWindowMs);
  const closedBy = q.ticketsClosed(now - t.churnWindowMs);
  const openedBy = new Map<string, typeof opened>();
  for (const o of opened) openedBy.set(o.repoId, [...(openedBy.get(o.repoId) ?? []), o]);
  for (const [repoId, list] of openedBy) {
    const closedCount = closedBy.get(repoId) ?? 0;
    if (list.length >= t.churnMinOpened && list.length >= closedCount) {
      out.push({
        check: "ticket-churn",
        subject: `${repoId}:day`,
        repoId,
        ticket: null,
        seatId: null,
        runId: null,
        level: list.length,
        evidence: `In the last day ${list.length} tickets were opened and ${closedCount} closed in ${repoId}, so the board did not shrink. Opened: ${named(list.map((o) => `#${o.n}`))}.`,
      });
    }
    for (const o of list.filter((x) => WASTE_SPLIT_TITLE.test(x.title))) {
      const ref = `${repoId}#${o.n}`;
      out.push({
        check: "ticket-churn",
        subject: `${ref}:split`,
        repoId,
        ticket: ref,
        seatId: null,
        runId: null,
        level: 1,
        evidence: `${ref} reads as a piece of other work ("${o.title}"). Fold it back into its ticket, or explain on the plan ticket why it stands apart.`,
      });
    }
  }
  const parkedBefore = q.alarms(
    "WHERE check_id = 'retry-loop' AND opened_at >= ?",
    now - 7 * 24 * HOUR_MS,
  );
  for (const a of parkedBefore) {
    if (a.ticket === null) continue;
    const startedAfter = (byTicket.get(a.ticket) ?? []).filter(
      (r) => r.startedAt > a.openedAt && developer(r),
    );
    if (startedAfter.length === 0 || done(a.ticket)) continue;
    out.push({
      check: "ticket-churn",
      subject: `${a.ticket}:restarted`,
      repoId: a.repoId,
      ticket: a.ticket,
      seatId: null,
      runId: null,
      level: startedAfter.length,
      evidence: `${a.ticket} was parked by a retry-loop alarm and has started again (${named(startedAfter.map((r) => r.id))}).`,
    });
  }
  return out;
}

/**
 * Brings the stored alarms in step with the scan: opens one per new finding, keeps an open one's
 * evidence current, and closes one whose cause has ended. A finding FLIGHT resolved stays quiet
 * until it grows past the level it was resolved at. Returns whether any alarm changed.
 */
export function syncWasteAlarms(config: CcConfig, store: Store, now: number): boolean {
  const q = store.waste;
  const found = new Map(wasteScan(config, store, now).map((f) => [`${f.check}\0${f.subject}`, f]));
  let changed = false;
  const stored = q.alarms("WHERE closed_at IS NULL AND resolved_at IS NULL");
  for (const a of stored) {
    const f = found.get(`${a.check}\0${a.subject}`);
    if (f === undefined) {
      q.closeAlarm(a.id, now);
      changed = true;
    } else if (f.level !== a.level || f.evidence !== a.evidence) {
      q.updateAlarm(a.id, f.level, f.evidence);
      changed = true;
    }
  }
  const open = new Set(stored.map((a) => `${a.check}\0${a.subject}`));
  for (const [key, f] of found) {
    if (open.has(key)) continue;
    const hold = wasteResolveHoldMs(f.check);
    const resolved = q
      .alarms("WHERE check_id = ? AND subject = ? AND resolved_at IS NOT NULL", f.check, f.subject)
      .filter((a) => hold === null || (a.resolvedAt ?? 0) >= now - hold)
      .reduce((n, a) => Math.max(n, a.level), -1);
    if (f.level <= resolved) continue;
    q.insertAlarm(f, now);
    changed = true;
  }
  return changed;
}

/** The open alarms, newest first. */
export const openWasteAlarms = (store: Store): WasteAlarm[] =>
  store.waste.alarms(
    "WHERE closed_at IS NULL AND resolved_at IS NULL ORDER BY opened_at DESC, id DESC",
  );

/** The evidence of the open alarm of a check on a subject, or null. */
const openEvidence = (store: Store, check: WasteCheck, subject: string): string | null =>
  store.waste.alarms(
    "WHERE check_id = ? AND subject = ? AND closed_at IS NULL AND resolved_at IS NULL LIMIT 1",
    check,
    subject,
  )[0]?.evidence ?? null;

/** Why this seat may not start again (it is in a restart storm), or null. */
export const restartHold = (store: Store, seatId: string): string | null =>
  openEvidence(store, "restart-storm", seatId);

/** Why this ticket is parked (a retry-loop alarm stands), or null. */
export const ticketParked = (store: Store, ticket: string): string | null =>
  openEvidence(store, "retry-loop", ticket);

/**
 * Whether reviews of this author run's change are stopped: it is past its review rounds and FLIGHT
 * has not resolved the alarm at this round. Read live, so a third round never starts in the minute
 * before the next scan.
 */
export function reviewsHeld(store: Store, authorRunId: string): boolean {
  const rounds = store.waste.maxRound(authorRunId);
  if (rounds <= WASTE_THRESHOLDS.reviewRounds) return false;
  const resolved = store.waste
    .alarms(
      "WHERE check_id = 'review-rounds' AND subject = ? AND resolved_at IS NOT NULL",
      authorRunId,
    )
    .reduce((n, a) => Math.max(n, a.level), -1);
  return rounds > resolved;
}

/** The refusal text for an unchanged rerun, and the record of it, for the hook. */
export function refuseRerun(
  store: Store,
  run: { id: string },
  command: string,
  sha: string,
  at: number,
): string {
  store.addRerunRefusal(run.id, command, sha, at);
  return unchangedRerunText(command, sha);
}

/** FLIGHT or the operator closes a hold with a basis; false when the alarm is not open. */
export function resolveWasteAlarm(store: Store, id: number, at: number, basis: string): boolean {
  return store.waste.resolveAlarm(id, at, basis);
}

/** Spend over one window, with each vendor's coverage. A cost is null where no run recorded one. */
function spendFor(config: CcConfig, store: Store, window: WasteWindow, now: number): WasteSpend {
  const since = now - WASTE_WINDOW_MS[window];
  const agents = agentInfo(config);
  const runs = store.waste.runsSince(since);
  const mergedCount = store.waste.mergedBetween(since, now).length;
  const vendors = new Map<
    string,
    { vendor: string; runs: number; runsWithCost: number; costUsd: number | null; tokens: number }
  >();
  let costUsd: number | null = null;
  let buildCost = 0;
  let tokens = 0;
  let buildTokens = 0;
  let withCost = 0;
  for (const r of runs) {
    const info = agents.get(r.agentId);
    const vendor = info?.vendor ?? "unknown";
    const v = vendors.get(vendor) ?? { vendor, runs: 0, runsWithCost: 0, costUsd: null, tokens: 0 };
    v.runs += 1;
    const tk = runTokens(r);
    v.tokens += tk;
    tokens += tk;
    const build = info?.loop === "build";
    if (build) buildTokens += tk;
    if (r.costUsd !== null) {
      v.runsWithCost += 1;
      v.costUsd = (v.costUsd ?? 0) + r.costUsd;
      costUsd = (costUsd ?? 0) + r.costUsd;
      withCost += 1;
      if (build) buildCost += r.costUsd;
    }
    vendors.set(vendor, v);
  }
  return {
    window,
    since,
    merged: mergedCount,
    costUsd,
    runs: runs.length,
    runsWithCost: withCost,
    tokens,
    perMergeUsd: costUsd === null || mergedCount === 0 ? null : costUsd / mergedCount,
    perMergeTokens: mergedCount === 0 ? null : tokens / mergedCount,
    buildingShareUsd: costUsd === null || costUsd === 0 ? null : buildCost / costUsd,
    buildingShareTokens: tokens === 0 ? null : buildTokens / tokens,
    vendors: [...vendors.values()].sort((a, b) => a.vendor.localeCompare(b.vendor)),
  };
}

/** What GET /waste serves: spend per merged change, the building share, open alarms and each check's record. */
export function wasteReport(config: CcConfig, store: Store, now: number): WasteReport {
  const week = store.waste.alarms("WHERE opened_at >= ?", now - WASTE_WINDOW_MS.week);
  const merged = store.waste.mergedTickets();
  const checks: WasteCheckRow[] = WASTE_CHECKS.map((check) => {
    const mine = week.filter((a) => a.check === check);
    const withTicket = mine.filter((a) => a.ticket !== null);
    return {
      check,
      title: WASTE_CHECK_TITLES[check],
      threshold: wasteThresholdText(check),
      action: WASTE_ACTIONS[check],
      fired: mine.length,
      withTicket: withTicket.length,
      progressAfter: withTicket.filter((a) => (merged.get(a.ticket ?? "") ?? 0) > a.openedAt)
        .length,
    };
  });
  return {
    at: now,
    spend: WASTE_WINDOWS.map((w) => spendFor(config, store, w, now)),
    // a clearance wait shows here from a day; before that it only wakes FLIGHT
    alarms: openWasteAlarms(store).filter(
      (a) =>
        a.check !== "clearance-waiting" || a.level * HOUR_MS >= WASTE_THRESHOLDS.clearanceAuditMs,
    ),
    checks,
    flight: flightActivity(config, store, now),
    counts: latestCounts(config, store),
  };
}

/** The latest daily retrospective's counts, or null before the first. */
function latestCounts(config: CcConfig, store: Store): WasteCounts | null {
  for (const repoId of new Set(config.crew?.sessions.map((s) => s.repoId))) {
    const report = store.retrospectives(repoId)[0] as { counts?: WasteCounts } | undefined;
    if (report?.counts !== undefined) return report.counts;
  }
  return null;
}

/** The retrospective's counts over [since, now]: tickets, runs per ticket, review rounds, idle seat-hours. */
export function wasteCounts(
  config: CcConfig,
  store: Store,
  repoId: string,
  day: string,
  since: number,
  now: number,
): WasteCounts {
  const q = store.waste;
  const opened = q.ticketsOpened(since).filter((o) => o.repoId === repoId).length;
  const closed = q.ticketsClosed(since).get(repoId) ?? 0;
  const perTicket = new Map<string, number>();
  for (const r of q.runsSince(since))
    if (r.repoId === repoId && r.ticket !== null && r.reviewId === null)
      perTicket.set(r.ticket, (perTicket.get(r.ticket) ?? 0) + 1);
  const busiest = [...perTicket].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const reviews = store.reviewsIn(["reported"], { repo: repoId, since, until: now });
  const failed = reviews.filter(
    (r) => r.blocking > 0 || r.verdict?.spec === "fail" || r.verdict?.quality === "fail",
  ).length;
  const seats = new Set(config.crew?.sessions.flatMap((s) => s.seats.map((x) => x.id)));
  const spans = new Map<string, { state: string; at: number }>();
  let idleMs = 0;
  const close = (id: string, until: number) => {
    const open = spans.get(id);
    if (open?.state === "idle") idleMs += Math.max(0, until - open.at);
  };
  // each seat starts the window in the state it was last left in, so a quiet seat still counts
  const before = q.agentStatesBefore(since);
  for (const id of seats) {
    const state = before.get(id) ?? store.seatSession(id)?.state;
    if (state !== undefined) spans.set(id, { state, at: since });
  }
  for (const e of store.agentEvents(since)) {
    if (!seats.has(e.agentId) || e.at > now) continue;
    if (!spans.has(e.agentId)) spans.set(e.agentId, { state: e.from, at: since });
    close(e.agentId, e.at);
    spans.set(e.agentId, { state: e.to, at: e.at });
  }
  for (const id of spans.keys()) close(id, now);
  return {
    day,
    at: now,
    since,
    ticketsOpened: opened,
    ticketsClosed: closed,
    ticketsWithRuns: perTicket.size,
    runsPerTicket: {
      mean:
        perTicket.size === 0
          ? null
          : [...perTicket.values()].reduce((n, x) => n + x, 0) / perTicket.size,
      max: busiest?.[1] ?? null,
      maxTicket: busiest?.[0] ?? null,
    },
    reviewRounds: { reported: reviews.length, failed },
    idleSeatHours: idleMs / HOUR_MS,
  };
}

/** FLIGHT's wakes, waits and token share in each of the last FLIGHT_ACTIVITY_DAYS 24-hour buckets. */
function flightActivity(config: CcConfig, store: Store, now: number): FlightDay[] {
  const since = now - FLIGHT_ACTIVITY_DAYS * 24 * HOUR_MS;
  const agents = agentInfo(config);
  const days: FlightDay[] = Array.from({ length: FLIGHT_ACTIVITY_DAYS }, (_, i) => ({
    since: since + i * 24 * HOUR_MS,
    wakes: 0,
    waits: 0,
    flightTokens: 0,
    totalTokens: 0,
    tokenShare: null,
  }));
  const bucket = (at: number): FlightDay | undefined =>
    at > now
      ? undefined
      : days[Math.min(FLIGHT_ACTIVITY_DAYS - 1, Math.floor((at - since) / (24 * HOUR_MS)))];
  for (const w of store.flightWakes(since)) {
    const d = bucket(w.at);
    if (d !== undefined) d.wakes += 1;
  }
  for (const at of store.flightWaitTimes(since)) {
    const d = bucket(at);
    if (d !== undefined) d.waits += 1;
  }
  for (const r of store.waste.runsSince(since)) {
    const d = bucket(r.startedAt);
    if (d === undefined) continue;
    const tk = runTokens(r);
    d.totalTokens += tk;
    if (agents.get(r.agentId)?.loop === "watch") d.flightTokens += tk;
  }
  for (const d of days) d.tokenShare = d.totalTokens === 0 ? null : d.flightTokens / d.totalTokens;
  return days;
}
