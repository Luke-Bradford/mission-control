import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/example",
    maxSeats: 1,
    sessions: [
      {
        id: "demo",
        repoId: "demo",
        checkout: "/example",
        seats: [{ id: "flight", role: "FLIGHT", accountId: "demo", model: "opus", area: [] }],
      },
    ],
  },
};
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-discussion-"));
  store = new Store(join(dir, "mc.sqlite"));
  store.raiseNote({
    key: "blocked:demo",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Choose a route",
    at: 1,
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("marks the hub's alerts on /api/attention, and only them (#1543)", async () => {
  const app = buildApp({ config: { ...config, crew: undefined }, store, bus: new ChangeBus() });
  store.raiseNote({
    key: "hub-update-held",
    kind: "blocked",
    runId: null,
    seatId: "guido-1",
    repoId: null,
    text: "Update waits for you.",
    at: 2,
  });
  const items = (await app.inject("/api/attention")).json() as { key: string; alert?: true }[];
  expect(items.find((i) => i.key === "note:hub-update-held")?.alert).toBe(true);
  expect(items.find((i) => i.key === "note:blocked:demo")?.alert).toBeUndefined();
});
