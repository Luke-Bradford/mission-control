import {
  type LoopKind,
  MC_TOOL_NAMES,
  type NoReport,
  noReportNoteKey,
  noReportReason,
  type Run,
} from "@mc/core";
import type { Store } from "../store.ts";
import type { TranscriptFacts } from "../streamjson.ts";

const REPORT_TOOLS = {
  build: MC_TOOL_NAMES.reportEvidence,
  review: MC_TOOL_NAMES.reportFindings,
  plan: MC_TOOL_NAMES.reportPlan,
} as const;

/** Records an unreported exit, including one recovered from an exited keeper after a restart. */
export function recordNoReport(
  store: Store,
  run: Run,
  loop: LoopKind,
  exit: Pick<NoReport, "code" | "signal" | "lastStderr"> & Partial<Pick<NoReport, "error">>,
  facts: TranscriptFacts | null,
  at: number,
): boolean {
  if (loop === "none" || loop === "watch") return false;
  const review = run.reviewId == null ? null : store.review(run.reviewId);
  const fresh = store.run(run.id) ?? run;
  if (fresh.loop?.phase === "done") return false;
  const ev = store.latestEvidence(run.id);
  const reported =
    loop === "build"
      ? ev !== null && !(fresh.loop?.phase === "working" && ev.id <= fresh.loop.reportedEvidenceId)
      : loop === "review"
        ? review?.runId === run.id && review.verdict !== null
        : store.loopEventsOfRun(run.id).some((e) => e.key === `${run.id}:plan`);
  if (reported) return false;
  const record: NoReport = {
    code: exit.code,
    signal: exit.signal,
    lastStderr: exit.lastStderr,
    stopReason: facts?.stopReason ?? null,
    resultSubtype: facts?.resultSubtype ?? null,
    isError: facts?.isError ?? null,
    error: exit.error ?? facts?.error ?? null,
    terminalReason: facts?.terminalReason ?? null,
    apiErrorStatus: facts?.apiErrorStatus ?? null,
    turns: facts?.resultCount ?? null,
    tokens: facts?.tokens ?? run.tokens,
    lastAssistantText: facts?.lastAssistantText ?? null,
  };
  store.recordNoReport(run.id, record, {
    key: noReportNoteKey(run.id),
    kind: "flag",
    runId: run.id,
    seatId: run.agentId,
    repoId: run.repoId,
    text: `${run.agentId} run #${run.seq} ended without an accepted ${REPORT_TOOLS[loop]}: ${noReportReason(record)}.`,
    at,
  });
  return true;
}
