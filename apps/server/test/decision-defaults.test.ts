import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_CAPCOM, DECISION_DEFAULT_WAIT_MS, type Escalation } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdItem, releaseHold } from "../src/attention-holds.ts";
import type { CcConfig } from "../src/config.ts";
import { applyDecisionDefaults } from "../src/decision-defaults.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const ASKED = NOW - 10 * MIN;
const DUE = ASKED + DECISION_DEFAULT_WAIT_MS;

let dir: string;
let dbPath: string;
let store: Store;
let config: CcConfig;
let key: string;

const escalation: Escalation = {
  id: "shop-app#9",
  repoId: "shop-app",
  issueNumber: 9,
  title: "[operator-decision] pick one",
  kind: "operator-decision",
  source: "title",
  openedAt: ASKED - MIN,
  url: "https://github.com/o/shop-app/issues/9",
  question: null,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-defaults-"));
  dbPath = join(dir, "mc.sqlite");
  store = new Store(dbPath);
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
    repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  store.replaceEscalations("shop-app", [escalation]);
  key = attentionItems(config, store, NOW).find((i) => i.kind === "decision")?.key ?? "";
  store.addBrief({
    key,
    for: "operator",
    context: "c",
    ask: "Pick a vendor?",
    recommendation: "Acme",
    recommendedOptionId: "acme",
    options: [
      { id: "acme", label: "Acme", answer: "Go with Acme." },
      { id: "beta", label: "Beta", answer: "Go with Beta." },
    ],
    basis: "b",
    at: ASKED,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sweep = (now: number, s = store) => applyDecisionDefaults({ config, store: s, now });
describe("decision defaults", () => {
  it("shows the deadline on the card", () => {
    expect(attentionItems(config, store, NOW).find((i) => i.key === key)?.defaultDueAt).toBe(DUE);
  });

  it("applies the default at the deadline: the card leaves and the outcome is in Comms", async () => {
    expect(await sweep(DUE - 1)).toBe(0);
    expect(await sweep(DUE)).toBe(1);
    const item = attentionItems(config, store, DUE).find((i) => i.key === key);
    expect(item?.acked).toBe(true);
    const sent = store.commsForPair(COMMS_CAPCOM, "MC");
    expect(sent.map((m) => m.text)).toEqual(["Default applied: Acme (Pick a vendor?)"]);
  });

  it("applies once: a second sweep and a restarted store do nothing", async () => {
    expect(await sweep(DUE)).toBe(1);
    expect(await sweep(DUE + MIN)).toBe(0);
    store.close();
    store = new Store(dbPath);
    expect(await sweep(DUE + 2 * MIN)).toBe(0);
    expect(store.commsForPair(COMMS_CAPCOM, "MC")).toHaveLength(1);
  });

  it("applies an overdue default after a restart", async () => {
    store.close();
    store = new Store(dbPath);
    expect(await sweep(DUE + 5 * MIN)).toBe(1);
  });

  it("an answer before the deadline cancels it", async () => {
    store.ack([key], DUE - MIN);
    expect(await sweep(DUE + MIN)).toBe(0);
    expect(store.commsForPair(COMMS_CAPCOM, "MC")).toHaveLength(0);
  });

  it("Held stops the clock: nothing applies while held, and the wait restarts on release", async () => {
    holdItem(store, key, "later", { kind: "manual" }, "operator", DUE - MIN);
    expect(await sweep(DUE + MIN)).toBe(0);
    releaseHold(store, key, DUE + 5 * MIN);
    expect(await sweep(DUE + 6 * MIN)).toBe(0);
    expect(await sweep(DUE + 5 * MIN + DECISION_DEFAULT_WAIT_MS)).toBe(1);
  });

  it("an item answered on GitHub is recorded but nothing is delivered", async () => {
    const deliver = vi.fn(async () => {});
    await applyDecisionDefaults({ config, store, now: DUE, deliver });
    expect(deliver).not.toHaveBeenCalled();
  });
});
