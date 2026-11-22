import {
  AUDIT_PACK_ROWS_MAX,
  type AuditReport,
  type FlightPrFlowRow,
  type WasteSpend,
  wrapExternalText,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { flightSeat } from "../flight/seat.ts";
import { flightState } from "../flight/state.ts";
import type { SeatBusy } from "../runtime/supervisor.ts";
import { wasteCounts, wasteReport } from "../spend/waste.ts";
import type { Store } from "../store.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How far back the pack's flow counts look. */
const PACK_WINDOW_DAYS = 7;
const hours = (ms: number): number => Math.round((ms / HOUR_MS) * 10) / 10;
const top = <T>(rows: readonly T[]): T[] => rows.slice(0, AUDIT_PACK_ROWS_MAX);

const spendRow = (s: WasteSpend) => ({
  window: s.window,
  merged: s.merged,
  runs: s.runs,
  tokens: s.tokens,
  costUsd: s.costUsd,
  perMergeTokens: s.perMergeTokens,
  perMergeUsd: s.perMergeUsd,
  buildingShareTokens: s.buildingShareTokens,
});

/** A report as the next one reads it: the verdict and each finding's problem, never its evidence again. */
const previousOf = (r: AuditReport | null, now: number) =>
  r === null
    ? null
    : {
        id: r.id,
        hoursAgo: hours(now - r.at),
        verdict: r.verdict,
        findings: r.findings.map((f) => ({ rank: f.rank, area: f.area, problem: f.problem })),
      };

/**
 * The crew's own record, bounded for the AUDIT seat: one JSON line the brief calls data. Lists hold
 * at most AUDIT_PACK_ROWS_MAX rows; titles from the board are outside text, wrapped as data.
 */
export function buildAuditPack(i: {
  config: CcConfig;
  store: Store;
  busy: readonly SeatBusy[];
  now: number;
}): string {
  const { config, store, busy, now } = i;
  const found = flightSeat(config);
  const repoId = found?.session.repoId ?? "";
  const state = flightState({ config, store, busy, now });
  const byColumn: Record<string, number> = {};
  for (const t of state.tickets) byColumn[t.column] = (byColumn[t.column] ?? 0) + 1;
  const buildSeats = state.seats.filter((s) => s.loop === "build");
  const since = now - PACK_WINDOW_DAYS * DAY_MS;
  const counts = repoId === "" ? null : wasteCounts(config, store, repoId, "", since, now);
  const waste = wasteReport(config, store, now);
  const rows: FlightPrFlowRow[] = state.prFlow?.rows ?? [];
  const flightId = found?.seat.id;
  const flightStarts = store.waste
    .runsSince(now - DAY_MS)
    .filter((r) => r.agentId === flightId).length;
  const audit = store.audit(since, now);
  // Decisions on one subject more than once: the ones that may have gone round in circles.
  const bySubject = new Map<string, { about: string; count: number; kinds: Set<string> }>();
  for (const d of store.flightDecisions(since, 500)) {
    const row = bySubject.get(d.about) ?? { about: d.about, count: 0, kinds: new Set<string>() };
    row.count += 1;
    row.kinds.add(d.kind);
    bySubject.set(d.about, row);
  }
  const repeatedDecisions = [...bySubject.values()]
    .filter((r) => r.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ about: wrapExternalText(r.about), count: r.count, kinds: [...r.kinds] }));
  return JSON.stringify({
    at: now,
    repo: state.repo,
    seats: top(
      state.seats.map((s) => ({
        id: s.id,
        role: s.role,
        loop: s.loop,
        state: s.state,
        free: s.free,
        ticket: s.ticket,
        idleMin: s.idleMin,
        stalled: s.stalled,
        atStop: s.atStop,
        paused: s.pause !== null,
        stopped: s.stop !== null,
        openQuestion: s.openQuestion,
      })),
    ),
    buildSeats: {
      configured: buildSeats.length,
      running: buildSeats.filter((s) => !s.free).length,
      idle: buildSeats.filter((s) => s.free).length,
    },
    board: { open: state.tickets.length, byColumn },
    prs: top(
      rows
        .slice()
        .sort((a, b) => a.stageSince - b.stageSince)
        .map((p) => ({
          pr: p.pr,
          ticket: p.ticket,
          title: wrapExternalText(p.title),
          stage: p.stage,
          stageHours: hours(now - p.stageSince),
          openHours: hours(now - p.openSince),
          owner: p.owner,
          ownerKind: p.ownerKind ?? null,
          waitsOn: p.waitsOn.slice(0, 5),
          lastAction: p.lastAction,
        })),
    ),
    questions: top(
      state.questions.map((q) => ({
        id: q.id,
        seat: q.seat,
        ticket: q.ticket,
        ageMin: q.ageMin,
      })),
    ),
    flow:
      counts === null
        ? null
        : {
            days: PACK_WINDOW_DAYS,
            ticketsOpened: counts.ticketsOpened,
            ticketsClosed: counts.ticketsClosed,
            runsPerTicket: counts.runsPerTicket,
            reviewRounds: counts.reviewRounds,
            idleSeatHours: Math.round(counts.idleSeatHours * 10) / 10,
          },
    flightStarts24h: flightStarts,
    spend: waste.spend.map(spendRow),
    review7d: {
      rounds: top(audit.reviewRounds?.prs ?? []),
      late: top(audit.reviewRounds?.late ?? []),
      specBounces: top(audit.specBounces?.counts ?? []),
      ...store.reviewWaste(since),
    },
    flightRepeatedDecisions7d: top(repeatedDecisions),
    previous: previousOf(repoId === "" ? null : store.latestAuditReport(repoId), now),
  });
}
