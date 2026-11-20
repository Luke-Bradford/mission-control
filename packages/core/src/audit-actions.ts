/**
 * The Audit page's "Do next" list: each cause the hub already measures, as one row with a number
 * now, a target, who decides and the evidence in one line. Pure: the page passes what
 * `/api/audit` and `/api/waste` returned. No proposal is stored, so a row has no lifecycle.
 */

import {
  AUDIT_PR_OUTLIER_LINES,
  AUDIT_REFUSAL_SPIKE,
  AUDIT_REWORK_ROUNDS,
  AUDIT_SPEND_OUTLIER_FACTOR,
  type AuditImprovementKind,
  type AuditView,
} from "./audit.ts";
import { GUARD_RULES } from "./guard.ts";
import {
  WASTE_CHECK_TITLES,
  WASTE_THRESHOLDS,
  type WasteAlarm,
  type WasteCheck,
  wasteThresholdText,
} from "./waste.ts";

/** Who decides what to do about a row: FLIGHT, or the operator ("You"). */
export type AuditDecider = "FLIGHT" | "You";

/** Where a row's figure comes from, for its source column. */
export type AuditActionSource =
  | "Waste"
  | "Runs"
  | "Reviews"
  | "Guards"
  | "Spend"
  | "Merges"
  | "Messages"
  | "CI";

export interface AuditAction {
  /** Stable per cause: the same cause keeps its id between reads. */
  id: string;
  /** 1 for the first; set after ranking. */
  rank: number;
  source: AuditActionSource;
  /** The specific change, as one line. */
  title: string;
  /** The evidence in one line. */
  why: string;
  measure: {
    label: string;
    now: number;
    /** True when the server cut the list, so `now` is a floor. */
    atLeast: boolean;
    target: number;
    unit: string;
    /** What the target comes from, in words. */
    targetSource: string;
  };
  decider: AuditDecider;
  /** Why that decider, in a few words. */
  deciderNote: string;
  /** More lines of evidence, for the row's detail; at most `DETAIL_LINES`. */
  evidence: string[];
  /** What the figure does not prove. */
  caveat: string;
  /** Where to look: a seat and, when known, its run. */
  links: { label: string; agentId: string; runId: string | null }[];
}

export interface AuditVerdict {
  /** Rows in the list. */
  count: number;
  /** Rows only the operator decides, and rows FLIGHT decides. */
  you: number;
  flight: number;
  /** The first row's title; null when there are no rows. */
  first: string | null;
}

const DETAIL_LINES = 5;
const HOUR_MS = 3_600_000;

const hours = (ms: number): string => `${(ms / HOUR_MS).toFixed(1)} h`;
const times = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A run id: its seat, then its start as `YYYYMMDDThhmmssZ`. */
const RUN_ID = /([a-z][\w-]*):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}Z/;

/** Text with each run id as "seat run of 17 Nov 10:22 UTC" and each commit after `@` as a short sha. */
export const plainIds = (text: string): string =>
  text
    .replace(new RegExp(RUN_ID.source, "g"), (_m, seat, _y, mo, d, h, mi) => {
      return `${seat} run of ${Number(d)} ${MONTHS[Number(mo) - 1] ?? mo} ${h}:${mi} UTC`;
    })
    .replace(/@([0-9a-f]{7,40})\b/g, (_m, sha: string) => ` at commit ${sha.slice(0, 7)}`);

/** A guard rule as the Guard drawer words it; a rule no longer listed shows as stored. */
const ruleText = (rule: string): string =>
  Object.hasOwn(GUARD_RULES, rule) ? GUARD_RULES[rule as keyof typeof GUARD_RULES] : rule;

