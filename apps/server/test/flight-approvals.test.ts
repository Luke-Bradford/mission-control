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
