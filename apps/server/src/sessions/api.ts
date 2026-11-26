import {
  CMUX_WORKSPACE_ID,
  OPERATOR_HEADER,
  SESSION_BUSY_TEXT,
  SESSION_CHECK_COMMAND_MAX,
  SESSION_CHECK_COMMANDS_MAX,
  SESSION_CREW_CHECKS_TEXT,
  SESSION_NO_CHECKS_TEXT,
  SESSION_TEXT_MAX,
  SESSION_UNKNOWN_TEXT,
  SESSIONS_CMUX_WRITES_SETTING,
  SESSIONS_OFF_TEXT,
} from "@mc/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../api.ts";
import { checkCommand } from "../engine/rule-config.ts";
import { operatorTokenMatches } from "../operator.ts";
import { CmuxError } from "../runtime/cmux.ts";
import { type SessionChecks, SessionChecksError } from "./checks.ts";
import { OpenSessionArgs, SessionOpenError } from "./open.ts";
import { SessionError, type SessionsService } from "./sessions.ts";

const SendInput = z.strictObject({ text: z.string().min(1).max(SESSION_TEXT_MAX) });
const SidebarInput = z.strictObject({ on: z.boolean() });
const noBody = z.strictObject({}).optional();
const AppAction = z.enum(["start", "stop"]);
const RepoChecksInput = z.strictObject({
  repo: z.string().min(1).max(4096),
  on: z.boolean().optional(),
  commands: z
    .array(checkCommand.pipe(z.string().max(SESSION_CHECK_COMMAND_MAX)))
    .max(SESSION_CHECK_COMMANDS_MAX)
    .optional(),
});
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
  const checks = (reply: FastifyReply): SessionChecks | null => {
    if (deps.sessionChecks) return deps.sessionChecks;
    reply.code(503).send({ error: SESSIONS_OFF_TEXT });
    return null;
  };
  const failure = (error: unknown, reply: FastifyReply) => {
    if (
      error instanceof SessionError ||
      error instanceof SessionOpenError ||
      error instanceof SessionChecksError
    )
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
  // Reader: apps/web/src/pages/Sessions.tsx (the app workspace Start and Stop controls)
  api.get("/sessions/apps", { preHandler: auth }, async () => deps.crewApps?.view() ?? []);
  // Reader: apps/web/src/pages/Sessions.tsx (the app workspace Start and Stop controls)
  api.post<{ Params: { repo: string; action: "start" | "stop" } }>(
    "/sessions/apps/:repo/:action",
    { preHandler: auth },
    async (req, reply) => {
      if (!noBody.safeParse(req.body).success)
        return reply.code(400).send({ error: "Send an empty object." });
      const action = AppAction.safeParse(req.params.action);
      if (!action.success) return reply.code(404).send({ error: "No app action has that name." });
      if (!deps.crewApps) return reply.code(503).send({ error: SESSIONS_OFF_TEXT });
      const found = deps.crewApps.view().some((app) => app.id === req.params.repo);
      if (!found) return reply.code(404).send({ error: "No configured app has that repository." });
      try {
        await deps.crewApps[action.data](req.params.repo);
        return { ok: true };
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
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
  // Reader: docs/runbooks/cmux-sessions.md#repo-checks (the row's Run checks)
  api.post<{ Params: { id: string } }>(
    "/sessions/:id/checks",
    { preHandler: auth },
    async (req, reply) => {
      if (!noBody.safeParse(req.body).success)
        return reply.code(400).send({ error: "Send an empty object." });
      if (!CMUX_WORKSPACE_ID.test(req.params.id))
        return reply.code(404).send({ error: SESSION_UNKNOWN_TEXT });
      const service = checks(reply);
      if (service === null) return reply;
      try {
        const ran = await service.run(req.params.id);
        if (ran === "no-checks") return reply.code(400).send({ error: SESSION_NO_CHECKS_TEXT });
        if (ran === "crew") return reply.code(400).send({ error: SESSION_CREW_CHECKS_TEXT });
        return { ok: true };
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  // Reader: docs/runbooks/cmux-sessions.md#repo-checks (a repo's switch and its page commands)
  api.post("/sessions/checks", { preHandler: auth }, async (req, reply) => {
    const body = RepoChecksInput.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({
        error: `Send { repo, on?, commands? }: at most ${SESSION_CHECK_COMMANDS_MAX} commands, each one plain command (no &&, |, ; or line break) of at most ${SESSION_CHECK_COMMAND_MAX} characters.`,
      });
    const service = checks(reply);
    if (service === null) return reply;
    try {
      const { repo, ...change } = body.data;
      service.setRepo(repo, change, PAGE_ASKER);
      return { ok: true };
    } catch (error) {
      return failure(error, reply);
    }
  });
}
