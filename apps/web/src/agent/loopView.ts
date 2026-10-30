/** The Agent page's Loop panel, as data: the run's limits, its tries and checks, the timeline's bars. */
import {
  CI_TRIES,
  type LoopTry,
  MC_PUSH_CHECKS,
  type PullRequestView,
  REVIEW_ROUNDS,
  REVIEW_STATUS_RUNNING,
  type ReviewStatus,
  type RunLoop,
  type RunView,
} from "@mc/core";
import type { LOOP_PATH } from "../crew.ts";
import { cutText, firstLine, kTokens, plural, shortSha } from "../fmt.ts";

export type LoopStep = (typeof LOOP_PATH)[number];

export type CheckState = "pass" | "fail" | "run" | "wait";

export const CHECK_ICON: Record<CheckState, string> = {
  pass: "✓ pass",
  fail: "✗ fail",
  run: "◌ running",
  wait: "· waiting",
};

export const CHECK_CLASS: Record<CheckState, string> = {
  pass: "ck-pass",
  fail: "ck-fail",
  run: "ck-run",
  wait: "ck-wait",
};

export interface Check {
  text: string;
  state: CheckState;
}

export interface LoopLimits {
  tries: number;
  rounds: number;
}

/** The limits the engine parks on: the run's profile's, else the build loop's. */
export const runLimits = (run?: RunView): LoopLimits => ({
  tries: run?.profile?.profile.tries ?? CI_TRIES,
  rounds: run?.profile?.profile.rounds ?? REVIEW_ROUNDS,
});

/** The line under a step saying when it parks the run; null for a step that never does. */
export function loopRule(step: LoopStep, limits: LoopLimits): string | null {
  if (step === "ci") return `↻ fail → back to Working · parks after ${limits.tries} failures`;
  if (step === "review") {
    return `↻ Critical or Important findings → fix → CI → review · parks after ${plural(limits.rounds, "round")}`;
  }
  return null;
}

/** The step the run's newest try is at, else null. */
export const heldStep = (tries: readonly LoopTry[]): LoopStep | null => tries.at(-1)?.step ?? null;

/** A step's tries, oldest first, fixes included. */
export const stepTries = (tries: readonly LoopTry[], step: LoopStep): LoopTry[] =>
  tries.filter((t) => t.step === step);

const MINUTE = 60_000;

export const tryMinutes = (t: LoopTry, now: number): number =>
  Math.round(((t.endedAt ?? now) - t.startedAt) / MINUTE);

export const tryText = (t: LoopTry): string => (t.reason ? `${t.outcome}: ${t.reason}` : t.outcome);

/** A reason's one line, and the whole text when there is more than the line says. */
export interface ReasonLine {
  line: string;
  full: string | null;
}

/** The longest line a reason takes in a row. */
const REASON_LINE_MAX = 120;
/** One line of the hub's push refusal: `- not run: pnpm -s test`, `- failed: pnpm -s lint`. */
const REFUSED_CHECK = /^- (failed|not run): (.+)$/;
const REFUSED_COMMIT = /\bCommit (\w+):/;

/**
 * A reason for a row: the hub's checks refusal reads `push refused: \`pnpm -s test\` not run on
 * 80001f8`; any other long or multi-line text is cut to its first line. `full` is the whole text
 * (null when the line already says it all), for a disclosure.
 */
export function reasonLine(reason: string): ReasonLine {
  if (reason.startsWith(MC_PUSH_CHECKS)) {
    const checks = reason.split("\n").flatMap((row) => {
      const found = REFUSED_CHECK.exec(row);
      return found ? [{ failed: found[1] === "failed", command: found[2] }] : [];
    });
    const sha = REFUSED_COMMIT.exec(reason)?.[1];
    if (checks.length > 0 && sha) {
      const [first, ...rest] = checks;
      const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
      const state = first.failed ? "failed" : "not run";
      return { line: `push refused: \`${first.command}\` ${state} on ${sha}${more}`, full: reason };
    }
  }
  const first = reason.split("\n")[0].trim();
  const line = first.length > REASON_LINE_MAX ? `${first.slice(0, REASON_LINE_MAX - 1)}…` : first;
  return { line, full: line === reason ? null : reason };
}

export function tryClass(t: LoopTry): string {
  switch (t.outcome) {
    case "fail":
    case "parked":
    case "stopped":
      return "crit-t";
    case "running":
    case "waiting":
      return "fg2";
    case "pass":
      return "ok-t";
  }
}

