import { FLIGHT_APPROVAL_RULES, OPERATOR_HEADER } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import {
  findApproval,
  grantApproval,
  mergeFloorApproval,
  mergeFloorScope,
  useApproval,
} from "../src/flight-approvals.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const NOW = Date.now();
const SHA = "a".repeat(40);
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
const TOKEN = "op-token";
const json = { "content-type": "application/json" };

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close?.());

describe("POST /api/flight/approvals", () => {
  const app = () => buildApp({ config, store, bus: new ChangeBus(), operatorToken: TOKEN });
  const post = (a: ReturnType<typeof app>, payload: object, token: string | null = TOKEN) =>
    a.inject({
      method: "POST",
      url: "/api/flight/approvals",
      headers: { ...json, ...(token === null ? {} : { [OPERATOR_HEADER]: token }) },
      payload,
    });
  const body = (over: object = {}) => ({
    rule: "merge-floor",
    scope: mergeFloorScope(12, SHA.slice(0, 12)),
    until: new Date(Date.now() + 3_600_000).toISOString(),
    reason: "read the workflow change",
    ...over,
  });

  it("needs the operator token", async () => {
    const a = app();
    expect((await post(a, body(), null)).statusCode).toBe(401);
    expect((await post(a, body(), "wrong")).statusCode).toBe(401);
    expect(store.getSetting("flight.approvals")).toBeNull();
    await a.close();
  });

  it("records a grant and puts it on the ledger", async () => {
    const a = app();
    const r = await post(a, body());
    expect(r.statusCode).toBe(200);
    expect(mergeFloorApproval(store, 12, SHA, Date.now())?.id).toBe(r.json().id);
    expect(store.flightDecisions(0, 10)).toEqual([
      expect.objectContaining({ kind: "approval", basis: "read the workflow change" }),
    ]);
    await a.close();
  });

  it.each([
    ["an unknown rule", { rule: "everything" }],
    ["no reason", { reason: " " }],
    ["a past time", { until: new Date(Date.now() - 1000).toISOString() }],
    ["a window over seven days", { until: new Date(Date.now() + 8 * 86_400_000).toISOString() }],
    ["an extra field", { sneaky: true }],
  ])("refuses %s", async (_name, over) => {
    const a = app();
    expect((await post(a, body(over))).statusCode).toBe(400);
    expect(store.getSetting("flight.approvals")).toBeNull();
    await a.close();
  });

  it("lists every rule the guard or the merge gate can be approved past", () => {
    expect(FLIGHT_APPROVAL_RULES).toEqual(["merge-floor", "repo-rules", "merge-push"]);
  });
});

describe("a seat's run token on the operator's routes (#1214)", () => {
  const SEAT = "flight-1";
  const setup = () => {
    const tokens = new RunTokens();
    const seatToken = tokens.issue(SEAT, "run-f");
    const app = buildApp({ config, store, bus: new ChangeBus(), operatorToken: TOKEN, tokens });
    return { app, seatToken };
  };
  const bootstrap = { "sec-fetch-site": "same-origin" };
  const opHeader = { [OPERATOR_HEADER]: TOKEN };

  it("refuses the token's bootstrap route to a request carrying a seat's token, and serves it without", async () => {
    const { app, seatToken } = setup();
    const refused = await app.inject({
      url: "/api/operator/bootstrap",
      headers: { ...bootstrap, authorization: `Bearer ${seatToken}` },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain(TOKEN);
    const page = await app.inject({ url: "/api/operator/bootstrap", headers: bootstrap });
    expect(page.statusCode).toBe(200);
    await app.close();
  });

  it("refuses approvals and the breaker's lift to a seat even with the operator token, and allows the operator", async () => {
    const { app, seatToken } = setup();
    const body = {
      rule: "repo-rules",
      scope: "x",
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "r",
    };
    const seatCall = (url: string, payload: object) =>
      app.inject({
        method: "POST",
        url,
        headers: {
          ...opHeader,
          authorization: `Bearer ${seatToken}`,
          "content-type": "application/json",
        },
        payload,
      });
    expect((await seatCall("/api/flight/approvals", body)).statusCode).toBe(403);
    expect((await seatCall("/api/flight/runaway/lift", {})).statusCode).toBe(403);
    expect((await seatCall("/api/attention/note:flight-runaway/dismiss", {})).statusCode).toBe(403);
    expect(store.getSetting("flight.approvals")).toBeNull();
    const operator = await app.inject({
      method: "POST",
      url: "/api/flight/approvals",
      headers: { ...opHeader, "content-type": "application/json" },
      payload: body,
    });
    expect(operator.statusCode).toBe(200);
    await app.close();
  });

  it("still needs the operator token on those routes for a request with no seat token", async () => {
    const { app } = setup();
    const noToken = await app.inject({
      method: "POST",
      url: "/api/flight/runaway/lift",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(noToken.statusCode).toBe(401);
    await app.close();
  });
});

describe("approvals", () => {
  const grant = (over: Partial<Parameters<typeof grantApproval>[1]> = {}) =>
    grantApproval(
      store,
      {
        rule: "repo-rules",
        scope: "git push origin main",
        until: NOW + 1000,
        reason: "r",
        ...over,
      },
      NOW,
    );

  it("finds an open grant by rule and exact scope only", () => {
    grant();
    expect(findApproval(store, "repo-rules", "git push origin main", NOW)).toBeDefined();
    expect(findApproval(store, "merge-push", "git push origin main", NOW)).toBeUndefined();
    expect(findApproval(store, "repo-rules", "git push origin main ", NOW)).toBeUndefined();
    expect(findApproval(store, "repo-rules", "git push origin main", NOW + 1000)).toBeUndefined();
  });

  it("is used up by the call it lets through", () => {
    const a = grant();
    useApproval(store, a.id, NOW);
    expect(findApproval(store, "repo-rules", a.scope, NOW)).toBeUndefined();
  });

  it("keeps a bounded number of grants", () => {
    for (let i = 0; i < 250; i++) grant({ scope: `s${i}` });
    expect(JSON.parse(store.getSetting("flight.approvals") ?? "[]")).toHaveLength(200);
  });
});
