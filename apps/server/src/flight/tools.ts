/**
 * FLIGHT's mc tools. Each is hidden from every seat whose role does not grant it (`modes: []`,
 * `grantable: ["read-only"]`) and re-checks the run and the seat's loop on every call, so a token
 * from another seat gets nothing. Tickets 2 and 3 add their tools to `createFlightTools`.
 */
import {
  capText,
  FLIGHT_ABOUT_MAX,
  FLIGHT_BASIS_MAX,
  FLIGHT_DECISION_MAX,
  FLIGHT_HOUR_MS,
  FLIGHT_NOTED,
  FLIGHT_NOTES_PER_HOUR,
  type FlightDecisionKind,
  MC_FLIGHT_ONLY,
  MC_RUN_ENDED,
  MC_TOOL_NAMES,
  notInSessionText,
  type TicketView,
} from "@mc/core";
import { z } from "zod";
import type { ChangeBus } from "../bus.ts";
import { type CcConfig, crewSeatDef, SEAT_ID } from "../config.ts";
import type { Engine } from "../engine/engine.ts";
import type { McTool, McToolContext } from "../mcp/server.ts";
import { badArgs, text } from "../mcp/tools.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import { flightSeat } from "./state.ts";

export interface FlightToolsDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  supervisor: Pick<Supervisor, "message" | "busy" | "startRun">;
  engine: Pick<Engine, "onOperatorMessage" | "status"> | null;
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  now?: () => number;
}

type Result = { text: string; isError?: boolean };

/** A decision text stored cut to `max`, ending `…` when it was cut. */
export const cut = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const LogDecisionArgs = z.strictObject({
  seat: z.string().regex(SEAT_ID).optional(),
  about: text(FLIGHT_ABOUT_MAX),
  decision: text(FLIGHT_DECISION_MAX),
  basis: text(FLIGHT_BASIS_MAX),
});

/**
 * What every FLIGHT tool checks first: the arguments (strict zod), that the token's run is its
 * seat's unended run, and that the seat's loop is `watch`. Returns the parsed arguments, or the
 * refusal to give.
 */
export function flightCall<S extends z.ZodType>(
  deps: Pick<FlightToolsDeps, "config" | "store">,
  ctx: McToolContext,
  schema: S,
  args: unknown,
): { ok: true; args: z.output<S> } | { ok: false; result: Result } {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { ok: false, result: badArgs(parsed.error) };
  const row = deps.store.seatSession(ctx.seatId);
  const run = deps.store.run(ctx.runId);
  if (row?.runId !== ctx.runId || run === null || run.endedAt !== null) {
    return { ok: false, result: { text: MC_RUN_ENDED, isError: true } };
  }
  if (crewSeatDef(deps.config, ctx.seatId).loop !== "watch") {
    return { ok: false, result: { text: MC_FLIGHT_ONLY, isError: true } };
  }
  return { ok: true, args: parsed.data };
}

/** Each tool: `modes: []`, `grantable: ["read-only"]`, so #222's grant filter shows it only to FLIGHT. */
export function createFlightTools(deps: FlightToolsDeps): McTool[] {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;

  async function logDecision(ctx: McToolContext, args: unknown): Promise<Result> {
    const c = flightCall(deps, ctx, LogDecisionArgs, args);
    if (!c.ok) return c.result;
    const { seat, about, decision, basis } = c.args;
    if (seat !== undefined) {
      const mine = flightSeat(config)?.session.seats.some((s) => s.id === seat) === true;
      if (!mine) return { text: notInSessionText(seat), isError: true };
    }
    const at = now();
    const kinds: FlightDecisionKind[] = ["note"];
    const n = store.countFlightDecisions({ kinds, since: at - FLIGHT_HOUR_MS });
    if (n >= FLIGHT_NOTES_PER_HOUR) {
      return { text: capText("logged notes", n), isError: true };
    }
    store.addFlightDecision({
      at,
      kind: "note",
      seatId: seat ?? null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: cut(about, FLIGHT_ABOUT_MAX),
      decision: cut(decision, FLIGHT_DECISION_MAX),
      basis: cut(basis, FLIGHT_BASIS_MAX),
    });
    bus.emit("flight");
    return { text: FLIGHT_NOTED };
  }

  return [
    {
      name: MC_TOOL_NAMES.logDecision,
      description:
        "Record a decision that no other tool recorded, with its basis: a ticket you held back, a question you left to the operator, the PRs ready for review.",
      inputSchema: {
        type: "object",
        properties: {
          seat: {
            type: "string",
            description: "The seat the decision is about, if one (e.g. guido-1).",
          },
          about: { type: "string", minLength: 1, maxLength: FLIGHT_ABOUT_MAX },
          decision: { type: "string", minLength: 1, maxLength: FLIGHT_DECISION_MAX },
          basis: { type: "string", minLength: 1, maxLength: FLIGHT_BASIS_MAX },
        },
        required: ["about", "decision", "basis"],
        additionalProperties: false,
      },
      modes: [],
      grantable: ["read-only"],
      call: logDecision,
    },
  ];
}
