import type { AttentionItem, FlightBlocked, FlightDecision, FlightView } from "@mc/core";
import { brief, CONFIG, HOUR, item, METRICS_VIEW, MIN, NOW } from "./fixtures.ts";
import { flightSummary, ledgerEntry, summaryItem } from "./flightSummaryFixture.ts";

export type PageState = "stopped" | "running" | "blocked" | "busy";

const LONG =
  "Open the ticket inline with bound Accept and Decline actions, then check the answer against the Done when list and the review findings before anything merges. ";

const decision = (id: number): FlightDecision => ({
  id,
  at: NOW - id * 11 * MIN,
  kind: "answer",
  seatId: "guido-1",
  targetRunId: null,
  ref: "shop-app#5",
  questionId: null,
  about: `shop-app#${id}: which port should the preview use?`,
  decision: `Use 517${id % 10}, the one the config already names.`,
  basis: "The config's preview port is named and nothing else listens there.",
});

const ticket = (n: number, waitsOn: string[], waitedMin: number): FlightBlocked => ({
  ref: `shop-app#${n}`,
  title: `Ticket ${n} waits for other work`,
  column: "In progress",
  waitsOn,
  chain: [`shop-app#${n}`],
  waitedMin,
});

/** What the hub answers the FLIGHT page in each state; an override replaces one path's answer. */
export function flightPageApi(state: PageState, over: Record<string, unknown> = {}) {
  const live = state !== "stopped";
  const attention: AttentionItem[] =
    state === "busy"
      ? Array.from({ length: 12 }, (_, i) =>
          item({
            key: `q:${i}`,
            kind: "question",
            text: `${LONG}(${i})`,
            ticket: `shop-app#${300 + i}`,
            at: NOW - (i + 1) * 17 * MIN,
            brief: brief({ assessment: `${LONG}${LONG}${LONG}` }),
          }),
        )
      : state === "blocked"
        ? [
            item({
              key: "q:1",
              kind: "question",
              text: "Which wording for away mode?",
              at: NOW - 3 * HOUR,
            }),
          ]
        : [];
  const view: FlightView = {
    seat: {
      id: "flight-1",
      call: "FLIGHT-1",
      model: "opus",
      state: live ? "running" : "idle",
      live,
      context: live ? { tokens: 74_200, rotateAt: 200_000, text: null } : null,
    },
    decisions: Array.from({ length: 30 }, (_, i) => decision(i + 1)),
    wake: { lastWakeAt: NOW - 4 * MIN, wokeOn: ["q (1)"], nextWakeAt: null },
    blocked:
      state === "blocked"
        ? [ticket(9, ["shop-app#7 (PR 12 in CI)"], 42), ticket(8, ["shop-app#6"], 18)]
        : state === "busy"
          ? Array.from({ length: 4 }, (_, i) =>
              ticket(20 + i, [`shop-app#${10 + i} (PR ${50 + i} in CI)`], 25 + i * 9),
            )
          : [],
  };
  const now = [1, 2, 3, 4].map((n) =>
    summaryItem(
      ledgerEntry({
        key: `work:${n}`,
        title: `Reviewing queue ${n}`,
        next: "Check the PR against its Done when list",
      }),
    ),
  );
  return {
    "/api/operator/bootstrap": { token: "fixture-token" },
    "/api/config": CONFIG,
    "/api/metrics": METRICS_VIEW,
    "/api/settings/crew-pause": null,
    "/api/flight": view,
    "/api/attention": attention,
    "/api/flight/summary": flightSummary({
      session: "s1",
      headline: "The crew is shipping; one review needs attention.",
      headlineAgeMin: 4,
      now,
    }),
    ...over,
  };
}
