import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { PlanMockup, PlanState, TicketPlan } from "@mc/core";
import { parseJson } from "../json.ts";

type Row = Record<string, SQLInputValue>;

/** The parts the planner fills in. */
export interface PlanParts {
  asks: string | null;
  proposal: string;
  sizeEstimate: string | null;
  risks: string | null;
  mockups: PlanMockup[];
}

const toPlan = (r: Row): TicketPlan => ({
  repoId: r.repo_id as string,
  issue: r.issue as number,
  ref: `${r.repo_id as string}#${r.issue as number}`,
  title: null,
  state: r.state as PlanState,
  marked: r.required === 1,
  asks: (r.asks as string | null) ?? null,
  proposal: (r.proposal as string | null) ?? null,
  sizeEstimate: (r.size_estimate as string | null) ?? null,
  risks: (r.risks as string | null) ?? null,
  mockups: parseJson<PlanMockup[]>(r.mockups, []),
  note: (r.note as string | null) ?? null,
  requestedAt: r.requested_at as number,
  plannedAt: (r.planned_at as number | null) ?? null,
  decidedAt: (r.decided_at as number | null) ?? null,
});

/** The queries over `ticket_plans`: one row per ticket, its state moving as the plan does. */
export function ticketPlanQueries(db: DatabaseSync) {
  const get = (repoId: string, issue: number): TicketPlan | null => {
    const row = db
      .prepare("SELECT * FROM ticket_plans WHERE repo_id = ? AND issue = ?")
      .get(repoId, issue) as Row | undefined;
    return row === undefined ? null : toPlan(row);
  };
  return {
    get,

    /** Every plan in `states`, oldest request first. */
    inStates(states: readonly PlanState[]): TicketPlan[] {
      const marks = states.map(() => "?").join(", ");
      return (
        db
          .prepare(
            `SELECT * FROM ticket_plans WHERE state IN (${marks}) ORDER BY requested_at, issue`,
          )
          .all(...states) as Row[]
      ).map(toPlan);
    },

    /** The signed-off plans, newest decision first. */
    signedOff(): TicketPlan[] {
      return (
        db
          .prepare(
            "SELECT * FROM ticket_plans WHERE state = 'signed-off' ORDER BY decided_at DESC, issue DESC",
          )
          .all() as Row[]
      ).map(toPlan);
    },

    /** FLIGHT sends a ticket to the Planner tab: held until signed off. A signed-off row is kept. */
    request(repoId: string, issue: number, at: number): void {
      db.prepare(
        `INSERT INTO ticket_plans (repo_id, issue, state, required, requested_at)
         VALUES (?, ?, 'awaiting-plan', 1, ?)
         ON CONFLICT (repo_id, issue) DO UPDATE SET required = 1
         WHERE state != 'signed-off'`,
      ).run(repoId, issue, at);
    },

    /**
     * The planner filed a plan: waits for sign-off. `marked` is FLIGHT's own mark for larger work;
     * a row that FLIGHT already sent keeps its mark. Whether the ticket is held is worked out from
     * the repo's current setting and this mark (planHolds), never stored.
     */
    file(repoId: string, issue: number, parts: PlanParts, marked: boolean, at: number): void {
      db.prepare(
        `INSERT INTO ticket_plans
           (repo_id, issue, state, required, asks, proposal, size_estimate, risks, mockups,
            requested_at, planned_at)
         VALUES (?, ?, 'awaiting-signoff', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, issue) DO UPDATE SET
           state = 'awaiting-signoff', asks = excluded.asks, proposal = excluded.proposal,
           size_estimate = excluded.size_estimate, risks = excluded.risks,
           mockups = excluded.mockups, planned_at = excluded.planned_at, note = NULL,
           decided_at = NULL`,
      ).run(
        repoId,
        issue,
        marked ? 1 : 0,
        parts.asks,
        parts.proposal,
        parts.sizeEstimate,
        parts.risks,
        JSON.stringify(parts.mockups),
        at,
        at,
      );
    },

    /** The operator signs the plan off. */
    approve(repoId: string, issue: number, at: number): boolean {
      return (
        db
          .prepare(
            "UPDATE ticket_plans SET state = 'signed-off', note = NULL, decided_at = ? WHERE repo_id = ? AND issue = ? AND state = 'awaiting-signoff'",
          )
          .run(at, repoId, issue).changes === 1
      );
    },

    /** The operator sends the plan back: it returns to the planner with the note. */
    sendBack(repoId: string, issue: number, note: string): boolean {
      return (
        db
          .prepare(
            "UPDATE ticket_plans SET state = 'sent-back', note = ?, decided_at = NULL WHERE repo_id = ? AND issue = ? AND state = 'awaiting-signoff'",
          )
          .run(note, repoId, issue).changes === 1
      );
    },
  };
}
