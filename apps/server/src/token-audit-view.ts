import {
  TOKEN_AUDIT_TOP_RUNS,
  type TokenAuditNamed,
  type TokenAuditRole,
  type TokenAuditView,
  type TokenCounts,
} from "@mc/core";
import { type CcConfig, configuredAgents } from "./config.ts";
import { flightWakeCost } from "./flight/cost.ts";
import { flightSeat } from "./flight/seat.ts";
import type { Store } from "./store.ts";

const DAY_MS = 86_400_000;
/** The role name shown for an observed loop, which has none. */
export const LOOP_ROLE = "loop";

const merge = (into: Map<string, TokenCounts>, from: Record<string, TokenCounts>) => {
  for (const [name, c] of Object.entries(from)) {
    const t = into.get(name) ?? { added: 0, reread: 0, events: 0 };
    t.added += c.added;
    t.reread += c.reread;
    t.events += c.events;
    into.set(name, t);
  }
};

const named = (m: Map<string, TokenCounts>): TokenAuditNamed[] => {
  const total = [...m.values()].reduce((s, c) => s + c.reread, 0);
  return [...m]
    .map(([name, c]) => ({ name, ...c, share: total > 0 ? c.reread / total : 0 }))
    .sort((a, b) => b.reread - a.reread || a.name.localeCompare(b.name));
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

/** The stored token audits of runs started in the last `days` days, summed for `GET /api/audit/tokens`. */
export function tokenAuditView(
  store: Store,
  config: CcConfig,
  now: number,
  days: number,
): TokenAuditView {
  const since = now - days * DAY_MS;
  const roles = new Map<string, string>(
    configuredAgents(config).map((a) => [a.id, a.kind === "loop" ? LOOP_ROLE : a.seat.role]),
  );
  const rows = store.runTokenAudits(since);
  const bySource = new Map<string, TokenCounts>();
  const byCommand = new Map<string, TokenCounts>();
  const byRole = new Map<string, TokenAuditRole & { peaks: number[] }>();
  const view = {
    runs: rows.length,
    calls: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reread: 0,
    rewrites: 0,
  };
  let readAfter = 0;
  let readWithReport = 0;
  const topRuns = rows.map(({ run, audit }) => {
    const reread = Object.values(audit.bySource).reduce((s, c) => s + c.reread, 0);
    const roleName = roles.get(run.agentId) ?? "unknown";
    const role = byRole.get(roleName) ?? {
      role: roleName,
      runs: 0,
      calls: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reread: 0,
      rewrites: 0,
      medianPeakContext: 0,
      peaks: [] as number[],
    };
    role.runs += 1;
    role.calls += audit.calls;
    role.output += audit.output;
    role.cacheRead += audit.cacheRead;
    role.cacheWrite += audit.cacheWrite;
    role.reread += reread;
    role.rewrites += audit.rewrites;
    role.peaks.push(audit.peakContext);
    byRole.set(roleName, role);
    merge(bySource, audit.bySource);
    merge(byCommand, audit.byCommand);
    view.calls += audit.calls;
    view.output += audit.output;
    view.cacheRead += audit.cacheRead;
    view.cacheWrite += audit.cacheWrite;
    view.reread += reread;
    view.rewrites += audit.rewrites;
    if (audit.readAfterReport !== null) {
      readAfter += audit.readAfterReport;
      readWithReport += audit.cacheRead;
    }
    return {
      runId: run.id,
      agentId: run.agentId,
      role: roleName,
      calls: audit.calls,
      peakContext: audit.peakContext,
      medianContext: audit.medianContext,
      output: audit.output,
      reread,
      rewrites: audit.rewrites,
      readAfterReportShare:
        audit.readAfterReport === null || audit.cacheRead === 0
          ? null
          : audit.readAfterReport / audit.cacheRead,
      costUsd: run.costUsd,
    };
  });
  const flight = flightSeat(config);
  const cost =
    flight === null
      ? null
      : flightWakeCost(
          store,
          now,
          flight.seat.id,
          new Set(configuredAgents(config).flatMap((a) => (a.kind === "crew" ? [a.id] : []))),
          days,
        );
  const start = cost?.byReason.find((r) => r.reason === "start");
  return {
    days,
    since,
    ...view,
    readAfterReportShare: readWithReport > 0 ? readAfter / readWithReport : null,
    byRole: [...byRole.values()]
      .map(({ peaks, ...r }) => ({ ...r, medianPeakContext: median(peaks) }))
      .sort((a, b) => b.reread - a.reread || a.role.localeCompare(b.role)),
    bySource: named(bySource),
    byCommand: named(byCommand),
    topRuns: topRuns
      .sort((a, b) => b.reread - a.reread || a.runId.localeCompare(b.runId))
      .slice(0, TOKEN_AUDIT_TOP_RUNS),
    hubSections: store.promptSectionTotals(since).sort((a, b) => b.tokens - a.tokens),
    flightStart:
      cost === null
        ? null
        : {
            usd: start?.usd ?? 0,
            totalUsd: cost.totalUsd,
            share: cost.totalUsd > 0 ? (start?.usd ?? 0) / cost.totalUsd : 0,
          },
    controller:
      config.audit?.controllerSessions === true ? store.controllerUsageSince(since) : null,
  };
}
