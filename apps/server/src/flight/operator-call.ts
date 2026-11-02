/**
 * `mc operator`'s transport (#1214): one request to the hub's own app, in process. The operator
 * token and the authenticated FLIGHT actor are added here. The route retains that provenance;
 * controller approvals never become anonymous operator calls.
 */
import { OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance } from "fastify";
import type { FlightToolsDeps } from "./tools.ts";

export const FLIGHT_OPERATOR_ACTOR_HEADER = "x-mc-flight-actor";

export function operatorCall(
  app: () => Pick<FastifyInstance, "inject"> | null,
  token: string,
): NonNullable<FlightToolsDeps["operator"]> {
  return async (req) => {
    const hub = app();
    if (hub === null) return { status: 503, body: '{"error":"the hub is starting"}' };
    const res = await hub.inject({
      method: req.method,
      url: req.path,
      headers: {
        [OPERATOR_HEADER]: token,
        "content-type": "application/json",
        ...(req.actor ? { [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify(req.actor) } : {}),
      },
      // a POST with no body still carries an empty object, as the HUD's own calls do
      ...(req.method === "POST" ? { payload: JSON.stringify(req.body ?? {}) } : {}),
    });
    return { status: res.statusCode, body: res.body };
  };
}
