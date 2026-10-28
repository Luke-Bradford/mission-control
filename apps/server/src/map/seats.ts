import {
  type CrewRow,
  MAP_RECENT_CAP,
  MAP_RECENT_MS,
  type MapSeat,
  type MapSnapshot,
  namesOnly,
  type Run,
  type TestLockState,
} from "@mc/core";
import { cleanText } from "../clean.ts";
import type { Store } from "../store.ts";
import type { CallRing, RingCall } from "./ring.ts";

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
    const flight = row.role === "FLIGHT";
    // Each unmerged branch the seat's work is on: its run's, then set-aside runs'. A worktree can
    // have moved on to a later run's branch, so each counts as the branch its diff was read on,
    // owned (ticket, title, commits) by the newest run on that branch. A review run edits nothing.
    const modified = new Map<string, MapSeat["scope"]["modified"][number]>();
    const work: { branch: string; owner: Run | null; changed: boolean }[] = [];
    let currentWork: Work | null = null;
    let currentChanged = false;
    for (const candidate of flight
      ? []
      : [
          ...(run ? [run] : []),
          ...store.mapAsideRuns(row.id).filter((r) => r.id !== run?.id && r.repoId === row.repoId),
        ]) {
      const done = runWork(candidate, ring, store);
      if (candidate === run) currentWork = done;
      const { branch, owner, changes } = done;
      if (
        branch &&
        (work.some((w) => w.branch === branch) ||
          store.pullRequests(row.repoId).some((p) => p.branch === branch && p.state === "merged"))
      )
        continue;
      // a run with no branch yet still shows its edit churn; it just names no branch
      if (branch) work.push({ branch, owner, changed: changes.length > 0 });
      if (candidate === run && changes.length > 0) currentChanged = true;
      for (const change of changes) {
        const previous = modified.get(change.file);
        if (previous) {
          previous.add += change.add;
          previous.rem += change.rem;
          // a total that includes any churn is labelled churn: never pass it off as the diff
          if (change.source === "churn") previous.source = "churn";
        } else modified.set(change.file, { ...change });
      }
    }
    // The map answers where an agent is working and what it changed, so the seat's ticket, title,
    // PR and CI are those of the work its changes are on: its current run's when that has changes,
    // else its first other branch with changes, else its current run's. A worktree on a branch no
    // run owns (main, a hand checkout) borrows no ticket: the crew row's stands.
    const firstChanged = work.find((w) => w.changed && w.owner) ?? null;
    const lead = run
      ? currentChanged
        ? currentWork
        : (firstChanged ?? currentWork)
      : (firstChanged ?? work.find((w) => w.owner) ?? null);
    const owner = lead?.owner ?? null;
    const ticketRef = flight ? null : (owner?.ticket ?? row.ticket ?? null);
    const ticket = ticketNumber(ticketRef);
    const ticketTitle =
      owner && owner.ticket !== row.ticket
        ? (owner.ticketTitle ?? null)
        : (row.ticketTitle ?? null);
    const leadBranch = lead?.branch ?? run?.branch ?? null;
    // the ticket the seat's current run is on, when the line leads with another (its changes')
    const currentTicket = ticketNumber(currentWork?.owner?.ticket ?? run?.ticket);
    const nowTicket =
      !flight && lead !== currentWork && currentTicket !== ticket ? currentTicket : null;
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
      .find((p) => leadBranch !== null && p.branch === leadBranch);
    const reviews =
      ticket === null
        ? []
        : store
            .runsOnTicket(row.repoId, ticketRef as string)
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
    return {
      seat: flight ? "FLIGHT" : row.id,
      state: row.hudState === "stalled" ? "stalled" : (session?.state ?? "idle"),
      since: row.stateSince,
      ticket,
      title: !flight && ticketTitle ? safe(ticketTitle) : null,
      branches: work.map((w) => w.branch),
      changedOn: work.filter((w) => w.changed).map((w) => w.branch),
      nowTicket,
      tickets: Object.fromEntries(
        work.flatMap((w) => {
          const n = ticketNumber(w.owner?.ticket);
          return n === null ? [] : [[w.branch, n]];
        }),
      ),
      calls: live
        ? calls
            .filter((c) => c.end === null)
            .map(({ tool, detail, files, since }) => ({ tool, detail, files, since }))
        : [],
      scope: {
        read: live ? scope.read : [],
        modified: flight ? (live ? scope.modified : []) : [...modified.values()],
      },
      recent: recentPath(calls, live, now),
      context: null,
      badges: {
        questions: store
          .openQuestions()
          .filter((q) => q.agentId === row.id && q.runId === run?.id)
          // a question carries its own run's ticket, not the one the seat's line shows
          .map((q) => ({
            id: q.id,
            from: row.id,
            to: "CAPCOM",
            ticket: ticketNumber(run?.ticket) ?? ticket,
            since: q.at,
          })),
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
          ? {
              kind: "test-lock",
              since: waiting.since,
              reason: safe(waiting.command),
              stopped: false,
            }
          : row.loop?.parked
            ? {
                kind: "parked",
                since: row.stateSince,
                reason: safe(row.loop.parked),
                stopped: run?.endedBy === "operator",
              }
            : session?.state === "parked"
              ? {
                  kind: "parked",
                  since: session.updatedAt,
                  reason: safe(session.reason ?? ""),
                  stopped: false,
                }
              : null,
      },
    };
  });
  return { seats, findings };
}

