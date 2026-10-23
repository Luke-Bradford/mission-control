/** A looped run's tries at each step, worked out on read from its Activity rows. */
import {
  type LoopEvent,
  type LoopTry,
  parkedEventText,
  REVIEW_STATUS_RUNNING,
  type ReviewStatus,
  type Run,
  type RunDigest,
  reviewEventKey,
} from "@mc/core";

/** The event texts that move a run between steps; core's loop writes them. */
const REPORTED_TEXT = "reported; pushing";
const CI_PASSED_PREFIX = "CI passed on ";
const CI_FAILED_PREFIX = "CI failed on ";
const MERGED_TEXT = "merged";
const PARKED_PREFIX = parkedEventText("");
/** The engine's flake re-run of a failed CI: the run stays on CI, so it changes no try. */
const RERUN_KEY = (runId: string): string => `${runId}:rerun:`;

type Step = LoopTry["step"];

/** The review id of a `{run}:review:{id}:{step}` key, or null when the key is not that step's. */
function reviewIdOf(runId: string, key: string, step: string): string | null {
  const head = reviewEventKey(runId, 0, step).replace(/0:[^:]*$/, "");
  const tail = `:${step}`;
  if (!key.startsWith(head) || !key.endsWith(tail)) return null;
  const id = key.slice(head.length, key.length - tail.length);
  return /^\d+$/.test(id) ? id : null;
}

/** The step a run is on after `event`, when it says so; used to place a try opened by a resume. */
function impliedStep(runId: string, e: LoopEvent): Step | null {
  if (e.text === REPORTED_TEXT) return "working";
  if (e.key.startsWith(RERUN_KEY(runId))) return "ci";
  if (e.text.startsWith(CI_PASSED_PREFIX) || e.text.startsWith(CI_FAILED_PREFIX)) return "ci";
  if (
    reviewIdOf(runId, e.key, "fix") !== null ||
    e.text === MERGED_TEXT ||
    e.key.startsWith(`${runId}:update:`)
  ) {
    return "review";
  }
  return null;
}

/**
 * The run's tries at each step, oldest first. `events` come by `at`, then key; `review` is the
 * QA status of the pushed commit, which says whether an open In review try is being worked on.
 */
export function loopTries(
  run: Run,
  events: LoopEvent[],
  review: ReviewStatus | null,
  usage?: RunDigest["attemptUsage"],
): LoopTry[] {
  const loop = run.loop ?? null;
  if (loop === null) return [];
  const tries: LoopTry[] = [];
  /** The open try is the newest one, until it has an end. */
  const openTry = (): LoopTry | null => {
    const t = tries.at(-1);
    return t !== undefined && t.endedAt === null ? t : null;
  };

  const close = (at: number, outcome: LoopTry["outcome"], reason: string | null = null): void => {
    const open = openTry();
    if (open === null) return;
    open.endedAt = at;
    // a parked try stays parked when it closes
    if (open.outcome !== "parked") {
      open.outcome = outcome;
      open.reason = reason;
    }
  };
  const begin = (step: Step, at: number, fix = false): void => {
    const n = tries.filter((t) => t.step === step && t.fix === fix).length + 1;
    tries.push({ step, fix, n, startedAt: at, endedAt: null, outcome: "running", reason: null });
  };

  begin("working", run.startedAt);
  const reported = new Map<string, string>();
  for (const [i, e] of events.entries()) {
    const reviewReported = reviewIdOf(run.id, e.key, "reported");
    if (reviewReported !== null) reported.set(reviewReported, e.text);
    if (e.key.startsWith(RERUN_KEY(run.id))) continue;
    const fixOf = reviewIdOf(run.id, e.key, "fix");
    if (e.text === REPORTED_TEXT || e.key.startsWith(`${run.id}:update:`)) {
      close(e.at, "pass");
      begin("ci", e.at);
    } else if (e.key.startsWith(`${run.id}:update-conflict:`)) {
      close(e.at, "fail", e.text);
      begin("working", e.at);
    } else if (e.text.startsWith(CI_PASSED_PREFIX)) {
      close(e.at, "pass");
      begin("review", e.at);
    } else if (e.text.startsWith(CI_FAILED_PREFIX)) {
      close(e.at, "fail", e.text);
      begin("working", e.at);
    } else if (fixOf !== null) {
      close(e.at, "fail", reported.get(fixOf) ?? null);
      begin("review", e.at, true);
    } else if (e.text.startsWith(PARKED_PREFIX)) {
      const parked = openTry();
      if (parked !== null) {
        parked.outcome = "parked";
        parked.reason = e.text.slice(PARKED_PREFIX.length);
      }
    } else if (e.key.startsWith(`${run.id}:resumed:`)) {
      const was = openTry();
      const later = events.slice(i + 1).find((x) => impliedStep(run.id, x) !== null);
      const phase = loop.phase === "working" || loop.phase === "ci" || loop.phase === "review";
      const step: Step =
        (later === undefined ? null : impliedStep(run.id, later)) ??
        (phase ? (loop.phase as Step) : (was?.step ?? "working"));
      close(e.at, "stopped");
      begin(step, e.at);
    } else if (e.text === MERGED_TEXT) {
      close(e.at, "pass");
      begin("done", e.at);
    }
  }

  const last = openTry();
  if (last === null) return tries;
  if (run.endedAt !== null) {
    if (last.step === "done") close(run.endedAt, "pass");
    else {
      close(run.endedAt, "stopped", loop.parked?.kind === "ended" ? loop.parked.reason : null);
    }
  } else if (last.outcome !== "parked") {
    last.outcome =
      last.step === "review"
        ? review?.description === REVIEW_STATUS_RUNNING
          ? "running"
          : "waiting"
        : "running";
  }
  if (usage !== undefined) {
    for (const t of tries) {
      const samples = usage.filter(
        (u) => u.at !== null && u.at >= t.startedAt && (t.endedAt === null || u.at < t.endedAt),
      );
      t.tokens = samples.length === 0 ? null : samples.reduce((n, u) => n + u.tokens, 0);
    }
  }
  return tries;
}
