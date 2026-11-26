import "./temp-home.ts";
import { resolve } from "node:path";
import { COMMS_CAPCOM, FLIGHT_MODE_SETTING, OPERATOR_HEADER } from "@mc/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, loadConfig } from "../src/config.ts";
import { seatMayTake } from "../src/engine/queue.ts";
import {
  deliversToFlight,
  operatorOnlyFacts,
  readFlightMode,
  writeFlightMode,
} from "../src/flight/mode.ts";
import { flightState, wakeFacts } from "../src/flight/state.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const T0 = Date.parse("2026-11-25T12:00:00Z");
const base = (): CcConfig =>
  loadConfig(resolve(import.meta.dirname, "../../../config.example.yaml"));
const withFlight = (): CcConfig => ({
  ...base(),
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 4,
    sessions: [
      {
        id: "s1",
        repoId: base().repos[0]?.id ?? "shop-app",
        checkout: "/tmp/none/clone",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "opus", area: [] },
        ],
      },
    ],
  },
});

const op = { [OPERATOR_HEADER]: "op", "content-type": "application/json" };

describe("FLIGHT's mode setting", () => {
  it("the mode is read live from the setting", async () => {
    const store = new Store(":memory:");
    const bus = new ChangeBus();
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const tokens = new RunTokens();
    const app = buildApp({
      config: base(),
      store,
      bus,
      operatorToken: "op",
      tokens,
      now: () => T0,
    });
    const get = () => app.inject({ method: "GET", url: "/api/settings/flight-mode", headers: op });
    const post = (body: object, headers: Record<string, string> = op) =>
      app.inject({ method: "POST", url: "/api/settings/flight-mode", headers, payload: body });

    expect((await get()).json()).toEqual({ mode: "crew" });
    expect(seatMayTake(store, "guido-1")).toBe(true);

    const set = await post({ mode: "watch" });
    expect(set.statusCode).toBe(200);
    expect((await get()).json()).toEqual({ mode: "watch" });
    expect(seatMayTake(store, "guido-1")).toBe(false);
    expect(events).toEqual(expect.arrayContaining(["settings", "agents"]));
    expect(store.hubEvents(0).map((e) => e.text)).toContain("FLIGHT mode set to Watch by operator");

    expect((await post({ mode: "asleep" })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
    expect(readFlightMode(store)).toBe("watch");

    const seat = tokens.issue("guido-1", "r-guido");
    const refused = await post(
      { mode: "crew" },
      { authorization: `Bearer ${seat}`, "content-type": "application/json" },
    );
    expect(refused.statusCode).toBe(403);
    expect(readFlightMode(store)).toBe("watch");
    await app.close();
  });

  it("an unreadable stored mode reads as crew", () => {
    const store = new Store(":memory:");
    store.setSetting(FLIGHT_MODE_SETTING, "nonsense");
    expect(readFlightMode(store)).toBe("crew");
    writeFlightMode(store, "on-call", "FLIGHT for comms:4", T0);
    expect(readFlightMode(store)).toBe("on-call");
  });

  it("outside crew only the operator's message reaches FLIGHT", () => {
    const store = new Store(":memory:");
    const config = withFlight();
    store.setSetting(FLIGHT_MODE_SETTING, "on-call");
    expect(deliversToFlight(store, config, "flight-1", "guido-1")).toBe(false);
    expect(deliversToFlight(store, config, "flight-1", COMMS_CAPCOM)).toBe(true);
    // other seats still take their messages
    expect(deliversToFlight(store, config, "guido-1", "flight-1")).toBe(true);
  });

  it("operatorOnlyFacts keeps the operator's messages, what is owed, and the breaker", () => {
    const facts = JSON.stringify({
      q: [1],
      signals: ["seat-call:x"],
      operator: ["9"],
      owed: ["8"],
      items: ["k"],
      breaker: [],
    });
    expect(JSON.parse(operatorOnlyFacts(facts))).toEqual({
      operator: ["9"],
      owed: ["8"],
      breaker: [],
    });
  });

  it("crew mode changes nothing", () => {
    const store = new Store(":memory:");
    const config = withFlight();
    const state = flightState({ config, store, busy: [], now: T0 });
    expect(state.mode).toBeUndefined();
    expect(deliversToFlight(store, config, "flight-1", "guido-1")).toBe(true);
    const wake = wakeFacts(state);
    store.setSetting(FLIGHT_MODE_SETTING, "crew");
    expect(wakeFacts(flightState({ config, store, busy: [], now: T0 }))).toBe(wake);
    store.setSetting(FLIGHT_MODE_SETTING, "watch");
    expect(flightState({ config, store, busy: [], now: T0 }).mode).toBe("watch");
  });
});
