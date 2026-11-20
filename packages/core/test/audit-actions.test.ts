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
    expect(rows[0]).toMatchObject({ id: "waste:retry-loop", measure: { now: 2, target: 0 } });
    expect(rows.filter((r) => r.id === "waste:retry-loop")).toHaveLength(1);
    const gitEnv = rows.find((r) => r.id === "guards:refusal:git-env");
    expect(gitEnv).toMatchObject({ decider: "You", measure: { now: 8, target: 0 } });
    expect(rows.find((r) => r.id === "runs:long")?.measure.now).toBe(3);
    expect(rows.find((r) => r.id === "messages:unanswered")?.measure.now).toBe(2);
    for (const r of rows) {
      expect(Number.isFinite(r.measure.now) && Number.isFinite(r.measure.target)).toBe(true);
      expect(r.title).not.toMatch(/Inspect the shared cause/);
    }
    expect(auditVerdict(rows)).toMatchObject({ count: rows.length, first: rows[0]?.title });
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
});
