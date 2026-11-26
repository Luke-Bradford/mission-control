import { OPERATOR_HEADER, SESSION_BUSY_TEXT, SESSION_TEXT_MAX, SESSIONS_OFF_TEXT } from "@mc/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../api.ts";
import { operatorTokenMatches } from "../operator.ts";
import { CmuxError } from "../runtime/cmux.ts";
import { OpenSessionArgs, SessionOpenError } from "./open.ts";
import { SessionError, type SessionsService } from "./sessions.ts";

const SendInput = z.strictObject({ text: z.string().min(1).max(SESSION_TEXT_MAX) });
const noBody = z.strictObject({}).optional();
/** Who a write from the page is logged as asked by. */
const PAGE_ASKER = "operator";

/**
 * The Sessions page's routes, registered inside /api. Every one needs the operator's token: they
 * read and write terminal sessions, the operator's own included. A seat's token is refused.
 */
export function registerSessionRoutes(api: FastifyInstance, deps: AppDeps): void {
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      !deps.operatorToken ||
      !operatorTokenMatches(deps.operatorToken, req.headers[OPERATOR_HEADER])
    )
      return reply.code(401).send({ error: "The operator token is required." });
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (bearer && deps.tokens?.resolve(bearer))
      return reply.code(403).send({ error: "A seat token cannot reach cmux sessions." });
    if (!deps.sessions) return reply.code(503).send({ error: SESSIONS_OFF_TEXT });
  };
  const sessions = () => deps.sessions as SessionsService;
  const failure = (error: unknown, reply: FastifyReply) => {
    if (error instanceof SessionError || error instanceof SessionOpenError)
      return reply.code(error.status).send({ error: error.message });
    if (error instanceof CmuxError) return reply.code(503).send({ error: error.message });
    throw error;
  };

  // Reader: docs/runbooks/cmux-sessions.md#the-sessions-page (every cmux workspace on this Mac)
  api.get("/sessions", { preHandler: auth }, async () => sessions().view());
  // Reader: docs/runbooks/cmux-sessions.md#opening-a-session (the New session form's choices)
  api.get("/sessions/roles", { preHandler: auth }, async () => sessions().roles());
  // Reader: docs/runbooks/cmux-sessions.md#opening-a-session (the New session button)
  api.post("/sessions", { preHandler: auth }, async (req, reply) => {
    const body = OpenSessionArgs.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({
        error: `Send a folder, a role and a first message of 1 to ${SESSION_TEXT_MAX} characters.`,
      });
    try {
      return reply.code(201).send(await sessions().open(body.data, PAGE_ASKER));
    } catch (error) {
      return failure(error, reply);
    }
  });
  // Reader: docs/runbooks/cmux-sessions.md#the-sessions-page (a row click brings it to the front)
  api.post<{ Params: { id: string } }>(
    "/sessions/:id/focus",
    { preHandler: auth },
    async (req, reply) => {
      if (!noBody.safeParse(req.body).success)
        return reply.code(400).send({ error: "Send an empty object." });
      try {
        await sessions().focus(req.params.id);
        return { ok: true };
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  // Reader: docs/runbooks/cmux-sessions.md#the-sessions-page (the row's Write box)
  api.post<{ Params: { id: string } }>(
    "/sessions/:id/send",
    { preHandler: auth },
    async (req, reply) => {
      const body = SendInput.safeParse(req.body);
      if (!body.success || body.data.text.trim() === "")
        return reply.code(400).send({ error: `Write 1 to ${SESSION_TEXT_MAX} characters.` });
      try {
        const sent = await sessions().send(req.params.id, body.data.text, PAGE_ASKER);
        if (sent === "busy") return reply.code(409).send({ error: SESSION_BUSY_TEXT });
        return { ok: true };
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  // Reader: docs/runbooks/cmux-sessions.md#the-sessions-page (the App cell opens its browser view)
  api.post<{ Params: { id: string } }>(
    "/sessions/:id/app",
    { preHandler: auth },
    async (req, reply) => {
      if (!noBody.safeParse(req.body).success)
        return reply.code(400).send({ error: "Send an empty object." });
      try {
        await sessions().openApp(req.params.id, PAGE_ASKER);
        return { ok: true };
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
}