/** The change each waste check asks for. */
const WASTE_ACTION_TITLES: Record<WasteCheck, string> = {
  "unchanged-rerun": "Stop rerunning checks on a commit that has not changed",
  "retry-loop": "Fix what makes a ticket fail again and again",
  "review-rounds": "Settle the changes held past the review-round limit",
  "restart-storm": "Find why a seat restarts over and over",
  "cost-without-output": "Look at the tickets that spend without a merge",
  "coordination-overhead": "Cut FLIGHT's spend where it passes the developers'",
  "ticket-churn": "Slow the churn of opened and split tickets",
  "runs-per-ticket": "Find why a ticket needs this many runs",
  "failed-review-rounds": "Fix the open PRs that keep failing review",
  "clearance-waiting": "Clear the hard-rule PRs waiting on FLIGHT",
};

/** One alarm's cause as a figure: what is measured, its value now, and the highest value that raises no alarm. */
interface WasteCause {
  /** Alarms with the same key share one metric and threshold, so only they are grouped. */
  key: string;
  label: string;
  now: number;
  target: number;
  unit: string;
  window: string;
  /** How alarms of one key combine: the worst of them, or how many there are. */
  combine: "max" | "count";
}

const exact = (text: string, re: RegExp): number | null => {
  const m = re.exec(text);
  return m?.[1] === undefined ? null : Number(m[1]);
};

/** The causes one alarm stands for; an alarm can name more than one (failed attempts and resumes). */
function wasteCauses(check: WasteCheck, a: WasteAlarm): WasteCause[] {
  const t = WASTE_THRESHOLDS;
  const c = (
    key: string,
    label: string,
    now: number,
    target: number,
    unit: string,
    window = "open alarms now",
    combine: WasteCause["combine"] = "max",
  ): WasteCause => ({ key, label, now, target, unit, window, combine });
  switch (check) {
    case "unchanged-rerun":
      return [c("rerun", "Most reruns of one check on one commit", a.level, 0, "reruns")];
    case "retry-loop": {
      const failed = exact(a.evidence, /(\d+) failed attempts/);
      const resumed = [...a.evidence.matchAll(/resumed (\d+) times/g)].map((m) => Number(m[1]));
      const out: WasteCause[] = [];
      if (failed !== null)
        out.push(
          c(
            "failed",
            "Most failed attempts on one ticket",
            failed,
            t.retryFailedAttempts - 1,
            "failed attempts",
          ),
        );
      if (resumed.length > 0)
        out.push(
          c(
            "resumed",
            "Most carry-on resumes of one run without a report",
            Math.max(...resumed),
            t.retryResumes - 1,
            "resumes",
          ),
        );
      return out.length > 0
        ? out
        : [
            c(
              "failed",
              "Most failed attempts on one ticket",
              a.level,
              t.retryFailedAttempts - 1,
              "failed attempts",
            ),
          ];
    }
    case "review-rounds":
      return [c("rounds", "Most review rounds on one change", a.level, t.reviewRounds, "rounds")];
    case "restart-storm":
      return [
        c(
          "starts",
          "Most starts of one seat in an hour",
          a.level,
          t.restartStormStarts,
          "starts in an hour",
          "the last hour",
        ),
      ];
    case "cost-without-output":
      return [
        c(
          "cost",
          "Highest cost against the median of its size, no merge",
          a.level,
          t.costFactor,
          "× median cost",
        ),
      ];
    case "coordination-overhead": {
      const dev = exact(a.evidence, /developers \$(\d+(?:\.\d+)?)/);
      return [
        c(
          "flight-usd",
          "FLIGHT spend in the last day",
          a.level,
          dev === null ? t.coordinationMinUsd : Math.floor(dev),
          "dollars",
          "the last day, against the developers' spend",
        ),
      ];
    }
    case "ticket-churn": {
      const opened = /(\d+) tickets were opened and (\d+) closed/.exec(a.evidence);
      if (opened)
        return [
          c(
            "day",
            "Tickets opened in a day, in the busiest repo",
            Number(opened[1]),
            Math.max(t.churnMinOpened - 1, Number(opened[2]) - 1),
            "tickets opened",
            "the last day",
          ),
        ];
      if (a.subject.endsWith(":restarted"))
        return [
          c(
            "restarted",
            "Runs started on a ticket parked by a retry loop",
            a.level,
            0,
            "runs",
            "since the alarm opened",
          ),
        ];
      return [
        c(
          "split",
          "Tickets that read as a piece of other work",
          1,
          0,
          "tickets",
          "the last day",
          "count",
        ),
      ];
    }
    case "runs-per-ticket":
      return [c("runs", "Most runs on one open ticket", a.level, t.runsPerTicket, "runs")];
    case "failed-review-rounds":
      return [
        c(
          "failed-rounds",
          "Most failed review rounds on one open PR",
          a.level,
          t.failedReviewRounds - 1,
          "failed rounds",
        ),
      ];
    case "clearance-waiting":
      return [
        c(
          "clearance",
          "Longest wait on FLIGHT's clearance",
          a.level,
          t.clearanceAlarmMs / HOUR_MS - 1,
          "hours",
        ),
      ];
  }
}

