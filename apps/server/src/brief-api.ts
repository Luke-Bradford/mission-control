import { type BriefActor, OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "./api.ts";
import { type BriefChoiceDeps, chooseBrief } from "./brief-choices.ts";
import { briefActionRoute, withinBriefDispatch } from "./brief-dispatch.ts";
import { BriefActionRefused, BriefError } from "./brief-prepare.ts";
import { dispatchRoutineBriefAction } from "./brief-routine.ts";
import { BriefChoiceInput } from "./brief-schema.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "./flight/operator-call.ts";
import { attentionItems, NO_LOCK } from "./hud.ts";
import { prepareQueueReorderSnapshot } from "./queue-reorder.ts";

/** Only this bound path installs dispatch guards; existing direct routes keep their contracts. */
export function registerBriefChoiceRoutes(
  api: FastifyInstance,
  app: FastifyInstance,
  deps: AppDeps,
  actorOf: (request: FastifyRequest) => BriefActor | null,
): void {
  // Reader: docs/superpowers/plans/2026-11-03-complete-briefs-759/published-web-child.md (#1390 adds the web buttons)
  api.post<{ Params: { key: string } }>("/attention/:key/choice", async (request, reply) => {
    const parsed = BriefChoiceInput.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    if (deps.noLoopWrites)
      return reply.code(409).send({ error: "Loop writes are disabled on this preview." });
    const declared = request.headers[FLIGHT_OPERATOR_ACTOR_HEADER];
    const actor = declared === undefined ? { operator: true as const } : actorOf(request);
    if (!actor)
      return reply.code(403).send({ error: "The declared FLIGHT actor is no longer current." });
    const now = deps.now ?? Date.now;
    const queue = deps.queueReorder;
    const choices: BriefChoiceDeps = {
      config: deps.config,
      store: deps.store,
      now,
      bus: deps.bus,
      prepareQueue: queue
        ? (seat, move, above) => prepareQueueReorderSnapshot(queue, seat, move, above)
        : undefined,
      item: (key) =>
        attentionItems(
          deps.config,
          deps.store,
          now(),
          deps.lock?.state() ?? NO_LOCK,
          undefined,
          deps.hubLogin?.() ?? null,
          true,
        ).find((item) => item.key === key),
      dispatch: async (action, input, context) => {
        const route = briefActionRoute(action, request.params.key, input);
        const routine = await dispatchRoutineBriefAction(
          {
            ...choices,
            supervisor: deps.supervisor,
            queue,
            knownSecrets: deps.knownSecrets ?? (async () => []),
            bus: deps.bus,
            reconcileRun: deps.engine?.reconcileRun?.bind(deps.engine),
          },
          action,
          input,
          context,
        );
        if (routine !== null) return routine;
        if (!route) throw new BriefError(400, "No typed action adapter exists for this choice.");
        context.beforeWrite();
        // Forward immutable declared provenance, not a post-await re-resolution that could turn an
        // ended FLIGHT actor into an anonymous operator. All original route auth still executes.
        const token = request.headers[OPERATOR_HEADER];
        const response = await withinBriefDispatch(
          context.beforeWrite,
          () =>
            app.inject({
              method: "POST",
              url: route.path,
              payload: route.body,
              headers: {
                "content-type": "application/json",
                ...(typeof token === "string" ? { [OPERATOR_HEADER]: token } : {}),
                ...(typeof declared === "string"
                  ? { [FLIGHT_OPERATOR_ACTOR_HEADER]: declared }
                  : {}),
              },
            }),
          context.brief.binding?.epoch,
        );
        let body: { error?: string; text?: string } = {};
        try {
          body = response.json();
        } catch {
          /* An unreadable result is not a successful receipt. */
        }
        if ([400, 401, 403, 404, 409].includes(response.statusCode))
          throw new BriefActionRefused(
            response.statusCode,
            body.error ?? "The original route refused this actor.",
          );
        if (response.statusCode >= 400)
          throw new BriefError(
            response.statusCode,
            body.error ?? body.text ?? "The existing action handler refused this choice.",
          );
        const effect = context.brief.binding?.actions.find(
          (entry) => entry.optionId === context.optionId,
        )?.effect;
        deps.bus.emit("attention");
        return body.text ?? `${effect ?? "Typed action completed"}.`;
      },
    };
    try {
      const receipt = await chooseBrief(choices, request.params.key, parsed.data, actor);
      deps.bus.emit("attention");
      return reply
        .code(
          receipt.state === "applied"
            ? 200
            : receipt.state === "refused"
              ? (receipt.status ?? 409)
              : (receipt.status ?? 202),
        )
        .send(receipt);
    } catch (error) {
      if (error instanceof BriefError)
        return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
