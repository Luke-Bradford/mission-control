import { describe, expect, it } from "vitest";
import type { AuditView } from "../src/audit.ts";
import { auditActions, auditVerdict } from "../src/audit-actions.ts";
import type { WasteAlarm } from "../src/waste.ts";

const HOUR = 3_600_000;
const base: AuditView = {
  range: { since: 0, until: 30 * 24 * HOUR },
  longRunners: [],
  deathLoops: [],
  reworkRounds: [],
  refusalsByRule: [],
  refusals: [],
  refusalSpikes: [],
  spendOutliers: [],
  questions: { asked: 0, answered: 0, answerMs: null },
  costPerMergedTicket: [],
  modelPromptTimeline: [],
  prSizes: { prs: [], outliers: [] },
  chatter: [],
  flakes: [],
  changes: [],
  surgeonProposals: [],
};
const alarm = (id: number, check: WasteAlarm["check"], subject: string): WasteAlarm => ({
  id,
  check,
  subject,
  repoId: "mission-control",
  ticket: subject,
  seatId: "guido-1",
  runId: `run-${id}`,
  level: 1,
  evidence: `evidence ${subject}`,
  openedAt: 1,
  closedAt: null,
  resolvedAt: null,
  basis: null,
});

describe("auditActions", () => {
  it("is empty with nothing past a limit", () => {
    expect(auditActions(base, [], new Set())).toEqual([]);
    expect(auditVerdict([])).toEqual({ count: 0, you: 0, flight: 0, first: null });
  });

  it("groups repeats into one row per cause, with unique titles, numbers and a decider", () => {
    const audit: AuditView = {
      ...base,
      longRunners: [1, 2, 3].map((n) => ({
        runId: `r${n}`,
        agentId: `seat-${n}`,
        ticket: `mc#${n}`,
        startedAt: 0,
        durationMs: n * HOUR,
      })),
      deathLoops: [{ runId: "d", agentId: "retro-1", parks: 4 }],
      reworkRounds: [{ runId: "w", agentId: "guido-1", rounds: 5, maxRound: 5 }],
      refusals: [
        { agentId: "a", runId: "x", rule: "git-env", count: 5 },
        { agentId: "b", runId: "y", rule: "git-env", count: 3 },
        { agentId: "a", runId: "z", rule: "full-suite", count: 2 },
      ],
      questions: { asked: 7, answered: 5, answerMs: HOUR },
    };
    const rows = auditActions(
      audit,
      [alarm(1, "retry-loop", "mc#1"), alarm(2, "retry-loop", "mc#2")],
      new Set(),
    );
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
    expect(new Set(rows.map((r) => r.title)).size).toBe(rows.length);
    expect(rows[0]).toMatchObject({
      id: "waste:retry-loop:failed",
      measure: { now: 1, target: 1 },
    });
    expect(rows.filter((r) => r.id === "waste:retry-loop:failed")).toHaveLength(1);
    // Ordinary guard refusals are the guard working: no row, and no invented zero target.
    expect(rows.some((r) => r.id.startsWith("guards:refusal:"))).toBe(false);
    expect(rows.some((r) => /guard keeps refusing/.test(r.title))).toBe(false);
    expect(rows.find((r) => r.id === "runs:long")?.measure.now).toBe(3);
    expect(rows.find((r) => r.id === "messages:unanswered")?.measure.now).toBe(2);
    for (const r of rows) {
      expect(Number.isFinite(r.measure.now) && Number.isFinite(r.measure.target)).toBe(true);
      expect(r.title).not.toMatch(/Inspect the shared cause/);
    }
    expect(auditVerdict(rows)).toMatchObject({ count: rows.length, first: rows[0]?.title });
  });

  it("gives every waste family its real measure against the limit, not an alarm count", () => {
    const at = (check: WasteAlarm["check"], level: number, evidence = "e"): WasteAlarm => ({
      ...alarm(level, check, `mc#${level}`),
      level,
      evidence,
    });
    const cases: [WasteAlarm[], number, number, string][] = [
      [[at("unchanged-rerun", 3)], 3, 0, "reruns"],
      [[at("retry-loop", 4)], 4, 1, "failed attempts"],
      [[at("review-rounds", 5), at("review-rounds", 3)], 5, 2, "rounds"],
      [[at("restart-storm", 9)], 9, 6, "starts in an hour"],
      [[at("cost-without-output", 4)], 4, 3, "× median cost"],
      [
        [
          at(
            "coordination-overhead",
            42,
            "In the last day FLIGHT spent $42.10 and the developers $18.40.",
          ),
        ],
        42,
        18,
        "dollars",
      ],
      [
        [
          at(
            "ticket-churn",
            9,
            "In the last day 9 tickets were opened and 3 closed in mc, so the board did not shrink.",
          ),
        ],
        9,
        4,
        "tickets opened",
      ],
      [[at("runs-per-ticket", 6)], 6, 3, "runs"],
      [[at("failed-review-rounds", 3)], 3, 1, "failed rounds"],
      [[at("clearance-waiting", 7)], 7, 1, "hours"],
    ];
    for (const [alarms, now, target, unit] of cases) {
      const [row] = auditActions(base, alarms, new Set());
      expect(row?.measure, alarms[0]?.check).toMatchObject({ now, target, unit });
      expect(row?.measure.targetSource).toMatch(/limit/);
    }
  });

  it("keeps each retry and churn cause against its own limit", () => {
    const at = (check: WasteAlarm["check"], evidence: string, over: Partial<WasteAlarm> = {}) => ({
      ...alarm(1, check, "mc#1"),
      evidence,
      level: 3,
      ...over,
    });
    const one = (a: WasteAlarm) => auditActions(base, [a], new Set())[0];
    // failed attempts only
    expect(
      one(at("retry-loop", "mc#1 is parked: 3 failed attempts (a, b, c). It stays parked."))
        ?.measure,
    ).toMatchObject({ now: 3, target: 1, unit: "failed attempts" });
    // resumes only: the resume limit, never the failed-attempt one
    const resumed = one(
      at("retry-loop", "mc#1 is parked: run r resumed 3 times without a report. It stays parked."),
    );
    expect(resumed?.measure).toMatchObject({ now: 3, target: 2, unit: "resumes" });
    expect(resumed?.measure.targetSource).toMatch(/3 carry-on resumes/);
    // mixed: first cause on the row, the other against its own limit in the evidence
    const mixed = one(
      at(
        "retry-loop",
        "mc#1 is parked: 2 failed attempts (a, b); run r resumed 4 times without a report. It stays parked.",
        { level: 6 },
      ),
    );
    expect(mixed).toBeDefined();
    const mixedRows = auditActions(
      base,
      [
        at(
          "retry-loop",
          "mc#1 is parked: 2 failed attempts (a, b); run r resumed 4 times without a report. It stays parked.",
          { level: 6 },
        ),
      ],
      new Set(),
    );
    expect(mixedRows.find((r) => r.id === "waste:retry-loop:failed")?.measure).toMatchObject({
      now: 2,
      target: 1,
      unit: "failed attempts",
    });
    expect(mixedRows.find((r) => r.id === "waste:retry-loop:resumed")?.measure).toMatchObject({
      now: 4,
      target: 2,
      unit: "resumes",
    });
    // churn: a restarted ticket and split tickets are their own causes
    const restarted = one(
      at("ticket-churn", "mc#1 was parked and has started again (r1, r2).", {
        subject: "mc#1:restarted",
        level: 2,
      }),
    );
    expect(restarted?.measure).toMatchObject({ now: 2, target: 0, unit: "runs" });
    const split = auditActions(
      base,
      [
        at("ticket-churn", "mc#7 reads as a piece of other work.", {
          subject: "mc#7:split",
          level: 1,
        }),
        at("ticket-churn", "mc#8 reads as a piece of other work.", {
          subject: "mc#8:split",
          level: 1,
        }),
      ],
      new Set(),
    )[0];
    expect(split?.measure).toMatchObject({ now: 2, target: 0, unit: "tickets" });
  });

  it("keeps distinct ticket-churn causes as distinct rows and combines repeats of one", () => {
    const at = (evidence: string, subject: string, level: number): WasteAlarm => ({
      ...alarm(level, "ticket-churn", subject),
      subject,
      evidence,
      level,
    });
    const rows = auditActions(
      base,
      [
        at(
          "In the last day 9 tickets were opened and 3 closed in mc, so the board did not shrink.",
          "mc",
          9,
        ),
        at("mc#1 was parked and has started again (r1, r2).", "mc#1:restarted", 2),
        at("mc#2 was parked and has started again (r3).", "mc#2:restarted", 3),
        at("mc#7 reads as a piece of other work.", "mc#7:split", 1),
        at("mc#8 reads as a piece of other work.", "mc#8:split", 1),
      ],
      new Set(),
    ).filter((r) => r.source === "Waste");
    expect(rows.map((r) => r.id).sort()).toEqual([
      "waste:ticket-churn:day",
      "waste:ticket-churn:restarted",
      "waste:ticket-churn:split",
    ]);
    expect(new Set(rows.map((r) => r.title)).size).toBe(3);
    const by = (k: string) => rows.find((r) => r.id.endsWith(k));
    expect(by("day")?.measure).toMatchObject({ now: 9, unit: "tickets opened" });
    expect(by("restarted")?.measure).toMatchObject({ now: 3, target: 0, unit: "runs" });
    expect(by("split")?.measure).toMatchObject({ now: 2, target: 0, unit: "tickets" });
    expect(by("restarted")?.evidence).toHaveLength(2);
  });

  it("shows run ids as seat and date, with working links, never raw", () => {
    const a = {
      ...alarm(9, "cost-without-output", "guido-1:20261117T102236Z@0123456789abcdef"),
      seatId: null,
      runId: null,
      evidence: "Run guido-1:20261117T102236Z cost 3x the median.",
    };
    const [row] = auditActions(base, [a], new Set());
    const text = [
      row?.why,
      ...(row?.evidence ?? []),
      ...(row?.links.map((l) => l.label) ?? []),
    ].join("|");
    expect(text).not.toMatch(/\d{8}T\d{6}Z/);
    expect(row?.evidence[0]).toBe(
      "guido-1 run of 17 Nov 10:22 UTC at commit 0123456: Run guido-1 run of 17 Nov 10:22 UTC cost 3x the median.",
    );
    expect(row?.links[0]).toMatchObject({ agentId: "guido-1", runId: "guido-1:20261117T102236Z" });
  });

  it("leaves out closed and resolved alarms and excluded seats", () => {
    const closed = { ...alarm(3, "restart-storm", "guido-1"), closedAt: 5 };
    const resolved = { ...alarm(4, "ticket-churn", "mc"), resolvedAt: 5 };
    const rows = auditActions(
      {
        ...base,
        deathLoops: [{ runId: "d", agentId: "flight-1", parks: 4 }],
        longRunners: [
          {
            runId: "s",
            agentId: "x",
            ticket: null,
            startedAt: 0,
            durationMs: HOUR,
            actionable: false,
          },
        ],
      },
      [closed, resolved],
      new Set(["flight-1"]),
    );
    expect(rows).toEqual([]);
  });

  it("marks a count as a floor when the server cut the list", () => {
    const rows = auditActions(
      {
        ...base,
        capped: { flakes: 80 },
        flakes: [{ key: "web:a", count: 2, lastAt: 1 }],
      },
      [],
      new Set(),
    );
    expect(rows[0]?.measure.atLeast).toBe(true);
  });
  it("gives one chatter cause one row, not one from the chatter list and one from its improvement", () => {
    const audit: AuditView = {
      ...base,
      chatter: [{ from: "guido-1", to: "flight-1", ticket: "mc#9", rounds: 12 }],
      improvements: [
        {
          kind: "chatter",
          subject: "mc#9",
          ticket: "mc#9",
          pr: null,
          detail: "guido-1 and flight-1 went 12 rounds on mc#9",
          at: 1,
        },
      ],
    };
    const rows = auditActions(audit, [], new Set());
    expect(rows.filter((r) => /chatter/.test(r.id))).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });
});