/**
 * A run's change: the branch's real diff from its merge base, read from its worktree, plus edit
 * churn for the worktree's untracked, unignored files the diff can't see yet (a new file not yet
 * added), counted from the edits since the run's last commit (all of them when it has none: an
 * untracked file was never committed). A reverted edit or an ignored file adds nothing. Before
 * the diff has been read, or where it can't be, the run's churn alone, labelled churn.
 */
export function runChanges(
  runId: string,
  ring: Pick<CallRing, "diff" | "scope" | "untracked">,
  store: Pick<Store, "newestRunCommit">,
  /** The run whose edits and commits belong to the diff's branch, when that is another run. */
  ownerId = runId,
): MapSeat["scope"]["modified"] {
  const scope = ring.scope(ownerId);
  const real = ring.diff(runId);
  if (real === null) return scope.modified;
  const untracked = new Set(ring.untracked(runId) ?? []);
  if (!untracked.size) return real;
  const since = store.newestRunCommit(ownerId)?.at ?? Number.NEGATIVE_INFINITY;
  const inDiff = new Set(real.map((c) => c.file));
  const churn = new Map<string, { add: number; rem: number }>();
  for (const edit of scope.edits) {
    if (!untracked.has(edit.file) || inDiff.has(edit.file) || edit.at <= since) continue;
    const total = churn.get(edit.file) ?? { add: 0, rem: 0 };
    total.add += edit.add;
    total.rem += edit.rem;
    churn.set(edit.file, total);
  }
  return [
    ...real,
    ...[...churn].map(([file, { add, rem }]) => ({ file, add, rem, source: "churn" as const })),
  ];
}

/**
 * A seat's path: its calls' files in order, each at its call's end (now, for a call still running),
 * a run of accesses to one file listed once at its latest. It stays after the run ends while each
 * call is within MAP_RECENT_MS of its end; a call cut off by the run ending ends at its start, so
 * it ages out too. Name-only listings (Glob) are left out: they opened nothing.
 */
function recentPath(calls: RingCall[], live: boolean, now: number): MapSeat["recent"] {
  const path: MapSeat["recent"] = [];
  for (const call of calls) {
    const at = call.end ?? (live ? now : call.since);
    if (namesOnly(call.tool) || at < now - MAP_RECENT_MS) continue;
    for (const file of call.files) {
      if (path.at(-1)?.file === file) path.pop();
      path.push({ file, at: call.end ?? call.since });
    }
  }
  return path.slice(-MAP_RECENT_CAP);
}

const ticketNumber = (ref: string | null | undefined): number | null =>
  ref ? Number(ref.split("#").at(-1)) || null : null;

type Work = { branch: string | null; owner: Run | null; changes: MapSeat["scope"]["modified"] };

/**
 * A run's work: the branch its worktree's diff was read on (the run's own until read), the newest
 * run on that branch, which owns its ticket and commits (this seat's own run first), and the change
 * (runChanges). A review run's scratch checkout holds the developer's PR, so it contributes no
 * change and no branch. A worktree on a branch no run owns, or detached, is credited nothing.
 */
export function runWork(
  candidate: Run,
  ring: Pick<CallRing, "diff" | "diffBranch" | "scope" | "untracked">,
  store: Pick<Store, "newestRunCommit" | "latestRunOnBranch">,
): Work {
  if (candidate.reviewId != null) return { branch: null, owner: candidate, changes: [] };
  const read = ring.diffBranch(candidate.id);
  if (read === null && ring.diff(candidate.id) !== null)
    return { branch: candidate.branch, owner: candidate, changes: [] }; // detached: not this branch
  if (read && read !== candidate.branch) {
    const owner = store.latestRunOnBranch(candidate.repoId, read, candidate.agentId);
    return owner
      ? { branch: read, owner, changes: runChanges(candidate.id, ring, store, owner.id) }
      : { branch: read, owner: null, changes: [] };
  }
  return {
    branch: read ?? candidate.branch,
    owner: candidate,
    changes: runChanges(candidate.id, ring, store),
  };
}