/**
 * A waste check's measure. Alarms are grouped by the metric and threshold they share; the row shows
 * the first metric present (in the order the check names them) and every other metric as its own
 * "label: now → target unit" line, so a mixed row never puts one cause's figure against another's limit.
 */
function wasteMeasure(
  check: WasteCheck,
  rows: readonly WasteAlarm[],
): { measure: AuditAction["measure"]; other: string[] } {
  const groups = new Map<string, WasteCause>();
  for (const a of rows) {
    for (const cause of wasteCauses(check, a)) {
      const had = groups.get(cause.key);
      groups.set(
        cause.key,
        had === undefined
          ? cause
          : {
              ...had,
              now: cause.combine === "count" ? had.now + cause.now : Math.max(had.now, cause.now),
            },
      );
    }
  }
  const [first, ...rest] = [...groups.values()];
  const limit = wasteThresholdText(check);
  const source = (c: WasteCause) =>
    `highest value that raises no alarm, from the limit: ${limit}; ${c.window}`;
  const head = first as WasteCause;
  return {
    measure: {
      label: head.label,
      now: head.now,
      atLeast: false,
      target: head.target,
      unit: head.unit,
      targetSource: source(head),
    },
    other: rest.map((c) => `${c.label}: ${c.now} → ${c.target} ${c.unit} (${source(c)})`),
  };
}

/** The change each message problem asks for; kinds not listed are not rows. */
const IMPROVEMENT_TITLES: Partial<Record<AuditImprovementKind, string>> = {
  "question-asked-back": "Answer a seat's question without asking it back",
  "question-waited": "Answer seats' questions before they wait for hours",
  "delivered-after-run-ended": "Stop sending messages to runs that have ended",
  "repeat-message": "Stop seats sending the same message twice",
  "repeat-notice": "Stop the hub repeating one notice on a PR",
  "controller-request-waited": "Answer the controller's requests sooner",
  "ticket-message-volume": "Trim the tickets that carry far more message text than usual",
};

/** The order rows rank in: spend alarms, then stuck runs, then review, guards, spend, merges, messages. */
const GROUP_ORDER = [
  "waste",
  "long-runners",
  "death-loops",
  "rework",
  "refusals",
  "refusal-spikes",
  "spend",
  "pr-size",
  "chatter",
  "questions",
  "improvements",
  "flakes",
] as const;
type Group = (typeof GROUP_ORDER)[number];

interface Draft extends Omit<AuditAction, "rank"> {
  group: Group;
}

/**
 * The ranked actions. `excluded` is the seats and loops the page does not hold to account (observed
 * loops, FLIGHT's watch seat); rows about them are left out. Ranking is by group, then by how many
 * instances the cause has, so equal causes keep a stable order.
 */
