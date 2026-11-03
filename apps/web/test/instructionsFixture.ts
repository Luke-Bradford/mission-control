import {
  INSTRUCTION_TEXT_MAX,
  type SeatInstructionIndex,
  type StandingInstruction,
} from "@mc/core";
import { agentDensityFixture } from "./agentDensityFixture.ts";
import { NOW } from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

export type InstructionScenario = "empty" | "one" | "many" | "long" | "boundary";
/** Fictional data shaped exactly like the reviewed #1377 routes. No live or provider evidence. */
export function instructionsFixture(scenario: InstructionScenario) {
  const agent = agentDensityFixture(
    scenario === "boundary" ? "long" : scenario === "empty" ? "one" : scenario,
  );
  const count = scenario === "empty" ? 0 : scenario === "many" ? 50 : 1;
  const text =
    scenario === "boundary"
      ? "🚀".repeat(INSTRUCTION_TEXT_MAX / 2)
      : scenario === "long"
        ? "Retain the complete original guidance, the operator hold and the exact numbered evidence before continuing. ".repeat(
            30,
          )
        : "Preserve operator holds and retain exact review evidence.";
  const orders: StandingInstruction[] = Array.from({ length: count }, (_, i) => ({
    id: 10000 + i,
    seatId: null,
    kind: "text",
    by: "operator",
    text: `${i === 0 ? "" : `${i}: `}${text}`.slice(0, INSTRUCTION_TEXT_MAX),
    at: NOW - i * 60_000,
    revokedAt: null,
    source: "saved",
  }));
  const revoked: StandingInstruction = {
    id: 7,
    seatId: null,
    kind: "text",
    by: "operator",
    text: "Retained old order: keep its planning reference after revocation.",
    at: NOW - 86_400_000,
    revokedAt: NOW - 60_000,
    source: "saved",
  };
  const seatId = "guido-1";
  const active: StandingInstruction[] =
    count === 0
      ? []
      : [
          ...Array.from(
            { length: scenario === "many" ? 48 : 1 },
            (_, i): StandingInstruction => ({
              id: 1001 + i,
              seatId,
              kind: "text",
              by: i % 2 ? "operator" : "flight",
              text: scenario === "many" ? `Seat instruction ${i + 1}: ${text}` : text,
              at: NOW - 120_000 - i,
              revokedAt: null,
              source: "saved",
            }),
          ),
          ...(scenario === "one"
            ? []
            : [
                {
                  id: 1050,
                  seatId,
                  kind: "focus" as const,
                  focus: "label:cache",
                  by: "flight" as const,
                  at: NOW - 60_000,
                  revokedAt: null,
                  source: "saved" as const,
                },
                {
                  id: 1051,
                  seatId,
                  kind: "focus" as const,
                  focus: null,
                  by: "operator" as const,
                  at: NOW,
                  revokedAt: null,
                  source: "saved" as const,
                },
              ]),
        ];
  const imported: StandingInstruction = {
    id: 100,
    seatId,
    kind: "focus",
    focus: "label:legacy",
    by: "operator",
    at: NOW - 86_400_000,
    revokedAt: NOW - 120_000,
    source: "legacy-config",
  };
  const index: SeatInstructionIndex = {
    seats: Array.from({ length: scenario === "many" ? 50 : 1 }, (_, i) => ({
      seatId: `guido-${i + 1}`,
      active: active.map((entry) => ({
        ...entry,
        id: entry.id + i * 100,
        seatId: `guido-${i + 1}`,
      })),
      effectiveFocus: null,
      focusInstructionId: active.some((entry) => entry.kind === "focus") ? 1051 + i * 100 : null,
    })),
  };
  const api: Record<string, unknown> = {
    ...agent.api,
    "/api/flight/orders?limit=1": {
      active: orders,
      history: scenario === "empty" ? [] : [revoked],
      nextCursor: null,
    },
    "/api/flight/orders?limit=50": {
      active: orders,
      history: scenario === "empty" ? [] : [revoked],
      nextCursor: null,
    },
    "/api/flight/orders/7": revoked,
    "/api/flight/instructions": index,
    "/api/flight": {
      seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
      decisions: [],
      promptWakes: [],
      wake: { lastWakeAt: NOW, nextWakeAt: NOW + 30_000, wokeOn: ["instruction revision"] },
    },
    "/api/flight/summary": flightSummary(),
    "/api/flight/brief": { session: "s1", sections: [] },
    "/api/flight/incoming": { entries: [] },
    "/api/flight/schedule": { session: "s1", entries: [] },
    "/api/flight/ledger?status=open": { session: "s1", entries: [], more: false, nextOffset: null },
    "/api/flight/ledger?status=all": { session: "s1", entries: [] },
    "/api/notifications": { open: [], handledToday: [] },
    "/api/attention/held": [],
    "/api/drafts": [],
    "/api/drafts/history": [],
    "/api/prs/flow": { generatedAt: NOW, repos: [] },
    "/api/flight/memory?repo=shop-app": { notes: [] },
    "/api/flight/memory?repo=site-builder": { notes: [] },
  };
  for (const [i, seat] of index.seats.entries()) {
    api[`/api/seats/${seat.seatId}/instructions?limit=1`] = {
      ...seat,
      history: [{ ...imported, id: 100 + i, seatId: seat.seatId }],
      nextCursor: null,
    };
    api[`/api/seats/${seat.seatId}/instructions?limit=50`] = {
      ...seat,
      history: [{ ...imported, id: 100 + i, seatId: seat.seatId }],
      nextCursor: null,
    };
    api[`/api/seats/${seat.seatId}/focus`] = {
      focus: null,
      effectiveFocus: null,
      focusInstructionId: seat.focusInstructionId,
    };
  }
  return { api, orders, index };
}
