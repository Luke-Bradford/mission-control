import { type OverviewTimeline, TIMELINE_TICKS_MAX, TIMELINE_WINDOW_MS } from "@mc/core";
import { type CcConfig, configuredAgents } from "./config.ts";
import { loopTries } from "./loophistory.ts";
import type { Store } from "./store.ts";

type Lane = OverviewTimeline["lanes"][number];

type Span = Lane["spans"][number];

/**
 * Spans in start order, with overlapping spans of one kind joined. A crew seat's open turn can be
 * seen twice (its status events and its unended run); drawn twice it would double up on the lane.
 */
function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  const last = new Map<Span["kind"], Span>();
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const prev = last.get(span.kind);
    if (prev && (prev.to === null || span.from < prev.to)) {
      prev.to = prev.to === null || span.to === null ? null : Math.max(prev.to, span.to);
      continue;
    }
    const copy = { ...span };
    out.push(copy);
    last.set(span.kind, copy);
  }
  return out;
}

export function overviewTimeline(config: CcConfig, store: Store, now: number): OverviewTimeline {
  const from = now - TIMELINE_WINDOW_MS;
  const lanes = configuredAgents(config).map(
    (a): Lane => ({ agentId: a.id, spans: [], ticks: [] }),
  );
  const byAgent = new Map(lanes.map((lane) => [lane.agentId, lane]));
  const add = (
    agentId: string,
    kind: Lane["spans"][number]["kind"],
    start: number,
    end: number | null,
  ) => {
    if (start > now || (end !== null && end <= from)) return;
    byAgent.get(agentId)?.spans.push({
      kind,
      from: Math.max(from, start),
      to: end === null ? null : Math.min(now, end),
    });
  };
  const sources = store.timelineSources(from, now);
  const crewIds = new Set(
    configuredAgents(config)
      .filter((a) => a.kind === "crew")
      .map((a) => a.id),
  );
  const running = new Map<string, number>();
  const seen = new Set<string>();
  for (const event of sources.events) {
    if (!crewIds.has(event.agentId)) continue;
    if (!seen.has(event.agentId) && event.from === "running") running.set(event.agentId, from);
    seen.add(event.agentId);
    const start = running.get(event.agentId);
    if (["idle", "stopped", "error", "parked"].includes(event.to) && start !== undefined) {
      add(event.agentId, "turn", start, event.at);
      running.delete(event.agentId);
    }
    if (event.to === "running") running.set(event.agentId, event.at);
  }
  for (const [agentId, start] of running) {
    if (store.seatSession(agentId)?.state === "running") add(agentId, "turn", start, null);
  }
  for (const hold of sources.holds) add(hold.agentId, "lock", hold.from, hold.to);
  for (const review of sources.reviews) {
    if (review.startedAt !== null) add(review.seatId, "review", review.startedAt, review.endedAt);
  }
  const digests = store.digests(sources.runs.map((run) => run.id));
  for (const run of sources.runs) {
    if (run.loop) {
      for (const attempt of loopTries(run, store.loopEventsOfRun(run.id), null)) {
        if (attempt.step === "ci" && attempt.outcome !== "parked") {
          add(run.agentId, "checks", attempt.startedAt, attempt.endedAt);
        }
      }
    } else {
      add(run.agentId, "turn", run.startedAt, run.endedAt);
    }
    byAgent.get(run.agentId)?.ticks.push(...(digests.get(run.id)?.toolStarts ?? []));
  }
  for (const lane of lanes) {
    lane.spans = mergeSpans(lane.spans);
    lane.ticks = lane.ticks
      .filter((at) => at >= from && at <= now)
      .sort((a, b) => a - b)
      .slice(-TIMELINE_TICKS_MAX);
  }
  return { from, to: now, lanes };
}
