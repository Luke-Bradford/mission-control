import { type InstructionAuthor, OPERATOR_HEADER, type StandingInstructionInput } from "@mc/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../api.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../flight/operator-call.ts";
import { seatFocus } from "../focus.ts";
import { operatorTokenMatches } from "../operator.ts";
import { announceInstruction } from "./notices.ts";
import { InstructionError, InstructionInput, OrderInput } from "./standing.ts";

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const query = z.strictObject({
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const noBody = z.strictObject({});
/** Registered inside /api; common hooks validate a declared actor before any route work. */
export function registerInstructionRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;
  const seats = () => config.crew?.sessions.flatMap((s) => s.seats) ?? [];
  for (const seat of seats()) store.instructions.syncFocus(seat, now());
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      !deps.operatorToken ||
      !operatorTokenMatches(deps.operatorToken, req.headers[OPERATOR_HEADER])
    )
      return reply.code(401).send({ error: "The operator token is required." });
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (bearer && deps.tokens?.resolve(bearer))
      return reply.code(403).send({ error: "A seat token cannot author operator instructions." });
  };
  const by = (req: FastifyRequest): InstructionAuthor =>
    req.headers[FLIGHT_OPERATOR_ACTOR_HEADER] === undefined ? "operator" : "flight";
  const failure = (error: unknown, reply: FastifyReply) => {
    if (error instanceof InstructionError)
      return reply.code(error.status).send({ error: error.message });
    throw error;
  };
  const target = (seatId: string) => {
    const seat = seats().find((s) => s.id === seatId);
    if (!seat) throw new InstructionError(404, "Seat unavailable.");
    return seat;
  };
  const announce = (result: Parameters<typeof announceInstruction>[1]) =>
    announceInstruction({ config, store, bus, supervisor: deps.supervisor, now }, result);
  // Reader: apps/web/src/flight/KnowsTab.tsx (planned #1378 active and revoked global orders)
  api.get("/flight/orders", async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Use a positive history cursor and limit from 1 to 100." });
    return store.instructions.list(null, parsed.data.before, parsed.data.limit);
  });
  // Reader: apps/web/src/flight/DidTab.tsx (planned #1378 exact retained order behind a re-plan)
  api.get<{ Params: { id: string } }>("/flight/orders/:id", async (req, reply) => {
    const parsed = id.safeParse(req.params.id);
    const entry = parsed.success ? store.instructions.get(parsed.data) : null;
    if (!entry || entry.seatId !== null)
      return reply.code(404).send({ error: "Order unavailable." });
    return entry;
  });
  // Reader: apps/web/src/flight/KnowsTab.tsx (planned #1378 operator add/replace order action)
  api.post("/flight/orders", { preHandler: auth }, async (req, reply) => {
    // Presence is immutable declared provenance even if its run ended during body parsing.
    if (by(req) === "flight")
      return reply.code(403).send({ error: "Only the operator can save a global order." });
    const body = OrderInput.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({
        error: "Use nonempty order text, at most 4000 characters, and an optional replacement ID.",
      });
    try {
      return await announce(
        store.instructions.create(null, { kind: "text", ...body.data }, "operator", now()),
      );
    } catch (error) {
      return failure(error, reply);
    }
  });
  // Reader: apps/web/src/flight/KnowsTab.tsx (planned #1378 operator revoke order action)
  api.post<{ Params: { id: string } }>(
    "/flight/orders/:id/revoke",
    { preHandler: auth },
    async (req, reply) => {
      if (by(req) === "flight")
        return reply.code(403).send({ error: "Only the operator can revoke a global order." });
      const parsed = id.safeParse(req.params.id);
      if (!parsed.success || !noBody.safeParse(req.body).success)
        return reply.code(400).send({ error: "Use an order ID and an empty object." });
      try {
        return await announce(store.instructions.revoke(parsed.data, null, "operator", now()));
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  // Reader: apps/web/src/flight/CrewBoardTab.tsx (planned #1378 named-seat instruction index)
  api.get("/flight/instructions", async () => ({
    seats: seats().map((seat) => {
      store.instructions.syncFocus(seat, now());
      return {
        seatId: seat.id,
        active: store.instructions.active(seat.id),
        ...store.instructions.focus(seat.id),
      };
    }),
  }));
  // Reader: apps/web/src/pages/Agent.tsx (planned #1378 active and revoked seat instructions)
  api.get<{ Params: { id: string } }>("/seats/:id/instructions", async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Use a positive history cursor and limit from 1 to 100." });
    try {
      store.instructions.syncFocus(target(req.params.id), now());
      return store.instructions.seat(req.params.id, parsed.data.before, parsed.data.limit);
    } catch (error) {
      return failure(error, reply);
    }
  });
  // Reader: apps/web/src/pages/Agent.tsx (planned #1378 operator add/replace seat instruction action)
  api.post<{ Params: { id: string } }>(
    "/seats/:id/instructions",
    { preHandler: auth },
    async (req, reply) => {
      const parsed = InstructionInput.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Use instruction text or valid focus selectors and an optional replacement ID.",
        });
      try {
        target(req.params.id);
        return await announce(
          store.instructions.create(
            req.params.id,
            parsed.data as StandingInstructionInput,
            by(req),
            now(),
          ),
        );
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  // Reader: apps/web/src/pages/Agent.tsx (planned #1378 operator revoke seat instruction action)
  api.post<{ Params: { id: string; instructionId: string } }>(
    "/seats/:id/instructions/:instructionId/revoke",
    { preHandler: auth },
    async (req, reply) => {
      const parsed = id.safeParse(req.params.instructionId);
      if (!parsed.success || !noBody.safeParse(req.body).success)
        return reply.code(400).send({ error: "Use an instruction ID and an empty object." });
      try {
        target(req.params.id);
        return await announce(
          store.instructions.revoke(parsed.data, req.params.id, by(req), now()),
        );
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  // Kept wire-compatible with the delivered Queue focus editor.
  // Reader: apps/web/src/agent/SideTabs.tsx (existing Queue focus reader)
  api.get<{ Params: { id: string } }>("/seats/:id/focus", async (req, reply) => {
    try {
      store.instructions.syncFocus(target(req.params.id), now());
      const focus = store.instructions.focus(req.params.id);
      return { focus: focus.effectiveFocus, ...focus };
    } catch (error) {
      return failure(error, reply);
    }
  });
  // Reader: apps/web/src/agent/SideTabs.tsx (existing Queue focus save/clear action)
  api.post<{ Params: { id: string } }>(
    "/seats/:id/focus",
    { preHandler: auth },
    async (req, reply) => {
      const parsed = z.strictObject({ focus: seatFocus }).safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "Use valid focus selectors or null to clear." });
      try {
        target(req.params.id);
        const result = await announce(
          store.instructions.create(
            req.params.id,
            { kind: "focus", ...parsed.data },
            by(req),
            now(),
          ),
        );
        return { focus: result.effectiveFocus, ...result };
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
}
