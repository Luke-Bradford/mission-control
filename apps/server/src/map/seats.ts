import type { CrewRow, MapSeat, MapSnapshot, TestLockState } from "@mc/core";
import { cleanText } from "../clean.ts";
import type { Store } from "../store.ts";
import type { CallRing } from "./ring.ts";

const safe = (text: string) => cleanText(text.replace(/\/(?:Users|home)\/[^/\s]+\//g, "~/"));

export function mapSeats(
  rows: CrewRow[],
  store: Store,
  ring: CallRing,
  lock: TestLockState,
  now: number,
): Pick<MapSnapshot, "seats" | "findings"> {
  const findings: MapSnapshot["findings"] = [];
  const seats = rows.map((row): MapSeat => {
    const session = store.seatSession(row.id);
    const run = row.run ? store.run(row.run.id) : null;
    const ticket =
      row.role !== "FLIGHT" && row.ticket ? Number(row.ticket.split("#").at(-1)) || null : null;
    const flight = row.role === "FLIGHT";
    const scopeId = flight ? `${run?.id}:${row.repoId}` : (run?.id ?? "");
    const calls = ring
      .calls(row.id)
      .filter(
        (c) => c.repoId === row.repoId && c.runId === scopeId && (!flight || c.files.length > 0),
      );
    const live = session?.state === "running" || session?.state === "starting";
    const completed = calls.filter((c) => c.end !== null);
    const scope = ring.scope(scopeId);
    const latestTests = scope.tests;
    const waiting = lock.waiting.find((w) => w.seatId === row.id);
    const pr = store
      .pullRequests(row.repoId)
      .find((p) => run?.branch != null && p.branch === run.branch);
    const reviews =
      ticket === null
        ? []
        : store
            .runsOnTicket(row.repoId, row.ticket as string)
            .flatMap((r) => store.reviewsOfRun(r.id));
    const review = reviews.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).at(-1);
    const current = review ? store.findingsOf(review.id) : [];
    const counts = { Critical: 0, Important: 0, Minor: 0 };
    for (const finding of current) {
      counts[finding.severity]++;
      if (ticket !== null && review)
        findings.push({
          severity: finding.severity,
          file: safe(finding.file),
          line: finding.line,
          summary: safe(finding.summary),
          scenario: safe(finding.scenario),
          fix: safe(finding.fix),
          seat: row.id,
          ticket,
          round: review.round,
        });
    }
    const modified = new Map<string, MapSeat["scope"]["modified"][number]>();
    for (const candidate of flight
      ? []
      : [
          ...(run ? [run] : []),
          ...store.mapAsideRuns(row.id).filter((r) => r.id !== run?.id && r.repoId === row.repoId),
        ]) {
      if (
        store
          .pullRequests(row.repoId)
          .some((p) => p.branch === candidate.branch && p.state === "merged")
      )
        continue;
      for (const change of ring.scope(candidate.id).modified) {
        const previous = modified.get(change.file);
        if (previous) {
          previous.add += change.add;
          previous.rem += change.rem;
        } else modified.set(change.file, { ...change });
      }
    }
    return {
      seat: flight ? "FLIGHT" : row.id,
      state: row.hudState === "stalled" ? "stalled" : (session?.state ?? "idle"),
      since: row.stateSince,
      ticket,
      title: !flight && row.ticketTitle ? safe(row.ticketTitle) : null,
      calls: live
        ? calls
            .filter((c) => c.end === null)
            .map(({ tool, detail, files, since }) => ({ tool, detail, files, since }))
        : [],
      scope: {
        read: live ? scope.read : [],
        modified: flight ? (live ? scope.modified : []) : [...modified.values()],
      },
      recent: live
        ? calls.flatMap((c) => c.files.map((file) => ({ file, at: c.end ?? c.since }))).slice(-12)
        : [],
      context: null,
      badges: {
        questions: store
          .openQuestions()
          .filter((q) => q.agentId === row.id && q.runId === run?.id)
          .map((q) => ({ id: q.id, from: row.id, to: "CAPCOM", ticket, since: q.at })),
        failures: [
          ...completed
            .filter((c) => (c.error || c.refused) && (c.end as number) >= now - 600_000)
            .map((c) => ({
              at: c.end as number,
              tool: c.tool,
              refused: c.refused,
              why: c.why ?? "",
            })),
          ...store
            .guardHits(now - 600_000)
            .filter((h) => h.runId === run?.id)
            .map((h) => ({ at: h.at, tool: "guard", refused: true, why: safe(h.text) })),
        ],
        review:
          review && ticket !== null
            ? { ticket, round: review.round, counts, at: review.endedAt ?? review.createdAt }
            : null,
        tests: latestTests
          ? {
              ...latestTests.tests,
              at: latestTests.at,
              editedSince: scope.editedAt > latestTests.at,
            }
          : null,
        ci:
          pr?.headSha && pr.checks
            ? { sha: pr.headSha, checks: pr.checks, at: pr.updatedAt }
            : null,
        waiting: waiting
          ? { kind: "test-lock", since: waiting.since, reason: safe(waiting.command) }
          : row.loop?.parked
            ? { kind: "parked", since: row.stateSince, reason: safe(row.loop.parked) }
            : session?.state === "parked"
              ? { kind: "parked", since: session.updatedAt, reason: safe(session.reason ?? "") }
              : null,
      },
    };
  });
  return { seats, findings };
}
