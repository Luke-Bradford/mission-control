import type { MapSeat, MapSnapshot } from "@mc/core";
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

/** Cut-off calls are excluded by the server; only reported refusals and failures count. */
export function isStuck(seat: MapSeat, now: number): boolean {
  return (
    seat.state === "stalled" ||
    seat.calls.some((c) => now - c.since > 600_000) ||
    recentFailures(seat, now).length >= 3 ||
    (seat.badges.waiting !== null && now - seat.badges.waiting.since > 900_000)
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
  const call = [...seat.calls].sort((a, b) => a.since - b.since)[0];
  const state =
    seat.state === "stalled"
      ? `stalled ${duration(now - seat.since)}`
      : call
        ? `${call.tool} ${call.detail} ${duration(now - call.since)}${seat.calls.length > 1 ? ` · +${seat.calls.length - 1} calls` : ""}`
        : seat.state === "running"
          ? "thinking"
          : `${seat.state} ${duration(now - seat.since)}`;
  return {
    state,
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
