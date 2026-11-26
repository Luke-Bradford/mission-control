import {
  OPERATOR_HEADER,
  SESSION_BUSY_TEXT,
  SESSION_TEXT_MAX,
  SESSIONS_CMUX_WRITES_SETTING,
  SESSIONS_OFF_TEXT,
} from "@mc/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../api.ts";
import { operatorTokenMatches } from "../operator.ts";
import { CmuxError } from "../runtime/cmux.ts";
import { SessionError, type SessionsService } from "./sessions.ts";

const SendInput = z.strictObject({ text: z.string().min(1).max(SESSION_TEXT_MAX) });
const SidebarInput = z.strictObject({ on: z.boolean() });
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
    if (error instanceof SessionError)
      return reply.code(error.status).send({ error: error.message });
    if (error instanceof CmuxError) return reply.code(503).send({ error: error.message });
    throw error;
  };

  // Reader: docs/runbooks/cmux-sessions.md#the-cmux-sidebar (the Sessions page switch)
  api.get("/sessions/sidebar", { preHandler: auth }, async () => ({
    on: deps.store.getSetting(SESSIONS_CMUX_WRITES_SETTING) !== "off",
  }));
  // Reader: apps/web/src/pages/Sessions.tsx (the Write to cmux switch)
  api.post("/sessions/sidebar", { preHandler: auth }, async (req, reply) => {
    const body = SidebarInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Send on as true or false." });
    deps.store.setSetting(SESSIONS_CMUX_WRITES_SETTING, body.data.on ? "on" : "off");
    if (body.data.on) deps.onSessionSidebarChange?.(true);
    deps.store.addHubEvent(
      `cmux writes turned ${body.data.on ? "on" : "off"} by operator`,
      Date.now(),
    );
    return { on: body.data.on };
  });

  // Reader: docs/runbooks/cmux-sessions.md#the-sessions-page (every cmux workspace on this Mac)
  api.get("/sessions", { preHandler: auth }, async () => sessions().view());
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
