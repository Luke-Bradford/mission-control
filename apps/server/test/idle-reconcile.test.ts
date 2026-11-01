import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import * as hud from "../src/hud.ts";
import { Store } from "../src/store.ts";
import * as views from "../src/views.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "demo", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
let dir: string;
let store: Store;
let bus: ChangeBus;
let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  dir = mkdtempSync(join(tmpdir(), "mc-idle-reconcile-"));
  store = new Store(join(dir, "mc.sqlite"));
  bus = new ChangeBus();
  app = buildApp({ config, store, bus });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("reconciles notifications from attention items alone, with no event timelines built", async () => {
  const crew = vi.spyOn(hud, "crew");
  const timelines = vi.spyOn(views, "runEventsIndex");
  const items = vi.spyOn(hud, "attentionItems");
  await app.ready();
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(5000);
    bus.emit("agents");
    await vi.advanceTimersByTimeAsync(5000);
  }
  expect(items).toHaveBeenCalled();
  // only the summary crew (the sixth argument) is read, and it builds no event timelines
  expect(crew.mock.calls.every((call) => call[5] === true)).toBe(true);
  expect(timelines).not.toHaveBeenCalled();
});