export function barClass(t: LoopTry): string {
  if (t.fix) return "tl-fix";
  switch (t.outcome) {
    case "fail":
    case "stopped":
      return "tl-fail";
    case "running":
      return "tl-run";
    case "waiting":
    case "parked":
      return "tl-wait";
    case "pass":
      return "tl-pass";
  }
}

/** The CI check of the pushed commit, read from the PR the loop watches. */
export function ciCheck(loop: RunLoop, prs: readonly PullRequestView[] | undefined): Check {
  if (!loop.pushFor) return { text: "Nothing pushed yet", state: "wait" };
  const short = shortSha(loop.pushFor);
  const pr = prs?.find((p) => p.number === loop.prNumber);
  if (!pr || pr.headSha !== loop.pushFor) {
    return { text: `CI on ${short}: waiting for the push to show on GitHub`, state: "wait" };
  }
  switch (pr.ci) {
    case "passing":
      return { text: `CI on ${short}`, state: "pass" };
    case "failing":
      return { text: `CI on ${short}`, state: "fail" };
    case "pending":
      return { text: `CI on ${short}`, state: "run" };
    case null:
      return { text: `CI on ${short}: no CI reported yet`, state: "wait" };
  }
}

/** The In review step's checks: the QA review's status, then the merge. */
export function reviewChecks(review: ReviewStatus | null, prNumber: number | null): Check[] {
  const qa: Check = !review
    ? { text: "No QA review yet", state: "wait" }
    : {
        text: review.description,
        state:
          review.state === "success"
            ? "pass"
            : review.state === "failure"
              ? "fail"
              : review.description.startsWith(REVIEW_STATUS_RUNNING)
                ? "run"
                : "wait",
      };
  return [qa, { text: prNumber === null ? "PR merged" : `PR #${prNumber} merged`, state: "wait" }];
}

export function stepChecks(
  step: LoopStep,
  loop: RunLoop,
  review: ReviewStatus | null,
  prs: readonly PullRequestView[] | undefined,
): Check[] {
  if (step === "ci") return [ciCheck(loop, prs)];
  if (step === "review") return reviewChecks(review, loop.prNumber);
  return [];
}

/** The timeline's extent: the run's start to its end, or to now while it runs. */
export function loopSpan(
  start: number,
  endedAt: number | null,
  now: number,
): { end: number; total: number } {
  const end = endedAt ?? now;
  return { end, total: Math.max(end - start, 1) };
}

/** A try's bar as percents of the span; an open try runs to the span's end. */
export function barPlace(
  t: LoopTry,
  start: number,
  end: number,
  total: number,
): { left: number; width: number } {
  return {
    left: ((t.startedAt - start) * 100) / total,
    width: (((t.endedAt ?? end) - t.startedAt) * 100) / total,
  };
}

/** Only measured attempts contribute; missing usage is not a zero reading. */
export const stepTokens = (tries: readonly LoopTry[]): number | null => {
  const measured = tries.filter((t) => t.tokens != null);
  return measured.length === 0 ? null : measured.reduce((sum, t) => sum + (t.tokens ?? 0), 0);
};

export const tokenText = (tokens: number | null | undefined): string =>
  tokens == null ? "—" : kTokens(tokens);

/** A step's reason line stays under this many characters. */
export const STEP_REASON_MAX = 60;

const REVIEW_PARK_KIND = /^review/;
const REVIEWED_SHA = /\breviewed ([0-9a-f]{7})/;
const PARK_LABEL: Record<string, string> = {
  refused: "push refused",
  "no-ci": "no CI reported",
  conflict: "PR conflicts with main",
  "pr-closed": "PR closed",
  gate: "gate check failed",
  ci: "CI failed",
  silent: "seat went silent",
  ended: "run ended",
};