export function auditActions(
  audit: AuditView,
  alarms: readonly WasteAlarm[],
  excluded: ReadonlySet<string>,
): AuditAction[] {
  const keep = <T extends { agentId: string | null }>(rows: T[]) =>
    rows.filter((r) => r.agentId !== null && !excluded.has(r.agentId));
  const capped = (name: string): boolean => audit.capped?.[name] !== undefined;
  const drafts: Draft[] = [];
  const add = (d: Draft): void => {
    drafts.push(d);
  };

  // Open waste alarms: one row per check, never one per ticket.
  const open = alarms.filter((a) => a.closedAt === null && a.resolvedAt === null);
  for (const check of Object.keys(WASTE_CHECK_TITLES) as WasteCheck[]) {
    const rows = open.filter((a) => a.check === check);
    if (rows.length === 0) continue;
    const waste = wasteMeasure(check, rows);
    add({
      group: "waste",
      id: `waste:${check}`,
      source: "Waste",
      title: WASTE_ACTION_TITLES[check],
      why: `${times(rows.length, "open alarm")}: ${plainIds(rows[0]?.evidence ?? "")}`,
      measure: waste.measure,
      decider: "FLIGHT",
      deciderNote: "the alarm waits on FLIGHT or the operator",
      evidence: [
        ...waste.other,
        ...rows
          .slice(0, DETAIL_LINES)
          .map((a) => `${plainIds(a.subject)}: ${plainIds(a.evidence)}`),
      ].slice(0, DETAIL_LINES),
      caveat: "An alarm marks spend that bought no progress; it does not say the work was wrong.",
      links: rows.slice(0, DETAIL_LINES).flatMap((a) => {
        const run = RUN_ID.exec(`${a.runId ?? ""} ${a.subject} ${a.evidence}`);
        const seat = a.seatId ?? run?.[1] ?? null;
        return seat === null
          ? []
          : [{ label: plainIds(a.subject), agentId: seat, runId: a.runId ?? run?.[0] ?? null }];
      }),
    });
  }

  const link = (r: { agentId: string | null; runId?: string | null }, label: string) =>
    r.agentId ? [{ label, agentId: r.agentId, runId: r.runId ?? null }] : [];

  const longRunners = keep(audit.longRunners.filter((r) => r.actionable !== false));
  if (longRunners.length > 0) {
    const sorted = [...longRunners].sort((a, b) => b.durationMs - a.durationMs);
    add({
      group: "long-runners",
      id: "runs:long",
      source: "Runs",
      title: "Split the work that keeps one run open for hours",
      why: `Longest ${hours(sorted[0]?.durationMs ?? 0)}, ${sorted[0]?.agentId}${sorted[0]?.ticket ? ` on ${sorted[0].ticket}` : ""}.`,
      measure: count(
        "Runs flagged long",
        longRunners.length,
        capped("longRunners"),
        "runs",
        0,
        "no run flagged long",
      ),
      decider: "FLIGHT",
      deciderNote: "a brief or sizing change",
      evidence: sorted
        .slice(0, DETAIL_LINES)
        .map((r) => `${r.agentId}${r.ticket ? ` · ${r.ticket}` : ""} · ${hours(r.durationMs)}`),
      caveat: "A long run can be honest work; the hub flags the run, not a fault.",
      links: sorted.slice(0, DETAIL_LINES).flatMap((r) => link(r, `${r.agentId} run`)),
    });
  }

  const deathLoops = keep(audit.deathLoops);
  if (deathLoops.length > 0) {
    const sorted = [...deathLoops].sort((a, b) => b.parks - a.parks);
    add({
      group: "death-loops",
      id: "runs:death-loops",
      source: "Runs",
      title: "Stop the seats that park again and again",
      why: `${sorted[0]?.agentId} parked ${times(sorted[0]?.parks ?? 0, "time")} in one run.`,
      measure: count(
        "Runs that parked repeatedly",
        deathLoops.length,
        capped("deathLoops"),
        "runs",
        0,
        "no run parks repeatedly",
      ),
      decider: "FLIGHT",
      deciderNote: "a brief or sizing change",
      evidence: sorted
        .slice(0, DETAIL_LINES)
        .map((r) => `${r.agentId} · ${times(r.parks, "park")}`),
      caveat: "A park can be an operator hold; the count is of runs that parked more than once.",
      links: sorted.slice(0, DETAIL_LINES).flatMap((r) => link(r, `${r.agentId} run`)),
    });
  }

  const rework = keep(audit.reworkRounds);
  if (rework.length > 0) {
    const sorted = [...rework].sort((a, b) => b.rounds - a.rounds);
    add({
      group: "rework",
      id: "reviews:rework",
      source: "Reviews",
      title: `Cut the review rework that passes ${AUDIT_REWORK_ROUNDS} rounds`,
      why: `${sorted[0]?.agentId} took ${times(sorted[0]?.rounds ?? 0, "round")} on one change.`,
      measure: count(
        "Runs past the round limit",
        rework.length,
        capped("reworkRounds"),
        "runs",
        0,
        `no run passes ${AUDIT_REWORK_ROUNDS} rounds`,
      ),
      decider: "FLIGHT",
      deciderNote: "a brief or review change",
      evidence: sorted
        .slice(0, DETAIL_LINES)
        .map((r) => `${r.agentId} · ${times(r.rounds, "round")}`),
      caveat: "Rounds count review passes, not the size of what was fixed.",
      links: sorted.slice(0, DETAIL_LINES).flatMap((r) => link(r, `${r.agentId} run`)),
    });
  }

  // Guard refusals: one row per rule, so "git-env" and "full-suite" are two causes.
  const byRule = new Map<
    string,
    { count: number; seats: Map<string, number>; run: string | null }
  >();
  for (const r of keep(audit.refusals)) {
    const e = byRule.get(r.rule) ?? { count: 0, seats: new Map(), run: null };
    e.count += r.count;
    e.seats.set(r.agentId, (e.seats.get(r.agentId) ?? 0) + r.count);
    e.run ??= r.runId;
    byRule.set(r.rule, e);
  }
  for (const [rule, e] of [...byRule].sort((a, b) => b[1].count - a[1].count)) {
    const seats = [...e.seats].sort((a, b) => b[1] - a[1]);
    add({
      group: "refusals",
      id: `guards:refusal:${rule}`,
      source: "Guards",
      title: `Find why the guard keeps refusing: ${ruleText(rule)}`,
      why: `${times(e.count, "refusal")} across ${times(seats.length, "seat")}; most from ${seats[0]?.[0]}.`,
      measure: count(
        "Refusals in range",
        e.count,
        capped("refusals"),
        "refusals",
        0,
        "a refusal is a stopped action",
      ),
      decider: "You",
      deciderNote: "guard rules are yours to change",
      evidence: seats.slice(0, DETAIL_LINES).map(([seat, n]) => `${seat} · ${times(n, "refusal")}`),
      caveat:
        "Some refusals are right: the guard did its job. Step one reads the hits and changes nothing.",
      links: seats
        .slice(0, DETAIL_LINES)
        .map(([seat]) => ({ label: seat, agentId: seat, runId: null })),
    });
  }

  const spikes = audit.refusalSpikes.filter((s) => !excluded.has(s.agentId));
  if (spikes.length > 0) {
    const sorted = [...spikes].sort((a, b) => b.count - a.count);
    add({
      group: "refusal-spikes",
      id: "guards:spikes",
      source: "Guards",
      title: "Look at the seats that hit a spike of guard refusals in one day",
      why: `${sorted[0]?.agentId} hit ${sorted[0]?.count} in one day; the spike line is ${AUDIT_REFUSAL_SPIKE}.`,
      measure: count(
        "Seat-days over the line",
        spikes.length,
        capped("refusalSpikes"),
        "seat-days",
        0,
        `no seat reaches ${AUDIT_REFUSAL_SPIKE} refusals in a day`,
      ),
      decider: "FLIGHT",
      deciderNote: "a brief change for the seat",
      evidence: sorted.slice(0, DETAIL_LINES).map((s) => `${s.agentId} · ${s.count} refusals`),
      caveat: "A spike can be one stuck command repeated, not many different mistakes.",
      links: sorted
        .slice(0, DETAIL_LINES)
        .map((s) => ({ label: s.agentId, agentId: s.agentId, runId: null })),
    });
  }

  const outliers = keep(audit.spendOutliers);
  if (outliers.length > 0) {
    const sorted = [...outliers].sort((a, b) => b.costUsd - a.costUsd);
    add({
      group: "spend",
      id: "spend:outliers",
      source: "Spend",
      title: `Review the runs that cost ${AUDIT_SPEND_OUTLIER_FACTOR}× the median run`,
      why: `Costliest ~$${(sorted[0]?.costUsd ?? 0).toFixed(2)}, ${sorted[0]?.agentId}${sorted[0]?.ticket ? ` on ${sorted[0].ticket}` : ""}.`,
      measure: count(
        "Runs over the median factor",
        outliers.length,
        capped("spendOutliers"),
        "runs",
        0,
        `no run costs ${AUDIT_SPEND_OUTLIER_FACTOR}× the median`,
      ),
      decider: "FLIGHT",
      deciderNote: "a sizing or brief change",
      evidence: sorted
        .slice(0, DETAIL_LINES)
        .map((r) => `${r.agentId}${r.ticket ? ` · ${r.ticket}` : ""} · ~$${r.costUsd.toFixed(2)}`),
      caveat: "Cost covers runs that recorded one; Codex runs without cost are not counted.",
      links: sorted.slice(0, DETAIL_LINES).flatMap((r) => link(r, `${r.agentId} run`)),
    });
  }

  const big = audit.prSizes.prs.filter((p) => p.additions + p.deletions >= AUDIT_PR_OUTLIER_LINES);
  if (big.length > 0) {
    const sorted = [...big].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    add({
      group: "pr-size",
      id: "merges:pr-size",
      source: "Merges",
      title: `Split the changes that merge at ${AUDIT_PR_OUTLIER_LINES}+ lines`,
      why: `Largest PR #${sorted[0]?.number}: ${((sorted[0]?.additions ?? 0) + (sorted[0]?.deletions ?? 0)).toLocaleString()} lines.`,
      measure: count(
        "Merged PRs at the limit",
        big.length,
        capped("prSizes.prs"),
        "PRs",
        0,
        `no merge reaches ${AUDIT_PR_OUTLIER_LINES} lines`,
      ),
      decider: "FLIGHT",
      deciderNote: "how a ticket is sized",
      evidence: sorted
        .slice(0, DETAIL_LINES)
        .map(
          (p) =>
            `${p.repoId} PR #${p.number} · ${(p.additions + p.deletions).toLocaleString()} lines`,
        ),
      caveat: "Generated files and moves inflate line counts without adding review work.",
      links: [],
    });
  }

  if (audit.chatter.length > 0) {
    const sorted = [...audit.chatter].sort((a, b) => b.rounds - a.rounds);
    add({
      group: "chatter",
      id: "messages:chatter",
      source: "Messages",
      title: "Settle the long back-and-forth between two seats",
      why: `${sorted[0]?.from} and ${sorted[0]?.to} went ${times(sorted[0]?.rounds ?? 0, "round")} on ${sorted[0]?.ticket}.`,
      measure: count(
        "Ticket conversations over the line",
        audit.chatter.length,
        capped("chatter"),
        "conversations",
        0,
        "no pair goes round that long",
      ),
      decider: "FLIGHT",
      deciderNote: "a brief or ticket change",
      evidence: sorted
        .slice(0, DETAIL_LINES)
        .map((c) => `${c.from} ↔ ${c.to} · ${c.ticket} · ${times(c.rounds, "round")}`),
      caveat: "Rounds count messages between two seats, not whether they disagreed.",
      links: [],
    });
  }

  const unanswered = (audit.questions?.asked ?? 0) - (audit.questions?.answered ?? 0);
  if (unanswered > 0) {
    add({
      group: "questions",
      id: "messages:unanswered",
      source: "Messages",
      title: "Answer the seats' questions or close them",
      why: `${unanswered} of ${audit.questions?.asked ?? 0} questions asked have no answer.`,
      measure: count(
        "Unanswered questions",
        unanswered,
        false,
        "questions",
        0,
        "every question answered or closed",
      ),
      decider: "FLIGHT",
      deciderNote: "FLIGHT answers seats' questions",
      evidence: [],
      caveat: "A question can be closed with a ticket instead of an answer.",
      links: [],
    });
  }

  const byKind = new Map<AuditImprovementKind, NonNullable<AuditView["improvements"]>>();
  for (const i of audit.improvements ?? []) {
    if (IMPROVEMENT_TITLES[i.kind] === undefined) continue;
    const list = byKind.get(i.kind) ?? [];
    list.push(i);
    byKind.set(i.kind, list);
  }
  for (const [kind, rows] of byKind) {
    add({
      group: "improvements",
      id: `messages:${kind}`,
      source: "Messages",
      title: IMPROVEMENT_TITLES[kind] ?? kind,
      why: rows[0]?.detail ?? "",
      measure: count(
        "Occurrences in range",
        rows.length,
        capped("improvements"),
        rows.length === 1 ? "occurrence" : "occurrences",
        0,
        "none in the range",
      ),
      decider: "FLIGHT",
      deciderNote: "a brief or hub change",
      evidence: rows.slice(0, DETAIL_LINES).map((r) => r.detail),
      caveat: "Worked out from the hub's own message records.",
      links: [],
    });
  }

  if (audit.flakes.length > 0) {
    const sorted = [...audit.flakes].sort((a, b) => b.count - a.count);
    add({
      group: "flakes",
      id: "ci:flakes",
      source: "CI",
      title: "Fix the checks that fail, then pass on the same commit",
      why: `${sorted[0]?.key} flipped ${times(sorted[0]?.count ?? 0, "time")}.`,
      measure: count(
        "Flaky checks",
        audit.flakes.length,
        capped("flakes"),
        "checks",
        0,
        "no check flips on one commit",
      ),
      decider: "FLIGHT",
      deciderNote: "a test fix",
      evidence: sorted.slice(0, DETAIL_LINES).map((f) => `${f.key} · ${times(f.count, "flip")}`),
      caveat: "A flip is a candidate, not a proven flaky test.",
      links: [],
    });
  }

  const order = (g: Group) => GROUP_ORDER.indexOf(g);
  return drafts
    .map((d, i) => ({ d, i }))
    .sort(
      (a, b) =>
        order(a.d.group) - order(b.d.group) || b.d.measure.now - a.d.measure.now || a.i - b.i,
    )
    .map(({ d: { group: _group, ...row } }, i) => ({ ...row, rank: i + 1 }));
}

function count(
  label: string,
  now: number,
  capped: boolean,
  unit: string,
  target: number,
  targetSource: string,
): AuditAction["measure"] {
  return { label, now, atLeast: capped, target, unit, targetSource };
}

/** One sentence's worth of facts about the list; the page words it. */
export function auditVerdict(actions: readonly AuditAction[]): AuditVerdict {
  return {
    count: actions.length,
    you: actions.filter((a) => a.decider === "You").length,
    flight: actions.filter((a) => a.decider === "FLIGHT").length,
    first: actions[0]?.title ?? null,
  };
}
