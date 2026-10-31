/**
 * `mc operator`'s transport (#1214): one request to the hub's own app, in process. The operator
 * token is added here, so FLIGHT never holds it and no network is crossed; the route's own checks
 * run as for the operator.
 */
import { OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance } from "fastify";
import type { FlightToolsDeps } from "./tools.ts";

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
      headers: { [OPERATOR_HEADER]: token, "content-type": "application/json" },
      // a POST with no body still carries an empty object, as the HUD's own calls do
      ...(req.method === "POST" ? { payload: JSON.stringify(req.body ?? {}) } : {}),
    });
    return { status: res.statusCode, body: res.body };
  };
}