/** How many findings a review park holds, read from its text; null when the text does not say. */
function findingCount(reason: string): number | null {
  const found = /found (\d+) issues?\b/.exec(reason) ?? /(\d+) blocking\b/.exec(reason);
  if (found) return Number(found[1]);
  const listed = reason.match(/^\s*\d+\. \[/gm);
  return listed ? listed.length : null;
}

/** A park in three short forms; `full` is the whole text, for a "details" control. */
export interface ParkNote {
  /** What a step waits on: `waiting: 1 finding held on c74cdfc`. */
  step: string;
  /** The header's status: `Parked · review findings on c74cdfc · 1 held`. */
  header: string;
  full: string;
}

/**
 * A park's one-line forms, built from its kind and numbers (finding count, sha), never from its
 * text. `kind` and `sha` come from the run's loop; without them a review is told by its text.
 */
export function parkNote(
  reason: string,
  kind?: string | null,
  sha?: string | null,
  /** The blocking count of the review the park holds on, from the run's events. */
  blocking?: number | null,
): ParkNote {
  const reviewed = REVIEWED_SHA.exec(reason)?.[1];
  const short = sha ? shortSha(sha) : (reviewed ?? null);
  if (kind ? REVIEW_PARK_KIND.test(kind) : reviewed !== undefined) {
    const count = blocking ?? findingCount(reason);
    const held = count === null ? "findings held" : `${plural(count, "finding")} held`;
    return {
      step: cutText(`waiting: ${held}${short ? ` on ${short}` : ""}`, STEP_REASON_MAX),
      header: `Parked · review findings${short ? ` on ${short}` : ""}${count === null ? "" : ` · ${count} held`}`,
      full: reason,
    };
  }
  const label = (kind ? PARK_LABEL[kind] : undefined) ?? cutText(firstLine(reason), 80);
  return {
    step: cutText(`parked: ${label}`, STEP_REASON_MAX),
    header: `Parked · ${label}`,
    full: reason,
  };
}

/** A try's outcome as a short code: `pass`, `refused: checks not run`, `CI failed: lint`. */
export function tryCode(t: LoopTry, parkKind?: string | null): string {
  const reason = t.reason ?? "";
  if (reason.includes(MC_PUSH_CHECKS)) {
    return /^- failed: /m.test(reason) ? "refused: checks failed" : "refused: checks not run";
  }
  const why = cutText(firstLine(reason), 40);
  switch (t.outcome) {
    case "fail":
      return t.step === "ci"
        ? why
          ? `CI failed: ${why}`
          : "CI failed"
        : why
          ? `failed: ${why}`
          : "failed";
    case "parked":
      return `parked: ${parkKind ? (PARK_LABEL[parkKind] ?? parkKind) : why || "held"}`;
    default:
      return t.outcome;
  }
}

/** One line of a step's tries: a run of identical outcomes in a row, counted. */
export interface TryLine {
  key: string;
  label: string;
  code: string;
  count: number;
  minutes: number;
  tokens: number | null;
  tone: string;
}

/** A step's tries as lines: consecutive tries with the same outcome code and kind become one. */
export function tryLines(
  tries: readonly LoopTry[],
  now: number,
  parkKind?: string | null,
): TryLine[] {
  const lines: { line: TryLine; fix: boolean; group: LoopTry[] }[] = [];
  for (const t of tries) {
    const code = tryCode(t, t === tries.at(-1) ? parkKind : null);
    const last = lines.at(-1);
    if (last && last.fix === t.fix && last.line.code === code) {
      last.group.push(t);
    } else {
      lines.push({
        fix: t.fix,
        group: [t],
        line: {
          key: `${t.fix ? "fix" : "try"}${t.n}:${t.startedAt}`,
          label: "",
          code,
          count: 1,
          minutes: 0,
          tokens: null,
          tone: tryClass(t),
        },
      });
    }
  }
  return lines.map(({ line, fix, group }) => {
    const first = group[0] as LoopTry;
    const lastTry = group.at(-1) as LoopTry;
    const range = group.length > 1 ? `${first.n}–${lastTry.n}` : `${first.n}`;
    return {
      ...line,
      label: fix ? "fix" : `${group.length > 1 ? "tries" : "try"} ${range}`,
      count: group.length,
      minutes: group.reduce((sum, t) => sum + tryMinutes(t, now), 0),
      tokens: stepTokens(group),
    };
  });
}

/** `12m`, `2h 25m`: a step's time. */
export const minutesText = (minutes: number): string =>
  minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

/** Park kinds where the step failed (the operator fixes it), against a wait on a review or the operator. */
const FAILED_PARK_KINDS = new Set([
  "ci",
  "refused",
  "no-ci",
  "conflict",
  "gate",
  "merge-step",
  "pr-closed",
]);
export const isFailedPark = (kind: string | null | undefined): boolean =>
  kind != null && FAILED_PARK_KINDS.has(kind);

/**
 * The blocking findings of the newest review of `sha`, read from the run's events
 * (`RETRO reviewed c74cdfc: 1 blocking, 0 minor`); null when no event says.
 */
export function blockingOf(
  events: readonly { text: string }[] | undefined,
  sha: string | null | undefined,
): number | null {
  if (!events || !sha) return null;
  const short = shortSha(sha);
  for (const e of [...events].reverse()) {
    const found = /\breviewed ([0-9a-f]{7}): (\d+) blocking\b/.exec(e.text);
    if (found?.[1] === short) return Number(found[2]);
  }
  return null;
}
