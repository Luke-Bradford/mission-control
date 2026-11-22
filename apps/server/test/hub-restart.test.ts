import "./temp-home.ts";
import { resolve } from "node:path";
import { CONTROLLER_HEADER, OPERATOR_HEADER } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { buildApp, RESTART_OPERATOR_ONLY, RESTART_UNAVAILABLE } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const config = () => loadConfig(resolve(import.meta.dirname, "../../../config.example.yaml"));
const build = (restartHub?: () => void) =>
  buildApp({
    config: config(),
    store: new Store(":memory:"),
    operatorToken: "op",
    controllerToken: "ctl",
    bus: new ChangeBus(),
    restartHub,
  });
const post = (app: ReturnType<typeof build>, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/hub/restart", headers, payload: {} });

describe("POST /api/hub/restart", () => {
  it("the operator gets 202 and the restart runs once", async () => {
    const restartHub = vi.fn();
    const r = await post(build(restartHub), { [OPERATOR_HEADER]: "op" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ restarting: true });
    expect(restartHub).toHaveBeenCalledTimes(1);
  });

  it("a FLIGHT actor or the controller gets 403 and nothing runs", async () => {
    const restartHub = vi.fn();
    const app = build(restartHub);
    const flight = await post(app, {
      [OPERATOR_HEADER]: "op",
      "x-mc-flight-actor": JSON.stringify({ seatId: "flight-1", runId: "r" }),
    });
    expect(flight.statusCode).toBe(403);
    const ctl = await post(app, { [CONTROLLER_HEADER]: "ctl" });
    expect(ctl.statusCode).toBe(403);
    expect(ctl.json()).toEqual({ error: RESTART_OPERATOR_ONLY });
    expect(restartHub).not.toHaveBeenCalled();
  });

  it("answers 409 when the hub cannot restart itself", async () => {
    const r = await post(build(), { [OPERATOR_HEADER]: "op" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: RESTART_UNAVAILABLE });
  });
});
