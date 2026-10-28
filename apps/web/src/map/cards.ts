import { type MapSeat, type MapSnapshot, seatCallSign } from "@mc/core";
import { stateLabel } from "./agents.ts";
import { isDocked } from "./model.ts";

export type BadgeKind = "questions" | "failures" | "review" | "tests" | "ci" | "waiting";
export interface MapBadge {
  kind: BadgeKind;
  text: string;
  age: string;
  tone: "muted" | "warn" | "ok";
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`;
}
export const age = (at: number, now: number): string => `${duration(now - at)} ago`;

export const recentFailures = (seat: MapSeat, now: number) =>
  seat.badges.failures
    .filter((f) => f.at >= now - 600_000 && f.at <= now)
    .sort((a, b) => b.at - a.at);

/**
 * Cut-off calls are excluded by the server; only reported refusals and failures count. A seat
 * parked because the operator stopped its run (`waiting.stopped`) waits on nobody, so it isn't stuck.
 */
/**
 * "Conflicts not checked: head not fetched" for each of the seat's unmerged branches whose
 * conflicts went unchecked; the branch is named when the seat carries more than one.
 */
export function uncheckedNotes(seat: MapSeat, snapshot: MapSnapshot): string[] {
  return snapshot.conflictsUnchecked
    .filter((u) => seat.branches.includes(u.branch))
    .map(
      (u) =>
        `Conflicts not checked${seat.branches.length > 1 ? ` on ${u.branch}` : ""}: ${u.reason}`,
    );
}

export function isStuck(seat: MapSeat, now: number): boolean {
  const waiting = seat.badges.waiting;
  return (
    seat.state === "stalled" ||
    seat.calls.some((c) => now - c.since > 600_000) ||
    recentFailures(seat, now).length >= 3 ||
    (waiting !== null && !waiting.stopped && now - waiting.since > 900_000)
  );
}

export function badgeModels(seat: MapSeat, now: number): MapBadge[] {
  const result: MapBadge[] = [];
  const add = (kind: BadgeKind, text: string, at: number, tone: MapBadge["tone"] = "muted") =>
    result.push({ kind, text, age: age(at, now), tone });
  const { questions, review, tests, ci, waiting } = seat.badges;
  if (questions.length)
    add(
      "questions",
      `Questions: ${questions.length} awaiting reply`,
      Math.min(...questions.map((q) => q.since)),
    );
  const failures = recentFailures(seat, now);
  if (failures.length) {
    const refused = failures.filter((f) => f.refused).length;
    const failed = failures.length - refused;
    const counts = [refused ? `${refused} refused` : "", failed ? `${failed} failed` : ""]
      .filter(Boolean)
      .join(" · ");
    add(
      "failures",
      `${counts} in 10 min${failures[0].why ? ` · ${failures[0].why}` : ""}`,
      failures[0].at,
      "warn",
    );
  }
  if (review && review.ticket === seat.ticket) {
    const { Critical, Important, Minor } = review.counts;
    add(
      "review",
      `Review round ${review.round}: ${Critical} Critical, ${Important} Important, ${Minor} Minor`,
      review.at,
      Critical + Important ? "warn" : "ok",
    );
  }
  if (tests) {
    const text =
      tests.runner === "vitest" ? `${tests.passed} passed, ${tests.failed} failed` : "unknown";
    add(
      "tests",
      `Local tests: ${text}${tests.editedSince ? " · edited since" : ""}`,
      tests.at,
      tests.status === "failed"
        ? "warn"
        : tests.status === "passed" && !tests.editedSince
          ? "ok"
          : "muted",
    );
  }
  if (ci) {
    const counts = (["passing", "failing", "pending"] as const)
      .map((state) => `${ci.checks.filter((c) => c.state === state).length} ${state}`)
      .join(", ");
    add(
      "ci",
      `CI @${ci.sha.slice(0, 8)}: ${ci.checks.length ? counts : "unknown"}`,
      ci.at,
      ci.checks.some((c) => c.state === "failing")
        ? "warn"
        : ci.checks.length && ci.checks.every((c) => c.state === "passing")
          ? "ok"
          : "muted",
    );
  }
  if (waiting)
    add(
      "waiting",
      `Waiting: ${waiting.kind}${waiting.reason ? ` · ${waiting.reason}` : ""}`,
      waiting.since,
      now - waiting.since > 900_000 ? "warn" : "muted",
    );
  return result;
}

export function agentCard(seat: MapSeat, now: number) {
  const scope = new Set([...seat.scope.read, ...seat.scope.modified.map((c) => c.file)]);
  const active = new Set(seat.calls.flatMap((c) => c.files));
  // A branch folder describes observed scope, never what a thinking agent is considering.
  const folders = [...(active.size ? active : scope)].map((f) => f.split("/").slice(0, -1));
  const common = folders[0] ?? [];
  let depth = 0;
  while (depth < common.length && folders.every((f) => f[depth] === common[depth])) depth++;
  return {
    state: stateLabel(seat, now),
    folder: folders.length ? common.slice(0, depth).join("/") || "." : null,
    scope: scope.size,
    modified: new Set(seat.scope.modified.map((c) => c.file)).size,
    accessing: active.size,
    docked: isDocked(seat, now),
    stuck: isStuck(seat, now),
  };
}

export function currentFindings(snapshot: MapSnapshot, seat: MapSeat) {
  const review = seat.badges.review;
  return review && review.ticket === seat.ticket
    ? snapshot.findings.filter(
        (f) => f.seat === seat.seat && f.ticket === review.ticket && f.round === review.round,
      )
    : [];
}

export function questionLanes(seat: MapSeat) {
  return [...new Set(seat.badges.questions.map((q) => JSON.stringify([q.from, q.to].sort())))].map(
    (key) => ({
      key,
      ends: JSON.parse(key) as [string, string],
      questions: seat.badges.questions.filter((q) => JSON.stringify([q.from, q.to].sort()) === key),
    }),
  );
}

/**
 * A seat the stage shows: live now (a call in flight, a running turn, or less than a minute since
 * one), or carrying an unmerged branch with changes. Everyone else folds into the rail's idle line.
 */
export function isWorking(seat: MapSeat, now: number): boolean {
  return !isDocked(seat, now) || seat.scope.modified.length > 0;
}

/** What a seat has changed on its unmerged branches: distinct files, lines added and removed. */
export function changeTotals(seat: MapSeat): { files: number; add: number; rem: number } {
  const files = new Set(seat.scope.modified.map((c) => c.file));
  return {
    files: files.size,
    add: seat.scope.modified.reduce((n, c) => n + c.add, 0),
    rem: seat.scope.modified.reduce((n, c) => n + c.rem, 0),
  };
}

/** The stage's one line per working agent: `GUIDO-CX · #698 · 12 files · +77 −30`. */
export function factLine(seat: MapSeat, callSign = seatCallSign(seat.seat)): string {
  const { files, add, rem } = changeTotals(seat);
  return [
    callSign,
    ...(seat.ticket !== null ? [`#${seat.ticket}`] : []),
    files ? `${files} file${files === 1 ? "" : "s"}` : "no changes yet",
    ...(files ? [`+${add} −${rem}`] : []),
  ].join(" · ");
}
