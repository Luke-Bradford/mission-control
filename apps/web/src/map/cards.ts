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

/** A change that moved at least one line (a mode-only or empty entry counts for nothing). */
const counted = (seat: MapSeat) => seat.scope.modified.filter((c) => c.add + c.rem > 0);

/** Acting now: a call in flight or a running turn. */
export const isActing = (seat: MapSeat): boolean =>
  seat.calls.length > 0 || seat.state === "running";

/**
 * Waiting on the operator: a question awaiting a reply, or parked for a reason other than the
 * operator stopping its run (a test-lock queue waits on the lock, not on anyone).
 */
export const waitsOnYou = (seat: MapSeat): boolean =>
  seat.badges.questions.length > 0 ||
  (seat.badges.waiting?.kind === "parked" && !seat.badges.waiting.stopped);

/**
 * A seat the stage shows: live now (a call in flight, a running turn, or less than a minute since
 * one), carrying an unmerged branch with changes, or waiting on the operator. Everyone else folds
 * into the rail's idle line.
 */
export function isWorking(seat: MapSeat, now: number): boolean {
  return !isDocked(seat, now) || counted(seat).length > 0 || waitsOnYou(seat);
}

/**
 * What a seat has changed on its unmerged branches: distinct files, lines added and removed, and
 * whether any of it is edit churn rather than the branch's real diff.
 */
export function changeTotals(seat: MapSeat): {
  files: number;
  add: number;
  rem: number;
  churn: boolean;
} {
  const changes = counted(seat);
  return {
    files: new Set(changes.map((c) => c.file)).size,
    add: changes.reduce((n, c) => n + c.add, 0),
    rem: changes.reduce((n, c) => n + c.rem, 0),
    churn: changes.some((c) => c.source === "churn"),
  };
}

/**
 * The stage's label: facts only, `GUIDO-CX · #747 · 6 files · +175 −29`. Edit churn is a "~" on
 * the numbers and several branches a "· 2br"; the words (and waiting on you, shown as a dot) are in
 * factLine, which is the label's accessible name and the tooltip's.
 */
export function stageLine(seat: MapSeat, callSign = seatCallSign(seat.seat)): string {
  const { files, add, rem, churn } = changeTotals(seat);
  return [
    callSign,
    ...(seat.ticket !== null ? [`#${seat.ticket}`] : []),
    ...(files
      ? [`${files} file${files === 1 ? "" : "s"}`, `${churn ? "~" : ""}+${add} −${rem}`]
      : seat.seat === "FLIGHT"
        ? []
        : ["no changes yet"]),
    ...(seat.branches.length > 1 ? [`${seat.branches.length}br`] : []),
  ].join(" · ");
}

/** Each branch with its ticket, for a tooltip: `feature/717-x (#717), feature/708-y (#708)`. */
export const branchList = (seat: MapSeat): string =>
  seat.branches
    .map((b) => (seat.tickets[b] !== undefined ? `${b} (#${seat.tickets[b]})` : b))
    .join(", ");

/**
 * The stage's one line per working agent, in words: `GUIDO-CX · #698 · 12 files · +77 −30`, with
 * "(churn)" when any of it is edit churn, "· 2 branches" when it spans several, and "· waiting on
 * you" when it waits on the operator. FLIGHT has no branch, so it never says "no changes yet".
 */
export function factLine(seat: MapSeat, callSign = seatCallSign(seat.seat)): string {
  const { files, add, rem, churn } = changeTotals(seat);
  return [
    callSign,
    ...(seat.ticket !== null ? [`#${seat.ticket}`] : []),
    ...(files
      ? [`${files} file${files === 1 ? "" : "s"}`, `+${add} −${rem}${churn ? " (churn)" : ""}`]
      : seat.seat === "FLIGHT"
        ? []
        : ["no changes yet"]),
    ...(seat.branches.length > 1 ? [`${seat.branches.length} branches`] : []),
    ...(waitsOnYou(seat) ? ["waiting on you"] : []),
  ].join(" · ");
}
