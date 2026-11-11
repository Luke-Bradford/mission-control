import { COMMS_CONTROLLER } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendComms } from "../src/comms.ts";
import type { CcConfig } from "../src/config.ts";
import { applyDecisionDefaults } from "../src/decision-defaults.ts";
import { Store } from "../src/store.ts";

vi.mock("../src/hud.ts", async (original) => ({
  ...(await original<typeof import("../src/hud.ts")>()),
  attentionItems: () => [
    { key: "d1", acked: false, agentId: null, ticket: "repo#1", text: "Proceed?", brief: null },
  ],
}));
vi.mock("../src/attention/holds.ts", async (original) => ({
  ...(await original<typeof import("../src/attention/holds.ts")>()),
  decisionDefault: () => ({
    option: { id: "go", label: "Go", answer: "Proceed." },
    briefAt: 1,
    dueAt: 1,
  }),
}));

const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "repo-1",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("hub-written messages are the hub's, even with a FLIGHT seat configured", () => {
  it("does not manufacture a hub message from an unbound legacy default", async () => {
    expect(await applyDecisionDefaults({ config, store, now: 10 })).toBe(0);
    expect(store.commsMessage("comms:1")).toBeNull();
  });

  const deps = (senderKind: "hub" | "seat" | "controller" | "flight") => ({
    store,
    crew: () => ["GUIDO-1", "FLIGHT-1"],
    knownSecrets: async () => [],
    senderKind,
  });

  it("refuses a hub message sent as CAPCOM", async () => {
    await expect(sendComms(deps("hub"), "CAPCOM", { to: "GUIDO-1", text: "x" })).rejects.toThrow(
      "Only the operator sends as CAPCOM",
    );
  });

  it("refuses CAPCOM as the name of a seat, FLIGHT or the controller", async () => {
    for (const kind of ["seat", "flight", "controller"] as const)
      await expect(sendComms(deps(kind), "CAPCOM", { to: "GUIDO-1", text: "x" })).rejects.toThrow();
  });

  it("refuses a hub message under any name but MC", async () => {
    await expect(
      sendComms(deps("hub"), COMMS_CONTROLLER, { to: "GUIDO-1", text: "x" }),
    ).rejects.toThrow("A hub message is sent as MC");
    await expect(sendComms(deps("hub"), "MC", { to: "GUIDO-1", text: "x" })).resolves.toMatchObject(
      { from: "MC", senderKind: "hub" },
    );
  });
});
