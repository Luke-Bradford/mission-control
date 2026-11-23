import {
  AUDIT_FLIGHT_TOP,
  type AuditReportFinding,
  auditToldKey,
  type FlightState,
} from "@mc/core";
import type { Store } from "../store.ts";

/** What FLIGHT reads of the newest AUDIT report it has not been told: its verdict and top findings. */
export interface FlightAudit {
  id: number;
  at: number;
  verdict: string;
  top: AuditReportFinding[];
}

/** The newest report of the repo that FLIGHT has not been told, with its top findings; else undefined. */
export function pendingAudit(store: Store, repoId: string): FlightAudit | undefined {
  const report = store.latestAuditReport(repoId);
  if (report === null) return undefined;
  if (Number(store.getSetting(auditToldKey(repoId))) >= report.id) return undefined;
  return {
    id: report.id,
    at: report.at,
    verdict: report.verdict,
    top: report.findings
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .slice(0, AUDIT_FLIGHT_TOP),
  };
}

/** Records that FLIGHT has been shown the report in `state`, so the next wake does not carry it again. */
export function markAuditShown(store: Store, state: Pick<FlightState, "audit" | "repo">): void {
  if (state.audit === undefined) return;
  const told = Number(store.getSetting(auditToldKey(state.repo)));
  if (!(told >= state.audit.id)) store.setSetting(auditToldKey(state.repo), String(state.audit.id));
}
